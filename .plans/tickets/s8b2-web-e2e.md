# Task: S8b2 — Fix the S8 web e2e to read shapes correctly and reach 12/12

Server layer is verified: the demo task "update utils.js so the tests pass" makes codex edit utils.js, state.artifacts is non-empty (path=utils.js, kind=modify, with a diff), testResult passes (exitCode 0), finalResult is completed. Only the web e2e is broken.

## Fix plan
1. Fix apps/web/e2e/s8.spec.mjs to read canvas shapes via page.evaluate reading the tldraw editor store (the same method the S3-S6 e2e used; those passed). Do not use page.locator to find text on a tldraw canvas (text renders on a canvas, not the DOM).
2. Fix the .first.fill -> .first().fill Playwright bug and audit other locator calls for the same mistake.
3. Align e2e assertion texts with the real buildBoardObjects output: task shape "Task: <text>", turn shape "Turn 1 (task) ... completed ... duration", change shape whatever the projector emits for artifacts (read apps/web/src/routes/index.tsx buildBoardObjects for the artifact shape text). Assert the real texts.
4. Run apps/web/e2e/s8.spec.mjs once. All 12 P0 criteria should pass:
   - Real task enters Glassbox
   - Task shape on canvas
   - Change artifact on canvas (path utils.js, kind modify)
   - Test result on canvas (exitCode 0)
   - Final result on canvas (completed)
   - Full canvas (task + artifact + test + result)
   - Inspector file path (select artifact, see utils.js)
   - Inspector change kind (modify)
   - Inspector backed by trace facts
   - Steer creates explicit new turn
   - action.steer in trace
   - Decisions surfaced not auto-answered
5. If a criterion fails, curl-diagnose (GET /state, /trace) before re-running the e2e; do NOT blind-loop the e2e.

## Scope and safety
- Modify apps/web only (e2e, and apps/web/src/routes/index.tsx or inspector if the artifact shape text is missing). Do not modify apps/server (server is verified), AGENTS.md, README, .plans, or Notion.
- Controlled workspace /tmp/glassbox-demo-repo is the only writable target. Do not let codex write the user real filesystem or the Glassbox repo.
- Session data under <repo>/.glassbox/. Do not touch ~/.glassbox/.
- Kill only processes you start, by PID. Do not use fuser -k or pkill. Follow AGENTS.md. Relative /api and /ws only.

## When done
Print: the e2e shape-read fix, the .first.fill fix, the assertion text alignment, the 12/12 e2e result, and a screenshot path.
