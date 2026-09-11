# Glassbox Technology Stack

Status: CURRENT DIRECTION

This file records the preferred technology stack and toolchain direction for Glassbox. It is not permission to add every listed technology before the active plan needs it.

## Toolchain

Glassbox standardizes on **Vite+** as the primary JavaScript / TypeScript development toolchain.

Vite+ is the preferred command surface for:

```text
runtime / package-manager environment
install
workspace task execution
dev
build
format
lint
type check
test
staged checks
```

The intended developer interface is:

```bash
vp install
vp dev
vp build
vp check
vp test
vp run <task>
```

Use `vp run` for repository scripts and workspace tasks that are not Vite+ built-ins.

Vite+ currently unifies Vite, Rolldown, Vitest, Oxlint, Oxfmt, tsdown, and Vite Task behind the `vp` toolchain.

### Migration rule

Do not partially migrate the repository.

The Vite+ migration slice must update and verify together:

```text
package.json
package-lock.json
Vite configuration
Vitest resolution
workspace commands
README development instructions
AGENTS.md toolchain rules
CI when CI exists
```

Until that verified migration lands, existing npm / Vite scripts remain valid implementation reality even though Vite+ is the selected target toolchain.

When migrating, follow the Vite+ migration path rather than hand-building an imitation of it. Keep Vite / Vitest resolution aligned with the local `vite-plus` toolchain and regenerate the lockfile in the same verified change.

## Runtime and language

```text
Node.js 22+
TypeScript
ES modules
```

`apps/server` remains a Node.js runtime. Vite+ is the repository toolchain; it does not mean the server must become a Vite dev server.

Server processes may continue to use a focused runtime such as `tsx` when that is the smallest correct execution path. Run those commands through `vp run` once the migration is complete.

## Web application

```text
React 19
TanStack Router / TanStack Start where already used
tldraw
Vite+ / Vite / Rolldown
```

The Workbench is one product surface. Do not let frontend framework choices redefine Agent, Conversation, Run, authorization, or durable state semantics.

## Testing and code quality

Preferred Vite+ surfaces:

```text
vp check   → format + lint + type checks
vp test    → Vitest
vp fmt     → Oxfmt
vp lint    → Oxlint
```

Playwright remains the browser / E2E layer where browser behavior is the thing being tested.

Do not keep parallel ESLint / Prettier / ad-hoc TypeScript check stacks unless a concrete compatibility gap requires them.

## Persistence

Plan 03 introduces Turso / SQLite-compatible structured durable state behind a narrow server-side persistence boundary.

Raw Trace remains independent append-only evidence.

The model does not receive unrestricted SQL access.

## Agent execution

Current execution capabilities include Codex and Claude Code provider integrations from the earlier coding-agent phase.

Future workers and providers remain behind Glassbox-owned trust boundaries.

Provider or worker choice does not define Personal Agent identity.

## Authorization

Authorization is server-side and default-deny.

The stable trust model remains:

```text
Principal × Resource × Action × Context → Decision
```

No toolchain, framework, model router, channel adapter, vector database, or cache may bypass this boundary.

## Retrieval and efficiency

These are post-foundation layers, not Plan 03 dependencies.

Primary future mechanisms include:

```text
authorized hybrid retrieval
vector + lexical search
context budgets
tool-result budgets
tool-result projection
routing
thinking-depth selection
token estimation
permission-scoped semantic cache
```

`TokenRhythm/opensquilla` is a primary upstream reference for these mechanisms.

## Long work, eval, and learning

Future layers may use ideas from Temporal, AGY, Inspect AI, SkillClaw, CoEvoSkills, Voyager, Dagster, and other recorded upstream references.

Do not introduce their infrastructure until an active plan needs the concrete boundary.

## Documentation site

The documentation / Learning Lab is a separate product surface.

Do not choose its framework merely because the Workbench uses React. The future docs implementation should optimize for:

```text
content quality
MD / MDX-style authoring
fast static delivery
interactive concept demos
code and contract links
versionable documentation
low client-side cost
```

The docs stack should be selected when the documentation implementation plan starts.
