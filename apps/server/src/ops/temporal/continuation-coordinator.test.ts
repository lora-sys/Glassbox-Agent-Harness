import { expect, it, vi } from "vite-plus/test";
import { DomainDatabase } from "../../persistence/database.js";
import { DurableContinuationStore } from "../continuation-store.js";
import { createContinuationWorkflowClient } from "./client.js";
import { TemporalContinuationCoordinator } from "./continuation-coordinator.js";

it("restores active timers and wakes a rescheduled stable workflow", async () => {
  const db = await DomainDatabase.open(":memory:");
  try {
    const schedules = new DurableContinuationStore(db);
    const now = new Date().toISOString();
    const due = new Date(Date.now() + 60_000).toISOString();
    const schedule = await schedules.schedule(
      {
        target: { kind: "activity", targetId: "activity-1" },
        cadence: { kind: "once" },
        nextDueAt: due,
        origin: { kind: "system", reason: "test" },
      },
      now,
    );
    let running = false;
    const port = {
      start: vi.fn(async ({ workflowId }: { workflowId: string }) => {
        running = true;
        return { workflowId };
      }),
      wake: vi.fn(async (_workflowId: string) => {}),
      cancel: vi.fn(async (_workflowId: string) => {}),
      inspect: vi.fn(async (_workflowId: string) => (running ? { runId: "run-1", running } : null)),
    };
    const coordinator = new TemporalContinuationCoordinator(
      schedules,
      createContinuationWorkflowClient(port),
    );

    expect(await coordinator.recover()).toEqual({ recovered: [schedule.id], unavailable: [] });
    expect(port.start).toHaveBeenCalledTimes(1);
    const moved = await schedules.reschedule(
      schedule.id,
      schedule.version,
      new Date(Date.now() + 120_000).toISOString(),
      { kind: "system", reason: "test" },
      new Date().toISOString(),
    );
    expect(moved?.generation).toBe(2);
    await coordinator.wake(schedule.id);
    expect(port.start).toHaveBeenCalledTimes(1);
    expect(port.wake).toHaveBeenCalledTimes(1);
    await schedules.cancelFuture(
      schedule.id,
      moved!.version,
      { kind: "system", reason: "test" },
      new Date().toISOString(),
    );
    await coordinator.stop(schedule.id);
    expect(port.cancel).toHaveBeenCalledTimes(1);
  } finally {
    await db.close();
  }
});

it("recovers a completed schedule while its fired occurrence still needs delivery", async () => {
  const db = await DomainDatabase.open(":memory:");
  try {
    const schedules = new DurableContinuationStore(db);
    const dueAt = new Date(Date.now() - 1000).toISOString();
    const schedule = await schedules.schedule(
      {
        target: { kind: "task", targetId: "task-1" },
        cadence: { kind: "once" },
        nextDueAt: dueAt,
        origin: { kind: "system", reason: "test" },
      },
      new Date(Date.now() - 2000).toISOString(),
    );
    const fired = await schedules.fireDue(
      schedule.id,
      schedule.generation,
      new Date().toISOString(),
      { kind: "system", reason: "test" },
    );
    expect(fired.schedule.status).toBe("completed");
    const port = {
      start: vi.fn(async ({ workflowId }: { workflowId: string }) => ({ workflowId })),
      wake: vi.fn(async (_workflowId: string) => {}),
      cancel: vi.fn(async (_workflowId: string) => {}),
      inspect: vi.fn(async (_workflowId: string) => null),
    };
    const coordinator = new TemporalContinuationCoordinator(
      schedules,
      createContinuationWorkflowClient(port),
    );
    expect(await coordinator.recover()).toEqual({ recovered: [schedule.id], unavailable: [] });
    expect(port.start).toHaveBeenCalledTimes(1);
  } finally {
    await db.close();
  }
});
