// apps/server/src/trace/store.test.ts
// Tests for RawTraceStore and loadTrace round-trip, refresh safety,
// and append-only semantics.

import { describe, expect, it, beforeEach, afterAll } from "vitest";
import { readFileSync, rmSync } from "node:fs";
import { RawTraceStore, getGlassboxBase, getTracePath, TRACE_PROVENANCE } from "./store.js";
import { loadTrace } from "./load.js";

const SESSION = "trace-test-session-001";

const testDir = `${getGlassboxBase()}/sessions/${SESSION}`;

function cleanTestData(): void {
  try { rmSync(testDir, { recursive: true, force: true }); } catch { /* ignore */ }
}

describe("RawTraceStore", () => {
  beforeEach(() => { cleanTestData(); });
  afterAll(() => { cleanTestData(); });

  it("creates the session directory on first append", () => {
    new RawTraceStore().append(SESSION, { method: "thread/started", params: { thread: { id: "t1" } } });
  });

  it("writes a valid JSONL line with seq, ts, event, provenance", () => {
    const store = new RawTraceStore();
    store.append(SESSION, { method: "thread/started", params: { thread: { id: "t1" } } });

    const path = getTracePath(SESSION);
    const content = readFileSync(path, "utf-8");
    const entry = JSON.parse(content.trim()) as any;
    expect(entry.seq).toBe(1);
    expect(entry.ts).toBeTruthy();
    expect(entry.event).toEqual({ method: "thread/started", params: { thread: { id: "t1" } } });
    expect(entry.provenance).toBe(TRACE_PROVENANCE);
  });

  it("appends three events in order with incremental seq numbers", () => {
    const store = new RawTraceStore();

    store.append(SESSION, { method: "thread/started", params: { order: 1 } });
    store.append(SESSION, { method: "turn/started", params: { order: 2 } });
    store.append(SESSION, { method: "turn/completed", params: { order: 3 } });

    const trace = loadTrace(SESSION);
    expect(trace).toHaveLength(3);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((trace[0] as any).seq).toBe(1);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((trace[0] as any).event.method).toBe("thread/started");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((trace[1] as any).seq).toBe(2);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((trace[1] as any).event.method).toBe("turn/started");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((trace[2] as any).seq).toBe(3);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((trace[2] as any).event.method).toBe("turn/completed");
  });

  it("is append-only: second write builds on first, not replace", () => {
    const store = new RawTraceStore();

    store.append(SESSION, { method: "turn/started", params: { run: "first" } });
    store.append(SESSION, { method: "turn/completed", params: { run: "second" } });

    const trace = loadTrace(SESSION);
    expect(trace).toHaveLength(2);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((trace[0] as any).event.params).toEqual({ run: "first" });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((trace[1] as any).event.params).toEqual({ run: "second" });
  });
});

describe("loadTrace", () => {
  beforeEach(() => { cleanTestData(); });
  afterAll(() => { cleanTestData(); });

  it("throws when the trace file does not exist", () => {
    expect(() => loadTrace("nonexistent-session-xyz")).toThrow();
  });

  it("returns events in file order (chronological)", () => {
    const store = new RawTraceStore();
    store.append(SESSION, { method: "event-a", params: { order: 1 } });
    store.append(SESSION, { method: "event-b", params: { order: 2 } });
    store.append(SESSION, { method: "event-c", params: { order: 3 } });

    const trace = loadTrace(SESSION);
    expect(trace).toHaveLength(3);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((trace[0] as any).event.method).toBe("event-a");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((trace[1] as any).event.method).toBe("event-b");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((trace[2] as any).event.method).toBe("event-c");
  });
});

describe("refresh safety", () => {
  it("loading with a new RawTraceStore instance reads the full written sequence", () => {
    cleanTestData();

    const sessionId = "refresh-safety-123";
    const sessionDir = `${getGlassboxBase()}/sessions/${sessionId}`;

    // Instance A: write two events
    new RawTraceStore().append(sessionId, { method: "m1", params: { v: 1 } });
    new RawTraceStore().append(sessionId, { method: "m2", params: { v: 2 } });

    // Simulate a "restart": instance A is gone, only the file remains.
    const trace = loadTrace(sessionId);

    expect(trace).toHaveLength(2);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((trace[0] as any).seq).toBe(1);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((trace[0] as any).event.method).toBe("m1");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((trace[1] as any).seq).toBe(2);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((trace[1] as any).event.method).toBe("m2");

    // Append a third event via a new instance — proves append-only goodness
    new RawTraceStore().append(sessionId, { method: "m3", params: { v: 3 } });
    const trace2 = loadTrace(sessionId);
    expect(trace2).toHaveLength(3);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((trace2[2] as any).seq).toBe(3);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((trace2[2] as any).event.method).toBe("m3");

    try { rmSync(sessionDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });
});
