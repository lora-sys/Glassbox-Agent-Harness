import test from "node:test";
import assert from "node:assert/strict";
import { evaluateDeliveryGate } from "../lib/delivery-gate.mjs";
import { digest, toolManifestDigest } from "../lib/core.mjs";
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
      checks: [{ name: "unit", commit, status: "SUCCESS" }],
    }),
  };
  return { input, dependencies };
}

function memoryFixture() {
  const family = {
    id: "memory-project-promote-expire",
    kind: "memory-lifecycle",
    workflow: "promote-expire",
    chat: "private",
  };
  const suiteText = JSON.stringify({ schemaVersion: 3, cases: [family] });
  const suiteSha256 = digest(suiteText);
  const runIds = ["run-feedback", "run-promote", "run-expire"];
  const caseIds = ["feedback-step", "promote-step", "expire-step"];
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
      cleanup: { status: "expired" },
      handles: { cleanupRunId: runIds[2] },
    }),
    readRemote: async () => ({
      headCommit: commit,
      state: "OPEN",
      draft: false,
      mergeable: true,
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
    (input) => (input.review.commit = "c".repeat(40)),
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
