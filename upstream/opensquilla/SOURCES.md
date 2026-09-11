# OpenSquilla source index

Reference project: `TokenRhythm/opensquilla`

Pinned upstream commit: `75a7085960ee57bc7a17acde5ce08071af4e7632`

Upstream branch at review time: `main`

Primary license: Apache-2.0.

OpenSquilla is an approved reference for Glassbox's later efficiency layer. No production code in Glassbox imports this directory, and none of the mechanisms below are required to complete Plan 03.

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

## Serverless note

At this review commit, we verified OpenSquilla's gateway, runtime targets, router, persistence, budgeting, retrieval, and provider abstractions, but did not find a clearly named first-class Serverless deployment implementation in the main source tree comparable to a dedicated Lambda / Workers runtime.

Do not document “OpenSquilla serverless” as a proven upstream mechanism until a concrete source path or deployment artifact is identified. We can still reuse its stateless boundary ideas when Glassbox later targets serverless execution.

For Glassbox, a future serverless execution layer should keep durable identity, Conversation, permissions, jobs, and other structured state outside ephemeral workers, with Turso and Trace remaining durable sources of truth.

## Current phase boundary

Plan 03 remains:

```text
Identity
→ Authorization
→ Conversation
→ Turso persistence
→ Run / Authorization Trace
```

Do not add smart routing, vector retrieval, semantic cache, TokenJuice-style projection, or serverless deployment merely to complete Plan 03.

Those become valuable after the security and persistence boundary is correct.