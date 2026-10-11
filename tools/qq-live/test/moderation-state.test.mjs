import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readModerationPolicyState,
  verifyModerationPolicyUnchanged,
} from "../lib/moderation-state.mjs";
import { MODERATION_GROUP_B_ID } from "../lib/moderation-scenario.mjs";

const config = {
  bot: { qq: "10001" },
  driver: { qq: "20002" },
  groups: [
    { alias: "A", id: "30003" },
    { alias: "B", id: MODERATION_GROUP_B_ID },
  ],
  runtime: { connectionId: "fixture-connection", dataDirectory: "", threadId: null },
};
const scopeKey = JSON.stringify([
  config.runtime.connectionId,
  config.bot.qq,
  "private",
  config.driver.qq,
  config.driver.qq,
  null,
]);

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "moderation-state-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const testConfig = structuredClone(config);
  testConfig.runtime.dataDirectory = directory;
  const db = new DatabaseSync(join(directory, "glassbox.db"));
  db.exec(`
    CREATE TABLE principals(id TEXT PRIMARY KEY,kind TEXT);
    CREATE TABLE channel_identities(identity_key TEXT,principal_id TEXT);
    CREATE TABLE grants(id TEXT PRIMARY KEY,principal_id TEXT,resource_id TEXT,action TEXT,scope_key TEXT,effect TEXT,revoked_at TEXT,created_at TEXT);
    CREATE TABLE group_capability_policies(connection_id TEXT,group_id TEXT,policy_json TEXT,version INTEGER,updated_at TEXT);
  `);
  db.prepare("INSERT INTO principals VALUES (?, 'owner')").run("owner-fixture");
  db.prepare("INSERT INTO channel_identities VALUES (?, ?)").run(
    JSON.stringify([testConfig.runtime.connectionId, testConfig.bot.qq, testConfig.driver.qq]),
    "owner-fixture",
  );
  db.prepare("INSERT INTO grants VALUES (?, ?, ?, 'group:moderate', ?, 'allow', NULL, ?)").run(
    "moderate-b",
    "owner-fixture",
    `group:${MODERATION_GROUP_B_ID}`,
    scopeKey,
    "2026-10-01T00:00:00.000Z",
  );
  db.prepare("INSERT INTO group_capability_policies VALUES (?, ?, ?, 3, ?)").run(
    testConfig.runtime.connectionId,
    MODERATION_GROUP_B_ID,
    JSON.stringify({ categories: { "group.moderate": true } }),
    "2026-10-02T00:00:00.000Z",
  );
  db.close();
  return { config: testConfig, dbPath: join(directory, "glassbox.db"), directory };
}

test("moderation policy state binds the Owner-private grant and enabled B category", async (t) => {
  const f = await fixture(t);
  const state = readModerationPolicyState(f.config);
  assert.equal(state.groupId, MODERATION_GROUP_B_ID);
  assert.equal(state.principalId, "owner-fixture");
  assert.equal(state.scopeKey, scopeKey);
  assert.equal(state.moderationEnabled, true);
  assert.equal(state.grantId, "moderate-b");
  assert.equal(
    verifyModerationPolicyUnchanged(state, structuredClone(state)).status,
    "MODERATION_POLICY_AND_GRANT_VERIFIED",
  );
});

test("policy observer does not require an Owner group administrator role", async (t) => {
  const f = await fixture(t);
  assert.equal(readModerationPolicyState(f.config).moderationEnabled, true);
});

test("moderation policy rejects disabled category, extra grant, and changed grant tuple", async (t) => {
  const f = await fixture(t);
  let db = new DatabaseSync(f.dbPath);
  db.prepare("UPDATE group_capability_policies SET policy_json=?").run(
    JSON.stringify({ categories: { "group.moderate": false } }),
  );
  db.close();
  assert.equal(readModerationPolicyState(f.config).moderationEnabled, false);

  db = new DatabaseSync(f.dbPath);
  db.prepare("UPDATE group_capability_policies SET policy_json=?").run(
    JSON.stringify({ categories: { "group.moderate": true } }),
  );
  db.prepare("INSERT INTO grants VALUES (?, ?, ?, 'group:moderate', ?, 'allow', NULL, ?)").run(
    "duplicate-moderate-b",
    "owner-fixture",
    `group:${MODERATION_GROUP_B_ID}`,
    scopeKey,
    "2026-10-01T00:00:00.000Z",
  );
  db.close();
  assert.throws(() => readModerationPolicyState(f.config), { code: "MODERATION_POLICY_STATE" });

  db = new DatabaseSync(f.dbPath);
  db.prepare("DELETE FROM grants WHERE id='duplicate-moderate-b'").run();
  db.prepare("UPDATE grants SET scope_key='wrong-scope'").run();
  db.close();
  assert.throws(() => readModerationPolicyState(f.config), { code: "MODERATION_POLICY_STATE" });
});
