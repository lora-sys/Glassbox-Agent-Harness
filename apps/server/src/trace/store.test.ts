import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { existsSync, mkdtempSync, readFileSync, rmSync, appendFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { RawTraceStore, getGlassboxBase, getTracePath, TRACE_PROVENANCE } from "./store.js";
import { loadTrace } from "./load.js";

const SESSION = "trace-test-session-001";
let testRoot: string;

beforeEach(() => {
  testRoot = mkdtempSync(path.join(os.tmpdir(), "glassbox-trace-test-"));
  vi.stubEnv("GLASSBOX_DATA_DIR", testRoot);
});

afterEach(() => {
  vi.unstubAllEnvs();
  // Only the directory created by this test is removed, never a configured data directory.
  const resolved = path.resolve(testRoot);
  if (
    path.dirname(resolved) !== path.resolve(os.tmpdir()) ||
    !path.basename(resolved).startsWith("glassbox-trace-test-")
  ) {
    throw new Error("Refusing to remove a directory outside the trace fixture");
  }
  rmSync(resolved, { recursive: true, force: true });
});

describe("RawTraceStore", () => {
  it("creates the session directory in the isolated data root on first append", () => {
    new RawTraceStore().append(SESSION, {
      method: "thread/started",
      params: { thread: { id: "t1" } },
    });
    expect(getGlassboxBase()).toBe(testRoot);
    expect(getTracePath(SESSION)).toBe(path.join(testRoot, "sessions", SESSION, "trace.jsonl"));
    expect(existsSync(getTracePath(SESSION))).toBe(true);
  });

  it("writes a valid JSONL line with seq, ts, event, provenance", () => {
    const event = { method: "thread/started", params: { thread: { id: "t1" } } };
    new RawTraceStore().append(SESSION, event);
    const entry: unknown = JSON.parse(readFileSync(getTracePath(SESSION), "utf-8").trim());
    expect(entry).toEqual({ seq: 1, ts: expect.any(String), event, provenance: TRACE_PROVENANCE });
  });

  it("appends three events in order with incremental seq numbers", () => {
    const store = new RawTraceStore();
    store.append(SESSION, { method: "thread/started", params: { order: 1 } });
    store.append(SESSION, { method: "turn/started", params: { order: 2 } });
    store.append(SESSION, { method: "turn/completed", params: { order: 3 } });
    expect(loadTrace(SESSION)).toMatchObject([
      { seq: 1, event: { method: "thread/started", params: { order: 1 } } },
      { seq: 2, event: { method: "turn/started", params: { order: 2 } } },
      { seq: 3, event: { method: "turn/completed", params: { order: 3 } } },
    ]);
  });

  it("preserves the exact first line when another event is appended", () => {
    const store = new RawTraceStore();
    store.append(SESSION, { method: "turn/started", params: { run: "first" } });
    const firstLine = readFileSync(getTracePath(SESSION), "utf-8");
    store.append(SESSION, { method: "turn/completed", params: { run: "second" } });
    expect(readFileSync(getTracePath(SESSION), "utf-8").startsWith(firstLine)).toBe(true);
    expect(loadTrace(SESSION)).toMatchObject([
      { event: { params: { run: "first" } } },
      { event: { params: { run: "second" } } },
    ]);
  });

  it("rejects path traversal and invalid identifiers before creating directories or writing", () => {
    const store = new RawTraceStore();
    const malicious = [
      "../escape",
      "..\\escape",
      "../../etc/passwd",
      "/absolute/path",
      "C:\\Windows",
      "has/slash",
      "has\\backslash",
      "has:colon",
      "",
      ".",
      "..",
      "CON",
      "AUX",
    ];

    for (const id of malicious) {
      expect(() => getTracePath(id)).toThrow();
      expect(() => store.append(id, { test: 1 })).toThrow();
      expect(() => loadTrace(id)).toThrow();
    }
  });

  it("fails clearly on truncated tail on restart instead of silently resetting sequence to 1", () => {
    const sessionId = "corrupt-tail-session";
    const store1 = new RawTraceStore();
    store1.append(sessionId, { seq1: true });

    // Corrupt tail by appending unclosed line without newline
    const filePath = getTracePath(sessionId);
    appendFileSync(filePath, '{"partial": "record"', "utf-8");

    // Restart: new store instance must throw clearly rather than resetting seq or concatenating corrupt text
    const store2 = new RawTraceStore();
    expect(() => store2.append(sessionId, { next: true })).toThrow(/truncated tail/);
  });
});

describe("loadTrace", () => {
  it("throws when the trace file does not exist", () => {
    expect(() => loadTrace("nonexistent-session-xyz")).toThrow();
  });

  it("returns events in file order", () => {
    const store = new RawTraceStore();
    store.append(SESSION, { method: "event-a", params: { order: 1 } });
    store.append(SESSION, { method: "event-b", params: { order: 2 } });
    store.append(SESSION, { method: "event-c", params: { order: 3 } });
    expect(loadTrace(SESSION)).toMatchObject([
      { event: { method: "event-a" } },
      { event: { method: "event-b" } },
      { event: { method: "event-c" } },
    ]);
  });

  it("throws honest error on truncated tail by default and returns complete prefix when requested", () => {
    const sessionId = "prefix-test-session";
    const store = new RawTraceStore();
    store.append(sessionId, { order: 1 });
    store.append(sessionId, { order: 2 });

    const filePath = getTracePath(sessionId);
    appendFileSync(filePath, '{"seq": 3, "interrupted": true', "utf-8");

    // Default throws
    expect(() => loadTrace(sessionId)).toThrow(/Failed to parse trace entry/);

    // allowPartialPrefix returns complete valid prefix
    const prefix = loadTrace(sessionId, { allowPartialPrefix: true });
    expect(prefix).toHaveLength(2);
    expect(prefix[0].event).toEqual({ order: 1 });
    expect(prefix[1].event).toEqual({ order: 2 });
  });
});

describe("refresh safety", () => {
  it("reads and continues the full sequence with a new RawTraceStore instance", () => {
    const sessionId = "refresh-safety-123";
    new RawTraceStore().append(sessionId, { method: "m1", params: { v: 1 } });
    new RawTraceStore().append(sessionId, { method: "m2", params: { v: 2 } });
    expect(loadTrace(sessionId)).toMatchObject([
      { seq: 1, event: { method: "m1" } },
      { seq: 2, event: { method: "m2" } },
    ]);
    new RawTraceStore().append(sessionId, { method: "m3", params: { v: 3 } });
    expect(loadTrace(sessionId)).toMatchObject([
      { seq: 1, event: { method: "m1" } },
      { seq: 2, event: { method: "m2" } },
      { seq: 3, event: { method: "m3" } },
    ]);
  });

  it("invalidates cache on append failure and rejects non-consecutive sequence", () => {
    const store = new RawTraceStore();
    const sessionId = "cache-poison-session";

    store.append(sessionId, { step: 1 });

    // Manually inject a gapped line into trace.jsonl (seq 3 instead of seq 2)
    const filePath = getTracePath(sessionId);
    appendFileSync(
      filePath,
      JSON.stringify({ seq: 3, ts: new Date().toISOString(), event: {}, provenance: "test" }) +
        "\n",
      "utf-8",
    );

    // loadTrace must reject the gapped sequence
    expect(() => loadTrace(sessionId)).toThrow(/Non-consecutive trace sequence/);

    // loadTrace with allowPartialPrefix returns only the valid consecutive prefix (seq 1)
    const prefix = loadTrace(sessionId, { allowPartialPrefix: true });
    expect(prefix).toHaveLength(1);
    expect(prefix[0].seq).toBe(1);
  });

  it("rejects directory junctions that escape data directory", async () => {
    const outsideDir = mkdtempSync(path.join(os.tmpdir(), "glassbox-outside-raw-"));
    const sessionsDir = path.join(testRoot, "sessions");
    const { mkdirSync, symlinkSync, unlinkSync, rmSync } = await import("node:fs");

    mkdirSync(sessionsDir, { recursive: true });
    const junctionPath = path.join(sessionsDir, "escaped-session");

    try {
      symlinkSync(outsideDir, junctionPath, "junction");

      expect(() => getTracePath("escaped-session")).toThrow(/Security violation/);
      expect(() => new RawTraceStore().append("escaped-session", { test: 1 })).toThrow(
        /Security violation/,
      );
    } finally {
      try {
        unlinkSync(junctionPath);
      } catch {
        // ignore
      }
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });
});
