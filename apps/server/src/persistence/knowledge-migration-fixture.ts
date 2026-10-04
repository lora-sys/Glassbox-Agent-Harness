import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { DomainDatabase } from "./database.js";
export const knowledgeMigrationFixtureScript = new URL(import.meta.url);
async function run() {
  const path = process.argv[2];
  assert.ok(path);
  let db = await DomainDatabase.open(path);
  await db.transaction(async (tx) => {
    await tx.execute(
      "INSERT INTO principals(id,kind,created_at) VALUES ('migration-owner','owner','2026-10-05')",
    );
    for (const table of [
      "learning_progress_audit",
      "learning_progress_records",
      "website_knowledge_articles",
      "website_knowledge_article_versions",
      "website_knowledge_syncs",
      "website_knowledge_sync_policy",
      "website_knowledge_sync_events",
    ])
      await tx.execute(`DROP TABLE ${table}`);
    await tx.execute("PRAGMA user_version = 29");
  });
  await db.close();
  db = await DomainDatabase.open(path);
  await db.transaction(async (tx) => {
    assert.equal((await tx.execute("PRAGMA user_version")).rows[0]?.user_version, 30);
    assert.equal(
      (await tx.execute("SELECT id FROM principals WHERE id='migration-owner'")).rows.length,
      1,
    );
    for (const table of [
      "learning_progress_records",
      "learning_progress_audit",
      "website_knowledge_articles",
      "website_knowledge_sync_policy",
    ])
      assert.equal((await tx.execute(`SELECT COUNT(*) AS count FROM ${table}`)).rows[0]?.count, 0);
  });
  await db.close();
  db = await DomainDatabase.open(path);
  assert.equal(
    await db.transaction(
      async (tx) =>
        (await tx.execute("SELECT id FROM principals WHERE id='migration-owner'")).rows.length,
    ),
    1,
  );
  await db.close();
}
if (process.argv[1] === fileURLToPath(import.meta.url)) await run();
