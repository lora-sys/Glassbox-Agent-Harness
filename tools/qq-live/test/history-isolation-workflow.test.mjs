import test from "node:test";
import assert from "node:assert/strict";
import { digest, toolManifestDigest } from "../lib/core.mjs";
import {
  HISTORY_ISOLATION_FAMILY_ID,
  runHistoryIsolationWorkflow,
} from "../lib/history-isolation-workflow.mjs";

const TOKENS = ["a".repeat(32), "b".repeat(32)];
const RUN_IDS = ["seed-run-b", "exclusion-run-private"];
const BASE_TIME = Math.floor(Date.now() / 1000) - 10;
const config = {
  groups: [
    { alias: "A", id: "20001" },
    { alias: "B", id: "20002" },
  ],
  bot: { qq: "10003" },
  driver: { qq: "10002" },
  runtime: {
    connectionId: "qq-isolation-test",
    threadId: null,
    expectedCommit: "d".repeat(40),
  },
};

function resolved(value, token) {
  return JSON.parse(JSON.stringify(value).replaceAll("{{nonce}}", token));
}

function observations(spec) {
  return spec.featureAssertions.map((assertion) => {
    if (assertion.kind === "trace")
      return { kind: "trace", type: assertion.type, count: assertion.count };
    if (assertion.kind === "history_coverage")
      return {
        kind: "history_coverage",
        coverage: "complete",
        returned: spec.chat === "B" ? 1 : 0,
        sourceComplete: true,
      };
    if (assertion.kind === "history_result")
      return {
        kind: "history_result",
        result: "hit",
        returned: 1,
        sourceVerified: true,
        toolOutputVerified: true,
      };
    return {
      kind: "history_exclusion_result",
      result: "no_match",
      returned: 0,
      sourceVerified: true,
      exclusionVerified: true,
      toolOutputVerified: true,
    };
  });
}

function accepted(spec, index, options) {
  const token = options.tokens[index];
  const time = options.times[index];
  const runId = options.runIds[index];
  const prompt = `GLASSBOX_ACCEPTANCE_V1 ${token}\n${spec.prompt.replaceAll("{{nonce}}", token).trim()}`;
  const binding = {
    driverMessageId: String(31001 + index),
    botMessageId: String(41001 + index),
    realSequence: String(51001 + index),
    time,
    driverTime: time,
    textSha256: digest(prompt),
  };
  const productRuntime = structuredClone(options.runtimes[index]);
  const route = spec.chat === "private" ? "private" : "20002";
  const reply = {
    botMessageId: String(51001 + index),
    driverMessageId: String(61001 + index),
    realSequence: String(71001 + index),
    time,
    driverTime: time,
    textSha256: digest(`reply-${index}`),
  };
  const productCase = {
    caseId: spec.id,
    runId,
    delivery: { status: "sent", external_id: reply.botMessageId },
    scope: {
      connectionId: config.runtime.connectionId,
      botId: config.bot.qq,
      senderId: config.driver.qq,
      chatType: spec.chat === "private" ? "private" : "group",
      chatId: spec.chat === "private" ? config.driver.qq : route,
      threadId: config.runtime.threadId,
    },
    messageBinding: {
      input: {
        realSequence: binding.realSequence,
        time: binding.time,
        driverTime: binding.driverTime,
        textSha256: binding.textSha256,
      },
      reply,
    },
    traceVerified: true,
    feature: { runId, status: "PASS", observations: observations(spec) },
  };
  const result = {
    transportCase: {
      id: spec.id,
      token,
      status: "PASS",
      route,
      prompt,
      startedAt: new Date(time * 1000).toISOString(),
      expected: resolved(spec.expectContains, token),
      featureAssertions: resolved(spec.featureAssertions, token),
      leasedToolNames: spec.leaseTools.map((tool) => tool.name),
      acceptanceLease: {
        leaseId: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
        expiresAt: time * 1000 + 60_000,
        toolsSha256: toolManifestDigest(resolved(spec.leaseTools, token)),
      },
      leaseRevoked: true,
      anomalies: [],
      sentMessageId: binding.driverMessageId,
      inputBinding: binding,
      replies: [
        {
          route,
          messageId: reply.driverMessageId,
          matches: true,
          textSha256: reply.textSha256,
        },
      ],
    },
    productAcceptance: { status: "PASS", runtime: productRuntime, cases: [productCase] },
  };
  options.mutate?.(spec.id, result);
  return result;
}

function harness(overrides = {}) {
  const calls = [];
  const checkpoints = [];
  const options = {
    tokens: [...TOKENS],
    runIds: [...RUN_IDS],
    times: [BASE_TIME, BASE_TIME + 1],
    runtimes: [0, 1].map(() => ({
      checkout: "C:/acceptance/checkout",
      dataDirectory: "C:/acceptance/data",
      commit: config.runtime.expectedCommit,
      pid: 4321,
      connectionId: config.runtime.connectionId,
      threadId: config.runtime.threadId,
    })),
    ...overrides,
  };
  return {
    calls,
    checkpoints,
    args: {
      config,
      executeStep: async (stage, spec) => {
        calls.push({ stage, spec });
        return accepted(spec, calls.length - 1, options);
      },
      checkpoint: async (state) => {
        checkpoints.push(state);
        return options.checkpoint ? options.checkpoint(state, calls) : true;
      },
      signal: options.signal,
    },
  };
}

test("runs B seed then private A exclusion from verified seed evidence", async () => {
  const h = harness();
  const result = await runHistoryIsolationWorkflow(h.args);
  assert.deepEqual(result, {
    status: "PASS",
    familyId: HISTORY_ISOLATION_FAMILY_ID,
    stageRunIds: RUN_IDS,
    cleanup: { required: false, leaseRevoked: true },
  });
  assert.deepEqual(
    h.calls.map(({ stage }) => stage),
    ["seed", "exclusion"],
  );
  const [seed, exclusion] = h.calls.map(({ spec }) => spec);
  const sentinel = seed.prompt.match(/qq-isolation-secret-[a-f0-9]{32}/)?.[0];
  assert.match(sentinel ?? "", /^qq-isolation-secret-[a-f0-9]{32}$/);
  assert.equal(seed.chat, "B");
  assert.equal(seed.leaseTools[0].operations[0].resourceId, "group:20002");
  assert.equal(exclusion.chat, "private");
  assert.match(exclusion.prompt, new RegExp(`query=${TOKENS[0]}`));
  assert.ok(exclusion.prompt.includes(`until=${new Date(BASE_TIME * 1000).toISOString()}`));
  assert.equal(exclusion.prompt.includes(sentinel), false);
  assert.deepEqual(exclusion.leaseTools[0].operations[0].inputConstraint.groupIds, ["20001"]);
  assert.equal(exclusion.featureAssertions[3].sourceGroupId, "20002");
  assert.equal(exclusion.featureAssertions[3].sourceRunId, RUN_IDS[0]);
  assert.equal(exclusion.featureAssertions[3].sentinelSha256, digest(sentinel));
  assert.equal(exclusion.featureAssertions[3].until, new Date(BASE_TIME * 1000).toISOString());
  assert.deepEqual(
    h.checkpoints.map(({ stage, phase }) => [stage, phase]),
    [
      ["seed", "intent"],
      ["seed", "verified"],
      ["exclusion", "intent"],
      ["exclusion", "verified"],
    ],
  );
  assert.equal(JSON.stringify(h.checkpoints).includes(sentinel), false);
});

test("a failed seed stops before exclusion", async () => {
  const h = harness({
    mutate(id, result) {
      if (id === "history-cross-group-seed") result.transportCase.status = "FAIL";
    },
  });
  await assert.rejects(runHistoryIsolationWorkflow(h.args), { code: "HISTORY_ISOLATION_WORKFLOW" });
  assert.deepEqual(
    h.calls.map(({ stage }) => stage),
    ["seed"],
  );
});

test("a failed exclusion is attempted once and never replayed", async () => {
  const h = harness({
    mutate(id, result) {
      if (id === "history-cross-group-private-exclusion")
        result.productAcceptance.cases[0].traceVerified = false;
    },
  });
  await assert.rejects(runHistoryIsolationWorkflow(h.args), { code: "HISTORY_ISOLATION_WORKFLOW" });
  assert.deepEqual(
    h.calls.map(({ stage }) => stage),
    ["seed", "exclusion"],
  );
});

test("rejects repeated markers, Run IDs, times, or changed runtime", async (t) => {
  const variants = [
    ["same marker", { tokens: [TOKENS[0], TOKENS[0]] }],
    ["same Run", { runIds: [RUN_IDS[0], RUN_IDS[0]] }],
    ["same time", { times: [BASE_TIME, BASE_TIME] }],
    [
      "changed runtime",
      {
        runtimes: [
          {
            checkout: "C:/acceptance/checkout",
            dataDirectory: "C:/acceptance/data",
            commit: config.runtime.expectedCommit,
            pid: 4321,
            connectionId: config.runtime.connectionId,
            threadId: null,
          },
          {
            checkout: "C:/acceptance/checkout",
            dataDirectory: "C:/acceptance/data",
            commit: config.runtime.expectedCommit,
            pid: 9999,
            connectionId: config.runtime.connectionId,
            threadId: null,
          },
        ],
      },
    ],
  ];
  for (const [name, options] of variants)
    await t.test(name, async () => {
      const h = harness(options);
      await assert.rejects(runHistoryIsolationWorkflow(h.args), {
        code: "HISTORY_ISOLATION_WORKFLOW",
      });
      assert.deepEqual(
        h.calls.map(({ stage }) => stage),
        ["seed", "exclusion"],
      );
    });
});

test("rejects weakened transport, lease, feature, scope, and product evidence", async (t) => {
  const cases = [
    [
      "Owner reply predates Owner input",
      (_id, result) => {
        const evidence = result.productAcceptance.cases[0];
        evidence.messageBinding.reply.driverTime = evidence.messageBinding.input.driverTime - 1;
      },
      ["seed"],
    ],
    [
      "missing feature assertion",
      (_id, result) => result.transportCase.featureAssertions.pop(),
      ["seed"],
    ],
    [
      "wrong lease manifest",
      (_id, result) => (result.transportCase.acceptanceLease.toolsSha256 = "f".repeat(64)),
      ["seed"],
    ],
    [
      "array lease ID",
      (_id, result) =>
        (result.transportCase.acceptanceLease.leaseId = [
          result.transportCase.acceptanceLease.leaseId,
        ]),
      ["seed"],
    ],
    ["lease not revoked", (_id, result) => (result.transportCase.leaseRevoked = false), ["seed"]],
    [
      "wrong QQ binding",
      (_id, result) => (result.transportCase.inputBinding.textSha256 = "f".repeat(64)),
      ["seed"],
    ],
    [
      "array QQ sequence",
      (_id, result) => (result.transportCase.inputBinding.realSequence = ["51001"]),
      ["seed"],
    ],
    [
      "wrong product scope",
      (_id, result) => (result.productAcceptance.cases[0].scope.chatId = "20001"),
      ["seed"],
    ],
    [
      "array product Run ID",
      (_id, result) => (result.productAcceptance.cases[0].runId = ["seed-run-b"]),
      ["seed"],
    ],
    [
      "missing trace proof",
      (_id, result) => (result.productAcceptance.cases[0].traceVerified = false),
      ["seed"],
    ],
    [
      "missing exclusion observation",
      (id, result) => {
        if (id === "history-cross-group-private-exclusion")
          result.productAcceptance.cases[0].feature.observations.pop();
      },
      ["seed", "exclusion"],
    ],
  ];
  for (const [name, mutate, expectedStages] of cases)
    await t.test(name, async () => {
      const h = harness({ mutate });
      await assert.rejects(runHistoryIsolationWorkflow(h.args), {
        code: "HISTORY_ISOLATION_WORKFLOW",
      });
      assert.deepEqual(
        h.calls.map(({ stage }) => stage),
        expectedStages,
      );
    });
});

test("checkpoint rejection and abort prevent later sends", async (t) => {
  await t.test("seed intent checkpoint", async () => {
    const h = harness({ checkpoint: () => false });
    await assert.rejects(runHistoryIsolationWorkflow(h.args), {
      code: "HISTORY_ISOLATION_WORKFLOW",
    });
    assert.equal(h.calls.length, 0);
  });
  await t.test("seed verified checkpoint", async () => {
    const h = harness({
      checkpoint: (state) => !(state.stage === "seed" && state.phase === "verified"),
    });
    await assert.rejects(runHistoryIsolationWorkflow(h.args), {
      code: "HISTORY_ISOLATION_WORKFLOW",
    });
    assert.deepEqual(
      h.calls.map(({ stage }) => stage),
      ["seed"],
    );
  });
  await t.test("abort before first stage", async () => {
    const controller = new AbortController();
    controller.abort();
    const h = harness({ signal: controller.signal });
    await assert.rejects(runHistoryIsolationWorkflow(h.args), { code: "CANCELLED" });
    assert.equal(h.calls.length, 0);
  });
  await t.test("abort after seed verified checkpoint", async () => {
    const controller = new AbortController();
    const h = harness({
      signal: controller.signal,
      checkpoint(state) {
        if (state.stage === "seed" && state.phase === "verified") controller.abort();
        return true;
      },
    });
    await assert.rejects(runHistoryIsolationWorkflow(h.args), { code: "CANCELLED" });
    assert.deepEqual(
      h.calls.map(({ stage }) => stage),
      ["seed"],
    );
  });
});

test("rejects invalid or non-distinct configured groups before sending", async () => {
  for (const groups of [
    "not-groups",
    [{ alias: "A", id: "20001" }],
    [
      { alias: "A", id: "20001" },
      { alias: "A", id: "20002" },
      { alias: "B", id: "20003" },
    ],
    [
      { alias: "A", id: "20001" },
      { alias: "B", id: "20001" },
    ],
  ]) {
    const h = harness();
    await assert.rejects(
      runHistoryIsolationWorkflow({ ...h.args, config: { ...config, groups } }),
      { code: "HISTORY_ISOLATION_WORKFLOW" },
    );
    assert.equal(h.calls.length, 0);
  }
});
