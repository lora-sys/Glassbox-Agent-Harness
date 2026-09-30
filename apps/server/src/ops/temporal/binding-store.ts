import type { TaskWorkflowBinding } from "@glassbox/contracts";
import type { Row } from "@libsql/client";
import { DomainDatabase, optionalString, stringColumn } from "../../persistence/database.js";
import { requireIdentifier } from "../../identity/scope.js";
import { longWorkWorkflowId } from "./contracts.js";

export type WorkflowBindingStatus = TaskWorkflowBinding["status"];

export class TaskWorkflowBindingStore {
  constructor(private readonly db: DomainDatabase) {}

  async reserve(
    taskId: string,
    policyRevision: number,
    updatedAt: string,
  ): Promise<TaskWorkflowBinding> {
    requireIdentifier(taskId);
    requireTimestamp(updatedAt);
    if (!Number.isSafeInteger(policyRevision) || policyRevision < 1)
      throw new Error("Policy revision must be a positive integer");

    return this.db.transaction(async (tx) => {
      const taskResult = await tx.execute({
        sql: "SELECT orchestration_mode, policy_revision, cancellation_state, status FROM tasks WHERE id = ?",
        args: [taskId],
      });
      const task = taskResult.rows[0];
      if (!task) throw new Error(`Task not found: ${taskId}`);
      if (task.orchestration_mode !== "durable")
        throw new Error("Workflow binding requires a durable Task");
      if (Number(task.policy_revision) !== policyRevision)
        throw new Error("Workflow binding policy revision is stale");
      if (
        task.cancellation_state !== "none" ||
        ["DONE", "CANCELED", "ACCEPTED", "FAILED"].includes(stringColumn(task, "status"))
      )
        throw new Error("Workflow binding requires active durable work");

      const workflowId = longWorkWorkflowId(taskId);
      const existingResult = await tx.execute({
        sql: "SELECT * FROM task_workflow_bindings WHERE task_id = ?",
        args: [taskId],
      });
      const existing = existingResult.rows[0];
      if (existing) {
        const binding = mapBinding(existing);
        if (
          binding.workflowId !== workflowId ||
          binding.backend !== "temporal" ||
          binding.policyRevision !== policyRevision
        )
          throw new Error("Task already has a different workflow binding");
        return binding;
      }

      await tx.execute({
        sql: "INSERT INTO task_workflow_bindings(task_id,workflow_id,backend,state,policy_revision,updated_at) VALUES (?,?, 'temporal','starting',?,?)",
        args: [taskId, workflowId, policyRevision, updatedAt],
      });
      const inserted = await tx.execute({
        sql: "SELECT * FROM task_workflow_bindings WHERE task_id = ?",
        args: [taskId],
      });
      return mapBinding(inserted.rows[0]!);
    });
  }

  async recordState(input: {
    taskId: string;
    policyRevision: number;
    expectedStatus: Exclude<WorkflowBindingStatus, "closed">;
    expectedRunId: string | null;
    status: Exclude<WorkflowBindingStatus, "starting">;
    runId?: string;
    updatedAt: string;
  }): Promise<TaskWorkflowBinding> {
    requireIdentifier(input.taskId);
    requireTimestamp(input.updatedAt);
    if (!Number.isSafeInteger(input.policyRevision) || input.policyRevision < 1)
      throw new Error("Policy revision must be a positive integer");
    if (input.expectedRunId !== null) requireIdentifier(input.expectedRunId);
    if (input.runId !== undefined) requireIdentifier(input.runId);
    if (!isAllowedTransition(input.expectedStatus, input.status))
      throw new Error("Invalid workflow binding state transition");

    return this.db.transaction(async (tx) => {
      const currentResult = await tx.execute({
        sql: "SELECT * FROM task_workflow_bindings WHERE task_id = ?",
        args: [input.taskId],
      });
      const currentRow = currentResult.rows[0];
      if (!currentRow) throw new Error("Workflow binding not found");
      const current = mapBinding(currentRow);
      const nextRunId = input.runId ?? current.runId ?? null;
      const runRolledOver =
        input.status === "running" &&
        current.runId !== undefined &&
        nextRunId !== null &&
        current.runId !== nextRunId;
      const nextContinuation = current.continuation + (runRolledOver ? 1 : 0);
      if (
        current.policyRevision === input.policyRevision &&
        current.status === input.expectedStatus &&
        (current.runId ?? null) === input.expectedRunId &&
        current.status === input.status &&
        current.runId === nextRunId &&
        current.continuation === nextContinuation
      )
        return current;

      const result = await tx.execute({
        sql: "UPDATE task_workflow_bindings SET run_id = ?, state = ?, continuation = ?, updated_at = ? WHERE task_id = ? AND policy_revision = ? AND state = ? AND run_id IS ? AND continuation = ? RETURNING *",
        args: [
          nextRunId,
          input.status,
          nextContinuation,
          input.updatedAt,
          input.taskId,
          input.policyRevision,
          input.expectedStatus,
          input.expectedRunId,
          current.continuation,
        ],
      });
      if (!result.rows[0])
        throw new Error("Workflow binding changed concurrently or policy is stale");
      return mapBinding(result.rows[0]);
    });
  }

  async listRecoverable(): Promise<TaskWorkflowBinding[]> {
    return this.db.transaction(async (tx) => {
      const result = await tx.execute(
        "SELECT * FROM task_workflow_bindings WHERE state IN ('starting','running','unavailable') ORDER BY updated_at, task_id",
      );
      return result.rows.map(mapBinding);
    });
  }
}

function isAllowedTransition(from: WorkflowBindingStatus, to: WorkflowBindingStatus): boolean {
  return (
    (from === "starting" && ["running", "unavailable", "closed"].includes(to)) ||
    (from === "running" && ["running", "unavailable", "closed"].includes(to)) ||
    (from === "unavailable" && ["running", "closed"].includes(to))
  );
}

function requireTimestamp(value: string): void {
  if (!value.trim() || Number.isNaN(Date.parse(value)))
    throw new Error("Valid timestamp is required");
}

function mapBinding(row: Row): TaskWorkflowBinding {
  const status = stringColumn(row, "state");
  if (!["starting", "running", "unavailable", "closed"].includes(status))
    throw new Error("Invalid persisted workflow binding state");
  const backend = stringColumn(row, "backend");
  if (backend !== "temporal") throw new Error("Invalid persisted workflow backend");
  return {
    taskId: stringColumn(row, "task_id"),
    workflowId: stringColumn(row, "workflow_id"),
    ...(optionalString(row, "run_id") ? { runId: optionalString(row, "run_id")! } : {}),
    backend,
    policyRevision: Number(row.policy_revision),
    continuation: Number(row.continuation),
    status: status as WorkflowBindingStatus,
    updatedAt: stringColumn(row, "updated_at"),
  };
}
