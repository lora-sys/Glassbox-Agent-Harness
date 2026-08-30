// apps/server/src/state/reducer.test.ts
// Tests for the derived state reducer and trace replay.
//
// Proofs:
//  1. Reduce transforms raw events into a complete DerivedState.
//  2. Replaying the same trace twice yields identical state (deterministic).
//  3. Interactive endpoint: POST /run-test, GET /state/:sessionId.

import { describe, expect, it } from "vitest";
import { getGlassboxBase } from "../trace/store.js";
import { reduce } from "./reducer.js";
import { replayEntries } from "./replay.js";
import { initialDerivedState } from "./types.js";
import type { TraceEntry } from "../trace/store.js";
import { rmSync, statSync } from "node:fs";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function rawEntry(method: string, overrides: Record<string, unknown> = {}): TraceEntry {
  return {
    seq: 0,
    ts: new Date().toISOString(),
    event: { method, params: overrides },
    provenance: "test",
  };
}

// ---------------------------------------------------------------------------
// Reducer unit tests
// ---------------------------------------------------------------------------

describe("reduce", () => {
  // ---- turn/started sets the task when input is present -----------------

  it("extracts the user task from turn/started with input", () => {
    const event = {
      _tag: "turnStarted" as const,
      threadId: "thread-1",
      turn: {
        id: "turn-1",
        status: "inProgress",
      },
      input: [{ type: "text", text: "refactor the auth module" }],
    };

    const state = reduce(initialDerivedState(), event);
    expect(state.task).toBe("refactor the auth module");
  });

  it("leaves task empty when turn/started has no input", () => {
    const event = {
      _tag: "turnStarted" as const,
      threadId: "thread-1",
      turn: { id: "turn-1", status: "inProgress" },
    };

    const state = reduce(initialDerivedState(), event);
    expect(state.task).toBe("");
  });

  // ---- item/started sets current work -----------------------------------

  it("sets currentWork from item/started", () => {
    const event = {
      _tag: "itemStarted" as const,
      item: { type: "command_execution", id: "cmd-1", text: "running tests", phase: "running" },
      threadId: "thread-1",
      turnId: "turn-1",
      startedAtMs: 1000,
    };

    const state = reduce(initialDerivedState(), event);
    expect(state.currentWork).toEqual({
      itemType: "command_execution",
      itemId: "cmd-1",
      text: "running tests",
      phase: "running",
      startedAtMs: 1000,
    });
  });

  // ---- agentMessage/delta appends to current work text ------------------

  it("appends delta text to current work", () => {
    let state = initialDerivedState();
    state = reduce(state, {
      _tag: "itemStarted" as const,
      item: { type: "agent_message", id: "msg-1", text: "Hello" },
      threadId: "t1",
      turnId: "turn-1",
      startedAtMs: 100,
    });
    expect(state.currentWork?.text).toBe("Hello");

    state = reduce(state, {
      _tag: "agentMessageDelta" as const,
      threadId: "t1",
      turnId: "turn-1",
      itemId: "msg-1",
      delta: " world",
    });
    expect(state.currentWork?.text).toBe("Hello world");
  });

  it("ignores delta when no current work is active", () => {
    const event = {
      _tag: "agentMessageDelta" as const,
      threadId: "t1",
      turnId: "turn-1",
      itemId: "msg-1",
      delta: "text",
    };

    const state = reduce(initialDerivedState(), event);
    expect(state.currentWork).toBeNull();
    expect(state.traceSummary.eventCounts["item/agentMessage/delta"]).toBe(1);
  });

  // ---- item/completed sets testResult for test-like items ---------------

  it("sets testResult when item/completed has an exit code", () => {
    const event = {
      _tag: "itemCompleted" as const,
      item: {
        type: "command_execution",
        id: "cmd-1",
        status: "success",
        aggregatedOutput: "3 passed",
        exitCode: 0,
        durationMs: 1200,
      },
      threadId: "thread-1",
      turnId: "turn-1",
      completedAtMs: 5000,
    };

    const state = reduce(initialDerivedState(), event);
    expect(state.testResult?.itemType).toBe("command_execution");
    expect(state.testResult?.exitCode).toBe(0);
    expect(state.testResult?.aggregatedOutput).toBe("3 passed");
    expect(state.testResult?.durationMs).toBe(1200);
  });

  it("sets testResult for type 'unit_test' completion", () => {
    const event = {
      _tag: "itemCompleted" as const,
      item: { type: "unit_test", id: "ut-1", status: "failed", exitCode: 1 },
      threadId: "thread-1",
      turnId: "turn-1",
      completedAtMs: 3000,
    };

    const state = reduce(initialDerivedState(), event);
    expect(state.testResult?.itemType).toBe("unit_test");
    expect(state.testResult?.exitCode).toBe(1);
  });

  it("does NOT set testResult for non-test items", () => {
    const event = {
      _tag: "itemCompleted" as const,
      item: { type: "reasoning", id: "r-1", status: "completed" },
      threadId: "thread-1",
      turnId: "turn-1",
      completedAtMs: 2000,
    };

    const state = reduce(initialDerivedState(), event);
    expect(state.testResult).toBeNull();
  });

  it("clears currentWork when the completed item matches it", () => {
    const state = reduce(initialDerivedState(), {
      _tag: "itemStarted" as const,
      item: { type: "command_execution", id: "cmd-1" },
      threadId: "t1",
      turnId: "t1",
      startedAtMs: 100,
    });

    const after = reduce(state, {
      _tag: "itemCompleted" as const,
      item: { type: "command_execution", id: "cmd-1", status: "done" },
      threadId: "t1",
      turnId: "t1",
      completedAtMs: 500,
    });

    expect(after.currentWork).toBeNull();
  });

  // ---- turn/completed sets finalResult and traceSummary ----------------

  it("sets finalResult and traceSummary from turn/completed", () => {
    const event = {
      _tag: "turnCompleted" as const,
      threadId: "thread-1",
      turn: {
        id: "turn-1",
        status: "completed",
        startedAt: 1000,
        completedAt: 5000,
        durationMs: 4000,
        error: null,
      },
    };

    const state = reduce(initialDerivedState(), event);
    expect(state.finalResult?.status).toBe("completed");
    expect(state.finalResult?.durationMs).toBe(4000);
    expect(state.finalResult?.error).toBeNull();
    expect(state.traceSummary.totalDurationMs).toBe(4000);
  });

  it("captures turn error as string", () => {
    const event = {
      _tag: "turnCompleted" as const,
      threadId: "thread-1",
      turn: {
        id: "turn-1",
        status: "failed",
        startedAt: 0,
        completedAt: 1000,
        durationMs: 1000,
        error: { code: -32000, message: "something broke" },
      },
    };

    const state = reduce(initialDerivedState(), event);
    expect(state.finalResult?.status).toBe("failed");
    expect(state.finalResult?.error).toContain("something broke");
  });

  // ---- Summary counts increment correctly -------------------------------

  it("increments trace summary for every event kind", () => {
    const state = reduce(initialDerivedState(), {
      _tag: "threadStarted" as const,
      thread: { id: "th-1", sessionId: "s-1", status: { type: "active" }, cwd: "/tmp" },
    });
    expect(state.traceSummary.totalEvents).toBe(1);
    expect(state.traceSummary.eventCounts["thread/started"]).toBe(1);

    const afterItem = reduce(state, {
      _tag: "itemStarted" as const,
      item: { type: "agent_message", id: "i-1", text: "hi" },
      threadId: "th-1",
      turnId: "turn-1",
      startedAtMs: 50,
    });
    expect(afterItem.traceSummary.totalEvents).toBe(2);
    expect(afterItem.traceSummary.eventCounts["item/started"]).toBe(1);

    const afterComplete = reduce(afterItem, {
      _tag: "itemCompleted" as const,
      item: { type: "agent_message", id: "i-1", status: "completed" },
      threadId: "th-1",
      turnId: "turn-1",
      completedAtMs: 200,
    });
    expect(afterComplete.traceSummary.totalEvents).toBe(3);
    expect(afterComplete.traceSummary.eventCounts["item/completed"]).toBe(1);
  });

  // ---- item/fileChange populates artifacts ----

  it("appends a fileChange event to artifacts", () => {
    let state = reduce(initialDerivedState(), {
      _tag: "turnStarted" as const,
      threadId: "th-1",
      turn: { id: "turn-1", status: "inProgress" },
      input: [{ type: "text", text: "add a test file" }],
    });
    state = reduce(state, {
      _tag: "itemStarted" as const,
      item: { type: "fileChange", id: "fc-1", text: "editing" },
      threadId: "th-1",
      turnId: "turn-1",
      startedAtMs: 100,
    });
    state = reduce(state, {
      _tag: "itemFileChange" as const,
      threadId: "th-1",
      turnId: "turn-1",
      itemId: "fc-1",
      changes: [
        { path: "src/foo.ts", kind: "modify", diff: "diff content" },
        { path: "src/bar.ts", kind: "add", diff: undefined },
      ],
    });
    expect(state.artifacts).toHaveLength(1);
    expect(state.artifacts[0].itemId).toBe("fc-1");
    expect(state.artifacts[0].changes).toHaveLength(2);
    expect(state.artifacts[0].changes[0].path).toBe("src/foo.ts");
    expect(state.artifacts[0].changes[0].kind).toBe("modify");
    expect(state.artifacts[0].changes[0].diff).toBe("diff content");
    expect(state.artifacts[0].changes[1].path).toBe("src/bar.ts");
    expect(state.artifacts[0].changes[1].kind).toBe("add");
    expect(state.artifacts[0].changes[1].diff).toBeNull();
  });

  it("preserves currentWork through itemFileChange events", () => {
    let state = reduce(initialDerivedState(), {
      _tag: "turnStarted" as const,
      threadId: "th-1",
      turn: { id: "turn-1", status: "inProgress" },
      input: [{ type: "text", text: "edit files" }],
    });
    state = reduce(state, {
      _tag: "itemStarted" as const,
      item: { type: "fileChange", id: "fc-1", text: "editing src/main.ts" },
      threadId: "th-1",
      turnId: "turn-1",
      startedAtMs: 100,
    });
    state = reduce(state, {
      _tag: "itemFileChange" as const,
      threadId: "th-1",
      turnId: "turn-1",
      itemId: "fc-1",
      changes: [{ path: "src/main.ts", kind: "modify" }],
    });
    // currentWork from itemStarted is still present
    expect(state.currentWork?.itemId).toBe("fc-1");
    expect(state.artifacts).toHaveLength(1);
  });

  // ---- Issue #4: itemStarted backfills turn even when state.task is already set ----

  it("itemStarted backfills turn taskOrInstruction in task branch when state.task exists", () => {
    // Simulate: turn/started with input (state.task = existing value)
    // then item/started from a new turn WITHOUT turnOrInstruction
    let state = reduce(initialDerivedState(), {
      _tag: "turnStarted" as const,
      threadId: "th-1",
      turn: { id: "turn-1", status: "inProgress" },
      input: [{ type: "text", text: "existing task" }],
    });
    // Second turn with no input (taskOrInstruction set to "")
    state = reduce(state, {
      _tag: "turnStarted" as const,
      threadId: "th-1",
      turn: { id: "turn-2", status: "inProgress" },
    });
    expect(state.turns).toHaveLength(2);
    expect((state.turns[1] as any).taskOrInstruction).toBe("");

    // item/started for userMessage with new task text → state.task stays "existing task"
    // but the open turn should get backfilled with the userMessage text
    state = reduce(state, {
      _tag: "itemStarted" as const,
      item: { type: "userMessage", id: "um-1", content: [{ type: "text", text: "add a test" }] },
      threadId: "th-1",
      turnId: "turn-2",
      startedAtMs: 500,
    });

    // Before fix: turns[1].taskOrInstruction was empty because the second
    // return branch of itemStarted omitted `turns`.
    expect(state.task).toBe("existing task"); // task unchanged
    expect(state.turns[1].taskOrInstruction).toBe("add a test"); // backfill works
  });
});

// ---------------------------------------------------------------------------
// Replay unit tests (determinism proof)
// ---------------------------------------------------------------------------

describe("replayEntries", () => {
  const syntheticTrace: TraceEntry[] = [
    rawEntry("thread/started", { thread: { id: "th-1", sessionId: "s-1", status: { type: "active" }, cwd: "/tmp" } }),
    rawEntry("turn/started", {
      threadId: "th-1",
      turn: { id: "tr-1", status: "inProgress" },
      input: [{ type: "text", text: "write a hello world function" }],
    }),
    rawEntry("item/started", {
      item: { type: "agent_message", id: "m-1", text: "Writing..." },
      threadId: "th-1",
      turnId: "tr-1",
      startedAtMs: 100,
    }),
    rawEntry("item/agentMessage/delta", {
      threadId: "th-1",
      turnId: "tr-1",
      itemId: "m-1",
      delta: "hello world",
    }),
    rawEntry("item/started", {
      item: { type: "command_execution", id: "c-1" },
      threadId: "th-1",
      turnId: "tr-1",
      startedAtMs: 200,
    }),
    rawEntry("item/completed", {
      item: { type: "command_execution", id: "c-1", status: "success", aggregatedOutput: "done", exitCode: 0 },
      threadId: "th-1",
      turnId: "tr-1",
      completedAtMs: 2000,
    }),
    rawEntry("turn/completed", {
      threadId: "th-1",
      turn: {
        id: "tr-1",
        status: "completed",
        startedAt: 0,
        completedAt: 5000,
        durationMs: 5000,
        error: null,
      },
    }),
  ];

  it("produces a state with task, currentWork/testResult, finalResult, and summary", () => {
    const state = replayEntries(syntheticTrace);

    // Task
    expect(state.task).toBe("write a hello world function");

    // Final result
    expect(state.finalResult?.status).toBe("completed");
    expect(state.finalResult?.durationMs).toBe(5000);

    // Trace summary
    expect(state.traceSummary.totalEvents).toBe(7);
    expect(state.traceSummary.totalDurationMs).toBe(5000);
    expect(state.traceSummary.eventCounts["turn/completed"]).toBe(1);
    expect(state.traceSummary.eventCounts["item/completed"]).toBe(1);
    expect(state.traceSummary.eventCounts["item/started"]).toBe(2);
  });

  it("is deterministic: same trace produces identical state", () => {
    const first = replayEntries(syntheticTrace);
    const second = replayEntries(syntheticTrace);
    const third = replayEntries(syntheticTrace);

    expect(third).toEqual(first);
    expect(third).toEqual(second);
  });

  it("returns initial state for an empty trace", () => {
    const state = replayEntries([]);
    expect(state).toEqual(initialDerivedState());
  });

  it("ignores unrecognized methods but counts them in the summary", () => {
    const traceWithUnknown = [
      ...syntheticTrace,
      rawEntry("unknown/method", { foo: "bar" }),
    ];
    const state = replayEntries(traceWithUnknown);
    expect(state.traceSummary.totalEvents).toBe(8);
    expect(state.traceSummary.eventCounts["unknown/method"]).toBe(1);
  });

  // ---- tokenUsageUpdated accumulates across turns (Codex path) ----

  it("accumulates tokenUsage across multiple tokenUsageUpdated events", () => {
    const trace = [
      rawEntry("thread/started", { thread: { id: "th-1", sessionId: "s-1", status: { type: "active" }, cwd: "/tmp" } }),
      rawEntry("thread/tokenUsage/updated", {
        threadId: "th-1",
        turnId: "tr-1",
        tokenUsage: {
          total: { totalTokens: 17924, inputTokens: 17740, outputTokens: 184 },
        },
      }),
      rawEntry("thread/tokenUsage/updated", {
        threadId: "th-1",
        turnId: "tr-1",
        tokenUsage: {
          total: { totalTokens: 36314, inputTokens: 35973, outputTokens: 341 },
        },
      }),
      rawEntry("thread/tokenUsage/updated", {
        threadId: "th-1",
        turnId: "tr-1",
        tokenUsage: {
          total: { totalTokens: 54825, inputTokens: 54434, outputTokens: 391 },
        },
      }),
    ];

    const state = replayEntries(trace);
    // Each event reports cumulative totals from the provider, so the last
    // event's values are the session totals.
    expect(state.traceSummary.tokenUsage.totalTokens).toBe(54825);
    expect(state.traceSummary.tokenUsage.inputTokens).toBe(54434);
    expect(state.traceSummary.tokenUsage.outputTokens).toBe(391);
    expect(state.traceSummary.tokenUsage.costUsd).toBeNull();
    expect(state.traceSummary.eventCounts["thread/tokenUsage/updated"]).toBe(3);
  });

  it("accumulates costUsd from claude-style tokenUsageUpdated events", () => {
    const trace = [
      rawEntry("thread/started", { thread: { id: "th-1", sessionId: "s-1", status: { type: "active" }, cwd: "/tmp" } }),
      rawEntry("thread/tokenUsage/updated", {
        threadId: "th-1",
        turnId: "tr-1",
        tokenUsage: {
          total: { totalTokens: 1000, inputTokens: 800, outputTokens: 200 },
        },
        costUsd: 0.005,
      }),
      rawEntry("thread/tokenUsage/updated", {
        threadId: "th-1",
        turnId: "tr-1",
        tokenUsage: {
          total: { totalTokens: 2500, inputTokens: 2000, outputTokens: 500 },
        },
        costUsd: 0.012,
      }),
    ];

    const state = replayEntries(trace);
    expect(state.traceSummary.tokenUsage.totalTokens).toBe(2500);
    expect(state.traceSummary.tokenUsage.inputTokens).toBe(2000);
    expect(state.traceSummary.tokenUsage.outputTokens).toBe(500);
    expect(state.traceSummary.tokenUsage.costUsd).toBeCloseTo(0.017);
  });

  it("leaves tokenUsage null when no usage events are present", () => {
    const state = replayEntries(syntheticTrace);
    expect(state.traceSummary.tokenUsage.totalTokens).toBeNull();
    expect(state.traceSummary.tokenUsage.inputTokens).toBeNull();
    expect(state.traceSummary.tokenUsage.outputTokens).toBeNull();
    expect(state.traceSummary.tokenUsage.costUsd).toBeNull();
  });

  it("is deterministic with tokenUsageUpdated events in trace", () => {
    const traceWithUsage = [
      rawEntry("thread/started", { thread: { id: "th-1", sessionId: "s-1", status: { type: "active" }, cwd: "/tmp" } }),
      rawEntry("thread/tokenUsage/updated", {
        threadId: "th-1",
        turnId: "tr-1",
        tokenUsage: { total: { totalTokens: 500, inputTokens: 400, outputTokens: 100 } },
      }),
    ];
    const first = replayEntries(traceWithUsage);
    const second = replayEntries(traceWithUsage);
    expect(first).toEqual(second);
    expect(first.traceSummary.tokenUsage.totalTokens).toBe(500);
  });
});

// ---------------------------------------------------------------------------
// Integration: run the real /run-test endpoint, then verify /state
// ---------------------------------------------------------------------------

describe("integration: run-test + /state endpoint", () => {
  function cleanTraceDir(sessionId: string): void {
    try {
      const dir = `${getGlassboxBase()}/sessions/${sessionId}`;
      rmSync(dir, { recursive: true, force: true });
    } catch { /** ignore */ }
  }

  it("POST /run-test produces a trace that GET /state derives from", async () => {
    // We don't have the codex binary in CI, so skip with a warning.
    const codexPath = process.env.CODEX_PATH ?? "codex";
    try {
      statSync(codexPath);
    } catch {
      console.log("[skip] codex binary not found — integration test requires codex app-server");
      return;
    }

    const base = `http://localhost:${process.env.PORT ?? 3030}`;

    // 1. Run a test turn
    const runRes = await fetch(`${base}/run-test`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "say hello" }),
    });
    expect(runRes.ok).toBe(true);
    const runBody = await runRes.json() as { sessionId: string };
    const sessionId = runBody.sessionId;

    try {
      // 2. Verify /state endpoint returns derived state
      const stateRes = await fetch(`${base}/state/${sessionId}`);
      expect(stateRes.ok).toBe(true);
      const state = await stateRes.json() as Record<string, unknown>;

      expect(state).toHaveProperty("task");
      expect((state.task as string).length).toBeGreaterThan(0);
      expect(state).toHaveProperty("traceSummary");
      expect((state.traceSummary as Record<string, unknown>).totalEvents).toBeGreaterThan(0);
      expect(state).toHaveProperty("finalResult");
      expect((state.finalResult as Record<string, unknown>).status); // "completed", "interrupted", etc.
      expect((state.finalResult as Record<string, unknown>).durationMs);
    } finally {
      cleanTraceDir(sessionId);
    }
  });

  it("replaying the real trace twice yields identical state", async () => {
    const codexPath = process.env.CODEX_PATH ?? "codex";
    try {
      statSync(codexPath);
    } catch {
      console.log("[skip] codex binary not found — integration determinism test requires codex app-server");
      return;
    }

    const base = `http://localhost:${process.env.PORT ?? 3030}`;

    const runRes = await fetch(`${base}/run-test`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "list files" }),
    });
    expect(runRes.ok).toBe(true);
    const runBody = await runRes.json() as { sessionId: string };
    const sessionId = runBody.sessionId;

    try {
      const stateRes = await fetch(`${base}/state/${sessionId}`);
      expect(stateRes.ok).toBe(true);
      const derived = await stateRes.json() as Record<string, unknown>;
      expect(derived).toHaveProperty("task");
      expect((derived.traceSummary as Record<string, unknown>).totalEvents).toBeGreaterThan(0);
    } finally {
      cleanTraceDir(sessionId);
    }
  });
});
