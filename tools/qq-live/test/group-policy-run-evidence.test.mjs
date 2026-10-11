import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { groupPolicyStep } from "../lib/group-policy-scenario.mjs";
import { captureGroupPolicyState } from "../lib/group-policy-state.mjs";
import { observeGroupPolicyRun } from "../lib/group-policy-run-evidence.mjs";

const config = {
  bot: { qq: "10001" },
  driver: { qq: "20002" },
  groups: [
    { alias: "A", id: "30003" },
    { alias: "B", id: "40004" },
  ],
  runtime: { connectionId: "fixture-connection", threadId: null },
};
const baselineTime = "2026-10-07T00:00:00.000Z";
const runId = "owner-policy-run";
const principalId = "owner-fixture";

function fixture(t, stage = "disable", threadId = null) {
  const fixtureConfig = structuredClone(config);
  fixtureConfig.runtime.threadId = threadId;
  const fixtureScopeKey = JSON.stringify([
    config.runtime.connectionId,
    config.bot.qq,
    "private",
    config.driver.qq,
    config.driver.qq,
    threadId,
  ]);
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  db.exec(`
    CREATE TABLE principals(id TEXT PRIMARY KEY,kind TEXT NOT NULL);
    CREATE TABLE channel_identities(identity_key TEXT,principal_id TEXT);
    CREATE TABLE resources(id TEXT PRIMARY KEY);
    CREATE TABLE grants(id TEXT PRIMARY KEY,principal_id TEXT,resource_id TEXT,action TEXT,scope_key TEXT,effect TEXT,revoked_at TEXT,created_at TEXT);
    CREATE TABLE group_capability_policies(connection_id TEXT,group_id TEXT,policy_json TEXT,version INTEGER,updated_by_principal_id TEXT,updated_at TEXT);
    CREATE TABLE runs(id TEXT PRIMARY KEY,principal_id TEXT,scope_json TEXT,status TEXT,created_at TEXT,updated_at TEXT);
    CREATE TABLE authorization_decisions(id TEXT PRIMARY KEY,principal_id TEXT,resource_id TEXT,action TEXT,scope_key TEXT,decision TEXT,run_id TEXT,delivery_source TEXT);
    CREATE TABLE authorization_decisions_archive(id TEXT PRIMARY KEY,principal_id TEXT,resource_id TEXT,action TEXT,scope_key TEXT,decision TEXT,run_id TEXT,delivery_source TEXT);
    CREATE VIEW authorization_decisions_all AS SELECT * FROM authorization_decisions UNION ALL SELECT * FROM authorization_decisions_archive;
  `);
  db.prepare("INSERT INTO principals VALUES (?, 'owner')").run(principalId);
  db.prepare("INSERT INTO channel_identities VALUES (?,?)").run(
    JSON.stringify([config.runtime.connectionId, config.bot.qq, config.driver.qq]),
    principalId,
  );
  for (const resourceId of ["owner-control", "group:30003", "group:40004"]) {
    db.prepare("INSERT INTO resources VALUES (?)").run(resourceId);
    db.prepare("INSERT INTO grants VALUES (?,?,?,'group:manage',?,'allow',NULL,?)").run(
      `manage-${resourceId}`,
      principalId,
      resourceId,
      fixtureScopeKey,
      baselineTime,
    );
  }
  const policy = {
    categories: { "group.history": true },
    memorySources: { history: true },
    webCapabilities: {},
  };
  for (const groupId of ["30003", "40004"]) {
    db.prepare("INSERT INTO group_capability_policies VALUES (?,?,?,?,?,?)").run(
      config.runtime.connectionId,
      groupId,
      JSON.stringify(policy),
      1,
      principalId,
      baselineTime,
    );
  }
  db.prepare("INSERT INTO grants VALUES ('history-B',?,?, 'history:read',?,'allow',NULL,?)").run(
    principalId,
    "group:40004",
    fixtureScopeKey,
    baselineTime,
  );
  const before = captureGroupPolicyState(db, fixtureConfig);
  const enabled = stage === "restore";
  const version = stage === "restore" ? 3 : 2;
  const updatedAt = stage === "restore" ? "2026-10-07T00:00:03.000Z" : "2026-10-07T00:00:02.000Z";
  const nextPolicy = structuredClone(policy);
  nextPolicy.categories["group.history"] = enabled;
  nextPolicy.memorySources.history = enabled;
  db.prepare(
    "UPDATE group_capability_policies SET policy_json=?,version=?,updated_at=? WHERE group_id='40004'",
  ).run(JSON.stringify(nextPolicy), version, updatedAt);
  db.prepare("UPDATE grants SET revoked_at=? WHERE id='history-B'").run("2026-10-07T00:00:02.000Z");
  if (enabled) {
    db.prepare(
      "INSERT INTO grants VALUES ('history-B-restored',?,?, 'history:read',?,'allow',NULL,?)",
    ).run(principalId, "group:40004", fixtureScopeKey, "2026-10-07T00:00:03.000Z");
  }
  const after = captureGroupPolicyState(db, fixtureConfig, {
    originalHistoryGrantId: "history-B",
  });
  db.prepare("INSERT INTO runs VALUES (?,?,?,?,?,?)").run(
    runId,
    principalId,
    JSON.stringify({
      connectionId: config.runtime.connectionId,
      botId: config.bot.qq,
      chatType: "private",
      chatId: config.driver.qq,
      senderId: config.driver.qq,
      threadId,
    }),
    "succeeded",
    "2026-10-07T00:00:01.000Z",
    "2026-10-07T00:00:04.000Z",
  );
  db.prepare("INSERT INTO authorization_decisions VALUES ('decision-1',?,?,?,?,?,?,NULL)").run(
    principalId,
    "owner-control",
    "group:manage",
    fixtureScopeKey,
    "ALLOW",
    runId,
  );
  const input = groupPolicyStep(stage, "40004").leaseTools[0].operations[0].inputConstraint;
  const output = JSON.stringify({ groupId: "40004", enabled, version });
  const head = JSON.stringify({
    content: [{ type: "text", text: output }],
    details: {},
  });
  const digest = createHash("sha256").update(head, "utf8").digest("hex");
  const events = [
    {
      runId,
      timestamp: "2026-10-07T00:00:01.100Z",
      principalId,
      type: "tool_call",
      toolCallId: "call-1",
      data: {
        name: "owner_group_admin",
        runId,
        principalId,
        toolCallId: "call-1",
        input,
      },
    },
    {
      runId,
      type: "group_history_changed",
      connectionId: config.runtime.connectionId,
      groupId: "40004",
      enabled,
      policyVersion: version,
      principalId,
    },
    {
      runId,
      timestamp: "2026-10-07T00:00:03.100Z",
      principalId,
      type: "tool_result",
      toolCallId: "call-1",
      data: {
        name: "owner_group_admin",
        runId,
        principalId,
        toolCallId: "call-1",
        isError: false,
        outputTruncated: false,
        outputBytes: Buffer.byteLength(head, "utf8"),
        outputHead: head,
        outputSha256: digest,
      },
    },
  ];
  return { db, before, after, events, input, stage };
}

test("verifies Owner-private group history disable and restore against DB, Trace, and captured state", (t) => {
  for (const stage of ["disable", "restore"]) {
    const current = fixture(t, stage);
    const evidence = observeGroupPolicyRun({
      db: current.db,
      events: current.events,
      runId,
      before: current.before,
      after: current.after,
      stage,
    });
    assert.equal(evidence.status, "GROUP_POLICY_RUN_VERIFIED");
    assert.equal(evidence.runId, runId);
    assert.equal(evidence.stage, stage);
    assert.equal(evidence.policyVersion, current.after.B.version);
    assert.equal(evidence.toolCallId, "call-1");
    assert.equal(evidence.stateProof.status, "STATE_TRANSITION_VERIFIED");
    assert.equal(evidence.actualQqDeliveryVerified, false);
  }
});

test("accepts the captured Owner-private thread scope when it has a string thread ID", (t) => {
  const f = fixture(t, "disable", "owner-thread");
  const evidence = observeGroupPolicyRun({
    db: f.db,
    events: f.events,
    runId,
    before: f.before,
    after: f.after,
    stage: f.stage,
  });
  assert.equal(evidence.status, "GROUP_POLICY_RUN_VERIFIED");
});

test("accepts multiple matching ALLOW decisions and rejects a mixed decision set", (t) => {
  const allowed = fixture(t);
  allowed.db
    .prepare("INSERT INTO authorization_decisions VALUES ('decision-2',?,?,?,?,?,?,NULL)")
    .run(principalId, "owner-control", "group:manage", allowed.before.scopeKey, "ALLOW", runId);
  assert.equal(
    observeGroupPolicyRun({
      db: allowed.db,
      events: allowed.events,
      runId,
      before: allowed.before,
      after: allowed.after,
      stage: allowed.stage,
    }).status,
    "GROUP_POLICY_RUN_VERIFIED",
  );

  const mixed = fixture(t);
  mixed.db
    .prepare("INSERT INTO authorization_decisions VALUES ('decision-2',?,?,?,?,?,?,NULL)")
    .run(principalId, "owner-control", "group:manage", mixed.before.scopeKey, "DENY", runId);
  assert.throws(
    () =>
      observeGroupPolicyRun({
        db: mixed.db,
        events: mixed.events,
        runId,
        before: mixed.before,
        after: mixed.after,
        stage: mixed.stage,
      }),
    (error) => error.code === "GROUP_POLICY_RUN_EVIDENCE",
  );
});

test("rejects missing or altered run identity, scope, authority, status, and chronology", (t) => {
  const cases = [
    (f) => f.db.prepare("UPDATE runs SET principal_id='other-owner' WHERE id=?").run(runId),
    (f) => f.db.prepare("UPDATE runs SET scope_json='{}' WHERE id=?").run(runId),
    (f) => f.db.prepare("UPDATE runs SET status='failed' WHERE id=?").run(runId),
    (f) =>
      f.db.prepare("UPDATE runs SET created_at='2026-10-06T23:59:59.000Z' WHERE id=?").run(runId),
    (f) =>
      f.db.prepare("UPDATE runs SET updated_at='2026-10-07T00:00:00.000Z' WHERE id=?").run(runId),
    (f) => f.db.prepare("DELETE FROM runs WHERE id=?").run(runId),
    (f) =>
      f.db.prepare("UPDATE authorization_decisions SET decision='DENY' WHERE run_id=?").run(runId),
    (f) =>
      f.db
        .prepare("UPDATE authorization_decisions SET decision='REQUIRES_APPROVAL' WHERE run_id=?")
        .run(runId),
    (f) =>
      f.db.prepare("UPDATE authorization_decisions SET scope_key='[]' WHERE run_id=?").run(runId),
    (f) =>
      f.db
        .prepare("UPDATE authorization_decisions SET principal_id='other-owner' WHERE run_id=?")
        .run(runId),
    (f) =>
      f.db
        .prepare("UPDATE authorization_decisions SET delivery_source='history' WHERE run_id=?")
        .run(runId),
    (f) => f.db.prepare("DELETE FROM authorization_decisions WHERE run_id=?").run(runId),
  ];
  for (const mutate of cases) {
    const f = fixture(t);
    mutate(f);
    assert.throws(
      () =>
        observeGroupPolicyRun({
          db: f.db,
          events: f.events,
          runId,
          before: f.before,
          after: f.after,
          stage: f.stage,
        }),
      (error) => error.code === "GROUP_POLICY_RUN_EVIDENCE",
    );
  }
});

test("rejects altered Tool identity, exact input, actor, order, duplication, output, and mutation evidence", (t) => {
  const mutations = [
    (f) => {
      f.events[0].data.name = "other_tool";
    },
    (f) => {
      f.events[0].data.input.enabled = true;
    },
    (f) => {
      f.events[0].data.principalId = "other-owner";
    },
    (f) => {
      f.events[0].principalId = "other-owner";
    },
    (f) => {
      f.events[2].toolCallId = "different-call";
    },
    (f) => {
      delete f.events[0].timestamp;
    },
    (f) => {
      f.events[2].timestamp = "2026-10-07T00:00:01.000Z";
    },
    (f) => {
      f.events.splice(0, 1);
    },
    (f) => {
      f.events.reverse();
    },
    (f) => {
      [f.events[1], f.events[2]] = [f.events[2], f.events[1]];
    },
    (f) => {
      f.events.push(structuredClone(f.events[0]));
    },
    (f) => {
      f.events[2].data.outputTruncated = true;
    },
    (f) => {
      f.events[2].data.outputHead += " ";
    },
    (f) => {
      f.events[2].data.isError = true;
    },
    (f) => {
      f.events[1].policyVersion += 1;
    },
    (f) => {
      f.events[1].principalId = "other-owner";
    },
    (f) => {
      f.events[1].groupId = "30003";
    },
    (f) => {
      f.events[1].data = { connectionId: config.runtime.connectionId };
    },
    (f) => {
      f.events.splice(1, 1);
    },
    (f) => {
      f.events.push(structuredClone(f.events[1]));
    },
  ];
  for (const mutate of mutations) {
    const f = fixture(t);
    mutate(f);
    assert.throws(
      () =>
        observeGroupPolicyRun({
          db: f.db,
          events: f.events,
          runId,
          before: f.before,
          after: f.after,
          stage: f.stage,
        }),
      (error) => error.code === "GROUP_POLICY_RUN_EVIDENCE",
    );
  }
});

test("does not trust serialized or modified state snapshots", (t) => {
  const f = fixture(t);
  const imported = JSON.parse(JSON.stringify(f.before));
  assert.throws(
    () =>
      observeGroupPolicyRun({
        db: f.db,
        events: f.events,
        runId,
        before: imported,
        after: f.after,
        stage: f.stage,
      }),
    (error) => error.code === "GROUP_POLICY_RUN_EVIDENCE",
  );
  f.after.B.version += 1;
  assert.throws(
    () =>
      observeGroupPolicyRun({
        db: f.db,
        events: f.events,
        runId,
        before: f.before,
        after: f.after,
        stage: f.stage,
      }),
    (error) => error.code === "GROUP_POLICY_RUN_EVIDENCE",
  );
});

test("requires canonical Run timestamps and policy grant changes inside the Run interval", (t) => {
  const malformedRun = fixture(t);
  malformedRun.db.prepare("UPDATE runs SET created_at='2026-10-07 00:00:01' WHERE id=?").run(runId);
  assert.throws(
    () =>
      observeGroupPolicyRun({
        db: malformedRun.db,
        events: malformedRun.events,
        runId,
        before: malformedRun.before,
        after: malformedRun.after,
        stage: malformedRun.stage,
      }),
    (error) => error.code === "GROUP_POLICY_RUN_EVIDENCE",
  );

  const earlyRevocation = fixture(t);
  earlyRevocation.db
    .prepare("UPDATE grants SET revoked_at=? WHERE id='history-B'")
    .run(baselineTime);
  earlyRevocation.after = captureGroupPolicyState(earlyRevocation.db, config, {
    originalHistoryGrantId: "history-B",
  });
  assert.throws(
    () =>
      observeGroupPolicyRun({
        db: earlyRevocation.db,
        events: earlyRevocation.events,
        runId,
        before: earlyRevocation.before,
        after: earlyRevocation.after,
        stage: earlyRevocation.stage,
      }),
    (error) => error.code === "GROUP_POLICY_RUN_EVIDENCE",
  );

  const lateRestore = fixture(t, "restore");
  lateRestore.db
    .prepare("UPDATE grants SET created_at=? WHERE id='history-B-restored'")
    .run("2026-10-07T00:00:05.000Z");
  lateRestore.after = captureGroupPolicyState(lateRestore.db, config, {
    originalHistoryGrantId: "history-B",
  });
  assert.throws(
    () =>
      observeGroupPolicyRun({
        db: lateRestore.db,
        events: lateRestore.events,
        runId,
        before: lateRestore.before,
        after: lateRestore.after,
        stage: lateRestore.stage,
      }),
    (error) => error.code === "GROUP_POLICY_RUN_EVIDENCE",
  );
});
