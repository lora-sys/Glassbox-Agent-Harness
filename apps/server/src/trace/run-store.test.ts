import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  RunTraceStore,
  TraceCursorError,
  TraceTruncatedError,
  TraceCorruptedError,
  TraceEventTooLargeError,
  assertSafeIdentifier,
} from "./run-store.js";

let testRoot: string;

beforeEach(async () => {
  testRoot = await fs.mkdtemp(path.join(os.tmpdir(), "glassbox-runtrace-test-"));
});

afterEach(async () => {
  const resolved = path.resolve(testRoot);
  if (
    path.dirname(resolved) !== path.resolve(os.tmpdir()) ||
    !path.basename(resolved).startsWith("glassbox-runtrace-test-")
  ) {
    throw new Error("Refusing to remove directory outside the test fixture");
  }
  await fs.rm(resolved, { recursive: true, force: true });
});

describe("RunTraceStore - Path and Identifier Safety", () => {
  it("requires an absolute path in constructor", () => {
    expect(() => new RunTraceStore("relative/path")).toThrow(/must be an absolute path/);
    expect(() => new RunTraceStore("")).toThrow(/non-empty string/);
    expect(new RunTraceStore(testRoot).dataDirectory).toBe(path.resolve(testRoot));
  });

  it("validates safe run identifiers and rejects directory escapes", () => {
    const store = new RunTraceStore(testRoot);
    const illegal = [
      "../escape",
      "..\\escape",
      "../../etc/passwd",
      "/root/dir",
      "C:\\Windows",
      "run/sub",
      "run\\sub",
      "run:colon",
      "",
      ".",
      "..",
      "CON",
      "PRN",
      "AUX",
      "NUL",
      "COM1",
      "a".repeat(129),
    ];

    for (const badId of illegal) {
      expect(() => store.getTracePath(badId)).toThrow();
      expect(() => assertSafeIdentifier(badId)).toThrow();
    }
  });

  it("allows safe identifiers with alphanumeric, hyphens, underscores and isolated dots", () => {
    const store = new RunTraceStore(testRoot);
    const valid = ["run-001", "run_test_123", "RUN.2026", "a1-b2_c3.d4"];
    for (const goodId of valid) {
      expect(() => store.getTracePath(goodId)).not.toThrow();
      expect(store.getTracePath(goodId)).toBe(path.join(testRoot, "runs", goodId, "trace.jsonl"));
    }
  });
});

describe("RunTraceStore - Append and Record Structure", () => {
  it("appends events and returns exact byte offset and monotonic eventCount", async () => {
    const store = new RunTraceStore(testRoot);
    const runId = "run-basic-01";

    const res1 = await store.append(runId, { type: "step", name: "init" });
    expect(res1.runId).toBe(runId);
    expect(res1.traceRef).toBe(runId);
    expect(res1.eventCount).toBe(1);
    expect(res1.byteOffset).toBeGreaterThan(0);

    const filePath = store.getTracePath(runId);
    const stat1 = await fs.stat(filePath);
    expect(res1.byteOffset).toBe(stat1.size);

    const res2 = await store.append(runId, { type: "step", name: "execute" });
    expect(res2.eventCount).toBe(2);
    expect(res2.byteOffset).toBeGreaterThan(res1.byteOffset);

    const stat2 = await fs.stat(filePath);
    expect(res2.byteOffset).toBe(stat2.size);

    const content = await fs.readFile(filePath, "utf-8");
    const lines = content.trim().split("\n");
    expect(lines).toHaveLength(2);
    const e1 = JSON.parse(lines[0]);
    const e2 = JSON.parse(lines[1]);
    expect(e1.seq).toBe(1);
    expect(e2.seq).toBe(2);
    expect(e1.event).toEqual({ type: "step", name: "init" });
  });

  it("enforces structural event limit before append", async () => {
    const store = new RunTraceStore({ dataDirectory: testRoot, maxEventBytes: 128 });
    const runId = "run-limit-01";

    const bigEvent = { payload: "x".repeat(200) };
    await expect(store.append(runId, bigEvent)).rejects.toBeInstanceOf(TraceEventTooLargeError);

    // Verify no file was created and no seq advanced
    await expect(fs.stat(store.getTracePath(runId))).rejects.toThrow();

    // Appending a normal event succeeds with seq 1
    const okRes = await store.append(runId, { payload: "small" });
    expect(okRes.eventCount).toBe(1);
  });
});

describe("RunTraceStore - Chinese and Multi-byte UTF-8 Chunk Boundaries", () => {
  it("accurately tracks UTF-8 byte offsets with Chinese characters across chunk boundaries", async () => {
    const store = new RunTraceStore(testRoot);
    const runId = "run-chinese-01";

    const chineseData = [
      { text: "你好世界，这是第一条中文追踪测试数据。" },
      { text: "智能体执行步骤：正在分析用户意图并制定多步骤规划。" },
      { text: "测试特殊符号：🚀✨🌈 以及全角标点【】「」（）。" },
    ];

    for (const item of chineseData) {
      await store.append(runId, item);
    }

    const filePath = store.getTracePath(runId);
    const fileBytes = await fs.readFile(filePath);
    const stat = await fs.stat(filePath);
    expect(fileBytes.byteLength).toBe(stat.size);

    const page = await store.readPage(runId, { limit: 10 });
    expect(page.records).toHaveLength(3);
    expect(page.records[0].event).toEqual(chineseData[0]);
    expect(page.records[1].event).toEqual(chineseData[1]);
    expect(page.records[2].event).toEqual(chineseData[2]);

    // Ensure no replacement characters \uFFFD exist
    const fullText = JSON.stringify(page.records);
    expect(fullText.includes("\uFFFD")).toBe(false);
  });

  it("handles multi-byte Chinese characters spanning micro chunk boundaries (16 bytes)", async () => {
    // Force a tiny 16-byte chunk size so that Chinese 3-byte sequences span across chunk boundaries
    const store = new RunTraceStore({ dataDirectory: testRoot, chunkSize: 16 });
    const runId = "run-chinese-chunk-16";

    const data = [
      { text: "人工智能测试：中文字符跨越极小读取分块边界。" },
      { text: "第二段验证数据：确保多字节UTF-8不会被截断或破坏。" },
    ];

    await store.append(runId, data[0]);
    await store.append(runId, data[1]);

    const page = await store.readPage(runId, { limit: 10 });
    expect(page.records).toHaveLength(2);
    expect(page.records[0].event).toEqual(data[0]);
    expect(page.records[1].event).toEqual(data[1]);
    expect(JSON.stringify(page.records).includes("\uFFFD")).toBe(false);

    // Range inspection also works seamlessly with tiny chunks
    const range = await store.inspectRange(runId, { traceStart: 0, traceEnd: 1 });
    expect(range).toHaveLength(1);
    expect(range[0].event).toEqual(data[0]);
  });
});

describe("RunTraceStore - Restart and Sequence Safety", () => {
  it("restarts cleanly and continues sequence monotonically without resetting or rewriting", async () => {
    const runId = "run-restart-01";
    const store1 = new RunTraceStore(testRoot);
    await store1.append(runId, { msg: "step 1" });
    await store1.append(runId, { msg: "step 2" });

    // New instance simulates process restart
    const store2 = new RunTraceStore(testRoot);
    const res3 = await store2.append(runId, { msg: "step 3" });
    expect(res3.eventCount).toBe(3);

    const page = await store2.readPage(runId);
    expect(page.records).toHaveLength(3);
    expect(page.records.map((r) => r.seq)).toEqual([1, 2, 3]);
  });

  it("does not do O(N^2) file reads on successive appends in the same instance", async () => {
    const store = new RunTraceStore(testRoot);
    const runId = "run-perf-01";

    const statSpy = vi.spyOn(fs, "stat");
    statSpy.mockClear();

    // First append scans the file to get initial offset/seq
    await store.append(runId, { i: 0 });

    const initialStatCalls = statSpy.mock.calls.length;

    // Subsequent 10 appends should use in-memory offset and seq
    for (let i = 1; i <= 10; i++) {
      await store.append(runId, { i });
    }

    // statSpy should not have been invoked 10 more times for file scanning
    expect(statSpy.mock.calls.length).toBe(initialStatCalls);
    statSpy.mockRestore();
  });
});

describe("RunTraceStore - Cursors and Pagination", () => {
  it("paginates stably with complete record boundary cursors", async () => {
    const store = new RunTraceStore(testRoot);
    const runId = "run-paging-01";

    for (let i = 1; i <= 7; i++) {
      await store.append(runId, { index: i });
    }

    // Page 1 (limit 3)
    const p1 = await store.readPage(runId, { limit: 3 });
    expect(p1.records).toHaveLength(3);
    expect(p1.records.map((r) => r.seq)).toEqual([1, 2, 3]);
    expect(p1.nextCursor).not.toBeNull();

    // Page 2 (limit 3)
    const p2 = await store.readPage(runId, { cursor: p1.nextCursor!, limit: 3 });
    expect(p2.records).toHaveLength(3);
    expect(p2.records.map((r) => r.seq)).toEqual([4, 5, 6]);
    expect(p2.nextCursor).not.toBeNull();

    // Re-reading Page 2 with p1.nextCursor produces identical stable output
    const p2Recheck = await store.readPage(runId, { cursor: p1.nextCursor!, limit: 3 });
    expect(p2Recheck.records).toEqual(p2.records);
    expect(p2Recheck.nextCursor).toBe(p2.nextCursor);

    // Page 3 (limit 3)
    const p3 = await store.readPage(runId, { cursor: p2.nextCursor!, limit: 3 });
    expect(p3.records).toHaveLength(1);
    expect(p3.records[0].seq).toBe(7);
    expect(p3.nextCursor).toBeNull();
  });

  it("prevents cursors from jumping into record, crossing run, or escaping path", async () => {
    const store = new RunTraceStore(testRoot);
    const runA = "run-cursor-a";
    const runB = "run-cursor-b";

    await store.append(runA, { hello: "world" });
    await store.append(runB, { other: "data" });

    const pA = await store.readPage(runA, { limit: 1 });
    const validCursorA = pA.nextCursor;

    // Cross-run attempt
    if (validCursorA) {
      await expect(store.readPage(runB, { cursor: validCursorA })).rejects.toThrow(
        /Cursor cannot cross run/,
      );
    }

    // Malformed cursor
    await expect(store.readPage(runA, { cursor: "not-a-valid-cursor" })).rejects.toBeInstanceOf(
      TraceCursorError,
    );

    // Cursor jumping into record (byteOffset = 5 inside first line)
    const jumpPayload = { r: runA, o: 5, c: 0 };
    const jumpCursor = `gbxtrc_${Buffer.from(JSON.stringify(jumpPayload)).toString("base64url")}`;
    await expect(store.readPage(runA, { cursor: jumpCursor })).rejects.toThrow(
      /complete record boundary/,
    );

    // Cursor exceeding file size
    const outOfBoundsPayload = { r: runA, o: 999999, c: 10 };
    const oobCursor = `gbxtrc_${Buffer.from(JSON.stringify(outOfBoundsPayload)).toString("base64url")}`;
    await expect(store.readPage(runA, { cursor: oobCursor })).rejects.toThrow(/exceeds file size/);
  });
});

describe("RunTraceStore - Interrupted/Truncated Tail Handling", () => {
  it("fails clearly on truncated tail by default and supports complete-prefix retrieval", async () => {
    const store = new RunTraceStore(testRoot);
    const runId = "run-corrupt-01";

    await store.append(runId, { step: 1 });
    await store.append(runId, { step: 2 });

    const filePath = store.getTracePath(runId);
    const originalContent = await fs.readFile(filePath, "utf-8");

    // Simulate power loss / partial write: incomplete JSON without trailing newline
    await fs.appendFile(filePath, '{"seq": 3, "event": {"partial": true');

    // 1. Default readPage fails with honest error
    await expect(store.readPage(runId)).rejects.toBeInstanceOf(TraceTruncatedError);

    // 2. readPage with allowPartialPrefix returns the 2 complete records
    const prefixPage = await store.readPage(runId, { allowPartialPrefix: true });
    expect(prefixPage.records).toHaveLength(2);
    expect(prefixPage.records.map((r) => r.seq)).toEqual([1, 2]);
    expect(prefixPage.nextCursor).toBeNull();

    // 3. File on disk is NEVER rewritten, deleted, or truncated to repair it
    const afterContent = await fs.readFile(filePath, "utf-8");
    expect(afterContent).toBe(originalContent + '{"seq": 3, "event": {"partial": true');

    // 4. Appending to a file with truncated tail fails clearly instead of corrupting data
    const store2 = new RunTraceStore(testRoot);
    await expect(store2.append(runId, { step: 4 })).rejects.toBeInstanceOf(TraceTruncatedError);
  });
});

describe("RunTraceStore - Concurrent Append Serialization", () => {
  it("serializes concurrent appends per run without colliding sequences or corrupted lines", async () => {
    const store = new RunTraceStore(testRoot);
    const runId = "run-concurrent-01";

    const totalEvents = 25;
    const promises = Array.from({ length: totalEvents }, (_, idx) =>
      store.append(runId, { order: idx }),
    );

    const results = await Promise.all(promises);
    expect(results).toHaveLength(totalEvents);

    const seqs = results.map((r) => r.eventCount).sort((a, b) => a - b);
    for (let i = 1; i <= totalEvents; i++) {
      expect(seqs[i - 1]).toBe(i);
    }

    const page = await store.readPage(runId, { limit: 100 });
    expect(page.records).toHaveLength(totalEvents);
    for (let i = 0; i < totalEvents; i++) {
      expect(page.records[i].seq).toBe(i + 1);
    }
  });
});

describe("RunTraceStore - Public Projection Secret Screening", () => {
  it("screens known secrets on public projection only while preserving raw authorized evidence on disk", async () => {
    const store = new RunTraceStore(testRoot);
    const runId = "run-secrets-01";

    const rawSecretEvent = {
      apiKey: "sk-ant-api03-abcdef12345678901234567890",
      botToken: "123456:ABCdefGHIjklMNOpqrSTUvwxYZ1234567890",
      normal: "public text",
    };

    await store.append(runId, rawSecretEvent);

    // 1. Raw file on disk contains full, unredacted authorized evidence
    const filePath = store.getTracePath(runId);
    const rawDisk = await fs.readFile(filePath, "utf-8");
    expect(rawDisk).toContain("sk-ant-api03-abcdef12345678901234567890");
    expect(rawDisk).toContain("123456:ABCdefGHIjklMNOpqrSTUvwxYZ1234567890");

    // 2. Default readPage returns raw authorized evidence
    const unredacted = await store.readPage(runId);
    expect((unredacted.records[0].event as typeof rawSecretEvent).apiKey).toBe(
      "sk-ant-api03-abcdef12345678901234567890",
    );

    // 3. Screened public projection masks secrets
    const screened = await store.readPage(runId, { redactSecrets: true });
    const screenedEvent = screened.records[0].event as Record<string, unknown>;
    expect(screenedEvent.apiKey).toBe("<redacted:key>");
    expect(screenedEvent.botToken).toBe("<redacted:token>");
    expect(screenedEvent.normal).toBe("public text");

    // 4. Raw file on disk is still 100% intact after public projection
    const rawDiskAfter = await fs.readFile(filePath, "utf-8");
    expect(rawDiskAfter).toBe(rawDisk);
  });
});

describe("RunTraceStore - Exact Indexed Range for Eval", () => {
  it("inspects exact indexed range [traceStart, traceEnd) without loading entire trace", async () => {
    const store = new RunTraceStore(testRoot);
    const runId = "run-eval-01";

    for (let i = 0; i < 15; i++) {
      await store.append(runId, { index: i, note: `event-${i}` });
    }

    // Inspect range [4, 7) -> 3 events (index 4, 5, 6 with seq 5, 6, 7)
    const range = await store.inspectRange(runId, { traceStart: 4, traceEnd: 7 });
    expect(range).toHaveLength(3);
    expect(range.map((r) => r.seq)).toEqual([5, 6, 7]);
    expect(range[0].event).toEqual({ index: 4, note: "event-4" });
    expect(range[2].event).toEqual({ index: 6, note: "event-6" });

    // Empty range [3, 3)
    const emptyRange = await store.inspectRange(runId, { traceStart: 3, traceEnd: 3 });
    expect(emptyRange).toEqual([]);

    // Range exceeding available events throws clear error matching Eval contract
    await expect(store.inspectRange(runId, { traceStart: 10, traceEnd: 25 })).rejects.toThrow(
      /exceeds available trace events/,
    );
  });
});

describe("RunTraceStore - Disk Failure Safety", () => {
  it("ensures appending after disk failure is not falsely successful and does not advance state", async () => {
    const store = new RunTraceStore(testRoot);
    const runId = "run-disk-failure-01";

    const res1 = await store.append(runId, { step: 1 });
    expect(res1.eventCount).toBe(1);

    // Simulate disk failure on next write
    const openSpy = vi.spyOn(fs, "open").mockImplementationOnce(async () => {
      throw new Error("EIO: disk write failed");
    });

    await expect(store.append(runId, { step: 2 })).rejects.toThrow("EIO: disk write failed");

    openSpy.mockRestore();

    // Subsequent write succeeds and correctly continues from truthful state (seq 2, not 3)
    const res2 = await store.append(runId, { step: 2, retry: true });
    expect(res2.eventCount).toBe(2);

    const page = await store.readPage(runId);
    expect(page.records).toHaveLength(2);
    expect(page.records.map((r) => r.seq)).toEqual([1, 2]);
  });

  it("invalidates and poisons cached state on write failure with partial bytes", async () => {
    const store = new RunTraceStore(testRoot);
    const runId = "run-poison-01";

    await store.append(runId, { step: 1 });

    // Simulate disk failure leaving partial write on disk
    const filePath = store.getTracePath(runId);
    await fs.appendFile(filePath, '{"partial_corrupt": true');

    // Force open to fail on next append
    const openSpy = vi.spyOn(fs, "open").mockImplementationOnce(async () => {
      throw new Error("EIO: write aborted mid-stream");
    });

    await expect(store.append(runId, { step: 2 })).rejects.toThrow("EIO: write aborted mid-stream");
    openSpy.mockRestore();

    // The store's cached state must be deleted/poisoned; next append scans file,
    // detects the truncated tail (missing newline), and refuses to append onto corrupted data
    await expect(store.append(runId, { step: 2, retry: true })).rejects.toBeInstanceOf(
      TraceTruncatedError,
    );
  });
});

describe("RunTraceStore - Envelope and Sequence Integrity", () => {
  it("rejects non-consecutive sequences and invalid envelope fields", async () => {
    const store = new RunTraceStore(testRoot);
    const runId = "run-seq-integrity-01";

    const filePath = store.getTracePath(runId);
    await fs.mkdir(path.dirname(filePath), { recursive: true });

    // 1. First record has seq: 2 instead of seq: 1
    const invalidSeq1 =
      JSON.stringify({ seq: 2, ts: new Date().toISOString(), event: {}, provenance: "test" }) +
      "\n";
    await fs.writeFile(filePath, invalidSeq1);

    await expect(store.readPage(runId)).rejects.toBeInstanceOf(TraceCorruptedError);

    // 2. AllowPartialPrefix returns empty prefix when first record is corrupt
    const prefix = await store.readPage(runId, { allowPartialPrefix: true });
    expect(prefix.records).toEqual([]);

    // 3. Gap in sequence: seq 1 followed by seq 3
    const gapRecords =
      JSON.stringify({ seq: 1, ts: new Date().toISOString(), event: {}, provenance: "test" }) +
      "\n" +
      JSON.stringify({ seq: 3, ts: new Date().toISOString(), event: {}, provenance: "test" }) +
      "\n";
    await fs.writeFile(filePath, gapRecords);

    await expect(store.readPage(runId)).rejects.toThrow(/Non-consecutive trace sequence/);

    const prefixGap = await store.readPage(runId, { allowPartialPrefix: true });
    expect(prefixGap.records).toHaveLength(1);
    expect(prefixGap.records[0].seq).toBe(1);

    // 4. Missing envelope fields (missing 'provenance')
    const missingField = JSON.stringify({ seq: 1, ts: new Date().toISOString(), event: {} }) + "\n";
    await fs.writeFile(filePath, missingField);

    await expect(store.readPage(runId)).rejects.toThrow(/missing or invalid 'provenance'/);
  });
});

describe("RunTraceStore - Memory and Payload Bounds", () => {
  it("validates constructor limits as positive safe integers", () => {
    expect(() => new RunTraceStore({ dataDirectory: testRoot, maxEventBytes: -1 })).toThrow(
      /positive safe integer/,
    );
    expect(() => new RunTraceStore({ dataDirectory: testRoot, maxLineBytes: NaN })).toThrow(
      /positive safe integer/,
    );
    expect(() => new RunTraceStore({ dataDirectory: testRoot, maxPageBytes: 0 })).toThrow(
      /positive safe integer/,
    );
    expect(() => new RunTraceStore({ dataDirectory: testRoot, chunkSize: 1.5 })).toThrow(
      /positive safe integer/,
    );
  });

  it("bounds line bytes and halts reading on unterminated huge line", async () => {
    const store = new RunTraceStore({ dataDirectory: testRoot, maxLineBytes: 256 });
    const runId = "run-huge-line-01";

    const filePath = store.getTracePath(runId);
    await fs.mkdir(path.dirname(filePath), { recursive: true });

    // Unterminated line of 512 bytes
    await fs.writeFile(filePath, "a".repeat(512));

    await expect(store.readPage(runId)).rejects.toThrow(/exceeds maximum line limit/);
  });

  it("bounds page payload bytes in readPage", async () => {
    const store = new RunTraceStore({ dataDirectory: testRoot, maxPageBytes: 500 });
    const runId = "run-page-bytes-01";

    // Each event is ~150 bytes
    for (let i = 1; i <= 5; i++) {
      await store.append(runId, { payload: "x".repeat(80), index: i });
    }

    // Each event is ~187 bytes, maxPageBytes is 500, so each page holds at most 2 records
    const page1 = await store.readPage(runId, { limit: 5 });
    expect(page1.records).toHaveLength(2);
    expect(page1.nextCursor).not.toBeNull();

    const page2 = await store.readPage(runId, { cursor: page1.nextCursor!, limit: 5 });
    expect(page2.records).toHaveLength(2);
    expect(page2.nextCursor).not.toBeNull();

    const page3 = await store.readPage(runId, { cursor: page2.nextCursor!, limit: 5 });
    expect(page3.records).toHaveLength(1);
    expect(page3.nextCursor).toBeNull();

    const total = [...page1.records, ...page2.records, ...page3.records];
    expect(total).toHaveLength(5);
    expect(total.map((r) => r.seq)).toEqual([1, 2, 3, 4, 5]);
  });
});

describe("RunTraceStore - Fabricated Cursors and Strict Validation", () => {
  it("rejects cursor with fabricated eventCount", async () => {
    const store = new RunTraceStore(testRoot);
    const runId = "run-cursor-forgery-01";

    await store.append(runId, { step: 1 });
    await store.append(runId, { step: 2 });

    // Cursor at byteOffset 0 with fabricated eventCount 99 (expecting seq 100, but file has seq 1)
    const forgedCursor = `gbxtrc_${Buffer.from(JSON.stringify({ r: runId, o: 0, c: 99 })).toString("base64url")}`;
    await expect(store.readPage(runId, { cursor: forgedCursor })).rejects.toBeInstanceOf(
      TraceCursorError,
    );
  });

  it("rejects cursor with fabricated eventCount at EOF", async () => {
    const store = new RunTraceStore(testRoot);
    const runId = "run-cursor-eof-01";

    const res = await store.append(runId, { step: 1 });
    const stat = await fs.stat(store.getTracePath(runId));

    // Cursor at EOF with fabricated eventCount 50 instead of 1
    const forgedEofCursor = `gbxtrc_${Buffer.from(JSON.stringify({ r: runId, o: stat.size, c: 50 })).toString("base64url")}`;
    await expect(store.readPage(runId, { cursor: forgedEofCursor })).rejects.toThrow(
      /cursor eventCount 50 does not match total file event count 1/,
    );

    // Valid cursor at EOF succeeds
    const validEofCursor = `gbxtrc_${Buffer.from(JSON.stringify({ r: runId, o: stat.size, c: res.eventCount })).toString("base64url")}`;
    const eofPage = await store.readPage(runId, { cursor: validEofCursor });
    expect(eofPage.records).toEqual([]);
    expect(eofPage.nextCursor).toBeNull();
  });

  it("rejects invalid page limits without silent coercion", async () => {
    const store = new RunTraceStore(testRoot);
    const runId = "run-limit-validation-01";

    await store.append(runId, { step: 1 });

    const badLimits = [NaN, 0, -1, 1.5, Infinity, 1001];
    for (const badLimit of badLimits) {
      await expect(store.readPage(runId, { limit: badLimit })).rejects.toThrow(/Invalid limit/);
    }
  });

  it("rejects oversized cursor token before base64 decoding", async () => {
    const store = new RunTraceStore(testRoot);
    const hugeCursor = "gbxtrc_" + "A".repeat(1500);
    await expect(store.readPage("run-01", { cursor: hugeCursor })).rejects.toBeInstanceOf(
      TraceCursorError,
    );
  });
});

describe("RunTraceStore - Lock Cleanup and Run Cache Eviction", () => {
  it("cleans up appendLocks map after concurrent appends with zero memory leaks", async () => {
    const store = new RunTraceStore(testRoot);
    const runId = "run-leak-check-01";

    const promises = Array.from({ length: 15 }, (_, i) => store.append(runId, { index: i }));
    await Promise.all(promises);

    // Internal lock map must be completely clean (size 0)
    expect((store as unknown as { appendLocks: Map<string, unknown> }).appendLocks.size).toBe(0);
  });

  it("supports releaseRun and evicts LRU run states safely", async () => {
    const store = new RunTraceStore({ dataDirectory: testRoot, maxCachedRuns: 2 });

    await store.append("run-a", { a: 1 });
    await store.append("run-b", { b: 1 });
    await store.append("run-c", { c: 1 });

    const internalStates = (store as unknown as { runStates: Map<string, unknown> }).runStates;
    expect(internalStates.size).toBeLessThanOrEqual(2);

    // Explicit releaseRun
    store.releaseRun("run-c");
    expect(internalStates.has("run-c")).toBe(false);

    // Reopening an evicted run works correctly without corrupting sequence
    const nextA = await store.append("run-a", { a: 2 });
    expect(nextA.eventCount).toBe(2);
  });
});

describe("RunTraceStore - Symlink and Junction Protection", () => {
  it("rejects directory junctions that escape dataDirectory", async () => {
    const store = new RunTraceStore(testRoot);
    const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), "glassbox-outside-"));

    const runsDir = path.join(testRoot, "runs");
    await fs.mkdir(runsDir, { recursive: true });

    const junctionPath = path.join(runsDir, "escaped-run");

    try {
      // Create junction pointing outside testRoot
      await fs.symlink(outsideDir, junctionPath, "junction");

      await expect(store.append("escaped-run", { test: 1 })).rejects.toThrow(
        /Security violation.*resolves outside dataDirectory via symlink\/junction/,
      );

      await expect(store.readPage("escaped-run")).rejects.toThrow(
        /Security violation.*resolves outside dataDirectory via symlink\/junction/,
      );
    } finally {
      try {
        await fs.unlink(junctionPath);
      } catch {
        // ignore
      }
      await fs.rm(outsideDir, { recursive: true, force: true });
    }
  });
});
