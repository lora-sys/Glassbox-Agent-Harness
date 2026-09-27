import { expect, it } from "vite-plus/test";
import type { TaskStep } from "@glassbox/contracts";
import { openDomainStore } from "../../application/domain-store.js";
import type { CallerContext } from "../../identity/scope.js";
import { AccessDeniedError } from "../../auth/service.js";
import { FakeHerdrBridge } from "../fake-herdr-bridge.js";
import { LongWorkScheduler } from "../long-work-scheduler.js";
import { AuthorizedOpsService } from "../service.js";
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
