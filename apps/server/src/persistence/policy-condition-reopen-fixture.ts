import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { createClient } from "@libsql/client";
import { openDomainStore } from "./index.js";
import { localDatabaseUrl } from "./database.js";
import { archiveDecisionBatch } from "./decision-archive.js";
import { CURRENT_SCHEMA_VERSION } from "./schema.js";

export const policyConditionReopenFixtureScript = new URL(import.meta.url);
async function runFixture() {
  const [path, scenario] = process.argv.slice(2);
  assert.ok(path);
  if (scenario === "fresh") {
    let store = await openDomainStore({ databasePath: path });
    const caller = {
      principalId: "owner",
      scope: {
        connectionId: "qq",
        botId: "bot",
        chatType: "private" as const,
        chatId: "owner",
        senderId: "owner",
      },
    };
    await store.identities.bindOwner("owner", caller.scope);
    await store.authorization.registerResource({
      id: "group:100",
      kind: "qq_group",
      visibility: "public",
    });
    await store.authorization.grant({
      principalId: "owner",
      resourceId: "group:100",
      action: "history:read",
      scope: caller.scope,
      effect: "allow",
    });
    await store.capabilities.write({
      connectionId: "qq",
      groupId: "100",
      principalId: "owner",
      policy: { categories: { "group.history": true }, memorySources: {} },
    });
    const policyCondition = {
      version: 1,
      kind: "qq_category",
      connectionId: "qq",
      groupId: "100",
      category: "group.history",
    } as const;
    const constrained = await store.authorization.check({
      caller,
      resourceId: "group:100",
      action: "history:read",
      policyCondition,
    });
    const ordinary = await store.authorization.check({
      caller,
      resourceId: "group:100",
      action: "history:read",
    });
    assert.equal(await archiveDecisionBatch(store.db, "9999-01-01T00:00:00.000Z"), 2);
    await store.close();
    store = await openDomainStore({ databasePath: path });
    try {
      await store.db.transaction(async (tx) => {
        const rows = await tx.execute(
          "SELECT id,policy_condition_json FROM authorization_decisions_all",
        );
        const byId = new Map(rows.rows.map((row) => [row.id, row.policy_condition_json]));
        assert.equal(byId.get(constrained.id), JSON.stringify(policyCondition));
        assert.equal(byId.get(ordinary.id), JSON.stringify({ version: 1, kind: "none" }));
        assert.equal((await tx.execute("PRAGMA integrity_check")).rows[0]?.integrity_check, "ok");
        assert.deepEqual((await tx.execute("PRAGMA foreign_key_check")).rows, []);
      });
    } finally {
      await store.close();
    }
  } else if (scenario === "upgrade") {
    const fresh = await openDomainStore({ databasePath: path });
    await fresh.close();
    const legacy = createClient({ url: localDatabaseUrl(path) });
    await legacy.execute("DROP VIEW authorization_decisions_all");
    for (const table of ["authorization_decisions", "authorization_decisions_archive"]) {
      await legacy.execute(`ALTER TABLE ${table} DROP COLUMN policy_condition_json`);
      await legacy.execute(
        `INSERT INTO ${table}(id,resource_id,action,scope_key,decision,reason,delivery_source,created_at) VALUES ('${table}','group:100','history:read','scope','ALLOW','explicit_grant','content_source','2026-01-01')`,
      );
    }
    await legacy.execute("PRAGMA user_version = 25");
    legacy.close();
    const upgraded = await openDomainStore({ databasePath: path });
    try {
      await upgraded.db.transaction(async (tx) => {
        assert.equal(
          (await tx.execute("PRAGMA user_version")).rows[0]?.user_version,
          CURRENT_SCHEMA_VERSION,
        );
        const rows = await tx.execute(
          "SELECT id,policy_condition_json,delivery_source FROM authorization_decisions_all ORDER BY id",
        );
        assert.equal(rows.rows.length, 2);
        assert.ok(
          rows.rows.every(
            (row) => row.policy_condition_json === null && row.delivery_source === "content_source",
          ),
        );
        assert.equal((await tx.execute("PRAGMA integrity_check")).rows[0]?.integrity_check, "ok");
      });
    } finally {
      await upgraded.close();
    }
  } else assert.fail(`Unknown fixture scenario: ${scenario}`);
  console.log(JSON.stringify({ scenario }));
}
if (process.argv[1] === fileURLToPath(import.meta.url)) await runFixture();
