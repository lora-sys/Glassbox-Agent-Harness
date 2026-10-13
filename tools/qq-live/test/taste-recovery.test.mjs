import test from "node:test";
import assert from "node:assert/strict";
import { tasteRecoveryPlan, reconcileTasteFixture } from "../lib/taste-recovery.mjs";
import { TASTE_FAMILY_ID } from "../lib/taste-scenario.mjs";

const runtime = {
  checkout: "/checkout",
  dataDirectory: "/data",
  commit: "a".repeat(40),
  pid: 44,
  connectionId: "connection",
};
const handles = {
  fixtureNonce: "1".repeat(32),
  projectId: `qqtest-${"1".repeat(32)}`,
  principalId: "owner-1",
  candidateId: `candidate_${"2".repeat(32)}`,
  memoryId: `memory_${"3".repeat(32)}`,
  correctionCandidateId: `candidate_${"4".repeat(32)}`,
  creationRunId: "run-1",
  promotionRunId: "run-2",
  negativeRunId: "run-3",
};

function record(stage = "negative-feedback", phase = "observed") {
  const row = {
    familyId: TASTE_FAMILY_ID,
    phase,
    stage,
    handles,
    checkpointSha256: "b".repeat(64),
  };
  return { pending: row, rows: [row] };
}

function observation(stage = "negative-feedback") {
  return { status: "NEEDS_CLEANUP", stage, handles };
}

test("Taste recovery plan only permits the fixed cleanup for an observed stage", () => {
  const planned = tasteRecoveryPlan(record(), observation(), runtime);
  assert.deepEqual(planned.plan.actions, ["reject-correction", "expire-original"]);
  assert.match(planned.sha256, /^[a-f0-9]{64}$/);
  assert.equal(
    tasteRecoveryPlan(record("feedback", "sent"), observation("feedback"), runtime),
    null,
  );
  assert.equal(tasteRecoveryPlan(record(), { ...observation(), stage: "promote" }, runtime), null);
  const correctionRejected = record("negative-feedback", "recovery_observed");
  correctionRejected.pending.recoveryAttempt = {
    action: "reject-correction",
    planSha256: "c".repeat(64),
    cleanupRunId: "cleanup-reject",
  };
  assert.deepEqual(tasteRecoveryPlan(correctionRejected, observation(), runtime).plan.actions, [
    "expire-original",
  ]);
  const uncertain = record("negative-feedback", "recovery_prepared");
  uncertain.pending.recoveryAttempt = correctionRejected.pending.recoveryAttempt;
  assert.equal(tasteRecoveryPlan(uncertain, observation(), runtime), null);
});

test("Taste recovery checkpoints and independently verifies each cleanup before final release", async () => {
  const source = record();
  const plan = tasteRecoveryPlan(source, observation(), runtime);
  const sent = [];
  const checkpointed = [];
  const result = await reconcileTasteFixture({
    record: source,
    observation: observation(),
    runtime,
    approvedPlanSha256: plan.sha256,
    verifyStopped: async () => ({ stopped: true }),
    revokeMarker: async () => ({ active: false }),
    checkpoint: async (state) => {
      checkpointed.push(state.phase);
      return { confirmed: true };
    },
    executeCleanup: async (action, spec) => {
      sent.push([action, spec.leaseTools[0].operations[0].action]);
      return { action };
    },
    verifyCleanup: async (action, _execution, current) =>
      action === "final"
        ? { status: "CLEANED", activeCount: 0, pendingCount: 0 }
        : { status: "PASS", runId: `cleanup-${action}`, current: current.principalId },
    readRuntime: async () => runtime,
  });
  assert.equal(result.status, "CLEANED", JSON.stringify(result));
  assert.deepEqual(sent, [
    ["reject-correction", "memory:govern"],
    ["expire-original", "memory:govern"],
  ]);
  assert.deepEqual(checkpointed, [
    "recovery_prepared",
    "recovery_observed",
    "recovery_prepared",
    "recovery_observed",
  ]);
});

test("Taste recovery never sends when plan approval or stopped-process proof is missing", async () => {
  const source = record("promote");
  const observed = observation("promote");
  const plan = tasteRecoveryPlan(source, observed, runtime);
  let calls = 0;
  const common = {
    record: source,
    observation: observed,
    runtime,
    verifyStopped: async () => ({ stopped: true }),
    revokeMarker: async () => ({ active: false }),
    checkpoint: async () => ({ confirmed: true }),
    executeCleanup: async () => {
      calls += 1;
      return {};
    },
    verifyCleanup: async () => ({ status: "PASS", runId: "cleanup-1" }),
    readRuntime: async () => runtime,
  };
  assert.equal(
    (await reconcileTasteFixture(common)).error.code,
    "TASTE_RECOVERY_APPROVAL_REQUIRED",
  );
  const running = await reconcileTasteFixture({
    ...common,
    approvedPlanSha256: plan.sha256,
    verifyStopped: async () => ({ stopped: false }),
  });
  assert.equal(running.error.code, "TASTE_RECOVERY_PROCESS_RUNNING");
  assert.equal(calls, 0);
});
