import test from "node:test";
import assert from "node:assert/strict";
import {
  MEMORY_FAMILY_ID,
  memoryFamilyPlan,
  resolveFeatureSuite,
  validateMemoryFamily,
} from "../lib/feature-suite.mjs";

const config = { groups: [] };
const memoryFamily = () => ({
  id: MEMORY_FAMILY_ID,
  kind: "memory-lifecycle",
  workflow: "promote-expire",
  chat: "private",
});
const readCase = (id = "ops-status") => ({
  id,
  chat: "private",
  prompt: "检查状态并引用编号 {{nonce}}",
  expectContains: ["{{nonce}}"],
  sideEffect: "none",
  leaseTools: [
    {
      name: "ops_status",
      operations: [{ action: "ops:status", resourceId: "agent-ops", inputConstraint: {} }],
    },
  ],
  featureAssertions: [
    {
      kind: "trace",
      type: "tool_result",
      where: { name: "ops_status", isError: false },
      count: 1,
    },
  ],
});

test("schema 2 read suites retain the existing parser behavior", () => {
  const raw = { schemaVersion: 2, cases: [readCase()] };
  const resolved = resolveFeatureSuite(raw, config);
  assert.equal(resolved.cases.length, 1);
  assert.deepEqual(resolved.cases, resolved.readCases);
  assert.deepEqual(resolved.memoryFamilies, []);
  assert.equal(resolved.readCases[0].id, "ops-status");
});

test("schema 3 admits one exact Memory family with mixed read cases", () => {
  const memoryCase = memoryFamily();
  const read = readCase();
  const resolved = resolveFeatureSuite({ schemaVersion: 3, cases: [memoryCase, read] }, config);
  assert.deepEqual(
    resolved.cases.map((item) => item.id),
    [MEMORY_FAMILY_ID, "ops-status"],
  );
  assert.deepEqual(
    resolved.readCases.map((item) => item.id),
    ["ops-status"],
  );
  assert.equal(resolved.memoryFamilies[0], memoryCase);
  assert.equal(validateMemoryFamily(memoryCase), memoryCase);
});

test("schema 3 supports only one exact fixed Memory family and rejects extensions", () => {
  const invalidFamilies = [
    { ...memoryFamily(), id: "custom-memory" },
    { ...memoryFamily(), kind: "custom-lifecycle" },
    { ...memoryFamily(), workflow: "feedback-only" },
    { ...memoryFamily(), chat: "A" },
    { ...memoryFamily(), prompt: "arbitrary instruction" },
    { ...memoryFamily(), tools: ["owner_memory_admin"] },
    { ...memoryFamily(), assertions: [] },
    { ...memoryFamily(), fixture: { projectId: "qqtest-fixed" } },
    { ...memoryFamily(), candidateId: "candidate_fixed" },
    { ...memoryFamily(), cleanup: "arbitrary cleanup" },
  ];
  for (const family of invalidFamilies) {
    assert.throws(() => resolveFeatureSuite({ schemaVersion: 3, cases: [family] }, config), {
      code: "FEATURE_MEMORY_FAMILY",
      status: "BLOCKED",
    });
  }
  assert.throws(
    () =>
      resolveFeatureSuite({ schemaVersion: 3, cases: [memoryFamily(), memoryFamily()] }, config),
    { code: "FEATURE_CASE", status: "BLOCKED" },
  );
  assert.throws(
    () =>
      resolveFeatureSuite(
        { schemaVersion: 3, cases: [memoryFamily(), readCase(MEMORY_FAMILY_ID)] },
        config,
      ),
    { code: "FEATURE_CASE", status: "BLOCKED" },
  );
  assert.throws(() => resolveFeatureSuite({ schemaVersion: 3, cases: [readCase()] }, config), {
    code: "FEATURE_MEMORY_FAMILY",
    status: "BLOCKED",
  });
});

test("schema and case shapes fail closed", () => {
  for (const suite of [
    { schemaVersion: 1, cases: [memoryFamily()] },
    { schemaVersion: 4, cases: [memoryFamily()] },
    { schemaVersion: 3, cases: [memoryFamily()], fixture: {} },
    { schemaVersion: 3, cases: [] },
  ])
    assert.throws(() => resolveFeatureSuite(suite, config));
});

test("Memory plan uses the same three fixed stage specifications and zeroed IDs", () => {
  const plan = memoryFamilyPlan();
  assert.equal(plan.schemaVersion, 3);
  assert.equal(plan.scenario, "memory-lifecycle");
  assert.deepEqual(
    plan.stages.map(({ stage }) => stage),
    ["feedback", "promote", "expire"],
  );
  assert.ok(plan.stages.every(({ spec }) => spec.chat === "private"));
  assert.ok(plan.stages[0].spec.prompt.includes("qqtest-{{fixture_nonce}}"));
  assert.ok(plan.stages[1].spec.prompt.includes("{{candidate_id}}"));
  assert.ok(plan.stages[2].spec.prompt.includes("{{memory_id}}"));
  assert.ok(plan.stages.every(({ spec }) => spec.leaseTools[0].name === "owner_memory_admin"));
});
