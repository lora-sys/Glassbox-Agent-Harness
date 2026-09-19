# Glassbox Product Roadmap

Status: ROADMAP ONLY

This file records sequencing and product direction. It is not permission to implement future phases.

The only active implementation plan is:

```text
.plans/03-personal-agent-foundation.md
```

until its completion gate passes.

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

Current active plan.

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

See the active Plan for exact slices and the completion gate.

### Post-P3 Fast Follow — Owner Control + Group Task Pilot

This fast follow starts only after the P3 completion gate passes. It does not add new P3 completion requirements.

Goal: make the Personal Agent visibly useful in the real test group before broad Memory work begins.

The first pilot should use the existing Owner identity, QQ group Conversation, Authorization, Pi runtime, Delivery Gate, Turso state, Trace, and narrow runtime profiles established by P3.

Priority order:

```text
F0 Per-Run Capability and Tool Surface
F1 Owner Direct Control Surface
F2 Group Assignment and Check-In Pilot
F3 Group Tool Registry and Safe Templates
F4 Owner Group Snapshot and Reports
```

#### F0 — Per-Run Capability and Tool Surface

Build the effective Tool surface after Principal, Location, Conversation, group policy, and authorization are resolved.

```text
available capabilities
→ profile narrowing
→ group bindings
→ Principal authorization
→ Run capability set
→ attach only selected Tool definitions
→ Pi Run
→ re-authorize again at Tool execution
```

Unauthorized Owner, other-group, MCP, and Ops schemas must not enter model-visible Context.

The group runtime may know that a capability class exists only when that metadata itself is authorized. It must not receive a hidden Tool schema merely because the server could later deny execution.

#### F1 — Owner Direct Control Surface

Give the Owner private-channel projection a protected control surface for:

```text
group status
runtime status
model and profile selection
temporary overrides
Tool binding management
schedule management
Trace and failure inspection
group assignment management
```

Do not build one unrestricted string-based god Tool. Keep Actions explicit, authorized, traced, and reversible where practical.

#### F2 — Group Assignment and Check-In Pilot

Add a human-oriented group work model that is separate from Agent Operations Task.

```text
GroupAssignment
AssignmentParticipant
CompletionEvidence
ProgressEvent
ReminderPolicy
ScheduleDefinition
ReportSnapshot
```

A first real loop should support:

```text
Owner creates recurring learning assignment
→ Glassbox posts it on schedule
→ members check in or submit evidence
→ Glassbox records progress
→ overdue members may receive policy-controlled reminders
→ Owner can inspect current progress
→ weekly report summarizes completed, incomplete, overdue, and progress
```

Use durable schedule and occurrence identities so restart or retry does not duplicate a post, reminder, or report.

For the first test group, an in-process scheduler backed by Turso state is acceptable. A later delivery service such as QStash may replace the timer transport without becoming schedule truth.

#### F3 — Group Tool Registry and Safe Templates

Support group-specific capabilities without loading arbitrary code from group chat.

Use this order:

```text
configuration
→ fixed Tool template
→ Skill
→ generated code only when a real new executable capability is required
```

The main Agent may help create a group capability, but activation stays a Glassbox product Action.

Initial Tool creation should prefer parameterized templates with known implementation and permission manifests. New executable Tool code should go through the normal developer path:

```text
request
→ draft
→ tests
→ permission review
→ Owner approval
→ versioned activation
```

A group member must never be able to create or activate an Owner capability through prompt injection.

#### F4 — Owner Group Snapshot and Reports

Add a compact Owner-only projection across configured groups:

```text
group health
active schedules
assignment progress
recent failures
enabled Tool bindings
delivery failures
attention needed
```

This is operational state, not broad cross-group Memory.

The fast follow is complete when one real test group can run a scheduled learning assignment, record member progress, issue a controlled reminder, produce a weekly report, and let the Owner inspect or change the group's active capabilities without exposing Owner or unrelated group Tool schemas.

Detailed design: `docs/owner-group-operations.md`.

### P4 — Memory, Taste and Authorized Retrieval

Add the personal learning layer after P3 trust and execution boundaries are proven.

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
Run / Conversation / Task / Group Assignment evidence
→ Memory Candidate
→ explicit scope and visibility
→ reliability checks
→ dedupe / contradiction handling
→ promotion
→ authorized retrieval
```

Group-derived Memory remains group-scoped by default. The Owner private Main Agent may retrieve across authorized group scopes, but one group's Memory must not silently become another group's Context.

Cross-group synthesis should create an Owner-only derived insight with provenance. Promotion into a broader reusable Skill, Rule, or system-learning record requires an explicit later action.

Planned P4 slices:

```text
P4.0 Feedback Ledger
P4.1 Taste Candidate + Confidence
P4.2 Task-aware Taste Retrieval
P4.3 Semantic Memory with group namespace support
P4.4 Episodic Memory for Runs, Tasks, Conversations and group outcomes
P4.5 Authorized Retrieval including Owner cross-group retrieval
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
