# Task: S3 finish — apps/web connect to real server + Playwright verification

The apps/server codex adapter initialize hang is fixed: POST /run-test now returns a real event summary in ~8s (15 events, agentMessage/delta, turn/completed). apps/web is built with a board projector that turns DerivedState into tldraw text shapes (task, currentWork, finalResult). But apps/web currently points at a mock server (vite proxy target 3032, apps/web/mock-server.mjs). Point it at the real server and verify end to end with a browser.

## Goal
apps/web talks to the real apps/server (port 3030). A Playwright check opens the page, clicks Run test, and asserts the task and final result appear on the Canvas. Keep iterating until it passes.

## Steps
1. apps/web/vite.config.ts: change the proxy target from 3032 to 3030 (the real apps/server). Both /api and /ws.
2. Delete apps/web/mock-server.mjs (no longer needed).
3. Make sure apps/web dev script does not start the mock server.
4. Fix any tldraw text-shape rendering issue so buildBoardObjects shapes actually appear. If editor.store.put with type:"text" does not render, use the correct tldraw v5 text shape API (e.g. createTextShape or the proper props including rich text). The goal is visible text on the canvas.
5. Write a Playwright script at apps/web/e2e/run.spec.ts (or .mjs). It should:
   - Launch chromium.
   - Start (or assume already started) apps/server on 3030 and apps/web dev on 5173. If you start them, capture the PIDs and kill them after.
   - Open the apps/web URL.
   - Click "Run test".
   - Wait up to 30s for the task text to appear on the canvas.
   - Wait up to 30s for the "Result:" text to appear (final result).
   - Assert both are visible (page.text or a locator).
   - If assertion fails, iterate on the implementation until it passes.
6. Do not change the Glassbox rule: spatial layout does not affect execution. The projector just places shapes at fixed positions.

## Verify (the browser check must pass)
- The task text "Task: say ready" appears on the canvas after clicking Run test.
- The "Result: completed" text appears after the turn finishes.
- Both are visible to Playwright.

## Scope and safety
- Only modify apps/web (vite.config.ts, delete mock-server.mjs, fix rendering, add e2e). Do not modify apps/server (already fixed), AGENTS.md, README, .plans.
- Codex turns use the server's readOnly sandbox + cwd /tmp/glassbox-codex-spike (already set in apps/server). Do not let codex write the user real filesystem.
- Do not touch ~/.glassbox/ or anything outside this repo.
- Kill only processes you started (dev servers, chromium), by PID.
- Follow AGENTS.md. Relative /api and /ws only.

## When done
Print: the proxy change, the rendering fix, the Playwright result (pass with assertion details), and how to run apps/server + apps/web together.
