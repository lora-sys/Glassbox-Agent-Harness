# Glassbox

Glassbox is evolving from a local Coding Agent workbench into a durable Personal Agent workbench with explicit identity, strict authorization, persistent Conversations, inspectable execution, learning, assets, and evals.

The product has one durable Personal Agent. Workbench, WeChat, QQ, email, and future integrations are entry points to that Agent, not separate Agents.

Glassbox should help people use the Agent, understand what it did, and verify why it was allowed to do it.

## What makes Glassbox special?

### 1. Authorization before intelligence

Permission is a server-side product invariant.

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

Unauthorized data must be filtered before model-visible Context is assembled. Never load private data, send it to a model, and rely on a Prompt telling the model not to reveal it.

Protected Tool execution rechecks current authorization at execution time.

Approval does not manufacture Permission.

### 2. One durable Personal Agent

Channel identity is not Agent identity.

Workbench, WeChat, QQ, email, API identities, and future Channels resolve a caller into a User / Principal that reaches the same Personal Agent.

Conversation is durable product state. Provider Session and Run are execution concepts underneath it.

Keep these boundaries clear:

```text
Channel ≠ Agent
Identity ≠ Authorization
Conversation ≠ Session
Session ≠ Run
Provider / Worker ≠ Personal Agent
```

### 3. Researchable by default

Glassbox should preserve enough evidence to answer:

- Who was acting?
- What was that Principal allowed to see or do?
- What Context actually reached the Agent?
- Which Tool or Provider executed?
- What changed during the Run?
- Why was an operation allowed, denied, or sent for approval?
- Which result came from which configuration and evidence?

Editing, projection, compression, or a newer reducer must not erase what an active or completed Run actually used.

### 4. Agent-native, not provider-specific

Glassbox connects to existing Agent runtimes and specialist workers instead of forcing every provider into one behavior.

Codex, Claude Code, OpenHarness, AGY, and future systems may expose different tools, lifecycle controls, context behavior, permission modes, and events.

Keep provider-specific behavior close to the provider integration.

Share only the concepts Glassbox actually needs.

Never copy an upstream trust model blindly. Glassbox authorization rules win.

### 5. Canvas-native, but Canvas is a projection

Canvas remains a powerful workspace and inspection surface. It is not execution state and it is not the whole product.

Moving, connecting, grouping, resizing, or annotating Canvas Objects must not silently change Agent execution or authorization.

Do not turn every raw event into a Canvas Object.

Keep normal whiteboard behavior useful, but preserve this boundary:

```text
Raw Trace
→ Derived State
→ Canvas Objects
→ tldraw projection
```

### 6. Performance and efficiency without compromising trust

Treat measured regressions as bugs.

Watch for broad rerenders, huge live payloads, unbounded event history projections, repeated retrieval, oversized Tool results, unnecessary model Context, and duplicated work.

Later efficiency work may use context budgets, Tool-result projection, hybrid retrieval, smart routing, semantic cache, and model-tier selection.

Those mechanisms may reduce cost or increase capability. They may never widen authority, hide evidence, or bypass authorization.

## Project owner note

When a requirement is ambiguous, choose the smaller implementation that preserves the product rules in this file.

Do not silently expand the task.

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

`.plans/roadmap.md` records sequencing, not permission to implement future phases.

Current P3 scope is deliberately narrow:

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

P3 may use fake Channels, fake protected Tools, deterministic fixtures, and disposable persistence to prove the boundary.

Until P3 passes its completion gate, do not make real WeChat, QQ, Mail, Calendar, AGY, LongTask, Eval, Arena, Skill evolution, full Memory consolidation, vector retrieval, semantic cache, smart routing, or serverless deployment a dependency of the implementation.

Product history and future ideas belong in `README.md`, `.plans/roadmap.md`, `docs/`, or research notes. Current implementation scope belongs in the active plan.

If the current task conflicts with a stable rule in this file, stop and ask before breaking the rule.

## A small glossary

Use these terms consistently.

- **you** means the coding Agent reading this file and changing Glassbox.
- **we**, **us**, and **maintainers** mean the people building and maintaining Glassbox.
- **user** means a person known to Glassbox.
- **principal** means the effective actor used for an authorization decision.
- **channel identity** means an external identity such as Workbench account, WeChat ID, QQ ID, email identity, or future integration identity.
- **agent** means the durable Personal Agent product identity unless a provider-specific context clearly means an external Agent runtime.
- **provider** means an external model / Agent runtime integration such as Codex or Claude Code.
- **worker** means delegated specialist execution such as future AGY-style background work.
- **resource** means protected data or capability addressed by authorization.
- **action** means an explicit operation on a Resource or execution state.
- **conversation** means the durable relationship / thread between a Principal and the Personal Agent.
- **session** means provider or runtime execution context. It is not the Conversation.
- **run** means one concrete Agent execution.
- **raw trace** means append-only execution evidence.
- **derived state** means Glassbox's current interpretation of evidence for product behavior.
- **authorization decision** means inspectable evidence of an `ALLOW`, `DENY`, or `REQUIRES_APPROVAL` result.
- **approval** means explicit human authorization for a policy path that already permits approval. It is not Permission.
- **memory** means promoted durable knowledge. It is not raw Conversation history.
- **skill** means a reusable validated procedure or capability description.
- **asset** means a durable output with provenance, lineage, or version identity.
- **canvas** means the interactive tldraw workspace and projection surface.
- **canvas object** means something shown on Canvas because it helps the user understand, inspect, edit, or act on work.
- **artifact** means a durable output such as a file, diff, document, image, webpage, dataset, or generated design.
- **inspector** means contextual detail UI for a selected object or execution record.

Keep these distinctions clear:

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

Do not reuse one identifier for multiple concepts merely because the current implementation is local or single-user.

## The easiest ways to hurt this project

1. **Authorizing after private data is loaded.** Permission filtering happens before protected Context, retrieval results, Worker payloads, Tool results, caches, or projections reach an unauthorized caller or model.

2. **Creating a confused deputy.** External messages, email, webpages, documents, MCP results, Agent outputs, Worker outputs, retrieved text, and future game environments are untrusted input. They cannot borrow broader Owner authority.

3. **Letting stale authority survive.** A stale Conversation, cached UI permission, old Context, resumed Run, or future LongTask must not preserve a revoked grant.

4. **Escalating through delegation.** Future delegation must satisfy:

```text
worker_permissions ⊆ delegated_permissions ⊆ caller_permissions
```

5. **Rewriting evidence.** Never alter Raw Trace or execution-relevant history so an old Run appears to have used newer state.

6. **Making Canvas the source of truth.** tldraw records are a view. Core Agent, Conversation, Permission, Run, Trace, Memory, Skill, and Asset state must not depend on Canvas layout.

7. **Designing for imaginary future systems.** Do not build roadmap features because they sound inevitable. The active plan decides implementation scope.

8. **Writing to live user state.** Never run tests, migrations, cleanup, fixtures, or test Agents against the user's real Personal Agent state or real writable repositories.

9. **Doing a half toolchain migration.** `package.json`, lockfile, Vite, Vitest, and Vite+ must describe one coherent toolchain after migration.

## Explicit execution semantics

Edit freely. Execute explicitly.

Only named Actions may change execution or authorization state.

Examples include:

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

Layout changes, notes, grouping, arrows, or Canvas movement do not implicitly execute anything.

The UI must make draft state, applied state, permission state, and running state truthful.

If an execution-relevant value changes during a Run, preserve enough information to reconstruct what the Run started with and when the new value took effect.

## Preserve evidence

Raw Trace is evidence. Derived State is interpretation.

Do not rewrite Raw Trace to match a newer UI model or reducer.

Authorization decisions, approvals, delegation, Run lifecycle, and later learning promotion must remain traceable to underlying evidence.

A denial record explains why access was denied without copying denied private contents.

Context compression and Tool-result projection may reduce model-facing data later. They do not delete Raw Trace evidence.

Measurements and judgments are different. Token counts, tool calls, duration, file changes, and exit codes are measurements. Eval scores, LLM judgments, and human review are judgments. Do not merge them into a fake universal score.

## Check every affected path

Before calling a change done, check the parts that apply.

- **Identity.** Confirm who the caller resolves to and that identity binding does not grant permission by itself.
- **Authorization.** Check allow, deny, approval, revoke, and stale-state paths.
- **Context.** Verify denied Resource contents never enter model-visible Context.
- **Tools.** Protected Tool calls re-authorize at execution time.
- **Conversation / Session / Run.** Preserve the correct lifetime and identity for each.
- **Persistence.** Decide what survives refresh, reconnect, restart, and database reopen.
- **Trace.** Verify evidence is useful without leaking protected payloads.
- **Provider behavior.** Define what happens when a Provider does not support a capability.
- **Contracts.** When cross-boundary state changes, check every producer and consumer.
- **Canvas projection.** Check both Glassbox state and visible tldraw behavior where relevant.
- **Reverse states.** Grant / Revoke, start / stop, apply / edit, approve / consume, and similar paired states need explicit behavior.
- **Toolchain.** Keep workspace config, package manifests, lockfile, test runner, lint, and format behavior coherent.
- **Docs.** Update the active plan or stable docs when a settled boundary changes.

## Dev servers

Document and run only commands that exist in the current repository.

Glassbox has selected **Vite+** as the unified JavaScript / TypeScript toolchain direction. Read `docs/tech-stack.md` before changing it.

The intended command surface after the verified migration is:

```text
vp install
vp dev
vp build
vp check
vp test
vp run <task>
```

Vite+ is expected to unify Vite / Rolldown, Vitest, Oxlint, Oxfmt, and workspace task execution.

Playwright remains the browser / E2E layer.

`apps/server` remains a Node.js runtime. Do not turn it into a Vite dev server merely because Vite+ is the toolchain.

Until the Vite+ dependency migration is actually verified and committed, inspect the repository scripts and use the commands that exist. Do not pretend planned commands are already repository reality.

Do not introduce a second ESLint / Prettier / ad-hoc check stack unless a demonstrated compatibility gap requires it.

Do not hardcode localhost origins into client code. Development clients use relative `/api` and `/ws` boundaries through the dev server.

Stop only processes you started or processes you verified belong to the current development instance.

## Test data

Never use live Personal Agent state as writable test state.

Use repo-local, temporary, or otherwise disposable state.

For Plan 03, prefer one deterministic fixture containing:

```text
one Agent
Owner
Visitor
one public Resource
one Owner-private Resource
one public Tool
one Owner-only Tool
Grant / Revoke
restart
AuthorizationDecision + Run evidence
```

That fixture may be reused by automated tests, local acceptance UI, examples, and later documentation demos.

Reading or copying real data for debugging is acceptable when required. Write only to a safe copy.

> Copy in. Never point in. Never write back.

Use realistic fixtures when empty state or tiny mocks would hide the behavior being tested.

## Verifying

Prove the change with the smallest useful check.

Behavior changes need focused tests for the behavior that changed.

Plan 03 authorization coverage should include the relevant subset of:

```text
default deny
explicit allow
requires approval
cross-user read
private / public isolation
identity spoof attempt
identity binding does not grant authority
revocation
stale authorization state
confused deputy
protected Tool call
approval replay
restart and resume
denial Trace redaction
```

Persistence tests use disposable Turso databases.

Async tests wait on real completion signals or state transitions. Do not hide races with arbitrary sleeps when a real signal exists.

Run browser-level verification when behavior depends on real tldraw interaction, selection, drag and drop, visual state, or browser APIs.

After the Vite+ migration is complete, `vp check`, `vp test`, and `vp build` become the preferred broad toolchain checks. Before that migration lands, use the repository commands that actually exist.

Do not launch unrelated browsers, providers, external processes, or broad live-provider suites unless the task requires them.

## Pull requests

Do not create a Pull Request unless the user asks for one.

Commit directly to `main` after a verified slice is complete unless the user requests a branch or PR workflow.

Keep one main concern per change.

Use existing commit conventions. Do not invent a new convention inside one task.

For user-visible UI changes, include visual verification when practical. A short recording is useful when motion, timing, drag and drop, or a multi-step interaction is the point of the change.

Treat automated review findings as claims to verify against the source. Fix real issues; do not change code merely to satisfy an incorrect bot comment.

## How it works

The long-term trusted path is:

```text
Channel / Workbench
        ↓
Identity Resolution
        ↓
Principal + Conversation
        ↓
Authorization
        ↓
Authorized Context
        ↓
Personal Agent
        ↓
Authorized Tool / Provider / Worker
        ↓
Run
        ↓
Raw Trace + Authorization Evidence
        ↓
Derived State
        ↓
Memory / Skills / Assets / Journal
        ↓
Timeline / Canvas / Inspector
```

Execution or authorization changes travel through explicit Actions:

```text
User / Agent intent
        ↓
Named Action
        ↓
Authorization
        ↓
Runtime / Provider / Persistence
        ↓
Evidence
```

Plan 03 proves only this smaller vertical slice:

```text
Identity
→ Authorization
→ Conversation
→ Turso persistence
→ Run / Authorization Trace
```

Keep these rules true even if the internal implementation changes:

- one durable Personal Agent is shared across Channels
- identity resolution and authorization are separate
- unauthorized data is excluded before Context assembly
- protected Tool calls re-authorize
- revocation takes effect on the next protected operation
- Conversation is not Provider Session or Run
- Raw Trace and Derived State are separate
- Canvas is not execution state
- future Worker authority only shrinks
- routing, retrieval, caching, and token optimization never widen authority

Do not document a layer as implemented until it actually exists.

## Where code lives

Follow the current repository structure.

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

`apps/server` owns the current Runtime, HTTP, WebSocket, Provider adapters, Session lifecycle, Trace, screening, and new server-side Personal Agent boundaries.

Plan 03 may add focused modules near this code such as:

```text
auth/
identity/
conversation/
persistence/
```

These names are guidance, not mandatory architecture.

`apps/web` owns React, tldraw, Workbench interaction, Canvas projection, and Inspector behavior.

`packages/contracts` contains only contracts with a real cross-boundary producer and consumer.

`packages/shared` stays small and runtime-independent.

Keep provider-specific behavior near Provider integration.

Keep Channel protocol behavior near Channel integration.

Keep tldraw-specific behavior near Canvas projection and interaction.

Keep authorization enforcement in server-side boundaries that UI and adapters cannot bypass.

Do not create speculative packages merely to mirror `.plans/roadmap.md`.

## Taste

Use the smallest abstraction that solves the current problem.

Do not add systems the active plan does not need.

Prefer explicit state transitions over inferred magic.

Prefer deny-path correctness over UI polish when working on authorization.

The UI must not lie. A visible Grant means server authorization grants it. A Deny means protected data never reached the model-visible path. Waiting means durable waiting state exists. Delegated means a real Worker Job exists. Success means the underlying work finished.

Reuse mature code when it already solves the problem well.

Before inventing a standard mechanism, inspect relevant upstream work. Important references include:

```text
pingdotgg/t3code
  Provider integration, Claude Code permissions, resume

HKUDS/OpenHarness
  Agent loop, tools, memory, permissions, channels, QQ

TokenRhythm/opensquilla
  context budgets, Tool-result budgets, hybrid retrieval, routing, token efficiency

openfga/openfga
  relation-based authorization

tursodatabase/turso
  structured durable state

joyehuang/trajectory-panel
  Trace, timeline, redaction, Turso sync

UKGovernmentBEIS/inspect_ai
  Eval

temporalio/sdk-typescript
  durable LongTask semantics
```

Vendored or adapted upstream code records source repository, pinned commit, license, original path, and reason. Preserve copyright, license, NOTICE, and third-party provenance requirements.

Keep provider quirks out of generic product state.

Keep tldraw quirks out of core Agent state.

Prefer inferred TypeScript types when the compiler already knows the type. Avoid `any`. Validate unknown external data at system boundaries.

Comments explain intent, trust boundaries, provenance, or non-obvious behavior. Do not narrate obvious code.

Do not grow the task while fixing it. Record adjacent work instead.

## Additional tips

Use current project tools and upstream patterns before adding a dependency or service.

The documentation site is a Learning Lab as well as reference documentation. Concept pages should distinguish `Implemented`, `Experimental`, and `Planned` rather than presenting roadmap features as current reality.

Interactive demos should use deterministic synthetic data and mirror real domain semantics when those semantics exist. Do not build a second fake authorization model only for docs.

Memory, retrieval, routing, Mail, Calendar, Workers, LongTask, Eval, Skill evolution, Asset Library, Arena, and serverless execution are future consumers of the foundation. Do not pull them into P3 unless a tiny fake is required to prove a P3 invariant.

OpenSquilla is a post-foundation efficiency reference, not a reason to implement routing or vector retrieval during P3.

Research notes, future ideas, rejected alternatives, and open product questions belong outside this file.

If a rule here becomes wrong because the product changed, update the rule. Do not work around it silently.
