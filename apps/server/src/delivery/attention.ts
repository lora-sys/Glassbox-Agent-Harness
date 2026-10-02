import type { Transaction } from "@libsql/client";
import { deliveryReason } from "./outcome.js";

export const deliveryAttentionId = (deliveryId: string): string => `delivery-${deliveryId}`;
const unknownGuidance =
  "Delivery unconfirmed; inspect provider or recipient evidence before any new send. Automatic replay is disabled.";
const failedGuidance = "Delivery failed; an explicit retry requires current authorization.";

/** Same transaction as the delivery fact; contains identifiers and fixed codes, never payload. */
export async function recordDeliveryAttention(
  tx: Transaction,
  runId: string,
  deliveryId: string,
  status: "sent" | "failed" | "unknown",
  reason?: unknown,
): Promise<void> {
  const id = deliveryAttentionId(deliveryId);
  const now = new Date().toISOString();
  if (status === "sent") {
    await tx.execute({
      sql: "UPDATE attention_items SET resolved_at = ? WHERE id = ? AND kind = 'delivery_failed' AND conversation_id = (SELECT conversation_id FROM runs WHERE id = ?) AND resolved_at IS NULL",
      args: [now, id, runId],
    });
    return;
  }
  const summary = `${status === "unknown" ? unknownGuidance : failedGuidance} Reason: ${deliveryReason(status, reason)}. Run: ${runId}. Delivery: ${deliveryId}.`;
  const recorded = await tx.execute({
    sql: `INSERT INTO attention_items(id, kind, summary, conversation_id, created_at)
      SELECT ?, 'delivery_failed', ?, conversation_id, ? FROM runs WHERE id = ?
      ON CONFLICT(id) DO UPDATE SET summary = excluded.summary, resolved_at = NULL
      WHERE attention_items.kind = 'delivery_failed'
        AND attention_items.conversation_id = excluded.conversation_id`,
    args: [id, summary, now, runId],
  });
  if (recorded.rowsAffected !== 1) throw new Error("Delivery attention identity conflict");
}

/** One bounded metadata-only batch per startup. Existing acknowledgements are never reopened. */
export async function backfillDeliveryAttention(tx: Transaction): Promise<void> {
  await tx.execute({
    sql: `INSERT INTO attention_items(id, kind, summary, conversation_id, created_at)
      SELECT 'delivery-' || d.id, 'delivery_failed',
        CASE WHEN d.status = 'failed' THEN ? ELSE ? END || ' Reason: ' ||
        CASE WHEN d.status = 'sending' THEN 'process_interrupted' ELSE 'unclassified' END ||
        '. Run: ' || d.run_id || '. Delivery: ' || d.id || '.',
        r.conversation_id, ?
      FROM deliveries d JOIN runs r ON r.id = d.run_id
      WHERE d.status IN ('sending', 'unknown', 'failed')
        AND NOT EXISTS (SELECT 1 FROM attention_items a WHERE a.id = 'delivery-' || d.id)
      ORDER BY CASE WHEN d.status = 'sending' THEN 0 ELSE 1 END, d.rowid
      LIMIT 1000
      ON CONFLICT(id) DO NOTHING`,
    args: [failedGuidance, unknownGuidance, new Date().toISOString()],
  });
}
