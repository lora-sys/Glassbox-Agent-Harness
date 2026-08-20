# AGENTS template checklist

Use this before turning `AGENTS_TEMPLATE.md` into a project's `AGENTS.md`.

## Fill in

- project name and one-line description
- what the product does
- three to six project principles
- project glossary
- three concrete ways to damage the project
- real dev commands
- local development state path
- verification commands
- current architecture
- real repo paths

## Usually keep

- kill only processes you started
- never test against live user state
- check every supported entry point and reverse state
- use the smallest useful verification
- do not run the full repo by default
- wait for real async completion instead of sleeping
- do not create PRs without permission
- one concern per PR
- keep external quirks in adapters
- avoid abstractions for work that does not exist yet
- avoid `any`
- keep UI state truthful
- reuse mature implementations
- do not expand scope while fixing something

## Delete when it does not apply

- provider rules when there is no provider layer
- connection rules when the product is intentionally local-only
- screenshot rules when there is no UI
- browser verification for a CLI or library
- worktree state rules when the project stores no mutable local state
- pairing, tunnels, mobile, desktop, or hosted rules before those things exist

## Final pass

1. Search for `<` and `>` and remove every placeholder.
2. Delete rules for features that do not exist.
3. Delete duplicate rules.
4. Check that every path under `Where code lives` exists or is part of the current change.
5. Run every command you named, or verify it already exists in the project.
6. Match terminology to the code.
7. Read the file once as a coding agent. Every line should tell it what to know, do, or avoid.
