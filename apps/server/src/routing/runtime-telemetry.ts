import type { Usage } from "@earendil-works/pi-ai";

export type MeasurementSource = "reported" | "sdk_normalized" | "derived" | "unknown";

export interface UsageMeasurement {
  value: number | null;
  source: MeasurementSource;
}

export interface RuntimeCostMeasurement {
  input: number | null;
  output: number | null;
  cacheRead: number | null;
  cacheWrite: number | null;
  total: number | null;
  /** Null means no price source was supplied. Provider placeholder zeroes are ignored. */
  source: "reported" | "configured" | null;
}

export interface RuntimeThroughputSample {
  tokensPerSecond: number | null;
  sampleDurationMs: number | null;
  source: "observed" | "unknown";
}

export interface NormalizedPiTurnUsage {
  inputTokens: UsageMeasurement;
  outputTokens: UsageMeasurement;
  cacheReadTokens: UsageMeasurement;
  cacheWriteTokens: UsageMeasurement;
  reasoningTokens: UsageMeasurement;
  totalTokens: UsageMeasurement;
  cost: RuntimeCostMeasurement;
  throughput: RuntimeThroughputSample;
}

/** An explicit price source. Pi's numeric cost fields alone are not evidence of price. */
export interface CostEvidence {
  source: "reported" | "configured";
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

/** A Run may contain several Pi turns around Tool calls. Keep its known usage cumulative. */
export function aggregateRuntimeUsage(
  previous: NormalizedPiTurnUsage | undefined,
  next: NormalizedPiTurnUsage,
): NormalizedPiTurnUsage {
  if (!previous) return next;
  const addMeasurement = (left: UsageMeasurement, right: UsageMeasurement): UsageMeasurement => {
    if (left.value === null || right.value === null) return { value: null, source: "unknown" };
    const source =
      left.source === "reported" && right.source === "reported"
        ? "reported"
        : left.source === "sdk_normalized" && right.source === "sdk_normalized"
          ? "sdk_normalized"
          : "derived";
    return { value: left.value + right.value, source };
  };
  const costSourcesMatch =
    previous.cost.source === next.cost.source && previous.cost.source !== null;
  const cost = costSourcesMatch
    ? {
        input:
          previous.cost.input === null || next.cost.input === null
            ? null
            : previous.cost.input + next.cost.input,
        output:
          previous.cost.output === null || next.cost.output === null
            ? null
            : previous.cost.output + next.cost.output,
        cacheRead:
          previous.cost.cacheRead === null || next.cost.cacheRead === null
            ? null
            : previous.cost.cacheRead + next.cost.cacheRead,
        cacheWrite:
          previous.cost.cacheWrite === null || next.cost.cacheWrite === null
            ? null
            : previous.cost.cacheWrite + next.cost.cacheWrite,
        total:
          previous.cost.total === null || next.cost.total === null
            ? null
            : previous.cost.total + next.cost.total,
        source: previous.cost.source,
      }
    : { input: null, output: null, cacheRead: null, cacheWrite: null, total: null, source: null };
  const totalTokens = addMeasurement(previous.totalTokens, next.totalTokens);
  const durationKnown =
    previous.throughput.sampleDurationMs !== null && next.throughput.sampleDurationMs !== null;
  const duration = durationKnown
    ? previous.throughput.sampleDurationMs! + next.throughput.sampleDurationMs!
    : null;
  return {
    inputTokens: addMeasurement(previous.inputTokens, next.inputTokens),
    outputTokens: addMeasurement(previous.outputTokens, next.outputTokens),
    cacheReadTokens: addMeasurement(previous.cacheReadTokens, next.cacheReadTokens),
    cacheWriteTokens: addMeasurement(previous.cacheWriteTokens, next.cacheWriteTokens),
    reasoningTokens: addMeasurement(previous.reasoningTokens, next.reasoningTokens),
    totalTokens,
    cost,
    throughput:
      duration !== null && totalTokens.value !== null && duration > 0
        ? {
            tokensPerSecond: (totalTokens.value * 1_000) / duration,
            sampleDurationMs: duration,
            source: "observed",
          }
        : { tokensPerSecond: null, sampleDurationMs: null, source: "unknown" },
  };
}

function validNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

type UsageField = "input" | "output" | "cacheRead" | "cacheWrite" | "reasoning" | "totalTokens";

function measured(
  usage: Partial<Usage> | null | undefined,
  field: UsageField,
  providerReported?: Partial<Record<UsageField, boolean>>,
): UsageMeasurement {
  const value = usage?.[field];
  if (!validNonNegative(value) || providerReported?.[field] === false)
    return { value: null, source: "unknown" };
  return { value, source: providerReported?.[field] === true ? "reported" : "sdk_normalized" };
}

function normalizeCost(evidence: CostEvidence | null | undefined): RuntimeCostMeasurement {
  if (
    !evidence ||
    ![
      evidence.input,
      evidence.output,
      evidence.cacheRead,
      evidence.cacheWrite,
      evidence.total,
    ].every(validNonNegative)
  )
    return {
      input: null,
      output: null,
      cacheRead: null,
      cacheWrite: null,
      total: null,
      source: null,
    };
  return { ...evidence };
}

function normalizeThroughput(
  totalTokens: UsageMeasurement,
  sample?: { startedAtMs?: number | null; completedAtMs?: number | null },
): RuntimeThroughputSample {
  const started = sample?.startedAtMs;
  const completed = sample?.completedAtMs;
  if (
    totalTokens.value === null ||
    !validNonNegative(started) ||
    !validNonNegative(completed) ||
    completed <= started
  )
    return { tokensPerSecond: null, sampleDurationMs: null, source: "unknown" };
  const duration = completed - started;
  return {
    tokensPerSecond: (totalTokens.value * 1_000) / duration,
    sampleDurationMs: duration,
    source: "observed",
  };
}

/** Normalize the assistant usage attached to Pi's turn_end event. */
export function normalizePiTurnEndUsage(input: {
  usage?: Partial<Usage> | null;
  /** Optional provenance retained when the provider supplied per-field report flags separately. */
  providerReported?: Partial<Record<UsageField, boolean>>;
  costEvidence?: CostEvidence | null;
  sample?: { startedAtMs?: number | null; completedAtMs?: number | null };
}): NormalizedPiTurnUsage {
  const usage = input.usage;
  const inputTokens = measured(usage, "input", input.providerReported);
  const outputTokens = measured(usage, "output", input.providerReported);
  const cacheReadTokens = measured(usage, "cacheRead", input.providerReported);
  const cacheWriteTokens = measured(usage, "cacheWrite", input.providerReported);
  const reasoningTokens = measured(usage, "reasoning", input.providerReported);
  const normalizedTotal = measured(usage, "totalTokens", input.providerReported);
  const totalTokens =
    normalizedTotal.source === "reported" || normalizedTotal.source === "sdk_normalized"
      ? normalizedTotal
      : inputTokens.value !== null && outputTokens.value !== null
        ? {
            value:
              inputTokens.value +
              outputTokens.value +
              (cacheReadTokens.value ?? 0) +
              (cacheWriteTokens.value ?? 0),
            source: "derived" as const,
          }
        : { value: null, source: "unknown" as const };
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    reasoningTokens,
    totalTokens,
    cost: normalizeCost(input.costEvidence),
    throughput: normalizeThroughput(totalTokens, input.sample),
  };
}

export interface RuntimeLimitObservations {
  contextWindowTokens: number | null;
  maxOutputTokens: number | null;
  maxConcurrentRuns: number | null;
  requestsPerMinute: number | null;
  tokensPerMinute: number | null;
  requestsRemaining: number | null;
  tokensRemaining: number | null;
  quotaResetsAt: string | null;
  source: "provider_reported" | "operator_configured" | null;
}

export function normalizeRuntimeLimits(
  input?: Partial<RuntimeLimitObservations> | null,
): RuntimeLimitObservations {
  const nonNegativeOrNull = (value: unknown): number | null =>
    validNonNegative(value) ? value : null;
  const source =
    input?.source === "provider_reported" || input?.source === "operator_configured"
      ? input.source
      : null;
  const quotaResetsAt =
    source !== null &&
    typeof input?.quotaResetsAt === "string" &&
    Number.isFinite(Date.parse(input.quotaResetsAt))
      ? new Date(input.quotaResetsAt).toISOString()
      : null;
  return {
    contextWindowTokens: source === null ? null : nonNegativeOrNull(input?.contextWindowTokens),
    maxOutputTokens: source === null ? null : nonNegativeOrNull(input?.maxOutputTokens),
    maxConcurrentRuns: source === null ? null : nonNegativeOrNull(input?.maxConcurrentRuns),
    requestsPerMinute: source === null ? null : nonNegativeOrNull(input?.requestsPerMinute),
    tokensPerMinute: source === null ? null : nonNegativeOrNull(input?.tokensPerMinute),
    requestsRemaining: source === null ? null : nonNegativeOrNull(input?.requestsRemaining),
    tokensRemaining: source === null ? null : nonNegativeOrNull(input?.tokensRemaining),
    quotaResetsAt,
    source,
  };
}

export interface RuntimeHealthObservation {
  state: "healthy" | "degraded" | "unavailable" | "unknown";
  checkedAt: string | null;
  freshness: "fresh" | "stale" | "unknown";
  latencyMs: number | null;
  reasonCode: string | null;
}

export function normalizeRuntimeHealth(
  input: {
    state?: RuntimeHealthObservation["state"] | null;
    checkedAt?: string | null;
    latencyMs?: number | null;
    reasonCode?: string | null;
    nowMs?: number;
    maxAgeMs?: number;
  } = {},
): RuntimeHealthObservation {
  const now = input.nowMs ?? Date.now();
  const maxAge = validNonNegative(input.maxAgeMs) ? input.maxAgeMs : 60_000;
  const checked = typeof input.checkedAt === "string" ? Date.parse(input.checkedAt) : Number.NaN;
  const validTimestamp = Number.isFinite(checked) && checked <= now;
  const age = validTimestamp ? now - checked : null;
  const freshness = age === null ? "unknown" : age > maxAge ? "stale" : "fresh";
  const state =
    freshness === "stale" || freshness === "unknown" ? "unknown" : (input.state ?? "unknown");
  return {
    state,
    checkedAt: validTimestamp ? new Date(checked).toISOString() : null,
    freshness,
    latencyMs: validNonNegative(input.latencyMs) && freshness === "fresh" ? input.latencyMs : null,
    reasonCode:
      typeof input.reasonCode === "string" && /^[a-z][a-z0-9_]{0,63}$/u.test(input.reasonCode)
        ? input.reasonCode
        : null,
  };
}
