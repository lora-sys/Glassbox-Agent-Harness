# Glassbox Technology Stack

Status: CURRENT DIRECTION

This file records the preferred technology stack and toolchain direction for Glassbox. It is not permission to add every listed technology before the active plan needs it.

For the complete cross-cutting data, storage, search, observability, analytics, and public Trace / Eval read model, see [`data-observability.md`](./data-observability.md).

For the execution-runtime ownership boundary between Glassbox, Pi, Lora PI Kit, Codex, and Claude Code, see [`runtime-strategy.md`](./runtime-strategy.md).

For the bidirectional Task / Attention / Herdr worker boundary, see [`agent-operations.md`](./agent-operations.md).

The current implementation source of truth is `.plans/03-personal-agent-foundation.md`.

## Toolchain

Glassbox standardizes on **Vite+** as the primary JavaScript / TypeScript development toolchain direction.

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

`apps/server` remains a Node.js runtime. Vite+ is the repository toolchain. It does not mean the server must become a Vite dev server.

Server processes may continue to use a focused runtime such as `tsx` when that is the smallest correct execution path. Run those commands through `vp run` once the migration is complete.

The production target is a Linux server. Local development must keep the same product contracts that will run there.

## Web application

```text
React 19
TanStack Router / TanStack Start where already used
tldraw
Vite+ / Vite / Rolldown
```

The Workbench is one product surface. Do not let frontend framework choices redefine Agent, Conversation, Task, Run, authorization, or durable state semantics.

The Owner is the only Web administrator. Public Web access is read-only and limited to explicitly published Trace or Eval projections. Public pages never become a second control plane.

## Testing and code quality

Preferred Vite+ surfaces:

```text
vp check   -> format + lint + type checks
vp test    -> Vitest
vp fmt     -> Oxfmt
vp lint    -> Oxlint
```

Playwright remains the browser / E2E layer where browser behavior is the thing being tested.

Plan 03 requires deterministic QQ / OneBot and Agent Operations test harnesses that do not depend on real QQ accounts, paid model quota, or the user's live Herdr workspaces.

Do not keep parallel ESLint / Prettier / ad-hoc TypeScript check stacks unless a concrete compatibility gap requires them.

## Persistence

Plan 03 introduces Turso / SQLite-compatible structured durable state behind a narrow server-side persistence boundary.

The selected cross-cutting storage model is:

```text
Turso
  structured durable state
  Agent / User / ChannelIdentity
  Conversation
  permissions / relationships
  authorization decisions
  approvals
  Run metadata
  message dedupe keys
  runtime session bindings
  visibility and Share metadata
  AttentionItem
  Task
  TaskAttempt
  WorkerBinding
  later lexical / vector search and analytics indexes

Cloudflare R2
  Raw Trace evidence
  large artifacts
  attachments
  archives
  backups

AgentMail
  later email transport and source objects

Glassbox server
  runtime execution
  authorization
  Channel adapters
  Task / Attention control plane
  Agent Operations reconciliation
  owner APIs
  public Trace / Eval APIs
```

Raw Trace remains independent append-only evidence.

Herdr workspace, pane, Agent, and plugin state are not the canonical Task database.

The model does not receive unrestricted SQL access.

The browser does not receive direct Turso, R2, or AgentMail credentials.

## Agent execution

Current execution capabilities include Codex and Claude Code adapters from the earlier Coding Agent phase.

Plan 03 makes Pi the primary Personal Agent runtime path:

```text
upstream Pi
    |
    v
Lora PI Kit
    |
    v
@earendil-works/pi-coding-agent SDK
    |
    v
Glassbox Runtime Boundary
```

Glassbox embeds Pi through the public SDK inside `apps/server`.

Primary Pi surfaces for P3 include:

```text
createAgentSession
createAgentSessionRuntime when replacement is required
ModelRuntime
SessionManager
DefaultResourceLoader
Extension API
customTools
session events
explicit agentDir
```

Lora PI Kit owns reusable Pi packages, extensions, selected Skills, prompts, runtime presets, observability hooks, and bootstrap tooling. It does not own Glassbox authorization, durable Conversation state, Task truth, QQ identity, audience policy, product identity, or Raw Trace truth.

The customization order is:

```text
Pi settings / project config
-> Pi package
-> Skill
-> Extension
-> custom Tool
-> Pi SDK integration
-> upstream contribution
-> small local Pi core patch only when a tested requirement cannot use public boundaries
```

RPC remains available upstream but is not the primary Plan 03 integration path.

Codex and Claude Code remain valid runtimes for compatibility, fallback, specialist execution, coding workers, and differential Eval while Pi becomes the primary Personal Agent path.

## Agent Operations

Plan 03 uses Herdr as the live execution host for coding workers.

The production boundary is:

```text
Glassbox Main Agent
        ↓
Attention Queue + Task Registry
        ↓
Glassbox Ops Tools
        ↓
HerdrBridge
        ↓
Herdr local socket API
        ↓
workspace / worktree / pane / coding Agent
        ↓
Herdr lifecycle events
        ↓
OpsReconciler
        ↓
TaskAttempt + WorkerBinding + Trace
```

Glassbox owns:

```text
Task
TaskAttempt
AttentionItem
WorkerBinding
AgentOpsSnapshot
priority
acceptance criteria
review
rework
acceptance
authorization
```

Herdr owns live execution facts:

```text
session
workspace
worktree
tab
pane
terminal process
recognized coding Agent
working / blocked / done / idle / unknown
live output
```

`Herdr agent = done` does not mean `Task = DONE`. Normal completion moves work to `REVIEW`; Glassbox or an authorized reviewer accepts it or requests rework.

For long-lived integration, prefer Herdr's public local socket protocol behind `HerdrBridge`. CLI wrappers are fine for one-shot scripts and diagnostics.

Bootstrap and reconnect use:

```text
events.subscribe
→ subscription acknowledgement
→ session.snapshot
→ reconcile durable WorkerBindings / TaskAttempts
→ process later events
```

After reconnect, snapshot and reconcile again.

`aorumbayev/herdr-workflows` may execute bounded linear stage recipes. It does not own durable Task truth or review/rework loops.

The main Agent receives explicit Ops Tools such as `ops_status`, `task_delegate`, `worker_read`, `worker_prompt`, `task_accept`, and `task_rework`. Do not expose unrestricted raw Herdr terminal control through QQ.

## QQ Channel

Plan 03 uses NapCat as the QQ protocol-side runtime and OneBot 11 as the application boundary.

```text
QQ
-> NapCat
-> OneBot 11
-> Glassbox QQ Channel Adapter
-> Identity / Conversation / Authorization
-> Pi SDK
-> direct answer or authorized Task delegation
-> Glassbox Delivery Gate
-> NapCat
-> QQ
```

QQ transport code belongs in Glassbox, not Lora PI Kit.

Initial P3 scope includes private messages, group messages, explicit group activation such as `@bot`, reply delivery, reconnect, health, message deduplication, and self-message loop prevention.

## Authorization

Authorization is server-side and default-deny.

The stable decision inputs must answer:

```text
Who
Where
What
How
Resource
Audience
Conversation
Run
```

Decision remains:

```text
ALLOW
DENY
REQUIRES_APPROVAL
```

Plan 03 enforces four hard gates:

```text
Ingress Gate
Context Gate
Tool Gate
Delivery Gate
```

No toolchain, framework, runtime, model router, Channel adapter, Herdr state, Herdr plugin, workflow recipe, vector database, cache, Pi Extension, Skill, or runtime profile may bypass these boundaries.

Unauthorized protected content is filtered before Pi model Context is assembled.

Protected Tools and Ops Actions are re-authorized immediately before execution.

Delivery is authorized separately from read access. An Owner being allowed to read a private resource does not make that resource safe to send into a QQ group.

The remote QQ Pi profile uses an explicit Tool allowlist. Generic unrestricted `bash`, `powershell`, raw Herdr pane input, arbitrary worktree deletion, and unrelated worker reads are not exposed as remote escape hatches in P3.

Delegation must satisfy:

```text
worker_permissions ⊆ delegated_permissions ⊆ caller_permissions
```

## Test environments

Plan 03 has deterministic tests plus real integration acceptance.

Deterministic automated tests use:

```text
Fake OneBot gateway
Fake Owner
Fake Visitor
Fake QQ group
Disposable Turso / SQLite database
isolated Pi agentDir
Lora PI Kit test preset
deterministic or recording model/provider
FakeHerdrBridge
deterministic Herdr event fixtures
synthetic protected resources
Raw Trace capture
```

Focused Herdr protocol tests use a dedicated disposable Herdr session and repository/worktree. They must not operate on the user's normal live Herdr workspaces.

Real acceptance uses:

```text
Bot QQ
Owner QQ
Visitor QQ
Test QQ group
NapCat
isolated Glassbox test database
isolated Pi agentDir
Lora PI Kit
Herdr dedicated test session
one disposable test repo / worktree
at least one real supported coding Agent
real model execution
```

Tests must never write to live Personal Agent state, normal `~/.pi/agent`, production Herdr workspaces, real writable user repositories, or production QQ session data.

## Local development and server deployment

The intended production host is:

```text
Linux server
  Glassbox server
  Pi SDK + Lora PI Kit
  NapCat
  Herdr session server
  coding Agents / worktrees
  Turso-compatible durable state
```

When Glassbox and Herdr run on the same host, use the local Herdr control boundary.

Human operators may attach over SSH. Moshi may be used as a remote Herdr client and monitoring surface, but Glassbox product correctness must not depend on Moshi, desktop GUI state, or Herdr sidebar presentation.

Do not hardcode developer-machine absolute paths as product semantics. Local testing and server deployment use the same `Task`, `TaskAttempt`, `AttentionItem`, `WorkerBinding`, `HerdrBridge`, authorization, reconciliation, and Trace contracts.

## Retrieval and efficiency

Hybrid retrieval, semantic cache, smart routing, aggressive Context budgets, TokenJuice-style Tool-result projection, and broader runtime optimization remain post-P3 work unless a minimal mechanism is required for the closed loops themselves.

The selected architecture keeps retrieval behind Glassbox-owned authorization boundaries and uses Turso as the default structured, lexical, and vector store.

Primary later mechanisms include:

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

`TokenRhythm/opensquilla` is a primary upstream reference for these later mechanisms.

When a mechanism is generic Pi workflow customization, prefer implementing it in Lora PI Kit. When it changes Glassbox product state, authorization, retrieval visibility, Task truth, audience policy, or evidence semantics, keep it in Glassbox.

## Observability and Eval

Product observability is a Glassbox feature, not an external dashboard dependency.

P3 must expose enough evidence to inspect:

```text
Channel / Principal / location
Conversation
Authorization decisions
model-visible Context metadata
Tool decisions
Run and runtime/session identity
token usage where available
Delivery decision
Attention counts
Task state
TaskAttempt history
WorkerBinding
Herdr observed worker state
review / rework / acceptance
reconciliation state
```

The main Agent should have a compact `AgentOpsSnapshot` instead of receiving every Task body on every turn.

OpenTelemetry, Langfuse, Inspect AI, Token Monitor, and Herdr lifecycle surfaces are reference models for trace structure, scores, analytics, runtime usage, and later Eval design. They are not alternative authorization sources.

Public observers may read only sanitized, explicitly published Trace or Eval snapshots.

## Long work, eval, and learning

The later LongTask phase extends the P3 Task / TaskAttempt / WorkerBinding foundation with dependency graphs, checkpoints, retry policy, signals, child tasks, continuations, leases, and stronger restart semantics.

Future layers may use ideas from Temporal, AGY, Inspect AI, SkillClaw, CoEvoSkills, Voyager, Dagster, and other recorded upstream references.

Do not introduce their full infrastructure until an active plan needs the concrete boundary.

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