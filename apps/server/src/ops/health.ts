import type {
  AgentTask,
  HerdrAgentLifecycleState,
  TaskAttempt,
  WorkerBinding,
} from "@glassbox/contracts";

export type OpsBridgeState = "connected" | "disconnected" | "reconnecting" | "unknown";

export interface HerdrWorkerObservation {
  taskAttemptId: string;
  state: HerdrAgentLifecycleState;
  observedAt: string;
}

export interface OpsHealthInput {
  tasks: readonly AgentTask[];
  attempts: readonly TaskAttempt[];
  bindings: readonly WorkerBinding[];
  herdr: {
    bridgeState: OpsBridgeState;
    /** Set after events_lost and until a fresh session.snapshot has been reconciled. */
    eventsLost: boolean;
    lastSuccessfulReconciliationAt: string | null;
    observations: readonly HerdrWorkerObservation[];
  };
  now: string;
  windowStart: string;
  staleAfterMs?: number;
}

export interface OpsHealthSnapshot {
  durable: {
    activeTasks: number;
    waitingReviewTasks: number;
    acceptedTasksInWindow: number;
    attemptsInWindow: number;
    reworkAttempts: number;
    reworkRate: number | null;
    meanReviewLatencyMs: number | null;
    reviewLatencySamples: number;
  };
  workers: {
    total: number;
    starting: number;
    working: number;
    blocked: number;
    idle: number;
    done: number;
    unknown: number;
  };
  herdr: {
    state: "healthy" | "degraded" | "unavailable" | "unknown";
    stale: boolean;
    lastSuccessfulReconciliationAt: string | null;
    reason: "events_lost" | "reconnecting" | "disconnected" | "stale" | "unknown" | null;
  };
}

const activeTaskStatuses = new Set(["NEW", "QUEUED", "ASSIGNED", "RUNNING", "WAITING_INPUT"]);
const acceptedTaskStatus = "DONE";

function timestamp(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Builds an Ops projection from durable Glassbox records and explicit live Herdr observations.
 * Herdr's `done` lifecycle state remains a worker observation and never increments accepted Tasks.
 */
export function buildOpsHealthSnapshot(input: OpsHealthInput): OpsHealthSnapshot {
  const nowMs = timestamp(input.now);
  const windowStartMs = timestamp(input.windowStart);
  const staleAfterMs = input.staleAfterMs ?? 30_000;
  if (nowMs === null || windowStartMs === null || staleAfterMs < 0) {
    throw new RangeError(
      "Ops health requires valid now/window timestamps and a non-negative staleAfterMs",
    );
  }

  const reconciliationMs = timestamp(input.herdr.lastSuccessfulReconciliationAt);
  const stale =
    input.herdr.bridgeState !== "connected" ||
    input.herdr.eventsLost ||
    reconciliationMs === null ||
    nowMs - reconciliationMs > staleAfterMs ||
    reconciliationMs > nowMs;

  let bridgeReason: OpsHealthSnapshot["herdr"]["reason"] = null;
  if (input.herdr.eventsLost) bridgeReason = "events_lost";
  else if (input.herdr.bridgeState === "reconnecting") bridgeReason = "reconnecting";
  else if (input.herdr.bridgeState === "disconnected") bridgeReason = "disconnected";
  else if (reconciliationMs === null || reconciliationMs > nowMs) bridgeReason = "unknown";
  else if (nowMs - reconciliationMs > staleAfterMs) bridgeReason = "stale";

  const attemptById = new Map(input.attempts.map((attempt) => [attempt.id, attempt]));
  const attemptsByTask = new Map<string, TaskAttempt[]>();
  for (const attempt of input.attempts) {
    const attempts = attemptsByTask.get(attempt.taskId) ?? [];
    attempts.push(attempt);
    attemptsByTask.set(attempt.taskId, attempts);
  }

  const acceptedTasksInWindow = input.tasks.filter((task) => {
    const updatedAt = timestamp(task.updatedAt);
    return (
      task.status === acceptedTaskStatus &&
      updatedAt !== null &&
      updatedAt >= windowStartMs &&
      updatedAt <= nowMs
    );
  }).length;

  const attemptsInWindow = input.attempts.filter((attempt) => {
    const completedAt = timestamp(attempt.completedAt);
    return completedAt !== null && completedAt >= windowStartMs && completedAt <= nowMs;
  }).length;
  const reworkAttempts = input.attempts.filter((attempt) => attempt.attemptNumber > 1).length;
  const tasksWithAttempts = input.tasks.filter((task) => attemptsByTask.has(task.id));
  const reworkedTaskCount = tasksWithAttempts.filter(
    (task) => (attemptsByTask.get(task.id)?.length ?? 0) > 1,
  ).length;

  const reviewLatencies: number[] = [];
  for (const task of input.tasks) {
    if (task.status !== acceptedTaskStatus) continue;
    const attempt = task.activeAttemptId ? attemptById.get(task.activeAttemptId) : undefined;
    const acceptedAt = timestamp(task.updatedAt);
    const reviewReadyAt = timestamp(attempt?.completedAt);
    if (acceptedAt !== null && reviewReadyAt !== null && acceptedAt >= reviewReadyAt) {
      reviewLatencies.push(acceptedAt - reviewReadyAt);
    }
  }

  const observationsByAttempt = new Map<string, HerdrWorkerObservation>();
  for (const observation of input.herdr.observations) {
    const current = observationsByAttempt.get(observation.taskAttemptId);
    const observedAtMs = timestamp(observation.observedAt);
    const currentAtMs = timestamp(current?.observedAt);
    if (observedAtMs !== null && (currentAtMs === null || observedAtMs >= currentAtMs)) {
      observationsByAttempt.set(observation.taskAttemptId, observation);
    }
  }

  const workerCounts = { starting: 0, working: 0, blocked: 0, idle: 0, done: 0, unknown: 0 };
  for (const binding of input.bindings) {
    const observation = observationsByAttempt.get(binding.taskAttemptId);
    const observedAtMs = timestamp(observation?.observedAt);
    const workerStale =
      stale ||
      !observation ||
      observedAtMs === null ||
      nowMs - observedAtMs > staleAfterMs ||
      observedAtMs > nowMs;
    const state = workerStale ? "unknown" : observation.state;
    workerCounts[state] += 1;
  }

  let herdrState: OpsHealthSnapshot["herdr"]["state"] = "healthy";
  if (input.herdr.bridgeState === "disconnected") herdrState = "unavailable";
  else if (input.herdr.eventsLost) herdrState = "degraded";
  else if (input.herdr.bridgeState !== "connected" || stale) herdrState = "unknown";

  return {
    durable: {
      activeTasks: input.tasks.filter((task) => activeTaskStatuses.has(task.status)).length,
      waitingReviewTasks: input.tasks.filter((task) => task.status === "REVIEW").length,
      acceptedTasksInWindow,
      attemptsInWindow,
      reworkAttempts,
      reworkRate: tasksWithAttempts.length ? reworkedTaskCount / tasksWithAttempts.length : null,
      meanReviewLatencyMs: reviewLatencies.length
        ? reviewLatencies.reduce((sum, latency) => sum + latency, 0) / reviewLatencies.length
        : null,
      reviewLatencySamples: reviewLatencies.length,
    },
    workers: { total: input.bindings.length, ...workerCounts },
    herdr: {
      state: herdrState,
      stale,
      lastSuccessfulReconciliationAt: input.herdr.lastSuccessfulReconciliationAt,
      reason: bridgeReason,
    },
  };
}
