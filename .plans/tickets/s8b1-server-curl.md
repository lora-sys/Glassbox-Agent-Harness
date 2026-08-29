# Task: S8b1 — Change the demo task so it produces a change artifact (server + curl only)

The S8 demo task was a read-only inventory, so codex never updated a file and state.artifacts stayed empty. Change the demo task to one that updates a file, and confirm with curl that state.artifacts becomes non-empty. No browser work in this ticket.

## Steps
1. In apps/server, find the demo task prompt (the /run-demo or demo workspace endpoint). Change it to: "update utils.js so the tests pass". The controlled workspace /tmp/glassbox-demo-repo has a utils.js with an issue and a failing test.js.
2. If codex needs a writable sandbox to update the file, make sure the run uses writableRoots limited to /tmp/glassbox-demo-repo (no network). Keep any decision requests surfaced to the caller; do not answer them automatically inside the server.
3. Note: apps/server/src/state/reducer.ts may have uncommitted in-progress edits from a previous run. If curl shows state fields are wrong (task, artifacts, finalResult), fix the reducer so it derives correctly. Otherwise leave it.
4. Start apps/server (PORT=3030 or a free port; capture the PID).
5. POST the demo task. Poll GET /state/:sessionId until finalResult is set or 60s.
6. Print the full derivedState JSON. Confirm state.artifacts is non-empty (at least one change with a path and a kind). Print the event method list from GET /trace/:sessionId and confirm item/fileChange fired.
7. If state.artifacts is still empty, diagnose why: did codex update the file? did a decision request block it? Print what you find.
8. Kill the server PID you started. Leave the source changes in place (the demo task prompt change, and any reducer fix).

## Scope and safety
- Modify apps/server/src only (demo task prompt, run endpoint config, reducer if needed). Do not modify apps/web, AGENTS.md, README, .plans, or Notion.
- Controlled workspace /tmp/glassbox-demo-repo is the only writable target. Do not let codex write the user real filesystem or the Glassbox repo.
- Session data under <repo>/.glassbox/. Do not touch ~/.glassbox/.
- Kill only processes you start, by PID. Do not use fuser -k or pkill. Follow AGENTS.md.

## When done
Print: the new demo task, the derivedState artifacts array, the event method list, and whether item/fileChange fired.
