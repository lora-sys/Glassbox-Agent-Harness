import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { expect, it } from "vite-plus/test";
import { DomainDatabase, localDatabaseUrl } from "./database.js";
import { CURRENT_SCHEMA_VERSION } from "./schema.js";
import { runFixtureProcess } from "./test-fixture-process.js";
import { deliveryV9FixtureScript } from "./delivery-v9-fixture.js";

it("migrates v9 deliveries without losing old rows and accepts browser and media Assets", async ({
  signal,
}) => {
  const directory = await mkdtemp(join(tmpdir(), "glassbox-delivery-v9-"));
  try {
    await runFixtureProcess(deliveryV9FixtureScript, [directory], signal);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("marks legacy protected reads during the v14 upgrade and leaves public web decisions unmarked", async () => {
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
    await legacy.execute("DROP VIEW authorization_decisions_all");
    await legacy.execute("ALTER TABLE authorization_decisions DROP COLUMN delivery_source");
    // Rewind to 13, the version immediately before this migration, rather than to 10: a real v13
    // database has already run v11's deliveries rebuild and v12's attachments table, and rewinding
    // past them would ask those migrations to run a second time on a schema that already holds
    // their result. What is under test here is the marker, not the rebuilds. Dropping the V18
    // Worker prompt column first exercises that migration against a schema that predates it.
    await legacy.execute("ALTER TABLE worker_bindings DROP COLUMN prompt_dispatched_at");
    await legacy.execute("PRAGMA user_version = 13");
    legacy.close();

    const upgraded = await DomainDatabase.open(path);
    try {
      await upgraded.transaction(async (tx) => {
        expect((await tx.execute("PRAGMA user_version")).rows[0]?.user_version).toBe(
          CURRENT_SCHEMA_VERSION,
        );
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
