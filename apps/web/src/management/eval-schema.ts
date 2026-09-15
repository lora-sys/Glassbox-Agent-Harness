import { RUN_INTEGRITY_SUITE } from "@glassbox/contracts";
import type {
  EvalVerdict,
  RunEvalAssessment,
  RunEvalCheck,
  RunEvalPage,
  RunEvalView,
} from "@glassbox/contracts";
import { ManagementApiError } from "./errors";
import {
  decodeRecordPage,
  recordCounter,
  recordsObject,
  recordText,
  recordTime,
} from "./records-schema";

const checkIds: RunEvalCheck[] = [
  "run_terminal",
  "trace_index",
  "terminal_event",
  "ack_delivery",
  "result_delivery",
  "result_delivery_event",
];
function invalid(): never {
  throw new ManagementApiError("INVALID_RESPONSE");
}
function content(value: unknown): string {
  if (typeof value !== "string" || value.length > 32000) return invalid();
  return value;
}
function verdict(value: unknown): EvalVerdict {
  if (value !== "pass" && value !== "fail" && value !== "unknown") return invalid();
  return value;
}
function assessment(value: unknown, expectedRunId: string): RunEvalAssessment | null {
  if (value === null) return null;
  const input = recordsObject(value);
  if (
    input.suiteId !== RUN_INTEGRITY_SUITE ||
    input.source !== "stored-run-evidence" ||
    input.acceptance !== "not-assessed" ||
    !Array.isArray(input.scores) ||
    input.scores.length !== checkIds.length
  )
    return invalid();
  const sample = recordsObject(input.sample);
  const sampleInput = recordsObject(sample.input);
  const run = recordsObject(input.run);
  const trace = recordsObject(input.trace);
  if (
    sampleInput.runId !== expectedRunId ||
    sample.target !== RUN_INTEGRITY_SUITE ||
    run.id !== expectedRunId ||
    trace.runId !== expectedRunId
  )
    return invalid();
  const scores = input.scores.map((value) => {
    const score = recordsObject(value);
    if (!checkIds.some((id) => id === score.id)) return invalid();
    const sequence = score.traceSequence === null ? null : recordCounter(score.traceSequence);
    if (sequence === 0) return invalid();
    return {
      id: score.id as RunEvalCheck,
      value: verdict(score.value),
      expected: content(score.expected),
      observed: content(score.observed),
      reason: content(score.reason),
      traceSequence: sequence,
    };
  });
  if (new Set(scores.map((score) => score.id)).size !== scores.length) return invalid();
  const combinedVerdict = scores.some((score) => score.value === "fail")
    ? "fail"
    : scores.some((score) => score.value === "unknown")
      ? "unknown"
      : "pass";
  if (input.verdict !== combinedVerdict) return invalid();
  return {
    suiteId: RUN_INTEGRITY_SUITE,
    source: "stored-run-evidence",
    acceptance: "not-assessed",
    verdict: verdict(input.verdict),
    sample: {
      id: recordText(sample.id),
      input: { runId: expectedRunId, messageId: recordText(sampleInput.messageId) },
      target: RUN_INTEGRITY_SUITE,
    },
    run: {
      id: expectedRunId,
      conversationId: recordText(run.conversationId),
      executionRef: recordText(run.executionRef),
      status: recordText(run.status),
    },
    trace: {
      runId: expectedRunId,
      traceRef: recordText(trace.traceRef),
      byteOffset: recordCounter(trace.byteOffset),
      eventCount: recordCounter(trace.eventCount),
    },
    scores,
  };
}
export function decodeEvaluation(value: unknown, expectedRunId: string): RunEvalView {
  const input = recordsObject(value);
  if (input.runId !== expectedRunId || typeof input.passed !== "boolean") return invalid();
  const traceStart = recordCounter(input.traceStart);
  const traceEnd = recordCounter(input.traceEnd);
  if (traceEnd < traceStart) return invalid();
  const parsedAssessment = assessment(input.assessment, expectedRunId);
  if (
    parsedAssessment &&
    (input.passed !== (parsedAssessment.verdict === "pass") ||
      parsedAssessment.sample.id !== input.sampleId ||
      parsedAssessment.trace.traceRef !== input.traceRef ||
      parsedAssessment.trace.eventCount !== traceEnd ||
      traceStart !== 0 ||
      parsedAssessment.scores.some(
        (score) => score.traceSequence !== null && score.traceSequence > traceEnd,
      ))
  )
    return invalid();
  return {
    id: recordText(input.id),
    runId: expectedRunId,
    sampleId: recordText(input.sampleId),
    scorerVersion: recordText(input.scorerVersion),
    traceRef: recordText(input.traceRef),
    traceStart,
    traceEnd,
    expected: content(input.expected),
    observed: content(input.observed),
    passed: input.passed,
    inputTokens: input.inputTokens === null ? null : recordCounter(input.inputTokens),
    outputTokens: input.outputTokens === null ? null : recordCounter(input.outputTokens),
    durationMs: input.durationMs === null ? null : recordCounter(input.durationMs),
    createdAt: recordTime(input.createdAt),
    assessment: parsedAssessment,
  };
}
export function decodeEvalPage(value: unknown, expectedRunId: string): RunEvalPage {
  return decodeRecordPage(value, (item) => decodeEvaluation(item, expectedRunId));
}
export function decodeEvalResult(value: unknown, expectedRunId: string): RunEvalView {
  const input = recordsObject(value);
  if (Object.keys(input).some((key) => key !== "evaluation")) return invalid();
  return decodeEvaluation(input.evaluation, expectedRunId);
}
