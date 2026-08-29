# Task: S8 diagnose — why task/artifact/result shapes do not project, then fix to 12/12

S8 (controlled demo at /tmp/glassbox-demo-repo) is built but the e2e is 5/12. Previous attempts timed out looping on the full e2e. Do NOT loop the full e2e. Diagnose with fast curl calls first, fix, then run the e2e once at the end.

## Current failures
- Task shape not on canvas (e2e reads "Task: (none)")
- File-change artifact not on canvas
- Final result not on canvas
- Inspector file path / change kind / trace facts fail
- e2e Playwright bug: `.first.fill` should be `.first().fill`
Already PASS: test result, steer creates new turn, action.steer in trace, decisions not auto-answered.

## Step 1: Diagnose with curl (fast, no browser)
Start apps/server (PORT=3030). POST a demo task to the demo workspace endpoint. Then GET /state/:sessionId and print the raw derivedState JSON. Also GET /trace/:sessionId and print the event method names in order. Answer:
- Is `task` empty? Does the turn/started event carry `input`? (Codex may not echo input.)
- Is `artifacts` empty? Did codex emit item/fileChange events? Did a file-change decision request appear and was it approved? (If approvals are needed and unanswered, no file change happens.)
- Is `finalResult` set? Did turn/completed arrive?

## Step 2: Fix
- If `task` is empty because codex does not echo input in turn/started: append a Glassbox-side action record (same shape as action.steer, kind "action.task") to the trace with the task text before the first turn's events, and have the reducer set state.task from it. Or ensure the run endpoint sends input that codex echoes. Pick the simpler one.
- If artifacts are empty because file-change decisions were not surfaced/approved in the e2e: make the e2e wait for and click Approve on item/fileChange/requestApproval (the /decide endpoint already exists). If codex in readOnly plus workspaceWrite does not request approval and just writes, the file change should still flow through item/fileChange; verify the adapter surfaces it.
- Align the e2e assertion text with the actual buildBoardObjects output. Turn shapes say "Turn 1 (task)", not "Result:"; task shape says "Task: <text>". Fix the e2e to assert the real shape texts, or fix the projector to emit the texts the e2e expects; pick one and be consistent.
- Fix `.first.fill` to `.first().fill` and audit other locator calls.

## Step 3: Verify once
Run apps/web/e2e/s8.spec.mjs once. All 12 criteria should pass. If not, go back to Step 1 with curl; do NOT loop the full e2e blindly.

## Scope and safety
- Modify apps/server/src/state, apps/server/src/index.ts, apps/web as needed. Do not modify AGENTS.md, README, .plans, or Notion.
- Controlled workspace /tmp/glassbox-demo-repo is the only writable target (writableRoots exactly that path). Do not let codex write the user real filesystem or the Glassbox repo.
- Session data under <repo>/.glassbox/. Do not touch ~/.glassbox/.
- Kill only processes you start, by PID. Follow AGENTS.md. Relative /api and /ws only.

## When done
Print: the curl diagnosis (task/artifacts/finalResult values + event methods in order), the fixes, the 12/12 e2e result, and a screenshot path.
