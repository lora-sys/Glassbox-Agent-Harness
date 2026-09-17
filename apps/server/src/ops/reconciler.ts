import type { HerdrAgentLifecycleState } from "@glassbox/contracts";
import type { HerdrBridge, HerdrEvent, HerdrSessionSnapshot } from "./herdr-bridge.js";
import { TaskStore } from "./task-store.js";

export class OpsReconciler {
  private subscriptionId: string | null = null;

  constructor(
    private readonly store: TaskStore,
    private readonly bridge: HerdrBridge,
  ) {}

  getSubscriptionId(): string | null {
    return this.subscriptionId;
  }

  async start(): Promise<void> {
    // Reconnection & bootstrap invariant:
    // 1. Subscribe to events first
    // 2. Request session.snapshot
    // 3. Reconcile snapshot with durable Task/Worker state
    const sub = await this.bridge.subscribe((event) => {
      void this.handleEvent(event);
    });
    this.subscriptionId = sub.subscriptionId;

    const snapshot = await this.bridge.getSnapshot();
    await this.reconcileSnapshot(snapshot);
  }

  async reconcileSnapshot(snapshot: HerdrSessionSnapshot): Promise<void> {
    for (const workspace of snapshot.workspaces) {
      for (const pane of workspace.panes) {
        const binding = await this.store.getWorkerBindingByPane(pane.paneId);
        if (!binding) continue;

        await this.store.updateWorkerState(binding.taskAttemptId, pane.state);
        const attempt = await this.store.getAttempt(binding.taskAttemptId);
        if (!attempt) continue;

        await this.syncTaskAttemptState(attempt.taskId, attempt.id, pane.state);
      }
    }
  }

  async handleEvent(event: HerdrEvent): Promise<void> {
    if (event.type === "session.disconnected") {
      await this.store.createAttentionItem({
        kind: "ops_connection_problem",
        summary: `Herdr session ${event.sessionId} disconnected`,
      });
      return;
    }

    if (event.type === "agent.state" && event.state) {
      const binding = await this.store.getWorkerBindingByPane(event.paneId);
      if (!binding) return;

      await this.store.updateWorkerState(binding.taskAttemptId, event.state);
      const attempt = await this.store.getAttempt(binding.taskAttemptId);
      if (!attempt) return;

      await this.syncTaskAttemptState(attempt.taskId, attempt.id, event.state);
    }
  }

  private async syncTaskAttemptState(
    taskId: string,
    taskAttemptId: string,
    agentState: HerdrAgentLifecycleState,
  ): Promise<void> {
    const task = await this.store.getTask(taskId);
    if (!task || task.status === "DONE" || task.status === "CANCELED") return;

    if (agentState === "working") {
      if (task.status === "WAITING_INPUT" || task.status === "QUEUED" || task.status === "NEW") {
        await this.store.updateTaskStatus(taskId, "RUNNING", taskAttemptId);
        await this.store.updateAttemptStatus(taskAttemptId, "running");
        await this.store.resolveAttentionByTask(taskId, "worker_blocked");
      }
    } else if (agentState === "blocked") {
      await this.store.updateTaskStatus(taskId, "WAITING_INPUT", taskAttemptId);
      await this.store.updateAttemptStatus(taskAttemptId, "waiting_input");
      await this.store.createAttentionItem({
        kind: "worker_blocked",
        summary: `Worker in attempt ${taskAttemptId} is blocked awaiting input`,
        taskId,
        taskAttemptId,
      });
    } else if (agentState === "done") {
      // INVARIANT: Herdr done moves Task to REVIEW, NEVER automatically to DONE
      await this.store.updateTaskStatus(taskId, "REVIEW", taskAttemptId);
      await this.store.updateAttemptStatus(taskAttemptId, "review");
      await this.store.resolveAttentionByTask(taskId, "worker_blocked");
      await this.store.createAttentionItem({
        kind: "task_review",
        summary: `Task "${task.title}" completed worker execution and awaits review`,
        taskId,
        taskAttemptId,
      });
    }
  }

  /** Explicit product review action: ACCEPT */
  async acceptTask(taskId: string): Promise<void> {
    const task = await this.store.getTask(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    if (task.status !== "REVIEW") {
      throw new Error(`Cannot accept task in status ${task.status}; must be in REVIEW`);
    }

    if (task.activeAttemptId) {
      await this.store.updateAttemptStatus(task.activeAttemptId, "succeeded", "Accepted by reviewer");
    }
    await this.store.updateTaskStatus(taskId, "DONE");
    await this.store.resolveAttentionByTask(taskId);
  }

  /** Explicit product review action: REWORK */
  async reworkTask(taskId: string, reworkReason: string): Promise<void> {
    const task = await this.store.getTask(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    if (task.status !== "REVIEW") {
      throw new Error(`Cannot request rework for task in status ${task.status}; must be in REVIEW`);
    }

    // Mark previous attempt as completed (review completed with rework)
    if (task.activeAttemptId) {
      await this.store.updateAttemptStatus(
        task.activeAttemptId,
        "review",
        `Rework requested: ${reworkReason}`,
      );
    }

    // Resolve review attention item
    await this.store.resolveAttentionByTask(taskId, "task_review");

    // Create brand new attempt N+1, preserving prior attempt history!
    const newAttempt = await this.store.createAttempt({
      taskId,
      reworkReason,
    });

    await this.store.updateTaskStatus(taskId, "RUNNING", newAttempt.id);
  }

  /** Explicit product cancel action */
  async cancelTask(taskId: string, reason?: string): Promise<void> {
    const task = await this.store.getTask(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    if (task.activeAttemptId) {
      await this.store.updateAttemptStatus(task.activeAttemptId, "canceled", reason);
    }
    await this.store.updateTaskStatus(taskId, "CANCELED");
    await this.store.resolveAttentionByTask(taskId);
  }
}
