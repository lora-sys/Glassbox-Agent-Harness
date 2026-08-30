// apps/server/src/state/replay.ts
// Replays a Raw Trace into DerivedState by folding the pure reducer over
// decoded events. Re-running the same trace always produces the same state
// — reconstruction does NOT depend on Canvas layout or any mutable UI state.
//
// Raw Trace stores { method, params } without the _tag discriminator.
// This module reconstructs tagged CodexEvent objects from the raw store format.

import { loadTrace } from "../trace/load.js";
import type { TraceEntry } from "../trace/store.js";
import { reduce } from "./reducer.js";
import { initialDerivedState } from "./types.js";
import type { CodexEvent } from "../codex/schema.js";
import type { DerivedState } from "./types.js";

// ---------------------------------------------------------------------------
// Method → _tag mapping (mirrors METHOD_TAG in codex/schema.ts)
// ---------------------------------------------------------------------------

const METHOD_TO_TAG: Record<string, string> = {
  "thread/started": "threadStarted",
  "turn/started": "turnStarted",
  "item/started": "itemStarted",
  "item/agentMessage/delta": "agentMessageDelta",
  "item/completed": "itemCompleted",
  "turn/completed": "turnCompleted",
  "item/fileChange": "itemFileChange",
  "item/fileChange/requestApproval": "requestApproval",
  "item/commandExecution/requestApproval": "requestApproval",
  "thread/tokenUsage/updated": "tokenUsageUpdated",
  "turn/diff/updated": "turnDiffUpdated",
  "action.pause": "actionPause",
  "action.stop": "actionPause",
  "action.steer": "actionSteer",
  "action.send": "actionSend",
  "action.editInput": "actionEditInput",
  "action.decide": "actionDecide",
};

// ---------------------------------------------------------------------------
// Raw → CodexEvent conversion
// ---------------------------------------------------------------------------

/**
 * Parse a raw trace entry's `{ method, params }` into a CodexEvent.
 *
 * The Raw Trace stores the raw JSON-RPC notification params without the `_tag`
 * discriminator. This function re-adds `_tag` based on the method string and
 * returns a tagged object compatible with the pure reducer.
 *
 * Returns `null` for unrecognized methods — they are counted but not
 * interpreted by the reducer.
 */
function rawToCodexEvent(entry: TraceEntry): CodexEvent | null {
  const event = entry.event as { method: string; params: Record<string, unknown> };
  // Claude Code adapter prefixes inner SDK events with "sdk:" (e.g.
  // "sdk:assistant", "sdk:system"). Strip that prefix before lookup so the
  // same map works for both providers without adding duplicate entries.
  const baseMethod = event.method.startsWith("sdk:")
    ? event.method.slice(4) : event.method;
  const tag = METHOD_TO_TAG[baseMethod];
  if (!tag) return null;

  // Some provider events place turn.id nested under params.turn rather than
  // at params.turnId (the live adapter extracts it from { turn: { id } }).
  // During replay we replicate that extraction so the reducer can match
  // turn/diff/updated and item/fileChange diffs to their turns.
  const p = event.params;
  const inferredTurnId =
    typeof (p as Record<string, unknown>).turnId === "string"
      ? (p as Record<string, unknown>).turnId as string
      : typeof ((p as Record<string, unknown>).turn as Record<string, unknown> | undefined)?.id === "string"
        ? ((p as Record<string, unknown>).turn as Record<string, unknown>).id as string
        : "";

  const reconstructed: Record<string, unknown> = { _tag: tag as CodexEvent["_tag"], ...p };
  if (inferredTurnId) {
    (reconstructed as Record<string, unknown>).turnId = inferredTurnId;
  }

  return reconstructed as CodexEvent;
}

// ---------------------------------------------------------------------------
// Replay functions
// ---------------------------------------------------------------------------

/**
 * Result of a replay operation.
 */
export interface ReplayResult {
  /** The derived state produced by the replay. */
  state: DerivedState;
  /** Total trace entries processed. */
  entryCount: number;
  /** Entries that could not be mapped to a CodexEvent (unrecognized methods). */
  skippedEvents: number;
}

/**
 * Load a stored trace for a session and replay it into DerivedState.
 *
 * Each entry is decoded back to a CodexEvent (the `_tag` discriminator is
 * reconstructed from the method string). Unrecognized methods increment
 * the summary counts but do not produce product-specific state.
 *
 * Deterministic: the same trace always produces the same DerivedState.
 *
 * @param sessionId - the session whose trace to replay
 * @returns ReplayResult with the derived state and stats
 */
export function replayTrace(sessionId: string): ReplayResult {
  let entries: TraceEntry[];
  try {
    entries = loadTrace(sessionId);
  } catch {
    return { state: initialDerivedState(), entryCount: 0, skippedEvents: 0 };
  }

  let state = initialDerivedState();
  let skipped = 0;

  for (const entry of entries) {
    const event = rawToCodexEvent(entry);
    if (!event) {
      skipped++;
      const raw = entry.event as { method: string };
      if (typeof raw === "object" && raw && "method" in raw) {
        const counts = { ...state.traceSummary.eventCounts };
        counts[raw.method as string] = (counts[raw.method as string] ?? 0) + 1;
        state = {
          ...state,
          traceSummary: {
            ...state.traceSummary,
            eventCounts: counts,
            totalEvents: state.traceSummary.totalEvents + 1,
          },
        };
      }
      continue;
    }
    state = reduce(state, event);
  }

  return { state, entryCount: entries.length, skippedEvents: skipped };
}

/**
 * Replay a pre-loaded list of TraceEntry objects (used in tests).
 *
 * Pure function: same input always yields same output, no file I/O.
 */
export function replayEntries(entries: TraceEntry[]): DerivedState {
  let state = initialDerivedState();
  for (const entry of entries) {
    const event = rawToCodexEvent(entry);
    if (!event) {
      const raw = entry.event as { method: string };
      if (typeof raw === "object" && raw && "method" in raw) {
        const counts = { ...state.traceSummary.eventCounts };
        counts[raw.method as string] = (counts[raw.method as string] ?? 0) + 1;
        state = {
          ...state,
          traceSummary: {
            ...state.traceSummary,
            eventCounts: counts,
            totalEvents: state.traceSummary.totalEvents + 1,
          },
        };
      }
      continue;
    }
    state = reduce(state, event);
  }
  return state;
}
