/**
 * Which factual questions only an external Tool can answer, and which Tool answers each.
 *
 * A model can always produce a fluent sentence about a QQ group. This module is the runtime's
 * answer to "did it observe that, or did it compose it?", reduced to a decision made from the
 * *current user message* alone.
 *
 * Three rules keep the policy narrow rather than a blanket "call a Tool for everything":
 *
 *  - A domain is required only when the message asks for that domain's live facts. The words
 *    are the domain's own nouns, and they must sit with a read verb, so an unrelated message
 *    that happens to mention 文件 is not a file request.
 *  - The requirement is a property of the *message*, never of the Run's Tool surface. A Run
 *    whose surface withholds the Tool cannot observe the fact, and that is the case in which a
 *    fabricated answer is most likely and least detectable: gating the requirement on the
 *    surface would make the evidence check weakest exactly where the Run can observe least, and
 *    a surface that failed to resolve would silently require nothing at all. What the surface
 *    decides is satisfiability, not the requirement — so a Run that cannot observe fails closed
 *    instead of asserting. Requiring is never granting: the Tool still re-authorizes its
 *    Resource at execution time.
 *  - Nothing here authorizes anything. A requirement is a condition on the Run's *answer*.
 *
 * The intent is read from `input.text` alone — never from Conversation history, retrieved
 * group history, a notice, file content or an earlier Tool result. Retrieved text that says
 * "搜索本群历史" is content being answered, not an instruction to answer it.
 */

import { GROUP_HISTORY_SEARCH_TOOL, OWNER_HISTORY_SEARCH_TOOL } from "./history-tools.js";
import { satisfiesRequiredInput } from "./protected-tools.js";
import type { ToolExecutionOutcome } from "./tool-plane.js";

/**
 * A factual domain whose current value lives outside Glassbox.
 *
 * The names are domains rather than Tools on purpose: which Tool answers a domain is a
 * registry decision that can change, while "the user asked which members this group has" is
 * the fact the evidence has to explain.
 */
export type RequiredEvidenceDomain =
  | "group_history_search"
  | "owner_history_search"
  | "group_metadata"
  | "group_members"
  | "group_history_page"
  | "group_content"
  | "group_files"
  | "account_status";

export interface RequiredEvidence {
  readonly domain: RequiredEvidenceDomain;
  /** The Tool that can answer it. */
  readonly tool: string;
  /**
   * The exact input the message pins down. Every key must match the call, so a call that
   * answers a different question — another group, another operation — does not satisfy it.
   * Empty when the message pins nothing beyond the Tool itself.
   */
  readonly input: Record<string, unknown>;
}

/** The group id the current message names, if it names one. */
export function namedGroupId(text: string): string | undefined {
  const match = /(?:群\s*([1-9]\d{4,15})|([1-9]\d{4,15})\s*群)/u.exec(text);
  return match?.[1] ?? match?.[2];
}

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
 */
export function groupHistorySearchRequested(text: string): boolean {
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
export function ownerHistorySearchRequested(text: string): boolean {
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

/**
 * The verbs that make a message a request to be told something.
 *
 * A bare domain noun is not a request. "群成员" alone might be a label in a sentence about
 * anything; "群成员有哪些" is a question whose answer has to come from QQ.
 */
const READ_VERB =
  /(?:有哪些|有哪几个|有什么|是哪些|是什么|都是谁|多少人|多少个|几个|列表|列出|查看|查询|查一下|看一下|看看|显示|告诉我|现在|当前|最新的|是不是|是否)/u;

/**
 * The verbs that make a message an instruction to change something.
 *
 * A message that changes a group's state is answered by the mutation gate, not by requiring a
 * read. Without this exclusion "把成员 10004 踢出群" would also demand a member list.
 */
const MUTATION_VERB =
  /(?:禁言|闭嘴|踢出|踢掉|踢人|踢了|移出群|改成|改为|设置为|设为|换成|新建文件夹|建文件夹|创建文件夹|删除文件|删文件|上传文件|同意入群|拒绝入群)/u;

/** A question about whether or how something is possible is not a request for its result. */
const CAPABILITY_QUESTION = /如何|怎么|能否|是否|可以吗/u;

const REFUSAL = /不要|不用|无需|不需要|请勿|不许|停止|别再|别去|别帮我/u;

interface LiveDomain {
  readonly domain: RequiredEvidenceDomain;
  readonly tool: string;
  /** The domain's own nouns. A request has to name one of these. */
  readonly nouns: RegExp;
  /** The provider operation that answers it, omitted when the Tool's own default is right. */
  readonly operation?: string;
  /**
   * True when the Tool is bound to the Run's own group, so the required input never names a
   * group. False when the Tool addresses a group the message must name.
   */
  readonly currentGroup: boolean;
}

/**
 * The read-only QQ factual domains, in the order they are checked.
 *
 * Order matters where one domain's nouns contain another's: 公告 precedes 精华 only because
 * they are separate operations of the same Tool, and 群文件 is listed before 文件夹 so a
 * message about the file list is read as a file list.
 *
 * Every Tool here is a `risk: "read"` capability. A mutating capability is never required as
 * evidence: it is authorized by the mutation-intent gate, and asking to *know* something is
 * never a reason to change it.
 */
const LIVE_DOMAINS: readonly LiveDomain[] = Object.freeze([
  {
    domain: "group_members",
    tool: "qq_group_members",
    nouns: /成员|群员/u,
    operation: "get_group_member_list",
    currentGroup: true,
  },
  {
    domain: "group_content",
    tool: "qq_group_content",
    nouns: /公告/u,
    operation: "_get_group_notice",
    currentGroup: true,
  },
  {
    domain: "group_content",
    tool: "qq_group_content",
    nouns: /精华/u,
    operation: "get_essence_msg_list",
    currentGroup: true,
  },
  {
    domain: "group_files",
    tool: "qq_group_files",
    nouns: /群文件|文件列表|有哪些文件|文件夹/u,
    operation: "get_group_root_files",
    currentGroup: true,
  },
  {
    domain: "group_history_page",
    tool: "qq_group_history",
    // The domain's nouns include the ways a person actually asks for a recent message, not
    // only the word 历史: "这个群最新的消息是什么" is the same live read.
    nouns: /历史|聊天记录|消息记录|(?:最新|最近|当前|现在)的?(?:消息|聊天)/u,
    operation: "get_group_msg_history",
    currentGroup: true,
  },
  {
    domain: "group_metadata",
    tool: "qq_groups",
    // A short connective is allowed between the group word and the noun, so "这个群当前资料"
    // is a profile read. A longer gap is not: "群里发的资料" is about something in the group,
    // not about the group.
    nouns: /(?:群|本群|该群)\s*(?:的|当前|现在|目前)?\s*(?:资料|信息|名称|简介|头像)/u,
    operation: "get_group_info",
    currentGroup: true,
  },
  {
    domain: "account_status",
    tool: "qq_account_status",
    nouns: /账号|登录状态|机器人状态/u,
    operation: "get_login_info",
    currentGroup: false,
  },
]);

/**
 * Whether the message asks about a group's *policy* rather than its live state.
 *
 * "查询群 1126022432 的历史配置状态" names 历史, but the question is about the setting that
 * governs retrieval, which is Glassbox product state read through `owner_group_admin`. Reading
 * it as a request for a live history page would require a provider call that cannot answer it.
 */
const POLICY_QUESTION =
  /(?:历史|聊天记录|消息记录|成员|文件)[^。！？\n]{0,16}(?:状态|配置|开关|是否启用|是否开启|是否允许)/u;

export interface RequiredEvidenceInput {
  readonly text: string;
  readonly chatType: "private" | "group";
  readonly isOwner: boolean;
}

/**
 * The evidence the current message requires before the Run may state a factual answer.
 *
 * Returns every domain the message asks for, so a message that asks about members *and*
 * notices requires both rather than whichever the check happened to reach first.
 *
 * The Run's Tool surface is deliberately not an input. A requirement that disappeared with the
 * Tool would let a Run answer a live question precisely when it had no way to observe it, and
 * would make a surface that failed to resolve indistinguishable from a message that asked
 * nothing. `authorizedToolNames` is the runtime's answer to "could this Run observe it"; the
 * caller resolves that against the requirement instead of letting it suppress the requirement.
 */
export function requiredEvidenceFor(input: RequiredEvidenceInput): RequiredEvidence[] {
  const text = input.text;
  if (REFUSAL.test(text)) return [];
  const required: RequiredEvidence[] = [];
  const group = namedGroupId(text);

  if (input.chatType === "group") {
    // A group Run is bound to its own group, so a domain the message asks about needs no
    // group id: the Run's trusted scope supplies it and the model never names one.
    const searched = groupHistorySearchRequested(text);
    if (searched)
      required.push({ domain: "group_history_search", tool: GROUP_HISTORY_SEARCH_TOOL, input: {} });
    for (const domain of liveDomainsRequested(text, "current-group")) {
      if (searchCoversDomain(domain.domain, searched)) continue;
      required.push({
        domain: domain.domain,
        tool: domain.tool,
        input: domain.operation === undefined ? {} : { operation: domain.operation },
      });
    }
    return required;
  }

  // Everything below is the Owner-private surface. A cross-group search is answered by its own
  // Tool, which addresses groups the message names rather than the Run's scope.
  if (!input.isOwner) return [];
  const searched = ownerHistorySearchRequested(text);
  if (searched)
    required.push({ domain: "owner_history_search", tool: OWNER_HISTORY_SEARCH_TOOL, input: {} });
  for (const domain of liveDomainsRequested(text, "named-group")) {
    if (searchCoversDomain(domain.domain, searched)) continue;
    // A group-scoped domain cannot be required without the group it applies to. The message
    // named none, so there is nothing to bind and the requirement is a refusal, not a guess.
    if (domain.currentGroup && group === undefined) continue;
    required.push({
      domain: domain.domain,
      tool: domain.tool,
      input: {
        ...(domain.currentGroup && group !== undefined ? { groupId: group } : {}),
        ...(domain.operation === undefined ? {} : { operation: domain.operation }),
      },
    });
  }
  return required;
}

/**
 * Whether an explicit history search already covers a domain.
 *
 * "搜索本群历史，找到 P4B-A-1349" names 历史, which is also the live history *page* domain's own
 * noun. A page is one group's recent messages and cannot answer a search across its history, and
 * the words that make the Owner form a search — "列出" the matched sender and text, reply to the
 * "current" chat — describe the answer the user wants rather than asking for a page. Requiring
 * both would fail a Run closed against a read the message never asked for, which is its own way
 * of not answering the question.
 */
function searchCoversDomain(domain: RequiredEvidenceDomain, historySearched: boolean): boolean {
  return historySearched && domain === "group_history_page";
}

function liveDomainsRequested(
  text: string,
  scope: "current-group" | "named-group",
): readonly LiveDomain[] {
  // A question about how to do something, or whether it is possible, asks for no result.
  if (CAPABILITY_QUESTION.test(text)) return [];
  // A message that changes state is answered by the mutation gate.
  if (MUTATION_VERB.test(text)) return [];
  // A question about a setting is Glassbox product state, not the provider's live state.
  if (POLICY_QUESTION.test(text)) return [];
  if (!READ_VERB.test(text)) return [];
  return LIVE_DOMAINS.filter(
    (domain) => domain.nouns.test(text) && (scope === "named-group" || domain.currentGroup),
  );
}

/**
 * Whether the message asks a live-QQ question at all, whatever the Run's surface carries.
 *
 * The management-query branch uses this to stay out of the way: a message that asks what a
 * group *contains* is not a request to read the group's Glassbox configuration, even though
 * both are answered with a Tool call.
 */
export function asksLiveQqFact(text: string): boolean {
  return liveDomainsRequested(text, "current-group").length > 0;
}

/**
 * One Tool call as the runtime recorded it, structurally.
 *
 * Deliberately not `PiRunResult["toolCalls"][number]`: the resolution below is a pure function
 * of the calls, and naming the shape it actually reads keeps it testable without a Run.
 */
export interface ObservedToolCall {
  readonly name: string;
  readonly input: Record<string, unknown>;
  readonly failed?: boolean;
  readonly toolCallId?: string;
  readonly outcome?: ToolExecutionOutcome;
}

/**
 * What became of one required domain in one Run.
 *
 * `not_called` is a first-class outcome rather than an absent field: "the Run never asked" and
 * "the Run asked and the provider refused" are different failures with different repairs, and
 * a record that cannot tell them apart cannot explain the Run.
 */
export interface EvidenceResolution {
  readonly domain: RequiredEvidenceDomain;
  readonly tool: string;
  /** The runtime's id for the call that answered it, when one did. */
  readonly toolCallId?: string;
  readonly outcome: ToolExecutionOutcome | "not_called";
}

/**
 * Whether one recorded call observed one required domain.
 *
 * A call counts only when it did not fail *and* every input the message pinned down agrees
 * with it, using the same comparison the mutating-Tool gate uses. A call that failed — for any
 * reason, including a provider that was never reachable — observed nothing, and a call that
 * answered a different question is not evidence for this one.
 */
function callObserved(evidence: RequiredEvidence, call: ObservedToolCall): boolean {
  return (
    call.name === evidence.tool &&
    call.failed === false &&
    satisfiesRequiredInput(evidence.input, call.input)
  );
}

/**
 * How each required domain was answered, for the Run's evidence record.
 *
 * A recorded call that did not fail is a success: the runtime sets `outcome` from the same
 * `isError` flag, so the two cannot disagree. The fallback covers only callers that report no
 * outcome at all, where "did not fail" is the whole of what they said.
 */
export function resolveEvidence(
  required: readonly RequiredEvidence[],
  toolCalls: readonly ObservedToolCall[],
): EvidenceResolution[] {
  return required.map((evidence) => {
    const call = toolCalls.find((candidate) => callObserved(evidence, candidate));
    if (call === undefined)
      return { domain: evidence.domain, tool: evidence.tool, outcome: "not_called" };
    return {
      domain: evidence.domain,
      tool: evidence.tool,
      ...(call.toolCallId === undefined ? {} : { toolCallId: call.toolCallId }),
      outcome: call.outcome ?? "success",
    };
  });
}

/** The domains that were required and not observed. Empty means every domain was answered. */
export function unobservedEvidence(
  resolutions: readonly EvidenceResolution[],
): EvidenceResolution[] {
  return resolutions.filter((resolution) => resolution.outcome !== "success");
}
