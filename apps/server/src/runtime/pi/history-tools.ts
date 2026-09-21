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
import { selectBoundedContext, type BoundedContextItem } from "../../retrieval/context.js";
import { MemoryRetriever } from "../../retrieval/retriever.js";
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
  considered: number;
  truncated: boolean;
  resultStatus: "matches_found" | "no_matches_in_searched_window";
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
  considered: number;
  truncated: boolean;
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
  returned: number;
  truncated: boolean;
  resultStatus: "matches_found" | "no_matches_in_searched_window";
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
    returned: details.items.length,
    truncated: details.truncated,
    resultStatus: details.resultStatus,
    guidance:
      details.resultStatus === "matches_found" && details.truncated
        ? "Partial results only. Do not claim a complete list, total count, earliest or latest message, or infer omitted messages. Say the result is incomplete and run a narrower or higher-limit search before answering a completeness question."
        : details.resultStatus === "matches_found"
          ? "Answer only from these matches. Do not infer messages that are not present."
          : "No match was found in the searched window. This does not prove the event never happened.",
  };
}

/**
 * Scope decides which history Tool exists. The model never chooses its own surface.
 *
 * A group Run sees the current-group Tool only while the group's own policy still enables
 * `group.history`. Discovery is a superset of authority, so the grant can stay in place and
 * the Owner's policy change takes effect on the very next Run without a re-grant.
 */
export function availableHistoryToolNames(input: {
  isOwner: boolean;
  chatType: "group" | "private";
  enabledCategories: readonly QqCapabilityCategory[];
}): string[] {
  if (input.chatType === "group")
    return input.enabledCategories.includes("group.history") ? [GROUP_HISTORY_SEARCH_TOOL] : [];
  if (input.isOwner) return [OWNER_HISTORY_SEARCH_TOOL];
  return [];
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
   */
  syncGroup?: (groupId: string, context: ProtectedToolContext) => Promise<void>;
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
    for (const groupId of candidates) {
      const decision = await options.store.authorization.check({
        caller,
        resourceId: groupResourceId(groupId),
        action: HISTORY_READ_ACTION,
        conversationId: context.conversationId,
        runId: context.runId,
      });
      if (decision.decision === "ALLOW") searched.push(groupId);
    }

    for (const groupId of searched) await options.syncGroup?.(groupId, context);

    const botId = params.mentionsMe
      ? options.botIdForConnection?.(caller.scope.connectionId)
      : undefined;
    if (params.mentionsMe && !botId) throw new ToolInputError("bot_identity_unavailable");
    const retriever = new MemoryRetriever({ store: options.archive });
    // Ask for one extra hit so the projection can truthfully report that a limit truncated the
    // result. The retriever otherwise returns exactly `limit` items with no indication that more
    // matched. The extra item never reaches model-visible Context.
    const retrievalLimit = Math.min(MAX_LIMIT + 1, (params.limit ?? DEFAULT_LIMIT) + 1);
    const results = searched.length
      ? await retriever.search(params.query ?? "", {
          allowedSourceIds: searched,
          limit: retrievalLimit,
          since: params.since,
          until: params.until,
          metadataFilters: {
            ...(params.sender ? { sender: params.sender } : {}),
            ...(botId ? { mentionedUserId: botId } : {}),
          },
        })
      : [];
    // Source diversity is useful across several groups. Inside one group it used to cap every
    // result at three messages, even when the caller requested more.
    const bounded = selectBoundedContext(results, {
      topK: params.limit,
      ...(searched.length === 1 ? { perSourceCap: params.limit } : {}),
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
    const details: HistorySearchDetails = {
      groups: searched,
      query: params.query ?? "",
      sourceKind: "channel_message",
      retrievalMode: "lexical",
      runId: context.runId,
      items,
      considered: bounded.considered,
      truncated: bounded.truncated,
      resultStatus: items.length > 0 ? "matches_found" : "no_matches_in_searched_window",
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
        considered: bounded.considered,
        truncated: bounded.truncated,
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
    return details;
  };

  const groupTool = createProtectedTool<GroupHistoryInput, HistorySearchDetails>({
    name: GROUP_HISTORY_SEARCH_TOOL,
    label: "搜索本群历史",
    description:
      "Search the current QQ group's authorized history. Filters cover message text, sender QQ or group nickname, whether the sender mentioned this bot, and ISO 8601 time bounds. Use sender for who spoke and mentionsMe for who @mentioned the bot. For requests about all messages, omissions, totals, or the earliest or latest message, use a sufficient limit and narrow filters. When truncated is true, the result is partial and must not be described as complete. A no_matches_in_searched_window result is not proof that an event never happened.",
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
      "Owner-only search across assigned and authorized QQ groups. Filters cover message text, sender QQ or group nickname, whether the sender mentioned this bot, group ids, and ISO 8601 time bounds. Use sender for who spoke. For requests about all messages, omissions, totals, or the earliest or latest message, use a sufficient limit and narrow filters. When truncated is true, the result is partial and must not be described as complete. A no_matches_in_searched_window result is not proof that an event never happened.",
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
