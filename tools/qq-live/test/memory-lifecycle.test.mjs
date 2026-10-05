import test from "node:test";
import assert from "node:assert/strict";
import { runMemoryLifecycle } from "../lib/memory-lifecycle.mjs";

const NONCE = "a".repeat(32);
const OWNER = "owner-12345";
const CANDIDATE = `candidate_${"b".repeat(32)}`;
const MEMORY = `memory_${"c".repeat(32)}`;
const RUNS = ["run-feedback-1", "run-promote-2", "run-expire-3"];
const runtime = {
  checkout: "C:/acceptance/checkout",
  dataDirectory: "C:/acceptance/data",
  commit: "d".repeat(40),
  pid: 1234,
};

function accepted(stage, index) {
  const id = `memory-${stage}`;
  const runId = RUNS[index];
  return {
    transportCase: {
      id,
      route: "private",
      status: "PASS",
      leaseRevoked: true,
      inputBinding: {
        driverMessageId: String(10000 + index),
        botMessageId: String(20000 + index),
        realSequence: String(30000 + index),
        time: 1_800_000_000 + index,
        textSha256: "e".repeat(64),
      },
    },
    productAcceptance: {
      status: "PASS",
      runtime,
      cases: [
        {
          caseId: id,
          runId,
          scope: { chatType: "private", chatId: "12345" },
          messageBinding: {
            input: {
              realSequence: String(30000 + index),
              time: 1_800_000_000 + index,
              textSha256: "e".repeat(64),
            },
            reply: {},
          },
          traceVerified: true,
          feature: { runId, status: "PASS", assertions: [] },
        },
      ],
    },
  };
}

function observation(stage, runId) {
  const base = {
    principalKind: "owner",
    principalId: OWNER,
    projectId: `qqtest-${NONCE}`,
    stepRunId: runId,
  };
  if (stage === "feedback")
    return {
      ...base,
      candidateId: CANDIDATE,
      creationRunId: runId,
      candidateStatus: "pending",
    };
  if (stage === "promote")
    return {
      ...base,
      candidateId: CANDIDATE,
      memoryId: MEMORY,
      creationRunId: RUNS[0],
      promoteRunId: runId,
      lifecycleState: "active",
    };
  return {
    ...base,
    status: "expired",
    candidateId: CANDIDATE,
    memoryId: MEMORY,
    creationRunId: RUNS[0],
    promoteRunId: RUNS[1],
    cleanupRunId: runId,
  };
}

function harness(overrides = {}) {
  const calls = [];
  const checkpoints = [];
  const executeStep = async (stage, spec) => {
    calls.push(["execute", stage, spec.id]);
    return accepted(stage, ["feedback", "promote", "expire"].indexOf(stage));
  };
  const observeStep = async (stage, handles) => {
    calls.push(["observe", stage, handles.stepRunId]);
    return observation(stage, handles.stepRunId);
  };
  const checkpoint = async (value) => {
    calls.push(["checkpoint", value.phase, value.stage]);
    checkpoints.push(value);
  };
  return {
    calls,
    checkpoints,
    args: {
      fixtureNonce: NONCE,
      executeStep,
      observeStep,
      checkpoint,
      ...overrides,
    },
  };
}

test("runs feedback, promote, and expire with per-step durable checkpoints", async () => {
  const h = harness();
  const result = await runMemoryLifecycle(h.args);
  assert.equal(result.status, "PASS");
  assert.equal(result.requiresReconciliation, false);
  assert.deepEqual(
    result.steps.map((step) => step.stage),
    ["feedback", "promote", "expire"],
  );
  assert.deepEqual(
    result.steps.map((step) => step.runId),
    RUNS,
  );
  assert.deepEqual(
    result.steps.map((step) => step.currentRunId),
    RUNS,
  );
  assert.equal(result.handles.projectId, `qqtest-${NONCE}`);
  assert.equal(result.handles.principalId, OWNER);
  assert.equal(result.handles.candidateId, CANDIDATE);
  assert.equal(result.handles.memoryId, MEMORY);
  assert.deepEqual(
    h.checkpoints.map(({ phase, stage }) => [phase, stage]),
    ["feedback", "promote", "expire"].flatMap((stage) => [
      ["before_send", stage],
      ["observed", stage],
    ]),
  );
  for (let i = 0; i < 3; i++) {
    const observe = h.calls.find(
      (call) => call[0] === "observe" && call[1] === ["feedback", "promote", "expire"][i],
    );
    assert.equal(observe[2], RUNS[i]);
  }
});

test("does not send when the pre-send checkpoint fails", async () => {
  let sends = 0;
  const h = harness({
    executeStep: async () => {
      sends++;
    },
    checkpoint: async () => {
      throw new Error("checkpoint unavailable");
    },
  });
  const result = await runMemoryLifecycle(h.args);
  assert.equal(sends, 0);
  assert.equal(result.status, "INCONCLUSIVE");
  assert.equal(result.requiresReconciliation, true);
});

test("does not send when the checkpoint explicitly declines durability", async () => {
  let sends = 0;
  const h = harness({
    executeStep: async () => {
      sends++;
    },
    checkpoint: async () => false,
  });
  const result = await runMemoryLifecycle(h.args);
  assert.equal(sends, 0);
  assert.equal(result.status, "INCONCLUSIVE");
  assert.equal(result.requiresReconciliation, true);
});

test("stops after the observed step if its durable checkpoint fails", async () => {
  const h = harness({
    checkpoint: async (entry) => {
      h.calls.push(["checkpoint", entry.phase, entry.stage]);
      if (entry.phase === "observed") throw new Error("disk unavailable");
    },
  });
  const result = await runMemoryLifecycle(h.args);
  assert.equal(result.status, "INCONCLUSIVE");
  assert.equal(result.stage, "feedback");
  assert.equal(result.handles.candidateId, CANDIDATE);
  assert.deepEqual(
    h.calls.filter((call) => call[0] === "execute").map((call) => call[1]),
    ["feedback"],
  );
});

test("rejects incomplete or fabricated PASS evidence before observation", async (t) => {
  const mutations = [
    (value) => {
      value.transportCase.leaseRevoked = false;
    },
    (value) => {
      value.productAcceptance.cases[0].traceVerified = false;
    },
    (value) => {
      value.productAcceptance.cases[0].runId = "other-run";
    },
    (value) => {
      value.productAcceptance.cases.push(value.productAcceptance.cases[0]);
    },
    (value) => {
      value.productAcceptance.cases[0].feature.status = "FAIL";
    },
    (value) => {
      value.productAcceptance.cases[0].feature.runId = "other-run";
    },
    (value) => {
      value.productAcceptance.cases[0].messageBinding.input.textSha256 = "f".repeat(64);
    },
  ];
  for (const [index, mutate] of mutations.entries()) {
    await t.test(`mutation ${index + 1}`, async () => {
      let observed = false;
      let sends = 0;
      const h = harness({
        executeStep: async (stage) => {
          sends++;
          const result = accepted(stage, 0);
          mutate(result);
          return result;
        },
        observeStep: async () => {
          observed = true;
        },
      });
      const result = await runMemoryLifecycle(h.args);
      assert.equal(result.status, "INCONCLUSIVE");
      assert.equal(result.requiresReconciliation, true);
      assert.equal(observed, false);
      assert.equal(sends, 1);
    });
  }
});

test("stops on wrong owner, project, or Run lineage and preserves known handles", async (t) => {
  const forgeries = [
    (value) => {
      if (value.stepRunId === RUNS[1]) value.principalId = "other-owner";
    },
    (value) => {
      value.projectId = "qqtest-" + "f".repeat(32);
    },
    (value) => {
      value.creationRunId = "other-run";
    },
    (value) => {
      value.candidateStatus = "rejected";
    },
  ];
  for (const [index, forge] of forgeries.entries()) {
    await t.test(`forgery ${index + 1}`, async () => {
      let sends = 0;
      const h = harness({
        executeStep: async (stage) => {
          sends++;
          return accepted(stage, 0);
        },
        observeStep: async (stage, handles) => {
          const value = observation(stage, handles.stepRunId);
          forge(value);
          return value;
        },
      });
      const result = await runMemoryLifecycle(h.args);
      assert.equal(result.status, "INCONCLUSIVE");
      assert.equal(result.requiresReconciliation, true);
      assert.equal(sends, index === 0 ? 2 : 1);
      assert.equal(result.handles.candidateId, index === 0 ? CANDIDATE : undefined);
    });
  }
});

test("wrong Run observation during promote does not start expire", async () => {
  let sends = 0;
  const h = harness({
    executeStep: async (stage) => {
      sends++;
      return accepted(stage, ["feedback", "promote", "expire"].indexOf(stage));
    },
    observeStep: async (stage, handles) => {
      const value = observation(stage, handles.stepRunId);
      if (stage === "promote") value.promoteRunId = "other-run";
      return value;
    },
  });
  const result = await runMemoryLifecycle(h.args);
  assert.equal(result.status, "INCONCLUSIVE");
  assert.equal(result.stage, "promote");
  assert.equal(result.handles.candidateId, CANDIDATE);
  assert.equal(sends, 2);
});

test("runtime snapshot changes between steps stop before the next observation", async () => {
  let sends = 0;
  const h = harness({
    executeStep: async (stage) => {
      sends++;
      const value = accepted(stage, ["feedback", "promote", "expire"].indexOf(stage));
      if (stage === "promote") value.productAcceptance.runtime.pid++;
      return value;
    },
  });
  const result = await runMemoryLifecycle(h.args);
  assert.equal(result.status, "INCONCLUSIVE");
  assert.equal(result.stage, "promote");
  assert.equal(result.handles.stepRunId, RUNS[1]);
  assert.equal(result.handles.candidateId, CANDIDATE);
  assert.equal(sends, 2);
});

test("interruption between observations prevents the next send", async () => {
  const controller = new AbortController();
  let sends = 0;
  const h = harness({
    signal: controller.signal,
    executeStep: async (stage) => {
      sends++;
      return accepted(stage, ["feedback", "promote", "expire"].indexOf(stage));
    },
    observeStep: async (stage, handles) => {
      const result = observation(stage, handles.stepRunId);
      if (stage === "feedback") controller.abort();
      return result;
    },
  });
  const result = await runMemoryLifecycle(h.args);
  assert.equal(result.status, "INCONCLUSIVE");
  assert.equal(result.stage, "promote");
  assert.equal(sends, 1);
});

test("unknown cleanup evidence cannot produce a PASS result", async () => {
  let sends = 0;
  const h = harness({
    executeStep: async (stage) => {
      sends++;
      return accepted(stage, ["feedback", "promote", "expire"].indexOf(stage));
    },
    observeStep: async (stage, handles) => {
      const value = observation(stage, handles.stepRunId);
      if (stage === "expire") value.status = "unknown";
      return value;
    },
  });
  const result = await runMemoryLifecycle(h.args);
  assert.equal(result.status, "INCONCLUSIVE");
  assert.equal(result.requiresReconciliation, true);
  assert.equal(result.stage, "expire");
  assert.equal(sends, 3);
});

test("does not retry an execution with unknown outcome", async () => {
  let sends = 0;
  const h = harness({
    executeStep: async () => {
      sends++;
      throw new Error("transport outcome unknown");
    },
  });
  const result = await runMemoryLifecycle(h.args);
  assert.equal(result.status, "INCONCLUSIVE");
  assert.equal(result.requiresReconciliation, true);
  assert.equal(sends, 1);
});
