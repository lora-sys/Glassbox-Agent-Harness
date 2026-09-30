import type { DomainStore } from "../../application/domain-store.js";
import type { AdvanceContinuationActivity } from "./contracts.js";

const RETRY_PENDING_DELIVERY_MS = 30_000;
const MAX_DELIVERIES_PER_ADVANCE = 100;

/** Temporal advances timers. Target domains consume immutable occurrences. */
export function createAdvanceContinuationActivity(
  store: DomainStore,
  wakeTask: (taskId: string) => Promise<void>,
): AdvanceContinuationActivity {
  return async ({ scheduleId }) => {
    const now = new Date();
    let schedule = await store.continuations.get(scheduleId);
    if (!schedule) throw new Error("Continuation schedule is missing");

    if (
      schedule.status === "active" &&
      schedule.nextDueAt !== null &&
      Date.parse(schedule.nextDueAt) <= now.getTime()
    ) {
      const fired = await store.continuations.fireDue(
        scheduleId,
        schedule.generation,
        now.toISOString(),
        { kind: "system", reason: "temporal_timer" },
      );
      schedule = fired.schedule;
    }

    let retryDelivery = false;
    const pending = await store.continuations.listPendingForSchedule(
      scheduleId,
      MAX_DELIVERIES_PER_ADVANCE,
    );
    for (const delivery of pending) {
      if (delivery.occurrence.target.kind !== "task") continue;
      const task = await store.tasks.getTask(delivery.occurrence.target.targetId);
      if (!task || ["REVIEW", "ACCEPTED", "DONE", "CANCELED", "FAILED"].includes(task.status)) {
        // The occurrence remains evidence. There is no live Task to wake.
        await store.continuations.acknowledgeOccurrence(
          delivery.occurrence.id,
          delivery.version,
          new Date().toISOString(),
        );
        continue;
      }
      try {
        await wakeTask(task.id);
        await store.continuations.acknowledgeOccurrence(
          delivery.occurrence.id,
          delivery.version,
          new Date().toISOString(),
        );
      } catch {
        retryDelivery = true;
      }
    }

    if (retryDelivery)
      return {
        kind: "wait",
        wakeAt: new Date(Date.now() + RETRY_PENDING_DELIVERY_MS).toISOString(),
      };
    const remaining = await store.continuations.listPendingForSchedule(scheduleId, 1);
    if (remaining[0]?.occurrence.target.kind === "task") return { kind: "continue" };
    if (schedule.status !== "active" || schedule.nextDueAt === null) return { kind: "complete" };
    if (Date.parse(schedule.nextDueAt) <= Date.now()) return { kind: "continue" };
    return { kind: "wait", wakeAt: schedule.nextDueAt };
  };
}
