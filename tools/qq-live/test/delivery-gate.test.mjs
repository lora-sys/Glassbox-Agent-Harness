import test from "node:test";
import assert from "node:assert/strict";
import { evaluateDeliveryGate } from "../lib/delivery-gate.mjs";
import { digest, toolManifestDigest } from "../lib/core.mjs";
import {
  MEMORY_FAMILY_ID,
  MEMORY_REJECT_FAMILY_ID,
  memoryWorkflow,
} from "../lib/memory-workflow.mjs";
const commit = "a".repeat(40),
  suiteText = JSON.stringify({
    schemaVersion: 2,
    cases: [
      {
        id: "feature-test",
        chat: "private",
        prompt: "call ops {{nonce}}",
        expectContains: ["{{nonce}}"],
        leaseTools: [],
        featureAssertions: [
          {
            kind: "trace",
            type: "tool_result",
            where: { name: "ops_status", isError: false },
            count: 1,
          },
        ],
      },
      {
        id: "baseline-test",
        chat: "private",
        prompt: "reply {{nonce}}",
        expectContains: ["{{nonce}}"],
      },
    ],
  }),
  suiteSha256 = digest(suiteText);

function tasteGateFixture() {
  const f = fixture();
  const familyId = "taste-project-feedback-lifecycle";
  const suiteText = JSON.stringify({
    schemaVersion: 6,
    cases: [{ id: familyId, kind: "taste-lifecycle", chat: "private" }],
  });
  const stages = ["feedback", "promote", "negative-feedback", "retire"];
  const runs = stages.map((stage) => `run-taste-${stage}`);
  const cases = stages.map((stage) => ({
    id: `taste-${stage}`,
    status: "PASS",
    leaseRevoked: true,
  }));
  const report = {
    mode: "run",
    status: "PASS",
    suiteSha256: digest(suiteText),
    productAcceptance: { status: "PASS", runtime: { commit } },
    cases,
    tasteFamily: { familyId },
    tasteLifecycle: {
      status: "PASS",
      requiresReconciliation: false,
      steps: stages.map((stage, i) => ({ stage, runId: runs[i] })),
    },
  };
  f.input.suiteText = suiteText;
  f.input.suiteSha256 = digest(suiteText);
  f.input.requiredCaseIds = [familyId];
  f.input.reports = [report];
  f.dependencies.verifyCoverage = async () => ({ status: "PASS", requiredCaseIds: [familyId] });
  f.dependencies.verifyReport = async () => ({
    status: "PASS",
    runtime: { commit },
    cases: cases.map((item, i) => ({
      caseId: item.id,
      runId: runs[i],
      traceVerified: true,
      feature: { status: "PASS" },
    })),
  });
  f.dependencies.verifyTasteReport = async () => ({
    status: "PASS",
    familyId,
    runtime: { commit },
    stageRunIds: runs,
    fixture: { lifecycleState: "retired", activeCount: 0, pendingCount: 0 },
  });
  return f;
}

test("delivery counts Taste only after independent four-Run final-state verification", async () => {
  const f = tasteGateFixture();
  const result = await evaluateDeliveryGate(f.input, f.dependencies);
  assert.equal(result.status, "PASS");
});

test("delivery rejects stale, incomplete, duplicate, mixed or cleanup-only Taste evidence", async () => {
  for (const change of [
    (f) => {
      delete f.dependencies.verifyTasteReport;
    },
    (f) => {
      f.input.reports[0].cleanupOnly = true;
    },
    (f) => {
      f.input.reports[0].tasteLifecycle.requiresReconciliation = true;
    },
    (f) => {
      f.input.reports[0].memoryFamily = { caseId: "memory-project-promote-expire" };
    },
    (f) => {
      f.input.reports[0].tasteLifecycle.steps[3].runId = "foreign-run";
    },
    (f) => {
      f.dependencies.verifyTasteReport = async () => ({ status: "PASS" });
    },
    (f) => {
      const original = f.dependencies.verifyTasteReport;
      f.dependencies.verifyTasteReport = async () => ({
        ...(await original()),
        runtime: { commit: "b".repeat(40) },
      });
    },
    (f) => {
      const original = f.dependencies.verifyTasteReport;
      f.dependencies.verifyTasteReport = async () => ({
        ...(await original()),
        fixture: { lifecycleState: "retired", activeCount: 1, pendingCount: 0 },
      });
    },
  ]) {
    const f = tasteGateFixture();
    change(f);
    await assert.rejects(evaluateDeliveryGate(f.input, f.dependencies), {
      code: "TASTE_FAMILY_GATE",
    });
  }
  const duplicate = tasteGateFixture();
  duplicate.input.reports.push(structuredClone(duplicate.input.reports[0]));
  await assert.rejects(evaluateDeliveryGate(duplicate.input, duplicate.dependencies), {
    code: "CASE_DUPLICATE",
  });
});
function fixture() {
  const input = {
    commit,
    suiteSha256,
    suiteText,
    requiredCaseIds: ["feature-test", "baseline-test"],
    requiredCheckNames: ["unit"],
    userAuthorizedMerge: true,
    deterministic: { commit, full: "PASS", commitGate: "PASS" },
    review: { commit, status: "PASS", evidenceId: "review-test" },
    reports: [
      {
        status: "PASS",
        mode: "run",
        suiteSha256,
        productAcceptance: { status: "PASS", runtime: { commit } },
        cases: [
          {
            id: "feature-test",
            route: "private",
            token: "d".repeat(32),
            prompt: `GLASSBOX_ACCEPTANCE_V1 ${"d".repeat(32)}\ncall ops ${"d".repeat(32)}`,
            expected: ["d".repeat(32)],
            status: "PASS",
            featureAssertions: [
              {
                kind: "trace",
                type: "tool_result",
                where: { name: "ops_status", isError: false },
                count: 1,
              },
            ],
            acceptanceLease: { toolsSha256: toolManifestDigest([]) },
            leasedToolNames: [],
            leaseRevoked: true,
          },
          {
            id: "baseline-test",
            route: "private",
            status: "PASS",
            token: "baseline-nonce",
            prompt: "reply baseline-nonce",
            expected: ["baseline-nonce"],
          },
        ],
      },
    ],
  };
  const dependencies = {
    verifyCoverage: async () => ({
      status: "PASS",
      requiredCaseIds: ["feature-test", "baseline-test"],
    }),
    resolveRoute: (chat) => (chat === "private" ? "private" : undefined),
    verifyReport: async () => ({
      status: "PASS",
      runtime: { commit },
      cases: [
        {
          caseId: "feature-test",
          runId: "run-test-1",
          traceVerified: true,
          feature: { status: "PASS" },
        },
        { caseId: "baseline-test", runId: "run-test-2", traceVerified: true },
      ],
    }),
    readRemote: async () => ({
      headCommit: commit,
      state: "OPEN",
      draft: false,
      mergeable: true,
      review: { commit, status: "PASS", reviewer: "reviewer", evidenceId: "github-review" },
      checks: [{ name: "unit", commit, status: "SUCCESS" }],
    }),
  };
  return { input, dependencies };
}

function memoryFixture(familyId = MEMORY_FAMILY_ID) {
  const workflow = memoryWorkflow(familyId);
  const family = {
    id: familyId,
    kind: "memory-lifecycle",
    workflow: workflow.workflow,
    chat: workflow.chat,
  };
  const suiteText = JSON.stringify({ schemaVersion: 3, cases: [family] });
  const suiteSha256 = digest(suiteText);
  const runIds = workflow.stages.map((stage) => `run-${stage}`);
  const caseIds = workflow.stages.map((stage) => `memory-${stage}`);
  const report = {
    status: "PASS",
    mode: "run",
    suiteSha256,
    productAcceptance: { status: "PASS", runtime: { commit } },
    memoryFamily: { caseId: family.id },
    memoryLifecycle: { steps: runIds.map((runId) => ({ runId })) },
    cases: caseIds.map((id) => ({ id, status: "PASS" })),
  };
  const input = {
    commit,
    suiteSha256,
    suiteText,
    requiredCaseIds: [family.id],
    requiredCheckNames: ["unit"],
    userAuthorizedMerge: true,
    deterministic: { commit, full: "PASS", commitGate: "PASS" },
    review: { commit, status: "PASS", evidenceId: "review-memory-test" },
    reports: [report],
  };
  const runtime = { commit, checkout: "/acceptance/repo", dataDirectory: "/acceptance/data" };
  const dependencies = {
    verifyCoverage: async () => ({ status: "PASS", requiredCaseIds: [family.id] }),
    resolveRoute: () => "private",
    verifyReport: async () => ({
      status: "PASS",
      runtime,
      cases: caseIds.map((caseId, index) => ({
        caseId,
        runId: runIds[index],
        traceVerified: true,
        feature: { status: "PASS" },
      })),
    }),
    verifyMemoryReport: async () => ({
      status: "PASS",
      caseId: family.id,
      runtime,
      stageRunIds: runIds,
      cleanup: { status: workflow.cleanupStatus },
      handles: { cleanupRunId: runIds.at(-1) },
    }),
    readRemote: async () => ({
      headCommit: commit,
      state: "OPEN",
      draft: false,
      mergeable: true,
      review: { commit, status: "PASS", reviewer: "reviewer", evidenceId: "github-review" },
      checks: [{ name: "unit", commit, status: "SUCCESS" }],
    }),
  };
  return { input, dependencies };
}

test("read-only gate judgments cannot authorize a merge", async () => {
  const { input, dependencies } = fixture();
  input.userAuthorizedMerge = false;
  input.checkOnly = true;
  const result = await evaluateDeliveryGate(input, dependencies);
  assert.equal(result.status, "PASS");
  assert.equal(result.mergeAuthorized, false);
  delete input.checkOnly;
  await assert.rejects(evaluateDeliveryGate(input, dependencies), { code: "MERGE_AUTHORIZATION" });
});

test("an exact verified full-diff Agent receipt can replace missing formal approval", async () => {
  const { input, dependencies } = fixture();
  input.review = { commit: null, status: "MISSING", evidenceId: null };
  dependencies.readRemote = async () => ({
    headCommit: commit,
    state: "OPEN",
    draft: false,
    mergeable: true,
    review: { commit: null, status: "MISSING", evidenceId: null },
    checks: [{ name: "unit", commit, status: "SUCCESS" }],
  });
  dependencies.verifyAgentReview = async ({ commit: expectedCommit }) => ({
    status: "PASS",
    candidateCommit: expectedCommit,
    receiptSha256: "b".repeat(64),
    bindingSha256: "c".repeat(64),
    artifactSha256: "d".repeat(64),
    reviewerId: "independent-review-agent",
    implementationAgentIds: ["agent:implementation-a"],
    hostOperatorIdentityAttested: true,
  });
  const gate = await evaluateDeliveryGate(input, dependencies);
  assert.equal(gate.reviewEvidence.kind, "agent-review-receipt");
  assert.equal(gate.reviewEvidence.commit, commit);
  assert.equal(gate.mergeAuthorized, true);
});

test("an Agent receipt cannot override a current-head changes-requested review", async () => {
  const { input, dependencies } = fixture();
  dependencies.readRemote = async () => ({
    headCommit: commit,
    state: "OPEN",
    draft: false,
    mergeable: true,
    review: { commit, status: "CHANGES_REQUESTED", evidenceId: "change-request" },
    checks: [{ name: "unit", commit, status: "SUCCESS" }],
  });
  dependencies.verifyAgentReview = async () => ({
    status: "PASS",
    candidateCommit: commit,
    receiptSha256: "b".repeat(64),
    bindingSha256: "c".repeat(64),
    artifactSha256: "d".repeat(64),
    reviewerId: "independent-review-agent",
    implementationAgentIds: ["agent:implementation-a"],
    hostOperatorIdentityAttested: true,
  });
  await assert.rejects(evaluateDeliveryGate(input, dependencies), { code: "REVIEW_GATE" });
});

test("post-merge review receipt stays bound to the candidate while product evidence uses the merge commit", async () => {
  const { input, dependencies } = fixture();
  const candidateCommit = commit;
  const mergeCommit = "f".repeat(40);
  const mergedAt = "2026-10-06T12:00:00.000Z";
  input.commit = mergeCommit;
  input.postMerge = true;
  input.checkOnly = true;
  input.candidateCommit = candidateCommit;
  input.deterministic.commit = mergeCommit;
  input.reports[0].productAcceptance.runtime.commit = mergeCommit;
  for (const c of input.reports[0].cases) c.inputTime = Date.parse(mergedAt) / 1000 + 10;
  dependencies.verifyReport = async () => ({
    status: "PASS",
    runtime: { commit: mergeCommit },
    cases: [
      {
        caseId: "feature-test",
        runId: "run-test-1",
        traceVerified: true,
        feature: { status: "PASS" },
        runCreatedAt: mergedAt,
        messageBinding: { input: { time: Date.parse(mergedAt) / 1000 + 10 } },
      },
      {
        caseId: "baseline-test",
        runId: "run-test-2",
        traceVerified: true,
        runCreatedAt: mergedAt,
        messageBinding: { input: { time: Date.parse(mergedAt) / 1000 + 10 } },
      },
    ],
  });
  dependencies.readRemote = async () => ({
    headCommit: candidateCommit,
    state: "MERGED",
    mergeCommit,
    mergedAt,
    review: { commit: candidateCommit, status: "MISSING" },
    checks: [{ name: "unit", commit: mergeCommit, status: "SUCCESS" }],
  });
  const reviewedCommits = [];
  dependencies.verifyAgentReview = async ({ commit: reviewedCommit }) => {
    reviewedCommits.push(reviewedCommit);
    return {
      status: "PASS",
      candidateCommit: reviewedCommit,
      receiptSha256: "1".repeat(64),
      bindingSha256: "2".repeat(64),
      artifactSha256: "3".repeat(64),
      reviewerId: "independent-reviewer",
      implementationAgentIds: ["agent:implementation-a"],
      hostOperatorIdentityAttested: true,
    };
  };
  const result = await evaluateDeliveryGate(input, dependencies);
  assert.equal(result.status, "PASS");
  assert.equal(result.commit, mergeCommit);
  assert.equal(result.candidateCommit, candidateCommit);
  assert.equal(result.reviewEvidence.commit, candidateCommit);
  assert.deepEqual(reviewedCommits, [candidateCommit]);
});

test("default coverage rejects evidence for a different checkout commit before remote checks", async () => {
  const { input, dependencies } = fixture();
  delete dependencies.verifyCoverage;
  let queriedRemote = false;
  dependencies.readRemote = async () => {
    queriedRemote = true;
    throw Error("must not reach remote");
  };
  await assert.rejects(evaluateDeliveryGate(input, dependencies), { code: "COVERAGE_VERSION" });
  assert.equal(queriedRemote, false);
});
test("a coverage verifier cannot omit its missing required baseline case", async () => {
  const { input, dependencies } = fixture();
  dependencies.verifyCoverage = async () => ({
    status: "PASS",
    requiredCaseIds: ["missing-baseline"],
  });
  await assert.rejects(evaluateDeliveryGate(input, dependencies), { code: "COVERAGE_GATE" });
});
test("gate resolves approved group scope and nonce assertions through trusted bindings", async () => {
  const { input, dependencies } = fixture();
  const suite = JSON.parse(input.suiteText);
  suite.cases[0].featureAssertions.push({
    kind: "trace",
    type: "history_retrieval",
    count: 1,
    where: { query: "{{nonce}}", groups: ["{{group:A}}"], resources: ["group:{{group:A}}"] },
  });
  input.suiteText = JSON.stringify(suite);
  input.suiteSha256 = digest(input.suiteText);
  input.reports[0].suiteSha256 = input.suiteSha256;
  const c = input.reports[0].cases[0];
  c.featureAssertions.push({
    kind: "trace",
    type: "history_retrieval",
    count: 1,
    where: { query: c.token, groups: ["10001"], resources: ["group:10001"] },
  });
  dependencies.resolveRoute = (chat) =>
    chat === "private" ? "private" : chat === "A" ? "10001" : undefined;
  assert.equal((await evaluateDeliveryGate(input, dependencies)).status, "PASS");
  c.featureAssertions[1].where.query = "old-nonce";
  await assert.rejects(evaluateDeliveryGate(input, dependencies), { code: "SUITE_CASE_BINDING" });
  c.featureAssertions[1].where.query = c.token;
  c.featureAssertions[1].where.groups.push("456");
  await assert.rejects(evaluateDeliveryGate(input, dependencies), { code: "SUITE_CASE_BINDING" });
});
test("gate binds the executed message, route, reply assertions and lease operations to approval", async () => {
  for (const alter of [
    (c) => {
      c.prompt += " different task";
    },
    (c) => {
      c.expected = [];
    },
    (c) => {
      c.route = "another-group";
    },
    (c) => {
      c.acceptanceLease.toolsSha256 = "e".repeat(64);
    },
  ]) {
    const { input, dependencies } = fixture();
    alter(input.reports[0].cases[0]);
    await assert.rejects(evaluateDeliveryGate(input, dependencies), { code: "SUITE_CASE_BINDING" });
  }
});
test("gate requires fresh product evidence and exact remote commit", async () => {
  const { input, dependencies } = fixture();
  assert.equal((await evaluateDeliveryGate(input, dependencies)).status, "PASS");
  await assert.rejects(
    evaluateDeliveryGate(input, {
      ...dependencies,
      verifyReport: async () => ({ status: "FAIL" }),
    }),
    /产品证据/,
  );
  await assert.rejects(
    evaluateDeliveryGate(input, {
      ...dependencies,
      readRemote: async () => ({ headCommit: "c".repeat(40) }),
    }),
    /远端 PR/,
  );
});
test("missing regression, unknown cleanup, skipped CI and stale review block merge", async () => {
  for (const mutate of [
    (input) => input.requiredCaseIds.push("uncovered-feature"),
    (input) => (input.reports[0].cases[0].cleanup = { required: true, restored: false }),
    (input) => (input.reports[0].cases[0].leaseRevoked = false),
    (input) => (input.deterministic.full = "FAIL"),
    (input) => (input.userAuthorizedMerge = false),
  ]) {
    const { input, dependencies } = fixture();
    mutate(input);
    await assert.rejects(evaluateDeliveryGate(input, dependencies));
  }
  const { input, dependencies } = fixture();
  await assert.rejects(
    evaluateDeliveryGate(input, {
      ...dependencies,
      readRemote: async () => ({
        headCommit: commit,
        state: "OPEN",
        draft: false,
        mergeable: true,
        review: { commit, status: "CHANGES_REQUESTED" },
        checks: [{ name: "unit", commit, status: "SUCCESS" }],
      }),
    }),
    { code: "REVIEW_GATE" },
  );
  const fresh = fixture();
  await assert.rejects(
    evaluateDeliveryGate(fresh.input, {
      ...fresh.dependencies,
      readRemote: async () => ({
        headCommit: commit,
        state: "OPEN",
        draft: false,
        mergeable: true,
        checks: [{ name: "unit", commit, status: "SKIPPED" }],
      }),
    }),
    /必需 CI/,
  );
  await assert.rejects(evaluateDeliveryGate(input, {}), /重新验证/);
});
test("removing assertions or lease fields cannot downgrade an approved feature to smoke", async () => {
  for (const mutate of [
    (c) => delete c.featureAssertions,
    (c) => delete c.acceptanceLease,
    (c) => (c.featureAssertions = [{ changed: true }]),
  ]) {
    const { input, dependencies } = fixture();
    mutate(input.reports[0].cases[0]);
    await assert.rejects(evaluateDeliveryGate(input, dependencies), /审批套件/);
  }
  const { input, dependencies } = fixture();
  input.suiteText += " ";
  await assert.rejects(evaluateDeliveryGate(input, dependencies), /审批哈希/);
});
test("approved assertions cannot silently become ordinary transport evidence", async () => {
  const { input, dependencies } = fixture();
  const suite = JSON.parse(input.suiteText);
  delete suite.cases[0].leaseTools;
  input.suiteText = JSON.stringify(suite);
  input.suiteSha256 = digest(input.suiteText);
  input.reports[0].suiteSha256 = input.suiteSha256;
  delete input.reports[0].cases[0].featureAssertions;
  delete input.reports[0].cases[0].acceptanceLease;
  await assert.rejects(evaluateDeliveryGate(input, dependencies), /许可范围/);
});

test("Memory family gate requires an independent verifier and accepts exact lifecycle evidence", async () => {
  const { input, dependencies } = memoryFixture();
  await assert.rejects(
    evaluateDeliveryGate(input, { ...dependencies, verifyMemoryReport: undefined }),
    { code: "MEMORY_FAMILY_GATE" },
  );
  assert.equal((await evaluateDeliveryGate(input, dependencies)).status, "PASS");
});

test("Memory feedback-reject family accepts only two unique Runs and rejected cleanup", async () => {
  const { input, dependencies } = memoryFixture(MEMORY_REJECT_FAMILY_ID);
  assert.equal((await evaluateDeliveryGate(input, dependencies)).status, "PASS");

  const wrongFamily = memoryFixture(MEMORY_REJECT_FAMILY_ID);
  wrongFamily.input.reports[0].memoryFamily.caseId = MEMORY_FAMILY_ID;
  await assert.rejects(evaluateDeliveryGate(wrongFamily.input, wrongFamily.dependencies), {
    code: "MEMORY_FAMILY_GATE",
  });

  const wrongCleanup = memoryFixture(MEMORY_REJECT_FAMILY_ID);
  wrongCleanup.dependencies.verifyMemoryReport = async () => ({
    status: "PASS",
    caseId: MEMORY_REJECT_FAMILY_ID,
    runtime: { commit, checkout: "/acceptance/repo", dataDirectory: "/acceptance/data" },
    stageRunIds: ["run-feedback", "run-reject"],
    cleanup: { status: "expired" },
    handles: { cleanupRunId: "run-reject" },
  });
  await assert.rejects(evaluateDeliveryGate(wrongCleanup.input, wrongCleanup.dependencies), {
    code: "MEMORY_FAMILY_GATE",
  });

  const reusedRun = memoryFixture(MEMORY_REJECT_FAMILY_ID);
  reusedRun.dependencies.verifyReport = async () => ({
    status: "PASS",
    runtime: { commit, checkout: "/acceptance/repo", dataDirectory: "/acceptance/data" },
    cases: [
      {
        caseId: "memory-feedback",
        runId: "run-feedback",
        traceVerified: true,
        feature: { status: "PASS" },
      },
      {
        caseId: "memory-reject",
        runId: "run-feedback",
        traceVerified: true,
        feature: { status: "PASS" },
      },
    ],
  });
  await assert.rejects(evaluateDeliveryGate(reusedRun.input, reusedRun.dependencies), {
    code: "MEMORY_FAMILY_GATE",
  });
});

test("Memory family gate rejects duplicate families and mismatched stage Runs", async () => {
  const { input, dependencies } = memoryFixture();
  input.reports.push(structuredClone(input.reports[0]));
  await assert.rejects(evaluateDeliveryGate(input, dependencies), { code: "CASE_DUPLICATE" });

  const mismatch = memoryFixture();
  mismatch.input.reports[0].memoryLifecycle.steps[1].runId = "run-wrong";
  await assert.rejects(evaluateDeliveryGate(mismatch.input, mismatch.dependencies), {
    code: "MEMORY_FAMILY_GATE",
  });
});

test("Memory family gate requires expired cleanup and matching fresh runtime and Run evidence", async () => {
  for (const alter of [
    ({ dependencies }) => {
      dependencies.verifyMemoryReport = async () => ({
        status: "PASS",
        caseId: "memory-project-promote-expire",
        runtime: { commit },
        stageRunIds: ["run-feedback", "run-promote", "run-expire"],
        cleanup: { status: "rejected" },
        handles: { cleanupRunId: "run-expire" },
      });
    },
    ({ dependencies }) => {
      dependencies.verifyMemoryReport = async () => ({
        status: "PASS",
        caseId: "memory-project-promote-expire",
        runtime: { commit, checkout: "/different/checkout", dataDirectory: "/acceptance/data" },
        stageRunIds: ["run-feedback", "run-promote", "run-expire"],
        cleanup: { status: "expired" },
        handles: { cleanupRunId: "run-expire" },
      });
    },
    ({ dependencies }) => {
      dependencies.verifyReport = async () => ({
        status: "PASS",
        runtime: { commit, checkout: "/acceptance/repo", dataDirectory: "/acceptance/data" },
        cases: [
          {
            caseId: "feedback-step",
            runId: "run-feedback",
            traceVerified: true,
            feature: { status: "PASS" },
          },
          {
            caseId: "promote-step",
            runId: "run-feedback",
            traceVerified: true,
            feature: { status: "PASS" },
          },
          {
            caseId: "expire-step",
            runId: "run-expire",
            traceVerified: true,
            feature: { status: "PASS" },
          },
        ],
      });
    },
    ({ dependencies }) => {
      dependencies.verifyReport = async () => ({
        status: "PASS",
        runtime: { commit, checkout: "/acceptance/repo", dataDirectory: "/acceptance/data" },
        cases: [
          {
            caseId: "wrong-step",
            runId: "run-feedback",
            traceVerified: true,
            feature: { status: "PASS" },
          },
          {
            caseId: "promote-step",
            runId: "run-promote",
            traceVerified: true,
            feature: { status: "PASS" },
          },
          {
            caseId: "expire-step",
            runId: "run-expire",
            traceVerified: true,
            feature: { status: "PASS" },
          },
        ],
      });
    },
  ]) {
    const current = memoryFixture();
    alter(current);
    await assert.rejects(evaluateDeliveryGate(current.input, current.dependencies), {
      code: "MEMORY_FAMILY_GATE",
    });
  }
});

test("schema 2 cannot masquerade as an approved Memory family suite", async () => {
  const { input, dependencies } = memoryFixture();
  const suite = JSON.parse(input.suiteText);
  suite.schemaVersion = 2;
  input.suiteText = JSON.stringify(suite);
  input.suiteSha256 = digest(input.suiteText);
  input.reports[0].suiteSha256 = input.suiteSha256;
  await assert.rejects(evaluateDeliveryGate(input, dependencies), { code: "MEMORY_FAMILY_GATE" });
});

function historyFamilyFixture() {
  const f = fixture();
  const id = "history-group-seed-private-recall";
  const text = JSON.stringify({
    schemaVersion: 4,
    cases: [{ id, kind: "history-seed", chat: "A" }],
  });
  const runs = ["seed-run", "recall-run"],
    cases = ["history-current-group-hit", "history-seed-recall"];
  f.input.suiteText = text;
  f.input.suiteSha256 = digest(text);
  f.input.requiredCaseIds = [id];
  const report = {
    status: "PASS",
    mode: "run",
    suiteSha256: digest(text),
    productAcceptance: { status: "PASS", runtime: { commit } },
    historyFamily: { caseId: id },
    historySeedWorkflow: { stageRunIds: runs },
    cases: cases.map((id) => ({ id, status: "PASS", leaseRevoked: true })),
  };
  f.input.reports = [report];
  f.dependencies.verifyCoverage = async () => ({ status: "PASS", requiredCaseIds: [id] });
  f.dependencies.verifyReport = async () => ({
    status: "PASS",
    runtime: { commit },
    cases: cases.map((caseId, i) => ({
      caseId,
      runId: runs[i],
      traceVerified: true,
      feature: { status: "PASS" },
    })),
  });
  f.dependencies.verifyHistoryReport = async () => ({
    status: "PASS",
    caseId: id,
    runtime: { commit },
    stageRunIds: runs,
    cleanup: { required: false, leaseRevoked: true },
  });
  return f;
}
test("delivery rechecks the fixed history family before counting either stage", async () => {
  const f = historyFamilyFixture();
  assert.equal((await evaluateDeliveryGate(f.input, f.dependencies)).status, "PASS");
  for (const changed of [
    undefined,
    async () => ({ status: "FAIL" }),
    async () => ({
      status: "PASS",
      caseId: "foreign",
      runtime: { commit },
      stageRunIds: ["seed-run", "recall-run"],
      cleanup: { required: false, leaseRevoked: true },
    }),
  ])
    await assert.rejects(
      evaluateDeliveryGate(f.input, { ...f.dependencies, verifyHistoryReport: changed }),
    );
  f.input.reports[0].historySeedWorkflow.stageRunIds = ["seed-run", "foreign-run"];
  await assert.rejects(evaluateDeliveryGate(f.input, f.dependencies));
});
test("history family cannot impersonate reads or an older suite schema", async () => {
  const f = historyFamilyFixture();
  delete f.input.reports[0].historyFamily;
  delete f.input.reports[0].historySeedWorkflow;
  await assert.rejects(evaluateDeliveryGate(f.input, f.dependencies));
  const g = historyFamilyFixture();
  g.input.suiteText = g.input.suiteText.replace('"schemaVersion":4', '"schemaVersion":3');
  g.input.suiteSha256 = digest(g.input.suiteText);
  g.input.reports[0].suiteSha256 = g.input.suiteSha256;
  await assert.rejects(evaluateDeliveryGate(g.input, g.dependencies));
});

function historyIsolationGateFixture() {
  const f = historyFamilyFixture();
  const id = "history-cross-group-isolation";
  const text = JSON.stringify({
    schemaVersion: 5,
    cases: [{ id, kind: "history-isolation", chat: "B" }],
  });
  const names = ["history-cross-group-seed", "history-cross-group-private-exclusion"];
  const runs = ["seed-run", "exclusion-run"];
  f.input.suiteText = text;
  f.input.suiteSha256 = digest(text);
  f.input.requiredCaseIds = [id];
  const r = f.input.reports[0];
  r.suiteSha256 = digest(text);
  r.historyFamily = { caseId: id };
  delete r.historySeedWorkflow;
  r.historyIsolationWorkflow = { stageRunIds: runs };
  r.cases = names.map((id) => ({ id, status: "PASS", leaseRevoked: true }));
  f.dependencies.verifyCoverage = async () => ({ status: "PASS", requiredCaseIds: [id] });
  f.dependencies.verifyReport = async () => ({
    status: "PASS",
    runtime: { commit },
    cases: names.map((caseId, i) => ({
      caseId,
      runId: runs[i],
      traceVerified: true,
      feature: { status: "PASS" },
    })),
  });
  f.dependencies.verifyHistoryReport = async () => ({
    status: "PASS",
    caseId: id,
    runtime: { commit },
    stageRunIds: runs,
    cleanup: { required: false, leaseRevoked: true },
  });
  return f;
}

test("delivery independently rechecks the isolation family and rejects workflow substitution", async () => {
  const f = historyIsolationGateFixture();
  assert.equal((await evaluateDeliveryGate(f.input, f.dependencies)).status, "PASS");
  for (const alter of [
    (f) => {
      f.input.reports[0].historySeedWorkflow = { stageRunIds: ["seed-run", "exclusion-run"] };
    },
    (f) => {
      delete f.input.reports[0].historyIsolationWorkflow;
    },
    (f) => {
      f.input.reports[0].historyIsolationWorkflow.stageRunIds = ["foreign-run", "exclusion-run"];
    },
    (f) => {
      f.dependencies.verifyHistoryReport = undefined;
    },
    (f) => {
      const suite = JSON.parse(f.input.suiteText);
      suite.schemaVersion = 4;
      f.input.suiteText = JSON.stringify(suite);
      f.input.suiteSha256 = digest(f.input.suiteText);
      f.input.reports[0].suiteSha256 = f.input.suiteSha256;
    },
  ]) {
    const bad = historyIsolationGateFixture();
    alter(bad);
    await assert.rejects(evaluateDeliveryGate(bad.input, bad.dependencies), {
      code: "HISTORY_FAMILY_GATE",
    });
  }
});
