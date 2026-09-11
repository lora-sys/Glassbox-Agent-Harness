# Glassbox Product Roadmap

Status: ROADMAP ONLY

This file records sequencing and product direction. It is not an active implementation plan.

The only active implementation plan remains `/.plans/03-personal-agent-foundation.md` until its completion gate passes.

## Product thesis

Glassbox is a durable Personal Agent with explicit identity, authorization, persistent state, inspectable execution, learning, and evidence.

The long-term product should remain understandable from two perspectives at the same time:

```text
Use the Agent
Understand the Agent
```

The first is the runtime product. The second is the documentation and learning experience.

## Sequence

### P3 — Trusted Personal Agent Foundation

Current active plan.

```text
Identity
→ Authorization
→ Conversation
→ Turso persistence
→ Run / Authorization Trace
```

Goal: prove Owner and Visitor can use the same Agent without crossing permission boundaries.

### P4 — First real remote Channel

Choose one real external entry point only after P3 passes.

Likely candidates include Web public access, WeChat, or QQ.

The Channel must reuse the same Agent identity, Principal resolution, authorization, Conversation, persistence, and Trace boundaries proven in P3.

Do not create a separate Agent implementation per Channel.

### P5 — Memory and Authorized Retrieval

Introduce durable Memory only after authorization and Conversation isolation are real.

Target mechanisms:

```text
Memory Candidate
→ permission / visibility inheritance
→ value and reliability scoring
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

OpenSquilla is a primary reference for hybrid retrieval mechanics. `zhibao-dev/Learning-Multi-Factor-Memory` and `langchain-ai/langmem` remain primary references for memory value and consolidation.

### P6 — Efficient Agent Runtime

Use `TokenRhythm/opensquilla` as the main efficiency-layer reference.

Target capabilities:

```text
Context Budget Governor
Tool Result Budget
Tool Result Projection
Token Estimation
Execution Routing
Thinking-depth selection
Prompt / context compression policy
Duplicate retrieval prevention
Semantic cache with permission-scoped keys
Routing observability
Routing Eval
```

A future routing decision should produce an explicit execution policy rather than only a model name:

```text
ExecutionPolicy
  modelTier
  provider
  model
  thinkingLevel
  promptPolicy
  contextBudget
  retrievalBudget
  toolBudget
  workerPolicy
  ensemblePolicy
  costCeiling
```

Authorization always happens before routing-sensitive context assembly.

The router may reduce cost or increase capability. It may never widen authority.

Raw Trace remains full evidence even when model-facing context is compressed.

Success must be measured with Eval rather than claimed from intuition. Compare at minimum quality, invariant violations, input/output tokens, cost, and latency with routing enabled and disabled.

### P7 — Durable Long Work and Workers

Introduce durable LongTask semantics and specialist Worker delegation.

Primary references:

```text
temporalio/sdk-typescript
keli-wen/agy-staff
```

Worker authority can only shrink from caller authority.

### P8 — Eval, Learning, Assets, and Skill Evolution

Turn real execution evidence into a controlled learning loop:

```text
Run / Trace
→ Experience Mining
→ Memory / Skill / Asset Candidate
→ Eval / Verification
→ Promotion
```

Primary references include Inspect AI, SkillClaw, CoEvoSkills, Voyager, Dagster, Generative Agents, and memos.

## Documentation and Learning track

The documentation site is a product track, not an afterthought.

Its goal is to help a new user understand the key ideas behind Glassbox without reading the codebase first.

The site should teach concepts with three layers:

```text
Explain
→ Visualize
→ Let the reader manipulate the mechanism
```

Documentation work can begin before later runtime phases, but a page must never present a planned mechanism as implemented.

Every substantial feature page should visibly indicate one of:

```text
Implemented
Experimental
Planned
```

### D0 — Documentation foundation

Can start immediately without changing runtime scope.

Create the information architecture, terminology, diagrams, deterministic fixtures, and demo specifications.

### D1 — P3 interactive lessons

After P3 contracts stabilize, publish interactive demos for:

```text
Identity vs Authorization
Owner vs Visitor
Default deny
Approval vs Permission
Authorize before Context
Conversation vs Session vs Run
Authorization Trace
Raw Trace vs Derived State
```

These demos should use synthetic data and the same conceptual contracts as production code.

### D2 — Memory and retrieval lab

After P5 exists, let readers manipulate:

```text
visibility scope
keyword vs vector weight
time decay
source weighting
MMR diversity
result count
context budget
```

The demo must make it obvious that permission filtering happens before protected content enters retrieval results shown to the model.

### D3 — Routing and token economy lab

After P6 exists, let readers compare:

```text
router off vs on
small vs large model tier
thinking depth
prompt policy
context budget
tool-result projection
retrieval budget
```

Show resulting quality, token usage, estimated cost, latency, and selected routing reason using fixed reproducible fixtures first.

### D4 — Trace-to-Canvas and LongTask labs

Later interactive lessons can show:

```text
Raw Events
→ Derived State
→ Canvas Projection
```

and:

```text
LongTask
→ checkpoint
→ waiting
→ signal
→ retry
→ resume
```

## Documentation is not authority

Interactive demos explain mechanisms. They do not grant permissions, modify production state, or act as an authorization source.

The documentation site must never require access to real user Memory, private Conversations, credentials, production Trace, or private Tools to demonstrate a concept.

If a future live-demo mode is added, it must go through the same server-side authorization boundary as the product.
