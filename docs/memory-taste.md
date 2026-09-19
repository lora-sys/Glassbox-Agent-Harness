# Glassbox Memory and Taste

Status: CURRENT DIRECTION / P4 PLANNED

This document defines the ownership and learning boundary between Rules, Skills, Taste, Feedback, and durable Memory.

The current fast-follow source of truth is `.plans/03-plus-owner-group-utility.md`. P4 remains the first implementation phase for Taste and Memory.

P3+ may persist group assignments, participant progress, completion evidence, schedules, and runtime configuration. Those records are structured product state, not Memory. They must not be described as Semantic Memory, Episodic Memory, or Taste merely because they are durable.

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

The loop is:

```text
FeedbackEvent
→ pattern extraction
→ TasteCandidate
→ repeated supporting / contradicting evidence
→ confidence update
→ promote, keep candidate, demote, or retire
```

A useful first policy may look like:

```text
confidence < 0.40
  evidence only / weak candidate

0.40 - 0.70
  candidate

0.70 - 0.90
  active Taste

>= 0.90
  strong Taste
```

These thresholds are implementation defaults, not product laws. P4 tests may change them.

## Confidence

Confidence is not raw observation count.

At minimum consider:

```text
supporting evidence
contradicting evidence
recency
consistency
signal strength
scope consistency
```

Recent repeated corrections should be able to lower confidence in an old preference.

Explicit user statements such as:

```text
"以后都这样写"
"以后不要这样做"
```

are stronger signals than one incidental edit, but still preserve evidence and scope.

Do not mutate a hard Rule because Taste confidence changed.

## Task-aware Taste retrieval

Do not inject the whole Taste profile into every request.

The normal path is:

```text
current task
→ derive task / language / framework / domain hints
→ resolve authorized user + project scope
→ retrieve relevant Taste candidates
→ rank by relevance × confidence × recency
→ choose a small Top K
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

Later hybrid retrieval may combine:

```text
lexical search
vector search
source weighting
temporal decay
diversity reranking
confidence / reliability
context budget
```

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

## P4 implementation order

Planned slices:

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
  facts and durable project knowledge

P4.4 — Episodic Memory
  meaningful prior Run / Task / Conversation outcomes

P4.5 — Authorized Retrieval
  lexical first, hybrid/vector when justified

P4.6 — Inspection and Eval
  inspect evidence, confidence, scope, retrieval reason, and impact
```

Taste comes before broad Memory retrieval because it can deliver user value with a smaller mechanism and can be evaluated directly through correction behavior.

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
