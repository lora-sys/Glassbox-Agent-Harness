# Plan 03 — QQ Personal Agent Closed Loop

Status: ACTIVE

This is the only active implementation plan in the repository.

## Goal

Ship the first genuinely usable Glassbox Personal Agent closed loop.

Plan 03 ends only when the same durable Personal Agent can be used from real QQ private chat and a real QQ group through NapCat, executes through the Pi SDK with Lora PI Kit loaded, persists Conversation state in Turso, enforces server-side authorization at every protected boundary, and records enough Trace to explain every allow, deny, tool execution, and delivery decision.

The acceptance sentence is:

> A real Owner and a real Visitor can talk to the same Glassbox Personal Agent through QQ private chat and a test QQ group. Pi SDK executes the Agent with Lora PI Kit resources. Unauthorized data never reaches Pi, protected Tools cannot run without a fresh authorization decision, private results cannot be delivered to an unauthorized audience, Conversations survive restart, duplicate QQ events do not produce duplicate replies, and every decision can be inspected in Trace.

## The closed loop

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

Plan 03 is complete only when this path works end to end with both deterministic automated tests and a real QQ acceptance environment.

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

Upstream projects may provide mechanisms or patterns, but ownership stays explicit:

```text
Pi runtime customization
→ Lora PI Kit

QQ transport and OneBot handling
→ Glassbox QQ Channel

Identity, authorization, Conversation, protected Context, delivery policy, durable state, Trace
→ Glassbox
```

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
→ glassbox-policy-bridge receives tool_call
→ build AuthorizationRequest from current Principal, location, resource, action, tool and audience
→ call Glassbox Authorization Engine
→ ALLOW: execute
→ DENY: block
→ REQUIRES_APPROVAL: create approval path and do not execute until the explicit policy path is satisfied
```

QQ P3 uses a strict Tool allowlist.

Do not expose unrestricted general shell execution to the QQ Runtime in P3.

In particular, generic `bash` or `powershell` must not become a remote escape hatch around resource authorization. Remote QQ execution should use explicit Tools with explicit resource/action semantics so the Authorization Engine can make a meaningful decision.

Local coding workflows may continue to use broader tooling outside this QQ policy profile.

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

Model output must carry or derive an effective visibility label based on protected sources and Tool results used by the Run.

At minimum, Delivery Gate evaluates:

```text
source visibility
current Principal
Conversation scope
audience
explicit Share state
```

An explicit Share is a named Action. It may require approval, but Approval does not invent access that the policy otherwise forbids.

## Conversation model

The old assumption that every Conversation belongs directly to one `userId` is insufficient for group chat.

Use a scope-based Conversation identity.

Conceptual shape:

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

P3 examples:

```text
QQ private chat
  channel = qq
  scopeType = direct
  scopeKey = qq:user:<qq-id>

QQ group
  channel = qq
  scopeType = group
  scopeKey = qq:group:<group-id>
```

The Conversation may be shared by a group, but every Run records the real acting Principal.

```text
Run
  id
  conversationId
  principalId
  runtime
  runtimeSessionId?
  deliveryAudience
  startedAt
  endedAt?
```

Keep these boundaries explicit:

```text
ChannelIdentity ≠ User
User ≠ Principal
Conversation ≠ Principal
Conversation ≠ Pi Session
Pi Session ≠ Run
Actor permission ≠ Delivery permission
```

## Durable state

Plan 03 uses Turso or SQLite-compatible Turso local state behind a narrow server-side persistence boundary.

Persist only what this closed loop needs first:

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
```

Raw Trace remains append-only evidence outside the relational product-state model when appropriate.

A restart must not silently merge private and group Conversations or restore stale permissions.

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

Primary references for this slice:

```text
NapNeko/NapCatQQ
botuniverse/onebot-11
```

Prefer OneBot-compatible boundaries so the application-side Channel logic does not depend on undocumented NapCat internals.

## Test environments

Plan 03 requires two test layers.

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
synthetic protected resources
Raw Trace capture
```

Pi must use an isolated test directory instead of the user's normal `~/.pi/agent` state.

Suggested generated test root:

```text
.glassbox-test/
  pi/
    settings.json
    models.json
    skills/
    extensions/
    sessions/
  db/
    p3-test.db
  fixtures/
    users.json
    groups.json
    resources.json
    onebot-events/
  traces/
```

This directory is disposable test state and should be ignored when appropriate. Do not commit credentials or real QQ session data.

The SDK integration should accept explicit `agentDir`, model runtime, SessionManager, ResourceLoader, and Tool set so tests can replace real dependencies.

### B. Real QQ acceptance environment

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

Use an isolated Glassbox test database and isolated Pi configuration for real acceptance.

The real acceptance environment proves transport and integration behavior that deterministic fixtures cannot prove:

```text
NapCat login and connection
OneBot event shape
private reply
group @ activation
group reply
reconnect
restart
real Pi model execution
real delivery
```

Real QQ acceptance is not the default unit-test path.

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
stale authorization state
revoked permission
cross-Conversation reuse
cross-group reuse
Delivery Gate bypass attempt
```

P3 fails if this canary appears in any unauthorized location, including:

```text
Pi model-visible Context
unauthorized Tool result
QQ output
public or unauthorized Trace projection
denial text that copies protected contents
```

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
Owner group + owner-private-project        → read may be individually authorized, group delivery remains DENY
Group + group-note                         → ALLOW when visible to that group
Grant Visitor explicit private read        → next matching private operation ALLOW
Revoke the Grant                           → next matching operation DENY
Duplicate QQ event                         → one Run and one reply only
Group message without activation           → no Agent Run
Restart                                    → Conversations and current grants restore correctly
```

## Implementation slices

### P3.0 — Test harness and contracts

Build the deterministic acceptance fixture first.

Define the minimum provider-neutral contracts for:

```text
Principal
Location
Audience
ResourceRef
Action
AuthorizationRequest
AuthorizationDecision
ConversationScope
Run identity
Visibility scope
```

Add the fake OneBot path, disposable database, fake model/runtime injection, Trace capture, and private canary assertion before real QQ work.

P3.0 is complete when the test harness can prove a trivial allow and deny without a real model or QQ account.

### P3.1 — Lora PI Kit MVP

Create `lora-sys/lora-pi-kit`.

Implement only the P3 resources required for the Glassbox integration:

```text
Pi package manifest
Glassbox policy bridge Extension
Trace / usage hooks
base prompt
QQ and test presets
Skill selection / sync
install and doctor scripts
Pi compatibility metadata
```

Use upstream Pi package and Extension mechanisms. Do not fork Pi.

P3.1 is complete when an isolated Pi test environment can load Lora PI Kit and report its expected resources without touching the user's normal Pi environment.

### P3.2 — Pi SDK Runtime

Integrate `@earendil-works/pi-coding-agent` directly into `apps/server` behind a Glassbox-owned runtime adapter.

Requirements:

```text
create / restore Pi session
map Conversation to runtime session binding without equating the two concepts
subscribe to Pi events
collect output and usage metadata
abort active execution
load Lora PI Kit resources
inject isolated agentDir for tests
use explicit Tool allowlists per runtime policy
```

Keep Codex and Claude Code adapters intact for regression and later differential Eval.

P3.2 is complete when deterministic Glassbox tests can run one prompt through Pi SDK and receive normalized Run events.

### P3.3 — Four hard authorization gates

Implement:

```text
IngressGate
AuthorizedContextBuilder
AuthorizedToolExecutor / Pi policy bridge
DeliveryGate
```

All four call or derive from the Glassbox Authorization Engine. None may rely on model obedience.

Implement default deny, explicit allow, approval path, revocation, visibility labels, and audience checks.

P3.3 is complete when the canary attack suite fails closed before any QQ integration exists.

### P3.4 — Conversation and Turso durability

Implement scope-based Conversation identity and durable state.

Prove:

```text
Owner private Conversation isolation
Visitor private Conversation isolation
shared group Conversation with per-Run Principal identity
restart
reopen
Grant / Revoke persistence
runtime session binding restore or safe recreation
no stale authorization after restart
```

P3.4 is complete when the deterministic fixture survives process/database reopen.

### P3.5 — NapCat / OneBot QQ Channel

Implement the smallest production Channel adapter.

Handle:

```text
private message event
group message event
@ activation
self-message filtering
message/event deduplication
send private message
send group message
connection health and reconnect
```

Normalize OneBot events into Glassbox Channel inputs before product logic.

P3.5 is complete when Fake OneBot integration tests prove private and group flows and a local NapCat connection can be established in the acceptance environment.

### P3.6 — End-to-end QQ closed loop

Wire the entire path:

```text
QQ
→ NapCat
→ Glassbox Channel
→ hard gates
→ Pi SDK + Lora PI Kit
→ hard gates
→ QQ
```

Prove Owner private, Visitor private, Owner group, and Visitor group flows.

P3.6 is complete when the bot can be used conversationally in the dedicated test QQ environment.

### P3.7 — Adversarial, restart, dedupe, and Trace validation

Run the full security and reliability matrix.

At minimum test:

```text
default deny
explicit allow
requires approval
identity spoof attempt
identity binding does not grant authority
private/public/group isolation
Owner group exfiltration attempt
Visitor private exfiltration attempt
Visitor group exfiltration attempt
prompt injection
confused deputy
protected Tool call
unrestricted shell unavailable in QQ policy
approval replay
revocation
stale Conversation
stale Pi session
cross-Conversation contamination
cross-group contamination
duplicate OneBot event
reconnect replay
self-message loop
restart and resume
denial Trace redaction
Delivery Gate denial
PRIVATE_CANARY_7F92A1 non-leak
```

Each denial records enough metadata to explain the decision without copying the denied private payload.

### P3.8 — Real QQ completion gate

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
  trace/
```

Names may change when implementation evidence shows a better boundary.

Do not put Glassbox authorization policy inside Lora PI Kit.

Do not put NapCat or OneBot transport inside Lora PI Kit.

Do not import production code from `upstream/`.

Do not create a broad shared `agent-runtime` package until more than one real consumer needs a stable cross-package contract.

## Upstream references for this phase

Read the narrow source needed for the current slice before inventing standard behavior:

```text
earendil-works/pi
  SDK, AgentSession, SessionManager, ResourceLoader, Extensions, custom Tools, package model

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

Token Monitor
  later runtime usage / health collection patterns
```

OpenSquilla remains a later efficiency reference. Do not pull routing, hybrid retrieval, semantic cache, or broad Context optimization into P3 unless a concrete P3 correctness problem requires a very small mechanism.

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
- Turso-backed state survives restart.
- duplicate/replayed OneBot events do not create duplicate Runs or replies.
- NapCat reconnect does not silently replay completed work into duplicate replies.
- Raw Trace and AuthorizationDecision evidence can explain Who, Where, What, How, Resource, Audience, Conversation and Run for protected operations.
- denial evidence does not copy protected payload contents.
- `PRIVATE_CANARY_7F92A1` never appears in unauthorized Pi Context, Tool result, QQ delivery, or unauthorized Trace projection.
- real Owner QQ private chat works.
- real Visitor QQ private chat works under Visitor permissions.
- real QQ group activation and reply work.
- group non-activation does not create an Agent Run.
- restart preserves the intended Conversation and current authorization state.
- existing Codex and Claude Code paths retain focused regression coverage and are not deleted merely to finish P3.

When this gate passes, Glassbox has its first usable Personal Agent product loop. The next product phase is Memory and Authorized Retrieval, not another phase whose only purpose is to make the first remote Channel work.
