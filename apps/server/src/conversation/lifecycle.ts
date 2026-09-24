import { randomUUID } from "node:crypto";
import type { Row, Transaction } from "@libsql/client";
import { authorizedValue, evaluate, type AuthorizedResult } from "../auth/service.js";
import {
  requireIdentifier,
  validateScope,
  scopeKey,
  type CallerContext,
  type TrustedChannelScope,
} from "../identity/scope.js";
import { DomainDatabase, optionalString, stringColumn } from "../persistence/database.js";
import {
  authorizeRun,
  makePage,
  pageParameters,
  runRecord,
  type Page,
  type PageOptions,
  type RunRecord,
  type RunStatus,
} from "./store.js";

export type DeliveryStatus = "pending" | "sending" | "sent" | "failed" | "unknown";
export interface DeliveryRecord {
  id: string;
  runId: string;
  dedupKey: string;
  destinationScopeKey: string;
  payloadText: string;
  payloadKind: "text" | "result" | "ack" | "browser_artifact";
  status: DeliveryStatus;
  externalId: string | null;
}
export interface RunRoute {
  runId: string;
  conversationId: string;
  sequence: number;
  caller: CallerContext;
}
export type TerminalRunStatus = Exclude<RunStatus, "queued" | "running" | "cancelling">;
export interface RunLease {
  run: RunRecord;
  settle(
    status: TerminalRunStatus,
    text?: string,
  ): Promise<{ run: RunRecord; outputWithheld: boolean }>;
}
export interface DeliveryLease {
  delivery: DeliveryRecord;
  settle(status: "sent" | "failed" | "unknown", externalId?: string): Promise<void>;
}

function deliveryRecord(row: Row, runId: string): DeliveryRecord {
  return {
    id: stringColumn(row, "id"),
    runId,
    dedupKey: stringColumn(row, "dedup_key"),
    destinationScopeKey: stringColumn(row, "destination_scope_key"),
    payloadText: stringColumn(row, "payload_text"),
    payloadKind: stringColumn(row, "payload_kind") as DeliveryRecord["payloadKind"],
    status: stringColumn(row, "status") as DeliveryStatus,
    externalId: optionalString(row, "external_id"),
  };
}

function storedScope(row: Row): TrustedChannelScope {
  const value: unknown = JSON.parse(stringColumn(row, "scope_json"));
  if (
    typeof value !== "object" ||
    value === null ||
    !("connectionId" in value) ||
    !("botId" in value) ||
    !("chatType" in value) ||
    !("chatId" in value) ||
    !("senderId" in value)
  )
    throw new Error("Invalid persisted scope");
  if (
    typeof value.connectionId !== "string" ||
    typeof value.botId !== "string" ||
    typeof value.chatId !== "string" ||
    typeof value.senderId !== "string" ||
    (value.chatType !== "group" && value.chatType !== "private")
  )
    throw new Error("Invalid persisted scope");
  const scope: TrustedChannelScope = {
    connectionId: value.connectionId,
    botId: value.botId,
    chatType: value.chatType,
    chatId: value.chatId,
    senderId: value.senderId,
  };
  if ("threadId" in value) {
    requireIdentifier(value.threadId);
    scope.threadId = value.threadId;
  }
  if ("nativeGroupRole" in value) {
    const observed = value.nativeGroupRole;
    if (
      typeof observed !== "object" ||
      observed === null ||
      !("role" in observed) ||
      !("source" in observed) ||
      !("observedAt" in observed)
    )
      throw new Error("Invalid persisted scope");
    scope.nativeGroupRole = {
      role: observed.role as NonNullable<TrustedChannelScope["nativeGroupRole"]>["role"],
      source: observed.source as NonNullable<TrustedChannelScope["nativeGroupRole"]>["source"],
      observedAt: observed.observedAt as string,
    };
  }
  scopeKey(scope);
  return scope;
}
const transitions: Record<RunStatus, readonly RunStatus[]> = {
  queued: ["running", "cancelled"],
  running: ["cancelling", "succeeded", "failed", "interrupted", "unknown"],
  cancelling: ["cancelled", "succeeded", "failed", "interrupted", "unknown"],
  cancelled: [],
  succeeded: [],
  failed: [],
  interrupted: [],
  unknown: [],
};
const deliveryTransitions: Record<DeliveryStatus, readonly DeliveryStatus[]> = {
  pending: ["sending"],
  sending: ["sent", "failed", "unknown"],
  sent: [],
  failed: ["pending"],
  unknown: [],
};

export class LifecycleStore {
  constructor(private readonly db: DomainDatabase) {}

  private async authorizeDeliverySources(
    tx: Transaction,
    caller: CallerContext,
    runId: string,
  ): Promise<AuthorizedResult<null>> {
    // Authorization evidence conservatively records every protected read admitted
    // to this Run. Model text cannot remove a dependency from this set.
    const sources = await tx.execute({
      sql: `SELECT DISTINCT resource_id, action FROM authorization_decisions WHERE run_id = ? AND principal_id = ?
        AND decision = 'ALLOW' AND action IN ('read', 'context:read', 'history:read', 'worker:read', 'worker:status', 'worker:file:read', 'task:read')`,
      args: [runId, caller.principalId],
    });
    // Every delivery decision is evidence about one Run in one Conversation, so the delivery
    // recheck names both. A denial then explains which Run tried to send which Resource's
    // derived content, without copying the payload it was carrying.
    const runs = await tx.execute({
      sql: "SELECT conversation_id FROM runs WHERE id = ? AND principal_id = ?",
      args: [runId, caller.principalId],
    });
    const conversationId = runs.rows[0] ? stringColumn(runs.rows[0], "conversation_id") : undefined;
    for (const source of sources.rows) {
      for (const action of [stringColumn(source, "action"), "delivery:send"]) {
        const decision = await evaluate(tx, {
          caller,
          runId,
          ...(conversationId === undefined ? {} : { conversationId }),
          resourceId: stringColumn(source, "resource_id"),
          action,
        });
        if (decision.decision !== "ALLOW") return { denied: decision };
      }
    }
    return { value: null };
  }

  /** Internal runtime evidence routing, constrained to the persisted Run actor. */
  async traceCaller(runId: string, principalId?: string): Promise<CallerContext> {
    return authorizedValue(
      await this.db.transaction<AuthorizedResult<CallerContext>>(async (tx) => {
        const rows = await tx.execute({
          sql: "SELECT scope_json, principal_id FROM runs WHERE id = ? AND (? IS NULL OR principal_id = ?)",
          args: [runId, principalId ?? null, principalId ?? null],
        });
        if (!rows.rows[0]) throw new Error("Runtime trace actor mismatch");
        const scope = JSON.parse(stringColumn(rows.rows[0], "scope_json")) as TrustedChannelScope;
        validateScope(scope);
        const caller = { principalId: stringColumn(rows.rows[0], "principal_id"), scope };
        const authorization = await authorizeRun(tx, caller, runId, "trace:write");
        return "denied" in authorization ? authorization : { value: caller };
      }),
    );
  }

  /** Supervisor-only queue metadata. No message, result or provider state is read.
   * Use a single server owner; this method is not a channel-facing query API. */
  async listRunRoutes(statuses: readonly RunStatus[], afterSequence = 0): Promise<RunRoute[]> {
    if (
      statuses.length === 0 ||
      statuses.some((status) => !Object.hasOwn(transitions, status)) ||
      !Number.isSafeInteger(afterSequence) ||
      afterSequence < 0
    )
      throw new Error("Invalid queue query");
    return this.db.transaction(async (tx) => {
      const rows = await tx.execute({
        sql: `SELECT runs.id, runs.conversation_id, runs.sequence, runs.principal_id, runs.scope_json FROM runs WHERE runs.status IN (${statuses.map(() => "?").join(",")}) AND runs.sequence > ? ORDER BY runs.sequence LIMIT 100`,
        args: [...statuses, afterSequence],
      });
      return rows.rows.map((row) => {
        const sequence = Number(row.sequence);
        if (!Number.isSafeInteger(sequence)) throw new Error("Invalid persisted sequence");
        return {
          runId: stringColumn(row, "id"),
          conversationId: stringColumn(row, "conversation_id"),
          sequence,
          caller: { principalId: stringColumn(row, "principal_id"), scope: storedScope(row) },
        };
      });
    });
  }

  /** The unforgeable in-process closure records terminal facts only. It neither
   * loads context nor grants permission to execute Tools or publish results. */
  async claimQueuedRun(caller: CallerContext, runId: string): Promise<RunLease> {
    const run = await this.transitionRun(caller, runId, "queued", "running");
    let active = true;
    return {
      run,
      settle: async (status, text) => {
        if (!active) throw new Error("Run lease already settled");
        if (
          !["succeeded", "failed", "cancelled", "interrupted", "unknown"].includes(status) ||
          (text !== undefined && (typeof text !== "string" || text.length > 64_000))
        )
          throw new Error("Invalid execution outcome");
        active = false;
        try {
          return await this.db.transaction(async (tx) => {
            const rows = await tx.execute({
              sql: "SELECT status FROM runs WHERE id = ?",
              args: [runId],
            });
            const current = rows.rows[0] && stringColumn(rows.rows[0], "status");
            if (current !== "running" && current !== "cancelling")
              throw new Error("Run state changed");
            if (status === "cancelled" && current !== "cancelling")
              throw new Error("Cancellation was not requested");
            let outputWithheld = false;
            for (const action of ["conversation:read", "run:create", "run:control"]) {
              if ("denied" in (await authorizeRun(tx, caller, runId, action)))
                outputWithheld = true;
            }
            const updated = await tx.execute({
              sql: "UPDATE runs SET status = ?, result_text = ?, updated_at = ? WHERE id = ? AND status IN ('running','cancelling')",
              args: [
                status,
                outputWithheld ? null : (text ?? null),
                new Date().toISOString(),
                runId,
              ],
            });
            if (updated.rowsAffected !== 1) throw new Error("Run state changed");
            const finished = await tx.execute({
              sql: "SELECT * FROM runs WHERE id = ?",
              args: [runId],
            });
            return { run: runRecord(finished.rows[0]!), outputWithheld };
          });
        } catch (error) {
          active = true;
          throw error;
        }
      },
    };
  }

  /** Authorize and reserve the immutable payload before transport invocation.
   * The returned closure can only record that particular send's outcome. */
  async claimDelivery(
    caller: CallerContext,
    runId: string,
    deliveryId: string,
  ): Promise<DeliveryLease | null> {
    const delivery = authorizedValue(
      await this.db.transaction<AuthorizedResult<DeliveryRecord | null>>(async (tx) => {
        for (const action of ["conversation:read", "run:create", "run:control", "delivery:send"]) {
          const decision = await authorizeRun(tx, caller, runId, action);
          if ("denied" in decision) return decision;
        }
        const sources = await this.authorizeDeliverySources(tx, caller, runId);
        if ("denied" in sources) return sources;
        const changed = await tx.execute({
          sql: "UPDATE deliveries SET status = 'sending', updated_at = ? WHERE id = ? AND run_id = ? AND destination_scope_key = ? AND status = 'pending'",
          args: [new Date().toISOString(), deliveryId, runId, scopeKey(caller.scope)],
        });
        if (changed.rowsAffected !== 1) return { value: null };
        const rows = await tx.execute({
          sql: "SELECT * FROM deliveries WHERE id = ?",
          args: [deliveryId],
        });
        return { value: deliveryRecord(rows.rows[0]!, runId) };
      }),
    );
    if (!delivery) return null;
    let active = true;
    return {
      delivery,
      settle: async (status, externalId) => {
        if (!active) throw new Error("Delivery lease already settled");
        if (!["sent", "failed", "unknown"].includes(status))
          throw new Error("Invalid delivery outcome");
        if (externalId !== undefined) requireIdentifier(externalId);
        active = false;
        try {
          await this.db.transaction(async (tx) => {
            const result = await tx.execute({
              sql: "UPDATE deliveries SET status = ?, external_id = ?, updated_at = ? WHERE id = ? AND run_id = ? AND status = 'sending'",
              args: [status, externalId ?? null, new Date().toISOString(), deliveryId, runId],
            });
            if (result.rowsAffected !== 1) throw new Error("Delivery state changed");
          });
        } catch (error) {
          active = true;
          throw error;
        }
      },
    };
  }

  /** State changes describe confirmed execution facts. Enter running immediately
   * before dispatch; enter cancelled only after the executor confirms stopping. */
  async transitionRun(
    caller: CallerContext,
    runId: string,
    expected: RunStatus,
    next: RunStatus,
    resultText?: string,
  ): Promise<RunRecord> {
    if (!transitions[expected]?.includes(next)) throw new Error("Invalid Run transition");
    if (resultText !== undefined && (typeof resultText !== "string" || resultText.length > 64_000))
      throw new Error("Run result exceeds the accepted text limit");
    return authorizedValue(
      await this.db.transaction<AuthorizedResult<RunRecord>>(async (tx) => {
        const authorization = await authorizeRun(
          tx,
          caller,
          runId,
          next === "running" ? "run:create" : "run:control",
        );
        if ("denied" in authorization) return authorization;
        if (next === "running") {
          const active = await tx.execute({
            sql: "SELECT id FROM runs WHERE conversation_id = ? AND status IN ('running','cancelling') LIMIT 1",
            args: [authorization.value.conversationId],
          });
          if (active.rows.length) throw new Error("Conversation already has an active Run");
          const first = await tx.execute({
            sql: "SELECT id FROM runs WHERE conversation_id = ? AND status = 'queued' ORDER BY sequence LIMIT 1",
            args: [authorization.value.conversationId],
          });
          if (!first.rows[0] || stringColumn(first.rows[0], "id") !== runId)
            throw new Error("An earlier Run is queued");
        }
        const updated = await tx.execute({
          sql: "UPDATE runs SET status = ?, result_text = COALESCE(?, result_text), updated_at = ? WHERE id = ? AND status = ?",
          args: [next, resultText ?? null, new Date().toISOString(), runId, expected],
        });
        if (updated.rowsAffected !== 1) throw new Error("Run state changed");
        const rows = await tx.execute({ sql: "SELECT * FROM runs WHERE id = ?", args: [runId] });
        return { value: runRecord(rows.rows[0]!) };
      }),
    );
  }

  /** Startup-only recovery. It never reruns a tool or reports an unconfirmed send
   * as successful. Callers append these facts to raw trace after this transaction. */
  async recover(): Promise<{
    interruptedRunIds: string[];
    unknownRunIds: string[];
    unknownDeliveryIds: string[];
  }> {
    return this.db.transaction(async (tx) => {
      const running = await tx.execute("SELECT id FROM runs WHERE status = 'running'");
      const cancelling = await tx.execute("SELECT id FROM runs WHERE status = 'cancelling'");
      const sending = await tx.execute("SELECT id FROM deliveries WHERE status = 'sending'");
      const now = new Date().toISOString();
      await tx.batch([
        {
          sql: "UPDATE runs SET status = 'interrupted', updated_at = ? WHERE status = 'running'",
          args: [now],
        },
        {
          sql: "UPDATE runs SET status = 'unknown', updated_at = ? WHERE status = 'cancelling'",
          args: [now],
        },
        {
          sql: "UPDATE deliveries SET status = 'unknown', updated_at = ? WHERE status = 'sending'",
          args: [now],
        },
      ]);
      return {
        interruptedRunIds: running.rows.map((row) => stringColumn(row, "id")),
        unknownRunIds: cancelling.rows.map((row) => stringColumn(row, "id")),
        unknownDeliveryIds: sending.rows.map((row) => stringColumn(row, "id")),
      };
    });
  }

  async createDelivery(
    caller: CallerContext,
    input: {
      runId: string;
      dedupKey: string;
      destination: TrustedChannelScope;
      payloadText: string;
      payloadKind: DeliveryRecord["payloadKind"];
    },
  ): Promise<string> {
    requireIdentifier(input.dedupKey);
    if (
      typeof input.payloadText !== "string" ||
      input.payloadText.length > 64_000 ||
      !["text", "result", "ack", "browser_artifact"].includes(input.payloadKind) ||
      (input.payloadKind === "browser_artifact" &&
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
          input.payloadText,
        ))
    )
      throw new Error("Invalid delivery payload");
    const destination = scopeKey(input.destination);
    if (destination !== scopeKey(caller.scope))
      throw new Error("Delivery must use the authorized ingress destination");
    return authorizedValue(
      await this.db.transaction<AuthorizedResult<string>>(async (tx) => {
        const decision = await authorizeRun(tx, caller, input.runId, "run:control");
        if ("denied" in decision) return decision;
        const deliveryDecision = await authorizeRun(tx, caller, input.runId, "delivery:send");
        if ("denied" in deliveryDecision) return deliveryDecision;
        const sources = await this.authorizeDeliverySources(tx, caller, input.runId);
        if ("denied" in sources) return sources;
        const id = randomUUID();
        const now = new Date().toISOString();
        await tx.execute({
          sql: "INSERT INTO deliveries(id, run_id, dedup_key, destination_scope_key, payload_text, payload_kind, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?) ON CONFLICT(run_id, dedup_key) DO NOTHING",
          args: [
            id,
            input.runId,
            input.dedupKey,
            destination,
            input.payloadText,
            input.payloadKind,
            now,
            now,
          ],
        });
        const rows = await tx.execute({
          sql: "SELECT id, payload_text, payload_kind FROM deliveries WHERE run_id = ? AND dedup_key = ?",
          args: [input.runId, input.dedupKey],
        });
        if (
          stringColumn(rows.rows[0]!, "payload_text") !== input.payloadText ||
          stringColumn(rows.rows[0]!, "payload_kind") !== input.payloadKind
        )
          throw new Error("A delivery payload is immutable");
        return { value: stringColumn(rows.rows[0]!, "id") };
      }),
    );
  }

  /** Commit sending before calling transport. Failed may be explicitly retried;
   * sent and unknown never transition back into an automatic send path. */
  async transitionDelivery(
    caller: CallerContext,
    runId: string,
    deliveryId: string,
    expected: DeliveryStatus,
    next: DeliveryStatus,
    externalId?: string,
  ): Promise<void> {
    if (!deliveryTransitions[expected]?.includes(next))
      throw new Error("Invalid delivery transition");
    if (externalId !== undefined) requireIdentifier(externalId);
    authorizedValue(
      await this.db.transaction<AuthorizedResult<void>>(async (tx) => {
        const decision = await authorizeRun(tx, caller, runId, "run:control");
        if ("denied" in decision) return decision;
        const deliveryDecision = await authorizeRun(tx, caller, runId, "delivery:send");
        if ("denied" in deliveryDecision) return deliveryDecision;
        const sources = await this.authorizeDeliverySources(tx, caller, runId);
        if ("denied" in sources) return sources;
        const result = await tx.execute({
          sql: "UPDATE deliveries SET status = ?, external_id = COALESCE(?, external_id), updated_at = ? WHERE id = ? AND run_id = ? AND destination_scope_key = ? AND status = ?",
          args: [
            next,
            externalId ?? null,
            new Date().toISOString(),
            deliveryId,
            runId,
            scopeKey(caller.scope),
            expected,
          ],
        });
        if (result.rowsAffected !== 1) throw new Error("Delivery state changed");
        return { value: undefined };
      }),
    );
  }

  async listDeliveries(
    caller: CallerContext,
    runId: string,
    options: PageOptions = {},
  ): Promise<Page<DeliveryRecord>> {
    const page = pageParameters(options);
    return authorizedValue(
      await this.db.transaction<AuthorizedResult<Page<DeliveryRecord>>>(async (tx) => {
        const decision = await authorizeRun(tx, caller, runId, "conversation:read");
        if ("denied" in decision) return decision;
        const rows = await tx.execute({
          sql: "SELECT * FROM deliveries WHERE run_id = ? AND (created_at, id) > (?, ?) ORDER BY created_at, id LIMIT ?",
          args: [runId, page.afterTime, page.afterId, page.limit + 1],
        });
        return {
          value: makePage(rows.rows, page.limit, (row) => ({
            id: stringColumn(row, "id"),
            runId,
            dedupKey: stringColumn(row, "dedup_key"),
            destinationScopeKey: stringColumn(row, "destination_scope_key"),
            payloadText: stringColumn(row, "payload_text"),
            payloadKind: stringColumn(row, "payload_kind") as DeliveryRecord["payloadKind"],
            status: stringColumn(row, "status") as DeliveryStatus,
            externalId: optionalString(row, "external_id"),
          })),
        };
      }),
    );
  }

  async findDelivery(
    caller: CallerContext,
    runId: string,
    dedupKey: string,
  ): Promise<DeliveryRecord | null> {
    requireIdentifier(dedupKey);
    return authorizedValue(
      await this.db.transaction<AuthorizedResult<DeliveryRecord | null>>(async (tx) => {
        const authorization = await authorizeRun(tx, caller, runId, "conversation:read");
        if ("denied" in authorization) return authorization;
        const rows = await tx.execute({
          sql: "SELECT * FROM deliveries WHERE run_id = ? AND dedup_key = ?",
          args: [runId, dedupKey],
        });
        return { value: rows.rows[0] ? deliveryRecord(rows.rows[0], runId) : null };
      }),
    );
  }
}
