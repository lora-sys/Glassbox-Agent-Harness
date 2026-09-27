import { expect, it } from "vite-plus/test";
import { DomainDatabase } from "./database.js";

it("creates an event-keyed Task notification outbox in schema v16", async () => {
  const db = await DomainDatabase.open(":memory:");
  try {
    await db.transaction(async (tx) => {
      expect(Number((await tx.execute("PRAGMA user_version")).rows[0]?.user_version)).toBe(16);
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
