import { randomUUID } from "node:crypto";
import type { Transaction } from "@libsql/client";
import { resolveIdentity } from "../identity/service.js";
import {
  requireIdentifier,
  scopeKey,
  type CallerContext,
  type TrustedChannelScope,
} from "../identity/scope.js";
import { DomainDatabase, stringColumn } from "../persistence/database.js";

export type DecisionValue = "ALLOW" | "DENY" | "REQUIRES_APPROVAL";
export type DecisionReason =
  | "identity_unbound"
  | "identity_mismatch"
  | "resource_missing"
  | "private_group_context"
  | "no_grant"
  | "explicit_grant"
  | "approval_required"
  | "approval_invalid"
  | "approved"
  | "scope_mismatch";
export interface AuthorizationDecision {
  id: string;
  decision: DecisionValue;
  reason: DecisionReason;
  grantId: string | null;
  approvalId: string | null;
}
export interface AuthorizationRequest {
  caller: CallerContext;
  resourceId: string;
  action: string;
  approvalId?: string;
  conversationId?: string;
  runId?: string;
}

export class AccessDeniedError extends Error {
  constructor(readonly decision: AuthorizationDecision) {
    super(decision.decision === "REQUIRES_APPROVAL" ? "Approval is required" : "Access denied");
    this.name = "AccessDeniedError";
  }
}

export async function recordDecision(
  tx: Transaction,
  request: AuthorizationRequest,
  decision: DecisionValue,
  reason: DecisionReason,
  grantId: string | null = null,
  approvalId: string | null = null,
): Promise<AuthorizationDecision> {
  const id = randomUUID();
  await tx.execute({
    sql: "INSERT INTO authorization_decisions(id, principal_id, resource_id, action, scope_key, decision, reason, grant_id, approval_id, conversation_id, run_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    args: [
      id,
      request.caller.principalId,
      request.resourceId,
      request.action,
      scopeKey(request.caller.scope),
      decision,
      reason,
      grantId,
      approvalId,
      request.conversationId ?? null,
      request.runId ?? null,
      new Date().toISOString(),
    ],
  });
  return { id, decision, reason, grantId, approvalId };
}

/** Reads current bindings, resource visibility and grants inside the operation's
 * transaction. No cached role, historical permission or caller-supplied reason. */
export async function evaluate(
  tx: Transaction,
  request: AuthorizationRequest,
): Promise<AuthorizationDecision> {
  requireIdentifier(request.resourceId);
  requireIdentifier(request.action);
  requireIdentifier(request.caller.principalId);
  const resolved = await resolveIdentity(tx, request.caller.scope);
  if (resolved === null) return recordDecision(tx, request, "DENY", "identity_unbound");
  if (resolved !== request.caller.principalId)
    return recordDecision(tx, request, "DENY", "identity_mismatch");
  const resources = await tx.execute({
    sql: "SELECT visibility FROM resources WHERE id = ?",
    args: [request.resourceId],
  });
  if (!resources.rows[0]) return recordDecision(tx, request, "DENY", "resource_missing");
  if (
    stringColumn(resources.rows[0], "visibility") === "private" &&
    request.caller.scope.chatType === "group"
  ) {
    return recordDecision(tx, request, "DENY", "private_group_context");
  }
  const grants = await tx.execute({
    sql: "SELECT id, effect FROM grants WHERE principal_id = ? AND resource_id = ? AND action = ? AND scope_key = ? AND revoked_at IS NULL ORDER BY CASE effect WHEN 'allow' THEN 0 ELSE 1 END, id LIMIT 1",
    args: [resolved, request.resourceId, request.action, scopeKey(request.caller.scope)],
  });
  const grant = grants.rows[0];
  if (!grant) return recordDecision(tx, request, "DENY", "no_grant");
  const grantId = stringColumn(grant, "id");
  if (stringColumn(grant, "effect") === "allow")
    return recordDecision(tx, request, "ALLOW", "explicit_grant", grantId);
  if (!request.approvalId && request.runId && request.action === "run:create") {
    // Admission consumes approval once and links its decision to exactly one Run.
    // Rechecks reuse that evidence only while the same grant and binding are current.
    const admitted = await tx.execute({
      sql: "SELECT a.id FROM approvals a JOIN authorization_decisions d ON d.approval_id = a.id JOIN runs r ON r.id = d.run_id JOIN conversations c ON c.id = r.conversation_id WHERE d.run_id = ? AND d.principal_id = ? AND d.resource_id = ? AND d.action = ? AND d.scope_key = ? AND d.decision = 'ALLOW' AND d.reason = 'approved' AND d.grant_id = ? AND a.grant_id = ? AND a.consumed_at IS NOT NULL AND a.expires_at > ? AND c.principal_id = ? AND c.scope_key = ? LIMIT 1",
      args: [
        request.runId,
        resolved,
        request.resourceId,
        request.action,
        scopeKey(request.caller.scope),
        grantId,
        grantId,
        new Date().toISOString(),
        resolved,
        scopeKey(request.caller.scope),
      ],
    });
    if (admitted.rows[0])
      return recordDecision(
        tx,
        request,
        "ALLOW",
        "approved",
        grantId,
        stringColumn(admitted.rows[0], "id"),
      );
  }
  if (!request.approvalId)
    return recordDecision(tx, request, "REQUIRES_APPROVAL", "approval_required", grantId);
  const used = await tx.execute({
    sql: "UPDATE approvals SET consumed_at = ? WHERE id = ? AND grant_id = ? AND principal_id = ? AND resource_id = ? AND action = ? AND scope_key = ? AND consumed_at IS NULL AND expires_at > ?",
    args: [
      new Date().toISOString(),
      request.approvalId,
      grantId,
      resolved,
      request.resourceId,
      request.action,
      scopeKey(request.caller.scope),
      new Date().toISOString(),
    ],
  });
  if (used.rowsAffected !== 1)
    return recordDecision(tx, request, "DENY", "approval_invalid", grantId);
  return recordDecision(tx, request, "ALLOW", "approved", grantId, request.approvalId);
}

export type AuthorizedResult<T> = { value: T } | { denied: AuthorizationDecision };
export function authorizedValue<T>(result: AuthorizedResult<T>): T {
  if ("denied" in result) throw new AccessDeniedError(result.denied);
  return result.value;
}

export class AuthorizationService {
  constructor(private readonly db: DomainDatabase) {}

  /** Register metadata only. Protected content stays behind an authorized loader. */
  async registerResource(input: {
    id: string;
    kind: string;
    visibility: "public" | "private";
    ownerId?: string;
  }): Promise<void> {
    requireIdentifier(input.id);
    requireIdentifier(input.kind);
    if (input.visibility !== "public" && input.visibility !== "private")
      throw new Error("Invalid resource visibility");
    await this.db.transaction(async (tx) => {
      await tx.execute({
        sql: "INSERT INTO resources(id, kind, visibility, owner_id) VALUES (?, ?, ?, ?)",
        args: [input.id, input.kind, input.visibility, input.ownerId ?? null],
      });
    });
  }

  /** Management-only. Identity binding deliberately creates no grants. */
  async grant(input: {
    principalId: string;
    resourceId: string;
    action: string;
    scope: TrustedChannelScope;
    effect: "allow" | "approval";
  }): Promise<string> {
    for (const value of [input.principalId, input.resourceId, input.action])
      requireIdentifier(value);
    if (input.effect !== "allow" && input.effect !== "approval")
      throw new Error("Invalid grant effect");
    const key = scopeKey(input.scope);
    return this.db.transaction(async (tx) => {
      const id = randomUUID();
      await tx.execute({
        sql: "INSERT INTO grants(id, principal_id, resource_id, action, scope_key, effect, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        args: [
          id,
          input.principalId,
          input.resourceId,
          input.action,
          key,
          input.effect,
          new Date().toISOString(),
        ],
      });
      return id;
    });
  }

  async revoke(grantId: string): Promise<void> {
    requireIdentifier(grantId);
    await this.db.transaction(async (tx) => {
      await tx.execute({
        sql: "UPDATE grants SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL",
        args: [new Date().toISOString(), grantId],
      });
    });
  }

  /** Management-only approval for an existing eligible policy path. The caller
   * must verify the human approver before invoking this method. */
  async approve(input: {
    grantId: string;
    approverId: string;
    expiresAt: string;
  }): Promise<string> {
    if (!Number.isFinite(Date.parse(input.expiresAt)) || Date.parse(input.expiresAt) <= Date.now())
      throw new Error("Invalid approval expiry");
    return this.db.transaction(async (tx) => {
      const result = await tx.execute({
        sql: "SELECT * FROM grants WHERE id = ? AND effect = 'approval' AND revoked_at IS NULL",
        args: [input.grantId],
      });
      const grant = result.rows[0];
      if (!grant) throw new Error("No eligible approval policy");
      const id = randomUUID();
      await tx.execute({
        sql: "INSERT INTO approvals(id, grant_id, approver_id, principal_id, resource_id, action, scope_key, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        args: [
          id,
          input.grantId,
          input.approverId,
          stringColumn(grant, "principal_id"),
          stringColumn(grant, "resource_id"),
          stringColumn(grant, "action"),
          stringColumn(grant, "scope_key"),
          new Date(input.expiresAt).toISOString(),
          new Date().toISOString(),
        ],
      });
      return id;
    });
  }

  check(request: AuthorizationRequest): Promise<AuthorizationDecision> {
    return this.db.transaction((tx) => evaluate(tx, request));
  }

  /** The loader runs only after authorization. Tool wrappers should call this
   * again for every protected operation rather than retaining a past decision. */
  async withAuthorizedResource<T>(
    request: AuthorizationRequest,
    load: () => Promise<T>,
  ): Promise<T> {
    // Approval consumption must commit before an external side effect. A timeout
    // or thrown loader error cannot roll it back and permit accidental replay.
    const decision = await this.check(request);
    if (decision.decision !== "ALLOW") throw new AccessDeniedError(decision);
    return load();
  }
}
