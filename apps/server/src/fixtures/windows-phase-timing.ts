import { performance } from "node:perf_hooks";
import type { Transaction } from "@libsql/client";
import { vi } from "vite-plus/test";
import { DomainDatabase } from "../persistence/database.js";
import * as privatePath from "../platform/private-path.js";
import { RunTraceStore } from "../trace/run-store.js";

type TimingCase = "owner-restart" | "visitor-restart" | "future-mcp";
type Metric = "transaction" | "transaction-operation" | "database-close" | "trace-append" | "acl";
type Phase =
  | "owner-setup"
  | "fixture-open"
  | "fixture-save-channel"
  | "fixture-connect"
  | "fixture-close"
  | "fixture-reopen"
  | "enable-group-a"
  | "enable-group-b"
  | "visitor-run"
  | "private-rejection"
  | "restart"
  | "verify"
  | "database-open"
  | "setup"
  | "denied-call"
  | "grant"
  | "allowed-call"
  | "trace-read"
  | "cleanup";

export interface WindowsPhaseTiming {
  phase<T>(phase: Phase, operation: () => Promise<T>): Promise<T>;
  finish(): void;
}

/** Test-only observation. Never logs arguments, results, errors, paths or SQL. */
export function startWindowsPhaseTiming(
  testCase: TimingCase,
  options: { enabled?: boolean; emit?: (line: string) => void } = {},
): WindowsPhaseTiming {
  if (!(options.enabled ?? process.platform === "win32"))
    return { phase: (_phase, operation) => operation(), finish: () => {} };

  const emit = options.emit ?? ((line: string) => console.log(line));
  const metrics = new Map<
    Metric,
    { count: number; failed: number; totalMs: number; maxMs: number }
  >();
  const active = new Set<{ metric: Metric; started: number }>();
  const phases = new Set<{ phase: Phase; started: number }>();
  const restores: Array<() => void> = [];
  let finished = false;
  let slowRecords = 0;
  const write = (record: Record<string, unknown>) => {
    if (!finished) emit(`[windows-test-timing] ${JSON.stringify({ testCase, ...record })}`);
  };
  const elapsed = (started: number) => Math.round(performance.now() - started);
  const snapshot = () =>
    [...metrics].map(([metric, value]) => ({
      metric,
      ...value,
      totalMs: Math.round(value.totalMs),
      maxMs: Math.round(value.maxMs),
      active: [...active].filter((item) => item.metric === metric).length,
      oldestActiveMs: Math.max(
        0,
        ...[...active]
          .filter((item) => item.metric === metric)
          .map((item) => elapsed(item.started)),
      ),
    }));

  async function measure<T>(metric: Metric, operation: () => Promise<T>): Promise<T> {
    const item = { metric, started: performance.now() };
    const total = metrics.get(metric) ?? { count: 0, failed: 0, totalMs: 0, maxMs: 0 };
    metrics.set(metric, total);
    active.add(item);
    let outcome = "succeeded";
    try {
      return await operation();
    } catch (error) {
      outcome = "failed";
      total.failed++;
      throw error;
    } finally {
      active.delete(item);
      const duration = performance.now() - item.started;
      total.count++;
      total.totalMs += duration;
      total.maxMs = Math.max(total.maxMs, duration);
      if (duration >= 1_000 && slowRecords++ < 8)
        write({ kind: "slow-operation", metric, outcome, elapsedMs: Math.round(duration) });
    }
  }

  // Plain wrappers avoid spy call histories retaining transactions and their native handles.
  const transactionDescriptor = Object.getOwnPropertyDescriptor(
    DomainDatabase.prototype,
    "transaction",
  )!;
  const transaction = transactionDescriptor.value as DomainDatabase["transaction"];
  Object.defineProperty(DomainDatabase.prototype, "transaction", {
    ...transactionDescriptor,
    value: function <T>(
      this: DomainDatabase,
      operation: (tx: Transaction) => Promise<T>,
    ): Promise<T> {
      return measure(
        "transaction",
        () =>
          transaction.call(this, (tx) =>
            measure("transaction-operation", () => operation(tx)),
          ) as Promise<T>,
      );
    },
  });
  restores.push(() =>
    Object.defineProperty(DomainDatabase.prototype, "transaction", transactionDescriptor),
  );
  const closeDescriptor = Object.getOwnPropertyDescriptor(DomainDatabase.prototype, "close")!;
  const close = closeDescriptor.value as DomainDatabase["close"];
  Object.defineProperty(DomainDatabase.prototype, "close", {
    ...closeDescriptor,
    value: function (this: DomainDatabase) {
      return measure("database-close", () => close.call(this));
    },
  });
  restores.push(() => Object.defineProperty(DomainDatabase.prototype, "close", closeDescriptor));
  const appendDescriptor = Object.getOwnPropertyDescriptor(RunTraceStore.prototype, "append")!;
  const append = appendDescriptor.value as RunTraceStore["append"];
  Object.defineProperty(RunTraceStore.prototype, "append", {
    ...appendDescriptor,
    value: function (this: RunTraceStore, ...args: Parameters<RunTraceStore["append"]>) {
      return measure("trace-append", () => append.apply(this, args));
    },
  });
  restores.push(() => Object.defineProperty(RunTraceStore.prototype, "append", appendDescriptor));
  const securePrivatePath = privatePath.securePrivatePath;
  const aclSpy = vi
    .spyOn(privatePath, "securePrivatePath")
    .mockImplementation((...args) =>
      measure("acl", () => securePrivatePath(...args)).finally(() => aclSpy.mockClear()),
    );
  restores.push(() => aclSpy.mockRestore());

  write({ kind: "case", outcome: "started" });
  return {
    async phase<T>(phase: Phase, operation: () => Promise<T>): Promise<T> {
      const item = { phase, started: performance.now() };
      phases.add(item);
      write({ kind: "phase", phase, outcome: "started" });
      let outcome = "succeeded";
      try {
        return await operation();
      } catch (error) {
        outcome = "failed";
        throw error;
      } finally {
        phases.delete(item);
        write({
          kind: "phase",
          phase,
          outcome,
          elapsedMs: elapsed(item.started),
          metrics: snapshot(),
        });
      }
    },
    finish() {
      if (finished) return;
      for (const item of phases)
        write({
          kind: "phase",
          phase: item.phase,
          outcome: "unfinished",
          elapsedMs: elapsed(item.started),
        });
      write({ kind: "summary", metrics: snapshot() });
      finished = true;
      for (const restore of restores.reverse()) restore();
    },
  };
}
