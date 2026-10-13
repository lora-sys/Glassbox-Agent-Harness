import test from "node:test";
import assert from "node:assert/strict";
import { executeDelivery } from "../lib/delivery-executor.mjs";

const commit = "a".repeat(40);
const mergeCommit = "c".repeat(40);
const suiteSha256 = "b".repeat(64);
const acceptanceIdentitySha256 = "d".repeat(64);
const prUrl = "https://github.com/example/repo/pull/17";
const binding = { prUrl, commit, suiteSha256, acceptanceIdentitySha256 };

function fixture(overrides = {}) {
  const calls = {
    gate: 0,
    local: 0,
    remote: 0,
    merge: 0,
    mergeCommit: null,
    attempt: 0,
    outcome: [],
    acceptance: 0,
    acceptanceBinding: null,
  };
  const deps = {
    evaluateGate: async () => {
      calls.gate++;
      return {
        status: "PASS",
        commit,
        suiteSha256,
        remoteHead: commit,
        mergeAuthorized: true,
      };
    },
    readLocalHead: async () => {
      calls.local++;
      return { commit, clean: true };
    },
    readRemote: async () => {
      calls.remote++;
      return {
        headCommit: commit,
        state: "OPEN",
        draft: false,
        checks: [{ commit, status: "SUCCESS" }],
        review: { commit, status: "PASS" },
      };
    },
    readAttempt: async () => null,
    writeAttempt: async () => {
      calls.attempt++;
      return true;
    },
    writeOutcome: async (outcome) => {
      calls.outcome.push(outcome);
      return true;
    },
    mergeExactHead: async (value) => {
      calls.merge++;
      calls.mergeCommit = value;
      return { accepted: true };
    },
    postMergeAccept: async (input) => {
      calls.acceptance++;
      calls.acceptanceBinding = input;
      return { status: "PASS", ...input };
    },
    ...overrides,
  };
  return { calls, deps };
}

test("default check is read-only and returns READY", async () => {
  const { calls, deps } = fixture({
    evaluateGate: async () => {
      calls.gate++;
      return {
        status: "PASS",
        commit,
        suiteSha256,
        remoteHead: commit,
        mergeAuthorized: false,
      };
    },
  });
  const result = await executeDelivery({ ...binding, live: false }, deps);
  assert.equal(result.status, "READY");
  assert.equal(result.mergeAttempted, false);
  assert.equal(calls.gate, 1);
  assert.equal(calls.local, 1);
  assert.equal(calls.remote, 1);
  assert.equal(calls.merge, 0);
  assert.equal(calls.attempt, 0);
  assert.deepEqual(calls.outcome, []);
});

test("check-only may omit acceptance identity while live merge requires it", async () => {
  const { calls, deps } = fixture();
  const checked = await executeDelivery({ prUrl, commit, live: false }, deps);
  assert.equal(checked.status, "READY");
  const live = await executeDelivery({ prUrl, commit, suiteSha256, live: true }, deps);
  assert.equal(live.status, "BLOCKED");
  assert.equal(live.code, "ACCEPTANCE_IDENTITY_BINDING");
  assert.equal(calls.merge, 0);
  assert.equal(calls.attempt, 0);
});

test("live delivery repeats gate and head checks and merges only once", async () => {
  const { calls, deps } = fixture({
    writeAttempt: async (attempt) => {
      calls.attempt++;
      assert.equal(attempt.prUrl, prUrl);
      assert.equal(attempt.commit, commit);
      assert.equal(attempt.suiteSha256, suiteSha256);
      assert.equal(attempt.acceptanceIdentitySha256, acceptanceIdentitySha256);
    },
    writeOutcome: async (outcome) => {
      calls.outcome.push(outcome);
    },
    readRemote: async () => {
      calls.remote++;
      return {
        headCommit: commit,
        state: calls.remote >= 3 ? "MERGED" : "OPEN",
        ...(calls.remote >= 3 ? { mergeCommit } : {}),
        draft: false,
        checks: [{ commit, status: "SUCCESS" }],
        review: { commit, status: "PASS" },
      };
    },
  });
  const result = await executeDelivery({ ...binding, live: true }, deps);
  assert.equal(result.status, "DELIVERED");
  assert.equal(calls.gate, 2);
  assert.equal(calls.local, 2);
  assert.equal(calls.remote, 3);
  assert.equal(calls.attempt, 1);
  assert.equal(calls.merge, 1);
  assert.equal(calls.mergeCommit, commit);
  assert.equal(calls.acceptance, 1);
  assert.equal(calls.acceptanceBinding.candidateCommit, commit);
  assert.equal(calls.acceptanceBinding.commit, mergeCommit);
  assert.equal(calls.acceptanceBinding.acceptanceIdentitySha256, acceptanceIdentitySha256);
  assert.equal(calls.outcome[0].candidateCommit, commit);
  assert.equal(calls.outcome[0].commit, mergeCommit);
  assert.equal(calls.outcome[0].mergeCommit, mergeCommit);
  assert.equal(calls.outcome[0].acceptanceIdentitySha256, acceptanceIdentitySha256);
  assert.equal(calls.outcome[1].commit, mergeCommit);
  assert.deepEqual(
    calls.outcome.map((item) => item.status),
    ["MERGED", "DELIVERED"],
  );
});

test("check-only gate authorization cannot be reused for a live merge", async () => {
  const { calls, deps } = fixture({
    evaluateGate: async () => {
      calls.gate++;
      return {
        status: "PASS",
        commit,
        suiteSha256,
        remoteHead: commit,
        mergeAuthorized: false,
      };
    },
  });
  const result = await executeDelivery({ ...binding, live: true }, deps);
  assert.equal(result.status, "BLOCKED");
  assert.equal(calls.gate, 1);
  assert.equal(calls.attempt, 0);
  assert.equal(calls.merge, 0);
});

test("changed remote head before the second gate stops before persisting or merging", async () => {
  const { calls, deps } = fixture({
    readRemote: async () => {
      calls.remote++;
      return {
        headCommit: calls.remote === 1 ? commit : "c".repeat(40),
        state: "OPEN",
        draft: false,
        checks: [{ commit, status: "SUCCESS" }],
        review: { commit, status: "PASS" },
      };
    },
  });
  const result = await executeDelivery({ ...binding, live: true }, deps);
  assert.equal(result.status, "BLOCKED");
  assert.equal(result.code, "REMOTE_HEAD_CHANGED");
  assert.equal(calls.gate, 2);
  assert.equal(calls.attempt, 0);
  assert.equal(calls.merge, 0);
});

test("attempt persistence failure prevents the merge call", async () => {
  const { calls, deps } = fixture({ writeAttempt: async () => false });
  const result = await executeDelivery({ ...binding, live: true }, deps);
  assert.equal(result.status, "INCONCLUSIVE");
  assert.equal(result.code, "ATTEMPT_NOT_DURABLE");
  assert.equal(result.mergeAttempted, false);
  assert.equal(calls.merge, 0);
});

test("unknown merge result is never retried and an open remote stays inconclusive", async () => {
  const { calls, deps } = fixture({
    mergeExactHead: async () => {
      calls.merge++;
      throw new Error("connection dropped after request");
    },
  });
  const result = await executeDelivery({ ...binding, live: true }, deps);
  assert.equal(result.status, "INCONCLUSIVE");
  assert.equal(result.code, "MERGE_UNCONFIRMED");
  assert.equal(calls.merge, 1);
  assert.equal(calls.attempt, 1);
  assert.deepEqual(calls.outcome, []);
});

test("existing attempt with an open remote is preserved without another merge", async () => {
  const oldAttempt = {
    attemptId: "attempt-1",
    ...binding,
    status: "ATTEMPTING",
  };
  const { calls, deps } = fixture({ readAttempt: async () => oldAttempt });
  const result = await executeDelivery({ ...binding, live: true }, deps);
  assert.equal(result.status, "INCONCLUSIVE");
  assert.equal(result.code, "MERGE_UNCONFIRMED");
  assert.equal(calls.gate, 0);
  assert.equal(calls.merge, 0);
  assert.equal(calls.attempt, 0);
  assert.equal(calls.acceptance, 0);
});

test("existing PR attempt cannot be reused with a different acceptance identity", async () => {
  const oldAttempt = {
    attemptId: "attempt-identity-mismatch",
    ...binding,
    acceptanceIdentitySha256: "e".repeat(64),
    status: "ATTEMPTING",
  };
  const { calls, deps } = fixture({ readAttempt: async () => oldAttempt });
  const result = await executeDelivery({ ...binding, live: true }, deps);
  assert.equal(result.status, "INCONCLUSIVE");
  assert.equal(result.code, "ATTEMPT_BINDING");
  assert.equal(calls.gate, 0);
  assert.equal(calls.merge, 0);
  assert.equal(calls.acceptance, 0);
});

test("existing attempt proceeds only after exact remote merged confirmation", async () => {
  const oldAttempt = {
    attemptId: "attempt-1",
    ...binding,
    status: "ATTEMPTING",
  };
  const { calls, deps } = fixture({
    readAttempt: async () => oldAttempt,
    readRemote: async () => {
      calls.remote++;
      return {
        headCommit: commit,
        state: "MERGED",
        mergeCommit,
        draft: false,
        checks: [],
        review: {},
      };
    },
  });
  const result = await executeDelivery({ ...binding, live: true }, deps);
  assert.equal(result.status, "DELIVERED");
  assert.equal(calls.gate, 0);
  assert.equal(calls.merge, 0);
  assert.equal(calls.acceptance, 1);
  assert.deepEqual(
    calls.outcome.map((item) => item.status),
    ["MERGED", "DELIVERED"],
  );
});

test("pending post-merge acceptance never reports delivery complete", async () => {
  const { calls, deps } = fixture({
    readRemote: async () => {
      calls.remote++;
      return {
        headCommit: commit,
        state: calls.remote >= 3 ? "MERGED" : "OPEN",
        ...(calls.remote >= 3 ? { mergeCommit } : {}),
        draft: false,
        checks: [{ commit, status: "SUCCESS" }],
        review: { commit, status: "PASS" },
      };
    },
    postMergeAccept: async () => ({ status: "PENDING" }),
  });
  const result = await executeDelivery({ ...binding, live: true }, deps);
  assert.equal(result.status, "INCONCLUSIVE");
  assert.equal(result.mergeConfirmed, true);
  assert.notEqual(result.status, "DELIVERED");
  assert.deepEqual(
    calls.outcome.map((item) => item.status),
    ["MERGED", "INCONCLUSIVE"],
  );
});

test("candidate commit cannot stand in for the exact post-merge commit", async () => {
  const { calls, deps } = fixture({
    readRemote: async () => {
      calls.remote++;
      return {
        headCommit: commit,
        state: calls.remote >= 3 ? "MERGED" : "OPEN",
        ...(calls.remote >= 3 ? { mergeCommit } : {}),
        draft: false,
        checks: [{ commit, status: "SUCCESS" }],
        review: { commit, status: "PASS" },
      };
    },
    postMergeAccept: async (input) => ({
      status: "PASS",
      ...input,
      commit: input.candidateCommit,
    }),
  });
  const result = await executeDelivery({ ...binding, live: true }, deps);
  assert.equal(result.status, "INCONCLUSIVE");
  assert.equal(result.code, "POST_MERGE_ACCEPTANCE");
  assert.equal(result.mergeConfirmed, true);
  assert.equal(calls.merge, 1);
  assert.notEqual(result.status, "DELIVERED");
});

test("post-merge acceptance must echo the exact acceptance identity binding", async () => {
  const { calls, deps } = fixture({
    readRemote: async () => {
      calls.remote++;
      return {
        headCommit: commit,
        state: calls.remote >= 3 ? "MERGED" : "OPEN",
        ...(calls.remote >= 3 ? { mergeCommit } : {}),
        draft: false,
        checks: [{ commit, status: "SUCCESS" }],
        review: { commit, status: "PASS" },
      };
    },
    postMergeAccept: async (input) => ({
      status: "PASS",
      ...input,
      acceptanceIdentitySha256: "e".repeat(64),
    }),
  });
  const result = await executeDelivery({ ...binding, live: true }, deps);
  assert.equal(result.status, "INCONCLUSIVE");
  assert.equal(result.code, "POST_MERGE_ACCEPTANCE");
  assert.equal(calls.merge, 1);
  assert.notEqual(result.status, "DELIVERED");
});

test("MERGED without an exact remote merge SHA remains inconclusive", async () => {
  const { calls, deps } = fixture({
    readRemote: async () => {
      calls.remote++;
      return {
        headCommit: commit,
        state: calls.remote >= 3 ? "MERGED" : "OPEN",
        draft: false,
        checks: [{ commit, status: "SUCCESS" }],
        review: { commit, status: "PASS" },
      };
    },
  });
  const result = await executeDelivery({ ...binding, live: true }, deps);
  assert.equal(result.status, "INCONCLUSIVE");
  assert.equal(result.code, "MERGE_COMMIT_UNCONFIRMED");
  assert.equal(calls.acceptance, 0);
  assert.deepEqual(calls.outcome, []);
});
