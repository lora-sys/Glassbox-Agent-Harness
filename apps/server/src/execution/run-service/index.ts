import { deliveryReason } from "../../delivery/outcome.js";
import { createHash } from "node:crypto";
import { AccessDeniedError } from "../../auth/service.js";
import type {
  DeliveryRecord,
  RunLease,
  RunRoute,
  TerminalRunStatus,
} from "../../conversation/lifecycle.js";
import type { IncomingMessage, RunRecord } from "../../conversation/store.js";
import { requireIdentifier, type CallerContext } from "../../identity/scope.js";
import { authorizeLongWorkAction } from "../../ops/long-work-authority.js";
import { parseCheckpointWriteSpec, parseTaskGetSpec } from "../../ops/tool-step-spec.js";
import type { TaskNotificationRecord } from "../../ops/task-notification-store.js";
import { stringColumn } from "../../persistence/database.js";
import type {
  AcceptedIncoming,
  ExecutionFailureCode,
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

/** What a Run with no text of its own tells its reader, keyed by the cause it recorded.
 * Each line names what actually went wrong: a reader who is told only "状态为 unknown" cannot
 * act on it, and the four Runs that reached this fallback on 2026-09-28 all said the same thing.
 *
 * The key is the closed union of causes, so a cause added later cannot be added without the
 * sentence that explains it. A `Record<string, string>` here would let a new cause reach a reader
 * as "任务处理未完成" — a line that says a Run produced nothing without saying why, which is the
 * whole defect this table exists to close. */
const failureFallback: Record<ExecutionFailureCode, string> = {
  execution_threw: "执行这次请求的进程中途出错了，没有产出结果。请稍后重试。",
  pre_provider_context_overflow:
    "这次请求的内容超出了当前模型的上下文容量，未发送给模型。可以缩小问题范围或另开一个会话再试。",
  model_capability_missing:
    "当前配置的模型不支持这次输入，因此没有发送给模型。请切换到支持相应输入的模型后重试。",
  model_credential_missing: "当前模型未配置可用凭据，因此没有发送请求。请检查模型凭据后重试。",
  model_capacity_unknown: "没能确认当前模型的上下文容量，因此没有发送给模型。请稍后重试。",
  required_action_not_completed: "这次请求需要执行的操作没有完成，因此无法给出结果。请稍后重试。",
  claimed_change_not_performed:
    "这次没有执行被要求的变更，因此我不会声称它已经完成。请以管理面或群里的实际状态为准。",
  required_evidence_missing: "没能取到这条问题所依赖的原始信息，因此无法确认。请稍后重试。",
  gate_refused: "这个请求被我自己的规则拦下了，因此没有执行。",
  runtime_run_errored: "模型在执行这次请求时出错了，没有产出结果。请稍后重试。",
  runtime_internal_error: "本次执行发生内部错误，尚未确认是否由模型服务引起。请查看本次执行记录。",
  execution_unavailable: "当前没有可以执行这个请求的执行通道，请联系管理员检查模型配置。",
};

function isDeliverableText(text: unknown): text is string | undefined {
  return text === undefined || (typeof text === "string" && text.length <= 64_000);
}

/** The last resort when a Run recorded no cause and said nothing. Status names alone are opaque
 * to a reader on the other end of a chat channel, so the two outcomes a reader can recognise get
 * a sentence instead. */
const statusFallback: Record<string, string> = {
  cancelled: "已停止，这次没有给出结果。",
  interrupted: "这次执行被中断，没有给出结果。请稍后重试。",
};

/**
 * How long after a Run finishes a restart may still publish it.
 *
 * The gap this covers is the one a restart exists for: the process died between settling the
 * Run and creating its delivery. Two hours is long enough to survive a machine reboot and
 * short enough that a Run nobody has waited two hours for is not answered by surprise.
 */
const DEFAULT_RESTORE_WINDOW_MS = 2 * 60 * 60 * 1000;
const MAX_RESTORE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const DISPATCH_RETRY_DELAYS_MS = [500, 1_000, 2_000] as const;
const DISPATCH_SETTLEMENT_RETRY_MS = 1_000;
/** Backoff before each re-send of an unconfirmed delivery; its length bounds the retries. */
const DEFAULT_DELIVERY_RETRY_DELAYS_MS = [1_000, 3_000] as const;
/** Unknown outcomes where the transport itself could not confirm the write. */
const RETRYABLE_UNKNOWN_REASONS: ReadonlySet<string> = new Set([
  "timeout",
  "disconnected",
  "send_error",
]);

/** Session task ownership adapts OpenHarness's gateway bridge. Durable queue
 * order, current authorization and immutable deliveries belong to DomainStore. */
export class RunService {
  private started = false;
  private readonly concurrency: number;
  private readonly queuedPollMs: number;
  private readonly deliveryTimeoutMs: number;
  private readonly deliveryRetryDelaysMs: readonly number[];
  private readonly restoreWindowMs: number;
  private readonly active = new Map<string, ActiveRun>();
  private readonly blocked = new Set<string>();
  private readonly recoveredNativeRoleRunIds = new Set<string>();
  private readonly publications = new Set<Promise<void>>();
  private readonly waiters = new Map<string, Set<RunWaiter>>();
  private queuedPoll?: ReturnType<typeof setInterval>;
  private notificationPoll?: ReturnType<typeof setInterval>;
  private notificationPumping?: Promise<void>;
  private pumping: Promise<void> | undefined;
  private pumpAgain = false;

  constructor(private readonly options: RunServiceOptions) {
    this.concurrency = options.concurrency ?? 2;
    this.queuedPollMs = options.queuedPollMs ?? 0;
    this.deliveryTimeoutMs = options.deliveryTimeoutMs ?? 15_000;
    this.deliveryRetryDelaysMs = options.deliveryRetryDelaysMs ?? DEFAULT_DELIVERY_RETRY_DELAYS_MS;
    if (
      this.deliveryRetryDelaysMs.length > 5 ||
      this.deliveryRetryDelaysMs.some(
        (delay) => !Number.isInteger(delay) || delay < 0 || delay > 60_000,
      )
    )
      throw new Error("Invalid delivery retry delays");
    this.restoreWindowMs = options.restoreWindowMs ?? DEFAULT_RESTORE_WINDOW_MS;
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
    if (
      !Number.isSafeInteger(this.restoreWindowMs) ||
      this.restoreWindowMs < 0 ||
      this.restoreWindowMs > MAX_RESTORE_WINDOW_MS
    )
      throw new Error("Invalid restore window");
  }

  /** The host must already hold exclusive server ownership of this data directory. */
  async start(options: { recover?: boolean } = {}): Promise<void> {
    if (this.started || this.active.size || this.pumping)
      throw new Error("Run service already started");
    if (options.recover) await this.recover();
    await this.captureQueuedNativeRoleRuns();
    this.started = true;
    await this.restorePublications();
    this.kickTaskNotifications();
    this.notificationPoll = setInterval(() => this.kickTaskNotifications(), 2_000);
    this.notificationPoll.unref();
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
    await this.options.store.taskNotifications.recover();
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
    if (!accepted.duplicate) await this.recordMessageReceived(input, accepted.run);
    await this.enqueueAccepted(accepted);
    return accepted;
  }

  /**
   * Records the message that produced a Run as the first event on the Run's trace.
   *
   * The channel adapter calls `acceptIncoming` itself rather than going through
   * `receive`, so this is exposed for it to call with the same `IncomingMessage` it
   * stored. Duplicates reuse an existing Run, which already carries the event.
   *
   * Metadata only: the body stays in storage. The identifiers are what let a trace
   * reader join a Run to its message, channel conversation and sender without the
   * trace ever holding protected payload text.
   */
  async recordMessageReceived(input: IncomingMessage, run: RunRecord): Promise<void> {
    await this.emit({
      type: "message_received",
      runId: run.id,
      conversationId: run.conversationId,
      externalId: input.messageId,
      messageId: run.messageId,
      connectionId: input.scope.connectionId,
      botId: input.scope.botId,
      chatType: input.scope.chatType,
      chatId: input.scope.chatId,
      senderId: input.scope.senderId,
      ...(input.scope.threadId === undefined ? {} : { threadId: input.scope.threadId }),
      textBytes: Buffer.byteLength(input.text, "utf8"),
      textSha256: createHash("sha256").update(input.text, "utf8").digest("hex"),
    });
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
    if (terminal.has(run.status) || run.status === "cancelling") {
      this.blocked.delete(runId);
      return run;
    }
    const active = this.active.get(run.conversationId);
    if (run.status === "queued") {
      const cancelled = await this.options.store.lifecycle.transitionRun(
        caller,
        runId,
        "queued",
        "cancelled",
      );
      this.blocked.delete(runId);
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
    if (this.notificationPoll) clearInterval(this.notificationPoll);
    this.notificationPoll = undefined;
    for (const subscriptions of this.waiters.values())
      for (const waiter of subscriptions) waiter.stop();
    this.waiters.clear();
    for (const active of this.active.values())
      if (options.abortRunning || !active.lease) active.controller.abort();
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
          const seenConversations = new Set<string>();
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
              if (seenConversations.has(route.conversationId)) continue;
              seenConversations.add(route.conversationId);
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
        this.report("dispatch_failed", route.runId);
      })
      .finally(() => {
        this.active.delete(route.conversationId);
        this.kick();
      });
  }

  private async waitBeforeRetry(ms: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return;
    await new Promise<void>((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", finish);
        resolve();
      };
      const timer = setTimeout(finish, ms);
      signal.addEventListener("abort", finish, { once: true });
      if (signal.aborted) finish();
    });
  }

  private async settleUnclaimedDispatch(active: ActiveRun): Promise<void> {
    const { caller, runId, conversationId } = active.route;
    while (this.started) {
      try {
        const finished = await this.options.store.lifecycle.failQueuedDispatch(caller, runId);
        this.blocked.delete(runId);
        if (!this.started) return;
        if (!finished) return;
        await this.emit({
          type: "run_finished",
          runId,
          conversationId,
          status: finished.status,
          outputWithheld: false,
        });
        this.publishInBackground(caller, finished);
        return;
      } catch {
        this.report("dispatch_failed", runId);
        // Keep ownership of this conversation until the database can commit the terminal fact.
        await new Promise<void>((resolve) => setTimeout(resolve, DISPATCH_SETTLEMENT_RETRY_MS));
      }
    }
  }

  private async execute(active: ActiveRun): Promise<void> {
    const { caller, runId } = active.route;
    let run: RunRecord | undefined;
    for (let attempt = 0; !active.lease && this.started; attempt++) {
      try {
        run = await this.getRun(caller, runId);
        if (run.status === "running" || run.status === "cancelling") {
          await this.settleUnclaimedDispatch(active);
          return;
        }
        if (run.status !== "queued") {
          this.blocked.delete(runId);
          return;
        }
        if (active.controller.signal.aborted) return;
        active.lease = await this.options.store.lifecycle.claimQueuedRun(caller, run.id);
        this.blocked.delete(runId);
      } catch (error) {
        if (!this.started) return;
        if (error instanceof AccessDeniedError) {
          this.blocked.add(runId);
          return;
        }
        this.report("dispatch_failed", runId);
        const observed = await this.getRun(caller, runId).catch(() => null);
        if (observed && observed.status !== "queued") {
          if (observed.status === "running" || observed.status === "cancelling")
            await this.settleUnclaimedDispatch(active);
          else this.blocked.delete(runId);
          return;
        }
        if (attempt >= DISPATCH_RETRY_DELAYS_MS.length) {
          await this.settleUnclaimedDispatch(active);
          return;
        }
        await this.waitBeforeRetry(DISPATCH_RETRY_DELAYS_MS[attempt]!, active.controller.signal);
      }
    }
    if (!active.lease || !run) return;

    let result: ExecutionResult;
    let executorStarted = false;
    try {
      await this.emit({ type: "run_started", runId, conversationId: run.conversationId });
      const adapter = this.options.resolveExecution(run.executionRef);
      const toolStep =
        run.source === "task_step" &&
        (parseTaskGetSpec(run.executionRef) !== null ||
          parseCheckpointWriteSpec(run.executionRef) !== null);
      if (
        !adapter ||
        (run.source === "external" && run.executionRef.startsWith("tool:")) ||
        (caller.scope.chatType === "group" && adapter.supportsGroup !== true) ||
        (run.source === "task_step" &&
          (toolStep
            ? adapter.supportsTaskStepTool !== true
            : adapter.supportsTaskStepModel !== true))
      ) {
        // The configured route has no executor able to take this Run, which is a fact about the
        // configuration rather than about the runtime, but it is still a reason to keep this
        // profile out of routing until the route is fixed.
        result = { status: "failed", failureCode: "execution_unavailable" };
      } else {
        const input = await this.options.store.conversations.loadRunInput(caller, runId);
        if (run.source === "task_step") {
          if (!input.taskStepBinding) throw new Error("Internal Step Run binding missing");
          await authorizeLongWorkAction(this.options.store, {
            taskId: input.taskStepBinding.taskId,
            caller,
            resourceId: `task-${input.taskStepBinding.taskId}`,
            action: "task:read",
          });
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
          const executionInput = {
            ...input,
            ...(run.source === "task_step"
              ? {
                  executionMode: toolStep
                    ? ("task_step_tool" as const)
                    : ("task_step_model" as const),
                }
              : {}),
            caller: structuredClone(caller),
            signal: active.controller.signal,
          };
          executorStarted = true;
          if (this.options.captureLearning) {
            try {
              const candidateId = await this.options.captureLearning(executionInput);
              if (candidateId) {
                await this.emit({
                  type: "learning_candidate_created",
                  runId,
                  conversationId: input.conversation.id,
                  candidateId,
                  scopeType: caller.scope.chatType === "group" ? "group" : "global",
                });
              }
            } catch {
              this.report("evidence_failed", runId);
            }
          }
          result = await adapter.execute({
            ...executionInput,
          });
        }
      }
    } catch (error) {
      // A thrown adapter error does not prove that a detached execution stopped. It does prove
      // that no classified result exists, so the Run keeps a named cause instead of collapsing
      // into the same opaque status line every other failure produced. An internal Run whose
      // executor never started is a cancellation the Task must observe instead.
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
        result =
          error instanceof AccessDeniedError
            ? { status: "failed", failureCode: "gate_refused" }
            : { status: "unknown", failureCode: "execution_threw" };
      }
    }
    // A result the adapter could not classify still carries whatever cause it named: dropping the
    // text here is what turned every executor failure into one indistinguishable sentence.
    const classified =
      result && terminal.has(result.status) && isDeliverableText(result.text) ? result : undefined;
    if (!classified)
      result = {
        status: "unknown",
        ...(result && isDeliverableText(result.text) ? { text: result.text } : {}),
        ...(result?.failureCode ? { failureCode: result.failureCode } : {}),
      };
    if (
      result.failureCode !== undefined &&
      (typeof result.failureCode !== "string" || result.failureCode.length > 64)
    )
      result = { status: "unknown", failureCode: "execution_threw" };
    let status: TerminalRunStatus = result.status;
    if (status === "cancelled") {
      // Server shutdown may abort without a user cancellation transition.
      try {
        if ((await this.getRun(caller, runId)).status !== "cancelling") status = "interrupted";
      } catch {
        status = "interrupted";
      }
    }
    const finished = await this.settleCompletedRun(active, status, result);
    if (!finished || !this.started) return;
    const settledStatus = finished.run.status as TerminalRunStatus;
    await this.emit({
      type: "run_finished",
      runId,
      conversationId: run.conversationId,
      status: settledStatus,
      outputWithheld: finished.outputWithheld,
      ...(result.failureCode && finished.run.failureCode === result.failureCode
        ? { failureCode: result.failureCode }
        : {}),
    });
    if (finished.outputWithheld) return;
    if (run.source === "external" && settledStatus === "succeeded" && result.providerSessionId) {
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

  private async settleCompletedRun(
    active: ActiveRun,
    status: TerminalRunStatus,
    result: ExecutionResult,
  ): Promise<Awaited<ReturnType<RunLease["settle"]>> | undefined> {
    const { runId } = active.route;
    // Keep the classified result and conversation ownership until its terminal fact is
    // durable. Retrying this write must never re-enter the executor or resend a Tool call.
    for (;;) {
      try {
        return await active.lease!.settle(status, result.text, result.failureCode);
      } catch {
        this.report("dispatch_failed", runId);
        if (!this.started) return;
        // A committed write may have lost its response. Use only an authorized durable
        // result, rather than overwriting it or repeatedly settling an exhausted lease.
        try {
          const observed = await active.lease!.reconcileSettlement();
          if (observed) return observed;
        } catch {
          // A failed or denied diagnostic read cannot discard the pending outcome.
        }
        await new Promise<void>((resolve) => setTimeout(resolve, DISPATCH_SETTLEMENT_RETRY_MS));
        if (!this.started) return;
      }
    }
  }

  private async publishTerminal(caller: CallerContext, record: RunRecord): Promise<void> {
    if (record.source === "task_step") return;
    // Re-read through authorization before loading the persisted result for transport.
    const run = await this.getRun(caller, record.id);
    if (run.source === "task_step") return;
    if (!terminal.has(run.status)) return;
    const existing = await this.options.store.lifecycle.findDelivery(caller, run.id, "result");
    // A Run that said nothing still owes its reader a sentence, and the cause it recorded decides
    // which one. The status alone names the outcome, not the reason, and an unrecorded cause falls
    // back to naming the status rather than staying silent. Blank text counts as having said
    // nothing: delivering it would send an empty message.
    const reported = run.resultText?.trim() ? run.resultText : undefined;
    // The recorded cause is read as the cause type, because that is what the column holds: a
    // writer went through the closed union. A value that is not in the union is not one of the
    // causes this table explains, and it falls through to the status line below.
    const cause = run.failureCode as ExecutionFailureCode | null | undefined;
    const candidate =
      reported ??
      (cause ? failureFallback[cause] : undefined) ??
      statusFallback[run.status] ??
      `任务处理未完成，状态为 ${run.status}。`;
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

  /**
   * Republishes the terminal Runs a restart is entitled to.
   *
   * Bounded by `restoreWindowMs`: only Runs that finished recently, or that hold a delivery
   * that never reached a final state, are candidates. Everything else settled while this
   * process — or an earlier one — was alive and already had its outcome recorded, so a restart
   * that republished it would answer a question nobody is still asking.
   */
  private async restorePublications(): Promise<void> {
    let cursor = 0;
    while (this.started) {
      const routes = await this.options.store.lifecycle.listRestorableRunRoutes(
        ["succeeded", "failed", "cancelled", "interrupted", "unknown"],
        cursor,
        { windowMs: this.restoreWindowMs, now: new Date() },
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

  /** Task events have their own durable outbox. The claim rechecks the Task and the
   * exact audience before this method calls the channel transport. */
  private kickTaskNotifications(): void {
    if (!this.started || this.notificationPumping) return;
    const task = (async () => {
      const candidates = await this.options.store.taskNotifications.listUndelivered(100);
      for (const candidate of candidates) {
        if (!this.started) break;
        await this.sendTaskNotification(candidate);
      }
    })()
      .catch(() => this.report("delivery_failed"))
      .finally(() => {
        this.notificationPumping = undefined;
        this.publications.delete(task);
      });
    this.notificationPumping = task;
    this.publications.add(task);
  }

  private async sendTaskNotification(candidate: TaskNotificationRecord): Promise<void> {
    const caller: CallerContext = {
      principalId: candidate.principalId,
      scope: structuredClone(candidate.destination),
    };
    let lease;
    try {
      lease = await this.options.store.taskNotifications.claim(caller, candidate.id);
    } catch {
      this.report("delivery_failed", candidate.runId);
      return;
    }
    if (!lease) return;
    const notice = lease.notification;
    await this.emit({
      type: "task_notification_changed",
      runId: notice.runId,
      taskId: notice.taskId,
      notificationId: notice.id,
      status: "sending",
    });
    const delivery: DeliveryRecord = {
      id: notice.id,
      runId: notice.runId,
      dedupKey: `task-event-${notice.eventSequence}`,
      destinationScopeKey: notice.destinationScopeKey,
      payloadText: notice.payloadText,
      payloadKind: "text",
      status: "sending",
      externalId: null,
    };
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<SendOutcome>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve({ status: "unknown", reason: "delivery_timeout" });
      }, this.deliveryTimeoutMs);
    });
    let outcome: SendOutcome;
    try {
      outcome = await Promise.race([
        this.options.transport
          .send({
            destination: structuredClone(notice.destination),
            delivery,
            signal: controller.signal,
          })
          .catch((): SendOutcome => ({ status: "unknown", reason: "transport_error" })),
        timeout,
      ]);
      if (!outcome || !["sent", "failed", "unknown"].includes(outcome.status))
        outcome = { status: "unknown", reason: "invalid_response" };
    } catch {
      outcome = { status: "unknown", reason: "transport_error" };
    } finally {
      clearTimeout(timer);
    }
    const reason =
      outcome.status === "sent" ? undefined : deliveryReason(outcome.status, outcome.reason);
    try {
      await lease.settle(
        outcome.status,
        outcome.status === "sent" ? outcome.externalId : undefined,
      );
      await this.emit({
        type: "task_notification_changed",
        runId: notice.runId,
        taskId: notice.taskId,
        notificationId: notice.id,
        status: outcome.status,
        ...(reason ? { reason } : {}),
      });
    } catch {
      this.report("delivery_failed", notice.runId);
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
    // `unknown` from a transport that never confirmed the write is not a terminal fact yet.
    // Retry a bounded number of times with backoff, reusing the same immutable delivery and ID.
    // The ID preserves trace correlation; it does not guarantee channel-side deduplication.
    // Settle once with the final outcome.
    // A platform-confirmed `failed` is never retried here; that needs an explicit, authorized
    // retry. Claiming the already-sending delivery again is a read-only authorization check:
    // LifecycleStore rechecks the Run, destination and all protected delivery sources before
    // it returns null because the current lease already owns the row.
    let outcome: SendOutcome;
    let attempts = 0;
    let retryStoppedReason: "authorization_changed" | "service_stopped" | undefined;
    let sendLease = lease;
    for (;;) {
      attempts += 1;
      outcome = await this.sendOnce(caller.scope, sendLease.delivery);
      const retryDelay = this.deliveryRetryDelaysMs[attempts - 1];
      if (
        outcome.status !== "unknown" ||
        retryDelay === undefined ||
        !RETRYABLE_UNKNOWN_REASONS.has(outcome.reason ?? "unclassified")
      )
        break;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, retryDelay));
      if (!this.started) {
        retryStoppedReason = "service_stopped";
        break;
      }
      try {
        const retryLease = await this.options.store.lifecycle.claimDelivery(
          caller,
          runId,
          deliveryId,
        );
        // The delivery is still `sending`, so the existing lease remains the owner. A lease
        // returned here means another state transition released it; use the newly claimed
        // lease so the next send is still protected by the same authorization transaction.
        if (retryLease) sendLease = retryLease;
      } catch (error) {
        if (!(error instanceof AccessDeniedError)) throw error;
        retryStoppedReason = "authorization_changed";
        break;
      }
    }
    const reason =
      outcome.status === "sent" ? undefined : deliveryReason(outcome.status, outcome.reason);
    try {
      await sendLease.settle(
        outcome.status,
        outcome.status === "sent" ? outcome.externalId : undefined,
        reason,
      );
      await this.emit({
        type: "delivery_changed",
        runId,
        deliveryId,
        status: outcome.status,
        ...(reason ? { reason } : {}),
        ...(attempts > 1 ? { attempts } : {}),
        ...(retryStoppedReason ? { retryStoppedReason } : {}),
        ...(outcome.status === "sent" && outcome.externalId
          ? { externalId: outcome.externalId }
          : {}),
      });
    } catch {
      this.report("delivery_failed", runId);
    }
  }

  private async sendOnce(
    destination: CallerContext["scope"],
    delivery: DeliveryRecord,
  ): Promise<SendOutcome> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<SendOutcome>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve({ status: "unknown", reason: "delivery_timeout" });
      }, this.deliveryTimeoutMs);
    });
    let outcome: SendOutcome;
    try {
      outcome = await Promise.race([
        this.options.transport
          .send({
            destination: structuredClone(destination),
            delivery: structuredClone(delivery),
            signal: controller.signal,
          })
          .catch((): SendOutcome => ({ status: "unknown", reason: "transport_error" })),
        timeout,
      ]);
      if (!outcome || !["sent", "failed", "unknown"].includes(outcome.status))
        outcome = { status: "unknown", reason: "invalid_response" };
    } catch {
      outcome = { status: "unknown", reason: "transport_error" };
    } finally {
      clearTimeout(timer);
    }
    return outcome;
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
