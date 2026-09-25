import { describe, expect, it, vi } from "vitest";
import { BrowserBridge, type BrowserAuthorizer } from "./browser-bridge.js";
import type {
  BrowserExecutionSession,
  BrowserExecutorLimits,
  BrowserExecutorPort,
  BrowserExecutorResult,
} from "./browser-executor-port.js";
import type { BrowserSessionBinding } from "./browser-session.js";

const binding: BrowserSessionBinding = {
  runId: "run-1",
  principalId: "owner-1",
  conversationId: "conversation-1",
  workspaceId: "workspace-1",
  policyVersion: "policy-7",
};
const resolvePublicHost = async () => ["93.184.215.14"];

function setup(
  options: {
    allow?: boolean;
    result?: (args: readonly string[]) => BrowserExecutorResult | undefined;
  } = {},
) {
  const calls: Array<{ args: string[]; limits: BrowserExecutorLimits }> = [];
  const opens: Array<{ binding: BrowserSessionBinding; sessionId: string }> = [];
  const authorize = vi.fn<BrowserAuthorizer>(async () => options.allow ?? true);
  let cancelCount = 0;
  let closeCount = 0;
  const execution: BrowserExecutionSession = {
    execute: vi.fn(async (args, limits) => {
      calls.push({ args: [...args], limits });
      const result = options.result?.(args);
      if (result) return result;
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          success: true,
          data: args[3] === "get" && args[4] === "url" ? "https://example.com/" : { ok: true },
        }),
        stderr: "",
      };
    }),
    cancel: vi.fn(async () => {
      cancelCount++;
    }),
    close: vi.fn(async () => {
      closeCount++;
    }),
  };
  const executor: BrowserExecutorPort = {
    open: vi.fn(async (sessionBinding, sessionId) => {
      opens.push({ binding: sessionBinding, sessionId });
      return execution;
    }),
  };
  const bridge = new BrowserBridge({
    authorize,
    executor,
    resolveHost: resolvePublicHost,
    timeoutMs: 7000,
    maxOutputChars: 1200,
    maxArtifactBytes: 4096,
  });
  return {
    bridge,
    calls,
    opens,
    authorize,
    executor,
    execution,
    get cancelCount() {
      return cancelCount;
    },
    get closeCount() {
      return closeCount;
    },
  };
}

describe("BrowserExecutorPort boundary", () => {
  it("opens a generated executor session bound to the complete caller scope", async () => {
    const state = setup();
    await state.bridge.execute(binding, { type: "open", url: "https://example.com/" });

    expect(state.opens).toHaveLength(1);
    expect(state.opens[0]).toMatchObject({
      binding,
      sessionId: expect.stringMatching(/^gb-[a-f0-9]{24}$/u),
    });
    expect(state.opens[0]?.sessionId).not.toContain(binding.runId);
  });

  it("passes only structured CLI arguments and explicit resource limits to the executor", async () => {
    const state = setup();
    await state.bridge.execute(binding, { type: "open", url: "https://example.com/" });
    await state.bridge.execute(binding, { type: "snapshot" });

    expect(state.calls[0]).toMatchObject({
      args: ["--json", "--session", state.opens[0]?.sessionId, "open", "https://example.com/"],
      limits: { timeoutMs: 7000, maxOutputChars: 1200, maxArtifactBytes: 4096 },
    });
    expect(state.calls[3]?.args).toEqual([
      "--json",
      "--session",
      state.opens[0]?.sessionId,
      "snapshot",
    ]);
    expect(state.calls[3]?.limits).toEqual(state.calls[0]?.limits);
  });

  it("isolates executor sessions by Run, Principal, and purpose", async () => {
    const state = setup();
    await state.bridge.execute(binding, { type: "open", url: "https://example.com/" });
    await state.bridge.execute(
      { ...binding, runId: "run-2" },
      { type: "open", url: "https://example.com/" },
    );
    await state.bridge.execute(
      { ...binding, purpose: "fallback" },
      { type: "open", url: "https://example.com/" },
    );
    await state.bridge.execute(
      { ...binding, principalId: "owner-2" },
      { type: "open", url: "https://example.com/" },
    );

    expect(new Set(state.opens.map(({ sessionId }) => sessionId)).size).toBe(4);
    expect(
      state.opens.map(({ binding: opened }) => [
        opened.runId,
        opened.principalId,
        opened.purpose ?? "tool",
      ]),
    ).toEqual([
      ["run-1", "owner-1", "tool"],
      ["run-2", "owner-1", "tool"],
      ["run-1", "owner-1", "fallback"],
      ["run-1", "owner-2", "tool"],
    ]);
  });

  it("does not reuse an executor session after the bound policy version changes", async () => {
    const state = setup();
    await state.bridge.execute(binding, { type: "open", url: "https://example.com/" });
    await state.bridge.execute(
      { ...binding, policyVersion: "policy-8" },
      { type: "open", url: "https://example.com/" },
    );

    expect(state.opens).toHaveLength(2);
    expect(state.opens[0]?.sessionId).not.toBe(state.opens[1]?.sessionId);
    expect(state.opens.map(({ binding: opened }) => opened.policyVersion)).toEqual([
      "policy-7",
      "policy-8",
    ]);
  });

  it("does not acquire executor resources when authorization denies the operation", async () => {
    const state = setup({ allow: false });
    await expect(
      state.bridge.execute(binding, { type: "open", url: "https://example.com/" }),
    ).rejects.toThrow("browser_denied");

    expect(state.opens).toHaveLength(0);
    expect(state.calls).toHaveLength(0);
  });

  it("rejects executor artifacts over the configured byte limit", async () => {
    const state = setup({
      result: (args) =>
        args[3] === "screenshot"
          ? {
              exitCode: 0,
              stdout: JSON.stringify({ success: true, data: { captured: true } }),
              stderr: "",
              artifact: { id: "artifact-1", mimeType: "image/png", sizeBytes: 4097 },
            }
          : undefined,
    });
    await state.bridge.execute(binding, { type: "open", url: "https://example.com/" });

    await expect(state.bridge.execute(binding, { type: "screenshot" })).rejects.toThrow(
      "browser_artifact_invalid",
    );
    await state.bridge.cleanup(binding);
    expect(state.closeCount).toBe(1);
  });

  it("closes the execution session on explicit close and cancels it on run cleanup", async () => {
    const explicit = setup();
    await explicit.bridge.execute(binding, { type: "open", url: "https://example.com/" });
    await explicit.bridge.execute(binding, { type: "close" });
    expect(explicit.closeCount).toBe(1);
    expect(explicit.cancelCount).toBe(0);

    const cleanup = setup();
    await cleanup.bridge.execute(binding, { type: "open", url: "https://example.com/" });
    await cleanup.bridge.cleanup(binding);
    expect(cleanup.cancelCount).toBe(1);
    expect(cleanup.closeCount).toBe(1);
  });

  it("disposes a session after a failed initial browser command", async () => {
    let failOpen = true;
    const state = setup({
      result: (args) => {
        if (args[3] === "open" && failOpen) {
          failOpen = false;
          return { exitCode: 1, stdout: "", stderr: "executor failed" };
        }
        return undefined;
      },
    });

    await expect(
      state.bridge.execute(binding, { type: "open", url: "https://example.com/" }),
    ).rejects.toThrow("browser_cli_failed");
    expect(state.cancelCount).toBe(1);
    expect(state.closeCount).toBe(1);
    await state.bridge.execute(binding, { type: "open", url: "https://example.com/" });
    expect(state.opens).toHaveLength(2);
  });
});
