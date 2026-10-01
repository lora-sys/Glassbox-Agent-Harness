import type { Row, Transaction } from "@libsql/client";

/** Build a derived integer time index without changing the original archive evidence. */
export async function applyHistoryTimeMigration(tx: Transaction): Promise<void> {
  const columns = await tx.execute("PRAGMA table_info(channel_messages)");
  // Every supported v7+ archive schema already owns this table. Missing it is an
  // incomplete/corrupt database, not permission to silently declare schema v28.
  if (columns.rows.length === 0)
    throw new Error("Missing channel archive before history time migration");
  if (!columns.rows.some((row) => row.name === "occurred_at_ms"))
    await tx.execute("ALTER TABLE channel_messages ADD COLUMN occurred_at_ms INTEGER");

  // Bound each read. Date.parse preserves the formats accepted by the old input boundary,
  // including RFC timestamps and numeric offsets that SQLite's date parser rejects.
  let after: string | null = null;
  while (true) {
    const rows: readonly Row[] = (
      await tx.execute({
        sql: `SELECT id, occurred_at FROM channel_messages${after === null ? "" : " WHERE id > ?"} ORDER BY id LIMIT 500`,
        args: after === null ? [] : [after],
      })
    ).rows;
    if (rows.length === 0) break;
    for (const row of rows) {
      if (typeof row.id !== "string" || typeof row.occurred_at !== "string")
        throw new Error("Invalid history migration record");
      const timestamp = Date.parse(row.occurred_at);
      await tx.execute({
        sql: "UPDATE channel_messages SET occurred_at_ms = ? WHERE id = ?",
        args: [Number.isSafeInteger(timestamp) ? timestamp : null, row.id],
      });
      after = row.id;
    }
  }
  await tx.execute(
    "CREATE INDEX IF NOT EXISTS channel_messages_connection_time_ms ON channel_messages(connection_id, group_id, source_class, occurred_at_ms)",
  );
  await tx.execute(
    "CREATE INDEX IF NOT EXISTS channel_messages_group_time_ms ON channel_messages(group_id, source_class, occurred_at_ms)",
  );
}
