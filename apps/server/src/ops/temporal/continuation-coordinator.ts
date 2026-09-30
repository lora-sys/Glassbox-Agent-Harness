import type { DurableContinuationStore } from "../continuation-store.js";
import type { createContinuationWorkflowClient } from "./client.js";

type Workflows = ReturnType<typeof createContinuationWorkflowClient>;

/** Restores Temporal timer mechanics from Glassbox's durable schedule records. */
export class TemporalContinuationCoordinator {
  constructor(
    private readonly schedules: DurableContinuationStore,
    private readonly workflows: Workflows,
  ) {}

  async start(scheduleId: string): Promise<void> {
    const schedule = await this.schedules.get(scheduleId);
    if (!schedule) throw new Error("Continuation schedule is required");
    if (
      schedule.status !== "active" &&
      (await this.schedules.listPendingForSchedule(scheduleId, 1)).length === 0
    )
      throw new Error("Active schedule or pending continuation is required");
    const observed = await this.workflows.inspect(scheduleId);
    if (observed?.running) {
      await this.workflows.wake(scheduleId);
      return;
    }
    try {
      await this.workflows.start({ scheduleId });
    } catch (error) {
      // A concurrent reconciler may have started the same stable Workflow ID.
      const concurrent = await this.workflows.inspect(scheduleId).catch(() => null);
      if (!concurrent?.running) throw error;
      await this.workflows.wake(scheduleId);
    }
  }

  async wake(scheduleId: string): Promise<void> {
    const schedule = await this.schedules.get(scheduleId);
    if (!schedule) throw new Error("Continuation schedule is required");
    if (
      schedule.status !== "active" &&
      (await this.schedules.listPendingForSchedule(scheduleId, 1)).length === 0
    ) {
      const observed = await this.workflows.inspect(scheduleId);
      if (observed?.running) await this.workflows.wake(scheduleId);
      return;
    }
    await this.start(scheduleId);
  }

  /** Cancellation is durable before this best-effort runtime cleanup. */
  async stop(scheduleId: string): Promise<void> {
    const observed = await this.workflows.inspect(scheduleId);
    if (observed?.running) await this.workflows.cancel(scheduleId);
  }

  async recover(): Promise<{ recovered: string[]; unavailable: string[] }> {
    const recovered: string[] = [];
    const unavailable: string[] = [];
    for (const schedule of await this.schedules.listRecoverable()) {
      try {
        await this.start(schedule.id);
        recovered.push(schedule.id);
      } catch {
        unavailable.push(schedule.id);
      }
    }
    return { recovered, unavailable };
  }
}
