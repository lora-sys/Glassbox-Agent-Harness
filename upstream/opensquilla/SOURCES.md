# OpenSquilla source index

Reference project: `TokenRhythm/opensquilla`

Pinned upstream commit used by the earlier retrieval review: `75a7085960ee57bc7a17acde5ce08071af4e7632`

P5 reviewed upstream commit (2026-09-21): `9e38139641daea70db967091aecce9524b93efe0`

Upstream branch at review time: `main`

Primary license: Apache-2.0.

OpenSquilla is an approved reference for Glassbox's later efficiency layer. No production code in Glassbox imports this directory. Its routing, retrieval, semantic cache, and aggressive token-optimization mechanisms are not required for the Plan 03 QQ closed loop.

## Why it matters

OpenSquilla treats token economy and routing as harness responsibilities rather than prompt tricks. Its current README describes a local router that sends each turn to the cheapest model that can handle it, persistent memory, on-device embeddings, and one shared execution loop across UI, CLI, and channels.

The most useful ideas for Glassbox are:

- context-window budgeting
- Tool result budgeting and duplicate retrieval prevention
- hybrid vector + lexical retrieval
- task-difficulty routing and thinking-level selection
- prompt-policy / context compression decisions
- token estimation
- tool-result projection before model context
- routing observability and self-learning data collection

## Candidate source slices

| Upstream path | What to study / potentially port |
| --- | --- |
| `src/opensquilla/context_budget.py` | `ContextBudgetGovernor`; derive model-request, Tool argument, Tool result, output, and thinking reserves from one context window |
| `src/opensquilla/result_budget.py` | Tool boundary budgets; per-call and per-turn limits; web retrieval caps; duplicate / replayed retrieval prevention |
| `src/opensquilla/token_estimation.py` | Provider-aware token estimation and budgeting inputs |
| `src/opensquilla/squilla_router/controller.py` | Pure routing post-processing; task difficulty, thinking depth, prompt compression policy, safety flags |
| `src/opensquilla/router_tiers.py` | Canonical routing tiers, route-class mapping, model/provider roles, ensemble ownership |
| `src/opensquilla/squilla_router/` | Local router runtime and later self-learning / data-flywheel ideas |
| `src/opensquilla/memory/retrieval.py` | Hybrid vector + FTS5 retrieval; temporal decay; source weighting; MMR diversity reranking |
| `src/opensquilla/memory/embedding.py` | On-device / remote embedding boundary and retry behavior |
| `src/opensquilla/memory/embedding_resolver.py` | Embedding backend selection and capability resolution |
| `src/opensquilla/plugins/tokenjuice/` | Rule-driven Tool result projection / reduction before model context |
| `src/opensquilla/observability/` | Routing and execution observability patterns |
| `src/opensquilla/gateway/` | Shared gateway / entry-point execution behavior; study separately from Glassbox Channel identity model |

Do not vendor all of these at once. Copy a source slice only when a concrete Glassbox implementation task needs it.

## Tokenjuice provenance

OpenSquilla's built-in `tokenjuice` backend has its own provenance note. The approach is adapted from `vincentkoc/tokenjuice`; bundled reduction rules are derived from that upstream under the MIT license and OpenSquilla carries `LICENSE.tokenjuice` plus third-party notices.

If Glassbox copies code or rules from `src/opensquilla/plugins/tokenjuice/`, preserve the relevant MIT attribution in addition to OpenSquilla's Apache-2.0 provenance. Do not treat the whole subtree as Apache-only.

## Glassbox adoption rules

### Authorization happens before retrieval

Vector search is not an authorization mechanism.

Forbidden:

```text
search every Memory vector
→ retrieve private + public candidates
→ ask the model to ignore unauthorized results
```

Required:

```text
resolve Principal
→ resolve authorized resource / namespace set
→ retrieve only inside that authorized set
→ rank / rerank
→ assemble model context
```

A future Glassbox vector index must preserve visibility / ownership metadata strongly enough to enforce this before protected text reaches the model.

### Routing cannot widen authority

The router may choose model, provider, thinking depth, ensemble mode, or prompt policy. It may not choose authorization scope.

Routing operates on already-authorized request metadata and context. A cheaper or more capable model never receives data the Principal could not access through the normal path.

### Cache and semantic reuse are permission-scoped

Any future semantic cache, retrieval cache, or route-result cache must include sufficient scope in its key, at minimum the Agent and effective authorization / visibility boundary.

A cached result created for the Owner must never be reused for a Visitor merely because their prompts are semantically similar.

Revocation must invalidate or bypass stale authorization-sensitive cache entries.

### Token optimization cannot erase evidence

Context compression may reduce what is sent to a model. It must not delete Raw Trace, AuthorizationDecision, Approval, Run provenance, or the ability to explain why a result was produced.

Glassbox may maintain a compact model-facing projection while preserving full append-only evidence separately.

### Tool-result budgeting belongs at the Tool boundary

The strongest OpenSquilla idea here is to budget Tool output before it floods the next model request.

Glassbox should eventually distinguish classes such as external retrieval, local source context, artifact data, control results, and errors, with different budgets and projection rules.

Authorization still runs before and at protected Tool execution. Budgeting happens after the Tool is allowed, not instead of permission checks.

### Routing decisions should be traceable

A future routing event should be inspectable, for example:

```text
RoutingDecision
  runId
  routeClass
  modelTier
  provider
  model
  thinkingLevel
  promptPolicy
  estimatedInputTokens
  contextBudget
  reason
  fallback?
```

This gives Eval a real surface for measuring cost / quality tradeoffs instead of treating routing as hidden magic.

## P5 reviewed source set

Plan 05 re-audited the live upstream at commit `9e38139641daea70db967091aecce9524b93efe0`.

P5A additionally reviewed:

~~~text
tests/test_context_budget_governor.py
tests/test_engine/test_context_budget_coordinator.py
tests/test_engine/test_tokenjuice_tool_result_projection.py
tests/test_tools/test_loop_guard.py
tests/test_session/test_tokenizer.py
~~~

P5B additionally reviewed:

~~~text
src/opensquilla/engine/routing/policy.py
src/opensquilla/observability/decision_log.py
src/opensquilla/observability/turn_call_log.py
src/opensquilla/observability/usage_telemetry.py
tests/test_engine/test_routing_policy_stages.py
tests/test_engine/test_routing_policy_parity.py
tests/test_observability/test_decision_log_contract.py
tests/test_observability/test_decision_log_cost_source.py
tests/test_observability/test_log_privacy.py
~~~

P5 deliberately does not make the full ONNX/LightGBM router or ensemble system a baseline dependency. It first ports deterministic routing policy/evidence.

The P5 audit also did not identify a complete generic semantic model-answer cache that satisfies Glassbox authorization/revocation semantics. Treat generic semantic response caching as deferred; first prove authority-scoped deterministic projection/retrieval reuse.

Detailed audit: `.plans/findings/05-p5-upstream-review-2026-09-21.md`.

## Serverless note

At this review commit, we verified OpenSquilla's gateway, runtime targets, router, persistence, budgeting, retrieval, and provider abstractions, but did not find a clearly named first-class Serverless deployment implementation in the main source tree comparable to a dedicated Lambda / Workers runtime.

Do not document “OpenSquilla serverless” as a proven upstream mechanism until a concrete source path or deployment artifact is identified. We can still reuse its stateless boundary ideas when Glassbox later targets serverless execution.

For Glassbox, a future serverless execution layer should keep durable identity, Conversation, permissions, jobs, and other structured state outside ephemeral workers, with Turso and Trace remaining durable sources of truth.

## Current phase boundary

P4A/P4B are closing the governed learning and authorization-first retrieval phase. P5 planning is now frozen, but production P5 work starts only after both P4 streams are merged and their completion gates pass from main.

P5A may adapt the reviewed Context-budget, Tool-budget, token-estimation and projection mechanisms. P5B may adapt deterministic routing-policy and decision-observability mechanisms.

The P3/P4 security order remains authoritative:

~~~text
Authorization
→ protected source / Tool access
→ retrieval / execution
→ P5 optimization / routing
→ Delivery
~~~

Do not let routing, cache, Context compression or token optimization become an alternate authorization path.
