import test from "node:test";
import assert from "node:assert/strict";
import { runTasteLifecycle } from "../lib/taste-lifecycle.mjs";

const nonce = "1".repeat(32);
const candidateId = `candidate_${"2".repeat(32)}`;
const memoryId = `memory_${"3".repeat(32)}`;
const correctionCandidateId = `candidate_${"4".repeat(32)}`;

function fixture(overrides = {}) {
  const sent = [];
  const checkpoints = [];
  const runtime = {
    checkout: "/fixture",
    dataDirectory: "/disposable",
    commit: "a".repeat(40),
    pid: 123,
  };
  return {
    sent,
    checkpoints,
    options: {
      fixtureNonce: nonce,
      readRuntime: async () => ({ ...runtime }),
      checkpoint: async (snapshot) => {
        checkpoints.push(snapshot);
      },
      executeStep: async (stage, spec) => {
        sent.push(stage);
        const runId = `run-${stage}`;
        const input = { realSequence: "123", time: 42, textSha256: "b".repeat(64) };
        const evidence = {
          caseId: spec.id,
          runId,
          traceVerified: true,
          cleanupVerified: true,
          feature: { status: "PASS", runId },
          scope: { chatType: "private", chatId: "owner" },
          messageBinding: { input },
        };
        return {
          transportCase: {
            id: spec.id,
            route: "private",
            status: "PASS",
            leaseRevoked: true,
            inputBinding: input,
          },
          productAcceptance: { status: "PASS", runtime, cases: [evidence] },
        };
      },
      observeStep: async (stage, handles) => ({
        ...handles,
        principalKind: "owner",
        principalId: "owner",
        candidateId,
        creationRunId: "run-feedback",
        candidateStatus: "pending",
        ...(stage !== "feedback"
          ? { memoryId, promotionRunId: "run-promote", lifecycleState: "active" }
          : {}),
        ...(["negative-feedback", "retire"].includes(stage)
          ? {
              correctionCandidateId,
              negativeRunId: "run-negative-feedback",
              correctionStatus: "pending",
            }
          : {}),
        ...(stage === "retire"
          ? {
              cleanupRunId: "run-retire",
              lifecycleState: "retired",
              correctionStatus: "promoted",
              activeCount: 0,
              pendingCount: 0,
            }
          : {}),
      }),
      ...overrides,
    },
  };
}

test("Taste coordinator verifies each stage before proceeding and checkpoints retirement", async () => {
  const f = fixture();
  const result = await runTasteLifecycle(f.options);
  assert.equal(result.status, "PASS");
  assert.deepEqual(f.sent, ["feedback", "promote", "negative-feedback", "retire"]);
  assert.equal(result.requiresReconciliation, false);
  assert.equal(result.cleanup.status, "retired");
  assert.equal(f.checkpoints.length, 8);
  assert.equal(f.checkpoints.at(-1).handles.cleanupRunId, "run-retire");
});

test("unconfirmed Taste checkpoint prevents sending and leaves reconciliation required", async () => {
  const f = fixture({ checkpoint: async () => false });
  const result = await runTasteLifecycle(f.options);
  assert.equal(result.error.code, "TASTE_CHECKPOINT");
  assert.deepEqual(f.sent, []);
  assert.equal(result.requiresReconciliation, true);
});

test("unknown Taste send is never repeated and blocks later stages", async () => {
  let calls = 0;
  const f = fixture({
    executeStep: async () => {
      calls++;
      throw new Error("uncertain send");
    },
  });
  const result = await runTasteLifecycle(f.options);
  assert.equal(calls, 1);
  assert.equal(result.status, "INCONCLUSIVE");
  assert.equal(result.requiresReconciliation, true);
  assert.equal(result.steps.length, 0);
});

test("a claimed reply without independently verified lease cleanup cannot advance", async () => {
  const f = fixture();
  const execute = f.options.executeStep;
  f.options.executeStep = async (...args) => {
    const result = await execute(...args);
    result.productAcceptance.cases[0].cleanupVerified = false;
    return result;
  };
  const result = await runTasteLifecycle(f.options);
  assert.equal(result.error.code, "TASTE_STEP_EVIDENCE");
  assert.deepEqual(f.sent, ["feedback"]);
});

test("negative feedback must leave the original preference active until confirmed", async () => {
  const f = fixture();
  const observe = f.options.observeStep;
  f.options.observeStep = async (stage, handles) => {
    const result = await observe(stage, handles);
    if (stage === "negative-feedback") result.lifecycleState = "retired";
    return result;
  };
  const result = await runTasteLifecycle(f.options);
  assert.equal(result.error.code, "TASTE_NEGATIVE");
  assert.deepEqual(f.sent, ["feedback", "promote", "negative-feedback"]);
  assert.equal(result.requiresReconciliation, true);
});

test("retired preference with another active fixture does not prove cleanup", async () => {
  const f = fixture();
  const observe = f.options.observeStep;
  f.options.observeStep = async (stage, handles) => ({
    ...(await observe(stage, handles)),
    ...(stage === "retire" ? { activeCount: 1 } : {}),
  });
  const result = await runTasteLifecycle(f.options);
  assert.equal(result.error.code, "TASTE_RETIRE");
  assert.equal(result.requiresReconciliation, true);
});

test("a changed runtime stops before negative feedback and retains fixture handles", async () => {
  const f = fixture();
  const execute = f.options.executeStep;
  f.options.executeStep = async (stage, spec) => {
    const result = await execute(stage, spec);
    if (stage === "promote")
      result.productAcceptance.runtime = {
        ...result.productAcceptance.runtime,
        pid: 456,
      };
    return result;
  };
  const result = await runTasteLifecycle(f.options);
  assert.equal(result.error.code, "TASTE_RUNTIME_CHANGED");
  assert.deepEqual(f.sent, ["feedback", "promote"]);
  assert.equal(result.handles.candidateId, candidateId);
  assert.equal(result.requiresReconciliation, true);
});

test("another project's observation cannot select a candidate for promotion", async () => {
  const f = fixture();
  const observe = f.options.observeStep;
  f.options.observeStep = async (...args) => ({
    ...(await observe(...args)),
    projectId: "ordinary-project",
  });
  const result = await runTasteLifecycle(f.options);
  assert.equal(result.error.code, "TASTE_OBSERVATION");
  assert.deepEqual(f.sent, ["feedback"]);
  assert.equal(result.handles.candidateId, undefined);
});

test("runtime change during final independent observation cannot produce PASS", async () => {
  const f = fixture();
  const readRuntime = f.options.readRuntime;
  const observe = f.options.observeStep;
  let changed = false;
  f.options.readRuntime = async () => ({
    ...(await readRuntime()),
    ...(changed ? { pid: 999 } : {}),
  });
  f.options.observeStep = async (stage, handles) => {
    const result = await observe(stage, handles);
    if (stage === "retire") changed = true;
    return result;
  };
  const result = await runTasteLifecycle(f.options);
  assert.equal(result.error.code, "TASTE_RUNTIME_CHANGED");
  assert.equal(result.status, "INCONCLUSIVE");
  assert.equal(result.requiresReconciliation, true);
});
