import { createClient } from "@libsql/client";
import { expect, it } from "vite-plus/test";
import { applyHistoryTimeMigration } from "./history-time-migration.js";
import { schema } from "./schema.js";

it("backfills more than one page without changing source text and creates integer-time indexes", async () => {
  const client = createClient({ url: "file::memory:" });
  try {
    const tx = await client.transaction("write");
    await tx.batch(schema);
    await tx.execute(
      "INSERT INTO resources(id,kind,visibility) VALUES ('group:100','qq_group','public')",
    );
    const timestamp = "2026-10-01T08:30:00.123+0800";
    for (let i = 0; i < 501; i++) {
      const id = String(i).padStart(4, "0");
      await tx.execute({
        sql: "INSERT INTO channel_messages(id,channel,connection_id,group_id,external_message_id,sender_id,normalized_text,occurred_at,ingested_at,resource_id,dedup_key) VALUES (?,'qq','qq','100',?,'member','Original source evidence',?,?,'group:100',?)",
        args: [id, id, timestamp, timestamp, id],
      });
    }
    await applyHistoryTimeMigration(tx);
    await applyHistoryTimeMigration(tx);
    const result = (
      await tx.execute(
        "SELECT COUNT(*) AS count FROM channel_messages WHERE occurred_at = '2026-10-01T08:30:00.123+0800' AND occurred_at_ms = 1790814600123 AND typeof(occurred_at_ms) = 'integer' AND normalized_text = 'Original source evidence'",
      )
    ).rows[0];
    expect(result?.count).toBe(501);
    const plan = await tx.execute(
      "EXPLAIN QUERY PLAN SELECT id FROM channel_messages WHERE connection_id = 'qq' AND group_id = '100' AND source_class = 'history' AND occurred_at_ms >= 1790814600123 ORDER BY occurred_at_ms DESC LIMIT 1",
    );
    expect(
      plan.rows.map((row) => (typeof row.detail === "string" ? row.detail : "")).join(" "),
    ).toContain("channel_messages_connection_time_ms");
    await tx.commit();
    tx.close();
  } finally {
    client.close();
  }
});

it("fails closed when a claimed historical schema is missing its required archive table", async () => {
  const client = createClient({ url: "file::memory:" });
  try {
    await client.execute("CREATE TABLE fixture_evidence(value TEXT NOT NULL)");
    await client.execute("INSERT INTO fixture_evidence VALUES ('Retained old evidence')");
    await client.execute("PRAGMA user_version = 9");
    const tx = await client.transaction("write");
    try {
      await expect(applyHistoryTimeMigration(tx)).rejects.toThrow(
        "Missing channel archive before history time migration",
      );
    } finally {
      await tx.rollback();
      tx.close();
    }
    expect((await client.execute("PRAGMA user_version")).rows[0]?.user_version).toBe(9);
    expect((await client.execute("SELECT value FROM fixture_evidence")).rows[0]?.value).toBe(
      "Retained old evidence",
    );
    expect(
      (await client.execute("SELECT name FROM sqlite_master WHERE name = 'channel_messages'")).rows,
    ).toEqual([]);
  } finally {
    client.close();
  }
});
