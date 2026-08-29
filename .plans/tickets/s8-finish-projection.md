# Task: S8 finish — fix canvas projection + e2e to 12/12 (browser-verified)

S8 is mostly built: controlled workspace at /tmp/glassbox-demo-repo, server /decide, demo task runs, codex runs the fix and the tests pass, steer works, action.steer is in the trace. But the S8 e2e is 5/12: the web canvas does not project the task, file-change artifact, or final result shapes, and the e2e has a Playwright API bug. Fix it to 12/12.

## Current e2e result (5/12 pass)
PASS: Real task enters Glassbox; Decisions surfaced not auto-answered; Test result on canvas; Steer creates explicit new turn; action.steer in trace.
FAIL: Task shape on canvas; File-change artifact on canvas; Final result on canvas; Full canvas; Inspector file path; Inspector change kind; Inspector backed by trace facts.
Error: `inspectorTextarea.first.fill is not a function` (Playwright: .first is a method, must call .first().fill).

## Goal
All 12 P0 acceptance criteria pass in apps/web/e2e/s8.spec.mjs.

## Steps
1. Diagnose why the task, artifact, and result shapes do not project. Run a demo task, GET /state/:sessionId, inspect derivedState fields: task, artifacts, finalResult, turns. Likely the reducer does not fill task from the demo path, or buildBoardObjects does not handle these events for the demo workspace. Fix the reducer (apps/server/src/state) or the projector (apps/web) so the task, the file change as an artifact, and the final result appear.
2. Fix the file-change artifact projection: when codex changes a file in /tmp/glassbox-demo-repo, the event must become an artifact Canvas object with the file path and a diff, selectable for the Inspector.
3. Fix the final-result projection for the demo turn.
4. Fix the e2e Playwright API: replace .first.fill with .first().fill, and audit other locator calls for the same mistake.
5. Run apps/web/e2e/s8.spec.mjs until all 12 pass. Iterate on the implementation, not the criteria.

## Scope and safety
- Modify apps/server/src/state and apps/web as needed. Do not modify AGENTS.md, README, .plans, or Notion.
- The controlled workspace stays at /tmp/glassbox-demo-repo and is the only writable target for codex (writableRoots exactly that path). Do not let codex write the user real filesystem or the Glassbox repo.
- Do not touch the user real ~/.glassbox/. Session data stays under <repo>/.glassbox/.
- Kill only processes you started, by PID.
- Follow AGENTS.md. Relative /api and /ws only.

## When done
Print: the root cause of the missing shapes, the fixes, the 12/12 e2e result, and a screenshot path.
