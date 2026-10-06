import test from "node:test";
import assert from "node:assert/strict";
import { digest } from "../lib/core.mjs";
import { memoryRecoveryPlan, reconcileMemoryFixture } from "../lib/memory-recovery.mjs";

const fixtureNonce = "a".repeat(32);
const projectId = `qqtest-${fixtureNonce}`;
const principalId = "owner-fixture";
const candidateId = `candidate_${"b".repeat(32)}`;
const memoryId = `memory_${"c".repeat(32)}`;
const creationRunId = "creation-run-1";
const promoteRunId = "promote-run-2";
const cleanupRunId = "cleanup-run-3";
const runtime = {
  checkout: "/srv/glassbox",
  dataDirectory: "/srv/glassbox-data",
  commit: "d".repeat(40),
  pid: 456,
  connectionId: "connection-fixture",
  threadId: null,
};
const scope = {
  connectionId: runtime.connectionId,
  botId: "10002",
  chatType: "private",
  chatId: "10001",
  senderId: "10001",
  threadId: null,
};
const handlesFor = (stage) => ({
  fixtureNonce,
  projectId,
  principalId,
  creationRunId,
  candidateId,
  ...(stage === "expire" ? { promoteRunId, memoryId } : {}),
});

function recordFor(stage = "expire") {
  const markerA = "1".repeat(32);
  const markerB = "2".repeat(32);
  const feedbackLease = {
    caseId: "memory-feedback",
    marker: markerA,
  };
  const rows = [
    {
      stage: "feedback",
      phase: "prepared",
      checkpointSha256: "a".repeat(64),
      preparedCase: feedbackLease,
      handles: { fixtureNonce, projectId, stepRunId: creationRunId },
    },
    {
      stage: "feedback",
      phase: "sent",
      checkpointSha256: "b".repeat(64),
      preparedCase: feedbackLease,
      handles: { fixtureNonce, projectId, stepRunId: creationRunId },
    },
    {
      stage: "feedback",
      phase: "observed",
      checkpointSha256: "c".repeat(64),
      handles: {
        fixtureNonce,
        projectId,
        stepRunId: creationRunId,
        principalId,
        creationRunId,
        candidateId,
      },
      recoveryAttempt: {
        preparedCase: { caseId: "memory-recovery", marker: "3".repeat(32) },
      },
    },
  ];
  if (stage === "expire")
    rows.push({
      stage: "promote",
      phase: "observed",
      checkpointSha256: "e".repeat(64),
      preparedCase: { caseId: "memory-promote", marker: markerB },
      handles: {
        fixtureNonce,
        projectId,
        stepRunId: promoteRunId,
        principalId,
        creationRunId,
        candidateId,
        promoteRunId,
        memoryId,
      },
    });
  const last = rows.at(-1);
  return {
    origin: {
      runtime,
      process: { pid: 123, bootId: "01234567-1234-1234-1234-0123456789ab", startTicks: "99" },
      scope,
      driverSha256: digest(scope.chatId),
      suiteSha256: "f".repeat(64),
      startedAt: "2026-10-05T00:00:00.000Z",
    },
    rows,
    pending: { ...last, checkpointSha256: last.checkpointSha256 },
  };
}

function observation(stage = "expire", overrides = {}) {
  return {
    status: "NEEDS_CLEANUP",
    cleanupStage: stage,
    handles: handlesFor(stage),
    ...overrides,
  };
}

function successfulExecution(stage, spec, record, overrides = {}) {
  const token = "4".repeat(32);
  const prompt = `GLASSBOX_ACCEPTANCE_V1 ${token}\n${spec.prompt.replaceAll("{{nonce}}", token).trim()}`;
  const binding = {
    driverMessageId: "90001",
    botMessageId: "90002",
    realSequence: "501",
    time: 1791158400000,
    driverTime: 1791158400000,
    textSha256: digest(prompt),
  };
  const evidence = {
    caseId: spec.id,
    runId: cleanupRunId,
    traceVerified: true,
    feature: { status: "PASS", runId: cleanupRunId },
    scope: structuredClone(record.origin.scope),
    delivery: { status: "sent", id: "delivery-1" },
    messageBinding: {
      input: {
        realSequence: binding.realSequence,
        time: binding.time,
        driverTime: binding.driverTime,
        textSha256: binding.textSha256,
      },
      reply: {
        botMessageId: "90003",
        driverMessageId: "90004",
        realSequence: "502",
        time: binding.time + 1000,
        driverTime: binding.time + 1000,
        textSha256: "9".repeat(64),
      },
    },
  };
  return {
    successfulRun: cleanupRunId,
    transportCase: {
      id: spec.id,
      token,
      prompt,
      status: "PASS",
      route: "private",
      leaseRevoked: true,
      sentMessageId: binding.driverMessageId,
      inputBinding: binding,
    },
    productAcceptance: {
      status: "PASS",
      runtime: structuredClone(record.origin.runtime),
      cases: [evidence],
    },
    ...overrides,
  };
}

function expectedCleanup(stage, handles) {
  return {
    status: stage === "reject" ? "rejected" : "expired",
    principalKind: "owner",
    candidateId: handles.candidateId,
    principalId: handles.principalId,
    projectId: handles.projectId,
    creationRunId: handles.creationRunId,
    ...(stage === "expire"
      ? { memoryId: handles.memoryId, promoteRunId: handles.promoteRunId }
      : {}),
    cleanupRunId,
  };
}

function harness(stage = "expire", overrides = {}) {
  const record = overrides.record ?? recordFor(stage);
  const observed = overrides.observation ?? observation(stage);
  const calls = [];
  const callbacks = {
    verifyStopped: async () => {
      calls.push("stopped");
      return { stopped: true };
    },
    revokeMarker: async (marker) => {
      calls.push(["revoke", marker]);
      return { active: false };
    },
    observe: async () => {
      calls.push("observe");
      return observed;
    },
    executeCleanup: async (cleanupStage, spec, handles) => {
      calls.push(["execute", cleanupStage, spec.id, handles.recoveryPlanSha256]);
      return successfulExecution(cleanupStage, spec, record);
    },
    verifyCleanup: async (handles) => {
      calls.push(["verifyCleanup", handles.cleanupRunId]);
      return expectedCleanup(stage, handles);
    },
    checkpoint: async (value) => {
      calls.push(["checkpoint", value.phase]);
      return { published: true };
    },
  };
  Object.assign(callbacks, overrides.callbacks);
  let plan = null;
  if (observed.status === "NEEDS_CLEANUP") {
    try {
      plan = memoryRecoveryPlan(record, observed, runtime);
    } catch {
      plan = null;
    }
  }
  return {
    record,
    observed,
    calls,
    args: {
      record,
      ...callbacks,
      runtime,
      approvedPlanSha256: overrides.approvedPlanSha256 ?? plan?.sha256,
      ...overrides.args,
    },
    plan,
  };
}

test("recovery plan binds both checkpoints, current Runtime, observed handles and cleanup stage", () => {
  const record = recordFor();
  const observed = observation();
  const plan = memoryRecoveryPlan(record, observed, runtime);
  assert.deepEqual(plan.plan, {
    schemaVersion: 1,
    pendingCheckpointSha256: record.pending.checkpointSha256,
    latestJournalSha256: record.rows.at(-1).checkpointSha256,
    runtime,
    cleanupStage: "expire",
    handles: observed.handles,
  });
  assert.equal(plan.sha256, digest(JSON.stringify(plan.plan)));
  assert.notEqual(
    memoryRecoveryPlan(recordFor("reject"), observation("reject"), runtime).sha256,
    plan.sha256,
  );
  const restartedRuntime = { ...runtime, pid: runtime.pid + 1 };
  assert.equal(
    memoryRecoveryPlan(record, observed, restartedRuntime).plan.runtime.pid,
    restartedRuntime.pid,
  );
  assert.throws(() => memoryRecoveryPlan(record, observed, { ...runtime, commit: "e".repeat(40) }));
});

test("source process must be confirmed stopped before marker revocation or observation", async () => {
  for (const [verifyStopped, expectedStatus] of [
    [async () => ({ stopped: false }), "BLOCKED"],
    [
      async () => {
        throw Error();
      },
      "INCONCLUSIVE",
    ],
  ]) {
    const h = harness("expire", { callbacks: { verifyStopped } });
    const result = await reconcileMemoryFixture(h.args);
    assert.equal(result.status, expectedStatus);
    assert.equal(
      h.calls.some((call) => Array.isArray(call) && call[0] === "revoke"),
      false,
    );
    assert.equal(h.calls.includes("observe"), false);
  }
});

test("source and recovery markers are deduplicated and every revocation receipt must be inactive", async () => {
  const h = harness();
  const result = await reconcileMemoryFixture(h.args);
  assert.equal(result.status, "CLEANED");
  assert.deepEqual(
    h.calls.filter((call) => Array.isArray(call) && call[0] === "revoke").map((call) => call[1]),
    ["1".repeat(32), "3".repeat(32), "2".repeat(32)],
  );

  for (const revokeMarker of [
    async () => ({ active: true }),
    async () => {
      throw Error();
    },
  ]) {
    const failed = harness("expire", { callbacks: { revokeMarker } });
    const blocked = await reconcileMemoryFixture(failed.args);
    assert.equal(blocked.status, "INCONCLUSIVE");
    assert.equal(failed.calls.includes("observe"), false);
    assert.equal(
      failed.calls.some((call) => Array.isArray(call) && call[0] === "execute"),
      false,
    );
  }
});

test("recovery markers nested in journal rows are revoked and observer handles inherit source nonce", async () => {
  const h = harness("expire", {
    observation: observation("expire", {
      handles: Object.fromEntries(
        Object.entries(handlesFor("expire")).filter(([key]) => key !== "fixtureNonce"),
      ),
    }),
  });
  const result = await reconcileMemoryFixture(h.args);
  assert.equal(result.status, "CLEANED");
  assert.deepEqual(
    h.calls.filter((call) => Array.isArray(call) && call[0] === "revoke").map((call) => call[1]),
    ["1".repeat(32), "3".repeat(32), "2".repeat(32)],
  );
  const execution = h.calls.find((call) => Array.isArray(call) && call[0] === "execute");
  assert.equal(execution?.[1], "expire");
});

test("already-cleaned observation is cleanup-only and inconclusive observation stops", async () => {
  const cleaned = harness("expire", {
    observation: {
      status: "CLEANED",
      cleanupStage: "expire",
      handles: {
        ...Object.fromEntries(
          Object.entries(handlesFor("expire")).filter(([key]) => key !== "fixtureNonce"),
        ),
        cleanupRunId,
      },
    },
  });
  const cleanedResult = await reconcileMemoryFixture(cleaned.args);
  assert.deepEqual(cleanedResult, {
    status: "CLEANED",
    cleanupOnly: true,
    requiresReconciliation: false,
    handles: { ...handlesFor("expire"), cleanupRunId },
    cleanupRunId,
  });
  assert.equal(
    cleaned.calls.some((call) => Array.isArray(call) && call[0] === "execute"),
    false,
  );

  const unknown = harness("expire", {
    observation: { status: "INCONCLUSIVE", handles: handlesFor("expire"), cleanupStage: "expire" },
  });
  const unknownResult = await reconcileMemoryFixture(unknown.args);
  assert.equal(unknownResult.status, "INCONCLUSIVE");
  assert.equal(
    unknown.calls.some((call) => Array.isArray(call) && call[0] === "execute"),
    false,
  );
});

test("plan mismatch exposes exact approval plan without checkpoint or cleanup effect", async () => {
  const h = harness("expire", { approvedPlanSha256: "0".repeat(64) });
  const result = await reconcileMemoryFixture(h.args);
  assert.equal(result.status, "BLOCKED");
  assert.equal(result.error.code, "MEMORY_RECOVERY_APPROVAL_REQUIRED");
  assert.deepEqual(result.plan, h.plan.plan);
  assert.equal(result.planSha256, h.plan.sha256);
  assert.equal(
    h.calls.some((call) => Array.isArray(call) && call[0] === "checkpoint"),
    false,
  );
  assert.equal(
    h.calls.some((call) => Array.isArray(call) && call[0] === "execute"),
    false,
  );
});

test("reject and expire execute one fixed cleanup stage and never replay feedback or promote", async () => {
  for (const stage of ["reject", "expire"]) {
    const h = harness(stage);
    const result = await reconcileMemoryFixture(h.args);
    assert.equal(result.status, "CLEANED");
    assert.equal(result.cleanupOnly, true);
    assert.equal(result.requiresReconciliation, false);
    assert.equal(result.cleanupRunId, cleanupRunId);
    assert.deepEqual(
      h.calls.filter((call) => Array.isArray(call) && call[0] === "execute").map((call) => call[1]),
      [stage],
    );
    assert.deepEqual(
      h.calls
        .filter((call) => Array.isArray(call) && call[0] === "checkpoint")
        .map((call) => call[1]),
      ["recovery_prepared", "recovery_cleaned"],
    );
    const checkpoint = h.calls.find((call) => Array.isArray(call) && call[0] === "checkpoint");
    assert.ok(checkpoint);
  }
});

test("unknown cleanup stages or source-mismatched handles never reach effects", async () => {
  const invalidStage = harness("expire", {
    observation: observation("feedback", { cleanupStage: "promote" }),
  });
  const stageResult = await reconcileMemoryFixture(invalidStage.args);
  assert.equal(stageResult.status, "INCONCLUSIVE");
  assert.equal(
    invalidStage.calls.some((call) => Array.isArray(call) && call[0] === "execute"),
    false,
  );

  const wrongHandle = harness("expire", {
    observation: observation("expire", {
      handles: { ...handlesFor("expire"), candidateId: `candidate_${"9".repeat(32)}` },
    }),
  });
  const handleResult = await reconcileMemoryFixture(wrongHandle.args);
  assert.equal(handleResult.status, "INCONCLUSIVE");
  assert.equal(
    wrongHandle.calls.some((call) => Array.isArray(call) && call[0] === "execute"),
    false,
  );
});

test("an interrupted promote without promoted handles can still reject the pending candidate", async () => {
  const record = recordFor("reject");
  const promoteAttempt = {
    stage: "promote",
    phase: "prepared",
    checkpointSha256: "e".repeat(64),
    preparedCase: { caseId: "memory-promote", marker: "5".repeat(32) },
    handles: {
      fixtureNonce,
      projectId,
      principalId,
      candidateId,
      creationRunId,
    },
  };
  record.rows.push(promoteAttempt);
  record.pending = { ...promoteAttempt };
  const h = harness("reject", { record, observation: observation("reject") });
  const result = await reconcileMemoryFixture(h.args);
  assert.equal(result.status, "CLEANED");
  assert.deepEqual(
    h.calls.filter((call) => Array.isArray(call) && call[0] === "execute").map((call) => call[1]),
    ["reject"],
  );
});

test("checkpoint failure and cancellation before effect stop cleanup", async () => {
  for (const checkpoint of [
    async () => false,
    async () => {
      throw Error();
    },
  ]) {
    const h = harness("expire", { callbacks: { checkpoint } });
    const result = await reconcileMemoryFixture(h.args);
    assert.equal(result.status, "INCONCLUSIVE");
    assert.equal(
      h.calls.some((call) => Array.isArray(call) && call[0] === "execute"),
      false,
    );
  }

  const controller = new AbortController();
  const h = harness("expire", {
    callbacks: {
      checkpoint: async () => {
        controller.abort();
        return { published: true };
      },
    },
    args: { signal: controller.signal },
  });
  const result = await reconcileMemoryFixture(h.args);
  assert.equal(result.status, "INCONCLUSIVE");
  assert.equal(
    h.calls.some((call) => Array.isArray(call) && call[0] === "execute"),
    false,
  );
});

test("cleanup acceptance requires a distinct successful private Run and exact product evidence", async () => {
  const mutations = [
    (execution) => {
      execution.transportCase.route = "20001";
    },
    (execution) => {
      execution.transportCase.sentMessageId = undefined;
    },
    (execution) => {
      execution.successfulRun = "creation-run-1";
    },
    (execution) => {
      execution.productAcceptance.runtime.pid++;
    },
    (execution) => {
      execution.productAcceptance.cases[0].feature.status = "FAIL";
    },
    (execution) => {
      execution.transportCase.leaseRevoked = false;
    },
    (execution) => {
      execution.productAcceptance.cases[0].scope.chatId = "20002";
    },
    (execution) => {
      execution.productAcceptance.cases[0].messageBinding.input.textSha256 = "0".repeat(64);
    },
    (execution) => {
      const proof = execution.productAcceptance.cases[0].messageBinding;
      proof.reply.driverTime = proof.input.driverTime - 1;
    },
  ];
  for (const mutate of mutations) {
    const h = harness("expire", {
      callbacks: {
        executeCleanup: async (stage, spec) => {
          const execution = successfulExecution(stage, spec, h.record);
          mutate(execution);
          return execution;
        },
      },
    });
    const result = await reconcileMemoryFixture(h.args);
    assert.equal(result.status, "INCONCLUSIVE");
    assert.equal(
      h.calls.some((call) => Array.isArray(call) && call[0] === "verifyCleanup"),
      false,
    );
  }
});

test("read-only cleanup mismatch or unconfirmed final checkpoint stays inconclusive without rerun", async () => {
  const mismatch = harness("expire", {
    callbacks: {
      verifyCleanup: async () => ({
        ...expectedCleanup("expire", handlesFor("expire")),
        memoryId: `memory_${"9".repeat(32)}`,
      }),
    },
  });
  const mismatchResult = await reconcileMemoryFixture(mismatch.args);
  assert.equal(mismatchResult.status, "INCONCLUSIVE");
  assert.equal(mismatchResult.error.code, "MEMORY_RECOVERY_SQL_MISMATCH");
  assert.equal(
    mismatch.calls.filter((call) => Array.isArray(call) && call[0] === "execute").length,
    1,
  );

  const failedFinal = harness("expire", {
    callbacks: {
      checkpoint: async (value) =>
        value.phase === "recovery_cleaned" ? false : { published: true },
    },
  });
  const failedResult = await reconcileMemoryFixture(failedFinal.args);
  assert.equal(failedResult.status, "INCONCLUSIVE");
  assert.equal(failedResult.cleanupRunId, cleanupRunId);
  assert.equal(
    failedFinal.calls.filter((call) => Array.isArray(call) && call[0] === "execute").length,
    1,
  );
});
