// apps/server/src/state/reducer.ts
// Pure synchronous reducer: (DerivedState, CodexEvent) -> DerivedState.
//
// Contract: given the same sequence of events, repeated folds over the
// reducer always produce identical DerivedState. The reducer does NOT
// depend on Canvas layout, timing, or order beyond event sequence.

import type { CodexEvent } from "../codex/schema.js";
import type { DerivedState, TurnRecord } from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Extract a single-blob text message from a UserInput array. */
function userInputText(input: unknown): string | null {
  if (!Array.isArray(input)) return null;
  const parts = input
    .filter((u): u is { type: string; text: string } =>
      typeof u === "object" && u !== null && u.type === "text" && typeof u.text === "string"
    )
    .map(u => u.text)
    .filter(Boolean);
  return parts.length > 0 ? parts.join(" ") : null;
}

/** Consider it a test-like item when the type string contains "test" or "command",
 *  or when exitCode is present (test/command items report completion codes). */
function isTestLikeItem(type: string, exitCode: number | undefined): boolean {
  if (exitCode !== undefined) return true;
  const lower = type.toLowerCase();
  return lower.includes("test") || lower.includes("command") || lower.includes("check");
}

/** Find the index of the last open turn (finalResult === null), or -1. */
function findOpenTurnIndex(turns: TurnRecord[]): number {
  for (let i = turns.length - 1; i >= 0; i--) {
    if (turns[i].finalResult === null) return i;
  }
  return -1;
}

// ---------------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------------

/**
 * Fold one decoded CodexEvent into derived state.
 *
 * @param state - current derived state
 * @param event - a decoded CodexEvent (has _tag discriminant)
 * @returns next derived state
 */
export function reduce(state: DerivedState, event: CodexEvent): DerivedState {
  // We always mutate the event-count summary; the rest is conditional.
  const counts: Record<string, number> = { ...state.traceSummary.eventCounts };

  switch (event._tag) {
    // -----------------------------------------------------------------------
    // Connection / thread lifecycle — no product state change, count only
    // -----------------------------------------------------------------------
    case "threadStarted": {
      counts["thread/started"] = (counts["thread/started"] ?? 0) + 1;
      return { ...state, traceSummary: { ...state.traceSummary, eventCounts: counts, totalEvents: state.traceSummary.totalEvents + 1 } };
    }

    // -----------------------------------------------------------------------
    // Turn started — capture task (first time only), push open turn entry
    // -----------------------------------------------------------------------
    case "turnStarted": {
      counts["turn/started"] = (counts["turn/started"] ?? 0) + 1;
      const fullEvent = event as unknown as Record<string, unknown>;
      const maybeInput = fullEvent.input as unknown;
      const text = userInputText(maybeInput);

      // Capture task if not yet set (first turn's input becomes the persistent task)
      const task = state.task || text || "";

      // Push an open turn entry
      const turnId = (fullEvent.turn as { id?: string } | undefined)?.id || "";
      const newTurn: TurnRecord = {
        turnId,
        taskOrInstruction: text || "",
        finalResult: null,
        agentMessageText: "",
      };

      return {
        ...state,
        task,
        turns: [...state.turns, newTurn],
        currentWork: null,
        testResult: null,
        traceSummary: { ...state.traceSummary, eventCounts: counts, totalEvents: state.traceSummary.totalEvents + 1 },
      };
    }

    // -----------------------------------------------------------------------
    // Item started — becomes the current work item
    // -----------------------------------------------------------------------
    case "itemStarted": {
      counts["item/started"] = (counts["item/started"] ?? 0) + 1;
      const item = event.item;
      // User messages carry text in `content[]` not `text`.
      let itemText = item.text ?? "";
      if (!itemText && Array.isArray((item as unknown as Record<string, unknown>).content)) {
        itemText = userInputText((item as unknown as Record<string, unknown>).content) ?? "";
      }
      // If no task yet and this is a user message, capture text as task
      if (!state.task && item.type === "userMessage" && itemText) {
        return {
          ...state,
          task: itemText,
          currentWork: {
            itemType: item.type,
            itemId: item.id,
            text: itemText,
            phase: item.phase ?? null,
            startedAtMs: event.startedAtMs,
          },
          traceSummary: { ...state.traceSummary, eventCounts: counts, totalEvents: state.traceSummary.totalEvents + 1 },
        };
      }
      return {
        ...state,
        currentWork: {
          itemType: item.type,
          itemId: item.id,
          text: itemText,
          phase: item.phase ?? null,
          startedAtMs: event.startedAtMs,
        },
        traceSummary: { ...state.traceSummary, eventCounts: counts, totalEvents: state.traceSummary.totalEvents + 1 },
      };
    }

    // -----------------------------------------------------------------------
    // Agent message delta — append to current work text AND to open turn entry
    // -----------------------------------------------------------------------
    case "agentMessageDelta": {
      counts["item/agentMessage/delta"] = (counts["item/agentMessage/delta"] ?? 0) + 1;
      // Update top-level currentWork (back-compat)
      let currentWork = state.currentWork;
      if (currentWork) {
        currentWork = { ...currentWork, text: currentWork.text + event.delta };
      }
      // Accumulate into the open turn entry in turns array
      const turns = [...state.turns];
      const openIdx = findOpenTurnIndex(turns);
      if (openIdx >= 0) {
        turns[openIdx] = { ...turns[openIdx], agentMessageText: turns[openIdx].agentMessageText + event.delta };
      }
      return {
        ...state,
        currentWork,
        turns,
        traceSummary: { ...state.traceSummary, eventCounts: counts, totalEvents: state.traceSummary.totalEvents + 1 },
      };
    }

    // -----------------------------------------------------------------------
    // Item completed — capture test result, clear currentWork if matching
    // -----------------------------------------------------------------------
    case "itemCompleted": {
      counts["item/completed"] = (counts["item/completed"] ?? 0) + 1;
      if (isTestLikeItem(event.item.type, event.item.exitCode)) {
        const newState = {
          ...state,
          testResult: {
            itemType: event.item.type,
            itemId: event.item.id,
            status: event.item.status,
            exitCode: event.item.exitCode ?? null,
            aggregatedOutput: event.item.aggregatedOutput ?? null,
            durationMs: event.item.durationMs ?? null,
          },
          traceSummary: { ...state.traceSummary, eventCounts: counts, totalEvents: state.traceSummary.totalEvents + 1 },
        };
        if (state.currentWork?.itemId === event.item.id) {
          return { ...newState, currentWork: null };
        }
        return newState;
      }
      // Non-test item: clear currentWork if it matches this item
      let currentWork = state.currentWork;
      if (currentWork?.itemId === event.item.id) currentWork = null;
      return {
        ...state,
        currentWork,
        traceSummary: { ...state.traceSummary, eventCounts: counts, totalEvents: state.traceSummary.totalEvents + 1 },
      };
    }

    // -----------------------------------------------------------------------
    // File change — record artifact changes (accumulated across all turns)
    // -----------------------------------------------------------------------
    case "itemFileChange": {
      counts["item/fileChange"] = (counts["item/fileChange"] ?? 0) + 1;
      const changes = event.changes.map((c) => ({
        path: (c as { path: string }).path,
        kind: (c as { kind: string }).kind,
        diff: (c as { diff?: string }).diff ?? null,
      }));
      const artifact: typeof state.artifacts[number] = {
        itemId: event.itemId,
        changes,
        status: "changed",
      };
      return {
        ...state,
        artifacts: [...state.artifacts, artifact],
        traceSummary: { ...state.traceSummary, eventCounts: counts, totalEvents: state.traceSummary.totalEvents + 1 },
      };
    }

    // -----------------------------------------------------------------------
    // Turn completed — finalize the open turn entry and set top-level finalResult
    // -----------------------------------------------------------------------
    case "turnCompleted": {
      counts["turn/completed"] = (counts["turn/completed"] ?? 0) + 1;
      const turn = event.turn;
      const finalResult: DerivedState["finalResult"] = {
        status: turn.status,
        startedAt: turn.startedAt,
        completedAt: turn.completedAt,
        durationMs: turn.durationMs,
        error: typeof turn.error === "string" ? turn.error : (turn.error ? JSON.stringify(turn.error) : null),
      };

      // Finalize the open turn entry with finalResult
      const turns = [...state.turns];
      const openIdx = findOpenTurnIndex(turns);
      if (openIdx >= 0) {
        turns[openIdx] = { ...turns[openIdx], finalResult };
      }

      return {
        ...state,
        turns,
        currentWork: null,
        finalResult,
        traceSummary: {
          ...state.traceSummary,
          eventCounts: counts,
          totalEvents: state.traceSummary.totalEvents + 1,
          totalDurationMs: turn.durationMs,
        },
      };
    }

    // -----------------------------------------------------------------------
    // Approval requests — no product state change, count only
    // -----------------------------------------------------------------------
    case "requestApproval": {
      const methodKey =
        event._tag === "requestApproval" ? "item/requestApproval" : "other/requestApproval";
      counts[methodKey] = (counts[methodKey] ?? 0) + 1;
      return { ...state, traceSummary: { ...state.traceSummary, eventCounts: counts, totalEvents: state.traceSummary.totalEvents + 1 } };
    }

    // -----------------------------------------------------------------------
    // Glassbox-side Action records — backfill instruction text on turns
    // -----------------------------------------------------------------------
    case "actionPause": {
      counts["action.pause"] = (counts["action.pause"] ?? 0) + 1;
      // action.pause: already captured in turns array via turn/completed with
      // status "interrupted". The turn record exists; no backfill needed.
      return { ...state, traceSummary: { ...state.traceSummary, eventCounts: counts, totalEvents: state.traceSummary.totalEvents + 1 } };
    }
    case "actionSteer": {
      counts["action.steer"] = (counts["action.steer"] ?? 0) + 1;
      // Backfill the instruction text onto the turn this steer created.
      // action.steer arrives AFTER turn/completed in the trace (per S6
      // provenance ordering), so the turn is already closed. Find it by
      // turnId and set the empty taskOrInstruction to the instruction text.
      const steerTurnId = (event as unknown as { turnId?: string }).turnId;
      const instruction = (event as unknown as { instruction?: string }).instruction || "";
      if (steerTurnId) {
        const turns = state.turns.map(t =>
          t.turnId === steerTurnId && !t.taskOrInstruction
            ? { ...t, taskOrInstruction: instruction }
            : t
        );
        return { ...state, turns, traceSummary: { ...state.traceSummary, eventCounts: counts, totalEvents: state.traceSummary.totalEvents + 1 } };
      }
      return { ...state, traceSummary: { ...state.traceSummary, eventCounts: counts, totalEvents: state.traceSummary.totalEvents + 1 } };
    }

    // -----------------------------------------------------------------------
    // Unhandled / future event kinds — update summary counts from _tag
    // -----------------------------------------------------------------------
    default: {
      const tag = (event as { _tag: string })._tag;
      counts["unknown/" + tag] = (counts["unknown/" + tag] ?? 0) + 1;
      return { ...state, traceSummary: { ...state.traceSummary, eventCounts: counts, totalEvents: state.traceSummary.totalEvents + 1 } };
    }
  }
}
