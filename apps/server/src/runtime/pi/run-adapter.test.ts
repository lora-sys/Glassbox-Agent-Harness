import { describe, expect, it, vi } from "vite-plus/test";
import { PiRunExecutionAdapter } from "./run-adapter.js";
import type { PiRunResult, PiRuntimeAdapter } from "./types.js";

function fixture(results: PiRunResult[]) {
  const run = vi.fn(async (..._args: Parameters<PiRuntimeAdapter["run"]>) => results.shift()!);
  const disposeSession = vi.fn(async () => {});
  const runtime: PiRuntimeAdapter = {
    initialize: async () => {},
    createOrRestoreSession: async () => ({
      conversationId: "conversation-1",
      runtimeSessionId: "session-1",
      profileName: "main-agent",
      agentDir: "agent",
      createdAt: new Date(0).toISOString(),
      lastActiveAt: new Date(0).toISOString(),
    }),
    run,
    abort: async () => {},
    disposeSession,
    cleanup: async () => {},
  };
  const input = {
    caller: {
      principalId: "owner",
      scope: {
        connectionId: "qq",
        botId: "bot",
        chatType: "private" as const,
        chatId: "owner",
        senderId: "owner",
      },
    },
    conversation: {
      id: "conversation-1",
      agentId: "personal",
      principalId: "owner",
      scope: {
        connectionId: "qq",
        botId: "bot",
        chatType: "private" as const,
        chatId: "owner",
        senderId: "owner",
      },
      resourceId: "conversation:conversation-1",
      providerKind: null,
      providerSessionId: null,
      providerSessionPrincipalId: null,
      createdAt: new Date(0).toISOString(),
    },
    run: {
      id: "run-1",
      sequence: 1,
      conversationId: "conversation-1",
      messageId: "message-1",
      principalId: "owner",
      scope: {
        connectionId: "qq",
        botId: "bot",
        chatType: "private" as const,
        chatId: "owner",
        senderId: "owner",
      },
      executionRef: "pi",
      status: "running" as const,
      resultText: null,
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    },
    text: "请启用群 1126022432 的 Bot 使用权限。",
    history: [],
    providerSessionId: null,
    signal: new AbortController().signal,
  };
  return { executor: new PiRunExecutionAdapter(runtime), input, run, disposeSession };
}

describe("Pi required Tool execution", () => {
  it("retries once and accepts only a successful required Tool result", async () => {
    const f = fixture([
      { status: "completed", text: "已执行", toolCalls: [] },
      {
        status: "completed",
        text: "群权限已启用。",
        toolCalls: [
          {
            name: "owner_group_set_access",
            input: { groupId: "1126022432", enabled: true },
            result: { groupId: "1126022432", enabled: true },
            failed: false,
          },
        ],
      },
    ]);
    await expect(f.executor.execute(f.input)).resolves.toMatchObject({
      status: "succeeded",
      text: "群权限已启用。",
    });
    expect(f.run).toHaveBeenCalledTimes(2);
    expect(f.run.mock.calls[1]?.[2]).toContain("owner_group_set_access");
    expect(f.disposeSession).toHaveBeenCalledOnce();
  });

  it("fails closed when the model claims execution without a successful Tool result", async () => {
    const f = fixture([
      { status: "completed", text: "已执行", toolCalls: [] },
      { status: "error", text: "已经完成", toolCalls: [], error: "provider_failed" },
    ]);
    await expect(f.executor.execute(f.input)).resolves.toMatchObject({
      status: "failed",
      text: "请求的操作未执行，请稍后重试。",
    });
    expect(f.run).toHaveBeenCalledTimes(2);
    expect(f.disposeSession).toHaveBeenCalledOnce();
  });

  it("does not turn a question about group access into a required action", async () => {
    const f = fixture([{ status: "completed", text: "说明", toolCalls: [] }]);
    f.input.text = "如何启用群 1126022432？";
    await expect(f.executor.execute(f.input)).resolves.toMatchObject({
      status: "succeeded",
      text: "说明",
    });
    expect(f.run).toHaveBeenCalledOnce();
  });
});
