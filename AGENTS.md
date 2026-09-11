# Glassbox Agent Instructions

Glassbox is evolving from a local Coding Agent workbench into a durable Personal Agent workbench with strict authorization, persistent Conversations, inspectable execution, long-running work, learning, assets, and evals.

The repository still contains working Coding Agent infrastructure from the earlier phase. Preserve it while introducing the Personal Agent foundation in small verified slices.

## Start here

The only active implementation plan is:

`/.plans/03-personal-agent-foundation.md`

Read in this order before changing code:

1. `AGENTS.md`
2. `.plans/03-personal-agent-foundation.md`
3. `docs/tech-stack.md` when changing tooling, dependencies, build, test, lint, format, or package management
4. only the relevant `.plans/findings/`
5. relevant upstream source or documentation
6. current production code and focused tests

`README.md` defines product direction.

`AGENTS.md` defines stable engineering, trust, and delivery rules.

The active plan defines current scope.

`.plans/roadmap.md` is sequencing, not permission to implement future phases.

Do not implement future roadmap features merely because README or docs describe them.

## Current implementation target

Plan 03 is deliberately narrow:

```text
Identity
  ↓
Authorization
  ↓
Conversation
  ↓
Turso persistence
  ↓
Run / Authorization Trace
```

Until Plan 03's completion gate passes, do not make real WeChat, QQ, Mail, Calendar, AGY, LongTask, Eval, Arena, Skill evolution, full Memory consolidation, smart routing, semantic cache, or vector retrieval a dependency of the implementation.

Use fake Channels, fake protected Tools, deterministic fixtures, and disposable persistence where they prove the boundary faster and more safely.

## Toolchain

Glassbox has selected **Vite+** as the unified JavaScript / TypeScript toolchain direction.

The intended command surface after the verified migration is:

```text
vp install
vp dev
vp build
vp check
vp test
vp run <task>
```

Vite+ owns the preferred frontend / TypeScript toolchain surface around Vite, Rolldown, Vitest, Oxlint, Oxfmt, and workspace task execution.

Rules:

- read `docs/tech-stack.md` before changing the toolchain
- use `vp check` as the default static check after migration
- use `vp test` for Vitest tests after migration
- use `vp run <task>` for repository scripts and non-built-in workspace tasks
- Playwright remains the browser / E2E layer
- `apps/server` remains a Node.js runtime; Vite+ does not require turning it into a Vite dev server
- do not add parallel ESLint / Prettier / ad-hoc check stacks unless a real compatibility gap requires them
- keep Vite, Vitest, Vite+ and the lockfile aligned in one migration slice

Do not perform a half migration where `package.json` and `package-lock.json` describe different toolchains.

Until the Vite+ dependency migration is verified and committed, existing npm / Vite commands remain valid repository reality.

## Product boundary

The long-term product has one durable Personal Agent.

Workbench, WeChat, QQ, email, and other integrations are entry points to that Agent. They are not separate Agents.

Codex, Claude Code, OpenHarness, AGY, and similar systems are providers, workers, or specialist execution capabilities. They are not the Personal Agent identity.

Canvas is an inspection and workspace view. It is not execution state and it is not the whole product.

Target direction:

```text
Channel / Workbench
        ↓
Identity Resolution
        ↓
Authorization
        ↓
Conversation + Personal Agent
        ↓
Skill / Tool / Provider / Worker / LongTask / Eval
        ↓
       Run
        ↓
 Raw Trace + Derived State
        ↓
Experience Mining
        ↓
Memory / Skills / Assets / Journal
        ↓
Timeline / Canvas / Inspector
```

## P0: authorization comes before intelligence

The Personal Agent must not cross permission boundaries.

Never rely on model behavior, a system prompt, hidden UI, an upstream provider permission mode, a vector database filter performed too late, or a cache key alone as the primary protection for private resources.

Authorization is a server-side product invariant.

Every protected operation reduces to:

```text
Principal × Resource × Action × Context → Decision
```

Decision is exactly one of:

```text
ALLOW
DENY
REQUIRES_APPROVAL
```

No matching grant means `DENY`.

### Identity is not authorization

Resolve who is acting before loading protected data or executing a protected Tool.

A Workbench account, WeChat ID, QQ ID, email address, API identity, or Worker identity does not grant permission merely because it resolves to a known user.

Identity binding and authorization are separate trusted operations.

### Authorize before context assembly

Required order:

```text
Incoming Request
      ↓
Resolve Principal
      ↓
Authorization Check
      ↓
Load Authorized Data Only
      ↓
Authorized Context Builder
      ↓
Model / Agent Runtime
```

Unauthorized data must not appear in prompts, retrieval results, Worker payloads, model-visible traces, denial reasons, Tool results, caches, or projections for that request.

### Recheck protected Tool execution

A Tool visible in the UI or present in a Skill is not automatically authorized.

Re-evaluate authorization at execution time using the current Principal and current grant state.

A stale Conversation, cached UI permission, old Context, resumed Run, or future LongTask must not preserve revoked authority.

### Prevent confused-deputy escalation

Treat messages, email, webpages, documents, MCP results, Agent outputs, Worker outputs, retrieved text, and game environments as untrusted input.

An untrusted caller cannot instruct the Personal Agent to borrow broader Owner authority.

### Delegation can only reduce authority

Future Worker delegation must satisfy:

```text
worker_permissions ⊆ delegated_permissions ⊆ caller_permissions
```

### Approval is not permission

Approval cannot manufacture authority for a Principal that had no valid authorization path.

Keep requester, approver, Resource, Action, consumed approval, Conversation, Run, and future LongTask linkage auditable.

### Authorization is evidence

Important decisions should produce inspectable `AuthorizationDecision` evidence.

A denial log explains the decision without copying protected contents.

## Core domain distinctions

Keep these boundaries explicit:

```text
Identity ≠ Authorization
Permission ≠ Approval
Channel ≠ Agent
Conversation ≠ Session
Session ≠ Run
LongTask ≠ Run
WorkerJob ≠ LongTask
Provider / Worker ≠ Personal Agent
Event ≠ Canvas Object
Asset ≠ Canvas Object
Canvas ≠ Execution State
Raw Trace ≠ Derived State
Edit ≠ Apply
```

Do not reuse one identifier for multiple concepts merely because the first implementation is local or single-user.

Only introduce future domain objects when the active plan needs them.

## Raw Trace and Derived State

Raw Trace is evidence.

Do not rewrite history to fit a newer UI or reducer interpretation.

Derived State may evolve as Glassbox learns to interpret traces better.

Authorization decisions, approvals, delegation, Run lifecycle, and later learning promotion remain traceable to underlying evidence.

Do not dump protected payloads into Trace merely to make debugging convenient.

Context compression and Tool-result projection may reduce model-facing data later. They must not delete Raw Trace evidence.

## Explicit execution

Edit freely. Execute explicitly.

Only named Actions change execution or authorization state.

Examples:

```text
Apply
Steer
Approve
Grant
Revoke
Stop
Resume
Delegate
Cancel Worker
Continue Worker
Start Eval
Retry Step
Promote Memory
Promote Skill
Promote Asset
```

Moving, connecting, grouping, resizing, or annotating Canvas Objects never grants permission or changes a running Agent implicitly.

## Current code boundaries

Follow the actual repository structure:

```text
apps/
  server/
  web/
    e2e/

packages/
  contracts/
  shared/

.plans/
  03-personal-agent-foundation.md
  roadmap.md
  findings/

docs/
  README.md
  tech-stack.md
  interactive-demos.md

assets/
  readme/

upstream/
  t3-code/
  opensquilla/
```

`apps/server` owns the current Runtime, HTTP, WebSocket, Provider adapters, Session lifecycle, Trace, screening, and Derived State.

Plan 03 should initially add server-side boundaries near this code. Reasonable module names include:

```text
auth/
identity/
conversation/
persistence/
```

These names are guidance, not mandatory architecture.

`apps/web` owns React, tldraw, Canvas projection, Inspector, and user interaction.

`packages/contracts` contains only contracts with a real cross-boundary producer and consumer.

`packages/shared` stays small and runtime-independent.

Do not create speculative packages merely to mirror the roadmap.

Keep Provider-specific behavior near Provider integration.

Keep Worker-specific behavior near Worker integration.

Keep Channel protocol behavior near Channel integration.

Keep tldraw-specific behavior in web projection and rendering.

Keep authorization enforcement in server-side boundaries that UI and adapters cannot bypass.

## Persistence and Turso

Plan 03 introduces Turso for structured durable state.

Start with only the records required by the plan, such as:

```text
agents
users
channel_identities
conversations
relationships
permissions or authorization tuples
authorization_decisions
```

Raw Trace remains separate append-only evidence unless a later concrete plan changes that decision.

Do not give the model unrestricted SQL access.

Expose narrow Domain APIs and authorize before reading or writing protected state.

Migrations and tests use disposable databases.

## Channels

Real remote channels are not part of Plan 03.

Use a fake Visitor entry to prove identity, Conversation isolation, and authorization first.

When real channels arrive, normalize them before the Agent Core.

Never put QQ, WeChat, Telegram, Discord, or other protocol quirks into the Personal Agent core.

## Memory, retrieval, routing, and learning

These are roadmap consumers of the foundation, not Plan 03 dependencies.

Stable rules already apply:

- Memory is not raw Conversation history
- private sources produce private candidates by default
- permission filtering happens before protected retrieval reaches model-visible results
- routing may choose cost / capability policy but may not widen authority
- semantic caches must be permission-scoped
- automatic learning never widens visibility or capability
- one successful Run is evidence for a Skill Candidate, not automatic permanent promotion
- promoted Memory, Skill, and Asset preserve provenance
- Journal is a user-readable reflection artifact, not private chain-of-thought storage

## Upstream-first development

Before inventing a standard mechanism, inspect the relevant upstream first.

Primary references include:

```text
pingdotgg/t3code
  Provider integration, Claude Code adapter, permissions, resume

HKUDS/OpenHarness
  Agent loop, tools, skills, memory, permissions, channels, QQ

TokenRhythm/opensquilla
  Context budgets, Tool-result budgets, hybrid retrieval, routing, token efficiency

keli-wen/agy-staff
  Worker delegation and background jobs

joyehuang/trajectory-panel
  trajectory parsing, timeline, redaction, Turso sync

UKGovernmentBEIS/inspect_ai
  eval tasks, datasets, scorers, experiment execution

temporalio/sdk-typescript
  durable workflows, retry, signals, continuation

tursodatabase/turso
  structured durable state

openfga/openfga
  relation-based fine-grained authorization
```

Vendoring rules:

- copy only files relevant to a real current problem
- record source repository, commit SHA, license, original path, and reason
- preserve copyright, license, and notice requirements
- keep vendored reference code isolated from runtime imports
- prefer proven mechanisms over rewrites made only to own more code
- never copy an upstream trust model blindly; Glassbox authorization rules win

## Documentation and Learning Lab

`docs/` is a public learning surface, not a substitute for implementation evidence.

Every feature page must distinguish:

```text
Implemented
Experimental
Planned
```

Interactive demos use deterministic synthetic fixtures unless a specific integration guide requires otherwise.

Documentation demos should reuse real domain semantics where practical. Do not invent a second authorization or Conversation model just to make a demo easier.

## Tests

`apps/web/e2e/` contains regression tests from the Coding Agent phase.

Some require live Providers, pre-generated sessions, historical fixtures, or environment assumptions. They are not the default first check for Plan 03.

New Plan 03 tests should prefer fake Channels, fake Tools, disposable Turso databases, and deterministic authorization fixtures.

Never use machine-specific absolute paths in new tests.

Never use live Personal Agent state, real user data, live channels, production credentials, or a real repository as writable test state.

> Copy in. Never point in. Never write back.

At minimum, relevant Plan 03 authorization tests cover:

```text
default deny
explicit allow
requires approval
cross-user read
private/public resource isolation
identity spoof attempt
identity binding does not grant authority
revocation
stale permission state
confused deputy
protected Tool call
approval replay
restart and resume
denial trace redaction
```

Async tests wait for real state transitions or completion signals. Do not hide races with arbitrary sleeps when a real signal exists.

## Performance

Treat measured regressions as bugs.

Do not project every raw event onto Canvas.

Avoid broad React rerenders, unbounded DOM growth, huge live payloads, and full-history recomputation on every event.

Optimize measured bottlenecks, not imaginary future ones.

## Delivery

Commit directly to `main` as soon as a verified slice is complete unless the user asks for a branch or Pull Request workflow.

Do not accumulate unrelated changes.

One slice has one main concern.

Update the active plan when implementation evidence changes its status or assumptions.

Do not use completed plan files as scratchpads. Git already preserves history.

Open a Pull Request only when the user asks.

A toolchain migration is complete only when dependency manifests, lockfile, commands, config, and focused checks agree.

## Taste

Use the smallest model and smallest abstraction that solve the current problem.

Prefer explicit state transitions over inferred magic.

Prefer deny-path correctness over UI polish when working on authorization.

The UI must not lie. A visible grant means server authorization grants it. A denial means protected data never reached the model. Waiting means durable waiting state exists. Delegated means a real Worker Job exists. Success means underlying work finished.

Validate unknown external data at system boundaries.

Avoid `any` when TypeScript can express the boundary.

Comments explain intent, trust boundaries, provenance, or non-obvious behavior.

If this file conflicts with actual product direction, update the rule instead of silently working around it.
