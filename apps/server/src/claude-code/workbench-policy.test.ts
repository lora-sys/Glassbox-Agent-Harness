import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import type { ProviderAdapter, RunResult, SessionOpts, TurnOpts } from "../provider/types.js";
import type { UserInput } from "../codex/types.js";

const boundary = vi.hoisted(() => ({ createAdapter: vi.fn() }));
vi.mock("../provider/index.js", () => ({ createAdapter: boundary.createAdapter }));

class FakeAdapter implements ProviderAdapter {
  readonly sessions: Array<{ id: string; options: SessionOpts }> = [];
  readonly turns: Array<{ id: string; sessionId: string; options: TurnOpts }> = [];
  readonly instructions = new Map<string, string>();
  readonly interrupt = vi.fn();
  nextStatus: RunResult["turnStatus"] = "completed";
  private subscribers: Array<(status: string) => void> = [];
  start() {}
  stop() {}
  async initialize() {
    return {
      userAgent: "fixture",
      codexHome: "fixture",
      platformFamily: "fixture",
      platformOs: process.platform,
    };
  }
  async startSession(id: string, options: SessionOpts = {}) {
    this.sessions.push({ id, options: structuredClone(options) });
    return { id };
  }
  async startTurn(sessionId: string, _input: UserInput[], options: TurnOpts = {}) {
    const id = randomUUID();
    this.turns.push({ id, sessionId, options: structuredClone(options) });
    return {
      id,
      status: "inProgress" as const,
      items: [],
      itemsView: "",
      error: null,
      startedAt: Date.now(),
      completedAt: null,
      durationMs: null,
    };
  }
  async interruptTurn(sessionId: string, turnId: string) {
    this.interrupt(sessionId, turnId);
  }
  async collectTurnEvents(
    sessionId: string,
    turnId: string,
    _timeout: number,
    collect?: (method: string, params: Record<string, unknown>) => void,
  ): Promise<RunResult> {
    const status = this.nextStatus;
    this.nextStatus = "completed";
    collect?.("turn/started", {
      threadId: sessionId,
      turn: { id: turnId },
      startedAtMs: Date.now(),
    });
    collect?.("turn/completed", {
      threadId: sessionId,
      turn: { id: turnId, status, durationMs: 5 },
    });
    for (const subscriber of this.subscribers.splice(0)) subscriber(status);
    return {
      sessionId,
      turnId,
      turnStatus: status,
      turnDurationMs: 5,
      eventCounts: { "turn/completed": 1 },
      approvals: [],
      agentMessageDeltas: 0,
      ...(status === "failed" ? { error: "fixture failure" } : {}),
    };
  }
  registerOnTurnEnd(callback: (status: string) => void) {
    this.subscribers.push(callback);
  }
  on() {}
  respondToApproval() {}
  findApprovalRequestId() {
    return null;
  }
  snapshotWorkspace() {}
  scanAndFireHooks() {
    return { changes: [] };
  }
  setAppendSystemPrompt(sessionId: string, text: string) {
    this.instructions.set(sessionId, text);
  }
}

describe("Workbench continuation policy", () => {
  let application: typeof import("../index.js");
  let directory: string;
  let baseUrl: string;
  let token: string;
  const adapters = new Map<string, FakeAdapter>();
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "glassbox-workbench-policy-"));
    vi.stubEnv("GLASSBOX_DATA_DIR", directory);
    for (const provider of ["CODEX", "CLAUDE", "DEMO"])
      vi.stubEnv(`GLASSBOX_WORKSPACE_${provider}`, join(directory, provider));
    boundary.createAdapter.mockImplementation((provider: string) => {
      const adapter = new FakeAdapter();
      adapters.set(provider, adapter);
      return adapter;
    });
    application = await import("../index.js");
    const server = await application.startServer({
      port: 0,
      quiet: true,
      databasePath: ":memory:",
    });
    baseUrl = server.baseUrl;
    token = (await readFile(server.credentialFile, "utf8")).trim();
  });
  afterAll(async () => {
    await application?.stopServer();
    vi.unstubAllEnvs();
    const target = resolve(directory);
    if (
      dirname(target) !== resolve(tmpdir()) ||
      !basename(target).startsWith("glassbox-workbench-policy-")
    )
      throw new Error("Invalid fixture path");
    await rm(target, { recursive: true, force: true });
  });
  async function post(endpoint: string, body: Record<string, unknown>) {
    const response = await fetch(baseUrl + endpoint, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(response.status).toBe(200);
    const value: unknown = await response.json();
    if (
      !value ||
      typeof value !== "object" ||
      !("sessionId" in value) ||
      typeof value.sessionId !== "string"
    )
      throw new Error("Invalid session response");
    return value;
  }
  it.each(["/run-test", "/run-stream", "/run-demo"])(
    "preserves read-only and approval policy after %s",
    async (endpoint) => {
      const created = await post(endpoint, {
        provider: "codex",
        prompt: "fixture",
        sandboxPolicy: "read-only",
        approvalPolicy: "never",
      });
      const adapter = adapters.get("codex")!;
      const session = adapter.sessions.at(-1)!;
      await post("/send-task", {
        sessionId: created.sessionId,
        task: "follow up",
        sandboxPolicy: "danger-full-access",
        approvalPolicy: "on-request",
      });
      await post("/steer", { sessionId: created.sessionId, instruction: "follow up again" });
      expect(session.options).toMatchObject({ sandbox: "read-only", approvalPolicy: "never" });
      const turns = adapter.turns.filter((turn) => turn.sessionId === session.id);
      expect(turns).toHaveLength(3);
      for (const turn of turns)
        expect(turn.options).toMatchObject({
          sandboxPolicy: { type: "readOnly", networkAccess: false },
          approvalPolicy: "never",
        });
      expect(adapter.interrupt).not.toHaveBeenCalled();
    },
  );
  it("preserves Claude permission mode through send, steer and system instruction edits", async () => {
    const created = await post("/run-stream", {
      provider: "claude-code",
      prompt: "fixture",
      permissionMode: "plan",
    });
    const adapter = adapters.get("claude-code")!;
    const session = adapter.sessions.at(-1)!;
    await post("/send-task", {
      sessionId: created.sessionId,
      task: "follow up",
      permissionMode: "bypassPermissions",
    });
    await post("/steer", { sessionId: created.sessionId, instruction: "follow up again" });
    await post("/edit-input", {
      sessionId: created.sessionId,
      inputKind: "systemInstruction",
      value: "Revised instruction",
    });
    expect(session.options.permissionMode).toBe("plan");
    const turns = adapter.turns.filter((turn) => turn.sessionId === session.id);
    expect(turns).toHaveLength(4);
    for (const turn of turns) {
      expect(turn.options.permissionMode).toBe("plan");
      expect(turn.options).not.toHaveProperty("sandboxPolicy");
    }
    expect(adapter.instructions.get(session.id)).toBe("Revised instruction");
    expect(adapter.interrupt).not.toHaveBeenCalled();
  });
  it("reports the collector's failed result and permits the next explicit turn", async () => {
    const created = await post("/run-stream", {
      provider: "codex",
      prompt: "fixture",
      sandboxPolicy: "read-only",
    });
    const adapter = adapters.get("codex")!;
    adapter.nextStatus = "failed";
    const failed = await post("/send-task", { sessionId: created.sessionId, task: "fail" });
    expect(failed).toMatchObject({ turnStatus: "failed", turnDurationMs: 5 });
    expect(
      await post("/send-task", { sessionId: created.sessionId, task: "continue" }),
    ).toMatchObject({ turnStatus: "completed" });
    expect(adapter.interrupt).not.toHaveBeenCalled();
  });
});
