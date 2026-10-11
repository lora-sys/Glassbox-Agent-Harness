import test from "node:test";
import assert from "node:assert/strict";
import { digest, toolManifestDigest } from "../lib/core.mjs";
import {
  acceptanceMemoryCleanupExpectedOutput,
  acceptanceMemoryInventorySha256,
  buildAcceptanceMemoryCleanupPlan,
  verifyAcceptanceMemoryCleanup,
} from "../lib/acceptance-memory-cleanup-plan.mjs";

const HASH = "a".repeat(64);
const TIME = "2026-10-07T08:00:00.000Z";
const principalId = "owner-principal";
const runtime = {
  checkout: "/workspace/glassbox",
  dataDirectory: "/data/glassbox",
  commit: "b".repeat(40),
  pid: 1234,
  connectionId: "qq-live",
  threadId: null,
};
const origin = {
  reportSha256: "c".repeat(64),
  guardSha256: "d".repeat(64),
  sourceAuditSha256: "9".repeat(64),
};

function candidate(index, { feedback = false } = {}) {
  const candidateId = "candidate_" + String(index).padStart(32, "0");
  const sourceRunId = "source-run-" + index;
  const sourceFeedback = feedback
    ? {
        id: "feedback-row-" + index,
        candidateId,
        runId: sourceRunId,
        signalType: "explicit_positive",
        createdAt: TIME,
        rowSha256: "e".repeat(64),
      }
    : null;
  const auditWrite = {
    id: "write-audit-" + index,
    sequence: index,
    principalId,
    action: "write",
    targetId: sourceFeedback?.id ?? candidateId,
    runId: sourceRunId,
    lineage: feedback ? [candidateId, "run:" + sourceRunId] : ["run:" + sourceRunId],
    createdAt: TIME,
    rowSha256: "f".repeat(64),
  };
  return {
    candidateId,
    status: "pending",
    promotedMemoryId: null,
    candidateKind: "assertion",
    createdAt: TIME,
    scopeSha256: HASH,
    subjectSha256: "1".repeat(64),
    statementSha256: "2".repeat(64),
    sourceSha256: "3".repeat(64),
    principalId,
    sourceRunId,
    auditWrite,
    sourceFeedback,
  };
}

function makeInventory() {
  return {
    schemaVersion: 1,
    candidates: [candidate(1), candidate(2, { feedback: true }), candidate(3)],
  };
}

function makePlan(overrides = {}) {
  const inventory = overrides.inventory ?? makeInventory();
  return buildAcceptanceMemoryCleanupPlan({
    inventory,
    inventorySha256: acceptanceMemoryInventorySha256(inventory),
    runtime: overrides.runtime ?? runtime,
    origin: overrides.origin ?? origin,
  });
}

function makeCleanup(plan, overrides = {}) {
  const token = "9".repeat(32);
  const runId = "cleanup-run";
  const ids = plan.candidateIds;
  const input = { action: "reject", candidateIds: ids };
  const expectedOutput = acceptanceMemoryCleanupExpectedOutput(ids);
  const results = expectedOutput.results;
  const renderedPrompt =
    "GLASSBOX_ACCEPTANCE_V1 " + token + "\n" + plan.prompt.replaceAll("{{nonce}}", token).trim();
  const cleanup = {
    runId,
    principalId,
    token,
    runtime: structuredClone(plan.runtime),
    run: {
      runId,
      principalId,
      internalMessageId: "message-internal-1",
      externalMessageId: "82736",
    },
    binding: {
      internalMessageId: "message-internal-1",
      externalMessageId: "82736",
      runId,
      principalId,
      textSha256: digest(renderedPrompt),
    },
    lease: {
      runId,
      principalId,
      registered: true,
      revoked: true,
      toolsSha256: toolManifestDigest(plan.leaseTools),
    },
    authorization: {
      runId,
      principalId,
      decisionId: "decision-0",
      decision: "ALLOW",
      action: "memory:govern",
      resourceId: "owner-memory",
    },
    delivery: {
      runId,
      principalId,
      decisionId: "delivery-decision",
      decision: "ALLOW",
      route: "private",
      recipientPrincipalId: principalId,
      externalMessageId: "82737",
      delivered: true,
    },
    toolCall: {
      runId,
      principalId,
      toolCallId: "tool-call-1",
      name: "owner_memory_admin",
      inputSha256: digest(JSON.stringify(input)),
      sequence: 4,
    },
    toolResult: {
      runId,
      principalId,
      toolCallId: "tool-call-1",
      name: "owner_memory_admin",
      isError: false,
      sequence: 5,
      results,
      outputBytes: expectedOutput.outputBytes,
      outputSha256: expectedOutput.outputSha256,
    },
    learningWrites: {
      runId,
      principalId,
      candidateWriteAuditCount: 0,
      feedbackWriteCount: 0,
      candidateSourceCount: 0,
    },
    rejectionAudits: ids.map((candidateId, index) => ({
      id: "reject-audit-" + index,
      sequence: 100 + index,
      action: "reject",
      targetId: candidateId,
      runId,
      principalId,
      decisionId: `decision-${index}`,
      rowSha256: "4".repeat(64),
    })),
  };
  return Object.assign(cleanup, overrides);
}

function finalizeInventory(inventory) {
  return {
    schemaVersion: 1,
    candidates: inventory.candidates.map((entry) => ({ ...entry, status: "rejected" })),
  };
}

function verify(planRecord, cleanup, finalInventory) {
  const finalInventorySha256 = acceptanceMemoryInventorySha256(finalInventory);
  return verifyAcceptanceMemoryCleanup({
    plan: planRecord.plan,
    planSha256: planRecord.sha256,
    cleanup,
    finalInventory,
    finalInventorySha256,
  });
}

test("builds and verifies a fixed cleanup-only Owner reject batch with separately bound origin hashes", () => {
  const planRecord = makePlan();
  const { plan } = planRecord;
  assert.equal(plan.cleanupOnly, true);
  assert.equal(plan.featurePass, false);
  assert.equal(plan.ownerCommand, "/memory reject " + plan.candidateIds.join(" "));
  assert.deepEqual(plan.leaseTools, [
    {
      name: "owner_memory_admin",
      operations: [
        {
          action: "memory:govern",
          resourceId: "owner-memory",
          inputConstraint: { action: "reject", candidateIds: plan.candidateIds },
        },
      ],
    },
  ]);
  assert.deepEqual(plan.origin, origin);
  assert.equal(JSON.stringify(plan).includes("statement text"), false);

  const finalInventory = finalizeInventory(plan.inventory);
  const proof = verify(planRecord, makeCleanup(plan), finalInventory);
  assert.equal(proof.status, "CLEANUP_VERIFIED");
  assert.equal(proof.cleanupOnly, true);
  assert.equal(proof.featurePass, false);
  assert.equal(proof.rejectedCount, plan.candidateIds.length);
  assert.deepEqual(proof.candidateIds, plan.candidateIds);
});

test("accepts the exact adapter projection while keeping candidate IDs bound by output and audits", () => {
  const planRecord = makePlan();
  const cleanup = makeCleanup(planRecord.plan);
  cleanup.toolCall.inputProjection = "array-values-omitted";
  cleanup.toolCall.inputSha256 = digest(JSON.stringify({ action: "reject" }));
  const proof = verify(planRecord, cleanup, finalizeInventory(planRecord.plan.inventory));
  assert.equal(proof.status, "CLEANUP_VERIFIED");
  for (const mutate of [
    (toolCall) => {
      toolCall.inputSha256 = digest(JSON.stringify({ action: "reject", extra: true }));
    },
    (toolCall) => {
      toolCall.inputProjection = "omitted-all-input";
    },
    (toolCall) => {
      delete toolCall.inputProjection;
    },
  ]) {
    const invalid = makeCleanup(planRecord.plan);
    invalid.toolCall.inputProjection = "array-values-omitted";
    invalid.toolCall.inputSha256 = digest(JSON.stringify({ action: "reject" }));
    mutate(invalid.toolCall);
    assert.throws(() => verify(planRecord, invalid, finalizeInventory(planRecord.plan.inventory)));
  }
});

test("accepts only exact six-field clean and eight-field development runtime snapshots", () => {
  assert.doesNotThrow(() => makePlan({ runtime }));
  assert.doesNotThrow(() =>
    makePlan({
      runtime: { ...runtime, development: true, sourceTreeSha256: "5".repeat(64) },
    }),
  );
  for (const bad of [
    { ...runtime, extra: "field" },
    { ...runtime, expectedSourceTreeSha256: "5".repeat(64) },
    { ...runtime, development: true },
    { ...runtime, development: false, sourceTreeSha256: "5".repeat(64) },
    { ...runtime, checkout: "/workspace/../other" },
  ])
    assert.throws(() => makePlan({ runtime: bad }), /Runtime/u);
});

test("rejects inventory hash drift, malformed or extra fields, duplicate IDs, promoted state and source mismatches", () => {
  const inventory = makeInventory();
  const correctHash = acceptanceMemoryInventorySha256(inventory);
  assert.throws(
    () =>
      buildAcceptanceMemoryCleanupPlan({
        inventory,
        inventorySha256: "0".repeat(64),
        runtime,
        origin,
      }),
    /hash/u,
  );
  const extra = makeInventory();
  extra.candidates[0].statement = "must not be accepted";
  assert.throws(() => acceptanceMemoryInventorySha256(extra), /inventory/u);
  const duplicate = makeInventory();
  duplicate.candidates[1].candidateId = duplicate.candidates[0].candidateId;
  duplicate.candidates.sort((a, b) => a.candidateId.localeCompare(b.candidateId));
  assert.throws(() => acceptanceMemoryInventorySha256(duplicate), /candidate/u);
  const promoted = makeInventory();
  promoted.candidates[0].promotedMemoryId = "memory_" + "7".repeat(32);
  assert.throws(() => acceptanceMemoryInventorySha256(promoted), /candidate/u);
  const badSource = makeInventory();
  badSource.candidates[1].auditWrite.runId = "another-source-run";
  assert.throws(() => acceptanceMemoryInventorySha256(badSource), /provenance/u);
  assert.equal(correctHash.length, 64);
});

test("rejects plans with invalid origin hashes, unsupported runtime shape, or tampering", () => {
  assert.throws(
    () => makePlan({ origin: { reportSha256: HASH, guardSha256: "bad", sourceAuditSha256: HASH } }),
    /origin/u,
  );
  const planRecord = makePlan();
  const tampered = structuredClone(planRecord.plan);
  tampered.candidateIds.pop();
  assert.throws(
    () =>
      verifyAcceptanceMemoryCleanup({
        plan: tampered,
        planSha256: planRecord.sha256,
        cleanup: makeCleanup(planRecord.plan),
        finalInventory: finalizeInventory(planRecord.plan.inventory),
        finalInventorySha256: HASH,
      }),
    /plan|command/u,
  );
});

test("rejects mismatched message, lease, authorization, delivery, tool batch and audit proof", () => {
  const planRecord = makePlan();
  const plan = planRecord.plan;
  const finalInventory = finalizeInventory(plan.inventory);
  const badCases = [
    (cleanup) => {
      cleanup.runtime.pid += 1;
    },
    (cleanup) => {
      cleanup.binding.internalMessageId = "other-message";
    },
    (cleanup) => {
      cleanup.binding.externalMessageId = "99999";
    },
    (cleanup) => {
      cleanup.binding.textSha256 = HASH;
    },
    (cleanup) => {
      cleanup.lease.toolsSha256 = HASH;
    },
    (cleanup) => {
      cleanup.authorization.decision = "DENY";
    },
    (cleanup) => {
      cleanup.authorization.action = "memory:write";
    },
    (cleanup) => {
      cleanup.delivery.route = "group";
    },
    (cleanup) => {
      cleanup.delivery.delivered = false;
    },
    (cleanup) => {
      cleanup.toolCall.inputSha256 = HASH;
    },
    (cleanup) => {
      cleanup.toolResult.isError = true;
    },
    (cleanup) => {
      cleanup.toolResult.results[0].status = "failed";
    },
    (cleanup) => {
      cleanup.toolResult.outputBytes += 1;
    },
    (cleanup) => {
      cleanup.learningWrites.candidateWriteAuditCount = 1;
    },
    (cleanup) => {
      cleanup.rejectionAudits[0].runId = "source-run-1";
    },
    (cleanup) => {
      cleanup.rejectionAudits.pop();
    },
  ];
  for (const mutate of badCases) {
    const cleanup = makeCleanup(plan);
    mutate(cleanup);
    assert.throws(() => verify(planRecord, cleanup, finalInventory));
  }
});

test("rejects final promotion, changed origin metadata, missing candidates and new candidates", () => {
  const planRecord = makePlan();
  const plan = planRecord.plan;
  const cleanup = makeCleanup(plan);
  const baseFinal = finalizeInventory(plan.inventory);
  const promoted = structuredClone(baseFinal);
  promoted.candidates[0].status = "promoted";
  promoted.candidates[0].promotedMemoryId = "memory_" + "8".repeat(32);
  assert.throws(() => verify(planRecord, cleanup, promoted));
  const drifted = structuredClone(baseFinal);
  drifted.candidates[0].statementSha256 = "9".repeat(64);
  assert.throws(() => verify(planRecord, cleanup, drifted));
  const missing = structuredClone(baseFinal);
  missing.candidates.pop();
  assert.throws(() => verify(planRecord, cleanup, missing));
  const added = structuredClone(baseFinal);
  added.candidates.push({ ...added.candidates.at(-1), candidateId: "candidate_" + "f".repeat(32) });
  added.candidates.sort((a, b) => a.candidateId.localeCompare(b.candidateId));
  assert.throws(() => verify(planRecord, cleanup, added));
});

test("rejects cleanup run reuse, wrong principal, unbound tool result, and altered final inventory hash", () => {
  const planRecord = makePlan();
  const plan = planRecord.plan;
  const finalInventory = finalizeInventory(plan.inventory);
  for (const mutation of [
    (cleanup) => {
      cleanup.runId = "source-run-1";
    },
    (cleanup) => {
      cleanup.principalId = "another-owner";
    },
    (cleanup) => {
      cleanup.toolResult.toolCallId = "another-call";
    },
    (cleanup) => {
      cleanup.toolResult.sequence = cleanup.toolCall.sequence;
    },
  ]) {
    const cleanup = makeCleanup(plan);
    mutation(cleanup);
    assert.throws(() => verify(planRecord, cleanup, finalInventory));
  }
  assert.throws(
    () =>
      verifyAcceptanceMemoryCleanup({
        plan,
        planSha256: planRecord.sha256,
        cleanup: makeCleanup(plan),
        finalInventory,
        finalInventorySha256: HASH,
      }),
    /hash/u,
  );
});
