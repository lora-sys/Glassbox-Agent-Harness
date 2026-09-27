import type { HerdrBridge, HerdrEvent, HerdrSessionSnapshot } from "./herdr-bridge.js";
import { TaskStore } from "./task-store.js";

export class OpsReconciler {
  private subscriptionId: string | null = null;
  private bootstrapping = false;
  private stopped = false;
  private bufferedEvents: HerdrEvent[] = [];
  private eventTail: Promise<void> = Promise.resolve();
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private reconnectTask?: Promise<void>;
  private eventsLost = false;
  private lastSuccessfulReconciliationAt: string | null = null;

  constructor(
    private readonly store: TaskStore,
    private readonly bridge: HerdrBridge,
    private readonly reconnectDelayMs = 1_000,
  ) {}

  getSubscriptionId(): string | null {
    return this.subscriptionId;
  }

  healthObservation() {
    return {
      bridgeState:
        this.stopped || !this.bridge.isConnected()
          ? ("disconnected" as const)
          : this.bootstrapping || !this.subscriptionId
            ? ("reconnecting" as const)
            : ("connected" as const),
      eventsLost: this.eventsLost,
      lastSuccessfulReconciliationAt: this.lastSuccessfulReconciliationAt,
    };
  }

  async start(): Promise<void> {
    // Reconnection & bootstrap invariant:
    // 1. Subscribe to events first
    // 2. Request session.snapshot
    // 3. Reconcile snapshot with durable Task/Worker state
    if (this.subscriptionId) return;
    this.stopped = false;
    this.bootstrapping = true;
    try {
      const sub = await this.bridge.subscribe((event) => {
        if (this.stopped) return;
        if (this.bootstrapping) {
          this.bufferedEvents.push(event);
          return;
        }
        this.enqueueEvent(event);
      });
      if (this.stopped) {
        await this.bridge.unsubscribe(sub.subscriptionId);
        return;
      }
      this.subscriptionId = sub.subscriptionId;

      const snapshot = await this.bridge.getSnapshot();
      if (this.stopped) return;
      await this.reconcileSnapshot(snapshot);
      this.bootstrapping = false;
      for (const event of this.bufferedEvents.splice(0)) this.enqueueEvent(event);
      await this.eventTail;
    } catch (error) {
      this.bootstrapping = false;
      this.bufferedEvents = [];
      const subscriptionId = this.subscriptionId;
      this.subscriptionId = null;
      if (subscriptionId) await this.bridge.unsubscribe(subscriptionId);
      throw error;
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.bootstrapping = false;
    this.bufferedEvents = [];
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    const subscriptionId = this.subscriptionId;
    this.subscriptionId = null;
    if (subscriptionId) await this.bridge.unsubscribe(subscriptionId);
    await this.reconnectTask;
    await this.eventTail;
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      if (this.stopped) return;
      this.reconnectTask = (async () => {
        try {
          await this.bridge.connect();
          if (!this.stopped) await this.start();
        } catch {
          // Keep durable observations unknown until a later snapshot succeeds.
          this.scheduleReconnect();
        }
      })();
    }, this.reconnectDelayMs);
    this.reconnectTimer.unref();
  }

  private enqueueEvent(event: HerdrEvent): void {
    this.eventTail = this.eventTail
      .then(() => this.handleEvent(event))
      .catch(async () => {
        await this.store.createAttentionItem({
          kind: "ops_connection_problem",
          summary: "Failed to reconcile Herdr event",
        });
      });
  }

  async reconcileSnapshot(snapshot: HerdrSessionSnapshot): Promise<void> {
    for (const binding of await this.store.activeWorkerBindings(snapshot.sessionId)) {
      const pane = snapshot.workspaces
        .find((workspace) => workspace.workspaceId === binding.workspaceId)
        ?.panes.find((entry) => entry.paneId === binding.paneId);
      const matches = pane && (!binding.agentName || pane.agentName === binding.agentName);
      await this.store.observeWorker(binding, matches ? pane.state : "unknown");
    }
    // A complete snapshot closes a previous session-level monitoring gap. Keep
    // task-scoped dispatch failures until their Task is handled explicitly.
    await this.store.resolveGlobalAttentionByKind("ops_connection_problem");
    this.lastSuccessfulReconciliationAt = snapshot.timestamp;
    this.eventsLost = false;
  }

  async handleEvent(event: HerdrEvent): Promise<void> {
    if (event.type === "events.lost") {
      this.eventsLost = true;
      for (const binding of await this.store.activeWorkerBindings(event.sessionId))
        await this.store.observeWorker(binding, "unknown");
      await this.reconcileSnapshot(await this.bridge.getSnapshot());
      return;
    }
    if (event.type === "session.disconnected") {
      this.eventsLost = true;
      const subscriptionId = this.subscriptionId;
      this.subscriptionId = null;
      if (subscriptionId) await this.bridge.unsubscribe(subscriptionId);
      for (const binding of await this.store.activeWorkerBindings(event.sessionId)) {
        await this.store.observeWorker(binding, "unknown");
      }
      await this.store.createAttentionItem({
        kind: "ops_connection_problem",
        summary: `Herdr session ${event.sessionId} disconnected`,
      });
      this.scheduleReconnect();
      return;
    }

    if (event.type === "agent.state" && event.state) {
      const binding = (await this.store.activeWorkerBindings(event.sessionId)).find(
        (entry) => entry.workspaceId === event.workspaceId && entry.paneId === event.paneId,
      );
      if (!binding) return;
      if (binding.agentName && !event.agentName) {
        // A delayed event without instance identity cannot identify which worker
        // completed. Use both identity and state from the current snapshot.
        await this.reconcileSnapshot(await this.bridge.getSnapshot());
        return;
      }
      if (binding.agentName && binding.agentName !== event.agentName) {
        await this.store.observeWorker(binding, "unknown");
        return;
      }
      await this.store.observeWorker(
        {
          paneId: event.paneId,
          herdrSession: event.sessionId,
          workspaceId: event.workspaceId,
        },
        event.state,
      );
    }
  }

  /** Explicit product review action: ACCEPT */
  async acceptTask(taskId: string): Promise<void> {
    await this.store.acceptTask(taskId);
  }

  /** Explicit product review action: REWORK */
  async reworkTask(taskId: string, reworkReason: string): Promise<void> {
    await this.store.reworkTask(taskId, reworkReason);
  }

  /** Explicit product cancel action */
  async cancelTask(taskId: string, reason?: string): Promise<void> {
    await this.store.cancelTask(taskId, reason);
  }
}
