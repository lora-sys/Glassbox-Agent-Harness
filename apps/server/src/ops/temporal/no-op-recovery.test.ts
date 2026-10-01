import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vite-plus/test";
import type { TaskStep } from "@glassbox/contracts";
import type { CallerContext } from "../../identity/scope.js";
import { openDomainStore } from "../../application/domain-store.js";
import { DEFAULT_TASK_GRAPH_LIMITS } from "../task-graph.js";
import { createAdvanceLongWorkActivity } from "./activity.js";

const caller: CallerContext = {
  principalId: "owner",
  scope: {
    connectionId: "test",
    botId: "bot",
    chatType: "private",
    chatId: "owner",
    senderId: "owner",
  },
};

const origin = { kind: "system", reason: "No-op crash recovery test" } as const;

it.each([
  ["join", false],
  ["timer_wait", false],
  ["join", true],
  ["timer_wait", true],
] as const)(
  "recovers a %s committed running before a crash with cancellation=%s",
  async (kind, cancel) => {
    const directory = await mkdtemp(join(tmpdir(), "glassbox-no-op-recovery-"));
    const databasePath = join(directory, "state.db");
    let store = await openDomainStore({ databasePath });
    try {
      await store.identities.bindOwner("owner", caller.scope);
      const task = await store.tasks.createTask({
        title: "Crash recovery",
        creatorPrincipalId: "owner",
        authorizationScope: caller.scope,
      });
      const now = new Date().toISOString();
      const step: TaskStep = {
        id: "crash-step",
        taskId: task.id,
        kind,
        title: "Pure step",
        status: "pending",
        dependencyIds: [],
        dependencyPolicy: { failed: "block", cancelled: "cancel", skipped: "skip" },
        maxAttempts: 1,
        requiredCapabilities: [],
        delegatedPermissionSet: [],
        version: 1,
        createdAt: now,
        updatedAt: now,
        ...(kind === "timer_wait"
          ? {
              waitPolicy: {
                version: 1 as const,
                kind: "until" as const,
                dueAt: "2020-01-01T00:00:00.000Z",
                overdue: "resume" as const,
              },
            }
          : {}),
      };
      const downstream: TaskStep = {
        ...step,
        id: "downstream",
        kind: "join",
        waitPolicy: undefined,
        dependencyIds: [step.id],
      };
      await store.longWork.createGraph(
        task.id,
        [step, downstream],
        downstream.id,
        DEFAULT_TASK_GRAPH_LIMITS,
        origin,
      );
      const transition = store.longWork.transitionStep.bind(store.longWork);
      vi.spyOn(store.longWork, "transitionStep").mockImplementation(async (input) => {
        const result = await transition(input);
        if (input.stepId === step.id && input.to === "running")
          throw new Error("injected crash after start commit");
        return result;
      });
      const input = { taskId: task.id, policyRevision: 1 };
      await expect(createAdvanceLongWorkActivity(store)(input)).rejects.toThrow(
        "injected crash after start commit",
      );
      expect(
        (await store.longWork.listSteps(task.id)).find((item) => item.id === step.id)?.status,
      ).toBe("running");
      await store.close();
      store = await openDomainStore({ databasePath });
      const advance = createAdvanceLongWorkActivity(store);
      if (cancel) {
        await store.authorization.grant({
          principalId: "owner",
          resourceId: `task-${task.id}`,
          action: "task:cancel",
          scope: caller.scope,
          effect: "allow",
        });
        const decision = await store.authorization.check({
          caller,
          resourceId: `task-${task.id}`,
          action: "task:cancel",
        });
        expect(decision.decision).toBe("ALLOW");
        await store.longWork.requestDurableCancellation(task.id, {
          kind: "decision",
          actorPrincipalId: "owner",
          decisionId: decision.id,
        });
        await advance(input);
        expect(await advance(input)).toEqual({ kind: "complete" });
        expect(await advance(input)).toEqual({ kind: "complete" });
        expect((await store.tasks.getTask(task.id))?.status).toBe("CANCELED");
        expect((await store.longWork.listSteps(task.id)).map((item) => item.status)).toEqual([
          "cancelled",
          "cancelled",
        ]);
        const events = await store.longWork.listEvents(task.id);
        expect(
          events.filter((event) => event.stepId === step.id && event.type === "STEP_CANCELLED"),
        ).toHaveLength(1);
        expect(
          events.filter((event) => event.stepId === step.id && event.type === "STEP_SUCCEEDED"),
        ).toHaveLength(0);
        return;
      }
      await advance(input);
      await advance(input);
      expect((await store.longWork.listSteps(task.id)).map((item) => item.status)).toEqual([
        "succeeded",
        "succeeded",
      ]);
      expect(await advance(input)).toEqual({ kind: "complete" });
      expect((await store.tasks.getTask(task.id))?.status).toBe("REVIEW");
      const events = await store.longWork.listEvents(task.id);
      expect(
        events.filter((event) => event.stepId === step.id && event.type === "STEP_STARTED"),
      ).toHaveLength(1);
      expect(
        events.filter((event) => event.stepId === step.id && event.type === "STEP_SUCCEEDED"),
      ).toHaveLength(1);
    } finally {
      await store.close();
      // Windows can briefly retain a native database file lock after close.
      await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  },
);
