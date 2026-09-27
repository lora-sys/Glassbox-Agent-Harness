import {
  RUN_INTEGRITY_SUITE,
  type EvalVerdict,
  type RunEvalAssessment,
  type RunEvalCheck,
  type RunEvalScore,
  type RunEvalView,
} from "@glassbox/contracts";
import {
  ROUTING_SAFETY_SCORER_VERSION,
  ROUTING_SAFETY_SUITE,
  type RoutingEvalAssessment,
  type RoutingEvalCheck,
  type RoutingEvalScore,
  type RoutingEvalView,
} from "../../../../packages/contracts/src/evals.js";
import type { EvalResult } from "../persistence/evidence.js";
import { CHECK_TARGETS, RUN_INTEGRITY_SCORER_VERSION, verdict } from "./scorers.js";
import { ROUTING_CHECK_TARGETS, routingVerdict } from "./routing-scorers.js";

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function text(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 32_000;
}
function count(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function valueIsVerdict(value: unknown): value is EvalVerdict {
  return value === "pass" || value === "fail" || value === "unknown";
}
function checkId(value: unknown): value is RunEvalCheck {
  return typeof value === "string" && Object.hasOwn(CHECK_TARGETS, value);
}
function score(value: unknown): value is RunEvalScore {
  return (
    record(value) &&
    checkId(value.id) &&
    valueIsVerdict(value.value) &&
    value.expected === CHECK_TARGETS[value.id] &&
    text(value.observed) &&
    text(value.reason) &&
    (value.traceSequence === null || (count(value.traceSequence) && value.traceSequence > 0))
  );
}

function assessment(value: unknown): value is RunEvalAssessment {
  if (
    !record(value) ||
    value.suiteId !== RUN_INTEGRITY_SUITE ||
    value.source !== "stored-run-evidence" ||
    value.acceptance !== "not-assessed" ||
    !valueIsVerdict(value.verdict)
  )
    return false;
  const sample = value.sample;
  const run = value.run;
  const trace = value.trace;
  return (
    record(sample) &&
    text(sample.id) &&
    sample.target === RUN_INTEGRITY_SUITE &&
    record(sample.input) &&
    text(sample.input.runId) &&
    text(sample.input.messageId) &&
    record(run) &&
    text(run.id) &&
    text(run.conversationId) &&
    text(run.executionRef) &&
    typeof run.status === "string" &&
    [
      "queued",
      "running",
      "cancelling",
      "succeeded",
      "failed",
      "cancelled",
      "interrupted",
      "unknown",
    ].includes(run.status) &&
    record(trace) &&
    text(trace.runId) &&
    text(trace.traceRef) &&
    count(trace.byteOffset) &&
    count(trace.eventCount) &&
    Array.isArray(value.scores) &&
    value.scores.length === Object.keys(CHECK_TARGETS).length &&
    value.scores.every(score) &&
    new Set(value.scores.map((item) => item.id)).size === value.scores.length &&
    verdict(value.scores) === value.verdict
  );
}

export function evalView(stored: EvalResult): RunEvalView {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stored.observed);
  } catch {
    parsed = null;
  }
  const validated =
    stored.scorerVersion === RUN_INTEGRITY_SCORER_VERSION &&
    assessment(parsed) &&
    parsed.sample.id === stored.sampleId &&
    parsed.sample.input.runId === stored.runId &&
    parsed.run.id === stored.runId &&
    parsed.trace.runId === stored.runId &&
    parsed.trace.traceRef === stored.traceRef &&
    parsed.trace.eventCount === stored.traceEnd &&
    stored.traceStart === 0 &&
    (parsed.verdict === "pass") === stored.passed &&
    parsed.scores.every(
      (item) => item.traceSequence === null || item.traceSequence <= stored.traceEnd,
    )
      ? parsed
      : null;
  return {
    ...stored,
    inputTokens: stored.inputTokens ?? null,
    outputTokens: stored.outputTokens ?? null,
    durationMs: stored.durationMs ?? null,
    assessment: validated,
  };
}

function routingCheckId(value: unknown): value is RoutingEvalCheck {
  return typeof value === "string" && Object.hasOwn(ROUTING_CHECK_TARGETS, value);
}

function routingScore(value: unknown): value is RoutingEvalScore {
  return (
    record(value) &&
    routingCheckId(value.id) &&
    valueIsVerdict(value.value) &&
    value.expected === ROUTING_CHECK_TARGETS[value.id] &&
    text(value.observed) &&
    text(value.reason) &&
    (value.traceSequence === null || (count(value.traceSequence) && value.traceSequence > 0))
  );
}

function routingAssessment(value: unknown): value is RoutingEvalAssessment {
  if (
    !record(value) ||
    value.suiteId !== ROUTING_SAFETY_SUITE ||
    value.source !== "stored-run-evidence" ||
    value.acceptance !== "not-assessed" ||
    !valueIsVerdict(value.verdict)
  )
    return false;
  const sample = value.sample;
  const run = value.run;
  const trace = value.trace;
  return (
    record(sample) &&
    text(sample.id) &&
    sample.target === ROUTING_SAFETY_SUITE &&
    record(sample.input) &&
    text(sample.input.runId) &&
    record(run) &&
    text(run.id) &&
    text(run.conversationId) &&
    text(run.executionRef) &&
    typeof run.status === "string" &&
    [
      "queued",
      "running",
      "cancelling",
      "succeeded",
      "failed",
      "cancelled",
      "interrupted",
      "unknown",
    ].includes(run.status) &&
    record(trace) &&
    text(trace.runId) &&
    text(trace.traceRef) &&
    count(trace.byteOffset) &&
    count(trace.eventCount) &&
    Array.isArray(value.scores) &&
    value.scores.length === Object.keys(ROUTING_CHECK_TARGETS).length &&
    value.scores.every(routingScore) &&
    new Set(value.scores.map((item) => item.id)).size === value.scores.length &&
    routingVerdict(value.scores) === value.verdict
  );
}

export function routingEvalView(stored: EvalResult): RoutingEvalView {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stored.observed);
  } catch {
    parsed = null;
  }
  const validated =
    stored.scorerVersion === ROUTING_SAFETY_SCORER_VERSION &&
    routingAssessment(parsed) &&
    parsed.sample.id === stored.sampleId &&
    parsed.sample.input.runId === stored.runId &&
    parsed.run.id === stored.runId &&
    parsed.trace.runId === stored.runId &&
    parsed.trace.traceRef === stored.traceRef &&
    parsed.trace.eventCount === stored.traceEnd &&
    stored.traceStart === 0 &&
    (parsed.verdict === "pass") === stored.passed &&
    parsed.scores.every(
      (item) => item.traceSequence === null || item.traceSequence <= stored.traceEnd,
    )
      ? parsed
      : null;
  return {
    ...stored,
    inputTokens: stored.inputTokens ?? null,
    outputTokens: stored.outputTokens ?? null,
    durationMs: stored.durationMs ?? null,
    assessment: validated,
  };
}
