import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import {
  captureGroupPolicyState,
  verifyGroupPolicyTransition,
  verifyGroupPolicyPreSend,
} from "../lib/group-policy-state.mjs";

const config = {
  bot: { qq: "10001" },
  driver: { qq: "20002" },
  groups: [
    { alias: "A", id: "30003" },
    { alias: "B", id: "40004" },
  ],
  runtime: { connectionId: "fixture-connection", threadId: null },
};
const scope = JSON.stringify([
  config.runtime.connectionId,
  config.bot.qq,
  "private",
  config.driver.qq,
  config.driver.qq,
  null,
]);
const policy = {
  categories: { "group.history": true, "group.read": true },
  memorySources: { history: true, notice: true },
  webCapabilities: {},
};
const originalTime = "2026-10-07T00:00:00.000Z";

test("legacy web defaults match product reads without rewriting stored rows", (t) => {
  const db = fixture(t);
  const legacy = structuredClone(policy);
  delete legacy.webCapabilities;
  const raw = JSON.stringify(legacy);
  db.prepare("UPDATE group_capability_policies SET policy_json=?").run(raw);
  const before = captureGroupPolicyState(db, config);
  assert.deepEqual(before.B.policy.webCapabilities, {});
  assert.equal(
    db.prepare("SELECT policy_json FROM group_capability_policies WHERE group_id='40004'").get()
      .policy_json,
    raw,
  );
  transition(db, false, 2);
  const disabled = captureGroupPolicyState(db, config, {
    originalHistoryGrantId: "history-B",
  });
  assert.equal(
    verifyGroupPolicyTransition(before, disabled, "disable").status,
    "STATE_TRANSITION_VERIFIED",
  );
  transition(db, true, 3);
  const restored = captureGroupPolicyState(db, config, {
    originalHistoryGrantId: "history-B",
  });
  assert.equal(
    verifyGroupPolicyTransition(before, restored, "restore").originalPolicyRestored,
    true,
  );
  assert.equal(restored.A.recordSha256, before.A.recordSha256);
  assert.notEqual(restored.B.recordSha256, before.B.recordSha256);
});

function fixture(t) {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  db.exec(
    "CREATE TABLE principals(id TEXT PRIMARY KEY,kind TEXT); CREATE TABLE channel_identities(identity_key TEXT,principal_id TEXT); CREATE TABLE resources(id TEXT PRIMARY KEY); CREATE TABLE grants(id TEXT PRIMARY KEY,principal_id TEXT,resource_id TEXT,action TEXT,scope_key TEXT,effect TEXT,revoked_at TEXT,created_at TEXT); CREATE TABLE group_capability_policies(connection_id TEXT,group_id TEXT,policy_json TEXT,version INTEGER,updated_by_principal_id TEXT,updated_at TEXT);",
  );
  db.prepare("INSERT INTO principals VALUES (?,?)").run("owner-fixture", "owner");
  db.prepare("INSERT INTO channel_identities VALUES (?,?)").run(
    JSON.stringify([config.runtime.connectionId, config.bot.qq, config.driver.qq]),
    "owner-fixture",
  );
  for (const resource of ["owner-control", "group:30003", "group:40004"]) {
    db.prepare("INSERT INTO resources VALUES (?)").run(resource);
    grant(db, `manage-${resource}`, resource, "group:manage");
  }
  for (const group of config.groups) {
    db.prepare("INSERT INTO group_capability_policies VALUES (?,?,?,?,?,?)").run(
      config.runtime.connectionId,
      group.id,
      JSON.stringify(policy),
      1,
      "owner-fixture",
      originalTime,
    );
    grant(db, `history-${group.alias}`, `group:${group.id}`, "history:read");
  }
  return db;
}
function grant(
  db,
  id,
  resource,
  action,
  effect = "allow",
  principal = "owner-fixture",
  scopeKey = scope,
) {
  db.prepare("INSERT INTO grants VALUES (?,?,?,?,?,?,NULL,?)").run(
    id,
    principal,
    resource,
    action,
    scopeKey,
    effect,
    originalTime,
  );
}
function transition(db, enabled, version) {
  const next = structuredClone(policy);
  next.categories["group.history"] = enabled;
  next.memorySources.history = enabled;
  db.prepare(
    "UPDATE group_capability_policies SET policy_json=?,version=?,updated_at=? WHERE group_id=?",
  ).run(JSON.stringify(next), version, `2026-10-07T00:00:0${version}.000Z`, "40004");
  if (!enabled)
    db.prepare("UPDATE grants SET revoked_at=? WHERE id=?").run(
      "2026-10-07T00:00:02.000Z",
      "history-B",
    );
  else {
    grant(db, "history-B-restored", "group:40004", "history:read");
    db.prepare("UPDATE grants SET created_at=? WHERE id=?").run(
      "2026-10-07T00:00:03.000Z",
      "history-B-restored",
    );
  }
}

test("edited or imported snapshots cannot replace independently read state", (t) => {
  const db = fixture(t);
  const before = captureGroupPolicyState(db, config);
  transition(db, false, 2);
  grant(db, "collateral", "group:40004", "file:write");
  const after = captureGroupPolicyState(db, config, {
    originalHistoryGrantId: "history-B",
  });
  after.B.unrelatedGrantsSha256 = before.B.unrelatedGrantsSha256;
  assert.throws(() => verifyGroupPolicyTransition(before, after, "disable"), /群策略/u);
  const imported = JSON.parse(JSON.stringify(before));
  assert.throws(() => verifyGroupPolicyPreSend(before, imported, "disable"), /群策略/u);
  const cyclic = { schemaVersion: 1 };
  cyclic.self = cyclic;
  assert.throws(
    () => verifyGroupPolicyTransition(before, cyclic, "disable"),
    (error) => error.code === "GROUP_POLICY_TRANSITION",
  );
  for (const options of [
    null,
    [],
    { ignoreDrift: true },
    { originalHistoryGrantId: "history-B", ignored: true },
  ])
    assert.throws(() => captureGroupPolicyState(db, config, options), /群策略/u);
});

test("pre-send guard rejects collateral drift before disable or restore", (t) => {
  const db = fixture(t);
  const before = captureGroupPolicyState(db, config);
  assert.equal(
    verifyGroupPolicyPreSend(before, captureGroupPolicyState(db, config), "disable").status,
    "STATE_GUARD_VERIFIED",
  );
  transition(db, false, 2);
  const disabled = captureGroupPolicyState(db, config, {
    originalHistoryGrantId: "history-B",
  });
  assert.equal(
    verifyGroupPolicyPreSend(before, disabled, "restore").status,
    "STATE_GUARD_VERIFIED",
  );
  db.prepare("UPDATE group_capability_policies SET version=version+1 WHERE group_id='30003'").run();
  const drifted = captureGroupPolicyState(db, config, {
    originalHistoryGrantId: "history-B",
  });
  assert.throws(() => verifyGroupPolicyPreSend(before, drifted, "restore"), /群策略/u);
  assert.throws(() => verifyGroupPolicyPreSend(before, disabled, "unknown"), /群策略/u);
});

test("history toggle and restore preserve A and unrelated authority while retaining revoked audit", (t) => {
  const db = fixture(t);
  const before = captureGroupPolicyState(db, config);
  assert.equal(before.B.historyGrants.length, 1);
  transition(db, false, 2);
  const disabled = captureGroupPolicyState(db, config, {
    originalHistoryGrantId: before.B.historyGrants[0].id,
  });
  assert.equal(
    verifyGroupPolicyTransition(before, disabled, "disable").status,
    "STATE_TRANSITION_VERIFIED",
  );
  transition(db, true, 3);
  const restored = captureGroupPolicyState(db, config, {
    originalHistoryGrantId: before.B.historyGrants[0].id,
  });
  const evidence = verifyGroupPolicyTransition(before, restored, "restore");
  assert.equal(evidence.status, "STATE_TRANSITION_VERIFIED");
  assert.equal(evidence.actualQqDeliveryVerified, false);
  assert.equal(
    db.prepare("SELECT revoked_at FROM grants WHERE id=?").get("history-B").revoked_at,
    "2026-10-07T00:00:02.000Z",
  );
});

test("capture refuses ambiguous groups, non-Owner identity and missing current management grants", (t) => {
  const db = fixture(t);
  for (const changed of [
    { ...config, groups: [config.groups[0], config.groups[0]] },
    { ...config, groups: [config.groups[0]] },
  ])
    assert.throws(() => captureGroupPolicyState(db, changed), {
      code: "GROUP_POLICY_STATE",
    });
  db.exec("UPDATE principals SET kind='visitor'");
  assert.throws(() => captureGroupPolicyState(db, config), {
    code: "GROUP_POLICY_STATE",
  });
  db.exec(
    "UPDATE principals SET kind='owner'; UPDATE grants SET revoked_at='2026-10-07T00:00:01.000Z' WHERE id='manage-group:40004'",
  );
  assert.throws(() => captureGroupPolicyState(db, config), {
    code: "GROUP_POLICY_STATE",
  });
});

test("policy verification rejects cross-group changes, stale versions and collateral grants", (t) => {
  for (const mutate of [
    (db) => db.exec("UPDATE group_capability_policies SET version=2 WHERE group_id='30003'"),
    (db) => db.exec("UPDATE group_capability_policies SET version=3 WHERE group_id='40004'"),
    (db) => grant(db, "unexpected", "group:40004", "group:files:write"),
    (db) =>
      grant(
        db,
        "sibling-owner",
        "group:30003",
        "history:read",
        "allow",
        "sibling",
        JSON.stringify(["other", "bot", "private", "user", "user", null]),
      ),
    (db) => db.exec("DELETE FROM grants WHERE id='history-B'"),
    (db) =>
      db.exec(
        "UPDATE group_capability_policies SET updated_by_principal_id='sibling' WHERE group_id='40004'",
      ),
  ]) {
    const db = fixture(t);
    const before = captureGroupPolicyState(db, config);
    transition(db, false, 2);
    mutate(db);
    const after = captureGroupPolicyState(db, config, {
      originalHistoryGrantId: before.B.historyGrants[0].id,
    });
    assert.throws(() => verifyGroupPolicyTransition(before, after, "disable"), {
      code: "GROUP_POLICY_TRANSITION",
    });
  }
});

test("non-restorable initial policy or duplicate/approval history grants cannot start", (t) => {
  for (const mutate of [
    (db) => grant(db, "duplicate-history", "group:40004", "history:read"),
    (db) => grant(db, "approval-history", "group:40004", "history:read", "approval"),
    (db) => db.exec("UPDATE group_capability_policies SET policy_json='{}' WHERE group_id='40004'"),
  ]) {
    const db = fixture(t);
    mutate(db);
    assert.throws(() => captureGroupPolicyState(db, config), {
      code: "GROUP_POLICY_STATE",
    });
  }
});

test("restoration refuses a new authority, reused grant and altered original revocation", (t) => {
  for (const mutate of [
    (db) => db.exec("UPDATE grants SET effect='approval' WHERE id='history-B-restored'"),
    (db) => db.exec("UPDATE grants SET scope_key='different-scope' WHERE id='history-B-restored'"),
    (db) => db.exec("UPDATE grants SET revoked_at=NULL WHERE id='history-B'"),
    (db) => db.exec("DELETE FROM grants WHERE id='history-B'"),
    (db) =>
      db.exec(
        "UPDATE grants SET created_at='2026-10-06T23:59:59.000Z' WHERE id='history-B-restored'",
      ),
  ]) {
    const db = fixture(t);
    const before = captureGroupPolicyState(db, config);
    transition(db, false, 2);
    transition(db, true, 3);
    mutate(db);
    assert.throws(
      () => {
        const after = captureGroupPolicyState(db, config, {
          originalHistoryGrantId: before.B.historyGrants[0].id,
        });
        verifyGroupPolicyTransition(before, after, "restore");
      },
      (error) => ["GROUP_POLICY_STATE", "GROUP_POLICY_TRANSITION"].includes(error.code),
    );
  }
});

test("failed capture returns safe diagnostics and closes its own transaction", (t) => {
  const db = fixture(t);
  const privatePayload = "FIXTURE_PRIVATE_POLICY_TEXT";
  db.prepare("UPDATE group_capability_policies SET policy_json=? WHERE group_id=?").run(
    JSON.stringify({ ...policy, privatePayload }),
    "40004",
  );
  assert.throws(
    () => captureGroupPolicyState(db, config),
    (error) =>
      error.code === "GROUP_POLICY_STATE" &&
      error.status === "INCONCLUSIVE" &&
      !error.message.includes(privatePayload),
  );
  db.prepare("UPDATE group_capability_policies SET policy_json=? WHERE group_id=?").run(
    JSON.stringify(policy),
    "40004",
  );
  assert.equal(captureGroupPolicyState(db, config).B.version, 1);
  db.exec("BEGIN");
  assert.throws(() => captureGroupPolicyState(db, config), {
    code: "GROUP_POLICY_STATE",
  });
  // Failed BEGIN must not roll back a transaction owned by the caller.
  db.exec("ROLLBACK");
});
