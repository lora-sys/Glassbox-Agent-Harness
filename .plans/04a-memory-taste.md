# Plan 04A — Memory and Taste Durable Learning Truth

Status: ACTIVE PARALLEL P4 STREAM

Tracking Issue: #9

This plan is one of two intentionally parallel P4 implementation streams.

Sibling:

```text
.plans/04b-authorized-retrieval-history.md
```

One Issue owns this plan and one later PR must stay inside this boundary.

## Goal

Build the durable write side of Glassbox learning by porting mature upstream mechanisms instead of designing a new Memory system.

Acceptance sentence:

> An Owner can explicitly create, inspect, update, expire, revoke, and govern durable project knowledge across restart. Conversation and feedback evidence can produce candidates through mature upstream contracts and consolidation behavior, but one edit cannot silently become permanent Taste, project Taste cannot become global Taste, and model inference cannot bypass the candidate / promotion boundary. Every protected mutation is authorized by Glassbox and remains traceable.

## Upstream-first rule

Implementation order:

```text
MGP
  Memory / Candidate / Evidence / lifecycle contracts

LangMem
  conversation → structured Memory extraction / consolidation

OpenHarness Memory
  signature / dedupe / TTL / disabled / supersedes / freshness

Learning-Multi-Factor-Memory
  value / retention / forgetting mechanism

Command Code
  Taste behavior signals and user/project scope

Glassbox
  Principal / Authorization / Project / Turso / Trace only
```

Do not invent a standard Memory mechanism until the listed upstreams have been checked.

Any new generic mechanism must record why the relevant upstream cannot be used.

## Primary upstream source map

### MGP

Pinned:

```text
HKUDS/MGP
54ce6c00e3d0aa731ecbe17e74407cbbb5a96f10
```

Repository note:

```text
upstream/mgp/SOURCES.md
```

Port first:

```text
schemas/memory-object.schema.json
schemas/memory-candidate.schema.json
schemas/memory-evidence.schema.json
schemas/memory-merge-hint.schema.json
schemas/audit-event.schema.json
spec/runtime-write-candidate.md
reference/gateway/semantics.py
compliance/dedupe/test_dedupe_upsert.py
compliance/lifecycle/
```

Preserve candidate kinds, evidence, merge hints, lifecycle distinctions, lineage and audit semantics.

Do not introduce MGP's Python gateway or policy engine as a second Glassbox control plane.

### LangMem

Pinned:

```text
langchain-ai/langmem
9d033b47d9ce53e37e92c92241b0496c0278932e
```

Port behavior from:

```text
src/langmem/knowledge/extraction.py
create_memory_manager
create_memory_store_manager
docs/docs/guides/extract_semantic_memories.md
docs/docs/guides/extract_episodic_memories.md
docs/docs/background_quickstart.md
docs/docs/guides/delayed_processing.md
```

Preserve:

```text
messages + existing Memory
→ extraction / enrichment
→ create / update / removal decision
→ persistence
```

Do not add LangGraph as a second Runtime.

### OpenHarness Memory

Pinned:

```text
HKUDS/OpenHarness
9b2efd795c6aa09f88b0c257d269a9e518da6ae7
```

Port behavior from:

```text
src/openharness/memory/schema.py
src/openharness/memory/manager.py
src/openharness/memory/scan.py
src/openharness/memory/usage.py
tests/test_memory/
```

Preserve normalized signature, dedupe, stable ID, TTL, disabled state, supersedes, timestamps, freshness and atomic mutation behavior.

Use Turso rather than copying OpenHarness file storage.

### Learning-Multi-Factor-Memory

Pinned:

```text
zhibao-dev/Learning-Multi-Factor-Memory
2d51bdf279cd837eed7d582bad2bde58caa74c61
```

Mechanism reference:

```text
borge/memory/value.py
borge/memory/forgetting.py
borge/memory/retrieval.py
borge/memory/consolidation.py
tests/test_memory_value.py
tests/test_forgetting_value.py
tests/test_retrieval_value.py
tests/test_consolidation_factors.py
```

Use interpretable factors such as reliability, goal relevance, task utility, usage and recency for retention decisions.

The repository currently has only MIT metadata in pyproject rather than a verified LICENSE file. Until license terms are confirmed, reuse mechanism / formulas / test ideas, not large verbatim source slices.

Automatic destructive forgetting stays off in P4A. Raw Trace and source evidence are not deleted by Memory retention.

### Command Code

Use:

```text
upstream/command-code/SOURCES.md
```

Adopt Taste signals:

```text
accept
reject
edit
revert
explicit correction
global / user preference
project preference
```

It is a research reference, not a code-vendoring source.

## Glassbox ownership

Glassbox continues to own:

```text
Agent
Principal
Project
Resource
Grant
AuthorizationDecision
Conversation
Run
Task / TaskAttempt
Audience / Delivery
Turso durable state
Raw Trace
```

Relevant current code:

```text
apps/server/src/persistence/schema.ts
apps/server/src/persistence/database.ts
apps/server/src/conversation/store.ts
apps/server/src/auth/service.ts
apps/server/src/runtime/pi/protected-tools.ts
apps/server/src/runtime/pi/owner-tools.ts
```

Reuse the existing Owner Tool pattern:

```text
discover authorization
→ protected Tool
→ execution-time authorization
→ durable mutation
→ evidence
```

## Stable concept boundary

```text
Rules
  explicit authority

Skills
  reusable validated procedures

Taste
  learned preference

Memory
  governed durable facts, decisions and events
```

```text
Rules ≠ Skills ≠ Taste ≠ Memory
```

Taste never grants authority.

Raw Conversation history is not automatically Memory.

Stable procedural knowledge should normally become a Skill candidate.

## Canonical Memory contract

Do not design a second candidate / Memory schema.

Base the TypeScript domain contract on MGP:

```text
MemoryObject
MemoryCandidate
MemoryEvidence
MemoryMergeHint
Lifecycle actions
Audit / lineage
```

P4A initially needs canonical types corresponding to:

```text
preference
semantic_fact
episodic_event
relationship
```

MGP scope does not exactly equal Glassbox Taste `global / project`.

Keep Glassbox product scope through an explicit mapping / extension rather than changing product semantics.

## Write authority

```text
explicit Owner Action
  → may create / update governed durable truth after authorization

deterministic product event
  → may append evidence

model / extractor inference
  → Candidate only
  → cannot directly create active canonical Memory / Taste
```

No unrestricted model-controlled `write_memory(anything)`.

## Taste

Taste uses Command Code signals but MGP-style Candidate / Evidence / merge behavior.

```text
single edit
→ evidence / candidate
≠ active Taste

repeated support
→ reinforce evidence

contradiction
→ correction evidence
→ lower confidence or replace / retire when justified
```

Do not invent a complex confidence model.

Use the smallest explainable evidence policy needed. If an exact algorithm beyond upstream behavior is required, document the gap before implementing it.

Initial scope remains:

```text
global
project
```

## Semantic and Episodic Memory

Classification and consolidation follow LangMem behavior.

```text
Conversation / Run / Task evidence
→ relevant existing Memory
→ extraction / enrichment
→ MGP Candidate
→ dedupe / merge / reinforce / correction
→ canonical Semantic or Episodic Memory
```

Do not promote every message.

Prefer source references over copying large protected payloads.

## Lifecycle and hygiene

Use MGP lifecycle semantics plus OpenHarness hygiene.

P4A must support:

```text
normalized signature
dedupe
reinforce
correction
supersedes
optional TTL
expire
revoke
disabled / inactive projection
freshness
source provenance
```

Do not create an unrelated custom state machine for delete / expire / revoke / retire.

## Retention

Do not use an arbitrary fixed expiry policy.

Use the Multi-Factor Memory value approach for non-destructive retention decisions.

Initial factors may include:

```text
reliability
goal relevance
task utility
usage
recency
```

Automated physical deletion is out of scope.

## Implementation route

### P4A.0 — Port MGP contracts

Port the required MGP schemas and semantics into TypeScript domain types and Turso persistence.

Add MGP compliance-inspired fixtures.

### P4A.1 — Candidate and evidence ingestion

Normalize Owner statements, FeedbackEvent, Run / Task evidence and extractor output into MGP-style Candidate + Evidence.

### P4A.2 — Port LangMem consolidation

Implement behavior-compatible semantic / episodic extraction using existing Memory in the update decision.

### P4A.3 — Port OpenHarness hygiene

Implement signature, dedupe, TTL, disabled state, supersedes, freshness and usage metadata on Turso.

### P4A.4 — Taste loop

Map Command Code-style feedback signals into MGP-style candidate / evidence handling while preserving global / project isolation.

### P4A.5 — Retention value

Add the interpretable Multi-Factor Memory retention factors without destructive auto-prune.

### P4A.6 — Owner governance

Expose narrow Owner-private lifecycle Actions based on MGP semantics:

```text
list
get
write explicit
update
expire
revoke
review candidate
promote
reject candidate
```

Every mutation re-authorizes at execution time.

### P4A.7 — Real acceptance

Prove:

```text
explicit project fact
→ Candidate / Memory
→ restart
→ inspect
→ update / revoke
→ next inspection reflects change

single edit
→ candidate evidence
→ not active Taste
```

## P4B boundary

P4A exports canonical active Memory plus Glassbox resource / scope mapping.

P4A does not define retrieval ranking or a custom SearchResult.

P4B uses the MGP Recall / SearchResult contract.

## Tests

Bring behavior-compatible upstream cases with the port.

Primary sources:

```text
MGP
  compliance/dedupe/
  compliance/lifecycle/
  compliance/schema/

OpenHarness
  tests/test_memory/

Learning-Multi-Factor-Memory
  tests/test_memory_value.py
  tests/test_forgetting_value.py
  tests/test_consolidation_factors.py

LangMem
  semantic / episodic extraction examples
  store-manager create / update / removal behavior
```

Glassbox-specific coverage:

```text
Visitor cannot inspect Owner-private Memory
group Run cannot discover Owner governance Tool
revocation affects the next protected operation
project Taste cannot become global
model inference cannot directly create active Memory
restart preserves lifecycle / provenance
```

## Completion gate

P4A is complete only when:

```text
MGP-derived contract is canonical
LangMem-style consolidation works
OpenHarness-style hygiene works
Taste remains evidence-driven
Semantic / Episodic Memory remain distinct
lifecycle survives restart
Owner can inspect and govern Memory
Glassbox Authorization wraps protected mutation
P4B consumes the canonical contract without P4A internals
```

## PR provenance requirement

Every substantially ported mechanism records:

```text
upstream repository
pinned commit
original source path
license
ported behavior / tests
Glassbox-specific changes
```

## Non-goals

```text
QQ history search
Owner cross-group search
retrieval ranking
external vector database
generic Context compression
P5 routing / token governor
new Channels
LongTask
Skill generation
full Eval platform
frontend management UI
```
