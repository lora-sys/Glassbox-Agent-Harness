# Plan 05A — Context Budgeting and Runtime Efficiency

Status: READY NEXT PARALLEL P5 STREAM — IMPLEMENT AFTER P4 COMPLETION

Tracking Issue: #13

Sibling stream: [Plan 05B — Routing and Runtime Observability](./05b-routing-runtime-observability.md)

P5A has one owner, one implementation branch and one later implementation PR. It is intentionally parallel with P5B, but implementation starts from the same post-P4 main baseline after P4A/P4B are merged and their completion gates are satisfied.

## Goal

P5A makes the already-proven Personal Agent path cheaper, more bounded and more predictable **without changing what the current Principal is allowed to read, execute or receive**.

Target path:

~~~text
authorized current request
+ authorized Conversation / Rules / Skills / Taste / Memory / retrieval
+ authorized Tool results
        ↓
ContextDemandEstimate
        ↓
P5B RoutingDecision + selected ModelCapacity
        ↓
ContextBudgetGovernor
        ↓
bounded model-visible Context / Tool projection
        ↓
Pi
        ↓
full evidence remains in Glassbox
~~~

Acceptance sentence:

> Every Run has an inspectable demand estimate and route-specific Context budget; large Tool/retrieval results are bounded before the next model request; repeated retrievals cannot silently consume the turn budget; compression only changes the model-facing projection, never historical evidence; and any reusable protected projection is scoped strongly enough that another Principal, location, authorization revision or post-revocation Run cannot inherit it.

## Entry gate from P4

P5A is not allowed to develop against the pre-P4 architecture and later reinterpret P4 behavior.

Before production implementation starts:

- P4A Memory/Taste truth is merged;
- P4B authorization-first retrieval is merged;
- current P3/P4 regression gates pass from main;
- the implementation branches are cut from the same post-P4 commit;
- the P4B retrieval/Context contract is treated as input, not reimplemented.

P5A may be prototyped earlier only with deterministic fixtures matching the sibling/preceding contracts.

## Upstream-first rule

P5A must port the smallest mature mechanisms that fit the Glassbox trust model. It must not copy another project's full runtime or use token optimization as a reason to weaken authorization/evidence.

Every substantial port records repository, reviewed commit, license, original path, behavior adopted, upstream tests consulted and Glassbox-specific changes.

The upstream audit for this Plan is recorded in:

~~~text
.plans/findings/05-p5-upstream-review-2026-09-21.md
~~~

## Primary upstream source map

### TokenRhythm/opensquilla

Reviewed P5 commit:

~~~text
9e38139641daea70db967091aecce9524b93efe0
Apache-2.0
~~~

Primary source slices:

| Upstream path | P5A use |
| --- | --- |
| src/opensquilla/context_budget.py | ContextBudgetGovernor and coherent reserve derivation |
| src/opensquilla/result_budget.py | per-call/per-turn Tool budgets, result classes, duplicate retrieval admission |
| src/opensquilla/token_estimation.py | bounded token estimation and explicit estimate source |
| src/opensquilla/engine/turn_runner/prompt_assembler_stage.py | where budget/projection belongs relative to prompt assembly |
| src/opensquilla/plugins/tokenjuice/reducer.py | model-facing Tool reduction patterns |
| src/opensquilla/plugins/tokenjuice/matcher.py | deterministic rule matching |
| src/opensquilla/plugins/tokenjuice/rules.py | bounded rule registry pattern |

Focused upstream tests reviewed / to preserve semantically:

~~~text
tests/test_context_budget_governor.py
tests/test_engine/test_context_budget_coordinator.py
tests/test_engine/test_tokenjuice_tool_result_projection.py
tests/test_tools/test_loop_guard.py
tests/test_session/test_tokenizer.py
~~~

TokenJuice carries separate MIT provenance in its LICENSE.tokenjuice and PROVENANCE.md. If Glassbox copies rule/reducer code, preserve that attribution in addition to OpenSquilla's Apache-2.0 provenance.

### Pi and Lora PI Kit

Pi remains the Agent engine. P5A should prefer public SDK / Tool / Extension / session surfaces and model capability metadata.

Generic Pi workflow behavior that does not change Glassbox authorization, protected Context selection or evidence may live in Lora PI Kit. The Glassbox product still owns which protected material is eligible for projection.

Do not patch Pi core for a budget feature until the public SDK / Tool / Extension / Kit route is proven insufficient.

### P4B retrieval

P5A consumes the P4B authorized source/result contract.

Required ordering:

~~~text
Principal resolved
→ source authorization
→ protected source loaded
→ retrieval / ranking
→ P5A budgeting / projection
→ model
~~~

Forbidden:

~~~text
load broad protected source set
→ budget / cache / dedupe it
→ authorize later
~~~

Budgeting, duplicate detection and caching are not security filters.

## Glassbox ownership

P5A owns:

~~~text
TokenEstimate
ContextDemandEstimate
ContextBudgetSnapshot
ContextProjectionDecision
ToolResultBudgetPolicy
ToolResultProjection
per-turn Tool/retrieval admission accounting
model-facing compression policy
authorization-scoped cache proof / projection reuse
efficiency evidence
~~~

P5A does not own:

~~~text
model/provider choice
route quality judgment
thinking-depth selection
RuntimeUsage normalization
quota / RuntimeHealth
Agent Ops throughput
routing Eval
Memory/Taste promotion
retrieval ranking
authorization grants
Delivery policy
~~~

## Stable invariants

### Authorization before optimization

All protected source authorization remains P3/P4 behavior.

~~~text
authorization
→ retrieval / Tool execution
→ projection
~~~

never:

~~~text
projection
→ authorization
~~~

### Raw evidence is not model-facing Context

P5A may reduce what reaches Pi. It may not rewrite historical evidence so an old Run appears to have produced a smaller Tool result or different retrieved sources.

~~~text
full authorized evidence
≠
bounded model projection
~~~

### Estimates are not actual usage

A TokenEstimate always records an estimate source. Provider/runtime actual usage remains separate.

Do not turn a conservative estimate into an observed token count.

### Overflow is explicit

When required material cannot fit the selected route:

~~~text
typed capacity / overflow result
→ P5B may choose another route
or
→ Run fails / requests a policy decision honestly
~~~

Do not silently drop required instructions or security-relevant context.

## Shared P5 contract

P5A and P5B use an intentionally narrow handshake:

~~~text
P5A
  ContextDemandEstimate
        ↓
P5B
  RoutingDecision
  ModelCapacity
        ↓
P5A
  ContextBudgetSnapshot
  ContextProjectionDecision
        ↓
Pi execution
        ↓
P5B observations
~~~

The demand projection should contain bounded derived information needed by routing, for example:

~~~text
estimatedMaterialTokens
estimateSource
hasLargeAuthorizedContext
requiredOutputClass
tool/retrieval presence
attachment/artifact presence
explicit trusted policy flags
~~~

It should not copy raw protected Memory/history/Tool bodies merely so the router can inspect them.

While the sibling branch is not merged:

- P5A uses deterministic RoutingDecision / ModelCapacity fixtures;
- P5B uses deterministic ContextDemandEstimate fixtures;
- neither branch imports sibling-private modules.

## Parallel worktree boundary

Preferred P5A production ownership:

~~~text
packages/contracts/src/runtime-efficiency.ts
apps/server/src/runtime/efficiency/**
focused P5A tests
~~~

Narrow integration changes may later touch:

~~~text
apps/server/src/runtime/pi/adapter.ts
apps/server/src/runtime/pi/types.ts
packages/contracts/src/index.ts
apps/server/src/persistence/schema.ts
~~~

These are shared integration hotspots. Do not make broad parallel edits there. Core behavior must live behind leaf modules first, then the final integration commit is rebased against the sibling stream.

P5A should not take ownership of:

~~~text
apps/server/src/runtime/routing/**
apps/server/src/runtime/observability/**
routing Eval files
Agent Ops health projection
~~~

## Token estimation

Target contract:

~~~text
TokenEstimate
  tokens
  source
  conservative
  materialKind
  measuredChars / bytes when useful
  policyVersion
~~~

Possible source vocabulary:

~~~text
provider_actual       # not an estimate object when actual usage exists
tokenizer
provider_compatible_estimator
unicode_conservative
chars_conservative
unknown
~~~

Requirements:

- CJK / Unicode-heavy text must not severely under-estimate compared with ASCII assumptions;
- very large material must be bounded in CPU/memory work;
- tokenizer initialization failure cannot make the whole Personal Agent unavailable;
- estimates used for a decision are persisted as decision metadata, not rewritten by later estimator versions;
- actual provider usage may be compared with estimates later but never retroactively replaces the decision evidence.

## Context Budget Governor

P5A ports the relationship, not hard-coded OpenSquilla constants.

Inputs include:

~~~text
selected ModelCapacity
max output
declared thinking reserve when the runtime exposes one
policy threshold
authorized material demand
explicit product reserve
~~~

Output should separate at least:

~~~text
contextWindowTokens
reservedOutputTokens
reservedThinkingTokens
reservedSystemTokens
usableInputTokens
providerRequestLimit
Tool argument/result budgets
overflow state
policyVersion
~~~

Current main contains a configured Pi model path with a fixed contextWindow/maxTokens placeholder. P5 implementation must not treat those constants as universal model truth. P5B's selected ModelCapacity (or a verified configured model capability) is the budget input.

## Tool Result Budget / Projection

Budget at the Tool boundary after authorization and successful Tool execution.

Initial result classes:

~~~text
external
local
artifact
error
control
unknown
~~~

Each class may have:

- single-result ceiling;
- per-turn aggregate ceiling;
- minimum error/control preservation;
- projection strategy;
- full-evidence reference;
- safe digest/summary metadata.

A Tool result may be large and still important. The model-facing result should carry enough structure to know that truncation/projection occurred and how to request a narrower follow-up when policy allows.

Do not let a Skill bypass Tool budgets by changing prose.

## Per-turn Tool / retrieval admission

P5A may adapt OpenSquilla's ToolRunBudgetTracker ideas.

Track at least:

~~~text
calls by class
projected/raw chars or token estimate
external retrieval consumption
semantic retrieval key
in-flight duplicate
terminal replay status
retry permission
~~~

Important distinction:

~~~text
P4B retrieval ranking / candidate dedupe
≠
P5A repeated Tool-call admission
~~~

Examples:

- two identical searches already in flight: suppress duplicate;
- same failed search with no retry permission: suppress replay;
- retryable provider/network failure after state change: allow a bounded retry;
- two different authorized groups with the same query: do not collapse them into one source unless the security/source key proves equivalence.

## Context compression

Start with deterministic, reversible projection modes:

~~~text
full
compact
reference
omit_duplicate
~~~

P5A should prefer structural projection over generated summarization for the first production path.

Protected/instruction classes that need explicit preservation rules include:

- current user instruction;
- hard Rules;
- required Tool execution evidence;
- authorization/approval-facing control state;
- Task/review state needed for the current action;
- recent conversation turns needed for coherence.

If later LLM compaction is introduced, the generated summary is derived state with its own provenance. It cannot replace original evidence.

## Authorization-scoped cache

The P5 upstream audit did not find a mature generic semantic-response cache in current OpenSquilla that can safely be transplanted as a complete solution.

Therefore the first cache slice is a **proof of isolation and invalidation**, not a mandate to cache model answers.

A protected cache key/validity proof should include, where relevant:

~~~text
Agent
Principal
location / Conversation scope
authorized Resource set or authorization fingerprint
grant / policy revision
source version / provenance
retrieval policy version
model / provider / profile
prompt / Kit / behavior-affecting Skill identity
projection policy version
~~~

Rules:

- Owner-private entries cannot be reused by Visitor/group Runs;
- project/private scope cannot become global reuse;
- revocation affects the next protected operation;
- a cache hit never creates an AuthorizationDecision that did not occur;
- stale source/projection versions miss safely;
- denial paths do not reveal cached protected payload;
- cache metadata is not Raw Trace truth.

Initial production use should favor deterministic projection/retrieval reuse. Generic semantic model-answer caching remains out of scope until a separate evidence-based proof exists.

## Efficiency evidence

P5A should emit safe decision/effect records such as:

~~~text
Run
policy version
estimate + source
budget snapshot digest / numeric limits
material classes
before / after size
projection mode + reason
duplicate admission outcome
cache hit/miss + safe scope fingerprint digest
overflow / route-capacity request
~~~

Do not emit the private payload itself merely to explain a projection.

Useful derived measurements:

~~~text
estimated input before / after
Tool projection reduction
duplicate calls prevented
overflow frequency
cache hit rate
unsafe cache hit count     # must remain zero
revocation leakage count   # must remain zero
~~~

Savings are measurements, not acceptance truth. A lower token count is not success if correctness/security regresses.

## Implementation route

### P5A.0 — Post-P4 contract audit

Rebase onto completed P4 main. Confirm P4A/P4B contracts, current Pi SDK behavior, configured model metadata and P3/P4 regression baselines.

Freeze the shared handshake before changing runtime behavior.

### P5A.1 — Efficiency contracts and fixtures

Add runtime-efficiency contracts plus deterministic fixtures for:

- small / medium / large ModelCapacity;
- low / high Context demand;
- external/local/artifact/control/error result classes;
- authorized and revoked source sets;
- duplicate/retry scenarios.

### P5A.2 — Token estimator

Port the bounded estimator/fallback semantics and focused tests.

### P5A.3 — Context Budget Governor

Implement pure budget derivation first. No Pi integration until its property/edge tests pass.

### P5A.4 — Tool result budget and projection

Introduce classification, single-call ceilings, per-turn ceilings, projection metadata and evidence reference behavior.

### P5A.5 — Tool/retrieval admission

Add duplicate/replay/retry accounting around the existing authorized Tool/retrieval surface.

### P5A.6 — Context assembly / compression

Assemble already-authorized sources under the selected route budget. Preserve required classes and emit explicit overflow.

### P5A.7 — Cache isolation proof

Implement the smallest deterministic reusable-projection cache needed to prove keys, versioning and revocation behavior. Leave generic semantic model-answer caching disabled.

### P5A.8 — Pi integration

Wire the governor/projection through one narrow runtime seam. Keep full evidence and P3/P4 security gates unchanged.

### P5A.9 — Stress / adversarial / restart acceptance

Run focused and repository-wide gates, including P4 history/memory source isolation and restart behavior.

## Test matrix

At minimum cover:

~~~text
small / medium / large context windows
output + thinking reserve
CJK / mixed-language / long Unicode text
estimator failure fallback
huge external Tool result
huge local result
artifact projection
error/control floors
single-call exhaustion
per-turn exhaustion
duplicate in-flight
terminal replay
legitimate retry
two Resources with same query
P4B unauthorized source exclusion
Owner-private vs group cache isolation
project vs global cache isolation
grant revocation
policy/source version change
restart
Pi session restore
Raw Trace reconstruction
typed overflow → P5B fixture route upgrade
~~~

## Completion gate

P5A is complete when:

~~~text
authorization still precedes optimization
Context demand and budgets are explicit
Tool/retrieval flooding is bounded
estimates never masquerade as actuals
overflow is explicit, not silent truncation of required semantics
compression is inspectable through preserved evidence
cache reuse is authority-scoped and revocation-safe
P5B can consume ContextDemandEstimate without P5A internals
Pi receives bounded projections without becoming product truth
all P3/P4 security / retrieval / Delivery regressions remain green
~~~

## PR provenance requirement

The one P5A implementation PR must list for every substantially ported mechanism:

~~~text
upstream repo
reviewed/pinned commit
original path
license
upstream test/reference behavior
ported behavior
Glassbox-specific changes
~~~

## Non-goals

P5A does not add:

- route/model scoring;
- thinking-depth policy;
- Runtime quota dashboard;
- broad local runtime scanners;
- Agent Ops throughput;
- a second retrieval engine;
- vector search as authorization;
- generic semantic answer caching without the isolation proof;
- P6 durable DAG/checkpoint/scheduler;
- P8 self-learning/promotion;
- new Channels/providers;
- Pi core fork;
- Trace deletion/rewrite for token savings.
