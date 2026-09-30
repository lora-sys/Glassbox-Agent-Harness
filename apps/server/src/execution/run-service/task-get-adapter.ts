import type { DomainStore } from "../../application/domain-store.js";
import { AccessDeniedError } from "../../auth/service.js";
import { parseTaskGetSpec } from "../../ops/tool-step-spec.js";
import type { RunExecutionAdapter } from "./types.js";

/** The first closed P6 Tool executor. It reads a Task through current authorization and
 * leaves the result in the internal Run; a separate Step review decides whether to use it. */
export function createTaskGetAdapter(store: DomainStore): RunExecutionAdapter {
  return {
    supportsGroup: true,
    supportsTaskStepTool: true,
    async execute(input) {
      if (input.executionMode !== "task_step_tool") return { status: "failed", failureCode: "gate_refused" };
      const spec = parseTaskGetSpec(input.run.executionRef);
      if (!spec || !input.taskStepBinding) return { status: "failed", failureCode: "gate_refused" };
      const taskStepBinding = input.taskStepBinding;
      const binding = await store.db.transaction(async (tx) => {
        const result = await tx.execute({
          sql: `SELECT s.kind,s.spec_ref,t.status,t.cancellation_state
                FROM task_attempt_runs ar
                JOIN runs r ON r.id = ar.run_id AND r.status = 'running'
                JOIN task_attempts a ON a.id = ar.attempt_id AND a.status = 'running'
                JOIN task_steps s ON s.id = ar.step_id AND s.task_id = ar.task_id
                JOIN tasks t ON t.id = ar.task_id
                WHERE ar.run_id = ? AND ar.task_id = ? AND ar.step_id = ? AND ar.attempt_id = ?
                  AND s.status = 'running'
                  AND EXISTS (SELECT 1 FROM task_step_leases l
                    WHERE l.task_id = ar.task_id AND l.step_id = ar.step_id
                      AND l.attempt_id = ar.attempt_id AND l.state = 'active'
                      AND l.expires_at > ?) LIMIT 1`,
          args: [
            input.run.id,
            taskStepBinding.taskId,
            taskStepBinding.stepId,
            taskStepBinding.attemptId,
            new Date().toISOString(),
          ],
        });
        return result.rows[0] ?? null;
      });
      if (
        !binding ||
        binding.kind !== "tool" ||
        binding.spec_ref !== input.run.executionRef ||
        binding.status !== "RUNNING" ||
        binding.cancellation_state !== "none"
      )
        return { status: "failed", failureCode: "gate_refused" };
      const read = async () => {
        const decision = await store.authorization.check({
          caller: input.caller,
          resourceId: `task-${spec.targetTaskId}`,
          action: "task:read",
          conversationId: input.conversation.id,
          runId: input.run.id,
        });
        if (decision.decision !== "ALLOW") throw new AccessDeniedError(decision);
        return decision.id;
      };
      if (input.signal.aborted) return { status: "cancelled" };
      await read();
      const task = await store.tasks.getTask(spec.targetTaskId);
      if (!task) return { status: "failed", failureCode: "gate_refused" };
      if (input.signal.aborted) return { status: "cancelled" };
      const sourceDecisionId = await read();
      if (input.signal.aborted) return { status: "cancelled" };
      const text = JSON.stringify({
        id: task.id,
        title: task.title,
        description: task.description ?? null,
        status: task.status,
        priority: task.priority,
        updatedAt: task.updatedAt,
      });
      if (text.length > 64_000) return { status: "unknown" };
      await store.authorization.markDeliverySource(sourceDecisionId, "content_source");
      return { status: "succeeded", text };
    },
  };
}
