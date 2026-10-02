import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { createClient } from "@libsql/client";
import { openDomainStore } from "../persistence/index.js";
import { localDatabaseUrl } from "../persistence/database.js";
import { schema, applySchemaV24Migration } from "../persistence/schema.js";
import { ChannelArchiveStore } from "./channel-archive.js";

export const historyReopenFixtureScript = new URL(import.meta.url);

async function runFixture() {
  const [path] = process.argv.slice(2);
  assert.ok(path);
  const instant = "2026-10-01T00:30:00.123Z";
  const formats = [
    instant,
    "2026-10-01T08:30:00.123+08:00",
    "2026-10-01T08:30:00.123+0800",
    "Thu, 01 Oct 2026 00:30:00 GMT",
    "2026-10-01",
    "2026-10-01 00:30:00.123Z",
    "invalid legacy timestamp",
  ];
  const legacy = createClient({ url: localDatabaseUrl(path) });
  try {
    const tx = await legacy.transaction("write");
    await tx.batch(schema);
    await applySchemaV24Migration(tx);
    await tx.execute("PRAGMA user_version = 25");
    await tx.execute(
      "INSERT INTO resources(id,kind,visibility) VALUES ('group:100','qq_group','public')",
    );
    for (const [i, timestamp] of formats.entries())
      await tx.execute({
        sql: "INSERT INTO channel_messages(id,channel,connection_id,group_id,external_message_id,sender_id,normalized_text,occurred_at,ingested_at,resource_id,dedup_key) VALUES (?,'qq','qq','100',?,'member','Deployment legacy',?,?,'group:100',?)",
        args: [String(i), String(i), timestamp, instant, String(i)],
      });
    await tx.commit();
    tx.close();
  } finally {
    legacy.close();
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    const store = await openDomainStore({ databasePath: path });
    try {
      const archive = new ChannelArchiveStore(store.db);
      // Unknown legacy times still retain searchable evidence when no time bound was requested.
      assert.deepStrictEqual(
        (await archive.searchMessages({ allowedGroupIds: ["100"] })).map((x) => x.id).sort(),
        formats.map((_, i) => String(i)),
      );
      assert.deepStrictEqual(
        (await archive.searchMessages({ allowedGroupIds: ["100"], since: instant, until: instant }))
          .map((x) => x.id)
          .sort(),
        ["0", "1", "2", "5"],
      );
      assert.equal(
        (await archive.searchMessages({ allowedGroupIds: ["100"], limit: 1 })).length,
        1,
      );
      const rows = await store.db.transaction(
        async (tx) =>
          (
            await tx.execute(
              "SELECT id,occurred_at,occurred_at_ms FROM channel_messages ORDER BY id",
            )
          ).rows,
      );
      assert.deepStrictEqual(
        rows.map((r) => r.occurred_at),
        formats,
      );
      assert.deepStrictEqual(
        rows.map((r) => r.occurred_at_ms),
        formats.map((s) => (Number.isNaN(Date.parse(s)) ? null : Date.parse(s))),
      );
      assert.equal(
        await store.db.transaction(
          async (tx) => (await tx.execute("PRAGMA integrity_check")).rows[0]?.integrity_check,
        ),
        "ok",
      );
      assert.deepStrictEqual(
        await store.db.transaction(
          async (tx) => (await tx.execute("PRAGMA foreign_key_check")).rows,
        ),
        [],
      );
    } finally {
      await store.close();
    }
  }
  console.log(JSON.stringify({ completed: "history-reopen" }));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await runFixture();
