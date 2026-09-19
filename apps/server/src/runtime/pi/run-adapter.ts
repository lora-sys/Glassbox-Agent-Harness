import type {
  RunExecutionAdapter,
  ExecutionInput,
  ExecutionResult,
} from "../../execution/run-service/types.js";
import { scopeKey } from "../../identity/scope.js";
import type { PiRuntimeAdapter, PiRuntimeProfileName } from "./types.js";
import { OWNER_GROUP_ADMIN_TOOL } from "./owner-tools.js";

interface RequiredToolCall {
  name: string;
  groupId: string;
  action: "get" | "set_access" | "set_skill";
  enabled?: boolean;
  skillName?: string;
}

function requiredToolCall(input: ExecutionInput): RequiredToolCall | undefined {
  if (input.caller.principalId !== "owner" || input.caller.scope.chatType !== "private")
    return undefined;
  const text = input.text;
  if (/不要|别|无需/u.test(text)) return undefined;
  const groupMatch = /(?:群\s*([1-9]\d{4,15})|([1-9]\d{4,15})\s*群)/u.exec(text);
  const groupId = groupMatch?.[1] ?? groupMatch?.[2];
  if (!groupId) return undefined;
  if (/如何|怎么|能否|是否|可以吗/u.test(text)) return undefined;
  if (/查看|查询|列出|当前|有哪些|状态/u.test(text))
    return { name: OWNER_GROUP_ADMIN_TOOL, groupId, action: "get" };
  const disabled = /关闭|停用|禁用|取消|移除/u.test(text);
  const changeRequested = disabled || /启用|开启|打开|允许|恢复|加入/u.test(text);
  if (!changeRequested && !text.includes(OWNER_GROUP_ADMIN_TOOL)) return undefined;
  const skillMatch =
    /(?:技能|Skill)\s*["'`]?([a-z0-9]+(?:-[a-z0-9]+)*)|([a-z0-9]+(?:-[a-z0-9]+)*)\s*(?:技能|Skill)/iu.exec(
      text,
    );
  const requestedSkill = (skillMatch?.[1] ?? skillMatch?.[2])?.toLowerCase();
  return {
    name: OWNER_GROUP_ADMIN_TOOL,
    groupId,
    action: /技能|Skill/iu.test(text) ? "set_skill" : "set_access",
    ...(disabled || /启用|开启|打开|允许|恢复|加入/u.test(text) ? { enabled: !disabled } : {}),
    ...(requestedSkill ? { skillName: requestedSkill } : {}),
  };
}

function recreatedPrompt(input: ExecutionInput): string {
  if (input.history.length === 0) return input.text;
  const history = input.history
    .map((message) => `${message.role === "user" ? "User" : "Assistant"}: ${message.text}`)
    .join("\n");
  return `Authorized Conversation history:\n${history}\n\nCurrent user message:\n${input.text}`;
}

export class PiRunExecutionAdapter implements RunExecutionAdapter {
  readonly supportsGroup = true;

  constructor(private readonly runtime: PiRuntimeAdapter) {}

  async execute(input: ExecutionInput): Promise<ExecutionResult> {
    await this.runtime.initialize();
    const profile: PiRuntimeProfileName =
      input.caller.scope.chatType === "group" ? "qq-group" : "main-agent";
    const required = requiredToolCall(input);
    const context = {
      caller: input.caller,
      conversationId: input.conversation.id,
      runId: input.run.id,
      requiredToolName: required?.name,
      requiredToolInput: required
        ? {
            action: required.action,
            groupId: required.groupId,
            ...(required.enabled === undefined ? {} : { enabled: required.enabled }),
            ...(required.skillName === undefined ? {} : { skillName: required.skillName }),
          }
        : undefined,
    };
    const binding = await this.runtime.createOrRestoreSession(
      {
        id: input.conversation.id,
        agentId: input.conversation.agentId,
        principalId: input.caller.principalId,
        scope: {
          channel: "qq",
          scopeType: input.conversation.scope.chatType === "group" ? "group" : "direct",
          scopeKey: scopeKey(input.conversation.scope),
          chatId: input.conversation.scope.chatId,
          connectionId: input.conversation.scope.connectionId,
        },
        resourceId: `conversation:${input.conversation.id}`,
        createdAt: input.conversation.createdAt,
      },
      profile,
      context,
    );
    const abort = () => {
      void this.runtime.abort(binding.runtimeSessionId);
    };
    input.signal.addEventListener("abort", abort, { once: true });
    try {
      if (input.signal.aborted) {
        await this.runtime.abort(binding.runtimeSessionId);
        return { status: "cancelled", providerSessionId: binding.runtimeSessionId };
      }
      let result = await this.runtime.run(
        binding,
        { ...input.run, principalId: input.caller.principalId },
        recreatedPrompt(input),
        context,
      );
      const requiredName = context.requiredToolName;
      const completedRequiredTool = () =>
        required === undefined ||
        result.toolCalls.some(
          (call) =>
            call.name === required.name &&
            call.failed === false &&
            call.input.action === required.action &&
            call.input.groupId === required.groupId &&
            (required.enabled === undefined || call.input.enabled === required.enabled) &&
            (required.skillName === undefined || call.input.skillName === required.skillName),
        );
      if (result.status === "completed" && !completedRequiredTool() && !input.signal.aborted) {
        result = await this.runtime.run(
          binding,
          { ...input.run, principalId: input.caller.principalId },
          `The required action has not executed. Call ${requiredName} now with exactly this JSON input: ${JSON.stringify(context.requiredToolInput)}. Do not ask for confirmation and do not report success without the tool result.`,
          context,
        );
      }
      if (requiredName !== undefined && result.status !== "aborted" && !completedRequiredTool()) {
        return {
          status: "failed",
          text: "请求的操作未执行，请稍后重试。",
          providerSessionId: binding.runtimeSessionId,
        };
      }
      return {
        status:
          result.status === "completed"
            ? "succeeded"
            : result.status === "aborted"
              ? "cancelled"
              : "failed",
        text: result.text,
        providerSessionId: binding.runtimeSessionId,
      };
    } finally {
      input.signal.removeEventListener("abort", abort);
      await this.runtime.disposeSession?.(binding.runtimeSessionId);
    }
  }

  async cleanup(): Promise<void> {
    return this.runtime.cleanup();
  }
}
