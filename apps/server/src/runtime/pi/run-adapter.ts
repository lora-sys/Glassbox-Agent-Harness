import type { QqSourceClass } from "@glassbox/contracts";
import type {
  RunExecutionAdapter,
  ExecutionInput,
  ExecutionResult,
} from "../../execution/run-service/types.js";
import { scopeKey } from "../../identity/scope.js";
import type { QqCapabilityCategory } from "../../channels/onebot/capabilities.js";
import type { PiRunContext, PiRuntimeAdapter, PiRuntimeProfileName } from "./types.js";
import { GROUP_HISTORY_SEARCH_TOOL, OWNER_HISTORY_SEARCH_TOOL } from "./history-tools.js";
import { requiredInputClause, satisfiesRequiredInput } from "./protected-tools.js";
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
    /(?:成员|群员|用户|把|将|给|对|踢出|踢掉|踢人|踢了|移出群)\s*(\d{5,15})|(\d{5,15})\s*(?:禁言|闭嘴|踢出|踢掉|踢人|移出群|名片|管理员)/u.exec(
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

/** The group-card value the Owner names, including an explicit request to clear it. */
function namedGroupCard(text: string): string | undefined {
  if (/(?:清空|清除|删除|移除|取消)/u.test(text) && /(?:群名片|名片)/u.test(text)) {
    return "";
  }
  return namedText(text);
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
 * The rejoin flag a kick message names, if it names one.
 *
 * `set_group_kick`'s `reject_add_request` is optional at the provider, so the message must say
 * which value it wants: a kick that blocks rejoin and one that allows it are different
 * requests. A message that names neither yields `undefined`, and the caller then binds the
 * member alone — leaving the flag unset so the provider default applies, rather than letting
 * the model choose a value the Owner never asked for.
 *
 * `不拒绝` is tested before `拒绝` and `不允许` before `允许`, since each contains the other.
 */
function namedRejectAddRequest(text: string): boolean | undefined {
  if (/不拒绝/u.test(text)) return false;
  if (/拒绝|不允许|拉黑/u.test(text)) return true;
  if (/允许/u.test(text)) return false;
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
 * `set_group_kick` qualifies: the member comes from the message, and its optional
 * `reject_add_request` flag is bound only when the message names it, so an unstated flag
 * stays at the provider default instead of a value the model chose. `upload_group_file` is
 * not listed — and is no longer on the capability surface at all, because its `file`
 * parameter is a local server path with no Asset-mediated upload boundary to authorize it.
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
    tool: "qq_group_moderation",
    operation: "set_group_kick",
    words: /踢出|踢掉|踢人|踢了|移出群/iu,
    params: (text): RequiredMutationParams => {
      const user_id = namedMemberId(text);
      if (user_id === undefined) return undefined;
      // The flag is bound only when the message names it. When it does not, the required
      // params carry the member alone, so a call that adds the flag is a different request
      // and the provider default stands.
      const reject = namedRejectAddRequest(text);
      if (reject === undefined) return { user_id };
      return { user_id, reject_add_request: reject };
    },
  },
  {
    tool: "qq_group_settings",
    operation: "set_group_card",
    words: /群名片|名片/iu,
    params: (text) => {
      const user_id = namedMemberId(text);
      const card = namedGroupCard(text);
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

/**
 * The words that ask to search the history of the group the Run is already in.
 *
 * The verb and its object must be adjacent: a message that merely contains 搜索 and 历史 in
 * different clauses ("搜索一下这个文件，群历史里可能有") is not a history-search request. The
 * object must name a group's history, so a message about searching anything else — a member,
 * a file, an order — never binds the Tool.
 */
const GROUP_HISTORY_REQUEST =
  /(?:搜索|搜|查找|查|检索|查询|翻)\s*(?:一下|一翻|一遍)?\s*(?:本群|群里|群内|该群|此群|当前群|群)\s*(?:的)?\s*(?:历史|聊天记录|消息记录|群聊记录|聊天历史|历史消息)/iu;

/**
 * The negations that turn a request into a refusal.
 *
 * The words are unambiguous ones: 别 is deliberately absent because it is also part of
 * ordinary words such as 特别, and reading those as a refusal would silently drop a request
 * the user actually made.
 */
const GROUP_HISTORY_REFUSAL = /(?:不要|不用|无需|不需要|请勿|不许|停止|别再|别去|别帮我)\s*$/u;

/**
 * Whether the current group message explicitly asks to search this group's history.
 *
 * Read from the current user message alone. Retrieved group history, a notice, file content,
 * a Tool result or an earlier Conversation turn can describe a search without ever being one,
 * so none of them can require a Tool call.
 */
function groupHistorySearchRequested(text: string): boolean {
  const match = GROUP_HISTORY_REQUEST.exec(text);
  if (!match) return false;
  // A negation in the clause immediately before the request makes it a refusal.
  if (GROUP_HISTORY_REFUSAL.test(text.slice(0, match.index))) return false;
  // A question about how to search, or whether searching is possible, is not a request to search.
  if (/如何|怎么|能否|是否|可以吗/u.test(text)) return false;
  return true;
}

/**
 * Whether the current Owner-private message explicitly asks to search one or more groups.
 *
 * This check runs before the management-query check. A search request often asks to "list"
 * the matched sender and text, or says to reply in the "current" private chat. Those words
 * describe the requested answer and audience. They do not turn the request into a group-policy
 * query. A request about the history setting or its status remains a management query.
 */
function ownerHistorySearchRequested(text: string): boolean {
  if (/不要|不用|无需|不需要|请勿|不许|停止|别再|别去|别帮我/u.test(text)) return false;
  if (/如何|怎么|能否|是否|可以吗/u.test(text)) return false;
  if (/(?:历史|聊天记录|消息记录)[^。！？\n]{0,16}(?:状态|配置|开关|是否启用|是否开启)/u.test(text))
    return false;
  if (
    !/(?:已授权|管理的|多个\s*群|两个\s*群|所有\s*群|各个\s*群|群\s*[1-9]\d{4,15}|[1-9]\d{4,15}\s*群)/u.test(
      text,
    )
  )
    return false;
  return /(?:搜索|搜|查找|查|检索|查询)[^。！？\n]{0,120}(?:群\s*(?:的)?\s*(?:历史|聊天记录|消息记录|群聊记录|聊天历史|历史消息)|已授权[^。！？\n]{0,40}(?:历史|聊天记录|消息记录))/u.test(
    text,
  );
}

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

/**
 * The Tool the current message requires, or `undefined` when it requires none.
 *
 * A group Run can only ever reach the current-group history Tool, and only while its own
 * discovered surface carries it. Requiring a Tool the surface does not offer would fail an
 * honest Run closed against a Tool the model was never given, so the requirement follows the
 * surface the runtime resolved rather than the message alone. Requiring is never granting:
 * the Tool still re-authorizes its own Resource at execution time.
 */
function requiredToolCall(
  input: ExecutionInput,
  isOwner: boolean,
  authorizedToolNames: readonly string[] | undefined,
): RequiredToolCall | undefined {
  if (input.caller.scope.chatType === "group") {
    if (!authorizedToolNames?.includes(GROUP_HISTORY_SEARCH_TOOL)) return undefined;
    if (!groupHistorySearchRequested(input.text)) return undefined;
    // The message names no parameter of its own: the query is the model's to compose, and the
    // group comes from the Run's trusted scope. The requirement is the call, not its arguments.
    return { name: GROUP_HISTORY_SEARCH_TOOL, input: {} };
  }
  // Everything below is the Owner-private surface. A management Tool is never required
  // outside a private Owner Run, whatever else a message may name.
  if (input.caller.scope.chatType !== "private" || !isOwner) return undefined;
  const text = input.text;
  if (/不要|别|无需/u.test(text)) return undefined;
  if (authorizedToolNames?.includes(OWNER_HISTORY_SEARCH_TOOL) && ownerHistorySearchRequested(text))
    return { name: OWNER_HISTORY_SEARCH_TOOL, input: {} };
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
    // The required Tool is decided *after* the session is created, because the runtime
    // resolves the Run's discovered Tool surface while creating it. Deciding before would
    // have to guess that surface, and a guess that disagreed with it would either require a
    // Tool the model was never offered or silently drop a requirement the Run could meet.
    const context: PiRunContext = {
      caller: input.caller,
      conversationId: input.conversation.id,
      runId: input.run.id,
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
    const required = requiredToolCall(input, isOwner, context.authorizedToolNames);
    if (required !== undefined) {
      context.requiredToolName = required.name;
      context.requiredToolInput = required.input;
    }
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
          `The required action has not executed. Call ${requiredName} now${requiredInputClause(context.requiredToolInput)}. Do not ask for confirmation and do not report success without the tool result.`,
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
