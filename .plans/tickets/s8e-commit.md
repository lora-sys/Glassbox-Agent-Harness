# Task: S8e — Verify suites green and commit the S8 work (no push)

The S8 e2e just passed 22/22 (see /tmp/s8-e2e-final2.log). Commit the S8 work now. Do NOT push.

## Steps
1. Run the server suite: npx vitest run apps/server/src --reporter=basic from the repo root. Expect 52 tests passing (2 integration tests may skip if codex is not on PATH under vitest). If a test fails, fix only what your own changes broke, then re-run.
2. Commit in logical groups (conventional messages), for example:
   - feat(server): S8 demo workspace runs, decision surfacing and /decide, trace store absolute path fix, WS approval catch-up, bounded interrupt waits, live derived-state broadcast
   - feat(web,e2e): S8 acceptance e2e with decision answering, steering and edit flows
   Adjust to what actually changed. Exclude test artifacts and generated files: test-results/, .vite/, .playwright-mcp/, screenshots, .plans/findings/_s8d* logs and progress files stay uncommitted (or commit the .plans tickets/ if earlier commits included .plans — match the existing pattern from commit 76b0c61).
3. git log --oneline to confirm. Do NOT push. Stay on main.

## Safety
- Stop only processes you start, by PID. Do not modify AGENTS.md, README, or Notion.

## When done
Print: vitest summary, commit hashes + subjects, and confirm no push.
