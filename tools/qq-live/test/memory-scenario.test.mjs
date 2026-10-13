import test from "node:test";
import assert from "node:assert/strict";
import { memoryFixtureProject, memoryFixtureStep } from "../lib/memory-scenario.mjs";
import { validateReadFeatureSpecs } from "../lib/feature-specs.mjs";

const nonce = "a".repeat(32);
test("fixed Memory fixture creation stays in one unique project and explicit feedback", () => {
  const spec = memoryFixtureStep("feedback", { nonce });
  assert.equal(memoryFixtureProject(nonce), `qqtest-${nonce}`);
  assert.deepEqual(spec.leaseTools[0].operations, [
    {
      action: "memory:write",
      resourceId: "owner-memory",
      inputConstraint: {
        action: "feedback",
        scopeType: "project",
        projectId: `qqtest-${nonce}`,
        signalType: "explicit_positive",
        statement: `qqtest-${nonce}`,
      },
    },
  ]);
  assert.match(spec.prompt, /\n请在回复中包含本轮测试编号 \{\{nonce\}\}。$/);
  assert.deepEqual(spec.expectContains, ["{{nonce}}"]);
  assert.throws(
    () => validateReadFeatureSpecs({ schemaVersion: 2, cases: [spec] }, { groups: [] }),
    { code: "FEATURE_CLEANUP_UNSUPPORTED" },
  );
});
test("governance steps bind exact new candidate or Memory handles and no wider inputs", () => {
  const candidateId = `candidate_${"b".repeat(32)}`,
    memoryId = `memory_${"c".repeat(32)}`;
  for (const stage of ["promote", "reject", "expire"]) {
    const spec = memoryFixtureStep(stage, { nonce, candidateId, memoryId });
    const id = stage === "expire" ? memoryId : candidateId;
    assert.deepEqual(spec.leaseTools[0].operations, [
      {
        action: "memory:govern",
        resourceId: "owner-memory",
        inputConstraint: { action: stage, id },
      },
    ]);
    assert.equal(spec.prompt.split("\n")[0], `/memory ${stage} ${id}`);
  }
  for (const bad of [
    "global",
    "candidate_legacy_" + "b".repeat(32),
    "candidate_existing",
    memoryId,
  ])
    assert.throws(() => memoryFixtureStep("promote", { nonce, candidateId: bad }));
  assert.throws(() => memoryFixtureStep("expire", { nonce, memoryId: candidateId }));
});
test("unknown stages, injected fixture IDs and missing nonces fail before execution", () => {
  for (const value of [null, "", "a".repeat(31), "A".repeat(32), `${nonce}\ncommand`])
    assert.throws(() => memoryFixtureProject(value));
  assert.throws(() => memoryFixtureStep("delete", { nonce }));
  assert.throws(() => memoryFixtureStep("promote", { nonce }));
});
