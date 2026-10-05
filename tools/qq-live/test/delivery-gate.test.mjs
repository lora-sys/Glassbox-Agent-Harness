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
