# Glassbox Memory and Taste

## P4A Owner confirmation boundary

The Owner-private `owner_memory_admin` Tool reads the current persisted Run input before
changing canonical Memory. A model-suggested `write` or `supersede` creates a pending
candidate; it cannot use a prompt description as confirmation. The Owner can inspect
all pending candidates together with `/memory candidates`, then promote or reject up to
20 candidates in one Owner-private message with `/memory promote <candidate-id> <candidate-id>`
or `/memory reject <candidate-id> <candidate-id>`. A single candidate may also be reviewed
with one ID. `/memory ok` reviews the latest pending creation Run in this Owner's current
Conversation, up to 20 candidates. `/memory promote last` reviews the last candidate in
that Run. Both use server-written creation audit events and persisted Run order, so source
message references, candidate timestamps and model metadata cannot choose the batch.
Current and later Runs are excluded. A repeated suggestion that reuses a pending candidate
does not change its original batch; use its explicit ID to review it separately. Source
results distinguish newly created candidates from reused pending candidates. `imported`
counts both kinds returned by the read, while `created` counts additions to this Run.
Exact `/memory expire|revoke|retire <memory-id>` commands govern lifecycle.
An explicit write uses
`/memory write global|project:<project-id> <memory-type> <statement>`; an explicit
correction uses `/memory supersede <memory-id> <statement>` and inherits the original
scope and type. Statement-only corrections also preserve sensitivity, retention policy and
the original absolute TTL deadline. Explicit replacement metadata takes precedence. An explicit
supersession records its own confirmation candidate, even when a matching suggestion is
already pending; the suggestion and its evidence remain unchanged.
Pending corrections require an active target at promotion time. When a candidate records
`ifMatchUpdatedAt`, its target must still have that exact version. New Owner Tool and
extraction candidates record the version they inspected; historical candidates without
that field retain the active-target check. A stale review leaves the candidate pending and
writes no replacement. `/memory feedback global|project:<project-id> <signal> <statement>`
records a feedback event and a scoped candidate, never immediate Taste.

Inspection uses `/memory list [all|global|project:<project-id>]`, `/memory get <memory-id>`
and `/memory candidates`. An authorized QQ source can be imported through
`/memory source global|project:<project-id> <group-id> <source-class>`. Source class is one
of `history`, `notice`, `essence`, `metadata`, `file` or `album`. The Tool contract also
supports bounded query, limit, since and until fields for time-bounded source reads.

Conversation extraction and enabled, authorized QQ source reads are available through
the Owner-private Tool's `extract` and `source` actions. Both create candidates only;
the source content remains untrusted evidence with group, message, sender, Run and
authorization provenance. This is a deterministic product path, not proof of a live
QQ/NapCat acceptance run.

Status: IMPLEMENTED LEARNING BOUNDARY / P4A AND P4B COMPLETE

This document defines the ownership and learning boundary between Rules, Skills, Taste, Feedback, and durable Memory.

P3, P4A and P4B are complete. `.plans/04a-memory-taste.md` and Issue #9 record the learning implementation; `.plans/04b-authorized-retrieval-history.md` and Issue #10 record authorized retrieval and QQ history search. The current learning implementation lives in `apps/server/src/learning/`; later sections retain explicitly labeled conceptual designs.

## Decision

Do not collapse Rules, Skills, Taste, and Memory into one prompt file or one generic memory bucket.

The stable split is:

```text
Rules
  hard constraints and explicit product / project requirements

Skills
  reusable validated procedures for how to perform work

Taste
  learned user preferences about how work should be done

Memory
  durable knowledge about facts, decisions, events, and prior work
```

These concepts may interact, but they have different authority and lifecycle.

```text
Rules ≠ Skills
Skills ≠ Taste
Taste ≠ Memory
Memory ≠ Rules
```

## Why Taste exists

A user should not need to continuously maintain a growing prompt that describes every coding preference.

Taste learns from behavior.

Useful signals include:

```text
accept
reject
edit
revert
repeated correction
explicit praise
explicit correction
```

Example:

```text
Agent repeatedly generates default exports
→ user repeatedly changes them to named exports
→ produce a Taste candidate
→ repeated evidence raises confidence
→ relevant future TypeScript tasks receive that Taste
```

The learned preference is not automatically a hard Rule.

```text
Prefer named exports over default exports.
```

means a preference.

```text
Named exports are required by this repository.
```

is a Rule and requires an explicit source of authority.

## Ownership

Glassbox owns durable learning truth:

```text
FeedbackEvent
MemoryCandidate
CanonicalMemory
confidence and scope
promotion / rejection / lifecycle changes
retrieval
visibility and authorization
source provenance and audit evidence
```

The server stores these records in its local libSQL/SQLite database through `@libsql/client`. The format is Turso-compatible; the current database boundary accepts local paths or `:memory:` and has no remote Turso configuration.

### Implemented learning records

- `apps/server/src/learning/contracts.ts` defines `MemoryCandidate` and `FeedbackEvent`
- `apps/server/src/learning/store.ts` owns candidate creation, feedback, review, promotion and Memory lifecycle operations
- `packages/contracts/src/memory.ts` defines the shared `CanonicalMemory`, scope, evidence and retention contracts
- `apps/server/src/persistence/schema.ts` stores `memory_candidates`, `memories`, `feedback_events` and `memory_audit_events`

`MemoryCandidate` carries the following fields. The TypeScript contract is authoritative:

```text
candidateId
candidateKind = assertion | confirmation | correction | derived
subject
scope = { type: global } | { type: project, projectId } | { type: group, connectionId, botId, groupId }
proposedType = preference | semantic_fact | episodic_event | relationship
statement
content
source
sourceEvidence
confidence?
sensitivity?
retentionPolicy?
ttlSeconds?
mergeHint
extensions
status = pending | promoted | rejected
createdAt
reviewedAt?
promotedMemoryId?
```

Feedback-derived Taste uses a `MemoryCandidate` with `proposedType = preference` and `extensions["glassbox:taste"] = true`. Promotion uses the shared `CanonicalMemory` contract with `type = preference`; there is no separate `taste_*` table. Semantic and episodic Memory use the same contract with their respective types. Server-owned source dependencies are stored separately from model-editable candidate content.

`TasteEntry` and `OwnerInsight` below are conceptual designs, not implemented record types or tables. In particular, there is no `owner_insights` table or `OwnerInsight` contract.

Lora PI Kit owns Pi-specific integration behavior:

```text
capture or forward usable runtime feedback signals
request task-relevant Taste from Glassbox
inject selected Taste into Pi runtime Context
expose runtime hooks needed for observation
```

Lora PI Kit is not the canonical Taste database.

## P4 upstream implementation map

P4 follows the repository upstream-first rule.

```text
MGP
  canonical Memory / Candidate / Evidence / lifecycle / Recall contracts

LangMem
  semantic / episodic extraction and consolidation behavior

OpenHarness Memory
  signature / dedupe / TTL / supersedes / freshness hygiene

Learning-Multi-Factor-Memory
  interpretable retention value and forgetting mechanism

Command Code
  Taste behavior signals and user / project preference concept

OpenSquilla
  retrieval pipeline, FTS / hybrid interface, temporal decay and MMR

NapCat / OneBot
  QQ history source
```

Glassbox keeps Principal, Authorization, Project / Resource scope, Conversation / Run / Task linkage, local database truth, Audience / Delivery and Trace.

Do not design a second generic Memory or Retrieval protocol when the upstream contract fits.

See:

```text
upstream/mgp/SOURCES.md
upstream/command-code/SOURCES.md
upstream/opensquilla/SOURCES.md
upstream/openharness/SOURCES.md
```


The same Glassbox Taste should later be usable by Pi, Codex, Claude Code, or another Runtime without duplicating preference truth per Runtime.

`lora-sys/skills` remains the canonical source for reusable Agent Skills. Lora PI Kit may install or load selected Skills.

## Rules

Rules are explicit, high-authority constraints.

Examples:

```text
protected Tools must re-authorize before execution
production deploy requires approval
this repository uses named exports
never write automated tests into production state
```

Rules should not silently change because a user edited one output once.

A learned pattern may suggest a Rule candidate, but promotion to a hard Rule must use an explicit product or project action.

`AGENTS.md` contains stable repository invariants. Project-specific implementation rules belong in the appropriate project rule surface, not in Taste.

## Skills

Skills encode reusable procedures.

Examples:

```text
review a pull request
deploy Glassbox
add a QQ Channel
investigate a Herdr reconnect issue
```

A repeated procedure learned from successful work may become a Skill candidate.

A procedural pattern that is stable, reusable, and testable should normally be promoted to a Skill rather than remain generic Memory.

## Taste

Taste represents user preference, not authority.

Minimum P4 scope:

```text
global
project
```

Meaning:

```text
global
  long-lived personal preference across projects

project
  preference specific to one Glassbox Project / repository context
```

## Owner learning loop and QQ group Memory

Issue #37 extends the completed P4 storage and retrieval paths into normal Runs.

- Clear Owner-authored preferences, corrections, and explicit remember requests create pending candidates. A private Owner conversation proposes global scope. A group Run proposes only that exact QQ connection, bot, and group scope.
- Visitor messages, quoted text, retrieved history, Tool output, credentials, and ambiguous group statements do not create candidates automatically. The Owner can import authorized group history into candidates with the Owner-private Memory Tool.
- Pending candidates are available together through `/memory candidates`. No per-candidate private notification is sent. Only an explicit Owner review can promote a candidate.
- Active global Memory is read only in Owner-private Runs. Active public group Memory is read only in Runs from its exact QQ group scope. Group Memory never becomes global or project Memory.
- Bounded Memory reads filter expired rows before applying the limit. Group reads also filter non-public rows before the limit. Expiry at the query timestamp is inactive; Owner inspection can still request inactive records.
- The Runtime selects a bounded set of active preferences and relevant facts. It records Memory IDs and counts in Trace, not statements. Selected context is included in the P5 token budget; optional learning context is dropped first if it would overflow the model capacity.

Group scope is `{ connectionId, botId, groupId }`. QQ-native group roles do not grant Memory authority. The group Resource and current Run authorization gate group candidate writes and active group reads.

Future scopes may include repository, path, language, framework, team, or task class only when a real need appears.

Do not let project Taste silently contaminate global Taste.

### Conceptual TasteEntry

Historical design sketch, not the current persistence or API contract. Use `MemoryCandidate` and `CanonicalMemory` above when implementing or consuming learning records:

```json
{
  "id": "taste_01",
  "preference": "Prefer named exports over default exports",
  "category": "typescript.exports",
  "scope": {
    "type": "global"
  },
  "confidence": 0.82,
  "positive": 7,
  "negative": 1,
  "observations": 8,
  "firstSeen": "2026-09-01T00:00:00Z",
  "lastSeen": "2026-09-15T00:00:00Z",
  "status": "active"
}
```

The implemented schema is defined by the learning and shared Memory contracts linked above. The counters in this sketch are not separate persisted `TasteEntry` fields.

## Feedback Ledger

Do not update Taste directly from a transient UI event without preserving the evidence.

First persist a FeedbackEvent.

Current shape from `apps/server/src/learning/contracts.ts`:

```text
FeedbackEvent
  id
  principalId
  scope
  signalType
  statement
  category?
  conversationId?
  runId?
  taskId?
  artifactRef?
  evidence
  createdAt
  candidateId
```

Minimum signal types:

```text
accept
reject
edit
revert
explicit_positive
explicit_negative
```

Repeated corrections are derived from multiple events rather than stored as a magical one-off signal.

Feedback may contain sensitive code, text, or artifact references. It inherits normal Glassbox visibility and authorization rules.

## Candidate before preference

One edit must not become a permanent preference.

Use the MGP candidate / evidence / merge model instead of inventing another candidate lifecycle.

```text
FeedbackEvent
→ MGP-style Memory / Taste Candidate
→ evidence
→ reinforce / correction / dedupe / manual review as applicable
→ promote only through the Glassbox governed path
```

Do not freeze arbitrary numeric confidence thresholds in architecture documentation.

The learning store applies an evidence policy with these boundaries:

```text
single edit
  evidence only

repeated support
  can strengthen a candidate

contradicting correction
  can weaken, replace or retire a candidate

explicit current user instruction
  wins over learned Taste
```

The current feedback confidence calculation lives in `LearningStore.recordFeedback`. Changes to that calculation need evidence and tests; confidence never grants permission or bypasses Owner review.

## Confidence

Confidence remains evidence-backed metadata, not authority.

Use MGP evidence / candidate semantics and Command Code's behavior signals as the base.

Do not mutate a hard Rule because confidence changed.

P4A owns confidence evidence and promotion state. P4B may use confidence as one retrieval signal but must not mutate it.

## Task-aware Taste retrieval

Do not inject the whole Taste profile into every request.

The normal path is:

```text
current task / MGP-style RecallIntent
→ resolve authorized Principal + project source set
→ OpenSquilla-derived retrieval
→ bounded Top K
→ inject only selected Taste into Runtime Context
```

Example:

```text
Task: edit a React TypeScript page

Relevant Taste:
- prefer named exports
- avoid unnecessary component abstraction
- prefer integration tests for page behavior
- prefer direct error messages

Not relevant:
- Python packaging preference
- CLI flag style
- database migration naming
```

Taste retrieval follows the same authorization-before-context rule as Memory retrieval.

A private Taste or project-specific Taste must not leak into an unauthorized Principal's Context.

## Memory

Taste answers:

```text
How does this user prefer work to be done?
```

Memory answers questions such as:

```text
What happened before?
What decision was made?
What fact should remain available?
What result did an earlier Task produce?
```

The canonical Memory contract includes these two knowledge types, alongside `preference` and `relationship`:

```text
Semantic Memory
  durable facts, decisions, relationships, known project information

Episodic Memory
  meaningful prior events, tasks, conversations, outcomes, failures, and lessons
```

Procedural knowledge that stabilizes into a reusable validated workflow should normally become a Skill.

Raw Conversation history is not automatically Memory.

### Memory scope

Memory must keep the scope and visibility of its evidence unless an explicit authorized action changes them.

Initial useful namespaces include:

```text
owner_private
project
group
```

A group-derived Memory stays in that group's namespace by default.

```text
group A evidence
→ group A Memory
```

It must not silently become group B Context.

The Owner private Main Agent may retrieve across several authorized group namespaces for Owner use. Cross-group synthesis should create a derived Owner-only insight with source provenance instead of rewriting source group Memory.

Planned conceptual shape; no dedicated `OwnerInsight` type or table exists:

```text
OwnerInsight
  statement
  sourceScopes
  sourceRefs
  confidence
  visibility = owner_private
```

A later explicit promotion may turn repeated cross-group evidence into a Skill candidate, Rule candidate, system-learning candidate, or product improvement proposal.

A future group-assignment implementation may contribute Memory evidence. Group assignments remain a planned operational model; their outcomes must use the governed learning path rather than imply automatic promotion.

## Memory promotion

A Memory candidate should consider at least:

```text
future utility
goal relevance
reliability
reuse
novelty
staleness
contradiction
privacy risk
source provenance
```

Protected Memory inherits the source visibility unless an explicit authorized action changes that visibility.

## Authorized retrieval

The required order is:

```text
resolve Principal
→ resolve authorized visibility / namespace set
→ retrieve only inside the authorized set
→ rank / rerank
→ apply context budget
→ assemble model-visible Context
```

Forbidden:

```text
retrieve private + public candidates globally
→ send everything to model
→ ask model to ignore unauthorized content
```

Retrieval implementation should port the OpenSquilla `MemoryRetriever` architecture rather than inventing a new ranking pipeline.

P4B starts with:

```text
vector_weight = 0
text_weight = 1
```

so the first production path is lexical / FTS while keeping the same interface for later hybrid retrieval.

When FTS is unavailable in the exact Glassbox database path, port the bounded OpenHarness Memory search fallback.

## Runtime integration

Glassbox selects the information.

Runtime adapters only receive the selected projection.

Target shape:

```text
Glassbox
  Rules
  Skill selection
  Taste retrieval
  Memory retrieval
        ↓
Authorized Runtime Context
        ↓
Pi + Lora PI Kit
or Codex / Claude / future Runtime
```

Do not create a separate Taste truth inside every Runtime.

## P4 split ownership

P4 was delivered as two parallel streams. The completed plans record their acceptance; the responsibilities below still define the write/read boundary.

### P4A — Memory and Taste

P4A owns the learning write side:

```text
P4.0 — Feedback Ledger
  capture durable accept / reject / edit / revert evidence

P4.1 — Taste Candidate + Confidence
  global / project scope
  promotion / demotion
  contradiction handling

P4.2 — Task-aware Taste Retrieval
  relevant Top K only
  runtime injection
  scope and authorization checks

P4.3 — Semantic Memory
  facts, durable project knowledge, and group-scoped knowledge

P4.4 — Episodic Memory
  meaningful prior Run / Task / Conversation / group-assignment outcomes

P4.5 — Authorized Retrieval
  lexical first, hybrid/vector when justified
  Owner-private cross-group retrieval without group-to-group leakage

P4.6 — Inspection and Eval
  inspect evidence, confidence, scope, retrieval reason, and impact
```

P4A decides what becomes durable truth and preserves evidence for that decision.

Model or extractor inference may create a Candidate. It must not directly create active durable Memory or Taste.

### P4B — Authorized Retrieval and QQ History

P4B owns the read side:

```text
authorized source-set resolution
QQ group-history retrieval
Owner-private authorized cross-group search
Memory retrieval
Taste retrieval
ranking
Top K
Runtime Context projection
retrieval evidence
```

P4B must authorize before protected candidates are loaded.

P4A exposes canonical MGP-derived Memory objects plus Glassbox Resource / scope mapping. P4B consumes them through MGP-style Recall / SearchResult contracts without mutating P4A confidence or promotion state.
The shared `@glassbox/contracts` package exports this canonical Memory, scope, lifecycle,
evidence and retention boundary. P4B does not import the P4A store implementation.

P4B consumes the implemented canonical Memory projection. Deterministic fixtures continue to test retrieval without writing to live learning state.

## Eval

P4 should measure whether learning reduces correction work rather than only counting stored memories.

Useful metrics include:

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

Compare behavior before and after Taste injection on fixed tasks where possible.

A preference system that stores many entries but increases correction rate is a regression.

## Command Code reference

Command Code is a primary mechanism reference for Taste, not a dependency.

Its public Taste documentation describes a continuous loop where accept, reject, and edit behavior becomes a learning signal, and project/user scopes are handled separately.

Glassbox adopts the useful product idea while keeping its own trust and data model:

```text
behavior as feedback
separate Rules / Skills / Taste
global + project preference scope
continuous preference learning
small relevant context instead of manual prompt growth
```

Glassbox does not depend on Command Code's proprietary `taste-1` model or copy its internal implementation.

See `upstream/command-code/SOURCES.md` for the reference note.

## Stable boundaries

### Website knowledge and personal learning progress

Issue #139 adds two separate sources. Published articles from `https://lora-sys.github.io/loraSys/` form a versioned website corpus. They do not become Canonical Memory. The Owner can use `/knowledge sync`, `/knowledge enable`, `/knowledge disable`, and `/knowledge status` in private chat. Enabled synchronization refreshes every six hours and retains the last complete corpus when a refresh fails. Related answers can cite published article URLs and expose the source dates in runtime Context.

Learning progress records belong to a trusted channel identity and retain their original source scope. Current group Context uses only the sender's records from that group. Private Context can continue that sender's group progress only while current identity, original history permission, source enablement and destination permission allow it. General group Memory and another person's records remain excluded.

Explicit learning goals are observations. Repeated questions are low-confidence cues and require separate occurrences. Neither creates confirmed Taste. `/progress list`, `/progress remember <statement>`, `/progress confirm <id>`, `/progress correct <id> | <statement>`, and `/progress delete <id>` operate on the caller's own records. Correction and deletion change the revision and invalidate previous Context and pending delivery dependencies. Normal group replies do not disclose the sender's previous questions.

The Owner can request `/knowledge interests <topic>` to create pending preference candidates supported by article excerpts. The existing Owner candidate review decides promotion. Website updates retire old delivery dependencies. Progress source revocation, identity unbinding and record revision changes are checked before provider requests and delivery.

- Rules are explicit authority; Taste is preference.
- Skills are reusable procedures; Taste is not a procedure library.
- Taste is not generic Memory.
- One edit is evidence, not a permanent preference.
- Every Taste entry has scope, confidence, provenance, and supporting evidence.
- Project Taste does not silently become global Taste.
- Taste and Memory are filtered by authorization before model-visible Context.
- Only task-relevant Taste is injected.
- Glassbox owns durable Taste and Feedback truth in the local libSQL/SQLite database.
- Lora PI Kit may bridge Taste into Pi but does not become the canonical store.
- Runtime-specific learning signals must map back to Glassbox-owned FeedbackEvent records.
