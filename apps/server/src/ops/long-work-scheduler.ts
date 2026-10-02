import type { TaskStep } from "@glassbox/contracts";
import {
  computeTaskGraphProgress,
  type TaskGraphLimits,
  type TaskGraphTransition,
} from "./task-graph.js";
import type { LongWorkOrigin, LongWorkStore } from "./long-work-store.js";

export interface LongWorkAdvanceResult {
  transitions: readonly LongWorkSchedulerTransition[];
  readyStepIds: readonly string[];
  runnableStepIds: readonly string[];
  deferredReadyStepIds: readonly string[];
}

export interface LongWorkSchedulerTransition {
  stepId: string;
  status: "ready" | "blocked" | "skipped" | "cancelled" | "running" | "succeeded";
  reason: TaskGraphTransition["reason"] | "barrier_satisfied";
}

/** Advances durable graph state only. Execution of model, Tool, and Worker Steps is external. */
export class LongWorkScheduler {
  constructor(
    private readonly store: LongWorkStore,
    private readonly limits: TaskGraphLimits,
  ) {}

  async advance(taskId: string, origin: LongWorkOrigin): Promise<LongWorkAdvanceResult> {
    const recorded: LongWorkAdvanceResult["transitions"][number][] = [];
    let steps = await this.store.listSteps(taskId);
    if (steps.length === 0) throw new Error("Task has no durable Step graph");

    // A Step can be advanced at most three times here: pending to ready, and a no-op join
    // through running to succeeded. The graph size is validated by computeTaskGraphProgress.
    for (let pass = 0; pass <= this.limits.maxSteps; pass++) {
      const progress = computeProgress(steps, this.limits);
      let changed = false;
      for (const transition of progress.transitions) {
        const current = steps.find((step) => step.id === transition.stepId)!;
        const updated = await this.store.transitionStep({
          taskId,
          stepId: current.id,
          expectedVersion: current.version,
          from: current.status,
          to: transition.status,
          origin,
          metadata: { scheduler: "graph", reason: transition.reason },
        });
        steps = replaceStep(steps, updated);
        recorded.push(transition);
        changed = true;
      }

      // A join is a no-op barrier. It may finish once all of its dependencies are terminal
      // and dependency policy has allowed it to become ready. It performs no protected work.
      // A prior Activity may have stopped between the running and succeeded commits.
      const joins = steps.filter(
        (step) =>
          step.kind === "join" &&
          ["ready", "running"].includes(step.status) &&
          step.dependencyIds.every((id) => isTerminal(steps.find((item) => item.id === id)!)),
      );
      for (const join of joins) {
        let running = join;
        if (join.status === "ready") {
          running = await this.store.transitionStep({
            taskId,
            stepId: join.id,
            expectedVersion: join.version,
            from: "ready",
            to: "running",
            origin,
            metadata: { scheduler: "join" },
          });
          steps = replaceStep(steps, running);
          recorded.push({ stepId: join.id, status: "running", reason: "barrier_satisfied" });
        }
        const succeeded = await this.store.transitionStep({
          taskId,
          stepId: join.id,
          expectedVersion: running.version,
          from: "running",
          to: "succeeded",
          origin,
          metadata: { scheduler: "join", reason: "barrier_satisfied" },
        });
        steps = replaceStep(steps, succeeded);
        recorded.push({ stepId: join.id, status: "succeeded", reason: "barrier_satisfied" });
        changed = true;
      }

      if (!changed) break;
      if (pass === this.limits.maxSteps)
        throw new Error("Task graph advancement exceeded its bounded pass count");
    }

    const result = computeProgress(steps, this.limits);
    return {
      transitions: recorded,
      readyStepIds: result.readyStepIds,
      runnableStepIds: result.runnableStepIds,
      deferredReadyStepIds: result.deferredReadyStepIds,
    };
  }
}

function replaceStep(steps: readonly TaskStep[], updated: TaskStep): TaskStep[] {
  return steps.map((step) => (step.id === updated.id ? updated : step));
}

function isTerminal(step: TaskStep): boolean {
  return ["succeeded", "failed", "blocked", "cancelled", "skipped"].includes(step.status);
}

function computeProgress(steps: readonly TaskStep[], limits: TaskGraphLimits) {
  // A blocked Step is terminal for downstream dependency evaluation. The public helper's
  // dependency policies model failure, cancellation, and skip, so treat blocked as failed
  // only in this derived view while preserving the stored state and evidence.
  return computeTaskGraphProgress(
    steps.map((step) =>
      step.status === "blocked" ? { ...step, status: "failed" as const } : step,
    ),
    limits,
  );
}
