# Task: S3 — apps/web skeleton: Vite+ + TanStack + tldraw + board projector (first UI slice, browser-verified)

S2 (apps/server runtime) is done: HTTP /run-test /trace /state, WS /ws, Codex adapter, Effect Schema decode, Raw Trace store, derived state reducer. Now build apps/web so a user can see Codex work on a Canvas. This is the first UI slice. You MUST verify with browser automation (Playwright) and keep iterating until the goal is reached.

## P0.2 verified stack
- vp v0.2.9 at /home/lora/.vite-plus/bin/vp.
- TanStack: @tanstack/react-start v1.168.x (NOT @tanstack/start). Scaffold npx @tanstack/cli@latest create. Peer deps vite>=7, react>=18/19.
- tldraw v5.3.2 on npm. Agent Starter Kit at github.com/tldraw/agent-template and templates/agent/ in tldraw/tldraw. Reuse patterns: TldrawAgent, Canvas/selection context, typed actions, streamed updates. Do not import the kit Cloudflare Worker layer.

## Goal
A running apps/web that shows a tldraw Canvas, connects to apps/server, and when the user triggers a test run, shows the task and final result as Canvas objects, updating live.

## Steps
1. Scaffold apps/web under the workspace. Use vp create or npx @tanstack/cli@latest create to get a Vite + TanStack react-start app. Add tldraw as a dependency. Wire it into the workspace package.json (apps/web). dev server runs on a port (read it from the dev output, do not hardcode).
2. A single page with a tldraw Editor (empty Canvas) plus a small control bar with a "Run test" button and a prompt input defaulting to "say ready".
3. Connect to apps/server: on "Run test", POST /run-test (or /run-stream), then open a WebSocket to ws://<server>/ws?sessionId=<id> and subscribe. Server pushes live decoded events and derived-state snapshots.
4. Board projector (minimal): turn the derived state into Canvas objects. For this slice, show at least: a text object for the task, and a text object for the final result (status + duration). Place them at fixed positions. This proves state to Canvas projection. Do NOT make spatial layout affect execution (Glassbox rule).
5. Live updates: as events arrive, update the objects. When turn/completed arrives, show final result.
6. The web client uses relative /api and /ws paths through the dev server proxy (do NOT hardcode localhost:3030 in the bundle; configure the Vite dev proxy to forward /api and /ws to apps/server on its port).

## Browser verification (REQUIRED, do not skip)
Use Playwright (install if needed: pnpm add -D playwright or npm i -D playwright, then npx playwright install chromium). Write a script that:
- Launches chromium.
- Opens the apps/web dev URL.
- Clicks "Run test".
- Waits for the task text object to appear on the Canvas.
- Waits for the final result text object to appear after the turn completes.
- Asserts both are visible.
If the assertion fails, iterate on the implementation until it passes. Do not declare done until the browser check passes.

## Scope and safety
- Only create files under apps/web and the workspace root package.json (add apps/web to workspaces). Do not modify AGENTS.md, README, .plans, or apps/server.
- Codex turns must use readOnly sandbox and cwd /tmp/glassbox-codex-spike or the server's existing safe cwd. Do not let codex write the user real filesystem.
- Do not touch the user real ~/.glassbox/ or anything outside this repository.
- Follow the repository AGENTS.md rules. Relative /api and /ws only, no hardcoded localhost in client bundle.

## When done
Print to stdout: the apps/web file tree, the dev URL, the Playwright verification result (pass/fail with the assertion details), and how to run apps/web and apps/server together.
