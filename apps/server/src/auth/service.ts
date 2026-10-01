import {
  policyConditionAllows,
  isPublicGroupCollectionGate,
  policyConditionJson,
  type AuthorizationPolicyCondition,
} from "./policy-condition.js";
import { randomUUID } from "node:crypto";
import type { Transaction } from "@libsql/client";
import { resolveIdentity } from "../identity/service.js";
import {
  conversationScopeKey,
  requireIdentifier,
  scopeKey,
  validateScope,
  type CallerContext,
  type TrustedChannelScope,
} from "../identity/scope.js";
import { DomainDatabase, optionalString, stringColumn } from "../persistence/database.js";
import { taskPolicyResourceId } from "./task-policy.js";

export interface ProvisionedResource {
  id: string;
  kind: string;
  visibility: "public" | "private";
  ownerId?: string;
  ifAbsent?: boolean;
}

export interface ProvisioningEntry {
  resource: ProvisionedResource;
  action: string;
}

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
  | "scope_mismatch"
  | "delegation_scope_denied"
  | "source_policy_denied"
  | "source_read_unverified"
  | "source_provenance_unavailable";
export interface AuthorizationDecision {
  id: string;
  decision: DecisionValue;
  reason: DecisionReason;
  grantId: string | null;
  approvalId: string | null;
}
export interface AuthorizationRequest {
  /** Trusted source route. Undefined creates explicit none; null preserves legacy unknown. */
  policyCondition?: AuthorizationPolicyCondition | null;
  caller: CallerContext;
  resourceId: string;
  action: string;
  approvalId?: string;
  conversationId?: string;
  runId?: string;
  /** Trusted execution boundary. A Run-to-Task binding also supplies this automatically. */
  delegatedTaskId?: string;
}

export interface AuthorizedReadReceipt {
  request: AuthorizationRequest;
  decisionId: string;
  source: "content_source" | "access_gate";
}

async function delegatedTaskAllows(
  tx: Transaction,
  request: AuthorizationRequest,
): Promise<boolean> {
  let runTaskId: string | undefined;
  let runConversationId: string | undefined;
  let originRunMatchesTask = false;
  if (request.runId) {
    const bound = await tx.execute({
      sql: `SELECT r.source,r.conversation_id,ar.task_id FROM runs r
            LEFT JOIN task_attempt_runs ar ON ar.run_id = r.id WHERE r.id = ? LIMIT 1`,
      args: [request.runId],
    });
    if (bound.rows[0]) {
      if (bound.rows[0].source === "task_step") {
        runTaskId = optionalString(bound.rows[0], "task_id") ?? undefined;
        if (!runTaskId) return false;
        runConversationId = stringColumn(bound.rows[0], "conversation_id");
      } else if (request.delegatedTaskId) {
        const origin = await tx.execute({
          sql: "SELECT 1 FROM tasks WHERE id = ? AND run_id = ?",
          args: [request.delegatedTaskId, request.runId],
        });
        originRunMatchesTask = origin.rows.length > 0;
        if (!originRunMatchesTask) return false;
      }
    }
  }
  if (
    request.delegatedTaskId &&
    request.runId &&
    !originRunMatchesTask &&
    request.delegatedTaskId !== runTaskId
  )
    return false;
  const taskId = request.delegatedTaskId ?? runTaskId;
  if (!taskId) return true;
  requireIdentifier(taskId);
  const task = await tx.execute({
    sql: "SELECT creator_principal_id,origin_scope_key,conversation_id FROM tasks WHERE id = ?",
    args: [taskId],
  });
  if (
    !task.rows[0] ||
    task.rows[0].creator_principal_id !== request.caller.principalId ||
    task.rows[0].origin_scope_key !== scopeKey(request.caller.scope)
  )
    return false;

  const technicalAction =
    (request.resourceId === `task-${taskId}` &&
      [
        "task:read",
        "task:continue",
        "task:plan",
        "task:delegate",
        "task:checkpoint:write",
      ].includes(request.action)) ||
    (request.conversationId !== undefined &&
      request.conversationId ===
        (runConversationId ?? optionalString(task.rows[0], "conversation_id")) &&
      request.resourceId === "agent:personal" &&
      ["run:create", "conversation:read", "run:control"].includes(request.action));
  const seen = new Set<string>();
  let current = taskId;
  for (let depth = 0; depth < 5; depth++) {
    if (seen.has(current)) return false;
    seen.add(current);
    const links = await tx.execute({
      sql: "SELECT parent_task_id,delegated_permissions_json FROM task_child_links WHERE child_task_id = ?",
      args: [current],
    });
    const link = links.rows[0];
    if (!link) return true;
    let permissions: unknown;
    try {
      permissions = JSON.parse(stringColumn(link, "delegated_permissions_json"));
    } catch {
      return false;
    }
    if (
      !Array.isArray(permissions) ||
      permissions.some(
        (permission) =>
          !permission ||
          typeof permission !== "object" ||
          typeof permission.resourceId !== "string" ||
          typeof permission.action !== "string",
      )
    )
      return false;
    if (
      !technicalAction &&
      !permissions.some(
        (permission) =>
          permission.resourceId === request.resourceId && permission.action === request.action,
      )
    )
      return false;
    current = stringColumn(link, "parent_task_id");
  }
  return false;
}

export type ProtectedReadClassification =
  | "content_source"
  | "access_gate"
  | "legacy_content_source"
  | "legacy_access_gate";

/**
 * Classifies a persisted authorization Action for delivery reauthorization.
 *
 * Content-source Actions read protected Resource contents and need both the original Action
 * and `delivery:send` rechecked. Search Actions gate access to a search surface; concrete
 * protected results are recorded separately against their own Resources. Public-web Resource
 * Actions are neither protected content sources nor protected search gates.
 */
const PROTECTED_READ_ACTION_VERBS = new Set(["read", "list", "status"]);

export function classifyProtectedReadAction(
  action: string,
  resourceKind: string | undefined,
): ProtectedReadClassification | undefined {
  if (resourceKind === "web-public") return undefined;
  const verb = action.split(":").at(-1);
  if (verb === "search") return "access_gate";
  return verb !== undefined && PROTECTED_READ_ACTION_VERBS.has(verb) ? "content_source" : undefined;
}

/** AUTH02's two non-read Actions whose verified results carry protected content. */
export function isDocumentedContentWrite(
  action: string,
  resourceKind: string | undefined,
  resourceId: string,
): boolean {
  return (
    (resourceKind === "workspace" &&
      resourceId.startsWith("workspace:") &&
      action === "workspace:write") ||
    (resourceKind === "owner-control" &&
      resourceId === "owner-control" &&
      action === "model:switch")
  );
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
    sql: "INSERT INTO authorization_decisions(id, principal_id, resource_id, action, scope_key, decision, reason, grant_id, approval_id, conversation_id, run_id, delivery_source, policy_condition_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
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
      null,
      policyConditionJson(request.policyCondition),
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
  /** Server-only receipt for completion of the same read, not permission for another operation. */
  completedReadDecisionId?: string,
): Promise<AuthorizationDecision> {
  requireIdentifier(request.resourceId);
  requireIdentifier(request.action);
  requireIdentifier(request.caller.principalId);
  const resolved = await resolveIdentity(tx, request.caller.scope);
  if (resolved === null) return recordDecision(tx, request, "DENY", "identity_unbound");
  if (resolved !== request.caller.principalId)
    return recordDecision(tx, request, "DENY", "identity_mismatch");
  const resources = await tx.execute({
    sql: "SELECT visibility, kind FROM resources WHERE id = ?",
    args: [request.resourceId],
  });
  if (!resources.rows[0]) return recordDecision(tx, request, "DENY", "resource_missing");
  if (
    stringColumn(resources.rows[0], "visibility") === "private" &&
    request.caller.scope.chatType === "group"
  ) {
    return recordDecision(tx, request, "DENY", "private_group_context");
  }
  if (!(await delegatedTaskAllows(tx, request)))
    return recordDecision(tx, request, "DENY", "delegation_scope_denied");
  const grants = await tx.execute({
    sql: "SELECT id, effect FROM grants WHERE principal_id = ? AND resource_id = ? AND action = ? AND scope_key = ? AND revoked_at IS NULL ORDER BY CASE effect WHEN 'allow' THEN 0 ELSE 1 END, id LIMIT 1",
    args: [resolved, request.resourceId, request.action, scopeKey(request.caller.scope)],
  });
  let grant = grants.rows[0];
  if (
    !grant &&
    stringColumn(resources.rows[0], "kind") === "task" &&
    request.resourceId.startsWith("task-")
  ) {
    const tasks = await tx.execute({
      sql: "SELECT id FROM tasks WHERE id = ? AND creator_principal_id = ? AND origin_scope_key = ?",
      args: [request.resourceId.slice(5), resolved, scopeKey(request.caller.scope)],
    });
    if (tasks.rows.length === 1) {
      const policies = await tx.execute({
        sql: "SELECT id, effect FROM grants WHERE principal_id = ? AND resource_id = ? AND action = ? AND scope_key = ? AND effect = 'allow' AND revoked_at IS NULL ORDER BY id LIMIT 1",
        args: [
          resolved,
          taskPolicyResourceId(request.caller),
          request.action,
          scopeKey(request.caller.scope),
        ],
      });
      grant = policies.rows[0];
    }
  }
  if (!grant) return recordDecision(tx, request, "DENY", "no_grant");
  if (
    !(await policyConditionAllows(tx, {
      ...request,
      resourceKind: stringColumn(resources.rows[0], "kind"),
    }))
  )
    return recordDecision(tx, request, "DENY", "source_policy_denied");
  const grantId = stringColumn(grant, "id");
  if (stringColumn(grant, "effect") === "allow")
    return recordDecision(tx, request, "ALLOW", "explicit_grant", grantId);
  if (completedReadDecisionId) {
    const completed = await tx.execute({
      sql: `SELECT a.id FROM authorization_decisions_all d JOIN approvals a ON a.id = d.approval_id
        WHERE d.id = ? AND d.decision = 'ALLOW' AND d.reason = 'approved' AND d.grant_id = ?
          AND d.principal_id = ? AND d.resource_id = ? AND d.action = ? AND d.scope_key = ?
          AND d.run_id IS ? AND d.conversation_id IS ? AND d.policy_condition_json IS ?
          AND a.grant_id = d.grant_id AND a.consumed_at IS NOT NULL AND a.expires_at > ?`,
      args: [
        completedReadDecisionId,
        grantId,
        resolved,
        request.resourceId,
        request.action,
        scopeKey(request.caller.scope),
        request.runId ?? null,
        request.conversationId ?? null,
        policyConditionJson(request.policyCondition),
        new Date().toISOString(),
      ],
    });
    if (completed.rows[0])
      return recordDecision(
        tx,
        request,
        "ALLOW",
        "approved",
        grantId,
        stringColumn(completed.rows[0], "id"),
      );
    return recordDecision(tx, request, "DENY", "approval_invalid", grantId);
  }
  if (!request.approvalId && request.runId && request.action === "run:create") {
    // Admission consumes approval once and links its decision to exactly one Run.
    // Rechecks reuse that evidence only while the same grant and binding are current.
    const locationKey = conversationScopeKey(request.caller.scope);
    const admitted = await tx.execute({
      sql: "SELECT a.id, a.grant_id FROM approvals a JOIN grants g ON g.id = a.grant_id JOIN authorization_decisions_all d ON d.approval_id = a.id JOIN runs r ON r.id = d.run_id JOIN conversations c ON c.id = r.conversation_id WHERE d.run_id = ? AND d.principal_id = ? AND d.resource_id = ? AND d.action = ? AND d.scope_key = ? AND d.decision = 'ALLOW' AND d.reason = 'approved' AND d.grant_id = a.grant_id AND g.revoked_at IS NULL AND a.consumed_at IS NOT NULL AND a.expires_at > ? AND r.principal_id = ? AND (c.scope_key = ? OR c.id IN (SELECT conversation_id FROM conversation_locations WHERE location_key = ?)) LIMIT 1",
      args: [
        request.runId,
        resolved,
        request.resourceId,
        request.action,
        scopeKey(request.caller.scope),
        new Date().toISOString(),
        resolved,
        locationKey,
        locationKey,
      ],
    });
    if (admitted.rows[0])
      return recordDecision(
        tx,
        request,
        "ALLOW",
        "approved",
        stringColumn(admitted.rows[0], "grant_id"),
        stringColumn(admitted.rows[0], "id"),
      );
  }
  if (!request.approvalId)
    return recordDecision(tx, request, "REQUIRES_APPROVAL", "approval_required", grantId);
  const nowIso = new Date().toISOString();
  const eligible = await tx.execute({
    sql: "SELECT a.id, a.grant_id FROM approvals a JOIN grants g ON g.id = a.grant_id WHERE a.id = ? AND a.principal_id = ? AND a.resource_id = ? AND a.action = ? AND a.scope_key = ? AND a.consumed_at IS NULL AND a.expires_at > ? AND g.revoked_at IS NULL",
    args: [
      request.approvalId,
      resolved,
      request.resourceId,
      request.action,
      scopeKey(request.caller.scope),
      nowIso,
    ],
  });
  const eligibleApproval = eligible.rows[0];
  if (!eligibleApproval) return recordDecision(tx, request, "DENY", "approval_invalid", grantId);
  const targetGrantId = stringColumn(eligibleApproval, "grant_id");
  const used = await tx.execute({
    sql: "UPDATE approvals SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL AND expires_at > ?",
    args: [nowIso, request.approvalId, nowIso],
  });
  if (used.rowsAffected !== 1)
    return recordDecision(tx, request, "DENY", "approval_invalid", targetGrantId);
  return recordDecision(tx, request, "ALLOW", "approved", targetGrantId, request.approvalId);
}

export type AuthorizedResult<T> = { value: T } | { denied: AuthorizationDecision };
export function authorizedValue<T>(result: AuthorizedResult<T>): T {
  if ("denied" in result) throw new AccessDeniedError(result.denied);
  return result.value;
}

export class AuthorizationService {
  constructor(private readonly db: DomainDatabase) {}

  /** Reauthorize completed reads and record every consumed source in one transaction.
   * Initial execution evidence remains intact. An approval receipt can finish only the exact
   * read it originally allowed; it is not consumed twice or reusable for another operation. */
  async authorizeReadResults(
    reads: readonly AuthorizedReadReceipt[],
  ): Promise<AuthorizationDecision[]> {
    return (await this.completeReadAuthorization(reads)).reads;
  }

  /** The last source-read and dependent action checks share one authorization snapshot.
   * Call only after all external role/trace/policy projections have finished. */
  async authorizeReadResultsAndAction(
    reads: readonly AuthorizedReadReceipt[],
    actionRequest: AuthorizationRequest,
  ): Promise<AuthorizationDecision> {
    const result = await this.completeReadAuthorization(reads, actionRequest);
    if (!result.action) throw new Error("Missing final action authorization");
    return result.action;
  }

  private async completeReadAuthorization(
    reads: readonly AuthorizedReadReceipt[],
    actionRequest?: AuthorizationRequest,
  ): Promise<{ reads: AuthorizationDecision[]; action?: AuthorizationDecision }> {
    if (reads.length > 128) throw new Error("Too many completed protected reads");
    return authorizedValue(
      await this.db.transaction<
        AuthorizedResult<{ reads: AuthorizationDecision[]; action?: AuthorizationDecision }>
      >(async (tx) => {
        if (
          actionRequest &&
          reads.some(
            ({ request }) =>
              request.caller.principalId !== actionRequest.caller.principalId ||
              scopeKey(request.caller.scope) !== scopeKey(actionRequest.caller.scope) ||
              (request.runId ?? null) !== (actionRequest.runId ?? null) ||
              (request.conversationId ?? null) !== (actionRequest.conversationId ?? null) ||
              (request.delegatedTaskId ?? null) !== (actionRequest.delegatedTaskId ?? null),
          )
        )
          return {
            denied: await recordDecision(tx, actionRequest, "DENY", "source_read_unverified"),
          };
        const decisions: AuthorizationDecision[] = [];
        for (const read of reads) {
          const { request } = read;
          const original = await tx.execute({
            sql: `SELECT d.id,d.delivery_source,r.kind FROM authorization_decisions_all d JOIN resources r ON r.id = d.resource_id
            WHERE d.id = ? AND d.decision = 'ALLOW' AND d.principal_id = ? AND d.resource_id = ?
              AND d.action = ? AND d.scope_key = ? AND d.run_id IS ? AND d.conversation_id IS ?
              AND d.policy_condition_json IS ?`,
            args: [
              read.decisionId,
              request.caller.principalId,
              request.resourceId,
              request.action,
              scopeKey(request.caller.scope),
              request.runId ?? null,
              request.conversationId ?? null,
              policyConditionJson(request.policyCondition),
            ],
          });
          if (
            !original.rows[0] ||
            (classifyProtectedReadAction(request.action, stringColumn(original.rows[0], "kind")) !==
              read.source &&
              !(
                read.source === "content_source" &&
                original.rows[0].delivery_source === "content_source" &&
                isDocumentedContentWrite(
                  request.action,
                  stringColumn(original.rows[0], "kind"),
                  request.resourceId,
                )
              ) &&
              !(
                original.rows[0].kind === "owner-memory" &&
                original.rows[0].delivery_source === "access_gate" &&
                isPublicGroupCollectionGate({
                  ...request,
                  source: read.source,
                  policyCondition: request.policyCondition ?? null,
                })
              ))
          )
            return { denied: await recordDecision(tx, request, "DENY", "source_read_unverified") };
          const decision = await evaluate(tx, request, read.decisionId);
          if (decision.decision !== "ALLOW") return { denied: decision };
          decisions.push(decision);
        }
        const action = actionRequest ? await evaluate(tx, actionRequest) : undefined;
        if (action && action.decision !== "ALLOW") return { denied: action };
        for (let index = 0; index < decisions.length; index++)
          await tx.execute({
            sql: "UPDATE authorization_decisions SET delivery_source = ? WHERE id = ?",
            args: [reads[index]!.source, decisions[index]!.id],
          });
        return { value: { reads: decisions, ...(action ? { action } : {}) } };
      }),
    );
  }

  /** Records protected output provenance before releasing content. Native tools mark before
   * execution because they can stream or return partial content even when the call fails. */
  async markDeliverySource(
    decisionId: string,
    source: "content_source" | "access_gate",
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      const updated = await tx.execute({
        sql: "UPDATE authorization_decisions SET delivery_source = ? WHERE id = ? AND decision = 'ALLOW' AND (delivery_source IS NULL OR delivery_source = ?)",
        args: [source, decisionId, source],
      });
      if (updated.rowsAffected === 1) return;
      const existing = await tx.execute({
        sql: "SELECT delivery_source FROM authorization_decisions WHERE id = ? AND decision = 'ALLOW'",
        args: [decisionId],
      });
      if (existing.rows[0]?.delivery_source !== source)
        throw new Error("delivery_source_decision_mismatch");
    });
  }

  /** Register metadata only. Protected content stays behind an authorized loader. */
  async registerResource(input: ProvisionedResource): Promise<void> {
    await this.db.transaction((tx) => this.registerResourceInTransaction(tx, input));
  }

  private async registerResourceInTransaction(
    tx: Transaction,
    input: ProvisionedResource,
  ): Promise<void> {
    requireIdentifier(input.id);
    requireIdentifier(input.kind);
    if (input.visibility !== "public" && input.visibility !== "private")
      throw new Error("Invalid resource visibility");
    await tx.execute({
      sql: `INSERT ${input.ifAbsent ? "OR IGNORE " : ""}INTO resources(id, kind, visibility, owner_id) VALUES (?, ?, ?, ?)`,
      args: [input.id, input.kind, input.visibility, input.ownerId ?? null],
    });
    if (input.ifAbsent) {
      const existing = (
        await tx.execute({
          sql: "SELECT kind, visibility, owner_id FROM resources WHERE id = ?",
          args: [input.id],
        })
      ).rows[0];
      if (
        !existing ||
        existing.kind !== input.kind ||
        existing.visibility !== input.visibility ||
        existing.owner_id !== (input.ownerId ?? null)
      )
        throw new Error("Resource metadata conflict");
    }
  }

  /** Management-only provisioning. Each ordered check remains in the decision ledger.
   * A bounded batch commits all metadata, decisions and grants together or rolls back all.
   * Initial provisioning never restores revoked or approval-only policy.
   */
  async provisionResources(input: {
    caller: CallerContext;
    entries: readonly ProvisioningEntry[];
    initialOnly: boolean;
  }): Promise<void> {
    if (!Array.isArray(input.entries) || input.entries.length > 128)
      throw new Error("Invalid provisioning batch size");
    if (typeof input.initialOnly !== "boolean") throw new Error("Invalid provisioning mode");
    requireIdentifier(input.caller.principalId);
    validateScope(input.caller.scope);
    await this.db.transaction(async (tx) => {
      for (const entry of input.entries) {
        await this.registerResourceInTransaction(tx, entry.resource);
        const existing = await evaluate(tx, {
          caller: input.caller,
          resourceId: entry.resource.id,
          action: entry.action,
        });
        if (existing.decision !== "ALLOW")
          await this.writeGrantInTransaction(
            tx,
            {
              principalId: input.caller.principalId,
              resourceId: entry.resource.id,
              action: entry.action,
              scope: input.caller.scope,
              effect: "allow",
            },
            input.initialOnly,
          );
      }
    });
  }

  /** Management-only. Explicit grants may restore previously revoked authority. */
  async grant(input: {
    principalId: string;
    resourceId: string;
    action: string;
    scope: TrustedChannelScope;
    effect: "allow" | "approval";
  }): Promise<string> {
    return (await this.writeGrant(input, false))!;
  }

  /** Initial provisioning only. Any prior policy, including revocation, stays authoritative. */
  async grantInitial(input: {
    principalId: string;
    resourceId: string;
    action: string;
    scope: TrustedChannelScope;
    effect: "allow" | "approval";
  }): Promise<string | null> {
    return this.writeGrant(input, true);
  }

  /** Historical routing metadata for explicit management restoration, never automatic grants. */
  async listScopeHistory(input: {
    resourceId: string;
    action: string;
    connectionId: string;
    botId: string;
    chatType: "private" | "group";
    chatId: string;
  }): Promise<CallerContext[]> {
    for (const value of [
      input.resourceId,
      input.action,
      input.connectionId,
      input.botId,
      input.chatId,
    ])
      requireIdentifier(value);
    if (input.chatType !== "private" && input.chatType !== "group")
      throw new Error("Invalid channel scope");
    return this.db.transaction(async (tx) => {
      const rows = await tx.execute({
        sql: `SELECT DISTINCT principal_id, scope_key FROM grants
              WHERE resource_id = ? AND action = ?
                AND json_extract(scope_key, '$[0]') = ?
                AND json_extract(scope_key, '$[1]') = ?
                AND json_extract(scope_key, '$[2]') = ?
                AND json_extract(scope_key, '$[3]') = ?`,
        args: [
          input.resourceId,
          input.action,
          input.connectionId,
          input.botId,
          input.chatType,
          input.chatId,
        ],
      });
      const scopes: CallerContext[] = [];
      for (const row of rows.rows) {
        const key = stringColumn(row, "scope_key");
        const tuple: unknown = JSON.parse(key);
        if (!Array.isArray(tuple) || tuple.length !== 6)
          throw new Error("Invalid persisted channel scope");
        const scope: TrustedChannelScope = {
          connectionId: tuple[0],
          botId: tuple[1],
          chatType: tuple[2],
          chatId: tuple[3],
          senderId: tuple[4],
          ...(tuple[5] === null ? {} : { threadId: tuple[5] }),
        };
        validateScope(scope);
        if (scopeKey(scope) !== key) throw new Error("Invalid persisted channel scope");
        scopes.push({ principalId: stringColumn(row, "principal_id"), scope });
      }
      return scopes;
    });
  }

  private async writeGrant(
    input: {
      principalId: string;
      resourceId: string;
      action: string;
      scope: TrustedChannelScope;
      effect: "allow" | "approval";
    },
    initialOnly: boolean,
  ): Promise<string | null> {
    return this.db.transaction((tx) => this.writeGrantInTransaction(tx, input, initialOnly));
  }

  private async writeGrantInTransaction(
    tx: Transaction,
    input: {
      principalId: string;
      resourceId: string;
      action: string;
      scope: TrustedChannelScope;
      effect: "allow" | "approval";
    },
    initialOnly: boolean,
  ): Promise<string | null> {
    for (const value of [input.principalId, input.resourceId, input.action])
      requireIdentifier(value);
    if (input.effect !== "allow" && input.effect !== "approval")
      throw new Error("Invalid grant effect");
    const key = scopeKey(input.scope);
    if (initialOnly) {
      const configured = await tx.execute({
        sql: "SELECT id FROM grants WHERE principal_id = ? AND resource_id = ? AND action = ? AND scope_key = ? LIMIT 1",
        args: [input.principalId, input.resourceId, input.action, key],
      });
      if (configured.rows[0]) return null;
    }
    const existing = await tx.execute({
      sql: "SELECT id FROM grants WHERE principal_id = ? AND resource_id = ? AND action = ? AND scope_key = ? AND effect = ? AND revoked_at IS NULL ORDER BY created_at ASC, id ASC LIMIT 1",
      args: [input.principalId, input.resourceId, input.action, key, input.effect],
    });
    if (existing.rows[0]) {
      return stringColumn(existing.rows[0], "id");
    }
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

  /**
   * Gives `delivery:send` to every Principal that can already read a content source, in the
   * exact scope where they can read it, only if delivery policy has never been configured.
   * Revocations and approval requirements are preserved. Returns how many grants it added.
   *
   * Reading a source and delivering what it produced are two rows, and a grant introduced
   * later only reaches the scopes the provisioning path knows about. A group member is
   * addressed at runtime, so their scope is not in the Channel configuration and never
   * appears in it: the backfill has to read the grants that exist rather than recreate the
   * ones it would create.
   */
  async backfillDeliveryForReaders(input: {
    resourceId: string;
    readAction: string;
  }): Promise<number> {
    for (const value of [input.resourceId, input.readAction]) requireIdentifier(value);
    return this.db.transaction(async (tx) => {
      const readers = await tx.execute({
        sql: `SELECT DISTINCT principal_id, scope_key FROM grants
          WHERE resource_id = ? AND action = ? AND effect = 'allow' AND revoked_at IS NULL`,
        args: [input.resourceId, input.readAction],
      });
      let added = 0;
      for (const row of readers.rows) {
        const principalId = stringColumn(row, "principal_id");
        const key = stringColumn(row, "scope_key");
        const existing = await tx.execute({
          sql: `SELECT id FROM grants
            WHERE principal_id = ? AND resource_id = ? AND action = 'delivery:send'
              AND scope_key = ? LIMIT 1`,
          args: [principalId, input.resourceId, key],
        });
        if (existing.rows[0]) continue;
        await tx.execute({
          sql: "INSERT INTO grants(id, principal_id, resource_id, action, scope_key, effect, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
          args: [
            randomUUID(),
            principalId,
            input.resourceId,
            "delivery:send",
            key,
            "allow",
            new Date().toISOString(),
          ],
        });
        added += 1;
      }
      return added;
    });
  }

  async revokeScope(input: {
    principalId: string;
    resourceId: string;
    scope: TrustedChannelScope;
  }): Promise<void> {
    requireIdentifier(input.principalId);
    requireIdentifier(input.resourceId);
    const key = scopeKey(input.scope);
    await this.db.transaction(async (tx) => {
      await tx.execute({
        sql: "UPDATE grants SET revoked_at = ? WHERE principal_id = ? AND resource_id = ? AND scope_key = ? AND revoked_at IS NULL",
        args: [new Date().toISOString(), input.principalId, input.resourceId, key],
      });
    });
  }

  /**
   * Revoke one Action on one Resource for one Principal in one scope.
   *
   * A Resource can carry several independent Actions — for example several capability
   * categories on the same QQ group. Disabling one must not silently revoke its siblings,
   * so the reverse of `grant` exists per Action and not only per Resource.
   */
  async revokeScopeAction(input: {
    principalId: string;
    resourceId: string;
    action: string;
    scope: TrustedChannelScope;
  }): Promise<void> {
    requireIdentifier(input.principalId);
    requireIdentifier(input.resourceId);
    const key = scopeKey(input.scope);
    await this.db.transaction(async (tx) => {
      await tx.execute({
        sql: "UPDATE grants SET revoked_at = ? WHERE principal_id = ? AND resource_id = ? AND action = ? AND scope_key = ? AND revoked_at IS NULL",
        args: [new Date().toISOString(), input.principalId, input.resourceId, input.action, key],
      });
    });
  }

  /** Retire every grant tied to one removed Channel sender, without touching other senders
   * or the same Principal's grants on a different connection or bot. */
  async revokeSenderScopes(input: {
    connectionId: string;
    botId: string;
    senderId: string;
  }): Promise<void> {
    for (const value of [input.connectionId, input.botId, input.senderId]) requireIdentifier(value);
    await this.db.transaction(async (tx) => {
      await tx.execute({
        sql: `UPDATE grants SET revoked_at = ? WHERE revoked_at IS NULL
          AND json_extract(scope_key, '$[0]') = ?
          AND json_extract(scope_key, '$[1]') = ?
          AND json_extract(scope_key, '$[4]') = ?`,
        args: [new Date().toISOString(), input.connectionId, input.botId, input.senderId],
      });
    });
  }

  /**
   * Revoke every active grant on one Resource, across principals and scopes.
   *
   * Use only when a Resource is retired in every scope. A QQ group number can be managed
   * through more than one connection, so disabling one connection must instead revoke
   * that connection's location scopes.
   */
  async revokeResource(resourceId: string): Promise<void> {
    requireIdentifier(resourceId);
    await this.db.transaction(async (tx) => {
      await tx.execute({
        sql: "UPDATE grants SET revoked_at = ? WHERE resource_id = ? AND revoked_at IS NULL",
        args: [new Date().toISOString(), resourceId],
      });
    });
  }

  /** Revoke every active grant issued inside one Channel location, across all senders. */
  async revokeLocationScopes(input: {
    connectionId: string;
    botId: string;
    chatType: "private" | "group";
    chatId: string;
  }): Promise<void> {
    for (const value of [input.connectionId, input.botId, input.chatId]) requireIdentifier(value);
    if (input.chatType !== "private" && input.chatType !== "group")
      throw new Error("Invalid channel scope");
    await this.db.transaction(async (tx) => {
      await tx.execute({
        sql: `UPDATE grants SET revoked_at = ?
              WHERE revoked_at IS NULL
                AND json_extract(scope_key, '$[0]') = ?
                AND json_extract(scope_key, '$[1]') = ?
                AND json_extract(scope_key, '$[2]') = ?
                AND json_extract(scope_key, '$[3]') = ?`,
        args: [
          new Date().toISOString(),
          input.connectionId,
          input.botId,
          input.chatType,
          input.chatId,
        ],
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

  /**
   * True when an active (unrevoked) grant exists for this exact Principal, Resource,
   * Action and scope.
   *
   * The reverse-state checks need to know whether *anyone* still holds an assignment
   * before tearing shared state down — for example whether a group still has an assigned
   * Owner after one Owner revokes. Reading the grant directly avoids treating a `check`
   * denial (which may be a visibility rule rather than a missing grant) as absence.
   */
  async hasActiveGrant(input: {
    principalId: string;
    resourceId: string;
    action: string;
    scope: TrustedChannelScope;
  }): Promise<boolean> {
    requireIdentifier(input.principalId);
    requireIdentifier(input.resourceId);
    requireIdentifier(input.action);
    const key = scopeKey(input.scope);
    return this.db.transaction(async (tx) => {
      const rows = await tx.execute({
        sql: "SELECT id FROM grants WHERE principal_id = ? AND resource_id = ? AND action = ? AND scope_key = ? AND effect = 'allow' AND revoked_at IS NULL LIMIT 1",
        args: [input.principalId, input.resourceId, input.action, key],
      });
      return rows.rows.length > 0;
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
