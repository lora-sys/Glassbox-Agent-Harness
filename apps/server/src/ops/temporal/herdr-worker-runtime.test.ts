import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
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

it("captures a declared Worker text file before review and rechecks grants when reading it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "glassbox-p6-worker-artifact-"));
  const dataRoot = join(directory, "data");
  const project = join(directory, "project");
  await mkdir(join(project, "reports"), { recursive: true });
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
    await store.identities.bindOwner(caller.principalId, caller.scope);
    const registry = await WorkspaceRegistry.open({ dataRoot });
    const workspace = await registry.registerExistingTrusted({
      path: project,
      label: "artifact-project",
      ownerPrincipalId: caller.principalId,
    });
    const policy = {
      databasePath,
      contextDirectory: join(dataRoot, "worker-contexts"),
      resourceId: "worker-workspace:artifact",
    };
    for (const resource of [
      { id: policy.resourceId, kind: "worker-files", visibility: "public" as const },
      { id: `workspace:${workspace.id}`, kind: "workspace", visibility: "public" as const },
    ])
      await store.authorization.registerResource(resource);
    const task = await store.tasks.createTask({
      title: "Capture Worker file",
      creatorPrincipalId: caller.principalId,
      authorizationScope: caller.scope,
    });
    const grants = new Map<string, string>();
    for (const [resourceId, action] of [
      [`task-${task.id}`, "task:continue"],
      [`task-${task.id}`, "task:delegate"],
      [`task-${task.id}`, "task:read"],
      [`task-${task.id}`, "worker:read"],
      [policy.resourceId, "worker:file:write"],
      [policy.resourceId, "worker:file:read"],
      [`workspace:${workspace.id}`, "workspace:write"],
      [`workspace:${workspace.id}`, "workspace:read"],
    ]) {
      const grantId = await store.authorization.grant({
        principalId: caller.principalId,
        resourceId: resourceId!,
        action: action!,
        scope: caller.scope,
        effect: "allow",
      });
      grants.set(`${resourceId}:${action}`, grantId);
    }
    const now = new Date().toISOString();
    const step: TaskStep = {
      id: "worker-file-step",
      taskId: task.id,
      kind: "herdr_worker",
      title: "Write the declared file",
      instructions: "Write the result and finish",
      specRef: "worker:text-file:reports/result.txt",
      status: "pending",
      dependencyIds: [],
      dependencyPolicy: { failed: "block", cancelled: "cancel", skipped: "skip" },
      maxAttempts: 1,
      requiredCapabilities: [],
      delegatedPermissionSet: [
        { resourceId: policy.resourceId, action: "worker:file:write" },
        { resourceId: policy.resourceId, action: "worker:file:read" },
        { resourceId: `workspace:${workspace.id}`, action: "workspace:write" },
        { resourceId: `workspace:${workspace.id}`, action: "workspace:read" },
      ],
      version: 1,
      createdAt: now,
      updatedAt: now,
    };
    await store.longWork.createGraph(task.id, [step], step.id, DEFAULT_TASK_GRAPH_LIMITS, {
      kind: "system",
      reason: "test plan",
    });
    const bridge = new FakeHerdrBridge("artifact-session");
    const service = new AuthorizedOpsService(store, bridge, policy, undefined, {
      registry,
      writes: new WorkspaceWriteOccupancy(dataRoot, "participant"),
    });
    const workers = new HerdrWorkerRuntime(store, service, bridge, {
      workspaceId: "herdr-workspace",
      agentKind: "pi",
      worktreePath: project,
    });
    const advance = createAdvanceLongWorkActivity(store, workers);
    const input = { taskId: task.id, policyRevision: 1 };
    expect(await advance(input)).toEqual({ kind: "continue" });
    expect((await store.longWork.listSteps(task.id))[0]).toMatchObject({ status: "running" });
    const attempt = (await store.tasks.listAttempts(task.id))[0]!;
    const binding = (await store.tasks.getWorkerBinding(attempt.id))!;
    await writeFile(join(project, "reports", "result.txt"), "Verified Worker result\n", "utf8");
    bridge.simulateAgentState(binding.paneId, "done", "Worker finished");
    expect(await advance(input)).toEqual({ kind: "continue" });
    expect((await store.longWork.listSteps(task.id))[0]).toMatchObject({ status: "review" });
    expect(await store.longWork.getWorkerFileArtifact(task.id, step.id, attempt.id)).toMatchObject({
      relativePath: "reports/result.txt",
      contentText: "Verified Worker result\n",
      workerBindingId: binding.id,
    });
    expect(await service.workerCandidate(caller, task.id, step.id, attempt.id)).toMatchObject({
      fileArtifact: {
        relativePath: "reports/result.txt",
        contentExcerpt: "Verified Worker result\n",
        truncated: false,
      },
    });
    await store.authorization.revoke(grants.get(`${policy.resourceId}:worker:file:read`)!);
    await expect(service.workerCandidate(caller, task.id, step.id, attempt.id)).rejects.toThrow();
    await store.authorization.grant({
      principalId: caller.principalId,
      resourceId: policy.resourceId,
      action: "worker:file:read",
      scope: caller.scope,
      effect: "allow",
    });
    await store.authorization.grant({
      principalId: caller.principalId,
      resourceId: `task-${task.id}`,
      action: "task:accept",
      scope: caller.scope,
      effect: "allow",
    });
    const reviewed = (await store.longWork.listSteps(task.id))[0]!;
    await service.acceptStep(caller, task.id, step.id, reviewed.version);

    const recoveryTask = await store.tasks.createTask({
      title: "Recover captured Worker file",
      creatorPrincipalId: caller.principalId,
      authorizationScope: caller.scope,
    });
    for (const action of ["task:continue", "task:delegate", "task:read", "worker:read"])
      await store.authorization.grant({
        principalId: caller.principalId,
        resourceId: `task-${recoveryTask.id}`,
        action,
        scope: caller.scope,
        effect: "allow",
      });
    const recoveryStep: TaskStep = {
      ...step,
      id: "recovery-file-step",
      taskId: recoveryTask.id,
      specRef: "worker:text-file:reports/recovery.txt",
    };
    await store.longWork.createGraph(
      recoveryTask.id,
      [recoveryStep],
      recoveryStep.id,
      DEFAULT_TASK_GRAPH_LIMITS,
      { kind: "system", reason: "capture recovery test" },
    );
    const recoveryInput = { taskId: recoveryTask.id, policyRevision: 1 };
    expect(await advance(recoveryInput)).toEqual({ kind: "continue" });
    const recoveryAttempt = (await store.tasks.listAttempts(recoveryTask.id))[0]!;
    const recoveryBinding = (await store.tasks.getWorkerBinding(recoveryAttempt.id))!;
    const recoveryLease = (await store.longWork.getActiveLease(recoveryTask.id, recoveryStep.id))!;
    const runningRecoveryStep = (await store.longWork.listSteps(recoveryTask.id))[0]!;
    const firstContent = "First captured file\n";
    await writeFile(join(project, "reports", "recovery.txt"), firstContent, "utf8");
    bridge.simulateAgentState(recoveryBinding.paneId, "done", "First captured terminal output");
    await store.longWork.recordWorkerCandidate({
      taskId: recoveryTask.id,
      stepId: recoveryStep.id,
      attemptId: recoveryAttempt.id,
      leaseId: recoveryLease.id,
      ownerInstanceId: recoveryLease.ownerInstanceId,
      workerBindingId: recoveryBinding.id,
      expectedStepVersion: runningRecoveryStep.version,
      expectedLeaseVersion: recoveryLease.version,
      output: "First captured terminal output",
      artifact: {
        relativePath: "reports/recovery.txt",
        contentText: firstContent,
        sha256: createHash("sha256").update(firstContent).digest("hex"),
      },
    });
    await rm(join(project, "reports", "recovery.txt"));
    expect(await advance(recoveryInput)).toEqual({ kind: "continue" });
    expect((await store.longWork.listSteps(recoveryTask.id))[0]).toMatchObject({
      status: "review",
    });
    expect(
      await service.workerCandidate(caller, recoveryTask.id, recoveryStep.id, recoveryAttempt.id),
    ).toMatchObject({ fileArtifact: { contentExcerpt: firstContent } });
    await store.authorization.grant({
      principalId: caller.principalId,
      resourceId: `task-${recoveryTask.id}`,
      action: "task:accept",
      scope: caller.scope,
      effect: "allow",
    });
    const reviewedRecoveryStep = (await store.longWork.listSteps(recoveryTask.id))[0]!;
    await service.acceptStep(
      caller,
      recoveryTask.id,
      recoveryStep.id,
      reviewedRecoveryStep.version,
    );

    const missingTask = await store.tasks.createTask({
      title: "Missing Worker result file",
      creatorPrincipalId: caller.principalId,
      authorizationScope: caller.scope,
    });
    for (const action of ["task:continue", "task:delegate", "task:read", "worker:read"])
      await store.authorization.grant({
        principalId: caller.principalId,
        resourceId: `task-${missingTask.id}`,
        action,
        scope: caller.scope,
        effect: "allow",
      });
    const missingStep: TaskStep = {
      ...step,
      id: "missing-file-step",
      taskId: missingTask.id,
      specRef: "worker:text-file:reports/missing.txt",
    };
    await store.longWork.createGraph(
      missingTask.id,
      [missingStep],
      missingStep.id,
      DEFAULT_TASK_GRAPH_LIMITS,
      { kind: "system", reason: "missing result test" },
    );
    const missingInput = { taskId: missingTask.id, policyRevision: 1 };
    expect(await advance(missingInput)).toEqual({ kind: "continue" });
    const missingAttempt = (await store.tasks.listAttempts(missingTask.id))[0]!;
    const missingBinding = (await store.tasks.getWorkerBinding(missingAttempt.id))!;
    bridge.simulateAgentState(missingBinding.paneId, "done", "Worker says done without file");
    expect(await advance(missingInput)).toEqual({ kind: "continue" });
    expect((await store.longWork.listSteps(missingTask.id))[0]).toMatchObject({
      status: "blocked",
    });
    expect(
      await store.longWork.getWorkerFileArtifact(missingTask.id, missingStep.id, missingAttempt.id),
    ).toBeNull();
    expect((await store.tasks.getTask(missingTask.id))?.status).not.toBe("DONE");
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 2, retryDelay: 50 }).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code !== "EBUSY") throw error;
      },
    );
  }
});

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
    const beforeReviewStep = (await store.longWork.listSteps(task.id))[0]!;
    const beforeReviewLease = (await store.longWork.getActiveLease(task.id, step.id))!;
    await store.longWork.recordWorkerCandidate({
      taskId: task.id,
      stepId: step.id,
      attemptId: attempt.id,
      leaseId: beforeReviewLease.id,
      ownerInstanceId: beforeReviewLease.ownerInstanceId,
      workerBindingId: binding!.id,
      expectedStepVersion: beforeReviewStep.version,
      expectedLeaseVersion: beforeReviewLease.version,
      output: "Candidate Worker result",
    });
    const beforeReviewGrants = [];
    for (const [resourceId, action] of [
      [`task-${task.id}`, "task:read"],
      [`task-${task.id}`, "worker:read"],
      [policy.resourceId, "worker:file:read"],
      [`workspace:${workspace.id}`, "workspace:read"],
    ])
      beforeReviewGrants.push(
        await store.authorization.grant({
          principalId: "owner",
          resourceId: resourceId!,
          action: action!,
          scope: caller.scope,
          effect: "allow",
        }),
      );
    expect(await service.workerCandidate(caller, task.id, step.id, attempt.id)).toBeNull();
    for (const grant of beforeReviewGrants) await store.authorization.revoke(grant);
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
    await store.authorization.grant({
      principalId: "owner",
      resourceId: `workspace:${workspace.id}`,
      action: "workspace:read",
      scope: caller.scope,
      effect: "allow",
    });
    await store.conversations.createAgent("personal");
    await store.authorization.grant({
      principalId: "owner",
      resourceId: "agent:personal",
      action: "run:create",
      scope: caller.scope,
      effect: "allow",
    });
    const origin = await store.conversations.acceptIncoming({
      agentId: "personal",
      scope: caller.scope,
      messageId: "worker-origin",
      text: "Plan protected Worker work",
      executionRef: "pi:test",
    });
    await store.db.transaction(async (tx) => {
      await tx.execute({
        sql: "UPDATE tasks SET run_id = ? WHERE id = ?",
        args: [origin.run.id, task.id],
      });
    });
    await store.authorization.registerResource({
      id: "worker-plan-source",
      kind: "document",
      visibility: "private",
    });
    const sourceGrant = await store.authorization.grant({
      principalId: "owner",
      resourceId: "worker-plan-source",
      action: "read",
      scope: caller.scope,
      effect: "allow",
    });
    const sourceDecision = await store.authorization.check({
      caller,
      resourceId: "worker-plan-source",
      action: "read",
      runId: origin.run.id,
      conversationId: origin.conversation.id,
    });
    expect(sourceDecision.decision).toBe("ALLOW");
    await store.authorization.markDeliverySource(sourceDecision.id, "content_source");
    expect(await service.workerCandidate(caller, task.id, step.id, attempt.id)).toMatchObject({
      outputExcerpt: "Candidate Worker result",
    });
    const inspector = await store.conversations.acceptIncoming({
      agentId: "personal",
      scope: caller.scope,
      messageId: "worker-result-inspection",
      text: "Inspect the Worker result",
      executionRef: "pi:test",
    });
    expect(
      await service.workerCandidate(caller, task.id, step.id, attempt.id, {
        runId: inspector.run.id,
        conversationId: inspector.conversation.id,
      }),
    ).toMatchObject({ outputExcerpt: "Candidate Worker result" });
    await store.authorization.revoke(sourceGrant);
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

    const unknownTask = await store.tasks.createTask({
      title: "Cancel a quarantined bound Worker",
      creatorPrincipalId: "owner",
      authorizationScope: caller.scope,
    });
    for (const action of ["task:continue", "task:delegate", "task:cancel"])
      await store.authorization.grant({
        principalId: "owner",
        resourceId: `task-${unknownTask.id}`,
        action,
        scope: caller.scope,
        effect: "allow",
      });
    const unknownStep = { ...step, id: "unknown-bound-step", taskId: unknownTask.id };
    await store.longWork.createGraph(
      unknownTask.id,
      [unknownStep],
      unknownStep.id,
      DEFAULT_TASK_GRAPH_LIMITS,
      { kind: "system", reason: "test bound Worker quarantine" },
    );
    const unknownInput = { taskId: unknownTask.id, policyRevision: 1 };
    expect(await advance(unknownInput)).toEqual({ kind: "continue" });
    const unknownAttempt = (await store.tasks.listAttempts(unknownTask.id))[0]!;
    const unknownBinding = (await store.tasks.getWorkerBinding(unknownAttempt.id))!;
    const runningUnknown = (await store.longWork.listSteps(unknownTask.id))[0]!;
    const activeUnknownLease = (await store.longWork.getActiveLease(
      unknownTask.id,
      unknownStep.id,
    ))!;
    await service.quarantineClaimedWorker(unknownAttempt.id);
    await store.longWork.settleClaimedStep({
      taskId: unknownTask.id,
      stepId: unknownStep.id,
      attemptId: unknownAttempt.id,
      leaseId: activeUnknownLease.id,
      ownerInstanceId: activeUnknownLease.ownerInstanceId,
      expectedStepVersion: runningUnknown.version,
      expectedLeaseVersion: activeUnknownLease.version,
      workerBindingId: unknownBinding.id,
      outcome: "unknown",
      evidenceRef: `worker-response-unknown:${unknownAttempt.id}`,
      origin: { kind: "system", reason: "test unknown Worker" },
    });
    expect(writes.status(workspace.id)).toBe("quarantined");
    expect(await service.cancel(caller, unknownTask.id)).toBe(false);
    expect((await store.longWork.listSteps(unknownTask.id))[0]?.status).toBe("cancelled");
    expect(await advance(unknownInput)).toEqual({ kind: "continue" });
    expect(writes.status(workspace.id)).toBe("free");
    expect((await bridge.getSnapshot()).workspaces[0]?.panes).toHaveLength(0);
    expect(await advance(unknownInput)).toEqual({ kind: "complete" });
    expect((await store.tasks.getTask(unknownTask.id))?.status).toBe("CANCELED");
    expect(
      (await store.longWork.listEvents(unknownTask.id)).some(
        (event) => event.type === "WORKER_LOST",
      ),
    ).toBe(true);

    const reworkTask = await store.tasks.createTask({
      title: "Rework a quarantined bound Worker",
      creatorPrincipalId: "owner",
      authorizationScope: caller.scope,
    });
    for (const action of ["task:continue", "task:delegate", "task:rework", "task:cancel"])
      await store.authorization.grant({
        principalId: "owner",
        resourceId: `task-${reworkTask.id}`,
        action,
        scope: caller.scope,
        effect: "allow",
      });
    const reworkStep = { ...step, id: "rework-unknown-step", taskId: reworkTask.id };
    await store.longWork.createGraph(
      reworkTask.id,
      [reworkStep],
      reworkStep.id,
      DEFAULT_TASK_GRAPH_LIMITS,
      { kind: "system", reason: "test unknown Worker rework" },
    );
    const reworkInput = { taskId: reworkTask.id, policyRevision: 1 };
    expect(await advance(reworkInput)).toEqual({ kind: "continue" });
    const firstReworkAttempt = (await store.tasks.listAttempts(reworkTask.id))[0]!;
    const firstReworkBinding = (await store.tasks.getWorkerBinding(firstReworkAttempt.id))!;
    const firstReworkStep = (await store.longWork.listSteps(reworkTask.id))[0]!;
    const firstReworkLease = (await store.longWork.getActiveLease(reworkTask.id, reworkStep.id))!;
    await service.quarantineClaimedWorker(firstReworkAttempt.id);
    await store.longWork.settleClaimedStep({
      taskId: reworkTask.id,
      stepId: reworkStep.id,
      attemptId: firstReworkAttempt.id,
      leaseId: firstReworkLease.id,
      ownerInstanceId: firstReworkLease.ownerInstanceId,
      expectedStepVersion: firstReworkStep.version,
      expectedLeaseVersion: firstReworkLease.version,
      workerBindingId: firstReworkBinding.id,
      outcome: "unknown",
      evidenceRef: `worker-response-unknown:${firstReworkAttempt.id}`,
      origin: { kind: "system", reason: "test unknown Worker" },
    });
    expect((await store.longWork.listSteps(reworkTask.id))[0]?.status).toBe("blocked");
    await expect(
      service.reworkStep(
        caller,
        reworkTask.id,
        reworkStep.id,
        (await store.longWork.listSteps(reworkTask.id))[0]!.version,
        "Verify old Worker stopped before retry",
      ),
    ).rejects.toThrow();
    expect(await advance(reworkInput)).toEqual({ kind: "continue" });
    expect(writes.status(workspace.id)).toBe("free");
    expect((await store.tasks.listAttempts(reworkTask.id))[0]?.status).toBe("failed");
    await service.reworkStep(
      caller,
      reworkTask.id,
      reworkStep.id,
      (await store.longWork.listSteps(reworkTask.id))[0]!.version,
      "Old Worker closed and result unknown",
    );
    expect(await advance(reworkInput)).toEqual({ kind: "continue" });
    expect(await store.tasks.listAttempts(reworkTask.id)).toHaveLength(2);
    expect((await store.tasks.listAttempts(reworkTask.id))[0]?.id).toBe(firstReworkAttempt.id);
    expect(writes.status(workspace.id)).toBe("active");
    expect(await service.cancel(caller, reworkTask.id)).toBe(false);
    expect(await advance(reworkInput)).toEqual({ kind: "continue" });
    expect(await advance(reworkInput)).toEqual({ kind: "complete" });

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
    const uncertainAttempt = (await store.tasks.listAttempts(uncertainTask.id))[0]!;
    expect(await store.longWork.getWorkerLaunchIntent(uncertainAttempt.id)).toMatchObject({
      taskId: uncertainTask.id,
      stepId: uncertainStep.id,
      agentKind: "pi",
      workspaceId: "herdr-workspace",
    });
    expect(writes.status(workspace.id)).toBe("quarantined");
    const closeAgent = vi
      .spyOn(bridge, "closeAgent")
      .mockRejectedValueOnce(new Error("Herdr close acknowledgement unavailable"));
    expect(await advance(uncertainInput)).toMatchObject({ kind: "wait" });
    expect(
      await store.longWork.getQuarantinedLease(uncertainTask.id, uncertainStep.id),
    ).toBeTruthy();
    expect(writes.status(workspace.id)).toBe("quarantined");
    closeAgent.mockRestore();
    expect(await advance(uncertainInput)).toEqual({ kind: "continue" });
    expect((await store.tasks.listAttempts(uncertainTask.id))[0]?.status).toBe("failed");
    expect(await store.longWork.getQuarantinedLease(uncertainTask.id, uncertainStep.id)).toBeNull();
    expect(writes.status(workspace.id)).toBe("free");
    expect((await bridge.getSnapshot()).workspaces[0]?.panes).toHaveLength(0);
    expect(await store.tasks.listAttempts(uncertainTask.id)).toHaveLength(1);

    const cancelUnboundTask = await store.tasks.createTask({
      title: "Cancel an unbound Worker after a lost launch response",
      creatorPrincipalId: "owner",
      authorizationScope: caller.scope,
    });
    for (const action of ["task:continue", "task:delegate", "task:cancel"])
      await store.authorization.grant({
        principalId: "owner",
        resourceId: `task-${cancelUnboundTask.id}`,
        action,
        scope: caller.scope,
        effect: "allow",
      });
    const cancelUnboundStep = {
      ...step,
      id: "cancel-unbound-step",
      taskId: cancelUnboundTask.id,
    };
    await store.longWork.createGraph(
      cancelUnboundTask.id,
      [cancelUnboundStep],
      cancelUnboundStep.id,
      DEFAULT_TASK_GRAPH_LIMITS,
      { kind: "system", reason: "test unbound Worker cancellation" },
    );
    vi.spyOn(bridge, "startAgent").mockImplementationOnce(async (params) => {
      await startAgent(params);
      throw new Error("transport lost after Herdr started the Worker");
    });
    const cancelUnboundInput = { taskId: cancelUnboundTask.id, policyRevision: 1 };
    expect(await advance(cancelUnboundInput)).toEqual({ kind: "continue" });
    expect(await service.cancel(caller, cancelUnboundTask.id)).toBe(false);
    expect(await advance(cancelUnboundInput)).toEqual({ kind: "continue" });
    expect(await advance(cancelUnboundInput)).toEqual({ kind: "complete" });
    expect((await store.tasks.getTask(cancelUnboundTask.id))?.status).toBe("CANCELED");
    expect(writes.status(workspace.id)).toBe("free");

    const orphanTask = await store.tasks.createTask({
      title: "Recover a Tab created before its response was lost",
      creatorPrincipalId: "owner",
      authorizationScope: caller.scope,
    });
    for (const action of ["task:continue", "task:delegate"])
      await store.authorization.grant({
        principalId: "owner",
        resourceId: `task-${orphanTask.id}`,
        action,
        scope: caller.scope,
        effect: "allow",
      });
    const orphanStep = { ...step, id: "orphan-tab-step", taskId: orphanTask.id };
    await store.longWork.createGraph(
      orphanTask.id,
      [orphanStep],
      orphanStep.id,
      DEFAULT_TASK_GRAPH_LIMITS,
      { kind: "system", reason: "test lost tab.create response" },
    );
    vi.spyOn(bridge, "startAgent").mockImplementationOnce(async (params) => {
      bridge.simulatePreAgentTab({
        workspaceId: params.workspaceId,
        agentName: params.agentName!,
        worktreePath: params.worktreePath!,
      });
      throw new Error("transport lost after tab.create committed");
    });
    const orphanInput = { taskId: orphanTask.id, policyRevision: 1 };
    expect(await advance(orphanInput)).toEqual({ kind: "continue" });
    expect(writes.status(workspace.id)).toBe("quarantined");
    const preAgentClose = vi
      .spyOn(bridge, "closePreAgentPane")
      .mockRejectedValueOnce(new Error("Herdr close acknowledgement unavailable"));
    expect(await advance(orphanInput)).toMatchObject({ kind: "wait" });
    expect(writes.status(workspace.id)).toBe("quarantined");
    preAgentClose.mockRestore();
    expect(await advance(orphanInput)).toEqual({ kind: "continue" });
    expect((await store.tasks.listAttempts(orphanTask.id))[0]?.status).toBe("failed");
    expect(writes.status(workspace.id)).toBe("free");
    expect((await bridge.getSnapshot()).workspaces[0]?.panes).toHaveLength(0);

    const absentTask = await store.tasks.createTask({
      title: "Unknown launch with no observed pane",
      creatorPrincipalId: "owner",
      authorizationScope: caller.scope,
    });
    for (const action of ["task:continue", "task:delegate"])
      await store.authorization.grant({
        principalId: "owner",
        resourceId: `task-${absentTask.id}`,
        action,
        scope: caller.scope,
        effect: "allow",
      });
    const absentStep = { ...step, id: "absent-worker-step", taskId: absentTask.id };
    await store.longWork.createGraph(
      absentTask.id,
      [absentStep],
      absentStep.id,
      DEFAULT_TASK_GRAPH_LIMITS,
      { kind: "system", reason: "test absent launch snapshot" },
    );
    vi.spyOn(bridge, "startAgent").mockRejectedValueOnce(
      new Error("transport lost before Herdr acknowledged tab creation"),
    );
    const absentInput = { taskId: absentTask.id, policyRevision: 1 };
    expect(await advance(absentInput)).toEqual({ kind: "continue" });
    const absentAttempt = (await store.tasks.listAttempts(absentTask.id))[0]!;
    const absentIntent = (await store.longWork.getWorkerLaunchIntent(absentAttempt.id))!;
    expect(await advance(absentInput)).toMatchObject({ kind: "wait" });
    expect(await store.longWork.getQuarantinedLease(absentTask.id, absentStep.id)).toBeTruthy();
    expect(writes.status(workspace.id)).toBe("quarantined");
    bridge.simulatePreAgentTab({
      workspaceId: absentIntent.workspaceId,
      agentName: absentIntent.agentName,
      worktreePath: absentIntent.worktreePath,
    });
    expect(await advance(absentInput)).toEqual({ kind: "continue" });
    expect(await store.tasks.listAttempts(absentTask.id)).toHaveLength(1);
    expect((await store.tasks.listAttempts(absentTask.id))[0]?.status).toBe("failed");
    expect(writes.status(workspace.id)).toBe("free");
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 2, retryDelay: 50 }).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code !== "EBUSY") throw error;
      },
    );
  }
});
