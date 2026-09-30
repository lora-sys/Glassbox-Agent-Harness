import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DomainDatabase } from "../persistence/database.js";
import { CURRENT_SCHEMA_VERSION } from "../persistence/schema.js";
import { DurableContinuationStore } from "./continuation-store.js";

const origin = "2026-09-28T00:00:00.000Z";
const at = (hours: number) => new Date(Date.parse(origin) + hours * 60 * 60 * 1000).toISOString();
const owner = { kind: "decision", decisionId: "decision-1", actorPrincipalId: "owner" } as const;
const timer = { kind: "system", reason: "timer" } as const;

describe("DurableContinuationStore", () => {
  it("fires a once schedule atomically and rejects an old timer generation", async () => {
    const db = await DomainDatabase.open(":memory:");
    try {
      const store = new DurableContinuationStore(db);
      const schedule = await store.schedule(
        {
          id: "once-1",
          target: { kind: "task", targetId: "task-1" },
          cadence: { kind: "once" },
          nextDueAt: at(1),
          origin: owner,
        },
        origin,
      );
      expect(
        (await store.fireDue(schedule.id, schedule.generation, origin, timer)).occurrence,
      ).toBeNull();

      const fired = await store.fireDue(schedule.id, schedule.generation, at(1), timer);
      expect(fired.occurrence).toMatchObject({
        scheduleId: schedule.id,
        target: { kind: "task", targetId: "task-1" },
        generation: 1,
        ordinal: 1,
        dueAt: at(1),
      });
      expect(fired.schedule).toMatchObject({
        status: "completed",
        nextDueAt: null,
        occurrenceCount: 1,
      });
      expect(
        (await store.fireDue(schedule.id, schedule.generation, at(2), timer)).occurrence,
      ).toBeNull();
      expect(await store.listPendingForSchedule(schedule.id)).toHaveLength(1);
      expect((await store.listRecoverable()).map((row) => row.id)).toContain(schedule.id);
      expect(await store.listEvents(schedule.id)).toMatchObject([
        { type: "created", origin: owner, version: 1, generation: 1 },
        { type: "fired", origin: timer, version: 2, generation: 1 },
      ]);
    } finally {
      await db.close();
    }
  });

  it("returns the same schedule for a retried create ID and rejects a changed policy", async () => {
    const db = await DomainDatabase.open(":memory:");
    try {
      const store = new DurableContinuationStore(db);
      const input = {
        id: "idempotent-1",
        target: { kind: "task" as const, targetId: "task-idempotent" },
        cadence: { kind: "interval" as const, intervalMs: 60_000, maxOccurrences: 2 },
        nextDueAt: at(1),
        origin: owner,
      };
      const first = await store.schedule(input, origin);
      const retry = await store.schedule(input, at(0.5));
      expect(retry).toEqual(first);
      await expect(
        store.schedule({ ...input, target: { kind: "activity", targetId: "other" } }, origin),
      ).rejects.toThrow("already used by another policy");
      expect((await store.listEvents(first.id)).map((event) => event.type)).toEqual(["created"]);
    } finally {
      await db.close();
    }
  });

  it("reschedules by generation and retains already fired occurrences for recovery", async () => {
    const db = await DomainDatabase.open(":memory:");
    try {
      const store = new DurableContinuationStore(db);
      const schedule = await store.schedule(
        {
          id: "repeat-1",
          target: { kind: "activity", targetId: "activity-1" },
          cadence: { kind: "interval", intervalMs: 60 * 60 * 1000, maxOccurrences: 3 },
          nextDueAt: at(1),
          origin: owner,
        },
        origin,
      );
      const first = await store.fireDue(schedule.id, schedule.generation, at(1), timer);
      expect(first.occurrence?.ordinal).toBe(1);

      const moved = await store.reschedule(
        schedule.id,
        first.schedule.version,
        at(4),
        owner,
        at(1),
      );
      expect(moved).toMatchObject({
        generation: 2,
        version: 3,
        nextDueAt: at(4),
        occurrenceCount: 1,
      });
      expect((await store.fireDue(schedule.id, 1, at(5), timer)).occurrence).toBeNull();
      expect(await store.listPendingForSchedule(schedule.id)).toHaveLength(1);

      const second = await store.fireDue(schedule.id, 2, at(4), timer);
      expect(second.occurrence?.ordinal).toBe(2);
      expect(await store.listPendingForSchedule(schedule.id)).toHaveLength(2);
      expect((await store.listRecoverable()).map((row) => row.id)).toContain(schedule.id);
    } finally {
      await db.close();
    }
  });

  it("cancels only the future timer and requires the current schedule version", async () => {
    const db = await DomainDatabase.open(":memory:");
    try {
      const store = new DurableContinuationStore(db);
      const schedule = await store.schedule(
        {
          target: { kind: "task", targetId: "task-cancel" },
          cadence: { kind: "interval", intervalMs: 60_000, maxOccurrences: 4 },
          nextDueAt: at(1),
          origin: owner,
        },
        origin,
      );
      const fired = await store.fireDue(schedule.id, schedule.generation, at(1), timer);
      expect(await store.cancelFuture(schedule.id, schedule.version, owner, at(1))).toBeNull();
      const cancelled = await store.cancelFuture(schedule.id, fired.schedule.version, owner, at(1));
      expect(cancelled).toMatchObject({ status: "cancelled", generation: 2, nextDueAt: null });
      expect((await store.fireDue(schedule.id, 1, at(3), timer)).occurrence).toBeNull();
      expect(await store.listPendingForSchedule(schedule.id)).toHaveLength(1);
      expect((await store.listEvents(schedule.id)).map((event) => event.type)).toEqual([
        "created",
        "fired",
        "cancelled",
      ]);
      expect((await store.listRecoverable()).some((row) => row.id === schedule.id)).toBe(true);
    } finally {
      await db.close();
    }
  });

  it("bounds recurrence and acknowledges pending delivery with optimistic versioning", async () => {
    const db = await DomainDatabase.open(":memory:");
    try {
      const store = new DurableContinuationStore(db);
      const schedule = await store.schedule(
        {
          id: "bounded-1",
          target: { kind: "activity", targetId: "activity-bounded" },
          cadence: {
            kind: "interval",
            intervalMs: 60 * 60 * 1000,
            maxOccurrences: 5,
            endAt: at(2),
          },
          nextDueAt: at(1),
          origin: owner,
        },
        origin,
      );
      const first = await store.fireDue(schedule.id, 1, at(1), timer);
      expect(first.schedule.nextDueAt).toBe(at(2));
      const second = await store.fireDue(schedule.id, 1, at(2), timer);
      expect(second.schedule).toMatchObject({
        status: "completed",
        nextDueAt: null,
        occurrenceCount: 2,
      });
      const pending = await store.listPending(10);
      expect(pending).toHaveLength(2);
      expect(await store.acknowledgeOccurrence(pending[0]!.occurrence.id, 8, at(2))).toBe(false);
      expect(await store.acknowledgeOccurrence(pending[0]!.occurrence.id, 1, at(2))).toBe(true);
      expect(await store.acknowledgeOccurrence(pending[0]!.occurrence.id, 1, at(3))).toBe(false);
      expect(await store.listPendingForSchedule(schedule.id)).toHaveLength(1);

      await expect(
        store.schedule(
          {
            target: { kind: "task", targetId: "task-too-far" },
            cadence: { kind: "once" },
            nextDueAt: at(24 * 366),
            origin: owner,
          },
          origin,
        ),
      ).rejects.toThrow("outside the allowed horizon");
      const horizonSchedule = await store.schedule(
        {
          target: { kind: "activity", targetId: "activity-too-long" },
          cadence: { kind: "interval", intervalMs: 200 * 24 * 60 * 60 * 1000, maxOccurrences: 3 },
          nextDueAt: at(1),
          origin: owner,
        },
        origin,
      );
      const firstHorizon = await store.fireDue(horizonSchedule.id, 1, at(1), timer);
      expect(firstHorizon.schedule.status).toBe("active");
      const secondHorizon = await store.fireDue(horizonSchedule.id, 1, at(1 + 200 * 24), timer);
      expect(secondHorizon.schedule).toMatchObject({ status: "completed", occurrenceCount: 2 });
    } finally {
      await db.close();
    }
  });

  it("stops an interval before it can exceed the creation horizon", async () => {
    const db = await DomainDatabase.open(":memory:");
    try {
      const store = new DurableContinuationStore(db);
      const schedule = await store.schedule(
        {
          id: "horizon-1",
          target: { kind: "activity", targetId: "activity-horizon" },
          cadence: {
            kind: "interval",
            intervalMs: 365 * 24 * 60 * 60 * 1000,
            maxOccurrences: 3,
          },
          nextDueAt: at(1),
          origin: owner,
        },
        origin,
      );
      const fired = await store.fireDue(schedule.id, 1, at(1), timer);
      expect(fired.schedule).toMatchObject({
        status: "completed",
        nextDueAt: null,
        occurrenceCount: 1,
      });
    } finally {
      await db.close();
    }
  });

  it("caps recoverable schedules at the recovery query limit", async () => {
    const db = await DomainDatabase.open(":memory:");
    try {
      await db.transaction(async (tx) => {
        await tx.batch(
          Array.from({ length: 1000 }, (_, index) => ({
            sql: `INSERT INTO durable_continuation_schedules
                  (id,target_kind,target_id,cadence_kind,interval_ms,max_occurrences,end_at,
                   created_at,initial_due_at,next_due_at,occurrence_count,generation,version,status,updated_at)
                  VALUES (?,'task',?,'once',NULL,1,NULL,?,?,?,0,1,1,'active',?)`,
            args: [`cap-${index}`, `task-${index}`, origin, at(1), at(1), origin],
          })),
        );
      });
      const store = new DurableContinuationStore(db);
      expect(await store.listRecoverable()).toHaveLength(1000);
      await expect(
        store.schedule(
          {
            target: { kind: "task", targetId: "task-over-cap" },
            cadence: { kind: "once" },
            nextDueAt: at(1),
            origin: owner,
          },
          origin,
        ),
      ).rejects.toMatchObject({ name: "ContinuationScheduleLimitError" });
    } finally {
      await db.close();
    }
  });

  it("upgrades a v21 database without losing existing tables", async () => {
    const directory = await mkdtemp(join(tmpdir(), "glassbox-continuation-migration-"));
    const path = join(directory, "domain.db");
    try {
      const initial = await DomainDatabase.open(path);
      await initial.transaction(async (tx) => {
        await tx.execute("DROP TABLE durable_continuation_deliveries");
        await tx.execute("DROP TRIGGER durable_continuation_events_no_update");
        await tx.execute("DROP TRIGGER durable_continuation_events_no_delete");
        await tx.execute("DROP TABLE durable_continuation_events");
        await tx.execute("DROP TRIGGER durable_continuation_occurrences_no_update");
        await tx.execute("DROP TRIGGER durable_continuation_occurrences_no_delete");
        await tx.execute("DROP TABLE durable_continuation_occurrences");
        await tx.execute("DROP TABLE durable_continuation_schedules");
        await tx.execute("PRAGMA user_version = 24");
      });
      await initial.close();

      const upgraded = await DomainDatabase.open(path);
      try {
        await upgraded.transaction(async (tx) => {
          expect(Number((await tx.execute("PRAGMA user_version")).rows[0]?.user_version)).toBe(
            CURRENT_SCHEMA_VERSION,
          );
          expect(
            (await tx.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='tasks'"))
              .rows,
          ).toHaveLength(1);
          expect(
            (
              await tx.execute(
                "SELECT name FROM sqlite_master WHERE type='table' AND name='durable_continuation_schedules'",
              )
            ).rows,
          ).toHaveLength(1);
        });
      } finally {
        await upgraded.close();
      }
    } finally {
      await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }).catch(
        (error: NodeJS.ErrnoException) => {
          if (process.platform !== "win32" || error.code !== "EBUSY") throw error;
        },
      );
    }
  });
});
