import { expect, it, vi } from "vite-plus/test";
import { openDomainStore, AccessDeniedError, type CallerContext } from "../persistence/index.js";
import { FakeHerdrBridge } from "./fake-herdr-bridge.js";
import { AuthorizedOpsService } from "./service.js";

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
