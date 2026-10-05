import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { caseEvidence, runtimeSnapshot, verifyTraceEvidence } from "../lib/product-evidence.mjs";

test("runtime verification rejects a stopped process and wrong commit", () => {
  const runtime = {
    checkout: process.cwd(),
    dataDirectory: process.cwd(),
    expectedCommit: "a".repeat(40),
    connectionId: "qq-live",
  };
  const capture = (command, args) =>
    command === "git"
      ? args[0] === "rev-parse"
        ? runtime.expectedCommit
        : ""
      : JSON.stringify({
          dataDirectory: runtime.dataDirectory,
          processes: [{ name: "glassbox", running: false }],
          glassboxReady: true,
          onebotReady: true,
        });
  assert.throws(() => runtimeSnapshot(runtime, capture), { code: "RUNTIME_UNVERIFIED" });
  assert.throws(() => runtimeSnapshot(runtime, () => "b".repeat(40)), { code: "RUNTIME_VERSION" });
});
test("matching current checkout cannot substitute for launch commit evidence", () => {
  const runtime = {
    checkout: process.cwd(),
    dataDirectory: process.cwd(),
    expectedCommit: "a".repeat(40),
    connectionId: "qq-live",
  };
  const capture = (command, args) =>
    command === "git"
      ? args[0] === "rev-parse"
        ? runtime.expectedCommit
        : ""
      : JSON.stringify({
          dataDirectory: runtime.dataDirectory,
          processes: [
            {
              name: "glassbox",
              running: true,
              status: "running",
              pid: 123,
              checkout: runtime.checkout,
              launchCommit: "b".repeat(40),
              launchClean: true,
            },
          ],
          glassboxReady: true,
          onebotReady: true,
        });
  assert.throws(() => runtimeSnapshot(runtime, capture), { code: "RUNTIME_LAUNCH_VERSION" });
});
test("runtime evidence requires the expected connection ID", () => {
  const runtime = {
    checkout: process.cwd(),
    dataDirectory: process.cwd(),
    expectedCommit: "a".repeat(40),
  };
  assert.throws(() => runtimeSnapshot(runtime, () => ""), { code: "RUNTIME_CONFIG" });
});

function evidenceFixture({ connectionId = "qq-live", threadId = null } = {}) {
  const db = new DatabaseSync(":memory:");
  db.exec(
    "CREATE TABLE messages(id TEXT, external_id TEXT, scope_key TEXT); CREATE TABLE runs(id TEXT, message_id TEXT, status TEXT, scope_json TEXT, created_at TEXT); CREATE TABLE authorization_decisions_all(id TEXT, run_id TEXT, action TEXT, decision TEXT); CREATE TABLE deliveries(id TEXT, run_id TEXT, status TEXT, external_id TEXT, destination_scope_key TEXT);",
  );
  const now = new Date().toISOString();
  const scope = {
    connectionId,
    botId: "10002",
    chatType: "group",
    chatId: "20001",
    senderId: "10001",
    threadId,
  };
  const scopeKey = JSON.stringify([
    scope.connectionId,
    scope.botId,
    scope.chatType,
    scope.chatId,
    scope.senderId,
    scope.threadId,
  ]);
  db.prepare("INSERT INTO messages VALUES (?,?,?)").run("m", "10", scopeKey);
  db.prepare("INSERT INTO runs VALUES (?,?,?,?,?)").run(
    "r",
    "m",
    "succeeded",
    JSON.stringify(scope),
    now,
  );
  db.prepare("INSERT INTO authorization_decisions_all VALUES (?,?,?,?)").run(
    "a",
    "r",
    "run:execute",
    "ALLOW",
  );
  db.prepare("INSERT INTO deliveries VALUES (?,?,?,?,?)").run("d", "r", "sent", "20", scopeKey);
  const c = {
    id: "group-A",
    sentMessageId: "10",
    route: "20001",
    startedAt: now,
    replies: [{ route: "20001", messageId: "20", matches: true }],
  };
  const config = {
    bot: { qq: "10002" },
    driver: { qq: "10001" },
    runtime: { connectionId, threadId },
  };
  return { db, c, config, scopeKey };
}

test("acceptance binds scoped input, successful Run, authorization and received delivery", (t) => {
  const { db, c, config } = evidenceFixture();
  t.after(() => db.close());
  assert.equal(caseEvidence(db, c, config).runId, "r");
  db.exec("UPDATE deliveries SET external_id='21'");
  assert.throws(() => caseEvidence(db, c, config), { code: "DELIVERY_EVIDENCE" });
  db.exec(
    "UPDATE deliveries SET external_id='20'; UPDATE authorization_decisions_all SET decision='DENY'",
  );
  assert.throws(() => caseEvidence(db, c, config), { code: "AUTHORIZATION_EVIDENCE" });
  assert.throws(() => caseEvidence(db, { ...c, route: "20002" }, config), { code: "RUN_EVIDENCE" });
});

test("same external message ID from another connection is not a Run match", (t) => {
  const { db, c, config, scopeKey } = evidenceFixture({ connectionId: "other-connection" });
  t.after(() => db.close());
  const expectedScopeKey = JSON.stringify(["qq-live", "10002", "group", "20001", "10001", null]);
  assert.notEqual(scopeKey, expectedScopeKey);
  assert.throws(() => caseEvidence(db, c, { ...config, runtime: { connectionId: "qq-live" } }), {
    code: "RUN_EVIDENCE",
  });
});

test("delivery to a different destination scope cannot satisfy acceptance", (t) => {
  const { db, c, config } = evidenceFixture();
  t.after(() => db.close());
  db.prepare("UPDATE deliveries SET destination_scope_key=? WHERE id='d'").run(
    JSON.stringify(["qq-live", "10002", "group", "other-group", "10001", null]),
  );
  assert.throws(() => caseEvidence(db, c, config), { code: "DELIVERY_EVIDENCE" });
});

test("trace delivery must reference the verified delivery ID", () => {
  const { c, config } = evidenceFixture();
  const events = [
    {
      type: "message_received",
      externalId: "10",
      connectionId: "qq-live",
      botId: "10002",
      senderId: "10001",
      chatType: "group",
      chatId: "20001",
    },
    { type: "delivery_changed", deliveryId: "wrong-delivery", status: "sent", externalId: "20" },
  ];
  assert.throws(() => verifyTraceEvidence(events, c, config, { id: "d" }), {
    code: "TRACE_EVIDENCE",
  });
  events[1].deliveryId = "d";
  assert.doesNotThrow(() => verifyTraceEvidence(events, c, config, { id: "d" }));
});

test("trace message from another connection or thread cannot satisfy acceptance", () => {
  const { c, config } = evidenceFixture({ threadId: "thread-a" });
  const events = [
    {
      type: "message_received",
      externalId: "10",
      connectionId: "other-connection",
      botId: "10002",
      senderId: "10001",
      chatType: "group",
      chatId: "20001",
      threadId: "thread-a",
    },
    { type: "delivery_changed", deliveryId: "d", status: "sent", externalId: "20" },
  ];
  assert.throws(() => verifyTraceEvidence(events, c, config, { id: "d" }), {
    code: "TRACE_EVIDENCE",
  });
  events[0].connectionId = "qq-live";
  events[0].threadId = "other-thread";
  assert.throws(() => verifyTraceEvidence(events, c, config, { id: "d" }), {
    code: "TRACE_EVIDENCE",
  });
});
