# Plan 04A — Memory and Taste Durable Learning Truth

Status: ACTIVE PARALLEL P4 STREAM

Tracking Issue: #9

This plan is one of two intentionally parallel P4 implementation streams.

The sibling plan is:

\`\`\`text
.plans/04b-authorized-retrieval-history.md
\`\`\`

One Issue owns this plan and one later PR must stay inside this plan's boundary.

## Goal

Build the durable write side of Glassbox learning.

P4A decides what becomes long-lived knowledge or preference, preserves why it exists, and lets the Owner inspect and control it.

P4A does not implement group-history search, retrieval ranking, Top K selection, or Runtime Context injection.

Acceptance sentence:

> An Owner can explicitly create, inspect, update, retire, and revoke durable project knowledge across restart. Real feedback can create scoped Taste candidates with evidence and confidence, but one edit cannot silently become a permanent preference, project Taste cannot leak into global Taste, and no model-generated inference can become active durable truth without an explicit promotion path.

## Ownership

P4A owns:

\`\`\`text
FeedbackEvent
TasteCandidate
TasteEntry
Taste confidence
supporting / contradicting evidence
global / project Taste scope
MemoryCandidate
Semantic Memory
Episodic Memory
provenance
reliability
promotion
demotion
supersession
retirement
Owner inspection / administration
learning evidence
\`\`\`

P4A does not own:

\`\`\`text
QQ group-history transport
cross-group search
lexical / vector search
retrieval ranking
Top K
Context budget
Runtime Context injection
Delivery of retrieved content
\`\`\`

## Stable distinction

\`\`\`text
Rules
  explicit authority-bearing constraints

Skills
  reusable validated procedures

Taste
  learned preference

Memory
  promoted durable facts, decisions, events and prior-work knowledge
\`\`\`

\`\`\`text
Rules ≠ Skills ≠ Taste ≠ Memory
\`\`\`

Taste never grants authority.

A stable repeatable procedure should normally become a Skill rather than generic Memory.

Raw Conversation history is not automatically Memory.

## What can be reused now

Current Glassbox already provides the important trust and persistence base:

\`\`\`text
Principal
Resource
Grant
AuthorizationDecision
Conversation
Run
Task / TaskAttempt
messages
Raw Trace / ops_trace_events
Turso / SQLite-compatible DomainDatabase
protected Pi Tool wrapper
Owner-private Tool visibility pattern
\`\`\`

Relevant code:

\`\`\`text
apps/server/src/persistence/schema.ts
apps/server/src/persistence/database.ts
apps/server/src/conversation/store.ts
apps/server/src/auth/service.ts
apps/server/src/runtime/pi/protected-tools.ts
apps/server/src/runtime/pi/owner-tools.ts
\`\`\`

The existing \`owner_group_admin\` Tool is the pattern to reuse for an Owner-only learning administration Tool. Tool visibility and execution authorization remain separate.

The repository already pins Command Code only as a mechanism reference:

\`\`\`text
upstream/command-code/SOURCES.md
\`\`\`

Do not vendor or depend on Command Code. Glassbox owns the learning data model and promotion policy.

## Data model direction

The exact schema may change during implementation, but every promoted record must preserve enough information to explain why it exists.

### FeedbackEvent

Minimum direction:

\`\`\`text
id
principalId
projectId?
conversationId?
runId?
taskId?
artifactRef?
signalType
beforeRef?
afterRef?
categoryHints?
visibility
createdAt
\`\`\`

Minimum signals:

\`\`\`text
accept
reject
edit
revert
explicit_positive
explicit_negative
\`\`\`

Repeated correction is derived from evidence. It is not a magical single signal.

### TasteCandidate / TasteEntry

Minimum direction:

\`\`\`text
id
preference
category
scope
confidence
supportingEvidence
contradictingEvidence
observations
firstSeen
lastSeen
status
sourceRefs
\`\`\`

P4A supports only:

\`\`\`text
global
project
\`\`\`

Do not add repository, path, language, framework, team, or task-class scope without a tested need.

### MemoryCandidate / Memory

At minimum keep two promoted classes:

\`\`\`text
Semantic Memory
  durable facts, decisions, relationships and project knowledge

Episodic Memory
  meaningful prior Runs, Tasks, Conversations, outcomes, failures and lessons
\`\`\`

Useful lifecycle fields include:

\`\`\`text
sourceRefs
reliability
visibility
status
createdAt
updatedAt
expiresAt?
supersedes?
retiredAt?
\`\`\`

Expiration is optional. Long-lived facts and decisions should support supersession and retirement rather than forced arbitrary expiry.

## Write authority

Do not expose a generic model-controlled \`write_memory(anything)\` path.

Allowed directions:

\`\`\`text
explicit Owner Action
  → may create or change durable truth after authorization

deterministic product event
  → may append FeedbackEvent evidence

model / extractor inference
  → may create Candidate only
  → cannot directly create active Memory or active Taste
\`\`\`

The model cannot convert its own guess into durable truth.

## Implementation route

### P4A.0 — Contracts and isolated fixtures

Define durable types, migrations and disposable test fixtures for:

\`\`\`text
FeedbackEvent
TasteCandidate
TasteEntry
MemoryCandidate
SemanticMemory
EpisodicMemory
source references
scope
status
\`\`\`

Prove restart / reopen before runtime integration.

### P4A.1 — Feedback Ledger

Persist explicit and deterministic feedback evidence.

Require:

\`\`\`text
source linkage
Principal
scope
visibility
timestamp
append-only evidence semantics
\`\`\`

Do not update Taste directly from a transient event.

### P4A.2 — Taste candidate and confidence

Implement candidate creation and confidence updates.

At minimum consider:

\`\`\`text
supporting evidence
contradicting evidence
recency
signal strength
scope consistency
\`\`\`

One edit remains evidence only.

Explicit current user instruction remains stronger than learned Taste.

### P4A.3 — Promotion, demotion and scope isolation

Support:

\`\`\`text
candidate
active
retired
\`\`\`

and explicit promotion / demotion behavior.

Prove project Taste cannot silently become global Taste.

### P4A.4 — Semantic Memory

Support explicit durable facts and decisions with provenance, reliability, visibility, supersession and retirement.

### P4A.5 — Episodic Memory

Promote meaningful prior execution evidence without treating every message as Memory.

Store references to durable evidence where possible instead of duplicating large protected payloads.

### P4A.6 — Owner inspection and administration

Add a narrow Owner-private protected surface, conceptually:

\`\`\`text
memory_admin

list
get
add_explicit
update
retire
delete or revoke where policy permits
review_candidate
promote
reject_candidate
\`\`\`

The exact Tool name is not frozen.

Every mutation re-authorizes immediately before execution and records evidence.

## Shared contract with P4B

P4A must expose retrieval-facing records without implementing retrieval policy.

Conceptual projection:

\`\`\`text
id
kind
text or summary
scope
resourceId
visibility
sourceRefs
occurredAt?
createdAt
status
confidence?
\`\`\`

P4B may query this projection only inside an already authorized source set.

P4B owns ranking and Context selection.

## Tests

Deterministic tests must cover at least:

\`\`\`text
explicit Memory survives restart
update / supersede / retire survives restart
one edit does not create active Taste
repeated supporting evidence raises confidence
contradicting evidence can lower confidence
project Taste never becomes global implicitly
Visitor cannot inspect Owner-private learning state
model inference produces Candidate only
revoked / retired entries are not returned as active truth
provenance links remain inspectable
Owner mutation records authorization evidence
test state is isolated from live state
\`\`\`

## Completion gate

P4A is complete only when:

- durable Memory and Taste truth lives in Glassbox / Turso-compatible state;
- feedback evidence exists before learned preference promotion;
- one edit cannot become permanent Taste;
- project and global Taste are isolated;
- Semantic and Episodic Memory are distinct;
- model inference cannot directly create active durable truth;
- Owner can inspect and manage learning state through a protected surface;
- restart preserves active, candidate, retired and provenance state;
- P4B can consume the stable retrieval-facing projection without depending on P4A internals;
- focused authorization, persistence and learning tests pass.

## Non-goals

Do not add in this Issue:

\`\`\`text
QQ history search
Owner cross-group search
vector database
generic Context compression
Context Budget Governor
token routing
new Channels
LongTask
Skill generation
full Eval platform
frontend management UI
\`\`\`
