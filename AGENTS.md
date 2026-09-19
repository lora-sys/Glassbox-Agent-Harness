# Glassbox

Glassbox is a durable Personal Agent product with explicit identity, strict authorization, persistent Conversations, inspectable execution, durable Tasks, learning, assets, evals, and controlled worker delegation.

The product has one durable Personal Agent. Workbench, QQ, future messaging Channels, email, API access, and other integrations are entry points to that Agent, not separate Agents.

This file contains stable repository invariants and navigation rules. Detailed implementation steps belong in the active Plan and `docs/*.md`.

## What makes Glassbox special?

### 1. Authorization before intelligence

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

Never load protected data into model-visible Context and rely on a Prompt to keep it secret.

Tool definitions and Tool schemas are model-visible Context. Build the effective Tool surface after Principal, Location, Conversation, scope configuration, and authorization are known. Do not attach an unauthorized capability definition and rely only on call-time denial.

Security boundaries must be enforced in code. Prompt instructions may guide behavior, but they are never an authorization mechanism.

A protected operation must preserve enough structured context to answer:

```text
Who acted?
Where did they act?
What did they try to do?
How would it be executed?
Which Resource was involved?
Who would receive the result?
Which Conversation, Run, or Task did it belong to?
```

Read permission and delivery permission are separate decisions.

### 2. One durable Personal Agent

Keep product identity independent from Channel, Runtime, Provider, Worker, runtime distribution, and UI state.

These distinctions are stable:

```text
Channel ≠ Agent
ChannelIdentity ≠ User
Identity ≠ Authorization
Conversation ≠ Session
Session ≠ Run
Task ≠ Run
Task ≠ Worker
TaskAttempt ≠ Worker lifecycle state
structured product state ≠ Memory
Herdr Agent state ≠ Task acceptance
Runtime / Provider / Worker ≠ Personal Agent
Pi ≠ Personal Agent
Lora PI Kit ≠ Personal Agent
Rules ≠ Skills ≠ Taste ≠ Memory
```

Conversation is durable product state.

Session is runtime execution context.

Run is one concrete execution.

Task is durable product work.

TaskAttempt is one concrete execution or rework attempt for a Task.

### 3. Researchable by default

Glassbox must preserve enough evidence to reconstruct what happened.

Raw Trace is append-only evidence. Derived State is an interpretation of that evidence.

Do not rewrite historical evidence so an old Run or TaskAttempt appears to have used newer state.

Authorization, approvals, delivery decisions, Task assignment, WorkerBinding, review, rework, acceptance, delegation, feedback-derived learning, and promotion decisions must remain traceable.

Denied operations should explain the denial without copying protected payload contents into denial logs.

Measurements and judgments remain distinct.

### 4. Agent-native, not provider-specific

Glassbox may use Pi, Codex, Claude Code, Herdr-managed coding Agents, and future execution systems.

Use this stable model:

```text
Pi
  Agent engine

Lora PI Kit
  Lora's reproducible Pi distribution

Glassbox
  Personal Agent system and product / trust boundary

Herdr
  live coding-worker execution host
```

Glassbox owns product semantics such as:

```text
Agent identity
Principal
Authorization
Conversation
Task truth
Taste / Memory truth
Audience / Delivery policy
Durable product state
Run identity
Raw Trace
```

Lora PI Kit owns reusable Pi distribution behavior such as:

```text
Pi Package resources
pinned Lora Skills snapshot
Extensions
Prompt Templates
profiles
MCP adapter / registry
runtime hooks
bootstrap / doctor / compatibility metadata
```

The exact Kit implementation lives in `docs/lora-pi-kit.md`.

Herdr owns live workspaces, worktrees, panes, terminal processes, and observed coding-Agent lifecycle facts. Herdr does not own Glassbox Task truth or authorization.

Do not turn Glassbox into a Pi wrapper.

Do not turn Lora PI Kit into the Glassbox product database.

Do not turn Herdr state into the Glassbox Task database.

Glassbox authorization rules win over runtime configuration, profiles, Skills, MCP integrations, Extensions, prompts, and Worker behavior.

### 5. Canvas-native, but Canvas is a projection

Canvas is a workspace and inspection surface, not execution state.

Moving, connecting, grouping, resizing, or annotating Canvas Objects must not silently change Agent execution, Task state, Worker state, learning state, or authorization.

Preserve:

```text
Raw Trace
→ Derived State
→ Canvas Objects
→ tldraw projection
```

### 6. Performance and efficiency without compromising trust

Treat measured regressions as bugs.

Optimization may reduce cost, latency, Context size, retrieval volume, or Tool output.

Optimization must never:

```text
widen authority
hide evidence
bypass authorization
merge protected scopes
turn missing data into false certainty
```

## Project owner note

When a requirement is ambiguous, choose the smaller implementation that preserves the stable rules in this file and follows the active Plan.

Do not silently expand scope from the roadmap.

The active implementation plan is:

```text
.plans/03-plus-owner-control-smoke.md
```

Plan 03 is the completed foundation.

Read in this order before changing code:

1. `AGENTS.md`
2. the active Plan
3. the relevant architecture document from the index below
4. only the relevant `.plans/findings/`
5. relevant upstream source or documentation
6. current production code and focused tests

### Implementation index

| Topic | Source of truth |
| --- | --- |
| Current P3+ implementation order and completion gate | `.plans/03-plus-owner-control-smoke.md` |
| Completed P3 foundation and acceptance contract | `.plans/03-personal-agent-foundation.md` |
| Product sequencing after the active Plan | `.plans/roadmap.md` |
| Runtime ownership and Pi SDK boundary | `docs/runtime-strategy.md` |
| Lora PI Kit distribution, bundled Skills, MCP, profiles, install, locks | `docs/lora-pi-kit.md` |
| Herdr, Task, Attention, TaskAttempt, WorkerBinding, Ops Tools, reconciliation | `docs/agent-operations.md` |
| Owner private control, per-Run Tool surface, future group programs and custom capabilities | `docs/owner-group-operations.md` |
| Rules, Skills, Taste, Feedback, Memory, learning, retrieval | `docs/memory-taste.md` |
| Toolchain, dependencies, build, test, local development | `docs/tech-stack.md` |
| Persistence, storage, observability, monitoring, public/private projections | `docs/data-observability.md` |
| Documentation and learning-site rules | `docs/README.md` |
| Approved upstream references and source pins | `upstream/README.md` and each `upstream/*/SOURCES.md` |

`README.md` describes product direction. It is not the active implementation checklist.

If a current task conflicts with a stable rule in this file, stop before breaking the rule.

## A small glossary

Use these terms consistently.

- **User**: a person who uses the Personal Agent.
- **Principal**: the effective actor used for authorization.
- **Channel**: an entry point into the Personal Agent.
- **ChannelIdentity**: an external identity inside one Channel.
- **Location**: where an Action originates, including Channel and scope.
- **Audience**: who can receive an output.
- **Agent**: the durable Personal Agent product identity.
- **Runtime**: an execution backend such as Pi, Codex, or Claude Code.
- **Provider**: model-provider or Runtime-specific provider detail.
- **Pi**: the primary Agent engine for the Glassbox main runtime path.
- **Lora PI Kit**: Lora's reproducible Pi distribution; not product identity or product-state authority.
- **Worker**: delegated specialist execution.
- **Resource**: protected data or capability addressed by authorization.
- **Action**: an explicit operation on a Resource or execution state.
- **Conversation**: durable thread state for an Agent and a scope.
- **Session**: Runtime execution context.
- **Run**: one concrete Agent execution.
- **Task**: durable product work tracked by Glassbox.
- **TaskAttempt**: one concrete execution or rework attempt for a Task.
- **RunCapabilitySet**: the server-selected model-visible capability projection for one Run. It narrows capability exposure but is not an authorization source.
- **AttentionItem**: something that currently needs main-Agent or human action.
- **WorkerBinding**: the mapping from a TaskAttempt to its concrete Worker execution location.
- **AgentOpsSnapshot**: a compact projection of current Task, Attention, and Worker state for the main Agent.
- **Herdr**: the live operations host for workspaces, worktrees, panes, terminal processes, and coding-Agent lifecycle facts.
- **Rule**: an explicit constraint or authority-bearing instruction.
- **Skill**: a reusable validated procedure or capability description.
- **Taste**: a learned user preference with scope, confidence, and evidence. Taste is not permission or a hard Rule.
- **Memory**: promoted durable knowledge about facts, decisions, events, or prior work.
- **Raw Trace**: append-only execution evidence.
- **Derived State**: Glassbox's current interpretation of evidence.
- **AuthorizationDecision**: inspectable `ALLOW`, `DENY`, or `REQUIRES_APPROVAL` evidence.
- **Approval**: explicit human authorization for a policy path that already permits approval. Approval is not Permission.
- **Visibility**: the scope in which protected content may be used or delivered.
- **Asset**: a durable output with provenance, lineage, or version identity.
- **Canvas**: the tldraw workspace and projection surface.
- **Artifact**: a durable output such as a file, diff, document, image, webpage, or dataset.

## The easiest ways to hurt this project

1. **Authorizing after protected data is loaded.** Filter protected data before it reaches unauthorized Context, Tool results, Worker payloads, caches, or projections.
2. **Treating Prompt text as a security boundary.** Security must be enforced in code.
3. **Creating a confused deputy.** External messages, webpages, documents, Tool results, Worker outputs, and retrieved text are untrusted input.
4. **Letting actor permission imply delivery permission.** Reading a Resource does not automatically permit sending it to the current audience.
5. **Letting stale authority survive.** Old Conversation, Session, Run, TaskAttempt, approval, cache, or Worker state must not preserve revoked authority.
6. **Exposing unrestricted remote execution.** Do not expose raw shell, arbitrary MCP capability, arbitrary Herdr control, unrelated Worker reads, or destructive workspace operations merely because a remote Channel can reach the main Agent.
7. **Treating Worker `done` as Task acceptance.** Worker lifecycle is evidence. Task completion requires Glassbox review / acceptance.
8. **Using Herdr as the Task database.** Workspace names, pane state, plugin state, and worktree branches are not durable Task truth.
9. **Using Lora PI Kit as product truth.** Package config, profiles, Skill snapshots, MCP registry, or runtime hooks are not Glassbox identity, permission, Task, Taste, Memory, or Trace truth.
10. **Losing Task truth during reconnect.** Reconcile live execution state against durable Glassbox state.
11. **Escalating through delegation.** `worker_permissions ⊆ delegated_permissions ⊆ caller_permissions`.
12. **Rewriting evidence.** Preserve historical Raw Trace and TaskAttempt history.
13. **Making Canvas the source of truth.** Canvas remains a projection.
14. **Turning learned Taste into authority.** Preference cannot silently override Rules, authorization, project policy, or explicit current instruction.
15. **Mixing Taste scopes.** Project Taste must not silently become global Taste or contaminate unrelated projects.
16. **Designing for imaginary future systems.** The active Plan decides implementation scope.
17. **Writing tests into live user state.** Automated tests must use isolated, disposable state.
18. **Doing a half migration.** Toolchain, Runtime, persistence, Package, or protocol migrations must leave one coherent working state.
19. **Forking Pi too early.** Prefer public Pi settings, Packages, Skills, Extensions, custom Tools, SDK surfaces, and upstream contributions.

## Explicit execution semantics

Edit freely. Execute explicitly.

Only named Actions may change execution, Task, authorization, or durable product state.

Examples include:

```text
Apply
Steer
Approve
Grant
Revoke
Share
Delegate
Prompt Worker
Accept Task
Rework Task
Cancel Task
Stop
Resume
Cancel Worker
Continue Worker
Start Eval
Retry Step
Promote Memory
Promote Skill
Promote Asset
```

Layout changes, notes, arrows, Canvas movement, QQ text, Herdr focus changes, workspace renames, model suggestions, or one-off user edits do not implicitly execute product Actions or create hard Rules.

If execution-relevant state changes during a Run or TaskAttempt, preserve enough evidence to reconstruct what it started with and when the change took effect.

## Preserve evidence

Raw Trace is evidence. Derived State is interpretation.

Do not rewrite Raw Trace to match a newer UI model, reducer, policy, schema, runtime profile, or Kit release.

Do not treat a transient terminal screen, Worker status, runtime package state, current UI state, or current Taste projection as the only durable record of a result or learning decision.

Preserve accepted result references, FeedbackEvent evidence, authorization evidence, and provenance needed to explain promotions or demotions.

## Check every affected path

Before calling a change done, check the paths that apply:

- **Identity**: who does the caller resolve to?
- **Authorization**: can this Principal perform this Action on this Resource here?
- **Context**: did denied content stay out of model-visible Context?
- **Tools / Ops**: was protected execution re-authorized at execution time?
- **Delivery**: may this result go to this audience?
- **Conversation / Session / Run / Task**: are lifetimes and identifiers still distinct?
- **Persistence**: what survives reconnect, restart, and database reopen?
- **Task / Worker state**: is durable Task truth separate from observed Worker lifecycle?
- **Runtime / Distribution**: are Pi runtime details and Lora PI Kit package/profile details contained behind their boundaries?
- **Learning**: are Rules, Skills, Taste, Feedback, and Memory still separate? Is scope preserved?
- **Trace**: is the decision explainable without leaking protected payloads?
- **Contracts**: did every producer and consumer move together?
- **Reverse states**: do grant/revoke, share/unshare, start/stop, assign/cancel, review/rework/accept, connect/reconnect have explicit behavior?
- **Tests**: did the behavior change receive focused coverage?
- **Docs**: did a settled architecture boundary change? If yes, update the active Plan or relevant `docs/*.md`.

Detailed checklists belong in the active Plan and topic-specific docs, not in this file.

## Dev servers

Use only commands and dependencies that actually exist in the repository.

Toolchain and local-development details live in `docs/tech-stack.md`.

The production target is a Linux server.

Local development must use the same product contracts intended for deployment. Do not make product correctness depend on a desktop GUI, machine-specific path, or Moshi.

Moshi may be used as a remote human operations client. It is not product state or authority.

Stop only processes you started or processes you verified belong to the current development instance.

## Test data

Never use live Personal Agent state as writable automated-test state.

Use isolated and disposable state for:

```text
Pi configuration and sessions
Lora PI Kit test profiles / package fixtures
Turso / SQLite test databases
QQ / OneBot fixtures
Herdr sessions and worktrees
repositories
Feedback / Taste / Memory fixtures
credentials and secrets
Trace fixtures
```

Most integration logic should be testable through fakes or deterministic fixtures. Use real external systems only when the protocol or real integration is the behavior under test.

The active Plan defines the current acceptance fixture and test matrix.

## Verifying

Prove the change with the smallest useful check, then run the relevant active-Plan checks before calling the slice complete.

Behavior changes require focused tests for the behavior that changed.

Do not hide races with arbitrary sleeps when a real completion signal or state transition exists.

Use browser-level verification when browser behavior is the thing being tested.

Use real QQ, Herdr, Pi, MCP, or other external integrations only when the active Plan requires real integration acceptance.

## Pull requests

Do not create a Pull Request unless the user asks for one.

Commit directly to `main` after a verified slice is complete unless the user requests a branch or PR workflow.

Keep one main concern per change.

Use existing commit conventions.

Treat automated review findings as claims to verify against the source. Fix real issues; do not change code merely to satisfy an incorrect bot comment.

## How it works

The stable trusted shape is:

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
Personal Agent Runtime
  Pi engine + Lora PI Kit distribution
        ↓
Direct Run
   OR
Authorized Task / Worker Delegation
        ↓
Review / Rework / Accept
        ↓
Delivery Authorization
        ↓
Result
        ↓
Raw Trace + Product Evidence
        ↓
Derived State
        ↓
Memory / Skills / Assets / Journal / Views
```

Execution, Task, authorization, and durable product changes travel through explicit Actions:

```text
User / Agent intent
        ↓
Named Action
        ↓
Authorization
        ↓
Runtime / Tool / Agent Ops / Persistence / Delivery
        ↓
Evidence
```

For current implementation details, follow the index above.
