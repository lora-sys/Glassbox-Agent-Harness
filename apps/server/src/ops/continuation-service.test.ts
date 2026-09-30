import { expect, it, vi } from "vite-plus/test";
import { openDomainStore } from "../application/domain-store.js";
import { AccessDeniedError } from "../auth/service.js";
import type { CallerContext } from "../identity/scope.js";
import { AuthorizedContinuationService } from "./continuation-service.js";

const caller: CallerContext = {
  principalId: "owner",
  scope: {
    connectionId: "fixture-onebot",
    botId: "bot",
    chatType: "private",
    chatId: "owner",
    senderId: "owner",
  },
};

it("authorizes Task schedule changes and keeps committed timers when Temporal is unavailable", async () => {
  const store = await openDomainStore({ databasePath: ":memory:" });
  try {
    await store.identities.bindOwner("owner", caller.scope);
    const task = await store.tasks.createTask({
      title: "Durable target",
      creatorPrincipalId: "owner",
      authorizationScope: caller.scope,
    });
    await store.db.transaction(async (tx) => {
      await tx.execute({
        sql: "UPDATE tasks SET orchestration_mode = 'durable' WHERE id = ?",
        args: [task.id],
      });
    });
    const runtime = {
      start: vi.fn().mockRejectedValueOnce(new Error("Temporal down")),
      wake: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
    };
    const service = new AuthorizedContinuationService(store, runtime);
    const dueAt = new Date(Date.now() + 60_000).toISOString();
    const input = {
      scheduleId: "schedule-task-1",
      taskId: task.id,
      nextDueAt: dueAt,
      cadence: { kind: "interval", intervalMs: 60_000, maxOccurrences: 2 } as const,
    };

    await expect(service.scheduleTask(caller, input)).rejects.toBeInstanceOf(AccessDeniedError);
    const grantId = await store.authorization.grant({
      principalId: "owner",
      resourceId: `task-${task.id}`,
      action: "task:continue",
      scope: caller.scope,
      effect: "allow",
    });
    const created = await service.scheduleTask(caller, input);
    expect(created.runtimeReady).toBe(false);
    expect((await store.continuations.get(input.scheduleId))?.status).toBe("active");

    const moved = await service.rescheduleTask(caller, {
      taskId: task.id,
      scheduleId: input.scheduleId,
      expectedVersion: created.schedule.version,
      nextDueAt: new Date(Date.now() + 120_000).toISOString(),
    });
    expect(moved).toMatchObject({ runtimeReady: true, schedule: { generation: 2 } });
    expect(runtime.wake).toHaveBeenCalledWith(input.scheduleId);
    await expect(
      service.rescheduleTask(caller, {
        taskId: task.id,
        scheduleId: input.scheduleId,
        expectedVersion: created.schedule.version,
        nextDueAt: new Date(Date.now() + 180_000).toISOString(),
      }),
    ).rejects.toThrow("version conflict");

    const cancelled = await service.cancelFutureTask(caller, {
      taskId: task.id,
      scheduleId: input.scheduleId,
      expectedVersion: moved.schedule.version,
    });
    expect(cancelled.schedule.status).toBe("cancelled");
    expect(runtime.wake).toHaveBeenCalledTimes(2);
    expect(runtime.stop).not.toHaveBeenCalled();
    expect(
      (await store.continuations.listEvents(input.scheduleId)).map((event) => event.type),
    ).toEqual(["created", "rescheduled", "cancelled"]);

    const originalSchedule = store.continuations.schedule.bind(store.continuations);
    vi.spyOn(store.continuations, "schedule").mockImplementationOnce(
      async (request, now, guard) => {
        await store.authorization.revoke(grantId);
        return originalSchedule(request, now, guard);
      },
    );
    await expect(
      service.scheduleTask(caller, { ...input, scheduleId: "schedule-after-revoke" }),
    ).rejects.toBeInstanceOf(AccessDeniedError);
    expect(await store.continuations.get("schedule-after-revoke")).toBeNull();
  } finally {
    await store.close();
  }
});
