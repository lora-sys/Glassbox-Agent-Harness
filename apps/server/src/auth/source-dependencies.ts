import type { Row, Transaction } from "@libsql/client";
import type { CallerContext } from "../identity/scope.js";
import { stringColumn } from "../persistence/database.js";
import { readPolicyCondition } from "./policy-condition.js";
import {
  evaluate,
  type AuthorizedResult,
  type AuthorizationRequest,
  type AuthorizedReadReceipt,
} from "./service.js";

export async function readRunSourceRows(
  tx: Transaction,
  runIds: readonly string[],
): Promise<Row[]> {
  if (!runIds.length) return [];
  const result = await tx.execute({
    sql: `SELECT DISTINCT resource_id,action,delivery_source,policy_condition_json
      FROM authorization_decisions_all WHERE run_id IN (${runIds.map(() => "?").join(",")})
      AND decision = 'ALLOW' AND delivery_source IS NOT NULL LIMIT 129`,
    args: [...runIds],
  });
  if (result.rows.length > 128) throw new Error("Too many protected source dependencies");
  return result.rows;
}

/** A Task's origin may already contain a protected answer from each parent. */
export async function readTaskSourceRows(tx: Transaction, taskId: string): Promise<Row[]> {
  const seen = new Set<string>();
  const runIds: string[] = [];
  let current: string | null = taskId;
  while (current) {
    if (seen.has(current) || seen.size >= 5) throw new Error("Invalid Task source lineage");
    seen.add(current);
    const result = await tx.execute({
      sql: `SELECT t.run_id,link.parent_task_id FROM tasks t
        LEFT JOIN task_child_links link ON link.child_task_id = t.id WHERE t.id = ?`,
      args: [current],
    });
    const task = result.rows[0];
    if (!task) throw new Error("Missing Task source lineage");
    if (typeof task.run_id === "string") {
      const run = await tx.execute({
        sql: "SELECT id FROM runs WHERE id = ?",
        args: [task.run_id],
      });
      if (!run.rows[0]) throw new Error("Missing Task source Run");
      runIds.push(task.run_id);
    }
    current = typeof task.parent_task_id === "string" ? task.parent_task_id : null;
  }
  return readRunSourceRows(tx, runIds);
}

export function sourceClassification(row: Row): "content_source" | "access_gate" {
  if (row.delivery_source === "content_source" || row.delivery_source === "legacy_content_source")
    return "content_source";
  if (row.delivery_source === "access_gate" || row.delivery_source === "legacy_access_gate")
    return "access_gate";
  throw new Error("Invalid protected source classification");
}

export async function reauthorizeSourceRows(
  tx: Transaction,
  caller: CallerContext,
  sources: readonly Row[],
  evidence: Pick<AuthorizationRequest, "runId" | "conversationId" | "delegatedTaskId">,
  completedReads?: AuthorizedReadReceipt[],
): Promise<AuthorizedResult<null>> {
  for (const source of sources) {
    const classification = sourceClassification(source);
    const request = {
      caller,
      ...evidence,
      resourceId: stringColumn(source, "resource_id"),
      action: stringColumn(source, "action"),
      policyCondition: readPolicyCondition(source),
    };
    const decision = await evaluate(tx, request);
    if (decision.decision !== "ALLOW") return { denied: decision };
    completedReads?.push({ request, decisionId: decision.id, source: classification });
    // Completion must verify the inherited producer's classification even when this
    // inspection has no consuming Run. This marker does not authorize a new operation.
    await tx.execute({
      sql: "UPDATE authorization_decisions SET delivery_source = ? WHERE id = ?",
      args: [classification, decision.id],
    });
  }
  return { value: null };
}
