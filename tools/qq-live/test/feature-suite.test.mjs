import test from "node:test";
import assert from "node:assert/strict";
import {
  MEMORY_FAMILY_ID,
  MEMORY_REJECT_FAMILY_ID,
  memoryFamilyPlan,
  resolveFeatureSuite,
  validateMemoryFamily,
  validateTasteFamily,
} from "../lib/feature-suite.mjs";
import { TASTE_FAMILY_ID, tasteFamilyPlan } from "../lib/taste-scenario.mjs";

const config = { groups: [] };
const memoryFamily = () => ({
  id: MEMORY_FAMILY_ID,
  kind: "memory-lifecycle",
  workflow: "promote-expire",
  chat: "private",
});
const tasteFamily = () => ({
  id: TASTE_FAMILY_ID,
  kind: "taste-lifecycle",
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

test("schema 3 supports only exact fixed Memory families and rejects extensions", () => {
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

test("reject family has an exact two-stage plan and can share a suite with promotion", () => {
  const reject = {
    id: MEMORY_REJECT_FAMILY_ID,
    kind: "memory-lifecycle",
    workflow: "feedback-reject",
    chat: "private",
  };
  const resolved = resolveFeatureSuite(
    { schemaVersion: 3, cases: [memoryFamily(), reject, readCase()] },
    config,
  );
  assert.deepEqual(
    resolved.memoryFamilies.map((c) => c.id),
    [MEMORY_FAMILY_ID, MEMORY_REJECT_FAMILY_ID],
  );
  assert.equal(validateMemoryFamily(reject), reject);
  const plan = memoryFamilyPlan(MEMORY_REJECT_FAMILY_ID);
  assert.deepEqual(
    plan.stages.map((s) => s.stage),
    ["feedback", "reject"],
  );
  assert.ok(plan.stages[1].spec.prompt.includes("{{candidate_id}}"));
  assert.ok(!plan.stages[1].spec.prompt.includes("{{memory_id}}"));
  for (const changed of [
    { ...reject, workflow: "promote-expire" },
    { ...reject, chat: "A" },
    { ...reject, stages: ["feedback", "reject"] },
    { ...reject, id: "memory-project-other" },
  ])
    assert.throws(() => validateMemoryFamily(changed), { code: "FEATURE_MEMORY_FAMILY" });
  assert.throws(() => resolveFeatureSuite({ schemaVersion: 3, cases: [reject, reject] }, config), {
    code: "FEATURE_CASE",
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

test("schema 4 accepts only the fixed history family alongside existing reads and Memory", () => {
  const family = { id: "history-group-seed-private-recall", kind: "history-seed", chat: "A" };
  const cfg = {
    groups: [
      { alias: "A", id: "10001" },
      { alias: "B", id: "10002" },
    ],
  };
  const resolved = resolveFeatureSuite(
    { schemaVersion: 4, cases: [family, memoryFamily(), readCase()] },
    cfg,
  );
  assert.deepEqual(resolved.historyFamilies, [family]);
  assert.equal(resolved.readCases.length, 1);
  assert.equal(resolved.memoryFamilies.length, 1);
  for (const changed of [
    { ...family, chat: "B" },
    { ...family, id: "custom" },
    { ...family, prompt: "extra" },
  ])
    assert.throws(() => resolveFeatureSuite({ schemaVersion: 4, cases: [changed] }, cfg));
  assert.throws(() => resolveFeatureSuite({ schemaVersion: 4, cases: [readCase()] }, cfg));
  assert.throws(() =>
    resolveFeatureSuite({ schemaVersion: 3, cases: [family, memoryFamily()] }, cfg),
  );
  assert.throws(() => resolveFeatureSuite({ schemaVersion: 4, cases: [family] }, config));
});

test("schema 5 binds both fixed history families while schema 4 stays unchanged", () => {
  assert.equal(
    resolveFeatureSuite(
      {
        schemaVersion: 5,
        cases: [{ id: "history-group-seed-private-recall", kind: "history-seed", chat: "A" }],
      },
      { groups: [{ alias: "A", id: "123" }] },
    ).historyFamilies.length,
    1,
  );
  const scopes = {
    groups: [
      { alias: "A", id: "123" },
      { alias: "B", id: "456" },
    ],
  };
  const old = { id: "history-group-seed-private-recall", kind: "history-seed", chat: "A" };
  const isolation = { id: "history-cross-group-isolation", kind: "history-isolation", chat: "B" };
  assert.equal(
    resolveFeatureSuite({ schemaVersion: 5, cases: [old, isolation] }, scopes).historyFamilies
      .length,
    2,
  );
  assert.equal(
    resolveFeatureSuite({ schemaVersion: 5, cases: [isolation] }, scopes).historyFamilies.length,
    1,
  );
  assert.equal(
    resolveFeatureSuite({ schemaVersion: 4, cases: [old] }, scopes).historyFamilies.length,
    1,
  );
  for (const cases of [[isolation], [old, isolation]])
    assert.throws(() => resolveFeatureSuite({ schemaVersion: 4, cases }, scopes));
  for (const bad of [
    { ...isolation, chat: "A" },
    { ...isolation, id: "arbitrary" },
    { ...isolation, extra: true },
  ])
    assert.throws(() => resolveFeatureSuite({ schemaVersion: 5, cases: [bad] }, scopes));
  assert.throws(() =>
    resolveFeatureSuite(
      { schemaVersion: 5, cases: [isolation] },
      {
        groups: [
          { alias: "A", id: "123" },
          { alias: "B", id: "123" },
        ],
      },
    ),
  );
});

test("schema 6 requires one exact Taste family and composes fixed read, Memory and history cases", () => {
  const taste = tasteFamily();
  const old = { id: "history-group-seed-private-recall", kind: "history-seed", chat: "A" };
  const isolation = { id: "history-cross-group-isolation", kind: "history-isolation", chat: "B" };
  const cfg = {
    groups: [
      { alias: "A", id: "10001" },
      { alias: "B", id: "10002" },
    ],
  };
  const read = readCase();
  const resolvedTasteOnly = resolveFeatureSuite({ schemaVersion: 6, cases: [taste] }, config);
  assert.deepEqual(resolvedTasteOnly.tasteFamilies, [taste]);
  assert.deepEqual(resolvedTasteOnly.memoryFamilies, []);
  assert.deepEqual(resolvedTasteOnly.historyFamilies, []);
  assert.deepEqual(resolvedTasteOnly.readCases, []);

  const resolved = resolveFeatureSuite(
    { schemaVersion: 6, cases: [read, memoryFamily(), old, isolation, taste] },
    cfg,
  );
  assert.deepEqual(
    resolved.cases.map((item) => item.id),
    ["ops-status", MEMORY_FAMILY_ID, old.id, isolation.id, TASTE_FAMILY_ID],
  );
  assert.deepEqual(resolved.tasteFamilies, [taste]);
  assert.equal(resolved.memoryFamilies.length, 1);
  assert.equal(resolved.historyFamilies.length, 2);
  assert.deepEqual(
    tasteFamilyPlan().stages.map((stage) => stage.id),
    ["taste-feedback", "taste-promote", "taste-negative-feedback", "taste-retire"],
  );
  assert.equal(validateTasteFamily(taste), taste);
});

test("Taste suite family is schema 6 only and cannot be extended or omitted", () => {
  const valid = tasteFamily();
  for (const changed of [
    { ...valid, id: "arbitrary-taste" },
    { ...valid, kind: "memory-lifecycle" },
    { ...valid, chat: "A" },
    { ...valid, workflow: "feedback-only" },
    { ...valid, stages: ["feedback"] },
  ])
    assert.throws(() => validateTasteFamily(changed), { code: "FEATURE_TASTE_FAMILY" });
  for (const schemaVersion of [2, 3, 4, 5]) {
    if (schemaVersion === 2)
      assert.throws(() => resolveFeatureSuite({ schemaVersion, cases: [valid] }, config));
    else
      assert.throws(() => resolveFeatureSuite({ schemaVersion, cases: [valid] }, config), {
        code: "FEATURE_TASTE_FAMILY",
      });
  }
  assert.throws(() => resolveFeatureSuite({ schemaVersion: 6, cases: [readCase()] }, config), {
    code: "FEATURE_TASTE_FAMILY",
  });
  assert.throws(
    () =>
      resolveFeatureSuite(
        { schemaVersion: 6, cases: [valid, { ...valid, id: "duplicate" }] },
        config,
      ),
    { code: "FEATURE_TASTE_FAMILY" },
  );
  assert.throws(
    () => resolveFeatureSuite({ schemaVersion: 6, cases: [valid, { ...valid }] }, config),
    { code: "FEATURE_CASE" },
  );
});
