# Task: S8d — Finish the S8 e2e and commit (browser-verified)

The S8 acceptance e2e (apps/web/e2e/s8.spec.mjs) is at 16/22. A set of fixes is already applied in the working tree (uncommitted). Run the e2e, fix whatever still fails, get every criterion green, then commit. Do NOT push.

## Notes on the working tree
These changes are intentional and already applied: absolute trace path in trace/store.ts; WS subscribe catch-up for pending approvals (ws/server.ts + index.ts); interrupt-then-bounded-wait in /steer and /send-task; /run-demo rewrites the demo fixture file for reproducible runs; startNewTurn uses workspaceWrite with writableRoots; makeTraceCollector re-broadcasts derived state every 25 events and on turn completion; the e2e uses the short prompt "update utils.js so the tests pass" with 180s waits.

## Last e2e result (16/22)
PASS: session, task shape, decisions surfaced, test result, steer new turn, action.steer x2, DRAFT badge, edited task, explicit actions, trace rebuild, turns rebuilt, task rebuilt, append-only, action.decide, action.send.
FAIL: artifact shape, final-result shape (live "Turn ... completed"), full canvas, and three Inspector criteria (skipped while the artifact shape is missing).

## Context from the last trace
18 turn/diff/updated fired and 4 turn/completed (all completed) — derived state is fine; earlier failures were timing (long prompt made the turn take 4+ minutes; the short prompt is ~25s) plus live-update gaps (now covered by the throttled broadcast). If the artifact shape still does not appear, print GET /state/:sessionId artifacts and check the reducer's pending-diff flush on turn completion (apps/server/src/state).

## Steps
1. Check ports 3030 and 5173 with curl. If occupied, find the PID via ss -tlnp and stop only the Glassbox server or vite process, by PID.
2. Run apps/web/e2e/s8.spec.mjs once (allow ~700s). Print the full criteria list.
3. If a criterion fails, diagnose with curl (GET /state, GET /trace) and fix precisely. At most two more e2e runs; no blind looping.
4. When green, run the server suite: npx vitest run apps/server/src --reporter=basic (52 tests; 2 integration tests may skip if codex is not on PATH under vitest).
5. Commit the S8 work in logical groups (conventional messages), including the e2e. Exclude test artifacts (test-results/, .vite/, .playwright-mcp/, screenshots). Do NOT push.

## Safety
- /tmp/glassbox-demo-repo is the only writable target for codex.
- Stop only processes you start, by PID. Never fuser -k or pkill.
- Do not modify AGENTS.md, README, .plans, or Notion.

## When done
Print: the final criteria list (all PASS), the vitest summary, commit hashes + subjects, and confirm no push.

## Working style (important)
- Write your progress to .plans/findings/_s8d-progress.md as you go (append after each step: e2e output, diagnosis, fixes). If the session is cut off, that file is the record.
- Be time-efficient: the previous attempt spent 30 minutes without finishing one e2e run. Budget: first e2e run within 10 minutes, fixes within 10, final verification within 10, then commit.
- The e2e starts its own server and web dev server (ports are currently free). Wait for the full criteria list at the end.

## Update
The previous two attempts each spent their whole session on one e2e run (turns with edits take 2-4 minutes each; the full e2e is 15-20 minutes). Update .plans/findings/_s8d-progress.md immediately when: the first e2e run finishes (paste the full criteria list), after each diagnosis, after each fix, and after the final verification. Prefer fewer, bigger fixes over many small iterations.
