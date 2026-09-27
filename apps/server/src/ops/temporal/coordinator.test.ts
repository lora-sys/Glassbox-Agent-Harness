import { expect, it, vi } from "vite-plus/test";
import type { TaskStep } from "@glassbox/contracts";
import { openDomainStore } from "../../application/domain-store.js";
import { DEFAULT_TASK_GRAPH_LIMITS } from "../task-graph.js";
import { TaskWorkflowBindingStore } from "./binding-store.js";
import { createLongWorkWorkflowClient } from "./client.js";
import { TemporalLongWorkCoordinator } from "./coordinator.js";

async function durableTask(store: Awaited<ReturnType<typeof openDomainStore>>) {
  await store.db.transaction(async (tx) => {
    await tx.execute({
      sql: "INSERT INTO principals(id,kind,created_at) VALUES (?,?,?)",
      args: ["owner", "owner", new Date().toISOString()],
    });
  });
  const task = await store.tasks.createTask({
    title: "Temporal Task",
    creatorPrincipalId: "owner",
  });
  const now = new Date().toISOString();
  const step: TaskStep = {
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
    createdAt: now,
    updatedAt: now,
    version: 1,
  };
  await store.longWork.createGraph(task.id, [step], step.id, DEFAULT_TASK_GRAPH_LIMITS, {
    kind: "system",
    reason: "test plan",
  });
  return task.id;
}

it("reserves a stable binding and reconciles a start interrupted by backend failure", async () => {
  const store = await openDomainStore({ databasePath: ":memory:" });
  try {
    const taskId = await durableTask(store);
    let available = false;
    let observed: { runId: string; running: boolean } | null = null;
    const port = {
      start: vi.fn(async ({ workflowId }: { workflowId: string }) => {
        if (!available) throw new Error("backend unavailable");
        observed = { runId: "run-1", running: true };
        return { workflowId, runId: "run-1" };
      }),
      wake: vi.fn(async () => {}),
      cancel: vi.fn(async () => {}),
      inspect: vi.fn(async () => observed),
    };
    const coordinator = new TemporalLongWorkCoordinator(store, createLongWorkWorkflowClient(port));
    await expect(coordinator.start(taskId, 1)).rejects.toThrow("backend unavailable");
    expect((await new TaskWorkflowBindingStore(store.db).listRecoverable())[0]?.status).toBe(
      "unavailable",
    );
    expect((await store.tasks.getTask(taskId))?.status).toBe("NEW");

    available = true;
    expect(await coordinator.recover()).toEqual({ recovered: [taskId], unavailable: [] });
    expect(port.wake).toHaveBeenCalledTimes(1);
    const binding = (await new TaskWorkflowBindingStore(store.db).listRecoverable())[0];
    expect(binding).toMatchObject({ taskId, status: "running", runId: "run-1" });
    await coordinator.start(taskId, 1);
    expect(port.start).toHaveBeenCalledTimes(2);
  } finally {
    await store.close();
  }
});

it("finds durable Tasks whose workflow binding was never reserved", async () => {
  const store = await openDomainStore({ databasePath: ":memory:" });
  try {
    const taskId = await durableTask(store);
    const port = {
      start: vi.fn(async ({ workflowId }: { workflowId: string }) => ({
        workflowId,
        runId: "run-2",
      })),
      wake: vi.fn(async () => {}),
      cancel: vi.fn(async () => {}),
      inspect: vi.fn(async () => null),
    };
    const coordinator = new TemporalLongWorkCoordinator(store, createLongWorkWorkflowClient(port));
    expect(await coordinator.recover()).toEqual({ recovered: [taskId], unavailable: [] });
    expect(port.start).toHaveBeenCalledTimes(1);
    expect((await new TaskWorkflowBindingStore(store.db).listRecoverable())[0]).toMatchObject({
      taskId,
      status: "running",
      runId: "run-2",
    });
  } finally {
    await store.close();
  }
});

it("reconciles Continue-As-New run IDs without replacing the workflow identity", async () => {
  const store = await openDomainStore({ databasePath: ":memory:" });
  try {
    const taskId = await durableTask(store);
    let observed: { runId: string; running: boolean } = { runId: "run-1", running: true };
    const port = {
      start: vi.fn(async ({ workflowId }: { workflowId: string }) => ({
        workflowId,
        runId: observed.runId,
      })),
      wake: vi.fn(async () => {}),
      cancel: vi.fn(async () => {}),
      inspect: vi.fn(async () => observed),
    };
    const coordinator = new TemporalLongWorkCoordinator(store, createLongWorkWorkflowClient(port));
    const first = await coordinator.start(taskId, 1);
    expect(first).toMatchObject({ status: "running", runId: "run-1", continuation: 0 });

    observed = { runId: "run-2", running: true };
    const continued = await coordinator.start(taskId, 1);
    expect(continued).toMatchObject({
      taskId,
      workflowId: first.workflowId,
      status: "running",
      runId: "run-2",
      continuation: 1,
    });
    expect(port.start).not.toHaveBeenCalled();
  } finally {
    await store.close();
  }
});

it("records a run ID observed after the initial start response omitted it", async () => {
  const store = await openDomainStore({ databasePath: ":memory:" });
  try {
    const taskId = await durableTask(store);
    let observed: { runId: string; running: boolean } | null = null;
    const port = {
      start: vi.fn(async ({ workflowId }: { workflowId: string }) => ({ workflowId })),
      wake: vi.fn(async () => {}),
      cancel: vi.fn(async () => {}),
      inspect: vi.fn(async () => observed),
    };
    const coordinator = new TemporalLongWorkCoordinator(store, createLongWorkWorkflowClient(port));
    expect(await coordinator.start(taskId, 1)).toMatchObject({
      status: "running",
      continuation: 0,
    });
    observed = { runId: "late-run", running: true };
    expect(await coordinator.start(taskId, 1)).toMatchObject({
      runId: "late-run",
      continuation: 0,
    });
  } finally {
    await store.close();
  }
});

it("marks an unexpectedly closed running workflow unavailable during recovery", async () => {
  const store = await openDomainStore({ databasePath: ":memory:" });
  try {
    const taskId = await durableTask(store);
    const port = {
      start: vi.fn(async ({ workflowId }: { workflowId: string }) => ({
        workflowId,
        runId: "run-1",
      })),
      wake: vi.fn(async () => {}),
      cancel: vi.fn(async () => {}),
      inspect: vi.fn(async () => ({ runId: "run-1", running: true })),
    };
    const coordinator = new TemporalLongWorkCoordinator(store, createLongWorkWorkflowClient(port));
    await coordinator.start(taskId, 1);
    port.inspect.mockResolvedValue({ runId: "run-1", running: false });

    expect(await coordinator.recover()).toEqual({ recovered: [], unavailable: [taskId] });
    expect((await new TaskWorkflowBindingStore(store.db).listRecoverable())[0]).toMatchObject({
      taskId,
      runId: "run-1",
      status: "unavailable",
    });
    expect((await store.tasks.getTask(taskId))?.status).toBe("NEW");
  } finally {
    await store.close();
  }
});

it("leaves requested Task cancellation pending external reconciliation during recovery", async () => {
  const store = await openDomainStore({ databasePath: ":memory:" });
  try {
    const taskId = await durableTask(store);
    const port = {
      start: vi.fn(async ({ workflowId }: { workflowId: string }) => ({
        workflowId,
        runId: "run-1",
      })),
      wake: vi.fn(async () => {}),
      cancel: vi.fn(async () => {}),
      inspect: vi.fn(async () => ({ runId: "run-1", running: true })),
    };
    const coordinator = new TemporalLongWorkCoordinator(store, createLongWorkWorkflowClient(port));
    await coordinator.start(taskId, 1);
    await store.db.transaction(async (tx) => {
      await tx.execute({
        sql: "UPDATE tasks SET cancellation_state = 'requested' WHERE id = ?",
        args: [taskId],
      });
    });

    expect(await coordinator.recover()).toEqual({ recovered: [], unavailable: [taskId] });
    expect((await new TaskWorkflowBindingStore(store.db).listRecoverable())[0]).toMatchObject({
      taskId,
      runId: "run-1",
      status: "unavailable",
    });
    expect((await store.tasks.getTask(taskId))?.cancellationState).toBe("requested");
    expect(port.cancel).not.toHaveBeenCalled();
    expect(port.wake).not.toHaveBeenCalled();
  } finally {
    await store.close();
  }
});
