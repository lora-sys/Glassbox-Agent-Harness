import { AccessDeniedError } from "../../auth/service.js";
import type { RunLease, RunRoute, TerminalRunStatus } from "../../conversation/lifecycle.js";
import type { IncomingMessage, RunRecord } from "../../conversation/store.js";
import { requireIdentifier, type CallerContext } from "../../identity/scope.js";
import { authorizeLongWorkAction } from "../../ops/long-work-authority.js";
import { stringColumn } from "../../persistence/database.js";
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
  private readonly queuedPollMs: number;
  private readonly deliveryTimeoutMs: number;
  private readonly active = new Map<string, ActiveRun>();
  private readonly blocked = new Set<string>();
  private readonly recoveredNativeRoleRunIds = new Set<string>();
  private readonly publications = new Set<Promise<void>>();
  private readonly waiters = new Map<string, Set<RunWaiter>>();
  private queuedPoll?: ReturnType<typeof setInterval>;
  private pumping: Promise<void> | undefined;
  private pumpAgain = false;

  constructor(private readonly options: RunServiceOptions) {
    this.concurrency = options.concurrency ?? 2;
    this.queuedPollMs = options.queuedPollMs ?? 0;
    this.deliveryTimeoutMs = options.deliveryTimeoutMs ?? 15_000;
    if (!Number.isInteger(this.concurrency) || this.concurrency < 1 || this.concurrency > 32)
      throw new Error("Invalid Run concurrency");
    if (
      !Number.isInteger(this.queuedPollMs) ||
      (this.queuedPollMs !== 0 && (this.queuedPollMs < 500 || this.queuedPollMs > 60_000))
    )
      throw new Error("Invalid durable queue polling interval");
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
    await this.captureQueuedNativeRoleRuns();
    this.started = true;
    await this.restorePublications();
    this.kick();
    // Temporal Activities persist internal Runs in a separate process. The database
    // is the queue; poll it so a process restart or missed in-memory wake cannot
    // strand a queued Run.
    if (this.queuedPollMs > 0) {
      this.queuedPoll = setInterval(() => this.kick(), this.queuedPollMs);
      this.queuedPoll.unref();
    }
  }

  async recover() {
    if (this.started || this.active.size || this.pumping)
      throw new Error("Cannot recover active execution");
    const recovered = await this.options.store.lifecycle.recover();
    await this.emit({ type: "recovered", ...recovered });
    return recovered;
  }

  /** A queued Run keeps its ingress role as historical evidence, but a process
   * restart is a trust boundary. Do not use that old observation to rediscover
   * native-role Tools when resuming work; a new QQ message must supply a fresh
   * observation. Protected execution still performs its own live role check. */
  private async captureQueuedNativeRoleRuns(): Promise<void> {
    let cursor = 0;
    while (true) {
      const routes = await this.options.store.lifecycle.listRunRoutes(["queued"], cursor);
      for (const route of routes) {
        cursor = route.sequence;
        if (
          route.caller.scope.chatType === "group" &&
          route.caller.scope.nativeGroupRole &&
          route.caller.scope.nativeGroupRole.role !== "qq_group_member"
        ) {
          this.recoveredNativeRoleRunIds.add(route.runId);
        }
      }
      if (routes.length < 100) return;
    }
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
    if (run.source !== "external") throw new Error("Incoming Run source mismatch");
    if (!accepted.duplicate)
      await this.emit({ type: "run_queued", runId: run.id, conversationId: run.conversationId });
    if (terminal.has(run.status)) this.publishInBackground(caller, run);
    this.kick();
  }

  getRun(caller: CallerContext, runId: string): Promise<RunRecord> {
    return this.options.store.conversations.getRun(caller, runId);
  }

  /** Queue a persisted Task Step Run without creating QQ ingress or a delivery. */
  async enqueueInternalStepRun(caller: CallerContext, runId: string): Promise<RunRecord> {
    if (!this.started) throw new Error("Run service is not started");
    const run = await this.getRun(caller, runId);
    if (run.source !== "task_step") throw new Error("Internal Step Run source mismatch");
    if (run.status === "queued") {
      await this.emit({ type: "run_queued", runId: run.id, conversationId: run.conversationId });
      this.kick();
    }
    return run;
  }

  /** Internal Step Runs follow their owning Task's durable cancellation request.
   * This reads only the persisted Run-to-Task link and cancellation state. */
  private async internalTaskCancellationState(
    caller: CallerContext,
    runId: string,
  ): Promise<{ requested: boolean; status: RunRecord["status"]; conversationId: string } | null> {
    const result = await this.options.store.db.transaction((tx) =>
      tx.execute({
        sql: `SELECT t.cancellation_state, r.status, r.conversation_id FROM runs r
              JOIN task_attempt_runs ar ON ar.run_id = r.id
              JOIN tasks t ON t.id = ar.task_id
              WHERE r.id = ? AND r.source = 'task_step' AND r.principal_id = ?`,
        args: [runId, caller.principalId],
      }),
    );
    const row = result.rows[0];
    if (!row) return null;
    const state = row.cancellation_state;
    return {
      requested: state === "requested" || state === "stopping" || state === "settled",
      status: stringColumn(row, "status") as RunRecord["status"],
      conversationId: stringColumn(row, "conversation_id"),
    };
  }

  private async cancelInternalRunForTask(
    caller: CallerContext,
    runId: string,
    activeHint?: ActiveRun,
  ): Promise<boolean> {
    const state = await this.internalTaskCancellationState(caller, runId);
    if (!state?.requested) return false;
    let status = state.status;
    if (terminal.has(status)) return true;
    const active = activeHint ?? this.active.get(state.conversationId);
    if (status === "queued") {
      const updated = await this.options.store.db.transaction((tx) =>
        tx.execute({
          sql: `UPDATE runs SET status = 'cancelled', updated_at = ? WHERE id = ?
                AND source = 'task_step' AND principal_id = ? AND status = 'queued'
                AND EXISTS (SELECT 1 FROM task_attempt_runs ar JOIN tasks t ON t.id = ar.task_id
                  WHERE ar.run_id = runs.id AND t.cancellation_state IN ('requested','stopping','settled'))`,
          args: [new Date().toISOString(), runId, caller.principalId],
        }),
      );
      if (updated.rowsAffected === 1) {
        await this.emit({
          type: "run_finished",
          runId,
          conversationId: state.conversationId,
          status: "cancelled",
          outputWithheld: false,
        });
        this.kick();
        return true;
      }
      const refreshed = await this.internalTaskCancellationState(caller, runId);
      if (!refreshed?.requested) return false;
      status = refreshed.status;
    }
    if (status === "running" || status === "cancelling") {
      if (!active || active.route.runId !== runId) return false;
      if (status === "running") {
        const updated = await this.options.store.db.transaction((tx) =>
          tx.execute({
            sql: `UPDATE runs SET status = 'cancelling', updated_at = ? WHERE id = ?
                  AND source = 'task_step' AND principal_id = ? AND status = 'running'
                  AND EXISTS (SELECT 1 FROM task_attempt_runs ar JOIN tasks t ON t.id = ar.task_id
                    WHERE ar.run_id = runs.id AND t.cancellation_state IN ('requested','stopping','settled'))`,
            args: [new Date().toISOString(), runId, caller.principalId],
          }),
        );
        if (updated.rowsAffected === 1) {
          await this.emit({
            type: "run_cancelling",
            runId,
            conversationId: state.conversationId,
          });
        } else {
          const refreshed = await this.internalTaskCancellationState(caller, runId);
          if (refreshed?.status !== "cancelling") return false;
        }
      }
      active.controller.abort();
      return true;
    }
    return false;
  }

  private async reconcileInternalRunCancellations(): Promise<void> {
    for (const active of this.active.values()) {
      try {
        await this.cancelInternalRunForTask(active.route.caller, active.route.runId, active);
      } catch {
        this.report("dispatch_failed", active.route.runId);
      }
    }
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
    if (run.source === "task_step")
      throw new Error("Task Step Runs require Task cancellation or reconciliation");
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
    if ((await this.getRun(caller, runId)).source === "task_step")
      throw new Error("Internal Step Runs have no direct delivery");
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
    if (run.source === "task_step") throw new Error("Internal Step Runs have no control reply");
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
    if (this.queuedPoll) clearInterval(this.queuedPoll);
    this.queuedPoll = undefined;
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
          await this.reconcileInternalRunCancellations();
          let cursor = 0;
          while (this.started && this.active.size < this.concurrency) {
            const routes = await this.options.store.lifecycle.listRunRoutes(["queued"], cursor);
            if (routes.length === 0) break;
            for (const route of routes) {
              cursor = route.sequence;
              try {
                if (await this.cancelInternalRunForTask(route.caller, route.runId)) continue;
              } catch {
                this.blocked.add(route.runId);
                this.report("dispatch_failed", route.runId);
                continue;
              }
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
    let executionRoute = route;
    if (this.recoveredNativeRoleRunIds.delete(route.runId)) {
      const scope = { ...route.caller.scope };
      delete scope.nativeGroupRole;
      executionRoute = { ...route, caller: { ...route.caller, scope } };
    }
    const active: ActiveRun = {
      route: executionRoute,
      controller: new AbortController(),
      task: Promise.resolve(),
    };
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
    let executorStarted = false;
    try {
      await this.emit({ type: "run_started", runId, conversationId: run.conversationId });
      const adapter = this.options.resolveExecution(run.executionRef);
      if (
        !adapter ||
        (caller.scope.chatType === "group" && adapter.supportsGroup !== true) ||
        (run.source === "task_step" && adapter.supportsTaskStepModel !== true)
      ) {
        result = { status: "failed" };
      } else {
        const input = await this.options.store.conversations.loadRunInput(caller, runId);
        if (run.source === "task_step") {
          if (!input.taskStepBinding) throw new Error("Internal Step Run binding missing");
          await authorizeLongWorkAction(this.options.store, {
            taskId: input.taskStepBinding.taskId,
            caller,
            resourceId: `task-${input.taskStepBinding.taskId}`,
            action: "task:continue",
          });
        }
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
          executorStarted = true;
          result = await adapter.execute({
            ...input,
            ...(run.source === "task_step" ? { executionMode: "task_step_model" as const } : {}),
            caller: structuredClone(caller),
            signal: active.controller.signal,
          });
        }
      }
    } catch (error) {
      // A thrown adapter error does not prove that a detached execution stopped.
      if (
        run.source === "task_step" &&
        !executorStarted &&
        (await this.internalTaskCancellationState(caller, runId).then(
          (state) => state?.requested ?? false,
          () => false,
        ))
      ) {
        await this.cancelInternalRunForTask(caller, runId, active).catch(() => false);
        result = { status: "cancelled" };
      } else {
        result = { status: error instanceof AccessDeniedError ? "failed" : "unknown" };
      }
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
    if (run.source === "external" && status === "succeeded" && result.providerSessionId) {
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
    if (run.source === "external") await this.publishTerminal(caller, finished.run);
  }

  private async publishTerminal(caller: CallerContext, record: RunRecord): Promise<void> {
    if (record.source === "task_step") return;
    // Re-read through authorization before loading the persisted result for transport.
    const run = await this.getRun(caller, record.id);
    if (run.source === "task_step") return;
    if (!terminal.has(run.status)) return;
    const existing = await this.options.store.lifecycle.findDelivery(caller, run.id, "result");
    const candidate = run.resultText ?? `任务处理未完成，状态为 ${run.status}。`;
    const prepared = this.options.prepareDelivery
      ? await this.options.prepareDelivery(candidate, { caller, run })
      : { allowed: true, text: candidate, reasons: [], candidateSha256: "not-recorded" };
    if (!existing && (!prepared.allowed || !prepared.text)) {
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
    try {
      if (!existing)
        await this.options.store.lifecycle.createDelivery(caller, {
          runId: run.id,
          dedupKey: "result",
          destination: caller.scope,
          payloadText: prepared.text!,
          payloadKind: "result",
        });
      if (prepared.allowed)
        for (const artifactId of prepared.artifactIds ?? [])
          await this.options.store.lifecycle.createDelivery(caller, {
            runId: run.id,
            dedupKey: `browser-artifact-${artifactId}`,
            destination: caller.scope,
            payloadText: artifactId,
            payloadKind: "browser_artifact",
          });
      if (prepared.allowed)
        for (const assetId of prepared.mediaAssetIds ?? [])
          await this.options.store.lifecycle.createDelivery(caller, {
            runId: run.id,
            dedupKey: `media-asset-${assetId}`,
            destination: caller.scope,
            payloadText: assetId,
            payloadKind: "media_artifact",
          });
    } catch (error) {
      // A delivery authorization refusal is a blocked outcome, not a transport failure: the
      // answer never left the process, so no send is attempted and nothing is retried. Trace
      // records that fact and the decision that caused it, never the payload the Run was
      // trying to send. The exact Resource and Action remain in the authorization ledger,
      // joined to this Run and Conversation.
      if (!(error instanceof AccessDeniedError)) throw error;
      const newlyDenied = await this.options.store.conversations.excludeRunFromContext(
        caller,
        run.id,
      );
      if (!newlyDenied) return;
      await this.emit({
        type: "delivery_denied",
        runId: run.id,
        conversationId: run.conversationId,
        decision: error.decision.decision,
        reason: error.decision.reason,
      });
      return;
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
        "external",
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
