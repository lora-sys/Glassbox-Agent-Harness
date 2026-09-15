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

The workspace now uses Vite+ 0.3.1 with Vite 8.2.2 and Vitest 4.1.11. The managed runtime is Node.js 24.21.0 with npm 12.0.2. Installation, focused tests and Web builds have run through Vite+. The complete workspace format and lint gate is still open. The root Vite configuration enables both typeAware and typeCheck. See the [migration guide](https://viteplus.dev/guide/migrate) and [check guide](https://viteplus.dev/guide/check).

When migrating, follow the Vite+ migration path rather than hand-building an imitation of it. Keep Vite / Vitest resolution aligned with the local `vite-plus` toolchain and regenerate the lockfile in the same verified change.

## Runtime and language

```text
Node.js 24.21.0
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

The initial compatibility choice is the local file path of the libSQL client used by trajectory-panel, behind narrow domain APIs. Verify Windows transactions and database reopen before accepting the driver. Turso now also documents separate database, sync, and serverless packages; do not treat those engines and interfaces as interchangeable. Cloud sync is not enabled by this phase.

Raw Trace remains independent append-only evidence.

The model does not receive unrestricted SQL access.

## Agent execution

Current execution capability centers on PI-driven model provider integration with extensible API protocols and multi-model configuration; historical runtime adapters from the earlier coding-agent phase are isolated as evidence-only references.

Selected provider and Agent-loop implementations are copied into Glassbox-owned source modules, preserving provenance and licenses. Do not import upstream checkouts or depend on complete upstream framework packages as a substitute. Standard model SDKs and database drivers remain ordinary dependencies. Channels, model providers and execution adapters have separate capability contracts.

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

Future layers may use ideas from Temporal, Inspect AI, SkillClaw, CoEvoSkills, Voyager, Dagster, and other recorded upstream references.

The current QQ phase includes bounded deterministic Eval samples linked to Run and Trace, following Inspect AI semantics through the existing test executor. The full Eval platform and learning infrastructure remain deferred.

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
