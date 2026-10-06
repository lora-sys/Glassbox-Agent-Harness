import test from "node:test";
import assert from "node:assert/strict";
import { digest, toolManifestDigest } from "../lib/core.mjs";
import { runHistorySeedWorkflow } from "../lib/history-seed-workflow.mjs";

const TOKENS = ["a".repeat(32), "b".repeat(32)];
const RUN_IDS = ["seed-run-1", "recall-run-2"];
const BASE_TIME = Math.floor(Date.now() / 1000) - 10;
const runtime = {
  connectionId: "p3-qq",
  threadId: null,
  expectedCommit: "d".repeat(40),
};
const config = {
  groups: [
    { alias: "A", id: "20001" },
    { alias: "B", id: "20002" },
  ],
  bot: { qq: "10003" },
  driver: { qq: "10002" },
  runtime,
};

function resolved(value, token) {
  return JSON.parse(JSON.stringify(value).replaceAll("{{nonce}}", token));
}

function accepted(stage, spec, index, options) {
  const token = options.tokens[index];
  const runId = options.runIds[index];
  const bindingTime = options.times[index];
  const prompt = `GLASSBOX_ACCEPTANCE_V1 ${token}\n${spec.prompt.replaceAll("{{nonce}}", token).trim()}`;
  const binding = {
    driverMessageId: String(31001 + index),
    botMessageId: String(41001 + index),
    realSequence: String(51001 + index),
    time: bindingTime,
    driverTime: bindingTime,
    textSha256: digest(prompt),
  };
  const productRuntime = structuredClone(options.runtimes[index]);
  const productCase = {
    caseId: spec.id,
    runId,
    scope: {
      connectionId: config.runtime.connectionId,
      botId: config.bot.qq,
      senderId: config.driver.qq,
      chatType: spec.chat === "private" ? "private" : "group",
      chatId: spec.chat === "private" ? config.driver.qq : "20001",
      threadId: config.runtime.threadId,
    },
    messageBinding: {
      input: {
        realSequence: binding.realSequence,
        time: binding.time,
        driverTime: binding.driverTime,
        textSha256: binding.textSha256,
      },
      reply: {
        botMessageId: String(51001 + index),
        driverMessageId: String(61001 + index),
        realSequence: String(71001 + index),
        time: binding.time,
        driverTime: binding.time,
        textSha256: digest(`reply-${index}`),
      },
    },
    traceVerified: true,
    feature: { runId, status: "PASS" },
  };
  const result = {
    transportCase: {
      id: spec.id,
      token,
      status: "PASS",
      route: spec.chat === "private" ? "private" : "20001",
      prompt,
      expected: resolved(spec.expectContains, token),
      featureAssertions: resolved(spec.featureAssertions, token),
      leasedToolNames: spec.leaseTools.map((tool) => tool.name),
      acceptanceLease: { toolsSha256: toolManifestDigest(resolved(spec.leaseTools, token)) },
      leaseRevoked: true,
      sentMessageId: binding.driverMessageId,
      inputBinding: binding,
    },
    productAcceptance: { status: "PASS", runtime: productRuntime, cases: [productCase] },
  };
  options.mutate?.(stage, result);
  return result;
}

function harness(overrides = {}) {
  const calls = [];
  const checkpoints = [];
  const options = {
    tokens: [...TOKENS],
    runIds: [...RUN_IDS],
    times: [BASE_TIME, BASE_TIME + 1],
    runtimes: [
      {
        checkout: "C:/acceptance/checkout",
        dataDirectory: "C:/acceptance/data",
        commit: runtime.expectedCommit,
        pid: 4321,
      },
      {
        checkout: "C:/acceptance/checkout",
        dataDirectory: "C:/acceptance/data",
        commit: runtime.expectedCommit,
        pid: 4321,
      },
    ],
    ...overrides,
  };
  return {
    calls,
    checkpoints,
    args: {
      config,
      executeStep: async (stage, spec) => {
        calls.push({ stage, spec });
        return accepted(stage, spec, calls.length - 1, options);
      },
      checkpoint: async (state) => {
        checkpoints.push(state);
        return options.checkpoint ? options.checkpoint(state, calls) : true;
      },
      signal: options.signal,
    },
  };
}

test("completes seed then private recall with distinct bound Runs and increasing input times", async () => {
  const h = harness();
  const result = await runHistorySeedWorkflow(h.args);
  assert.equal(result.status, "PASS");
  assert.deepEqual(result.stageRunIds, RUN_IDS);
  assert.deepEqual(
    h.calls.map((call) => call.stage),
    ["seed", "recall"],
  );
  assert.equal(h.calls[0].spec.id, "history-current-group-hit");
  assert.equal(h.calls[1].spec.id, "history-seed-recall");
  assert.match(h.calls[1].spec.prompt, new RegExp(`query=${TOKENS[0]}`));
  assert.equal(
    h.calls[1].spec.leaseTools[0].operations[0].inputConstraint.until,
    new Date(BASE_TIME * 1000).toISOString(),
  );
  assert.deepEqual(h.calls[1].spec.featureAssertions[3], {
    kind: "history_seed_result",
    tool: "owner_history_search",
    query: TOKENS[0],
    groupId: "20001",
    result: "hit",
    count: 1,
    sourceRunId: RUN_IDS[0],
    until: new Date(BASE_TIME * 1000).toISOString(),
  });
  assert.deepEqual(
    h.checkpoints.map(({ stage, phase }) => [stage, phase]),
    [
      ["seed", "intent"],
      ["seed", "verified"],
      ["recall", "intent"],
      ["recall", "verified"],
    ],
  );
});

test("a failed seed stops before recall", async () => {
  const h = harness({
    mutate(stage, result) {
      if (stage === "seed") result.transportCase.status = "FAIL";
    },
  });
  await assert.rejects(runHistorySeedWorkflow(h.args), { code: "HISTORY_SEED_WORKFLOW" });
  assert.deepEqual(
    h.calls.map((call) => call.stage),
    ["seed"],
  );
});

test("a failed recall is attempted once and never replayed", async () => {
  const h = harness({
    mutate(stage, result) {
      if (stage === "recall") result.productAcceptance.cases[0].traceVerified = false;
    },
  });
  await assert.rejects(runHistorySeedWorkflow(h.args), { code: "HISTORY_SEED_WORKFLOW" });
  assert.deepEqual(
    h.calls.map((call) => call.stage),
    ["seed", "recall"],
  );
});

test("rejects repeated marker, Run, input timestamp, and changed runtime", async (t) => {
  const cases = [
    ["same marker", { tokens: [TOKENS[0], TOKENS[0]] }],
    ["same Run", { runIds: [RUN_IDS[0], RUN_IDS[0]] }],
    ["same input time", { times: [BASE_TIME, BASE_TIME] }],
    [
      "changed runtime",
      {
        runtimes: [
          {
            checkout: "C:/acceptance/checkout",
            dataDirectory: "C:/acceptance/data",
            commit: runtime.expectedCommit,
            pid: 4321,
          },
          {
            checkout: "C:/acceptance/checkout",
            dataDirectory: "C:/acceptance/data",
            commit: runtime.expectedCommit,
            pid: 9999,
          },
        ],
      },
    ],
  ];
  for (const [name, options] of cases)
    await t.test(name, async () => {
      const h = harness(options);
      await assert.rejects(runHistorySeedWorkflow(h.args), { code: "HISTORY_SEED_WORKFLOW" });
      assert.deepEqual(
        h.calls.map((call) => call.stage),
        ["seed", "recall"],
      );
    });
});

test("rejects missing source evidence, wrong manifest, assertion, scope, or feature proof", async (t) => {
  const cases = [
    ["missing input binding", (_stage, result) => delete result.transportCase.inputBinding],
    [
      "wrong manifest",
      (_stage, result) => (result.transportCase.acceptanceLease.toolsSha256 = "f".repeat(64)),
    ],
    ["wrong assertions", (_stage, result) => result.transportCase.featureAssertions.pop()],
    [
      "wrong product scope",
      (_stage, result) => (result.productAcceptance.cases[0].scope.chatId = "20002"),
    ],
    [
      "unverified trace",
      (_stage, result) => (result.productAcceptance.cases[0].traceVerified = false),
    ],
    [
      "failed feature",
      (_stage, result) => (result.productAcceptance.cases[0].feature.status = "FAIL"),
    ],
    [
      "Owner reply predates Owner input",
      (_stage, result) => {
        const evidence = result.productAcceptance.cases[0];
        evidence.messageBinding.reply.driverTime = evidence.messageBinding.input.driverTime - 1;
      },
    ],
  ];
  for (const [name, mutate] of cases)
    await t.test(name, async () => {
      const h = harness({ mutate });
      await assert.rejects(runHistorySeedWorkflow(h.args), { code: "HISTORY_SEED_WORKFLOW" });
      assert.deepEqual(
        h.calls.map((call) => call.stage),
        ["seed"],
      );
    });
});

test("checkpoint failure blocks the corresponding send and later stage", async (t) => {
  await t.test("seed intent checkpoint", async () => {
    const h = harness({ checkpoint: () => false });
    await assert.rejects(runHistorySeedWorkflow(h.args));
    assert.equal(h.calls.length, 0);
  });
  await t.test("seed verified checkpoint", async () => {
    const h = harness({
      checkpoint: (state) => !(state.stage === "seed" && state.phase === "verified"),
    });
    await assert.rejects(runHistorySeedWorkflow(h.args));
    assert.deepEqual(
      h.calls.map((call) => call.stage),
      ["seed"],
    );
  });
});

test("abort before execution or after intent checkpoint sends no additional step", async (t) => {
  await t.test("already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const h = harness({ signal: controller.signal });
    await assert.rejects(runHistorySeedWorkflow(h.args), { code: "CANCELLED" });
    assert.equal(h.calls.length, 0);
  });
  await t.test("aborted by seed intent checkpoint", async () => {
    const controller = new AbortController();
    const h = harness({
      signal: controller.signal,
      checkpoint: (state) => {
        if (state.stage === "seed" && state.phase === "intent") controller.abort();
        return true;
      },
    });
    await assert.rejects(runHistorySeedWorkflow(h.args), { code: "CANCELLED" });
    assert.equal(h.calls.length, 0);
  });
});
