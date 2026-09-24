import { createHash } from "node:crypto";

/** Maximum UTF-16 units inspected directly by the estimator. */
export const TOKEN_ESTIMATE_SCAN_LIMIT = 65_536;

export type TokenEstimateSource =
  | "provider_compatible_estimator"
  | "tokenizer"
  | "unicode_conservative"
  | "chars_conservative"
  | "unknown";

export type TokenMaterialKind =
  | "system"
  | "current_message"
  | "tool_schema"
  | "conversation"
  | "retrieval"
  | "tool_result"
  | "artifact"
  | "other";

export interface TokenEstimate {
  tokens: number;
  source: TokenEstimateSource;
  conservative: boolean;
  materialKind: TokenMaterialKind;
  measuredChars: number;
  measuredBytes?: number;
  policyVersion: string;
}

/**
 * A deliberately conservative, bounded estimate for prompt budgeting.
 *
 * Every scanned Unicode code point counts as one token. Text beyond the scan limit is
 * charged one token per UTF-16 unit. This intentionally overestimates common text and keeps
 * work bounded for very large inputs.
 */
export function estimateUnicodeTokens(text: string): number {
  const scanned = text.slice(0, TOKEN_ESTIMATE_SCAN_LIMIT);
  let total = scanned.match(/[\s\S]/gu)?.length ?? 0;

  if (text.length > scanned.length) total += text.length - scanned.length;
  return total;
}

export function estimateTokenMaterial(
  text: string,
  materialKind: TokenMaterialKind,
  policyVersion = "unicode-conservative-v1",
): TokenEstimate {
  return {
    tokens: estimateUnicodeTokens(text),
    source: "unicode_conservative",
    conservative: true,
    materialKind,
    measuredChars: text.length,
    ...(text.length <= TOKEN_ESTIMATE_SCAN_LIMIT
      ? { measuredBytes: new TextEncoder().encode(text).length }
      : {}),
    policyVersion,
  };
}

export interface ContextDemandEstimate {
  /** Bounded numeric features for routing. Never place protected bodies here. */
  estimatedMaterialTokens: number;
  estimateSource: TokenEstimateSource;
  hasLargeAuthorizedContext: boolean;
  requiredOutputClass: "short" | "standard" | "long" | "structured";
  hasToolOrRetrieval: boolean;
  hasAttachmentsOrArtifacts: boolean;
  trustedPolicyFlags: readonly string[];
  /** System instructions and other fixed prompt text. */
  systemTokens: number;
  /** Current user request. This is an irreducible floor. */
  currentMessageTokens: number;
  /** Tool schemas exposed to this Run. */
  toolSchemaTokens: number;
  /** Other context that policy has declared irreducible. */
  requiredFloorTokens: number;
  /** Prior exchanges. An exchange is admitted or omitted as a whole. */
  exchanges: readonly ContextExchangeEstimate[];
}

export interface ContextExchangeEstimate {
  id: string;
  userTokens: number;
  assistantTokens: number;
  /** Required exchanges are preserved or produce an overflow result. */
  required?: boolean;
}

export interface ModelCapacity {
  contextWindowTokens: number;
  /** Space withheld for the model response. */
  outputReserveTokens: number;
  /** Additional safety margin for provider-specific serialization. */
  safetyMarginTokens: number;
}

export type ContextProjectionOverflow =
  | { kind: "invalid_capacity" }
  | { kind: "invalid_demand" }
  | { kind: "fixed_floor_exceeds_capacity"; floorTokens: number; budgetTokens: number }
  | { kind: "required_exchange_exceeds_capacity"; exchangeId: string; budgetTokens: number };

export interface ContextBudgetProjection {
  budgetTokens: number;
  fixedFloorTokens: number;
  projectedTokens: number;
  includedExchangeIds: string[];
  omittedExchangeIds: string[];
}

export type ContextProjectionResult =
  | { ok: true; projection: ContextBudgetProjection }
  | { ok: false; overflow: ContextProjectionOverflow };

/**
 * Project recent history into a model budget. Fixed and required floors are never clipped;
 * exchanges are considered newest first, admitted whole, then returned in original order.
 */
export function projectContextBudget(
  demand: ContextDemandEstimate,
  capacity: ModelCapacity,
): ContextProjectionResult {
  if (
    !isNonNegativeInteger(capacity.contextWindowTokens) ||
    !isNonNegativeInteger(capacity.outputReserveTokens) ||
    !isNonNegativeInteger(capacity.safetyMarginTokens) ||
    capacity.contextWindowTokens === 0
  )
    return { ok: false, overflow: { kind: "invalid_capacity" } };
  if (
    !isNonNegativeInteger(demand.estimatedMaterialTokens) ||
    !demand.estimateSource ||
    !["short", "standard", "long", "structured"].includes(demand.requiredOutputClass) ||
    !Array.isArray(demand.trustedPolicyFlags) ||
    demand.trustedPolicyFlags.some((flag) => typeof flag !== "string") ||
    !isNonNegativeInteger(demand.systemTokens) ||
    !isNonNegativeInteger(demand.currentMessageTokens) ||
    !isNonNegativeInteger(demand.toolSchemaTokens) ||
    !isNonNegativeInteger(demand.requiredFloorTokens) ||
    demand.exchanges.some(
      (exchange) =>
        !exchange.id ||
        !isNonNegativeInteger(exchange.userTokens) ||
        !isNonNegativeInteger(exchange.assistantTokens),
    ) ||
    new Set(demand.exchanges.map((exchange) => exchange.id)).size !== demand.exchanges.length
  )
    return { ok: false, overflow: { kind: "invalid_demand" } };

  const budgetTokens = Math.max(
    0,
    capacity.contextWindowTokens - capacity.outputReserveTokens - capacity.safetyMarginTokens,
  );
  const fixedFloorTokens =
    demand.systemTokens +
    demand.currentMessageTokens +
    demand.toolSchemaTokens +
    demand.requiredFloorTokens;
  if (fixedFloorTokens > budgetTokens) {
    return {
      ok: false,
      overflow: {
        kind: "fixed_floor_exceeds_capacity",
        floorTokens: fixedFloorTokens,
        budgetTokens,
      },
    };
  }

  const included = new Set<string>();
  let remaining = budgetTokens - fixedFloorTokens;
  for (const exchange of demand.exchanges.filter((item) => item.required)) {
    const tokens = exchange.userTokens + exchange.assistantTokens;
    if (tokens > remaining) {
      return {
        ok: false,
        overflow: {
          kind: "required_exchange_exceeds_capacity",
          exchangeId: exchange.id,
          budgetTokens,
        },
      };
    }
    included.add(exchange.id);
    remaining -= tokens;
  }
  for (const exchange of [...demand.exchanges].reverse()) {
    if (included.has(exchange.id)) continue;
    const tokens = exchange.userTokens + exchange.assistantTokens;
    if (tokens <= remaining) {
      included.add(exchange.id);
      remaining -= tokens;
    }
  }

  const includedExchangeIds = demand.exchanges
    .filter((exchange) => included.has(exchange.id))
    .map((exchange) => exchange.id);
  const omittedExchangeIds = demand.exchanges
    .filter((exchange) => !included.has(exchange.id))
    .map((exchange) => exchange.id);
  return {
    ok: true,
    projection: {
      budgetTokens,
      fixedFloorTokens,
      projectedTokens: budgetTokens - remaining,
      includedExchangeIds,
      omittedExchangeIds,
    },
  };
}

export type ToolBudgetClass =
  | "core"
  | "domain_read"
  | "domain_write"
  | "host"
  | "integration"
  | "worker";

export type ToolResultClass = "external" | "local" | "artifact" | "error" | "control" | "unknown";

export type ToolResultProjectionMode = "full" | "compact" | "reference" | "omit_duplicate";

export interface ToolResultForProjection {
  callId: string;
  toolName: string;
  budgetClass: ToolBudgetClass;
  resultClass: ToolResultClass;
  projection: ToolResultProjectionMode;
  /** Complete successful result text. */
  text?: string;
  /** Caller-produced deterministic compact projection. */
  projectedText?: string;
  /** Caller-produced non-content metadata. */
  metadata?: Readonly<Record<string, string | number | boolean | null>>;
  /** Stable reference to the full evidence retained outside model Context. */
  evidenceRef?: string;
  required?: boolean;
}

export type ToolResultClassification =
  | {
      kind: "content";
      source: "full" | "compact";
      text: string;
      metadata?: Readonly<Record<string, string | number | boolean | null>>;
    }
  | {
      kind: "reference";
      evidenceRef: string;
      metadata?: Readonly<Record<string, string | number | boolean | null>>;
    }
  | { kind: "omitted_duplicate" }
  | { kind: "unavailable"; reason: "projection_missing" };

export function classifyToolResult(result: ToolResultForProjection): ToolResultClassification {
  if (result.projection === "omit_duplicate") return { kind: "omitted_duplicate" };
  if (result.projection === "reference")
    return typeof result.evidenceRef === "string" && result.evidenceRef.length > 0
      ? {
          kind: "reference",
          evidenceRef: result.evidenceRef,
          ...(result.metadata ? { metadata: result.metadata } : {}),
        }
      : { kind: "unavailable", reason: "projection_missing" };
  if (result.projection === "compact")
    return typeof result.projectedText === "string"
      ? {
          kind: "content",
          source: "compact",
          text: result.projectedText,
          ...(result.metadata ? { metadata: result.metadata } : {}),
        }
      : { kind: "unavailable", reason: "projection_missing" };
  return typeof result.text === "string"
    ? {
        kind: "content",
        source: "full",
        text: result.text,
        ...(result.metadata ? { metadata: result.metadata } : {}),
      }
    : { kind: "unavailable", reason: "projection_missing" };
}

export interface ToolResultBudgetPolicy {
  policyVersion: string;
  perTurnTokens: number;
  singleResultTokens: Readonly<Record<ToolResultClass, number>>;
}

export interface ToolResultTurnProjection {
  calls: Array<{
    callId: string;
    toolName: string;
    budgetClass: ToolBudgetClass;
    classification: "content" | "reference" | "omitted_duplicate" | "unavailable";
    tokens: number;
    admitted: boolean;
    /** Present only when the projection fits the shared turn budget. */
    projection?: ToolResultClassification;
  }>;
  usedTokens: number;
  overflowCallIds: string[];
  callsByClass: Readonly<Record<ToolResultClass, number>>;
  tokensByClass: Readonly<Record<ToolResultClass, number>>;
}

/** Accounts every call against one shared per-turn result budget. Results are never clipped. */
export function projectToolResultsForTurn(
  results: readonly ToolResultForProjection[],
  policy: ToolResultBudgetPolicy | number,
):
  | ToolResultTurnProjection
  | {
      overflow:
        | { kind: "required_tool_result_exceeds_budget"; callId: string }
        | { kind: "required_tool_result_projection_missing"; callId: string }
        | { kind: "invalid_tool_result_budget" };
    } {
  const normalizedPolicy: ToolResultBudgetPolicy =
    typeof policy === "number"
      ? {
          policyVersion: "per-turn-only-v1",
          perTurnTokens: policy,
          singleResultTokens: {
            external: policy,
            local: policy,
            artifact: policy,
            error: policy,
            control: policy,
            unknown: policy,
          },
        }
      : policy;
  const tokenBudget = normalizedPolicy.perTurnTokens;
  if (!isNonNegativeInteger(tokenBudget))
    return { overflow: { kind: "invalid_tool_result_budget" } };
  if (
    Object.values(normalizedPolicy.singleResultTokens).some((limit) => !isNonNegativeInteger(limit))
  )
    return { overflow: { kind: "invalid_tool_result_budget" } };
  const calls: ToolResultTurnProjection["calls"] = [];
  const overflowCallIds: string[] = [];
  const callsByClass: Record<ToolResultClass, number> = {
    external: 0,
    local: 0,
    artifact: 0,
    error: 0,
    control: 0,
    unknown: 0,
  };
  const tokensByClass: Record<ToolResultClass, number> = {
    external: 0,
    local: 0,
    artifact: 0,
    error: 0,
    control: 0,
    unknown: 0,
  };
  let usedTokens = 0;
  for (const result of results) {
    callsByClass[result.resultClass] += 1;
    const classification = classifyToolResult(result);
    const metadataTokens = (
      metadata: Readonly<Record<string, string | number | boolean | null>> | undefined,
    ) =>
      metadata && Object.keys(metadata).length > 0
        ? estimateUnicodeTokens(JSON.stringify(metadata))
        : 0;
    const tokens =
      classification.kind === "content"
        ? estimateUnicodeTokens(classification.text) + metadataTokens(classification.metadata)
        : classification.kind === "reference"
          ? estimateUnicodeTokens(classification.evidenceRef) +
            metadataTokens(classification.metadata)
          : 0;
    const available = classification.kind !== "unavailable";
    const singleLimit = normalizedPolicy.singleResultTokens[result.resultClass];
    const mustPreserve =
      result.required === true ||
      result.resultClass === "error" ||
      result.resultClass === "control";
    const admitted = available && tokens <= singleLimit && tokens <= tokenBudget - usedTokens;
    if (!admitted) {
      overflowCallIds.push(result.callId);
      if (mustPreserve && !available)
        return {
          overflow: { kind: "required_tool_result_projection_missing", callId: result.callId },
        };
      if (mustPreserve)
        return { overflow: { kind: "required_tool_result_exceeds_budget", callId: result.callId } };
    } else {
      usedTokens += tokens;
      tokensByClass[result.resultClass] += tokens;
    }
    calls.push({
      callId: result.callId,
      toolName: result.toolName,
      budgetClass: result.budgetClass,
      classification: classification.kind,
      tokens,
      admitted,
      ...(admitted ? { projection: classification } : {}),
    });
  }
  return { calls, usedTokens, overflowCallIds, callsByClass, tokensByClass };
}

export interface DuplicateCallIdentity {
  authorityScope: string;
  resourceId: string;
  semanticKey?: string;
  toolName: string;
  input: unknown;
  /** True only when the caller has established that this terminal failure is retryable. */
  retryAllowed?: boolean;
}

export interface DuplicateCallAdmissionRecord extends DuplicateCallIdentity {
  attempt: number;
  state: "running" | "succeeded" | "failed";
}

export type DuplicateCallAdmission =
  | { admitted: true; attempt: number; key: string }
  | {
      admitted: false;
      reason: "already_running" | "already_succeeded" | "retry_limit_reached";
      key: string;
    };

/** Admit an identical call once, with bounded retries only after a recorded failure. */
export function admitDuplicateCall(
  existing: readonly DuplicateCallAdmissionRecord[],
  identity: DuplicateCallIdentity,
  maxRetries = 1,
): DuplicateCallAdmission {
  const key = duplicateCallKey(identity);
  if (!isNonNegativeInteger(maxRetries))
    return { admitted: false, reason: "retry_limit_reached", key };
  const prior = existing
    .filter((record) => duplicateCallKey(record) === key)
    .sort((left, right) => right.attempt - left.attempt)[0];
  if (!prior) return { admitted: true, attempt: 1, key };
  if (prior.state === "running") return { admitted: false, reason: "already_running", key };
  if (prior.state === "succeeded") return { admitted: false, reason: "already_succeeded", key };
  if (identity.retryAllowed !== true || prior.attempt > maxRetries)
    return { admitted: false, reason: "retry_limit_reached", key };
  return { admitted: true, attempt: prior.attempt + 1, key };
}

function duplicateCallKey(identity: DuplicateCallIdentity): string {
  return stableDigest({
    authorityScope: identity.authorityScope,
    resourceId: identity.resourceId,
    semanticKey: identity.semanticKey,
    toolName: identity.toolName,
    input: identity.input,
  });
}

export interface AuthorizedContextCacheIdentity {
  agentId: string;
  principalId: string;
  locationKey: string;
  conversationId: string;
  resourceId: string;
  authorizedResourceFingerprint: string;
  action: string;
  authorizationRevision: string;
  sourceRevision: string;
  retrievalPolicyVersion: string;
  runtimeProfileDigest: string;
  behaviorVersion: string;
  projectionPolicyVersion: string;
  contextVersion: string;
}

export interface AuthorizedContextCacheEntry<T> {
  kind: "authorized_context_fragment";
  key: string;
  identity: AuthorizedContextCacheIdentity;
  expiresAt: number;
  value: T;
}

/** Key material is scoped to a principal, location, resource, action and current revisions. */
export function authorizedContextCacheKey(identity: AuthorizedContextCacheIdentity): string {
  return stableDigest({
    kind: "authorized_context_fragment",
    agentId: identity.agentId,
    principalId: identity.principalId,
    locationKey: identity.locationKey,
    conversationId: identity.conversationId,
    resourceId: identity.resourceId,
    authorizedResourceFingerprint: identity.authorizedResourceFingerprint,
    action: identity.action,
    authorizationRevision: identity.authorizationRevision,
    sourceRevision: identity.sourceRevision,
    retrievalPolicyVersion: identity.retrievalPolicyVersion,
    runtimeProfileDigest: identity.runtimeProfileDigest,
    behaviorVersion: identity.behaviorVersion,
    projectionPolicyVersion: identity.projectionPolicyVersion,
    contextVersion: identity.contextVersion,
  });
}

/** Cache hits require exact current authority/source identity and an unexpired entry. */
export function isAuthorizedContextCacheEntryValid<T>(
  entry: AuthorizedContextCacheEntry<T>,
  current: AuthorizedContextCacheIdentity,
  now = Date.now(),
): boolean {
  return (
    entry.kind === "authorized_context_fragment" &&
    Number.isFinite(entry.expiresAt) &&
    entry.expiresAt > now &&
    entry.key === authorizedContextCacheKey(current) &&
    stableDigest(entry.identity) === stableDigest(current)
  );
}

function stableDigest(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    const encoded = JSON.stringify(value);
    return encoded === undefined ? "undefined" : encoded;
  }
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`)
    .join(",")}}`;
}

function isNonNegativeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}
