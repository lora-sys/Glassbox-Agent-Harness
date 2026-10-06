import { createHash } from "node:crypto";
import type { Transaction } from "@libsql/client";
import {
  requireIdentifier,
  scopeKey,
  validateScope,
  type CallerContext,
  type TrustedChannelScope,
} from "../identity/scope.js";
import { stringColumn } from "../persistence/database.js";

export interface ProgressSourceCondition {
  version: 1;
  kind: "learning_progress";
  recordId: string;
  revision: number;
}

export function isProgressSourceCondition(value: unknown): value is ProgressSourceCondition {
  if (!value || typeof value !== "object") return false;
  const condition = value as Record<string, unknown>;
  if (
    condition.version !== 1 ||
    condition.kind !== "learning_progress" ||
    typeof condition.recordId !== "string" ||
    !Number.isSafeInteger(condition.revision) ||
    (condition.revision as number) < 1 ||
    Object.keys(condition).length !== 4
  )
    return false;
  try {
    requireIdentifier(condition.recordId);
    return true;
  } catch {
    return false;
  }
}

export function learningProgressPersonKey(caller: CallerContext): string {
  validateScope(caller.scope);
  requireIdentifier(caller.principalId);
  return createHash("sha256")
    .update(
      JSON.stringify([
        caller.scope.connectionId,
        caller.scope.botId,
        caller.scope.senderId,
        caller.principalId,
      ]),
    )
    .digest("hex");
}

export function learningProgressResourceId(caller: CallerContext): string {
  return `learning-progress:${learningProgressPersonKey(caller)}`;
}

function sourceScope(raw: string): TrustedChannelScope | null {
  try {
    const value = JSON.parse(raw) as TrustedChannelScope;
    validateScope(value);
    return value;
  } catch {
    return null;
  }
}

/** Source condition for pending delivery and post-retrieval rechecks. */
export async function progressPolicyAllows(
  tx: Transaction,
  caller: CallerContext,
  condition: ProgressSourceCondition,
): Promise<boolean> {
  if (!isProgressSourceCondition(condition)) return false;
  const rows = await tx.execute({
    sql: `SELECT person_key, principal_id, connection_id, bot_id, sender_id,
                 source_chat_type, source_chat_id, source_scope_json, state, revision
          FROM learning_progress_records WHERE id = ?`,
    args: [condition.recordId],
  });
  const row = rows.rows[0];
  if (
    !row ||
    row.state === "deleted" ||
    row.revision !== condition.revision ||
    stringColumn(row, "person_key") !== learningProgressPersonKey(caller) ||
    stringColumn(row, "principal_id") !== caller.principalId ||
    stringColumn(row, "connection_id") !== caller.scope.connectionId ||
    stringColumn(row, "bot_id") !== caller.scope.botId ||
    stringColumn(row, "sender_id") !== caller.scope.senderId
  )
    return false;

  const scope = sourceScope(stringColumn(row, "source_scope_json"));
  if (
    !scope ||
    scope.connectionId !== caller.scope.connectionId ||
    scope.botId !== caller.scope.botId ||
    scope.senderId !== caller.scope.senderId ||
    scope.chatType !== row.source_chat_type ||
    scope.chatId !== row.source_chat_id
  )
    return false;

  if (scope.chatType === "private") {
    // A group Run can never replay private progress.
    return caller.scope.chatType === "private" && scope.chatId === caller.scope.chatId;
  }

  if (caller.scope.chatType === "group" && caller.scope.chatId !== scope.chatId) return false;
  const sourceKey = scopeKey(scope);
  const grant = await tx.execute({
    sql: `SELECT 1 FROM grants WHERE principal_id = ? AND resource_id = ?
          AND action = 'history:read' AND scope_key = ? AND effect = 'allow'
          AND revoked_at IS NULL LIMIT 1`,
    args: [caller.principalId, `group:${scope.chatId}`, sourceKey],
  });
  if (grant.rows.length === 0) return false;
  const policies = await tx.execute({
    sql: "SELECT policy_json FROM group_capability_policies WHERE connection_id = ? AND group_id = ?",
    args: [scope.connectionId, scope.chatId],
  });
  try {
    const json = policies.rows[0]?.policy_json;
    return typeof json === "string" && JSON.parse(json)?.memorySources?.history === true;
  } catch {
    return false;
  }
}
