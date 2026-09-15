# Glassbox Product Roadmap

Status: ROADMAP ONLY

This file records sequencing and product direction. It is not an active implementation plan.

The only active implementation plan is `/.plans/03-personal-agent-foundation.md` until its completion gate passes.

## Product thesis

Glassbox is a durable Personal Agent with explicit identity, authorization, persistent state, inspectable execution, learning, evidence, and controlled delegation.

The roadmap is organized around usable product loops rather than isolated infrastructure milestones.

The first loop is QQ because it gives Glassbox a real remote Channel, real multi-user identity, real private and group delivery, and a concrete place to prove authorization boundaries.

The same first loop now includes a minimal Agent Operations foundation so the user can increasingly talk to one main Agent while that Agent coordinates multiple coding workers through Herdr.

## Runtime direction

Glassbox keeps product identity and trust semantics independent from the concrete execution runtime.

The selected P3 runtime path is:

```text
earendil-works/pi
      ↓
Lora PI Kit
      ↓
Pi SDK embedded in Glassbox server
      ↓
Glassbox Runtime Boundary
```

Pi provides runtime primitives and SDK surfaces.

Lora PI Kit provides owned Pi configuration, Extensions, selected Skills, prompts, presets, observability hooks, bootstrap tooling, and compatibility metadata.

Glassbox keeps:

```text
Agent identity
Principal
Authorization
Conversation
protected Context
Tool authorization
Delivery authorization
Task truth
Attention Queue
TaskAttempt / WorkerBinding
Turso state
Run identity
Raw Trace
```

Codex and Claude Code remain supported adapters for compatibility, fallback, specialist execution, and later differential Eval. P3 does not delete them.

Use supported Pi settings, package, Skill, Extension, custom Tool, ResourceLoader, and SDK boundaries before considering any Pi core patch.

## Agent Operations direction

Herdr is the selected execution host and live Agent-operations layer for coding workers.

The intended boundary is:

```text
Main Glassbox Agent
        ↓
Attention Queue + Task Registry
        ↓
Glassbox Ops Tools
        ↓
Herdr Bridge
        ↓
Herdr
  workspace
  worktree
  pane
  Pi / Codex / Claude / other supported coding Agent
        ↓
Herdr event stream
        ↓
Ops Reconciler
        ↓
Glassbox TaskAttempt / WorkerBinding / Trace
```

Glassbox and Herdr communicate both ways.

Herdr owns live terminal topology and coding-Agent lifecycle facts such as `working`, `blocked`, `done`, and `idle`.

Glassbox owns durable Task state, prioritization, acceptance criteria, review, rework, authorization, and evidence.

These statements are intentionally different:

```text
Herdr agent = done
Task = accepted
```

The first does not imply the second.

`aorumbayev/herdr-workflows` may execute bounded linear stage recipes. It does not become the source of truth for Task state or rework loops.

Local testing and server deployment use the same control model. The target production shape is Glassbox + Pi + NapCat + Herdr on a Linux server, with remote human access over SSH when needed. Moshi may be used as a remote Herdr client, but Moshi client state is not Glassbox product state.

## Sequence

### P3 — QQ Personal Agent + Agent Ops Closed Loop

Current active plan.

P3 is the first usable Glassbox product loop.

```text
QQ
→ NapCat
→ OneBot 11 Channel Adapter
→ Ingress Gate
→ Identity + Conversation
→ Authorization
→ Authorized Context
→ Pi SDK + Lora PI Kit
→ Tool Gate
→ direct answer or durable Task
→ optional Herdr delegation
→ review / rework / completion
→ Delivery Gate
→ QQ reply
→ Turso + Trace
```

P3 includes:

```text
deterministic test environment
real QQ acceptance environment
Lora PI Kit MVP
Pi SDK Runtime
server-side hard authorization gates
scope-based private and group Conversations
Turso persistence
NapCat / OneBot QQ Channel
private chat
group @ activation
message dedupe
reconnect handling
restart recovery
adversarial canary tests
Trace evidence

Attention Queue
Task Registry
TaskAttempt
WorkerBinding
AgentOpsSnapshot
HerdrBridge
Herdr event ingestion
snapshot reconciliation
Ops Tools
one real delegated coding task
working / blocked / review / rework / done loop
```

P3 completion means a real Owner and Visitor can use the same Personal Agent through QQ without crossing permission or delivery boundaries, while the main Agent can also see its current workload and coordinate at least one real Herdr-backed worker through a complete review/rework cycle.

P3 deliberately does not become a full durable workflow engine. Complex dependency DAGs, checkpoints, general retry policy, child tasks, and large-scale worker scheduling remain later work.

See the active plan for the full completion gate.

### P4 — Memory and Authorized Retrieval

After the first real QQ and Ops loops work, add durable Memory without weakening the P3 trust model.

Target flow:

```text
Run / Conversation / Task evidence
→ Memory Candidate
→ visibility inheritance
→ value / reliability checks
→ deduplication / contradiction handling
→ promotion
→ authorized retrieval
```

Retrieval should eventually combine:

```text
authorization scope
+ lexical retrieval
+ vector retrieval
+ source weighting
+ temporal decay
+ diversity reranking
+ context budget
```

Protected Memory must be filtered before model-visible retrieval results are assembled.

Primary references:

```text
zhibao-dev/Learning-Multi-Factor-Memory
langchain-ai/langmem
TokenRhythm/opensquilla for retrieval mechanics
```

### P5 — Efficient Runtime and Observability

Optimize the working Pi and Agent Ops paths only after P3 proves correctness and P4 gives retrieval real data.

Target capabilities:

```text
Context Budget Governor
Tool Result Budget
Tool Result Projection
Token Estimation
Execution Routing
Thinking-depth selection
Prompt / Context compression policy
Duplicate retrieval prevention
permission-scoped semantic cache
Runtime usage / quota / health collection
Agent Ops usage / health projection
Routing observability
Routing Eval
```

Generic Pi workflow mechanisms belong in Lora PI Kit when they do not affect Glassbox product authorization or protected-data semantics.

Glassbox keeps any mechanism that changes protected Context visibility, product routing policy, durable state, Task truth, or evidence semantics.

Primary references:

```text
TokenRhythm/opensquilla
Javis603/token-monitor
herdrdev/herdr telemetry and lifecycle surfaces
OpenTelemetry concepts
```

Success is measured with quality, authorization invariant violations, token usage, cost, latency, task throughput, blocked time, and review/rework rates. Do not claim efficiency from intuition alone.

### P6 — Durable Long Work and Workers

Extend the P3 Task / TaskAttempt / WorkerBinding foundation into real durable long-running work.

Do not replace the P3 Task model merely because a more capable workflow engine is introduced. Migrate or extend the proven contracts.

Target semantics:

```text
stable task id
steps
dependencies / DAG
event history
checkpoint
retry policy
waiting
signal
child task
worker job
cancellation
continuation
lease / heartbeat where needed
recovery after server restart
```

Primary references:

```text
temporalio/sdk-typescript
keli-wen/agy-staff
herdrdev/herdr for live coding-worker execution
```

Worker authority must satisfy:

```text
worker_permissions ⊆ delegated_permissions ⊆ caller_permissions
```

A Worker may execute through Pi, Codex, Claude Code, AGY, or another backend. Runtime selection never widens authority.

Herdr remains useful for live coding workspaces and interactive worker processes. Durable workflow truth remains Glassbox-owned or lives behind a deliberately selected durable orchestration boundary.

### P7 — More Channels and Personal Domains

Expand beyond the first QQ loop only after the shared trust, Conversation, Task, and delivery model has proven itself.

Candidates include:

```text
Web public access
WeChat
Telegram
Discord
Slack
Email
Calendar
```

New Channels must reuse the same:

```text
ChannelIdentity
Principal
Conversation scope
Authorization
Context Gate
Tool Gate
Delivery Gate
Attention Queue
Task Registry when work is delegated
Trace
```

Mail and Calendar remain protected product Domains, not unrestricted MCP access.

### P8 — Eval, Learning, Assets, and Skill Evolution

Turn real execution evidence into a controlled learning loop:

```text
Run / Task / Trace
→ Experience Mining
→ Memory / Skill / Asset Candidate
→ Eval / Verification
→ Promotion
```

Target capabilities include:

```text
Benchmark Eval
Differential Eval
Invariant Eval
Permission Eval
Routing Eval
Task / worker Eval
Skill generation
Skill verification
Asset lineage
Journal
Monthly review
Arena experiments
```

Primary references include Inspect AI, SkillClaw, CoEvoSkills, Voyager, Dagster, Generative Agents, OpenSpiel, Sotopia, and memos.

Validated reusable Pi workflow procedures may be published through Lora PI Kit or `lora-sys/skills`. Glassbox remains the source of product evidence, permissions, task acceptance, and promotion decisions.

## Documentation and Learning track

The documentation site remains a parallel product track.

It must never present a planned mechanism as implemented.

Every substantial capability page shows one of:

```text
Implemented
Experimental
Planned
```

### D0 — Documentation foundation

Can proceed during P3 without changing runtime scope.

Create information architecture, terminology, diagrams, synthetic fixtures, and demo specifications.

### D1 — P3 interactive lessons

After P3 contracts stabilize, publish lessons for:

```text
Owner vs Visitor
private vs group Conversation
Who / Where / What / How / Audience authorization
Default deny
Permission vs Approval
Authorize before Context
Tool re-authorization
Delivery Gate
Conversation vs Pi Session vs Run
Task vs Run vs TaskAttempt
Herdr state vs Task acceptance
Attention Queue
Authorization Trace
Raw Trace vs Derived State
```

Use synthetic deterministic fixtures derived from the real P3 contracts.

### D2 — Memory and retrieval lab

After P4 exists, let readers manipulate visibility scope, lexical/vector weight, time decay, source weighting, diversity, result count, and context budget.

### D3 — Routing and token economy lab

After P5 exists, let readers compare routing, model tier, thinking depth, context budget, tool-result projection, retrieval budget, and worker utilization with reproducible fixtures.

### D4 — LongTask and learning labs

After later runtime phases, add LongTask state-machine, Trace-to-Canvas, Skill promotion, Eval, and learning-loop demonstrations.

## Stable roadmap rules

- Active implementation scope comes from the current Plan file, not from future roadmap sections.
- Upstream references are research and implementation material, not automatic dependencies.
- Glassbox authorization always wins over runtime configuration, Pi Extensions, Skills, model output, Channel input, Herdr state, or Worker behavior.
- Glassbox Task state is durable product truth. Herdr lifecycle state is an execution observation.
- A new runtime, Channel, Memory system, cache, Herdr plugin, workflow recipe, or Worker cannot bypass the hard gates proven in P3.
- `done` from an external runtime or worker never means accepted unless the Glassbox Task state machine records acceptance.
- Local testing must preserve the same contracts intended for the Linux server deployment. Avoid desktop-only product dependencies.
- Build one usable vertical loop at a time and preserve focused regression coverage for working behavior.