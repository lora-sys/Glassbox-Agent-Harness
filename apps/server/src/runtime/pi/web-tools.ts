import { Type } from "typebox";
import { createHash } from "node:crypto";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { DomainStore } from "../../persistence/index.js";
import type { WebCapability } from "../../management/web-capability-policy.js";
import { ProviderCallError } from "./provider-outcome.js";
import {
  createProtectedTool,
  ToolInputError,
  type ProtectedToolContext,
} from "./protected-tools.js";
import type { PiRunContext } from "./types.js";
import { WebService, type WebFetchInput, type WebSearchInput } from "../../web/web-service.js";
import { WebTargetError } from "../../web/network-guard.js";
import type { WebFetchResult, WebSearchResult, WebResultStatus } from "../../web/contracts.js";

export const WEB_SEARCH_TOOL = "web_search";
export const WEB_FETCH_TOOL = "web_fetch";
export const WEB_RESOURCE = "web:public";
export const WEB_ACTIONS: Readonly<Record<WebCapability, string>> = {
  "web.search": "web:search",
  "web.fetch": "web:fetch",
  "browser.read": "browser:read",
  "browser.interact": "browser:interact",
};

export interface WebToolEvidence {
  type: "web_search" | "web_fetch";
  runId: string;
  conversationId: string;
  principalId: string;
  status: string;
  providerStatus: string;
  sourceIds: readonly string[];
  urls: readonly string[];
  partial: boolean;
  truncated: boolean;
  providerOrigins: readonly string[];
  retrievedAt: string;
  queryDigest?: string;
  searchMode?: string;
  queryVariantCount?: number;
  jevUsed?: boolean;
  browserFallbackUsed?: boolean;
  candidateCount?: number;
  discardedCount?: number;
  finalResultCount?: number;
  retrievalMethod?: string;
  contentType?: string;
}

function contextFrom(getContext: () => PiRunContext | undefined): ProtectedToolContext | undefined {
  const value = getContext();
  return value?.caller && value.conversationId && value.runId
    ? { caller: value.caller, conversationId: value.conversationId, runId: value.runId }
    : undefined;
}

function requireWebSuccess(status: WebResultStatus): void {
  if (status === "succeeded" || status === "partial") return;
  if (status === "fallback_denied") throw new ProviderCallError("denied", "fallback_denied");
  if (status === "unavailable")
    throw new ProviderCallError("provider_unavailable", "provider_unavailable");
  if (status === "unknown") throw new ProviderCallError("unknown", "web_result_unknown");
  if (status === "blocked") throw new ProviderCallError("provider_failed", "browser_blocked");
  throw new ProviderCallError("provider_failed", "provider_failed");
}

function webInputError(error: unknown): never {
  if (error instanceof WebTargetError) throw new ToolInputError(error.code);
  if (
    error instanceof Error &&
    /^(?:invalid_web_[a-z_]+|unsupported_web_language_filter)$/u.test(error.message)
  )
    throw new ToolInputError(error.message);
  throw error;
}

export function createWebTools(options: {
  store: DomainStore;
  getContext: () => PiRunContext | undefined;
  service: WebService;
  isEnabled: (context: ProtectedToolContext, capability: WebCapability) => Promise<boolean>;
  recordEvidence?: (record: WebToolEvidence, context: ProtectedToolContext) => Promise<void>;
}): ToolDefinition[] {
  const getContext = () => contextFrom(options.getContext);
  const requireEnabled = async (context: ProtectedToolContext, capability: WebCapability) => {
    if (!(await options.isEnabled(context, capability)))
      throw new ProviderCallError("denied", "capability_category_disabled");
  };
  const search = createProtectedTool<WebSearchInput, WebSearchResult>({
    name: WEB_SEARCH_TOOL,
    description:
      "Search current public web sources. Results include URLs, timestamps and bounded highlights. Use web_fetch for a deeper read.",
    parameters: Type.Object(
      {
        query: Type.String({ minLength: 1, maxLength: 500 }),
        maxResults: Type.Optional(Type.Integer({ minimum: 1, maximum: 10 })),
        timeRange: Type.Optional(
          Type.Union([
            Type.Literal("day"),
            Type.Literal("week"),
            Type.Literal("month"),
            Type.Literal("year"),
          ]),
        ),
        language: Type.Optional(Type.String({ maxLength: 16 })),
        includeDomains: Type.Optional(
          Type.Array(Type.String({ maxLength: 253 }), { maxItems: 10 }),
        ),
        excludeDomains: Type.Optional(
          Type.Array(Type.String({ maxLength: 253 }), { maxItems: 10 }),
        ),
      },
      { additionalProperties: false },
    ),
    action: WEB_ACTIONS["web.search"],
    resourceId: WEB_RESOURCE,
    authService: options.store.authorization,
    getContext,
    execute: async (params, context) => {
      await requireEnabled(context, "web.search");
      const result = await options.service.search(context.runId, params).catch(webInputError);
      await options.recordEvidence?.(
        {
          type: "web_search",
          runId: context.runId,
          conversationId: context.conversationId,
          principalId: context.caller.principalId,
          status: result.status,
          providerStatus: result.providerStatus,
          sourceIds: result.results.map((item) => item.sourceId),
          urls: result.results.map((item) => item.url),
          partial: result.partial,
          truncated: result.truncated,
          providerOrigins: [...new Set(result.results.flatMap((item) => item.providerOrigins))],
          retrievedAt: new Date().toISOString(),
          searchMode: result.plan.mode,
          queryVariantCount: result.plan.queryVariants.length,
          queryDigest: createHash("sha256").update(result.query).digest("hex"),
          jevUsed: result.plan.jevUsed,
          browserFallbackUsed: result.plan.mode === "browser_fallback",
          candidateCount: result.candidateCount,
          discardedCount: result.discardedCount,
          finalResultCount: result.results.length,
        },
        context,
      );
      requireWebSuccess(result.status);
      return result;
    },
    projectResult: (result) => JSON.stringify(result),
  });
  const fetch = createProtectedTool<WebFetchInput, WebFetchResult>({
    name: WEB_FETCH_TOOL,
    description:
      "Read one public web URL in more depth after search or when the user supplied a URL.",
    parameters: Type.Object(
      {
        url: Type.String({ minLength: 1, maxLength: 2_048 }),
        query: Type.Optional(Type.String({ maxLength: 500 })),
        maxChars: Type.Optional(Type.Integer({ minimum: 1, maximum: 20_000 })),
      },
      { additionalProperties: false },
    ),
    action: WEB_ACTIONS["web.fetch"],
    resourceId: WEB_RESOURCE,
    authService: options.store.authorization,
    getContext,
    execute: async (params, context) => {
      await requireEnabled(context, "web.fetch");
      if (params.query !== undefined && params.query.trim() === "")
        throw new ToolInputError("invalid_web_query");
      const result = await options.service.fetch(context.runId, params).catch(webInputError);
      await options.recordEvidence?.(
        {
          type: "web_fetch",
          runId: context.runId,
          conversationId: context.conversationId,
          principalId: context.caller.principalId,
          status: result.status,
          providerStatus: result.providerStatus,
          sourceIds: [result.sourceId],
          urls: [result.url],
          partial: result.partial,
          truncated: result.truncated,
          providerOrigins: result.providerOrigins,
          retrievedAt: result.retrievedAt,
          retrievalMethod: result.retrievalMethod,
          ...(result.contentType ? { contentType: result.contentType } : {}),
        },
        context,
      );
      requireWebSuccess(result.status);
      return result;
    },
    projectResult: (result) => JSON.stringify(result),
  });
  return [search, fetch];
}
