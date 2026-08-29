# Task: S8b — Fix S8 to 12/12 using the diagnosis

Diagnosis done: state.task is set correctly, state.finalResult is set. The demo task was "list files" (read-only), so state.artifacts is empty (no file changes fired). The failures are: (a) the demo task does not produce a file-change artifact, and (b) the e2e reads shapes the wrong way and has a .first.fill Playwright bug.

## Fix plan
1. Change the demo task prompt to a fix-the-bug task: "fix the bug in utils.js so the tests pass". The controlled workspace /tmp/glassbox-demo-repo has a buggy utils.js and a failing test.js. Running this task must make codex edit utils.js.
2. Verify with curl (no browser first): POST the fix-bug demo task, poll GET /state/:sessionId until finalResult is set or 60s, confirm state.artifacts is non-empty (item/fileChange fired) and state.finalResult is completed. If codex requests a file-change approval, confirm the /decide endpoint records it. Print the derivedState artifacts array.
3. Fix apps/web/e2e/s8.spec.mjs to read shapes via page.evaluate reading the tldraw editor store (the same method the S3-S6 e2e used; those passed). Do not use page.locator to find text on a tldraw canvas (text renders on a canvas, not the DOM).
4. Fix the .first.fill -> .first().fill Playwright bug and audit other locator calls.
5. If an approval request appears during the e2e, wait for it and click Approve (calls /decide) so the file change proceeds.
6. Align e2e assertion texts with the real buildBoardObjects output: task shape "Task: <text>", turn shape "Turn 1 (task) ... completed ... duration", artifact shape whatever the projector emits. Assert the real texts.
7. Run apps/web/e2e/s8.spec.mjs once. All 12 criteria should pass. If not, curl-diagnose again; do NOT blind-loop the e2e.

## Scope and safety
- Modify apps/server/src (demo task prompt, run endpoint), apps/web (e2e, projector if needed), apps/web/src/routes/index.tsx if the artifact shape is missing. Do not modify AGENTS.md, README, .plans, or Notion.
- Controlled workspace /tmp/glassbox-demo-repo is the only writable target (writableRoots exactly that path). Do not let codex write the user real filesystem or the Glassbox repo.
- Session data under <repo>/.glassbox/. Do not touch ~/.glassbox/.
- Kill only processes you start, by PID. Do not use fuser -k or pkill (may hit processes you did not start). Follow AGENTS.md. Relative /api and /ws only.

## When done
Print: the fix-bug demo task, the curl artifacts confirmation, the e2e shape-read fix, the 12/12 e2e result, and a screenshot path.
