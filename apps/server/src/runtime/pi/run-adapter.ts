import type { QqSourceClass } from "@glassbox/contracts";
import type {
  RunExecutionAdapter,
  ExecutionInput,
  ExecutionResult,
} from "../../execution/run-service/types.js";
import { scopeKey } from "../../identity/scope.js";
import type { QqCapabilityCategory } from "../../channels/onebot/capabilities.js";
import type { PiRuntimeAdapter, PiRuntimeProfileName } from "./types.js";
import { satisfiesRequiredInput } from "./protected-tools.js";
import { OWNER_GROUP_ADMIN_TOOL } from "./owner-tools.js";

interface RequiredToolCall {
  name: string;
  /** The exact input the current user message requires; every key must match the call. */
  input: Record<string, unknown>;
}

/** The provider parameters the current message pins down, or `undefined` when it pins none. */
type RequiredMutationParams = Record<string, string | number | boolean> | undefined;

/** The group id the current message names, if it names one. */
function namedGroupId(text: string): string | undefined {
  const match = /(?:群\s*([1-9]\d{4,15})|([1-9]\d{4,15})\s*群)/u.exec(text);
  return match?.[1] ?? match?.[2];
}

/**
 * The member the current message names.
 *
 * A bare number is not enough: a duration, a page count or a file id can look like a QQ id,
 * so the number must be attached to a member-indicating word. A message that only says
 * "禁言" names no member, and that is a refusal rather than a guess.
 */
function namedMemberId(text: string): number | undefined {
  const match =
    /(?:成员|群员|用户|把|将|给|对)\s*(\d{5,15})|(\d{5,15})\s*(?:禁言|闭嘴|踢出|踢掉|踢人|移出群|名片|管理员)/u.exec(
      text,
    );
  const value = match?.[1] ?? match?.[2];
  return value === undefined ? undefined : Number(value);
}

/** The mute duration the message names, converted to the seconds the provider expects. */
function namedDuration(text: string): number | undefined {
  const match = /(\d{1,9})\s*(秒|分钟|分|小时|时|天)/u.exec(text);
  if (!match) return undefined;
  const unit = match[2];
  const scale =
    unit === "秒" ? 1 : unit === "天" ? 86_400 : unit === "分钟" || unit === "分" ? 60 : 3_600;
  return Number(match[1]) * scale;
}

/** The free text a message names after a "change it to" verb, with quotes and padding removed. */
function namedText(text: string): string | undefined {
  const match =
    /(?:改成|改为|设置为|设为|换成|叫作|叫做|重命名为)\s*["'“”「」『』]?([^"'“”「」『』\s]+)/u.exec(
      text,
    );
  return match?.[1];
}

/** The identifier a message names right after a file operation word. */
function namedAfter(text: string, words: RegExp): string | undefined {
  const match = new RegExp(`(?:${words.source})\\s*["'“”]?([^"'“”\\s]+)`, "u").exec(text);
  return match?.[1];
}

/** The boolean a message names for a flag-shaped mutation. */
function namedFlag(text: string): boolean | undefined {
  if (/关闭|停用|禁用|取消|撤销|解除/u.test(text)) return false;
  if (/开启|启用|打开|恢复|设为/u.test(text)) return true;
  return undefined;
}

/**
 * Mutating QQ domain operations an Owner-private message can request, with the words that
 * name them and the provider parameters the message must pin down.
 *
 * This map is the only way a mutating capability Tool becomes callable: without a match
 * there is no required-Tool context, and the Tool refuses. It is read from the *current*
 * user message alone, so an instruction embedded in retrieved group history, a notice, file
 * content, a Tool result or Conversation history can never authorize a mutation.
 *
 * The required input names only parameters the Tool itself declares (`groupId`, `operation`,
 * `params`), so the exact call the message asks for is also a call the Tool can accept. The
 * `params` entries are the target and value the message named: a message asking to mute
 * member A for 60 seconds cannot authorize muting member B for another duration.
 *
 * An operation is listed only when the message can pin down both its target and its value.
 * `set_group_kick` (whose `reject_add_request` flag the message never names) and
 * `upload_group_file` (whose source path no chat message carries) are deliberately absent:
 * with no derivable target there is nothing to bind, so those mutations stay unauthorized.
 *
 * Order matters — a more specific phrase must precede a broader one that contains it
 * (`全员禁言` before `禁言`, `群名片` before `群名`).
 */
export const MUTATION_REQUESTS: readonly {
  tool: string;
  operation: string;
  words: RegExp;
  /**
   * The provider parameters this message pins down, or `undefined` when it pins too few to
   * identify the target and value. `undefined` is a refusal, never a fallback.
   */
  params: (text: string) => RequiredMutationParams;
}[] = Object.freeze([
  {
    tool: "qq_group_moderation",
    operation: "set_group_whole_ban",
    words: /全员禁言|全体禁言/iu,
    params: (text) => {
      const enable = namedFlag(text);
      return enable === undefined ? undefined : { enable };
    },
  },
  {
    tool: "qq_group_moderation",
    operation: "set_group_ban",
    words: /禁言|闭嘴/iu,
    params: (text) => {
      const user_id = namedMemberId(text);
      const duration = namedDuration(text);
      if (user_id === undefined || duration === undefined) return undefined;
      return { user_id, duration };
    },
  },
  {
    tool: "qq_group_settings",
    operation: "set_group_card",
    words: /群名片|名片/iu,
    params: (text) => {
      const user_id = namedMemberId(text);
      const card = namedText(text);
      if (user_id === undefined || card === undefined) return undefined;
      return { user_id, card };
    },
  },
  {
    tool: "qq_group_settings",
    operation: "set_group_name",
    words: /群名称|群名|改名/iu,
    params: (text) => {
      const group_name = namedText(text);
      return group_name === undefined ? undefined : { group_name };
    },
  },
  {
    tool: "qq_group_settings",
    operation: "set_group_admin",
    words: /管理员/iu,
    params: (text) => {
      const user_id = namedMemberId(text);
      const enable = namedFlag(text);
      if (user_id === undefined || enable === undefined) return undefined;
      return { user_id, enable };
    },
  },
  {
    tool: "qq_group_file_ops",
    operation: "create_group_file_folder",
    words: /新建文件夹|建文件夹|创建文件夹/iu,
    params: (text) => {
      const name = namedAfter(text, /新建文件夹|建文件夹|创建文件夹/iu);
      return name === undefined ? undefined : { name };
    },
  },
  {
    tool: "qq_group_file_ops",
    operation: "delete_group_file",
    words: /删除文件|删文件/iu,
    params: (text) => {
      const file_id = namedAfter(text, /删除文件|删文件/iu);
      return file_id === undefined ? undefined : { file_id };
    },
  },
]);

/** Capability categories an Owner-private message can name, with the words that name them. */
const CAPABILITY_WORDS: readonly { category: QqCapabilityCategory; words: RegExp }[] = [
  { category: "group.history", words: /历史|聊天记录|消息记录/iu },
  { category: "group.members", words: /成员/iu },
  { category: "group.content", words: /公告|精华/iu },
  { category: "group.files.write", words: /文件夹|上传文件|删除文件/iu },
  { category: "group.files.read", words: /文件/iu },
  { category: "group.moderate", words: /禁言|踢|审核|管理/iu },
  { category: "group.settings", words: /设置/iu },
  { category: "message.manage", words: /消息管理/iu },
  { category: "group.read", words: /群信息|群资料/iu },
];

/** Memory source classes an Owner-private message can name. */
const SOURCE_CLASS_WORDS: readonly { sourceClass: QqSourceClass; words: RegExp }[] = [
  { sourceClass: "history", words: /历史|聊天记录/iu },
  { sourceClass: "notice", words: /公告/iu },
  { sourceClass: "essence", words: /精华/iu },
  { sourceClass: "metadata", words: /群资料|元数据/iu },
  { sourceClass: "album", words: /相册/iu },
  { sourceClass: "file", words: /文件/iu },
];

export interface PiRunExecutionAdapterOptions {
  isOwner?: (input: ExecutionInput) => Promise<boolean>;
  resolveProfileName?: (input: ExecutionInput) => Promise<PiRuntimeProfileName>;
}

export function piProfileName(
  chatType: ExecutionInput["caller"]["scope"]["chatType"],
  isOwner: boolean,
): PiRuntimeProfileName {
  return chatType === "group" && !isOwner ? "qq-group" : "main-agent";
}

function requiredToolCall(input: ExecutionInput, isOwner: boolean): RequiredToolCall | undefined {
  if (!isOwner || input.caller.scope.chatType !== "private") return undefined;
  const text = input.text;
  if (/不要|别|无需/u.test(text)) return undefined;
  const groupId = namedGroupId(text);
  if (!groupId) return undefined;
  if (/如何|怎么|能否|是否|可以吗/u.test(text)) return undefined;
  if (/查看|查询|列出|当前|有哪些|状态/u.test(text))
    return { name: OWNER_GROUP_ADMIN_TOOL, input: { action: "get", groupId } };

  // A mutating QQ domain operation is named by the current message, together with the group
  // it targets and the target and value it selects. The exact operation and every provider
  // parameter the message pins down are part of the required input, so the call cannot
  // substitute a different operation, a different member, a different duration or a different
  // value. A message that names the operation but not enough to identify its target yields no
  // required-Tool context at all, and the mutation stays unauthorized.
  const mutation = MUTATION_REQUESTS.find((entry) => entry.words.test(text));
  if (mutation) {
    const params = mutation.params(text);
    if (params === undefined) return undefined;
    return {
      name: mutation.tool,
      input: { groupId, operation: mutation.operation, params },
    };
  }

  const disabled = /关闭|停用|禁用|取消|移除/u.test(text);
  const changeRequested = disabled || /启用|开启|打开|允许|恢复|加入/u.test(text);
  if (!changeRequested && !text.includes(OWNER_GROUP_ADMIN_TOOL)) return undefined;

  if (/记忆来源|记忆源/u.test(text)) {
    const sourceClass = SOURCE_CLASS_WORDS.find((entry) => entry.words.test(text))?.sourceClass;
    return {
      name: OWNER_GROUP_ADMIN_TOOL,
      input: {
        action: "set_memory_source",
        groupId,
        enabled: !disabled,
        ...(sourceClass === undefined ? {} : { sourceClass }),
      },
    };
  }
  if (/历史|聊天记录|消息记录/u.test(text))
    return {
      name: OWNER_GROUP_ADMIN_TOOL,
      input: { action: "set_history", groupId, enabled: !disabled },
    };
  if (/能力|capability|owner_group_admin/iu.test(text)) {
    const category = CAPABILITY_WORDS.find((entry) => entry.words.test(text))?.category;
    return {
      name: OWNER_GROUP_ADMIN_TOOL,
      input: {
        action: "set_capability",
        groupId,
        enabled: !disabled,
        ...(category === undefined ? {} : { category }),
      },
    };
  }
  if (/技能|Skill/iu.test(text)) {
    const skillMatch =
      /(?:技能|Skill)\s*["'`]?([a-z0-9]+(?:-[a-z0-9]+)*)|([a-z0-9]+(?:-[a-z0-9]+)*)\s*(?:技能|Skill)/iu.exec(
        text,
      );
    const requestedSkill = (skillMatch?.[1] ?? skillMatch?.[2])?.toLowerCase();
    return {
      name: OWNER_GROUP_ADMIN_TOOL,
      input: {
        action: "set_skill",
        groupId,
        enabled: !disabled,
        ...(requestedSkill === undefined ? {} : { skillName: requestedSkill }),
      },
    };
  }
  return {
    name: OWNER_GROUP_ADMIN_TOOL,
    input: { action: "set_access", groupId, enabled: !disabled },
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

  constructor(
    private readonly runtime: PiRuntimeAdapter,
    private readonly options: PiRunExecutionAdapterOptions = {},
  ) {}

  async execute(input: ExecutionInput): Promise<ExecutionResult> {
    await this.runtime.initialize();
    const isOwner = this.options.isOwner
      ? await this.options.isOwner(input)
      : input.caller.principalId === "owner";
    const profile: PiRuntimeProfileName = this.options.resolveProfileName
      ? await this.options.resolveProfileName(input)
      : input.caller.scope.chatType === "group"
        ? "qq-group"
        : "main-agent";
    const required = requiredToolCall(input, isOwner);
    const context = {
      caller: input.caller,
      conversationId: input.conversation.id,
      runId: input.run.id,
      requiredToolName: required?.name,
      requiredToolInput: required?.input,
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
      // The same comparison the mutating-Tool gate uses: a call counts as having carried out
      // the required action only when every key the message pinned down agrees with it. Using
      // a looser check here would accept a Run whose Tool call the gate had refused.
      const completedRequiredTool = () =>
        required === undefined ||
        result.toolCalls.some(
          (call) =>
            call.name === required.name &&
            call.failed === false &&
            satisfiesRequiredInput(required.input, call.input),
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
