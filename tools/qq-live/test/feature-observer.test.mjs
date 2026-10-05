import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { observeFeature, validateFeatureAssertions } from "../lib/feature-observer.mjs";

const assertion = {
  kind: "trace",
  type: "tool_result",
  where: { name: "task_create", isError: false },
  count: 1,
};
const events = [
  { type: "tool_call", runId: "run-1", toolCallId: "call-1", data: { name: "task_create" } },
  {
    type: "tool_result",
    runId: "run-1",
    toolCallId: "call-1",
    data: { name: "task_create", isError: false },
  },
];
test("history evidence binds exact query and complete source scope without payload", () => {
  const history = {
    kind: "trace",
    type: "history_retrieval",
    count: 1,
    where: {
      query: "fresh-nonce",
      groups: ["group:123"],
      resources: ["group:123"],
      sourceKind: "channel_message",
      retrievalMode: "lexical",
    },
  };
  const event = { type: "history_retrieval", runId: "run-1", ...history.where };
  assert.equal(observeFeature([history], { events: [event], runId: "run-1" }).status, "PASS");
  for (const changed of [
    { query: "old-nonce" },
    { groups: ["group:123", "group:456"] },
    { resources: [] },
    { groups: "group:123" },
  ])
    assert.throws(
      () => observeFeature([history], { events: [{ ...event, ...changed }], runId: "run-1" }),
      /功能事件/,
    );
  for (const invalid of [[], ["group:123", "group:123"], [123], Array(9).fill("group:123")])
    assert.throws(() => validateFeatureAssertions([{ ...history, where: { groups: invalid } }]));
  assert.throws(() => validateFeatureAssertions([{ ...history, where: { items: [] } }]));
});
test("successful tool result requires matching current Run and call", () => {
  assert.equal(observeFeature([assertion], { events, runId: "run-1" }).status, "PASS");
  assert.throws(() => observeFeature([assertion], { events, runId: "run-2" }), /功能事件/);
  assert.throws(
    () => observeFeature([assertion], { events: events.slice(1), runId: "run-1" }),
    /对应调用/,
  );
  assert.throws(
    () => observeFeature([assertion], { events: [...events, events[1]], runId: "run-1" }),
    /功能事件/,
  );
});
test("observers reject arbitrary queries, unimplemented events and payload fields", () => {
  for (const bad of [
    [],
    [{ kind: "sql", sql: "SELECT * FROM messages" }],
    [{ ...assertion, where: { outputHead: "content" } }],
    [{ ...assertion, type: "unknown" }],
    [{ ...assertion, count: 0 }],
    [{ ...assertion, script: "anything" }],
  ])
    assert.throws(() => validateFeatureAssertions(bad));
});
test("state proves persisted result and originating Run without reading payload", (t) => {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  db.exec(
    "CREATE TABLE tasks(id TEXT, status TEXT, run_id TEXT); CREATE TABLE memory_candidates(id TEXT, status TEXT, source_json TEXT); CREATE TABLE memory_audit_events(id TEXT,target_id TEXT,run_id TEXT,action TEXT);",
  );
  db.prepare("INSERT INTO tasks VALUES (?,?,?)").run("task-test", "NEW", "run-1");
  db.prepare("INSERT INTO memory_candidates VALUES (?,?,?)").run(
    "candidate-test",
    "pending",
    JSON.stringify({ kind: "system", ref: "run:run-1" }),
  );
  const assertions = [
    { kind: "state", resource: "task", id: "task-test", status: "NEW" },
    { kind: "state", resource: "memory_candidate", id: "candidate-test", status: "pending" },
  ];
  assert.equal(observeFeature(assertions, { db, events, runId: "run-1" }).observations.length, 2);
  assert.throws(() => observeFeature(assertions, { db, events, runId: "run-old" }), /本轮 Run/);
  assert.throws(
    () => observeFeature([{ ...assertions[0], status: "DONE" }], { db, events, runId: "run-1" }),
    /资源状态/,
  );
  assert.throws(
    () => observeFeature([{ ...assertions[0], id: "task-absent" }], { db, events, runId: "run-1" }),
    /不存在/,
  );
  db.prepare("UPDATE memory_candidates SET source_json=? WHERE id=?").run(
    JSON.stringify({ kind: "human", ref: "principal:owner" }),
    "candidate-test",
  );
  assert.throws(() => observeFeature([assertions[1]], { db, events, runId: "run-1" }), /本轮 Run/);
  db.prepare("INSERT INTO memory_audit_events VALUES (?,?,?,?)").run(
    "audit-1",
    "candidate-test",
    "run-1",
    "write",
  );
  assert.equal(observeFeature([assertions[1]], { db, events, runId: "run-1" }).status, "PASS");
});
