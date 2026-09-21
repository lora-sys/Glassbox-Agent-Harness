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
import {
  asksLiveQqFact,
  groupHistorySearchRequested,
  namedGroupId,
  ownerHistorySearchRequested,
  requestClauses,
  requiredEvidenceFor,
  resolveEvidence,
  unobservedEvidence,
  type EvidenceResolution,
  type RequiredEvidence,
} from "./required-evidence.js";

interface RequiredToolCall {
  name: string;
  /** The exact input the current user message requires; every key must match the call. */
  input: Record<string, unknown>;
}

/** The provider parameters the current message pins down, or `undefined` when it pins none. */
type RequiredMutationParams = Record<string, string | number | boolean> | undefined;

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
export interface PiRunExecutionAdapterOptions {
  isOwner?: (input: ExecutionInput) => Promise<boolean>;
  resolveProfileName?: (input: ExecutionInput) => Promise<PiRuntimeProfileName>;
  /**
   * Records the Run's Tool-evidence decision, and how the Run answered it.
   *
   * Called once when the requirement is resolved and once when the Run reaches a terminal
   * state, so an inspector can see both what the Runtime required and what the Run actually
   * observed. The Run's own outcome never depends on whether the record could be written.
   */
  onEvidence?: (record: RunEvidenceRecord) => void | Promise<void>;
}

/**
 * What the Runtime decided a Run had to observe, and what it observed.
 *
 * The Tool call events already carry the call itself; this carries the *decision* the call is
 * judged against, which is the part no reader could reconstruct from the calls alone. It is
 * safe evidence: Tool names, domains and outcomes, never provider text or protected content.
 */
export type RunEvidenceRecord =
  | {
      type: "tool_evidence";
      runId: string;
      principalId: string;
      conversationId: string;
      phase: "required";
      /** The factual domains the current user message requires evidence from. */
      required: readonly RequiredEvidence[];
      /** The mutating Tool the message requires, when it requires one. */
      requiredToolName?: string;
      requiredToolInput?: Record<string, unknown>;
    }
  | {
      type: "tool_evidence";
      runId: string;
      principalId: string;
      conversationId: string;
      phase: "resolved";
      resolutions: readonly EvidenceResolution[];
    };

export function piProfileName(
  chatType: ExecutionInput["caller"]["scope"]["chatType"],
  isOwner: boolean,
): PiRuntimeProfileName {
  return chatType === "group" && !isOwner ? "qq-group" : "main-agent";
}

/**
 * The Tool the current message requires, or `undefined` when it requires none.
 *
 * Read from the message alone: the chat type the caller acted in, whether they are the Owner,
 * and the text. The Run's resolved Tool surface is deliberately not an input. A requirement
 * that disappeared with the Tool would leave a Run whose surface withheld it free to answer
 * with a fluent claim about an action it never performed, and that is the state in which a
 * fabricated answer is hardest to detect — a surface that failed to resolve would drop every
 * requirement at once. What the surface decides is *satisfiability*: a Run that cannot call
 * the required Tool fails closed below rather than reporting success. Requiring is never
 * granting: the Tool still re-authorizes its own Resource at execution time.
 */
function requiredToolCall(input: ExecutionInput, isOwner: boolean): RequiredToolCall | undefined {
  if (input.caller.scope.chatType === "group") {
    if (!groupHistorySearchRequested(input.text)) return undefined;
    // The message names no parameter of its own: the query is the model's to compose, and the
    // group comes from the Run's trusted scope. The requirement is the call, not its arguments.
    return { name: GROUP_HISTORY_SEARCH_TOOL, input: {} };
  }
  // Everything below is the Owner-private surface. A management Tool is never required
  // outside a private Owner Run, whatever else a message may name.
  if (input.caller.scope.chatType !== "private" || !isOwner) return undefined;
  // Read from the requests that ask for something: one that refuses a request, or that asks how
  // something is done or whether it can be, drops the request it speaks for and nothing else the
  // message asks for. A negation somewhere in the message is not a refusal of it — `别太久` is an
  // instruction about a mute, not a refusal to mute — and `可以吗` appended to an instruction asks
  // whether it may be done rather than taking it back. Reading the whole message for either
  // dropped requirements the Owner had actually made.
  const text = requestClauses(input.text);
  if (ownerHistorySearchRequested(text)) return { name: OWNER_HISTORY_SEARCH_TOOL, input: {} };
  const groupId = namedGroupId(text);
  if (!groupId) return undefined;
  // A question about what a group *contains* is answered by live QQ evidence, not by reading
  // the group's Glassbox configuration. Requiring both would make the Run fail closed on a
  // Tool that cannot answer the question it was asked.
  if (!asksLiveQqFact(text) && /查看|查询|列出|当前|有哪些|状态/u.test(text))
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
    // The requirements are written onto the context after the session exists, because the
    // context is what the runtime carries into the Run. They are decided from the message and
    // the caller's scope, so the order the session is created in cannot change them: the
    // surface the runtime resolves alongside it decides only whether the Run can satisfy them.
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
    const required = requiredToolCall(input, isOwner);
    if (required !== undefined) {
      context.requiredToolName = required.name;
      context.requiredToolInput = required.input;
    }
    // §2 — the factual domains the current message cannot be answered without observing. Read
    // from the message alone: the surface the Run got decides whether the requirement can be
    // met, never whether it exists, so a Run whose surface withholds the Tool fails closed
    // rather than answering a live question it had no way to observe.
    const evidence = requiredEvidenceFor({
      text: input.text,
      chatType: input.caller.scope.chatType === "group" ? "group" : "private",
      isOwner,
    });
    if (evidence.length > 0) context.requiredEvidence = evidence;
    await this.recordEvidence({
      type: "tool_evidence",
      runId: input.run.id,
      conversationId: input.conversation.id,
      principalId: input.caller.principalId,
      phase: "required",
      required: evidence,
      ...(required === undefined
        ? {}
        : { requiredToolName: required.name, requiredToolInput: required.input }),
    });
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
      // Calls accumulate across the retry: a domain observed before the retry stays observed,
      // and a mutation that already ran is not re-judged as having never happened. Reading only
      // the latest result would let a successful first call be forgotten by a second one.
      const observedCalls = [...result.toolCalls];
      // The same comparison the mutating-Tool gate uses: a call counts as having carried out
      // the required action only when every key the message pinned down agrees with it. Using
      // a looser check here would accept a Run whose Tool call the gate had refused.
      const completedRequiredTool = () =>
        required === undefined ||
        observedCalls.some(
          (call) =>
            call.name === required.name &&
            call.failed === false &&
            satisfiesRequiredInput(required.input, call.input),
        );
      // §2/§3 — every domain the message asked about, not the first one the check reached. A
      // message that asks about members *and* notices is not answered by observing one of them.
      const missingTools = () =>
        [
          ...(completedRequiredTool() ? [] : [requiredName ?? ""]),
          ...unobservedEvidence(resolveEvidence(evidence, observedCalls)).map(
            (resolution) => resolution.tool,
          ),
        ].filter((name) => name.length > 0);
      const missing = missingTools();
      if (result.status === "completed" && missing.length > 0 && !input.signal.aborted) {
        result = await this.runtime.run(
          binding,
          { ...input.run, principalId: input.caller.principalId },
          `The required action has not executed. Call ${[...new Set(missing)].join(" and ")} now${requiredInputClause(context.requiredToolInput)}. Do not ask for confirmation and do not report success without the tool result.`,
          context,
        );
        observedCalls.push(...result.toolCalls);
      }
      const finalResolutions = resolveEvidence(evidence, observedCalls);
      await this.recordEvidence({
        type: "tool_evidence",
        runId: input.run.id,
        conversationId: input.conversation.id,
        principalId: input.caller.principalId,
        phase: "resolved",
        resolutions: finalResolutions,
      });
      // A Run that never executed the action it was asked for, or never observed the facts it
      // was asked about, cannot stand behind its own text — it does not get to answer from
      // Conversation, from the user's own message, or from what it believes a Tool would have
      // returned. That holds whatever terminal status the Run reached. A cancelled Run is not a
      // claim of success, but its text still reaches the audience: the run service delivers
      // what the Run reported and falls back to a fixed line only when it reported nothing, so
      // skipping the aborted path would deliver the one answer this check exists to withhold
      // whenever the user happened to press Stop. A cancelled Run that cannot back its text
      // reports none, and that fixed line states the outcome instead.
      const missingTool = requiredName !== undefined && !completedRequiredTool();
      const missingEvidence = unobservedEvidence(finalResolutions).length > 0;
      if (result.status === "aborted") {
        return missingTool || missingEvidence
          ? { status: "cancelled", providerSessionId: binding.runtimeSessionId }
          : {
              status: "cancelled",
              text: result.text,
              providerSessionId: binding.runtimeSessionId,
            };
      }
      // The Run reached a terminal status of its own, so an unbacked answer is a failure rather
      // than a cancellation, and the fixed text names which requirement went unmet.
      if (missingTool)
        return {
          status: "failed",
          text: "请求的操作未执行，请稍后重试。",
          providerSessionId: binding.runtimeSessionId,
        };
      if (missingEvidence)
        return {
          status: "failed",
          text: "未能从 QQ 获取该信息，因此无法确认。",
          providerSessionId: binding.runtimeSessionId,
        };
      return {
        // The aborted case returned above, so a Run that reached here either completed or
        // errored; anything else the runtime reports is a failure, never a success.
        status: result.status === "completed" ? "succeeded" : "failed",
        text: result.text,
        providerSessionId: binding.runtimeSessionId,
      };
    } finally {
      input.signal.removeEventListener("abort", abort);
      await this.runtime.disposeSession?.(binding.runtimeSessionId);
    }
  }

  /** Evidence recording is the caller's to fail; a Run's outcome must not depend on it. */
  private async recordEvidence(record: RunEvidenceRecord): Promise<void> {
    if (!this.options.onEvidence) return;
    try {
      await this.options.onEvidence(record);
    } catch {
      // Swallowed deliberately: losing an evidence record is a defect in the recorder, not a
      // reason to turn an honest answer into a failure.
    }
  }

  async cleanup(): Promise<void> {
    return this.runtime.cleanup();
  }
}
