import { createHash } from "node:crypto";
import { expect, it, vi } from "vite-plus/test";
import type { TaskStep } from "@glassbox/contracts";
import { openDomainStore } from "../../application/domain-store.js";
import { conversationScopeKey, type CallerContext } from "../../identity/scope.js";
import { AccessDeniedError } from "../../auth/service.js";
import { RunService } from "../../execution/run-service/index.js";
import { createTaskGetAdapter } from "../../execution/run-service/task-get-adapter.js";
import { FakeHerdrBridge } from "../fake-herdr-bridge.js";
import { LongWorkScheduler } from "../long-work-scheduler.js";
import { AuthorizedOpsService } from "../service.js";
import { DEFAULT_TASK_GRAPH_LIMITS } from "../task-graph.js";
import { createAdvanceLongWorkActivity } from "./activity.js";

it("waits for a linked child Task and hands its accepted result to Step review", async () => {
  const store = await openDomainStore({ databasePath: ":memory:" });
  try {
    await store.identities.bindOwner("owner", caller.scope);
    const parent = await store.tasks.createTask({
      title: "Parent work",
      creatorPrincipalId: "owner",
      authorizationScope: caller.scope,
    });
    const child = await store.tasks.createTask({
      title: "Child work",
      creatorPrincipalId: "owner",
      authorizationScope: caller.scope,
    });
    await store.authorization.grant({
      principalId: "owner",
      resourceId: `task-${parent.id}`,
      action: "task:continue",
      scope: caller.scope,
      effect: "allow",
    });
    await store.authorization.grant({
      principalId: "owner",
      resourceId: `task-${parent.id}`,
      action: "task:delegate",
      scope: caller.scope,
      effect: "allow",
    });
    const now = new Date().toISOString();
    const step: TaskStep = {
      id: "child-step",
      taskId: parent.id,
      kind: "child_task",
      title: "Wait for child",
      status: "pending",
      dependencyIds: [],
      dependencyPolicy: { failed: "block", cancelled: "cancel", skipped: "skip" },
      maxAttempts: 1,
      requiredCapabilities: [],
      delegatedPermissionSet: [],
      version: 1,
      createdAt: now,
      updatedAt: now,
    };
    await store.longWork.createGraph(parent.id, [step], step.id, DEFAULT_TASK_GRAPH_LIMITS, {
      kind: "system",
      reason: "test child plan",
    });
    const advance = createAdvanceLongWorkActivity(store);
    const input = { taskId: parent.id, policyRevision: 1 };
    expect((await advance(input)).kind).toBe("wait");
    const ready = (await store.longWork.listSteps(parent.id))[0]!;
    expect(ready.status).toBe("ready");
    const service = new AuthorizedOpsService(store, new FakeHerdrBridge("child-session"));
    await service.linkChildTask(caller, {
      parentTaskId: parent.id,
      parentStepId: step.id,
      expectedStepVersion: ready.version,
      childTaskId: child.id,
      acceptanceCriteria: ["Child result reviewed"],
      cancellationPolicy: "keep_child",
      failurePolicy: "block_parent",
    });
    await store.authorization.grant({
      principalId: "owner",
      resourceId: `task-${child.id}`,
      action: "task:plan",
      scope: caller.scope,
      effect: "allow",
    });
    expect(
      (
        await store.authorization.check({
          caller,
          resourceId: `task-${child.id}`,
          action: "task:plan",
          delegatedTaskId: child.id,
        })
      ).decision,
    ).toBe("ALLOW");
    const childService = new AuthorizedOpsService(
      store,
      new FakeHerdrBridge("child-session"),
      undefined,
      {
        available: () => true,
        start: async () => undefined,
        wake: async () => undefined,
      },
    );
    const childStep: TaskStep = {
      ...step,
      id: "child-timer-step",
      taskId: child.id,
      kind: "timer_wait",
      waitPolicy: { version: 1, kind: "duration", durationMs: 60_000, overdue: "resume" },
    };
    await childService.planExistingTask(caller, child.id, [childStep], childStep.id);
    expect((await store.tasks.getTask(child.id))?.orchestrationMode).toBe("durable");
    expect((await advance(input)).kind).toBe("wait");
    await store.db.transaction(async (tx) => {
      await tx.execute({
        sql: "UPDATE tasks SET status = 'DONE' WHERE id = ?",
        args: [child.id],
      });
    });
    expect(await advance(input)).toEqual({ kind: "continue" });
    const reviewed = (await store.longWork.listSteps(parent.id))[0]!;
    expect(reviewed.status).toBe("review");
    expect(reviewed.outputRef).toBe(`task:${child.id}`);
    expect((await store.longWork.getChildTaskLink(child.id))?.resultRef).toBe(`task:${child.id}`);
    expect((await store.tasks.getTask(parent.id))?.status).not.toBe("DONE");
  } finally {
    await store.close();
  }
});

it("applies the linked child cancellation policy without claiming rollback", async () => {
  const store = await openDomainStore({ databasePath: ":memory:" });
  try {
    await store.identities.bindOwner("owner", caller.scope);
    const service = new AuthorizedOpsService(store, new FakeHerdrBridge("child-session"));
    const wakeChild = vi.fn(async (_taskId: string) => undefined);
    const advance = createAdvanceLongWorkActivity(store, undefined, wakeChild);
    for (const policy of ["cancel_child", "keep_child"] as const) {
      const parent = await store.tasks.createTask({
        title: `Parent ${policy}`,
        creatorPrincipalId: "owner",
        authorizationScope: caller.scope,
      });
      const child = await store.tasks.createTask({
        title: `Child ${policy}`,
        creatorPrincipalId: "owner",
        authorizationScope: caller.scope,
      });
      for (const action of ["task:continue", "task:delegate", "task:cancel"])
        await store.authorization.grant({
          principalId: "owner",
          resourceId: `task-${parent.id}`,
          action,
          scope: caller.scope,
          effect: "allow",
        });
      await store.authorization.grant({
        principalId: "owner",
        resourceId: `task-${child.id}`,
        action: "task:cancel",
        scope: caller.scope,
        effect: "allow",
      });
      await store.authorization.grant({
        principalId: "owner",
        resourceId: `task-${child.id}`,
        action: "task:delegate",
        scope: caller.scope,
        effect: "allow",
      });
      const now = new Date().toISOString();
      const step: TaskStep = {
        id: `child-step-${policy}`,
        taskId: parent.id,
        kind: "child_task",
        title: "Await child",
        status: "pending",
        dependencyIds: [],
        dependencyPolicy: { failed: "block", cancelled: "cancel", skipped: "skip" },
        maxAttempts: 1,
        requiredCapabilities: [],
        delegatedPermissionSet: [],
        version: 1,
        createdAt: now,
        updatedAt: now,
      };
      await store.longWork.createGraph(parent.id, [step], step.id, DEFAULT_TASK_GRAPH_LIMITS, {
        kind: "system",
        reason: "test child cancellation",
      });
      const input = { taskId: parent.id, policyRevision: 1 };
      await advance(input);
      const ready = (await store.longWork.listSteps(parent.id))[0]!;
      await service.linkChildTask(caller, {
        parentTaskId: parent.id,
        parentStepId: step.id,
        expectedStepVersion: ready.version,
        childTaskId: child.id,
        acceptanceCriteria: ["Child work handled"],
        cancellationPolicy: policy,
        failurePolicy: "block_parent",
      });
      await expect(
        service.delegate(caller, {
          taskId: child.id,
          workspaceId: "configured",
          agentKind: "pi",
          prompt: "Bypass the child graph",
        }),
      ).rejects.toThrow("Linked child Task requires a durable graph");
      if (policy === "cancel_child") {
        await store.authorization.grant({
          principalId: "owner",
          resourceId: `task-${child.id}`,
          action: "task:plan",
          scope: caller.scope,
          effect: "allow",
        });
        const childService = new AuthorizedOpsService(
          store,
          new FakeHerdrBridge("child-session"),
          undefined,
          {
            available: () => true,
            start: async () => undefined,
            wake: async () => undefined,
          },
        );
        const childStep: TaskStep = {
          ...step,
          id: `child-timer-${policy}`,
          taskId: child.id,
          kind: "timer_wait",
          waitPolicy: { version: 1, kind: "duration", durationMs: 60_000, overdue: "resume" },
        };
        await childService.planExistingTask(caller, child.id, [childStep], childStep.id);
      }
      expect(await service.cancel(caller, parent.id)).toBe(false);
      expect((await advance(input)).kind).toBe(policy === "cancel_child" ? "wait" : "continue");
      if (policy === "cancel_child") {
        expect(wakeChild).toHaveBeenCalledWith(child.id);
        expect((await store.tasks.getTask(child.id))?.cancellationState).toBe("requested");
        expect(await advance({ taskId: child.id, policyRevision: 1 })).toEqual({
          kind: "complete",
        });
        expect((await advance(input)).kind).toBe("continue");
      }
      expect((await store.longWork.listSteps(parent.id))[0]?.status).toBe("cancelled");
      expect(await advance(input)).toEqual({ kind: "complete" });
      expect((await store.tasks.getTask(parent.id))?.status).toBe("CANCELED");
      expect((await store.tasks.getTask(child.id))?.status).toBe(
        policy === "cancel_child" ? "CANCELED" : "NEW",
      );
      expect((await store.longWork.listEvents(parent.id)).at(-2)?.metadata).toMatchObject({
        rollbackPerformed: false,
      });
    }
  } finally {
    await store.close();
  }
});

it("applies each explicit child failure policy to the parent Step", async () => {
  const store = await openDomainStore({ databasePath: ":memory:" });
  try {
    await store.identities.bindOwner("owner", caller.scope);
    const service = new AuthorizedOpsService(store, new FakeHerdrBridge("child-session"));
    const advance = createAdvanceLongWorkActivity(store);
    for (const [policy, expected] of [
      ["block_parent", "blocked"],
      ["fail_parent", "failed"],
      ["review_parent", "review"],
    ] as const) {
      const parent = await store.tasks.createTask({
        title: `Parent ${policy}`,
        creatorPrincipalId: "owner",
        authorizationScope: caller.scope,
      });
      const child = await store.tasks.createTask({
        title: `Child ${policy}`,
        creatorPrincipalId: "owner",
        authorizationScope: caller.scope,
      });
      for (const action of ["task:continue", "task:delegate"])
        await store.authorization.grant({
          principalId: "owner",
          resourceId: `task-${parent.id}`,
          action,
          scope: caller.scope,
          effect: "allow",
        });
      const now = new Date().toISOString();
      const step: TaskStep = {
        id: `child-step-${policy}`,
        taskId: parent.id,
        kind: "child_task",
        title: "Await child",
        status: "pending",
        dependencyIds: [],
        dependencyPolicy: { failed: "block", cancelled: "cancel", skipped: "skip" },
        maxAttempts: 1,
        requiredCapabilities: [],
        delegatedPermissionSet: [],
        version: 1,
        createdAt: now,
        updatedAt: now,
      };
      await store.longWork.createGraph(parent.id, [step], step.id, DEFAULT_TASK_GRAPH_LIMITS, {
        kind: "system",
        reason: "test child failure",
      });
      const input = { taskId: parent.id, policyRevision: 1 };
      await advance(input);
      const ready = (await store.longWork.listSteps(parent.id))[0]!;
      await service.linkChildTask(caller, {
        parentTaskId: parent.id,
        parentStepId: step.id,
        expectedStepVersion: ready.version,
        childTaskId: child.id,
        acceptanceCriteria: ["Child work handled"],
        cancellationPolicy: "keep_child",
        failurePolicy: policy,
      });
      await store.db.transaction(async (tx) => {
        await tx.execute({
          sql: "UPDATE tasks SET status = 'FAILED' WHERE id = ?",
          args: [child.id],
        });
      });
      expect(await advance(input)).toEqual({ kind: "continue" });
      expect((await store.longWork.listSteps(parent.id))[0]?.status).toBe(expected);
      expect((await store.tasks.getTask(parent.id))?.status).not.toBe("DONE");
    }
  } finally {
    await store.close();
  }
});

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

async function createModelTask(
  store: Awaited<ReturnType<typeof openDomainStore>>,
  specRef: string | ((taskId: string) => string) = "pi:test",
  retryPolicy?: TaskStep["retryPolicy"],
  kind: "model" | "tool" = "model",
) {
  await store.identities.bindOwner("owner", caller.scope);
  await store.conversations.createAgent("personal");
  const now = new Date().toISOString();
  await store.db.transaction(async (tx) => {
    await tx.execute(
      "INSERT INTO resources(id,kind,visibility,owner_id) VALUES ('conversation:model-test','conversation','private','owner')",
    );
    await tx.execute({
      sql: "INSERT INTO conversations(id,agent_id,principal_id,scope_key,scope_json,resource_id,created_at) VALUES ('conversation:model-test','personal','owner',?,?,?,?)",
      args: [
        conversationScopeKey(caller.scope),
        JSON.stringify(caller.scope),
        "conversation:model-test",
        now,
      ],
    });
    await tx.execute({
      sql: "INSERT INTO conversation_locations(agent_id,location_key,conversation_id,created_at) VALUES ('personal',?,'conversation:model-test',?)",
      args: [conversationScopeKey(caller.scope), now],
    });
  });
  const task = await store.tasks.createTask({
    title: "Model Step",
    creatorPrincipalId: "owner",
    conversationId: "conversation:model-test",
    authorizationScope: caller.scope,
  });
  for (const action of ["task:continue", "task:read"])
    await store.authorization.grant({
      principalId: "owner",
      resourceId: `task-${task.id}`,
      action,
      scope: caller.scope,
      effect: "allow",
    });
  for (const action of ["run:create", "conversation:read", "run:control"])
    await store.authorization.grant({
      principalId: "owner",
      resourceId: "agent:personal",
      action,
      scope: caller.scope,
      effect: "allow",
    });
  const nowStep = new Date().toISOString();
  const step: TaskStep = {
    id: "model-step",
    taskId: task.id,
    kind,
    title: "Draft an answer",
    ...(kind === "model" ? { instructions: "Write a short answer" } : {}),
    specRef: typeof specRef === "function" ? specRef(task.id) : specRef,
    status: "pending",
    dependencyIds: [],
    dependencyPolicy: { failed: "block", cancelled: "cancel", skipped: "skip" },
    maxAttempts: retryPolicy?.maxAttempts ?? 2,
    ...(retryPolicy ? { retryPolicy } : {}),
    requiredCapabilities: [],
    delegatedPermissionSet: [],
    createdAt: nowStep,
    updatedAt: nowStep,
    version: 1,
  };
  await store.longWork.createGraph(task.id, [step], step.id, DEFAULT_TASK_GRAPH_LIMITS, {
    kind: "system",
    reason: "test plan",
  });
  return { task, step };
}

it("coordinates a signal wait through Glassbox state and stops at Task review", async () => {
  const store = await openDomainStore({ databasePath: ":memory:" });
  try {
    await store.identities.bindOwner("owner", caller.scope);
    const task = await store.tasks.createTask({
      title: "Wait for an explicit signal",
      creatorPrincipalId: "owner",
      authorizationScope: caller.scope,
    });
    const now = new Date().toISOString();
    const step: TaskStep = {
      id: "wait-step",
      taskId: task.id,
      kind: "signal_wait",
      title: "Wait for approval",
      status: "pending",
      dependencyIds: [],
      dependencyPolicy: { failed: "block", cancelled: "cancel", skipped: "skip" },
      maxAttempts: 1,
      waitPolicy: { version: 1, kind: "signal", signalKey: "continue", overdue: "stale" },
      requiredCapabilities: [],
      delegatedPermissionSet: [],
      createdAt: now,
      updatedAt: now,
      version: 1,
    };
    await store.longWork.createGraph(task.id, [step], step.id, DEFAULT_TASK_GRAPH_LIMITS, {
      kind: "system",
      reason: "test plan",
    });
    const advance = createAdvanceLongWorkActivity(store);
    const input = { taskId: task.id, policyRevision: 1 };
    expect(await advance(input)).toEqual({ kind: "continue" });
    expect((await store.longWork.listWaiting(task.id)).map((wait) => wait.stepId)).toEqual([
      step.id,
    ]);
    expect(await store.tasks.getTask(task.id)).toMatchObject({
      currentPhase: "waiting",
      activeStepIds: [step.id],
      waitingReason: "signal",
    });
    expect(await advance(input)).toEqual({ kind: "wait" });

    await store.authorization.grant({
      principalId: "owner",
      resourceId: `task-${task.id}`,
      action: "task:signal",
      scope: caller.scope,
      effect: "allow",
    });
    const decision = await store.authorization.check({
      caller,
      resourceId: `task-${task.id}`,
      action: "task:signal",
    });
    expect(decision.decision).toBe("ALLOW");
    expect(
      (
        await store.longWork.recordSignal({
          id: "signal-1",
          taskId: task.id,
          stepId: step.id,
          targetStepVersion: 3,
          type: "continue",
          source: "principal",
          actorPrincipalId: "owner",
          authorizationDecisionId: decision.id,
          idempotencyKey: "message-1",
          receivedAt: now,
        })
      ).disposition,
    ).toBe("applied");
    expect(await advance(input)).toEqual({ kind: "complete" });
    expect((await store.tasks.getTask(task.id))?.status).toBe("REVIEW");
    expect(await store.tasks.getTask(task.id)).toMatchObject({
      currentPhase: "review",
      activeStepIds: [],
    });
    expect((await store.longWork.listSteps(task.id))[0]?.status).toBe("succeeded");
    expect((await store.longWork.listEvents(task.id)).map((event) => event.type)).toContain(
      "TASK_REVIEW",
    );
    const service = new AuthorizedOpsService(store, new FakeHerdrBridge());
    await expect(service.accept(caller, task.id)).rejects.toBeInstanceOf(AccessDeniedError);
    await store.authorization.grant({
      principalId: "owner",
      resourceId: `task-${task.id}`,
      action: "task:accept",
      scope: caller.scope,
      effect: "allow",
    });
    await service.accept(caller, task.id);
    expect((await store.tasks.getTask(task.id))?.status).toBe("DONE");
  } finally {
    await store.close();
  }
});

it("settles an absolute timer whose due time passed before the worker started", async () => {
  const store = await openDomainStore({ databasePath: ":memory:" });
  try {
    await store.identities.bindOwner("owner", caller.scope);
    const task = await store.tasks.createTask({
      title: "Overdue timer",
      creatorPrincipalId: "owner",
      authorizationScope: caller.scope,
    });
    const now = new Date().toISOString();
    const step: TaskStep = {
      id: "timer-step",
      taskId: task.id,
      kind: "timer_wait",
      title: "Wait until deadline",
      status: "pending",
      dependencyIds: [],
      dependencyPolicy: { failed: "block", cancelled: "cancel", skipped: "skip" },
      maxAttempts: 1,
      waitPolicy: {
        version: 1,
        kind: "until",
        dueAt: "2020-01-01T00:00:00.000Z",
        overdue: "resume",
      },
      requiredCapabilities: [],
      delegatedPermissionSet: [],
      createdAt: now,
      updatedAt: now,
      version: 1,
    };
    await store.longWork.createGraph(task.id, [step], step.id, DEFAULT_TASK_GRAPH_LIMITS, {
      kind: "system",
      reason: "test plan",
    });
    const advance = createAdvanceLongWorkActivity(store);
    expect(await advance({ taskId: task.id, policyRevision: 1 })).toEqual({ kind: "continue" });
    expect(await advance({ taskId: task.id, policyRevision: 1 })).toEqual({ kind: "complete" });
    expect(await store.longWork.listWaiting(task.id)).toEqual([]);
    expect((await store.longWork.listSteps(task.id))[0]?.status).toBe("succeeded");
    expect((await store.tasks.getTask(task.id))?.status).toBe("REVIEW");
  } finally {
    await store.close();
  }
});

it("surfaces an overdue root Step as actionable blocked work", async () => {
  const store = await openDomainStore({ databasePath: ":memory:" });
  try {
    await store.identities.bindOwner("owner", caller.scope);
    const task = await store.tasks.createTask({
      title: "Expired work",
      creatorPrincipalId: "owner",
      authorizationScope: caller.scope,
    });
    const now = new Date().toISOString();
    const step: TaskStep = {
      id: "expired-step",
      taskId: task.id,
      kind: "timer_wait",
      title: "Wait until expiry",
      status: "pending",
      dependencyIds: [],
      dependencyPolicy: { failed: "block", cancelled: "cancel", skipped: "skip" },
      maxAttempts: 1,
      waitPolicy: {
        version: 1,
        kind: "until",
        dueAt: "2020-01-01T00:00:00.000Z",
        overdue: "stale",
      },
      requiredCapabilities: [],
      delegatedPermissionSet: [],
      createdAt: now,
      updatedAt: now,
      version: 1,
    };
    await store.longWork.createGraph(task.id, [step], step.id, DEFAULT_TASK_GRAPH_LIMITS, {
      kind: "system",
      reason: "test plan",
    });
    const advance = createAdvanceLongWorkActivity(store);
    expect(await advance({ taskId: task.id, policyRevision: 1 })).toEqual({ kind: "continue" });
    expect(await advance({ taskId: task.id, policyRevision: 1 })).toEqual({ kind: "wait" });
    expect((await store.tasks.getTask(task.id))?.status).toBe("WAITING_INPUT");
    expect((await store.longWork.listSteps(task.id))[0]?.status).toBe("blocked");
    expect((await store.longWork.listEvents(task.id)).map((event) => event.type)).toContain(
      "TASK_BLOCKED",
    );
    expect(await store.tasks.listAttentionItems()).toEqual(
      expect.arrayContaining([expect.objectContaining({ taskId: task.id })]),
    );
  } finally {
    await store.close();
  }
});

it("blocks a protected Step when no execution adapter is installed", async () => {
  const store = await openDomainStore({ databasePath: ":memory:" });
  try {
    await store.identities.bindOwner("owner", caller.scope);
    const task = await store.tasks.createTask({
      title: "Protected work",
      creatorPrincipalId: "owner",
      authorizationScope: caller.scope,
    });
    const now = new Date().toISOString();
    const step: TaskStep = {
      id: "worker-step",
      taskId: task.id,
      kind: "herdr_worker",
      title: "Coding worker",
      status: "pending",
      dependencyIds: [],
      dependencyPolicy: { failed: "block", cancelled: "cancel", skipped: "skip" },
      maxAttempts: 3,
      retryPolicy: {
        version: 1,
        maxAttempts: 3,
        initialDelayMs: 100,
        backoffMultiplier: 2,
        maxDelayMs: 1_000,
        retryableErrorClasses: ["transport_reset"],
        nonRetryableErrorClasses: ["policy_denied"],
        timeoutOutcome: "unknown",
      },
      requiredCapabilities: [],
      delegatedPermissionSet: [],
      createdAt: now,
      updatedAt: now,
      version: 1,
    };
    await store.longWork.createGraph(task.id, [step], step.id, DEFAULT_TASK_GRAPH_LIMITS, {
      kind: "system",
      reason: "test plan",
    });
    const advance = createAdvanceLongWorkActivity(store);
    expect(await advance({ taskId: task.id, policyRevision: 1 })).toEqual({ kind: "continue" });
    expect(await advance({ taskId: task.id, policyRevision: 1 })).toEqual({ kind: "wait" });
    expect((await store.longWork.listSteps(task.id))[0]?.status).toBe("blocked");
    expect((await store.tasks.getTask(task.id))?.status).toBe("WAITING_INPUT");
    const events = await store.longWork.listEvents(task.id);
    const blocked = events.find((event) => event.type === "STEP_BLOCKED");
    expect(blocked?.metadata).toMatchObject({
      reason: "executor_unavailable",
      outcome: "not_started",
      retryable: false,
      attempts: 0,
      maxAttempts: 3,
      kind: "herdr_worker",
    });
    expect(events.some((event) => event.type === "RETRY_SCHEDULED")).toBe(false);
    expect(await advance({ taskId: task.id, policyRevision: 1 })).toEqual({ kind: "wait" });
    expect(
      (await store.longWork.listEvents(task.id)).filter((event) => event.type === "STEP_BLOCKED"),
    ).toHaveLength(1);
    expect(await store.tasks.listAttentionItems()).toEqual(
      expect.arrayContaining([expect.objectContaining({ taskId: task.id })]),
    );
  } finally {
    await store.close();
  }
});

it("leaves a running Step alone until an executor reports its outcome", async () => {
  const store = await openDomainStore({ databasePath: ":memory:" });
  try {
    await store.identities.bindOwner("owner", caller.scope);
    const task = await store.tasks.createTask({
      title: "Live execution",
      creatorPrincipalId: "owner",
      authorizationScope: caller.scope,
    });
    const now = new Date().toISOString();
    const step: TaskStep = {
      id: "live-step",
      taskId: task.id,
      kind: "model",
      title: "Model work",
      status: "pending",
      dependencyIds: [],
      dependencyPolicy: { failed: "block", cancelled: "cancel", skipped: "skip" },
      maxAttempts: 2,
      requiredCapabilities: [],
      delegatedPermissionSet: [],
      createdAt: now,
      updatedAt: now,
      version: 1,
    };
    await store.longWork.createGraph(task.id, [step], step.id, DEFAULT_TASK_GRAPH_LIMITS, {
      kind: "system",
      reason: "test plan",
    });
    const scheduler = new LongWorkScheduler(store.longWork, DEFAULT_TASK_GRAPH_LIMITS);
    await scheduler.advance(task.id, { kind: "system", reason: "test readiness" });
    const ready = (await store.longWork.listSteps(task.id))[0]!;
    const running = await store.longWork.transitionStep({
      taskId: task.id,
      stepId: step.id,
      expectedVersion: ready.version,
      from: "ready",
      to: "running",
      origin: { kind: "system", reason: "simulated live executor" },
    });

    const advance = createAdvanceLongWorkActivity(store);
    expect(await advance({ taskId: task.id, policyRevision: 1 })).toEqual({ kind: "wait" });
    expect((await store.longWork.listSteps(task.id))[0]).toMatchObject({
      status: "running",
      version: running.version,
    });
    expect(
      (await store.longWork.listEvents(task.id)).some((event) =>
        ["STEP_FAILED", "STEP_BLOCKED", "RETRY_SCHEDULED"].includes(event.type),
      ),
    ).toBe(false);
  } finally {
    await store.close();
  }
});

it("surfaces a blocked non-root Step even while the root executor is running", async () => {
  const store = await openDomainStore({ databasePath: ":memory:" });
  try {
    await store.identities.bindOwner("owner", caller.scope);
    const task = await store.tasks.createTask({
      title: "Blocked parallel work",
      creatorPrincipalId: "owner",
      authorizationScope: caller.scope,
    });
    const now = new Date().toISOString();
    const root: TaskStep = {
      id: "root-step",
      taskId: task.id,
      kind: "model",
      title: "Root model work",
      status: "pending",
      dependencyIds: [],
      dependencyPolicy: { failed: "block", cancelled: "cancel", skipped: "skip" },
      maxAttempts: 1,
      requiredCapabilities: [],
      delegatedPermissionSet: [],
      createdAt: now,
      updatedAt: now,
      version: 1,
    };
    const blocked: TaskStep = {
      ...root,
      id: "blocked-step",
      kind: "herdr_worker",
      title: "Blocked worker work",
    };
    const timer: TaskStep = {
      ...root,
      id: "timer-step",
      kind: "timer_wait",
      title: "Future timer",
      waitPolicy: {
        version: 1,
        kind: "until",
        dueAt: new Date(Date.now() + 60_000).toISOString(),
        overdue: "resume",
      },
    };
    await store.longWork.createGraph(
      task.id,
      [root, blocked, timer],
      root.id,
      DEFAULT_TASK_GRAPH_LIMITS,
      {
        kind: "system",
        reason: "test plan",
      },
    );
    const scheduler = new LongWorkScheduler(store.longWork, DEFAULT_TASK_GRAPH_LIMITS);
    await scheduler.advance(task.id, { kind: "system", reason: "make steps ready" });
    const readyRoot = (await store.longWork.listSteps(task.id)).find(
      (step) => step.id === root.id,
    )!;
    await store.longWork.transitionStep({
      taskId: task.id,
      stepId: root.id,
      expectedVersion: readyRoot.version,
      from: "ready",
      to: "running",
      origin: { kind: "system", reason: "simulated root executor" },
    });
    const readyBlocked = (await store.longWork.listSteps(task.id)).find(
      (step) => step.id === blocked.id,
    )!;
    await store.longWork.transitionStep({
      taskId: task.id,
      stepId: blocked.id,
      expectedVersion: readyBlocked.version,
      from: "ready",
      to: "blocked",
      origin: { kind: "system", reason: "executor unavailable" },
      metadata: { reason: "executor_unavailable" },
    });

    const advance = createAdvanceLongWorkActivity(store);
    const input = { taskId: task.id, policyRevision: 1 };
    expect(await advance(input)).toEqual({ kind: "continue" });
    const waitUntil = (await store.longWork.listWaiting(task.id))[0]!.policy.dueAt!;
    expect(await advance(input)).toEqual({ kind: "wait", wakeAt: waitUntil });
    expect(await store.tasks.getTask(task.id)).toMatchObject({ status: "WAITING_INPUT" });
    expect(await store.tasks.listAttentionItems()).toEqual(
      expect.arrayContaining([expect.objectContaining({ taskId: task.id })]),
    );
    expect(await advance(input)).toEqual({ kind: "wait", wakeAt: waitUntil });
    expect(
      (await store.longWork.listEvents(task.id)).filter((event) => event.type === "TASK_BLOCKED"),
    ).toHaveLength(1);
  } finally {
    await store.close();
  }
});

it("moves a successful root to review after a non-root Step is cancelled", async () => {
  const store = await openDomainStore({ databasePath: ":memory:" });
  try {
    await store.identities.bindOwner("owner", caller.scope);
    const task = await store.tasks.createTask({
      title: "Cancelled optional work",
      creatorPrincipalId: "owner",
      authorizationScope: caller.scope,
    });
    const now = new Date().toISOString();
    const root: TaskStep = {
      id: "root-timer",
      taskId: task.id,
      kind: "timer_wait",
      title: "Due root timer",
      status: "pending",
      dependencyIds: [],
      dependencyPolicy: { failed: "block", cancelled: "cancel", skipped: "skip" },
      maxAttempts: 1,
      waitPolicy: {
        version: 1,
        kind: "until",
        dueAt: "2020-01-01T00:00:00.000Z",
        overdue: "resume",
      },
      requiredCapabilities: [],
      delegatedPermissionSet: [],
      createdAt: now,
      updatedAt: now,
      version: 1,
    };
    const optional: TaskStep = {
      ...root,
      id: "optional-timer",
      kind: "join",
      title: "Cancelled optional timer",
      waitPolicy: undefined,
    };
    await store.longWork.createGraph(
      task.id,
      [root, optional],
      root.id,
      DEFAULT_TASK_GRAPH_LIMITS,
      {
        kind: "system",
        reason: "test plan",
      },
    );
    const optionalPending = (await store.longWork.listSteps(task.id)).find(
      (step) => step.id === optional.id,
    )!;
    await store.longWork.transitionStep({
      taskId: task.id,
      stepId: optional.id,
      expectedVersion: optionalPending.version,
      from: "pending",
      to: "cancelled",
      origin: { kind: "system", reason: "optional work cancelled" },
    });

    const advance = createAdvanceLongWorkActivity(store);
    const input = { taskId: task.id, policyRevision: 1 };
    expect(await advance(input)).toEqual({ kind: "continue" });
    expect(await advance(input)).toEqual({ kind: "complete" });
    expect((await store.tasks.getTask(task.id))?.status).toBe("REVIEW");
    expect((await store.longWork.listSteps(task.id)).map((step) => step.status).sort()).toEqual([
      "cancelled",
      "succeeded",
    ]);
  } finally {
    await store.close();
  }
});

it("creates a linked internal Run for a model Step and settles it into Step review", async () => {
  const store = await openDomainStore({ databasePath: ":memory:" });
  try {
    const { task, step } = await createModelTask(store);
    const advance = createAdvanceLongWorkActivity(store);
    const input = { taskId: task.id, policyRevision: 1 };

    expect(await advance(input)).toEqual({ kind: "continue" });
    const claimed = (await store.longWork.listSteps(task.id))[0]!;
    const lease = await store.longWork.getActiveLease(task.id, step.id);
    expect(claimed.status).toBe("running");
    expect(lease?.attemptId).toBeTruthy();
    const run = await store.conversations.getInternalStepRun(caller, lease!.attemptId!);
    expect(run).toMatchObject({ source: "task_step", status: "queued", executionRef: "pi:test" });

    const pending = await advance(input);
    expect(pending.kind).toBe("wait");
    if (pending.kind !== "wait") throw new Error("Expected a durable Run poll wait");
    expect(Date.parse(pending.wakeAt!)).toBeGreaterThan(Date.now());
    const heartbeat = await store.longWork.getActiveLease(task.id, step.id);
    expect(Date.parse(heartbeat!.expiresAt)).toBeGreaterThan(Date.parse(lease!.expiresAt));

    await store.db.transaction((tx) =>
      tx.execute({
        sql: "UPDATE runs SET status = 'succeeded', result_text = 'Draft complete' WHERE id = ?",
        args: [run!.id],
      }),
    );
    expect(await advance(input)).toEqual({ kind: "continue" });
    expect((await store.longWork.listSteps(task.id))[0]).toMatchObject({
      status: "review",
      outputRef: `run:${run!.id}`,
    });
    expect((await store.tasks.getTask(task.id))?.status).not.toBe("DONE");
    const attemptStatus = await store.db.transaction((tx) =>
      tx.execute({
        sql: "SELECT status FROM task_attempts WHERE id = ?",
        args: [lease!.attemptId!],
      }),
    );
    expect(attemptStatus.rows[0]?.status).toBe("review");
  } finally {
    await store.close();
  }
});

it("executes a closed task_get Tool Step through a durable Run and holds its result for review", async () => {
  const store = await openDomainStore({ databasePath: ":memory:" });
  let service: RunService | undefined;
  try {
    const { task, step } = await createModelTask(
      store,
      "tool:task_get:target-read",
      undefined,
      "tool",
    );
    await store.tasks.createTask({
      id: "target-read",
      title: "Protected target",
      creatorPrincipalId: "owner",
      authorizationScope: caller.scope,
    });
    await store.authorization.grant({
      principalId: "owner",
      resourceId: "task-target-read",
      action: "task:read",
      scope: caller.scope,
      effect: "allow",
    });
    const advance = createAdvanceLongWorkActivity(store);
    const input = { taskId: task.id, policyRevision: 1 };
    expect(await advance(input)).toEqual({ kind: "continue" });
    const lease = await store.longWork.getActiveLease(task.id, step.id);
    const run = await store.conversations.getInternalStepRun(caller, lease!.attemptId!);
    expect(run).toMatchObject({
      source: "task_step",
      status: "queued",
      executionRef: "tool:task_get:target-read",
    });
    service = new RunService({
      store,
      resolveExecution: () => createTaskGetAdapter(store),
      transport: {
        send: async () => {
          throw new Error("Internal Tool result must not be delivered");
        },
      },
    });
    await service.start();
    await service.enqueueInternalStepRun(caller, run!.id);
    await vi.waitFor(async () => {
      expect((await store.conversations.getRun(caller, run!.id)).status).toBe("succeeded");
    });
    const finished = await store.conversations.getRun(caller, run!.id);
    expect(JSON.parse(finished.resultText!)).toMatchObject({ id: "target-read", status: "NEW" });
    const sources = await store.db.transaction((tx) =>
      tx.execute({
        sql: "SELECT resource_id,action,delivery_source FROM authorization_decisions WHERE run_id = ? AND delivery_source = 'content_source'",
        args: [run!.id],
      }),
    );
    expect(sources.rows).toEqual([
      expect.objectContaining({
        resource_id: "task-target-read",
        action: "task:read",
        delivery_source: "content_source",
      }),
    ]);
    expect(await advance(input)).toEqual({ kind: "continue" });
    expect((await store.longWork.listSteps(task.id))[0]).toMatchObject({
      status: "review",
      outputRef: `run:${run!.id}`,
    });
    expect((await store.tasks.getTask(task.id))?.status).not.toBe("DONE");
    await store.authorization.revokeScope({
      principalId: "owner",
      resourceId: "task-target-read",
      scope: caller.scope,
    });
    await expect(
      store.conversations.getInternalStepRun(caller, lease!.attemptId!),
    ).rejects.toMatchObject({
      decision: { reason: "no_grant" },
    });
  } finally {
    await service?.stop({ wait: true });
    await store.close();
  }
});

it("denies a task_get Tool call when target read permission is revoked after Run creation", async () => {
  const store = await openDomainStore({ databasePath: ":memory:" });
  try {
    const { task, step } = await createModelTask(
      store,
      "tool:task_get:target-read",
      undefined,
      "tool",
    );
    await store.tasks.createTask({
      id: "target-read",
      title: "Protected target",
      creatorPrincipalId: "owner",
      authorizationScope: caller.scope,
    });
    await store.authorization.grant({
      principalId: "owner",
      resourceId: "task-target-read",
      action: "task:read",
      scope: caller.scope,
      effect: "allow",
    });
    const advance = createAdvanceLongWorkActivity(store);
    const input = { taskId: task.id, policyRevision: 1 };
    expect(await advance(input)).toEqual({ kind: "continue" });
    const lease = await store.longWork.getActiveLease(task.id, step.id);
    const run = await store.conversations.getInternalStepRun(caller, lease!.attemptId!);
    const executionInput = await store.conversations.loadRunInput(caller, run!.id);
    const runLease = await store.lifecycle.claimQueuedRun(caller, run!.id);
    await store.authorization.revokeScope({
      principalId: "owner",
      resourceId: "task-target-read",
      scope: caller.scope,
    });
    await expect(
      createTaskGetAdapter(store).execute({
        ...executionInput,
        executionMode: "task_step_tool",
        caller,
        signal: new AbortController().signal,
      }),
    ).rejects.toBeInstanceOf(AccessDeniedError);
    await expect(store.conversations.getRun(caller, run!.id)).rejects.toMatchObject({
      decision: { reason: "no_grant" },
    });
    await runLease.settle("failed");
    expect(await advance(input)).toEqual({ kind: "continue" });
    expect((await store.longWork.listSteps(task.id))[0]?.status).toBe("blocked");
  } finally {
    await store.close();
  }
});

it("retries a failed model Run after its durable retry wait and fails when attempts are exhausted", async () => {
  const store = await openDomainStore({ databasePath: ":memory:" });
  try {
    const retryPolicy = {
      version: 1,
      maxAttempts: 2,
      initialDelayMs: 5_000,
      backoffMultiplier: 2,
      maxDelayMs: 10_000,
      retryableErrorClasses: ["model_failed"],
      nonRetryableErrorClasses: ["policy_denied"],
      timeoutOutcome: "unknown" as const,
    };
    const { task, step } = await createModelTask(store, "pi:test", retryPolicy);
    const advance = createAdvanceLongWorkActivity(store);
    const input = { taskId: task.id, policyRevision: 1 };

    expect(await advance(input)).toEqual({ kind: "continue" });
    const firstLease = await store.longWork.getActiveLease(task.id, step.id);
    const firstRun = await store.conversations.getInternalStepRun(caller, firstLease!.attemptId!);
    await store.db.transaction((tx) =>
      tx.execute({ sql: "UPDATE runs SET status = 'failed' WHERE id = ?", args: [firstRun!.id] }),
    );
    expect(await advance(input)).toEqual({ kind: "continue" });
    const waitingStep = (await store.longWork.listSteps(task.id))[0]!;
    expect(waitingStep).toMatchObject({ status: "waiting", version: 4 });
    const waiting = (await store.longWork.listWaiting(task.id))[0]!;
    expect(waiting).toMatchObject({
      attemptId: firstLease!.attemptId,
      policy: { kind: "retry", overdue: "resume" },
    });
    expect(
      (await store.longWork.listEvents(task.id)).filter(
        (event) => event.type === "RETRY_SCHEDULED",
      ),
    ).toHaveLength(1);
    expect(await advance(input)).toEqual({ kind: "wait", wakeAt: waiting.policy.dueAt });

    const dueAt = "2020-01-01T00:00:00.000Z";
    await store.db.transaction((tx) =>
      tx.execute({
        sql: "UPDATE task_waits SET due_at = ?, policy_json = ? WHERE task_id = ? AND step_id = ? AND status = 'waiting'",
        args: [dueAt, JSON.stringify({ ...waiting.policy, dueAt }), task.id, step.id],
      }),
    );
    expect(await advance(input)).toEqual({ kind: "continue" });
    expect(await advance(input)).toEqual({ kind: "continue" });
    const attempts = await store.db.transaction((tx) =>
      tx.execute({
        sql: "SELECT attempt_number,status FROM task_attempts WHERE task_id = ? AND step_id = ? ORDER BY attempt_number",
        args: [task.id, step.id],
      }),
    );
    expect(attempts.rows).toEqual([
      expect.objectContaining({ attempt_number: 1, status: "failed" }),
      expect.objectContaining({ attempt_number: 2, status: "running" }),
    ]);
    const secondLease = await store.longWork.getActiveLease(task.id, step.id);
    const secondRun = await store.conversations.getInternalStepRun(caller, secondLease!.attemptId!);
    expect(secondRun?.id).not.toBe(firstRun?.id);
    await store.db.transaction((tx) =>
      tx.execute({ sql: "UPDATE runs SET status = 'failed' WHERE id = ?", args: [secondRun!.id] }),
    );
    expect(await advance(input)).toEqual({ kind: "continue" });
    expect((await store.longWork.listSteps(task.id))[0]?.status).toBe("failed");
    expect(
      (await store.longWork.listEvents(task.id)).filter(
        (event) => event.type === "RETRY_SCHEDULED",
      ),
    ).toHaveLength(1);
  } finally {
    await store.close();
  }
});

it("counts Model Step retries independently of earlier attempts on the same Task", async () => {
  const store = await openDomainStore({ databasePath: ":memory:" });
  try {
    const { task, step } = await createModelTask(store, "pi:test", {
      version: 1,
      maxAttempts: 2,
      initialDelayMs: 1_000,
      backoffMultiplier: 2,
      maxDelayMs: 10_000,
      retryableErrorClasses: ["model_failed"],
      nonRetryableErrorClasses: [],
      timeoutOutcome: "unknown",
    });
    await store.db.transaction((tx) =>
      tx.execute({
        sql: "INSERT INTO task_attempts(id,task_id,attempt_number,status,started_at,completed_at) VALUES ('earlier-attempt',?,1,'succeeded',?,?)",
        args: [task.id, new Date().toISOString(), new Date().toISOString()],
      }),
    );
    const advance = createAdvanceLongWorkActivity(store);
    const input = { taskId: task.id, policyRevision: 1 };
    expect(await advance(input)).toEqual({ kind: "continue" });
    const lease = await store.longWork.getActiveLease(task.id, step.id);
    const run = await store.conversations.getInternalStepRun(caller, lease!.attemptId!);
    await store.db.transaction((tx) =>
      tx.execute({ sql: "UPDATE runs SET status = 'failed' WHERE id = ?", args: [run!.id] }),
    );
    expect(await advance(input)).toEqual({ kind: "continue" });
    expect((await store.longWork.listSteps(task.id))[0]?.status).toBe("waiting");
    expect((await store.longWork.listWaiting(task.id))[0]?.policy.kind).toBe("retry");
  } finally {
    await store.close();
  }
});

it("does not retry a model failure classified as nonretryable", async () => {
  const store = await openDomainStore({ databasePath: ":memory:" });
  try {
    const retryPolicy = {
      version: 1,
      maxAttempts: 2,
      initialDelayMs: 0,
      backoffMultiplier: 2,
      maxDelayMs: 10_000,
      retryableErrorClasses: ["transient"],
      nonRetryableErrorClasses: ["model_failed"],
      timeoutOutcome: "unknown" as const,
    };
    const { task, step } = await createModelTask(store, "pi:test", retryPolicy);
    const advance = createAdvanceLongWorkActivity(store);
    const input = { taskId: task.id, policyRevision: 1 };
    expect(await advance(input)).toEqual({ kind: "continue" });
    const lease = await store.longWork.getActiveLease(task.id, step.id);
    const run = await store.conversations.getInternalStepRun(caller, lease!.attemptId!);
    await store.db.transaction((tx) =>
      tx.execute({ sql: "UPDATE runs SET status = 'failed' WHERE id = ?", args: [run!.id] }),
    );

    expect(await advance(input)).toEqual({ kind: "continue" });
    expect((await store.longWork.listSteps(task.id))[0]?.status).toBe("failed");
    expect(
      (await store.longWork.listEvents(task.id)).some((event) => event.type === "RETRY_SCHEDULED"),
    ).toBe(false);
  } finally {
    await store.close();
  }
});

it("does not retry an unknown Model Run outcome", async () => {
  const store = await openDomainStore({ databasePath: ":memory:" });
  try {
    const retryPolicy = {
      version: 1,
      maxAttempts: 2,
      initialDelayMs: 0,
      backoffMultiplier: 2,
      maxDelayMs: 10_000,
      retryableErrorClasses: ["model_failed"],
      nonRetryableErrorClasses: [],
      timeoutOutcome: "unknown" as const,
    };
    const { task, step } = await createModelTask(store, "pi:test", retryPolicy);
    const advance = createAdvanceLongWorkActivity(store);
    const input = { taskId: task.id, policyRevision: 1 };
    expect(await advance(input)).toEqual({ kind: "continue" });
    const lease = await store.longWork.getActiveLease(task.id, step.id);
    const run = await store.conversations.getInternalStepRun(caller, lease!.attemptId!);
    await store.db.transaction((tx) =>
      tx.execute({ sql: "UPDATE runs SET status = 'unknown' WHERE id = ?", args: [run!.id] }),
    );

    expect(await advance(input)).toEqual({ kind: "continue" });
    expect((await store.longWork.listSteps(task.id))[0]?.status).toBe("blocked");
    expect(
      (await store.longWork.listEvents(task.id)).some((event) => event.type === "RETRY_SCHEDULED"),
    ).toBe(false);
  } finally {
    await store.close();
  }
});

it("does not retry a failed Model Run after Task continuation authorization is revoked", async () => {
  const store = await openDomainStore({ databasePath: ":memory:" });
  try {
    const retryPolicy = {
      version: 1,
      maxAttempts: 2,
      initialDelayMs: 0,
      backoffMultiplier: 2,
      maxDelayMs: 10_000,
      retryableErrorClasses: ["model_failed"],
      nonRetryableErrorClasses: [],
      timeoutOutcome: "unknown" as const,
    };
    const { task, step } = await createModelTask(store, "pi:test", retryPolicy);
    const advance = createAdvanceLongWorkActivity(store);
    const input = { taskId: task.id, policyRevision: 1 };
    expect(await advance(input)).toEqual({ kind: "continue" });
    const lease = await store.longWork.getActiveLease(task.id, step.id);
    const run = await store.conversations.getInternalStepRun(caller, lease!.attemptId!);
    await store.db.transaction((tx) =>
      tx.execute({ sql: "UPDATE runs SET status = 'failed' WHERE id = ?", args: [run!.id] }),
    );
    await store.authorization.revokeScopeAction({
      principalId: caller.principalId,
      resourceId: `task-${task.id}`,
      action: "task:continue",
      scope: caller.scope,
    });

    expect(await advance(input)).toEqual({ kind: "continue" });
    expect((await store.longWork.listSteps(task.id))[0]?.status).toBe("blocked");
    expect(
      (await store.longWork.listEvents(task.id)).some((event) => event.type === "RETRY_SCHEDULED"),
    ).toBe(false);
  } finally {
    await store.close();
  }
});

it("keeps Task cancellation pending until the linked model Run is terminal", async () => {
  const store = await openDomainStore({ databasePath: ":memory:" });
  try {
    const { task, step } = await createModelTask(store);
    await store.authorization.grant({
      principalId: "owner",
      resourceId: `task-${task.id}`,
      action: "task:cancel",
      scope: caller.scope,
      effect: "allow",
    });
    const advance = createAdvanceLongWorkActivity(store);
    const input = { taskId: task.id, policyRevision: 1 };
    expect(await advance(input)).toEqual({ kind: "continue" });
    const lease = await store.longWork.getActiveLease(task.id, step.id);
    const run = await store.conversations.getInternalStepRun(caller, lease!.attemptId!);
    expect(run).toBeTruthy();

    const ops = new AuthorizedOpsService(store, new FakeHerdrBridge());
    expect(await ops.cancel(caller, task.id)).toBe(false);
    await store.authorization.revokeScopeAction({
      principalId: caller.principalId,
      resourceId: `task-${task.id}`,
      action: "task:read",
      scope: caller.scope,
    });
    expect(await advance(input)).toMatchObject({ kind: "wait" });
    expect((await store.longWork.listSteps(task.id))[0]?.status).toBe("running");
    const queuedHeartbeat = await store.longWork.getActiveLease(task.id, step.id);
    expect(queuedHeartbeat?.state).toBe("active");
    expect(queuedHeartbeat!.version).toBeGreaterThan(lease!.version);

    await store.db.transaction((tx) =>
      tx.execute({ sql: "UPDATE runs SET status = 'cancelling' WHERE id = ?", args: [run!.id] }),
    );
    expect(await advance(input)).toMatchObject({ kind: "wait" });
    expect((await store.longWork.listSteps(task.id))[0]?.status).toBe("running");
    expect((await store.longWork.getActiveLease(task.id, step.id))!.version).toBeGreaterThan(
      queuedHeartbeat!.version,
    );

    await store.db.transaction((tx) =>
      tx.execute({ sql: "UPDATE runs SET status = 'cancelled' WHERE id = ?", args: [run!.id] }),
    );
    expect(await advance(input)).toEqual({ kind: "continue" });
    expect((await store.longWork.listSteps(task.id))[0]?.status).toBe("cancelled");
    expect(await store.longWork.getActiveLease(task.id, step.id)).toBeNull();
    expect(
      await store.db.transaction(
        async (tx) =>
          (
            await tx.execute({
              sql: "SELECT status FROM task_attempts WHERE id = ?",
              args: [lease!.attemptId!],
            })
          ).rows[0]?.status,
      ),
    ).toBe("canceled");
    expect(await advance(input)).toEqual({ kind: "complete" });
    expect(await store.tasks.getTask(task.id)).toMatchObject({
      status: "CANCELED",
      cancellationState: "settled",
    });
    expect((await store.longWork.listEvents(task.id)).map((event) => event.type)).toContain(
      "STEP_CANCELLED",
    );
  } finally {
    await store.close();
  }
});

it("settles Task cancellation after a restarted Model Run becomes unknown without erasing that evidence", async () => {
  const store = await openDomainStore({ databasePath: ":memory:" });
  try {
    const { task, step } = await createModelTask(store);
    await store.authorization.grant({
      principalId: "owner",
      resourceId: `task-${task.id}`,
      action: "task:cancel",
      scope: caller.scope,
      effect: "allow",
    });
    const advance = createAdvanceLongWorkActivity(store);
    const input = { taskId: task.id, policyRevision: 1 };
    expect(await advance(input)).toEqual({ kind: "continue" });
    const lease = await store.longWork.getActiveLease(task.id, step.id);
    const run = await store.conversations.getInternalStepRun(caller, lease!.attemptId!);
    const ops = new AuthorizedOpsService(store, new FakeHerdrBridge());
    expect(await ops.cancel(caller, task.id)).toBe(false);
    await store.db.transaction((tx) =>
      tx.execute({ sql: "UPDATE runs SET status = 'unknown' WHERE id = ?", args: [run!.id] }),
    );

    expect(await advance(input)).toEqual({ kind: "continue" });
    expect(await advance(input)).toEqual({ kind: "complete" });
    expect(await store.tasks.getTask(task.id)).toMatchObject({
      status: "CANCELED",
      cancellationState: "settled",
    });
    expect(await store.longWork.getActiveLease(task.id, step.id)).toBeNull();
    expect((await store.conversations.getRun(caller, run!.id)).status).toBe("unknown");
    expect(
      (await store.longWork.listEvents(task.id)).find((event) => event.type === "STEP_CANCELLED"),
    ).toMatchObject({
      evidenceRef: `run:${run!.id}`,
      metadata: { runOutcome: "unknown", rollbackPerformed: false },
    });
  } finally {
    await store.close();
  }
});

it("settles a cancelled claimed model Step when no internal Run was created", async () => {
  const store = await openDomainStore({ databasePath: ":memory:" });
  try {
    const { task, step } = await createModelTask(store);
    const scheduler = new LongWorkScheduler(store.longWork, DEFAULT_TASK_GRAPH_LIMITS);
    await scheduler.advance(task.id, { kind: "system", reason: "test ready model Step" });
    const readyStep = (await store.longWork.listSteps(task.id))[0]!;
    const decision = await store.authorization.check({
      caller,
      resourceId: `task-${task.id}`,
      action: "task:continue",
    });
    expect(decision.decision).toBe("ALLOW");
    await store.longWork.claimReadyStep({
      taskId: task.id,
      stepId: step.id,
      expectedStepVersion: readyStep.version,
      attemptId: "model-attempt-without-run",
      leaseId: "model-lease-without-run",
      ownerInstanceId: `temporal-model-${createHash("sha256")
        .update(`${task.id}\0${step.id}`)
        .digest("hex")}`,
      leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      origin: {
        kind: "decision",
        decisionId: decision.id,
        actorPrincipalId: caller.principalId,
      },
    });
    await store.authorization.grant({
      principalId: "owner",
      resourceId: `task-${task.id}`,
      action: "task:cancel",
      scope: caller.scope,
      effect: "allow",
    });
    const advance = createAdvanceLongWorkActivity(store);
    const input = { taskId: task.id, policyRevision: 1 };
    const ops = new AuthorizedOpsService(store, new FakeHerdrBridge());
    expect(await ops.cancel(caller, task.id)).toBe(false);

    expect(await advance(input)).toEqual({ kind: "continue" });
    expect((await store.longWork.listSteps(task.id))[0]?.status).toBe("cancelled");
    expect(await store.longWork.getActiveLease(task.id, step.id)).toBeNull();
    expect(await advance(input)).toEqual({ kind: "complete" });
    expect(await store.tasks.getTask(task.id)).toMatchObject({
      status: "CANCELED",
      cancellationState: "settled",
    });
  } finally {
    await store.close();
  }
});

it("settles a model Step failed when its internal Run insert fails before commit", async () => {
  const store = await openDomainStore({ databasePath: ":memory:" });
  try {
    const { task } = await createModelTask(store);
    vi.spyOn(store.conversations, "createInternalStepRun").mockRejectedValueOnce(
      new Error("insert failed"),
    );
    const advance = createAdvanceLongWorkActivity(store);
    expect(await advance({ taskId: task.id, policyRevision: 1 })).toEqual({ kind: "continue" });
    const step = (await store.longWork.listSteps(task.id))[0]!;
    expect(step.status).toBe("failed");
    expect(await store.longWork.getActiveLease(task.id, step.id)).toBeNull();
    expect(
      (await store.longWork.listEvents(task.id)).map((event) => event.evidenceRef),
    ).toContainEqual(expect.stringMatching(/^run-create-failed:/));
    expect(await store.conversations.getInternalStepRun(caller, "missing-attempt")).toBeNull();
  } finally {
    await store.close();
  }
});

it("blocks model Steps whose specRef cannot select a supported model adapter", async () => {
  const store = await openDomainStore({ databasePath: ":memory:" });
  try {
    const { task } = await createModelTask(store, "executor-main");
    const advance = createAdvanceLongWorkActivity(store);
    expect(await advance({ taskId: task.id, policyRevision: 1 })).toEqual({ kind: "continue" });
    expect((await store.longWork.listSteps(task.id))[0]?.status).toBe("blocked");
    expect((await store.longWork.listEvents(task.id)).at(-1)?.metadata).toMatchObject({
      reason: "invalid_model_execution_ref",
      outcome: "not_started",
    });
  } finally {
    await store.close();
  }
});

it("blocks a ready Model Step when its continuation grant was revoked before dispatch", async () => {
  const store = await openDomainStore({ databasePath: ":memory:" });
  try {
    const { task, step } = await createModelTask(store);
    await store.authorization.revokeScopeAction({
      principalId: caller.principalId,
      resourceId: `task-${task.id}`,
      action: "task:continue",
      scope: caller.scope,
    });
    const advance = createAdvanceLongWorkActivity(store);
    const input = { taskId: task.id, policyRevision: 1 };
    expect(await advance(input)).toEqual({ kind: "continue" });
    expect((await store.longWork.listSteps(task.id))[0]?.status).toBe("blocked");
    expect(await store.longWork.getActiveLease(task.id, step.id)).toBeNull();
    const attempts = await store.db.transaction((tx) =>
      tx.execute({ sql: "SELECT id FROM task_attempts WHERE task_id = ?", args: [task.id] }),
    );
    expect(attempts.rows).toHaveLength(0);
    expect((await store.longWork.listEvents(task.id)).at(-1)).toMatchObject({
      type: "STEP_BLOCKED",
      evidenceRef: expect.stringMatching(/^authorization:/),
      metadata: { reason: "task_continuation_denied", outcome: "not_started" },
    });
    await advance(input);
    expect((await store.tasks.getTask(task.id))?.status).toBe("WAITING_INPUT");
  } finally {
    await store.close();
  }
});

it("blocks model Steps that request a capability or delegated permission outside text generation", async () => {
  const store = await openDomainStore({ databasePath: ":memory:" });
  try {
    const { task, step } = await createModelTask(store);
    await store.db.transaction((tx) =>
      tx.execute({
        sql: "UPDATE task_steps SET required_capabilities_json = ?, delegated_permissions_json = ? WHERE id = ?",
        args: [JSON.stringify(["browser"]), JSON.stringify(["task:read"]), step.id],
      }),
    );
    const advance = createAdvanceLongWorkActivity(store);
    expect(await advance({ taskId: task.id, policyRevision: 1 })).toEqual({ kind: "continue" });
    expect((await store.longWork.listSteps(task.id))[0]?.status).toBe("blocked");
    expect(await store.longWork.getActiveLease(task.id, step.id)).toBeNull();
    const attempts = await store.db.transaction((tx) =>
      tx.execute({ sql: "SELECT id FROM task_attempts WHERE task_id = ?", args: [task.id] }),
    );
    expect(attempts.rows).toHaveLength(0);
    expect((await store.longWork.listEvents(task.id)).at(-1)?.metadata).toMatchObject({
      reason: "model_execution_boundary_exceeded",
      outcome: "not_started",
    });
  } finally {
    await store.close();
  }
});
