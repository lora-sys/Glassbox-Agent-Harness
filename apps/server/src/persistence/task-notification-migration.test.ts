import { expect, it } from "vite-plus/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DomainDatabase } from "./database.js";

it("creates an event-keyed Task notification outbox in schema v18", async () => {
  const db = await DomainDatabase.open(":memory:");
  try {
    await db.transaction(async (tx) => {
      expect(Number((await tx.execute("PRAGMA user_version")).rows[0]?.user_version)).toBe(19);
      const columns = await tx.execute("PRAGMA table_info(task_notifications)");
      expect(columns.rows.map((row) => row.name)).toEqual([
        "id",
        "event_sequence",
        "task_id",
        "origin_run_id",
        "conversation_id",
        "principal_id",
        "destination_scope_key",
        "destination_scope_json",
        "event_type",
        "payload_text",
        "payload_kind",
        "status",
        "external_id",
        "created_at",
        "updated_at",
      ]);
      expect(
        (
          await tx.execute(
            "SELECT name FROM sqlite_master WHERE type = 'trigger' AND name = 'task_notifications_payload_immutable'",
          )
        ).rows,
      ).toHaveLength(1);
    });
  } finally {
    await db.close();
  }
});

it("adds immutable Worker candidate output storage when upgrading schema v16", async () => {
  const directory = await mkdtemp(join(tmpdir(), "glassbox-worker-result-v16-"));
  const databasePath = join(directory, "glassbox.db");
  try {
    const old = await DomainDatabase.open(databasePath);
    await old.transaction(async (tx) => {
      await tx.execute("DROP TABLE worker_candidate_outputs");
      await tx.execute("PRAGMA user_version = 16");
    });
    await old.close();

    const upgraded = await DomainDatabase.open(databasePath);
    try {
      await upgraded.transaction(async (tx) => {
        expect((await tx.execute("PRAGMA user_version")).rows[0]?.user_version).toBe(19);
        expect(
          (await tx.execute("PRAGMA table_info(worker_candidate_outputs)")).rows.map(
            (row) => row.name,
          ),
        ).toEqual([
          "attempt_id",
          "task_id",
          "step_id",
          "worker_binding_id",
          "output_excerpt",
          "output_sha256",
          "truncated",
          "created_at",
        ]);
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
