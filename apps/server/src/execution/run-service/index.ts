import { AccessDeniedError } from "../../auth/service.js";
import type { RunLease, RunRoute, TerminalRunStatus } from "../../conversation/lifecycle.js";
import type { IncomingMessage, RunRecord } from "../../conversation/store.js";
import { requireIdentifier, type CallerContext } from "../../identity/scope.js";
import type {
  AcceptedIncoming,
  ExecutionResult,
  RunServiceEvent,
  RunServiceOptions,
  SendOutcome,
} from "./types.js";

export type * from "./types.js";

interface ActiveRun {
  route: RunRoute;
  controller: AbortController;
  task: Promise<void>;
  lease?: RunLease;
}
interface RunWaiter {
  notify(): void;
  stop(): void;
}

const terminal = new Set(["cancelled", "succeeded", "failed", "interrupted", "unknown"]);

/** Session task ownership adapts OpenHarness's gateway bridge. Durable queue
 * order, current authorization and immutable deliveries belong to DomainStore. */
export class RunService {
  private started = false;
  private readonly concurrency: number;
  private readonly deliveryTimeoutMs: number;
  private readonly active = new Map<string, ActiveRun>();
  private readonly blocked = new Set<string>();
  private readonly publications = new Set<Promise<void>>();
  private readonly waiters = new Map<string, Set<RunWaiter>>();
  private pumping: Promise<void> | undefined;
  private pumpAgain = false;

  constructor(private readonly options: RunServiceOptions) {
    this.concurrency = options.concurrency ?? 2;
    this.deliveryTimeoutMs = options.deliveryTimeoutMs ?? 15_000;
    if (!Number.isInteger(this.concurrency) || this.concurrency < 1 || this.concurrency > 32)
      throw new Error("Invalid Run concurrency");
    if (
      !Number.isInteger(this.deliveryTimeoutMs) ||
      this.deliveryTimeoutMs < 1 ||
      this.deliveryTimeoutMs > 120_000
    )
      throw new Error("Invalid delivery timeout");
  }

  /** The host must already hold exclusive server ownership of this data directory. */
  async start(options: { recover?: boolean } = {}): Promise<void> {
    if (this.started || this.active.size || this.pumping)
      throw new Error("Run service already started");
    if (options.recover) await this.recover();
    this.started = true;
    await this.restorePublications();
    this.kick();
  }

  async recover() {
    if (this.started || this.active.size || this.pumping)
      throw new Error("Cannot recover active execution");
    const recovered = await this.options.store.lifecycle.recover();
    await this.emit({ type: "recovered", ...recovered });
    return recovered;
  }

  async receive(input: IncomingMessage): Promise<AcceptedIncoming> {
    if (!this.started) throw new Error("Run service is not started");
    const accepted = await this.options.store.conversations.acceptIncoming(input);
    await this.enqueueAccepted(accepted);
    return accepted;
  }

  async enqueueAccepted(accepted: AcceptedIncoming): Promise<void> {
    if (!this.started) throw new Error("Run service is not started");
    // Re-read by authenticated scope; caller-supplied input text and snapshots are never executed.
    const caller = structuredClone(accepted.caller);
    const run = await this.options.store.conversations.getRun(caller, accepted.run.id);
    if (!accepted.duplicate)
      await this.emit({ type: "run_queued", runId: run.id, conversationId: run.conversationId });
    if (terminal.has(run.status)) this.publishInBackground(caller, run);
    this.kick();
  }

  getRun(caller: CallerContext, runId: string): Promise<RunRecord> {
    return this.options.store.conversations.getRun(caller, runId);
  }

  /** Event-driven observation only. Aborting a wait never aborts execution. */
  waitForRun(
    caller: CallerContext,
    runId: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<RunRecord> {
    if (!this.started) return Promise.reject(new Error("Run service is not started"));
    const observer = structuredClone(caller);
    return new Promise<RunRecord>((resolve, reject) => {
      let finished = false;
      let checking = false;
      let checkAgain = false;
      const abort = () => fail(new DOMException("Run wait aborted", "AbortError"));
      const listener = {
        notify: () => {
          void inspect();
        },
        stop: () => fail(new Error("Run service stopped")),
      };
      const subscriptions = this.waiters.get(runId) ?? new Set<RunWaiter>();
      this.waiters.set(runId, subscriptions);
      function cleanup() {
        finished = true;
        subscriptions.delete(listener);
        options.signal?.removeEventListener("abort", abort);
      }
      const fail = (error: unknown) => {
        if (finished) return;
        cleanup();
        if (subscriptions.size === 0) this.waiters.delete(runId);
        reject(error);
      };
      const inspect = async () => {
        if (finished) return;
        if (checking) {
          checkAgain = true;
          return;
        }
        checking = true;
        try {
          do {
            checkAgain = false;
            const run = await this.getRun(observer, runId);
            if (finished) return;
            if (terminal.has(run.status)) {
              cleanup();
              if (subscriptions.size === 0) this.waiters.delete(runId);
              resolve(run);
              return;
            }
          } while (checkAgain && !finished);
        } catch (error) {
          fail(error);
        } finally {
          checking = false;
        }
      };
      // Register before the initial read so a concurrent terminal commit is not lost.
      subscriptions.add(listener);
      options.signal?.addEventListener("abort", abort, { once: true });
      if (options.signal?.aborted) abort();
      else void inspect();
    });
  }

  async cancel(caller: CallerContext, runId: string): Promise<RunRecord> {
    const run = await this.getRun(caller, runId);
    if (terminal.has(run.status) || run.status === "cancelling") return run;
    const active = this.active.get(run.conversationId);
    if (run.status === "queued") {
      const cancelled = await this.options.store.lifecycle.transitionRun(
        caller,
        runId,
        "queued",
        "cancelled",
      );
      if (active?.route.runId === runId) active.controller.abort();
      await this.emit({
        type: "run_finished",
        runId,
        conversationId: run.conversationId,
        status: "cancelled",
        outputWithheld: false,
      });
      this.publishInBackground(caller, cancelled);
      this.kick();
      return cancelled;
    }
    if (!active || active.route.runId !== runId)
      throw new Error("No live execution handle; supervisor recovery is required");
    const cancelling = await this.options.store.lifecycle.transitionRun(
      caller,
      runId,
      "running",
      "cancelling",
    );
    active.controller.abort();
    await this.emit({ type: "run_cancelling", runId, conversationId: run.conversationId });
    return cancelling;
  }

  /** Explicit retry is allowed only for a transport-confirmed failed delivery. */
  async retryDelivery(caller: CallerContext, runId: string, deliveryId: string): Promise<void> {
    await this.options.store.lifecycle.transitionDelivery(
      caller,
      runId,
      deliveryId,
      "failed",
      "pending",
    );
    await this.sendPending(caller, runId, deliveryId);
  }

  /** Fixed control responses bypass execution scheduling, but keep the same
   * authorization, ingress destination and durable delivery guarantees. */
  async publishControlReply(
    caller: CallerContext,
    runId: string,
    input: { messageId: string; text: string },
  ): Promise<void> {
    requireIdentifier(input.messageId);
    const observer = structuredClone(caller);
    const run = await this.getRun(observer, runId);
    const dedupKey = `control:${input.messageId}`;
    const existing = await this.options.store.lifecycle.findDelivery(observer, run.id, dedupKey);
    const deliveryId =
      existing?.id ??
      (await this.options.store.lifecycle.createDelivery(observer, {
        runId: run.id,
        dedupKey,
        destination: observer.scope,
        payloadText: input.text,
        payloadKind: "text",
      }));
    await this.sendPending(observer, run.id, deliveryId);
  }

  /** Call after an explicit authorization or configuration change. */
  refresh(): void {
    this.blocked.clear();
    this.kick();
  }

  /** Waits for owned work to settle. Persisted authorization-blocked jobs stay queued. */
  async drain(): Promise<void> {
    while (this.pumping || this.active.size || this.publications.size) {
      await Promise.allSettled([
        ...(this.pumping ? [this.pumping] : []),
        ...[...this.active.values()].map((run) => run.task),
        ...this.publications,
      ]);
    }
  }

  /** Abort requests do not claim cancellation. The adapter must still settle. */
  async stop(options: { abortRunning?: boolean; wait?: boolean } = {}): Promise<void> {
    this.started = false;
    for (const subscriptions of this.waiters.values())
      for (const waiter of subscriptions) waiter.stop();
    this.waiters.clear();
    if (options.abortRunning) for (const active of this.active.values()) active.controller.abort();
    if (options.wait) await this.drain();
  }

  private kick(): void {
    if (!this.started) return;
    this.pumpAgain = true;
    if (this.pumping) return;
    this.pumping = Promise.resolve()
      .then(async () => {
        while (this.started && this.pumpAgain) {
          this.pumpAgain = false;
          let cursor = 0;
          while (this.started && this.active.size < this.concurrency) {
            const routes = await this.options.store.lifecycle.listRunRoutes(["queued"], cursor);
            if (routes.length === 0) break;
            for (const route of routes) {
              cursor = route.sequence;
              if (this.blocked.has(route.runId) || this.active.has(route.conversationId)) continue;
              this.launch(route);
              if (this.active.size >= this.concurrency) break;
            }
            if (routes.length < 100) break;
          }
        }
      })
      .catch(() => this.report("dispatch_failed"))
      .finally(() => {
        this.pumping = undefined;
        if (this.started && this.pumpAgain) this.kick();
      });
  }

  private launch(route: RunRoute): void {
    const active: ActiveRun = { route, controller: new AbortController(), task: Promise.resolve() };
    this.active.set(route.conversationId, active);
    active.task = Promise.resolve()
      .then(() => this.execute(active))
      .catch(() => {
        this.blocked.add(route.runId);
        this.report("dispatch_failed", route.runId);
      })
      .finally(() => {
        this.active.delete(route.conversationId);
        this.kick();
      });
  }

  private async execute(active: ActiveRun): Promise<void> {
    const { caller, runId } = active.route;
    let run: RunRecord;
    try {
      run = await this.getRun(caller, runId);
      if (run.status !== "queued") return;
      if (!this.started || active.controller.signal.aborted) return;
      active.lease = await this.options.store.lifecycle.claimQueuedRun(caller, run.id);
    } catch (error) {
      this.blocked.add(runId);
      if (!(error instanceof AccessDeniedError)) this.report("dispatch_failed", runId);
      return;
    }

    let result: ExecutionResult;
    try {
      await this.emit({ type: "run_started", runId, conversationId: run.conversationId });
      const adapter = this.options.resolveExecution(run.executionRef);
      if (!adapter || (caller.scope.chatType === "group" && adapter.supportsGroup !== true)) {
        result = { status: "failed" };
      } else {
        const input = await this.options.store.conversations.loadRunInput(caller, runId);
        // Recheck dispatch authority after context I/O and before invoking any external executor.
        const authorization = await this.options.store.authorization.check({
          caller,
          resourceId: `agent:${input.conversation.agentId}`,
          action: "run:create",
          conversationId: input.conversation.id,
          runId,
        });
        if (authorization.decision !== "ALLOW") throw new AccessDeniedError(authorization);
        if (active.controller.signal.aborted) {
          result = { status: "cancelled" };
        } else {
          result = await adapter.execute({
            ...input,
            caller: structuredClone(caller),
            signal: active.controller.signal,
          });
        }
      }
    } catch (error) {
      // A thrown adapter error does not prove that a detached execution stopped.
      result = { status: error instanceof AccessDeniedError ? "failed" : "unknown" };
    }
    if (
      !result ||
      !terminal.has(result.status) ||
      (result.text !== undefined &&
        (typeof result.text !== "string" || result.text.length > 64_000))
    )
      result = { status: "unknown" };
    let status: TerminalRunStatus = result.status;
    if (status === "cancelled") {
      // Server shutdown may abort without a user cancellation transition.
      try {
        if ((await this.getRun(caller, runId)).status !== "cancelling") status = "interrupted";
      } catch {
        status = "interrupted";
      }
    }
    const finished = await active.lease.settle(status, result.text);
    await this.emit({
      type: "run_finished",
      runId,
      conversationId: run.conversationId,
      status,
      outputWithheld: finished.outputWithheld,
    });
    if (finished.outputWithheld) return;
    if (status === "succeeded" && result.providerSessionId) {
      try {
        await this.options.store.conversations.setProviderSession(
          caller,
          run.conversationId,
          run.executionRef,
          result.providerSessionId,
        );
      } catch {
        this.report("dispatch_failed", runId);
      }
    }
    await this.publishTerminal(caller, finished.run);
  }

  private async publishTerminal(caller: CallerContext, record: RunRecord): Promise<void> {
    // Re-read through authorization before loading the persisted result for transport.
    const run = await this.getRun(caller, record.id);
    if (!terminal.has(run.status)) return;
    const existing = await this.options.store.lifecycle.findDelivery(caller, run.id, "result");
    if (!existing) {
      const candidate = run.resultText ?? `任务处理未完成，状态为 ${run.status}。`;
      const prepared = this.options.prepareDelivery
        ? await this.options.prepareDelivery(candidate)
        : { allowed: true, text: candidate, reasons: [], candidateSha256: "not-recorded" };
      if (!prepared.allowed || !prepared.text) {
        const newlyBlocked = await this.options.store.conversations.excludeRunFromContext(
          caller,
          run.id,
        );
        if (!newlyBlocked) return;
        await this.emit({
          type: "delivery_blocked",
          runId: run.id,
          conversationId: run.conversationId,
          reasons: [...prepared.reasons],
          candidateSha256: prepared.candidateSha256,
          candidateBytes: Buffer.byteLength(candidate, "utf8"),
        });
        return;
      }
      await this.options.store.lifecycle.createDelivery(caller, {
        runId: run.id,
        dedupKey: "result",
        destination: caller.scope,
        payloadText: prepared.text,
        payloadKind: "result",
      });
    }
    let cursor: string | undefined;
    do {
      const page = await this.options.store.lifecycle.listDeliveries(caller, run.id, {
        limit: 100,
        ...(cursor ? { cursor } : {}),
      });
      for (const delivery of page.items)
        if (delivery.status === "pending") await this.sendPending(caller, run.id, delivery.id);
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
  }

  private publishInBackground(caller: CallerContext, run: RunRecord): void {
    const task = this.publishTerminal(structuredClone(caller), run)
      .catch(() => this.report("delivery_failed", run.id))
      .finally(() => this.publications.delete(task));
    this.publications.add(task);
  }

  private async restorePublications(): Promise<void> {
    let cursor = 0;
    while (this.started) {
      const routes = await this.options.store.lifecycle.listRunRoutes(
        ["succeeded", "failed", "cancelled", "interrupted", "unknown"],
        cursor,
      );
      for (const route of routes) {
        cursor = route.sequence;
        try {
          await this.publishTerminal(route.caller, await this.getRun(route.caller, route.runId));
        } catch {
          this.report("delivery_failed", route.runId);
        }
      }
      if (routes.length < 100) return;
    }
  }

  private async sendPending(
    caller: CallerContext,
    runId: string,
    deliveryId: string,
  ): Promise<void> {
    let lease;
    try {
      lease = await this.options.store.lifecycle.claimDelivery(caller, runId, deliveryId);
    } catch {
      this.report("delivery_failed", runId);
      return;
    }
    if (!lease) return;
    await this.emit({ type: "delivery_changed", runId, deliveryId, status: "sending" });
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<SendOutcome>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve({ status: "unknown" });
      }, this.deliveryTimeoutMs);
    });
    let outcome: SendOutcome;
    try {
      outcome = await Promise.race([
        this.options.transport
          .send({
            destination: structuredClone(caller.scope),
            delivery: structuredClone(lease.delivery),
            signal: controller.signal,
          })
          .catch((): SendOutcome => ({ status: "unknown" })),
        timeout,
      ]);
      if (!outcome || !["sent", "failed", "unknown"].includes(outcome.status))
        outcome = { status: "unknown" };
    } catch {
      outcome = { status: "unknown" };
    } finally {
      clearTimeout(timer);
    }
    try {
      await lease.settle(
        outcome.status,
        outcome.status === "sent" ? outcome.externalId : undefined,
      );
      await this.emit({ type: "delivery_changed", runId, deliveryId, status: outcome.status });
    } catch {
      this.report("delivery_failed", runId);
    }
  }

  private async emit(event: RunServiceEvent): Promise<void> {
    try {
      await this.options.onEvent?.(event);
    } catch {
      this.report("evidence_failed", "runId" in event ? event.runId : undefined);
    }
    if (event.type === "run_finished")
      for (const waiter of this.waiters.get(event.runId) ?? []) waiter.notify();
  }

  private report(
    code: "dispatch_failed" | "delivery_failed" | "evidence_failed",
    runId?: string,
  ): void {
    try {
      this.options.onError?.({ code, ...(runId ? { runId } : {}) });
    } catch {
      /* Diagnostics must not alter persisted execution or delivery facts. */
    }
  }
}
