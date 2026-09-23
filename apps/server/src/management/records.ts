import { randomUUID } from "node:crypto";
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
 * Group audit routing metadata is bounded by the configured connection, Bot, group, and
 * current Owner grant before the application loads Trace evidence. */
export class OwnerManagementRecords {
  constructor(private readonly db: DomainDatabase) {}

  /**
   * Finds the newest Owner or Visitor Run in an exact configured group, whether
   * or not it contains a QQ-native role observation.
   * The caller must authorize the Owner against that configured group's `group:manage`
   * Resource before reading its Raw Trace. This returns routing metadata only.
   */
  async latestManagedGroupRuns(
    ownerId: string,
    input: { connectionId: string; botId: string; groupId: string },
  ): Promise<Array<{ runId: string; createdAt: string; principalKind: "owner" | "visitor" }>> {
    return this.db.transaction(async (tx) => {
      const owner = await tx.execute({
        sql: "SELECT id FROM principals WHERE id = ? AND kind = 'owner'",
        args: [ownerId],
      });
      if (!owner.rows.length) return [];
      const latest: Array<{
        runId: string;
        createdAt: string;
        principalKind: "owner" | "visitor";
      }> = [];
      for (const principalKind of ["owner", "visitor"] as const) {
        const rows = await tx.execute({
          sql: `SELECT r.id, r.created_at, r.scope_json
            FROM runs r JOIN principals p ON p.id = r.principal_id
            WHERE p.kind = ?
              AND json_extract(r.scope_json, '$.connectionId') = ?
              AND json_extract(r.scope_json, '$.botId') = ?
              AND json_extract(r.scope_json, '$.chatType') = 'group'
              AND json_extract(r.scope_json, '$.chatId') = ?
            ORDER BY r.created_at DESC, r.id DESC LIMIT 20`,
          args: [principalKind, input.connectionId, input.botId, input.groupId],
        });
        for (const row of rows.rows) {
          try {
            const scope = JSON.parse(stringColumn(row, "scope_json")) as TrustedChannelScope;
            validateScope(scope);
            if (
              scope.chatType !== "group" ||
              scope.connectionId !== input.connectionId ||
              scope.botId !== input.botId ||
              scope.chatId !== input.groupId
            )
              continue;
            latest.push({
              runId: stringColumn(row, "id"),
              createdAt: stringColumn(row, "created_at"),
              principalKind,
            });
            break;
          } catch {
            // Invalid persisted scope is not eligible for a protected audit projection.
          }
        }
      }
      return latest;
    });
  }

  /** Local authenticated incident response only. This withdraws context reuse;
   * it neither reads protected content nor grants the Owner channel authority. */
  async excludeUnsafeRunContexts(ownerId: string, runIds: string[]): Promise<void> {
    await this.db.transaction(async (tx) => {
      const owner = await tx.execute({
        sql: "SELECT id FROM principals WHERE id = ? AND kind = 'owner'",
        args: [ownerId],
      });
      if (!owner.rows.length) throw new Error("Owner management authority required");
      for (const runId of new Set(runIds)) {
        await tx.execute({
          sql: `INSERT INTO ops_trace_events(event_id, ts, type, run_id, principal_id, data_json)
            SELECT ?, ?, 'context.excluded', id, ?, ? FROM runs WHERE id = ?
            AND NOT EXISTS (SELECT 1 FROM ops_trace_events WHERE run_id = ? AND type = 'context.excluded')`,
          args: [
            randomUUID(),
            new Date().toISOString(),
            ownerId,
            JSON.stringify({
              action: "Exclude Run Context",
              reason: "unsafe_runtime_context",
              origin: "local_management",
            }),
            runId,
            runId,
          ],
        });
      }
    });
  }

  async deliveryRunId(ownerId: string, deliveryId: string): Promise<string | null> {
    return this.db.transaction(async (tx) => {
      const rows = await tx.execute({
        sql: "SELECT d.run_id FROM deliveries d JOIN runs r ON r.id = d.run_id JOIN principals p ON p.id = r.principal_id WHERE d.id = ? AND p.id = ? AND p.kind = 'owner'",
        args: [deliveryId, ownerId],
      });
      return rows.rows[0] ? stringColumn(rows.rows[0], "run_id") : null;
    });
  }

  async runCaller(ownerId: string, runId: string): Promise<CallerContext | null> {
    return this.db.transaction(async (tx) => {
      const rows = await tx.execute({
        sql: "SELECT r.principal_id, r.scope_json FROM runs r JOIN principals p ON p.id = r.principal_id WHERE r.id = ? AND p.id = ? AND p.kind = 'owner'",
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
        sql: "SELECT r.id, r.created_at, r.principal_id, r.scope_json FROM runs r JOIN principals p ON p.id = r.principal_id WHERE p.id = ? AND p.kind = 'owner' AND (? IS NULL OR r.conversation_id = ?) AND (r.created_at, r.id) > (?, ?) ORDER BY r.created_at, r.id LIMIT ?",
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
