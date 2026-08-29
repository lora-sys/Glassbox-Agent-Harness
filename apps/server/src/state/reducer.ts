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
    // Turn started — capture task (first time only). Previously-open turns
    // are NOT eagerly closed here: turn/completed finalizes them (producing
    // artifacts via pending-diff flush). Auto-closing on turnStarted dropped
    // late-arriving diffs because turnStarted can fire before turn/completed.
    // -----------------------------------------------------------------------
    case "turnStarted": {
      counts["turn/started"] = (counts["turn/started"] ?? 0) + 1;
      const fullEvent = event as unknown as Record<string, unknown>;
      const maybeInput = fullEvent.input as unknown;
      const text = userInputText(maybeInput);

      // Codex may omit the input field in turn/started notifications.
      // Fall back to item content[] if provided there (handled via itemStarted
      // backfill below). Do NOT overwrite state.task with "".
      const task = state.task || text || "";

      // Push the new open turn entry
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
        artifacts: state.artifacts,
        _pendingDiffs: state._pendingDiffs,
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
      // Backfill open turn's taskOrInstruction from userMessage content
      const turns = [...state.turns];
      const openIdx = findOpenTurnIndex(turns);
      if (openIdx >= 0 && !turns[openIdx].taskOrInstruction && itemText) {
        turns[openIdx] = { ...turns[openIdx], taskOrInstruction: itemText };
      }
      // If no task yet and this is a user message, capture text as task
      if (!state.task && item.type === "userMessage" && itemText) {
        return {
          ...state,
          task: itemText,
          turns,
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
    // Diff updated — buffer file changes from the diff, create artifacts on
    // turn completion -----------------------------------------------------------------------
    case "turnDiffUpdated": {
      counts["turn/diff/updated"] = (counts["turn/diff/updated"] ?? 0) + 1;

      // Parse unified diff to extract file paths and kinds
      const rawDiff = (event as unknown as { diff?: string }).diff || "";
      const files: { path: string; kind: string }[] = [];
      const diffRe = /^diff --git a\/([^ \t\n]+) b\/([^ \t\n]+)/gm;
      let m: RegExpExecArray | null;
      while ((m = diffRe.exec(rawDiff)) !== null) {
        const aPath = m[1];
        const bPath = m[2];
        if (aPath === "/dev/null") { files.push({ path: bPath, kind: "add" }); continue; }
        if (bPath === "/dev/null") { files.push({ path: aPath, kind: "delete" }); continue; }
        files.push({ path: bPath, kind: aPath !== bPath ? "rename" : "modify" });
      }
      // Deduplicate: if the same path appears multiple times (e.g. renames), keep first
      const seen = new Set<string>();
      const unique = files.filter((f) => { if (seen.has(f.path)) return false; seen.add(f.path); return true; });

      // Skip buffering if the diff belongs to an already-closed turn.
      // Late-arriving diffs after turn/completed are silently dropped;
      // the turn/flush logic in turnStarted and turnCompleted already handled
      // the final diff for that turn.
      const diffTurnId = (event as unknown as { turnId?: string }).turnId || "";
      if (diffTurnId && state.turns.some(t => t.turnId === diffTurnId && t.finalResult !== null)) {
        return {
          ...state,
          traceSummary: { ...state.traceSummary, eventCounts: counts, totalEvents: state.traceSummary.totalEvents + 1 },
        };
      }

      // Buffer diffs per turnId; they become artifacts when turn/completed fires.
      const diffItemId = diffTurnId
        ? "diff-" + diffTurnId.slice(0, 8)
        : "diff-" + String(state.turns.length);
      const diffEntry = {
        itemId: diffItemId,
        turnId: diffTurnId,
        files: unique,
        rawDiff,
      };
      const deduped = state._pendingDiffs.filter(
        (d) => d.turnId !== diffEntry.turnId || d.rawDiff !== diffEntry.rawDiff,
      );
      return {
        ...state,
        _pendingDiffs: [...deduped, diffEntry],
        traceSummary: { ...state.traceSummary, eventCounts: counts, totalEvents: state.traceSummary.totalEvents + 1 },
      } as DerivedState;
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
      let artifacts = [...state.artifacts];
      let pendingDiffs = [...state._pendingDiffs];

      // Flush pending diffs for this turn into artifacts
      if (openIdx >= 0) {
        const turnId = turns[openIdx].turnId;
        const turnDiffs = pendingDiffs.filter((d) => d.turnId === turnId);
        for (const diff of turnDiffs) {
          const changes = diff.files.map((f) => ({
            path: f.path,
            kind: f.kind,
            diff: diff.rawDiff.length > 500 ? diff.rawDiff.slice(0, 500) + "…" : diff.rawDiff,
          }));
          artifacts.push({
            itemId: diff.itemId,
            changes,
            status: "changed",
          });
        }
        pendingDiffs = pendingDiffs.filter((d) => d.turnId !== turnId);
        // Preserve agentMessageText (may have accumulated from deltas and a
        // prior turn/completed with items). If this turn/completed did carry
        // items, merge them in; otherwise keep the existing text.
        const existing = turns[openIdx];
        const itemTexts = (turn.items ?? [])
          .filter((i: any) => i?.text)
          .map((i: any) => i.text)
          .join(" ");
        turns[openIdx] = {
          ...existing,
          finalResult,
          agentMessageText: existing.agentMessageText || itemTexts,
        };
      }

      return {
        ...state,
        turns,
        currentWork: null,
        artifacts,
        finalResult,
        _pendingDiffs: pendingDiffs,
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
    case "actionSend": {
      counts["action.send"] = (counts["action.send"] ?? 0) + 1;
      // action.send follows a new turn that already captured the edited task
      // text in its turnStarted event. Update the top-level task so the canvas
      // and subsequent turns see the new text. Backfill the turn record if
      // its taskOrInstruction is still empty.
      const sendTurnId = (event as unknown as { turnId?: string }).turnId;
      const newTaskText = (event as unknown as { task?: string }).task || state.task;
      const turns = sendTurnId
        ? state.turns.map(t =>
            t.turnId === sendTurnId && !t.taskOrInstruction
              ? { ...t, taskOrInstruction: newTaskText }
              : t
          )
        : state.turns;
      return {
        ...state,
        task: newTaskText,
        turns,
        traceSummary: { ...state.traceSummary, eventCounts: counts, totalEvents: state.traceSummary.totalEvents + 1 },
      };
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
