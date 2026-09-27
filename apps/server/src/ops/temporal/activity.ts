import { randomUUID } from "node:crypto";
import type { AgentTask, TaskStep, TaskWaitPolicy } from "@glassbox/contracts";
import type { DomainStore } from "../../application/domain-store.js";
import { LongWorkScheduler } from "../long-work-scheduler.js";
import { DEFAULT_TASK_GRAPH_LIMITS } from "../task-graph.js";
import type { AdvanceLongWorkActivity } from "./contracts.js";

const ORIGIN = { kind: "system", reason: "Temporal coordinator" } as const;

function waitKindMatchesStep(step: TaskStep, policy: TaskWaitPolicy): boolean {
  if (step.kind === "timer_wait") return ["duration", "until", "deadline"].includes(policy.kind);
  if (step.kind === "signal_wait") return policy.kind === "signal";
  if (step.kind === "approval_wait") return policy.kind === "approval";
  return false;
}

function assertCurrentTask(task: AgentTask | null, policyRevision: number): AgentTask {
  if (!task || task.orchestrationMode !== "durable" || task.policyRevision !== policyRevision)
    throw new Error("Temporal input does not match current durable Task policy");
  return task;
}

/** The Activity only changes idempotent Glassbox records. External work is dispatched elsewhere. */
export function createAdvanceLongWorkActivity(store: DomainStore): AdvanceLongWorkActivity {
  const scheduler = new LongWorkScheduler(store.longWork, DEFAULT_TASK_GRAPH_LIMITS);
  return async ({ taskId, policyRevision }) => {
    const task = assertCurrentTask(await store.tasks.getTask(taskId), policyRevision);
    if (["DONE", "CANCELED", "FAILED"].includes(task.status) || task.cancellationState !== "none")
      return { kind: "complete" };
    if (task.status === "REVIEW") return { kind: "complete" };

    const waitingBefore = await store.longWork.listWaiting(taskId);
    const now = Date.now();
    for (const wait of waitingBefore) {
      if (
        (wait.policy.dueAt && Date.parse(wait.policy.dueAt) <= now) ||
        (wait.policy.timeoutAt && Date.parse(wait.policy.timeoutAt) <= now)
      ) {
        const step = (await store.longWork.listSteps(taskId)).find(
          (item) => item.id === wait.stepId,
        );
        if (!step || step.status !== "waiting") continue;
        await store.longWork.fireDueWait(taskId, step.id, step.version, ORIGIN);
        return { kind: "continue" };
      }
    }

    const progress = await scheduler.advance(taskId, ORIGIN);
    const steps = await store.longWork.listSteps(taskId);
    const byId = new Map(steps.map((step) => [step.id, step]));
    let addedWait = false;
    let unsupported = false;
    for (const stepId of progress.runnableStepIds) {
      const step = byId.get(stepId)!;
      if (!["timer_wait", "signal_wait", "approval_wait"].includes(step.kind)) {
        await store.longWork.transitionStep({
          taskId,
          stepId,
          expectedVersion: step.version,
          from: "ready",
          to: "blocked",
          origin: ORIGIN,
          metadata: {
            reason: "executor_unavailable",
            outcome: "not_started",
            retryable: false,
            attempts: 0,
            maxAttempts: step.retryPolicy?.maxAttempts ?? step.maxAttempts,
            kind: step.kind,
          },
        });
        unsupported = true;
        continue;
      }
      if (!step.waitPolicy || !waitKindMatchesStep(step, step.waitPolicy))
        throw new Error(`Wait Step ${step.id} has no compatible policy`);
      if (
        step.kind === "timer_wait" &&
        step.waitPolicy.dueAt &&
        Date.parse(step.waitPolicy.dueAt) <= Date.now()
      ) {
        if (step.waitPolicy.overdue === "stale") {
          await store.longWork.transitionStep({
            taskId,
            stepId,
            expectedVersion: step.version,
            from: "ready",
            to: "blocked",
            origin: ORIGIN,
            metadata: { reason: "timer_overdue" },
          });
        } else {
          const running = await store.longWork.transitionStep({
            taskId,
            stepId,
            expectedVersion: step.version,
            from: "ready",
            to: "running",
            origin: ORIGIN,
            metadata: { reason: "timer_overdue" },
          });
          await store.longWork.transitionStep({
            taskId,
            stepId,
            expectedVersion: running.version,
            from: "running",
            to: "succeeded",
            origin: ORIGIN,
            metadata: { reason: "timer_overdue" },
          });
        }
        addedWait = true;
        continue;
      }
      await store.longWork.createWait({
        id: randomUUID(),
        taskId,
        stepId,
        expectedStepVersion: step.version,
        policy: step.waitPolicy,
        origin: ORIGIN,
      });
      addedWait = true;
    }
    if (addedWait || unsupported) return { kind: "continue" };

    const root = byId.get(task.rootStepId ?? "");
    const waits = await store.longWork.listWaiting(taskId);
    const due = waits
      .flatMap((wait) => [wait.policy.dueAt, wait.policy.timeoutAt])
      .filter((value): value is string => value !== undefined)
      .map((value) => Date.parse(value))
      .filter(Number.isFinite)
      .sort((a, b) => a - b)[0];
    const blockedStep = steps.find((step) => ["blocked", "failed"].includes(step.status));
    if (blockedStep) {
      await store.longWork.markTaskNeedsAttention(taskId, ORIGIN, blockedStep.id);
      return due === undefined
        ? { kind: "wait" }
        : { kind: "wait", wakeAt: new Date(due).toISOString() };
    }
    // A running non-wait Step may belong to a live executor. Until the executor or
    // reconciler records loss evidence, preserve it and never dispatch it again here.
    if (steps.some((step) => step.status === "running")) return { kind: "wait" };
    const terminal = steps.every((step) =>
      ["succeeded", "failed", "cancelled", "skipped"].includes(step.status),
    );
    if (root?.status === "succeeded" && terminal) {
      await store.longWork.markTaskReview(taskId, ORIGIN);
      return { kind: "complete" };
    }
    return due === undefined
      ? { kind: "wait" }
      : { kind: "wait", wakeAt: new Date(due).toISOString() };
  };
}
