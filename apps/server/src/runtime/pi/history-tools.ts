/**
 * Runtime Tools for authorized Channel history search.
 *
 * Both Tools are thin projections over the shared retrieval path:
 *   authorized source set → OpenSquilla-shaped retriever → MGP-shaped result → bounded Context
 *
 * Security properties enforced here:
 *  - The source set is resolved *before* any protected text is loaded. The current-group Tool
 *    derives its Resource from the Run's own Channel scope and can never name a group; the
 *    Owner cross-group Tool intersects the requested filters with the Principal's assigned and
 *    authorized set, so an unauthorized group contributes zero fetch and zero candidates.
 *  - Each searched Resource is re-authorized at execution time and the decision is recorded
 *    with the Run. The Owner role alone never bypasses a group Resource grant.
 *  - Retrieval evidence carries Run, Resource, source kind, source id, retrieval mode, score,
 *    rank and the safe matched terms — never protected message text.
 *  - Neither Tool can reach raw OneBot RPC or a group the caller may not read.
 */

import { Type } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ReturnMode } from "@glassbox/contracts";
import type { DomainStore } from "../../persistence/index.js";
import type { ChannelArchiveStore } from "../../retrieval/channel-archive.js";
import {
  DEFAULT_PER_SOURCE_CAP,
  selectBoundedContext,
  type BoundedContext,
  type BoundedContextItem,
  type TruncationReason,
} from "../../retrieval/context.js";
import { carriesEveryExactTerm, exactTerms, isBareExactTerm } from "../../retrieval/exact-term.js";
import { MemoryRetriever, type RetrievalCoverage } from "../../retrieval/retriever.js";
import {
  groupResourceId,
  resolveAssignedGroupIds,
  resolveAuthorizedHistorySources,
} from "../../retrieval/source-resolver.js";
import {
  createProtectedTool,
  ToolInputError,
  type ProtectedToolContext,
} from "./protected-tools.js";
import type { QqCapabilityCategory } from "../../channels/onebot/capabilities.js";
import type { ToolExclusionReason } from "./tool-plane.js";
import type { PiRunContext } from "./types.js";

export const GROUP_HISTORY_SEARCH_TOOL = "group_history_search";
export const OWNER_HISTORY_SEARCH_TOOL = "owner_history_search";

/**
 * The Resource the Owner cross-group Tool is gated on.
 *
 * A single call spans several group Resources, so it cannot express its Resource set in one
 * Gate-3 Resource. The Tool is gated on the Owner's own search capability instead, and each
 * concrete group Resource is re-authorized inside `execute` and recorded with the Run.
 */
export const OWNER_HISTORY_RESOURCE = "owner-history";
export const OWNER_HISTORY_ACTION = "history:search";

/** Sentinel Resource for a Tool invoked outside its intended scope. Never registered. */
const SCOPE_MISMATCH_RESOURCE = "history:scope-mismatch";

const HISTORY_READ_ACTION = "history:read";
const DEFAULT_LIMIT = 8;
const MAX_LIMIT = 50;
const MAX_GROUP_FILTERS = 50;
const GROUP_ID_PATTERN = /^[1-9]\d{0,15}$/u;

interface GroupHistoryInput extends Record<string, unknown> {
  query?: string;
  sender?: string;
  mentionsMe?: boolean;
  limit?: number;
  since?: string;
  until?: string;
}

interface OwnerHistoryInput extends GroupHistoryInput {
  /** Optional group filters. Omitted means every assigned and authorized group. */
  groupIds?: readonly string[];
}

export interface HistorySearchItem extends BoundedContextItem {
  /** The group the hit came from. Derived from the source id, never model input. */
  groupId: string;
  /** The group Resource this item came from. Derived from the source id, never model input. */
  resourceId: string;
  /**
   * The authorized sender identity of the archived message.
   *
   * Absent for an item whose content was withheld: provenance follows the content it belongs
   * to, so a policy that hides what was said does not disclose who said it.
   */
  senderId?: string;
  senderName?: string;
}

export interface HistorySearchDetails {
  /** The authorized groups actually searched. Empty when nothing was authorized. */
  groups: string[];
  query: string;
  sourceKind: "channel_message";
  retrievalMode: "lexical";
  runId: string;
  items: HistorySearchItem[];
  /** Restates `coverage.considered`, so the window's size is readable without the nested record. */
  considered: number;
  /**
   * Restates `coverage.truncated`: a bound cut this search's window.
   *
   * The two are the same fact, so they cannot disagree. A narrower reading — only what the
   * bounded Context dropped — would leave this flag false beside a `truncationReasons` list
   * naming a cut, and a reader taking the flag alone would read a cut window as an exhausted
   * one. The coverage record is the wider of the two, so restating it never claims a window was
   * more complete than it was.
   */
  truncated: boolean;
  resultStatus: "matches_found" | "no_matches_in_searched_window";
  coverage: HistorySearchCoverage;
}

/**
 * Why a walk of one group's real history ended where it did.
 *
 * The archive answers a search out of what it has already stored, and what it has stored is
 * whatever previous walks managed to pull. So a search has two windows, not one: the
 * candidates the archive held, and the history the archive itself had been filled with. A
 * walk that stopped at `page_bound_reached` leaves the second one open, and an answer that
 * reads only the first will call a group empty that was never read to its end.
 */
export type HistorySyncStop =
  /** The provider had no older page to give, so the walk saw the source from its newest end back. */
  | "end_of_source"
  /** The walk reached the `since` it was given; older history was deliberately not fetched. */
  | "since_bound_reached"
  /** The walk hit its own page bound with more history still available. */
  | "page_bound_reached"
  /** The provider kept returning the same cursor, so paging could not advance. */
  | "cursor_stuck"
  /** The connection for this group is not registered, so nothing could be read. */
  | "provider_unavailable"
  /** The provider rejected the read. */
  | "provider_failed"
  /** The provider's answer could not be interpreted, so the walk's reach is unknown. */
  | "provider_unknown";

/**
 * What one group's history walk reached, reported by the sync that performed it.
 *
 * `stop` alone would be ambiguous without the count: `end_of_source` after one page means the
 * group is small, while the same stop after five means the walk read as far as it was allowed
 * and found the end. Both are recorded so a reader can tell a complete walk from a truncated
 * one that happened to stop on the same reason.
 */
export interface HistorySyncOutcome {
  /** Pages of real history this walk read. */
  pagesWalked: number;
  /** Why it stopped. */
  stop: HistorySyncStop;
}

/**
 * How much of the searched window this call actually saw.
 *
 * A retrieval result is not a census. The requested limit, the candidate ceiling and the
 * cross-group per-source cap each cut candidates, and each produces the same empty tail as
 * a genuinely exhausted window. Reporting which bound applied is what lets an answer say
 * "no match in what I looked at" instead of "this never happened".
 *
 * The archive is not a census either. It holds what previous walks pulled from the provider,
 * so a search can read every candidate it has and still not have looked at the group. The
 * per-source `sync` and the aggregate `sourceLimits` report that second window, and
 * `coverage` is `complete` only when both are exhausted.
 */
export interface HistorySearchCoverage {
  /** The limit the caller asked for. */
  requestedLimit: number;
  /**
   * Hits that reached the model: the length of the result list this call returned.
   *
   * Counted after every bound, so it is also the sum of the per-source `returned` below. The
   * two report one fact, which is why they cannot disagree — a reader who adds up the per-source
   * counts and compares them with this one is checking the same number twice. The retriever's
   * own count is taken before the bounds run and is what `considered` records.
   */
  returned: number;
  /**
   * Candidates the archive produced for this search, before any filter or bound.
   *
   * This is what the search actually considered, so it is the number a reader compares
   * against `returned`. The per-source `considered` below is the bound's own view — how many
   * of these reached it — and the difference between the two is exactly what the filters and
   * the limit named: `droppedByExactTerm`, the retriever's own filter count, and
   * `droppedByLimit`.
   */
  considered: number;
  /** True when at least one candidate was dropped by a bound rather than by authorization. */
  truncated: boolean;
  /** Why candidates were dropped, deduplicated. Empty when none were. */
  truncationReasons: TruncationReason[];
  /** The per-source cap this search applied; `null` when the search targeted one group. */
  perSourceCap: number | null;
  /**
   * The arbitrary-value terms this query required verbatim. Empty for a prose query.
   *
   * Present so a caller can see that the search was a containment search, and so a short
   * result can be explained without re-deriving the query's shape.
   */
  exactTerms: string[];
  /**
   * Candidates the archive returned that did not carry every exact term.
   *
   * These were read and judged, not cut, so this is not a truncation reason: the window is
   * still `complete`. It is the answer to "the search considered more than it returned —
   * why", which is the question a bare `considered`/`returned` gap leaves open.
   */
  droppedByExactTerm: number;
  /**
   * `complete` — every candidate the archive held was returned, out of a source the walk had
   * read to its end.
   * `partial` — a bound cut candidates, or the source itself was not read to its end, so more
   * may exist.
   * `unknown` — no group was searched, so nothing about the world was learned.
   */
  coverage: "complete" | "partial" | "unknown";
  /** Authorized groups this search actually read. */
  groupsSearched: number;
  /**
   * The source bounds that stopped a walk short of the end of its group, deduplicated.
   *
   * Empty when every searched group's walk reached the end of its source. `sync_unreported`
   * stands for a group whose walk reported nothing — a surface that wires no sync, or one that
   * returned no outcome — which is silence about the source rather than the end of it.
   *
   * Kept separate from `truncationReasons`: that list is about candidates this search read and
   * dropped, and folding the source window into it would say a search dropped something it
   * never fetched.
   */
  sourceLimits: Array<HistorySyncStop | "sync_unreported">;
  /** Per-group coverage, ordered by group id so the evidence is comparable across Runs. */
  sourceCoverage: Array<{
    groupId: string;
    returned: number;
    considered: number;
    capped: boolean;
    /** How far this group's history walk reached, or `unreported` when it said nothing. */
    sync: HistorySyncOutcome | "unreported";
  }>;
  /** When the search ran. Distinct from when the matched messages were sent. */
  observedAt: string;
  /**
   * What to do next to see more. Present only while the window is not exhausted.
   *
   * Deliberately not a time cursor: the retriever ranks by score, so "older than the oldest
   * hit" would skip newer matches that simply ranked lower. Raising the limit reaches the
   * candidate set this search already saw; searching a capped group alone removes the cap.
   */
  continuation?: {
    /**
     * A larger limit that reaches candidates this search cut.
     *
     * Present exactly when a larger limit exists. The Tool's own maximum is the largest limit
     * there is, so a search that already asked for it has nothing left to raise, and the field
     * is absent rather than naming the limit the search had just applied — a next step that
     * changes nothing while reading as though more were reachable.
     */
    suggestedLimit?: number;
    /** Groups whose hits were capped by the cross-group per-source cap. */
    cappedGroups?: string[];
  };
}

/** The cross-group per-source cap, restated here so the coverage can report it. */
const CROSS_GROUP_PER_SOURCE_CAP = DEFAULT_PER_SOURCE_CAP;

/**
 * Assembles the one coverage record from every bound that can cut a result.
 *
 * The retriever bounds how much it fetches and keeps; the bounded Context bounds what it
 * keeps per source; and the source walk bounds how much of the group the archive holds at
 * all. None alone describes the window, so the reported reasons are the union of the first
 * two and `coverage` is `complete` only when neither dropped anything and every source was
 * read to its end.
 *
 * The per-source list is built from the groups that were searched, not from the groups that
 * returned candidates. A group that produced nothing is exactly the case a negative answer
 * turns on, so it has to appear in the evidence with its own walk outcome rather than be
 * absent from it.
 */
function historyCoverage(input: {
  retrieval: RetrievalCoverage;
  bounded: BoundedContext;
  searchedGroupIds: readonly string[];
  syncs: ReadonlyMap<string, HistorySyncOutcome>;
  observedAt: string;
}): HistorySearchCoverage {
  const reasons = new Set<TruncationReason>(input.bounded.truncationReasons);
  if (input.retrieval.droppedByLimit > 0) reasons.add("top_k_reached");
  if (input.retrieval.candidateCapReached) reasons.add("candidate_ceiling_reached");

  const cappedGroups = input.bounded.sources
    .filter((source) => source.capped)
    .map((source) => source.sourceId)
    .sort();
  const truncated = reasons.size > 0;
  const continuation: HistorySearchCoverage["continuation"] = {};
  // A limit that reaches nothing more than the one already used is not a next step. When the
  // candidate set is larger than the Tool's maximum, no larger limit exists, so the field is
  // absent rather than naming the limit the search had just applied.
  const suggestedLimit = Math.min(
    Math.max(input.retrieval.considered, input.retrieval.requestedLimit + 1),
    MAX_LIMIT,
  );
  if (input.retrieval.droppedByLimit > 0 && suggestedLimit > input.retrieval.requestedLimit)
    continuation.suggestedLimit = suggestedLimit;
  if (cappedGroups.length > 0) continuation.cappedGroups = cappedGroups;

  const boundedBySource = new Map(input.bounded.sources.map((source) => [source.sourceId, source]));
  const sourceCoverage: HistorySearchCoverage["sourceCoverage"] = input.searchedGroupIds
    .map((groupId) => {
      const source = boundedBySource.get(groupId);
      return {
        groupId,
        returned: source?.returned ?? 0,
        considered: source?.considered ?? 0,
        capped: source?.capped ?? false,
        sync: input.syncs.get(groupId) ?? ("unreported" as const),
      };
    })
    .sort((left, right) => left.groupId.localeCompare(right.groupId));
  // `end_of_source` is the one stop that leaves nothing open, so it is not a limit. Every
  // other stop — including a walk that reported nothing at all — is.
  const sourceLimits = [
    ...new Set(
      sourceCoverage.map((source) =>
        source.sync === "unreported" ? ("sync_unreported" as const) : source.sync.stop,
      ),
    ),
  ]
    .filter((stop) => stop !== "end_of_source")
    .sort();

  return {
    requestedLimit: input.retrieval.requestedLimit,
    returned: input.bounded.items.length,
    considered: input.retrieval.considered,
    truncated,
    truncationReasons: [...reasons],
    perSourceCap: input.bounded.bounds.perSourceCap,
    exactTerms: [...input.retrieval.exactTerms],
    droppedByExactTerm: input.retrieval.droppedByExactTerm,
    coverage:
      input.searchedGroupIds.length === 0
        ? "unknown"
        : truncated || sourceLimits.length > 0
          ? "partial"
          : "complete",
    groupsSearched: input.searchedGroupIds.length,
    sourceLimits,
    sourceCoverage,
    observedAt: input.observedAt,
    ...(Object.keys(continuation).length === 0 ? {} : { continuation }),
  };
}

/**
 * Safe retrieval evidence for one search. Every field is either an identifier, a score or a
 * bounded term list; no snippet or message text is ever included, so a denial or a withheld
 * item cannot leak protected content through the trace.
 */
export interface HistoryRetrievalEvidence {
  type: "history_retrieval";
  runId: string;
  principalId: string;
  conversationId: string;
  query: string;
  groups: string[];
  resources: string[];
  sourceKind: "channel_message";
  retrievalMode: "lexical";
  /** Restates `coverage.considered`, so the window's size is readable without the nested record. */
  considered: number;
  /** Restates `coverage.truncated`, so the same fact is not recorded two ways. */
  truncated: boolean;
  /**
   * How much of the window this search saw, so Trace can answer "was this answer partial?"
   * without the model's own answer being the only record of it.
   */
  coverage: HistorySearchCoverage;
  items: Array<{
    resourceId: string;
    sourceId: string;
    rank: number;
    score: number;
    matchedTerms: string[];
    returnMode: ReturnMode;
  }>;
}

/**
 * The model-visible projection of one history search.
 *
 * This — not `HistorySearchDetails` — is what the model receives. It carries exactly what an
 * answer needs: which authorized group a hit came from, who sent it, when, the bounded text
 * and the matched terms. It carries no Run id, no archive record id and no Glassbox Resource
 * id. Those are implementation identifiers the model has no use for, and a model that copies
 * one into an answer produces output the Delivery Gate must refuse — which is what happened
 * on the real Run that motivated this projection.
 */
export interface HistorySearchResultView {
  /** The authorized groups actually searched. */
  groups: string[];
  query: string;
  results: Array<{
    rank: number;
    groupId: string;
    /** The sender's Channel identity, when the item's content was disclosed. */
    sender?: string;
    senderName?: string;
    occurredAt?: string;
    text: string;
    matchedTerms: string[];
  }>;
  considered: number;
  truncated: boolean;
  resultStatus: "matches_found" | "no_matches_in_searched_window";
  coverage: HistorySearchCoverage;
  guidance: string;
}

export function projectHistorySearch(details: HistorySearchDetails): HistorySearchResultView {
  return {
    groups: details.groups,
    query: details.query,
    results: details.items.map((item) => ({
      rank: item.rank,
      groupId: item.groupId,
      ...(item.senderId === undefined ? {} : { sender: item.senderId }),
      ...(item.senderName === undefined ? {} : { senderName: item.senderName }),
      ...(item.occurredAt === undefined ? {} : { occurredAt: item.occurredAt }),
      text: item.snippet,
      matchedTerms: item.matchedTerms,
    })),
    considered: details.considered,
    truncated: details.truncated,
    resultStatus: details.resultStatus,
    coverage: details.coverage,
    guidance: historyGuidance(details),
  };
}

export type StrictHistoryReplyField = "group" | "sender" | "time" | "text";

export interface StrictHistoryReplySpec {
  fields: StrictHistoryReplyField[];
  exactTerms: string[];
  exactText: boolean;
}

/**
 * Recognizes the narrow response contract that needs a physical output boundary.
 *
 * This is deliberately not a general natural-language claim verifier. It only applies when the
 * current message both names an exact identifier and explicitly says that the answer must contain
 * only a supported set of history fields. All other answers remain the model's responsibility.
 */
export function strictHistoryReplySpec(text: string): StrictHistoryReplySpec | undefined {
  const compact = text.replace(/\s+/gu, "");
  if (!/(?:只|仅)(?:根据实际工具结果)?(?:回复|返回|列出|给出)/u.test(compact)) return undefined;

  const terms = exactTerms(text).filter((term) => /[a-z]/iu.test(term));
  if (terms.length !== 1) return undefined;

  const fields: StrictHistoryReplyField[] = [];
  if (/群号|群\s*ID|group\s*(?:id)?/iu.test(text)) fields.push("group");
  if (/发送者|发件人|谁发|sender/iu.test(text)) fields.push("sender");
  if (/发送时间|时间|timestamp|time/iu.test(text)) fields.push("time");
  if (/原文|正文|消息内容|original\s*text|\btext\b/iu.test(text)) fields.push("text");
  if (fields.length === 0) return undefined;
  const exactText = /(?:精确查找|精确匹配|完全匹配|exact(?:\s+text)?\s+match)/iu.test(text);
  return { fields, exactTerms: terms, exactText };
}

function historyDetailsFromToolResult(result: unknown): HistorySearchDetails | undefined {
  if (!result || typeof result !== "object" || Array.isArray(result)) return undefined;
  const envelope = result as Record<string, unknown>;
  const candidate =
    envelope.details && typeof envelope.details === "object" && !Array.isArray(envelope.details)
      ? (envelope.details as Record<string, unknown>)
      : envelope;
  if (
    typeof candidate.query !== "string" ||
    !Array.isArray(candidate.items) ||
    (candidate.resultStatus !== "matches_found" &&
      candidate.resultStatus !== "no_matches_in_searched_window") ||
    !candidate.coverage ||
    typeof candidate.coverage !== "object" ||
    Array.isArray(candidate.coverage)
  )
    return undefined;
  for (const item of candidate.items) {
    if (
      !item ||
      typeof item !== "object" ||
      Array.isArray(item) ||
      typeof (item as Record<string, unknown>).snippet !== "string" ||
      typeof (item as Record<string, unknown>).groupId !== "string"
    )
      return undefined;
  }
  return candidate as unknown as HistorySearchDetails;
}

/**
 * Builds a strict reply from successful Tool details, never from model-authored prose.
 *
 * Returning `undefined` means the Tool result cannot prove every requested field. The execution
 * adapter treats that as a failed evidence projection rather than falling back to model text.
 */
export function projectStrictHistoryReply(
  spec: StrictHistoryReplySpec,
  toolResult: unknown,
): string | undefined {
  const details = historyDetailsFromToolResult(toolResult);
  if (!details) return undefined;
  const queryTerms = exactTerms(details.query).filter((term) => /[a-z]/iu.test(term));
  if (
    queryTerms.length !== spec.exactTerms.length ||
    queryTerms.some((term, index) => term !== spec.exactTerms[index])
  )
    return undefined;

  if (details.resultStatus === "no_matches_in_searched_window") {
    if (details.items.length > 0) return undefined;
    return details.coverage.coverage === "complete"
      ? "没有找到符合条件的消息。"
      : "在本次检索到的范围内没有找到符合条件的消息。";
  }
  const items = spec.exactText
    ? details.items.filter(
        (item) =>
          spec.exactTerms.length === 1 && isBareExactTerm(item.snippet, spec.exactTerms[0]!),
      )
    : details.items;
  if (items.length === 0) {
    return details.coverage.coverage === "complete"
      ? "没有找到符合条件的消息。"
      : "在本次检索到的范围内没有找到符合条件的消息。";
  }

  const blocks: string[] = [];
  for (const item of items) {
    if (!carriesEveryExactTerm(item.snippet, spec.exactTerms)) return undefined;
    const lines: string[] = [];
    for (const field of spec.fields) {
      if (field === "group") lines.push(`群号：${item.groupId}`);
      if (field === "sender") {
        if (!item.senderId) return undefined;
        lines.push(`发送者：${item.senderId}${item.senderName ? `（${item.senderName}）` : ""}`);
      }
      if (field === "time") {
        if (!item.occurredAt) return undefined;
        lines.push(`时间：${item.occurredAt}`);
      }
      if (field === "text") lines.push(`原文：${item.snippet}`);
    }
    blocks.push(lines.join("\n"));
  }
  return blocks.join("\n\n");
}

/**
 * What the model is told about the window it just searched.
 *
 * A short answer and an exhausted window read the same in a bare result list, and the
 * difference decides whether the Agent may say "this never happened". The guidance names
 * which case this is, so the negative reading is never the model's to assume.
 *
 * A query that named an identifier gets one more sentence, because the failure mode there
 * is different: the identifier is already in the Conversation, so a model that is handed no
 * match can still compose a sender, a time and an original text for it. The guidance says
 * which way the result came out, so "found" and "not found" are both observations rather
 * than something the model decided.
 *
 * The partial case names *which* window is short, because the two lead to different next
 * steps: a cut candidate set can be reached by raising the limit, while a source the walk
 * never finished cannot be reached at all from here. `coverage.sourceLimits` carries the
 * reason in structured form for Trace; the sentence says only which window it applies to.
 */
function historyGuidance(details: HistorySearchDetails): string {
  const { coverage } = details;
  const terms = coverage.exactTerms.map((term) => `"${term}"`).join(", ");
  if (coverage.coverage === "unknown")
    return "No group was searched, so nothing about the world was learned. This is not a negative result.";
  const sourceOpen = coverage.sourceLimits.length > 0;
  const window =
    coverage.coverage === "complete"
      ? " The searched window was exhausted, which does not prove the event never happened outside it."
      : coverage.truncated && sourceOpen
        ? " Only part of the window was searched, and the source itself was not read to its end, which does not prove the event never happened."
        : coverage.truncated
          ? " Only part of the window was searched, which does not prove the event never happened."
          : " Only part of the source was searched, which does not prove the event never happened.";
  if (details.resultStatus === "matches_found") {
    const exact =
      terms === ""
        ? ""
        : ` Every listed match contains ${terms} verbatim; the sender, the time and the original text come only from those matches.`;
    return `Answer only from these matches. Return only the fields the user requested; do not narrate Tool names, parameters, counts, coverage metadata or this guidance unless the user explicitly asks for them.${exact}${window}`;
  }
  const negative =
    terms === ""
      ? "No match was found and"
      : `No message in the searched window contains ${terms} verbatim, and`;
  const fabrication =
    terms === ""
      ? ""
      : " Do not report the identifier as found, and do not supply a sender, a time or an original text for it.";
  return `${negative}${window}${fabrication}`;
}

/**
 * Scope decides which history Tool exists. The model never chooses its own surface.
 *
 * A group Run sees the current-group Tool only while the group's own policy still enables
 * `group.history`. Discovery is a superset of authority, so the grant can stay in place and
 * the Owner's policy change takes effect on the very next Run without a re-grant.
 */
/**
 * Both history Tools, each with why it is or is not eligible for this scope.
 *
 * `availableHistoryToolNames` is a projection of this, never a second implementation: a Run
 * that reads only the eligible names and a Run that records the whole surface must never
 * disagree about which Tool a scope may reach.
 */
export function historyToolEligibility(input: {
  isOwner: boolean;
  chatType: "group" | "private";
  enabledCategories: readonly QqCapabilityCategory[];
}): { name: string; exclusion: ToolExclusionReason | null }[] {
  if (input.chatType === "group")
    return [
      {
        name: GROUP_HISTORY_SEARCH_TOOL,
        exclusion: input.enabledCategories.includes("group.history") ? null : "policy_disabled",
      },
      // An Owner in a group searches that group's history; the Owner-private corpus is a
      // different Resource and is not reachable from a group scope at all.
      { name: OWNER_HISTORY_SEARCH_TOOL, exclusion: "scope_not_permitted" },
    ];
  if (input.isOwner)
    return [
      { name: OWNER_HISTORY_SEARCH_TOOL, exclusion: null },
      { name: GROUP_HISTORY_SEARCH_TOOL, exclusion: "scope_not_permitted" },
    ];
  return [
    { name: OWNER_HISTORY_SEARCH_TOOL, exclusion: "scope_not_permitted" },
    { name: GROUP_HISTORY_SEARCH_TOOL, exclusion: "scope_not_permitted" },
  ];
}

export function availableHistoryToolNames(input: {
  isOwner: boolean;
  chatType: "group" | "private";
  enabledCategories: readonly QqCapabilityCategory[];
}): string[] {
  return historyToolEligibility(input)
    .filter((entry) => entry.exclusion === null)
    .map((entry) => entry.name);
}

function validatedParams(input: GroupHistoryInput): GroupHistoryInput {
  const query = input.query === undefined ? "" : input.query;
  if (typeof query !== "string" || query.length > 2_000) throw new Error("invalid_history_query");
  const sender = input.sender?.trim();
  if (
    input.sender !== undefined &&
    (typeof input.sender !== "string" || !sender || sender.length > 256)
  )
    throw new Error("invalid_history_sender");
  if (input.mentionsMe !== undefined && typeof input.mentionsMe !== "boolean")
    throw new Error("invalid_history_mentions_me");
  const limit = input.limit === undefined ? DEFAULT_LIMIT : input.limit;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIMIT)
    throw new Error("invalid_history_limit");
  const bound = (value: unknown): string | undefined => {
    if (value === undefined) return undefined;
    if (typeof value !== "string" || Number.isNaN(Date.parse(value)))
      throw new Error("invalid_history_time_bound");
    return value;
  };
  const since = bound(input.since);
  const until = bound(input.until);
  if (!query.trim() && !sender && input.mentionsMe !== true && !since && !until)
    throw new Error("history_filter_required");
  return {
    query: query.trim(),
    ...(sender ? { sender } : {}),
    ...(input.mentionsMe === true ? { mentionsMe: true } : {}),
    limit,
    since,
    until,
  };
}

function validatedGroupFilters(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_GROUP_FILTERS)
    throw new Error("invalid_history_group_filter");
  for (const groupId of value) {
    if (typeof groupId !== "string" || !GROUP_ID_PATTERN.test(groupId))
      throw new Error("invalid_history_group_filter");
  }
  return [...new Set(value as string[])];
}

export function createHistoryTools(options: {
  store: DomainStore;
  archive: ChannelArchiveStore;
  getContext: () => PiRunContext | undefined;
  /**
   * Pulls recent real history for an already-authorized group into the archive.
   * Only ever invoked after the `history:read` gate has returned ALLOW, so protected
   * text is never fetched for a group the caller may not read.
   *
   * It returns how far it got, because the archive is not the group: a walk that stopped at
   * its page bound leaves history the search cannot see, and a search that reported the
   * window as exhausted anyway would let an answer say the message is not there.
   */
  syncGroup?: (
    groupId: string,
    context: ProtectedToolContext,
  ) => Promise<HistorySyncOutcome | undefined>;
  /** Resolves the bot Channel identity used by the structured `mentionsMe` filter. */
  botIdForConnection?: (connectionId: string) => string | undefined;
  /**
   * Durable Owner intent for one group's history class. Not an authorization decision.
   *
   * Discovery already narrows the Tool surface, but the surface is computed once per Run:
   * a policy change between the Run starting and this Tool executing must still refuse, and
   * a Run that started while history was enabled must not keep the ability to read after it
   * was disabled.
   */
  isHistoryEnabled: (connectionId: string, groupId: string) => Promise<boolean>;
  /** Appends the safe retrieval evidence for one search to durable Trace. */
  recordEvidence?: (
    evidence: HistoryRetrievalEvidence,
    context: ProtectedToolContext,
  ) => Promise<void>;
}): ToolDefinition[] {
  const getContext = (): ProtectedToolContext | undefined => {
    const value = options.getContext();
    return value?.caller && value.conversationId && value.runId
      ? { caller: value.caller, conversationId: value.conversationId, runId: value.runId }
      : undefined;
  };

  /**
   * Searches exactly the groups the caller is currently authorized to read.
   *
   * `resolveAuthorizedHistorySources` intersects the requested filters with the caller's
   * active grants *before* anything is fetched, so an unauthorized group never contributes
   * a candidate. Each surviving Resource is re-authorized at execution time and the decision
   * is recorded with the Run.
   */
  const search = async (
    params: GroupHistoryInput,
    context: ProtectedToolContext,
    requestedGroupIds?: readonly string[],
  ): Promise<HistorySearchDetails> => {
    const caller = context.caller;
    const resolved = await resolveAuthorizedHistorySources(
      options.store,
      caller,
      requestedGroupIds,
    );
    // An Owner-private search is additionally bounded by the Principal's own assignment, so
    // one Owner's groups are never searched by another Owner who merely holds a stale grant.
    const assigned =
      caller.scope.chatType === "private"
        ? new Set(await resolveAssignedGroupIds(options.store, caller))
        : undefined;
    const candidates = assigned ? resolved.filter((groupId) => assigned.has(groupId)) : resolved;

    const searched: string[] = [];
    const sourceDecisions = new Map<string, string>();
    for (const groupId of candidates) {
      const decision = await options.store.authorization.check({
        caller,
        resourceId: groupResourceId(groupId),
        action: HISTORY_READ_ACTION,
        conversationId: context.conversationId,
        runId: context.runId,
      });
      if (decision.decision === "ALLOW") {
        searched.push(groupId);
        sourceDecisions.set(groupId, decision.id);
      }
    }

    // The walk's own report is collected per group, so a cross-group answer can say which
    // source is short rather than only that one of them is.
    const syncs = new Map<string, HistorySyncOutcome>();
    for (const groupId of searched) {
      const outcome = await options.syncGroup?.(groupId, context);
      if (outcome) syncs.set(groupId, outcome);
    }

    const botId = params.mentionsMe
      ? options.botIdForConnection?.(caller.scope.connectionId)
      : undefined;
    if (params.mentionsMe && !botId) throw new ToolInputError("bot_identity_unavailable");
    const retriever = new MemoryRetriever({ store: options.archive });
    // `searchDetailed` returns an empty result without querying the store when nothing is
    // authorized, so an unauthorized search still reports zero candidates honestly.
    const retrieval = await retriever.searchDetailed(params.query ?? "", {
      allowedSourceIds: searched,
      limit: params.limit,
      since: params.since,
      until: params.until,
      metadataFilters: {
        ...(params.sender ? { sender: params.sender } : {}),
        ...(botId ? { mentionedUserId: botId } : {}),
      },
    });
    const results = retrieval.results;
    // The per-source cap exists to stop one busy group filling a cross-group answer. A search
    // that already targets one group has nothing to diversify against, so capping it only
    // answers a smaller question than the Run asked: `limit: 8` returned 3.
    const bounded = selectBoundedContext(results, {
      topK: params.limit,
      perSourceCap: searched.length > 1 ? CROSS_GROUP_PER_SOURCE_CAP : null,
      preserveTerms: retrieval.coverage.exactTerms,
    });
    // Bounding drops items, so the sender is joined back by record id rather than by position.
    const senders = new Map(
      results.map((result) => [
        result.memory.id,
        {
          id: result.memory.metadata?.senderId,
          name: result.memory.metadata?.senderName,
        },
      ]),
    );
    const items: HistorySearchItem[] = bounded.items.map((item) => {
      const sender = senders.get(item.id);
      return {
        ...item,
        groupId: item.sourceId,
        resourceId: groupResourceId(item.sourceId),
        // A withheld item discloses neither its text nor who sent it.
        ...(typeof sender?.id === "string" && item.returnMode !== "metadata_only"
          ? { senderId: sender.id }
          : {}),
        ...(typeof sender?.name === "string" && item.returnMode !== "metadata_only"
          ? { senderName: sender.name }
          : {}),
      };
    });
    const coverage = historyCoverage({
      retrieval: retrieval.coverage,
      bounded,
      searchedGroupIds: searched,
      syncs,
      observedAt: new Date().toISOString(),
    });
    const details: HistorySearchDetails = {
      groups: searched,
      query: params.query ?? "",
      sourceKind: "channel_message",
      retrievalMode: "lexical",
      runId: context.runId,
      items,
      considered: coverage.considered,
      truncated: coverage.truncated,
      resultStatus: items.length > 0 ? "matches_found" : "no_matches_in_searched_window",
      coverage,
    };
    await options.recordEvidence?.(
      {
        type: "history_retrieval",
        runId: context.runId,
        principalId: caller.principalId,
        conversationId: context.conversationId,
        query: params.query ?? "",
        groups: searched,
        resources: searched.map(groupResourceId),
        sourceKind: "channel_message",
        retrievalMode: "lexical",
        considered: coverage.considered,
        truncated: coverage.truncated,
        coverage,
        items: items.map((item) => ({
          resourceId: item.resourceId,
          sourceId: item.sourceId,
          rank: item.rank,
          score: item.score,
          matchedTerms: item.matchedTerms,
          returnMode: item.returnMode,
        })),
      },
      context,
    );
    for (const groupId of new Set(items.map((item) => item.groupId))) {
      const decisionId = sourceDecisions.get(groupId);
      if (decisionId)
        await options.store.authorization.markDeliverySource(decisionId, "content_source");
    }
    return details;
  };

  const groupTool = createProtectedTool<GroupHistoryInput, HistorySearchDetails>({
    name: GROUP_HISTORY_SEARCH_TOOL,
    label: "搜索本群历史",
    description:
      "Search the current QQ group's authorized history. Filters cover message text, sender QQ or group nickname, whether the sender mentioned this bot, and ISO 8601 time bounds. Use sender for who spoke and mentionsMe for who @mentioned the bot. A query naming an exact identifier is matched verbatim, so a message that merely shares part of it is not a match. A no_matches_in_searched_window result is not proof that an event never happened.",
    parameters: Type.Object(
      {
        query: Type.Optional(Type.String({ maxLength: 2_000 })),
        sender: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
        mentionsMe: Type.Optional(Type.Boolean()),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_LIMIT })),
        since: Type.Optional(Type.String()),
        until: Type.Optional(Type.String()),
      },
      { additionalProperties: false },
    ),
    action: HISTORY_READ_ACTION,
    // The Resource comes from the Run's own Channel scope, never from model input.
    resourceId: (_params, context) =>
      context.caller.scope.chatType === "group"
        ? groupResourceId(context.caller.scope.chatId)
        : SCOPE_MISMATCH_RESOURCE,
    authService: options.store.authorization,
    getContext,
    projectResult: (result) => JSON.stringify(projectHistorySearch(result)),
    execute: async (params, context) => {
      const scope = context.caller.scope;
      // A non-group scope never reaches here: the Resource gate above denies it first. This
      // re-reads the Owner's policy at execution time, so a Run that started while history
      // was enabled cannot read after the Owner disabled it.
      if (
        scope.chatType === "group" &&
        !(await options.isHistoryEnabled(scope.connectionId, scope.chatId))
      )
        throw new ToolInputError("history_category_disabled");
      return search(validatedParams(params), context);
    },
  });

  const ownerTool = createProtectedTool<OwnerHistoryInput, HistorySearchDetails>({
    name: OWNER_HISTORY_SEARCH_TOOL,
    label: "搜索已授权群历史",
    description:
      "Owner-only search across assigned and authorized QQ groups. Filters cover message text, sender QQ or group nickname, whether the sender mentioned this bot, group ids, and ISO 8601 time bounds. A query naming an exact identifier is matched verbatim, so a message that merely shares part of it is not a match. A no_matches_in_searched_window result is not proof that an event never happened.",
    parameters: Type.Object(
      {
        groupIds: Type.Optional(
          Type.Array(Type.String({ pattern: "^[1-9]\\d{0,15}$" }), {
            minItems: 1,
            maxItems: MAX_GROUP_FILTERS,
          }),
        ),
        query: Type.Optional(Type.String({ maxLength: 2_000 })),
        sender: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
        mentionsMe: Type.Optional(Type.Boolean()),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_LIMIT })),
        since: Type.Optional(Type.String()),
        until: Type.Optional(Type.String()),
      },
      { additionalProperties: false },
    ),
    action: OWNER_HISTORY_ACTION,
    deliverySource: "access_gate",
    // A multi-group call cannot name one group Resource, so it is gated on the Owner's own
    // search capability; each concrete group Resource is re-authorized inside `execute`.
    resourceId: (_params, context) =>
      context.caller.scope.chatType === "private"
        ? OWNER_HISTORY_RESOURCE
        : SCOPE_MISMATCH_RESOURCE,
    authService: options.store.authorization,
    getContext,
    projectResult: (result) => JSON.stringify(projectHistorySearch(result)),
    execute: (params, context) =>
      search(validatedParams(params), context, validatedGroupFilters(params.groupIds)),
  });

  return [groupTool, ownerTool];
}
