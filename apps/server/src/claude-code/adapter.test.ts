// apps/server/src/claude-code/adapter.test.ts
// Unit tests for ClaudeCodeAdapter — no API key required.
import { afterEach, beforeEach, describe, it, expect, vi } from "vite-plus/test";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type { query, Options } from "@anthropic-ai/claude-agent-sdk";
import os from "node:os";
import { ClaudeCodeAdapter } from "./adapter.js";

type FakeQuery = AsyncGenerator<Record<string, unknown>, void> & { close: () => void };
const sdk = vi.hoisted(() => ({
  query: vi.fn<(input: Parameters<typeof query>[0]) => FakeQuery>(),
}));
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query: sdk.query }));
vi.mock("../platform/executable.js", () => ({ resolveClaudeExecutable: () => "fixture-claude" }));
let temporaryDirectory: string;
beforeEach(async () => {
  sdk.query.mockReset();
  temporaryDirectory = await mkdtemp(join(os.tmpdir(), "glassbox-claude-adapter-"));
  vi.stubEnv("GLASSBOX_DATA_DIR", temporaryDirectory);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  const target = resolve(temporaryDirectory);
  if (
    dirname(target) !== resolve(os.tmpdir()) ||
    !basename(target).startsWith("glassbox-claude-adapter-")
  )
    throw new Error("Invalid fixture path");
  await rm(target, { recursive: true, force: true });
});
function deferred<T>() {
  let complete!: (value: T) => void;
  const promise = new Promise<T>((resolveValue) => {
    complete = resolveValue;
  });
  return { promise, complete };
}
function response(text = "Hello") {
  return [
    { type: "system", subtype: "init", session_id: "provider-session" },
    {
      type: "assistant",
      uuid: "assistant-message",
      message: { content: [{ type: "text", text }] },
    },
    { type: "result", subtype: "success", is_error: false, duration_ms: 12, result: text },
  ];
}
function queryEvents(events = response()) {
  return Object.assign(
    (async function* () {
      yield* events;
    })(),
    { close: vi.fn() },
  );
}

describe("ClaudeCodeAdapter", () => {
  it("initialize returns ServerInfo", async () => {
    const adapter = new ClaudeCodeAdapter();
    adapter.start();
    const info = await adapter.initialize();
    expect(info).toMatchObject({
      userAgent: "claude-code-cli",
      platformFamily: "claude-code",
    });
    expect(info.platformOs).toBe(process.platform);
    adapter.stop();
  });

  it("startSession creates trackable session state", async () => {
    const adapter = new ClaudeCodeAdapter();
    adapter.start();
    const session = await adapter.startSession("sess-1", {});
    expect(session.id).toBe("sess-1");
    // startTurn should work without errors
    const turn = await adapter.startTurn("sess-1", [{ type: "text", text: "hello" }], {});
    expect(turn.status).toBe("inProgress");
    expect(turn.items).toEqual([]);
    adapter.stop();
  });

  it("startTurn stores prompt without sending API calls", async () => {
    const adapter = new ClaudeCodeAdapter();
    adapter.start();
    await adapter.startSession("sess-2", {});
    const turn = await adapter.startTurn("sess-2", [{ type: "text", text: "say hi" }], {});
    expect(turn.id).toBeDefined();
    expect(turn.startedAt).toBeGreaterThan(0);
    adapter.stop();
  });

  it("registerOnTurnEnd captures completion status", async () => {
    const adapter = new ClaudeCodeAdapter();
    adapter.start();
    const statuses: string[] = [];
    adapter.registerOnTurnEnd((s) => statuses.push(s));
    // registerOnTurnEnd doesn't fire until a turn actually runs — just verify it stores the callback
    expect(() => adapter.registerOnTurnEnd(() => {})).not.toThrow();
    adapter.stop();
  });

  it("on('approval') registers handler (collected on next approval)", async () => {
    const adapter = new ClaudeCodeAdapter();
    adapter.start();
    const approvals: unknown[] = [];
    adapter.on("approval", (ev) => approvals.push(ev));
    // Handler is recorded; it fires when collectTurnEvents encounters a tool_use
    expect(() => adapter.on("approval", () => {})).not.toThrow();
    adapter.stop();
  });

  it("findApprovalRequestId and respondToApproval — round trip", async () => {
    const adapter = new ClaudeCodeAdapter();
    adapter.start();
    await adapter.startSession("sess-3", {});

    // No approvals yet
    expect(adapter.findApprovalRequestId("item-1")).toBeNull();

    // Register an approval consumer to capture the event
    const captured: unknown[] = [];
    adapter.on("approval", (ev) => captured.push(ev));

    // Verify no pending approvals exist before tools fire
    expect(adapter.findApprovalRequestId("item-1")).toBeNull();
    adapter.stop();
  });

  it("snapshotWorkspace and scanAndFireHooks — git scan lifecycle", async () => {
    const adapter = new ClaudeCodeAdapter();
    adapter.start();
    const changes = adapter.scanAndFireHooks(os.tmpdir());
    expect(Array.isArray(changes.changes)).toBe(true);
    adapter.stop();
  });

  it("start after stop — clean restart", async () => {
    const adapter = new ClaudeCodeAdapter();
    adapter.start();
    adapter.stop();
    // After stop, sessions map is cleared; starting again works cleanly
    await adapter.startSession("sess-4", {});
    const turn = await adapter.startTurn("sess-4", [{ type: "text", text: "x" }], {});
    expect(turn.status).toBe("inProgress");
    adapter.stop();
  });

  it("getAppendSystemPrompt — returns empty string for missing session", async () => {
    const adapter = new ClaudeCodeAdapter();
    adapter.start();
    // Session never started — getAppendSystemPrompt should not throw
    expect(adapter.getAppendSystemPrompt("nonexistent-session")).toBe("");
    adapter.stop();
  });

  it("getAppendSystemPrompt — returns initial value after startSession", async () => {
    const adapter = new ClaudeCodeAdapter();
    adapter.start();
    await adapter.startSession("sess-5", {});
    expect(adapter.getAppendSystemPrompt("sess-5")).toBe("");
    adapter.stop();
  });

  it("getAppendSystemPrompt / setAppendSystemPrompt — round trip", async () => {
    const adapter = new ClaudeCodeAdapter();
    adapter.start();
    await adapter.startSession("sess-6", {});
    expect(adapter.getAppendSystemPrompt("sess-6")).toBe("");
    adapter.setAppendSystemPrompt("sess-6", "Be concise.");
    expect(adapter.getAppendSystemPrompt("sess-6")).toBe("Be concise.");
    // Overwriting
    adapter.setAppendSystemPrompt("sess-6", "New system instruction.");
    expect(adapter.getAppendSystemPrompt("sess-6")).toBe("New system instruction.");
    adapter.stop();
  });

  it("setAppendSystemPrompt on missing session — no throw", async () => {
    const adapter = new ClaudeCodeAdapter();
    adapter.start();
    // Setting on a session that doesn't exist should not throw
    expect(() => adapter.setAppendSystemPrompt("ghost-session", "x")).not.toThrow();
    // Confirm it returned empty string
    expect(adapter.getAppendSystemPrompt("ghost-session")).toBe("");
    adapter.stop();
  });

  // ---- P2.8b: agentMessage/final event on result ----

  it("collectTurnEvents emits item/agentMessage/final on result with last assistant text", async () => {
    sdk.query.mockImplementation(() => queryEvents());
    const adapter = new ClaudeCodeAdapter();
    adapter.start();
    const sessionId = "sess-final-test";
    await adapter.startSession(sessionId, { cwd: os.tmpdir() });
    const turn = await adapter.startTurn(sessionId, [{ type: "text", text: "Say hello." }], {});

    const traceEvents: Array<{ method: string; params: Record<string, unknown> }> = [];
    const result = await adapter.collectTurnEvents(sessionId, turn.id, 30000, (method, params) => {
      traceEvents.push({ method, params });
    });

    // Verify turn/completed was emitted
    const turnCompleted = traceEvents.filter((e) => e.method === "turn/completed");
    expect(turnCompleted).toHaveLength(1);
    expect(turnCompleted[0]?.params).toMatchObject({ turn: { id: turn.id, status: "completed" } });

    // If a final answer event was emitted, verify its shape
    const finalEvents = traceEvents.filter((e) => e.method === "item/agentMessage/final");
    expect(finalEvents).toHaveLength(1);
    for (const fe of finalEvents) {
      expect(fe.params).toHaveProperty("text");
      expect(typeof fe.params.text).toBe("string");
      expect(fe.params).toHaveProperty("threadId", sessionId);
      expect(fe.params).toHaveProperty("turnId", turn.id);
      expect(fe.params).toHaveProperty("completedAtMs");
    }

    expect(result).toMatchObject({ turnStatus: "completed", turnId: turn.id });
    expect(
      traceEvents.findIndex((event) => event.method === "item/agentMessage/final"),
    ).toBeLessThan(traceEvents.findIndex((event) => event.method === "turn/completed"));
    expect(
      await readFile(join(temporaryDirectory, "sessions", sessionId, "trace.jsonl"), "utf8"),
    ).toContain(turn.id);

    adapter.stop();
  });

  it("collects one query per Turn ID and creates a new ID only for the next turn", async () => {
    sdk.query.mockImplementation(() => queryEvents());
    const adapter = new ClaudeCodeAdapter();
    await adapter.startSession("ids");
    const first = await adapter.startTurn("ids", [{ type: "text", text: "first" }]);
    expect(() => adapter.collectTurnEvents("ids", "wrong-turn", 1000)).toThrow(
      "matching Claude turn",
    );
    await expect(adapter.startTurn("ids", [{ type: "text", text: "overlap" }])).rejects.toThrow(
      "already active",
    );
    const collecting = adapter.collectTurnEvents("ids", first.id, 1000);
    expect(adapter.collectTurnEvents("ids", first.id, 1000)).toBe(collecting);
    expect((await collecting).turnId).toBe(first.id);
    const second = await adapter.startTurn("ids", [{ type: "text", text: "second" }]);
    expect(second.id).not.toBe(first.id);
    await adapter.collectTurnEvents("ids", second.id, 1000);
    expect(sdk.query).toHaveBeenCalledTimes(2);
    adapter.stop();
  });

  it("closes the real query and waits for its iterator before reporting interruption", async () => {
    const entered = deferred<void>();
    const finish = deferred<void>();
    const closed = deferred<void>();
    let options: Options | undefined;
    const close = vi.fn(() => closed.complete());
    sdk.query.mockImplementation((input) => {
      options = input.options;
      return Object.assign(
        (async function* () {
          yield response()[0]!;
          entered.complete();
          await finish.promise;
        })(),
        { close },
      );
    });
    const adapter = new ClaudeCodeAdapter();
    await adapter.startSession("interrupt");
    const turn = await adapter.startTurn("interrupt", [{ type: "text", text: "wait" }]);
    const events: string[] = [];
    const ended = vi.fn();
    adapter.registerOnTurnEnd(ended);
    const collecting = adapter.collectTurnEvents("interrupt", turn.id, 1000, (method) =>
      events.push(method),
    );
    await entered.promise;
    await expect(adapter.interruptTurn("interrupt", "another-turn")).rejects.toThrow(
      "matching Claude turn",
    );
    const interrupt = adapter.interruptTurn("interrupt", turn.id);
    await closed.promise;
    expect(options?.abortController?.signal.aborted).toBe(true);
    expect(ended).not.toHaveBeenCalled();
    expect(events).not.toContain("turn/completed");
    finish.complete();
    await interrupt;
    expect((await collecting).turnStatus).toBe("interrupted");
    expect(ended).toHaveBeenCalledExactlyOnceWith("interrupted");
    expect(events.filter((event) => event === "turn/completed")).toHaveLength(1);
    adapter.stop();
  });

  it("does not publish an early result as terminal while the SDK still runs", async () => {
    const resultYielded = deferred<void>();
    const finish = deferred<void>();
    sdk.query.mockImplementation(() =>
      Object.assign(
        (async function* () {
          yield* response();
          resultYielded.complete();
          await finish.promise;
        })(),
        { close: vi.fn() },
      ),
    );
    const adapter = new ClaudeCodeAdapter();
    await adapter.startSession("draining");
    const turn = await adapter.startTurn("draining", [{ type: "text", text: "run" }]);
    const ended = vi.fn();
    adapter.registerOnTurnEnd(ended);
    const collecting = adapter.collectTurnEvents("draining", turn.id, 1000);
    await resultYielded.promise;
    expect(ended).not.toHaveBeenCalled();
    finish.complete();
    expect((await collecting).turnStatus).toBe("completed");
    expect(ended).toHaveBeenCalledExactlyOnceWith("completed");
    adapter.stop();
  });

  it("interrupts a pending tool approval and never allows a late approval", async () => {
    const approvalSeen = deferred<void>();
    const permission = deferred<unknown>();
    sdk.query.mockImplementation(({ options }) =>
      Object.assign(
        (async function* () {
          yield response()[0]!;
          const canUseTool = options?.canUseTool;
          const signal = options?.abortController?.signal;
          if (!canUseTool || !signal) throw new Error("Missing query controls");
          const decision = await canUseTool(
            "Bash",
            { command: "fixture" },
            { signal, toolUseID: "tool-fixture", requestId: "tool-request" },
          );
          permission.complete(decision);
        })(),
        { close: vi.fn() },
      ),
    );
    const adapter = new ClaudeCodeAdapter();
    await adapter.startSession("approval");
    const turn = await adapter.startTurn("approval", [{ type: "text", text: "run" }]);
    adapter.on("approval", () => approvalSeen.complete());
    const collecting = adapter.collectTurnEvents("approval", turn.id, 1000);
    await approvalSeen.promise;
    await adapter.interruptTurn("approval", turn.id);
    expect(await permission.promise).toMatchObject({ behavior: "deny" });
    adapter.respondToApproval("tool-fixture", true);
    expect(adapter.findApprovalRequestId("tool-fixture")).toBeNull();
    expect((await collecting).turnStatus).toBe("interrupted");
    adapter.stop();
  });

  it("keeps synchronous approval responses and the original session permission mode", async () => {
    const permission = deferred<unknown>();
    sdk.query.mockImplementation(({ options }) =>
      Object.assign(
        (async function* () {
          const canUseTool = options?.canUseTool;
          const signal = options?.abortController?.signal;
          if (!canUseTool || !signal) throw new Error("Missing query controls");
          permission.complete(
            await canUseTool(
              "Read",
              { file_path: "fixture" },
              { signal, toolUseID: "read-fixture", requestId: "read-request" },
            ),
          );
          yield* response();
        })(),
        { close: vi.fn() },
      ),
    );
    const adapter = new ClaudeCodeAdapter();
    await expect(adapter.startSession("invalid", { permissionMode: "invented" })).rejects.toThrow(
      "permission mode",
    );
    await adapter.startSession("policy", { permissionMode: "plan" });
    await expect(
      adapter.startTurn("policy", [], { permissionMode: "bypassPermissions" }),
    ).rejects.toThrow("cannot change");
    const turn = await adapter.startTurn("policy", [], { permissionMode: "plan" });
    adapter.on("approval", (event) => adapter.respondToApproval(event.itemId, true));
    await adapter.collectTurnEvents("policy", turn.id, 1000);
    expect(await permission.promise).toMatchObject({ behavior: "allow" });
    expect(sdk.query.mock.calls[0]?.[0].options?.permissionMode).toBe("plan");
    adapter.stop();
  });

  it("prevents an interrupted not-yet-collected turn from spawning the SDK", async () => {
    const adapter = new ClaudeCodeAdapter();
    await adapter.startSession("unstarted");
    const turn = await adapter.startTurn("unstarted", []);
    await adapter.interruptTurn("unstarted", turn.id);
    expect((await adapter.collectTurnEvents("unstarted", turn.id, 1000)).turnStatus).toBe(
      "interrupted",
    );
    expect(sdk.query).not.toHaveBeenCalled();
    adapter.stop();
  });

  it("stop aborts and closes active SDK work", async () => {
    const entered = deferred<void>();
    const finish = deferred<void>();
    const close = vi.fn(() => finish.complete());
    let options: Options | undefined;
    sdk.query.mockImplementation((input) => {
      options = input.options;
      return Object.assign(
        (async function* () {
          yield response()[0]!;
          entered.complete();
          await finish.promise;
        })(),
        { close },
      );
    });
    const adapter = new ClaudeCodeAdapter();
    await adapter.startSession("shutdown");
    const turn = await adapter.startTurn("shutdown", []);
    const collecting = adapter.collectTurnEvents("shutdown", turn.id, 1000);
    await entered.promise;
    adapter.stop();
    expect(close).toHaveBeenCalled();
    expect(options?.abortController?.signal.aborted).toBe(true);
    expect((await collecting).turnStatus).toBe("interrupted");
  });
});
