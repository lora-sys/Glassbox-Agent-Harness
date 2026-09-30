import type { TaskWorkflowBinding } from "@glassbox/contracts";
import type { DomainStore } from "../../application/domain-store.js";
import { TaskWorkflowBindingStore } from "./binding-store.js";
import type { createLongWorkWorkflowClient } from "./client.js";

type Workflows = ReturnType<typeof createLongWorkWorkflowClient>;

/** Reconciles Temporal execution with Glassbox's durable Task identity. */
export class TemporalLongWorkCoordinator {
  private readonly bindings: TaskWorkflowBindingStore;

  constructor(
    private readonly store: DomainStore,
    private readonly workflows: Workflows,
  ) {
    this.bindings = new TaskWorkflowBindingStore(store.db);
  }

  async start(taskId: string, policyRevision: number): Promise<TaskWorkflowBinding> {
    const binding = await this.bindings.reserve(taskId, policyRevision, new Date().toISOString());
    if (binding.status === "closed") throw new Error("Temporal binding is closed");
    try {
      const observed = await this.workflows.inspect(taskId);
      if (observed && !observed.running)
        throw new Error("Temporal workflow closed before Glassbox Task review");
      const runId =
        observed?.runId ?? (await this.workflows.start({ taskId, policyRevision })).runId;
      if (binding.status === "running") {
        if (runId && binding.runId !== runId) {
          return this.bindings.recordState({
            taskId,
            policyRevision,
            expectedStatus: "running",
            expectedRunId: binding.runId ?? null,
            status: "running",
            runId,
            updatedAt: new Date().toISOString(),
          });
        }
        return binding;
      }
      return this.bindings.recordState({
        taskId,
        policyRevision,
        expectedStatus: binding.status,
        expectedRunId: binding.runId ?? null,
        status: "running",
        ...(runId ? { runId } : {}),
        updatedAt: new Date().toISOString(),
      });
    } catch (error) {
      if (binding.status === "starting" || binding.status === "running") {
        await this.bindings
          .recordState({
            taskId,
            policyRevision,
            expectedStatus: binding.status,
            expectedRunId: binding.runId ?? null,
            status: "unavailable",
            updatedAt: new Date().toISOString(),
          })
          .catch(() => undefined);
      }
      throw error;
    }
  }

  async wake(taskId: string): Promise<void> {
    await this.workflows.wake(taskId);
  }

  async recover(): Promise<{ recovered: string[]; unavailable: string[] }> {
    const recovered: string[] = [];
    const unavailable: string[] = [];
    const bindings = await this.bindings.listRecoverable();
    const boundIds = new Set(bindings.map((binding) => binding.taskId));
    for (const task of await this.store.tasks.listTasks()) {
      if (
        task.orchestrationMode !== "durable" ||
        task.policyRevision === undefined ||
        ["DONE", "CANCELED", "FAILED", "REVIEW"].includes(task.status) ||
        boundIds.has(task.id)
      )
        continue;
      if (task.cancellationState === "requested" || task.cancellationState === "stopping") {
        unavailable.push(task.id);
        continue;
      }
      try {
        await this.start(task.id, task.policyRevision);
        recovered.push(task.id);
      } catch {
        unavailable.push(task.id);
      }
    }
    for (const binding of bindings) {
      if (binding.status === "closed") continue;
      const task = await this.store.tasks.getTask(binding.taskId);
      if (!task || ["DONE", "CANCELED", "FAILED", "REVIEW"].includes(task.status)) {
        try {
          const observed = await this.workflows.inspect(binding.taskId);
          if (observed?.running) await this.workflows.cancel(binding.taskId);
          await this.bindings.recordState({
            taskId: binding.taskId,
            policyRevision: binding.policyRevision,
            expectedStatus: binding.status,
            expectedRunId: binding.runId ?? null,
            status: "closed",
            updatedAt: new Date().toISOString(),
          });
          recovered.push(binding.taskId);
        } catch {
          unavailable.push(binding.taskId);
        }
        continue;
      }
      if (task.cancellationState === "requested" || task.cancellationState === "stopping") {
        try {
          const observed = await this.workflows.inspect(binding.taskId);
          if (observed?.running) {
            await this.workflows.wake(binding.taskId);
            await this.bindings.recordState({
              taskId: binding.taskId,
              policyRevision: binding.policyRevision,
              expectedStatus: binding.status,
              expectedRunId: binding.runId ?? null,
              status: "running",
              runId: observed.runId,
              updatedAt: new Date().toISOString(),
            });
            recovered.push(binding.taskId);
            continue;
          }
          if (binding.status !== "unavailable")
            await this.bindings.recordState({
              taskId: binding.taskId,
              policyRevision: binding.policyRevision,
              expectedStatus: binding.status,
              expectedRunId: binding.runId ?? null,
              status: "unavailable",
              updatedAt: new Date().toISOString(),
            });
        } catch {
          // Preserve cancellation intent until the backend can confirm the workflow.
        }
        unavailable.push(binding.taskId);
        continue;
      }
      try {
        await this.start(binding.taskId, binding.policyRevision);
        await this.wake(binding.taskId);
        recovered.push(binding.taskId);
      } catch {
        unavailable.push(binding.taskId);
      }
    }
    return { recovered, unavailable };
  }
}
