import test from "node:test";
import assert from "node:assert/strict";
import { digest, toolManifestDigest } from "../lib/core.mjs";
import { tasteFixtureStep, TASTE_FAMILY_ID } from "../lib/taste-scenario.mjs";
import { verifyTasteFamilyReport } from "../lib/taste-family-evidence.mjs";

const nonce = "1".repeat(32);
const ids = {
  fixtureNonce: nonce,
  projectId: `qqtest-${nonce}`,
  principalId: "owner-1",
  candidateId: `candidate_${"2".repeat(32)}`,
  memoryId: `memory_${"3".repeat(32)}`,
  correctionCandidateId: `candidate_${"4".repeat(32)}`,
  creationRunId: "run-1",
  promotionRunId: "run-2",
  negativeRunId: "run-3",
  cleanupRunId: "run-4",
  stepRunId: "run-4",
};
const stages = ["feedback", "promote", "negative-feedback", "retire"];
const runtime = {
  checkout: "/candidate",
  dataDirectory: "/acceptance",
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

function fixture() {
  const cases = stages.map((stage, index) => {
    const token = String(index + 1).repeat(32);
    const spec = tasteFixtureStep(stage, {
      nonce,
      candidateId: ids.candidateId,
      memoryId: ids.memoryId,
      correctionCandidateId: ids.correctionCandidateId,
    });
    const prompt = `GLASSBOX_ACCEPTANCE_V1 ${token}\n${spec.prompt.replaceAll("{{nonce}}", token).trim()}`;
    const binding = {
      driverMessageId: String(10 + index),
      botMessageId: String(20 + index),
      realSequence: String(100 + index),
      time: 1000 + index,
      textSha256: digest(prompt),
    };
    return {
      id: spec.id,
      status: "PASS",
      route: "private",
      inputObserved: true,
      botInputMessageId: binding.botMessageId,
      sentMessageId: binding.driverMessageId,
      token,
      prompt,
      expected: spec.expectContains.map((value) => value.replaceAll("{{nonce}}", token)),
      featureAssertions: spec.featureAssertions,
      leasedToolNames: ["owner_memory_admin"],
      leaseRevoked: true,
      acceptanceLease: {
        leaseId: `00000000-0000-4000-8000-00000000000${index + 1}`,
        expiresAt: Date.now() + 60_000,
        toolsSha256: toolManifestDigest(spec.leaseTools),
      },
      inputBinding: binding,
      replies: [
        {
          route: "private",
          matches: true,
          textSha256: "c".repeat(64),
          messageId: String(30 + index),
        },
      ],
      anomalies: [],
      startedAt: new Date().toISOString(),
      runId: `run-${index + 1}`,
    };
  });
  const finalObservation = {
    principalId: ids.principalId,
    principalKind: "owner",
    projectId: ids.projectId,
    stepRunId: ids.cleanupRunId,
    creationRunId: ids.creationRunId,
    candidateId: ids.candidateId,
    promotionRunId: ids.promotionRunId,
    memoryId: ids.memoryId,
    negativeRunId: ids.negativeRunId,
    correctionCandidateId: ids.correctionCandidateId,
    cleanupRunId: ids.cleanupRunId,
    lifecycleState: "retired",
    correctionStatus: "promoted",
    activeCount: 0,
    pendingCount: 0,
  };
  const report = {
    mode: "run",
    status: "PASS",
    runtime,
    productAcceptance: { status: "PASS" },
    tasteFamily: { familyId: TASTE_FAMILY_ID },
    cases,
    tasteLifecycle: {
      status: "PASS",
      requiresReconciliation: false,
      handles: ids,
      steps: stages.map((stage, index) => ({
        stage,
        runId: `run-${index + 1}`,
        transportCase: cases[index],
        productAcceptance: {
          status: "PASS",
          runtime,
          cases: [
            {
              caseId: cases[index].id,
              runId: `run-${index + 1}`,
              traceVerified: true,
              cleanupVerified: true,
              feature: { status: "PASS" },
            },
          ],
        },
        observation: index === stages.length - 1 ? finalObservation : {},
      })),
    },
  };
  const verifyProduct = async ({ cases: [c] }) => ({
    status: "PASS",
    runtime,
    cases: [
      {
        caseId: c.id,
        runId: c.runId,
        traceVerified: true,
        cleanupVerified: true,
        feature: { status: "PASS", runId: c.runId },
        scope: {
          connectionId: "qq-connection",
          botId: "bot-1",
          chatType: "private",
          chatId: "owner-1",
          senderId: "owner-1",
          threadId: null,
        },
        delivery: {
          status: "sent",
          external_id: String(Number(c.inputBinding.botMessageId) + 10),
          destination_scope_key: JSON.stringify([
            "qq-connection",
            "bot-1",
            "private",
            "owner-1",
            "owner-1",
            null,
          ]),
        },
        messageBinding: {
          input: c.inputBinding,
          reply: {
            botMessageId: String(Number(c.inputBinding.botMessageId) + 10),
            driverMessageId: c.replies[0].messageId,
            realSequence: String(Number(c.inputBinding.realSequence) + 10),
            time: c.inputBinding.time + 10,
            textSha256: c.replies[0].textSha256,
          },
        },
      },
    ],
  });
  return { report, finalObservation, verifyProduct };
}

test("Taste family verifier rechecks four distinct Runs and final independent fixture state", async () => {
  const f = fixture();
  let productCalls = 0;
  const result = await verifyTasteFamilyReport(f.report, {
    verifyProduct: async (...args) => {
      productCalls += 1;
      return f.verifyProduct(...args);
    },
    config,
    readFixture: async (input) => {
      assert.equal(input.stage, "retire");
      assert.equal(input.stepRunId, ids.cleanupRunId);
      return f.finalObservation;
    },
    readRuntime: async () => runtime,
  });
  assert.equal(result.status, "PASS");
  assert.deepEqual(result.stageRunIds, ["run-1", "run-2", "run-3", "run-4"]);
  assert.equal(productCalls, 4);
});

test("Taste family verifier rejects Run reuse and a changed final database read", async () => {
  const reused = fixture();
  reused.report.cases[3].runId = "run-3";
  await assert.rejects(
    verifyTasteFamilyReport(reused.report, {
      verifyProduct: reused.verifyProduct,
      config,
      readFixture: async () => reused.finalObservation,
      readRuntime: async () => runtime,
    }),
    { code: "TASTE_FAMILY_EVIDENCE" },
  );

  const changed = fixture();
  await assert.rejects(
    verifyTasteFamilyReport(changed.report, {
      verifyProduct: changed.verifyProduct,
      config,
      readFixture: async () => ({ ...changed.finalObservation, activeCount: 1 }),
      readRuntime: async () => runtime,
    }),
    { code: "TASTE_FAMILY_EVIDENCE" },
  );
});

test("Taste family verifier binds distinct reply identities and rechecks Runtime after the final read", async () => {
  for (const mutate of [
    (reply) => (reply.driverMessageId = "999"),
    (reply) => (reply.realSequence = "not-a-sequence"),
    (reply) => (reply.time = -1),
  ]) {
    const f = fixture();
    await assert.rejects(
      verifyTasteFamilyReport(f.report, {
        config,
        verifyProduct: async ({ cases }) => {
          const proof = await f.verifyProduct({ cases });
          mutate(proof.cases[0].messageBinding.reply);
          return proof;
        },
        readFixture: async () => f.finalObservation,
        readRuntime: async () => runtime,
      }),
      { code: "TASTE_FAMILY_EVIDENCE" },
    );
  }

  const f = fixture();
  let reads = 0;
  await assert.rejects(
    verifyTasteFamilyReport(f.report, {
      config,
      verifyProduct: f.verifyProduct,
      readFixture: async () => f.finalObservation,
      readRuntime: async () => ({ ...runtime, ...(reads++ ? { pid: 321 } : {}) }),
    }),
    { code: "TASTE_FAMILY_EVIDENCE" },
  );
});
