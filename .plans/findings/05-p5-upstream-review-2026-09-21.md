# P5 Upstream Review — Runtime Efficiency and Observability

Date: 2026-09-21

Status: planning evidence for Plan 05A / Plan 05B. No production source is vendored by this finding.

## Repository state reviewed

Glassbox main baseline used for this planning review:

~~~text
a8054a5938167d788ff49d50eaa9f497dc643db1
~~~

P4 is close but not yet fully merged into main at planning time:

~~~text
PR #11  P4B Authorized Retrieval & QQ History Search
         open / mergeable
         real QQ acceptance recorded

PR #12  P4A Memory & Taste Durable Learning Truth
         open / mergeable
         deterministic implementation/verification recorded
~~~

Therefore P5 docs may be prepared now, but P5 production branches must be cut from the post-P4 main baseline.

## Current Glassbox seams

The current code already contains several P5 inputs:

- apps/server/src/runtime/pi/types.ts has normalized Pi event usage fields;
- apps/server/src/runtime/pi/adapter.ts records provider/model and input/output/cache usage from Pi events;
- apps/server/src/runtime/pi/configured-model.ts currently supplies a fixed 32768 context window, 4096 max tokens and zero cost placeholders;
- apps/server/src/eval is already a Glassbox-owned evidence-based Eval boundary;
- apps/server/src/ops/reconciler.ts already owns Herdr snapshot/event reconciliation into durable Task/Worker state;
- Raw Trace remains append-only evidence;
- P4B adds authorization-first retrieval and Context projection contracts;
- P4A adds durable governed Memory/Taste truth.

P5 should extend these seams instead of creating parallel runtime, Eval, Trace or authorization systems.

## Reviewed upstream pins

| Project | Reviewed commit | License | P5 use |
| --- | --- | --- | --- |
| TokenRhythm/opensquilla | 9e38139641daea70db967091aecce9524b93efe0 | Apache-2.0 | budget governor, Tool budgets, token estimation, routing policy, decision evidence |
| Javis603/token-monitor | 8031cf3b75c7f354db8a990a983999c69086da28 (v0.60.0) | MIT | usage normalization, limits/quota, health, throughput capability |
| herdrdev/herdr | 7e91c4cd933201e1f578f89e87cd8b20bc87c658 | Apache-2.0 | connection/event/snapshot health semantics |
| open-telemetry/semantic-conventions | d0472f4ae331e8ef01aa571fe024d0d6a1a9b5e1 | Apache-2.0 | trace/metric/resource naming and privacy concepts |
| open-telemetry/opentelemetry-specification | 148f27606cf0352c11a314e7bf9eefa6bf88db86 | Apache-2.0 | telemetry lifecycle/interoperability concepts |
| earendil-works/pi | repository manifest/current public SDK reviewed through existing Glassbox pin | MIT | primary runtime SDK boundary |

These are P5 review pins. A later implementation PR must pin the exact source actually ported and must not silently change provenance to a newer upstream commit.

## OpenSquilla findings

### Strong direct references for P5A

~~~text
src/opensquilla/context_budget.py
  ContextBudgetGovernor
  ContextBudgetSnapshot
  reserves output + thinking + context headroom
  derives provider/Tool argument/result bounds

src/opensquilla/result_budget.py
  ToolResultBudgetPolicy
  ToolRunBudgetPolicy
  ToolRunBudgetTracker
  ToolResultBudgetTracker
  DuplicateRetrievalInFlightError
  TerminalRetrievalReplayError
  result classes

src/opensquilla/token_estimation.py
  bounded tokenization
  conservative Unicode fallback
  explicit estimate source

src/opensquilla/plugins/tokenjuice/*
  deterministic result reduction / rules
  separate MIT provenance
~~~

Useful tests:

~~~text
tests/test_context_budget_governor.py
tests/test_engine/test_context_budget_coordinator.py
tests/test_engine/test_tokenjuice_tool_result_projection.py
tests/test_tools/test_loop_guard.py
tests/test_session/test_tokenizer.py
~~~

Adoption decision: port behavior into Glassbox-owned TypeScript contracts/modules. Do not import OpenSquilla runtime wholesale.

### Strong direct references for P5B

~~~text
src/opensquilla/squilla_router/controller.py
  derive thinking mode
  prompt policy
  normalize contradictory combinations

src/opensquilla/engine/routing/policy.py
  RoutingDecision
  capability gate
  large-context floor
  budget gate
  fallback / routing trail

src/opensquilla/router_tiers.py
  route/tier canonicalization

src/opensquilla/observability/decision_log.py
  structured per-turn decision evidence
  actual billed cost separate from estimated savings
  projection token before/after counters
  privacy-safe reason codes
~~~

Useful tests:

~~~text
tests/test_engine/test_routing_policy_stages.py
tests/test_engine/test_routing_policy_parity.py
tests/test_observability/test_decision_log_contract.py
tests/test_observability/test_decision_log_cost_source.py
tests/test_observability/test_log_privacy.py
~~~

Adoption decision: start with deterministic route/policy gates and the current configured route as baseline. Defer the full local ML router / ONNX / LightGBM artifacts and ensemble machinery until Glassbox routing Eval proves a need.

### Semantic cache result

The review did **not** identify a mature generic semantic model-response cache in the current OpenSquilla source that satisfies Glassbox's protected-resource/revocation requirements as a direct port.

Current relevant caching is mainly provider prompt-cache behavior, runtime/session caches, retrieval/memory mechanisms and duplicate Tool/retrieval control.

Decision:

~~~text
P5A first proves authorization-scoped deterministic projection/retrieval reuse.
Generic semantic answer caching is disabled/deferred unless a separate proof
covers Principal + scope + Resource authority + policy/source version + revocation.
~~~

This intentionally narrows the older roadmap phrase “permission-scoped semantic cache”.

## Token Monitor findings

Reviewed stable release v0.60.0.

Strong reusable patterns:

~~~text
src/shared/usage.js
  normalizes input/output/cacheRead/cacheWrite/reasoning
  aggregates usage without assuming every source has every field

src/shared/clientHealth.js
  source-specific health instead of one generic parser

src/shared/limits/collector.js
src/shared/limits/core.js
  provider/runtime-specific limit collection
  normalized quota/window surface

tests/shared/usageThroughput.test.js
  distinguishes throughput available from unavailable
  preserves exact zero vs missing capability
~~~

Decision:

- Pi runtime events are the first production usage source because Glassbox already owns them;
- only add local filesystem/client collectors when an actual product surface needs them;
- cost/quota/throughput missing values remain null/unknown;
- management UI consumes Glassbox contracts, never upstream objects.

## Herdr findings

Public protocol remains the correct integration boundary.

Reviewed behavior:

~~~text
events.subscribe has no durable replay
session.snapshot is a one-time authoritative snapshot
events_lost means cached live state is stale
recovery requires new subscription + snapshot + reconciliation
snapshots/events have no shared sequence boundary
~~~

src/client/endpoint/health.rs also demonstrates a useful ready/heartbeat/timeout health shape, but Glassbox should port semantics rather than internal Rust code.

Decision:

- Agent Ops health is derived from Herdr observation + Glassbox durable state;
- event loss/reconnect marks live projections stale;
- worker done never becomes Task DONE;
- throughput counts Glassbox Task/Attempt outcomes, not only Herdr lifecycle transitions.

## OpenTelemetry findings

OpenTelemetry is useful only after Glassbox has its own canonical evidence.

Reviewed current conventions show:

- spans represent operations;
- metrics should use stable naming and units;
- duration metrics use seconds in OTel conventions;
- common attributes should be consistent and bounded for useful aggregation;
- GenAI input/output/system/tool content can contain sensitive information;
- GenAI semantic-convention fields continue to evolve.

Decision:

~~~text
Glassbox Raw Trace / Turso = canonical evidence and product state
OTel = optional sanitized projection/export
~~~

Do not make OTel schema evolution rewrite Glassbox contracts. Do not record protected prompt/response/Memory/Tool bodies by default.

## Split rationale

P5A owns **what reaches the model and how much**.

P5B owns **which configured execution route is selected and what happened operationally**.

Shared handshake:

~~~text
P5A ContextDemandEstimate
        ↓
P5B RoutingDecision + ModelCapacity
        ↓
P5A ContextBudget / projection
        ↓
Pi
        ↓
P5B actual usage / health / Eval
~~~

This split is deliberate because two developers work concurrently. It avoids both branches editing the same budget/router engine.

## Shared integration hotspots

Both streams may eventually need narrow changes in:

~~~text
packages/contracts/src/index.ts
apps/server/src/runtime/pi/adapter.ts
apps/server/src/management/application.ts
apps/server/src/persistence/schema.ts
~~~

Rule:

1. core behavior lives in stream-owned leaf modules;
2. develop against fixtures;
3. rebase on sibling changes;
4. serialize the final hotspot integration commits;
5. rerun P3/P4 security/retrieval/Delivery regressions.

## Rejected shortcuts

Do not:

- use a model router to choose authorization scope;
- treat context truncation as data-access control;
- count fixed zero pricing as free execution;
- treat missing quota/health as zero/unlimited;
- enable broad semantic answer caching before revocation tests;
- import the entire Token Monitor client catalog;
- start P5 with OpenSquilla's full ML/ensemble stack;
- make external telemetry the only routing evidence;
- count Herdr done as Task completion;
- overwrite Raw Trace with compressed Context.

## Implementation baseline requirement

When P5A/P5B implementation starts, refresh:

- post-P4 main SHA;
- actual Pi/Lora PI Kit version/commit;
- exact model capability sources;
- exact upstream paths copied/ported;
- repository test counts.

If upstream moved after this review, implementation may update the pin only with an explicit source/provenance note and focused parity tests.
