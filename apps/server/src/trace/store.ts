// apps/server/src/trace/store.ts
// RawTraceStore: append-only JSONL writer for decoded Codex events.
// Each event is written as one JSON line with seq + timestamp + provenance.
// Never overwrites or deletes existing lines.

import {
  mkdirSync,
  readFileSync,
  appendFileSync,
  statSync,
  openSync,
  readSync,
  closeSync,
  fsyncSync,
  realpathSync,
  existsSync,
} from "node:fs";
import path from "node:path";
import { getGlassboxDataDir } from "../platform/paths.js";
import {
  assertSafeIdentifier,
  validateTraceEnvelope,
  RunTraceStore,
  TraceTruncatedError,
  TraceCorruptedError,
  TraceCursorError,
  TraceEventTooLargeError,
  type TraceCursor,
  type TracePage,
  type AppendResult,
  type ReadPageOptions,
  type InspectRangeOptions,
  type RunTraceStoreOptions,
} from "./run-store.js";

export const TRACE_PROVENANCE = "codex-app-server";
export const TRACE_PROVENANCE_CLAUDECODE = "claude-code-cli";

export interface TraceEntry<T = unknown> {
  seq: number;
  ts: string;
  event: T;
  provenance: string;
}

export function getGlassboxBase(): string {
  return getGlassboxDataDir();
}

/**
 * Resolves and validates the trace file path for a session.
 * Guarantees lexical and symlink/junction path safety against directory escapes.
 */
export function getTracePath(sessionId: string): string {
  assertSafeIdentifier(sessionId, "sessionId");
  const base = path.resolve(getGlassboxBase());
  const sessionsBase = path.resolve(base, "sessions");
  const resolved = path.resolve(sessionsBase, sessionId, "trace.jsonl");
  if (!resolved.startsWith(sessionsBase + path.sep)) {
    throw new Error("Invalid sessionId: path escapes data directory");
  }

  // Verify that ancestors or existing file do not escape via symlink/junction
  if (existsSync(base)) {
    let realBase: string;
    try {
      realBase = path.resolve(realpathSync(base));
    } catch {
      realBase = base;
    }

    const runDir = path.dirname(resolved);
    let checkDir = runDir;
    while (!existsSync(checkDir)) {
      const parent = path.dirname(checkDir);
      if (parent === checkDir) break;
      checkDir = parent;
    }

    let realCheck: string;
    try {
      realCheck = path.resolve(realpathSync(checkDir));
    } catch {
      realCheck = path.resolve(checkDir);
    }

    const normBase = process.platform === "win32" ? realBase.toLowerCase() : realBase;
    const normCheck = process.platform === "win32" ? realCheck.toLowerCase() : realCheck;
    if (normCheck !== normBase && !normCheck.startsWith(normBase + path.sep)) {
      throw new Error(
        "Security violation: path resolves outside data directory via symlink/junction",
      );
    }

    if (existsSync(resolved)) {
      let realFile: string;
      try {
        realFile = path.resolve(realpathSync(resolved));
      } catch {
        realFile = resolved;
      }
      const normFile = process.platform === "win32" ? realFile.toLowerCase() : realFile;
      if (!normFile.startsWith(normBase + path.sep)) {
        throw new Error(
          "Security violation: trace file resolves outside data directory via symlink/junction",
        );
      }
    }
  }

  return resolved;
}

export class RawTraceStore {
  // In-memory sequence cache to avoid O(N^2) full-history reads on every append
  private readonly sessionSeqs = new Map<string, number>();

  private ensureDir(sessionId: string): void {
    assertSafeIdentifier(sessionId, "sessionId");
    const targetPath = getTracePath(sessionId);
    mkdirSync(path.dirname(targetPath), { recursive: true });
  }

  /**
   * Discovers the next sequence number for a session.
   * Scans existing file on initial access; fails clearly on truncated/malformed tail
   * or non-consecutive sequence, rather than silently resetting sequence to 1 or corrupting evidence.
   */
  private nextSeq(sessionId: string): number {
    const cached = this.sessionSeqs.get(sessionId);
    if (cached !== undefined) {
      const next = cached + 1;
      this.sessionSeqs.set(sessionId, next);
      return next;
    }

    const targetPath = getTracePath(sessionId);
    let stat;
    try {
      stat = statSync(targetPath);
    } catch {
      // File does not exist yet
      this.sessionSeqs.set(sessionId, 1);
      return 1;
    }

    if (stat.size === 0) {
      this.sessionSeqs.set(sessionId, 1);
      return 1;
    }

    // Verify trailing newline to prevent appending onto an incomplete line
    const fd = openSync(targetPath, "r");
    try {
      const checkBuf = Buffer.alloc(1);
      readSync(fd, checkBuf, 0, 1, stat.size - 1);
      if (checkBuf[0] !== 0x0a) {
        throw new TraceTruncatedError(
          `Cannot append to session '${sessionId}': trace file has truncated tail (missing trailing newline)`,
          sessionId,
          stat.size,
        );
      }
    } finally {
      closeSync(fd);
    }

    // Read and validate all lines to verify strictly consecutive sequence
    const content = readFileSync(targetPath, "utf-8");
    const lines = content.split("\n").filter((l) => l.trim().length > 0);
    if (lines.length === 0) {
      this.sessionSeqs.set(sessionId, 1);
      return 1;
    }

    let expectedSeq = 1;
    for (let i = 0; i < lines.length; i++) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(lines[i]);
      } catch {
        throw new TraceCorruptedError(
          `Cannot append to session '${sessionId}': existing trace contains malformed JSON at line ${i + 1}`,
          sessionId,
        );
      }
      validateTraceEnvelope(parsed, expectedSeq, sessionId, i);
      expectedSeq++;
    }

    this.sessionSeqs.set(sessionId, expectedSeq);
    return expectedSeq;
  }

  append(sessionId: string, event: unknown, provenance: string = TRACE_PROVENANCE): void {
    this.ensureDir(sessionId);
    const targetPath = getTracePath(sessionId);
    const seq = this.nextSeq(sessionId);
    const entry: TraceEntry<typeof event> = {
      seq,
      ts: new Date().toISOString(),
      event,
      provenance,
    };
    const line = JSON.stringify(entry) + "\n";

    let fd: number | null = null;
    try {
      fd = openSync(targetPath, "a");
      appendFileSync(fd, line, "utf-8");
      fsyncSync(fd);
    } catch (err: unknown) {
      // Invalidate / poison optimistic cache on failed write
      this.sessionSeqs.delete(sessionId);
      throw err;
    } finally {
      if (fd !== null) {
        closeSync(fd);
      }
    }
  }
}

// Re-export RunTraceStore and associated types/errors for single-entry import
export {
  assertSafeIdentifier,
  validateTraceEnvelope,
  RunTraceStore,
  TraceTruncatedError,
  TraceCorruptedError,
  TraceCursorError,
  TraceEventTooLargeError,
  type TraceCursor,
  type TracePage,
  type AppendResult,
  type ReadPageOptions,
  type InspectRangeOptions,
  type RunTraceStoreOptions,
};
