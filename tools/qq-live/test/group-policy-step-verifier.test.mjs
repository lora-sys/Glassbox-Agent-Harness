import assert from "node:assert/strict";
import test from "node:test";
import { digest, toolManifestDigest } from "../lib/core.mjs";
import { groupPolicyStep } from "../lib/group-policy-scenario.mjs";
import { verifyGroupPolicyStep } from "../lib/group-policy-step-verifier.mjs";

const config = {
  bot: { qq: "10001" },
  driver: { qq: "20002" },
  groups: [
    { alias: "A", id: "30003" },
    { alias: "B", id: "40004" },
  ],
  runtime: { checkout: "/fixture/checkout", dataDirectory: "/fixture/data" },
};
const runtime = {
  checkout: config.runtime.checkout,
  dataDirectory: config.runtime.dataDirectory,
  commit: "a".repeat(40),
  pid: 1234,
  connectionId: "fixture-connection",
};

function state(version = 1) {
  return {
    schemaVersion: 1,
    kind: "group-policy-state",
    connectionId: config.runtime.connectionId,
    scopeKey: JSON.stringify([
      config.runtime.connectionId,
      config.bot.qq,
      "private",
      config.driver.qq,
      config.driver.qq,
      null,
    ]),
    principalId: "owner-fixture",
    A: { groupId: "30003", version: 1 },
    B: { groupId: "40004", version, historyGrants: [{ id: "grant-original" }] },
  };
}

function transportCase(stage = "disable", overrides = {}) {
  const spec = groupPolicyStep(stage, "40004");
  const token = "b".repeat(32);
  const tools = spec.leaseTools;
  return {
    id: spec.id,
    token,
    route: "private",
    status: "PASS",
    code: "REAL_REPLY_RECEIVED",
    prompt: `GLASSBOX_ACCEPTANCE_V1 ${token}\n${spec.prompt.replaceAll("{{nonce}}", token).trim()}`,
    expected: spec.expectContains.map((value) => value.replaceAll("{{nonce}}", token)),
    featureAssertions: JSON.parse(
      JSON.stringify(spec.featureAssertions).replaceAll("{{nonce}}", token),
    ),
    leasedToolNames: tools.map((tool) => tool.name),
    acceptanceLease: {
      leaseId: "12345678-1234-4234-9234-123456789abc",
      expiresAt: Date.parse("2026-10-07T00:05:00.000Z"),
      toolsSha256: toolManifestDigest(tools),
    },
    startedAt: "2026-10-07T00:00:00.000Z",
    sendAttempted: true,
    inputObserved: true,
    leaseRegistrationAttempted: true,
    leaseRevoked: true,
    sentMessageId: "12345",
    replies: [{ route: "private", matches: true, messageId: "67890" }],
    anomalies: [],
    ...overrides,
  };
}

function harness(overrides = {}) {
  const before = state(1);
  const after = state(2);
  const spec = groupPolicyStep("disable", "40004");
  const db = {
    closeCalls: 0,
    close() {
      this.closeCalls += 1;
    },
  };
  const calls = [];
  const deps = {
    runtimeSnapshot: async () => runtime,
    openReadOnlyDatabase: () => db,
    verifyCaseWithLeaseCleanup: async (_db, _directory, _case, _config, verify) => {
      const result = await verify({
        runId: "run-fixture-1",
        delivery: { id: "delivery-1" },
      });
      return { cleanupVerified: true, result };
    },
    verifyMessageBindings: async () => ({
      inputMessageId: "1",
      replyMessageId: "2",
    }),
    readGroupPolicyTraceEvents: () => ({
      events: [{ event: { type: "trace_fixture" } }],
    }),
    verifyTraceEvidence: () => calls.push("trace"),
    verifyLeaseTraceEvidence: () => calls.push("lease-trace"),
    captureGroupPolicyState: () => after,
    observeGroupPolicyRun: () => ({
      status: "GROUP_POLICY_RUN_VERIFIED",
      runId: "run-fixture-1",
      stage: "disable",
      policyVersion: after.B.version,
      toolCallId: "call-fixture-1",
      toolOutputSha256: "c".repeat(64),
      stateProof: { status: "STATE_TRANSITION_VERIFIED", stage: "disable" },
      actualQqDeliveryVerified: false,
    }),
    ...overrides,
  };
  return {
    input: {
      config,
      clients: { driver: {}, bot: {} },
      expectedRuntime: runtime,
      stage: "disable",
      spec,
      result: { transportCase: transportCase() },
      before,
      after,
    },
    deps,
    db,
    calls,
  };
}

test("verifies fixed Run, cleanup, both-account delivery binding, trace and fresh policy state", async () => {
  const h = harness();
  const proof = await verifyGroupPolicyStep(h.input, h.deps);
  assert.equal(proof.status, "GROUP_POLICY_RUN_VERIFIED");
  assert.equal(proof.cleanupVerified, true);
  assert.equal(proof.actualQqDeliveryVerified, true);
  assert.deepEqual(proof.messageBinding, {
    inputMessageId: "1",
    replyMessageId: "2",
  });
  assert.deepEqual(h.calls, ["trace", "lease-trace"]);
  assert.equal(h.db.closeCalls, 1);
});

test("rejects a modified fixed spec before opening the database", async () => {
  const h = harness();
  h.input.spec.prompt += " custom";
  await assert.rejects(verifyGroupPolicyStep(h.input, h.deps), {
    code: "GROUP_POLICY_STEP_EVIDENCE",
    status: "INCONCLUSIVE",
  });
  assert.equal(h.db.closeCalls, 0);
});

test("rejects malformed transport receipts before reading runtime evidence", async (t) => {
  const changes = [
    ["wrong stage prompt", { prompt: "custom" }],
    ["unmatched reply", { replies: [{ route: "private", matches: false, messageId: "2" }] }],
    ["dual-account anomaly", { anomalies: ["WRONG_DESTINATION"] }],
    ["lease not revoked", { leaseRevoked: false }],
  ];
  for (const [name, change] of changes) {
    await t.test(name, async () => {
      const h = harness();
      h.input.result.transportCase = transportCase("disable", change);
      let runtimeReads = 0;
      h.deps.runtimeSnapshot = async () => {
        runtimeReads += 1;
        return runtime;
      };
      await assert.rejects(verifyGroupPolicyStep(h.input, h.deps), {
        code: "GROUP_POLICY_STEP_EVIDENCE",
        status: "INCONCLUSIVE",
      });
      assert.equal(runtimeReads, 0);
    });
  }
});

test("rejects runtime drift before DB reads and after evidence collection", async (t) => {
  await t.test("before", async () => {
    const h = harness({
      runtimeSnapshot: async () => ({ ...runtime, pid: 9999 }),
    });
    await assert.rejects(verifyGroupPolicyStep(h.input, h.deps), {
      code: "GROUP_POLICY_STEP_EVIDENCE",
      status: "INCONCLUSIVE",
    });
    assert.equal(h.db.closeCalls, 0);
  });
  await t.test("after", async () => {
    const h = harness();
    let reads = 0;
    h.deps.runtimeSnapshot = async () => (++reads === 1 ? runtime : { ...runtime, pid: 9999 });
    await assert.rejects(verifyGroupPolicyStep(h.input, h.deps), {
      code: "GROUP_POLICY_STEP_EVIDENCE",
      status: "INCONCLUSIVE",
    });
    assert.equal(h.db.closeCalls, 1);
  });
});

test("rejects missing lease cleanup and state drift", async (t) => {
  await t.test("cleanup", async () => {
    const h = harness({
      verifyCaseWithLeaseCleanup: async (_db, _directory, _case, _config, verify) => {
        const result = await verify({
          runId: "run-fixture-1",
          delivery: { id: "delivery-1" },
        });
        return { cleanupVerified: false, result };
      },
    });
    await assert.rejects(verifyGroupPolicyStep(h.input, h.deps), {
      code: "GROUP_POLICY_STEP_EVIDENCE",
      status: "INCONCLUSIVE",
    });
  });
  await t.test("independent state mismatch", async () => {
    const h = harness({ captureGroupPolicyState: () => state(3) });
    await assert.rejects(verifyGroupPolicyStep(h.input, h.deps), {
      code: "GROUP_POLICY_STEP_EVIDENCE",
      status: "INCONCLUSIVE",
    });
  });
});

test("rejects trace and dual-account message-binding failures", async (t) => {
  for (const [name, override] of [
    [
      "trace mismatch",
      {
        verifyTraceEvidence: () => {
          throw new Error("trace mismatch");
        },
      },
    ],
    [
      "dual-account receipt mismatch",
      {
        verifyMessageBindings: async () => {
          throw new Error("receipt mismatch");
        },
      },
    ],
  ]) {
    await t.test(name, async () => {
      const h = harness(override);
      await assert.rejects(verifyGroupPolicyStep(h.input, h.deps), {
        code: "GROUP_POLICY_STEP_EVIDENCE",
        status: "INCONCLUSIVE",
      });
    });
  }
});

test("reads the full fixed group-policy Trace type set with bounded execution", async () => {
  const h = harness();
  let invocation;
  const events = { events: [{ event: { type: "group_history_changed" } }] };
  const result = await verifyGroupPolicyStep(h.input, {
    ...h.deps,
    readGroupPolicyTraceEvents: undefined,
    execFileSync: (_file, args, options) => {
      invocation = { args, options };
      return JSON.stringify(events);
    },
  });
  assert.equal(result.status, "GROUP_POLICY_RUN_VERIFIED");
  assert.ok(invocation.args.includes("group_history_changed"));
  assert.equal(invocation.options.timeout, 10000);
  assert.equal(invocation.options.maxBuffer, 1024 * 1024);
  assert.equal(digest(h.input.result.transportCase.prompt).length, 64);
});
