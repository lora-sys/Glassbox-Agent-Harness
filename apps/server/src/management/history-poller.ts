import type { HistorySyncOutcome } from "../runtime/pi/history-tools.js";
import type { CallerContext } from "../identity/scope.js";

/** One configured group whose history this server is responsible for pulling. */
export interface HistorySyncTarget {
  connectionId: string;
  groupId: string;
  /** The configured Owner scope whose current history:read grant authorizes collection. */
  caller?: CallerContext;
}

export type HistorySyncRun = (
  target: HistorySyncTarget,
  options: { maxPages: number; mode: "poll" | "backfill" },
) => Promise<HistorySyncOutcome>;

/** What the last sync of one target actually did, so a silent stall is visible. */
export interface HistorySyncRecord {
  outcome: HistorySyncOutcome | null;
  at: string | null;
  /** A sync that threw rather than stopped, so the reason is not lost with the stack. */
  error: string | null;
}

type PollTimer = ReturnType<typeof setInterval>;

export interface HistoryPollerOptions {
  /** Wall clock between ticks. */
  intervalMs?: number;
  /** Pages one ordinary tick may walk per group. */
  maxPages?: number;
  /** Resolved fresh on every tick, so a config or policy change applies without a restart. */
  listTargets: () => Promise<HistorySyncTarget[]> | HistorySyncTarget[];
  run: HistorySyncRun;
  now?: () => Date;
  setTimer?: (callback: () => void, ms: number) => PollTimer;
  clearTimer?: (timer: PollTimer) => void;
}

const DEFAULT_INTERVAL_MS = 60_000;

/**
 * Keeps the durable group archive growing on its own.
 *
 * The archive used to grow only when a Run called `group_history_search`, so a group nobody
 * asked about had no history at all, and a group the socket dropped messages from had a hole
 * nobody could see. This poller walks each configured group on a bounded interval, which is
 * also what makes the reconnect backfill meaningful: there is now a normal cadence for a gap
 * to be filled back into.
 *
 * It is bounded in three ways, because it runs for the life of the process against a provider
 * that can stall. Ticks never overlap, so a slow provider cannot queue up work behind itself.
 * Each tick resolves its targets fresh and walks at most `maxPages` per group. And the timer
 * is unreferenced, so the poller can never be the reason the process stays alive.
 */
export class GroupHistoryPoller {
  private readonly intervalMs: number;
  private readonly maxPages: number;
  private readonly listTargets: HistoryPollerOptions["listTargets"];
  private readonly run: HistorySyncRun;
  private readonly now: () => Date;
  private readonly setTimer: NonNullable<HistoryPollerOptions["setTimer"]>;
  private readonly clearTimer: NonNullable<HistoryPollerOptions["clearTimer"]>;
  private readonly lastSyncs = new Map<string, HistorySyncRecord>();
  private timer: PollTimer | undefined;
  private running: Promise<void> | undefined;
  private stopped = false;

  constructor(options: HistoryPollerOptions) {
    this.intervalMs = Math.max(1_000, options.intervalMs ?? DEFAULT_INTERVAL_MS);
    this.maxPages = Math.max(1, options.maxPages ?? 1);
    this.listTargets = options.listTargets;
    this.run = options.run;
    this.now = options.now ?? (() => new Date());
    this.setTimer =
      options.setTimer ??
      ((callback, ms) => {
        const timer = setInterval(callback, ms);
        timer.unref();
        return timer;
      });
    this.clearTimer = options.clearTimer ?? ((timer) => clearInterval(timer));
  }

  /** The last sync of one group, or undefined when this server never synced it. */
  record(connectionId: string, groupId: string): HistorySyncRecord | undefined {
    return this.lastSyncs.get(recordKey(connectionId, groupId));
  }

  /** Every target this poller has synced, with what the last sync did. */
  records(): ReadonlyMap<string, HistorySyncRecord> {
    return this.lastSyncs;
  }

  start(): void {
    if (this.timer !== undefined || this.stopped) return;
    this.timer = this.setTimer(() => {
      void this.tick();
    }, this.intervalMs);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer !== undefined) {
      this.clearTimer(this.timer);
      this.timer = undefined;
    }
    // A tick already in flight keeps its provider read; stopping it would leave the archive
    // half-written with no record of why.
    await this.running;
  }

  /**
   * One pass over every current target.
   *
   * Returns the in-flight promise when a tick is already running rather than starting a second
   * one: a provider that takes longer than the interval must not accumulate concurrent walks.
   */
  tick(): Promise<void> {
    if (this.stopped) return this.running ?? Promise.resolve();
    this.running ??= this.walk()
      .catch(() => {
        // Target discovery reads durable policy too. Its failures happen before a group
        // exists to record, but must not escape the detached timer or expose raw DB errors.
        console.warn("Group history poll failed; retrying next interval.");
      })
      .finally(() => {
        this.running = undefined;
      });
    return this.running;
  }

  /**
   * Walk one group right now, past the per-tick page bound.
   *
   * This is the reconnect path. A walk that only ever reads the newest five pages can never
   * reach back over an outage, because the newest page after a reconnect is the first page
   * after the gap — the walk stops there and the gap stays a hole. So the caller asks for a
   * deeper walk, and the same idempotent ingest dedupes what the gap already covered.
   */
  async backfill(target: HistorySyncTarget, maxPages: number): Promise<HistorySyncOutcome> {
    return this.recorded(target, async () => this.run(target, { maxPages, mode: "backfill" }));
  }

  private async walk(): Promise<void> {
    const targets = await this.listTargets();
    for (const target of targets) {
      if (this.stopped) return;
      await this.recorded(target, async () =>
        this.run(target, { maxPages: this.maxPages, mode: "poll" }),
      );
    }
  }

  /**
   * Run one sync and keep what it did, whether it stopped on a reason or threw.
   *
   * A throw is recorded rather than propagated: this poller runs unattended, and an unhandled
   * rejection would end the process for what is a provider problem on one group.
   */
  private async recorded(
    target: HistorySyncTarget,
    sync: () => Promise<HistorySyncOutcome>,
  ): Promise<HistorySyncOutcome> {
    const key = recordKey(target.connectionId, target.groupId);
    try {
      const outcome = await sync();
      this.lastSyncs.set(key, { outcome, at: this.now().toISOString(), error: null });
      return outcome;
    } catch (error) {
      this.lastSyncs.set(key, {
        outcome: null,
        at: this.now().toISOString(),
        error: error instanceof Error ? error.message : String(error),
      });
      return { pagesWalked: 0, stop: "provider_failed" };
    }
  }
}

function recordKey(connectionId: string, groupId: string): string {
  return `${connectionId}:${groupId}`;
}
