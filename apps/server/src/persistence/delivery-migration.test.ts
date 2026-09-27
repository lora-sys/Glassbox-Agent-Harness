import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { expect, it } from "vite-plus/test";
import { DomainDatabase, localDatabaseUrl } from "./database.js";

it("migrates v9 deliveries without losing old rows and accepts browser and media Assets", async () => {
  const directory = await mkdtemp(join(tmpdir(), "glassbox-delivery-v9-"));
  try {
    const path = join(directory, "glassbox.db");
    const legacy = createClient({ url: localDatabaseUrl(path) });
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
        expect((await tx.execute("PRAGMA user_version")).rows[0]?.user_version).toBe(19);
        expect(
          (await tx.execute("SELECT payload_text, status FROM deliveries WHERE id = 'delivery-1'"))
            .rows[0],
        ).toMatchObject({
          payload_text: "old result",
          status: "sent",
        });
        await tx.execute(
          "INSERT INTO deliveries VALUES ('delivery-2','run-1','artifact','scope','ca181a0c-6f10-44ba-bd1f-5fba48024a48','browser_artifact','pending',NULL,'2026-09-24','2026-09-24')",
        );
        await tx.execute(
          "INSERT INTO deliveries VALUES ('delivery-3','run-1','media','scope','ca181a0c-6f10-44ba-bd1f-5fba48024a49','media_artifact','pending',NULL,'2026-09-24','2026-09-24')",
        );
      });
    } finally {
      await db.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }).catch(
      (error: NodeJS.ErrnoException) => {
        if (process.platform !== "win32" || error.code !== "EBUSY") throw error;
      },
    );
  }
});

it("marks legacy protected reads during migration and leaves public web decisions unmarked", async () => {
  const directory = await mkdtemp(join(tmpdir(), "glassbox-source-v10-"));
  try {
    const path = join(directory, "glassbox.db");
    const initialized = await DomainDatabase.open(path);
    await initialized.close();

    const legacy = createClient({ url: localDatabaseUrl(path) });
    await legacy.execute(
      "INSERT INTO resources(id, kind, visibility) VALUES ('workspace:test', 'workspace', 'private'), ('owner-history', 'owner-history', 'private'), ('web:public', 'web-public', 'public')",
    );
    for (const [id, resourceId, action] of [
      ["legacy-read", "workspace:test", "workspace:read"],
      ["legacy-search", "owner-history", "history:search"],
      ["public-search", "web:public", "web:search"],
    ]) {
      await legacy.execute({
        sql: "INSERT INTO authorization_decisions(id, resource_id, action, scope_key, decision, reason, created_at) VALUES (?, ?, ?, 'scope', 'ALLOW', 'explicit_grant', '2026-09-26')",
        args: [id, resourceId, action],
      });
    }
    await legacy.execute("ALTER TABLE authorization_decisions DROP COLUMN delivery_source");
    // Simulate a P6 database whose delivery_source column was not migrated yet.
    // Simulate a version 13 database before the version 15 Worker prompt field.
    await legacy.execute("ALTER TABLE worker_bindings DROP COLUMN prompt_dispatched_at");
    await legacy.execute("PRAGMA user_version = 13");
    legacy.close();

    const upgraded = await DomainDatabase.open(path);
    try {
      await upgraded.transaction(async (tx) => {
        expect((await tx.execute("PRAGMA user_version")).rows[0]?.user_version).toBe(19);
        const decisions = await tx.execute(
          "SELECT id, delivery_source FROM authorization_decisions ORDER BY id",
        );
        expect(
          Object.fromEntries(decisions.rows.map((row) => [row.id, row.delivery_source])),
        ).toEqual({
          "legacy-read": "legacy_content_source",
          "legacy-search": "legacy_access_gate",
          "public-search": null,
        });
        await tx.execute(
          "INSERT INTO authorization_decisions(id, resource_id, action, scope_key, decision, reason, created_at) VALUES ('new-discovery', 'workspace:test', 'workspace:read', 'scope', 'ALLOW', 'explicit_grant', '2026-09-26')",
        );
        expect(
          (
            await tx.execute(
              "SELECT delivery_source FROM authorization_decisions WHERE id = 'new-discovery'",
            )
          ).rows[0]?.delivery_source,
        ).toBeNull();
      });
    } finally {
      await upgraded.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }).catch(
      (error: NodeJS.ErrnoException) => {
        if (process.platform !== "win32" || error.code !== "EBUSY") throw error;
      },
    );
  }
});
