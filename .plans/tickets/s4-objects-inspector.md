# Task: S4 — Minimum Canvas objects + Inspector (browser-verified, vertical slice)

S3 is done: apps/web shows a tldraw Canvas, connects to apps/server, and a Playwright check confirms the task and final result appear as text shapes after Run test. Now make the Canvas show the full minimum object set and add an Inspector: selecting a work object opens a panel backed by Trace facts.

## Goal
1. The Canvas shows the minimum P0 object set: task, current work (live agent message), artifacts (file changes), test result, final result, and a trace summary. Not just task + result.
2. Selecting any object opens an Inspector panel showing the Trace facts behind it.
3. Browser-verified: Playwright clicks an object and asserts the Inspector shows the right facts.

## Steps
1. apps/web/src/routes/index.tsx (or split into components under apps/web/src): extend buildBoardObjects to emit all minimum objects: task, currentWork (live agentMessage deltas), each artifact (file change), testResult, finalResult, and a traceSummary object. Place them at fixed positions (layout does not affect execution).
2. Live updates: as WS events arrive, update currentWork (append agentMessage deltas) and add artifacts when item/fileChange fires.
3. Add an Inspector panel (a React component, e.g. apps/web/src/inspector/Inspector.tsx). When the user selects a shape on the canvas (tldraw selection), the Inspector shows the Trace facts behind that object: for a task, the turn/start input and the events that set it; for an artifact, the item/fileChange event with path/kind/diff; for the final result, the turn/completed event with status/duration/usage; for the trace summary, the event counts. Fetch the trace from GET /trace/:sessionId and filter to the events behind the selected object.
4. Selection to Inspector must NOT change execution (Glassbox rule: spatial/selection does not affect execution). Selecting is read-only inspection.
5. Write/extend the Playwright e2e at apps/web/e2e/run.spec.mjs: after Run test completes, click the task shape (or select it), assert the Inspector shows the task text and at least one trace event. Click the result shape, assert the Inspector shows "completed" and duration/usage. Iterate until it passes.

## Verify (browser)
- After Run test, the canvas shows the minimum object set (at least task, currentWork, finalResult, traceSummary; artifacts if the turn produced any).
- Selecting the task shape opens the Inspector with the task text and trace events.
- Selecting the final result shape opens the Inspector with status + duration + usage.
- Playwright asserts both.

## Scope and safety
- Only modify apps/web. Do not modify apps/server, AGENTS.md, README, .plans.
- Codex turns use the server readOnly sandbox + cwd /tmp/glassbox-codex-spike. Do not let codex write the user real filesystem.
- Do not touch ~/.glassbox/ or anything outside this repo.
- Kill only processes you started, by PID.
- Follow AGENTS.md. Relative /api and /ws only. Selection does not affect execution.

## When done
Print: the object set, the Inspector behavior, the Playwright result (assertion details), and a screenshot path.
