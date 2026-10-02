import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vite-plus/test";
import { DomainDatabase } from "../persistence/database.js";
import { RunTraceStore } from "../trace/run-store.js";
import * as privatePath from "../platform/private-path.js";
import { startWindowsPhaseTiming } from "./windows-phase-timing.js";

describe("Windows fixture phase observation", () => {
  it("keeps the disabled path unobserved and returns the original result", async () => {
    const emit = vi.fn();
    const original = Object.getOwnPropertyDescriptor(
      DomainDatabase.prototype,
      "transaction",
    )?.value;
    const timing = startWindowsPhaseTiming("future-mcp", { enabled: false, emit });
    const result = { status: "unchanged" };
    await expect(timing.phase("verify", async () => result)).resolves.toBe(result);
    timing.finish();
    expect(emit).not.toHaveBeenCalled();
    expect(Object.getOwnPropertyDescriptor(DomainDatabase.prototype, "transaction")?.value).toBe(
      original,
    );
  });

  it("observes real transactions, trace and ACL calls without logging their data", async () => {
    const lines: string[] = [];
    const originalTransaction = Object.getOwnPropertyDescriptor(
      DomainDatabase.prototype,
      "transaction",
    )?.value;
    const originalAppend = Object.getOwnPropertyDescriptor(
      RunTraceStore.prototype,
      "append",
    )?.value;
    const originalAcl = privatePath.securePrivatePath;
    const directory = await mkdtemp(join(tmpdir(), "glassbox-timing-"));
    const timing = startWindowsPhaseTiming("future-mcp", {
      enabled: true,
      emit: (line) => lines.push(line),
    });
    try {
      const db = await timing.phase("database-open", () => DomainDatabase.open(":memory:"));
      try {
        const result = await db.transaction(async (tx) => tx.execute("SELECT 7 AS value"));
        expect(result.rows[0]?.value).toBe(7);
        const failure = new Error("private-test-error");
        await expect(
          db.transaction(async () => {
            throw failure;
          }),
        ).rejects.toBe(failure);
        const trace = new RunTraceStore(directory);
        const written = await timing.phase("allowed-call", () =>
          trace.append("private-run-id", { privatePayload: "not-for-diagnostics" }),
        );
        expect(written.eventCount).toBe(1);
      } finally {
        await db.close();
      }
    } finally {
      timing.finish();
      await rm(directory, { recursive: true, force: true });
    }
    const records = lines.map((line) => JSON.parse(line.replace("[windows-test-timing] ", "")));
    const summary = records.find((record) => record.kind === "summary");
    for (const metric of [
      "transaction",
      "transaction-operation",
      "database-close",
      "trace-append",
      "acl",
    ])
      expect(summary.metrics).toContainEqual(
        expect.objectContaining({ metric, active: 0, count: expect.any(Number) }),
      );
    expect(summary.metrics).toContainEqual(
      expect.objectContaining({ metric: "transaction", failed: 1 }),
    );
    expect(lines.join("\n")).not.toMatch(
      /private-test-error|private-run-id|privatePayload|not-for-diagnostics|SELECT|glassbox-timing-/u,
    );
    expect(Object.getOwnPropertyDescriptor(DomainDatabase.prototype, "transaction")?.value).toBe(
      originalTransaction,
    );
    expect(Object.getOwnPropertyDescriptor(RunTraceStore.prototype, "append")?.value).toBe(
      originalAppend,
    );
    expect(privatePath.securePrivatePath).toBe(originalAcl);
  });

  it("reports an unfinished phase and stops observing once the test finishes", async () => {
    const lines: string[] = [];
    const original = Object.getOwnPropertyDescriptor(
      DomainDatabase.prototype,
      "transaction",
    )?.value;
    const timing = startWindowsPhaseTiming("future-mcp", {
      enabled: true,
      emit: (line) => lines.push(line),
    });
    let release!: () => void;
    const pending = timing.phase(
      "verify",
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    timing.finish();
    timing.finish();
    expect(lines.join("\n")).toContain('"outcome":"unfinished"');
    expect(Object.getOwnPropertyDescriptor(DomainDatabase.prototype, "transaction")?.value).toBe(
      original,
    );
    const count = lines.length;
    release();
    await pending;
    expect(lines).toHaveLength(count);
  });
});
