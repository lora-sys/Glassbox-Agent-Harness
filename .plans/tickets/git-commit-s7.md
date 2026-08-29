# Task: git — commit S7 work (no push)

S7 (editable task with a send button) is done and browser-verified but not committed. Commit it now. Do NOT push.

## Rules
- Only commit apps/server and apps/web files this build touched. Do not revert unrelated changes. If the working tree has unrelated files, leave them.
- No interactive git. Use git add <paths> + git commit -m. No amend, no destructive commands.
- Conventional commit message.

## Steps
1. git status and git log --oneline -6. Commit the S7 changes: POST /send-task endpoint, action.send reducer case + trace record, Inspector draft field + Send button, e2e S7 test.
2. One commit is fine: feat(server,web): editable task with send action and draft marker (S7).
3. Run the quick apps/server tests before committing (npx tsx --test or the existing test script). Fix only your own code if red; do not force a commit over a red test.
4. Do NOT push. Stay on main.

## When done
Print: the commit hash + subject, what was left uncommitted, and confirm no push.
