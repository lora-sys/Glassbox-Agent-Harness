# Task: S8 — Controlled real-task demo and P0 acceptance (browser-verified)

S0-S7 are done and committed. This is the P0 acceptance slice: run the full flow on a controlled real task and verify the P0 acceptance criteria.

## Glassbox rules
- Codex runs in a controlled workspace, never the user real filesystem.
- File-change decision requests stay surfaced to the user; the UI shows them and never answers them on the user's behalf automatically.
- The trace is append-only and reconstructs the run after reload.

## Goal
A controlled demo workspace at /tmp/glassbox-demo-repo holds a small repo with a known bug and a failing test. The user sends a task to fix it. Codex runs in that workspace (writable only inside /tmp/glassbox-demo-repo, no network). The full flow shows on the canvas: task, the file change as an artifact, the test result, the final result. The user can inspect the artifact, steer once, edit the task once, and reload to confirm the trace rebuilds. Playwright verifies the P0 acceptance criteria.

## Steps
1. Set up the controlled workspace at /tmp/glassbox-demo-repo: a tiny git repo with one JS file that has a small bug (for example an off-by-one or a wrong comparison) and a test that fails because of it. Initialize it as a git repo. This is a controlled fixture, not the Glassbox repo and not the user real filesystem.
2. apps/server: add a way to run a turn against a chosen workspace with a writableRoots limited to /tmp/glassbox-demo-repo and network off. Reuse the existing adapter. When the provider sends a file-change decision request, broadcast it over WS and let the UI show it. Do not answer it automatically; add a POST /decide endpoint that records the user's choice in the trace and forwards it to the provider.
3. apps/web: add a "Run demo task" entry (or a workspace picker) that sends the fix task to the controlled workspace. Show file-change decision requests on the canvas/inspector when they arrive, with a clear "needs your decision" look and Approve/Decline buttons that call /decide.
4. Run the full flow in a Playwright e2e at apps/web/e2e/s8.spec.mjs: send the fix task, when a decision request appears click Approve, wait for the file change artifact, the test result, and the final result. Open the inspector on the artifact and assert it shows the file path and a diff. Steer once with a new instruction (click Send). Edit the task once and Send. Reload and assert the whole run rebuilds from the trace, including the artifact, the test result, and the two turns.
5. Assert the P0 acceptance criteria: a real codex task enters Glassbox; the canvas shows task, work, artifact, test result, final result; the inspector is backed by trace facts; reload rebuilds; steering and edit are explicit actions; the trace is append-only; decision requests are surfaced not auto-answered.

## Scope and safety
- The controlled workspace is the only writable target for codex. writableRoots is exactly /tmp/glassbox-demo-repo. Do not let codex write the user real filesystem or the Glassbox repo.
- Do not touch the user real ~/.glassbox/. Session data stays under <repo>/.glassbox/.
- Modify apps/server and apps/web as needed. Do not modify AGENTS.md, README, .plans, or Notion.
- Kill only processes you started, by PID.
- Follow AGENTS.md. Relative /api and /ws only.

## When done
Print: the controlled workspace setup, the new server workspace support, the decision surfacing, the Playwright acceptance result (each P0 criterion pass/fail), and a screenshot path.
