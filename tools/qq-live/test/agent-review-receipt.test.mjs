import test from "node:test";
import assert from "node:assert/strict";
import {
  buildAgentReviewReceipt,
  reviewBindingSha256,
  verifyAgentReviewReceipt,
} from "../lib/agent-review-receipt.mjs";

const binding = {
  repository: "https://github.com/lora-sys/Glassbox-Agent-Harness",
  pullRequestNumber: 142,
  pullRequestUrl: "https://github.com/lora-sys/Glassbox-Agent-Harness/pull/142",
  baseCommit: "a".repeat(40),
  candidateCommit: "b".repeat(40),
  candidateTree: "c".repeat(40),
  diffSha256: "d".repeat(64),
  changedPaths: ["apps/server/src/ops/service.ts", "tools/qq-live/lib/delivery-gate.mjs"],
  pullRequestAuthorLogin: "octo-owner",
};
const review = {
  reviewerId: "independent-review-agent-9",
  implementationAgentIds: ["agent:implementation-7", "agent:implementation-8"],
  reviewerScope: ["authorization", "correctness", "tests"],
  coverage: "full-diff",
  reviewedPaths: binding.changedPaths,
  findings: [
    {
      id: "F-1",
      severity: "high",
      summary: "Affected code path needed a regression assertion.",
      resolution: "fixed",
      resolutionNote: "Added the focused regression test and confirmed it passes.",
    },
  ],
};
const artifactBytes = Buffer.from(JSON.stringify({ schemaVersion: 2, binding, review }));
const recordInput = {
  action: "record-agent-review",
  binding,
  artifactBytes,
  expectedReviewBindingSha256: reviewBindingSha256(binding),
  hostOperatorIdentityAttested: true,
  recordedAt: "2026-10-06T10:00:00.000Z",
};

function record(overrides = {}) {
  return buildAgentReviewReceipt({ ...recordInput, ...overrides });
}

test("records explicit independent full-diff review and rechecks exact artifact binding", () => {
  const receipt = record();
  assert.equal(receipt.status, "PASS");
  assert.equal(receipt.action, "record-agent-review");
  assert.equal(receipt.review.coverage, "full-diff");
  assert.equal(receipt.review.findings[0].resolution, "fixed");
  assert.deepEqual(verifyAgentReviewReceipt({ receipt, artifactBytes, expected: binding }), {
    status: "PASS",
    candidateCommit: binding.candidateCommit,
    hostOperatorIdentityAttested: true,
    implementationAgentIds: review.implementationAgentIds,
    receiptSha256: receipt.receiptSha256,
    bindingSha256: receipt.bindingSha256,
    reviewerId: review.reviewerId,
    reviewerScope: review.reviewerScope,
    artifactSha256: receipt.artifact.sha256,
  });
});

test("arbitrary report PASS and artifact promotion fields are rejected", () => {
  assert.throws(
    () =>
      buildAgentReviewReceipt({
        status: "PASS",
        commit: binding.candidateCommit,
        evidenceId: "report-says-pass",
      }),
    { code: "AGENT_REVIEW_RECEIPT" },
  );
  const report = { schemaVersion: 2, binding, review, status: "PASS" };
  assert.throws(() => record({ artifactBytes: Buffer.from(JSON.stringify(report)) }), {
    code: "AGENT_REVIEW_RECEIPT",
  });
  assert.throws(() => record({ action: "delivery-report" }), { code: "AGENT_REVIEW_RECEIPT" });
});

test("reviewer is checked against listed implementation Agents, not GitHub author login", () => {
  const selfReview = { ...review, reviewerId: "agent:implementation-7" };
  assert.throws(
    () =>
      record({
        artifactBytes: Buffer.from(
          JSON.stringify({ schemaVersion: 2, binding, review: selfReview }),
        ),
      }),
    { code: "AGENT_REVIEW_RECEIPT" },
  );
  for (const implementationAgentIds of [[], ["agent:implementation-7", "agent:implementation-7"]]) {
    const invalidIdentities = { ...review, implementationAgentIds };
    assert.throws(
      () =>
        record({
          artifactBytes: Buffer.from(
            JSON.stringify({ schemaVersion: 2, binding, review: invalidIdentities }),
          ),
        }),
      { code: "AGENT_REVIEW_RECEIPT" },
    );
  }
  const sameTextDifferentNamespace = { ...review, reviewerId: binding.pullRequestAuthorLogin };
  assert.doesNotThrow(() =>
    record({
      artifactBytes: Buffer.from(
        JSON.stringify({ schemaVersion: 2, binding, review: sameTextDifferentNamespace }),
      ),
    }),
  );
  const unresolved = {
    ...review,
    findings: [{ ...review.findings[0], resolution: "open", resolutionNote: "" }],
  };
  assert.throws(
    () =>
      record({
        artifactBytes: Buffer.from(
          JSON.stringify({ schemaVersion: 2, binding, review: unresolved }),
        ),
      }),
    { code: "AGENT_REVIEW_RECEIPT" },
  );
});

test("narrow scope, incomplete path set, or wrong expected binding cannot attest the whole PR", () => {
  const narrow = {
    ...review,
    coverage: "selected-files",
    reviewedPaths: [binding.changedPaths[0]],
  };
  assert.throws(
    () =>
      record({
        artifactBytes: Buffer.from(JSON.stringify({ schemaVersion: 2, binding, review: narrow })),
      }),
    { code: "AGENT_REVIEW_RECEIPT" },
  );
  assert.throws(() => record({ expectedReviewBindingSha256: "e".repeat(64) }), {
    code: "AGENT_REVIEW_BINDING",
  });
});

test("verification rejects changed receipt, artifact, candidate, base, tree, paths and diff", () => {
  const receipt = record();
  assert.throws(
    () =>
      verifyAgentReviewReceipt({
        receipt: { ...receipt, binding: { ...binding, candidateCommit: "e".repeat(40) } },
        artifactBytes,
        expected: binding,
      }),
    { code: "AGENT_REVIEW_RECEIPT" },
  );
  assert.throws(
    () =>
      verifyAgentReviewReceipt({
        receipt,
        artifactBytes: Buffer.from("different review artifact"),
        expected: binding,
      }),
    { code: "AGENT_REVIEW_RECEIPT" },
  );
  for (const changed of [
    { diffSha256: "f".repeat(64) },
    { baseCommit: "e".repeat(40) },
    { candidateCommit: "e".repeat(40) },
    { candidateTree: "e".repeat(40) },
    { changedPaths: ["other-file.ts"] },
  ]) {
    assert.throws(
      () =>
        verifyAgentReviewReceipt({ receipt, artifactBytes, expected: { ...binding, ...changed } }),
      { code: "AGENT_REVIEW_STALE" },
    );
  }
});

test("receipt input rejects unknown fields and invalid artifacts", () => {
  assert.throws(() => record({ report: { status: "PASS" } }), { code: "AGENT_REVIEW_RECEIPT" });
  assert.throws(() => record({ artifactBytes: Buffer.alloc(0) }), { code: "AGENT_REVIEW_RECEIPT" });
});
