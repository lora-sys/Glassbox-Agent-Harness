import test from "node:test";
import assert from "node:assert/strict";
import { digest, toolManifestDigest } from "../lib/core.mjs";
import { memoryFixtureStep } from "../lib/memory-scenario.mjs";
import { MEMORY_FAMILY_CASE_ID, verifyMemoryFamilyReport } from "../lib/memory-family-evidence.mjs";

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

function expectedCase(stage, index) {
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
    runId: runIds[index],
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
        messageId: String(40001 + index),
        realSequence: String(60001 + index),
        time: 1_800_000_010 + index,
        textSha256: replyTextSha256,
      },
    },
    traceVerified: true,
    feature: {
      status: "PASS",
      runId: runIds[index],
      observations: spec.featureAssertions.map((assertion) => ({
        kind: "trace",
        type: assertion.type,
        count: assertion.count,
      })),
    },
  };
  return { caseReport, productCase };
}

function fixture() {
  const reportRuntime = structuredClone(runtime);
  const productRuntime = structuredClone(runtime);
  const pairs = ["feedback", "promote", "expire"].map(expectedCase);
  const handles = {
    fixtureNonce: nonce,
    projectId: `qqtest-${nonce}`,
    principalId,
    candidateId,
    memoryId,
    creationRunId: runIds[0],
    promoteRunId: runIds[1],
    cleanupRunId: runIds[2],
    cleanupStatus: "expired",
    stepRunId: runIds[2],
  };
  const steps = ["feedback", "promote", "expire"].map((stage, index) => ({
    stage,
    currentRunId: runIds[index],
    runId: runIds[index],
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
    memoryFamily: { caseId: MEMORY_FAMILY_CASE_ID },
    cases: pairs.map((pair) => pair.caseReport),
    memoryLifecycle: {
      status: "PASS",
      stage: "expire",
      requiresReconciliation: false,
      handles,
      steps,
      cleanup: { status: "expired", runId: runIds[2] },
    },
  };
  const product = {
    status: "PASS",
    runtime: productRuntime,
    cases: pairs.map((pair) => pair.productCase),
  };
  const cleanup = { principalKind: "owner", status: "expired", ...handles };
  return { report, product, cleanup };
}

function verifiers(f) {
  return {
    verifyProduct: async () => structuredClone(f.product),
    readCleanup: async (handles) => {
      assert.deepEqual(handles, {
        projectId: `qqtest-${nonce}`,
        principalId,
        candidateId,
        memoryId,
        creationRunId: runIds[0],
        promoteRunId: runIds[1],
        cleanupRunId: runIds[2],
      });
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
