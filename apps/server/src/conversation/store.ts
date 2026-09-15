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
  createdAt: string;
}
export interface RunRecord {
  id: string;
  conversationId: string;
  messageId: string;
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
    sql: "SELECT agent_id, principal_id, scope_key FROM conversations WHERE id = ?",
    args: [conversationId],
  });
  const row = result.rows[0];
  if (
    !row ||
    stringColumn(row, "principal_id") !== caller.principalId ||
    stringColumn(row, "scope_key") !== scopeKey(caller.scope)
  ) {
    const denied = await recordDecision(
      tx,
      { caller, resourceId: "conversation", action },
      "DENY",
      "scope_mismatch",
    );
    return { denied };
  }
  const agentId = stringColumn(row, "agent_id");
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
    sql: "SELECT conversation_id FROM runs WHERE id = ?",
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
  const authorization = await authorizeConversation(tx, caller, conversationId, action, runId);
  return "denied" in authorization ? authorization : { value: { conversationId } };
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
        sql: "SELECT runs.id, runs.conversation_id FROM runs JOIN messages ON messages.id = runs.message_id WHERE messages.scope_key = ? AND messages.external_id = ?",
        args: [key, input.messageId],
      });
      if (prior.rows[0]) {
        const runId = stringColumn(prior.rows[0], "id");
        const authorization = await authorizeRun(tx, caller, runId, "conversation:read");
        if ("denied" in authorization) return authorization;
        const rows = await tx.execute({
          sql: "SELECT * FROM conversations WHERE id = ? AND agent_id = ? AND principal_id = ?",
          args: [authorization.value.conversationId, input.agentId, caller.principalId],
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
      let conversations = await tx.execute({
        sql: "SELECT * FROM conversations WHERE agent_id = ? AND scope_key = ?",
        args: [input.agentId, key],
      });
      const now = new Date().toISOString();
      if (
        conversations.rows[0] &&
        stringColumn(conversations.rows[0], "principal_id") !== caller.principalId
      ) {
        return {
          denied: await recordDecision(
            tx,
            { caller, resourceId: "conversation", action: "run:create" },
            "DENY",
            "scope_mismatch",
          ),
        };
      }
      if (!conversations.rows[0]) {
        const id = randomUUID();
        const resourceId = `conversation:${id}`;
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
            key,
            JSON.stringify(input.scope),
            resourceId,
            now,
          ],
        });
        conversations = await tx.execute({
          sql: "SELECT * FROM conversations WHERE id = ?",
          args: [id],
        });
      }
      const conversationRow = conversations.rows[0];
      if (!conversationRow) throw new Error("Conversation persistence failed");
      const conversation = conversationRecord(conversationRow, input.scope);
      const messageId = randomUUID();
      const runId = randomUUID();
      await tx.execute({
        sql: "INSERT INTO messages(id, conversation_id, scope_key, external_id, text, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        args: [messageId, conversation.id, key, input.messageId, input.text, now],
      });
      await tx.execute({
        sql: "INSERT INTO runs(id, conversation_id, message_id, execution_ref, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'queued', ?, ?)",
        args: [runId, conversation.id, messageId, input.executionRef, now, now],
      });
      const run: RunRecord = {
        id: runId,
        conversationId: conversation.id,
        messageId,
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
        const rows = await tx.execute({
          sql: "SELECT * FROM conversations WHERE agent_id = ? AND principal_id = ? AND scope_key = ? AND (created_at, id) > (?, ?) ORDER BY created_at, id LIMIT ?",
          args: [
            agentId,
            caller.principalId,
            scopeKey(caller.scope),
            page.afterTime,
            page.afterId,
            page.limit + 1,
          ],
        });
        return {
          value: makePage(rows.rows, page.limit, (row) => conversationRecord(row, caller.scope)),
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
          sql: "SELECT * FROM runs WHERE conversation_id = ? AND (created_at, id) > (?, ?) ORDER BY created_at, id LIMIT ?",
          args: [conversationId, page.afterTime, page.afterId, page.limit + 1],
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
          sql: "SELECT messages.text, runs.result_text FROM runs JOIN messages ON messages.id = runs.message_id WHERE runs.conversation_id = ? AND runs.sequence < ? AND runs.status = 'succeeded' AND runs.result_text IS NOT NULL ORDER BY runs.sequence DESC LIMIT 20",
          args: [run.conversationId, row.sequence!],
        });
        const exchanges: Array<{ user: string; assistant: string }> = [];
        let remaining = 32_000;
        for (const prior of earlier.rows) {
          const user = stringColumn(prior, "text");
          const assistant = stringColumn(prior, "result_text");
          if (user.length + assistant.length > remaining) break;
          remaining -= user.length + assistant.length;
          exchanges.push({ user, assistant });
        }
        const history = exchanges.reverse().flatMap(({ user, assistant }) => [
          { role: "user" as const, text: user },
          { role: "assistant" as const, text: assistant },
        ]);
        const providerSessionId =
          conversation.providerKind === run.executionRef ? conversation.providerSessionId : null;
        return {
          value: {
            run,
            conversation: {
              ...conversation,
              providerKind: providerSessionId ? run.executionRef : null,
              providerSessionId,
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
          sql: "UPDATE conversations SET provider_kind = ?, provider_session_id = ? WHERE id = ?",
          args: [providerKind, providerSessionId, conversationId],
        });
        return { value: undefined };
      }),
    );
  }
}
