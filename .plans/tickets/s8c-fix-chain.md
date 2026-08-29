# Task: S8c — Fix the S8 failure chain (4 precise fixes, then one e2e run)

The full root cause is diagnosed from the trace evidence. Apply these 4 fixes, verify server-side with curl, then run the e2e once.

## Root cause chain (from trace of the last e2e run)
codex fired item/fileChange/requestApproval once; nobody answered it; the turn never completed (zero turn/completed in the whole trace); artifacts never flushed (the diff buffer flushes on turnCompleted); so no artifact shape, no completed turn shape, and no action.steer / action.send records. The run also revealed a path bug in the trace store.

## Fix 1 — trace store path bug (apps/server/src/trace/store.ts)
getGlassboxBase() does `here.split("/").filter(Boolean)` which drops the leading slash, so the base becomes the RELATIVE path "data/lora/repos/..." and resolves against the server cwd. The server runs with cwd=apps/server, so traces land in apps/server/data/lora/repos/... . Fix it so the base is always the ABSOLUTE repo root: keep the leading slash (or use node:path resolution), so the base is exactly <repoRoot>/.glassbox. Also move the existing session data from apps/server/data/lora/repos/Glassbox-Agent-Harness/.glassbox to <repoRoot>/.glassbox so past sessions are not lost, and remove the stray apps/server/data directory afterwards.

## Fix 2 — demo workspace reset per run (apps/server/src/index.ts, /run-demo)
The demo repo /tmp/glassbox-demo-repo keeps the fixed utils.js from earlier runs, so each new run starts from an unpredictable state and codex behaves differently. At the start of /run-demo, reset the workspace to its broken state: restore utils.js to the buggy version (i < n) and restore test.js, via git -C /tmp/glassbox-demo-repo checkout -- . or by rewriting the files. Keep a small fixture constant in the server (the buggy file content) so the reset always works even if git is unavailable.

## Fix 3 — decision answering must work end to end (apps/web)
When a fileChange decision request arrives, the web already renders a "DECISION NEEDED" shape (pendingDecisions). Make sure the answer path works: selecting the decision shape shows Confirm/Decline buttons in the Inspector, and clicking one calls POST /decide with the itemId and the boolean. The e2e already selects the shape and looks for a button labeled "Approve"; either keep that label or update the e2e to match the real label. Verify in the browser flow that the button appears for a decision object and that /decide is called.

## Fix 4 — action records must be appended when the action happens, not after the turn completes
action.steer and action.send are currently appended only after the new turn finishes, so a hung turn means no provenance. Append the action record immediately when the server handles /steer or /send-task (and action.decide when /decide is called), before the turn's provider events. Keep the trace append-only.

## Verify (server-side first with curl, then one e2e)
1. Start apps/server. POST /run-demo. Within a few seconds GET /trace/:sessionId should show the action record and the turn/started. When item/fileChange/requestApproval appears, POST /decide with a positive answer. The turn should then complete: GET /state/:sessionId shows finalResult completed and state.artifacts non-empty, and GET /trace/:sessionId shows turn/diff/updated events and turn/completed. Print all of this.
2. Confirm the trace file now lives at <repoRoot>/.glassbox/sessions/... (not under apps/server/data).
3. Run apps/web/e2e/s8.spec.mjs ONCE. Expected: the e2e now answers the decision, the turn completes, artifact/test/result shapes appear, steer and edit actions record. If a criterion still fails, print the new trace method list and the derivedState, fix precisely, and run the e2e again (at most twice total).

## Scope and safety
- Modify apps/server/src (trace store, /run-demo reset, action records) and apps/web (decision buttons) as needed. Do not modify AGENTS.md, README, .plans, or Notion.
- /tmp/glassbox-demo-repo is the only writable target for codex. Do not let codex write the user real filesystem or the Glassbox repo.
- Kill only processes you start, by PID. Do not use fuser -k or pkill. Follow AGENTS.md. Relative /api and /ws only.

## When done
Print: the path fix, the reset behavior, the curl verification output (trace methods + derivedState), and the final e2e criteria list.
