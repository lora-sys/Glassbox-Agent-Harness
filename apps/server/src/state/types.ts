// apps/server/src/state/types.ts
// Derived state model: Glassbox's interpretation of a Codex trace.
// Never includes Canvas layout. Re-derivable from Raw Trace at any time.

// ---------------------------------------------------------------------------
// Top-level derived state
// ---------------------------------------------------------------------------

/** The complete derived state for one session. */
export interface DerivedState {
  /** The user's original instruction (from first turn/start input). */
  task: string;
  /** The current appended system instruction for the session (claude-code-specific). */
  systemInstruction: string;
  /** The latest in-progress item, or null if nothing is running. */
  currentWork: CurrentWork | null;
  /** File changes observed so far during the active turn. */
  artifacts: ArtifactChange[];
  /** The latest completed test-like item, or null. */
  testResult: TestResult | null;
  /** Final turn outcome from the most recent turn/completed, or null. */
  finalResult: FinalResult | null;
  /** Summary counts for the trace (event types, duration, tokens). */
  traceSummary: TraceSummary;
  /** Ordered history of every turn in this session, oldest first. */
  turns: TurnRecord[];
  /** Internal: buffered diff events per turn, flushed to artifacts on turn/completed. */
  _pendingDiffs: Array<{ itemId: string; turnId: string; files: { path: string; kind: string }[]; rawDiff: string }>;
}

// ---------------------------------------------------------------------------
// Sub-types
// ---------------------------------------------------------------------------

/** The current in-progress work item. */
export interface CurrentWork {
  itemType: string;
  itemId: string;
  /** Accumulated text (from item/started + agentMessageDelta). */
  text: string;
  phase: string | null;
  startedAtMs: number;
}

/** A file change observed during the turn. */
export interface ArtifactChange {
  itemId: string;
  /** Raw change objects from the provider (paths, types, etc.). */
  changes: unknown[];
  status: string;
}

/** A completed test or command item. */
export interface TestResult {
  itemType: string;
  itemId: string;
  status: string;
  exitCode: number | null;
  aggregatedOutput: string | null;
  durationMs: number | null;
}

/** Final turn outcome. */
export interface FinalResult {
  status: string;
  startedAt: number;
  completedAt: number;
  durationMs: number;
  error: string | null;
}

/** Trace-level summary stats. */
export interface TraceSummary {
  /** Count of each event method (e.g. "item/started": 5). */
  eventCounts: Record<string, number>;
  /** Cumulative event count. */
  totalEvents: number;
  /** Turn duration from turn/completed. */
  totalDurationMs: number | null;
  /** Cumulative token usage, accumulated from thread/tokenUsage/updated events. */
  tokenUsage: TokenUsage;
}

export interface TokenUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  costUsd: number | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** One turn within a session — accumulated as events arrive, finalized on turn/completed. */
export interface TurnRecord {
  /** Server-assigned turn UUID. */
  turnId: string;
  /** The input text for this turn (task prompt or steer instruction). */
  taskOrInstruction: string;
  /** Final outcome of this turn. Null while the turn is still running. */
  finalResult: FinalResult | null;
  /** Accumulated agent message text from agentMessageDelta events. */
  agentMessageText: string;
  /** Full final answer text from the last assistant text block (claude-code-only). */
  finalAnswer: string;
}

export function initialDerivedState(): DerivedState {
  return {
    task: "",
    systemInstruction: "",
  currentWork: null,
    artifacts: [],
    testResult: null,
    finalResult: null,
    traceSummary: {
      eventCounts: {},
      totalEvents: 0,
      totalDurationMs: null,
      tokenUsage: { inputTokens: null, outputTokens: null, totalTokens: null, costUsd: null },
    },
    turns: [],
    _pendingDiffs: [],
  };
}
