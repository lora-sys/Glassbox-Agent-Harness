import { describe, expect, it, vi } from "vite-plus/test";
import type { CallerContext } from "../../identity/scope.js";
import type { DomainStore } from "../../persistence/index.js";
import { BrowserSessionRegistry, type BrowserSessionBinding } from "../../web/browser-session.js";
import type { BrowserBridge } from "../../web/browser-bridge.js";
import { createBrowserTools, type BrowserToolEvidence } from "./browser-tools.js";
import type { PiRunContext } from "./types.js";

const caller: CallerContext = {
  principalId: "owner",
  scope: {
    connectionId: "qq",
    botId: "bot",
    chatType: "private",
    chatId: "owner",
    senderId: "owner",
  },
};

const context = {
  caller,
  conversationId: "conversation-1",
  runId: "run-1",
} as PiRunContext;

const binding: BrowserSessionBinding = {
  runId: "run-1",
  principalId: "owner",
  conversationId: "conversation-1",
  workspaceId: "workspace-1",
  policyVersion: "policy-1",
};

function makeTool(options: {
  bridge?: BrowserBridge;
  bind?: () => Promise<BrowserSessionBinding>;
  enabled?: () => Promise<boolean>;
  recordEvidence?: (record: BrowserToolEvidence) => Promise<void>;
}) {
  const tool = createBrowserTools({
    store: {
      authorization: {
        check: vi.fn(async () => ({ decision: "ALLOW" as const, reason: "granted" })),
      },
    } as unknown as DomainStore,
    getContext: () => context,
    binding: options.bind ?? (async () => binding),
    bridge: options.bridge,
    sessions: new BrowserSessionRegistry(() => "test-session"),
    isEnabled: options.enabled ?? (async () => true),
    onActivated: vi.fn(),
    onClosed: vi.fn(),
    recordEvidence: options.recordEvidence
      ? async (record) => options.recordEvidence!(record)
      : undefined,
  })[0]!;
  return tool;
}

async function call(tool: ReturnType<typeof makeTool>, params: Record<string, unknown>) {
  return tool.execute("call-1", params, undefined, undefined, {} as never);
}

describe("browser failure evidence", () => {
  it("records a fixed failure category and action without URL or input content", async () => {
    const records: BrowserToolEvidence[] = [];
    const bridge = {
      execute: vi.fn(async () => {
        throw new Error(
          "browser failed at https://private.example/path?token=secret with form=private",
        );
      }),
      cleanup: vi.fn(async () => undefined),
    } as unknown as BrowserBridge;
    const tool = makeTool({ bridge, recordEvidence: async (record) => void records.push(record) });

    await expect(
      call(tool, {
        action: "goto",
        url: "https://private.example/path?token=secret",
      }),
    ).rejects.toThrow("browser_failed");

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      action: "goto",
      status: "failed",
      failurePhase: "browser_execution",
      failureCategory: "browser_failed",
    });
    expect(JSON.stringify(records[0])).not.toContain("private.example");
    expect(JSON.stringify(records[0])).not.toContain("secret");
  });

  it("records a binding failure before the browser bridge runs", async () => {
    const records: BrowserToolEvidence[] = [];
    const execute = vi.fn(async () => ({ output: "ok", truncated: false }));
    const bridge = {
      execute,
      cleanup: vi.fn(async () => undefined),
    } as unknown as BrowserBridge;
    const tool = makeTool({
      bridge,
      bind: async () => {
        throw new Error("private workspace path");
      },
      recordEvidence: async (record) => void records.push(record),
    });

    await expect(call(tool, { action: "snapshot" })).rejects.toThrow("browser_failed");
    expect(execute).not.toHaveBeenCalled();
    expect(records[0]).toMatchObject({
      action: "snapshot",
      status: "failed",
      failurePhase: "session_binding",
      failureCategory: "binding_failed",
    });
    expect(JSON.stringify(records[0])).not.toContain("private workspace path");
  });

  it("records backend unavailability before session creation", async () => {
    const records: BrowserToolEvidence[] = [];
    const tool = makeTool({ recordEvidence: async (record) => void records.push(record) });

    await expect(call(tool, { action: "read" })).rejects.toThrow("browser_backend_unavailable");
    expect(records[0]).toMatchObject({
      action: "read",
      status: "failed",
      failurePhase: "backend_check",
      failureCategory: "backend_unavailable",
    });
    expect(records[0]?.browserSessionId).toBeUndefined();
  });
});
