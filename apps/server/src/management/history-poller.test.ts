import { describe, expect, it, vi } from "vite-plus/test";
import { GroupHistoryPoller, type HistorySyncTarget } from "./history-poller.js";

/** A fake interval the test drives by hand, so no test waits on a real 60 seconds. */
function fakeTimer() {
  const timers = new Set<() => void>();
  let created = 0;
  let cleared = 0;
  const setTimer = (callback: () => void, _ms: number) => {
    created += 1;
    const entry = () => callback();
    timers.add(entry);
    return entry as unknown as ReturnType<typeof setInterval>;
  };
  const clearTimer = (entry: unknown) => {
    cleared += 1;
    timers.delete(entry as () => void);
  };
  return {
    setTimer,
    clearTimer,
    fire() {
      // Iterated over a copy: a callback that reschedules puts a new entry in the live set, and
      // firing the copy leaves that one for the next tick.
      for (const entry of Array.from(timers)) entry();
    },
    get created() {
      return created;
    },
    get cleared() {
      return cleared;
    },
    get pending() {
      return timers.size;
    },
  };
}

const target: HistorySyncTarget = { connectionId: "qq", groupId: "100" };
const other: HistorySyncTarget = { connectionId: "qq", groupId: "200" };

describe("GroupHistoryPoller", () => {
  it.each(["sync", "async"])(
    "contains a %s target-enumeration failure and retries on the next timer tick",
    async (failureMode) => {
      const timer = fakeTimer();
      const diagnostic = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      let attempts = 0;
      const run = vi.fn(async () => ({ pagesWalked: 1, stop: "end_of_source" as const }));
      const poller = new GroupHistoryPoller({
        listTargets: () => {
          attempts += 1;
          if (attempts > 1) return [target];
          const error = new Error("private database path and protected payload");
          if (failureMode === "sync") throw error;
          return Promise.reject(error);
        },
        run,
        setTimer: timer.setTimer,
        clearTimer: timer.clearTimer,
      });
      try {
        poller.start();
        timer.fire();
        await expect(poller.tick()).resolves.toBeUndefined();
        expect(attempts).toBe(1);
        expect(run).not.toHaveBeenCalled();
        expect(poller.records().size).toBe(0);
        expect(diagnostic.mock.calls).toEqual([
          ["Group history poll failed; retrying next interval."],
        ]);
        timer.fire();
        await poller.tick();
        expect(attempts).toBe(2);
        expect(run).toHaveBeenCalledExactlyOnceWith(target, { maxPages: 1, mode: "poll" });
        expect(poller.record("qq", "100")?.error).toBeNull();
      } finally {
        await poller.stop();
        diagnostic.mockRestore();
      }
    },
  );

  it("does not enumerate targets after it has stopped", async () => {
    const listTargets = vi.fn(() => [target]);
    const run = vi.fn(async () => ({ pagesWalked: 1, stop: "end_of_source" as const }));
    const poller = new GroupHistoryPoller({ listTargets, run });
    await poller.stop();
    await poller.tick();
    expect(listTargets).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it("walks every current target on a tick, at the tick page bound", async () => {
    const timer = fakeTimer();
    const walked: Array<{
      target: HistorySyncTarget;
      maxPages: number;
      mode: "poll" | "backfill";
    }> = [];
    const poller = new GroupHistoryPoller({
      intervalMs: 60_000,
      maxPages: 5,
      listTargets: () => [target, other],
      run: async (walkedTarget, walk) => {
        walked.push({ target: walkedTarget, maxPages: walk.maxPages, mode: walk.mode });
        return { pagesWalked: 1, stop: "end_of_source" };
      },
      setTimer: timer.setTimer,
      clearTimer: timer.clearTimer,
    });

    poller.start();
    timer.fire();
    await poller.tick();

    expect(walked).toEqual([
      { target, maxPages: 5, mode: "poll" },
      { target: other, maxPages: 5, mode: "poll" },
    ]);
    expect(poller.record("qq", "100")).toMatchObject({
      outcome: { pagesWalked: 1, stop: "end_of_source" },
      error: null,
    });
  });

  it("resolves its targets again on the next tick, so a new group is picked up without a restart", async () => {
    const timer = fakeTimer();
    let groups = [target];
    const poller = new GroupHistoryPoller({
      listTargets: () => groups,
      run: async () => ({ pagesWalked: 1, stop: "end_of_source" }),
      setTimer: timer.setTimer,
      clearTimer: timer.clearTimer,
    });

    await poller.tick();
    groups = [target, other];
    await poller.tick();

    expect([...poller.records().keys()]).toEqual(["qq:100", "qq:200"]);
  });

  it("does not start a second walk while one is still running", async () => {
    const timer = fakeTimer();
    let inFlight = 0;
    let maxInFlight = 0;
    const release: Array<() => void> = [];
    let started!: () => void;
    const firstSync = new Promise<void>((resolve) => {
      started = resolve;
    });
    const poller = new GroupHistoryPoller({
      listTargets: () => [target],
      run: () => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        started();
        return new Promise((resolve) => {
          release.push(() => {
            inFlight -= 1;
            resolve({ pagesWalked: 1, stop: "end_of_source" });
          });
        });
      },
      setTimer: timer.setTimer,
      clearTimer: timer.clearTimer,
    });

    const first = poller.tick();
    const second = poller.tick();
    expect(second).toBe(first);
    await firstSync;
    release.forEach((done) => done());
    await Promise.all([first, second]);

    expect(inFlight).toBe(0);
    expect(maxInFlight).toBe(1);
  });

  it("backfills deeper than a tick, because the newest page after a reconnect starts after the gap", async () => {
    const timer = fakeTimer();
    const walked: number[] = [];
    const modes: string[] = [];
    const poller = new GroupHistoryPoller({
      maxPages: 5,
      listTargets: () => [target],
      run: async (_target, walk) => {
        walked.push(walk.maxPages);
        modes.push(walk.mode);
        return { pagesWalked: walk.maxPages, stop: "page_bound_reached" };
      },
      setTimer: timer.setTimer,
      clearTimer: timer.clearTimer,
    });

    await poller.tick();
    await poller.backfill(target, 20);

    expect(walked).toEqual([5, 20]);
    expect(modes).toEqual(["poll", "backfill"]);
    expect(poller.record("qq", "100")?.outcome).toEqual({
      pagesWalked: 20,
      stop: "page_bound_reached",
    });
  });

  it("records a sync that threw instead of rejecting, so one bad group cannot end the process", async () => {
    const timer = fakeTimer();
    const poller = new GroupHistoryPoller({
      listTargets: () => [target, other],
      run: async (walkedTarget) => {
        if (walkedTarget.groupId === "100") throw new Error("provider hung up");
        return { pagesWalked: 1, stop: "end_of_source" };
      },
      setTimer: timer.setTimer,
      clearTimer: timer.clearTimer,
    });

    await expect(poller.tick()).resolves.toBeUndefined();

    // A throw is not one of the stops the provider answers with, so the record keeps no outcome
    // and keeps the reason instead: a group whose sync keeps throwing has to look different from
    // a group that was simply quiet.
    expect(poller.record("qq", "100")).toMatchObject({
      outcome: null,
      error: "provider hung up",
    });
    // The second group still ran: one provider failure is not a reason to stop walking the rest.
    expect(poller.record("qq", "200")).toMatchObject({ error: null });
  });

  it("stops its timer and waits for a walk already in flight", async () => {
    const timer = fakeTimer();
    let finished = false;
    let release!: () => void;
    let started!: () => void;
    const firstSync = new Promise<void>((resolve) => {
      started = resolve;
    });
    const poller = new GroupHistoryPoller({
      listTargets: () => [target],
      run: () => {
        started();
        return new Promise((resolve) => {
          release = () => {
            finished = true;
            resolve({ pagesWalked: 1, stop: "end_of_source" });
          };
        });
      },
      setTimer: timer.setTimer,
      clearTimer: timer.clearTimer,
    });

    poller.start();
    const walk = poller.tick();
    await firstSync;
    release();
    await poller.stop();
    await walk;

    expect(finished).toBe(true);
    expect(timer.cleared).toBe(1);
    expect(timer.pending).toBe(0);
    // A stopped poller does not come back on the next interval.
    timer.fire();
    await Promise.resolve();
    expect(timer.pending).toBe(0);
  });

  it("holds one timer no matter how often it is started", () => {
    const timer = fakeTimer();
    const poller = new GroupHistoryPoller({
      listTargets: () => [],
      run: async () => ({ pagesWalked: 0, stop: "end_of_source" }),
      setTimer: timer.setTimer,
      clearTimer: timer.clearTimer,
    });

    poller.start();
    poller.start();
    expect(timer.created).toBe(1);
  });
});
