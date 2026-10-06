import test from "node:test";
import assert from "node:assert/strict";
import { digest, toolManifestDigest } from "../lib/core.mjs";
import { runTasteLifecycle } from "../lib/taste-lifecycle.mjs";
import { verifyTasteFamilyReport } from "../lib/taste-family-evidence.mjs";
import { TASTE_FAMILY_ID } from "../lib/taste-scenario.mjs";

const fixtureNonce = "1".repeat(32);
const candidateId = `candidate_${"2".repeat(32)}`;
const memoryId = `memory_${"3".repeat(32)}`;
const correctionCandidateId = `candidate_${"4".repeat(32)}`;
const runtime = {
  checkout: "/candidate",
  dataDirectory: "/disposable",
  commit: "a".repeat(40),
  pid: 123,
  connectionId: "qq-connection",
  threadId: null,
};
const config = {
  runtime,
  driver: { qq: "owner-1" },
  bot: { qq: "bot-1" },
};

function makeExecution(stage, spec, index) {
  const token = String(index + 1).repeat(32);
  const tools = JSON.parse(JSON.stringify(spec.leaseTools).replaceAll("{{nonce}}", token));
  const prompt = `GLASSBOX_ACCEPTANCE_V1 ${token}\n${spec.prompt
    .replaceAll("{{nonce}}", token)
    .trim()}`;
  const input = {
    driverMessageId: String(10 + index),
    botMessageId: String(20 + index),
    realSequence: String(100 + index),
    time: 1000 + index,
    textSha256: digest(prompt),
  };
  const reply = {
    route: "private",
    matches: true,
    textSha256: digest(`reply-${stage}`),
    messageId: String(30 + index),
  };
  const runId = `run-${index + 1}`;
  const transportCase = {
    id: spec.id,
    status: "PASS",
    code: "PASS",
    route: "private",
    inputObserved: true,
    sentMessageId: input.driverMessageId,
    botInputMessageId: input.botMessageId,
    token,
    prompt,
    expected: spec.expectContains.map((value) => value.replaceAll("{{nonce}}", token)),
    featureAssertions: JSON.parse(
      JSON.stringify(spec.featureAssertions).replaceAll("{{nonce}}", token),
    ),
    leasedToolNames: tools.map((tool) => tool.name),
    leaseRevoked: true,
    acceptanceLease: {
      leaseId: `00000000-0000-4000-8000-00000000000${index + 1}`,
      expiresAt: 200_000,
      toolsSha256: toolManifestDigest(tools),
    },
    inputBinding: input,
    replies: [reply],
    anomalies: [],
    startedAt: new Date(1_000 + index).toISOString(),
    runId,
  };
  const scope = {
    connectionId: runtime.connectionId,
    botId: config.bot.qq,
    chatType: "private",
    chatId: config.driver.qq,
    senderId: config.driver.qq,
    threadId: null,
  };
  const replyBinding = {
    botMessageId: String(30 + index),
    driverMessageId: reply.messageId,
    realSequence: String(110 + index),
    time: 1010 + index,
    textSha256: reply.textSha256,
  };
  const productAcceptance = {
    status: "PASS",
    runtime,
    cases: [
      {
        caseId: spec.id,
        runId,
        traceVerified: true,
        cleanupVerified: true,
        feature: { status: "PASS", runId },
        scope,
        messageBinding: { input, reply: replyBinding },
        delivery: {
          status: "sent",
          external_id: replyBinding.botMessageId,
          destination_scope_key: JSON.stringify([
            scope.connectionId,
            scope.botId,
            scope.chatType,
            scope.chatId,
            scope.senderId,
            scope.threadId,
          ]),
        },
      },
    ],
  };
  return { transportCase, productAcceptance };
}

async function makeReport() {
  const stages = [];
  const observations = [];
  const lifecycle = await runTasteLifecycle({
    fixtureNonce,
    readRuntime: async () => runtime,
    checkpoint: async () => ({ confirmed: true }),
    executeStep: async (stage, spec) => {
      const result = makeExecution(stage, spec, stages.length);
      stages.push(result);
      return result;
    },
    observeStep: async (stage, handles) => {
      const index = observations.length;
      const runId = `run-${index + 1}`;
      const observation = {
        ...handles,
        stage,
        principalKind: "owner",
        principalId: "owner-1",
        projectId: `qqtest-${fixtureNonce}`,
        stepRunId: runId,
        candidateId,
        creationRunId: "run-1",
        candidateStatus: stage === "feedback" ? "pending" : "promoted",
        ...(index >= 1 ? { promotionRunId: "run-2", memoryId, lifecycleState: "active" } : {}),
        ...(index >= 2
          ? {
              negativeRunId: "run-3",
              correctionCandidateId,
              correctionStatus: stage === "retire" ? "promoted" : "pending",
            }
          : {}),
        ...(stage === "retire"
          ? {
              cleanupRunId: "run-4",
              lifecycleState: "retired",
              activeCount: 0,
              pendingCount: 0,
            }
          : {}),
      };
      observations.push(observation);
      return observation;
    },
  });
  const report = {
    mode: "run",
    status: lifecycle.status,
    runtime,
    productAcceptance: { status: "PASS" },
    tasteFamily: { familyId: TASTE_FAMILY_ID },
    cases: stages.map(({ transportCase }) => transportCase),
    tasteLifecycle: lifecycle,
  };
  return { report, stages, observations };
}

function verifierCallbacks(fixture, readRuntime = async () => runtime) {
  return {
    config,
    readRuntime,
    readFixture: async (input) => {
      assert.equal(input.stage, "retire");
      assert.equal(input.stepRunId, "run-4");
      return fixture.observations.at(-1);
    },
    verifyProduct: async ({ cases: [transportCase] }) => {
      const step = fixture.stages.find((candidate) => candidate.transportCase === transportCase);
      assert.ok(step, "family verifier must recheck the coordinator's actual transport case");
      return step.productAcceptance;
    },
  };
}

test("actual Taste coordinator output passes the family verifier production contract", async () => {
  const fixture = await makeReport();
  assert.equal(fixture.report.tasteLifecycle.status, "PASS");
  assert.equal(fixture.report.tasteLifecycle.steps.length, 4);
  for (const step of fixture.report.tasteLifecycle.steps) {
    assert.deepEqual(Object.keys(step).sort(), [
      "observation",
      "productAcceptance",
      "runId",
      "stage",
      "transportCase",
    ]);
    assert.deepEqual(Object.keys(step.productAcceptance).sort(), ["cases", "runtime", "status"]);
    assert.equal(step.productAcceptance.cases.length, 1);
  }
  const evidence = await verifyTasteFamilyReport(fixture.report, verifierCallbacks(fixture));
  assert.equal(evidence.status, "PASS");
  assert.deepEqual(evidence.stageRunIds, ["run-1", "run-2", "run-3", "run-4"]);
});

test("actual Taste coordinator output is rejected if Runtime changes during final verification", async () => {
  const fixture = await makeReport();
  let reads = 0;
  await assert.rejects(
    verifyTasteFamilyReport(
      fixture.report,
      verifierCallbacks(fixture, async () => (reads++ === 0 ? runtime : { ...runtime, pid: 456 })),
    ),
    { code: "TASTE_FAMILY_EVIDENCE" },
  );
  assert.ok(reads >= 2);
});
