# Plan 03 — QQ Personal Agent Closed Loop

Status: ACTIVE

This is the only active implementation plan in the repository.

## Goal

Ship the first genuinely usable Glassbox Personal Agent closed loop.

Plan 03 ends only when the same durable Personal Agent can be used from real QQ private chat and a real QQ group through NapCat, executes through the Pi SDK with Lora PI Kit loaded, persists Conversation state in Turso, enforces server-side authorization at every protected boundary, and can coordinate real coding work through a bidirectional Herdr operations layer.

The acceptance sentence is:

> A real Owner and a real Visitor can talk to the same Glassbox Personal Agent through QQ private chat and a test QQ group. Pi SDK executes the Agent with Lora PI Kit resources. Unauthorized data never reaches Pi, protected Tools cannot run without a fresh authorization decision, private results cannot be delivered to an unauthorized audience, Conversations survive restart, duplicate QQ events do not produce duplicate replies, and the main Agent can see, delegate, monitor, review, rework, and complete multiple Herdr-backed tasks without losing task truth when Herdr reconnects.

## The closed loops

Plan 03 has two connected loops.

### Personal Agent loop

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
Pi SDK + Lora PI Kit
        ↓
Tool Gate
        ↓
Pi execution
        ↓
Delivery Gate
        ↓
NapCat
        ↓
QQ reply
        ↓
Turso durable state + Raw Trace
```

### Agent Operations loop

```text
QQ / Workbench request
        ↓
Main Agent
        ↓
Attention Queue + Task Registry
        ↓
Ops Tools
        ↓
Herdr Bridge
        ↓
Herdr workspace / worktree / pane / coding Agent
        ↓
Herdr event stream
        ↓
Ops Reconciler
        ↓
TaskAttempt + WorkerBinding + AttentionItem
        ↓
Main Agent review
        ↓
ACCEPT → DONE
or
REWORK → next TaskAttempt
        ↓
Trace + completion notification
```

The two loops share the same Principal, Authorization, Conversation, Task, Run, persistence, and evidence boundaries.

Plan 03 is complete only when both loops work with deterministic tests and the required real acceptance environment.

## Runtime decision

Plan 03 uses the Pi SDK directly inside the Glassbox Node.js server.

Primary package:

```text
@earendil-works/pi-coding-agent
```

Use Pi public SDK surfaces first:

```text
createAgentSession
createAgentSessionRuntime when session replacement is required
ModelRuntime
SessionManager
DefaultResourceLoader
Extension API
customTools
session events
```

Do not build the first Glassbox Pi integration on RPC.

Do not fork Pi for configuration or workflow behavior that can be implemented through settings, Pi packages, Skills, Extensions, custom Tools, ResourceLoader configuration, or the public SDK.

The customization order is:

```text
Pi settings / project config
→ Pi package resources
→ Skill
→ Extension
→ custom Tool
→ Pi SDK integration
→ upstream contribution
→ local Pi core patch only when a tested requirement cannot be implemented through supported public boundaries
```

Any local Pi core patch requires a focused compatibility test and a written removal or upstreaming condition.

## Lora PI Kit decision

Lora PI Kit is the owned Pi customization layer. It is not the Glassbox security model and it is not a copy of Pi core.

Create the separate `lora-sys/lora-pi-kit` repository during this plan when P3.1 starts.

The P3 MVP should contain only the resources needed for this closed loop:

```text
package.json
extensions/
  glassbox-policy-bridge.ts
  trace-hooks.ts
  usage-hooks.ts
prompts/
  base.md
presets/
  owner-direct.json
  visitor-direct.json
  qq-group.json
  test.json
config/
  settings template
  model profile template
scripts/
  install
  doctor
  sync-skills
compat/
  tested-pi-version.json
```

`lora-sys/skills` remains the canonical source for reusable Agent Skills. Lora PI Kit selects or installs Skills. It does not duplicate all Skill source by default.

Ownership stays explicit:

```text
Pi runtime customization
→ Lora PI Kit

QQ transport and OneBot handling
→ Glassbox QQ Channel

Identity, authorization, Conversation, protected Context, delivery policy, durable state, Task truth, Trace
→ Glassbox

Workspace / worktree / pane / terminal Agent lifecycle
→ Herdr
```

## Agent Operations decision

Herdr is the selected Agent Operations execution layer for P3.

Herdr is not the Personal Agent identity, not the Glassbox Task database, and not the authorization source.

Glassbox and Herdr communicate in both directions.

### Glassbox to Herdr

Glassbox may use the Herdr control surface to:

```text
inspect the current session
create or open workspaces and worktrees
start a supported coding Agent
send a prompt
wait for lifecycle state
read Agent or pane output
send deliberate follow-up input
stop or cancel only through an explicit authorized Action
```

### Herdr to Glassbox

Glassbox subscribes to Herdr lifecycle events and projects them into product state:

```text
workspace / worktree changes
pane changes
Agent started
Agent working
Agent blocked
Agent done
Agent replaced or disappeared
connection lost
connection restored
```

Herdr facts are execution facts. They are not automatically Glassbox Task decisions.

For example:

```text
Herdr agent = done
≠
Task = DONE
```

A worker reaching `done` normally moves the TaskAttempt to review. Glassbox or an authorized reviewer decides whether to accept or rework it.

## Ops domain

P3 introduces the smallest durable operations model needed for one main Agent to coordinate multiple pieces of work.

It is deliberately smaller than the future LongTask engine.

### AttentionItem

Represents something that currently needs the main Agent or a human to act.

Minimum kinds:

```text
unanswered_message
worker_blocked
approval_required
task_review
task_failed
delivery_failed
ops_connection_problem
```

An AttentionItem must point back to the relevant Conversation, Task, TaskAttempt, Run, WorkerBinding, or delivery record when one exists.

### Task

Task is durable product truth for a piece of work.

Minimum state machine:

```text
NEW
→ QUEUED
→ ASSIGNED
→ RUNNING
→ WAITING_INPUT
→ REVIEW
  ├─ ACCEPTED → DONE
  └─ REWORK → RUNNING through a new or resumed TaskAttempt

FAILED
CANCELED
```

Do not infer `DONE` only from terminal or Agent lifecycle state.

Task stores at least:

```text
id
title
source
status
priority
createdByPrincipalId
conversationId?
acceptanceCriteria?
createdAt
updatedAt
```

### TaskAttempt

One concrete execution or rework attempt.

```text
id
taskId
attemptNumber
status
workerBindingId?
startedAt?
endedAt?
resultRef?
reviewDecision?
```

Rework does not erase the previous attempt.

### WorkerBinding

Maps Glassbox work to the real Herdr execution location.

```text
id
taskId
taskAttemptId
herdrSession
workspaceId
tabId?
paneId
worktreePath?
branch?
agentName?
agentKind
lastObservedAgentState
lastObservedAt
```

A binding is execution metadata. It does not replace Task state.

### AgentOpsSnapshot

A compact projection for the main Agent.

At minimum expose counts such as:

```text
attention.total
attention.unansweredMessages
attention.approvals
attention.blockedWorkers
attention.awaitingReview
attention.failures

tasks.open
tasks.queued
tasks.running
tasks.waiting
tasks.review
tasks.doneToday

workers.total
workers.working
workers.blocked
workers.idle
workers.done
workers.unknown
```

Do not inject every Task body into every model turn. Give the main Agent a small operational summary and let it call Ops Tools for detail.

## Herdr Bridge

Production integration should use a Glassbox-owned `HerdrBridge`.

The bridge may use Herdr CLI wrappers for simple one-shot development and diagnostics. The long-lived Glassbox integration uses the local Herdr socket API for direct request/response control and event subscriptions.

Conceptual interface:

```text
HerdrBridge
  connect
  disconnect
  getSnapshot
  subscribe
  createWorktree
  openWorktree
  startAgent
  promptAgent
  waitAgent
  readAgent
  sendAgentKeys when deliberate interaction is required
  stop or cancel through explicit policy-controlled action
```

Use Herdr public methods and generated protocol schema. Do not parse the TUI screen as the primary integration protocol.

### Bootstrap and reconciliation

Avoid the event gap between a one-time snapshot and the event subscription.

Required startup / reconnect order:

```text
open event subscription connection
→ events.subscribe
→ wait for subscription acknowledgement
→ request session.snapshot
→ reconcile snapshot with durable Glassbox WorkerBindings / TaskAttempts
→ apply later events continuously
```

Herdr events do not replay everything that happened before a subscription. After reconnect, snapshot and reconcile again.

`OpsReconciler` is responsible for converting Herdr execution state into product projections.

Examples:

```text
Herdr working
→ WorkerBinding state = working
→ TaskAttempt = RUNNING

Herdr blocked
→ WorkerBinding state = blocked
→ Task = WAITING_INPUT when the active attempt truly needs input
→ create AttentionItem(worker_blocked)

Herdr done
→ TaskAttempt execution settled
→ Task = REVIEW
→ create AttentionItem(task_review)

Herdr connection lost
→ do not mark active Tasks DONE or FAILED only because monitoring disappeared
→ mark observation stale / unknown
→ create ops_connection_problem when useful
```

## Main Agent Ops Tools

The main Pi Agent interacts with Agent Operations through Glassbox Tools, not by receiving unrestricted Herdr shell access.

P3 minimum Tool surface:

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

These Tools must expose explicit resource and action semantics so Glassbox authorization can decide whether the current Principal may use them.

A remote QQ user does not automatically gain the right to:

```text
read unrelated project panes
prompt arbitrary coding Agents
stop someone else's worker
remove a worktree
accept privileged work
inspect private Task results
```

Herdr control is a protected capability.

## herdr-workflows boundary

`aorumbayev/herdr-workflows` is an approved reference and optional execution helper for short deterministic stage sequences.

Good fit:

```text
implement
→ test
→ review command
```

Glassbox remains the owner of Task truth, acceptance, rework, prioritization, and the cross-attempt lifecycle.

Do not move this loop into workflow YAML as the source of truth:

```text
review fails
→ rework
→ new attempt
→ review again
```

A useful rule is:

```text
Glassbox owns what must be done and whether it is accepted.
Herdr owns where and how the live coding Agent is running.
herdr-workflows may run a bounded stage recipe.
```

## Local test to server deployment invariant

P3 is developed locally but must not assume the final runtime is a desktop-only process.

Target deployment shape:

```text
Linux server
  Glassbox server
  Pi SDK + Lora PI Kit
  NapCat
  Herdr session server
  coding Agent processes / worktrees
  Turso-compatible durable state
```

When Glassbox and Herdr run on the same host, use the local Herdr control boundary. Human remote access may attach over SSH, including through clients such as Moshi, without changing Glassbox product semantics.

Do not store these as product truth:

```text
local GUI state
developer terminal window identity
machine-specific absolute paths that cannot be configured
Moshi client state
Herdr sidebar presentation
```

Local and server deployments must use the same Task, WorkerBinding, Authorization, Trace, and reconciliation contracts.

## Security model: hard gates, not prompt rules

No security invariant in this plan may depend on a system prompt saying "do not reveal" or "ask before doing".

The model may request an action. It never decides whether that action is authorized.

Every protected decision must have enough structured context to answer:

```text
Who is acting?
Where are they acting?
What are they trying to do?
How will it be done?
Which resource is involved?
Who will receive the result?
Which Conversation and Run does this belong to?
```

Conceptual request shape:

```text
AuthorizationRequest
  principal
  location
    channel
    scopeType
    scopeKey
  action
  resource
  execution
    runtime
    tool?
    operation?
  audience
  conversationId
  runId
```

Authorization returns exactly one of:

```text
ALLOW
DENY
REQUIRES_APPROVAL
```

No matching grant means `DENY`.

### Gate 1 — Ingress Gate

Run before the message reaches Pi.

It determines:

```text
self message or external message
known or unknown ChannelIdentity
resolved User and Principal
private chat or group
allowed group or blocked group
group mention / activation state
duplicate event state
whether this Principal may invoke the Agent from this location
```

P3 default QQ behavior:

```text
private chat
  accepted only for identities allowed by policy

group chat
  bot responds only when explicitly mentioned or when another explicit activation rule is configured

self messages
  ignored

duplicate message/event id
  ignored after the first accepted handling
```

An Ingress denial means no Pi session is invoked.

### Gate 2 — Context Gate

Run before `session.prompt(...)` or any equivalent Pi model invocation.

Unauthorized data must not be loaded into model-visible Context.

Forbidden:

```text
load Owner private content
→ send it to Pi
→ tell Pi not to reveal it
```

Required:

```text
resolve Principal and Conversation
→ authorize each protected source
→ load only allowed source content
→ build model-visible Context
→ invoke Pi
```

A group Conversation does not inherit the Owner's private visibility just because the Owner is the sender.

For P3, visibility scopes should support at least:

```text
public
owner-private
user:<user-id>
group:<group-id>
conversation:<conversation-id>
```

Group Context defaults to public data plus data explicitly visible to that group or Conversation. Owner-private data does not enter group model Context unless an explicit Share action has produced a resource or projection visible to that group.

### Gate 3 — Tool Gate

Every protected Tool call is re-authorized immediately before execution.

Lora PI Kit may use Pi's `tool_call` hook as an enforcement bridge, but the actual decision comes from the Glassbox Authorization Engine.

Conceptual flow:

```text
Pi requests Tool
→ build AuthorizationRequest
→ call Glassbox Authorization Engine
→ ALLOW: execute
→ DENY: block
→ REQUIRES_APPROVAL: create approval path and do not execute until satisfied
```

QQ P3 uses a strict Tool allowlist.

Do not expose unrestricted general shell execution to the QQ Runtime in P3.

Generic `bash` or `powershell` must not become a remote escape hatch around resource authorization.

Herdr Ops Tools follow the same rule. The main Agent gets explicit operations such as `task_delegate` and `worker_read`, not unrestricted remote terminal authority.

### Gate 4 — Delivery Gate

Authorization is checked again before a generated result leaves Glassbox for QQ.

"The actor can read this resource" does not imply "the result may be sent to this audience."

Example:

```text
Owner private chat
  Owner reads owner-private resource
  audience = Owner private chat
  → may be allowed

Owner in QQ group
  Owner can personally read owner-private resource
  audience = group:<group-id>
  → deny delivery unless that data has been explicitly shared to the group
```

Model output must carry or derive an effective visibility label based on protected sources, Task results, Worker outputs, and Tool results used by the Run.

## Conversation model

Use a scope-based Conversation identity.

```text
Conversation
  id
  agentId
  channel
  scopeType
  scopeKey
  createdAt
  updatedAt
```

Examples:

```text
QQ private chat
  scopeType = direct
  scopeKey = qq:user:<qq-id>

QQ group
  scopeType = group
  scopeKey = qq:group:<group-id>
```

The Conversation may be shared by a group, but every Run records the real acting Principal.

Keep these boundaries explicit:

```text
ChannelIdentity ≠ User
User ≠ Principal
Conversation ≠ Principal
Conversation ≠ Pi Session
Pi Session ≠ Run
Task ≠ Run
Task ≠ Herdr Agent
TaskAttempt ≠ Herdr pane
Herdr state ≠ acceptance decision
Actor permission ≠ Delivery permission
```

## Durable state

Plan 03 uses Turso or SQLite-compatible Turso local state behind a narrow server-side persistence boundary.

Persist the structures needed by the closed loops:

```text
agents
users
channel_identities
conversations
relationships
permissions or tuples
authorization_decisions
approvals when used
runs
message dedupe keys
runtime session bindings
resource visibility / share metadata
attention_items
tasks
task_attempts
worker_bindings
```

Raw Trace remains append-only evidence outside the relational product-state model when appropriate.

A restart must not silently merge private and group Conversations, restore stale permissions, lose accepted Task state, or reinterpret a Herdr monitoring gap as task completion.

## QQ Channel

NapCat is the selected QQ protocol-side runtime for P3.

Glassbox owns the OneBot 11 application-side Channel adapter.

Initial scope:

```text
OneBot 11 message events
private messages
group messages
@ bot activation in groups
send_private_msg
send_group_msg
connection health
reconnect handling
message/event deduplication
self-message loop prevention
```

Do not make NapCat storage, WebUI state, or QQ protocol details part of the Glassbox product model.

Do not put QQ transport code into Lora PI Kit.

## Test environments

Plan 03 requires deterministic tests plus real integration acceptance.

### A. Deterministic automated environment

Must run without real QQ accounts and without consuming paid model quota.

Target shape:

```text
Fake OneBot Gateway
Fake Owner
Fake Visitor
Fake Group
Disposable Turso / SQLite database
isolated Pi agentDir
Lora PI Kit test preset
recording or deterministic fake model/provider
FakeHerdrBridge or deterministic Herdr protocol fixture
synthetic protected resources
Raw Trace capture
```

Pi must use an isolated test directory instead of the user's normal `~/.pi/agent` state.

Test Herdr orchestration through the `HerdrBridge` contract. Most domain tests use a fake bridge. Add focused integration tests against a real local Herdr session for protocol and reconciliation behavior.

Suggested generated test root:

```text
.glassbox-test/
  pi/
  db/
    p3-test.db
  fixtures/
    users.json
    groups.json
    resources.json
    onebot-events/
    herdr-events/
  traces/
  worktrees/
```

This directory is disposable test state. Do not commit credentials, real QQ session data, or user repositories.

### B. Real QQ and Herdr acceptance environment

Use dedicated test identities:

```text
Bot QQ
Owner QQ
Visitor QQ
Test QQ Group
  Bot
  Owner
  Visitor
```

Use a dedicated Herdr test session or workspace group with disposable repositories/worktrees.

The real acceptance environment proves:

```text
NapCat login and connection
private reply
group @ activation
group reply
Pi model execution
Herdr connection
session snapshot + event subscription reconciliation
Task delegation to a coding Agent
working / blocked / done observation
review and rework
restart / reconnect recovery
real delivery
```

Real QQ and Herdr acceptance are not the default unit-test path.

## Canary security fixture

P3 has one distinctive Owner-private test secret, for example:

```text
PRIVATE_CANARY_7F92A1
```

Only the Owner-private fixture contains this value.

The automated suite must attempt to exfiltrate it through:

```text
Visitor private chat
Visitor group chat
Owner group chat
prompt injection
indirect Tool request
Herdr worker result
worker_read from unauthorized Task
stale authorization state
revoked permission
cross-Conversation reuse
cross-group reuse
Delivery Gate bypass attempt
```

P3 fails if this canary appears in any unauthorized location, including Pi model-visible Context, unauthorized Tool or Worker result, QQ output, public or unauthorized Trace projection, or denial text that copies protected contents.

## P3 acceptance fixture

Minimum deterministic fixture:

```text
Agent
  agent:lora

Users
  user:owner
  user:visitor

Channel identities
  qq:owner
  qq:visitor
  qq:bot

Conversations
  qq:user:owner
  qq:user:visitor
  qq:group:test

Resources
  resource:public-profile
  resource:owner-private-project
  resource:group-note

Tools
  tool:public-status
  tool:owner-private-project-read
  tool:group-note-read
  tool:ops-status
  tool:task-delegate
  tool:worker-read

Tasks
  task:queued
  task:running
  task:review

Workers
  worker:working
  worker:blocked

Secret
  PRIVATE_CANARY_7F92A1
```

Expected minimum behavior:

```text
Owner private + public-profile             → ALLOW
Owner private + owner-private-project      → ALLOW and may deliver privately
Visitor private + public-profile           → ALLOW
Visitor private + owner-private-project    → DENY
Visitor + owner-only Tool                  → DENY
Owner group + owner-private-project        → group delivery remains DENY
Group + group-note                         → ALLOW when visible to that group
Grant Visitor explicit private read        → next matching private operation ALLOW
Revoke the Grant                           → next matching operation DENY
Duplicate QQ event                         → one Run and one reply only
Group message without activation           → no Agent Run
Main Agent ops_status                      → correct task / attention / worker counts
Delegate Task                              → WorkerBinding points to Herdr execution location
Herdr blocked                              → AttentionItem created, Task not marked DONE
Herdr done                                 → Task enters REVIEW, not DONE
Review reject                              → REWORK with preserved previous attempt
Review accept                              → Task becomes DONE
Herdr reconnect                            → subscription + snapshot reconcile without losing Task truth
Restart                                    → Conversations, grants, Tasks, attempts and bindings restore correctly
```

## Implementation slices

### P3.0 — Test harness and contracts

Build the deterministic acceptance fixture first.

Define the minimum contracts for identity, authorization, Conversation, Task, Attention, WorkerBinding, Run, and visibility.

Add Fake OneBot, disposable database, fake model/runtime injection, `FakeHerdrBridge`, Trace capture, and private canary assertion before real QQ or Herdr work.

P3.0 is complete when tests can prove a trivial authorization allow/deny and a trivial Task lifecycle without real external accounts.

### P3.1 — Lora PI Kit MVP

Create `lora-sys/lora-pi-kit` and implement only the resources required for this closed loop.

Use upstream Pi package and Extension mechanisms. Do not fork Pi.

P3.1 is complete when an isolated Pi test environment loads Lora PI Kit without touching the user's normal Pi environment.

### P3.2 — Pi SDK Runtime

Integrate `@earendil-works/pi-coding-agent` directly into `apps/server` behind a Glassbox-owned runtime adapter.

Requirements:

```text
create / restore Pi session
map Conversation to runtime session binding without equating them
subscribe to Pi events
collect output and usage metadata
abort active execution
load Lora PI Kit resources
inject isolated agentDir for tests
use explicit Tool allowlists per runtime policy
```

Keep Codex and Claude Code adapters intact for regression and later differential Eval.

### P3.3 — Four hard authorization gates

Implement Ingress, Context, Tool, and Delivery gates.

Implement default deny, explicit allow, approval path, revocation, visibility labels, audience checks, and authorization for Herdr Ops Tools.

P3.3 is complete when the canary attack suite fails closed before live QQ integration exists.

### P3.4 — Conversation and Turso durability

Implement scope-based Conversation identity and durable product state.

Persist Task, AttentionItem, TaskAttempt, and WorkerBinding contracts in addition to the existing P3 identity / authorization state.

Prove restart, reopen, grant/revoke persistence, task-state persistence, and safe runtime-session recreation.

### P3.5 — Herdr Agent Operations Foundation

Implement:

```text
HerdrBridge
HerdrEventIngestor
OpsReconciler
AttentionQueue
TaskRegistry
TaskAttempt
WorkerBinding
AgentOpsSnapshot
Ops Tools
```

Use Herdr public socket methods and protocol schema.

Required behaviors:

```text
subscribe acknowledgement before bootstrap snapshot
session.snapshot reconciliation
create/open disposable worktree
start Pi / Codex / Claude worker when supported by the configured profile
prompt worker
wait / read worker
working / blocked / done projection
blocked creates attention
worker done creates review, not automatic task completion
accept
rework
cancel through explicit authorized action
reconnect reconciliation
```

A bounded `herdr-workflows` recipe may be used for a deterministic stage sequence, but Glassbox owns Task truth and rework loops.

P3.5 is complete when the main Agent can query `ops_status`, delegate one disposable task, observe its lifecycle, review it, request rework, and finish it through the Glassbox Ops contracts.

### P3.6 — NapCat / OneBot QQ Channel

Implement the smallest production QQ Channel adapter with private messages, group messages, @ activation, dedupe, replies, connection health, reconnect, and self-message filtering.

Normalize OneBot events into Glassbox Channel inputs before product logic.

### P3.7 — End-to-end QQ + Ops closed loop

Wire the entire product path.

Prove that a QQ request can be answered directly or converted into a durable Task, delegated through Herdr, observed by the main Agent, reviewed, and reported back through an authorized delivery path.

Do not require every QQ request to become a Task. The main Agent decides whether it can answer synchronously or needs delegated work.

### P3.8 — Adversarial, restart, dedupe, reconciliation, and Trace validation

At minimum test:

```text
default deny
explicit allow
requires approval
identity spoof
private/public/group isolation
prompt injection
confused deputy
protected Tool call
Ops Tool authorization
unrestricted shell unavailable in QQ policy
unauthorized worker_read
approval replay
revocation
stale Conversation
stale Pi session
cross-Conversation contamination
cross-group contamination
duplicate OneBot event
reconnect replay
self-message loop
Glassbox restart
Herdr disconnect / reconnect
snapshot reconciliation
worker replacement or disappearance
blocked attention dedupe
worker done does not auto-accept Task
rework preserves previous attempt
denial Trace redaction
Delivery Gate denial
PRIVATE_CANARY_7F92A1 non-leak
```

### P3.9 — Real completion gate

Perform the real acceptance run with:

```text
Bot QQ
Owner QQ
Visitor QQ
Test Group
NapCat
Glassbox
Pi SDK
Lora PI Kit
isolated Turso state
Herdr
one disposable test repository / worktree
at least one real supported coding Agent in Herdr
real configured model
```

Record evidence for every completion-gate item.

Do not mark P3 complete from mocks alone.

## Code placement guidance

Glassbox production code should stay in Glassbox-owned boundaries, for example:

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
    tasks/
    attention/
    herdr/
    reconcile/
  trace/
```

Names may change when implementation evidence shows a better boundary.

Do not put Glassbox authorization policy inside Lora PI Kit.

Do not put NapCat or OneBot transport inside Lora PI Kit.

Do not put durable Task truth inside Herdr plugin state or Herdr workspace metadata.

Do not import production code from `upstream/`.

## Upstream references for this phase

Read the narrow source needed for the current slice before inventing standard behavior:

```text
earendil-works/pi
  SDK, AgentSession, SessionManager, ResourceLoader, Extensions, custom Tools, package model

herdrdev/herdr
  session snapshot, event subscriptions, workspace/worktree/pane/agent control, lifecycle state, remote persistence

aorumbayev/herdr-workflows
  bounded linear workflow execution inside Herdr

NapNeko/NapCatQQ
  QQ protocol-side runtime and operational behavior

botuniverse/onebot-11
  event, API, WebSocket, authentication and message semantics

openfga/openfga
  relation-based authorization concepts

tursodatabase/turso
  durable SQLite-compatible state

pingdotgg/t3code
  existing runtime permission and session integration patterns

HKUDS/OpenHarness
  channel, session and tool boundary patterns

Javis603/token-monitor
  later runtime usage / health collection patterns
```

OpenSquilla remains a later efficiency reference. Do not pull routing, hybrid retrieval, semantic cache, or broad Context optimization into P3 merely because the mechanism exists.

## Completion gate

Plan 03 is complete only when all of these are true:

- Pi SDK is the working Glassbox runtime path for the P3 QQ flow.
- Lora PI Kit loads through supported Pi configuration/package/Extension mechanisms without a broad Pi fork.
- Owner and Visitor resolve to distinct Principals from real QQ identities.
- private and group Conversations use durable scope-based identity.
- Ingress Gate runs before Pi invocation.
- unauthorized protected data is excluded before Pi model Context assembly.
- every protected Tool call is re-authorized before execution.
- QQ runtime has an explicit Tool allowlist and no unrestricted remote shell escape hatch.
- Delivery Gate checks the audience before any protected result is sent.
- Owner-private data cannot be leaked into a QQ group merely because the Owner asked for it there.
- Grant and Revoke affect the next protected operation correctly.
- Turso-backed identity, Conversation, Task, TaskAttempt, AttentionItem, and WorkerBinding state survives restart.
- the main Agent can obtain a compact `AgentOpsSnapshot` with correct message, task, attention, and worker counts.
- Herdr is connected through a Glassbox-owned bridge rather than becoming product state.
- Glassbox subscribes to Herdr events and uses `session.snapshot` reconciliation on bootstrap/reconnect.
- one Task can be delegated to a real Herdr-managed coding Agent.
- Herdr `blocked` produces actionable attention without losing Task ownership.
- Herdr `done` moves work to review and does not silently mark the Task accepted.
- review can accept work or create rework while preserving previous TaskAttempt evidence.
- unauthorized Principals cannot use Ops Tools to inspect or control unrelated workers.
- a Herdr disconnect does not falsely complete or fail tasks; reconnect restores an authoritative execution projection.
- local test and server deployment use the same Ops contracts; no desktop-only state is required for product correctness.
- duplicate/replayed OneBot events do not create duplicate Runs or replies.
- Raw Trace and decision evidence can explain protected operations and Task lifecycle transitions.
- denial evidence does not copy protected payload contents.
- `PRIVATE_CANARY_7F92A1` never appears in unauthorized Pi Context, Worker output projection, Tool result, QQ delivery, or unauthorized Trace projection.
- real Owner QQ private chat works.
- real Visitor QQ private chat works under Visitor permissions.
- real QQ group activation and reply work.
- group non-activation does not create an Agent Run.
- restart preserves the intended Conversation, authorization, and task state.
- existing Codex and Claude Code paths retain focused regression coverage and are not deleted merely to finish P3.

When this gate passes, Glassbox has its first usable Personal Agent product loop and a minimal multi-worker operations loop. The later LongTask phase extends durability, dependency graphs, retry policy, checkpoints, and richer worker delegation instead of rebuilding this foundation.