import test from "node:test";
import assert from "node:assert/strict";
import { digest, toolManifestDigest } from "../lib/core.mjs";
import { HISTORY_FAMILY_ID, verifyHistoryFamilyReport } from "../lib/history-family-evidence.mjs";
import { historyRecallSpec, historySeedSpec } from "../lib/history-scenario.mjs";

const config = {
  driver: { qq: "10002" },
  bot: { qq: "10003" },
  groups: [
    { alias: "A", id: "123" },
    { alias: "B", id: "124" },
  ],
  runtime: { connectionId: "p3-qq", threadId: null },
};
const runtime = {
  checkout: "C:/acceptance/checkout",
  dataDirectory: "C:/acceptance/data",
  commit: "d".repeat(40),
  pid: 1234,
  connectionId: "p3-qq",
  threadId: null,
};
const runIds = ["history_seed_run", "history_recall_run"];
const tokens = ["a".repeat(32), "b".repeat(32)];
const seedTime = Math.floor(Date.now() / 1000) - 10;
const times = [seedTime, seedTime + 5];
const replyHash = (token) => digest(`reply ${token}`);

function replace(value, token) {
  return JSON.parse(JSON.stringify(value).replaceAll("{{nonce}}", token));
}

function expectedObservations(assertions) {
  return assertions.map((assertion) => {
    if (assertion.kind === "trace")
      return { kind: "trace", type: assertion.type, count: assertion.count };
    if (assertion.kind === "history_coverage")
      return { kind: "history_coverage", coverage: "complete", returned: 1, sourceComplete: true };
    if (assertion.kind === "history_result")
      return {
        kind: "history_result",
        result: "hit",
        returned: 1,
        sourceVerified: true,
        toolOutputVerified: true,
      };
    if (assertion.kind === "history_seed_result")
      return {
        kind: "history_seed_result",
        result: "hit",
        returned: 1,
        sourceVerified: true,
        toolOutputVerified: true,
        distinctEarlierInput: true,
      };
    throw new Error("unexpected fixture assertion");
  });
}

function buildCase(spec, token, runId, index) {
  const leaseTools = replace(spec.leaseTools, token);
  const expected = replace(spec.expectContains, token);
  const assertions = replace(spec.featureAssertions, token);
  const prompt = `GLASSBOX_ACCEPTANCE_V1 ${token}\n${spec.prompt.replaceAll("{{nonce}}", token).trim()}`;
  const route =
    spec.chat === "private" ? "private" : config.groups.find((g) => g.alias === spec.chat).id;
  const binding = {
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
    time: times[index] + 1,
    textSha256: replyHash(token),
  };
  const caseReport = {
    id: spec.id,
    token,
    route,
    prompt,
    expected,
    startedAt: new Date((times[index] - 1) * 1000).toISOString(),
    sentMessageId: binding.driverMessageId,
    status: "PASS",
    inputBinding: binding,
    replies: [{ ...reply, matches: true }],
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
    chatType: spec.chat === "private" ? "private" : "group",
    chatId: spec.chat === "private" ? config.driver.qq : route,
    senderId: config.driver.qq,
    threadId: null,
  };
  const scopeKey = JSON.stringify([
    scope.connectionId,
    scope.botId,
    scope.chatType,
    scope.chatId,
    scope.senderId,
    scope.threadId,
  ]);
  const freshCase = {
    caseId: spec.id,
    runId,
    scope,
    traceVerified: true,
    feature: { status: "PASS", runId, observations: expectedObservations(assertions) },
    delivery: {
      id: `delivery_${index}`,
      status: "sent",
      external_id: reply.messageId,
      destination_scope_key: scopeKey,
    },
    messageBinding: { input: { ...binding }, reply: { ...reply } },
  };
  return { caseReport, freshCase, spec };
}

function fixture() {
  const seed = buildCase(historySeedSpec(config), tokens[0], runIds[0], 0);
  const recallSpec = historyRecallSpec({
    config,
    groupId: "123",
    seedInputTime: times[0],
    seedMarker: tokens[0],
    seedRunId: runIds[0],
  });
  const recall = buildCase(recallSpec, tokens[1], runIds[1], 1);
  const report = {
    status: "PASS",
    mode: "run",
    runtime: structuredClone(runtime),
    historyFamily: { caseId: HISTORY_FAMILY_ID },
    historySeedWorkflow: {
      status: "PASS",
      familyId: HISTORY_FAMILY_ID,
      stageRunIds: [...runIds],
      cleanup: { required: false, leaseRevoked: true },
    },
    cases: [seed.caseReport, recall.caseReport],
  };
  const fresh = {
    status: "PASS",
    runtime: structuredClone(runtime),
    cases: [seed.freshCase, recall.freshCase],
  };
  return { report, fresh };
}

const verifier = (fresh) => async () => structuredClone(fresh);

test("verifies the two fixed Runs and source-linked recall from fresh product evidence", async () => {
  const { report, fresh } = fixture();
  assert.deepEqual(
    await verifyHistoryFamilyReport(report, { config, verifyProduct: verifier(fresh) }),
    {
      status: "PASS",
      caseId: HISTORY_FAMILY_ID,
      runtime,
      stageRunIds: runIds,
      cleanup: { required: false, leaseRevoked: true },
    },
  );
});

test("rejects missing, reordered, duplicated, or altered seed family assertions", async () => {
  const mutations = [
    (f) => delete f.report.historyFamily,
    (f) => (f.report.historyFamily.caseId = "other-family"),
    (f) => (f.report.historySeedWorkflow.stageRunIds = [runIds[0], runIds[0]]),
    (f) => (f.report.historySeedWorkflow.cleanup.leaseRevoked = false),
    (f) => (f.report.cases[0].featureAssertions = []),
    (f) => (f.report.cases[1].featureAssertions[3].sourceRunId = "unrelated_run"),
    (f) => (f.report.cases[1].featureAssertions[3].query = "c".repeat(32)),
    (f) => (f.report.cases[1].featureAssertions[3].until = "2027-01-01T00:00:00.000Z"),
    (f) => (f.report.cases[1].acceptanceLease.toolsSha256 = "0".repeat(64)),
    (f) => f.report.cases.reverse(),
    (f) => (f.report.cases[1].token = f.report.cases[0].token),
    (f) => (f.report.cases[1].inputBinding.time = f.report.cases[0].inputBinding.time),
    (f) => (f.fresh.cases[1].runId = runIds[0]),
    (f) => (f.fresh.cases[1].scope.chatType = "group"),
    (f) => (f.fresh.cases[0].feature.status = "FAIL"),
  ];
  for (const mutate of mutations) {
    const f = fixture();
    mutate(f);
    await assert.rejects(
      verifyHistoryFamilyReport(f.report, { config, verifyProduct: verifier(f.fresh) }),
      { code: "HISTORY_FAMILY_EVIDENCE" },
    );
  }
});

test("rejects stale, changed, or failed fresh product verification", async () => {
  const { report, fresh } = fixture();
  for (const changed of [
    { ...fresh, runtime: { ...fresh.runtime, commit: "e".repeat(40) } },
    { ...fresh, cases: [fresh.cases[0]] },
    { ...fresh, cases: [fresh.cases[0], { ...fresh.cases[1], caseId: "other" }] },
  ])
    await assert.rejects(
      verifyHistoryFamilyReport(report, { config, verifyProduct: verifier(changed) }),
      { code: "HISTORY_FAMILY_EVIDENCE" },
    );
  await assert.rejects(
    verifyHistoryFamilyReport(report, {
      config,
      verifyProduct: async () => {
        throw new Error("failure");
      },
    }),
    { code: "HISTORY_FAMILY_EVIDENCE" },
  );
});
