import test from "node:test";
import assert from "node:assert/strict";
import { digest, toolManifestDigest } from "../lib/core.mjs";
import {
  HISTORY_ISOLATION_FAMILY_ID,
  verifyHistoryIsolationFamilyReport,
} from "../lib/history-isolation-family-evidence.mjs";
import {
  historyExclusionSpec,
  historyIsolationSeedSpec,
} from "../lib/history-isolation-scenario.mjs";
import { Recorder } from "../lib/runner.mjs";

const config = {
  driver: { qq: "10002" },
  bot: { qq: "10003" },
  groups: [
    { alias: "A", id: "12345" },
    { alias: "B", id: "12456" },
  ],
  runtime: {
    checkout: "C:/acceptance/checkout",
    dataDirectory: "C:/acceptance/data",
    expectedCommit: "d".repeat(40),
    connectionId: "p3-qq",
    threadId: null,
  },
};
const runtime = {
  checkout: config.runtime.checkout,
  dataDirectory: config.runtime.dataDirectory,
  commit: config.runtime.expectedCommit,
  pid: 1234,
  connectionId: config.runtime.connectionId,
  threadId: null,
};
const runIds = ["isolation_seed_run", "isolation_exclusion_run"];
const tokens = ["a".repeat(32), "b".repeat(32)];
const sentinel = `qq-isolation-secret-${"c".repeat(32)}`;
const seedTime = Math.floor(Date.now() / 1000) - 20;
const times = [seedTime, seedTime + 10];

function replace(value, token) {
  return JSON.parse(JSON.stringify(value).replaceAll("{{nonce}}", token));
}

function expectedObservations(assertions, seed) {
  return assertions.map((assertion) => {
    if (assertion.kind === "trace")
      return { kind: "trace", type: assertion.type, count: assertion.count };
    if (assertion.kind === "history_coverage")
      return {
        kind: "history_coverage",
        coverage: "complete",
        returned: seed ? 1 : 0,
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
    if (assertion.kind === "history_exclusion_result")
      return {
        kind: "history_exclusion_result",
        result: "no_match",
        returned: 0,
        sourceVerified: true,
        exclusionVerified: true,
        toolOutputVerified: true,
      };
    throw new Error("unexpected fixture assertion");
  });
}

function buildCase(spec, token, runId, index, isSeed) {
  const leaseTools = replace(spec.leaseTools, token);
  const expected = replace(spec.expectContains, token);
  const assertions = replace(spec.featureAssertions, token);
  const prompt = `GLASSBOX_ACCEPTANCE_V1 ${token}\n${spec.prompt.replaceAll("{{nonce}}", token).trim()}`;
  const route =
    spec.chat === "private" ? "private" : config.groups.find((g) => g.alias === spec.chat).id;
  const inputBinding = {
    driverMessageId: String(-100 - index),
    botMessageId: String(-200 - index),
    realSequence: String(300 + index),
    time: times[index],
    textSha256: digest(prompt),
  };
  const reply = {
    route,
    messageId: String(-300 - index),
    realSequence: String(400 + index),
    time: Math.floor(Date.now() / 1000),
    textSha256: digest(`reply ${token}`),
  };
  const recorder = new Recorder(config);
  const recorded = recorder.begin(spec.id, route, spec.prompt, spec.expectContains, token);
  recorded.startedAt = new Date((times[index] - 1) * 1000).toISOString();
  recorded.startedMs = Date.parse(recorded.startedAt);
  recorded.sentMessageId = inputBinding.driverMessageId;
  recorder.ingest("driver", {
    self_id: config.driver.qq,
    post_type: "message",
    user_id: config.bot.qq,
    message_type: route === "private" ? "private" : "group",
    ...(route === "private" ? {} : { group_id: route }),
    message_id: reply.messageId,
    time: reply.time,
    message: [{ type: "text", data: { text: `reply ${token}` } }],
  });
  const caseReport = {
    id: spec.id,
    token,
    route,
    prompt,
    expected,
    startedAt: recorded.startedAt,
    sentMessageId: inputBinding.driverMessageId,
    status: "PASS",
    inputBinding,
    replies: structuredClone(recorded.replies),
    anomalies: [],
    featureAssertions: assertions,
    leasedToolNames: leaseTools.map((tool) => tool.name),
    acceptanceLease: {
      leaseId: `12345678-1234-1234-1234-${String(index + 1).padStart(12, "0")}`,
      expiresAt: (times[index] + 300) * 1000,
      toolsSha256: toolManifestDigest(leaseTools),
    },
    leaseRevoked: true,
  };
  const scope = {
    connectionId: runtime.connectionId,
    botId: config.bot.qq,
    chatType: isSeed ? "group" : "private",
    chatId: isSeed ? route : config.driver.qq,
    senderId: config.driver.qq,
    threadId: null,
  };
  const scopeKey = JSON.stringify([
    scope.connectionId,
    scope.botId,
    scope.chatType,
    scope.chatId,
    scope.senderId,
    null,
  ]);
  const botReplyId = String(-400 - index);
  const freshCase = {
    caseId: spec.id,
    runId,
    scope,
    traceVerified: true,
    feature: {
      status: "PASS",
      runId,
      observations: expectedObservations(assertions, isSeed),
    },
    delivery: {
      id: `delivery_${index}`,
      status: "sent",
      external_id: botReplyId,
      destination_scope_key: scopeKey,
    },
    messageBinding: {
      input: {
        realSequence: inputBinding.realSequence,
        time: inputBinding.time,
        textSha256: inputBinding.textSha256,
      },
      reply: {
        botMessageId: botReplyId,
        driverMessageId: reply.messageId,
        realSequence: reply.realSequence,
        time: reply.time,
        textSha256: reply.textSha256,
      },
    },
  };
  return { caseReport, freshCase };
}

function fixture() {
  const seedSpec = historyIsolationSeedSpec({ config, sentinel });
  const seed = buildCase(seedSpec, tokens[0], runIds[0], 0, true);
  const exclusionSpec = historyExclusionSpec({
    config,
    sourceGroupId: "12456",
    seedMarker: tokens[0],
    sentinel,
    sourceRunId: runIds[0],
    seedInputTime: times[0],
  });
  const exclusion = buildCase(exclusionSpec, tokens[1], runIds[1], 1, false);
  const report = {
    status: "PASS",
    mode: "run",
    runtime: structuredClone(runtime),
    historyFamily: { caseId: HISTORY_ISOLATION_FAMILY_ID },
    historyIsolationWorkflow: {
      status: "PASS",
      familyId: HISTORY_ISOLATION_FAMILY_ID,
      stageRunIds: [...runIds],
      cleanup: { required: false, leaseRevoked: true },
    },
    cases: [seed.caseReport, exclusion.caseReport],
  };
  const fresh = {
    status: "PASS",
    runtime: structuredClone(runtime),
    cases: [seed.freshCase, exclusion.freshCase],
  };
  return { report, fresh };
}

const verifier = (fresh) => async () => structuredClone(fresh);

test("verifies B seed then Owner-private A exclusion from fresh product evidence", async () => {
  const { report, fresh } = fixture();
  assert.equal(Object.hasOwn(report.cases[0].replies[0], "realSequence"), false);
  assert.equal(Object.hasOwn(report.cases[0].replies[0], "time"), false);
  assert.deepEqual(
    await verifyHistoryIsolationFamilyReport(report, { config, verifyProduct: verifier(fresh) }),
    {
      status: "PASS",
      caseId: HISTORY_ISOLATION_FAMILY_ID,
      runtime,
      stageRunIds: runIds,
      cleanup: { required: false, leaseRevoked: true },
    },
  );
});

test("rejects altered family, workflow, fixed assertions, sentinel and case order", async () => {
  const mutations = [
    (f) => delete f.report.historyFamily,
    (f) => (f.report.historyFamily.caseId = "other-family"),
    (f) => delete f.report.historyIsolationWorkflow,
    (f) => (f.report.historyIsolationWorkflow.stageRunIds = [runIds[0], runIds[0]]),
    (f) => (f.report.historyIsolationWorkflow.cleanup.leaseRevoked = false),
    (f) => (f.report.cases[0].featureAssertions = []),
    (f) => (f.report.cases[0].prompt = f.report.cases[0].prompt.replace(sentinel, "removed")),
    (f) => (f.report.cases[1].featureAssertions[3].sourceRunId = "unrelated_run"),
    (f) => (f.report.cases[1].featureAssertions[3].sentinelSha256 = "0".repeat(64)),
    (f) => delete f.report.cases[1].replies[0].textBytes,
    (f) => delete f.report.cases[1].replies[0].receivedAt,
    (f) => f.report.cases.reverse(),
    (f) => (f.report.cases[1].acceptanceLease.toolsSha256 = "0".repeat(64)),
    (f) => (f.report.cases[1].leaseRevoked = false),
  ];
  for (const mutate of mutations) {
    const f = fixture();
    mutate(f);
    await assert.rejects(
      verifyHistoryIsolationFamilyReport(f.report, { config, verifyProduct: verifier(f.fresh) }),
      { code: "HISTORY_ISOLATION_FAMILY_EVIDENCE" },
    );
  }
});

test("requires fresh source, exclusion, Owner scopes, ordered QQ inputs and shared runtime", async () => {
  const changes = [
    (f) => (f.fresh.cases[0].feature.observations[3].returned = 0),
    (f) => (f.fresh.cases[1].feature.observations[3].sourceVerified = false),
    (f) => (f.fresh.cases[1].feature.observations[3].exclusionVerified = false),
    (f) => (f.fresh.cases[1].scope.chatType = "group"),
    (f) => (f.fresh.cases[1].runId = runIds[0]),
    (f) => (f.fresh.cases[1].messageBinding.input.time = times[0]),
    (f) => (f.fresh.runtime.commit = "e".repeat(40)),
    (f) => (f.report.runtime.commit = "e".repeat(40)),
  ];
  for (const change of changes) {
    const f = fixture();
    change(f);
    await assert.rejects(
      verifyHistoryIsolationFamilyReport(f.report, { config, verifyProduct: verifier(f.fresh) }),
      { code: "HISTORY_ISOLATION_FAMILY_EVIDENCE" },
    );
  }
});

test("checks bot and driver QQ reply IDs separately against fresh delivery metadata", async () => {
  const f = fixture();
  assert.notEqual(
    f.fresh.cases[0].messageBinding.reply.botMessageId,
    f.fresh.cases[0].messageBinding.reply.driverMessageId,
  );
  for (const mutate of [
    (freshCase) => delete freshCase.messageBinding.reply.botMessageId,
    (freshCase) => (freshCase.messageBinding.reply.botMessageId = "not-an-id"),
    (freshCase) => (freshCase.messageBinding.reply.botMessageId = "-999"),
    (freshCase) => delete freshCase.messageBinding.reply.driverMessageId,
    (freshCase) => (freshCase.messageBinding.reply.driverMessageId = "not-an-id"),
    (freshCase) => (freshCase.messageBinding.reply.driverMessageId = "-999"),
  ]) {
    const changed = structuredClone(f.fresh);
    mutate(changed.cases[0]);
    await assert.rejects(
      verifyHistoryIsolationFamilyReport(f.report, { config, verifyProduct: verifier(changed) }),
      { code: "HISTORY_ISOLATION_FAMILY_EVIDENCE" },
    );
  }
});

test("rejects unavailable fresh product evidence", async () => {
  const { report } = fixture();
  await assert.rejects(
    verifyHistoryIsolationFamilyReport(report, {
      config,
      verifyProduct: async () => ({ status: "FAIL" }),
    }),
    { code: "HISTORY_ISOLATION_FAMILY_EVIDENCE" },
  );
});
