/**
 * Runtime Tools for authorized Channel history search.
 *
 * Both Tools are thin projections over the shared retrieval path:
 *   authorized source set → OpenSquilla-shaped retriever → MGP-shaped result → bounded Context
 *
 * Security properties enforced here:
 *  - The current-group Tool can never name a group. Its Resource is derived from the Run's
 *    own Channel scope, so a group Run cannot select another group.
 *  - The Owner cross-group Tool names one group per call and is gated on `history:read` for
 *    that exact group Resource. The Owner role alone never bypasses the Resource grant.
 *  - Both Tools re-authorize immediately before any protected text is loaded, and neither
 *    can read an arbitrary group or reach raw OneBot RPC.
 */

import { Type } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { DomainStore } from "../../persistence/index.js";
import type { ChannelArchiveStore } from "../../retrieval/channel-archive.js";
import { selectBoundedContext } from "../../retrieval/context.js";
import { MemoryRetriever } from "../../retrieval/retriever.js";
import { groupResourceId } from "../../retrieval/source-resolver.js";
import { createProtectedTool, type ProtectedToolContext } from "./protected-tools.js";
import type { PiRunContext } from "./types.js";

export const GROUP_HISTORY_SEARCH_TOOL = "group_history_search";
export const OWNER_HISTORY_SEARCH_TOOL = "owner_history_search";

/** Sentinel Resource for a Tool invoked outside its intended scope. Never registered. */
const SCOPE_MISMATCH_RESOURCE = "history:scope-mismatch";

const HISTORY_READ_ACTION = "history:read";
const DEFAULT_LIMIT = 8;
const MAX_LIMIT = 50;

interface GroupHistoryInput extends Record<string, unknown> {
  query: string;
  limit?: number;
  since?: string;
  until?: string;
}

interface OwnerHistoryInput extends GroupHistoryInput {
  groupId: string;
}

interface HistorySearchDetails {
  groupId: string;
  query: string;
  resourceId: string;
  sourceKind: "channel_message";
  retrievalMode: "lexical";
  runId: string;
  items: ReturnType<typeof selectBoundedContext>["items"];
  considered: number;
  truncated: boolean;
}

/** Scope decides which history Tool exists. The model never chooses its own surface. */
export function availableHistoryToolNames(input: {
  isOwner: boolean;
  chatType: "group" | "private";
}): string[] {
  if (input.chatType === "group") return [GROUP_HISTORY_SEARCH_TOOL];
  if (input.isOwner) return [OWNER_HISTORY_SEARCH_TOOL];
  return [];
}

function validatedParams(input: GroupHistoryInput): GroupHistoryInput {
  const query = input.query;
  if (typeof query !== "string" || !query.trim() || query.length > 2_000)
    throw new Error("invalid_history_query");
  const limit = input.limit === undefined ? DEFAULT_LIMIT : input.limit;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIMIT)
    throw new Error("invalid_history_limit");
  const bound = (value: unknown): string | undefined => {
    if (value === undefined) return undefined;
    if (typeof value !== "string" || Number.isNaN(Date.parse(value)))
      throw new Error("invalid_history_time_bound");
    return value;
  };
  return { query: query.trim(), limit, since: bound(input.since), until: bound(input.until) };
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
}): ToolDefinition[] {
  const getContext = (): ProtectedToolContext | undefined => {
    const value = options.getContext();
    return value?.caller && value.conversationId && value.runId
      ? { caller: value.caller, conversationId: value.conversationId, runId: value.runId }
      : undefined;
  };

  const search = async (
    groupId: string,
    params: GroupHistoryInput,
    context: ProtectedToolContext,
  ): Promise<HistorySearchDetails> => {
    await options.syncGroup?.(groupId, context);
    const retriever = new MemoryRetriever({ store: options.archive });
    const results = await retriever.search(params.query, {
      allowedSourceIds: [groupId],
      limit: params.limit,
      since: params.since,
      until: params.until,
    });
    const bounded = selectBoundedContext(results, { topK: params.limit });
    return {
      groupId,
      query: params.query,
      resourceId: groupResourceId(groupId),
      sourceKind: "channel_message",
      retrievalMode: "lexical",
      runId: context.runId,
      items: bounded.items,
      considered: bounded.considered,
      truncated: bounded.truncated,
    };
  };

  const groupTool = createProtectedTool<GroupHistoryInput, HistorySearchDetails>({
    name: GROUP_HISTORY_SEARCH_TOOL,
    label: "搜索本群历史",
    description:
      "Search the history of the QQ group this conversation is currently in. It cannot search any other group. Use it when the user refers to something said earlier in this group.",
    parameters: Type.Object(
      {
        query: Type.String({ minLength: 1, maxLength: 2_000 }),
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
    execute: (params, context) =>
      search(context.caller.scope.chatId, validatedParams(params), context),
  });

  const ownerTool = createProtectedTool<OwnerHistoryInput, HistorySearchDetails>({
    name: OWNER_HISTORY_SEARCH_TOOL,
    label: "搜索已授权群历史",
    description:
      "Owner-only: search the history of one QQ group that is currently authorized for this Owner. Name exactly one group per call. It cannot read a group that has not been granted.",
    parameters: Type.Object(
      {
        groupId: Type.String({ pattern: "^[1-9]\\d{0,15}$" }),
        query: Type.String({ minLength: 1, maxLength: 2_000 }),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_LIMIT })),
        since: Type.Optional(Type.String()),
        until: Type.Optional(Type.String()),
      },
      { additionalProperties: false },
    ),
    action: HISTORY_READ_ACTION,
    resourceId: (params, context) =>
      context.caller.scope.chatType === "private"
        ? groupResourceId(params.groupId)
        : SCOPE_MISMATCH_RESOURCE,
    authService: options.store.authorization,
    getContext,
    execute: (params, context) => {
      const groupId = String(params.groupId);
      return search(groupId, validatedParams(params), context);
    },
  });

  return [groupTool, ownerTool];
}
