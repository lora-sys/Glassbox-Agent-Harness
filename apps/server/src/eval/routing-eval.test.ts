import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { afterEach, expect, it } from "vite-plus/test";
import {
  ROUTING_SAFETY_SCORER_VERSION,
  ROUTING_SAFETY_SUITE,
} from "../../../../packages/contracts/src/evals.js";
import { createRunEvaluator } from "./index.js";
import { evalOwner, openEvalFixture } from "./fixture.js";

const fixtures: Awaited<ReturnType<typeof openEvalFixture>>[] = [];
const directories: string[] = [];

async function fixture() {
  const dataDirectory = await mkdtemp(join(tmpdir(), "glassbox-routing-eval-"));
  directories.push(dataDirectory);
  const opened = await openEvalFixture(dataDirectory);
  fixtures.push(opened);
  return opened;
}

afterEach(async () => {
  for (const opened of fixtures.splice(0)) await opened.close();
  for (const directory of directories.splice(0)) {
    const target = resolve(directory);
    if (
      dirname(target) !== resolve(tmpdir()) ||
      !basename(target).startsWith("glassbox-routing-eval-")
    )
      throw new Error("Invalid disposable routing Eval path");
    await rm(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

function routingEvidence(overrides: Record<string, unknown> = {}) {
  return {
    type: "routing_eval_evidence",
    schema: "glassbox.routing-eval-evidence.v1",
    capabilityFloor: 2,
    selectedCapabilityRank: 2,
    unavailableModelEncountered: true,
    fallbackSelected: true,
    fallbackAvailable: true,
    decisionExecutionRef: "profile-safe",
    actualExecutionRef: "profile-safe",
    decisionProvider: "glassbox-safe",
    decisionModel: "safe-model",
    actualProvider: "glassbox-safe",
    actualModel: "safe-model",
    usage: {
      actualTokens: 14,
      estimatedTokens: 18,
      reportedTokens: 14,
      reportedSource: "actual",
    },
    quota: { sourceAvailable: false, availability: "unknown" },
    ...overrides,
  };
}

async function evaluateEvidence(event: Record<string, unknown>, provenance = "glassbox-run") {
  const current = await fixture();
  const runId = await current.run();
  await current.store.evidence.advanceTrace(
    evalOwner,
    await current.trace.append(runId, event, provenance),
  );
  return {
    current,
    result: await createRunEvaluator(current).evaluate(evalOwner, runId, ROUTING_SAFETY_SUITE),
  };
}

it("scores the five deterministic routing checks from safe indexed Trace evidence", async () => {
  const { current, result } = await evaluateEvidence(routingEvidence());

  expect(result).toMatchObject({ scorerVersion: ROUTING_SAFETY_SCORER_VERSION, passed: true });
  expect(result.assessment).toMatchObject({
    suiteId: ROUTING_SAFETY_SUITE,
    verdict: "pass",
    acceptance: "not-assessed",
  });
  expect(result.assessment?.scores.map((entry) => entry.id)).toEqual([
    "unsafe_downgrade",
    "unavailable_fallback",
    "decision_actual_model",
    "actual_estimated_usage",
    "unknown_quota_honesty",
  ]);
  expect(result.assessment?.scores.every((entry) => entry.value === "pass")).toBe(true);
  expect(
    (await createRunEvaluator(current).list(evalOwner, result.runId)).items[0]?.assessment,
  ).toMatchObject({
    suiteId: ROUTING_SAFETY_SUITE,
    verdict: "pass",
  });
  expect(result.observed).not.toContain("prompt");
});

it("detects a provider or model drift even when the execution reference matches", async () => {
  const { result } = await evaluateEvidence(routingEvidence({ actualModel: "other-model" }));
  expect(
    result.assessment?.scores.find((score) => score.id === "decision_actual_model")?.value,
  ).toBe("fail");
});

it("fails unsafe downgrade, unsafe unavailable fallback, execution drift, and substituted usage", async () => {
  const { result } = await evaluateEvidence(
    routingEvidence({
      selectedCapabilityRank: 1,
      fallbackAvailable: false,
      actualExecutionRef: "profile-other",
      usage: {
        actualTokens: 14,
        estimatedTokens: 18,
        reportedTokens: 18,
        reportedSource: "estimate",
      },
      quota: { sourceAvailable: false, availability: "unlimited" },
    }),
  );
  const scores = new Map(result.assessment?.scores.map((entry) => [entry.id, entry]));

  expect(scores.get("unsafe_downgrade")?.value).toBe("fail");
  expect(scores.get("unavailable_fallback")?.value).toBe("fail");
  expect(scores.get("decision_actual_model")?.value).toBe("fail");
  expect(scores.get("actual_estimated_usage")?.value).toBe("fail");
  expect(scores.get("unknown_quota_honesty")?.value).toBe("fail");
});

it("keeps absent or provider-forged routing evidence unknown", async () => {
  const current = await fixture();
  const runId = await current.run();
  await current.store.evidence.advanceTrace(
    evalOwner,
    await current.trace.append(
      runId,
      routingEvidence({ payload: "PRIVATE-PROMPT-CONTENT" }),
      "glassbox-model",
    ),
  );
  const result = await createRunEvaluator(current).evaluate(evalOwner, runId, ROUTING_SAFETY_SUITE);

  expect(result.assessment?.verdict).toBe("unknown");
  expect(result.assessment?.scores.every((entry) => entry.value === "unknown")).toBe(true);
  expect(result.observed).not.toContain("PRIVATE-PROMPT-CONTENT");
});

it("does not treat quota labels as known when the source is unavailable", async () => {
  const { result } = await evaluateEvidence(
    routingEvidence({ quota: { sourceAvailable: null, availability: "exhausted" } }),
  );
  expect(
    result.assessment?.scores.find((entry) => entry.id === "unknown_quota_honesty"),
  ).toMatchObject({
    value: "fail",
    reason: "unavailable_quota_misrepresented",
  });
});
