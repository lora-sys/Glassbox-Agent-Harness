/** Sample/Score fields adapted from Inspect AI. See apps/server/src/eval/SOURCES.md. */
export const RUN_INTEGRITY_SUITE = "run-integrity-v1";
export type EvalVerdict = "pass" | "fail" | "unknown";
export type RunEvalCheck =
  | "run_terminal"
  | "trace_index"
  | "terminal_event"
  | "result_delivery"
  | "result_delivery_event";

export interface RunEvalScore {
  id: RunEvalCheck;
  value: EvalVerdict;
  expected: string;
  observed: string;
  reason: string;
  traceSequence: number | null;
}

export interface RunEvalAssessment {
  suiteId: typeof RUN_INTEGRITY_SUITE;
  source: "stored-run-evidence";
  /** These checks never certify a real QQ send or Claude Code acceptance test. */
  acceptance: "not-assessed";
  verdict: EvalVerdict;
  sample: {
    id: string;
    input: { runId: string; messageId: string };
    target: typeof RUN_INTEGRITY_SUITE;
  };
  run: { id: string; conversationId: string; executionRef: string; status: string };
  trace: { runId: string; traceRef: string; byteOffset: number; eventCount: number };
  scores: RunEvalScore[];
}

/** Existing evidence fields remain available even for older scorer versions. */
export interface RunEvalView {
  id: string;
  runId: string;
  sampleId: string;
  scorerVersion: string;
  traceRef: string;
  traceStart: number;
  traceEnd: number;
  expected: string;
  observed: string;
  passed: boolean;
  inputTokens: number | null;
  outputTokens: number | null;
  durationMs: number | null;
  createdAt: string;
  assessment: RunEvalAssessment | null;
}

export interface RunEvalPage {
  items: RunEvalView[];
  nextCursor: string | null;
}

/** Deterministic safety checks over sanitized, durable routing Trace evidence. */
export const ROUTING_SAFETY_SUITE = "routing-safety-v1";
export const ROUTING_SAFETY_SCORER_VERSION = "routing-safety-v1.0";
export const ROUTING_SAFETY_EVIDENCE_SCHEMA = "glassbox.routing-eval-evidence.v1";

/** Safe scalar fields required to replay the routing checks from Raw Trace. */
export interface RoutingSafetyEvidenceV1 {
  type: "routing_eval_evidence";
  schema: typeof ROUTING_SAFETY_EVIDENCE_SCHEMA;
  capabilityFloor: number | null;
  selectedCapabilityRank: number | null;
  unavailableModelEncountered: boolean | null;
  fallbackSelected: boolean | null;
  fallbackAvailable: boolean | null;
  decisionExecutionRef: string | null;
  actualExecutionRef: string | null;
  decisionProvider?: string | null;
  decisionModel?: string | null;
  actualProvider?: string | null;
  actualModel?: string | null;
  usage: {
    actualTokens: number | null;
    estimatedTokens: number | null;
    reportedTokens: number | null;
    reportedSource: "actual" | "estimate" | "unknown";
  } | null;
  quota: {
    sourceAvailable: boolean | null;
    availability: "available" | "exhausted" | "unlimited" | "unknown" | null;
  } | null;
}

export type RoutingEvalCheck =
  | "unsafe_downgrade"
  | "unavailable_fallback"
  | "decision_actual_model"
  | "actual_estimated_usage"
  | "unknown_quota_honesty";

export interface RoutingEvalScore {
  id: RoutingEvalCheck;
  value: EvalVerdict;
  expected: string;
  observed: string;
  reason: string;
  traceSequence: number | null;
}

export interface RoutingEvalAssessment {
  suiteId: typeof ROUTING_SAFETY_SUITE;
  source: "stored-run-evidence";
  acceptance: "not-assessed";
  verdict: EvalVerdict;
  sample: {
    id: string;
    input: { runId: string };
    target: typeof ROUTING_SAFETY_SUITE;
  };
  run: { id: string; conversationId: string; executionRef: string; status: string };
  trace: { runId: string; traceRef: string; byteOffset: number; eventCount: number };
  scores: RoutingEvalScore[];
}

export interface RoutingEvalView extends Omit<RunEvalView, "assessment"> {
  assessment: RoutingEvalAssessment | null;
}

export type EvalView = RunEvalView | RoutingEvalView;

export interface EvalPage {
  items: EvalView[];
  nextCursor: string | null;
}
