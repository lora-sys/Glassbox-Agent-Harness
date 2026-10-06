import test from "node:test";
import assert from "node:assert/strict";
import { evaluateDeliveryGate } from "../lib/delivery-gate.mjs";
import { verifyPostMergeAttempt } from "../lib/delivery-cli.mjs";
import { digest } from "../lib/core.mjs";

const candidateCommit = "a".repeat(40);
const mergeCommit = "b".repeat(40);
const acceptanceIdentitySha256 = "e".repeat(64);
const mergedAt = "2026-10-06T10:00:00.000Z";
const mergedAtUnixSeconds = Math.floor(Date.parse(mergedAt) / 1000);
const suiteText = JSON.stringify({
  schemaVersion: 2,
  cases: [
    {
      id: "postmerge-smoke",
      chat: "private",
      prompt: "验证回归并包含编号 {{nonce}}",
      expectContains: ["{{nonce}}"],
    },
  ],
});
const suiteSha256 = digest(suiteText);

function fixture() {
  const report = {
    status: "PASS",
    mode: "run",
    suiteSha256,
    productAcceptance: { status: "PASS", runtime: { commit: mergeCommit } },
    cases: [
      {
        id: "postmerge-smoke",
        route: "private",
        token: "fresh-postmerge-nonce",
        prompt: "验证回归并包含编号 fresh-postmerge-nonce",
        expected: ["fresh-postmerge-nonce"],
        status: "PASS",
      },
    ],
  };
  const fresh = {
    status: "PASS",
    runtime: { commit: mergeCommit },
    cases: [
      {
        caseId: "postmerge-smoke",
        runId: "fresh-merged-run",
        runCreatedAt: "2026-10-06T10:01:00.000Z",
        messageBinding: { input: { time: mergedAtUnixSeconds + 1 } },
        traceVerified: true,
      },
    ],
  };
  const remote = {
    headCommit: candidateCommit,
    state: "MERGED",
    mergeCommit,
    mergedAt,
    checks: [{ name: "unit", commit: mergeCommit, status: "SUCCESS" }],
    review: { commit: candidateCommit, status: "PASS", evidenceId: "candidate-review" },
  };
  const input = {
    commit: mergeCommit,
    candidateCommit,
    postMerge: true,
    checkOnly: true,
    suiteSha256,
    suiteText,
    requiredCaseIds: ["postmerge-smoke"],
    reports: [report],
    requiredCheckNames: ["unit"],
    deterministic: { commit: mergeCommit, full: "PASS", commitGate: "PASS" },
    review: { commit: candidateCommit, status: "PASS", evidenceId: "candidate-review" },
  };
  const dependencies = {
    verifyCoverage: async () => ({ status: "PASS", requiredCaseIds: ["postmerge-smoke"] }),
    verifyReport: async () => structuredClone(fresh),
    readRemote: async () => structuredClone(remote),
    resolveRoute: (chat) => (chat === "private" ? "private" : undefined),
  };
  return { input, dependencies, report, fresh, remote };
}

test("post-merge gate accepts a fresh Run on the merged commit after GitHub merge time", async () => {
  const { input, dependencies, fresh, remote } = fixture();
  assert.notEqual(input.candidateCommit, input.commit);
  assert.equal(remote.headCommit, input.candidateCommit);
  assert.equal(remote.mergeCommit, input.commit);
  assert.ok(Date.parse(fresh.cases[0].runCreatedAt) > Date.parse(remote.mergedAt));
  assert.ok(fresh.cases[0].messageBinding.input.time * 1000 > Date.parse(remote.mergedAt));

  const result = await evaluateDeliveryGate(input, dependencies);
  assert.equal(result.status, "PASS");
  assert.equal(result.candidateCommit, candidateCommit);
  assert.equal(result.mergeCommit, mergeCommit);
  assert.equal(result.mergeAuthorized, false);
});

test("post-merge gate rejects stale reports, Run times, merge metadata, reviews and CI", async () => {
  const cases = [
    {
      name: "candidate-built report",
      mutate({ report }) {
        report.productAcceptance.runtime.commit = candidateCommit;
      },
      code: "LIVE_GATE",
    },
    {
      name: "Run created before merge",
      mutate({ fresh }) {
        fresh.cases[0].runCreatedAt = "2026-10-06T09:59:59.999Z";
      },
      code: "REMOTE_HEAD_GATE",
    },
    {
      name: "Run creation time missing",
      mutate({ fresh }) {
        delete fresh.cases[0].runCreatedAt;
      },
      code: "POST_MERGE_RUN",
    },
    {
      name: "input message arrived before merge although SQL Run is newer",
      mutate({ fresh }) {
        fresh.cases[0].messageBinding.input.time = mergedAtUnixSeconds;
      },
      code: "POST_MERGE_INPUT",
    },
    {
      name: "input message timestamp missing although SQL Run is newer",
      mutate({ fresh }) {
        delete fresh.cases[0].messageBinding.input.time;
      },
      code: "POST_MERGE_INPUT",
    },
    {
      name: "mergedAt missing",
      mutate({ remote }) {
        delete remote.mergedAt;
      },
      code: "REMOTE_HEAD_GATE",
    },
    {
      name: "merge commit mismatch",
      mutate({ remote }) {
        remote.mergeCommit = candidateCommit;
      },
      code: "REMOTE_HEAD_GATE",
    },
    {
      name: "review belongs to another candidate",
      mutate({ remote }) {
        remote.review.commit = "c".repeat(40);
      },
      code: "REVIEW_GATE",
    },
    {
      name: "PR is still open",
      mutate({ remote }) {
        remote.state = "OPEN";
      },
      code: "REMOTE_HEAD_GATE",
    },
    {
      name: "merged CI missing",
      mutate({ remote }) {
        remote.checks = [];
      },
      code: "CI_GATE",
    },
  ];

  for (const scenario of cases) {
    const context = fixture();
    scenario.mutate(context);
    await assert.rejects(
      evaluateDeliveryGate(context.input, context.dependencies),
      {
        code: scenario.code,
      },
      scenario.name,
    );
  }
});

test("post-merge gate cannot use a caller review claim instead of fresh remote evidence", async () => {
  const { input, dependencies, remote } = fixture();
  delete remote.review;
  assert.equal(input.review.status, "PASS");
  await assert.rejects(evaluateDeliveryGate(input, dependencies), { code: "REVIEW_GATE" });
});

test("post-merge gate requires check-only mode", async () => {
  const { input, dependencies } = fixture();
  input.checkOnly = false;
  await assert.rejects(evaluateDeliveryGate(input, dependencies), { code: "POST_MERGE_BINDING" });
});

test("post-merge attempt must remain bound to the original PR, candidate, suite and attempt ID", () => {
  const binding = {
    prUrl: "https://github.com/example/project/pull/42",
    candidateCommit,
    suiteSha256,
    acceptanceIdentitySha256,
  };
  const attempt = {
    status: "ATTEMPTING",
    ...binding,
    commit: candidateCommit,
    remoteHead: candidateCommit,
    attemptId: "019c6e27-e55b-73d1-87d8-4e01f1f75043",
    startedAt: "2026-10-06T10:00:00.000Z",
  };
  assert.equal(verifyPostMergeAttempt(attempt, binding), attempt.attemptId);

  for (const mutate of [
    (value) => (value.prUrl = "https://github.com/example/project/pull/43"),
    (value) => (value.commit = "c".repeat(40)),
    (value) => (value.remoteHead = "c".repeat(40)),
    (value) => (value.suiteSha256 = "d".repeat(64)),
    (value) => (value.acceptanceIdentitySha256 = "f".repeat(64)),
    (value) => delete value.acceptanceIdentitySha256,
    (value) => (value.attemptId = "not-an-attempt-id"),
    (value) => delete value.attemptId,
  ]) {
    const mismatched = structuredClone(attempt);
    mutate(mismatched);
    assert.throws(() => verifyPostMergeAttempt(mismatched, binding), {
      code: "POST_MERGE_ATTEMPT",
    });
  }
  assert.throws(
    () =>
      verifyPostMergeAttempt(attempt, {
        ...binding,
        acceptanceIdentitySha256: "not-a-sha256",
      }),
    { code: "POST_MERGE_ATTEMPT" },
  );
});
