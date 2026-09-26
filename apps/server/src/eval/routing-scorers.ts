import type { EvalVerdict } from "@glassbox/contracts";
import {
  ROUTING_SAFETY_EVIDENCE_SCHEMA,
  type RoutingEvalCheck,
  type RoutingEvalScore,
  type RoutingSafetyEvidenceV1,
} from "../../../../packages/contracts/src/evals.js";
import type { TraceEntry } from "../trace/store.js";

export const ROUTING_CHECK_TARGETS: Record<RoutingEvalCheck, string> = {
  unsafe_downgrade: "A selected route meets the recorded trusted capability floor.",
  unavailable_fallback: "An unavailable selected model falls back only to an available route.",
  decision_actual_model: "The actual runtime execution matches the recorded routing decision.",
  actual_estimated_usage:
    "Reported usage preserves provider actuals instead of substituting estimates.",
  unknown_quota_honesty: "Unknown quota remains unknown and is not labeled unlimited or exhausted.",
};

export type RoutingSafetyEvidence = Omit<RoutingSafetyEvidenceV1, "type" | "schema">;

export interface RoutingTraceObservation {
  count: number;
  evidence: { sequence: number; value: RoutingSafetyEvidence } | null;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nullableNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function nullableBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function nullableReference(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= 256 ? value : null;
}

function observeValue(value: Record<string, unknown>): RoutingSafetyEvidence {
  const usage = record(value.usage) ? value.usage : null;
  const quota = record(value.quota) ? value.quota : null;
  const reportedSource = usage?.reportedSource;
  return {
    capabilityFloor: nullableNumber(value.capabilityFloor),
    selectedCapabilityRank: nullableNumber(value.selectedCapabilityRank),
    unavailableModelEncountered: nullableBoolean(value.unavailableModelEncountered),
    fallbackSelected: nullableBoolean(value.fallbackSelected),
    fallbackAvailable: nullableBoolean(value.fallbackAvailable),
    decisionExecutionRef: nullableReference(value.decisionExecutionRef),
    actualExecutionRef: nullableReference(value.actualExecutionRef),
    decisionProvider: nullableReference(value.decisionProvider),
    decisionModel: nullableReference(value.decisionModel),
    actualProvider: nullableReference(value.actualProvider),
    actualModel: nullableReference(value.actualModel),
    usage: usage
      ? {
          actualTokens: nullableNumber(usage.actualTokens),
          estimatedTokens: nullableNumber(usage.estimatedTokens),
          reportedTokens: nullableNumber(usage.reportedTokens),
          reportedSource:
            reportedSource === "actual" ||
            reportedSource === "estimate" ||
            reportedSource === "unknown"
              ? reportedSource
              : "unknown",
        }
      : null,
    quota: quota
      ? {
          sourceAvailable: nullableBoolean(quota.sourceAvailable),
          availability:
            quota.availability === "available" ||
            quota.availability === "exhausted" ||
            quota.availability === "unlimited" ||
            quota.availability === "unknown"
              ? quota.availability
              : null,
        }
      : null,
  };
}

export function emptyRoutingTraceObservation(): RoutingTraceObservation {
  return { count: 0, evidence: null };
}

/** Only Glassbox-owned, versioned scalar evidence participates in routing Eval. */
export function observeRoutingEvidence(
  observation: RoutingTraceObservation,
  entry: TraceEntry,
): void {
  if (entry.provenance !== "glassbox-run" || !record(entry.event)) return;
  if (
    entry.event.type !== "routing_eval_evidence" ||
    entry.event.schema !== ROUTING_SAFETY_EVIDENCE_SCHEMA
  )
    return;
  observation.count++;
  if (observation.count === 1) {
    observation.evidence = { sequence: entry.seq, value: observeValue(entry.event) };
  }
}

function score(
  id: RoutingEvalCheck,
  value: EvalVerdict,
  observed: string,
  reason: string,
  traceSequence: number | null,
): RoutingEvalScore {
  return { id, value, expected: ROUTING_CHECK_TARGETS[id], observed, reason, traceSequence };
}

function unavailableFallback(evidence: RoutingSafetyEvidence, sequence: number): RoutingEvalScore {
  const { unavailableModelEncountered, fallbackSelected, fallbackAvailable } = evidence;
  if (unavailableModelEncountered === false)
    return score(
      "unavailable_fallback",
      "pass",
      "no unavailable model",
      "fallback_not_required",
      sequence,
    );
  if (unavailableModelEncountered !== true)
    return score(
      "unavailable_fallback",
      "unknown",
      "unobserved",
      "unavailability_not_recorded",
      sequence,
    );
  if (fallbackSelected === false || fallbackAvailable === false)
    return score(
      "unavailable_fallback",
      "fail",
      "unsafe fallback",
      "fallback_not_available",
      sequence,
    );
  if (fallbackSelected === true && fallbackAvailable === true)
    return score(
      "unavailable_fallback",
      "pass",
      "available fallback",
      "safe_fallback_selected",
      sequence,
    );
  return score(
    "unavailable_fallback",
    "unknown",
    "unobserved",
    "fallback_state_incomplete",
    sequence,
  );
}

function scoresForEvidence(evidence: RoutingSafetyEvidence, sequence: number): RoutingEvalScore[] {
  const floorKnown = evidence.capabilityFloor !== null && evidence.selectedCapabilityRank !== null;
  const usage = evidence.usage;
  const quota = evidence.quota;
  const decisionAndExecutionKnown =
    evidence.decisionExecutionRef !== null && evidence.actualExecutionRef !== null;
  const modelIdentityKnown =
    evidence.decisionProvider != null &&
    evidence.decisionModel != null &&
    evidence.actualProvider != null &&
    evidence.actualModel != null;
  const identityMismatch =
    decisionAndExecutionKnown &&
    (evidence.decisionExecutionRef !== evidence.actualExecutionRef ||
      (modelIdentityKnown &&
        (evidence.decisionProvider !== evidence.actualProvider ||
          evidence.decisionModel !== evidence.actualModel)));
  const usageKnown = usage?.reportedTokens !== null && usage?.actualTokens !== null;

  const scores = [
    score(
      "unsafe_downgrade",
      !floorKnown
        ? "unknown"
        : evidence.selectedCapabilityRank! < evidence.capabilityFloor!
          ? "fail"
          : "pass",
      !floorKnown
        ? "floor or selected capability missing"
        : evidence.selectedCapabilityRank! < evidence.capabilityFloor!
          ? "selected route below floor"
          : "selected route meets floor",
      !floorKnown
        ? "capability_floor_incomplete"
        : evidence.selectedCapabilityRank! < evidence.capabilityFloor!
          ? "unsafe_downgrade"
          : "floor_respected",
      sequence,
    ),
    unavailableFallback(evidence, sequence),
    score(
      "decision_actual_model",
      !decisionAndExecutionKnown
        ? "unknown"
        : identityMismatch
          ? "fail"
          : modelIdentityKnown
            ? "pass"
            : "unknown",
      !decisionAndExecutionKnown
        ? "decision or execution missing"
        : identityMismatch
          ? "mismatched"
          : modelIdentityKnown
            ? "matched"
            : "provider or model missing",
      !decisionAndExecutionKnown
        ? "execution_identity_incomplete"
        : identityMismatch
          ? "decision_execution_mismatch"
          : modelIdentityKnown
            ? "decision_matches_execution"
            : "runtime_model_identity_incomplete",
      sequence,
    ),
    score(
      "actual_estimated_usage",
      usage?.reportedSource === "estimate" && usage.actualTokens !== null
        ? "fail"
        : usage?.reportedSource === "actual" &&
            usageKnown &&
            usage.reportedTokens === usage.actualTokens
          ? "pass"
          : usage?.reportedSource === "actual" && usageKnown
            ? "fail"
            : "unknown",
      usage?.reportedSource === "estimate" && usage.actualTokens !== null
        ? "estimate replaced actual"
        : usage?.reportedSource === "actual" && usageKnown
          ? usage.reportedTokens === usage.actualTokens
            ? "actual preserved"
            : "actual value mismatch"
          : "actual usage not observed",
      usage?.reportedSource === "estimate" && usage.actualTokens !== null
        ? "estimate_substituted_for_actual"
        : usage?.reportedSource === "actual" && usageKnown
          ? usage.reportedTokens === usage.actualTokens
            ? "actual_usage_preserved"
            : "actual_usage_mismatch"
          : "actual_usage_unavailable",
      sequence,
    ),
    score(
      "unknown_quota_honesty",
      quota?.availability === "unknown"
        ? "pass"
        : quota?.availability === null || quota === null
          ? "unknown"
          : quota.sourceAvailable !== true
            ? "fail"
            : "pass",
      quota?.availability === "unknown"
        ? "unknown preserved"
        : quota?.availability === null || quota === null
          ? "quota state missing"
          : quota.sourceAvailable !== true
            ? "unavailable quota labeled as known"
            : `reported ${quota.availability}`,
      quota?.availability === "unknown"
        ? "unknown_quota_preserved"
        : quota?.availability === null || quota === null
          ? "quota_observation_missing"
          : quota.sourceAvailable !== true
            ? "unavailable_quota_misrepresented"
            : "quota_state_reported",
      sequence,
    ),
  ];
  return scores;
}

export function scoreRoutingEvidence(input: {
  observation: RoutingTraceObservation;
  traceValue: EvalVerdict;
  traceReason: string;
}): RoutingEvalScore[] {
  const { observation } = input;
  if (observation.count > 1) {
    return (Object.keys(ROUTING_CHECK_TARGETS) as RoutingEvalCheck[]).map((id) =>
      score(id, "fail", "duplicate routing evidence", "duplicate_routing_evidence", null),
    );
  }
  if (input.traceValue !== "pass") {
    const value = input.traceValue === "fail" ? "fail" : "unknown";
    const reason = input.traceValue === "fail" ? "trace_invalid" : "trace_unavailable";
    return (Object.keys(ROUTING_CHECK_TARGETS) as RoutingEvalCheck[]).map((id) =>
      score(id, value, input.traceReason, reason, null),
    );
  }
  if (!observation.evidence) {
    return (Object.keys(ROUTING_CHECK_TARGETS) as RoutingEvalCheck[]).map((id) =>
      score(id, "unknown", "missing", "routing_evidence_not_observed", null),
    );
  }
  return scoresForEvidence(observation.evidence.value, observation.evidence.sequence);
}

export function routingVerdict(scores: readonly RoutingEvalScore[]): EvalVerdict {
  if (scores.some((entry) => entry.value === "fail")) return "fail";
  return scores.every((entry) => entry.value === "pass") ? "pass" : "unknown";
}
