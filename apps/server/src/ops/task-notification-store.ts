import { randomUUID } from "node:crypto";
import type { Row, Transaction } from "@libsql/client";
import { evaluate, recordDecision } from "../auth/service.js";
import { authorizeRun } from "../conversation/store.js";
import { DomainDatabase, optionalString, stringColumn } from "../persistence/database.js";
import {
  conversationScopeKey,
  scopeKey,
  validateScope,
  type CallerContext,
  type TrustedChannelScope,
} from "../identity/scope.js";
import { reconstructTaskOriginScope } from "./long-work-authority.js";

export type TaskNotificationStatus =
  | "pending"
  | "sending"
  | "sent"
  | "failed"
  | "unknown"
  | "suppressed";
export type TaskNotificationEventType =
  | "STEP_BLOCKED"
  | "STEP_REVIEW"
  | "STEP_FAILED"
  | "TASK_BLOCKED"
  | "TASK_REVIEW"
  | "TASK_ACCEPTED"
  | "WORKER_LOST";

export interface TaskNotificationRecord {
  id: string;
  taskId: string;
  eventSequence: number;
  eventType: TaskNotificationEventType;
  runId: string;
  conversationId: string;
  principalId: string;
  destination: TrustedChannelScope;
  destinationScopeKey: string;
  payloadText: string;
  payloadKind: "text";
  status: TaskNotificationStatus;
  externalId: string | null;
}

export interface TaskNotificationLease {
  notification: TaskNotificationRecord;
  settle(status: "sent" | "failed" | "unknown", externalId?: string): Promise<void>;
}

const notificationText: Record<
  TaskNotificationEventType,
  (taskId: string, stepId: string | null) => string
> = {
  STEP_BLOCKED: (taskId, stepId) => `任务 ${taskId} 的步骤 ${stepId ?? ""} 已阻塞。`,
  STEP_REVIEW: (taskId, stepId) => `任务 ${taskId} 的步骤 ${stepId ?? ""} 等待审核。`,
  STEP_FAILED: (taskId, stepId) => `任务 ${taskId} 的步骤 ${stepId ?? ""} 已失败。`,
  TASK_BLOCKED: (taskId) => `任务 ${taskId} 已阻塞。`,
  TASK_REVIEW: (taskId) => `任务 ${taskId} 等待审核。`,
  TASK_ACCEPTED: (taskId) => `任务 ${taskId} 已验收。`,
  WORKER_LOST: (taskId, stepId) => `任务 ${taskId} 的步骤 ${stepId ?? ""} 未能确认 Worker 状态。`,
};

const eventTypes = Object.keys(notificationText) as TaskNotificationEventType[];

function parseStoredScope(value: string): TrustedChannelScope {
  const parsed: unknown = JSON.parse(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("Invalid persisted notification destination");
  const raw = parsed as Record<string, unknown>;
  const scope: TrustedChannelScope = {
    connectionId: raw.connectionId as string,
    botId: raw.botId as string,
    chatType: raw.chatType as TrustedChannelScope["chatType"],
    chatId: raw.chatId as string,
    senderId: raw.senderId as string,
    ...(raw.threadId === undefined ? {} : { threadId: raw.threadId as string }),
  };
  validateScope(scope);
  return scope;
}

function notificationRecord(row: Row): TaskNotificationRecord {
  const destination = parseStoredScope(stringColumn(row, "destination_scope_json"));
  const destinationScopeKey = stringColumn(row, "destination_scope_key");
  if (scopeKey(destination) !== destinationScopeKey)
    throw new Error("Invalid persisted notification destination");
  return {
    id: stringColumn(row, "id"),
    taskId: stringColumn(row, "task_id"),
    eventSequence: Number(row.event_sequence),
    eventType: stringColumn(row, "event_type") as TaskNotificationEventType,
    runId: stringColumn(row, "origin_run_id"),
    conversationId: stringColumn(row, "conversation_id"),
    principalId: stringColumn(row, "principal_id"),
    destination,
    destinationScopeKey,
    payloadText: stringColumn(row, "payload_text"),
    payloadKind: "text",
    status: stringColumn(row, "status") as TaskNotificationStatus,
    externalId: optionalString(row, "external_id"),
  };
}

/** Durable Task notification intent. Transport and delivery happen elsewhere. */
export class TaskNotificationStore {
  constructor(private readonly db: DomainDatabase) {}

  /** Called inside the transaction that appends the corresponding Task event. */
  async enqueueTx(tx: Transaction, eventSequence: number): Promise<TaskNotificationRecord | null> {
    if (!Number.isSafeInteger(eventSequence) || eventSequence <= 0)
      throw new Error("Invalid Task event sequence");
    const eventResult = await tx.execute({
      sql: `SELECT e.sequence,e.task_id,e.step_id,e.type,t.creator_principal_id,t.conversation_id,
                   t.run_id,t.origin_scope_key,t.origin_scope_json,r.principal_id AS run_principal_id,
                   r.conversation_id AS run_conversation_id,r.source AS run_source,r.scope_json AS run_scope_json
            FROM task_events e JOIN tasks t ON t.id = e.task_id
            LEFT JOIN runs r ON r.id = t.run_id WHERE e.sequence = ?`,
      args: [eventSequence],
    });
    const row = eventResult.rows[0];
    if (!row) throw new Error("Task event not found");
    const eventType = stringColumn(row, "type");
    if (!eventTypes.includes(eventType as TaskNotificationEventType)) return null;

    const taskId = stringColumn(row, "task_id");
    const principalId = stringColumn(row, "creator_principal_id");
    const conversationId = optionalString(row, "conversation_id");
    const runId = optionalString(row, "run_id");
    const originScopeKey = optionalString(row, "origin_scope_key");
    const originScopeJson = optionalString(row, "origin_scope_json");
    if (!conversationId || !runId || !originScopeKey || !originScopeJson || !row.run_scope_json)
      return null;
    if (
      row.run_source !== "external" ||
      row.run_principal_id !== principalId ||
      row.run_conversation_id !== conversationId
    )
      return null;

    let taskScope: TrustedChannelScope;
    let runScope: TrustedChannelScope;
    try {
      taskScope = reconstructTaskOriginScope(originScopeKey, originScopeJson);
      runScope = parseStoredScope(stringColumn(row, "run_scope_json"));
    } catch {
      // Invalid historical routing data cannot authorize a notification. Keep the
      // Task event durable even when its optional notification cannot be sent.
      return null;
    }
    if (
      scopeKey(taskScope) !== originScopeKey ||
      scopeKey(runScope) !== originScopeKey ||
      conversationScopeKey(runScope) !== conversationScopeKey(taskScope)
    )
      return null;

    const stepId = optionalString(row, "step_id");
    const payloadText = notificationText[eventType as TaskNotificationEventType](taskId, stepId);
    const now = new Date().toISOString();
    await tx.execute({
      sql: `INSERT INTO task_notifications(
              id,event_sequence,task_id,origin_run_id,conversation_id,principal_id,
              destination_scope_key,destination_scope_json,event_type,payload_text,payload_kind,
              status,created_at,updated_at
            ) VALUES (?,?,?,?,?,?,?,?,?,?,'text','pending',?,?) ON CONFLICT(event_sequence) DO NOTHING`,
      args: [
        randomUUID(),
        eventSequence,
        taskId,
        runId,
        conversationId,
        principalId,
        originScopeKey,
        JSON.stringify(taskScope),
        eventType,
        payloadText,
        now,
        now,
      ],
    });
    const notification = await tx.execute({
      sql: "SELECT * FROM task_notifications WHERE event_sequence = ?",
      args: [eventSequence],
    });
    const record = notificationRecord(notification.rows[0]!);
    if (
      record.taskId !== taskId ||
      record.runId !== runId ||
      record.conversationId !== conversationId ||
      record.principalId !== principalId ||
      record.eventType !== eventType ||
      record.payloadText !== payloadText ||
      record.destinationScopeKey !== originScopeKey
    )
      throw new Error("Task notification event is already bound to different immutable data");
    return record;
  }

  /** Internal scheduler read. It returns only fixed payload and persisted recipient metadata. */
  async listUndelivered(limit = 50): Promise<TaskNotificationRecord[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500)
      throw new Error("Invalid Task notification page size");
    return this.db.transaction(async (tx) => {
      const rows = await tx.execute({
        sql: "SELECT * FROM task_notifications WHERE status = 'pending' ORDER BY event_sequence LIMIT ?",
        args: [limit],
      });
      return rows.rows.map(notificationRecord);
    });
  }

  /** Reauthorize both Task visibility and external Run delivery before reserving send. */
  async claim(
    caller: CallerContext,
    notificationId: string,
  ): Promise<TaskNotificationLease | null> {
    const claimed = await this.db.transaction(async (tx) => {
      const found = await tx.execute({
        sql: "SELECT * FROM task_notifications WHERE id = ? AND status = 'pending'",
        args: [notificationId],
      });
      if (!found.rows[0]) return null;
      const notification = notificationRecord(found.rows[0]);
      const task = await tx.execute({
        sql: `SELECT t.creator_principal_id,t.conversation_id,t.run_id,t.origin_scope_key,t.origin_scope_json,t.status AS task_status,
                     r.principal_id AS run_principal_id,r.conversation_id AS run_conversation_id,
                     r.source AS run_source,r.scope_json AS run_scope_json,e.step_id,
                     s.status AS step_status
              FROM tasks t LEFT JOIN runs r ON r.id = t.run_id
              LEFT JOIN task_events e ON e.sequence = ?
              LEFT JOIN task_steps s ON s.id = e.step_id AND s.task_id = t.id
              WHERE t.id = ?`,
        args: [notification.eventSequence, notification.taskId],
      });
      const row = task.rows[0];
      const identityMatches =
        caller.principalId === notification.principalId &&
        scopeKey(caller.scope) === notification.destinationScopeKey;
      let originMatches = false;
      try {
        if (row) {
          const storedRunScope =
            typeof row.run_scope_json === "string" ? parseStoredScope(row.run_scope_json) : null;
          originMatches =
            row.creator_principal_id === notification.principalId &&
            row.conversation_id === notification.conversationId &&
            row.run_id === notification.runId &&
            row.run_principal_id === notification.principalId &&
            row.run_conversation_id === notification.conversationId &&
            row.run_source === "external" &&
            row.origin_scope_key === notification.destinationScopeKey &&
            typeof row.origin_scope_json === "string" &&
            scopeKey(
              reconstructTaskOriginScope(
                stringColumn(row, "origin_scope_key"),
                stringColumn(row, "origin_scope_json"),
              ),
            ) === notification.destinationScopeKey &&
            storedRunScope !== null &&
            scopeKey(storedRunScope) === notification.destinationScopeKey;
        }
      } catch {
        originMatches = false;
      }
      let eventStillCurrent = false;
      if (row) {
        switch (notification.eventType) {
          case "TASK_REVIEW":
            eventStillCurrent = row.task_status === "REVIEW";
            break;
          case "TASK_ACCEPTED":
            eventStillCurrent = row.task_status === "DONE";
            break;
          case "TASK_BLOCKED":
            eventStillCurrent = row.task_status === "WAITING_INPUT";
            break;
          case "STEP_REVIEW":
            eventStillCurrent = row.step_status === "review";
            break;
          case "STEP_BLOCKED":
            eventStillCurrent = row.step_status === "blocked";
            break;
          case "STEP_FAILED":
            eventStillCurrent = row.step_status === "failed";
            break;
          case "WORKER_LOST":
            eventStillCurrent = true;
            break;
        }
        if (eventStillCurrent) {
          const eventRow = await tx.execute({
            sql: "SELECT step_id FROM task_events WHERE sequence = ? AND task_id = ?",
            args: [notification.eventSequence, notification.taskId],
          });
          const eventStepId = eventRow.rows[0] ? optionalString(eventRow.rows[0], "step_id") : null;
          const taskStateNotice = notification.eventType.startsWith("TASK_");
          const laterStateEvents = await tx.execute({
            sql: `SELECT 1 FROM task_events WHERE task_id = ? AND sequence > ? AND (
                    (? = 1 AND type IN ('TASK_REVIEW','TASK_BLOCKED','TASK_REWORK','TASK_ACCEPTED','TASK_CANCELLED','TASK_CONTINUED')) OR
                    (? = 0 AND step_id = ? AND type IN ('STEP_READY','STEP_STARTED','STEP_WAITING','STEP_BLOCKED','STEP_REVIEW','STEP_SUCCEEDED','STEP_FAILED','STEP_CANCELLED','STEP_SKIPPED','RETRY_SCHEDULED','TASK_REWORK','WORKER_BOUND','WORKER_RECOVERED'))
                  ) LIMIT 1`,
            args: [
              notification.taskId,
              notification.eventSequence,
              taskStateNotice ? 1 : 0,
              taskStateNotice ? 1 : 0,
              eventStepId,
            ],
          });
          eventStillCurrent = laterStateEvents.rows.length === 0;
        }
      }

      const taskRead = await evaluate(tx, {
        caller,
        resourceId: `task-${notification.taskId}`,
        action: "task:read",
        conversationId: notification.conversationId,
        runId: notification.runId,
      });
      const runDelivery = await authorizeRun(tx, caller, notification.runId, "delivery:send");
      const authorized =
        identityMatches &&
        originMatches &&
        taskRead.decision === "ALLOW" &&
        !("denied" in runDelivery);
      if (!authorized || !eventStillCurrent) {
        if (!originMatches || !identityMatches || !row) {
          await recordDecision(
            tx,
            {
              caller,
              resourceId: `task-${notification.taskId}`,
              action: "task:read",
              conversationId: notification.conversationId,
              runId: notification.runId,
            },
            "DENY",
            "scope_mismatch",
          );
          await recordDecision(
            tx,
            {
              caller,
              resourceId: "run",
              action: "delivery:send",
              conversationId: notification.conversationId,
              runId: notification.runId,
            },
            "DENY",
            "scope_mismatch",
          );
        }
        await tx.execute({
          sql: "UPDATE task_notifications SET status = 'suppressed', updated_at = ? WHERE id = ? AND status = 'pending'",
          args: [new Date().toISOString(), notification.id],
        });
        return null;
      }

      const updated = await tx.execute({
        sql: "UPDATE task_notifications SET status = 'sending', updated_at = ? WHERE id = ? AND status = 'pending'",
        args: [new Date().toISOString(), notification.id],
      });
      if (updated.rowsAffected !== 1) return null;
      return { ...notification, status: "sending" as const };
    });

    if (!claimed) return null;
    let active = true;
    return {
      notification: claimed,
      settle: async (status, externalId) => {
        if (!active) throw new Error("Task notification lease already settled");
        if (!["sent", "failed", "unknown"].includes(status))
          throw new Error("Invalid Task notification outcome");
        if (
          externalId !== undefined &&
          (typeof externalId !== "string" || !externalId || externalId.length > 512)
        )
          throw new Error("Invalid external notification ID");
        active = false;
        try {
          await this.db.transaction(async (tx) => {
            const result = await tx.execute({
              sql: "UPDATE task_notifications SET status = ?, external_id = ?, updated_at = ? WHERE id = ? AND status = 'sending'",
              args: [status, externalId ?? null, new Date().toISOString(), claimed.id],
            });
            if (result.rowsAffected !== 1) throw new Error("Task notification state changed");
          });
        } catch (error) {
          active = true;
          throw error;
        }
      },
    };
  }

  /** Startup recovery never retries an unconfirmed external send. */
  async recover(): Promise<string[]> {
    return this.db.transaction(async (tx) => {
      const sending = await tx.execute(
        "SELECT id FROM task_notifications WHERE status = 'sending'",
      );
      await tx.execute({
        sql: "UPDATE task_notifications SET status = 'unknown', updated_at = ? WHERE status = 'sending'",
        args: [new Date().toISOString()],
      });
      return sending.rows.map((row) => stringColumn(row, "id"));
    });
  }
}
