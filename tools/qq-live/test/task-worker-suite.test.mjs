import test from "node:test";
import assert from "node:assert/strict";
import { resolveFeatureSuite } from "../lib/feature-suite.mjs";
const family = {
  id: "task-worker-artifact-lifecycle",
  kind: "task-worker-artifact-lifecycle",
  chat: "private",
};
test("schema 8 selects exactly the fixed private Task Worker lifecycle", () => {
  const result = resolveFeatureSuite({ schemaVersion: 8, cases: [family] }, {});
  assert.deepEqual(result.taskWorkerFamilies, [family]);
  assert.deepEqual(result.readCases, []);
  for (const cases of [
    [],
    [family, family],
    [{ ...family, chat: "A" }],
    [{ ...family, workspaceId: "arbitrary" }],
    [{ ...family, prompt: "custom" }],
  ])
    assert.throws(() => resolveFeatureSuite({ schemaVersion: 8, cases }, {}));
});
