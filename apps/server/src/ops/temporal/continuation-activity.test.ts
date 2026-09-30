import { expect, it, vi } from "vite-plus/test";
import { openDomainStore } from "../../application/domain-store.js";
import { createAdvanceContinuationActivity } from "./continuation-activity.js";

const scope = {
  connectionId: "fixture-onebot",
  botId: "bot",
  chatType: "private",
  chatId: "owner",
  senderId: "owner",
} as const;

it("materializes a due Task occurrence once and retries a lost wake without firing again", async () => {
  const store = await openDomainStore({ databasePath: ":memory:" });
  try {
    await store.identities.bindOwner("owner", scope);
    const task = await store.tasks.createTask({
      title: "Continuation target",
      creatorPrincipalId: "owner",
      authorizationScope: scope,
    });
    const dueAt = new Date(Date.now() - 1000).toISOString();
    const schedule = await store.continuations.schedule(
      {
        target: { kind: "task", targetId: task.id },
        cadence: { kind: "once" },
        nextDueAt: dueAt,
        origin: { kind: "system", reason: "test" },
      },
      new Date(Date.now() - 2000).toISOString(),
    );
    const wake = vi.fn().mockRejectedValueOnce(new Error("Temporal temporarily unavailable"));
    const advance = createAdvanceContinuationActivity(store, wake);

    expect(await advance({ scheduleId: schedule.id })).toMatchObject({ kind: "wait" });
    expect((await store.continuations.get(schedule.id))?.occurrenceCount).toBe(1);
    expect(await store.continuations.listPendingForSchedule(schedule.id)).toHaveLength(1);

    expect(await advance({ scheduleId: schedule.id })).toEqual({ kind: "complete" });
    expect(wake).toHaveBeenCalledTimes(2);
    expect((await store.continuations.get(schedule.id))?.occurrenceCount).toBe(1);
    expect(await store.continuations.listPendingForSchedule(schedule.id)).toHaveLength(0);
  } finally {
    await store.close();
  }
});

it("leaves Activity occurrences pending for its domain consumer", async () => {
  const store = await openDomainStore({ databasePath: ":memory:" });
  try {
    const schedule = await store.continuations.schedule(
      {
        target: { kind: "activity", targetId: "activity-1" },
        cadence: { kind: "interval", intervalMs: 60_000, maxOccurrences: 2 },
        nextDueAt: new Date(Date.now() - 1000).toISOString(),
        origin: { kind: "system", reason: "test" },
      },
      new Date(Date.now() - 2000).toISOString(),
    );
    const wake = vi.fn();
    const result = await createAdvanceContinuationActivity(
      store,
      wake,
    )({ scheduleId: schedule.id });
    expect(result.kind).toBe("wait");
    expect(wake).not.toHaveBeenCalled();
    expect(await store.continuations.listPendingForSchedule(schedule.id)).toHaveLength(1);
  } finally {
    await store.close();
  }
});

it("drains more than one page of pending Task wakes before completing", async () => {
  const store = await openDomainStore({ databasePath: ":memory:" });
  try {
    await store.identities.bindOwner("owner", scope);
    const task = await store.tasks.createTask({
      title: "Pending wake target",
      creatorPrincipalId: "owner",
      authorizationScope: scope,
    });
    const base = Date.now() - 120_000;
    const schedule = await store.continuations.schedule(
      {
        target: { kind: "task", targetId: task.id },
        cadence: { kind: "interval", intervalMs: 1000, maxOccurrences: 101 },
        nextDueAt: new Date(base + 1000).toISOString(),
        origin: { kind: "system", reason: "test" },
      },
      new Date(base).toISOString(),
    );
    for (let ordinal = 1; ordinal <= 101; ordinal += 1)
      await store.continuations.fireDue(
        schedule.id,
        schedule.generation,
        new Date(base + ordinal * 1000).toISOString(),
        { kind: "system", reason: "test" },
      );
    const wake = vi.fn(async () => {});
    const advance = createAdvanceContinuationActivity(store, wake);
    expect(await advance({ scheduleId: schedule.id })).toEqual({ kind: "continue" });
    expect(await store.continuations.listPendingForSchedule(schedule.id)).toHaveLength(1);
    expect(await advance({ scheduleId: schedule.id })).toEqual({ kind: "complete" });
    expect(wake).toHaveBeenCalledTimes(101);
  } finally {
    await store.close();
  }
});
