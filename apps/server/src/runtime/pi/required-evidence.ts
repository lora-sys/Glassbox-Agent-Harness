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
import { WEB_FETCH_TOOL, WEB_SEARCH_TOOL } from "./web-tools.js";
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
  | "web_search"
  | "web_fetch"
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
 * different requests ("搜索一下这个文件，群历史里可能有") is not a history-search request. The
 * object must name a group's history, so a message about searching anything else — a member,
 * a file, an order — never binds the Tool.
 */
const GROUP_HISTORY_REQUEST =
  /(?:搜索|搜|查找|查|检索|查询|翻)\s*(?:一下|一翻|一遍)?\s*(?:本群|群里|群内|该群|此群|当前群|群)\s*(?:的)?\s*(?:历史|聊天记录|消息记录|群聊记录|聊天历史|历史消息)/iu;

/** A sender-qualified history search, where the sender filter precedes the history noun. */
const GROUP_HISTORY_SENDER_REQUEST =
  /(?:搜索|搜|查找|查|检索|查询|翻)\s*(?:发送者|群成员|成员|用户)\s*(?:QQ(?:号)?\s*)?([1-9]\d{4,15})\s*(?:发的|发过的|发送的|发布的|的)\s*(?:本群|群里|群内|该群|此群|当前群|群)\s*(?:的)?\s*(?:历史|聊天记录|消息记录|群聊记录|聊天历史|历史消息)/iu;

/**
 * The negations that can refuse a request, and the verbs that make one.
 *
 * 别 is deliberately absent from the negations because it is also part of ordinary words such
 * as 特别, and reading those as a refusal would silently drop a request the user actually made.
 * 别再, 别去 and 别帮我 are unambiguous and stay.
 */
const REFUSAL_WORDS = "不要|不用|无需|不需要|请勿|不许|停止|别再|别去|别帮我";

/**
 * The verbs that ask to be told, shown or handed something. Longest first, so a negation before
 * 查看 is read as governing 查看 rather than the 查 that 查看 starts with.
 */
const REQUEST_VERBS = "搜索|查找|查看|查询|检索|列出|列表|显示|告诉|搜|翻|查|看|读";

/**
 * A negation that governs a request: the request's own verb follows it.
 *
 * This is the whole of what makes a message a refusal. A negation somewhere in a message is not
 * a refusal of it — `不要漏掉管理员` asks for the list and adds an instruction about the list,
 * and `停止维护的那些也算` narrows which files count. Testing the whole message for a negation
 * word read both as refusals and deleted every requirement the message made, which is the one
 * state in which a Run may answer with nothing observed: the failure the evidence check exists
 * to prevent, arriving through the check itself.
 */
const REFUSED_REQUEST = new RegExp(`(?:${REFUSAL_WORDS})\\s*(?:再)?\\s*(?:${REQUEST_VERBS})`, "u");

/** The run of text between a message's punctuation. */
const PUNCTUATION_SPAN = /[^，,、；;。！？!?\n]+/gu;

/**
 * The connectives that join two requests inside one punctuation span.
 *
 * `把群名称改成 Lora 群并告诉我有哪些成员` is one span and two requests: an instruction and a
 * question. Judging it as one unit let the instruction's verb speak for the question, so the
 * question required nothing and the Run could answer it from the Conversation.
 *
 * The refusal path deliberately does not split on these. `不要查看群成员并查看群文件` can be read
 * as refusing both, and reading it as refusing one would have the Run read something the user
 * refused — worse than requiring nothing at all.
 */
const REQUEST_JOINER = /\s*(?:并|然后|另外|顺便|同时|还有)\s*/u;

/**
 * The requests a message makes, in order.
 *
 * Punctuation is one way a message separates two requests and a connective is another, so both
 * are boundaries. Every gate below judges one of these, so a gate that says what one request is
 * not cannot speak for another request beside it.
 */
function requests(text: string): readonly string[] {
  return (text.match(PUNCTUATION_SPAN) ?? [text])
    .flatMap((span) => span.split(REQUEST_JOINER))
    .filter((request) => request !== "");
}

/**
 * The message with every span that refuses a request removed.
 *
 * A refusal refuses its own span, so removing that span leaves the rest of what the message asks
 * and a message that refuses one read while asking another still requires the one it asked for.
 * The removal is the only change: a message with no governing negation is returned untouched, so
 * nothing else about how a requirement is read moves with this rule.
 *
 * The span is the punctuation-delimited one rather than the single request, so a refusal covers
 * every request joined to it.
 */
function withoutRefusedClauses(text: string): string {
  if (!REFUSED_REQUEST.test(text)) return text;
  return (text.match(PUNCTUATION_SPAN) ?? [])
    .filter((span) => !REFUSED_REQUEST.test(span))
    .join(" ");
}

/** The requests a message makes that ask for something, in order. */
function askingRequests(rawText: string): readonly string[] {
  const kept = withoutRefusedClauses(rawText);
  if (!CAPABILITY_QUESTION.test(kept)) return requests(kept);
  return requests(kept).filter((request) => !CAPABILITY_QUESTION.test(request));
}

/**
 * The message reduced to the requests that ask for something, joined in order.
 *
 * Two kinds of request ask for nothing: one that refuses a request, and one that asks how
 * something is done or whether it can be done. Each speaks only for itself, and reading either
 * as a property of the whole message let one request delete another's requirement —
 * `把成员 10004 禁言 60 秒，另外本群有哪些成员` both changes the group and asks what it
 * contains, and `怎么查看群成员？另外群文件有哪些` asks a question and gives a request. The
 * first half then had no requirement, so the Run could answer it from the Conversation; the
 * second had none either, so a Run could be required to answer the half that asked nothing.
 *
 * Nothing else about how a requirement is read moves with this rule: the requests that remain are
 * kept in their order and their words, and a message with no such request keeps every word it
 * had.
 */
export function requestClauses(rawText: string): string {
  return askingRequests(rawText).join("，");
}

/**
 * Whether the current group message explicitly asks to search this group's history.
 */
export function groupHistorySearchRequested(rawText: string): boolean {
  // Read from the requests that ask for something, so a question about how to search does not
  // delete a search request made beside it.
  const asking = requestClauses(rawText);
  return GROUP_HISTORY_REQUEST.test(asking) || GROUP_HISTORY_SENDER_REQUEST.test(asking);
}

/** The QQ sender id bound by an explicit sender-qualified group-history search, if present. */
export function groupHistorySearchSender(rawText: string): string | undefined {
  return GROUP_HISTORY_SENDER_REQUEST.exec(requestClauses(rawText))?.[1];
}

/**
 * Whether the current Owner-private message explicitly asks to search one or more groups.
 *
 * This check runs before the management-query check. A search request often asks to "list"
 * the matched sender and text, or says to reply in the "current" private chat. Those words
 * describe the requested answer and audience. They do not turn the request into a group-policy
 * query. A request about the history setting or its status remains a management query — and
 * that is a property of the request that asks it, not of the message, so a request that asks to
 * search beside one that asks about the setting is still a search request.
 */
export function ownerHistorySearchRequested(rawText: string): boolean {
  const asking = askingRequests(rawText)
    .filter((request) => !POLICY_QUESTION.test(request))
    .join("，");
  if (
    !/(?:已授权|管理的|多个\s*群|两个\s*群|所有\s*群|各个\s*群|群\s*[1-9]\d{4,15}|[1-9]\d{4,15}\s*群)/u.test(
      asking,
    )
  )
    return false;
  return /(?:搜索|搜|查找|查|检索|查询)[^。！？\n]{0,120}(?:群\s*(?:的)?\s*(?:历史|聊天记录|消息记录|群聊记录|聊天历史|历史消息)|已授权[^。！？\n]{0,40}(?:历史|聊天记录|消息记录))/u.test(
    asking,
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

/**
 * A question about whether or how something is *possible* is not a request for its result.
 *
 * 是否 is deliberately absent. It asks whether a fact holds, which is a question about the world
 * and is answered by observing it; reading it as a possibility question required no observation
 * at all, so a Run could answer 是 or 否 with the evidence check satisfied and nothing behind the
 * answer. A question that really is about possibility names possibility: 能否, 能不能, 可否.
 */
const CAPABILITY_QUESTION =
  /如何|怎么|能否|能不能|可否|可以吗|(?:谁|我|管理员|群主|成员|机器人|你)[^。！？\n]{0,80}可以[^。！？\n]{0,80}吗/u;

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
 *
 * 是否 belongs here rather than with the possibility questions. "本群历史检索是否已经开启" asks
 * whether a setting is on, and an adverb between 是否 and the verb does not change what it asks.
 */
const POLICY_QUESTION =
  /(?:历史|聊天记录|消息记录|成员|文件)[^。！？\n]{0,16}(?:状态|配置|开关|是否\s*(?:已经|已)?\s*(?:启用|开启|允许))/u;

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
 *
 * A request that refuses one contributes no requirement, and a request that does not refuse one
 * contributes whatever it asks for. A negation is read as a refusal only when it governs a
 * request's own verb, so an instruction *about* a request — `不要漏掉管理员` — is not one.
 */
export function requiredEvidenceFor(input: RequiredEvidenceInput): RequiredEvidence[] {
  // Read from the requests that ask for something, so a refusal or a possibility question drops
  // the request it speaks for and nothing else the message asks for.
  const text = requestClauses(input.text);
  const required: RequiredEvidence[] = [];
  const group = namedGroupId(text);
  const explicitUrl = /https?:\/\/[^\s，,。！？!?]+/iu.exec(text)?.[0];
  if (explicitUrl && /(?:打开|读取|抓取|查看|总结|摘要|read|fetch|open|summarize)/iu.test(text))
    required.push({ domain: "web_fetch", tool: WEB_FETCH_TOOL, input: { url: explicitUrl } });
  else if (
    ((/(?:搜索|搜一下|查找|检索|查询|上网查|web search|search the web|look up)/iu.test(text) &&
      /(?:网页|网站|互联网|网上|网络|资料|新闻|来源|web|online|internet|latest|current|最近|最新)/iu.test(
        text,
      )) ||
      /(?:今天|现在|当前|最新|近期|today|latest|current)\s*[^，,。！？!?]{0,60}(?:发布|版本|价格|新闻|官网|release|version|price|announc)/iu.test(
        text,
      )) &&
    !groupHistorySearchRequested(text) &&
    !ownerHistorySearchRequested(text) &&
    !asksLiveQqFact(text)
  )
    required.push({ domain: "web_search", tool: WEB_SEARCH_TOOL, input: {} });

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
  if (!input.isOwner) return required;
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

/**
 * The domains the message asks about, read request by request.
 *
 * Each gate below says what *one request* is not: not a possibility question, not an instruction
 * to change something, not a question about a setting. Applying them to the whole message made
 * each of them a statement about every request in it, so one request could both delete another
 * request's requirement — `把成员 10004 禁言 60 秒，另外本群有哪些成员` changes the group and
 * asks what it contains — and add one the message never made, since an instruction's own nouns
 * (`群名称`) were read as a question about the group's profile.
 *
 * The read verb is read from the message rather than the request: a request that names a domain
 * and leans on the previous one's verb — `本群成员有哪些？群文件呢` — is still asking for that
 * domain.
 */
function liveDomainsRequested(
  text: string,
  scope: "current-group" | "named-group",
): readonly LiveDomain[] {
  const asking = requests(text).filter(
    (request) =>
      !CAPABILITY_QUESTION.test(request) &&
      !MUTATION_VERB.test(request) &&
      !POLICY_QUESTION.test(request),
  );
  if (asking.length === 0) return [];
  if (!READ_VERB.test(text)) return [];
  return LIVE_DOMAINS.filter(
    (domain) =>
      (scope === "named-group" || domain.currentGroup) &&
      asking.some((request) => domain.nouns.test(request)),
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
