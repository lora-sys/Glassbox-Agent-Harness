import assert from "node:assert/strict";
import test from "node:test";
import { resolveGroupPolicyCli, runGroupPolicyCli } from "../lib/group-policy-cli.mjs";
import { GROUP_POLICY_FAMILY_ID } from "../lib/group-policy-scenario.mjs";

const config = {
  driver: { qq: "10001" },
  bot: { qq: "10002" },
  groups: [
    { alias: "A", id: "30003" },
    { alias: "B", id: "40004" },
  ],
  runtime: {
    checkout: "/fixture/checkout",
    dataDirectory: "/fixture/data",
    expectedCommit: "a".repeat(40),
    connectionId: "fixture-connection",
  },
  maxMessages: 3,
  groupPolicyFixtures: {
    enabled: true,
    retainAuditConfirmed: true,
    groupId: "40004",
  },
};
const plan = resolveGroupPolicyCli({ command: "plan", config });
const suiteSha256 = plan.suiteSha256;

test("resolves a display-only fixed group-B plan", () => {
  const result = resolveGroupPolicyCli({ command: "plan", config });
  assert.equal(result.familyId, GROUP_POLICY_FAMILY_ID);
  assert.equal(result.groupId, "40004");
  assert.equal(result.suiteSha256, suiteSha256);
  assert.deepEqual(result.stages, plan.stages);
  assert.deepEqual(result.bindings.groups, { A: "30003", B: "40004" });
  assert.equal(result.bindings.actors.ownerId, "10001");
  assert.equal(result.bindings.actors.botId, "10002");
  assert.equal(result.bindings.scope.threadId, null);
});

test("binds the approved hash to actors, groups, scope and runtime identity", () => {
  const variants = [
    { ...config, driver: { ...config.driver, qq: "10003" } },
    { ...config, bot: { ...config.bot, qq: "10004" } },
    {
      ...config,
      groups: [{ alias: "A", id: "30005" }, config.groups[1]],
    },
    {
      ...config,
      groups: [config.groups[0], { alias: "B", id: "40005" }],
      groupPolicyFixtures: { ...config.groupPolicyFixtures, groupId: "40005" },
    },
    {
      ...config,
      runtime: { ...config.runtime, connectionId: "other-connection" },
    },
    { ...config, runtime: { ...config.runtime, threadId: "thread-2" } },
    {
      ...config,
      runtime: { ...config.runtime, expectedCommit: "b".repeat(40) },
    },
    {
      ...config,
      runtime: { ...config.runtime, checkout: "/other/checkout" },
    },
    {
      ...config,
      runtime: { ...config.runtime, dataDirectory: "/other/data" },
    },
    {
      ...config,
      runtime: {
        ...config.runtime,
        expectedSourceTreeSha256: "d".repeat(64),
      },
    },
  ];
  for (const variant of variants) {
    const alternate = resolveGroupPolicyCli({
      command: "plan",
      config: variant,
    });
    assert.notEqual(alternate.suiteSha256, suiteSha256);
  }
});

test("requires the fixed case, runtime, budget, and reviewed plan for live execution", () => {
  const args = {
    command: "run",
    caseId: GROUP_POLICY_FAMILY_ID,
    config,
    approvedSuite: suiteSha256,
  };
  assert.equal(resolveGroupPolicyCli(args).groupId, "40004");
  for (const invalid of [
    { ...args, caseId: "other" },
    { ...args, approvedSuite: "b".repeat(64) },
    { ...args, config: { ...config, runtime: undefined } },
    { ...args, config: { ...config, maxMessages: 1 } },
    {
      ...args,
      config: {
        ...config,
        groupPolicyFixtures: {
          ...config.groupPolicyFixtures,
          groupId: "30003",
        },
      },
    },
  ])
    assert.throws(() => resolveGroupPolicyCli(invalid));
});

test("creates the durable checkpoint before invoking the three-stage workflow", async () => {
  const selection = resolveGroupPolicyCli({
    command: "run",
    caseId: GROUP_POLICY_FAMILY_ID,
    config,
    approvedSuite: suiteSha256,
  });
  const order = [];
  let workflowArgs;
  let checkpointArgs;
  let receivedAcceptance;
  const checkpoint = {
    write: async () => {
      order.push("checkpoint");
      return true;
    },
    complete: async (value) => {
      order.push("complete");
      return { status: "GROUP_POLICY_GUARD_COMPLETED", ...value };
    },
  };
  const clients = { driver: {}, bot: {} };
  const recorder = {};
  const acceptance = { register: async () => ({}) };
  const result = await runGroupPolicyCli({
    selection,
    config,
    clients,
    recorder,
    acceptance,
    signal: undefined,
    pendingPath: "/fixture/pending.json",
    reportDirectory: "/fixture/report",
    reportRuntime: {
      checkout: "/fixture/checkout",
      dataDirectory: "/fixture/data",
      commit: "a".repeat(40),
      pid: 42,
      connectionId: "fixture-connection",
    },
    driverSha256: "c".repeat(64),
    processIdentity: { pid: 42 },
    dependencies: {
      createCheckpoint: async (value) => {
        checkpointArgs = value;
        order.push("create");
        return checkpoint;
      },
      runWorkflow: async (value) => {
        workflowArgs = value;
        order.push("workflow");
        const stepResult = await value.executeStep(
          "disable",
          { id: "fixed-step" },
          { beforeRegister: async () => "workflow-hook" },
        );
        assert.equal(stepResult.transportCase.status, "PASS");
        assert.equal(
          await value.verifyStep({
            stage: "disable",
            spec: { id: "fixed-step" },
          }),
          "verified-step",
        );
        return {
          status: "GROUP_POLICY_WORKFLOW_VERIFIED",
          requiresReconciliation: false,
          actualQqDeliveryVerified: true,
          cleanupVerified: true,
          steps: [],
          finalProof: {},
        };
      },
      replyCase: async (...args) => {
        receivedAcceptance = args.at(-1);
        return { status: "PASS" };
      },
      verifyStep: async () => "verified-step",
    },
  });
  assert.deepEqual(order, ["create", "workflow"]);
  assert.equal(checkpointArgs.suiteSha256, suiteSha256);
  assert.equal(workflowArgs.groupId, "40004");
  assert.equal(typeof workflowArgs.captureState, "function");
  assert.equal(typeof workflowArgs.readRuntime, "function");
  assert.equal(typeof workflowArgs.checkpoint, "function");
  assert.equal(typeof workflowArgs.executeStep, "function");
  assert.equal(typeof workflowArgs.verifyStep, "function");
  assert.equal(typeof receivedAcceptance.beforeRegister, "function");
  assert.equal(await receivedAcceptance.beforeRegister(), "workflow-hook");
  assert.equal(typeof receivedAcceptance.register, "function");
  const completion = await result.complete({
    reportPath: "/fixture/report/report.json",
    connectionsDrained: true,
    recheck: async () => {},
  });
  assert.equal(completion.status, "GROUP_POLICY_GUARD_COMPLETED");
  assert.equal(order.at(-1), "complete");
});

test("rejects an altered selection before creating a checkpoint", async () => {
  let created = false;
  await assert.rejects(
    runGroupPolicyCli({
      selection: {
        mode: "run",
        familyId: GROUP_POLICY_FAMILY_ID,
        groupId: "30003",
        suiteSha256,
      },
      config,
      clients: { driver: {}, bot: {} },
      recorder: {},
      acceptance: {},
      pendingPath: "/fixture/pending.json",
      reportDirectory: "/fixture/report",
      reportRuntime: {},
      dependencies: {
        createCheckpoint: async () => {
          created = true;
        },
      },
    }),
  );
  assert.equal(created, false);
});
