import { expect, it } from "vite-plus/test";
import { archiveDecisionBatch, readArchivedDecisionPage } from "./decision-archive.js";
import { DomainDatabase, stringColumn } from "./database.js";

it("archives old decisions in bounded batches while preserving linked memory evidence", async () => {
  const db = await DomainDatabase.open(":memory:");
  try {
    await db.transaction(async (tx) => {
      await tx.execute(
        "INSERT INTO principals(id, kind, created_at) VALUES ('owner', 'owner', 'now')",
      );
      for (const [id, createdAt] of [
        ["old-a", "2025-01-01T00:00:00.000Z"],
        ["old-b", "2025-01-02T00:00:00.000Z"],
        ["linked", "2025-01-03T00:00:00.000Z"],
        ["fresh", "2026-01-01T00:00:00.000Z"],
      ]) {
        await tx.execute({
          sql: "INSERT INTO authorization_decisions(id, principal_id, resource_id, action, scope_key, decision, reason, created_at) VALUES (?, 'owner', 'resource', 'read', 'scope', 'ALLOW', 'explicit_grant', ?)",
          args: [id, createdAt],
        });
      }
      await tx.execute(
        "INSERT INTO memory_audit_events(id, request_id, principal_id, action, target_id, decision_id, lineage_json, created_at) VALUES ('audit', 'request', 'owner', 'read', 'target', 'linked', '{}', '2025-01-03T00:00:00.000Z')",
      );
    });
    const cutoff = "2025-12-01T00:00:00.000Z";
    expect(await archiveDecisionBatch(db, cutoff, 1)).toBe(1);
    expect(await archiveDecisionBatch(db, cutoff, 1)).toBe(1);
    expect(await archiveDecisionBatch(db, cutoff, 1)).toBe(0);
    const first = await readArchivedDecisionPage(db, cutoff, null, 1);
    expect(first.map((row) => row.id)).toEqual(["old-a"]);
    const second = await readArchivedDecisionPage(
      db,
      cutoff,
      { createdAt: stringColumn(first[0]!, "created_at"), id: stringColumn(first[0]!, "id") },
      1,
    );
    expect(second.map((row) => row.id)).toEqual(["old-b"]);
    await db.transaction(async (tx) => {
      const live = await tx.execute("SELECT id FROM authorization_decisions ORDER BY id");
      expect(live.rows.map((row) => row.id)).toEqual(["fresh", "linked"]);
      const all = await tx.execute("SELECT id FROM authorization_decisions_all ORDER BY id");
      expect(all.rows.map((row) => row.id)).toEqual(["fresh", "linked", "old-a", "old-b"]);
      expect((await tx.execute("PRAGMA foreign_key_check")).rows).toEqual([]);
    });
  } finally {
    await db.close();
  }
});
