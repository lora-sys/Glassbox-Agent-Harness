# Task: git — commit S2 through S6 work in logical groups (no push)

We built Glassbox slices S2-S6 but no commits exist yet. Commit the work now so progress is recorded. Do NOT push.

## Rules (from AGENTS.md and CLAUDE.md)
- Only commit files this build touched. Do NOT revert or discard any existing change you did not make. If the working tree has unrelated changes, leave them alone and commit only the Glassbox build files.
- No interactive git. Use `git add <specific paths>` + `git commit -m`. Inspect `git status` first; never `git add -A` blindly if there are unrelated changes.
- Never use destructive commands (reset --hard, checkout --). No `git commit --amend`.
- Conventional commit messages (feat/fix/test/chore) with a short scope. Short body.

## Steps
1. `git status` and `git log --oneline -10`. Identify files that belong to the Glassbox build: apps/server, apps/web, package.json, package-lock.json, .gitignore, .plans/ (only your own findings/tickets/plan edits). Leave unrelated files alone.
2. Commit in logical groups, for example:
   - feat(server): codex adapter, effect schema decode, raw trace store, derived state reducer, http+ws contract (S2)
   - feat(web): tldraw canvas projector + run/inspector (S3, S4)
   - feat(web): session reload from trace (S5)
   - feat(server,web): pause and steer actions with trace provenance (S6)
   - docs(plans): plan 01 execution status + findings
   Adjust grouping to what actually exists. One commit per logical unit is fine.
3. Run the quick test suites before committing if they are fast: apps/server tests, and apps/web e2e if quick. If a test fails, fix only your own code; do not force a commit over a red test.
4. Do NOT push. Do NOT create branches. Stay on the current branch.
5. Do NOT touch AGENTS.md, README.md, or any Notion page.

## Verify
- `git log --oneline` shows the new commits.
- `git status` shows only unrelated or intentionally-left files.

## When done
Print: the commit list (hashes + subjects), what was left uncommitted and why, and confirm no push happened.
