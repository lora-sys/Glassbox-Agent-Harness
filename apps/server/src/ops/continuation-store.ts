import { randomUUID } from "node:crypto";
import type { Row, Transaction } from "@libsql/client";
import type {
  DurableContinuationCadence,
  DurableContinuationEvent,
  DurableContinuationOccurrence,
  DurableContinuationOrigin,
  DurableContinuationSchedule,
  DurableContinuationTarget,
  PendingContinuationDelivery,
} from "@glassbox/contracts";
import { DomainDatabase, optionalString, stringColumn } from "../persistence/database.js";

export const MAX_DURABLE_CONTINUATION_HORIZON_MS = 365 * 24 * 60 * 60 * 1000;
export const MAX_DURABLE_CONTINUATION_OCCURRENCES = 1000;
export const MAX_DURABLE_CONTINUATION_INTERVAL_MS = 365 * 24 * 60 * 60 * 1000;
export const MAX_RECOVERABLE_DURABLE_CONTINUATION_SCHEDULES = 1000;

export class ContinuationScheduleLimitError extends Error {
  constructor() {
    super("Recoverable continuation schedule limit reached");
    this.name = "ContinuationScheduleLimitError";
  }
}

export interface CreateDurableContinuationSchedule {
  id?: string;
  target: DurableContinuationTarget;
  cadence: DurableContinuationCadence;
  nextDueAt: string;
  origin: DurableContinuationOrigin;
}

/** The caller may recheck its current policy in the same transaction as a mutation. */
export type ContinuationWriteGuard = (tx: Transaction) => Promise<void>;

export interface FiredContinuation {
  schedule: DurableContinuationSchedule;
  occurrence: DurableContinuationOccurrence | null;
}

function timestamp(value: string, field: string): { iso: string; ms: number } {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) throw new Error(`Invalid continuation ${field}`);
  return { iso: new Date(ms).toISOString(), ms };
}

function identifier(value: string, field: string): string {
  if (!value || value.length > 128 || value.trim() !== value)
    throw new Error(`Invalid continuation ${field}`);
  return value;
}

function scheduleRecord(row: Row): DurableContinuationSchedule {
  const cadenceKind = stringColumn(row, "cadence_kind");
  const cadence: DurableContinuationCadence =
    cadenceKind === "once"
      ? { kind: "once" }
      : cadenceKind === "interval"
        ? {
            kind: "interval",
            intervalMs: Number(row.interval_ms),
            maxOccurrences: Number(row.max_occurrences),
            ...(optionalString(row, "end_at") === null
              ? {}
              : { endAt: stringColumn(row, "end_at") }),
          }
        : (() => {
            throw new Error("Invalid persisted continuation cadence");
          })();
  const status = stringColumn(row, "status");
  if (status !== "active" && status !== "completed" && status !== "cancelled")
    throw new Error("Invalid persisted continuation status");
  const targetKind = stringColumn(row, "target_kind");
  if (targetKind !== "task" && targetKind !== "activity")
    throw new Error("Invalid persisted continuation target");
  return {
    id: stringColumn(row, "id"),
    target: { kind: targetKind, targetId: stringColumn(row, "target_id") },
    cadence,
    createdAt: stringColumn(row, "created_at"),
    nextDueAt: optionalString(row, "next_due_at"),
    occurrenceCount: Number(row.occurrence_count),
    generation: Number(row.generation),
    version: Number(row.version),
    status,
    updatedAt: stringColumn(row, "updated_at"),
  };
}

function occurrenceRecord(row: Row): DurableContinuationOccurrence {
  const targetKind = stringColumn(row, "target_kind");
  if (targetKind !== "task" && targetKind !== "activity")
    throw new Error("Invalid persisted continuation target");
  return {
    id: stringColumn(row, "id"),
    scheduleId: stringColumn(row, "schedule_id"),
    target: { kind: targetKind, targetId: stringColumn(row, "target_id") },
    generation: Number(row.generation),
    ordinal: Number(row.ordinal),
    dueAt: stringColumn(row, "due_at"),
    createdAt: stringColumn(row, "created_at"),
  };
}

function continuationTarget(target: DurableContinuationTarget): DurableContinuationTarget {
  if (target.kind !== "task" && target.kind !== "activity")
    throw new Error("Invalid continuation target kind");
  return { kind: target.kind, targetId: identifier(target.targetId, "target id") };
}

function checkedOrigin(origin: DurableContinuationOrigin): DurableContinuationOrigin {
  if (origin.kind === "decision")
    return {
      kind: "decision",
      decisionId: identifier(origin.decisionId, "decision id"),
      actorPrincipalId: identifier(origin.actorPrincipalId, "actor principal id"),
    };
  if (origin.kind === "system")
    return { kind: "system", reason: identifier(origin.reason, "system reason") };
  throw new Error("Invalid continuation origin");
}

function continuationEventRecord(row: Row): DurableContinuationEvent {
  const targetKind = stringColumn(row, "target_kind");
  if (targetKind !== "task" && targetKind !== "activity")
    throw new Error("Invalid persisted continuation target");
  const originKind = stringColumn(row, "origin_kind");
  const origin: DurableContinuationOrigin =
    originKind === "decision"
      ? {
          kind: "decision",
          decisionId: stringColumn(row, "decision_id"),
          actorPrincipalId: stringColumn(row, "actor_principal_id"),
        }
      : originKind === "system"
        ? { kind: "system", reason: stringColumn(row, "system_reason") }
        : (() => {
            throw new Error("Invalid persisted continuation origin");
          })();
  const type = stringColumn(row, "type");
  if (type !== "created" && type !== "rescheduled" && type !== "cancelled" && type !== "fired")
    throw new Error("Invalid persisted continuation event type");
  const occurrenceId = optionalString(row, "occurrence_id");
  return {
    id: stringColumn(row, "id"),
    sequence: Number(row.sequence),
    scheduleId: stringColumn(row, "schedule_id"),
    type,
    target: { kind: targetKind, targetId: stringColumn(row, "target_id") },
    generation: Number(row.generation),
    version: Number(row.schedule_version),
    dueAt: optionalString(row, "due_at"),
    ...(occurrenceId === null ? {} : { occurrenceId }),
    origin,
    createdAt: stringColumn(row, "created_at"),
  };
}

function checkedCadence(
  cadence: DurableContinuationCadence,
  dueMs: number,
  createdMs: number,
): { kind: string; intervalMs: number | null; maxOccurrences: number; endAt: string | null } {
  if (cadence.kind === "once")
    return { kind: "once", intervalMs: null, maxOccurrences: 1, endAt: null };
  if (cadence.kind !== "interval") throw new Error("Invalid continuation cadence");
  const { intervalMs, maxOccurrences } = cadence;
  if (
    !Number.isSafeInteger(intervalMs) ||
    intervalMs < 1000 ||
    intervalMs > MAX_DURABLE_CONTINUATION_INTERVAL_MS
  )
    throw new Error("Continuation interval is outside the allowed range");
  if (
    !Number.isSafeInteger(maxOccurrences) ||
    maxOccurrences < 1 ||
    maxOccurrences > MAX_DURABLE_CONTINUATION_OCCURRENCES
  )
    throw new Error("Continuation occurrence limit is outside the allowed range");
  const end = cadence.endAt === undefined ? null : timestamp(cadence.endAt, "end time");
  if (end && (end.ms < dueMs || end.ms > createdMs + MAX_DURABLE_CONTINUATION_HORIZON_MS))
    throw new Error("Continuation end time is outside the allowed horizon");
  return {
    kind: "interval",
    intervalMs,
    maxOccurrences,
    endAt: end?.iso ?? null,
  };
}

/** Persistence for bounded timers. Callers own authorization and execution semantics. */
export class DurableContinuationStore {
  constructor(private readonly db: DomainDatabase) {}

  private async appendEvent(
    tx: Transaction,
    schedule: DurableContinuationSchedule,
    type: DurableContinuationEvent["type"],
    dueAt: string | null,
    origin: DurableContinuationOrigin,
    createdAt: string,
    occurrenceId?: string,
  ): Promise<void> {
    const checked = checkedOrigin(origin);
    await tx.execute({
      sql: `INSERT INTO durable_continuation_events
            (id,schedule_id,type,target_kind,target_id,generation,schedule_version,due_at,
             occurrence_id,origin_kind,decision_id,actor_principal_id,system_reason,created_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      args: [
        randomUUID(),
        schedule.id,
        type,
        schedule.target.kind,
        schedule.target.targetId,
        schedule.generation,
        schedule.version,
        dueAt,
        occurrenceId ?? null,
        checked.kind,
        checked.kind === "decision" ? checked.decisionId : null,
        checked.kind === "decision" ? checked.actorPrincipalId : null,
        checked.kind === "system" ? checked.reason : null,
        createdAt,
      ],
    });
  }

  async schedule(
    input: CreateDurableContinuationSchedule,
    now: string,
    guard?: ContinuationWriteGuard,
  ): Promise<DurableContinuationSchedule> {
    const created = timestamp(now, "current time");
    const due = timestamp(input.nextDueAt, "due time");
    if (due.ms > created.ms + MAX_DURABLE_CONTINUATION_HORIZON_MS)
      throw new Error("Continuation due time is outside the allowed horizon");
    const target = continuationTarget(input.target);
    const cadence = checkedCadence(input.cadence, due.ms, created.ms);
    const id = identifier(input.id ?? randomUUID(), "schedule id");
    const origin = checkedOrigin(input.origin);
    return this.db.transaction(async (tx) => {
      await guard?.(tx);
      const existing = await tx.execute({
        sql: "SELECT * FROM durable_continuation_schedules WHERE id = ?",
        args: [id],
      });
      if (existing.rows[0]) {
        const row = existing.rows[0];
        const samePolicy =
          row.target_kind === target.kind &&
          row.target_id === target.targetId &&
          row.cadence_kind === cadence.kind &&
          row.interval_ms === cadence.intervalMs &&
          Number(row.max_occurrences) === cadence.maxOccurrences &&
          optionalString(row, "end_at") === cadence.endAt &&
          stringColumn(row, "initial_due_at") === due.iso;
        if (!samePolicy)
          throw new Error("Continuation schedule ID is already used by another policy");
        return scheduleRecord(row);
      }
      const recoverableCount = await tx.execute({
        sql: `SELECT COUNT(*) AS count FROM durable_continuation_schedules s
              WHERE (s.status = 'active' AND s.next_due_at IS NOT NULL)
                 OR EXISTS (
                   SELECT 1 FROM durable_continuation_occurrences o
                   JOIN durable_continuation_deliveries d ON d.occurrence_id = o.id
                   WHERE o.schedule_id = s.id AND o.target_kind = 'task' AND d.status = 'pending'
                 )`,
      });
      if (Number(recoverableCount.rows[0]?.count) >= MAX_RECOVERABLE_DURABLE_CONTINUATION_SCHEDULES)
        throw new ContinuationScheduleLimitError();
      await tx.execute({
        sql: `INSERT INTO durable_continuation_schedules
              (id,target_kind,target_id,cadence_kind,interval_ms,max_occurrences,end_at,created_at,
               initial_due_at,next_due_at,occurrence_count,generation,version,status,updated_at)
              VALUES (?,?,?,?,?,?,?,?,?,?,0,1,1,'active',?)`,
        args: [
          id,
          target.kind,
          target.targetId,
          cadence.kind,
          cadence.intervalMs,
          cadence.maxOccurrences,
          cadence.endAt,
          created.iso,
          due.iso,
          due.iso,
          created.iso,
        ],
      });
      const selected = await tx.execute({
        sql: "SELECT * FROM durable_continuation_schedules WHERE id = ?",
        args: [id],
      });
      const schedule = scheduleRecord(selected.rows[0]!);
      await this.appendEvent(tx, schedule, "created", schedule.nextDueAt, origin, created.iso);
      return schedule;
    });
  }

  async get(scheduleId: string): Promise<DurableContinuationSchedule | null> {
    const id = identifier(scheduleId, "schedule id");
    return this.db.transaction(async (tx) => {
      const result = await tx.execute({
        sql: "SELECT * FROM durable_continuation_schedules WHERE id = ?",
        args: [id],
      });
      return result.rows[0] ? scheduleRecord(result.rows[0]) : null;
    });
  }

  /** Materializes one due occurrence and advances the timer in the same transaction. */
  async fireDue(
    scheduleId: string,
    expectedGeneration: number,
    now: string,
    origin: DurableContinuationOrigin,
  ): Promise<FiredContinuation> {
    const id = identifier(scheduleId, "schedule id");
    const current = timestamp(now, "current time");
    if (!Number.isSafeInteger(expectedGeneration) || expectedGeneration < 1)
      throw new Error("Invalid continuation generation");
    const checked = checkedOrigin(origin);
    return this.db.transaction(async (tx) => {
      const selected = await tx.execute({
        sql: "SELECT * FROM durable_continuation_schedules WHERE id = ?",
        args: [id],
      });
      const row = selected.rows[0];
      if (!row) throw new Error("Continuation schedule not found");
      const before = scheduleRecord(row);
      const dueText = before.nextDueAt;
      if (
        before.status !== "active" ||
        before.generation !== expectedGeneration ||
        dueText === null ||
        timestamp(dueText, "due time").ms > current.ms
      )
        return { schedule: before, occurrence: null };

      const dueMs = timestamp(dueText, "due time").ms;
      const ordinal = before.occurrenceCount + 1;
      const occurrence: DurableContinuationOccurrence = {
        id: randomUUID(),
        scheduleId: id,
        target: before.target,
        generation: before.generation,
        ordinal,
        dueAt: dueText,
        createdAt: current.iso,
      };
      const nextMs =
        before.cadence.kind === "interval"
          ? dueMs + before.cadence.intervalMs
          : Number.POSITIVE_INFINITY;
      const occurrenceLimit =
        before.cadence.kind === "interval" ? before.cadence.maxOccurrences : 1;
      const endAtMs =
        before.cadence.kind === "interval" && before.cadence.endAt
          ? timestamp(before.cadence.endAt, "end time").ms
          : Number.POSITIVE_INFINITY;
      const horizonEndMs =
        timestamp(before.createdAt, "creation time").ms + MAX_DURABLE_CONTINUATION_HORIZON_MS;
      const shouldContinue =
        before.cadence.kind === "interval" &&
        ordinal < occurrenceLimit &&
        nextMs <= endAtMs &&
        nextMs <= horizonEndMs;
      await tx.execute({
        sql: `INSERT INTO durable_continuation_occurrences
              (id,schedule_id,target_kind,target_id,generation,ordinal,due_at,created_at)
              VALUES (?,?,?,?,?,?,?,?)`,
        args: [
          occurrence.id,
          occurrence.scheduleId,
          occurrence.target.kind,
          occurrence.target.targetId,
          occurrence.generation,
          occurrence.ordinal,
          occurrence.dueAt,
          occurrence.createdAt,
        ],
      });
      await tx.execute({
        sql: "INSERT INTO durable_continuation_deliveries (occurrence_id,status,version,acknowledged_at) VALUES (?,'pending',1,NULL)",
        args: [occurrence.id],
      });
      const updatedCount = await tx.execute({
        sql: `UPDATE durable_continuation_schedules
              SET next_due_at = ?, occurrence_count = ?,
                  version = version + 1, status = ?, updated_at = ?
              WHERE id = ? AND generation = ? AND version = ? AND status = 'active'`,
        args: [
          shouldContinue ? new Date(nextMs).toISOString() : null,
          ordinal,
          shouldContinue ? "active" : "completed",
          current.iso,
          id,
          before.generation,
          before.version,
        ],
      });
      if (updatedCount.rowsAffected !== 1)
        throw new Error("Continuation schedule changed while firing");
      const updated = await tx.execute({
        sql: "SELECT * FROM durable_continuation_schedules WHERE id = ?",
        args: [id],
      });
      const after = scheduleRecord(updated.rows[0]!);
      await this.appendEvent(tx, after, "fired", dueText, checked, current.iso, occurrence.id);
      return { schedule: after, occurrence };
    });
  }

  async reschedule(
    scheduleId: string,
    expectedVersion: number,
    nextDueAt: string,
    origin: DurableContinuationOrigin,
    now: string,
    guard?: ContinuationWriteGuard,
  ): Promise<DurableContinuationSchedule | null> {
    const id = identifier(scheduleId, "schedule id");
    const current = timestamp(now, "current time");
    const due = timestamp(nextDueAt, "due time");
    const checked = checkedOrigin(origin);
    if (due.ms < current.ms || due.ms > current.ms + MAX_DURABLE_CONTINUATION_HORIZON_MS)
      throw new Error("Continuation due time is outside the allowed horizon");
    return this.db.transaction(async (tx) => {
      await guard?.(tx);
      const selected = await tx.execute({
        sql: "SELECT * FROM durable_continuation_schedules WHERE id = ?",
        args: [id],
      });
      const row = selected.rows[0];
      if (!row) return null;
      const before = scheduleRecord(row);
      const scheduleEndMs =
        before.cadence.kind === "interval" && before.cadence.endAt
          ? timestamp(before.cadence.endAt, "end time").ms
          : timestamp(before.createdAt, "creation time").ms + MAX_DURABLE_CONTINUATION_HORIZON_MS;
      const actualEndMs = Math.min(
        scheduleEndMs,
        timestamp(before.createdAt, "creation time").ms + MAX_DURABLE_CONTINUATION_HORIZON_MS,
      );
      if (
        before.status !== "active" ||
        before.version !== expectedVersion ||
        due.ms > actualEndMs ||
        before.occurrenceCount >=
          (before.cadence.kind === "interval" ? before.cadence.maxOccurrences : 1)
      )
        return null;
      const changed = await tx.execute({
        sql: `UPDATE durable_continuation_schedules
              SET next_due_at = ?, generation = generation + 1, version = version + 1, updated_at = ?
              WHERE id = ? AND version = ? AND generation = ? AND status = 'active'`,
        args: [due.iso, current.iso, id, expectedVersion, before.generation],
      });
      if (changed.rowsAffected !== 1) return null;
      const updated = await tx.execute({
        sql: "SELECT * FROM durable_continuation_schedules WHERE id = ?",
        args: [id],
      });
      const after = scheduleRecord(updated.rows[0]!);
      await this.appendEvent(tx, after, "rescheduled", after.nextDueAt, checked, current.iso);
      return after;
    });
  }

  /** Cancels only the future timer. Fired occurrence deliveries remain recoverable. */
  async cancelFuture(
    scheduleId: string,
    expectedVersion: number,
    origin: DurableContinuationOrigin,
    now: string,
    guard?: ContinuationWriteGuard,
  ): Promise<DurableContinuationSchedule | null> {
    const id = identifier(scheduleId, "schedule id");
    const current = timestamp(now, "current time");
    const checked = checkedOrigin(origin);
    return this.db.transaction(async (tx) => {
      await guard?.(tx);
      const selected = await tx.execute({
        sql: "SELECT * FROM durable_continuation_schedules WHERE id = ?",
        args: [id],
      });
      const row = selected.rows[0];
      if (!row) return null;
      const before = scheduleRecord(row);
      if (before.status !== "active" || before.version !== expectedVersion) return null;
      const changed = await tx.execute({
        sql: `UPDATE durable_continuation_schedules
              SET next_due_at = NULL, generation = generation + 1, version = version + 1,
                  status = 'cancelled', updated_at = ?
              WHERE id = ? AND version = ? AND generation = ? AND status = 'active'`,
        args: [current.iso, id, expectedVersion, before.generation],
      });
      if (changed.rowsAffected !== 1) return null;
      const updated = await tx.execute({
        sql: "SELECT * FROM durable_continuation_schedules WHERE id = ?",
        args: [id],
      });
      const after = scheduleRecord(updated.rows[0]!);
      await this.appendEvent(tx, after, "cancelled", null, checked, current.iso);
      return after;
    });
  }

  async listPending(limit = 100): Promise<PendingContinuationDelivery[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000)
      throw new Error("Invalid continuation delivery limit");
    return this.db.transaction(async (tx) => {
      const result = await tx.execute({
        sql: `SELECT o.*,d.version AS delivery_version
              FROM durable_continuation_deliveries d
              JOIN durable_continuation_occurrences o ON o.id = d.occurrence_id
              WHERE d.status = 'pending' ORDER BY o.created_at,o.id LIMIT ?`,
        args: [limit],
      });
      return result.rows.map((row) => ({
        occurrence: occurrenceRecord(row),
        version: Number(row.delivery_version),
      }));
    });
  }

  async listPendingForSchedule(
    scheduleId: string,
    limit = 100,
  ): Promise<PendingContinuationDelivery[]> {
    const id = identifier(scheduleId, "schedule id");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000)
      throw new Error("Invalid continuation delivery limit");
    return this.db.transaction(async (tx) => {
      const result = await tx.execute({
        sql: `SELECT o.*,d.version AS delivery_version
              FROM durable_continuation_deliveries d
              JOIN durable_continuation_occurrences o ON o.id = d.occurrence_id
              WHERE d.status = 'pending' AND o.schedule_id = ?
              ORDER BY o.created_at,o.id LIMIT ?`,
        args: [id, limit],
      });
      return result.rows.map((row) => ({
        occurrence: occurrenceRecord(row),
        version: Number(row.delivery_version),
      }));
    });
  }

  async listEvents(scheduleId: string, limit = 100): Promise<DurableContinuationEvent[]> {
    const id = identifier(scheduleId, "schedule id");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000)
      throw new Error("Invalid continuation event limit");
    return this.db.transaction(async (tx) => {
      const result = await tx.execute({
        sql: `SELECT * FROM durable_continuation_events WHERE schedule_id = ?
              ORDER BY sequence LIMIT ?`,
        args: [id, limit],
      });
      return result.rows.map(continuationEventRecord);
    });
  }

  async acknowledgeOccurrence(
    occurrenceId: string,
    expectedVersion: number,
    now: string,
  ): Promise<boolean> {
    const id = identifier(occurrenceId, "occurrence id");
    const acknowledgedAt = timestamp(now, "acknowledgement time").iso;
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1)
      throw new Error("Invalid continuation delivery version");
    return this.db.transaction(async (tx) => {
      const result = await tx.execute({
        sql: `UPDATE durable_continuation_deliveries
              SET status = 'acknowledged', version = version + 1, acknowledged_at = ?
              WHERE occurrence_id = ? AND status = 'pending' AND version = ?`,
        args: [acknowledgedAt, id, expectedVersion],
      });
      return result.rowsAffected === 1;
    });
  }

  /** Active timers and pending Task wakes are enough to rebuild the timer wheel. */
  async listRecoverable(limit = 1000): Promise<DurableContinuationSchedule[]> {
    if (
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > MAX_RECOVERABLE_DURABLE_CONTINUATION_SCHEDULES
    )
      throw new Error("Invalid continuation recovery limit");
    return this.db.transaction(async (tx) => {
      const result = await tx.execute({
        sql: `SELECT s.* FROM durable_continuation_schedules s
              WHERE (s.status = 'active' AND s.next_due_at IS NOT NULL)
                 OR EXISTS (
                   SELECT 1 FROM durable_continuation_occurrences o
                   JOIN durable_continuation_deliveries d ON d.occurrence_id = o.id
                   WHERE o.schedule_id = s.id AND o.target_kind = 'task' AND d.status = 'pending'
                 )
              ORDER BY CASE WHEN s.status = 'active' THEN 0 ELSE 1 END,
                       s.next_due_at,s.id LIMIT ?`,
        args: [limit],
      });
      return result.rows.map(scheduleRecord);
    });
  }
}
