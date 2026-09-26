import { randomUUID } from "node:crypto";
import { RUN_INTEGRITY_SUITE, type RunEvalAssessment } from "@glassbox/contracts";
import {
  ROUTING_SAFETY_SCORER_VERSION,
  ROUTING_SAFETY_SUITE,
  type EvalPage,
  type EvalView,
  type RoutingEvalAssessment,
  type RoutingEvalView,
} from "../../../../packages/contracts/src/evals.js";
import type { PageOptions, RunRecord } from "../conversation/store.js";
import type { CallerContext } from "../identity/scope.js";
import { scopeKey } from "../identity/scope.js";
import type { DomainStore } from "../persistence/index.js";
import type { TraceCursor } from "../persistence/evidence.js";
import {
  RunTraceStore,
  TraceCorruptedError,
  TraceCursorError,
  TraceTruncatedError,
} from "../trace/run-store.js";
import {
  CHECK_TARGETS,
  RUN_INTEGRITY_SCORER_VERSION,
  emptyTraceObservation,
  observeLifecycle,
  scoreRun,
  verdict,
} from "./scorers.js";
import { evalView } from "./view.js";
import {
  emptyRoutingTraceObservation,
  observeRoutingEvidence,
  routingVerdict,
  scoreRoutingEvidence,
} from "./routing-scorers.js";
import { routingEvalView } from "./view.js";

export { RUN_INTEGRITY_SCORER_VERSION } from "./scorers.js";
export {
  ROUTING_SAFETY_SCORER_VERSION,
  ROUTING_SAFETY_SUITE,
} from "../../../../packages/contracts/src/evals.js";
const MAX_TRACE_EVENTS = 10_000;
const MAX_TRACE_PAGES = 100;

export class RunEvalError extends Error {
  constructor(public readonly code: "EVAL_SUITE_NOT_FOUND" | "EVAL_TRACE_NOT_INDEXED") {
    super(
      code === "EVAL_SUITE_NOT_FOUND"
        ? "The Eval suite does not exist"
        : "The Run has no indexed Trace evidence",
    );
    this.name = "RunEvalError";
  }
}

export function createRunEvaluator(options: {
  store: DomainStore;
  trace: Pick<RunTraceStore, "readPage">;
}) {
  const { store, trace } = options;

  async function inspect(
    caller: CallerContext,
    run: RunRecord,
    indexed: TraceCursor,
    resultDeliveryId: string | undefined,
    onEntry?: (entry: import("../trace/store.js").TraceEntry) => void,
  ) {
    const observation = emptyTraceObservation();
    if (indexed.traceRef !== run.id) {
      observation.value = "fail";
      observation.reason = "trace_reference_mismatch";
      return observation;
    }
    if (indexed.eventCount === 0) {
      observation.reason = "trace_empty";
      return observation;
    }
    let cursor: string | undefined;
    let pages = 0;
    while (
      observation.scanned < Math.min(indexed.eventCount, MAX_TRACE_EVENTS) &&
      pages < MAX_TRACE_PAGES
    ) {
      await store.evidence.assertEvalAccess(caller, run.id);
      let page;
      try {
        page = await trace.readPage(run.id, {
          ...(cursor ? { cursor } : {}),
          limit: Math.min(
            100,
            indexed.eventCount - observation.scanned,
            MAX_TRACE_EVENTS - observation.scanned,
          ),
          // A later unindexed partial tail is outside this immutable observation.
          allowPartialPrefix: true,
        });
      } catch (error) {
        observation.value =
          error instanceof TraceCorruptedError ||
          error instanceof TraceCursorError ||
          error instanceof TraceTruncatedError
            ? "fail"
            : "unknown";
        observation.reason = observation.value === "fail" ? "trace_invalid" : "trace_unavailable";
        return observation;
      }
      pages++;
      for (const entry of page.records) {
        observation.scanned++;
        observeLifecycle(observation, entry, run, resultDeliveryId);
        onEntry?.(entry);
      }
      if (observation.scanned === indexed.eventCount) {
        observation.value = "pass";
        observation.reason = "indexed_prefix_read";
        return observation;
      }
      if (!page.nextCursor || page.records.length === 0) {
        observation.value = "fail";
        observation.reason = "indexed_events_missing";
        return observation;
      }
      cursor = page.nextCursor;
    }
    observation.reason = "trace_scan_limit";
    return observation;
  }

  return {
    async evaluate(
      caller: CallerContext,
      runId: string,
      suiteId: string = RUN_INTEGRITY_SUITE,
    ): Promise<EvalView> {
      if (suiteId === ROUTING_SAFETY_SUITE) return evaluateRouting(caller, runId);
      if (suiteId !== RUN_INTEGRITY_SUITE) throw new RunEvalError("EVAL_SUITE_NOT_FOUND");
      const observer = structuredClone(caller);
      await store.evidence.assertEvalAccess(observer, runId);
      const run = await store.conversations.getRun(observer, runId);
      const indexed = await store.evidence.getTrace(observer, runId);
      if (!indexed) throw new RunEvalError("EVAL_TRACE_NOT_INDEXED");
      const result = await store.lifecycle.findDelivery(observer, runId, "result");
      const observation = await inspect(observer, run, indexed, result?.id);
      const scores = scoreRun({
        run,
        trace: observation,
        indexedEvents: indexed.eventCount,
        result,
        expectedScope: scopeKey(observer.scope),
      });
      const sampleId = randomUUID();
      const assessment: RunEvalAssessment = {
        suiteId: RUN_INTEGRITY_SUITE,
        source: "stored-run-evidence",
        acceptance: "not-assessed",
        verdict: verdict(scores),
        sample: {
          id: sampleId,
          input: { runId, messageId: run.messageId },
          target: RUN_INTEGRITY_SUITE,
        },
        run: {
          id: run.id,
          conversationId: run.conversationId,
          executionRef: run.executionRef,
          status: run.status,
        },
        trace: indexed,
        scores,
      };
      // The immutable observation contains addressing metadata and scalar checks,
      // never copied prompts, result bodies, provider payloads or private context.
      await store.evidence.assertEvalAccess(observer, runId);
      const id = await store.evidence.recordEval(observer, {
        runId,
        sampleId,
        scorerVersion: RUN_INTEGRITY_SCORER_VERSION,
        traceRef: indexed.traceRef,
        traceStart: 0,
        traceEnd: indexed.eventCount,
        expected: JSON.stringify({ suiteId: RUN_INTEGRITY_SUITE, targets: CHECK_TARGETS }),
        observed: JSON.stringify(assessment),
        passed: assessment.verdict === "pass",
        inputTokens: null,
        outputTokens: null,
        durationMs: null,
      });
      const stored = await store.evidence.getEval(observer, runId, id);
      if (!stored) throw new Error("The recorded Eval could not be read");
      await store.evidence.assertEvalAccess(observer, runId);
      return evalView(stored);
    },
    async list(caller: CallerContext, runId: string, page: PageOptions = {}): Promise<EvalPage> {
      const observer = structuredClone(caller);
      const records = await store.evidence.listEvals(observer, runId, page);
      return {
        items: records.items.map((record) =>
          record.scorerVersion === ROUTING_SAFETY_SCORER_VERSION
            ? routingEvalView(record)
            : evalView(record),
        ),
        nextCursor: records.nextCursor,
      };
    },
  };

  async function evaluateRouting(caller: CallerContext, runId: string): Promise<RoutingEvalView> {
    const observer = structuredClone(caller);
    await store.evidence.assertEvalAccess(observer, runId);
    const run = await store.conversations.getRun(observer, runId);
    const indexed = await store.evidence.getTrace(observer, runId);
    if (!indexed) throw new RunEvalError("EVAL_TRACE_NOT_INDEXED");
    const observation = emptyRoutingTraceObservation();
    const traceObservation = await inspect(observer, run, indexed, undefined, (entry) =>
      observeRoutingEvidence(observation, entry),
    );
    const scores = scoreRoutingEvidence({
      observation,
      traceValue: traceObservation.value,
      traceReason: traceObservation.reason,
    });
    const sampleId = randomUUID();
    const assessment: RoutingEvalAssessment = {
      suiteId: ROUTING_SAFETY_SUITE,
      source: "stored-run-evidence",
      acceptance: "not-assessed",
      verdict: routingVerdict(scores),
      sample: { id: sampleId, input: { runId }, target: ROUTING_SAFETY_SUITE },
      run: {
        id: run.id,
        conversationId: run.conversationId,
        executionRef: run.executionRef,
        status: run.status,
      },
      trace: indexed,
      scores,
    };
    await store.evidence.assertEvalAccess(observer, runId);
    const id = await store.evidence.recordEval(observer, {
      runId,
      sampleId,
      scorerVersion: ROUTING_SAFETY_SCORER_VERSION,
      traceRef: indexed.traceRef,
      traceStart: 0,
      traceEnd: indexed.eventCount,
      expected: JSON.stringify({ suiteId: ROUTING_SAFETY_SUITE }),
      observed: JSON.stringify(assessment),
      passed: assessment.verdict === "pass",
      inputTokens: null,
      outputTokens: null,
      durationMs: null,
    });
    const stored = await store.evidence.getEval(observer, runId, id);
    if (!stored) throw new Error("The recorded routing Eval could not be read");
    await store.evidence.assertEvalAccess(observer, runId);
    return routingEvalView(stored);
  }
}
