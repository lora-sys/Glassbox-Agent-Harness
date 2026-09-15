/** Sample/Score fields adapted from Inspect AI. See apps/server/src/eval/SOURCES.md. */
export const RUN_INTEGRITY_SUITE = "run-integrity-v1";
export type EvalVerdict = "pass" | "fail" | "unknown";
export type RunEvalCheck =
  | "run_terminal"
  | "trace_index"
  | "terminal_event"
  | "ack_delivery"
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
