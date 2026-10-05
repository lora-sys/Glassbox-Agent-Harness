import test from "node:test";
import assert from "node:assert/strict";
import { validateReadFeatureSpecs } from "../lib/feature-specs.mjs";
const config = { groups: [{ alias: "A", id: "20001" }] };
function suite() {
  return {
    schemaVersion: 2,
    cases: [
      {
        id: "ops-read",
        chat: "private",
        prompt: "Read counts and reply {{nonce}}",
        expectContains: ["{{nonce}}"],
        sideEffect: "none",
        leaseTools: [
          {
            name: "ops_status",
            operations: [
              { action: "ops:status", resourceId: "agent-operations", inputConstraint: {} },
            ],
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
      },
    ],
  };
}
test("structured feature cases require actual permitted tool execution", () => {
  assert.equal(validateReadFeatureSpecs(suite(), config).length, 1);
  for (const change of [
    (s) => (s.cases[0].sideEffect = "reversible"),
    (s) => (s.cases[0].leaseTools[0].name = "task_create"),
    (s) => (s.cases[0].leaseTools[0].operations[0].action = "task:create"),
    (s) => (s.cases[0].featureAssertions[0].where.isError = true),
    (s) => (s.cases[0].chat = "unconfigured"),
    (s) => (s.cases[0].script = "arbitrary"),
    (s) => s.cases.push(structuredClone(s.cases[0])),
  ]) {
    const raw = suite();
    change(raw);
    assert.throws(() => validateReadFeatureSpecs(raw, config));
  }
});
