import type { Transaction } from "@libsql/client";
import { requireIdentifier } from "../identity/scope.js";
import { taskPolicyResourceIdForScope } from "../auth/task-policy.js";

export type CurrentTaskActionAuthorization = {
  decisionId: string;
  actorPrincipalId: string;
  scopeKey: string;
};

/** Rechecks the recorded decision and its current grant inside the Task write transaction. */
export async function requireCurrentTaskActionAuthorization(
  tx: Transaction,
  input: {
    taskId: string;
    action: "task:accept" | "task:rework" | "task:cancel";
    authorization: CurrentTaskActionAuthorization;
    taskScopeKey?: string;
    errorMessage: string;
  },
): Promise<void> {
  requireIdentifier(input.taskId);
  requireIdentifier(input.authorization.decisionId);
  requireIdentifier(input.authorization.actorPrincipalId);
  if (typeof input.authorization.scopeKey !== "string" || !input.authorization.scopeKey)
    throw new Error("Task action scope is required");

  const taskScopeKey = input.taskScopeKey ?? input.authorization.scopeKey;
  if (typeof taskScopeKey !== "string" || !taskScopeKey)
    throw new Error("Task action scope is required");
  const policyResourceId = taskPolicyResourceIdForScope(
    input.authorization.actorPrincipalId,
    taskScopeKey,
  );
  const decision = await tx.execute({
    sql: `SELECT d.id FROM authorization_decisions d JOIN grants g ON g.id = d.grant_id
      WHERE d.id = ? AND d.principal_id = ? AND d.resource_id = ? AND d.action = ?
        AND d.scope_key = ? AND d.decision = 'ALLOW' AND g.revoked_at IS NULL
        AND g.principal_id = d.principal_id
        AND (g.resource_id = d.resource_id OR (
          g.resource_id = ? AND EXISTS (
            SELECT 1 FROM tasks t WHERE t.id = ? AND t.creator_principal_id = d.principal_id
              AND t.origin_scope_key = d.scope_key
          )
        ))
        AND g.action = d.action AND g.scope_key = d.scope_key
        AND (g.effect = 'allow' OR (
          g.effect = 'approval' AND d.reason = 'approved' AND d.approval_id IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM approvals a WHERE a.id = d.approval_id AND a.grant_id = g.id
              AND a.principal_id = d.principal_id AND a.resource_id = d.resource_id
              AND a.action = d.action AND a.scope_key = d.scope_key
              AND a.consumed_at IS NOT NULL AND a.expires_at > ?
          )
        ))`,
    args: [
      input.authorization.decisionId,
      input.authorization.actorPrincipalId,
      `task-${input.taskId}`,
      input.action,
      input.authorization.scopeKey,
      policyResourceId,
      input.taskId,
      new Date().toISOString(),
    ],
  });
  if (!decision.rows[0]) throw new Error(input.errorMessage);
}
