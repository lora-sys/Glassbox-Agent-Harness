import type { Row } from "@libsql/client";
import type { CallerContext } from "../identity/scope.js";
import { requireIdentifier } from "../identity/scope.js";
import { evaluate } from "../auth/service.js";
import { DomainDatabase } from "../persistence/database.js";

export interface LongWorkHealthSnapshot {
  tasks: { active: number; waiting: number };
  steps: { blocked: number; ready: number; running: number; review: number };
  leases: { active: number; quarantined: number };
  retries: number;
  children: number;
  backend: {
    status: "unknown" | "unavailable" | "not_marked_unavailable";
    unavailableBindings: number | null;
    observedBindings: number;
  };
}

function countColumn(row: Row, key: string): number {
  const value = row[key];
  const count = typeof value === "bigint" ? Number(value) : value;
  if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0)
    throw new Error("Invalid long-work health count");
  return count;
}

/**
 * Reauthorizes candidate Task IDs in the same transaction as the aggregate read.
 * It returns counts only and never loads protected Task contents.
 */
export async function readLongWorkHealth(
  db: DomainDatabase,
  candidateTaskIds: readonly string[],
  caller: CallerContext,
  evidence?: { runId?: string; conversationId?: string },
): Promise<LongWorkHealthSnapshot> {
  for (const taskId of candidateTaskIds) requireIdentifier(taskId);
  return db.transaction(async (tx) => {
    const authorizedTaskIds: string[] = [];
    for (const taskId of new Set(candidateTaskIds)) {
      const decision = await evaluate(tx, {
        caller,
        resourceId: `task-${taskId}`,
        action: "task:read",
        ...evidence,
      });
      if (decision.decision === "ALLOW") authorizedTaskIds.push(taskId);
    }
    const result = await tx.execute({
      sql: `
      WITH visible_tasks AS (
        SELECT t.id FROM tasks t JOIN json_each(?) scope ON scope.value = t.id
          WHERE t.orchestration_mode = 'durable'
      )
      SELECT
        (SELECT COUNT(*) FROM tasks WHERE id IN visible_tasks AND status IN ('NEW','QUEUED','ASSIGNED','RUNNING')) AS active_tasks,
        (SELECT COUNT(*) FROM tasks WHERE id IN visible_tasks AND status IN ('WAITING_INPUT','REVIEW')) AS waiting_tasks,
        (SELECT COUNT(*) FROM task_steps WHERE task_id IN visible_tasks AND status = 'blocked') AS blocked_steps,
        (SELECT COUNT(*) FROM task_steps WHERE task_id IN visible_tasks AND status = 'ready') AS ready_steps,
        (SELECT COUNT(*) FROM task_steps WHERE task_id IN visible_tasks AND status = 'running') AS running_steps,
        (SELECT COUNT(*) FROM task_steps WHERE task_id IN visible_tasks AND status = 'review') AS review_steps,
        (SELECT COUNT(*) FROM task_step_leases WHERE task_id IN visible_tasks AND state = 'active') AS active_leases,
        (SELECT COUNT(*) FROM task_step_leases WHERE task_id IN visible_tasks AND state = 'quarantined') AS quarantined_leases,
        (SELECT COUNT(*) FROM task_events WHERE task_id IN visible_tasks AND type = 'RETRY_SCHEDULED') AS retries,
        (SELECT COUNT(*) FROM task_child_links WHERE parent_task_id IN visible_tasks) AS children,
        (SELECT COUNT(*) FROM task_workflow_bindings WHERE task_id IN visible_tasks) AS observed_backend_bindings,
        (SELECT COUNT(*) FROM task_workflow_bindings WHERE task_id IN visible_tasks AND state = 'unavailable') AS unavailable_backend_bindings
    `,
      args: [JSON.stringify(authorizedTaskIds)],
    });
    const row = result.rows[0];
    if (!row) throw new Error("Long-work health query returned no aggregate row");

    const observedBindings = countColumn(row, "observed_backend_bindings");
    const unavailableCount = countColumn(row, "unavailable_backend_bindings");
    const backendStatus =
      observedBindings === 0
        ? "unknown"
        : unavailableCount > 0
          ? "unavailable"
          : "not_marked_unavailable";

    return {
      tasks: {
        active: countColumn(row, "active_tasks"),
        waiting: countColumn(row, "waiting_tasks"),
      },
      steps: {
        blocked: countColumn(row, "blocked_steps"),
        ready: countColumn(row, "ready_steps"),
        running: countColumn(row, "running_steps"),
        review: countColumn(row, "review_steps"),
      },
      leases: {
        active: countColumn(row, "active_leases"),
        quarantined: countColumn(row, "quarantined_leases"),
      },
      retries: countColumn(row, "retries"),
      children: countColumn(row, "children"),
      backend: {
        status: backendStatus,
        unavailableBindings: observedBindings === 0 ? null : unavailableCount,
        observedBindings,
      },
    };
  });
}
