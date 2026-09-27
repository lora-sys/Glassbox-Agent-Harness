import { expect, it, vi } from "vite-plus/test";
import { openDomainStore, AccessDeniedError, type CallerContext } from "../persistence/index.js";
import { FakeHerdrBridge } from "./fake-herdr-bridge.js";
import { AuthorizedOpsService } from "./service.js";

it("requests durable cancellation before settling and reports a running Step honestly", async () => {
  const store = await openDomainStore({ databasePath: ":memory:" });
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
  try {
    await store.identities.bindOwner("owner", caller.scope);
    const task = await store.tasks.createTask({
      title: "Cancel durable work",
      creatorPrincipalId: "owner",
      authorizationScope: caller.scope,
    });
    for (const action of ["task:plan", "task:cancel"])
      await store.authorization.grant({
        principalId: "owner",
        resourceId: `task-${task.id}`,
        action,
        scope: caller.scope,
        effect: "allow",
      });
    const runtime = {
      available: () => true,
      start: vi.fn(async () => undefined),
      wake: vi.fn(async () => undefined),
    };
    const service = new AuthorizedOpsService(store, new FakeHerdrBridge(), undefined, runtime);
    await service.planExistingTask(
      caller,
      task.id,
      [
        {
          id: "step-1",
          taskId: task.id,
          kind: "join",
          title: "Join",
          status: "pending",
          dependencyIds: [],
          dependencyPolicy: { failed: "block", cancelled: "cancel", skipped: "skip" },
          maxAttempts: 1,
          requiredCapabilities: [],
          delegatedPermissionSet: [],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          version: 1,
        },
      ],
      "step-1",
    );
    const ready = await store.longWork.transitionStep({
      taskId: task.id,
      stepId: "step-1",
      expectedVersion: 1,
      from: "pending",
      to: "ready",
      origin: { kind: "system", reason: "test" },
    });
    const running = await store.longWork.transitionStep({
      taskId: task.id,
      stepId: "step-1",
      expectedVersion: ready.version,
      from: "ready",
      to: "running",
      origin: { kind: "system", reason: "test" },
    });
    await expect(service.cancel(caller, task.id)).resolves.toBe(false);
    expect((await store.tasks.getTask(task.id))?.cancellationState).toBe("requested");
    expect((await store.longWork.listSteps(task.id))[0]?.status).toBe("running");
    await store.longWork.transitionStep({
      taskId: task.id,
      stepId: "step-1",
      expectedVersion: running.version,
      from: "running",
      to: "cancelled",
      origin: { kind: "system", reason: "verified stopped" },
    });
    await expect(service.cancel(caller, task.id)).resolves.toBe(true);
    expect((await store.tasks.getTask(task.id))?.status).toBe("CANCELED");
    expect((await store.tasks.getTask(task.id))?.cancellationState).toBe("settled");
  } finally {
    await store.close();
  }
});

it("authorizes durable graph planning and step reads on the exact Task", async () => {
  const store = await openDomainStore({ databasePath: ":memory:" });
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
  try {
    await store.identities.bindOwner("owner", caller.scope);
    const task = await store.tasks.createTask({
      title: "Long work",
      creatorPrincipalId: "owner",
      authorizationScope: caller.scope,
    });
    let runtimeAvailable = false;
    const runtime = {
      available: () => runtimeAvailable,
      start: vi.fn(async () => undefined),
      wake: vi.fn(async () => undefined),
    };
    const service = new AuthorizedOpsService(store, new FakeHerdrBridge(), undefined, runtime);
    const step = {
      id: "step-1",
      taskId: task.id,
      kind: "join" as const,
      title: "Review the result",
      status: "pending" as const,
      dependencyIds: [],
      dependencyPolicy: {
        failed: "block" as const,
        cancelled: "cancel" as const,
        skipped: "skip" as const,
      },
      maxAttempts: 1,
      requiredCapabilities: [],
      delegatedPermissionSet: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      version: 1,
    };
    await expect(service.planExistingTask(caller, task.id, [step], step.id)).rejects.toBeInstanceOf(
      AccessDeniedError,
    );
    const planGrant = await store.authorization.grant({
      principalId: "owner",
      resourceId: `task-${task.id}`,
      action: "task:plan",
      scope: caller.scope,
      effect: "allow",
    });
    await expect(service.planExistingTask(caller, task.id, [step], step.id)).rejects.toThrow(
      "runtime is unavailable",
    );
    expect((await store.tasks.getTask(task.id))?.orchestrationMode).toBeUndefined();
    runtimeAvailable = true;
    await service.planExistingTask(caller, task.id, [step], step.id);
    expect(runtime.start).toHaveBeenCalledWith(task.id, 1);
    await expect(service.steps(caller, task.id)).rejects.toBeInstanceOf(AccessDeniedError);
    await store.authorization.grant({
      principalId: "owner",
      resourceId: `task-${task.id}`,
      action: "task:read",
      scope: caller.scope,
      effect: "allow",
    });
    expect((await service.steps(caller, task.id)).map((item) => item.id)).toEqual([step.id]);
    expect((await service.taskEvents(caller, task.id)).map((event) => event.type)).toEqual([
      "STEP_ADDED",
    ]);
    await store.longWork.transitionStep({
      taskId: task.id,
      stepId: step.id,
      expectedVersion: 1,
      from: "pending",
      to: "ready",
      origin: { kind: "system", reason: "test" },
    });
    await store.longWork.createWait({
      id: "wait-1",
      taskId: task.id,
      stepId: step.id,
      expectedStepVersion: 2,
      policy: { version: 1, kind: "signal", signalKey: "continue", overdue: "stale" },
      origin: { kind: "system", reason: "test" },
    });
    const signal = {
      taskId: task.id,
      stepId: step.id,
      targetStepVersion: 3,
      type: "continue",
      idempotencyKey: "message-1",
    };
    await expect(service.signal(caller, signal)).rejects.toBeInstanceOf(AccessDeniedError);
    const signalGrant = await store.authorization.grant({
      principalId: "owner",
      resourceId: `task-${task.id}`,
      action: "task:signal",
      scope: caller.scope,
      effect: "allow",
    });
    expect((await service.signal(caller, signal)).disposition).toBe("applied");
    expect(runtime.wake).toHaveBeenCalledWith(task.id);
    await store.authorization.revoke(signalGrant);
    await expect(service.signal(caller, signal)).rejects.toBeInstanceOf(AccessDeniedError);
    await store.authorization.revoke(planGrant);
    await expect(service.planExistingTask(caller, task.id, [step], step.id)).rejects.toBeInstanceOf(
      AccessDeniedError,
    );
  } finally {
    await store.close();
  }
});

it("requires current target Task read authority before planning a task_get Tool Step", async () => {
  const store = await openDomainStore({ databasePath: ":memory:" });
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
  try {
    await store.identities.bindOwner("owner", caller.scope);
    const task = await store.tasks.createTask({
      title: "Read target",
      creatorPrincipalId: "owner",
      authorizationScope: caller.scope,
    });
    const target = await store.tasks.createTask({
      title: "Protected target",
      creatorPrincipalId: "owner",
      authorizationScope: caller.scope,
    });
    await store.authorization.grant({
      principalId: "owner",
      resourceId: `task-${task.id}`,
      action: "task:plan",
      scope: caller.scope,
      effect: "allow",
    });
    const runtime = {
      available: () => true,
      start: vi.fn(async () => {}),
      wake: vi.fn(async () => {}),
    };
    const service = new AuthorizedOpsService(store, new FakeHerdrBridge(), undefined, runtime);
    const now = new Date().toISOString();
    const step = {
      id: "tool-step",
      taskId: task.id,
      kind: "tool" as const,
      title: "Read target",
      specRef: `tool:task_get:${target.id}`,
      status: "pending" as const,
      dependencyIds: [],
      dependencyPolicy: {
        failed: "block" as const,
        cancelled: "cancel" as const,
        skipped: "skip" as const,
      },
      maxAttempts: 1,
      requiredCapabilities: [],
      delegatedPermissionSet: [],
      createdAt: now,
      updatedAt: now,
      version: 1,
    };
    await expect(service.planExistingTask(caller, task.id, [step], step.id)).rejects.toBeInstanceOf(
      AccessDeniedError,
    );
    expect((await store.tasks.getTask(task.id))?.orchestrationMode).toBeUndefined();
    await store.authorization.grant({
      principalId: "owner",
      resourceId: `task-${target.id}`,
      action: "task:read",
      scope: caller.scope,
      effect: "allow",
    });
    await service.planExistingTask(caller, task.id, [step], step.id);
    expect(runtime.start).toHaveBeenCalledWith(task.id, 1);
  } finally {
    await store.close();
  }
});

it("authorizes durable Step acceptance and rework at the service boundary", async () => {
  const store = await openDomainStore({ databasePath: ":memory:" });
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
  try {
    await store.identities.bindOwner("owner", caller.scope);
    const task = await store.tasks.createTask({
      title: "Review individual worker Steps",
      creatorPrincipalId: "owner",
      authorizationScope: caller.scope,
    });
    const grant = async (action: string) =>
      store.authorization.grant({
        principalId: "owner",
        resourceId: `task-${task.id}`,
        action,
        scope: caller.scope,
        effect: "allow",
      });
    await grant("task:plan");
    await grant("task:continue");
    const runtimeAvailable = vi.fn(() => true);
    const runtime = {
      available: runtimeAvailable,
      start: vi.fn(async () => undefined),
      wake: vi.fn(async () => undefined),
    };
    const service = new AuthorizedOpsService(store, new FakeHerdrBridge(), undefined, runtime);
    const makeStep = (id: string) => ({
      id,
      taskId: task.id,
      kind: "herdr_worker" as const,
      title: id,
      status: "pending" as const,
      dependencyIds: [],
      dependencyPolicy: {
        failed: "block" as const,
        cancelled: "cancel" as const,
        skipped: "skip" as const,
      },
      maxAttempts: 3,
      requiredCapabilities: [],
      delegatedPermissionSet: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      version: 1,
    });
    await service.planExistingTask(
      caller,
      task.id,
      [makeStep("accept-step"), makeStep("redo-step")],
      "accept-step",
    );
    const continueDecision = await store.authorization.check({
      caller,
      resourceId: `task-${task.id}`,
      action: "task:continue",
    });

    for (const stepId of ["accept-step", "redo-step"]) {
      await store.longWork.transitionStep({
        taskId: task.id,
        stepId,
        expectedVersion: 1,
        from: "pending",
        to: "ready",
        origin: { kind: "system", reason: "test ready" },
      });
      const claim = await store.longWork.claimReadyStep({
        taskId: task.id,
        stepId,
        expectedStepVersion: 2,
        attemptId: `${stepId}-attempt`,
        leaseId: `${stepId}-lease`,
        ownerInstanceId: "service-test",
        leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
        origin: {
          kind: "decision",
          decisionId: continueDecision.id,
          actorPrincipalId: "owner",
        },
      });
      await store.longWork.settleClaimedStep({
        taskId: task.id,
        stepId,
        attemptId: claim.attempt.id,
        leaseId: claim.lease.id,
        ownerInstanceId: "service-test",
        expectedStepVersion: claim.step.version,
        expectedLeaseVersion: claim.lease.version,
        outcome: "review",
        evidenceRef: `trace:${stepId}`,
        origin: { kind: "system", reason: "test settlement" },
      });
    }

    await expect(service.acceptStep(caller, task.id, "accept-step", 4)).rejects.toBeInstanceOf(
      AccessDeniedError,
    );
    await grant("task:accept");
    runtimeAvailable.mockReturnValue(false);
    runtime.wake.mockRejectedValueOnce(new Error("workflow backend unavailable"));
    const accepted = await service.acceptStep(caller, task.id, "accept-step", 4);
    expect(accepted).toMatchObject({ status: "succeeded", version: 5 });
    await expect(
      service.reworkStep(caller, task.id, "redo-step", 4, "Add the missing case"),
    ).rejects.toBeInstanceOf(AccessDeniedError);
    await grant("task:rework");
    const reworked = await service.reworkStep(
      caller,
      task.id,
      "redo-step",
      4,
      "Add the missing case",
    );
    expect(reworked).toMatchObject({ status: "ready", version: 5 });
    expect(runtime.wake).toHaveBeenCalledTimes(2);
    expect((await store.tasks.getAttempt("redo-step-attempt"))?.status).toBe("review");
    expect((await store.longWork.listEvents(task.id)).map((event) => event.evidenceRef)).toContain(
      "trace:redo-step",
    );
  } finally {
    await store.close();
  }
});

it("rechecks Worker source authority before reading terminal output", async () => {
  const store = await openDomainStore({ databasePath: ":memory:" });
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
  try {
    await store.identities.bindOwner("owner", caller.scope);
    await store.authorization.registerResource({
      id: "agent-operations",
      kind: "ops",
      visibility: "public",
    });
    await store.authorization.grant({
      principalId: "owner",
      resourceId: "agent-operations",
      action: "task:delegate",
      scope: caller.scope,
      effect: "allow",
    });
    const bridge = new FakeHerdrBridge();
    const service = new AuthorizedOpsService(store, bridge);
    const task = await service.delegate(caller, {
      title: "Source check",
      workspaceId: "isolated",
      agentKind: "pi",
      prompt: "Bounded work",
    });
    const read = vi.spyOn(bridge, "readAgent");
    await store.authorization.grant({
      principalId: "owner",
      resourceId: `task-${task.id}`,
      action: "worker:read",
      scope: caller.scope,
      effect: "allow",
    });
    await store.authorization.registerResource({
      id: "source-workspace",
      kind: "worker-files",
      visibility: "private",
      ownerId: "owner",
    });
    await store.tasks.recordTrace({
      type: "worker.tool",
      taskId: task.id,
      taskAttemptId: task.activeAttemptId!,
      data: { resourceId: "source-workspace", outcome: "succeeded", action: "worker:file:read" },
    });
    await expect(service.readWorker(caller, task.id)).rejects.toBeInstanceOf(AccessDeniedError);
    expect(read).not.toHaveBeenCalled();
    const grant = await store.authorization.grant({
      principalId: "owner",
      resourceId: "source-workspace",
      action: "worker:file:read",
      scope: caller.scope,
      effect: "allow",
    });
    await expect(service.readWorker(caller, task.id)).resolves.toHaveProperty("output");
    await store.authorization.revoke(grant);
    await expect(service.readWorker(caller, task.id)).rejects.toBeInstanceOf(AccessDeniedError);
    expect(read).toHaveBeenCalledTimes(1);
  } finally {
    await store.close();
  }
});

it("delegates an existing authorized Task once even when callers race", async () => {
  const store = await openDomainStore({ databasePath: ":memory:" });
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
  try {
    await store.identities.bindOwner("owner", caller.scope);
    await store.authorization.registerResource({
      id: "agent-operations",
      kind: "ops",
      visibility: "public",
    });
    await store.authorization.grant({
      principalId: "owner",
      resourceId: "agent-operations",
      action: "task:create",
      scope: caller.scope,
      effect: "allow",
    });
    const bridge = new FakeHerdrBridge();
    const start = vi.spyOn(bridge, "startAgent");
    const service = new AuthorizedOpsService(store, bridge);
    const task = await service.create(caller, { title: "Existing work" });
    const input = {
      taskId: task.id,
      workspaceId: "isolated",
      agentKind: "pi",
      prompt: "Bounded work",
    };
    await expect(service.delegate(caller, input)).rejects.toBeInstanceOf(AccessDeniedError);
    expect(start).not.toHaveBeenCalled();
    await store.authorization.grant({
      principalId: "owner",
      resourceId: `task-${task.id}`,
      action: "task:delegate",
      scope: caller.scope,
      effect: "allow",
    });
    const results = await Promise.allSettled([
      service.delegate(caller, input),
      service.delegate(caller, input),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(start).toHaveBeenCalledTimes(1);
    expect(await store.tasks.listTasks()).toHaveLength(1);
    expect(await store.tasks.listAttempts(task.id)).toHaveLength(1);
    expect(await store.tasks.listTraceEvents({ taskId: task.id })).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "task.worker_bound", taskId: task.id }),
      ]),
    );
  } finally {
    await store.close();
  }
});

it("preserves a failed rework attempt and never replays an uncertain prompt", async () => {
  const store = await openDomainStore({ databasePath: ":memory:" });
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
  try {
    await store.identities.bindOwner("owner", caller.scope);
    await store.authorization.registerResource({
      id: "agent-operations",
      kind: "ops",
      visibility: "public",
    });
    await store.authorization.grant({
      principalId: "owner",
      resourceId: "agent-operations",
      action: "task:delegate",
      scope: caller.scope,
      effect: "allow",
    });
    const bridge = new FakeHerdrBridge();
    const service = new AuthorizedOpsService(store, bridge);
    const task = await service.delegate(caller, {
      title: "Task",
      workspaceId: "isolated",
      agentKind: "pi",
      prompt: "Bounded work",
    });
    const binding = (await store.tasks.getWorkerBinding(task.activeAttemptId!))!;
    await store.tasks.observeWorker(binding, "done");
    for (const action of ["task:rework", "worker:prompt"])
      await store.authorization.grant({
        principalId: "owner",
        resourceId: `task-${task.id}`,
        action,
        scope: caller.scope,
        effect: "allow",
      });
    const prompt = vi.spyOn(bridge, "promptAgent").mockRejectedValue(new Error("SECRET_FAILURE"));
    const reworked = await service.rework(caller, task.id, "Missing case", "Add case");
    expect(reworked.status).toBe("WAITING_INPUT");
    expect(reworked.activeAttemptId).not.toBe(task.activeAttemptId);
    expect((await store.tasks.getAttempt(task.activeAttemptId!))?.status).toBe("review");
    expect(await store.tasks.listAttempts(task.id)).toHaveLength(2);
    expect(await store.tasks.getWorkerBinding(reworked.activeAttemptId!)).not.toBeNull();
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(await store.tasks.listTraceEvents({ taskId: task.id }))).not.toContain(
      "SECRET_FAILURE",
    );
  } finally {
    await store.close();
  }
});

it("retains a Task and binding when dispatch fails without silently retrying the worker", async () => {
  const store = await openDomainStore({ databasePath: ":memory:" });
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
  try {
    await store.identities.bindOwner("owner", caller.scope);
    await store.authorization.registerResource({
      id: "agent-operations",
      kind: "ops",
      visibility: "public",
    });
    await store.authorization.grant({
      principalId: "owner",
      resourceId: "agent-operations",
      action: "task:delegate",
      scope: caller.scope,
      effect: "allow",
    });
    const bridge = new FakeHerdrBridge();
    const start = vi.spyOn(bridge, "startAgent");
    const prompt = vi
      .spyOn(bridge, "promptAgent")
      .mockRejectedValue(new Error("PRIVATE_ERROR_PAYLOAD"));
    const task = await new AuthorizedOpsService(store, bridge).delegate(caller, {
      title: "Durable dispatch",
      workspaceId: "isolated",
      agentKind: "pi",
      prompt: "Bounded coding instruction",
    });
    expect(task).toMatchObject({
      status: "WAITING_INPUT",
      description: "Bounded coding instruction",
    });
    expect(await store.tasks.getWorkerBinding(task.activeAttemptId!)).not.toBeNull();
    expect(await store.tasks.listTasks()).toHaveLength(1);
    expect(start).toHaveBeenCalledTimes(1);
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(await store.tasks.listAttentionItems()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ taskId: task.id, kind: "ops_connection_problem" }),
      ]),
    );
    const trace = await store.tasks.listTraceEvents({ taskId: task.id });
    expect(trace).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "task.status_changed",
          data: { status: "WAITING_INPUT", reason: "worker_dispatch_incomplete" },
        }),
      ]),
    );
    expect(JSON.stringify(trace)).not.toContain("PRIVATE_ERROR_PAYLOAD");
  } finally {
    await store.close();
  }
});

it("filters Task reads before loading payloads and cancels an undelegated Task", async () => {
  const store = await openDomainStore({ databasePath: ":memory:" });
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
  try {
    await store.identities.bindOwner("owner", caller.scope);
    await store.authorization.registerResource({
      id: "agent-operations",
      kind: "ops",
      visibility: "public",
    });
    const bridge = new FakeHerdrBridge();
    const service = new AuthorizedOpsService(store, bridge);
    await expect(service.create(caller, { title: "No authority" })).rejects.toBeInstanceOf(
      AccessDeniedError,
    );
    expect(await store.tasks.listTasks()).toEqual([]);
    for (const action of ["task:create", "task:list"]) {
      await store.authorization.grant({
        principalId: "owner",
        resourceId: "agent-operations",
        action,
        scope: caller.scope,
        effect: "allow",
      });
    }
    const visible = await service.create(caller, { title: "Visible task" });
    const hidden = await service.create(caller, { title: "Protected canary" });
    expect(await service.list(caller)).toEqual([]);
    await expect(service.get(caller, hidden.id)).rejects.toBeInstanceOf(AccessDeniedError);
    const grant = await store.authorization.grant({
      principalId: "owner",
      resourceId: `task-${visible.id}`,
      action: "task:read",
      scope: caller.scope,
      effect: "allow",
    });
    expect((await service.list(caller)).map((task) => task.id)).toEqual([visible.id]);
    expect(await service.get(caller, visible.id)).toMatchObject({ title: "Visible task" });
    await store.authorization.revoke(grant);
    expect(await service.list(caller)).toEqual([]);
    await expect(service.workerStatus(caller, visible.id)).rejects.toBeInstanceOf(
      AccessDeniedError,
    );
    await store.authorization.grant({
      principalId: "owner",
      resourceId: `task-${visible.id}`,
      action: "task:cancel",
      scope: caller.scope,
      effect: "allow",
    });
    await service.cancel(caller, visible.id);
    expect((await store.tasks.getTask(visible.id))?.status).toBe("CANCELED");
    expect((await bridge.getSnapshot()).workspaces).toEqual([]);
  } finally {
    await store.close();
  }
});

it("delegation does not mint worker control or task acceptance authority", async () => {
  const store = await openDomainStore({ databasePath: ":memory:" });
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
  try {
    await store.identities.bindOwner("owner", caller.scope);
    await store.authorization.registerResource({
      id: "agent-operations",
      kind: "ops",
      visibility: "public",
    });
    await store.authorization.grant({
      principalId: "owner",
      resourceId: "agent-operations",
      action: "task:delegate",
      scope: caller.scope,
      effect: "allow",
    });
    const bridge = new FakeHerdrBridge();
    const service = new AuthorizedOpsService(store, bridge);
    const task = await service.delegate(caller, {
      title: "Bounded task",
      workspaceId: "isolated",
      agentKind: "test",
      prompt: "Do the task",
    });
    await store.authorization.grant({
      principalId: "owner",
      resourceId: "agent-operations",
      action: "ops:status",
      scope: caller.scope,
      effect: "allow",
    });
    await store.tasks.createTask({ title: "Unrelated private task", creatorPrincipalId: "owner" });
    await store.tasks.createAttentionItem({
      kind: "task_review",
      taskId: task.id,
      summary: "Protected review",
    });
    expect(await service.status(caller)).toMatchObject({
      tasks: { open: 0 },
      workers: { total: 0 },
      attention: { total: 0 },
    });
    const readGrant = await store.authorization.grant({
      principalId: "owner",
      resourceId: `task-${task.id}`,
      action: "task:read",
      scope: caller.scope,
      effect: "allow",
    });
    expect(await service.status(caller)).toMatchObject({
      tasks: { open: 1 },
      workers: { total: 1 },
      attention: { total: 1 },
    });
    await store.authorization.revoke(readGrant);
    expect(await service.status(caller)).toMatchObject({
      tasks: { open: 0 },
      workers: { total: 0 },
      attention: { total: 0 },
    });
    await expect(service.readWorker(caller, task.id)).rejects.toBeInstanceOf(AccessDeniedError);
    await expect(service.promptWorker(caller, task.id, "Do more")).rejects.toBeInstanceOf(
      AccessDeniedError,
    );
    const oldBinding = (await store.tasks.getWorkerBinding(task.activeAttemptId!))!;
    await store.tasks.observeWorker(
      {
        herdrSession: oldBinding.herdrSession,
        workspaceId: oldBinding.workspaceId,
        paneId: oldBinding.paneId,
      },
      "done",
    );
    const reworkGrants: string[] = [];
    for (const action of ["task:rework", "worker:prompt"]) {
      reworkGrants.push(
        await store.authorization.grant({
          principalId: "owner",
          resourceId: `task-${task.id}`,
          action,
          scope: caller.scope,
          effect: "allow",
        }),
      );
    }
    await service.rework(caller, task.id, "Missing check", "Run the missing check");
    const reworked = (await store.tasks.getTask(task.id))!;
    const newBinding = (await store.tasks.getWorkerBinding(reworked.activeAttemptId!))!;
    expect(newBinding.paneId).not.toBe(oldBinding.paneId);
    expect(reworked.activeAttemptId).not.toBe(task.activeAttemptId);
    await store.tasks.observeWorker(
      {
        herdrSession: oldBinding.herdrSession,
        workspaceId: oldBinding.workspaceId,
        paneId: oldBinding.paneId,
      },
      "done",
    );
    expect((await store.tasks.getTask(task.id))?.status).not.toBe("REVIEW");
    await store.tasks.observeWorker(
      {
        herdrSession: newBinding.herdrSession,
        workspaceId: newBinding.workspaceId,
        paneId: newBinding.paneId,
      },
      "done",
    );
    expect((await store.tasks.getTask(task.id))?.status).toBe("REVIEW");
    for (const grant of reworkGrants) await store.authorization.revoke(grant);
    await expect(service.accept(caller, task.id)).rejects.toBeInstanceOf(AccessDeniedError);
    await expect(service.rework(caller, task.id, "Redo", "Do more")).rejects.toBeInstanceOf(
      AccessDeniedError,
    );
    await expect(service.cancel(caller, task.id)).rejects.toBeInstanceOf(AccessDeniedError);
    await store.authorization.grant({
      principalId: "owner",
      resourceId: `task-${task.id}`,
      action: "worker:read",
      scope: caller.scope,
      effect: "allow",
    });
    await expect(service.readWorker(caller, task.id)).resolves.toHaveProperty("output");
    await expect(service.promptWorker(caller, task.id, "Do more")).rejects.toBeInstanceOf(
      AccessDeniedError,
    );
  } finally {
    await store.close();
  }
});
