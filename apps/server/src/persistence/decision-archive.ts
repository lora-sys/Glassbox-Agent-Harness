import type { Row } from "@libsql/client";
import { DomainDatabase, stringColumn } from "./database.js";

const columns =
  "id, principal_id, resource_id, action, scope_key, decision, reason, grant_id, approval_id, conversation_id, run_id, delivery_source, created_at";

/** Move a bounded set of old decisions while preserving memory-audit foreign keys.
 * Readers use authorization_decisions_all, so historical run and evidence reads still work. */
export async function archiveDecisionBatch(
  db: DomainDatabase,
  before: string,
  limit = 500,
): Promise<number> {
  if (!Number.isFinite(Date.parse(before)) || !/^\d{4}-\d{2}-\d{2}T/u.test(before))
    throw new Error("Invalid archive cutoff");
  if (!Number.isInteger(limit) || limit < 1 || limit > 500)
    throw new Error("Archive batch limit must be between 1 and 500");
  return db.transaction(async (tx) => {
    const candidates = await tx.execute({
      sql: `SELECT d.id FROM authorization_decisions d
        WHERE d.created_at < ?
          AND NOT EXISTS (SELECT 1 FROM memory_audit_events m WHERE m.decision_id = d.id)
          AND (d.run_id IS NULL OR EXISTS (SELECT 1 FROM runs r WHERE r.id = d.run_id
            AND r.status IN ('cancelled','succeeded','failed','interrupted','unknown')))
        ORDER BY d.created_at, d.id LIMIT ?`,
      args: [before, limit],
    });
    const ids = candidates.rows.map((row) => stringColumn(row, "id"));
    if (!ids.length) return 0;
    const placeholders = ids.map(() => "?").join(",");
    await tx.execute({
      sql: `INSERT INTO authorization_decisions_archive (${columns})
        SELECT ${columns} FROM authorization_decisions WHERE id IN (${placeholders})`,
      args: ids,
    });
    await tx.execute({
      sql: `DELETE FROM authorization_decisions WHERE id IN (${placeholders})`,
      args: ids,
    });
    return ids.length;
  });
}

/** Paginate a durable archive for JSONL export without loading it all into memory. */
export async function readArchivedDecisionPage(
  db: DomainDatabase,
  before: string,
  after: { createdAt: string; id: string } | null,
  limit = 500,
): Promise<readonly Row[]> {
  return db.transaction(async (tx) => {
    const result = await tx.execute({
      sql: `SELECT ${columns} FROM authorization_decisions_archive
        WHERE created_at < ? AND (created_at, id) > (?, ?)
        ORDER BY created_at, id LIMIT ?`,
      args: [before, after?.createdAt ?? "", after?.id ?? "", limit],
    });
    return result.rows;
  });
}
