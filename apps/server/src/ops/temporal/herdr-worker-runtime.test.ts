import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vite-plus/test";
import type { TaskStep } from "@glassbox/contracts";
import { openDomainStore } from "../../application/domain-store.js";
import { WorkspaceRegistry } from "../../workspace/registry.js";
import { WorkspaceWriteOccupancy } from "../../workspace/write-occupancy.js";
import { FakeHerdrBridge } from "../fake-herdr-bridge.js";
import { AuthorizedOpsService } from "../service.js";
import { DEFAULT_TASK_GRAPH_LIMITS } from "../task-graph.js";
import { createAdvanceLongWorkActivity } from "./activity.js";
import { HerdrWorkerRuntime } from "./herdr-worker-runtime.js";

it("dispatches one Worker, reviews and cancels it safely, and quarantines an uncertain launch", async () => {
  const directory = await mkdtemp(join(tmpdir(), "glassbox-p6-worker-"));
  const dataRoot = join(directory, "data");
  const project = join(directory, "project");
  await mkdir(project);
  const databasePath = join(dataRoot, "glassbox.db");
  const store = await openDomainStore({ databasePath });
  try {
    const caller = {
      principalId: "owner",
      scope: {
        connectionId: "test",
        botId: "bot",
        chatType: "private" as const,
        chatId: "owner",
        senderId: "owner",
      },
    };
    await store.identities.bindOwner("owner", caller.scope);
    const registry = await WorkspaceRegistry.open({ dataRoot });
    const workspace = await registry.registerExistingTrusted({
      path: project,
      label: "disposable-project",
      ownerPrincipalId: "owner",
    });
    const policy = {
      databasePath,
      contextDirectory: join(dataRoot, "worker-contexts"),
      resourceId: "worker-workspace:disposable",
    };
    for (const resource of [
      { id: policy.resourceId, kind: "worker-files", visibility: "public" as const },
      { id: `workspace:${workspace.id}`, kind: "workspace", visibility: "public" as const },
    ])
      await store.authorization.registerResource(resource);
    const task = await store.tasks.createTask({
      title: "Durable coding work",
      creatorPrincipalId: "owner",
      authorizationScope: caller.scope,
    });
    for (const [resourceId, action] of [
      [`task-${task.id}`, "task:continue"],
      [`task-${task.id}`, "task:delegate"],
      [policy.resourceId, "worker:file:write"],
      [`workspace:${workspace.id}`, "workspace:write"],
    ])
      await store.authorization.grant({
        principalId: "owner",
        resourceId: resourceId!,
        action: action!,
        scope: caller.scope,
        effect: "allow",
      });
    const now = new Date().toISOString();
    const step: TaskStep = {
      id: "worker-step",
      taskId: task.id,
      kind: "herdr_worker",
      title: "Edit the project",
      instructions: "Create a small source file and report the result",
      status: "pending",
      dependencyIds: [],
      dependencyPolicy: { failed: "block", cancelled: "cancel", skipped: "skip" },
      maxAttempts: 1,
      requiredCapabilities: [],
      delegatedPermissionSet: [
        { resourceId: policy.resourceId, action: "worker:file:write" },
        { resourceId: `workspace:${workspace.id}`, action: "workspace:write" },
      ],
      version: 1,
      createdAt: now,
      updatedAt: now,
    };
    await store.longWork.createGraph(task.id, [step], step.id, DEFAULT_TASK_GRAPH_LIMITS, {
      kind: "system",
      reason: "test plan",
    });
    const bridge = new FakeHerdrBridge("session-1");
    const writes = new WorkspaceWriteOccupancy(dataRoot, "participant");
    const service = new AuthorizedOpsService(store, bridge, policy, undefined, {
      registry,
      writes,
    });
    await store.authorization.grant({
      principalId: "owner",
      resourceId: `task-${task.id}`,
      action: "task:plan",
      scope: caller.scope,
      effect: "allow",
    });
    expect(await service.plannedWorkerPermissions(caller, task.id, project, "write")).toEqual(
      step.delegatedPermissionSet,
    );
    const workers = new HerdrWorkerRuntime(store, service, bridge, {
      workspaceId: "herdr-workspace",
      agentKind: "pi",
      worktreePath: project,
    });
    let advance = createAdvanceLongWorkActivity(store, workers);
    const input = { taskId: task.id, policyRevision: 1 };
    expect(await advance(input)).toEqual({ kind: "continue" });
    const attempt = (await store.tasks.listAttempts(task.id))[0]!;
    const binding = await store.tasks.getWorkerBinding(attempt.id);
    expect(binding?.promptDispatchedAt).toBeTruthy();
    expect((await store.longWork.getActiveLease(task.id, step.id))?.workerBindingId).toBe(
      binding?.id,
    );
    expect((await store.longWork.listSteps(task.id))[0]?.status).toBe("running");
    expect(writes.status(workspace.id)).toBe("active");
    expect((await bridge.getSnapshot()).workspaces[0]?.panes).toHaveLength(1);
    await bridge.disconnect();
    expect((await advance(input)).kind).toBe("wait");
    expect(await store.tasks.listAttempts(task.id)).toHaveLength(1);
    await bridge.connect();
    const reconnectedSnapshot = await bridge.getSnapshot();
    expect(
      reconnectedSnapshot.workspaces.flatMap((entry) => entry.panes).map((pane) => pane.paneId),
    ).toEqual([binding!.paneId]);
    expect((await advance(input)).kind).toBe("wait");
    expect(await store.tasks.listAttempts(task.id)).toHaveLength(1);
    const reconnectedBinding = await store.tasks.getWorkerBinding(attempt.id);
    expect(reconnectedBinding?.id).toBe(binding?.id);
    expect(reconnectedBinding?.paneId).toBe(binding?.paneId);
    expect(reconnectedBinding?.taskAttemptId).toBe(attempt.id);
    const beforeStale = await store.longWork.getActiveLease(task.id, step.id);
    const currentSnapshot = await bridge.getSnapshot();
    vi.spyOn(bridge, "getSnapshot").mockResolvedValueOnce({
      ...currentSnapshot,
      timestamp: "1970-01-01T00:00:00.000Z",
    });
    expect((await advance(input)).kind).toBe("wait");
    expect((await store.longWork.getActiveLease(task.id, step.id))?.version).toBe(
      beforeStale?.version,
    );
    const oldAdvance = advance;
    const recoveredWorkers = new HerdrWorkerRuntime(store, service, bridge, {
      workspaceId: "herdr-workspace",
      agentKind: "pi",
      worktreePath: project,
    });
    advance = createAdvanceLongWorkActivity(store, recoveredWorkers);
    expect((await advance(input)).kind).toBe("wait");
    expect((await store.longWork.getActiveLease(task.id, step.id))?.version).toBe(
      beforeStale?.version,
    );
    await store.db.transaction(async (tx) => {
      await tx.execute({
        sql: "UPDATE task_step_leases SET expires_at = ? WHERE id = ?",
        args: ["2000-01-01T00:00:00.000Z", beforeStale!.id],
      });
    });
    expect((await advance(input)).kind).toBe("wait");
    const recoveredLease = await store.longWork.getActiveLease(task.id, step.id);
    expect(recoveredLease?.ownerInstanceId).toBe(recoveredWorkers.ownerInstanceId);
    expect(recoveredLease?.version).toBeGreaterThan(beforeStale!.version);
    expect(await store.tasks.listAttempts(task.id)).toHaveLength(1);
    expect(
      (await store.longWork.listEvents(task.id)).filter(
        (event) => event.type === "WORKER_RECOVERED",
      ),
    ).toHaveLength(1);
    await expect(
      store.longWork.updateLease({
        taskId: task.id,
        leaseId: recoveredLease!.id,
        ownerInstanceId: workers.ownerInstanceId,
        expectedVersion: recoveredLease!.version,
        action: "heartbeat",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        origin: { kind: "system", reason: "stale process test" },
      }),
    ).rejects.toThrow("Lease version conflict");
    expect((await oldAdvance(input)).kind).toBe("wait");
    expect((await store.longWork.getActiveLease(task.id, step.id))?.version).toBe(
      recoveredLease?.version,
    );
    expect((await advance(input)).kind).toBe("wait");
    expect(await store.tasks.listAttempts(task.id)).toHaveLength(1);
    bridge.simulateAgentState(binding!.paneId, "done", "Candidate Worker result");
    expect(await advance(input)).toEqual({ kind: "continue" });
    expect((await store.longWork.listSteps(task.id))[0]).toMatchObject({
      status: "review",
      outputRef: `worker-result:${attempt.id}`,
    });
    expect(await store.longWork.getWorkerCandidate(task.id, step.id, attempt.id)).toMatchObject({
      outputExcerpt: "Candidate Worker result",
      truncated: false,
      workerBindingId: binding!.id,
    });
    await expect(service.workerCandidate(caller, task.id, step.id, attempt.id)).rejects.toThrow();
    for (const [resourceId, action] of [
      [`task-${task.id}`, "task:read"],
      [`task-${task.id}`, "worker:read"],
      [policy.resourceId, "worker:file:read"],
    ])
      await store.authorization.grant({
        principalId: "owner",
        resourceId: resourceId!,
        action: action!,
        scope: caller.scope,
        effect: "allow",
      });
    const workspaceRead = await store.authorization.grant({
      principalId: "owner",
      resourceId: `workspace:${workspace.id}`,
      action: "workspace:read",
      scope: caller.scope,
      effect: "allow",
    });
    expect(await service.workerCandidate(caller, task.id, step.id, attempt.id)).toMatchObject({
      outputExcerpt: "Candidate Worker result",
    });
    await store.authorization.revoke(workspaceRead);
    await expect(service.workerCandidate(caller, task.id, step.id, attempt.id)).rejects.toThrow();
    expect((await store.tasks.getTask(task.id))?.status).not.toBe("DONE");
    await store.authorization.grant({
      principalId: "owner",
      resourceId: `task-${task.id}`,
      action: "task:accept",
      scope: caller.scope,
      effect: "allow",
    });
    const reviewed = (await store.longWork.listSteps(task.id))[0]!;
    await service.acceptStep(caller, task.id, step.id, reviewed.version);
    expect(writes.status(workspace.id)).toBe("free");
    expect((await bridge.getSnapshot()).workspaces[0]?.panes).toHaveLength(0);
    expect(await store.longWork.getWorkerCandidate(task.id, step.id, attempt.id)).toMatchObject({
      outputExcerpt: "Candidate Worker result",
    });

    const cancelledTask = await store.tasks.createTask({
      title: "Cancel active coding work",
      creatorPrincipalId: "owner",
      authorizationScope: caller.scope,
    });
    for (const action of ["task:continue", "task:delegate", "task:cancel"])
      await store.authorization.grant({
        principalId: "owner",
        resourceId: `task-${cancelledTask.id}`,
        action,
        scope: caller.scope,
        effect: "allow",
      });
    const cancelStep = {
      ...step,
      id: "cancel-worker-step",
      taskId: cancelledTask.id,
    };
    await store.longWork.createGraph(
      cancelledTask.id,
      [cancelStep],
      cancelStep.id,
      DEFAULT_TASK_GRAPH_LIMITS,
      { kind: "system", reason: "test cancellation" },
    );
    const cancelInput = { taskId: cancelledTask.id, policyRevision: 1 };
    expect(await advance(cancelInput)).toEqual({ kind: "continue" });
    expect(writes.status(workspace.id)).toBe("active");
    expect(await service.cancel(caller, cancelledTask.id)).toBe(false);
    expect(await advance(cancelInput)).toEqual({ kind: "continue" });
    expect((await store.longWork.listSteps(cancelledTask.id))[0]?.status).toBe("cancelled");
    expect(await advance(cancelInput)).toEqual({ kind: "complete" });
    expect((await store.tasks.getTask(cancelledTask.id))?.status).toBe("CANCELED");
    expect(writes.status(workspace.id)).toBe("free");

    const revokedTask = await store.tasks.createTask({
      title: "Revoke while Worker runs",
      creatorPrincipalId: "owner",
      authorizationScope: caller.scope,
    });
    await store.authorization.grant({
      principalId: "owner",
      resourceId: `task-${revokedTask.id}`,
      action: "task:continue",
      scope: caller.scope,
      effect: "allow",
    });
    const delegatedGrant = await store.authorization.grant({
      principalId: "owner",
      resourceId: `task-${revokedTask.id}`,
      action: "task:delegate",
      scope: caller.scope,
      effect: "allow",
    });
    const revokedStep = { ...step, id: "revoked-worker-step", taskId: revokedTask.id };
    await store.longWork.createGraph(
      revokedTask.id,
      [revokedStep],
      revokedStep.id,
      DEFAULT_TASK_GRAPH_LIMITS,
      { kind: "system", reason: "test revocation" },
    );
    const revokedInput = { taskId: revokedTask.id, policyRevision: 1 };
    expect(await advance(revokedInput)).toEqual({ kind: "continue" });
    const revokedAttempt = (await store.tasks.listAttempts(revokedTask.id))[0]!;
    const revokedBinding = await store.tasks.getWorkerBinding(revokedAttempt.id);
    await store.authorization.revoke(delegatedGrant);
    bridge.simulateAgentState(revokedBinding!.paneId, "done");
    expect(await advance(revokedInput)).toEqual({ kind: "continue" });
    expect((await store.longWork.listSteps(revokedTask.id))[0]?.status).toBe("blocked");
    expect(writes.status(workspace.id)).toBe("free");
    expect((await bridge.getSnapshot()).workspaces[0]?.panes).toHaveLength(0);

    const uncertainTask = await store.tasks.createTask({
      title: "Uncertain launch",
      creatorPrincipalId: "owner",
      authorizationScope: caller.scope,
    });
    for (const action of ["task:continue", "task:delegate"])
      await store.authorization.grant({
        principalId: "owner",
        resourceId: `task-${uncertainTask.id}`,
        action,
        scope: caller.scope,
        effect: "allow",
      });
    const uncertainStep = { ...step, id: "uncertain-worker-step", taskId: uncertainTask.id };
    await store.longWork.createGraph(
      uncertainTask.id,
      [uncertainStep],
      uncertainStep.id,
      DEFAULT_TASK_GRAPH_LIMITS,
      { kind: "system", reason: "test uncertain launch" },
    );
    const startAgent = bridge.startAgent.bind(bridge);
    vi.spyOn(bridge, "startAgent").mockImplementationOnce(async (params) => {
      await startAgent(params);
      throw new Error("transport lost after Herdr started the Worker");
    });
    const uncertainInput = { taskId: uncertainTask.id, policyRevision: 1 };
    expect(await advance(uncertainInput)).toEqual({ kind: "continue" });
    expect((await store.longWork.listSteps(uncertainTask.id))[0]?.status).toBe("blocked");
    expect(await store.tasks.listAttempts(uncertainTask.id)).toHaveLength(1);
    expect(writes.status(workspace.id)).toBe("quarantined");
    expect(await advance(uncertainInput)).toEqual({ kind: "wait" });
    expect(await store.tasks.listAttempts(uncertainTask.id)).toHaveLength(1);
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 2, retryDelay: 50 }).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code !== "EBUSY") throw error;
      },
    );
  }
});
