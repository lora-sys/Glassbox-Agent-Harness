# Glassbox Documentation

Status: DESIGN / CONTENT FOUNDATION

This directory defines the architecture notes and future public learning experience for Glassbox.

The documentation should help a technically curious reader understand Glassbox without requiring them to reverse-engineer the repository first.

Do not use this file as an implementation checklist. The active Plan owns implementation order.

## Architecture source map

Use one source of truth per topic.

| Topic | Source of truth |
| --- | --- |
| Current implementation order and completion gate | `../.plans/03-personal-agent-foundation.md` |
| Long-term phase sequence | `../.plans/roadmap.md` |
| Stable repository invariants | `../AGENTS.md` |
| Runtime ownership / Pi SDK / runtime roles | `runtime-strategy.md` |
| Lora PI Kit distribution / Skills snapshot / MCP / profiles / locks | `lora-pi-kit.md` |
| Herdr / Task / Attention / WorkerBinding / reconciliation | `agent-operations.md` |
| Owner control / group assignments / group Tool bindings / schedules | `owner-group-operations.md` |
| Rules / Skills / Taste / Feedback / Memory / retrieval | `memory-taste.md` |
| Toolchain / dependencies / test / deployment | `tech-stack.md` |
| Persistence / storage / observability / projections | `data-observability.md` |
| Interactive demo curriculum | `interactive-demos.md` |
| Upstream research pins | `../upstream/*/SOURCES.md` |

Do not duplicate detailed implementation rules across several documents. Link to the owner document instead.

## Stable architecture vocabulary

```text
Pi
  Agent engine

Lora PI Kit
  Lora's reproducible Pi distribution

Glassbox
  Personal Agent product / trust / durable-state system

Herdr
  live coding-worker execution host
```

These are different layers.

```text
Pi ≠ Personal Agent
Lora PI Kit ≠ Personal Agent
Herdr Worker ≠ Personal Agent
Herdr state ≠ Task acceptance
Canvas ≠ Execution State
```

## Runtime model

Main Agent path:

```text
Channel / Workbench
        ↓
Glassbox
  Identity
  Authorization
  Conversation
  Task / Attention
  Taste / Memory truth
        ↓
PiRuntimeAdapter
        ↓
Pi SDK
        ↓
Pi + pinned Lora PI Kit profile
```

Lora PI Kit is not merely a config folder.

It is a Pi Distribution that may contain:

```text
pinned Lora Skills snapshot
Extensions
Prompt Templates
profiles
MCP adapter / registry
runtime hooks
Glassbox bridges
compatibility locks
install / doctor / update / sync tooling
```

See `lora-pi-kit.md`.

## Agent Operations model

```text
Main Agent
        ↓
Task Registry + Attention Queue
        ↓
Authorized Ops Tools
        ↓
HerdrBridge
        ↓
Herdr Worker
        ↓
working / blocked / done
        ↓
OpsReconciler
        ↓
TaskAttempt / WorkerBinding
        ↓
Review / Rework / Accept
```

Herdr reports live execution facts.

Glassbox owns Task truth and acceptance.

See `agent-operations.md`.

## Owner and group operations model

After P3, the first fast follow uses the same Personal Agent and trust boundaries for one real test group.

```text
Owner private Main Agent
        ↓
protected group control Actions
        ↓
GroupPolicy
Group Tool bindings
Schedules
GroupAssignments
Progress
Reminders
Reports
```

Tool schemas are model-visible Context. Glassbox must build a per-run Tool surface after Principal, Location, Conversation, group policy, and authorization are known.

Human GroupAssignments remain separate from Agent Operations Tasks.

See `owner-group-operations.md`.

## Learning model

Do not collapse all persistent behavior into generic Memory.

```text
Rules
  hard constraints

Skills
  reusable validated procedures

Taste
  learned user preference

Memory
  durable facts, decisions, events and prior-work knowledge
```

```text
Rules ≠ Skills ≠ Taste ≠ Memory
```

Taste learns from real user behavior such as accept, reject, edit, revert, repeated correction, and explicit feedback.

Taste is preference, not permission or a hard Rule.

See `memory-taste.md`.

## Trust and safety model

Every protected operation must be enforceable without model obedience.

Core principles:

```text
default deny
authorize before protected Context
re-authorize protected Tool / Ops execution
authorize Delivery audience separately
revocation affects the next protected operation
delegation may only reduce authority
Raw Trace remains evidence
```

An installed Pi Skill, Extension, MCP integration, profile, or Herdr control surface does not grant a Channel Principal permission to use it.

## Audience

The future documentation / learning site should serve several readers.

```text
User
  understand what the Agent can do and why permissions matter

Builder
  integrate a Channel, Tool, Runtime, Worker, MCP, or Agent Operations host

Contributor
  understand invariants, architecture, contracts and evidence

Researcher
  inspect Taste, Memory, routing, Eval, token economy and worker coordination
```

Pages should state their primary audience where useful.

## Teaching model

Important concepts should usually follow:

```text
1. Explain
2. Show the mechanism
3. Let the reader change inputs
4. Show the resulting state transition
5. Show the evidence
6. Link to the real implementation / contract when it exists
```

Interactive demos should expose a real mechanism, not just animate a diagram.

## Truthfulness rule

Every substantial capability page should show one of:

```text
Implemented
Experimental
Planned
```

Do not present planned architecture in present tense as if it were production behavior.

## Proposed public information architecture

### Start Here

```text
What is Glassbox?
Why one durable Personal Agent?
Pi vs Lora PI Kit vs Glassbox
Why authorization comes before intelligence
How to read a Run
How the main Agent tracks work
Current implementation status
Roadmap
```

### Core Concepts

```text
Agent
User / Principal
ChannelIdentity
Authorization
Permission / Approval
Conversation
Session
Run
Task
TaskAttempt
AttentionItem
WorkerBinding
Runtime
Lora PI Kit
Worker
Herdr
Rules
Skills
Taste
Memory
Trace
Derived State
Canvas
Eval
```

### Runtime

```text
Pi engine
Pi SDK
Lora PI Kit
Pi Packages
Profiles
Skills snapshot
MCP adapter
Context assembly
Tool boundary
runtime state isolation
compatibility locks
```

### Agent Operations

```text
Attention Queue
Task state machine
TaskAttempt
WorkerBinding
AgentOpsSnapshot
HerdrBridge
working / blocked / done
snapshot reconciliation
review / rework
local test → server deployment
Moshi as optional human client
```

### Memory and Taste

```text
Feedback Ledger
Taste Candidate
confidence
scope
task-aware Taste retrieval
Semantic Memory
Episodic Memory
Authorized Retrieval
Skill promotion boundary
```

### Observability

```text
Raw Trace
AuthorizationDecision
Run / Tool / Delivery evidence
Task lifecycle evidence
Kit / profile / runtime identity
Taste retrieval reason
Memory retrieval reason
public Trace / Eval projections
```

### Eval Lab

```text
Benchmark
Differential Eval
Invariant Eval
Permission Eval
Taste Eval
Memory retrieval Eval
Routing Eval
Task / Worker Eval
```

### Build with Glassbox

```text
Add a Channel
Add a Tool
Add a Runtime adapter
Add a Lora PI Kit Extension / profile integration
Add an MCP integration
Add a Worker / Agent Operations adapter
Add a protected Resource type
Add an Eval
```

## Visual language

Prefer state diagrams, timelines, small tables, event traces, and architecture flows over decorative diagrams.

Always distinguish:

```text
trusted boundary
untrusted input
persistent product state
runtime distribution state
ephemeral execution
external execution observation
derived projection
human approval / review
```

Do not use a Pi TUI screenshot to imply Pi is the Product State.

Do not use a Herdr pane to imply the pane is Task truth.

Do not use Canvas layout to imply Canvas controls execution.

## Interactive demo principles

Demos should be:

```text
deterministic by default
fast
resettable
safe to run locally
based on synthetic fixtures
explicit about simulated vs real behavior
```

Good interactions include:

```text
change Principal
change Resource visibility
Grant / Revoke
attempt protected Tool / MCP call
change Lora PI Kit profile
show which Skills are active
simulate Worker working / blocked / done
Accept / Rework Task
simulate Herdr reconnect reconciliation
add positive / negative Taste evidence
change Taste scope / confidence
inspect authorized retrieval
```

## Data safety

Public docs demos must not require:

```text
real Personal Agent state
private Conversation history
real Taste / Memory data
production credentials
private repositories
real Herdr workspaces
real QQ session data
production Trace containing protected payloads
```

Use synthetic fixtures.

## Search and terminology

Important aliases should lead readers to the canonical distinction.

Examples:

```text
chat history
  → Conversation

agent session
  → distinguish Conversation / Session / Run

job / task
  → distinguish Task / TaskAttempt / Run / LongTask

worker status
  → Agent Operations / WorkerBinding

Herdr done
  → Task review, not acceptance

Pi config
  → Lora PI Kit / Pi settings / Runtime Strategy

MCP
  → Lora PI Kit runtime integration + Glassbox authorization

preference memory
  → Taste

RAG
  → Authorized Retrieval
```

## Site implementation boundary

Do not create an `apps/docs` package until implementation work begins.

When it starts, prefer a mostly static content system with interactive islands where necessary.

The documentation site is not a second Glassbox control plane.

## First useful publishing milestone

After P3 contracts stabilize, a strong initial public set should cover:

```text
What is Glassbox?
Pi vs Lora PI Kit vs Glassbox
Identity vs Authorization
Owner vs Visitor
Permission vs Approval
Authorize before Context
Conversation vs Session vs Run
Task vs TaskAttempt vs Run
Attention Queue
Herdr state vs Task acceptance
Review / Rework
Trace
Canvas is a Projection
Current status and roadmap
```

After P4, add Taste / Memory interactive lessons.
