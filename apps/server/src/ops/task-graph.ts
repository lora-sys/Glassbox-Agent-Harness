import {
  TASK_STEP_KINDS,
  TASK_STEP_STATUSES,
  type DependencyOutcome,
  type TaskStep,
} from "@glassbox/contracts";

export interface TaskGraphLimits {
  maxSteps: number;
  maxDependenciesPerStep: number;
  maxFanOut: number;
  maxReadySteps: number;
  maxParallelSteps: number;
}

export const DEFAULT_TASK_GRAPH_LIMITS: Readonly<TaskGraphLimits> = Object.freeze({
  maxSteps: 64,
  maxDependenciesPerStep: 8,
  maxFanOut: 8,
  maxReadySteps: 16,
  maxParallelSteps: 4,
});

export type TaskGraphErrorCode =
  | "INVALID_LIMIT"
  | "INVALID_STEP"
  | "DUPLICATE_STEP"
  | "MISSING_DEPENDENCY"
  | "DUPLICATE_DEPENDENCY"
  | "CYCLE"
  | "STEP_LIMIT"
  | "DEPENDENCY_LIMIT"
  | "FAN_OUT_LIMIT"
  | "READY_LIMIT";

export class TaskGraphError extends Error {
  constructor(
    readonly code: TaskGraphErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "TaskGraphError";
  }
}

export interface TaskGraphValidation {
  /** Stable dependency-first order. Siblings are ordered by step ID. */
  topologicalStepIds: readonly string[];
}

export interface TaskGraphTransition {
  stepId: string;
  status: "ready" | "blocked" | "skipped" | "cancelled";
  reason:
    | "dependencies_satisfied"
    | "dependency_failed"
    | "dependency_cancelled"
    | "dependency_skipped";
}

export interface TaskGraphProgress extends TaskGraphValidation {
  transitions: readonly TaskGraphTransition[];
  readyStepIds: readonly string[];
  runnableStepIds: readonly string[];
  deferredReadyStepIds: readonly string[];
}

const OUTCOME_PRIORITY: Record<DependencyOutcome, number> = {
  continue: 0,
  block: 1,
  skip: 2,
  cancel: 3,
};

function positiveLimit(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function checkLimits(limits: TaskGraphLimits): void {
  for (const [name, value] of Object.entries(limits)) {
    if (!positiveLimit(value)) {
      throw new TaskGraphError("INVALID_LIMIT", `${name} must be a positive safe integer`);
    }
  }
}

function assertStep(step: TaskStep, taskId: string): void {
  if (
    !step.id ||
    !step.taskId ||
    step.taskId !== taskId ||
    !TASK_STEP_KINDS.includes(step.kind) ||
    !TASK_STEP_STATUSES.includes(step.status) ||
    !Array.isArray(step.dependencyIds)
  ) {
    throw new TaskGraphError("INVALID_STEP", `Invalid step ${step.id}`);
  }
  for (const outcome of [
    step.dependencyPolicy?.failed,
    step.dependencyPolicy?.cancelled,
    step.dependencyPolicy?.skipped,
  ]) {
    if (!(outcome && Object.hasOwn(OUTCOME_PRIORITY, outcome))) {
      throw new TaskGraphError("INVALID_STEP", `Invalid dependency policy for ${step.id}`);
    }
  }
}

export function validateTaskGraph(
  steps: readonly TaskStep[],
  limits: TaskGraphLimits,
): TaskGraphValidation {
  checkLimits(limits);
  if (steps.length > limits.maxSteps) {
    throw new TaskGraphError("STEP_LIMIT", `Graph has ${steps.length} steps`);
  }
  if (steps.length === 0) return { topologicalStepIds: [] };

  const byId = new Map<string, TaskStep>();
  const taskId = steps[0]!.taskId;
  for (const step of steps) {
    assertStep(step, taskId);
    if (byId.has(step.id)) {
      throw new TaskGraphError("DUPLICATE_STEP", `Duplicate step ${step.id}`);
    }
    byId.set(step.id, step);
  }

  const dependents = new Map<string, string[]>();
  const remaining = new Map<string, number>();
  for (const step of steps) {
    if (step.dependencyIds.length > limits.maxDependenciesPerStep) {
      throw new TaskGraphError("DEPENDENCY_LIMIT", `Step ${step.id} has too many dependencies`);
    }
    const distinct = new Set(step.dependencyIds);
    if (distinct.size !== step.dependencyIds.length) {
      throw new TaskGraphError("DUPLICATE_DEPENDENCY", `Step ${step.id} repeats a dependency`);
    }
    remaining.set(step.id, distinct.size);
    for (const dependencyId of distinct) {
      if (!byId.has(dependencyId)) {
        throw new TaskGraphError("MISSING_DEPENDENCY", `Step ${step.id} needs ${dependencyId}`);
      }
      const successors = dependents.get(dependencyId) ?? [];
      successors.push(step.id);
      if (successors.length > limits.maxFanOut) {
        throw new TaskGraphError("FAN_OUT_LIMIT", `Step ${dependencyId} exceeds fan-out limit`);
      }
      dependents.set(dependencyId, successors);
    }
  }

  const available = [...remaining.entries()]
    .filter(([, count]) => count === 0)
    .map(([id]) => id)
    .sort();
  const order: string[] = [];
  while (available.length > 0) {
    const id = available.shift()!;
    order.push(id);
    for (const successorId of dependents.get(id) ?? []) {
      const count = remaining.get(successorId)! - 1;
      remaining.set(successorId, count);
      if (count === 0) {
        available.push(successorId);
        available.sort();
      }
    }
  }
  if (order.length !== steps.length) {
    throw new TaskGraphError("CYCLE", "Task dependency graph contains a cycle");
  }
  return { topologicalStepIds: order };
}

function terminalDependencyOutcome(
  step: TaskStep,
  dependencies: readonly TaskStep[],
): {
  outcome: DependencyOutcome;
  reason: TaskGraphTransition["reason"];
} | null {
  const outcomes: Array<{
    outcome: DependencyOutcome;
    reason: TaskGraphTransition["reason"];
  }> = [];
  for (const dependency of dependencies) {
    const status = dependency.status;
    if (status === "failed" || status === "cancelled" || status === "skipped") {
      outcomes.push({
        outcome: step.dependencyPolicy[status],
        reason: `dependency_${status}`,
      });
    }
  }
  outcomes.sort(
    (a, b) =>
      OUTCOME_PRIORITY[b.outcome] - OUTCOME_PRIORITY[a.outcome] ||
      (a.reason < b.reason ? -1 : a.reason > b.reason ? 1 : 0),
  );
  return outcomes[0] ?? null;
}

/** Computes proposed state changes. Callers must persist them with version checks. */
export function computeTaskGraphProgress(
  steps: readonly TaskStep[],
  limits: TaskGraphLimits,
): TaskGraphProgress {
  const validation = validateTaskGraph(steps, limits);
  const byId = new Map(steps.map((step) => [step.id, step]));
  const effectiveStatus = new Map(steps.map((step) => [step.id, step.status]));
  const transitions: TaskGraphTransition[] = [];
  const alreadyReady = steps.filter((step) => step.status === "ready").length;
  if (alreadyReady > limits.maxReadySteps) {
    throw new TaskGraphError("READY_LIMIT", "Existing ready steps exceed the configured limit");
  }
  let readySlots = limits.maxReadySteps - alreadyReady;
  const readyStepIds: string[] = [];
  const deferredReadyStepIds: string[] = [];
  for (const id of validation.topologicalStepIds) {
    const step = byId.get(id)!;
    if (step.status !== "pending" && step.status !== "ready") continue;
    const dependencies = step.dependencyIds.map((dependencyId) => ({
      ...byId.get(dependencyId)!,
      status: effectiveStatus.get(dependencyId)!,
    }));
    const failure = terminalDependencyOutcome(step, dependencies);
    if (failure && failure.outcome !== "continue") {
      const status =
        failure.outcome === "cancel"
          ? "cancelled"
          : failure.outcome === "skip"
            ? "skipped"
            : "blocked";
      transitions.push({ stepId: id, status, reason: failure.reason });
      effectiveStatus.set(id, status);
      continue;
    }
    const settled = dependencies.every(
      (dependency) =>
        dependency.status === "succeeded" ||
        dependency.status === "failed" ||
        dependency.status === "cancelled" ||
        dependency.status === "skipped",
    );
    if (!settled) continue;
    if (step.status === "ready") {
      readyStepIds.push(id);
      continue;
    }
    if (readySlots === 0) {
      deferredReadyStepIds.push(id);
      continue;
    }
    readySlots--;
    readyStepIds.push(id);
    transitions.push({ stepId: id, status: "ready", reason: "dependencies_satisfied" });
  }
  const running = steps.filter((step) => step.status === "running").length;
  const available = Math.max(0, limits.maxParallelSteps - running);
  return {
    ...validation,
    transitions,
    readyStepIds,
    runnableStepIds: readyStepIds.slice(0, available),
    deferredReadyStepIds,
  };
}
