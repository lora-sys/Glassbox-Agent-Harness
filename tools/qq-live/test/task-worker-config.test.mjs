import test from "node:test";
import assert from "node:assert/strict";
import { taskWorkerFixtureConfig } from "../lib/task-worker-config.mjs";
const fixed = {
  enabled: true,
  retainAuditConfirmed: true,
  canonicalRoot: "/fixture",
  markerSha256: "a".repeat(64),
  workspaceId: "w2",
  productWorkspaceId: "workspace_fixture",
  herdrSession: "fixture",
  agentKind: "pi",
  timeoutMs: 600000,
};
test("Worker acceptance accepts only a complete protected fixed target", () => {
  assert.deepEqual(taskWorkerFixtureConfig({ taskWorkerFixtures: fixed }), fixed);
  assert.notEqual(taskWorkerFixtureConfig({ taskWorkerFixtures: fixed }), fixed);
  for (const change of [
    { enabled: false },
    { retainAuditConfirmed: false },
    { canonicalRoot: "relative" },
    { canonicalRoot: "/fixture/../other" },
    { markerSha256: "bad" },
    { workspaceId: "" },
    { agentKind: "shell" },
    { timeoutMs: Infinity },
    { extra: "unsupported" },
  ])
    assert.throws(() => taskWorkerFixtureConfig({ taskWorkerFixtures: { ...fixed, ...change } }));
});
