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

A Principal being allowed to read data does not imply that the data may be sent to the current audience.

### 2. One durable Personal Agent

Keep product identity independent from Channel, Runtime, Provider, Worker, and UI state.

These distinctions are stable:

```text
Channel ≠ Agent
ChannelIdentity ≠ User
Identity ≠ Authorization
Conversation ≠ Principal
Conversation ≠ Session
Session ≠ Run
Task ≠ Run
Task ≠ Worker
TaskAttempt ≠ Worker lifecycle state
Herdr Agent state ≠ Task acceptance
Actor permission ≠ Delivery permission
Runtime / Provider / Worker ≠ Personal Agent
Rules ≠ Skills ≠ Taste ≠ Memory
```

Conversation is durable product state.

Session is runtime execution context.

Run is one concrete execution.

Task is durable product work.

TaskAttempt is one concrete execution or rework attempt for a Task.

Rules are explicit constraints and authority-bearing instructions.

Skills are reusable validated procedures.

Taste is learned user preference and cannot override Rules, authorization, or product policy.

Memory is durable knowledge about facts, decisions, events, and prior work. It is not a generic bucket for Rules, Skills, or Taste.

Do not collapse these concepts because the current deployment is local, single-user, or uses only one Runtime.

### 3. Researchable by default

Glassbox must preserve enough evidence to reconstruct what happened.

Raw Trace is append-only evidence. Derived State is an interpretation of that evidence.

Do not rewrite historical execution evidence so an old Run or TaskAttempt appears to have used newer state.

Authorization, approvals, delivery decisions, Task assignment, WorkerBinding, review, rework, acceptance, delegation, feedback-derived learning, and promotion decisions must remain traceable.

Denied operations should record why they were denied without copying protected payload contents into denial logs.

Measurements and judgments remain distinct.

Examples of measurements:

```text
tokens
duration
tool calls
file changes
exit codes
message ids
worker state transitions
```

Examples of judgments:

```text
review decisions
eval scores
LLM judgments
human review
```

Do not collapse them into one fake universal score.

### 4. Agent-native, not provider-specific

Glassbox may use Pi, Codex, Claude Code, Herdr-managed coding Agents, and future execution systems.

Glassbox remains the product and trust boundary.

Runtime-specific behavior stays close to the corresponding integration.

Pi customization belongs in Lora PI Kit when it is reusable Pi workflow behavior.

Glassbox product semantics stay in Glassbox, including:

```text
Agent identity
Principal
Authorization
Conversation
Task truth
Taste and Memory truth
Audience / Delivery policy
Durable product state
Run identity
Raw Trace
```

Herdr owns live execution facts such as workspaces, worktrees, panes, terminal processes, and observed coding-Agent lifecycle state.

Herdr does not own Glassbox Task truth or authorization.

Lora PI Kit may bridge selected Taste, Memory, Rules, or Skills into Pi Runtime Context, but it is not the canonical store for Glassbox Taste or Memory.

Do not turn Glassbox into a Pi wrapper.

Do not turn Herdr state into the Glassbox Task database.

Do not copy an upstream trust model blindly. Glassbox authorization rules win.

### 5. Canvas-native, but Canvas is a projection

Canvas is a workspace and inspection surface, not execution state.

Moving, connecting, grouping, resizing, or annotating Canvas Objects must not silently change Agent execution, Task state, Worker state, learning state, or authorization.

Preserve this boundary:

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

The only active implementation plan is:

```text
.plans/03-personal-agent-foundation.md
```

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
| Current implementation order, slices, completion gate, acceptance matrix | `.plans/03-personal-agent-foundation.md` |
| Product sequencing after the active Plan | `.plans/roadmap.md` |
| Pi, Lora PI Kit, Runtime ownership, SDK boundary | `docs/runtime-strategy.md` |
| Herdr, Task, Attention, TaskAttempt, WorkerBinding, Ops Tools, reconciliation | `docs/agent-operations.md` |
| Rules, Skills, Taste, Feedback, Memory, learning, retrieval | `docs/memory-taste.md` |
| Toolchain, dependencies, build, test, local development | `docs/tech-stack.md` |
| Persistence, storage, observability, monitoring, public/private projections | `docs/data-observability.md` |
| Documentation and learning-site rules | `docs/README.md` |
| Approved upstream references and source pins | `upstream/README.md` and each `upstream/*/SOURCES.md` |

`README.md` describes the product direction. It is not the active implementation checklist.

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
- **Worker**: delegated specialist execution.
- **Resource**: protected data or capability addressed by authorization.
- **Action**: an explicit operation on a Resource or execution state.
- **Conversation**: durable thread state for an Agent and a scope.
- **Session**: Runtime execution context.
- **Run**: one concrete Agent execution.
- **Task**: durable product work tracked by Glassbox.
- **TaskAttempt**: one concrete execution or rework attempt for a Task.
- **AttentionItem**: something that currently needs main-Agent or human action.
- **WorkerBinding**: the mapping from a TaskAttempt to its concrete Worker execution location.
- **AgentOpsSnapshot**: a compact projection of current Task, Attention, and Worker state for the main Agent.
- **Herdr**: the live operations host for workspaces, worktrees, panes, terminal processes, and coding-Agent lifecycle facts.
- **Rule**: an explicit constraint or authority-bearing instruction.
- **Skill**: a reusable validated procedure or capability description.
- **Taste**: a learned user preference with scope, confidence, and evidence. Taste is not permission or a hard Rule.
- **Memory**: promoted durable knowledge about facts, decisions, events, or prior work; not raw Conversation history or Taste.
- **Raw Trace**: append-only execution evidence.
- **Derived State**: Glassbox's current interpretation of evidence.
- **AuthorizationDecision**: inspectable `ALLOW`, `DENY`, or `REQUIRES_APPROVAL` evidence.
- **Approval**: explicit human authorization for a policy path that already permits approval. Approval is not Permission.
- **Visibility**: the scope in which protected content may be used or delivered.
- **Asset**: a durable output with provenance, lineage, or version identity.
- **Canvas**: the tldraw workspace and projection surface.
- **Artifact**: a durable output such as a file, diff, document, image, webpage, or dataset.

Keep these distinctions clear:

```text
User ≠ Principal
ChannelIdentity ≠ User
ChannelIdentity ≠ Permission
Identity ≠ Authorization
Permission ≠ Approval
Conversation ≠ Session
Session ≠ Run
Task ≠ Run
Task ≠ Worker
TaskAttempt ≠ Worker lifecycle state
LongTask ≠ Task
Rules ≠ Skills
Skills ≠ Taste
Taste ≠ Memory
Memory ≠ Rules
Runtime / Provider / Worker ≠ Personal Agent
Canvas ≠ Execution State
Raw Trace ≠ Derived State
Edit ≠ Apply
```

## The easiest ways to hurt this project

1. **Authorizing after protected data is loaded.** Filter protected data before it reaches unauthorized Context, Tool results, Worker payloads, caches, or projections.

2. **Treating Prompt text as a security boundary.** Security must be enforced in code.

3. **Creating a confused deputy.** External messages, webpages, documents, Tool results, Worker outputs, and retrieved text are untrusted input and cannot borrow broader Owner authority.

4. **Letting actor permission imply delivery permission.** Reading a Resource does not automatically permit sending it to the current audience.

5. **Letting stale authority survive.** A stale Conversation, Session, Run, TaskAttempt, approval, cache, or Worker state must not preserve revoked authority.

6. **Exposing unrestricted remote execution.** Do not make raw shell, arbitrary Herdr control, unrelated Worker reads, or destructive workspace operations reachable merely because a remote Channel can talk to the main Agent.

7. **Treating Worker `done` as Task acceptance.** Worker lifecycle is evidence. Task completion requires the Glassbox review / acceptance path.

8. **Using Herdr as the Task database.** Workspace names, pane state, plugin state, and worktree branches are not durable Task truth.

9. **Losing Task truth during reconnect.** Reconcile live execution state against durable Glassbox state. Do not infer completion from a monitoring gap.

10. **Escalating through delegation.** Delegation must satisfy:

```text
worker_permissions ⊆ delegated_permissions ⊆ caller_permissions
```

11. **Rewriting evidence.** Preserve historical Raw Trace and TaskAttempt history.

12. **Making Canvas the source of truth.** Canvas remains a projection.

13. **Turning learned Taste into authority.** A repeated preference cannot silently override Rules, authorization, project policy, or a user's explicit current instruction.

14. **Mixing Taste scopes.** Project-specific Taste must not silently become global Taste or leak into unrelated projects.

15. **Designing for imaginary future systems.** The active Plan decides implementation scope.

16. **Writing tests into live user state.** Automated tests must use isolated, disposable state and must not mutate production QQ, Pi, Herdr, repositories, or Personal Agent data.

17. **Doing a half migration.** Toolchain, Runtime, persistence, or protocol migrations must leave one coherent working state.

18. **Forking Pi too early.** Prefer supported settings, packages, Skills, Extensions, custom Tools, ResourceLoader, SDK surfaces, and upstream contributions before maintaining a local core patch.

19. **Putting product authority into Lora PI Kit or Herdr.** Glassbox remains the authority for identity, permissions, Task truth, Taste / Memory truth, durable product state, and evidence.

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

Do not rewrite Raw Trace to match a newer UI model, reducer, policy, or schema.

Do not treat a transient terminal screen, Worker status, current UI state, or current Taste projection as the only durable record of a result or learning decision.

Preserve accepted result references, FeedbackEvent evidence, and the provenance needed to explain promotions or demotions.

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
- **Learning**: are Rules, Skills, Taste, Feedback, and Memory still separate? Is scope preserved?
- **Trace**: is the decision explainable without leaking protected payloads?
- **Runtime / Host integration**: are runtime-specific details contained behind their integration boundary?
- **Contracts**: did every producer and consumer move together?
- **Reverse states**: do grant/revoke, share/unshare, start/stop, assign/cancel, review/rework/accept, connect/reconnect have explicit behavior?
- **Tests**: did the behavior change receive focused coverage?
- **Docs**: did a settled architecture boundary change? If yes, update the active Plan or relevant `docs/*.md`.

Detailed checklists belong in the active Plan and the topic-specific docs, not in this file.

## Dev servers

Use only commands and dependencies that actually exist in the repository.

Toolchain and local-development details live in:

```text
docs/tech-stack.md
```

The production target is a Linux server.

Local development must use the same product contracts intended for deployment. Do not make product correctness depend on a desktop GUI, machine-specific path, or Moshi.

Moshi may be used later as a remote human operations client. It is not product state or authority.

Stop only processes you started or processes you verified belong to the current development instance.

## Test data

Never use live Personal Agent state as writable automated-test state.

Use isolated and disposable state for:

```text
Pi configuration and sessions
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

Use real QQ, Herdr, Pi, or other external integrations only when the active Plan requires real integration acceptance.

The exact current verification matrix lives in:

```text
.plans/03-personal-agent-foundation.md
```

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
Feedback / Taste / Memory learning
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

For the current concrete implementation path, read the active Plan and topic-specific docs from the index above.
