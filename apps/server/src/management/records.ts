import {
  authorizeConversation,
  authorizeRun,
  makePage,
  pageParameters,
  runRecord,
  type PageOptions,
} from "../conversation/store.js";
import { validateScope, type CallerContext, type TrustedChannelScope } from "../identity/scope.js";
import { DomainDatabase, stringColumn } from "../persistence/database.js";

function callerFromRow(row: { [key: string]: unknown }): CallerContext {
  const scope: unknown = JSON.parse(String(row.scope_json));
  validateScope(scope as TrustedChannelScope);
  if (typeof row.principal_id !== "string") throw new Error("Invalid Owner record");
  return { principalId: row.principal_id, scope: scope as TrustedChannelScope };
}

/** Only the authenticated local management controller receives this reader.
 * It selects Owner-owned routing metadata, then rechecks the exact stored scope
 * before loading contents. Channel message fields cannot choose this authority. */
export class OwnerManagementRecords {
  constructor(private readonly db: DomainDatabase) {}

  async deliveryRunId(ownerId: string, deliveryId: string): Promise<string | null> {
    return this.db.transaction(async (tx) => {
      const rows = await tx.execute({
        sql: "SELECT d.run_id FROM deliveries d JOIN runs r ON r.id = d.run_id JOIN conversations c ON c.id = r.conversation_id JOIN principals p ON p.id = c.principal_id WHERE d.id = ? AND p.id = ? AND p.kind = 'owner'",
        args: [deliveryId, ownerId],
      });
      return rows.rows[0] ? stringColumn(rows.rows[0], "run_id") : null;
    });
  }

  async runCaller(ownerId: string, runId: string): Promise<CallerContext | null> {
    return this.db.transaction(async (tx) => {
      const rows = await tx.execute({
        sql: "SELECT c.principal_id, c.scope_json FROM runs r JOIN conversations c ON c.id = r.conversation_id JOIN principals p ON p.id = c.principal_id WHERE r.id = ? AND p.id = ? AND p.kind = 'owner'",
        args: [runId, ownerId],
      });
      if (!rows.rows[0]) return null;
      const caller = callerFromRow(rows.rows[0]);
      const decision = await authorizeRun(tx, caller, runId, "conversation:read");
      return "denied" in decision ? null : caller;
    });
  }

  async listRuns(ownerId: string, options: PageOptions & { conversationId?: string } = {}) {
    const page = pageParameters(options);
    return this.db.transaction(async (tx) => {
      const rows = await tx.execute({
        sql: "SELECT r.id, r.created_at, c.principal_id, c.scope_json FROM runs r JOIN conversations c ON c.id = r.conversation_id JOIN principals p ON p.id = c.principal_id WHERE p.id = ? AND p.kind = 'owner' AND (? IS NULL OR c.id = ?) AND (r.created_at, r.id) > (?, ?) ORDER BY r.created_at, r.id LIMIT ?",
        args: [
          ownerId,
          options.conversationId ?? null,
          options.conversationId ?? null,
          page.afterTime,
          page.afterId,
          page.limit + 1,
        ],
      });
      const result = makePage(rows.rows, page.limit, (row) => row);
      const items = [];
      for (const entry of result.items) {
        const caller = callerFromRow(entry);
        const id = stringColumn(entry, "id");
        const decision = await authorizeRun(tx, caller, id, "conversation:read");
        if (!("denied" in decision)) {
          const run = await tx.execute({ sql: "SELECT * FROM runs WHERE id = ?", args: [id] });
          if (run.rows[0]) items.push({ ...runRecord(run.rows[0]), scope: caller.scope });
        }
      }
      return { items, nextCursor: result.nextCursor };
    });
  }

  async listConversations(ownerId: string, options: PageOptions = {}) {
    const page = pageParameters(options);
    return this.db.transaction(async (tx) => {
      // Query addressing metadata first. Message text is available only via the authorized domain API.
      const rows = await tx.execute({
        sql: "SELECT c.id, c.agent_id, c.principal_id, c.scope_json, c.created_at FROM conversations c JOIN principals p ON p.id = c.principal_id WHERE p.id = ? AND p.kind = 'owner' AND (c.created_at, c.id) > (?, ?) ORDER BY c.created_at, c.id LIMIT ?",
        args: [ownerId, page.afterTime, page.afterId, page.limit + 1],
      });
      const result = makePage(rows.rows, page.limit, (row) => row);
      const items = [];
      for (const row of result.items) {
        const caller = callerFromRow(row);
        const id = stringColumn(row, "id");
        const decision = await authorizeConversation(tx, caller, id, "conversation:read");
        if (!("denied" in decision))
          items.push({
            id,
            agentId: stringColumn(row, "agent_id"),
            principalId: caller.principalId,
            scope: caller.scope,
            createdAt: stringColumn(row, "created_at"),
          });
      }
      return { items, nextCursor: result.nextCursor };
    });
  }
}
