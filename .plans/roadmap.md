# Glassbox Product Roadmap

Status: ROADMAP ONLY

This file records sequencing and product direction. It is not permission to implement future phases.

P3 is complete. The active implementation plans are the intentionally parallel P4 streams:

```text
.plans/04a-memory-taste.md
.plans/04b-authorized-retrieval-history.md
```

Each stream has separate ownership, a tracking Issue, and a later PR.

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

Completed on 2026-09-19.

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

See the retained P3 Plan for its exact slices and completion gate.

### P4 — Memory / Taste and Authorized Retrieval

P4 is intentionally split into two parallel streams after P3.

```text
P4A — Memory and Taste Durable Learning Truth
P4B — Authorized Retrieval and QQ History Search
```

The split is by ownership, not by UI.

```text
P4A
  write side
  decides what becomes durable learning truth

P4B
  read side
  decides what the current Principal may retrieve
  searches only inside that authorized source set
```

Each stream has one active Plan, one Issue, and later one PR:

```text
.plans/04a-memory-taste.md
  Issue #9

.plans/04b-authorized-retrieval-history.md
  Issue #10
```

#### P4A — Memory and Taste Durable Learning Truth

Goal: create durable, inspectable personal learning state without allowing transient model inference to become truth.

Target Taste loop:

```text
Agent output
→ accept / reject / edit / revert / explicit feedback
→ FeedbackEvent
→ TasteCandidate
→ confidence + scope
→ promote / demote / retire
→ durable Taste truth
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
explicit Owner fact / decision
or
Run / Conversation / Task evidence
→ MemoryCandidate when inference is required
→ reliability + visibility + provenance checks
→ promote / supersede / retire
→ Semantic or Episodic Memory
```

P4A owns:

```text
FeedbackEvent
TasteCandidate
TasteEntry
confidence
scope
MemoryCandidate
Semantic Memory
Episodic Memory
promotion / demotion
supersession / retirement
Owner inspection / administration
```

P4A does not own history search, ranking, Top K, or Runtime Context injection.

P4A implementation is upstream-first:

```text
HKUDS/MGP
  Memory / Candidate / Evidence / lifecycle contract

langchain-ai/langmem
  semantic / episodic extraction and consolidation

HKUDS/OpenHarness
  Memory dedupe / TTL / supersedes / freshness hygiene

zhibao-dev/Learning-Multi-Factor-Memory
  retention value / forgetting mechanism

CommandCodeAI/command-code
  Taste behavior signals and project / user scope
```

Stable procedural knowledge should normally become a Skill rather than generic Memory.

#### P4B — Authorized Retrieval and QQ History Search

Goal: make history, Memory and Taste useful without weakening the P3 trust boundary.

Required order:

```text
resolve Principal
→ resolve authorized source set
→ retrieve only inside that set
→ rank
→ bound results
→ assemble Runtime Context
→ Delivery Gate
```

P4B adds two real QQ history capabilities:

```text
current group
→ search current group history

Owner private
→ search only groups currently granted to that Owner
```

Use an explicit protected Action:

```text
history:read
```

Bot membership or ordinary Conversation access must not silently imply bulk history permission.

Complete Channel history is separate from existing Run input messages:

```text
messages
  Agent Run input

channel_messages
  durable Channel history / retrieval source
```

P4B should prove the real NapCat `get_group_msg_history` path first, then add a durable channel archive / search store for repeated search.

P4B implementation is upstream-first:

```text
HKUDS/MGP
  RecallIntent / SearchResult contract

TokenRhythm/opensquilla
  Retrieval Engine, FTS / hybrid interface, decay, source weighting, MMR

HKUDS/OpenHarness
  bounded lexical fallback when FTS is unavailable

NapCat / OneBot
  QQ history source
```

The first production configuration uses the OpenSquilla-derived retriever with:

```text
vector_weight = 0
text_weight = 1
```

This keeps the first path lexical without designing a throwaway lexical-only API.

P4B consumes P4A through the MGP-derived canonical Memory contract. It must be able to develop against deterministic fixtures before P4A merges.

#### Shared P4 contract

Do not invent a Glassbox-only Memory / Retrieval protocol when the mature upstream contract fits.

P4A ports MGP-style:

```text
MemoryObject
MemoryCandidate
MemoryEvidence
MemoryMergeHint
lifecycle semantics
```

P4B ports MGP-style:

```text
RecallIntent
Search request / response
SearchResult metadata
RetrievalMode
ReturnMode
RedactionInfo
```

For non-Memory sources such as QQ group messages, Glassbox keeps the real ChannelMessage provenance and reuses the same retrieval metadata instead of pretending the message is canonical Memory.

P4B owns authorization-first querying and OpenSquilla-derived ranking / Context projection.

P4B must not mutate P4A confidence or promotion state.

P4A must not implement retrieval ranking or bypass P4B authorization.

#### P4 success

Measure whether the Agent needs less correction and retrieves the right protected information.

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
History Retrieval Precision
Unauthorized Candidate Count
```

P4 completion requires both P4A and P4B completion gates to pass. A large Memory table or a large search index is not success by itself.

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

- Active implementation scope comes from the owned active Plan and tracking Issue, not future roadmap sections.
- Pi is an engine; Lora PI Kit is a distribution; Glassbox is the Personal Agent system.
- `lora-sys/skills` is canonical Skill source; a Kit release uses a pinned snapshot.
- Package / profile / MCP presence never overrides Glassbox authorization.
- Glassbox Task state is durable product truth; Herdr state is execution observation.
- Taste is preference, not authority.
- A new Runtime, Channel, MCP integration, Memory system, cache, Worker, or plugin cannot bypass the trust boundaries proven in P3.
- External `done` never means accepted unless Glassbox records acceptance.
- Local testing must preserve the same contracts intended for Linux server deployment.
- Build one usable vertical loop at a time and keep focused regression coverage for working behavior.
