import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { expect, it } from "vite-plus/test";
import { DomainDatabase, localDatabaseUrl } from "./database.js";
import { CURRENT_SCHEMA_VERSION } from "./schema.js";

it("adds the Run failure_code column without touching the Runs already stored", async () => {
  const directory = await mkdtemp(join(tmpdir(), "glassbox-schema-v13-"));
  try {
    const path = join(directory, "glassbox.db");
    const initial = await DomainDatabase.open(path);
    await initial.close();

    const legacy = createClient({ url: localDatabaseUrl(path) });
    // The database above was built by the current schema, which already has the column. A v12
    // database does not, and the migration only runs over one that does not.
    await legacy.execute("ALTER TABLE runs DROP COLUMN failure_code");
    await legacy.execute("INSERT INTO agents(id, created_at) VALUES ('agent', '2026-09-28')");
    await legacy.execute(
      "INSERT INTO principals(id, kind, created_at) VALUES ('owner', 'owner', '2026-09-28')",
    );
    await legacy.execute(
      "INSERT INTO resources(id, kind, visibility, owner_id) VALUES ('conversation:1', 'conversation', 'private', 'owner')",
    );
    await legacy.execute(
      "INSERT INTO conversations(id, agent_id, principal_id, scope_key, scope_json, resource_id, created_at) VALUES ('conversation-1', 'agent', 'owner', 'scope', '{}', 'conversation:1', '2026-09-28')",
    );
    await legacy.execute(
      "INSERT INTO messages(id, conversation_id, scope_key, external_id, text, created_at) VALUES ('message-1', 'conversation-1', 'scope', 'external-1', 'hello', '2026-09-28')",
    );
    await legacy.execute(
      "INSERT INTO runs(id, conversation_id, message_id, principal_id, scope_json, execution_ref, status, result_text, created_at, updated_at) VALUES ('run-1', 'conversation-1', 'message-1', 'owner', '{}', 'pi:p3-minimax', 'succeeded', 'the real answer', '2026-09-28', '2026-09-28')",
    );
    await legacy.execute("PRAGMA user_version = 12");
    legacy.close();

    const db = await DomainDatabase.open(path);
    try {
      await db.transaction(async (tx) => {
        expect((await tx.execute("PRAGMA user_version")).rows[0]?.user_version).toBe(
          CURRENT_SCHEMA_VERSION,
        );
        // The column is nullable and the Rows written before it existed keep their own text: the
        // whole point is to record why a Run produced no text, never to reinterpret one that did.
        expect(
          (
            await tx.execute(
              "SELECT failure_code, status, result_text FROM runs WHERE id = 'run-1'",
            )
          ).rows[0],
        ).toMatchObject({
          failure_code: null,
          status: "succeeded",
          result_text: "the real answer",
        });
        await tx.execute("UPDATE runs SET failure_code = 'executor_crashed' WHERE id = 'run-1'");
        expect(
          (await tx.execute("SELECT failure_code FROM runs WHERE id = 'run-1'")).rows[0]
            ?.failure_code,
        ).toBe("executor_crashed");
        expect((await tx.execute("PRAGMA integrity_check")).rows[0]?.integrity_check).toBe("ok");
        expect((await tx.execute("PRAGMA foreign_key_check")).rows).toEqual([]);
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
