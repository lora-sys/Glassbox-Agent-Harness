import { randomUUID } from "node:crypto";
import type { Row, Transaction } from "@libsql/client";
import {
  authorizedValue,
  evaluate,
  recordDecision,
  type AuthorizedResult,
  type AuthorizationDecision,
} from "../auth/service.js";
import { resolveIdentity } from "../identity/service.js";
import {
  conversationScopeKey,
  requireIdentifier,
  scopeKey,
  type CallerContext,
  type TrustedChannelScope,
} from "../identity/scope.js";
import { DomainDatabase, optionalString, stringColumn } from "../persistence/database.js";

export type RunStatus =
  | "queued"
  | "running"
  | "cancelling"
  | "cancelled"
  | "succeeded"
  | "failed"
  | "interrupted"
  | "unknown";
export interface ConversationRecord {
  id: string;
  agentId: string;
  principalId: string;
  scope: TrustedChannelScope;
  providerKind: string | null;
  providerSessionId: string | null;
  providerSessionPrincipalId?: string | null;
  createdAt: string;
}
export interface RunRecord {
  id: string;
  conversationId: string;
  messageId: string;
  principalId: string;
  executionRef: string;
  status: RunStatus;
  resultText: string | null;
  createdAt: string;
  updatedAt: string;
}
export interface PageOptions {
  limit?: number;
  cursor?: string;
}
export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}
export interface IncomingMessage {
  agentId: string;
  scope: TrustedChannelScope;
  messageId: string;
  text: string;
  executionRef: string;
  approvalId?: string;
}
export interface RunInputRecord {
  run: RunRecord;
  conversation: ConversationRecord;
  text: string;
  history: Array<{ role: "user" | "assistant"; text: string }>;
  providerSessionId: string | null;
}

export function agentResourceId(agentId: string): string {
  requireIdentifier(agentId);
  return `agent:${agentId}`;
}

export function runRecord(row: Row): RunRecord {
  return {
    id: stringColumn(row, "id"),
    conversationId: stringColumn(row, "conversation_id"),
    messageId: stringColumn(row, "message_id"),
    principalId: stringColumn(row, "principal_id"),
    executionRef: stringColumn(row, "execution_ref"),
    status: stringColumn(row, "status") as RunStatus,
    resultText: optionalString(row, "result_text"),
    createdAt: stringColumn(row, "created_at"),
    updatedAt: stringColumn(row, "updated_at"),
  };
}

function conversationRecord(row: Row, scope: TrustedChannelScope): ConversationRecord {
  return {
    id: stringColumn(row, "id"),
    agentId: stringColumn(row, "agent_id"),
    principalId: stringColumn(row, "principal_id"),
    scope: { ...scope },
    providerKind: optionalString(row, "provider_kind"),
    providerSessionId: optionalString(row, "provider_session_id"),
    providerSessionPrincipalId: optionalString(row, "provider_session_principal_id"),
    createdAt: stringColumn(row, "created_at"),
  };
}

export function pageParameters(options: PageOptions = {}): {
  limit: number;
  afterTime: string;
  afterId: string;
} {
  const limit = options.limit ?? 30;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100)
    throw new Error("Page limit must be between 1 and 100");
  if (!options.cursor) return { limit, afterTime: "", afterId: "" };
  try {
    if (options.cursor.length > 4096) throw new Error();
    const decoded: unknown = JSON.parse(Buffer.from(options.cursor, "base64url").toString("utf8"));
    if (
      !Array.isArray(decoded) ||
      decoded.length !== 2 ||
      decoded.some((value) => typeof value !== "string")
    )
      throw new Error();
    return { limit, afterTime: decoded[0] as string, afterId: decoded[1] as string };
  } catch {
    throw new Error("Invalid page cursor");
  }
}

export function makePage<T>(rows: Row[], limit: number, map: (row: Row) => T): Page<T> {
  const included = rows.slice(0, limit);
  const last = included.at(-1);
  return {
    items: included.map(map),
    nextCursor:
      rows.length > limit && last
        ? Buffer.from(
            JSON.stringify([stringColumn(last, "created_at"), stringColumn(last, "id")]),
          ).toString("base64url")
        : null,
  };
}

/** Reads only addressing metadata until scope, identity and the live grant pass. */
export async function authorizeConversation(
  tx: Transaction,
  caller: CallerContext,
  conversationId: string,
  action: string,
  runId?: string,
): Promise<AuthorizedResult<{ agentId: string }>> {
  requireIdentifier(conversationId);
  const result = await tx.execute({
    sql: "SELECT c.agent_id, c.principal_id, c.scope_key, c.scope_json, r.visibility, r.owner_id FROM conversations c JOIN resources r ON r.id = c.resource_id WHERE c.id = ?",
    args: [conversationId],
  });
  const row = result.rows[0];
  if (!row) {
    const denied = await recordDecision(
      tx,
      { caller, resourceId: "conversation", action },
      "DENY",
      "scope_mismatch",
    );
    return { denied };
  }

  const agentId = stringColumn(row, "agent_id");
  const visibility = stringColumn(row, "visibility");
  const ownerId = optionalString(row, "owner_id");
  const storedScopeKey = stringColumn(row, "scope_key");

  const callerLocationKey = conversationScopeKey(caller.scope);
  let matchesLocation = storedScopeKey === callerLocationKey;
  if (!matchesLocation) {
    const loc = await tx.execute({
      sql: "SELECT 1 FROM conversation_locations WHERE conversation_id = ? AND location_key = ?",
      args: [conversationId, callerLocationKey],
    });
    if (loc.rows.length > 0) {
      matchesLocation = true;
    } else {
      try {
        const storedScope = JSON.parse(stringColumn(row, "scope_json"));
        if (conversationScopeKey(storedScope) === callerLocationKey) {
          matchesLocation = true;
        }
      } catch {
        // ignore parse errors
      }
    }
  }

  if (!matchesLocation) {
    const denied = await recordDecision(
      tx,
      { caller, resourceId: "conversation", action },
      "DENY",
      "scope_mismatch",
    );
    return { denied };
  }

  if (
    visibility === "private" &&
    caller.principalId !== (ownerId ?? stringColumn(row, "principal_id"))
  ) {
    const denied = await recordDecision(
      tx,
      { caller, resourceId: "conversation", action },
      "DENY",
      "scope_mismatch",
    );
    return { denied };
  }

  const decision = await evaluate(tx, {
    caller,
    resourceId: agentResourceId(agentId),
    action,
    conversationId,
    ...(runId ? { runId } : {}),
  });
  return decision.decision === "ALLOW" ? { value: { agentId } } : { denied: decision };
}

export async function authorizeRun(
  tx: Transaction,
  caller: CallerContext,
  runId: string,
  action: string,
): Promise<AuthorizedResult<{ conversationId: string }>> {
  requireIdentifier(runId);
  const result = await tx.execute({
    sql: "SELECT conversation_id, principal_id FROM runs WHERE id = ?",
    args: [runId],
  });
  const row = result.rows[0];
  if (!row)
    return {
      denied: await recordDecision(
        tx,
        { caller, resourceId: "run", action },
        "DENY",
        "scope_mismatch",
      ),
    };
  const conversationId = stringColumn(row, "conversation_id");
  const runPrincipalId = stringColumn(row, "principal_id");

  if (caller.principalId !== runPrincipalId) {
    return {
      denied: await recordDecision(
        tx,
        { caller, resourceId: "run", action, runId, conversationId },
        "DENY",
        "scope_mismatch",
      ),
    };
  }

  const authorization = await authorizeConversation(tx, caller, conversationId, action, runId);
  return "denied" in authorization ? authorization : { value: { conversationId } };
}

function matchesDestinationLocation(
  destinationScopeKey: string,
  targetLocationKey: string,
): boolean {
  if (destinationScopeKey === targetLocationKey) return true;
  try {
    const parsed = JSON.parse(destinationScopeKey);
    if (Array.isArray(parsed)) {
      if (parsed.length >= 5) {
        const [conn, bot, chatType, chatId, , thread] = parsed;
        const convKey = JSON.stringify([conn, bot, chatType, chatId, thread ?? null]);
        if (convKey === targetLocationKey) return true;
      }
    } else if (parsed && typeof parsed === "object" && parsed.chatType) {
      if (conversationScopeKey(parsed) === targetLocationKey) return true;
    }
  } catch {
    // ignore parse errors
  }
  return false;
}

export class ConversationStore {
  constructor(private readonly db: DomainDatabase) {}

  /** Management-only setup. Reopening the same configured Agent is idempotent. */
  async createAgent(id: string): Promise<void> {
    const resourceId = agentResourceId(id);
    await this.db.transaction(async (tx) => {
      await tx.execute({
        sql: "INSERT INTO agents(id, created_at) VALUES (?, ?) ON CONFLICT(id) DO NOTHING",
        args: [id, new Date().toISOString()],
      });
      await tx.execute({
        sql: "INSERT INTO resources(id, kind, visibility) VALUES (?, 'agent', 'public') ON CONFLICT(id) DO NOTHING",
        args: [resourceId],
      });
    });
  }

  async acceptIncoming(input: IncomingMessage): Promise<{
    conversation: ConversationRecord;
    run: RunRecord;
    duplicate: boolean;
    caller: CallerContext;
  }> {
    requireIdentifier(input.messageId);
    requireIdentifier(input.executionRef);
    if (typeof input.text !== "string" || input.text.length > 64_000)
      throw new Error("Message exceeds the accepted text limit");
    const key = scopeKey(input.scope);
    const convKey = conversationScopeKey(input.scope);
    const outcome = await this.db.transaction<
      AuthorizedResult<{
        conversation: ConversationRecord;
        run: RunRecord;
        duplicate: boolean;
        caller: CallerContext;
      }>
    >(async (tx) => {
      const principalId = await resolveIdentity(tx, input.scope);
      const caller = { principalId: principalId ?? "unbound", scope: input.scope };
      const prior = await tx.execute({
        sql: "SELECT runs.id, runs.conversation_id, runs.principal_id FROM runs JOIN messages ON messages.id = runs.message_id WHERE messages.scope_key = ? AND messages.external_id = ?",
        args: [key, input.messageId],
      });
      if (prior.rows[0]) {
        const runId = stringColumn(prior.rows[0], "id");
        const authorization = await authorizeRun(tx, caller, runId, "conversation:read");
        if ("denied" in authorization) return authorization;
        const rows = await tx.execute({
          sql: "SELECT * FROM conversations WHERE id = ? AND agent_id = ?",
          args: [authorization.value.conversationId, input.agentId],
        });
        if (!rows.rows[0])
          return {
            denied: await recordDecision(
              tx,
              { caller, resourceId: "conversation", action: "run:create" },
              "DENY",
              "scope_mismatch",
            ),
          };
        const runRows = await tx.execute({ sql: "SELECT * FROM runs WHERE id = ?", args: [runId] });
        const run = runRecord(runRows.rows[0]!);
        if (run.principalId !== caller.principalId) {
          return {
            denied: await recordDecision(
              tx,
              { caller, resourceId: "run", action: "run:create" },
              "DENY",
              "scope_mismatch",
            ),
          };
        }
        return {
          value: {
            conversation: conversationRecord(rows.rows[0], input.scope),
            run,
            duplicate: true,
            caller,
          },
        };
      }
      const decision = await evaluate(tx, {
        caller,
        resourceId: agentResourceId(input.agentId),
        action: "run:create",
        ...(input.approvalId ? { approvalId: input.approvalId } : {}),
      });
      if (decision.decision !== "ALLOW") return { denied: decision };
      const locRow = await tx.execute({
        sql: "SELECT conversation_id FROM conversation_locations WHERE agent_id = ? AND location_key = ?",
        args: [input.agentId, convKey],
      });
      const conversations = locRow.rows[0]
        ? await tx.execute({
            sql: "SELECT * FROM conversations WHERE id = ?",
            args: [stringColumn(locRow.rows[0], "conversation_id")],
          })
        : await tx.execute({
            sql: "SELECT * FROM conversations WHERE agent_id = ? AND scope_key = ?",
            args: [input.agentId, convKey],
          });
      let conversationRow: Row | undefined = conversations.rows[0];
      let remapPrivateLocation = false;
      const now = new Date().toISOString();
      if (
        conversationRow &&
        input.scope.chatType === "private" &&
        stringColumn(conversationRow, "principal_id") !== caller.principalId
      ) {
        const principalConversations = await tx.execute({
          sql: "SELECT * FROM conversations WHERE agent_id = ? AND principal_id = ? ORDER BY created_at DESC, id DESC",
          args: [input.agentId, caller.principalId],
        });
        conversationRow = principalConversations.rows.find((row) => {
          try {
            return conversationScopeKey(JSON.parse(stringColumn(row, "scope_json"))) === convKey;
          } catch {
            return false;
          }
        });
        remapPrivateLocation = true;
      }
      if (!conversationRow) {
        const id = randomUUID();
        const resourceId = `conversation:${id}`;
        const persistedScopeKey = remapPrivateLocation
          ? JSON.stringify([convKey, caller.principalId])
          : convKey;
        await tx.execute({
          sql: "INSERT INTO resources(id, kind, visibility, owner_id) VALUES (?, 'conversation', ?, ?)",
          args: [
            resourceId,
            input.scope.chatType === "private" ? "private" : "public",
            caller.principalId,
          ],
        });
        await tx.execute({
          sql: "INSERT INTO conversations(id, agent_id, principal_id, scope_key, scope_json, resource_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
          args: [
            id,
            input.agentId,
            caller.principalId,
            persistedScopeKey,
            JSON.stringify(input.scope),
            resourceId,
            now,
          ],
        });
        await tx.execute({
          sql: `INSERT INTO conversation_locations(agent_id, location_key, conversation_id, created_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(agent_id, location_key) DO UPDATE SET conversation_id = excluded.conversation_id`,
          args: [input.agentId, convKey, id, now],
        });
        const created = await tx.execute({
          sql: "SELECT * FROM conversations WHERE id = ?",
          args: [id],
        });
        conversationRow = created.rows[0];
      } else if (remapPrivateLocation) {
        await tx.execute({
          sql: "UPDATE conversation_locations SET conversation_id = ? WHERE agent_id = ? AND location_key = ?",
          args: [stringColumn(conversationRow, "id"), input.agentId, convKey],
        });
      } else if (!locRow.rows[0]) {
        await tx.execute({
          sql: "INSERT INTO conversation_locations(agent_id, location_key, conversation_id, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(agent_id, location_key) DO NOTHING",
          args: [input.agentId, convKey, stringColumn(conversationRow, "id"), now],
        });
      }
      if (!conversationRow) throw new Error("Conversation persistence failed");
      const conversation = conversationRecord(conversationRow, input.scope);
      const messageId = randomUUID();
      const runId = randomUUID();
      await tx.execute({
        sql: "INSERT INTO messages(id, conversation_id, scope_key, external_id, text, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        args: [messageId, conversation.id, key, input.messageId, input.text, now],
      });
      await tx.execute({
        sql: "INSERT INTO runs(id, conversation_id, message_id, principal_id, scope_json, execution_ref, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?)",
        args: [
          runId,
          conversation.id,
          messageId,
          caller.principalId,
          JSON.stringify(caller.scope),
          input.executionRef,
          now,
          now,
        ],
      });
      const run: RunRecord = {
        id: runId,
        conversationId: conversation.id,
        messageId,
        principalId: caller.principalId,
        executionRef: input.executionRef,
        status: "queued",
        resultText: null,
        createdAt: now,
        updatedAt: now,
      };
      await this.linkDecision(tx, decision, run);
      return { value: { conversation, run, duplicate: false, caller } };
    });
    return authorizedValue(outcome);
  }

  private async linkDecision(
    tx: Transaction,
    decision: AuthorizationDecision,
    run: RunRecord,
  ): Promise<void> {
    // Link the decision made in this same transaction, without changing its facts.
    await tx.execute({
      sql: "UPDATE authorization_decisions SET conversation_id = ?, run_id = ? WHERE id = ?",
      args: [run.conversationId, run.id, decision.id],
    });
  }

  async listConversations(
    caller: CallerContext,
    agentId: string,
    options: PageOptions = {},
  ): Promise<Page<ConversationRecord>> {
    const page = pageParameters(options);
    const outcome = await this.db.transaction<AuthorizedResult<Page<ConversationRecord>>>(
      async (tx) => {
        const decision = await evaluate(tx, {
          caller,
          resourceId: agentResourceId(agentId),
          action: "conversation:read",
        });
        if (decision.decision !== "ALLOW") return { denied: decision };
        const convKey = conversationScopeKey(caller.scope);
        const rows = await tx.execute({
          sql: `SELECT DISTINCT c.* FROM conversations c
                LEFT JOIN conversation_locations cl ON cl.conversation_id = c.id
                WHERE c.agent_id = ? AND (cl.location_key = ? OR c.scope_key = ?)
                AND (c.created_at, c.id) > (?, ?)
                ORDER BY c.created_at, c.id LIMIT ?`,
          args: [agentId, convKey, convKey, page.afterTime, page.afterId, page.limit + 1],
        });
        const items = [];
        for (const row of rows.rows) {
          const auth = await authorizeConversation(
            tx,
            caller,
            stringColumn(row, "id"),
            "conversation:read",
          );
          if (!("denied" in auth)) items.push(row);
        }
        return {
          value: makePage(items, page.limit, (row) => conversationRecord(row, caller.scope)),
        };
      },
    );
    return authorizedValue(outcome);
  }

  async getConversation(caller: CallerContext, id: string): Promise<ConversationRecord> {
    return authorizedValue(
      await this.db.transaction<AuthorizedResult<ConversationRecord>>(async (tx) => {
        const decision = await authorizeConversation(tx, caller, id, "conversation:read");
        if ("denied" in decision) return decision;
        const rows = await tx.execute({
          sql: "SELECT * FROM conversations WHERE id = ?",
          args: [id],
        });
        return { value: conversationRecord(rows.rows[0]!, caller.scope) };
      }),
    );
  }

  async getRun(caller: CallerContext, id: string): Promise<RunRecord> {
    return authorizedValue(
      await this.db.transaction<AuthorizedResult<RunRecord>>(async (tx) => {
        const decision = await authorizeRun(tx, caller, id, "conversation:read");
        if ("denied" in decision) return decision;
        const rows = await tx.execute({ sql: "SELECT * FROM runs WHERE id = ?", args: [id] });
        return { value: runRecord(rows.rows[0]!) };
      }),
    );
  }

  async listRuns(
    caller: CallerContext,
    conversationId: string,
    options: PageOptions = {},
  ): Promise<Page<RunRecord>> {
    const page = pageParameters(options);
    return authorizedValue(
      await this.db.transaction<AuthorizedResult<Page<RunRecord>>>(async (tx) => {
        const decision = await authorizeConversation(
          tx,
          caller,
          conversationId,
          "conversation:read",
        );
        if ("denied" in decision) return decision;
        const rows = await tx.execute({
          sql: "SELECT * FROM runs WHERE conversation_id = ? AND principal_id = ? AND (created_at, id) > (?, ?) ORDER BY created_at, id LIMIT ?",
          args: [conversationId, caller.principalId, page.afterTime, page.afterId, page.limit + 1],
        });
        return { value: makePage(rows.rows, page.limit, runRecord) };
      }),
    );
  }

  async listMessages(
    caller: CallerContext,
    conversationId: string,
    options: PageOptions = {},
  ): Promise<Page<{ id: string; text: string; createdAt: string }>> {
    const page = pageParameters(options);
    return authorizedValue(
      await this.db.transaction<
        AuthorizedResult<Page<{ id: string; text: string; createdAt: string }>>
      >(async (tx) => {
        const decision = await authorizeConversation(
          tx,
          caller,
          conversationId,
          "conversation:read",
        );
        if ("denied" in decision) return decision;
        const rows = await tx.execute({
          sql: "SELECT id, text, created_at FROM messages WHERE conversation_id = ? AND (created_at, id) > (?, ?) ORDER BY created_at, id LIMIT ?",
          args: [conversationId, page.afterTime, page.afterId, page.limit + 1],
        });
        return {
          value: makePage(rows.rows, page.limit, (row) => ({
            id: stringColumn(row, "id"),
            text: stringColumn(row, "text"),
            createdAt: stringColumn(row, "created_at"),
          })),
        };
      }),
    );
  }

  /** Explicit incident response. Preserve the original record and append the
   * exclusion decision; excluded exchanges cannot be reused by any Principal. */
  async excludeRunFromContext(caller: CallerContext, runId: string): Promise<boolean> {
    return authorizedValue(
      await this.db.transaction<AuthorizedResult<boolean>>(async (tx) => {
        const authorization = await authorizeRun(tx, caller, runId, "run:control");
        if ("denied" in authorization) return authorization;
        const prior = await tx.execute({
          sql: "SELECT event_id FROM ops_trace_events WHERE run_id = ? AND type = 'context.excluded' LIMIT 1",
          args: [runId],
        });
        if (prior.rows.length) return { value: false };
        await tx.execute({
          sql: "INSERT INTO ops_trace_events(event_id, ts, type, run_id, principal_id, data_json) VALUES (?, ?, 'context.excluded', ?, ?, ?)",
          args: [
            randomUUID(),
            new Date().toISOString(),
            runId,
            caller.principalId,
            JSON.stringify({ action: "Exclude Run Context", reason: "unsafe_runtime_context" }),
          ],
        });
        return { value: true };
      }),
    );
  }

  /** Load only this Run's input and earlier completed exchanges. Later queued
   * messages cannot become context before their own Run reaches execution. */
  async loadRunInput(caller: CallerContext, runId: string): Promise<RunInputRecord> {
    return authorizedValue(
      await this.db.transaction<AuthorizedResult<RunInputRecord>>(async (tx) => {
        const authorization = await authorizeRun(tx, caller, runId, "conversation:read");
        if ("denied" in authorization) return authorization;
        const rows = await tx.execute({
          sql: "SELECT runs.*, messages.text AS input_text FROM runs JOIN messages ON messages.id = runs.message_id WHERE runs.id = ?",
          args: [runId],
        });
        const row = rows.rows[0]!;
        const run = runRecord(row);
        const conversations = await tx.execute({
          sql: "SELECT * FROM conversations WHERE id = ?",
          args: [run.conversationId],
        });
        const conversation = conversationRecord(conversations.rows[0]!, caller.scope);
        const earlier = await tx.execute({
          sql: "SELECT runs.id, runs.principal_id, runs.sequence, runs.message_id FROM runs WHERE runs.conversation_id = ? AND runs.sequence < ? AND runs.status = 'succeeded' AND runs.result_text IS NOT NULL AND NOT EXISTS (SELECT 1 FROM ops_trace_events e WHERE e.run_id = runs.id AND e.type = 'context.excluded') ORDER BY runs.sequence DESC LIMIT 20",
          args: [run.conversationId, row.sequence!],
        });
        const callerLocationKey = conversationScopeKey(caller.scope);
        const exchanges: Array<{ user: string; assistant: string }> = [];
        let remaining = 32_000;
        for (const prior of earlier.rows) {
          const priorPrincipalId = stringColumn(prior, "principal_id");
          const priorRunId = stringColumn(prior, "id");
          const priorMessageId = stringColumn(prior, "message_id");
          let user: string;
          let assistant: string;

          const grantRows = await tx.execute({
            sql: "SELECT d.grant_id, g.revoked_at FROM authorization_decisions d JOIN grants g ON g.id = d.grant_id WHERE d.run_id = ? AND d.decision = 'ALLOW'",
            args: [priorRunId],
          });
          if (grantRows.rows.length === 0 || grantRows.rows.some((r) => r.revoked_at !== null)) {
            continue;
          }

          const sources = await tx.execute({
            sql: `SELECT DISTINCT resource_id, action FROM authorization_decisions WHERE run_id = ?
              AND decision = 'ALLOW' AND action IN ('read', 'context:read', 'worker:read', 'worker:status', 'worker:file:read', 'task:read')`,
            args: [priorRunId],
          });
          let permitted = true;
          for (const source of sources.rows) {
            const decision = await evaluate(tx, {
              caller,
              resourceId: stringColumn(source, "resource_id"),
              action: stringColumn(source, "action"),
              conversationId: run.conversationId,
              runId,
            });
            if (decision.decision !== "ALLOW") {
              permitted = false;
              break;
            }
          }
          if (!permitted) continue;

          const deliveryRows = await tx.execute({
            sql: "SELECT payload_text, destination_scope_key FROM deliveries WHERE run_id = ? AND status = 'sent' AND payload_kind IN ('text', 'result') ORDER BY created_at DESC",
            args: [priorRunId],
          });
          const matchingDelivery = deliveryRows.rows.find((dRow) =>
            matchesDestinationLocation(
              stringColumn(dRow, "destination_scope_key"),
              callerLocationKey,
            ),
          );
          if (matchingDelivery) assistant = stringColumn(matchingDelivery, "payload_text");
          else if (priorPrincipalId === caller.principalId) {
            const resultRows = await tx.execute({
              sql: "SELECT result_text FROM runs WHERE id = ?",
              args: [priorRunId],
            });
            if (!resultRows.rows[0]) continue;
            const result = resultRows.rows[0].result_text;
            if (typeof result !== "string" || !result) continue;
            assistant = result;
          } else continue;
          const msgRows = await tx.execute({
            sql: "SELECT text FROM messages WHERE id = ?",
            args: [priorMessageId],
          });
          if (!msgRows.rows[0]) continue;
          user = stringColumn(msgRows.rows[0], "text");

          if (user.length + assistant.length > remaining) break;
          remaining -= user.length + assistant.length;
          exchanges.push({ user, assistant });
        }
        const history = exchanges.reverse().flatMap(({ user, assistant }) => [
          { role: "user" as const, text: user },
          { role: "assistant" as const, text: assistant },
        ]);
        const sessionPrincipal = conversation.providerSessionPrincipalId;
        const providerSessionId =
          conversation.providerKind === run.executionRef && sessionPrincipal === caller.principalId
            ? conversation.providerSessionId
            : null;
        return {
          value: {
            run,
            conversation: {
              ...conversation,
              providerKind: providerSessionId ? run.executionRef : null,
              providerSessionId,
              providerSessionPrincipalId: providerSessionId ? caller.principalId : null,
            },
            text: stringColumn(row, "input_text"),
            history,
            providerSessionId,
          },
        };
      }),
    );
  }

  async setProviderSession(
    caller: CallerContext,
    conversationId: string,
    providerKind: string,
    providerSessionId: string,
  ): Promise<void> {
    requireIdentifier(providerKind);
    requireIdentifier(providerSessionId);
    authorizedValue(
      await this.db.transaction<AuthorizedResult<void>>(async (tx) => {
        const decision = await authorizeConversation(tx, caller, conversationId, "run:control");
        if ("denied" in decision) return decision;
        const used = await tx.execute({
          sql: "SELECT id FROM conversations WHERE provider_kind = ? AND provider_session_id = ? AND id <> ?",
          args: [providerKind, providerSessionId, conversationId],
        });
        if (used.rows.length)
          throw new Error("Provider Session already belongs to a different Conversation");
        await tx.execute({
          sql: "UPDATE conversations SET provider_kind = ?, provider_session_id = ?, provider_session_principal_id = ? WHERE id = ?",
          args: [providerKind, providerSessionId, caller.principalId, conversationId],
        });
        return { value: undefined };
      }),
    );
  }
}
