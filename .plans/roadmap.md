# Glassbox Product Roadmap

Status: ROADMAP ONLY

This file records sequencing and product direction. It is not permission to implement future phases.

The completed P3 foundation is followed by one deliberately small active fast-follow:

```text
.plans/03-plus-owner-control-smoke.md
```

P4 remains the first Memory / Taste phase.

## Product thesis

Glassbox is one durable Personal Agent with explicit identity, authorization, persistent state, inspectable execution, controlled delegation, learned Taste, durable Memory, reusable Skills, and evidence.

The roadmap is organized around usable product loops, not isolated infrastructure milestones.

## Stable architecture direction

Use this model:

```text
Pi
  Agent engine

Lora PI Kit
  Lora's reproducible Pi distribution

Glassbox
  Personal Agent system / product control plane

Herdr
  live coding-worker execution host
```

### Pi

Pi provides runtime primitives, Packages, Extensions, Skills, Prompt Templates, models/providers, sessions, SDK, RPC, and Agent-loop behavior.

### Lora PI Kit

Lora PI Kit is the reusable distribution installed on top of Pi.

It contains or manages:

```text
pinned Lora Skills snapshot
Pi Extensions
Prompt Templates
runtime profiles
MCP adapter / registry
model / thinking defaults
Glassbox runtime bridges
Taste / Feedback / Trace hooks
install / doctor / update / sync tooling
compatibility locks
```

`lora-sys/skills` remains the canonical Skill source repository. Kit releases bundle a pinned snapshot for reproducibility.

The same Kit may be used by local Pi, the Glassbox main Agent, and Herdr Pi workers through different profiles.

Detailed design: `docs/lora-pi-kit.md`.

### Glassbox

Glassbox keeps durable product truth:

```text
Agent identity
Principal
Authorization
Conversation
Task / Attention / TaskAttempt / WorkerBinding
Taste / Memory truth
Audience / Delivery policy
Run identity
Turso product state
Raw Trace
```

### Herdr

Herdr owns live execution topology and coding-Agent lifecycle observation.

```text
Herdr done
≠
Glassbox Task accepted
```

Glassbox owns review / rework / acceptance.

## Learning direction

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

Taste learns from real behavior such as accept, reject, edit, revert, repeated correction, and explicit feedback.

Glassbox owns Feedback, confidence, scope, promotion, retrieval, Memory, authorization, and provenance.

Lora PI Kit only bridges selected runtime context into Pi and forwards observable signals back to Glassbox.

Detailed design: `docs/memory-taste.md`.

## Sequence

### P3 — QQ Personal Agent + Agent Ops Closed Loop

Completed foundation.

Goal: first real usable Personal Agent product loop.

```text
QQ
→ NapCat / OneBot
→ Identity + Conversation
→ Authorization
→ Pi SDK + pinned Lora PI Kit profile
→ direct answer OR durable Task
→ optional Herdr delegation
→ review / rework / accept
→ Delivery Gate
→ QQ reply
→ Turso + Trace
```

P3 establishes:

```text
Lora PI Kit distribution MVP
Pi SDK main runtime
hard authorization gates
scope-based Conversation
Turso durable state
QQ private / group Channel
Attention Queue / Task Registry
TaskAttempt / WorkerBinding
HerdrBridge / reconciliation
Ops Tools
real delegated coding Task
restart / reconnect / dedupe
real QQ + Herdr acceptance
```

P3 does not become the full LongTask engine.

See the completed Plan 03 for its exact slices and completion gate.

### P3+ — Owner Control Smoke Slice

Immediate, bounded fast-follow on the completed P3 foundation.

Goal: prove Owner-only control and model-visible Tool isolation against the current real test group, then stop and continue the existing roadmap.

The active Plan is:

```text
.plans/03-plus-owner-control-smoke.md
```

P3+ adds only:

```text
per-Run Tool schema filtering
minimal Owner private control
test-group model override
enable / disable one existing safe capability
recent Run / Trace inspection
one real smoke acceptance
```

P3+ does not add any new group program or learning subsystem.

```text
no learning assignment
no scheduler
no reminder
no weekly report
no Group Tool Registry
no Tool generation
no Memory or Taste
```

Detailed architecture: `docs/owner-group-operations.md`.

### P4 — Memory, Taste and Authorized Retrieval

Add the personal learning layer after the P3 trust boundary and the tiny P3+ smoke slice are proven. P4 is the first phase that creates Taste or durable Memory.

Order matters: learn Taste from corrections before building broad Memory retrieval.

Target Taste loop:

```text
Agent output
→ accept / reject / edit / revert / correction
→ FeedbackEvent
→ TasteCandidate
→ confidence + scope
→ promote / demote / retire
→ task-aware retrieval
→ inject only relevant Taste
→ next execution
```

Initial Taste scope:

```text
global
project
```

One edit is evidence, not a permanent preference.

Project Taste must not silently become global Taste.

Target Memory loop:

```text
Run / Conversation / Task evidence
→ Memory Candidate
→ visibility + reliability checks
→ dedupe / contradiction handling
→ promotion
→ authorized retrieval
```

Planned P4 slices:

```text
P4.0 Feedback Ledger
P4.1 Taste Candidate + Confidence
P4.2 Task-aware Taste Retrieval
P4.3 Semantic Memory
P4.4 Episodic Memory
P4.5 Authorized Retrieval
P4.6 Inspection and Eval
```

Stable procedural knowledge should normally become a Skill rather than generic Memory.

P4 success should measure reduced user correction work, not the number of stored records.

Useful metrics:

```text
Correction Rate
Revert Rate
Taste Hit Rate
Preference Compliance
False Preference Rate
Scope Leakage Rate
Taste Retrieval Precision
Memory Retrieval Precision
```

Primary references include Command Code for Taste mechanics, Learning-Multi-Factor-Memory, LangMem, and OpenSquilla retrieval mechanics.

### P5 — Efficient Runtime and Observability

Optimize the proven runtime and retrieval paths.

Target capabilities:

```text
Context Budget Governor
Tool Result Budget / Projection
Token estimation
Execution routing
thinking-depth selection
Context compression policy
duplicate retrieval prevention
permission-scoped semantic cache
runtime usage / quota / health
Agent Ops health / throughput
routing observability
routing Eval
```

Generic Pi workflow mechanisms belong in Lora PI Kit when they do not change Glassbox authorization, product truth, or evidence semantics.

Glassbox keeps protected Context selection, product routing policy, Task truth, and evidence.

Primary references:

```text
TokenRhythm/opensquilla
Javis603/token-monitor
Herdr lifecycle surfaces
OpenTelemetry concepts
```

### P6 — Durable Long Work and Workers

Extend the P3 Task foundation into durable long-running work.

Do not replace proven Task / TaskAttempt / WorkerBinding semantics merely because a workflow engine is introduced.

Target semantics:

```text
stable task id
steps
dependency DAG
event history
checkpoint
retry policy
waiting
signal
child task
worker job
cancellation
continuation
lease / heartbeat
restart recovery
```

Primary references:

```text
temporalio/sdk-typescript
keli-wen/agy-staff
herdrdev/herdr for live coding-worker execution
```

Delegation must always satisfy:

```text
worker_permissions ⊆ delegated_permissions ⊆ caller_permissions
```

### P7 — More Channels and Personal Domains

Expand beyond QQ only after the shared trust, Conversation, Task, and Delivery model is proven.

Candidates:

```text
Web public access
WeChat
Telegram
Discord
Slack
Email
Calendar
```

Every new Channel reuses:

```text
ChannelIdentity
Principal
Conversation scope
Authorization
Context Gate
Tool / Ops Gate
Delivery Gate
Attention / Task when delegated
Trace
```

Mail and Calendar remain protected product Domains, not unrestricted remote capability.

### P8 — Eval, Learning, Assets and Skill Evolution

Turn real execution evidence into a controlled improvement loop.

```text
Run / Task / Trace
→ Experience Mining
→ Memory / Skill / Asset Candidate
→ Eval / Verification
→ Promotion
```

Target capabilities:

```text
Benchmark Eval
Differential Eval
Invariant Eval
Permission Eval
Routing Eval
Task / Worker Eval
Skill generation
Skill verification
Asset lineage
Journal
Monthly review
Arena experiments
```

Validated reusable Pi procedures may land in `lora-sys/skills` and then flow into a later Lora PI Kit release as a pinned Skill snapshot.

Glassbox remains the source of product evidence, authorization, Task acceptance, Taste / Memory truth, and promotion decisions.

### P9 — Group Programs and Custom Capabilities

This is the late-stage group-specific product track.

It is intentionally after the core Memory, runtime, long-work, channel, and Eval / learning phases so the earlier roadmap stays focused.

Target capabilities:

```text
scheduled group learning assignments
participant progress
automatic reminder policy
weekly reports
streaks / scoring when useful
Group Tool Registry
progressive Tool discovery
template-driven group capability creation
multi-group Owner snapshot
controlled new Tool development
```

After P4 Memory exists, P9 may also use:

```text
group-scoped Memory
Owner-authorized cross-group retrieval
Owner-private derived insights
system-improvement proposals with provenance
```

The capability creation order should remain:

```text
configuration
→ fixed template
→ Skill
→ new executable Tool code
```

Generated executable capability requires tests, a permission manifest, versioned activation, and Owner review where appropriate.

Detailed architecture: `docs/owner-group-operations.md`.

## Documentation and Learning track

The documentation / learning site remains a parallel product track.

It must never present planned behavior as already implemented.

Every substantial capability page should show one of:

```text
Implemented
Experimental
Planned
```

### D0 — Documentation foundation

Maintain architecture truth, terminology, synthetic fixtures, and diagrams during P3.

### D1 — P3 interactive lessons

After P3 contracts stabilize, teach:

```text
Owner vs Visitor
Who / Where / What / How / Audience
Permission vs Approval
Authorize before Context
Tool / Ops authorization
Delivery authorization
Conversation vs Session vs Run
Task vs TaskAttempt vs Run
Herdr state vs Task acceptance
Lora PI Kit vs Pi vs Glassbox
Raw Trace vs Derived State
```

### D2 — Taste / Memory lab

After P4, let readers inspect and manipulate:

```text
Feedback evidence
Taste confidence
scope
promotion / demotion
retrieval relevance
visibility
time decay / contradiction
Memory retrieval
```

### D3 — Routing / token economy lab

After P5, compare routing, model tier, thinking depth, Context budget, Tool projection, retrieval budget, and Worker utilization.

### D4 — LongTask / learning labs

After later phases, add LongTask state machines, Skill promotion, Eval, and asset lineage demonstrations.

## Stable roadmap rules

- Active implementation scope comes from the current Plan, not future roadmap sections.
- Pi is an engine; Lora PI Kit is a distribution; Glassbox is the Personal Agent system.
- `lora-sys/skills` is canonical Skill source; a Kit release uses a pinned snapshot.
- Package / profile / MCP presence never overrides Glassbox authorization.
- Glassbox Task state is durable product truth; Herdr state is execution observation.
- Taste is preference, not authority.
- A new Runtime, Channel, MCP integration, Memory system, cache, Worker, or plugin cannot bypass the trust boundaries proven in P3.
- External `done` never means accepted unless Glassbox records acceptance.
- Local testing must preserve the same contracts intended for Linux server deployment.
- Build one usable vertical loop at a time and keep focused regression coverage for working behavior.
