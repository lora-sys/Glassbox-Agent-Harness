# Task: S8b2 — Debug why the task shape does not project in the S8 e2e

Server is verified (curl shows state.task non-empty, state.artifacts non-empty, testResult passes, finalResult completed). The e2e reads shapes via the editor store correctly and .first().fill is already fixed. But when the e2e runs, the task/artifact/final-result shapes do not appear on the canvas, while the test-result shape does. Find and fix the projection gap.

## Likely root causes to check
1. The e2e fills a long prompt into the task input and clicks "Run demo". Does the Run-demo handler send that prompt to the server, or does /run-demo use a hardcoded default and ignore the input? If the turn runs without the prompt in its input, codex may not echo it, and state.task stays empty for that run (different from the curl run which used the server default).
2. Does the web client call applyDerivedState with the derived state from /run-demo and from WS derivedState messages? Check the Run-demo handler and the WS onmessage path.
3. Add a temporary console.log in buildBoardObjects and applyDerivedState, run the e2e once capturing console, and print what derivedState the web client receives and what shapes buildBoardObjects returns.

## Fix
- Make the Run-demo path send the e2e prompt so codex's turn echoes it and state.task is set; OR if state.task is empty for the e2e run, backfill it from a Glassbox action record (like action.steer) so the task shape projects.
- Ensure artifact, test, and final-result shapes all project for the e2e run.
- Run apps/web/e2e/s8.spec.mjs once; all 12 criteria should pass. If not, print the derivedState the web received and the shapes built, then fix; do NOT blind-loop.

## Scope and safety
- Modify apps/web and apps/server/src/index.ts (run-demo prompt) as needed. Do not modify AGENTS.md, README, .plans, or Notion.
- Controlled workspace /tmp/glassbox-demo-repo is the only writable target. Do not let codex write the user real filesystem or the Glassbox repo.
- Session data under <repo>/.glassbox/. Do not touch ~/.glassbox/.
- Kill only processes you start, by PID. Do not use fuser -k or pkill. Follow AGENTS.md. Relative /api and /ws only.

## When done
Print: the root cause, the fix, the 12/12 e2e result, and a screenshot path.
