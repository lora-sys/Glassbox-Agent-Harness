# Glassbox Memory and Taste

## P4A Owner confirmation boundary

The Owner-private `owner_memory_admin` Tool reads the current persisted Run input before
changing canonical Memory. A model-suggested `write` or `supersede` creates a pending
candidate; it cannot use a prompt description as confirmation. The Owner can inspect
the candidate and send `/memory promote <candidate-id>` in a later message. Exact
`/memory reject <candidate-id>` and `/memory expire|revoke|retire <memory-id>` commands
govern lifecycle. An explicit write uses
`/memory write global|project:<project-id> <memory-type> <statement>`; an explicit
correction uses `/memory supersede <memory-id> <statement>` and inherits the original
scope and type. `/memory feedback global|project:<project-id> <signal> <statement>`
records a feedback event and a scoped candidate, never immediate Taste.

Conversation extraction and enabled, authorized QQ source reads are available through
the Owner-private Tool's `extract` and `source` actions. Both create candidates only;
the source content remains untrusted evidence with group, message, sender, Run and
authorization provenance. This is a deterministic product path, not proof of a live
QQ/NapCat acceptance run.

Status: CURRENT DIRECTION / P4A ACTIVE / P4B CONSUMER

This document defines the ownership and learning boundary between Rules, Skills, Taste, Feedback, and durable Memory.

P3 is complete. Memory and Taste implementation now belongs to `.plans/04a-memory-taste.md` and Issue #9. Authorized retrieval and QQ history search belong to `.plans/04b-authorized-retrieval-history.md` and Issue #10.

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
TasteCandidate
TasteEntry
confidence
scope
promotion / demotion
retrieval
visibility and authorization
provenance
MemoryCandidate
Semantic Memory
Episodic Memory
```

Turso is the default structured store for these records.

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

Glassbox keeps Principal, Authorization, Project / Resource scope, Conversation / Run / Task linkage, Turso truth, Audience / Delivery and Trace.

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

Future scopes may include repository, path, language, framework, team, or task class only when a real need appears.

Do not let project Taste silently contaminate global Taste.

### TasteEntry

Initial conceptual shape:

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

The exact schema is not frozen until P4 implementation begins.

## Feedback Ledger

Do not update Taste directly from a transient UI event without preserving the evidence.

First persist a FeedbackEvent.

Conceptual shape:

```text
FeedbackEvent
  id
  userId
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

The first implementation should use the smallest explainable evidence policy needed to prove:

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

If implementation needs a confidence formula not provided by the approved upstream mechanisms, record that gap in the P4A PR before adding one.

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

P4 keeps at least two durable Memory classes:

```text
Semantic Memory
  durable facts, decisions, relationships, known project information

Episodic Memory
  meaningful prior events, tasks, conversations, outcomes, failures, and lessons
```

Procedural knowledge that stabilizes into a reusable validated workflow should normally become a Skill.

Raw Conversation history is not automatically Memory.

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

P4 is now two intentionally parallel streams.

### P4A — Memory and Taste

P4A owns the learning write side:

```text
Feedback Ledger
Taste Candidate + Confidence
global / project scope
promotion / demotion / retirement
Semantic Memory
Episodic Memory
Owner inspection / administration
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

Taste still comes before broad Memory retrieval as a learning mechanism, but P4A and P4B can be implemented in parallel because P4B develops against deterministic retrieval fixtures until the P4A projection is available.

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

- Rules are explicit authority; Taste is preference.
- Skills are reusable procedures; Taste is not a procedure library.
- Taste is not generic Memory.
- One edit is evidence, not a permanent preference.
- Every Taste entry has scope, confidence, provenance, and supporting evidence.
- Project Taste does not silently become global Taste.
- Taste and Memory are filtered by authorization before model-visible Context.
- Only task-relevant Taste is injected.
- Glassbox/Turso owns durable Taste and Feedback truth.
- Lora PI Kit may bridge Taste into Pi but does not become the canonical store.
- Runtime-specific learning signals must map back to Glassbox-owned FeedbackEvent records.
