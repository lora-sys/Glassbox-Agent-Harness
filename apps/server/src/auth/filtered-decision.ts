import { randomUUID } from "node:crypto";
import type { Transaction } from "@libsql/client";
import type { CallerContext } from "../identity/scope.js";
import type { AuthorizationDecision } from "./service.js";

/** Records only an exclusion that the calling projection has already selected. */
export async function recordFilteredDecision(
  tx: Transaction,
  caller: CallerContext,
  evidence: { runId?: string },
  decision: AuthorizationDecision,
  projection: "conversation-history" | "task-list" | "ops-health-records",
): Promise<void> {
  if (decision.decision !== "DENY" || !evidence.runId) return;
  await tx.execute({
    sql: `INSERT INTO ops_trace_events(
      event_id, ts, type, run_id, principal_id, data_json
    ) VALUES (?, ?, 'authorization.filtered', ?, ?, ?)`,
    args: [
      randomUUID(),
      new Date().toISOString(),
      evidence.runId,
      caller.principalId,
      JSON.stringify({ decisionId: decision.id, projection, outcome: "excluded" }),
    ],
  });
}
