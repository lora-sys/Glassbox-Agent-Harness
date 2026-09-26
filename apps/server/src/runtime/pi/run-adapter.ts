import type { PublicModelProfile, QqSourceClass } from "@glassbox/contracts";
import type {
  RunExecutionAdapter,
  ExecutionInput,
  ExecutionResult,
} from "../../execution/run-service/types.js";
import { scopeKey } from "../../identity/scope.js";
import {
  estimateUnicodeTokens,
  projectContextBudget,
  type ContextDemandEstimate,
  type ContextProjectionResult,
} from "../../efficiency/index.js";
import { exactTerms } from "../../retrieval/exact-term.js";
import type { QqCapabilityCategory } from "../../channels/onebot/capabilities.js";
import { WEB_CAPABILITIES } from "../../management/web-capability-policy.js";
import type { PiRunContext, PiRuntimeAdapter, PiRuntimeProfileName } from "./types.js";
import {
  GROUP_HISTORY_SEARCH_TOOL,
  OWNER_HISTORY_SEARCH_TOOL,
  projectStrictHistoryReply,
  strictHistoryReplySpec,
} from "./history-tools.js";
import { requiredInputClause, satisfiesRequiredInput } from "./protected-tools.js";
import { OWNER_GROUP_ADMIN_TOOL } from "./owner-tools.js";
import { OWNER_MEMORY_ADMIN_TOOL } from "./owner-memory-tools.js";
import { OWNER_MODEL_ADMIN_TOOL } from "./owner-model-tools.js";
import {
  asksLiveQqFact,
  groupHistorySearchRequested,
  groupHistorySearchSender,
  namedGroupId,
  officialSourceVerificationRequested,
  ownerHistorySearchRequested,
  requestClauses,
  requiredEvidenceFor,
  resolveEvidence,
  unobservedEvidence,
  type EvidenceResolution,
  type RequiredEvidence,
} from "./required-evidence.js";
import { safeWebEvidenceReply, webAnswerEvidenceFailure } from "./web-answer-evidence.js";

interface RequiredToolCall {
  name: string;
  /** The exact input the current user message requires; every key must match the call. */
  input: Record<string, unknown>;
  /** Additional explicit actions that need independent Tool calls in the same Run. */
  additional?: readonly RequiredToolCall[];
}

/** Parse only the current Owner message; historical or retrieved text is never mutation intent. */
function ownerMemoryCommand(text: string): RequiredToolCall | undefined {
  const command = text.trim();
  const scopeInput = (value: string): Record<string, string> | undefined => {
    if (value === "global") return { scopeType: "global" };
    if (/^project:[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(value))
      return { scopeType: "project", projectId: value.slice(8) };
    return undefined;
  };
  const write =
    /^\/memory write (\S+) (preference|semantic_fact|episodic_event|relationship) (.+)$/u.exec(
      command,
    );
  if (write) {
    const scope = scopeInput(write[1]!);
    if (!scope) return undefined;
    return {
      name: OWNER_MEMORY_ADMIN_TOOL,
      input: { action: "write", ...scope, type: write[2], statement: write[3] },
    };
  }
  const list = /^\/memory list(?: (all|global|project:[A-Za-z0-9][A-Za-z0-9_-]{0,127}))?$/u.exec(
    command,
  );
  if (list) {
    const scope = list[1] === undefined || list[1] === "all" ? undefined : scopeInput(list[1]);
    if (list[1] !== undefined && list[1] !== "all" && !scope) return undefined;
    return {
      name: OWNER_MEMORY_ADMIN_TOOL,
      input: { action: "list", ...scope },
    };
  }
  const get = /^\/memory get (\S+)$/u.exec(command);
  if (get) return { name: OWNER_MEMORY_ADMIN_TOOL, input: { action: "get", id: get[1] } };
  if (command === "/memory candidates")
    return { name: OWNER_MEMORY_ADMIN_TOOL, input: { action: "list_candidates" } };
  const source =
    /^\/memory source (\S+) ([1-9]\d{0,15}) (history|notice|essence|metadata|file|album)$/u.exec(
      command,
    );
  if (source) {
    const scope = scopeInput(source[1]!);
    if (!scope) return undefined;
    return {
      name: OWNER_MEMORY_ADMIN_TOOL,
      input: {
        action: "source",
        ...scope,
        groupId: source[2],
        sourceClass: source[3],
      },
    };
  }
  const feedback =
    /^\/memory feedback (\S+) (accept|reject|edit|revert|explicit_positive|explicit_negative) (.+)$/u.exec(
      command,
    );
  if (feedback) {
    const scope = scopeInput(feedback[1]!);
    if (!scope) return undefined;
    return {
      name: OWNER_MEMORY_ADMIN_TOOL,
      input: { action: "feedback", ...scope, signalType: feedback[2], statement: feedback[3] },
    };
  }
  const changed = /^\/memory (update|supersede) (\S+) (.+)$/u.exec(command);
  if (changed)
    return {
      name: OWNER_MEMORY_ADMIN_TOOL,
      input: { action: changed[1], id: changed[2], statement: changed[3] },
    };
  const governed = /^\/memory (promote|reject|expire|revoke|retire) (\S+)$/u.exec(command);
  if (governed)
    return { name: OWNER_MEMORY_ADMIN_TOOL, input: { action: governed[1], id: governed[2] } };

  const naturalSource =
    /(?:提取|导入|创建|生成).*(?:候选|candidate)|(?:候选|candidate).*(?:提取|导入|创建|生成)/iu.test(
      command,
    );
  if (!naturalSource) return undefined;
  const groupId = namedGroupId(command);
  const scopeMatch = /\b(global|project:[A-Za-z0-9][A-Za-z0-9_-]{0,127})\b/u.exec(command);
  const scope = scopeMatch ? scopeInput(scopeMatch[1]!) : undefined;
  if (!groupId || !scope) return undefined;
  const sourceClass = /(?:历史|history|消息)/iu.test(command)
    ? "history"
    : /(?:公告|notice)/iu.test(command)
      ? "notice"
      : /(?:精华|essence)/iu.test(command)
        ? "essence"
        : undefined;
  if (!sourceClass) return undefined;
  const quotedQuery = /[“"]([^”"]{1,256})[”"]/u.exec(command)?.[1]?.trim();
  return {
    name: OWNER_MEMORY_ADMIN_TOOL,
    input: {
      action: "source",
      ...scope,
      groupId,
      sourceClass,
      ...(quotedQuery ? { query: quotedQuery } : {}),
    },
  };
}

/** Explicitly named Ops calls must be backed by a real Tool result, never model narration. */
function ownerTaskDelegationRequest(text: string): RequiredToolCall | undefined {
  const request = requestClauses(text);
  if (!/(?:调用|执行|使用|尝试调用)\s*`?task_delegate`?/iu.test(request)) return undefined;
  if (/(?:不要|别|不需要|无需|停止)\s*(?:调用|执行|使用|委派)/u.test(request)) return undefined;
  const title = /名为\s*[“"「]?([A-Za-z0-9][A-Za-z0-9._-]{0,127})/u.exec(request)?.[1];
  return { name: "task_delegate", input: title ? { title } : {} };
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
  listModelProfiles?: () => readonly PublicModelProfile[];
  resolveProfileName?: (input: ExecutionInput) => Promise<PiRuntimeProfileName>;
  /**
   * Records the Run's Tool-evidence decision, and how the Run answered it.
   *
   * Called once when the requirement is resolved and once when the Run reaches a terminal
   * state, so an inspector can see both what the Runtime required and what the Run actually
   * observed. The Run's own outcome never depends on whether the record could be written.
   */
  onEvidence?: (record: RunEvidenceRecord) => void | Promise<void>;
  onBudgetEvidence?: (
    record: Extract<RunEvidenceRecord, { type: "context_budget" }>,
  ) => void | Promise<void>;
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
      type: "context_budget";
      runId: string;
      principalId: string;
      conversationId: string;
      policyVersion: "p5a-context-v1";
      estimateSource: "unicode_conservative";
      demandTokens: number;
      contextWindowTokens: number;
      outputReserveTokens: number;
      thinkingReserveTokens: number;
      projectedTokens: number | null;
      includedExchangeCount: number;
      omittedExchangeCount: number;
      sourceScanTruncated: boolean;
      omittedBySourceBoundCount: number;
      overflowCode?: string;
    }
  | {
      type: "model_capacity";
      runId: string;
      principalId: string;
      conversationId: string;
      state: "unknown";
      reasonCode: "capacity_unknown";
    }
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
      /** Safe rejection metadata for an explicit mutation that cannot be bound to exact inputs. */
      blockedMutation?: {
        operation: string;
        reason: "incomplete_parameters" | "not_permitted_in_group" | "not_permitted";
      };
    }
  | {
      type: "tool_evidence";
      runId: string;
      principalId: string;
      conversationId: string;
      phase: "resolved";
      resolutions: readonly EvidenceResolution[];
    }
  | {
      type: "web_answer_evidence";
      runId: string;
      principalId: string;
      conversationId: string;
      status: "accepted" | "withheld";
      reason?: "source_not_read" | "unqualified_latest_claim";
    };

function groupHistorySearchFollowUpRequested(input: ExecutionInput): boolean {
  const text = input.text.trim();
  if (!text || /(?:不要|不用|无需|不需要|请勿|不许|停止|别再|别去|别帮我)/u.test(text))
    return false;
  const recentHistory = input.history.slice(-6);
  if (
    !recentHistory.some(
      (turn) =>
        (turn.role === "user" && groupHistorySearchRequested(turn.text)) ||
        /群历史|聊天记录|消息记录|历史消息|检索结果|查到|查到了|发言记录|发言时间线/u.test(
          turn.text,
        ),
    )
  )
    return false;
  const asksToRetryOrVerify =
    /漏|遗漏|不全|完整|全部|所有|继续.{0,12}(?:查|搜|检索|核对)|重新.{0,12}(?:查|搜|检索|核对)|再.{0,12}(?:查|搜|检索|核对)/u.test(
      text,
    );
  const personOrTimeReference =
    /这个人|那个人|此人|他|她|他们|对方|刚才|前面|之前|最新|最近|上次|[1-9]\d{4,15}/u;
  const messageActivity = /说|问|发|发言|消息|记录|检索|查|搜|回复|提到/u;
  return asksToRetryOrVerify || (personOrTimeReference.test(text) && messageActivity.test(text));
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
 * Read from the message alone: the chat type the caller acted in, whether they are the Owner,
 * and the text. The Run's resolved Tool surface is deliberately not an input. A requirement
 * that disappeared with the Tool would leave a Run whose surface withheld it free to answer
 * with a fluent claim about an action it never performed, and that is the state in which a
 * fabricated answer is hardest to detect — a surface that failed to resolve would drop every
 * requirement at once. What the surface decides is *satisfiability*: a Run that cannot call
 * the required Tool fails closed below rather than reporting success. Requiring is never
 * granting: the Tool still re-authorizes its own Resource at execution time.
 */
function requiredToolCall(
  input: ExecutionInput,
  isOwner: boolean,
  authorizedToolNames?: readonly string[],
  modelProfiles: readonly PublicModelProfile[] = [],
): RequiredToolCall | undefined {
  if (input.caller.scope.chatType === "group") {
    if (groupHistorySearchRequested(input.text) || groupHistorySearchFollowUpRequested(input)) {
      // A single segmented identifier is a literal query, not prose for the model to reinterpret.
      // Bind it into the required input so a call for a different value cannot satisfy this Run.
      // Bare digit runs are excluded because they can name a sender rather than message text.
      const identifiers = exactTerms(requestClauses(input.text)).filter((term) =>
        /[a-z]/iu.test(term),
      );
      const sender = groupHistorySearchSender(input.text);
      return {
        name: GROUP_HISTORY_SEARCH_TOOL,
        input: {
          ...(identifiers.length === 1 ? { query: identifiers[0] } : {}),
          ...(sender ? { sender } : {}),
        },
      };
    }
    const text = requestClauses(input.text);
    const mutation = MUTATION_REQUESTS.find((entry) => entry.words.test(text));
    if (!mutation) return undefined;
    const params = mutation.params(text);
    if (params === undefined) return undefined;
    // Group-native roles get only the explicit local subset. `set_group_admin` and file writes
    // remain Glassbox Owner-private even when the current QQ sender is a group owner.
    if (mutation.operation === "set_group_admin" || mutation.tool === "qq_group_file_ops")
      return undefined;
    return {
      name: mutation.tool === "qq_group_settings" ? "qq_group_local_settings" : mutation.tool,
      input: {
        groupId: input.caller.scope.chatId,
        operation: mutation.operation,
        params,
      },
    };
  }
  // Everything below is the Owner-private surface. A management Tool is never required
  // outside a private Owner Run, whatever else a message may name.
  if (input.caller.scope.chatType !== "private" || !isOwner) return undefined;
  const rawText = input.text;
  if (authorizedToolNames?.includes(OWNER_MODEL_ADMIN_TOOL)) {
    const model = ownerModelCommand(rawText, modelProfiles);
    if (model) return model;
  }
  const taskDelegation = ownerTaskDelegationRequest(rawText);
  if (taskDelegation) return taskDelegation;
  if (authorizedToolNames?.includes(OWNER_MEMORY_ADMIN_TOOL)) {
    const memory = ownerMemoryCommand(rawText);
    if (memory) return memory;
  }
  const text = requestClauses(rawText);
  if (
    /不要查看|不用查看|无需查看|不需要查看|请勿查看|不许查看|停止查看|别再查看|别去查看|别帮我查看/u.test(
      rawText,
    )
  )
    return undefined;
  if (ownerHistorySearchRequested(rawText)) return { name: OWNER_HISTORY_SEARCH_TOOL, input: {} };
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

  const webCategories = WEB_CAPABILITIES.filter((category) =>
    new RegExp(`(?:^|[^\\w])${category.replace(".", "\\.")}(?=$|[^\\w])`, "iu").test(text),
  );
  const disabled = /关闭|停用|禁用|取消|移除/u.test(text);
  const enabled = /启用|开启|打开|允许|恢复|加入/u.test(text);
  // Mixed or negated Web requests cannot be represented by one shared enabled flag.
  // Refuse the mutation instead of changing any category in the wrong direction.
  if (
    webCategories.length > 0 &&
    ((disabled && enabled) ||
      /(?:不要|别|请勿|禁止|不)(?:再)?(?:启用|开启|打开|允许|恢复|加入)/u.test(text))
  )
    return undefined;
  const changeRequested = disabled || enabled;
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
  if (webCategories.length > 0)
    return {
      name: OWNER_GROUP_ADMIN_TOOL,
      input: {
        action: "set_capability",
        groupId,
        enabled: !disabled,
        category: webCategories[0],
      },
      ...(webCategories.length > 1
        ? {
            additional: webCategories.slice(1).map((category) => ({
              name: OWNER_GROUP_ADMIN_TOOL,
              input: {
                action: "set_capability",
                groupId,
                enabled: !disabled,
                category,
              },
            })),
          }
        : {}),
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

interface BlockedMutation {
  operation: string;
  reason: "incomplete_parameters" | "not_permitted_in_group" | "not_permitted";
}

function explicitModelSelectionCommand(text: string): boolean {
  const command = text.trim().replace(/^(?:Bob|Glassbox|玻璃盒)[，,\s]+/iu, "");
  return /^(?:请|帮我)?\s*(?:(?:切换(?:模型)?(?:到|成|为)?|换(?:到|成)|switch to)\s*.*|使用\s+.+)$/iu.test(
    command,
  );
}

/**
 * A mutation is explicit only when the current request uses command syntax. This prevents
 * explanatory questions and quoted capability descriptions from being treated as actions.
 */
function blockedMutationRequest(
  input: ExecutionInput,
  isOwner: boolean,
  modelProfiles: readonly PublicModelProfile[] = [],
): BlockedMutation | undefined {
  if (explicitModelSelectionCommand(input.text)) {
    if (input.caller.scope.chatType === "group")
      return { operation: "model:switch", reason: "not_permitted_in_group" };
    if (!isOwner) return { operation: "model:switch", reason: "not_permitted" };
    if (!ownerModelCommand(input.text, modelProfiles))
      return { operation: "model:switch", reason: "incomplete_parameters" };
  }
  const text = requestClauses(input.text).trim();
  if (!text) return undefined;
  const command =
    /^(?:(?:请|麻烦|帮我|马上|现在)\s*)?(?:(?:把|将)\s*|全员禁言|全体禁言|禁言|闭嘴|踢出|踢掉|踢人|踢了|移出群|新建文件夹|建文件夹|创建文件夹|删除文件|删文件|改名)/u;
  if (!command.test(text)) return undefined;
  const mutation = MUTATION_REQUESTS.find((entry) => entry.words.test(text));
  if (!mutation) return undefined;
  if (mutation.params(text) === undefined)
    return { operation: mutation.operation, reason: "incomplete_parameters" };
  if (
    input.caller.scope.chatType === "group" &&
    (mutation.operation === "set_group_admin" || mutation.tool === "qq_group_file_ops")
  )
    return { operation: mutation.operation, reason: "not_permitted_in_group" };
  if (input.caller.scope.chatType === "private" && isOwner && namedGroupId(text) === undefined)
    return { operation: mutation.operation, reason: "incomplete_parameters" };
  return undefined;
}

export function projectRunHistory(
  input: Pick<ExecutionInput, "text" | "history" | "historyRunIds">,
  capacity: {
    contextWindowTokens: number;
    outputReserveTokens: number;
    thinkingReserveTokens: number;
    safetyMarginTokens: number;
  },
  staticEstimate: { systemTokens: number; toolSchemaTokens: number },
): { result: ContextProjectionResult; demand: ContextDemandEstimate; included: Set<string> } {
  const exchanges = Array.from({ length: Math.floor(input.history.length / 2) }, (_, index) => {
    const user = input.history[index * 2];
    const assistant = input.history[index * 2 + 1];
    return {
      id: input.historyRunIds?.[index] ?? `exchange-${index}`,
      userTokens: estimateUnicodeTokens(user?.text ?? "") + 8,
      assistantTokens: estimateUnicodeTokens(assistant?.text ?? "") + 8,
    };
  });
  const currentMessageTokens = estimateUnicodeTokens(input.text);
  const demand: ContextDemandEstimate = {
    estimatedMaterialTokens:
      staticEstimate.systemTokens +
      staticEstimate.toolSchemaTokens +
      currentMessageTokens +
      exchanges.reduce((sum, exchange) => sum + exchange.userTokens + exchange.assistantTokens, 0),
    estimateSource: "unicode_conservative",
    hasLargeAuthorizedContext:
      exchanges.length > 20 ||
      exchanges.some((exchange) => exchange.userTokens + exchange.assistantTokens > 4096),
    requiredOutputClass: "standard",
    hasToolOrRetrieval: staticEstimate.toolSchemaTokens > 0,
    hasAttachmentsOrArtifacts: false,
    trustedPolicyFlags: [],
    systemTokens: staticEstimate.systemTokens,
    currentMessageTokens,
    toolSchemaTokens: staticEstimate.toolSchemaTokens,
    requiredFloorTokens: 256,
    exchanges,
  };
  const result = projectContextBudget(demand, capacity);
  return {
    result,
    demand,
    included: new Set(result.ok ? result.projection.includedExchangeIds : []),
  };
}

function recreatedPrompt(input: ExecutionInput, included: Set<string>): string {
  const history = input.history
    .filter((_, index) =>
      included.has(
        input.historyRunIds?.[Math.floor(index / 2)] ?? `exchange-${Math.floor(index / 2)}`,
      ),
    )
    .map((message) => `${message.role === "user" ? "User" : "Assistant"}: ${message.text}`)
    .join("\n");
  if (!history) return input.text;
  return `Authorized Conversation history:\n${history}\n\nCurrent user message:\n${input.text}`;
}

function ownerModelCommand(
  text: string,
  profiles: readonly PublicModelProfile[],
): RequiredToolCall | undefined {
  const command = text.trim().replace(/^(?:Bob|Glassbox|玻璃盒)[，,\s]+/iu, "");
  if (/^(?:当前模型|现在是什么模型|当前用的模型|\/model current)$/iu.test(command))
    return { name: OWNER_MODEL_ADMIN_TOOL, input: { action: "current" } };
  if (/^(?:恢复默认模型|切回默认模型|使用默认模型|\/model default)$/iu.test(command))
    return { name: OWNER_MODEL_ADMIN_TOOL, input: { action: "clear" } };
  if (/^(?:有哪些模型|列出模型|可切换模型|\/model list)$/iu.test(command))
    return { name: OWNER_MODEL_ADMIN_TOOL, input: { action: "list" } };
  const requested =
    /^(?:请|帮我)?\s*(?:切换(?:模型)?(?:到|成|为)|换(?:到|成)|使用|switch to)\s*["'“「]?(.+?)["'”」]?\s*$/iu
      .exec(command)?.[1]
      ?.replace(/\s*模型$/u, "")
      .trim();
  if (!requested) return undefined;
  const normalized = (value: string) => value.trim().toLocaleLowerCase();
  const matches = profiles.filter((profile) =>
    [profile.id, profile.label, profile.model].some(
      (alias) => normalized(alias) === normalized(requested),
    ),
  );
  const ids = [...new Set(matches.map((profile) => profile.id))];
  if (ids.length !== 1) return undefined;
  return { name: OWNER_MODEL_ADMIN_TOOL, input: { action: "select", profileId: ids[0] } };
}

export class PiRunExecutionAdapter implements RunExecutionAdapter {
  readonly supportsGroup = true;

  constructor(
    private readonly runtime: PiRuntimeAdapter,
    private readonly options: PiRunExecutionAdapterOptions = {},
  ) {}

  async execute(input: ExecutionInput): Promise<ExecutionResult> {
    const isOwner = this.options.isOwner
      ? await this.options.isOwner(input)
      : input.caller.principalId === "owner";
    const modelProfiles = this.options.listModelProfiles?.() ?? [];
    const blockedMutation = blockedMutationRequest(input, isOwner, modelProfiles);
    if (blockedMutation) {
      await this.recordEvidence({
        type: "tool_evidence",
        runId: input.run.id,
        conversationId: input.conversation.id,
        principalId: input.caller.principalId,
        phase: "required",
        required: [],
        blockedMutation,
      });
      return {
        status: "failed",
        text:
          blockedMutation.reason === "not_permitted_in_group"
            ? "该操作未在群聊中开放，未执行。"
            : blockedMutation.reason === "not_permitted"
              ? "该操作未授权，未执行。"
              : "请求的操作未执行，请补齐必要参数后重试。",
      };
    }
    await this.runtime.initialize();
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
    const required = requiredToolCall(input, isOwner, context.authorizedToolNames, modelProfiles);
    const requiredCalls = required
      ? [{ name: required.name, input: required.input }, ...(required.additional ?? [])]
      : [];
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
    if (explicitModelSelectionCommand(input.text) && isOwner && required === undefined) {
      await this.recordEvidence({
        type: "tool_evidence",
        runId: input.run.id,
        conversationId: input.conversation.id,
        principalId: input.caller.principalId,
        phase: "required",
        required: [],
        blockedMutation: { operation: "model:switch", reason: "not_permitted" },
      });
      await this.runtime.disposeSession?.(binding.runtimeSessionId);
      return {
        status: "failed",
        text: "模型切换工具当前不可用，未执行。",
        providerSessionId: binding.runtimeSessionId,
      };
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
      const capacity = this.runtime.getModelCapacity?.(binding.runtimeSessionId);
      if (!capacity) {
        await this.options.onEvidence?.({
          type: "model_capacity",
          runId: input.run.id,
          principalId: input.caller.principalId,
          conversationId: input.conversation.id,
          state: "unknown",
          reasonCode: "capacity_unknown",
        });
        await this.runtime.disposeSession?.(binding.runtimeSessionId);
        return {
          status: "failed",
          failureCode: "model_capacity_unknown",
          providerSessionId: binding.runtimeSessionId,
        };
      }
      const staticEstimate = this.runtime.getStaticContextEstimate?.(binding.runtimeSessionId) ?? {
        systemTokens: 4_096,
        toolSchemaTokens: 0,
      };
      const projection = projectRunHistory(input, capacity, staticEstimate);
      const budgetEvidence: Extract<RunEvidenceRecord, { type: "context_budget" }> = {
        type: "context_budget",
        runId: input.run.id,
        principalId: input.caller.principalId,
        conversationId: input.conversation.id,
        policyVersion: "p5a-context-v1",
        estimateSource: "unicode_conservative",
        demandTokens: projection.demand.estimatedMaterialTokens,
        contextWindowTokens: capacity.contextWindowTokens,
        outputReserveTokens: capacity.outputReserveTokens,
        thinkingReserveTokens: capacity.thinkingReserveTokens,
        projectedTokens: projection.result.ok ? projection.result.projection.projectedTokens : null,
        includedExchangeCount: projection.result.ok
          ? projection.result.projection.includedExchangeIds.length
          : 0,
        omittedExchangeCount: projection.result.ok
          ? projection.result.projection.omittedExchangeIds.length
          : projection.demand.exchanges.length,
        sourceScanTruncated: input.historyScanTruncated ?? false,
        omittedBySourceBoundCount: input.historyOmittedRunIds?.length ?? 0,
        ...(!projection.result.ok ? { overflowCode: projection.result.overflow.kind } : {}),
      };
      if (this.options.onBudgetEvidence) await this.options.onBudgetEvidence(budgetEvidence);
      if (!projection.result.ok)
        return {
          status: "failed",
          failureCode: "pre_provider_context_overflow",
          text: "当前请求超过已配置模型的上下文容量，未发送给模型。",
          providerSessionId: binding.runtimeSessionId,
        };
      let result = await this.runtime.run(
        binding,
        { ...input.run, principalId: input.caller.principalId },
        recreatedPrompt(input, projection.included),
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
      const callSatisfied = (expected: RequiredToolCall) =>
        observedCalls.some(
          (call) =>
            call.name === expected.name &&
            call.failed === false &&
            satisfiesRequiredInput(
              expected.input,
              input.caller.scope.chatType === "group"
                ? { ...call.input, groupId: input.caller.scope.chatId }
                : call.input,
            ),
        );
      const missingRequiredCalls = () => requiredCalls.filter((call) => !callSatisfied(call));
      const completedRequiredTool = () => missingRequiredCalls().length === 0;
      // §2/§3 — every domain the message asked about, not the first one the check reached. A
      // message that asks about members *and* notices is not answered by observing one of them.
      const missingRequirements = () => {
        const requiredCall = missingRequiredCalls()[0];
        const evidenceCalls = resolveEvidence(evidence, observedCalls).flatMap(
          (resolution, index) => {
            if (resolution.outcome === "success") return [];
            const candidate = { name: evidence[index]!.tool, input: evidence[index]!.input };
            // One exact required call also satisfies a generic evidence requirement for the same
            // Tool. Asking for both produced a retry that told the model to run the same search
            // twice, once with the bound identifier and once without it.
            if (
              requiredCall &&
              candidate.name === requiredCall.name &&
              satisfiesRequiredInput(candidate.input, requiredCall.input)
            )
              return [];
            return [candidate];
          },
        );
        return [...(requiredCall ? [requiredCall] : []), ...evidenceCalls];
      };
      let missing = missingRequirements();
      if (evidence.some((item) => item.domain.startsWith("browser_"))) {
        // Browser reads depend on navigation. Ask for one missing action per turn so the
        // model cannot dispatch title and screenshot beside the open call in parallel.
        while (result.status === "completed" && missing.length > 0 && !input.signal.aborted) {
          const nextRequired = missing[0]!;
          context.requiredToolName = nextRequired.name;
          context.requiredToolInput = nextRequired.input;
          context.requiredEvidence = evidence.filter(
            (item) =>
              item.tool === nextRequired.name &&
              satisfiesRequiredInput(item.input, nextRequired.input),
          );
          result = await this.runtime.run(
            binding,
            { ...input.run, principalId: input.caller.principalId },
            `Call ${nextRequired.name}${requiredInputClause(nextRequired.input)} now. Wait for its result before another browser action. Do not report success without the Tool result.`,
            context,
          );
          observedCalls.push(...result.toolCalls);
          const remaining = missingRequirements();
          if (
            remaining.some(
              (item) =>
                item.name === nextRequired.name &&
                satisfiesRequiredInput(item.input, nextRequired.input),
            )
          )
            break;
          missing = remaining;
        }
      } else if (
        requiredCalls.length <= 1 &&
        !(
          evidence.some((item) => item.domain === "web_search") &&
          evidence.some((item) => item.domain === "web_fetch")
        )
      ) {
        const delegationAttempted = requiredCalls.some(
          (call) =>
            call.name === "task_delegate" &&
            observedCalls.some(
              (observed) =>
                observed.name === call.name && satisfiesRequiredInput(call.input, observed.input),
            ),
        );
        if (
          result.status === "completed" &&
          missing.length > 0 &&
          !input.signal.aborted &&
          !delegationAttempted
        ) {
          result = await this.runtime.run(
            binding,
            { ...input.run, principalId: input.caller.principalId },
            `The required action has not executed. Call ${missing
              .map(
                ({ name, input: requiredInput }) => `${name}${requiredInputClause(requiredInput)}`,
              )
              .join(
                " and ",
              )} now. Do not ask for confirmation and do not report success without the tool result.`,
            context,
          );
          observedCalls.push(...result.toolCalls);
        }
      } else {
        while (result.status === "completed" && missing.length > 0 && !input.signal.aborted) {
          const nextRequired = missing[0]!;
          context.requiredToolName = nextRequired.name;
          context.requiredToolInput = nextRequired.input;
          result = await this.runtime.run(
            binding,
            { ...input.run, principalId: input.caller.principalId },
            `The required action has not executed. Call ${nextRequired.name}${requiredInputClause(
              nextRequired.input,
            )} now. Do not ask for confirmation and do not report success without the tool result.`,
            context,
          );
          observedCalls.push(...result.toolCalls);
          // Each required action gets one targeted retry. A failed or missing result stays closed.
          if (!callSatisfied(nextRequired)) break;
          missing = missingRequirements();
        }
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
      const missingEvidenceDomains = unobservedEvidence(finalResolutions).map(
        (item) => item.domain,
      );
      const missingEvidence = missingEvidenceDomains.length > 0;
      // A Tool can settle as a failure after cancellation, then the provider can emit a completed
      // turn containing only a refusal or fallback sentence. The Run's explicit cancel signal
      // remains authoritative even when the latest provider result is not `aborted`.
      if (input.signal.aborted || result.status === "aborted") {
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
          text: missingEvidenceDomains.some((domain) => domain.startsWith("browser_"))
            ? "浏览器操作未完成，无法确认页面或提供截图。"
            : missingEvidenceDomains.some((domain) => domain.startsWith("web_"))
              ? "网页检索或读取未完成，因此无法确认。"
              : "未能从 QQ 获取该信息，因此无法确认。",
          providerSessionId: binding.runtimeSessionId,
        };
      if (result.status === "completed" && officialSourceVerificationRequested(input.text)) {
        const failure = webAnswerEvidenceFailure({
          request: input.text,
          answer: result.text,
          toolCalls: observedCalls,
        });
        await this.recordEvidence({
          type: "web_answer_evidence",
          runId: input.run.id,
          principalId: input.caller.principalId,
          conversationId: input.conversation.id,
          status: failure ? "withheld" : "accepted",
          ...(failure ? { reason: failure.reason } : {}),
        });
        if (failure)
          return {
            status: "failed",
            text: safeWebEvidenceReply(failure),
            providerSessionId: binding.runtimeSessionId,
          };
      }
      const strictReply = strictHistoryReplySpec(input.text);
      if (
        strictReply &&
        result.status === "completed" &&
        (requiredName === GROUP_HISTORY_SEARCH_TOOL || requiredName === OWNER_HISTORY_SEARCH_TOOL)
      ) {
        const successfulCall = [...observedCalls]
          .reverse()
          .find(
            (call) =>
              call.name === requiredName &&
              call.failed === false &&
              satisfiesRequiredInput(context.requiredToolInput ?? {}, call.input),
          );
        const projected = successfulCall
          ? projectStrictHistoryReply(strictReply, successfulCall.result)
          : undefined;
        if (!projected)
          return {
            status: "failed",
            text: "未能从 QQ 获取完整的请求字段，因此无法确认。",
            providerSessionId: binding.runtimeSessionId,
          };
        result = { ...result, text: projected };
      }
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

  async disposeWorkspaceSessions(principalId: string, workspaceId: string): Promise<void> {
    await this.runtime.disposeWorkspaceSessions?.(principalId, workspaceId);
  }
}
