import { createHash, randomUUID } from "node:crypto";
import type { AgentTask, TaskStep, TaskWaitPolicy } from "@glassbox/contracts";
import type { DomainStore } from "../../application/domain-store.js";
import { AccessDeniedError } from "../../auth/service.js";
import type { RunRecord } from "../../conversation/store.js";
import { getLongWorkCaller, authorizeLongWorkAction } from "../long-work-authority.js";
import { LongWorkScheduler } from "../long-work-scheduler.js";
import { DEFAULT_TASK_GRAPH_LIMITS, TaskGraphError } from "../task-graph.js";
import { parseTaskGetSpec } from "../tool-step-spec.js";
import type { AdvanceLongWorkActivity } from "./contracts.js";
import { ClaimedWorkerDispatchError } from "../service.js";
import type { HerdrWorkerRuntime } from "./herdr-worker-runtime.js";

const ORIGIN = { kind: "system", reason: "Temporal coordinator" } as const;
const RUN_POLL_MS = 10_000;
const MODEL_LEASE_MS = 60_000;

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

function modelExecutionRef(step: TaskStep): string | null {
  const ref = step.specRef;
  if (step.kind === "tool") return ref && parseTaskGetSpec(ref) ? ref : null;
  return ref && /^(?:model|pi):.+$/u.test(ref) ? ref : null;
}

function modelLeaseOwner(taskId: string, stepId: string): string {
  const digest = createHash("sha256").update(`${taskId}\0${stepId}`).digest("hex");
  return `temporal-model-${digest}`;
}

function pollResult() {
  return { kind: "wait" as const, wakeAt: new Date(Date.now() + RUN_POLL_MS).toISOString() };
}

async function settleModelRun(
  store: DomainStore,
  input: {
    taskId: string;
    step: TaskStep;
    caller: Awaited<ReturnType<typeof getLongWorkCaller>>;
    run: RunRecord;
  },
): Promise<"settled" | "pending"> {
  const lease = await store.longWork.getActiveLease(input.taskId, input.step.id);
  const ownerInstanceId = modelLeaseOwner(input.taskId, input.step.id);
  if (
    input.step.status !== "running" ||
    !lease ||
    lease.ownerInstanceId !== ownerInstanceId ||
    !lease.attemptId
  )
    return "pending";

  // Renew ownership before each durable observation. A stale or changed lease is never settled.
  const renewed = await store.longWork.updateLease({
    taskId: input.taskId,
    leaseId: lease.id,
    ownerInstanceId,
    expectedVersion: lease.version,
    action: "heartbeat",
    expiresAt: new Date(Date.now() + MODEL_LEASE_MS).toISOString(),
    origin: ORIGIN,
  });
  if (
    input.run.status === "queued" ||
    input.run.status === "running" ||
    input.run.status === "cancelling"
  )
    return "pending";
  const attemptId = lease.attemptId!;

  let decisionId: string | undefined;
  let authorizationDeniedId: string | undefined;
  try {
    decisionId = await authorizeLongWorkAction(store, {
      taskId: input.taskId,
      caller: input.caller,
      resourceId: `task-${input.taskId}`,
      action: "task:continue",
    });
  } catch (error) {
    if (!(error instanceof AccessDeniedError)) throw error;
    authorizationDeniedId = error.decision.id;
  }
  const outcome = authorizationDeniedId
    ? "unknown"
    : input.run.status === "succeeded" && input.run.resultText !== null
      ? "review"
      : input.run.status === "failed"
        ? "failed"
        : "unknown";
  const currentOrigin =
    decisionId === undefined
      ? ORIGIN
      : { kind: "decision" as const, decisionId, actorPrincipalId: input.caller.principalId };
  const failureClass = input.step.kind === "tool" ? "tool_failed" : "model_failed";
  if (
    outcome === "failed" &&
    input.step.retryPolicy?.retryableErrorClasses.includes(failureClass)
  ) {
    try {
      await store.longWork.scheduleClaimedStepRetry({
        taskId: input.taskId,
        stepId: input.step.id,
        attemptId,
        leaseId: lease.id,
        ownerInstanceId,
        expectedStepVersion: input.step.version,
        expectedLeaseVersion: renewed.version,
        proof: {
          ref: `run:${input.run.id}`,
          sideEffectOutcome: "not_applied",
          errorClass: failureClass,
        },
        origin: currentOrigin,
      });
      return "settled";
    } catch (error) {
      if (!(error instanceof Error) || !error.message.startsWith("Retry was not authorized:"))
        throw error;
    }
  }
  await store.longWork.settleClaimedStep({
    taskId: input.taskId,
    stepId: input.step.id,
    attemptId: lease.attemptId,
    leaseId: lease.id,
    ownerInstanceId,
    expectedStepVersion: input.step.version,
    expectedLeaseVersion: renewed.version,
    outcome,
    evidenceRef: authorizationDeniedId
      ? `authorization:${authorizationDeniedId}`
      : `run:${input.run.id}`,
    ...(outcome === "review" ? { outputRef: `run:${input.run.id}` } : {}),
    origin: currentOrigin,
  });
  return "settled";
}

async function observeRunningModelStep(
  store: DomainStore,
  taskId: string,
  step: TaskStep,
): Promise<"settled" | "pending" | "continue" | "not-owned"> {
  const ownerInstanceId = modelLeaseOwner(taskId, step.id);
  const lease = await store.longWork.getActiveLease(taskId, step.id);
  if (!lease || lease.ownerInstanceId !== ownerInstanceId || !lease.attemptId) return "not-owned";
  const caller = await getLongWorkCaller(store, taskId);
  let run: RunRecord | null;
  try {
    run = await store.conversations.getInternalStepRun(caller, lease.attemptId);
  } catch {
    const renewed = await store.longWork.updateLease({
      taskId,
      leaseId: lease.id,
      ownerInstanceId,
      expectedVersion: lease.version,
      action: "heartbeat",
      expiresAt: new Date(Date.now() + MODEL_LEASE_MS).toISOString(),
      origin: ORIGIN,
    });
    await store.longWork.settleClaimedStep({
      taskId,
      stepId: step.id,
      attemptId: lease.attemptId,
      leaseId: lease.id,
      ownerInstanceId,
      expectedStepVersion: step.version,
      expectedLeaseVersion: renewed.version,
      outcome: "unknown",
      evidenceRef: `run-read-unknown:${lease.attemptId}`,
      origin: ORIGIN,
    });
    return "settled";
  }

  if (run) {
    const outcome = await settleModelRun(store, { taskId, step, caller, run });
    return outcome;
  }

  // A crash may happen after claim and before the idempotent Run insert. The same
  // attempt key can safely finish that insert because no external adapter ran yet.
  const ref = modelExecutionRef(step);
  if (!ref) {
    const renewed = await store.longWork.updateLease({
      taskId,
      leaseId: lease.id,
      ownerInstanceId,
      expectedVersion: lease.version,
      action: "heartbeat",
      expiresAt: new Date(Date.now() + MODEL_LEASE_MS).toISOString(),
      origin: ORIGIN,
    });
    await store.longWork.settleClaimedStep({
      taskId,
      stepId: step.id,
      attemptId: lease.attemptId,
      leaseId: lease.id,
      ownerInstanceId,
      expectedStepVersion: step.version,
      expectedLeaseVersion: renewed.version,
      outcome: "failed",
      evidenceRef: `run-create-invalid-spec:${lease.attemptId}`,
      origin: ORIGIN,
    });
    return "settled";
  }

  try {
    await authorizeLongWorkAction(store, {
      taskId,
      caller,
      resourceId: `task-${taskId}`,
      action: "task:continue",
    });
  } catch (error) {
    if (error instanceof AccessDeniedError) {
      const renewed = await store.longWork.updateLease({
        taskId,
        leaseId: lease.id,
        ownerInstanceId,
        expectedVersion: lease.version,
        action: "heartbeat",
        expiresAt: new Date(Date.now() + MODEL_LEASE_MS).toISOString(),
        origin: ORIGIN,
      });
      await store.longWork.settleClaimedStep({
        taskId,
        stepId: step.id,
        attemptId: lease.attemptId,
        leaseId: lease.id,
        ownerInstanceId,
        expectedStepVersion: step.version,
        expectedLeaseVersion: renewed.version,
        outcome: "failed",
        evidenceRef: `run-create-denied:${lease.attemptId}`,
        origin: ORIGIN,
      });
      return "settled";
    }
    throw error;
  }
  const renewed = await store.longWork.updateLease({
    taskId,
    leaseId: lease.id,
    ownerInstanceId,
    expectedVersion: lease.version,
    action: "heartbeat",
    expiresAt: new Date(Date.now() + MODEL_LEASE_MS).toISOString(),
    origin: ORIGIN,
  });
  try {
    run = await store.conversations.createInternalStepRun({
      caller,
      taskId,
      stepId: step.id,
      attemptId: lease.attemptId,
      executionRef: ref,
    });
    return run ? "continue" : "pending";
  } catch {
    try {
      run = await store.conversations.getInternalStepRun(caller, lease.attemptId);
    } catch {
      await store.longWork.settleClaimedStep({
        taskId,
        stepId: step.id,
        attemptId: lease.attemptId,
        leaseId: lease.id,
        ownerInstanceId,
        expectedStepVersion: step.version,
        expectedLeaseVersion: renewed.version,
        outcome: "unknown",
        evidenceRef: `run-create-unknown:${lease.attemptId}`,
        origin: ORIGIN,
      });
      return "settled";
    }
    if (run) return "continue";
    await store.longWork.settleClaimedStep({
      taskId,
      stepId: step.id,
      attemptId: lease.attemptId,
      leaseId: lease.id,
      ownerInstanceId,
      expectedStepVersion: step.version,
      expectedLeaseVersion: renewed.version,
      outcome: "failed",
      evidenceRef: `run-create-failed:${lease.attemptId}`,
      origin: ORIGIN,
    });
    return "settled";
  }
}

async function settleCancelledModelStep(
  store: DomainStore,
  taskId: string,
  step: TaskStep,
): Promise<"settled" | "pending" | "not-owned"> {
  const ownerInstanceId = modelLeaseOwner(taskId, step.id);
  const lease = await store.longWork.getActiveLease(taskId, step.id);
  if (!lease || lease.ownerInstanceId !== ownerInstanceId || !lease.attemptId) return "not-owned";

  const run = await store.longWork.getClaimedModelRunForCancellation({
    taskId,
    stepId: step.id,
    attemptId: lease.attemptId,
    leaseId: lease.id,
    ownerInstanceId,
    expectedStepVersion: step.version,
    expectedLeaseVersion: lease.version,
  });
  if (run && ["queued", "running", "cancelling"].includes(run.status)) {
    await store.longWork.updateLease({
      taskId,
      leaseId: lease.id,
      ownerInstanceId,
      expectedVersion: lease.version,
      action: "heartbeat",
      expiresAt: new Date(Date.now() + MODEL_LEASE_MS).toISOString(),
      origin: ORIGIN,
    });
    return "pending";
  }
  const renewed = await store.longWork.updateLease({
    taskId,
    leaseId: lease.id,
    ownerInstanceId,
    expectedVersion: lease.version,
    action: "heartbeat",
    expiresAt: new Date(Date.now() + MODEL_LEASE_MS).toISOString(),
    origin: ORIGIN,
  });
  await store.longWork.settleClaimedStepCancellation({
    taskId,
    stepId: step.id,
    attemptId: lease.attemptId,
    leaseId: lease.id,
    ownerInstanceId,
    expectedStepVersion: step.version,
    expectedLeaseVersion: renewed.version,
    ...(run ? { runId: run.id } : {}),
    origin: ORIGIN,
  });
  return "settled";
}

async function settleCancelledChildStep(
  store: DomainStore,
  taskId: string,
  step: TaskStep,
  wakeChild?: (taskId: string) => Promise<void>,
): Promise<"settled" | "pending"> {
  const links = await store.longWork.listChildTaskLinks(taskId, step.id);
  const link = links[0];
  let childStatus: string | undefined;
  if (link && link.cancellationPolicy === "cancel_child") {
    const child = await store.tasks.getTask(link.childTaskId);
    if (!child) return "pending";
    childStatus = child.status;
    if (!["DONE", "ACCEPTED", "FAILED", "CANCELED"].includes(child.status)) {
      const caller = await getLongWorkCaller(store, child.id);
      const decision = await store.authorization.check({
        caller,
        resourceId: `task-${child.id}`,
        action: "task:cancel",
      });
      if (decision.decision !== "ALLOW") return "pending";
      if (child.orchestrationMode === "durable") {
        await store.longWork.requestDurableCancellation(child.id, {
          kind: "decision",
          decisionId: decision.id,
          actorPrincipalId: caller.principalId,
        });
        await wakeChild?.(child.id).catch(() => undefined);
      } else if (["NEW", "QUEUED"].includes(child.status) && !child.activeAttemptId)
        await store.tasks.cancelTask(child.id, "Parent Task cancellation", caller.principalId);
      return "pending";
    }
  }
  await store.longWork.transitionStep({
    taskId,
    stepId: step.id,
    expectedVersion: step.version,
    from: "running",
    to: "cancelled",
    origin: ORIGIN,
    metadata: {
      reason: link?.cancellationPolicy === "cancel_child" ? "child_stopped" : "child_kept",
      ...(link ? { childTaskId: link.childTaskId } : {}),
      ...(childStatus ? { childStatus } : {}),
      rollbackPerformed: false,
    },
  });
  return "settled";
}

async function createClaimedModelRun(
  store: DomainStore,
  input: {
    taskId: string;
    step: TaskStep;
    caller: Awaited<ReturnType<typeof getLongWorkCaller>>;
    attemptId: string;
    leaseId: string;
    ownerInstanceId: string;
    stepVersion: number;
    authorizationDecisionId: string;
  },
): Promise<RunRecord | null> {
  const origin = {
    kind: "decision" as const,
    decisionId: input.authorizationDecisionId,
    actorPrincipalId: input.caller.principalId,
  };
  const claimed = await store.longWork.claimReadyStep({
    taskId: input.taskId,
    stepId: input.step.id,
    expectedStepVersion: input.stepVersion,
    attemptId: input.attemptId,
    leaseId: input.leaseId,
    ownerInstanceId: input.ownerInstanceId,
    leaseExpiresAt: new Date(Date.now() + MODEL_LEASE_MS).toISOString(),
    origin,
  });
  const ref = modelExecutionRef(claimed.step);
  if (!ref) {
    await store.longWork.settleClaimedStep({
      taskId: input.taskId,
      stepId: claimed.step.id,
      attemptId: claimed.attempt.id,
      leaseId: claimed.lease.id,
      ownerInstanceId: input.ownerInstanceId,
      expectedStepVersion: claimed.step.version,
      expectedLeaseVersion: claimed.lease.version,
      outcome: "failed",
      evidenceRef: `run-create-invalid-spec:${claimed.attempt.id}`,
      origin: ORIGIN,
    });
    return null;
  }

  try {
    return await store.conversations.createInternalStepRun({
      caller: input.caller,
      taskId: input.taskId,
      stepId: claimed.step.id,
      attemptId: claimed.attempt.id,
      executionRef: ref,
    });
  } catch (createError) {
    // A failed response can race a committed insert. First look up by the stable attempt ID.
    try {
      const persisted = await store.conversations.getInternalStepRun(
        input.caller,
        claimed.attempt.id,
      );
      if (persisted) return persisted;
    } catch {
      await store.longWork.settleClaimedStep({
        taskId: input.taskId,
        stepId: claimed.step.id,
        attemptId: claimed.attempt.id,
        leaseId: claimed.lease.id,
        ownerInstanceId: input.ownerInstanceId,
        expectedStepVersion: claimed.step.version,
        expectedLeaseVersion: claimed.lease.version,
        outcome: "unknown",
        evidenceRef: `run-create-unknown:${claimed.attempt.id}`,
        origin: ORIGIN,
      });
      return null;
    }
    // No bound Run means the model adapter cannot have started. Leave durable failure evidence.
    await store.longWork.settleClaimedStep({
      taskId: input.taskId,
      stepId: claimed.step.id,
      attemptId: claimed.attempt.id,
      leaseId: claimed.lease.id,
      ownerInstanceId: input.ownerInstanceId,
      expectedStepVersion: claimed.step.version,
      expectedLeaseVersion: claimed.lease.version,
      outcome: "failed",
      evidenceRef: `run-create-failed:${claimed.attempt.id}`,
      origin: ORIGIN,
    });
    if (createError instanceof AccessDeniedError) return null;
    return null;
  }
}

/** The Activity claims model Steps and records durable Runs; RunService performs model execution. */
export function createAdvanceLongWorkActivity(
  store: DomainStore,
  workers?: Pick<HerdrWorkerRuntime, "dispatch" | "observe" | "cancel" | "ownerInstanceId">,
  wakeChild?: (taskId: string) => Promise<void>,
): AdvanceLongWorkActivity {
  const scheduler = new LongWorkScheduler(store.longWork, DEFAULT_TASK_GRAPH_LIMITS);
  return async ({ taskId, policyRevision }) => {
    const task = assertCurrentTask(await store.tasks.getTask(taskId), policyRevision);
    if (["DONE", "CANCELED", "FAILED"].includes(task.status)) return { kind: "complete" };
    if (task.cancellationState !== "none") {
      const steps = await store.longWork.listSteps(taskId);
      let pending = false;
      for (const step of steps) {
        if (step.kind === "child_task" && step.status === "running") {
          const result = await settleCancelledChildStep(store, taskId, step, wakeChild);
          if (result === "settled") return { kind: "continue" };
          pending = true;
          continue;
        }
        if (step.kind === "herdr_worker" && step.status === "running") {
          if (workers && (await workers.cancel(taskId, step)) === "settled")
            return { kind: "continue" };
          pending = true;
          continue;
        }
        if (!["model", "tool"].includes(step.kind) || step.status !== "running") continue;
        const result = await settleCancelledModelStep(store, taskId, step);
        if (result === "settled") return { kind: "continue" };
        pending = true;
      }
      if (pending || steps.some((step) => step.status === "running")) return pollResult();
      try {
        await store.longWork.settleDurableCancellation(taskId, ORIGIN);
        return { kind: "complete" };
      } catch (error) {
        if (
          error instanceof Error &&
          error.message.includes("still have running Steps or active leases")
        )
          return pollResult();
        throw error;
      }
    }
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
    let modelRunPending = false;
    let workerPending = false;
    let childPending = false;
    for (const step of steps) {
      if (step.kind === "child_task" && step.status === "running") {
        const links = await store.longWork.listChildTaskLinks(taskId, step.id);
        if (links.length !== 1) {
          childPending = true;
          continue;
        }
        try {
          await authorizeLongWorkAction(store, {
            taskId,
            resourceId: `task-${taskId}`,
            action: "task:continue",
          });
        } catch (error) {
          if (!(error instanceof AccessDeniedError)) throw error;
          await store.longWork.transitionStep({
            taskId,
            stepId: step.id,
            expectedVersion: step.version,
            from: "running",
            to: "blocked",
            origin: ORIGIN,
            evidenceRef: `authorization:${error.decision.id}`,
            metadata: { reason: "child_continuation_denied" },
          });
          return { kind: "continue" };
        }
        const settled = await store.longWork.observeLinkedChildTask({
          parentTaskId: taskId,
          parentStepId: step.id,
          childTaskId: links[0]!.childTaskId,
          expectedStepVersion: step.version,
          origin: ORIGIN,
        });
        if (settled) return { kind: "continue" };
        childPending = true;
        continue;
      }
      if (step.kind === "herdr_worker" && step.status === "running" && workers) {
        const observed = await workers.observe(taskId, step);
        if (observed === "settled") return { kind: "continue" };
        workerPending = true;
        continue;
      }
      if (!["model", "tool"].includes(step.kind) || step.status !== "running") continue;
      const observed = await observeRunningModelStep(store, taskId, step);
      if (observed === "settled" || observed === "continue") return { kind: "continue" };
      if (observed === "pending") modelRunPending = true;
    }

    let addedWait = false;
    let unsupported = false;
    for (const stepId of progress.runnableStepIds) {
      const step = byId.get(stepId)!;
      if (step.kind === "child_task") {
        childPending = true;
        continue;
      }
      if (step.kind === "herdr_worker" && workers) {
        if (!step.instructions?.trim() || step.specRef || step.requiredCapabilities.length > 0) {
          await store.longWork.transitionStep({
            taskId,
            stepId,
            expectedVersion: step.version,
            from: "ready",
            to: "blocked",
            origin: ORIGIN,
            metadata: { reason: "invalid_worker_step_spec", outcome: "not_started" },
          });
          return { kind: "continue" };
        }
        const caller = await getLongWorkCaller(store, taskId);
        let decisionId: string;
        try {
          decisionId = await authorizeLongWorkAction(store, {
            taskId,
            caller,
            resourceId: `task-${taskId}`,
            action: "task:continue",
          });
          await authorizeLongWorkAction(store, {
            taskId,
            caller,
            resourceId: `task-${taskId}`,
            action: "task:delegate",
          });
        } catch (error) {
          if (!(error instanceof AccessDeniedError)) throw error;
          await store.longWork.transitionStep({
            taskId,
            stepId,
            expectedVersion: step.version,
            from: "ready",
            to: "blocked",
            origin: ORIGIN,
            evidenceRef: `authorization:${error.decision.id}`,
            metadata: { reason: "worker_delegation_denied", outcome: "not_started" },
          });
          return { kind: "continue" };
        }
        let claimed: Awaited<ReturnType<typeof store.longWork.claimReadyStep>>;
        try {
          claimed = await store.longWork.claimReadyStep({
            taskId,
            stepId,
            expectedStepVersion: step.version,
            attemptId: randomUUID(),
            leaseId: randomUUID(),
            ownerInstanceId: workers.ownerInstanceId,
            leaseExpiresAt: new Date(Date.now() + MODEL_LEASE_MS).toISOString(),
            maxActiveWorkerAttemptsPerPrincipal:
              DEFAULT_TASK_GRAPH_LIMITS.maxActiveWorkerAttemptsPerPrincipal,
            origin: { kind: "decision", decisionId, actorPrincipalId: caller.principalId },
          });
        } catch (error) {
          if (error instanceof TaskGraphError && error.code === "ACTIVE_WORKER_LIMIT")
            return pollResult();
          throw error;
        }
        try {
          await workers.dispatch(caller, claimed);
        } catch (error) {
          const lease = await store.longWork.getActiveLease(taskId, stepId);
          if (lease?.attemptId === claimed.attempt.id) {
            const outcome =
              error instanceof ClaimedWorkerDispatchError && error.outcome === "not_started"
                ? "failed"
                : "unknown";
            await store.longWork.settleClaimedStep({
              taskId,
              stepId,
              attemptId: claimed.attempt.id,
              leaseId: lease.id,
              ownerInstanceId: lease.ownerInstanceId,
              expectedStepVersion: claimed.step.version,
              expectedLeaseVersion: lease.version,
              ...(lease.workerBindingId ? { workerBindingId: lease.workerBindingId } : {}),
              outcome,
              evidenceRef:
                error instanceof ClaimedWorkerDispatchError && error.decisionId
                  ? `authorization:${error.decisionId}`
                  : `worker-dispatch:${outcome}:${claimed.attempt.id}`,
              origin: ORIGIN,
            });
          }
        }
        return { kind: "continue" };
      }
      if (step.kind === "model" || step.kind === "tool") {
        if (
          (step.kind === "model"
            ? step.requiredCapabilities.some((capability) => capability !== "text")
            : step.requiredCapabilities.length > 0) ||
          step.delegatedPermissionSet.length > 0
        ) {
          await store.longWork.transitionStep({
            taskId,
            stepId,
            expectedVersion: step.version,
            from: "ready",
            to: "blocked",
            origin: ORIGIN,
            metadata: {
              reason:
                step.kind === "tool"
                  ? "tool_execution_boundary_exceeded"
                  : "model_execution_boundary_exceeded",
              outcome: "not_started",
            },
          });
          unsupported = true;
          continue;
        }
        const executionRef = modelExecutionRef(step);
        if (!executionRef) {
          await store.longWork.transitionStep({
            taskId,
            stepId,
            expectedVersion: step.version,
            from: "ready",
            to: "blocked",
            origin: ORIGIN,
            metadata: { reason: "invalid_model_execution_ref", outcome: "not_started" },
          });
          unsupported = true;
          continue;
        }
        const caller = await getLongWorkCaller(store, taskId);
        let decisionId: string;
        try {
          decisionId = await authorizeLongWorkAction(store, {
            taskId,
            caller,
            resourceId: `task-${taskId}`,
            action: "task:continue",
          });
        } catch (error) {
          if (error instanceof AccessDeniedError) {
            await store.longWork.transitionStep({
              taskId,
              stepId,
              expectedVersion: step.version,
              from: "ready",
              to: "blocked",
              origin: ORIGIN,
              evidenceRef: `authorization:${error.decision.id}`,
              metadata: { reason: "task_continuation_denied", outcome: "not_started" },
            });
            return { kind: "continue" };
          }
          throw error;
        }
        await createClaimedModelRun(store, {
          taskId,
          step,
          caller,
          attemptId: randomUUID(),
          leaseId: randomUUID(),
          ownerInstanceId: modelLeaseOwner(taskId, step.id),
          stepVersion: step.version,
          authorizationDecisionId: decisionId,
        });
        return { kind: "continue" };
      }
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
    const modelWake = () => ({
      kind: "wait" as const,
      wakeAt: new Date(
        Math.min(Date.now() + RUN_POLL_MS, due ?? Number.POSITIVE_INFINITY),
      ).toISOString(),
    });
    if (blockedStep) {
      await store.longWork.markTaskNeedsAttention(taskId, ORIGIN, blockedStep.id);
      if (modelRunPending || workerPending || childPending) return modelWake();
      return due === undefined
        ? { kind: "wait" }
        : { kind: "wait", wakeAt: new Date(due).toISOString() };
    }
    // A running non-wait Step may belong to a live executor. Until the executor or
    // reconciler records loss evidence, preserve it and never dispatch it again here.
    if (modelRunPending || workerPending || childPending) return modelWake();
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
