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
  durations: {
    retryDelay: DurationEstimate;
    wait: DurationEstimate;
    blocked: DurationEstimate;
    reviewLatency: DurationEstimate;
    taskCompletion: DurationEstimate;
  };
  reworkCount: number | null;
  workerReplacementCount: number | null;
  historyTruncated: { tasks: boolean; waits: boolean; taskEvents: boolean };
  backend: {
    status: "unknown" | "unavailable" | "not_marked_unavailable";
    unavailableBindings: number | null;
    observedBindings: number;
  };
}

export interface DurationEstimate {
  averageMs: number | null;
  samples: number | null;
}

const MAX_METRIC_ROWS = 10_000;
const METRIC_ROW_LIMIT = MAX_METRIC_ROWS + 1;

function timestamp(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function duration(start: unknown, end: unknown): number | null {
  const startMs = timestamp(start);
  const endMs = timestamp(end);
  return startMs === null || endMs === null || endMs < startMs ? null : endMs - startMs;
}

function estimate(values: readonly number[]): DurationEstimate {
  return {
    averageMs:
      values.length === 0
        ? null
        : Math.round(values.reduce((total, value) => total + value, 0) / values.length),
    samples: values.length,
  };
}

function metadataObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "string") return {};
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
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

    const taskIdsJson = JSON.stringify(authorizedTaskIds);
    const [taskRows, waitRows, eventRows] = await Promise.all([
      tx.execute({
        sql: `SELECT created_at, completed_at FROM tasks
          WHERE id IN (SELECT value FROM json_each(?)) AND orchestration_mode = 'durable'
          LIMIT ?`,
        args: [taskIdsJson, METRIC_ROW_LIMIT],
      }),
      tx.execute({
        sql: `SELECT started_at, updated_at FROM task_waits
          WHERE task_id IN (SELECT value FROM json_each(?)) AND status <> 'waiting'
          LIMIT ?`,
        args: [taskIdsJson, METRIC_ROW_LIMIT],
      }),
      tx.execute({
        sql: `SELECT task_id, step_id, type, metadata_json, created_at FROM task_events
          WHERE task_id IN (SELECT value FROM json_each(?)) ORDER BY sequence LIMIT ?`,
        args: [taskIdsJson, METRIC_ROW_LIMIT],
      }),
    ]);

    const historyTruncated = {
      tasks: taskRows.rows.length > MAX_METRIC_ROWS,
      waits: waitRows.rows.length > MAX_METRIC_ROWS,
      taskEvents: eventRows.rows.length > MAX_METRIC_ROWS,
    };

    const taskCompletionSamples = (historyTruncated.tasks ? [] : taskRows.rows)
      .map((task) => duration(task.created_at, task.completed_at))
      .filter((value): value is number => value !== null);
    const waitSamples = (historyTruncated.waits ? [] : waitRows.rows)
      .map((wait) => duration(wait.started_at, wait.updated_at))
      .filter((value): value is number => value !== null);
    const retryDelaySamples: number[] = [];
    const blockedSamples: number[] = [];
    const reviewLatencySamples: number[] = [];
    let reworkCount = 0;
    let workerReplacementCount = 0;
    const blockedAt = new Map<string, string>();
    const reviewedAt = new Map<string, string>();
    const boundWorkerSteps = new Set<string>();
    for (const event of historyTruncated.taskEvents ? [] : eventRows.rows) {
      if (
        typeof event.task_id !== "string" ||
        typeof event.type !== "string" ||
        typeof event.created_at !== "string"
      )
        continue;
      const taskId = event.task_id;
      const stepId = typeof event.step_id === "string" ? event.step_id : null;
      const type = event.type;
      const createdAt = event.created_at;
      const meta = metadataObject(event.metadata_json);
      if (type === "RETRY_SCHEDULED") {
        const delay = duration(createdAt, meta.dueAt);
        if (delay !== null) retryDelaySamples.push(delay);
      }
      if (type === "TASK_REWORK") reworkCount += 1;
      if (type === "WORKER_BOUND" && stepId !== null) {
        const key = `${taskId}\u0000${stepId}`;
        if (boundWorkerSteps.has(key)) workerReplacementCount += 1;
        boundWorkerSteps.add(key);
      }
      if (type === "STEP_BLOCKED" && stepId !== null) {
        blockedAt.set(`${taskId}\u0000${stepId}`, createdAt);
      } else if (
        stepId !== null &&
        [
          "STEP_READY",
          "STEP_STARTED",
          "STEP_REVIEW",
          "STEP_SUCCEEDED",
          "STEP_FAILED",
          "STEP_CANCELLED",
          "STEP_SKIPPED",
        ].includes(type)
      ) {
        const key = `${taskId}\u0000${stepId}`;
        const start = blockedAt.get(key);
        if (start !== undefined) {
          const elapsed = duration(start, createdAt);
          if (elapsed !== null) blockedSamples.push(elapsed);
          blockedAt.delete(key);
        }
      }
      if (type === "TASK_REVIEW") {
        reviewedAt.set(taskId, createdAt);
      } else if (type === "TASK_ACCEPTED" || type === "TASK_REWORK") {
        const start = reviewedAt.get(taskId);
        if (start !== undefined) {
          const elapsed = duration(start, createdAt);
          if (elapsed !== null) reviewLatencySamples.push(elapsed);
          reviewedAt.delete(taskId);
        }
      }
    }

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
      durations: {
        retryDelay: historyTruncated.taskEvents
          ? { averageMs: null, samples: null }
          : estimate(retryDelaySamples),
        wait: historyTruncated.waits ? { averageMs: null, samples: null } : estimate(waitSamples),
        blocked: historyTruncated.taskEvents
          ? { averageMs: null, samples: null }
          : estimate(blockedSamples),
        reviewLatency: historyTruncated.taskEvents
          ? { averageMs: null, samples: null }
          : estimate(reviewLatencySamples),
        taskCompletion: historyTruncated.tasks
          ? { averageMs: null, samples: null }
          : estimate(taskCompletionSamples),
      },
      reworkCount: historyTruncated.taskEvents ? null : reworkCount,
      workerReplacementCount: historyTruncated.taskEvents ? null : workerReplacementCount,
      historyTruncated,
      backend: {
        status: backendStatus,
        unavailableBindings: observedBindings === 0 ? null : unavailableCount,
        observedBindings,
      },
    };
  });
}
