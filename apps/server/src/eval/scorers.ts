// Sample target and independent Score values adapted from Inspect AI. See SOURCES.md.
import type { EvalVerdict, RunEvalCheck, RunEvalScore } from "@glassbox/contracts";
import type { RunRecord } from "../conversation/store.js";
import type { DeliveryRecord, DeliveryStatus } from "../conversation/lifecycle.js";
import type { TraceEntry } from "../trace/store.js";

export const RUN_INTEGRITY_SCORER_VERSION = "run-integrity-v1.1";

export const CHECK_TARGETS: Record<RunEvalCheck, string> = {
  run_terminal: "The stored Run has a known terminal outcome.",
  trace_index: "Every event in the indexed Trace prefix is readable in sequence.",
  terminal_event: "One trusted run_finished event agrees with the stored Run.",
  ack_delivery: "The ingress acknowledgement has a confirmed delivery to the caller scope.",
  result_delivery: "The result has a confirmed delivery to the caller scope.",
  result_delivery_event: "Trusted Trace evidence agrees with the result delivery outcome.",
};

const knownTerminal = new Set(["succeeded", "failed", "cancelled", "interrupted"]);
const deliveryStatuses: readonly string[] = ["pending", "sending", "sent", "failed", "unknown"];

export interface TraceObservation {
  scanned: number;
  value: EvalVerdict;
  reason: string;
  finishedCount: number;
  finished: { status: string; sequence: number } | null;
  invalidLifecycle: boolean;
  resultDelivery: { status: DeliveryStatus; sequence: number } | null;
}

export function emptyTraceObservation(): TraceObservation {
  return {
    scanned: 0,
    value: "unknown",
    reason: "trace_not_scanned",
    finishedCount: 0,
    finished: null,
    invalidLifecycle: false,
    resultDelivery: null,
  };
}

function isDeliveryStatus(value: unknown): value is DeliveryStatus {
  return typeof value === "string" && deliveryStatuses.includes(value);
}

/** Provider output may contain arbitrary event-like objects. Only server lifecycle
 * provenance participates in these checks; no event payload is copied into an Eval. */
export function observeLifecycle(
  observation: TraceObservation,
  entry: TraceEntry,
  run: RunRecord,
  resultDeliveryId: string | undefined,
): void {
  if (entry.provenance !== "glassbox-run") return;
  const event = entry.event;
  if (!event || typeof event !== "object" || !("type" in event)) return;
  if (event.type !== "run_finished" && event.type !== "delivery_changed") return;
  if (!("runId" in event) || event.runId !== run.id) {
    observation.invalidLifecycle = true;
    return;
  }
  if (event.type === "run_finished") {
    observation.finishedCount++;
    if (
      !("conversationId" in event) ||
      event.conversationId !== run.conversationId ||
      !("status" in event) ||
      typeof event.status !== "string" ||
      (!knownTerminal.has(event.status) && event.status !== "unknown") ||
      !("outputWithheld" in event) ||
      typeof event.outputWithheld !== "boolean"
    ) {
      observation.invalidLifecycle = true;
      return;
    }
    observation.finished = { status: event.status, sequence: entry.seq };
  } else if ("deliveryId" in event && event.deliveryId === resultDeliveryId) {
    if (!("status" in event) || !isDeliveryStatus(event.status)) {
      observation.invalidLifecycle = true;
      return;
    }
    observation.resultDelivery = { status: event.status, sequence: entry.seq };
  }
}

function score(
  id: RunEvalCheck,
  value: EvalVerdict,
  observed: string,
  reason: string,
  traceSequence: number | null = null,
): RunEvalScore {
  return { id, value, expected: CHECK_TARGETS[id], observed, reason, traceSequence };
}

function deliveryScore(
  id: "ack_delivery" | "result_delivery",
  delivery: DeliveryRecord | null,
  expectedScope: string,
): RunEvalScore {
  if (!delivery) return score(id, "unknown", "missing", "delivery_not_recorded");
  if (delivery.destinationScopeKey !== expectedScope)
    return score(id, "fail", delivery.status, "delivery_scope_mismatch");
  if (delivery.status === "sent") return score(id, "pass", "sent", "delivery_confirmed");
  if (delivery.status === "failed") return score(id, "fail", "failed", "delivery_failed");
  return score(id, "unknown", delivery.status, "delivery_not_confirmed");
}

export function scoreRun(input: {
  run: RunRecord;
  trace: TraceObservation;
  indexedEvents: number;
  ack: DeliveryRecord | null;
  result: DeliveryRecord | null;
  expectedScope: string;
}): RunEvalScore[] {
  const { run, trace, result } = input;
  const runKnown = knownTerminal.has(run.status);
  const scores = [
    score(
      "run_terminal",
      runKnown ? "pass" : "unknown",
      run.status,
      runKnown ? "terminal_outcome_recorded" : "run_outcome_not_known",
    ),
    score(
      "trace_index",
      trace.value,
      `${trace.scanned}/${input.indexedEvents} indexed events read`,
      trace.reason,
    ),
  ];
  if (trace.invalidLifecycle || trace.finishedCount > 1) {
    scores.push(
      score(
        "terminal_event",
        "fail",
        `${trace.finishedCount} terminal events`,
        trace.invalidLifecycle ? "invalid_lifecycle_evidence" : "duplicate_terminal_events",
      ),
    );
  } else if (!trace.finished) {
    scores.push(score("terminal_event", "unknown", "missing", "terminal_event_not_observed"));
  } else {
    const matches = trace.finished.status === run.status;
    // A queued/running snapshot may precede the indexed completion event. Only
    // immutable terminal states can establish a contradiction across these reads.
    const contradictsTerminal = !matches && (runKnown || run.status === "unknown");
    scores.push(
      score(
        "terminal_event",
        contradictsTerminal
          ? "fail"
          : matches && trace.value === "pass" && runKnown
            ? "pass"
            : "unknown",
        trace.finished.status,
        contradictsTerminal
          ? "terminal_state_mismatch"
          : matches
            ? "terminal_event_observed"
            : "run_snapshot_incomplete",
        trace.finished.sequence,
      ),
    );
  }
  scores.push(deliveryScore("ack_delivery", input.ack, input.expectedScope));
  scores.push(deliveryScore("result_delivery", result, input.expectedScope));
  const deliveryEvent = trace.resultDelivery;
  if (!deliveryEvent || !result) {
    scores.push(
      score("result_delivery_event", "unknown", "missing", "delivery_event_not_observed"),
    );
  } else {
    const matches = deliveryEvent.status === result.status;
    const contradictory = !matches && ["sent", "unknown"].includes(deliveryEvent.status);
    const confirmed = result.status === "sent" || result.status === "failed";
    scores.push(
      score(
        "result_delivery_event",
        contradictory
          ? "fail"
          : matches && confirmed && trace.value === "pass"
            ? "pass"
            : "unknown",
        `${deliveryEvent.status} trace / ${result.status} stored`,
        contradictory
          ? "delivery_state_mismatch"
          : matches
            ? "delivery_event_observed"
            : "delivery_snapshot_incomplete",
        deliveryEvent.sequence,
      ),
    );
  }
  return scores;
}

export function verdict(scores: readonly RunEvalScore[]): EvalVerdict {
  if (scores.some((entry) => entry.value === "fail")) return "fail";
  return scores.every((entry) => entry.value === "pass") ? "pass" : "unknown";
}
