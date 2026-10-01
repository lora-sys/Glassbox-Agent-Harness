import { randomUUID } from "node:crypto";
import type { TaskStep } from "@glassbox/contracts";
import type { DomainStore } from "../application/domain-store.js";
import { FakeHerdrBridge } from "./fake-herdr-bridge.js";
import { DurableWorkerObserver } from "./durable-worker-observer.js";
import { OpsReconciler } from "./reconciler.js";

export const system = { kind: "system", reason: "durable worker observer test" } as const;
const limits = {
  maxSteps: 8,
  maxDependenciesPerStep: 4,
  maxFanOut: 4,
  maxReadySteps: 4,
  maxParallelSteps: 2,
};

function workerStep(
  taskId: string,
  stepId: string,
  kind: TaskStep["kind"] = "herdr_worker",
): TaskStep {
  const now = new Date().toISOString();
  return {
    id: stepId,
    taskId,
    kind,
    title: "Run worker",
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
}

export async function durableWorkerFixture(
  store: DomainStore,
  agentKind = "codex",
  prompted = true,
) {
  await store.identities.createPrincipal("owner", "owner");
  const task = await store.tasks.createTask({
    title: "Durable worker",
    creatorPrincipalId: "owner",
  });
  const stepId = `step-${randomUUID()}`;
  await store.longWork.createGraph(task.id, [workerStep(task.id, stepId)], stepId, limits, system);
  await store.longWork.transitionStep({
    taskId: task.id,
    stepId,
    expectedVersion: 1,
    from: "pending",
    to: "ready",
    origin: system,
  });
  await store.db.transaction(async (tx) => {
    await tx.execute({
      sql: "UPDATE task_steps SET status = 'running', version = 3 WHERE id = ?",
      args: [stepId],
    });
    // A durable Task reaches RUNNING when its first Step attempt starts; adopting a graph
    // instead leaves it NEW. The Worker binding guard reads that status, so a fixture that
    // skips it describes a Task no Worker could ever have been bound to.
    await tx.execute({
      sql: "UPDATE tasks SET status = 'RUNNING', updated_at = ? WHERE id = ?",
      args: [new Date().toISOString(), task.id],
    });
    await tx.execute({
      sql: "INSERT INTO task_attempts(id,task_id,step_id,attempt_number,status,started_at) VALUES ('attempt-1',?,?,1,'running',?)",
      args: [task.id, stepId, new Date().toISOString()],
    });
  });
  const bridge = new FakeHerdrBridge("session-1");
  const worker = await bridge.startAgent({ workspaceId: "workspace-1", agentKind });
  const binding = await store.tasks.bindWorker({
    taskAttemptId: "attempt-1",
    herdrSession: "session-1",
    workspaceId: "workspace-1",
    paneId: worker.paneId,
    agentName: worker.agentName,
    agentKind,
  });
  if (prompted) await store.tasks.markWorkerPromptDispatched("attempt-1", binding.id);
  const lease = await store.longWork.acquireLease({
    id: "lease-1",
    taskId: task.id,
    stepId,
    attemptId: "attempt-1",
    workerBindingId: binding.id,
    ownerInstanceId: "owner-instance",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    origin: system,
  });
  if (!lease) throw new Error("Expected exclusive Worker lease");
  const observer = new DurableWorkerObserver(store.db, store.longWork, store.tasks);
  const reconciler = new OpsReconciler(store.tasks, bridge, 1_000, observer);
  return { store, task, stepId, bridge, worker, binding, observer, reconciler };
}
