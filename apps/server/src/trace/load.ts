// apps/server/src/trace/load.ts
// Reads a decoded Codex event trace back from the per-session JSONL file.
// Returns entries in file order (which IS chronological since the store appends).
// This loader NEVER reads Canvas layout files — it is pure trace reconstruction.

import { readFileSync } from "node:fs";
import { getTracePath } from "./store.js";
import type { TraceEntry } from "./store.js";

/**
 * Load a Raw Trace for a session.
 *
 * @param sessionId - the session identifier
 * @returns ordered list of trace entries
 * @throws if the trace file does not exist (caller decides how to handle)
 */
export function loadTrace(sessionId: string): TraceEntry[] {
  const path = getTracePath(sessionId);
  const content = readFileSync(path, "utf-8");
  const lines = content.split("\n").filter((l) => l.trim().length > 0);

  const entries: TraceEntry[] = [];
  for (const line of lines) {
    entries.push(JSON.parse(line) as TraceEntry);
  }
  return entries;
}
