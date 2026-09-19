# Plan 03 — QQ Personal Agent Closed Loop

Status: ACTIVE

This is the only active implementation plan in the repository.

Detailed architecture lives in `docs/*.md`. This Plan owns implementation order, slice boundaries, and the completion gate.

## Goal

Ship the first genuinely usable Glassbox Personal Agent closed loop.

Plan 03 ends only when:

- real Owner and Visitor identities can use the same durable Personal Agent through QQ private chat and a test group;
- the main Agent runs through the Pi SDK with a real Lora PI Kit distribution loaded;
- protected Context, Tools / Ops Actions, and Delivery are enforced server-side;
- Conversation and product state survive restart;
- the main Agent can register and delegate real coding Tasks through Herdr;
- Herdr worker state is reconciled without replacing Glassbox Task truth;
- review / rework / acceptance work end to end;
- duplicate QQ events do not duplicate Runs or replies;
- enough evidence exists to explain every protected decision and Task lifecycle transition.

The acceptance sentence is:

> A real Owner and a real Visitor can talk to the same Glassbox Personal Agent through QQ. The main Agent executes through Pi + Lora PI Kit, keeps authorization and Conversation state durable, can delegate at least one real coding Task to Herdr, observes working / blocked / done, moves completed worker execution to review instead of silently accepting it, supports rework, survives restart and Herdr reconnect, and never leaks protected data across Principal or audience boundaries.

## Read these documents instead of duplicating them here

```text
AGENTS.md
  stable repository invariants

docs/runtime-strategy.md
  runtime ownership and Pi SDK boundary

docs/lora-pi-kit.md
  Lora PI Kit distribution, bundled Skills, MCP, profiles, install, locks

docs/agent-operations.md
  Herdr / Task / Attention / WorkerBinding / reconciliation

docs/tech-stack.md
  toolchain, testing and deployment stack

docs/data-observability.md
  persistence and observability ownership

docs/memory-taste.md
  later Rules / Skills / Taste / Memory learning boundary
```

## Closed loop A — Personal Agent

```text
QQ private / group message
        ↓
NapCat
        ↓
OneBot 11 Channel Adapter
        ↓
Ingress Gate
        ↓
Identity Resolver
        ↓
Conversation Resolver
        ↓
Authorization Engine
        ↓
Authorized Context Builder
        ↓
Pi SDK
        ↓
Pi session with Lora PI Kit profile
        ↓
Tool / Ops Gate
        ↓
Pi execution
        ↓
Delivery Gate
        ↓
QQ reply
        ↓
Turso durable state + Raw Trace
```

## Closed loop B — Agent Operations

```text
QQ / Workbench request
        ↓
Main Agent
        ↓
Attention Queue + Task Registry
        ↓
Authorized Ops Tools
        ↓
HerdrBridge
        ↓
Herdr workspace / worktree / pane / coding Agent
        ↓
Herdr events
        ↓
OpsReconciler
        ↓
TaskAttempt + WorkerBinding + AttentionItem
        ↓
Review
  ├─ ACCEPT → DONE
  └─ REWORK → next attempt
        ↓
Trace + completion notification
```

The loops share Principal, Authorization, Conversation, Run, Task, persistence, audience, and evidence boundaries.

## Runtime decision

Plan 03 embeds:

```text
@earendil-works/pi-coding-agent
```

directly inside the Glassbox Node.js server.

Use Pi public SDK surfaces first.

RPC is not the primary P3 integration path.

Do not fork Pi for behavior that settings, Pi Packages, Skills, Extensions, custom Tools, ResourceLoader configuration, SDK surfaces, or a small upstream contribution can implement.

Codex and Claude Code remain supported for regression, compatibility, specialist work, Herdr workers, and later differential Eval.

## Lora PI Kit decision

Lora PI Kit is Lora's reproducible Pi distribution.

It is not merely a loose config directory and is not a Pi fork.

P3.1 creates the separate repository:

```text
lora-sys/lora-pi-kit
```

The detailed design is owned by `docs/lora-pi-kit.md`.

The P3 architecture must already use the real distribution shape:

```text
Pi Package manifest
pinned bundled lora-sys/skills snapshot
runtime profiles
Pi Extensions
Prompt Templates
MCP adapter / registry boundary
Glassbox policy / trace / usage bridges
settings / model templates
install / doctor / sync-skills tooling
Pi + Skills compatibility locks
```

`lora-sys/skills` remains the canonical Skill source repository.

A Lora PI Kit release bundles a pinned Skill snapshot for reproducibility.

```text
canonical source
  lora-sys/skills

one Kit release
  pinned bundled Skill snapshot
```

Bundled does not mean every Skill is active on every task.

Profiles and task-level selection narrow the runtime set.

Lora PI Kit may provide MCP through a Pi Extension / Package layer because MCP is runtime integration behavior. It must not expose every configured MCP server on every profile.

Lora PI Kit is not the source of truth for:

```text
Glassbox identity
Authorization
Conversation
Task / Attention / WorkerBinding
Taste / Memory database
QQ transport
Delivery policy
Raw Trace evidence
```

## Role profiles

The same Kit may support several Pi roles:

```text
local-coding
main-agent
owner-direct
qq-group
herdr-worker
test
```

The same Kit does not make the roles the same identity.

```text
Glassbox main Personal Agent
≠
Herdr delegated Pi Worker
```

Remote profiles must expose a narrower Tool / MCP surface than normal local coding where necessary.

## Runtime state isolation

Glassbox-launched Pi instances should not write into the user's normal interactive Pi state by default.

Conceptually:

```text
Glassbox main runtime
Glassbox worker runtime
Glassbox test runtime
```

may use separate `agentDir` / session state while sharing the same pinned Lora PI Kit distribution.

Exact filesystem paths are implementation details.

## Security model

No security invariant depends on model obedience.

Authorization returns exactly one of:

```text
ALLOW
DENY
REQUIRES_APPROVAL
```

No matching grant means `DENY`.

Every protected decision must be explainable in terms of:

```text
Who
Where
What
How
Resource
Audience
Conversation
Run / Task when relevant
```

### Gate 1 — Ingress

Runs before Pi invocation.

Check at least:

```text
self message
ChannelIdentity
resolved User / Principal
private vs group scope
allowed group / identity
activation rule
duplicate event
permission to invoke the Agent here
```

Denied Ingress means no Pi Run.

### Gate 2 — Context

Unauthorized protected data must not enter model-visible Context.

Tool definitions, Tool schemas, MCP Tool schemas, and Ops Tool metadata are also model-visible Context when attached to a Run. Resolve the effective Tool surface only after Principal, Location, Conversation, and policy are known. A Principal must not receive definitions for capabilities it is not allowed to invoke.

Do not attach a global Tool catalog and rely only on call-time denial.

Forbidden:

```text
load private content
→ send to model
→ ask model not to reveal it
```

Required:

```text
resolve Principal / Conversation
→ authorize protected sources
→ load only allowed data
→ build Context
→ invoke runtime
```

### Gate 3 — Tool / Ops

Every protected Tool or Agent Ops Action re-authorizes immediately before execution.

Call-time authorization is the second check. The first check is Tool-surface construction before model invocation. Only the Tool definitions authorized for the current Run may be attached to the model-visible surface.

The existence of a Tool, Skill, Extension, MCP integration, Pi profile, or Herdr control surface does not grant permission to use it.

Remote QQ profiles must not expose unrestricted shell, arbitrary MCP capability, arbitrary Herdr pane input, unrelated Worker reads, or destructive workspace operations.

### Gate 4 — Delivery

Read permission does not imply delivery permission.

Results must be checked against the real audience before leaving Glassbox.

Owner-private information cannot be sent to a group merely because the Owner requested it there.

Worker output and Task results follow the same rule.

## Conversation model

Conversation is scope-based durable product state.

```text
Conversation
  id
  agentId
  channel
  scopeType
  scopeKey
```

Examples:

```text
QQ private
  scopeType = direct
  scopeKey = qq:user:<id>

QQ group
  scopeType = group
  scopeKey = qq:group:<id>
```

Every Run records the actual acting Principal even when the Conversation is shared by a group.

Keep these distinct:

```text
ChannelIdentity ≠ User
Conversation ≠ Principal
Conversation ≠ Pi Session
Pi Session ≠ Run
Task ≠ Run
Task ≠ Worker
TaskAttempt ≠ Herdr pane
Herdr state ≠ Task acceptance
Actor permission ≠ Delivery permission
```

## Agent Operations decision

Herdr is the live coding-worker execution layer.

Glassbox owns durable product truth:

```text
AttentionItem
Task
TaskAttempt
WorkerBinding
AgentOpsSnapshot
priority
acceptance criteria
review / rework / acceptance
authorization
```

Herdr owns observed execution facts:

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

```text
Herdr done
≠
Task DONE
```

A worker reaching `done` normally moves the active work to `REVIEW`.

Only an authorized Glassbox review / acceptance Action records Task completion.

Detailed integration rules live in `docs/agent-operations.md`.

## Main Agent Ops Tools

P3 minimum product surface includes concepts such as:

```text
ops_status
task_list
task_get
task_create
task_delegate
worker_status
worker_read
worker_prompt
task_accept
task_rework
task_cancel
```

These are Glassbox protected Actions, not raw terminal access.

## Herdr reconciliation invariant

For long-lived integration, use `HerdrBridge` and the public socket protocol.

Bootstrap / reconnect order:

```text
subscribe to events
→ receive subscription acknowledgement
→ request session.snapshot
→ reconcile snapshot with durable WorkerBinding / TaskAttempt state
→ process later events
```

A monitoring gap does not mean success or failure.

Herdr disconnect must not silently change Task truth.

## Durable state

P3 persists at least the structured product state required by both loops:

```text
agents
users
channel identities
conversations
relationships / permissions
authorization decisions
approvals when used
runs
message dedupe
runtime session bindings
visibility / Share metadata
attention items
tasks
task attempts
worker bindings
```

Raw Trace remains append-only evidence and may live outside the relational product model where appropriate.

## QQ Channel

NapCat is the selected QQ protocol-side runtime.

Glassbox owns the OneBot 11 application adapter.

P3 scope:

```text
private message
group message
explicit group activation such as @bot
private reply
group reply
health / reconnect
deduplication
self-message loop prevention
```

QQ transport stays in Glassbox and does not belong in Lora PI Kit.

## Local test → Linux server invariant

P3 is developed locally but targets a Linux server.

Target shape:

```text
Linux server
  Glassbox server
  Pi SDK
  pinned Lora PI Kit
  NapCat
  Herdr
  coding Workers / worktrees
  Turso-compatible durable state
```

Local and server environments must use the same product contracts.

Do not make product correctness depend on desktop GUI state, Moshi, machine-specific terminal windows, or hardcoded developer paths.

## Test environments

### Deterministic automated environment

Must work without real QQ accounts or paid model quota.

Use isolated substitutes such as:

```text
Fake OneBot Gateway
Fake Owner
Fake Visitor
Fake Group
Disposable Turso / SQLite
deterministic / recording model
isolated Pi runtime state
Lora PI Kit test profile
FakeHerdrBridge
synthetic protected resources
Raw Trace capture
```

Kit-focused P3 tests must verify:

```text
Pi Package loads
profile resolves
bundled Skills match skills.lock.json
required Extensions load
MCP adapter boundary loads without starting unrelated services
Pi compatibility metadata matches tested runtime
normal user Pi state is untouched
```

### Real integration acceptance

Use dedicated identities and disposable work:

```text
Bot QQ
Owner QQ
Visitor QQ
Test QQ group
NapCat
Glassbox
Pi SDK
pinned Lora PI Kit
isolated durable state
Herdr dedicated test session
one disposable repository / worktree
at least one supported coding Agent
real configured model
```

## Security canary

Keep one distinctive Owner-private value, for example:

```text
PRIVATE_CANARY_7F92A1
```

Attempt exfiltration through:

```text
Visitor private chat
Visitor group chat
Owner group chat
prompt injection
protected Tool
MCP-backed Tool
unauthorized worker_read
Worker output
stale authorization
revoked permission
cross-Conversation reuse
cross-group reuse
Delivery bypass
```

P3 fails if the canary appears in unauthorized model Context, Tool / Worker result, QQ output, public projection, or denial text.

## Implementation slices

### P3.0 — Test harness and contracts

Build deterministic fixtures first.

Define minimum product contracts for:

```text
Principal / Location / Audience
AuthorizationRequest / Decision
Conversation scope
Run
Visibility
Task
TaskAttempt
AttentionItem
WorkerBinding
```

Add Fake OneBot, disposable persistence, fake runtime/model injection, FakeHerdrBridge, Trace capture, and the private canary.

Completion:

> A trivial allow/deny and Task lifecycle pass without real QQ, Pi network calls, or Herdr.

### P3.1 — Lora PI Kit distribution MVP

Create `lora-sys/lora-pi-kit` using the architecture in `docs/lora-pi-kit.md`.

Required P3.1 deliverables:

```text
real Pi Package manifest
pinned bundled lora-sys/skills snapshot
skills.lock.json
Pi compatibility lock / metadata
main-agent profile
qq-group profile
herdr-worker profile
test profile
Glassbox policy bridge
trace / usage hooks
minimal MCP adapter / registry boundary
base Prompt Templates
settings / model templates
install
update or equivalent controlled upgrade path
doctor
sync-skills
```

At least one selected Skill must load from the bundled snapshot.

At least one minimal MCP adapter path must prove the Extension / profile boundary; it does not need a large catalog.

The test profile must not touch the user's normal Pi state.

Completion:

> A fresh compatible Pi environment can install/load the Kit, pass doctor, resolve the test profile, verify its locked Skill snapshot, load required Extensions, and run without an ad-hoc manual setup sequence.

### P3.2 — Pi SDK Runtime

Integrate Pi directly into `apps/server` behind a Glassbox-owned adapter.

Requirements:

```text
create / restore Pi session
Conversation ↔ runtime-session binding without equating them
normalized Pi events
output / usage metadata
abort
explicit runtime state / agentDir
load pinned Lora PI Kit
select runtime profile
explicit Tool surface
```

Completion:

> Deterministic Glassbox tests run one prompt through the Pi SDK with the Kit test profile and receive normalized Run events.

### P3.3 — Four hard authorization gates

Implement Ingress, Context, Tool / Ops, and Delivery authorization.

Prove default deny, explicit allow, approval path, revocation, audience checks, protected Ops Tools, and model-visible Tool schema filtering.

Completion:

> Canary attacks fail closed before live QQ integration exists.

### P3.4 — Conversation and Turso durability

Implement scope-based Conversation and durable product state.

Prove:

```text
Owner private isolation
Visitor private isolation
shared group Conversation with per-Run Principal
restart / reopen
grant / revoke persistence
safe runtime-session recreation
Task / Attention / Attempt / Binding persistence
no stale authorization after restart
```

### P3.5 — Herdr Agent Operations Foundation

Implement the contracts in `docs/agent-operations.md`.

Required product pieces:

```text
HerdrBridge
Herdr event ingestion
OpsReconciler
AttentionQueue
TaskRegistry
TaskAttempt
WorkerBinding
AgentOpsSnapshot
Ops Tools
```

Completion:

> Main Agent can query status, delegate one disposable coding Task, observe working / blocked / done, enter review, request rework, and accept through Glassbox product Actions.

### P3.6 — NapCat / OneBot QQ Channel

Implement the smallest production Channel adapter.

Completion:

> Fake OneBot proves private / group paths, and a local NapCat acceptance environment can connect.

### P3.7 — End-to-end QQ + Ops loop

Wire:

```text
QQ
→ Glassbox
→ Pi + Lora PI Kit
→ direct answer OR durable Task
→ optional Herdr Worker
→ review / rework / accept
→ authorized QQ delivery
```

Not every message becomes a Task.

### P3.8 — Adversarial / restart / dedupe / reconciliation validation

At minimum cover:

```text
default deny
explicit allow
approval
identity spoof
private / public / group isolation
prompt injection
protected Tool
MCP-backed protected Tool path
Ops Tool authorization
unrestricted shell blocked remotely
unauthorized worker_read
revocation / stale authority
cross-Conversation contamination
cross-group contamination
duplicate OneBot event
self-message loop
NapCat reconnect
Glassbox restart
Herdr disconnect / reconnect
snapshot reconciliation
worker replacement / disappearance
blocked Attention dedupe
worker done does not auto-accept
rework preserves prior TaskAttempt
Delivery denial
Trace redaction
PRIVATE_CANARY non-leak
```

### P3.9 — Real completion gate

Run the real dedicated environment and preserve evidence for the completion checklist below.

Mocks alone cannot complete P3.

## Code placement guidance

Glassbox product code stays in Glassbox-owned boundaries, for example:

```text
apps/server/src/
  auth/
  identity/
  conversation/
  persistence/
  runtime/pi/
  channel/qq/
  delivery/
  ops/
  trace/
```

Do not put Glassbox Authorization, Conversation, Task truth, Taste / Memory truth, QQ transport, or canonical Raw Trace into Lora PI Kit.

Do not put durable Task truth into Herdr plugin / workspace state.

Do not import production code from `upstream/`.

## Upstream references for P3

```text
earendil-works/pi
  runtime, SDK, Packages, Extensions, Skills, Prompt Templates

lora-sys/skills
  canonical Lora Skill source

herdrdev/herdr
  live coding-worker control / observation

aorumbayev/herdr-workflows
  optional bounded stage recipes

NapNeko/NapCatQQ
botuniverse/onebot-11
  QQ transport

tursodatabase/turso
  durable state

openfga/openfga
  authorization concepts

pingdotgg/t3code
HKUDS/OpenHarness
  integration patterns
```

OpenSquilla, broad retrieval/routing optimization, full Memory/Taste implementation, LongTask DAGs, and Eval Workbench remain later phases.

## Completion gate

Plan 03 is complete only when all are true:

### Pi / Lora PI Kit

- Pi SDK is the working main-Agent runtime path.
- Lora PI Kit is a real Pi distribution loaded through supported package / Extension / Skill mechanisms.
- a Kit release/test fixture uses a pinned bundled `lora-sys/skills` snapshot with lock metadata.
- P3 profiles include at least main-Agent, QQ-group, Herdr-worker, and test behavior.
- the MCP adapter / profile boundary is proven without making every integration globally active.
- Kit doctor / compatibility checks can identify the tested Pi / Kit / Skills set.
- Glassbox tests do not write to the user's normal interactive Pi state.
- no broad Pi fork is required merely to finish P3.

### Identity / Authorization / Delivery

- real Owner and Visitor QQ identities resolve to distinct Principals.
- Ingress authorization runs before Pi.
- unauthorized protected data stays out of model-visible Context.
- unauthorized Tool, MCP, and Ops definitions stay out of the model-visible Tool surface.
- protected Tool / Ops execution re-authorizes immediately before execution.
- remote profiles expose a narrow Tool / MCP surface.
- unrestricted remote shell is unavailable.
- Delivery checks the real audience.
- Owner-private data cannot leak into a group merely because the Owner asked for it.
- Grant and Revoke affect the next matching protected operation.

### Conversation / durability

- private and group Conversations use durable scope identity.
- every group Run records the acting Principal.
- identity, Conversation, authorization, Task, TaskAttempt, AttentionItem, and WorkerBinding state survive restart.
- stale runtime state does not restore revoked authority.

### Agent Operations

- main Agent can read a correct AgentOpsSnapshot.
- Herdr is connected through a Glassbox-owned bridge.
- bootstrap / reconnect use event subscription plus snapshot reconciliation.
- one real Task can be delegated to a real Herdr-managed coding Agent.
- `blocked` becomes actionable Attention without losing Task ownership.
- `done` goes to REVIEW, not automatic acceptance.
- review can accept or create rework while preserving previous attempts.
- unauthorized Principals cannot inspect/control unrelated Workers.
- Herdr disconnect does not falsely complete/fail Tasks.

### QQ / reliability

- real Owner private chat works.
- real Visitor private chat works under Visitor permissions.
- real group activation and reply work.
- non-activated group messages do not create Agent Runs.
- duplicate / replayed OneBot events do not create duplicate replies.
- NapCat reconnect does not replay completed work into duplicate output.

### Evidence / security

- Raw Trace and decision evidence explain protected operations and Task lifecycle transitions.
- denial evidence does not copy protected payload contents.
- `PRIVATE_CANARY_7F92A1` never appears in unauthorized model Context, Tool/MCP/Worker output, QQ delivery, or public/unauthorized Trace projection.
- existing Codex and Claude Code paths retain focused regression coverage.

When this gate passes, Glassbox has its first usable Personal Agent product loop plus the minimal multi-worker operations foundation. P4 then begins the Feedback → Taste → Memory → Authorized Retrieval layer instead of rebuilding P3.
