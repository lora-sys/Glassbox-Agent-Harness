import test from "node:test";
import assert from "node:assert/strict";
import { digest, toolManifestDigest } from "../lib/core.mjs";
import { memoryFixtureStep } from "../lib/memory-scenario.mjs";
import {
  MEMORY_FAMILY_CASE_ID,
  MEMORY_REJECT_FAMILY_CASE_ID,
  verifyMemoryFamilyReport,
} from "../lib/memory-family-evidence.mjs";
import { memoryWorkflow } from "../lib/memory-workflow.mjs";

const nonce = "a".repeat(32);
const principalId = "owner_fixture";
const candidateId = `candidate_${"b".repeat(32)}`;
const memoryId = `memory_${"c".repeat(32)}`;
const runIds = ["run_feedback", "run_promote", "run_expire"];
const runtime = {
  checkout: "C:/acceptance/checkout",
  dataDirectory: "C:/acceptance/data",
  commit: "d".repeat(40),
  pid: 1234,
  connectionId: "fixture_connection",
  threadId: null,
};
const scope = {
  connectionId: runtime.connectionId,
  botId: "22222",
  chatType: "private",
  chatId: "11111",
  senderId: "11111",
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

function expectedCase(stage, index, stageRunIds = runIds) {
  const token = String(index + 1).repeat(32);
  const spec = memoryFixtureStep(stage, { nonce, candidateId, memoryId });
  const replace = (value) => JSON.parse(JSON.stringify(value).replaceAll("{{nonce}}", token));
  const prompt = `GLASSBOX_ACCEPTANCE_V1 ${token}\n${spec.prompt.replaceAll("{{nonce}}", token).trim()}`;
  const replyTextSha256 = digest(`reply ${token}`);
  const caseScope = structuredClone(scope);
  const binding = {
    driverMessageId: String(10001 + index),
    botMessageId: String(20001 + index),
    realSequence: String(30001 + index),
    time: 1_800_000_000 + index,
    textSha256: digest(prompt),
  };
  const caseReport = {
    id: spec.id,
    token,
    route: "private",
    prompt,
    expected: replace(spec.expectContains),
    startedAt: "2026-10-06T00:00:00.000Z",
    sentMessageId: binding.driverMessageId,
    status: "PASS",
    inputBinding: binding,
    replies: [
      {
        route: "private",
        messageId: String(40001 + index),
        textSha256: replyTextSha256,
        textBytes: 40,
        matches: true,
        receivedAt: "2026-10-06T00:00:01.000Z",
      },
    ],
    anomalies: [],
    featureAssertions: replace(spec.featureAssertions),
    leasedToolNames: ["owner_memory_admin"],
    acceptanceLease: {
      leaseId: `12345678-1234-1234-1234-${String(index + 1).padStart(12, "0")}`,
      expiresAt: Date.parse("2026-10-06T00:01:00.000Z"),
      toolsSha256: toolManifestDigest(replace(spec.leaseTools)),
    },
    leaseRevoked: true,
  };
  const productCase = {
    caseId: spec.id,
    runId: stageRunIds[index],
    scope: caseScope,
    delivery: {
      id: `delivery-${index + 1}`,
      status: "sent",
      external_id: String(50001 + index),
      destination_scope_key: scopeKey,
    },
    messageBinding: {
      input: {
        realSequence: binding.realSequence,
        time: binding.time,
        textSha256: binding.textSha256,
      },
      reply: {
        botMessageId: String(50001 + index),
        driverMessageId: String(40001 + index),
        realSequence: String(60001 + index),
        time: 1_800_000_010 + index,
        textSha256: replyTextSha256,
      },
    },
    traceVerified: true,
    feature: {
      status: "PASS",
      runId: stageRunIds[index],
      observations: spec.featureAssertions.map((assertion) => ({
        kind: "trace",
        type: assertion.type,
        count: assertion.count,
      })),
    },
  };
  return { caseReport, productCase };
}

function fixture(familyId = MEMORY_FAMILY_CASE_ID) {
  const workflow = memoryWorkflow(familyId);
  const reportRuntime = structuredClone(runtime);
  const productRuntime = structuredClone(runtime);
  const stageRunIds = familyId === MEMORY_FAMILY_CASE_ID ? runIds : ["run_feedback", "run_reject"];
  const promoted = workflow.stages.includes("promote");
  const cleanupInput = {
    projectId: `qqtest-${nonce}`,
    principalId,
    candidateId,
    creationRunId: stageRunIds[0],
    cleanupRunId: stageRunIds.at(-1),
    ...(promoted
      ? { memoryId, promoteRunId: stageRunIds[workflow.stages.indexOf("promote")] }
      : {}),
  };
  const pairs = workflow.stages.map((stage, index) => expectedCase(stage, index, stageRunIds));
  const handles = {
    fixtureNonce: nonce,
    ...cleanupInput,
    cleanupStatus: workflow.cleanupStatus,
    stepRunId: stageRunIds.at(-1),
  };
  const steps = workflow.stages.map((stage, index) => ({
    stage,
    currentRunId: stageRunIds[index],
    runId: stageRunIds[index],
    productAcceptance: {
      status: "PASS",
      runtime: structuredClone(reportRuntime),
      caseId: `memory-${stage}`,
      traceVerified: true,
      featureStatus: "PASS",
    },
  }));
  const report = {
    mode: "run",
    status: "PASS",
    runtime: reportRuntime,
    productAcceptance: { status: "PASS" },
    memoryFamily: { caseId: familyId },
    cases: pairs.map((pair) => pair.caseReport),
    memoryLifecycle: {
      status: "PASS",
      stage: workflow.stages.at(-1),
      requiresReconciliation: false,
      handles,
      steps,
      cleanup: { status: workflow.cleanupStatus, runId: stageRunIds.at(-1) },
    },
  };
  const product = {
    status: "PASS",
    runtime: productRuntime,
    cases: pairs.map((pair) => pair.productCase),
  };
  const cleanup = { principalKind: "owner", status: workflow.cleanupStatus, ...cleanupInput };
  return { report, product, cleanup, cleanupInput, stageRunIds, workflow };
}

function verifiers(f) {
  return {
    verifyProduct: async () => structuredClone(f.product),
    readCleanup: async (handles) => {
      assert.deepEqual(handles, f.cleanupInput);
      return structuredClone(f.cleanup);
    },
  };
}

async function rejected(f, code = "MEMORY_FAMILY_EVIDENCE") {
  await assert.rejects(
    verifyMemoryFamilyReport(f.report, verifiers(f)),
    (error) => error.code === code,
  );
}

test("verifies a fixed three-step Memory family against fresh product and cleanup evidence", async () => {
  const f = fixture();
  const result = await verifyMemoryFamilyReport(f.report, verifiers(f));
  assert.deepEqual(result, {
    status: "PASS",
    caseId: MEMORY_FAMILY_CASE_ID,
    runtime,
    handles: {
      fixtureNonce: nonce,
      projectId: `qqtest-${nonce}`,
      principalId,
      candidateId,
      memoryId,
      creationRunId: runIds[0],
      promoteRunId: runIds[1],
      cleanupRunId: runIds[2],
    },
    stageRunIds: runIds,
    cleanup: {
      principalKind: "owner",
      status: "expired",
      projectId: `qqtest-${nonce}`,
      principalId,
      candidateId,
      memoryId,
      creationRunId: runIds[0],
      promoteRunId: runIds[1],
      cleanupRunId: runIds[2],
    },
  });
});

test("verifies the fixed feedback-reject family with rejected cleanup and no promotion handles", async () => {
  const f = fixture(MEMORY_REJECT_FAMILY_CASE_ID);
  const result = await verifyMemoryFamilyReport(f.report, verifiers(f));
  assert.deepEqual(result, {
    status: "PASS",
    caseId: MEMORY_REJECT_FAMILY_CASE_ID,
    runtime,
    handles: {
      fixtureNonce: nonce,
      ...f.cleanupInput,
    },
    stageRunIds: f.stageRunIds,
    cleanup: {
      principalKind: "owner",
      status: "rejected",
      ...f.cleanupInput,
    },
  });
  assert.equal(Object.hasOwn(result.handles, "memoryId"), false);
  assert.equal(Object.hasOwn(result.handles, "promoteRunId"), false);
});

test("rejects cleanup-only or incomplete lifecycle reports", async () => {
  const f = fixture();
  f.report.cleanupOnly = true;
  await rejected(f);
  const g = fixture();
  g.report.memoryLifecycle.steps.pop();
  await rejected(g);
});

test("rejects stale PASS when fresh product verification fails", async () => {
  const f = fixture();
  let called = 0;
  await assert.rejects(
    verifyMemoryFamilyReport(f.report, {
      ...verifiers(f),
      verifyProduct: async () => {
        called++;
        return { ...f.product, status: "INCONCLUSIVE" };
      },
    }),
  );
  assert.equal(called, 1);
});

test("rejects duplicated Runs and stale per-step runtime snapshots", async () => {
  const f = fixture();
  f.product.cases[2].runId = runIds[1];
  await rejected(f);
  const g = fixture();
  g.report.memoryLifecycle.steps[1].productAcceptance.runtime.pid++;
  await rejected(g);
});

test("rejects modified input, fixed Tool assertions, and unrevoked lease", async () => {
  for (const mutate of [
    (f) => (f.report.cases[0].prompt += " unrelated"),
    (f) => (f.report.cases[1].featureAssertions[0].where.isError = true),
    (f) => (f.report.cases[2].leaseRevoked = false),
  ]) {
    const f = fixture();
    mutate(f);
    await rejected(f);
  }
});

test("rejects wrong private scope, delivery destination, and input binding", async () => {
  for (const mutate of [
    (f) => (f.product.cases[0].scope.connectionId = "other_connection"),
    (f) => (f.product.cases[1].delivery.destination_scope_key = "[]"),
    (f) => (f.product.cases[2].messageBinding.input.textSha256 = "f".repeat(64)),
  ]) {
    const f = fixture();
    mutate(f);
    await rejected(f);
  }
});

test("rejects unknown cleanup state and cross-resource cleanup rows", async () => {
  const f = fixture();
  f.cleanup.status = "unknown";
  await rejected(f);
  const g = fixture();
  g.cleanup.memoryId = `memory_${"e".repeat(32)}`;
  await rejected(g);
});

test("reject family rejects an unknown workflow, wrong stages, and reused Runs", async () => {
  const unknown = fixture(MEMORY_REJECT_FAMILY_CASE_ID);
  unknown.report.memoryFamily.caseId = "custom-memory-family";
  await rejected(unknown);
  const wrongStage = fixture(MEMORY_REJECT_FAMILY_CASE_ID);
  wrongStage.report.cases[1].id = "memory-promote";
  await rejected(wrongStage);
  const reusedRun = fixture(MEMORY_REJECT_FAMILY_CASE_ID);
  reusedRun.product.cases[1].runId = reusedRun.product.cases[0].runId;
  await rejected(reusedRun);
});

test("reject family requires exact Owner candidate lineage, rejected status, and callbacks", async () => {
  for (const mutate of [
    (f) => (f.cleanup.candidateId = `candidate_${"e".repeat(32)}`),
    (f) => (f.cleanup.principalKind = "visitor"),
    (f) => (f.cleanup.status = "expired"),
    (f) => (f.cleanup.memoryId = memoryId),
    (f) => (f.cleanup.promoteRunId = "run_promote"),
    (f) => (f.report.memoryLifecycle.handles.memoryId = memoryId),
    (f) => (f.report.memoryLifecycle.handles.promoteRunId = "run_promote"),
  ]) {
    const f = fixture(MEMORY_REJECT_FAMILY_CASE_ID);
    mutate(f);
    await rejected(f);
  }
  const f = fixture(MEMORY_REJECT_FAMILY_CASE_ID);
  await assert.rejects(
    verifyMemoryFamilyReport(f.report, { verifyProduct: async () => f.product }),
    {
      code: "MEMORY_FAMILY_EVIDENCE",
      status: "INCONCLUSIVE",
    },
  );
});

test("Memory reply proof keeps distinct Bot and Owner local IDs and rejects either mismatch", async () => {
  const f = fixture();
  assert.notEqual(
    f.product.cases[0].messageBinding.reply.botMessageId,
    f.product.cases[0].messageBinding.reply.driverMessageId,
  );
  await verifyMemoryFamilyReport(f.report, verifiers(f));
  for (const field of ["botMessageId", "driverMessageId"]) {
    const changed = fixture();
    changed.product.cases[0].messageBinding.reply[field] = "99999";
    await rejected(changed);
  }
  const absent = fixture();
  delete absent.product.cases[0].messageBinding.reply.botMessageId;
  await rejected(absent);
});
