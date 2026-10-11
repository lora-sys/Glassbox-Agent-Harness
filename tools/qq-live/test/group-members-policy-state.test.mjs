import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import {
  captureGroupMembersPolicyState,
  verifyGroupMembersPolicyPreSend,
  verifyGroupMembersPolicyTransition,
} from "../lib/group-members-policy-state.mjs";

const config = {
  bot: { qq: "10001" },
  driver: { qq: "20002" },
  groups: [
    { alias: "A", id: "30003" },
    { alias: "B", id: "40004" },
  ],
  runtime: { connectionId: "members-fixture", threadId: null },
};
const scope = JSON.stringify(["members-fixture", "10001", "private", "20002", "20002", null]);
const policy = {
  categories: { "group.members": true, "group.history": true },
  memorySources: { history: true },
};
const initialTime = "2026-10-07T00:00:01.000Z";
function fixture(t) {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  db.exec(
    "CREATE TABLE principals(id TEXT PRIMARY KEY,kind TEXT); CREATE TABLE channel_identities(identity_key TEXT,principal_id TEXT); CREATE TABLE resources(id TEXT PRIMARY KEY); CREATE TABLE grants(id TEXT PRIMARY KEY,principal_id TEXT,resource_id TEXT,action TEXT,scope_key TEXT,effect TEXT,revoked_at TEXT,created_at TEXT); CREATE TABLE group_capability_policies(connection_id TEXT,group_id TEXT,policy_json TEXT,version INTEGER,updated_by_principal_id TEXT,updated_at TEXT);",
  );
  db.prepare("INSERT INTO principals VALUES ('owner-fixture','owner')").run();
  db.prepare("INSERT INTO channel_identities VALUES (?, 'owner-fixture')").run(
    JSON.stringify(["members-fixture", "10001", "20002"]),
  );
  for (const id of ["owner-control", "group:30003", "group:40004"]) {
    db.prepare("INSERT INTO resources VALUES (?)").run(id);
    grant(db, `manage-${id}`, id, "group:manage");
  }
  for (const groupId of ["30003", "40004"])
    db.prepare("INSERT INTO group_capability_policies VALUES (?,?,?,?,?,?)").run(
      "members-fixture",
      groupId,
      JSON.stringify(policy),
      1,
      "owner-fixture",
      initialTime,
    );
  grant(db, "members-B", "group:40004", "group:members:read");
  return db;
}
function grant(db, id, resource, action, createdAt = initialTime) {
  db.prepare("INSERT INTO grants VALUES (?,?,?,?,?,'allow',NULL,?)").run(
    id,
    "owner-fixture",
    resource,
    action,
    scope,
    createdAt,
  );
}
function toggle(db, enabled, version) {
  const next = structuredClone(policy);
  next.categories["group.members"] = enabled;
  db.prepare(
    "UPDATE group_capability_policies SET policy_json=?,version=?,updated_at=? WHERE group_id='40004'",
  ).run(JSON.stringify(next), version, `2026-10-07T00:00:0${version}.000Z`);
  if (!enabled)
    db.prepare(
      "UPDATE grants SET revoked_at='2026-10-07T00:00:02.000Z' WHERE id='members-B'",
    ).run();
  else
    grant(
      db,
      "members-B-restored",
      "group:40004",
      "group:members:read",
      "2026-10-07T00:00:03.000Z",
    );
}

test("independent SQLite captures prove exact Group B disable and semantic restore", (t) => {
  const db = fixture(t);
  const before = captureGroupMembersPolicyState(db, config);
  assert.equal(before.B.memberGrants.length, 1);
  assert.equal(
    verifyGroupMembersPolicyPreSend(before, captureGroupMembersPolicyState(db, config), "disable")
      .status,
    "STATE_GUARD_VERIFIED",
  );
  toggle(db, false, 2);
  const disabled = captureGroupMembersPolicyState(db, config, {
    originalMemberGrantId: "members-B",
  });
  assert.equal(
    verifyGroupMembersPolicyTransition(before, disabled, "disable").groupAUnchanged,
    true,
  );
  assert.equal(disabled.B.policy.categories["group.members"], false);
  assert.deepEqual(disabled.B.memberGrants, []);
  assert.equal(
    verifyGroupMembersPolicyPreSend(before, disabled, "restore").status,
    "STATE_GUARD_VERIFIED",
  );
  toggle(db, true, 3);
  const restored = captureGroupMembersPolicyState(db, config, {
    originalMemberGrantId: "members-B",
  });
  const proof = verifyGroupMembersPolicyTransition(before, restored, "restore");
  assert.equal(proof.originalPolicyRestored, true);
  assert.equal(proof.originalGrantRevocationRetained, true);
  assert.equal(restored.A.recordSha256, before.A.recordSha256);
  assert.equal(restored.B.memberGrants[0].id, "members-B-restored");
  assert.equal(
    db.prepare("SELECT revoked_at FROM grants WHERE id='members-B'").get().revoked_at,
    "2026-10-07T00:00:02.000Z",
  );
});

test("active duplicate grant, collateral authority change, wrong group, and imported snapshot fail closed", (t) => {
  const db = fixture(t);
  const before = captureGroupMembersPolicyState(db, config);
  toggle(db, false, 2);
  grant(db, "extra-members-grant", "group:40004", "group:members:read");
  const duplicate = captureGroupMembersPolicyState(db, config, {
    originalMemberGrantId: "members-B",
  });
  assert.throws(
    () => verifyGroupMembersPolicyTransition(before, duplicate, "disable"),
    (e) => e.code === "GROUP_MEMBERS_POLICY_TRANSITION",
  );
  const imported = structuredClone(before);
  assert.throws(
    () => verifyGroupMembersPolicyPreSend(before, imported, "disable"),
    (e) => e.code === "GROUP_MEMBERS_POLICY_PRE_SEND",
  );
  const wrong = structuredClone(config);
  wrong.groups[1].id = "40005";
  assert.throws(
    () => captureGroupMembersPolicyState(db, wrong),
    (e) => e.code === "GROUP_MEMBERS_POLICY_STATE",
  );

  const clean = fixture(t);
  const baseline = captureGroupMembersPolicyState(clean, config);
  toggle(clean, false, 2);
  grant(clean, "unrelated-added", "group:40004", "file:read");
  const changed = captureGroupMembersPolicyState(clean, config, {
    originalMemberGrantId: "members-B",
  });
  assert.throws(
    () => verifyGroupMembersPolicyTransition(baseline, changed, "disable"),
    (e) => e.code === "GROUP_MEMBERS_POLICY_TRANSITION",
  );
});

test("capture requires enabled B category and current Owner management authority", (t) => {
  const disabled = fixture(t);
  const off = structuredClone(policy);
  off.categories["group.members"] = false;
  disabled
    .prepare("UPDATE group_capability_policies SET policy_json=? WHERE group_id='40004'")
    .run(JSON.stringify(off));
  assert.throws(
    () => captureGroupMembersPolicyState(disabled, config),
    (e) => e.code === "GROUP_MEMBERS_POLICY_STATE",
  );
  const noManage = fixture(t);
  noManage.prepare("UPDATE grants SET revoked_at=? WHERE id='manage-group:40004'").run(initialTime);
  assert.throws(
    () => captureGroupMembersPolicyState(noManage, config),
    (e) => e.code === "GROUP_MEMBERS_POLICY_STATE",
  );
});
