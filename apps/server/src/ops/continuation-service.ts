import type { DurableContinuationCadence, DurableContinuationSchedule } from "@glassbox/contracts";
import { AccessDeniedError, evaluate } from "../auth/service.js";
import type { DomainStore } from "../application/domain-store.js";
import { scopeKey, type CallerContext } from "../identity/scope.js";
import type { ContinuationWriteGuard } from "./continuation-store.js";

export interface ContinuationRuntimePort {
  start(scheduleId: string): Promise<void>;
  wake(scheduleId: string): Promise<void>;
  stop(scheduleId: string): Promise<void>;
}

export interface ContinuationMutationResult {
  schedule: DurableContinuationSchedule;
  runtimeReady: boolean;
}

/** Task-facing authorization for the domain-neutral timer. Activity owns its own policy. */
export class AuthorizedContinuationService {
  constructor(
    private readonly store: DomainStore,
    private readonly runtime?: ContinuationRuntimePort,
  ) {}

  private async authorize(caller: CallerContext, taskId: string) {
    const resourceId = `task-${taskId}`;
    const action = "task:continue";
    const decision = await this.store.authorization.check({
      caller,
      resourceId,
      action,
      delegatedTaskId: taskId,
    });
    await this.store.tasks.recordAuthorizationTrace({
      principalId: caller.principalId,
      resourceId,
      action,
      scopeKey: scopeKey(caller.scope),
      decision: decision.decision,
      reason: decision.reason,
    });
    if (decision.decision !== "ALLOW") throw new AccessDeniedError(decision);
    return {
      kind: "decision" as const,
      decisionId: decision.id,
      actorPrincipalId: caller.principalId,
    };
  }

  private async taskSchedule(caller: CallerContext, taskId: string, scheduleId: string) {
    const origin = await this.authorize(caller, taskId);
    const schedule = await this.store.continuations.get(scheduleId);
    if (!schedule || schedule.target.kind !== "task" || schedule.target.targetId !== taskId)
      throw new Error("Task continuation schedule not found");
    return { schedule, origin };
  }

  private currentTaskGrant(caller: CallerContext, taskId: string): ContinuationWriteGuard {
    return async (tx) => {
      const current = await evaluate(tx, {
        caller,
        resourceId: `task-${taskId}`,
        action: "task:continue",
        delegatedTaskId: taskId,
      });
      if (current.decision !== "ALLOW") throw new AccessDeniedError(current);
    };
  }

  private async notifyRuntime(
    schedule: DurableContinuationSchedule,
    action: "start" | "wake" | "stop",
  ): Promise<ContinuationMutationResult> {
    try {
      if (!this.runtime) throw new Error("Temporal continuation runtime is unavailable");
      await this.runtime[action](schedule.id);
      return { schedule, runtimeReady: true };
    } catch {
      // The durable mutation already committed. Reconciliation starts or wakes it later.
      return { schedule, runtimeReady: false };
    }
  }

  async scheduleTask(
    caller: CallerContext,
    input: {
      scheduleId: string;
      taskId: string;
      nextDueAt: string;
      cadence: DurableContinuationCadence;
    },
  ): Promise<ContinuationMutationResult> {
    const origin = await this.authorize(caller, input.taskId);
    const task = await this.store.tasks.getTask(input.taskId);
    if (
      !task ||
      task.orchestrationMode !== "durable" ||
      ["REVIEW", "ACCEPTED", "DONE", "CANCELED", "FAILED"].includes(task.status)
    )
      throw new Error("An active durable Task is required");
    const schedule = await this.store.continuations.schedule(
      {
        id: input.scheduleId,
        target: { kind: "task", targetId: input.taskId },
        cadence: input.cadence,
        nextDueAt: input.nextDueAt,
        origin,
      },
      new Date().toISOString(),
      this.currentTaskGrant(caller, input.taskId),
    );
    return this.notifyRuntime(schedule, "start");
  }

  async rescheduleTask(
    caller: CallerContext,
    input: { taskId: string; scheduleId: string; expectedVersion: number; nextDueAt: string },
  ): Promise<ContinuationMutationResult> {
    const { origin } = await this.taskSchedule(caller, input.taskId, input.scheduleId);
    const schedule = await this.store.continuations.reschedule(
      input.scheduleId,
      input.expectedVersion,
      input.nextDueAt,
      origin,
      new Date().toISOString(),
      this.currentTaskGrant(caller, input.taskId),
    );
    if (!schedule) throw new Error("Continuation schedule version conflict");
    return this.notifyRuntime(schedule, "wake");
  }

  async cancelFutureTask(
    caller: CallerContext,
    input: { taskId: string; scheduleId: string; expectedVersion: number },
  ): Promise<ContinuationMutationResult> {
    const { origin } = await this.taskSchedule(caller, input.taskId, input.scheduleId);
    const schedule = await this.store.continuations.cancelFuture(
      input.scheduleId,
      input.expectedVersion,
      origin,
      new Date().toISOString(),
      this.currentTaskGrant(caller, input.taskId),
    );
    if (!schedule) throw new Error("Continuation schedule version conflict");
    // A previously fired occurrence may still need delivery. Wake the workflow so it
    // observes cancellation and drains those records before completing.
    return this.notifyRuntime(schedule, "wake");
  }
}
