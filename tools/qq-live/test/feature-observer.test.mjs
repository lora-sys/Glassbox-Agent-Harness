import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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

test("group member aggregate observer verifies full hashed Trace output and exact safe projection", () => {
  const assertion = {
    kind: "aggregate_projection",
    tool: "qq_group_members",
    count: 1,
  };
  const outputHead = JSON.stringify({
    content: [{ type: "text", text: '{"memberCount":3}' }],
    details: { memberCount: 3 },
  });
  const event = {
    type: "tool_result",
    runId: "run-members",
    toolCallId: "call-members",
    data: {
      name: "qq_group_members",
      isError: false,
      outputHead,
      outputTruncated: false,
      outputBytes: Buffer.byteLength(outputHead, "utf8"),
      outputSha256: createHash("sha256").update(outputHead, "utf8").digest("hex"),
    },
  };
  const events = [
    {
      type: "tool_call",
      runId: "run-members",
      toolCallId: "call-members",
      data: { name: "qq_group_members" },
    },
    event,
  ];
  const result = observeFeature([assertion], { events, runId: "run-members" });
  assert.deepEqual(result.observations, [
    {
      kind: "aggregate_projection",
      tool: "qq_group_members",
      memberCount: 3,
      identifiersExposed: false,
    },
  ]);

  const verifyFailure = (mutate, code) => {
    const changed = structuredClone(events);
    mutate(changed[1].data);
    assert.throws(() => observeFeature([assertion], { events: changed, runId: "run-members" }), {
      code,
    });
  };
  verifyFailure((data) => (data.outputTruncated = true), "FEATURE_AGGREGATE_TRACE");
  verifyFailure((data) => (data.outputBytes += 1), "FEATURE_AGGREGATE_TRACE");
  verifyFailure((data) => (data.outputSha256 = "0".repeat(64)), "FEATURE_AGGREGATE_TRACE");

  for (const details of [
    { memberCount: 3, user_id: "12345" },
    { memberCount: 3, nickname: "private-name" },
    { memberCount: 2 },
  ]) {
    const changed = structuredClone(events);
    const projection = {
      content: [
        {
          type: "text",
          text: JSON.stringify(details.memberCount === 2 ? { memberCount: 3 } : details),
        },
      ],
      details,
    };
    const head = JSON.stringify(projection);
    Object.assign(changed[1].data, {
      outputHead: head,
      outputBytes: Buffer.byteLength(head, "utf8"),
      outputSha256: createHash("sha256").update(head, "utf8").digest("hex"),
    });
    assert.throws(() => observeFeature([assertion], { events: changed, runId: "run-members" }), {
      code: "FEATURE_AGGREGATE_PROJECTION",
    });
  }

  const duplicateKeyHeads = [
    `{"content":[{"type":"text","text":${JSON.stringify('{"memberCount":3}')}}],"details":{"memberCount":3,"user_id":"12345"},"details":{"memberCount":3}}`,
    `{"content":[{"type":"text","text":${JSON.stringify('{"memberCount":3,"user_id":"12345","user_id":"67890"}')}}],"details":{"memberCount":3}}`,
  ];
  for (const head of duplicateKeyHeads) {
    const changed = structuredClone(events);
    Object.assign(changed[1].data, {
      outputHead: head,
      outputBytes: Buffer.byteLength(head, "utf8"),
      outputSha256: createHash("sha256").update(head, "utf8").digest("hex"),
    });
    assert.throws(() => observeFeature([assertion], { events: changed, runId: "run-members" }), {
      code: "FEATURE_AGGREGATE_PROJECTION",
    });
  }
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
