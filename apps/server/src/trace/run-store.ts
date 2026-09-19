// apps/server/src/trace/run-store.ts
// RunTraceStore: Dedicated append-only JSONL trace store for Personal Agent runs.
//
// Key invariants:
// 1. Raw trace files on disk are immutable evidence; never deleted, truncated, or rewritten.
// 2. Safe identifier and symlink/junction validation guarantee no data directory escapes.
// 3. Per-file serialization guarantees atomic sequential appends without race conditions.
// 4. Memory is bounded: per-line size, per-page payload, and active run cache eviction.
// 5. Envelope integrity and strictly consecutive sequence numbers (1, 2, 3...) are enforced.
// 6. Failed writes invalidate cached state; successful writes are fsynced before cursor advance.
// 7. Cursor offsets represent complete record boundaries; cursors cannot cross runs or jump inside records.
// 8. Secret screening applies only to public projection copies, preserving raw evidence on disk.

import { promises as fs } from "node:fs";
import path from "node:path";
import { TRACE_PROVENANCE, type TraceEntry } from "./store.js";
import { redactTraceEntry } from "./redact.js";

export class TraceTruncatedError extends Error {
  constructor(
    message: string,
    public readonly runId?: string,
    public readonly byteOffset?: number,
  ) {
    super(message);
    this.name = "TraceTruncatedError";
  }
}

export class TraceCorruptedError extends Error {
  constructor(
    message: string,
    public readonly runId?: string,
    public readonly byteOffset?: number,
  ) {
    super(message);
    this.name = "TraceCorruptedError";
  }
}

export class TraceCursorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TraceCursorError";
  }
}

export class TraceEventTooLargeError extends Error {
  constructor(
    message: string,
    public readonly byteLength: number,
    public readonly limit: number,
  ) {
    super(message);
    this.name = "TraceEventTooLargeError";
  }
}

export interface TraceCursor {
  runId: string;
  traceRef: string;
  byteOffset: number;
  eventCount: number;
}

export interface AppendResult {
  runId: string;
  traceRef: string;
  byteOffset: number;
  eventCount: number;
}

export interface TracePage<T = unknown> {
  records: TraceEntry<T>[];
  items: TraceEntry<T>[];
  nextCursor: string | null;
}

export interface ReadPageOptions {
  cursor?: string;
  limit?: number;
  allowPartialPrefix?: boolean;
  redactSecrets?: boolean;
}

export interface InspectRangeOptions {
  traceStart: number;
  traceEnd: number;
  redactSecrets?: boolean;
}

export interface RunTraceStoreOptions {
  dataDirectory: string;
  maxEventBytes?: number;
  maxLineBytes?: number;
  maxPageBytes?: number;
  chunkSize?: number;
  maxCachedRuns?: number;
}

interface DecodedCursor {
  r: string; // runId
  o: number; // byteOffset
  c: number; // eventCount
}

const SAFE_ID_REGEX = /^[a-zA-Z0-9_-]+([.][a-zA-Z0-9_-]+)*$/u;
const WINDOWS_RESERVED_REGEX = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/i;

/** Validate identifier for strict filesystem path safety. */
export function assertSafeIdentifier(id: unknown, label = "identifier"): asserts id is string {
  if (typeof id !== "string" || id.length === 0 || id.length > 128) {
    throw new Error(`Invalid ${label}: must be a non-empty string of at most 128 characters`);
  }
  if (!SAFE_ID_REGEX.test(id) || WINDOWS_RESERVED_REGEX.test(id)) {
    throw new Error(`Invalid ${label}: contains illegal characters or reserved name`);
  }
}

/** Validate positive safe integer option. */
function validatePositiveSafeInteger(val: unknown, name: string): number {
  if (typeof val !== "number" || !Number.isSafeInteger(val) || val <= 0) {
    throw new Error(`Invalid option '${name}': must be a positive safe integer`);
  }
  return val;
}

const CURSOR_PREFIX = "gbxtrc_";

function encodeCursor(runId: string, byteOffset: number, eventCount: number): string {
  const payload: DecodedCursor = { r: runId, o: byteOffset, c: eventCount };
  return `${CURSOR_PREFIX}${Buffer.from(JSON.stringify(payload)).toString("base64url")}`;
}

function decodeCursor(cursor: string): DecodedCursor {
  if (typeof cursor !== "string" || cursor.length === 0 || cursor.length > 1024) {
    throw new TraceCursorError("Invalid trace cursor: malformed cursor token");
  }
  if (!cursor.startsWith(CURSOR_PREFIX)) {
    throw new TraceCursorError("Invalid trace cursor: malformed cursor token");
  }
  const raw = cursor.slice(CURSOR_PREFIX.length);
  if (raw.length === 0 || raw.length > 1024) {
    throw new TraceCursorError("Invalid trace cursor: cursor payload exceeds length limit");
  }

  try {
    const json = Buffer.from(raw, "base64url").toString("utf-8");
    const parsed = JSON.parse(json) as DecodedCursor;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      typeof parsed.r !== "string" ||
      typeof parsed.o !== "number" ||
      typeof parsed.c !== "number" ||
      !Number.isSafeInteger(parsed.o) ||
      parsed.o < 0 ||
      !Number.isSafeInteger(parsed.c) ||
      parsed.c < 0
    ) {
      throw new Error("schema mismatch");
    }
    return parsed;
  } catch (err: unknown) {
    if (err instanceof TraceCursorError) throw err;
    throw new TraceCursorError("Invalid trace cursor: failed to decode cursor payload");
  }
}

/**
 * Validates a parsed JSON object against the TraceEntry envelope specification
 * and asserts strictly consecutive positive sequence numbering.
 */
export function validateTraceEnvelope<T = unknown>(
  obj: unknown,
  expectedSeq: number,
  runId?: string,
  offset?: number,
): TraceEntry<T> {
  if (typeof obj !== "object" || obj === null || Array.isArray(obj)) {
    throw new TraceCorruptedError(
      `Invalid trace record envelope at byte offset ${offset ?? "?"}: record is not a JSON object`,
      runId,
      offset,
    );
  }

  const record = obj as Record<string, unknown>;

  if (typeof record.seq !== "number" || !Number.isSafeInteger(record.seq) || record.seq <= 0) {
    throw new TraceCorruptedError(
      `Invalid trace record envelope at byte offset ${offset ?? "?"}: missing or invalid 'seq'`,
      runId,
      offset,
    );
  }

  if (record.seq !== expectedSeq) {
    throw new TraceCorruptedError(
      `Non-consecutive trace sequence in run '${runId ?? "?"}': expected seq ${expectedSeq}, got ${record.seq}`,
      runId,
      offset,
    );
  }

  if (typeof record.ts !== "string" || record.ts.length === 0) {
    throw new TraceCorruptedError(
      `Invalid trace record envelope at byte offset ${offset ?? "?"}: missing or invalid 'ts'`,
      runId,
      offset,
    );
  }

  if (!("event" in record) || record.event === undefined) {
    throw new TraceCorruptedError(
      `Invalid trace record envelope at byte offset ${offset ?? "?"}: missing 'event' field`,
      runId,
      offset,
    );
  }

  if (typeof record.provenance !== "string" || record.provenance.length === 0) {
    throw new TraceCorruptedError(
      `Invalid trace record envelope at byte offset ${offset ?? "?"}: missing or invalid 'provenance'`,
      runId,
      offset,
    );
  }

  return record as unknown as TraceEntry<T>;
}

interface RunStreamState {
  byteOffset: number;
  eventCount: number;
}

export class RunTraceStore {
  readonly dataDirectory: string;
  readonly maxEventBytes: number;
  readonly maxLineBytes: number;
  readonly maxPageBytes: number;
  readonly chunkSize: number;
  readonly maxCachedRuns: number;

  private readonly appendLocks = new Map<string, Promise<void>>();
  private readonly runStates = new Map<string, RunStreamState>();

  constructor(options: string | RunTraceStoreOptions) {
    const dataDir = typeof options === "string" ? options : options.dataDirectory;
    if (typeof dataDir !== "string" || dataDir.trim().length === 0) {
      throw new Error("dataDirectory must be a non-empty string");
    }
    if (!path.isAbsolute(dataDir)) {
      throw new Error("dataDirectory must be an absolute path");
    }
    this.dataDirectory = path.resolve(dataDir);

    const isOptObj = typeof options === "object" && options !== null;
    this.maxEventBytes =
      isOptObj && options.maxEventBytes !== undefined
        ? validatePositiveSafeInteger(options.maxEventBytes, "maxEventBytes")
        : 1024 * 1024;
    this.maxLineBytes =
      isOptObj && options.maxLineBytes !== undefined
        ? validatePositiveSafeInteger(options.maxLineBytes, "maxLineBytes")
        : Math.max(this.maxEventBytes * 2, 2 * 1024 * 1024);
    this.maxPageBytes =
      isOptObj && options.maxPageBytes !== undefined
        ? validatePositiveSafeInteger(options.maxPageBytes, "maxPageBytes")
        : 4 * 1024 * 1024;
    this.chunkSize =
      isOptObj && options.chunkSize !== undefined
        ? validatePositiveSafeInteger(options.chunkSize, "chunkSize")
        : 64 * 1024;
    this.maxCachedRuns =
      isOptObj && options.maxCachedRuns !== undefined
        ? validatePositiveSafeInteger(options.maxCachedRuns, "maxCachedRuns")
        : 500;
  }

  /** Resolves and validates the absolute path to the trace file for a run. */
  getTracePath(runId: string): string {
    assertSafeIdentifier(runId, "runId");
    const runsBase = path.resolve(this.dataDirectory, "runs");
    const resolved = path.resolve(runsBase, runId, "trace.jsonl");
    if (!resolved.startsWith(runsBase + path.sep)) {
      throw new Error("Invalid runId: path escapes data directory");
    }
    return resolved;
  }

  /**
   * Verifies that the resolved path and its existing directories do not escape
   * the dataDirectory via symbolic links or directory junctions.
   */
  private async verifyPathSafety(runId: string, filePath: string): Promise<void> {
    assertSafeIdentifier(runId, "runId");

    let realDataDir: string;
    try {
      realDataDir = path.resolve(await fs.realpath(this.dataDirectory));
    } catch {
      realDataDir = path.resolve(this.dataDirectory);
    }

    const runDir = path.dirname(filePath);

    // Find deepest existing ancestor of runDir
    let current = runDir;
    while (true) {
      try {
        await fs.access(current);
        break;
      } catch {
        const parent = path.dirname(current);
        if (parent === current) break;
        current = parent;
      }
    }

    let realAncestor: string;
    try {
      realAncestor = path.resolve(await fs.realpath(current));
    } catch {
      realAncestor = path.resolve(current);
    }

    const normDataDir = process.platform === "win32" ? realDataDir.toLowerCase() : realDataDir;
    const normAncestor = process.platform === "win32" ? realAncestor.toLowerCase() : realAncestor;

    if (normAncestor !== normDataDir && !normAncestor.startsWith(normDataDir + path.sep)) {
      throw new Error(
        `Security violation: path for run '${runId}' resolves outside dataDirectory via symlink/junction`,
      );
    }

    // If filePath already exists, verify its realpath directly
    try {
      await fs.access(filePath);
      const realFile = path.resolve(await fs.realpath(filePath));
      const normFile = process.platform === "win32" ? realFile.toLowerCase() : realFile;
      if (!normFile.startsWith(normDataDir + path.sep)) {
        throw new Error(
          `Security violation: trace file for run '${runId}' resolves outside dataDirectory via symlink/junction`,
        );
      }
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        throw err;
      }
    }
  }

  /**
   * Serializes async execution per runId to prevent concurrent file corruption.
   * Releases lock correctly and deletes completed map entries without memory leaks.
   */
  private async withLock<T>(runId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.appendLocks.get(runId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const lockPromise = prev.catch(() => {}).then(() => current);
    this.appendLocks.set(runId, lockPromise);

    try {
      await prev.catch(() => {});
      return await fn();
    } finally {
      release();
      if (this.appendLocks.get(runId) === lockPromise) {
        this.appendLocks.delete(runId);
      }
    }
  }

  /** Explicitly releases cached in-memory state for a run, allowing safe reopening. */
  releaseRun(runId: string): void {
    assertSafeIdentifier(runId, "runId");
    this.runStates.delete(runId);
  }

  /** Stores run state with bounded LRU eviction. */
  private recordRunState(runId: string, state: RunStreamState): void {
    if (this.runStates.size >= this.maxCachedRuns && !this.runStates.has(runId)) {
      const oldestKey = this.runStates.keys().next().value;
      if (oldestKey) {
        this.runStates.delete(oldestKey);
      }
    }
    this.runStates.set(runId, state);
  }

  /**
   * Initializes in-memory state on first append for a runId by scanning existing file.
   * Fails clearly on truncated or malformed trace; never resets sequence silently.
   */
  private async getOrInitState(runId: string, filePath: string): Promise<RunStreamState> {
    const existing = this.runStates.get(runId);
    if (existing) return existing;

    try {
      const stat = await fs.stat(filePath);
      if (stat.size === 0) {
        const state: RunStreamState = { byteOffset: 0, eventCount: 0 };
        this.recordRunState(runId, state);
        return state;
      }

      // Check that file ends with newline
      const handle = await fs.open(filePath, "r");
      try {
        const lastByteBuf = Buffer.alloc(1);
        await handle.read(lastByteBuf, 0, 1, stat.size - 1);
        if (lastByteBuf[0] !== 0x0a) {
          throw new TraceTruncatedError(
            `Cannot append to run '${runId}': trace file has truncated tail (missing trailing newline at offset ${stat.size})`,
            runId,
            stat.size,
          );
        }
      } finally {
        await handle.close();
      }

      // Scan file records to determine exact count and strictly consecutive sequence
      const { count } = await this.scanFileIntegrity(runId, filePath, stat.size);
      const state: RunStreamState = { byteOffset: stat.size, eventCount: count };
      this.recordRunState(runId, state);
      return state;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        const state: RunStreamState = { byteOffset: 0, eventCount: 0 };
        this.recordRunState(runId, state);
        return state;
      }
      throw err;
    }
  }

  /** Scans an existing file to count records and verify integrity without loading whole file into memory. */
  private async scanFileIntegrity(
    runId: string,
    filePath: string,
    fileSize: number,
  ): Promise<{ count: number }> {
    const handle = await fs.open(filePath, "r");
    try {
      const chunkSize = this.chunkSize;
      const buf = Buffer.alloc(chunkSize);
      let offset = 0;
      let remainder = Buffer.alloc(0);
      let count = 0;
      let currentOffset = 0;

      while (offset < fileSize) {
        const toRead = Math.min(chunkSize, fileSize - offset);
        const { bytesRead } = await handle.read(buf, 0, toRead, offset);

        if (bytesRead === 0) {
          if (offset < fileSize) {
            throw new TraceTruncatedError(
              `Unexpected EOF encountered at byte offset ${offset} before expected size ${fileSize}`,
              runId,
              offset,
            );
          }
          break;
        }

        offset += bytesRead;

        const chunk = Buffer.from(buf.subarray(0, bytesRead));
        const data = remainder.length > 0 ? Buffer.concat([remainder, chunk]) : chunk;
        let lastNewline = -1;
        let scanStart = 0;

        while (true) {
          const nl = data.indexOf(0x0a, scanStart);
          if (nl === -1) break;

          const lineBuf = data.subarray(lastNewline === -1 ? 0 : lastNewline + 1, nl);
          const lineByteLength = lineBuf.byteLength + 1; // includes \n
          lastNewline = nl;
          scanStart = nl + 1;

          if (lineBuf.length === 0) {
            currentOffset += lineByteLength;
            continue;
          }

          count++;
          let parsed: unknown;
          try {
            parsed = JSON.parse(lineBuf.toString("utf-8"));
          } catch {
            throw new TraceCorruptedError(
              `Existing trace file for run '${runId}' contains malformed JSON record at line ${count}`,
              runId,
              currentOffset,
            );
          }

          validateTraceEnvelope(parsed, count, runId, currentOffset);
          currentOffset += lineByteLength;
        }

        remainder = Buffer.from(lastNewline === -1 ? data : data.subarray(lastNewline + 1));
        if (remainder.length > this.maxLineBytes) {
          throw new TraceCorruptedError(
            `Trace record in run '${runId}' exceeds maximum line limit of ${this.maxLineBytes} bytes`,
            runId,
            currentOffset,
          );
        }
      }

      if (remainder.length > 0) {
        throw new TraceTruncatedError(
          `Existing trace file for run '${runId}' has incomplete trailing record`,
          runId,
          fileSize - remainder.length,
        );
      }

      return { count };
    } finally {
      await handle.close();
    }
  }

  /**
   * Appends an event to the run trace.
   * Serialized per file, validates envelope and structural limit once,
   * fsyncs to physical disk, and invalidates/poisons in-memory state on any error.
   */
  async append(
    runId: string,
    event: unknown,
    provenance: string = TRACE_PROVENANCE,
  ): Promise<AppendResult> {
    assertSafeIdentifier(runId, "runId");

    if (event === undefined) {
      throw new Error("Event cannot be undefined");
    }
    if (typeof provenance !== "string" || provenance.length === 0) {
      throw new Error("Provenance must be a non-empty string");
    }

    return this.withLock(runId, async () => {
      const filePath = this.getTracePath(runId);
      await this.verifyPathSafety(runId, filePath);

      const state = await this.getOrInitState(runId, filePath);

      const nextSeq = state.eventCount + 1;
      const entry: TraceEntry = {
        seq: nextSeq,
        ts: new Date().toISOString(),
        event,
        provenance,
      };

      let line: string;
      try {
        line = JSON.stringify(entry) + "\n";
      } catch (err: unknown) {
        throw new Error(`Failed to serialize trace entry: ${(err as Error).message}`);
      }

      const lineBuf = Buffer.from(line, "utf-8");
      if (lineBuf.byteLength > this.maxEventBytes) {
        throw new TraceEventTooLargeError(
          `Trace entry envelope size ${lineBuf.byteLength} bytes exceeds structural limit of ${this.maxEventBytes} bytes`,
          lineBuf.byteLength,
          this.maxEventBytes,
        );
      }

      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await this.verifyPathSafety(runId, filePath);

      let handle: fs.FileHandle | null = null;
      try {
        handle = await fs.open(filePath, "a");
        await handle.writeFile(lineBuf);
        await handle.sync(); // Fsync to ensure data is physical on disk before DB cursor advances
      } catch (err: unknown) {
        // Poison / invalidate in-memory cached state on failed write
        this.runStates.delete(runId);
        throw err;
      } finally {
        if (handle) {
          await handle.close();
        }
      }

      // Advance in-memory state only after write and fsync succeed
      state.byteOffset += lineBuf.byteLength;
      state.eventCount += 1;

      return {
        runId,
        traceRef: runId,
        byteOffset: state.byteOffset,
        eventCount: state.eventCount,
      };
    });
  }

  /**
   * Bounded page reading of UTF-8 JSONL trace records.
   * Verifies cursor boundaries, enforces per-run isolation, validates envelope/sequence,
   * bounds line and page payload bytes, and supports secret screening.
   */
  async readPage<T = unknown>(runId: string, options: ReadPageOptions = {}): Promise<TracePage<T>> {
    assertSafeIdentifier(runId, "runId");
    const filePath = this.getTracePath(runId);
    await this.verifyPathSafety(runId, filePath);

    let startOffset = 0;
    let startEventCount = 0;

    if (options.cursor) {
      const decoded = decodeCursor(options.cursor);
      if (decoded.r !== runId) {
        throw new TraceCursorError(
          `Cursor cannot cross run: cursor belongs to run '${decoded.r}', not '${runId}'`,
        );
      }
      startOffset = decoded.o;
      startEventCount = decoded.c;
    }

    let limit = 50;
    if (options.limit !== undefined) {
      if (
        typeof options.limit !== "number" ||
        !Number.isSafeInteger(options.limit) ||
        options.limit <= 0 ||
        options.limit > 1000
      ) {
        throw new Error(
          `Invalid limit: must be a positive integer between 1 and 1000, got ${String(options.limit)}`,
        );
      }
      limit = options.limit;
    }

    let stat;
    try {
      stat = await fs.stat(filePath);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        if (options.cursor && (startOffset !== 0 || startEventCount !== 0)) {
          throw new TraceCursorError("Invalid trace cursor: trace file does not exist");
        }
        return { records: [], items: [], nextCursor: null };
      }
      throw err;
    }

    if (startOffset > stat.size) {
      throw new TraceCursorError(
        `Invalid trace cursor: offset ${startOffset} exceeds file size ${stat.size}`,
      );
    }

    if (startOffset === stat.size) {
      // Validate cursor at EOF: cursor eventCount must match actual total events in file
      const state = await this.getOrInitState(runId, filePath);
      if (startEventCount !== state.eventCount) {
        throw new TraceCursorError(
          `Invalid trace cursor at EOF: cursor eventCount ${startEventCount} does not match total file event count ${state.eventCount}`,
        );
      }
      return { records: [], items: [], nextCursor: null };
    }

    const handle = await fs.open(filePath, "r");
    try {
      // Validate that startOffset is at a record boundary (byte before it must be \n)
      if (startOffset > 0) {
        const boundaryCheckBuf = Buffer.alloc(1);
        await handle.read(boundaryCheckBuf, 0, 1, startOffset - 1);
        if (boundaryCheckBuf[0] !== 0x0a) {
          throw new TraceCursorError(
            `Invalid trace cursor: offset ${startOffset} is not at a complete record boundary`,
          );
        }
      }

      const chunkSize = this.chunkSize;
      const readBuf = Buffer.alloc(chunkSize);
      let filePos = startOffset;
      let remainder = Buffer.alloc(0);
      let currentOffset = startOffset;
      let currentEventCount = startEventCount;
      let expectedSeq = startEventCount + 1;
      let accumulatedPageBytes = 0;
      let pageFull = false;
      const records: TraceEntry<T>[] = [];

      while (filePos < stat.size && !pageFull) {
        const toRead = Math.min(chunkSize, stat.size - filePos);
        const { bytesRead } = await handle.read(readBuf, 0, toRead, filePos);

        if (bytesRead === 0) {
          if (filePos < stat.size) {
            throw new TraceTruncatedError(
              `Unexpected EOF encountered at byte offset ${filePos} before expected size ${stat.size}`,
              runId,
              filePos,
            );
          }
          break;
        }

        filePos += bytesRead;

        const chunk = Buffer.from(readBuf.subarray(0, bytesRead));
        const data = remainder.length > 0 ? Buffer.concat([remainder, chunk]) : chunk;

        let lastNewline = -1;
        let scanStart = 0;

        while (true) {
          if (records.length >= limit) {
            pageFull = true;
            break;
          }

          const nl = data.indexOf(0x0a, scanStart);
          if (nl === -1) break;

          const lineBuf = data.subarray(lastNewline === -1 ? 0 : lastNewline + 1, nl);
          const lineByteLength = lineBuf.byteLength + 1; // includes \n
          if (lineByteLength > this.maxLineBytes)
            throw new TraceCorruptedError(
              "Trace line exceeds the read limit",
              runId,
              currentOffset,
            );

          // Bound page payload bytes
          if (lineByteLength > this.maxPageBytes)
            throw new TraceCorruptedError(
              "Trace line exceeds the page limit",
              runId,
              currentOffset,
            );
          if (records.length > 0 && accumulatedPageBytes + lineByteLength > this.maxPageBytes) {
            pageFull = true;
            break;
          }

          lastNewline = nl;
          scanStart = nl + 1;

          if (lineBuf.length === 0) {
            currentOffset += lineByteLength;
            continue;
          }

          let parsed: unknown;
          try {
            parsed = JSON.parse(lineBuf.toString("utf-8"));
          } catch {
            if (options.allowPartialPrefix) {
              const finalRecords = options.redactSecrets ? records.map(redactTraceEntry) : records;
              return {
                records: finalRecords,
                items: finalRecords,
                nextCursor: null,
              };
            }
            throw new TraceCorruptedError(
              `Malformed JSON record in run '${runId}' at byte offset ${currentOffset}`,
              runId,
              currentOffset,
            );
          }

          let envelope: TraceEntry<T>;
          try {
            envelope = validateTraceEnvelope<T>(parsed, expectedSeq, runId, currentOffset);
          } catch (err: unknown) {
            if (records.length === 0 && options.cursor) {
              const seqFound =
                typeof (parsed as Record<string, unknown>)?.seq === "number"
                  ? String((parsed as Record<string, unknown>).seq)
                  : "?";
              throw new TraceCursorError(
                `Invalid trace cursor: cursor eventCount ${startEventCount} does not match record sequence ${seqFound}`,
              );
            }
            if (options.allowPartialPrefix) {
              const finalRecords = options.redactSecrets ? records.map(redactTraceEntry) : records;
              return {
                records: finalRecords,
                items: finalRecords,
                nextCursor: null,
              };
            }
            throw err;
          }

          records.push(envelope);
          accumulatedPageBytes += lineByteLength;
          currentOffset += lineByteLength;
          currentEventCount += 1;
          expectedSeq += 1;

          if (records.length >= limit) {
            pageFull = true;
            break;
          }
        }

        remainder = Buffer.from(lastNewline === -1 ? data : data.subarray(lastNewline + 1));
        if (remainder.length > this.maxLineBytes) {
          throw new TraceCorruptedError(
            `Trace record in run '${runId}' exceeds maximum line limit of ${this.maxLineBytes} bytes`,
            runId,
            currentOffset,
          );
        }
      }

      let nextCursor: string | null = null;
      if (pageFull) {
        if (currentOffset < stat.size) {
          nextCursor = encodeCursor(runId, currentOffset, currentEventCount);
        }
      } else if (filePos >= stat.size && remainder.length > 0) {
        if (!options.allowPartialPrefix) {
          throw new TraceTruncatedError(
            `Trace tail for run '${runId}' is truncated or incomplete (missing trailing newline)`,
            runId,
            currentOffset,
          );
        }
        nextCursor = null;
      }

      const finalRecords = options.redactSecrets ? records.map(redactTraceEntry) : records;

      return {
        records: finalRecords,
        items: finalRecords,
        nextCursor,
      };
    } finally {
      await handle.close();
    }
  }

  /**
   * Inspects an exact indexed event range [traceStart, traceEnd) for Eval.
   * Stops reading as soon as traceEnd is reached without unbounded file loading.
   */
  async inspectRange<T = unknown>(
    runId: string,
    options: InspectRangeOptions,
  ): Promise<TraceEntry<T>[]> {
    assertSafeIdentifier(runId, "runId");
    const { traceStart, traceEnd, redactSecrets } = options;

    if (
      typeof traceStart !== "number" ||
      typeof traceEnd !== "number" ||
      !Number.isSafeInteger(traceStart) ||
      !Number.isSafeInteger(traceEnd) ||
      traceStart < 0 ||
      traceEnd < traceStart
    ) {
      throw new Error(
        `Invalid trace range: traceStart (${traceStart}) must be >= 0 and traceEnd (${traceEnd}) must be >= traceStart`,
      );
    }

    if (traceStart === traceEnd) {
      return [];
    }

    const filePath = this.getTracePath(runId);
    await this.verifyPathSafety(runId, filePath);

    let stat;
    try {
      stat = await fs.stat(filePath);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error(`Cannot inspect range: trace file for run '${runId}' does not exist`);
      }
      throw err;
    }

    const handle = await fs.open(filePath, "r");
    try {
      const chunkSize = this.chunkSize;
      const readBuf = Buffer.alloc(chunkSize);
      let filePos = 0;
      let remainder = Buffer.alloc(0);
      let eventIndex = 0;
      let expectedSeq = 1;
      let currentOffset = 0;
      const results: TraceEntry<T>[] = [];
      let resultBytes = 0;

      while (filePos < stat.size && eventIndex < traceEnd) {
        const toRead = Math.min(chunkSize, stat.size - filePos);
        const { bytesRead } = await handle.read(readBuf, 0, toRead, filePos);

        if (bytesRead === 0) {
          if (filePos < stat.size) {
            throw new TraceTruncatedError(
              `Unexpected EOF encountered at byte offset ${filePos} before expected size ${stat.size}`,
              runId,
              filePos,
            );
          }
          break;
        }

        filePos += bytesRead;

        const chunk = Buffer.from(readBuf.subarray(0, bytesRead));
        const data = remainder.length > 0 ? Buffer.concat([remainder, chunk]) : chunk;

        let lastNewline = -1;
        let scanStart = 0;

        while (eventIndex < traceEnd) {
          const nl = data.indexOf(0x0a, scanStart);
          if (nl === -1) break;

          const lineBuf = data.subarray(lastNewline === -1 ? 0 : lastNewline + 1, nl);
          const lineByteLength = lineBuf.byteLength + 1;
          if (lineByteLength > this.maxLineBytes)
            throw new TraceCorruptedError(
              "Trace line exceeds the read limit",
              runId,
              currentOffset,
            );
          lastNewline = nl;
          scanStart = nl + 1;

          if (lineBuf.length === 0) {
            currentOffset += lineByteLength;
            continue;
          }

          let parsed: unknown;
          try {
            parsed = JSON.parse(lineBuf.toString("utf-8"));
          } catch {
            throw new TraceCorruptedError(
              `Malformed JSON record in run '${runId}' at byte offset ${currentOffset}`,
              runId,
              currentOffset,
            );
          }

          const envelope = validateTraceEnvelope<T>(parsed, expectedSeq, runId, currentOffset);

          if (eventIndex >= traceStart) {
            resultBytes += lineByteLength;
            if (resultBytes > this.maxPageBytes)
              throw new TraceCorruptedError(
                "Trace range exceeds the read limit",
                runId,
                currentOffset,
              );
            results.push(redactSecrets ? redactTraceEntry(envelope) : envelope);
          }

          eventIndex++;
          expectedSeq++;
          currentOffset += lineByteLength;
        }

        remainder = Buffer.from(lastNewline === -1 ? data : data.subarray(lastNewline + 1));
        if (remainder.length > this.maxLineBytes) {
          throw new TraceCorruptedError(
            `Trace record in run '${runId}' exceeds maximum line limit of ${this.maxLineBytes} bytes`,
            runId,
            currentOffset,
          );
        }
      }

      if (eventIndex < traceEnd) {
        throw new Error(
          `Indexed range [${traceStart}, ${traceEnd}) exceeds available trace events (found ${eventIndex} events)`,
        );
      }

      return results;
    } finally {
      await handle.close();
    }
  }
}
