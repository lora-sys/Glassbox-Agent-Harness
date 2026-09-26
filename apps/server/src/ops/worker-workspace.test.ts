import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vite-plus/test";
import { openDomainStore, type CallerContext } from "../persistence/index.js";
import { WorkspaceRegistry } from "../workspace/registry.js";
import { WorkspaceWriteOccupancy, WorkspaceWriteBusyError } from "../workspace/write-occupancy.js";
import {
  executeWorkerFileTool,
  type WorkerToolContext,
} from "../runtime/pi/worker-tools-extension.js";
import { FakeHerdrBridge } from "./fake-herdr-bridge.js";
import { AuthorizedOpsService } from "./service.js";

it("shares one workspace write occupancy across Owners, Workers, and main Runs", async () => {
  const directory = await mkdtemp(join(tmpdir(), "glassbox-herdr-workspace-"));
  const dataRoot = join(directory, "data");
  const root = join(directory, "project");
  await mkdir(root);
  const registry = await WorkspaceRegistry.open({ dataRoot });
  const writes = new WorkspaceWriteOccupancy(dataRoot);
  const store = await openDomainStore({ databasePath: join(dataRoot, "glassbox.db") });
  const bridge = new FakeHerdrBridge();
  const policy = {
    databasePath: join(dataRoot, "glassbox.db"),
    contextDirectory: join(dataRoot, "worker-contexts"),
    resourceId: "worker-workspace:isolated",
  };
  const callers: CallerContext[] = ["owner-a", "owner-b"].map((principalId) => ({
    principalId,
    scope: {
      connectionId: "test",
      botId: "bot",
      chatType: "private",
      chatId: principalId,
      senderId: principalId,
    },
  }));
  try {
    const workspace = await registry.registerExistingTrusted({
      path: root,
      label: "project",
      ownerPrincipalId: callers[0]!.principalId,
    });
    await registry.grantTrusted(workspace.id, callers[1]!.principalId, "write");
    for (const resource of [
      { id: "agent-operations", kind: "ops", visibility: "public" as const },
      { id: policy.resourceId, kind: "worker-files", visibility: "public" as const },
      { id: `workspace:${workspace.id}`, kind: "workspace", visibility: "public" as const },
    ])
      await store.authorization.registerResource(resource);
    for (const caller of callers) {
      await store.identities.bindOwner(caller.principalId, caller.scope);
      for (const [resourceId, action] of [
        ["agent-operations", "task:delegate"],
        [policy.resourceId, "worker:file:read"],
        [policy.resourceId, "worker:file:write"],
        [`workspace:${workspace.id}`, "workspace:read"],
        [`workspace:${workspace.id}`, "workspace:write"],
      ])
        await store.authorization.grant({
          principalId: caller.principalId,
          resourceId: resourceId!,
          action: action!,
          scope: caller.scope,
          effect: "allow",
        });
    }
    const service = new AuthorizedOpsService(store, bridge, policy, { registry, writes });
    const delegate = (caller: CallerContext) =>
      service.delegate(caller, {
        title: "Bounded Worker",
        workspaceId: "herdr-project",
        agentKind: "pi",
        worktreePath: root,
        prompt: "Write one result",
      });
    const first = await delegate(callers[0]!);
    expect(first.status).toBe("RUNNING");
    expect(writes.status(workspace.id)).toBe("active");
    const firstContext = JSON.parse(
      await readFile(join(policy.contextDirectory, `${first.activeAttemptId}.json`), "utf8"),
    ) as WorkerToolContext;
    expect(firstContext.productWorkspaceId).toBe(workspace.id);
    await executeWorkerFileTool(firstContext, "first-write", "write", {
      path: "result.txt",
      content: "owner-a",
    });
    await executeWorkerFileTool(firstContext, "first-read", "read", { path: "result.txt" });
    expect(await readFile(join(root, "result.txt"), "utf8")).toBe("owner-a");
    await store.authorization.grant({
      principalId: callers[0]!.principalId,
      resourceId: `task-${first.id}`,
      action: "worker:read",
      scope: callers[0]!.scope,
      effect: "allow",
    });
    await expect(service.readWorker(callers[0]!, first.id)).resolves.toHaveProperty("output");
    await store.authorization.revokeScopeAction({
      principalId: callers[0]!.principalId,
      resourceId: `workspace:${workspace.id}`,
      action: "workspace:read",
      scope: callers[0]!.scope,
    });
    await expect(service.readWorker(callers[0]!, first.id)).rejects.toThrow();
    await store.authorization.grant({
      principalId: callers[0]!.principalId,
      resourceId: `workspace:${workspace.id}`,
      action: "workspace:read",
      scope: callers[0]!.scope,
      effect: "allow",
    });
    const firstBinding = (await store.tasks.getWorkerBinding(first.activeAttemptId!))!;
    await store.tasks.observeWorker(firstBinding, "done");
    expect((await store.tasks.getTask(first.id))?.status).toBe("REVIEW");
    expect(writes.status(workspace.id)).toBe("active");
    expect(() =>
      writes.acquire({
        workspaceId: workspace.id,
        principalId: callers[1]!.principalId,
        executionId: "main-run",
        sandboxSessionId: "sandbox",
        policyVersion: "workspace-sandbox-v1",
      }),
    ).toThrow(WorkspaceWriteBusyError);
    const independent = writes.acquire({
      workspaceId: "independent-workspace",
      principalId: callers[1]!.principalId,
      executionId: "independent-run",
      sandboxSessionId: "independent-sandbox",
      policyVersion: "workspace-sandbox-v1",
    });
    expect(writes.status(independent.workspaceId)).toBe("active");
    await writes.closeAndRelease(independent, async () => undefined);
    const busy = await delegate(callers[1]!);
    expect(busy.status).toBe("WAITING_INPUT");
    expect(await store.tasks.getWorkerBinding(busy.activeAttemptId!)).toBeNull();

    await store.authorization.grant({
      principalId: callers[0]!.principalId,
      resourceId: `task-${first.id}`,
      action: "task:accept",
      scope: callers[0]!.scope,
      effect: "allow",
    });
    await service.accept(callers[0]!, first.id);
    expect(writes.status(workspace.id)).toBe("free");
    await expect(
      executeWorkerFileTool(firstContext, "cancelled", "write", {
        path: "after.txt",
        content: "PRIVATE_CANARY",
      }),
    ).rejects.toThrow();

    const originalSnapshot = bridge.getSnapshot.bind(bridge);
    let snapshotCalls = 0;
    const wrongDirectory = vi.spyOn(bridge, "getSnapshot").mockImplementation(async () => {
      const snapshot = await originalSnapshot();
      snapshotCalls += 1;
      if (snapshotCalls === 2)
        for (const entry of snapshot.workspaces)
          for (const pane of entry.panes) pane.cwd = directory;
      return snapshot;
    });
    const mismatch = await delegate(callers[1]!);
    expect(mismatch.status).toBe("WAITING_INPUT");
    expect(writes.status(workspace.id)).toBe("free");
    wrongDirectory.mockRestore();

    const second = await delegate(callers[1]!);
    expect(second.status).toBe("RUNNING");
    const secondContext = JSON.parse(
      await readFile(join(policy.contextDirectory, `${second.activeAttemptId}.json`), "utf8"),
    ) as WorkerToolContext;
    await executeWorkerFileTool(secondContext, "second-read", "read", { path: "result.txt" });
    await store.authorization.grant({
      principalId: callers[1]!.principalId,
      resourceId: `task-${second.id}`,
      action: "worker:read",
      scope: callers[1]!.scope,
      effect: "allow",
    });
    await expect(service.readWorker(callers[1]!, second.id)).resolves.toHaveProperty("output");
    await registry.revokeTrusted(workspace.id, callers[1]!.principalId);
    await expect(service.readWorker(callers[1]!, second.id)).rejects.toThrow();
    await expect(
      executeWorkerFileTool(secondContext, "revoked", "write", {
        path: "after.txt",
        content: "PRIVATE_CANARY",
      }),
    ).rejects.toThrow();
    expect(writes.status(workspace.id)).toBe("active");
    await store.authorization.grant({
      principalId: callers[1]!.principalId,
      resourceId: `task-${second.id}`,
      action: "task:cancel",
      scope: callers[1]!.scope,
      effect: "allow",
    });
    await bridge.disconnect();
    await expect(service.cancel(callers[1]!, second.id)).rejects.toThrow();
    expect(writes.status(workspace.id)).toBe("quarantined");
    await bridge.connect();
    new WorkspaceWriteOccupancy(dataRoot);
    await registry.grantTrusted(workspace.id, callers[1]!.principalId, "write");
    await expect(
      executeWorkerFileTool(secondContext, "after-restart", "write", {
        path: "after.txt",
        content: "PRIVATE_CANARY",
      }),
    ).rejects.toThrow();
    await service.cancel(callers[1]!, second.id);
    expect(writes.status(workspace.id)).toBe("free");

    const review = await delegate(callers[0]!);
    const reviewBinding = (await store.tasks.getWorkerBinding(review.activeAttemptId!))!;
    await store.tasks.observeWorker(reviewBinding, "done");
    for (const action of ["task:rework", "worker:prompt"])
      await store.authorization.grant({
        principalId: callers[0]!.principalId,
        resourceId: `task-${review.id}`,
        action,
        scope: callers[0]!.scope,
        effect: "allow",
      });
    const reworked = await service.rework(callers[0]!, review.id, "Check result", "Revise it");
    expect(reworked.activeAttemptId).not.toBe(review.activeAttemptId);
    expect(writes.status(workspace.id)).toBe("active");
    expect((await store.tasks.getAttempt(review.activeAttemptId!))?.status).toBe("review");
    await store.authorization.grant({
      principalId: callers[0]!.principalId,
      resourceId: `task-${review.id}`,
      action: "task:cancel",
      scope: callers[0]!.scope,
      effect: "allow",
    });
    await service.cancel(callers[0]!, review.id);
    expect(writes.status(workspace.id)).toBe("free");

    const trace = await store.tasks.listTraceEvents({ taskId: second.id });
    expect(JSON.stringify(trace)).not.toContain("PRIVATE_CANARY");
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 2, retryDelay: 50 }).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code !== "EBUSY") throw error;
      },
    );
  }
});
