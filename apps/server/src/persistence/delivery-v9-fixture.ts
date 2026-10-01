import assert from "node:assert/strict";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@libsql/client";
import { DomainDatabase, localDatabaseUrl } from "./database.js";
import { CURRENT_SCHEMA_VERSION, schemaV7Statements, schemaV8Migration } from "./schema.js";

export const deliveryV9FixtureScript = new URL(import.meta.url);

async function runFixture() {
  const directory = process.argv[2];
  assert.ok(directory);
  const path = join(directory, "glassbox.db");
  const legacy = createClient({ url: localDatabaseUrl(path) });
  // A real v9 database has already installed the v7/v8 archive. Keep this migration
  // fixture historically valid rather than asking later migrations to skip required state.
  await legacy.execute(
    "CREATE TABLE resources (id TEXT PRIMARY KEY, kind TEXT NOT NULL, visibility TEXT NOT NULL, owner_id TEXT)",
  );
  await legacy.batch([...schemaV7Statements, ...schemaV8Migration]);
  await legacy.execute(
    "INSERT INTO resources(id,kind,visibility) VALUES ('group:100','qq_group','public')",
  );
  await legacy.execute(
    "INSERT INTO channel_messages(id,channel,connection_id,group_id,external_message_id,sender_id,normalized_text,occurred_at,ingested_at,resource_id,dedup_key,sender_name,mention_target_ids_json) VALUES ('history-v9','qq','qq','100','old-message','old-member','Archived before v9 fixture','2026-09-24T08:30:00.125+0800','2026-09-24T00:30:00.125Z','group:100','old-dedup','Fixture Member','[\"owner\"]')",
  );
  await legacy.execute(
    "INSERT INTO channel_messages_fts(segment,id,group_id) VALUES ('Archived before v9 fixture','history-v9','100')",
  );
  await legacy.execute("CREATE TABLE runs (id TEXT PRIMARY KEY)");
  await legacy.execute("CREATE TABLE tasks (id TEXT PRIMARY KEY)");
  await legacy.execute("CREATE TABLE task_attempts (id TEXT PRIMARY KEY, task_id TEXT)");
  await legacy.execute("CREATE TABLE worker_bindings (id TEXT PRIMARY KEY)");
  await legacy.execute(
    "CREATE TABLE deliveries (id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), dedup_key TEXT NOT NULL, destination_scope_key TEXT NOT NULL, payload_text TEXT NOT NULL, payload_kind TEXT NOT NULL CHECK(payload_kind IN ('text','result','ack')), status TEXT NOT NULL CHECK(status IN ('pending','sending','sent','failed','unknown')), external_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(run_id, dedup_key))",
  );
  await legacy.execute("INSERT INTO runs(id) VALUES ('run-1')");
  await legacy.execute(
    "INSERT INTO deliveries VALUES ('delivery-1','run-1','result','scope','old result','result','sent','external-1','2026-09-24','2026-09-24')",
  );
  await legacy.execute("PRAGMA user_version = 9");
  legacy.close();

  const db = await DomainDatabase.open(path);
  try {
    await db.transaction(async (tx) => {
      assert.equal(
        (await tx.execute("PRAGMA user_version")).rows[0]?.user_version,
        CURRENT_SCHEMA_VERSION,
      );
      assert.partialDeepStrictEqual(
        (await tx.execute("SELECT payload_text, status FROM deliveries WHERE id = 'delivery-1'"))
          .rows[0],
        {
          payload_text: "old result",
          status: "sent",
        },
      );
      await tx.execute(
        "INSERT INTO deliveries VALUES ('delivery-2','run-1','artifact','scope','ca181a0c-6f10-44ba-bd1f-5fba48024a48','browser_artifact','pending',NULL,'2026-09-24','2026-09-24')",
      );
      await tx.execute(
        "INSERT INTO deliveries VALUES ('delivery-3','run-1','media','scope','ca181a0c-6f10-44ba-bd1f-5fba48024a49','media_artifact','pending',NULL,'2026-09-24','2026-09-24')",
      );
      assert.partialDeepStrictEqual(
        (
          await tx.execute(
            "SELECT normalized_text,occurred_at,occurred_at_ms,sender_name,mention_target_ids_json,typeof(occurred_at_ms) AS epoch_type FROM channel_messages WHERE id='history-v9'",
          )
        ).rows[0],
        {
          normalized_text: "Archived before v9 fixture",
          occurred_at: "2026-09-24T08:30:00.125+0800",
          occurred_at_ms: 1790209800125,
          sender_name: "Fixture Member",
          mention_target_ids_json: '["owner"]',
          epoch_type: "integer",
        },
      );
      assert.equal(
        (await tx.execute("SELECT segment FROM channel_messages_fts WHERE id='history-v9'")).rows[0]
          ?.segment,
        "Archived before v9 fixture",
      );
      const archivePlan = await tx.execute(
        "EXPLAIN QUERY PLAN SELECT id FROM channel_messages WHERE connection_id='qq' AND group_id='100' AND source_class='history' AND occurred_at_ms>=1790209800125 ORDER BY occurred_at_ms DESC LIMIT 1",
      );
      assert.ok(
        archivePlan.rows
          .map((row) => (typeof row.detail === "string" ? row.detail : ""))
          .join(" ")
          .includes("channel_messages_connection_time_ms"),
      );
      assert.equal((await tx.execute("PRAGMA integrity_check")).rows[0]?.integrity_check, "ok");
      assert.deepEqual((await tx.execute("PRAGMA foreign_key_check")).rows, []);
    });
  } finally {
    await db.close();
  }
  // A damaged v27 database cannot be silently relabelled as v28. Use an independent
  // file so this negative case does not require DDL against retained native statements.
  const invalidPath = join(directory, "missing-archive.db");
  const damaged = createClient({ url: localDatabaseUrl(invalidPath) });
  await damaged.execute("CREATE TABLE fixture_evidence(value TEXT NOT NULL)");
  await damaged.execute("INSERT INTO fixture_evidence VALUES ('Retained old evidence')");
  await damaged.execute("PRAGMA user_version = 27");
  damaged.close();
  await assert.rejects(
    DomainDatabase.open(invalidPath),
    new RegExp("Missing channel archive before history time migration", "u"),
  );
  const retained = createClient({ url: localDatabaseUrl(invalidPath) });
  try {
    assert.equal((await retained.execute("PRAGMA user_version")).rows[0]?.user_version, 27);
    assert.equal(
      (await retained.execute("SELECT value FROM fixture_evidence")).rows[0]?.value,
      "Retained old evidence",
    );
    assert.deepEqual(
      (await retained.execute("SELECT name FROM sqlite_master WHERE name='channel_messages'")).rows,
      [],
    );
  } finally {
    retained.close();
  }
  console.log("v9 archive and delivery migration verified");
}
if (process.argv[1] === fileURLToPath(import.meta.url)) await runFixture();
