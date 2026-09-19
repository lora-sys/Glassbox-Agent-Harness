import { describe, expect, it, vi } from "vite-plus/test";
import type { ExecutionInput } from "../../execution/run-service/types.js";
import { piProfileName, PiRunExecutionAdapter } from "./run-adapter.js";
import type { PiRunResult, PiRuntimeAdapter } from "./types.js";

function fixture(results: PiRunResult[]) {
  const run = vi.fn(async (..._args: Parameters<PiRuntimeAdapter["run"]>) => results.shift()!);
  const disposeSession = vi.fn(async () => {});
  const createOrRestoreSession = vi.fn(
    async (..._args: Parameters<PiRuntimeAdapter["createOrRestoreSession"]>) => ({
      conversationId: "conversation-1",
      runtimeSessionId: "session-1",
      profileName: "main-agent" as const,
      agentDir: "agent",
      createdAt: new Date(0).toISOString(),
      lastActiveAt: new Date(0).toISOString(),
    }),
  );
  const runtime: PiRuntimeAdapter = {
    initialize: async () => {},
    createOrRestoreSession,
    run,
    abort: async () => {},
    disposeSession,
    cleanup: async () => {},
  };
  const input: ExecutionInput = {
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
      providerKind: null,
      providerSessionId: null,
      providerSessionPrincipalId: null,
      createdAt: new Date(0).toISOString(),
    },
    run: {
      id: "run-1",
      conversationId: "conversation-1",
      messageId: "message-1",
      principalId: "owner",
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
  return {
    executor: new PiRunExecutionAdapter(runtime),
    runtime,
    input,
    run,
    disposeSession,
    createOrRestoreSession,
  };
}

describe("Pi required Tool execution", () => {
  it("keeps non-Owner group runs on the restricted group profile", () => {
    expect(piProfileName("group", false)).toBe("qq-group");
    expect(piProfileName("group", true)).toBe("main-agent");
    expect(piProfileName("private", false)).toBe("main-agent");
  });

  it("selects the main Agent profile for an Owner in a group through the trusted role resolver", async () => {
    const f = fixture([{ status: "completed", text: "ok", toolCalls: [] }]);
    f.input.caller.scope.chatType = "group";
    f.input.caller.scope.chatId = "1126022432";
    f.input.conversation.scope.chatType = "group";
    f.input.conversation.scope.chatId = "1126022432";
    const executor = new PiRunExecutionAdapter(f.runtime, {
      isOwner: async () => true,
      resolveProfileName: async () => "main-agent",
    });

    await executor.execute(f.input);

    expect(f.createOrRestoreSession.mock.calls[0]?.[1]).toBe("main-agent");
  });

  it("recognizes a secondary Owner when requiring a private management Tool call", async () => {
    const f = fixture([
      {
        status: "completed",
        text: "当前启用两个技能。",
        toolCalls: [
          {
            name: "owner_group_admin",
            input: { action: "get", groupId: "1126022432" },
            failed: false,
          },
        ],
      },
    ]);
    f.input.caller.principalId = "owner-secondary";
    f.input.text = "查看群 1126022432 当前有哪些技能";
    const executor = new PiRunExecutionAdapter(f.runtime, { isOwner: async () => true });

    await expect(executor.execute(f.input)).resolves.toMatchObject({ status: "succeeded" });
    expect(f.run.mock.calls[0]?.[3]?.requiredToolName).toBe("owner_group_admin");
  });

  it("retries once and accepts only a successful required Tool result", async () => {
    const f = fixture([
      { status: "completed", text: "已执行", toolCalls: [] },
      {
        status: "completed",
        text: "群权限已启用。",
        toolCalls: [
          {
            name: "owner_group_admin",
            input: { action: "set_access", groupId: "1126022432", enabled: true },
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
    expect(f.run.mock.calls[1]?.[2]).toContain("owner_group_admin");
    expect(f.run.mock.calls[1]?.[2]).toContain(
      '{"action":"set_access","groupId":"1126022432","enabled":true}',
    );
    expect(f.run.mock.calls[1]?.[3]?.requiredToolInput).toEqual({
      action: "set_access",
      groupId: "1126022432",
      enabled: true,
    });
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

  it("rejects a successful call whose group operation does not match the request", async () => {
    const wrongCall = {
      status: "completed" as const,
      text: "已执行",
      toolCalls: [
        {
          name: "owner_group_admin",
          input: {
            action: "set_skill",
            groupId: "1126022432",
            skillName: "unslop",
            enabled: true,
          },
          failed: false,
        },
      ],
    };
    const f = fixture([wrongCall, wrongCall]);
    await expect(f.executor.execute(f.input)).resolves.toMatchObject({
      status: "failed",
      text: "请求的操作未执行，请稍后重试。",
    });
    expect(f.run).toHaveBeenCalledTimes(2);
  });

  it("requires a real read call for a question about the current group Skill policy", async () => {
    const f = fixture([
      {
        status: "completed",
        text: "当前启用 unslop。",
        toolCalls: [
          {
            name: "owner_group_admin",
            input: { action: "get", groupId: "1126022432" },
            failed: false,
          },
        ],
      },
    ]);
    f.input.text = "群 1126022432 当前有哪些技能？";
    await expect(f.executor.execute(f.input)).resolves.toMatchObject({
      status: "succeeded",
      text: "当前启用 unslop。",
    });
    expect(f.run).toHaveBeenCalledOnce();
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
