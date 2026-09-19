// apps/server/src/trace/load.ts
// Reads a decoded Codex event trace back from the per-session JSONL file.
// Returns entries in file order (which IS chronological since the store appends).
// This loader NEVER reads Canvas layout files — it is pure trace reconstruction.

import { readFileSync } from "node:fs";
import { getTracePath, assertSafeIdentifier, validateTraceEnvelope } from "./store.js";
import type { TraceEntry } from "./store.js";

export interface LoadTraceOptions {
  allowPartialPrefix?: boolean;
}

/**
 * Load a Raw Trace for a session.
 *
 * @param sessionId - the session identifier
 * @param options - optional configuration (e.g. allowPartialPrefix)
 * @returns ordered list of valid trace entries with strictly consecutive sequences
 * @throws if the trace file does not exist, contains malformed lines, or has non-consecutive sequences
 */
export function loadTrace(sessionId: string, options: LoadTraceOptions = {}): TraceEntry[] {
  assertSafeIdentifier(sessionId, "sessionId");
  const path = getTracePath(sessionId);
  const content = readFileSync(path, "utf-8");
  const lines = content.split("\n");

  const entries: TraceEntry[] = [];
  let expectedSeq = 1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim().length === 0) continue;

    try {
      const parsed = JSON.parse(line) as unknown;
      const validEntry = validateTraceEnvelope(parsed, expectedSeq, sessionId, i);
      entries.push(validEntry);
      expectedSeq++;
    } catch (err: unknown) {
      if (options.allowPartialPrefix) {
        // Stop at the corrupted/truncated record and return complete valid prefix
        break;
      }
      throw new Error(
        `Failed to parse trace entry for session '${sessionId}' at line ${i + 1}: ${(err as Error).message}`,
      );
    }
  }
  return entries;
}
