# Glassbox Product Roadmap

Status: ROADMAP ONLY

This file records sequencing and product direction. It is not an active implementation plan.

The only active implementation plan is `/.plans/03-personal-agent-foundation.md` until its completion gate passes.

## Product thesis

Glassbox is a durable Personal Agent with explicit identity, authorization, persistent state, inspectable execution, learning, and evidence.

The roadmap is now organized around usable product loops rather than isolated infrastructure milestones.

The first loop is QQ because it gives Glassbox a real remote Channel, real multi-user identity, real private and group delivery, and a concrete place to prove authorization boundaries.

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
Turso state
Run identity
Raw Trace
```

Codex and Claude Code remain supported adapters for compatibility, fallback, specialist execution, and later differential Eval. P3 does not delete them.

Use supported Pi settings, package, Skill, Extension, custom Tool, ResourceLoader, and SDK boundaries before considering any Pi core patch.

## Sequence

### P3 — QQ Personal Agent Closed Loop

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
```

P3 completion means a real Owner and Visitor can use the same Personal Agent through QQ private chat and a test group without crossing permission or delivery boundaries.

See the active plan for the full completion gate.

### P4 — Memory and Authorized Retrieval

After the first real QQ loop works, add durable Memory without weakening the P3 trust model.

Target flow:

```text
Run / Conversation evidence
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

Optimize the working Pi path only after P3 proves correctness and P4 gives retrieval real data.

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
Routing observability
Routing Eval
```

Generic Pi workflow mechanisms belong in Lora PI Kit when they do not affect Glassbox product authorization or protected-data semantics.

Glassbox keeps any mechanism that changes protected Context visibility, product routing policy, durable state, or evidence semantics.

Primary references:

```text
TokenRhythm/opensquilla
Javis603/token-monitor
OpenTelemetry concepts
```

Success is measured with quality, authorization invariant violations, token usage, cost, and latency. Do not claim efficiency from intuition alone.

### P6 — Durable Long Work and Workers

Introduce durable task semantics and specialist delegation.

Target semantics:

```text
stable task id
steps
event history
checkpoint
retry
waiting
signal
child task
worker job
cancellation
continuation
```

Primary references:

```text
temporalio/sdk-typescript
keli-wen/agy-staff
```

Worker authority must satisfy:

```text
worker_permissions ⊆ delegated_permissions ⊆ caller_permissions
```

A Worker may execute through Pi, Codex, Claude Code, AGY, or another backend. Runtime selection never widens authority.

### P7 — More Channels and Personal Domains

Expand beyond the first QQ loop only after the shared trust and Conversation model has proven itself.

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
Trace
```

Mail and Calendar remain protected product Domains, not unrestricted MCP access.

### P8 — Eval, Learning, Assets, and Skill Evolution

Turn real execution evidence into a controlled learning loop:

```text
Run / Trace
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
Skill generation
Skill verification
Asset lineage
Journal
Monthly review
Arena experiments
```

Primary references include Inspect AI, SkillClaw, CoEvoSkills, Voyager, Dagster, Generative Agents, OpenSpiel, Sotopia, and memos.

Validated reusable Pi workflow procedures may be published through Lora PI Kit or `lora-sys/skills`. Glassbox remains the source of product evidence, permissions, and promotion decisions.

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
Authorization Trace
Raw Trace vs Derived State
```

Use synthetic deterministic fixtures derived from the real P3 contracts.

### D2 — Memory and retrieval lab

After P4 exists, let readers manipulate visibility scope, lexical/vector weight, time decay, source weighting, diversity, result count, and context budget.

### D3 — Routing and token economy lab

After P5 exists, let readers compare routing, model tier, thinking depth, context budget, tool-result projection, and retrieval budget with reproducible fixtures.

### D4 — LongTask and learning labs

After later runtime phases, add LongTask state-machine, Trace-to-Canvas, Skill promotion, Eval, and learning-loop demonstrations.

## Stable roadmap rules

- Active implementation scope comes from the current Plan file, not from future roadmap sections.
- Upstream references are research and implementation material, not automatic dependencies.
- Glassbox authorization always wins over runtime configuration, Pi Extensions, Skills, model output, Channel input, or Worker behavior.
- A new runtime, Channel, Memory system, cache, or Worker cannot bypass the hard gates proven in P3.
- Build one usable vertical loop at a time and preserve focused regression coverage for working behavior.
