# Plan 05B — Routing and Runtime Observability

Status: ACTIVE COMBINED P5 IMPLEMENTATION AFTER P4 COMPLETION

Tracking Issue: #14

Sibling stream: [Plan 05A — Context Budgeting and Runtime Efficiency](./05a-context-budgeting-runtime-efficiency.md)

The Owner requested one implementation PR for P5A and P5B. The two boundaries remain separate modules within that PR. Implementation starts from post-P4 main.

## Goal

P5B makes execution choice and operational state explicit, measurable and testable without turning a router, quota source or external telemetry backend into a new authority.

Target path:

~~~text
current authorized Run
+ P5A ContextDemandEstimate
+ configured model/runtime capabilities
+ trusted product policy
        ↓
RoutingDecision
  route class
  profile/provider/model
  thinking level
  reason/floor/fallback
        ↓
P5A route-specific Context budget
        ↓
Pi execution
        ↓
actual RuntimeUsage / RuntimeHealth
+ Task/Worker operational observations
        ↓
Raw Trace / durable projections / Eval
~~~

Acceptance sentence:

> Every routed Run has a reconstructable decision and actual execution identity; routing can never widen authorization; thinking depth is capability-aware; usage/cost/quota/health distinguish actual/estimated/unknown; Herdr observations never replace Task truth; and routing Eval can detect unsafe downgrade, unavailable-model fallback and decision-vs-execution drift.

## Entry gate from P4

Production P5B begins only after P4A/P4B merge and main passes their completion gates.

P5B must not route against a pre-P4 Context model and later assume the retrieved source set was authorized correctly.

Implementation branches are cut from one post-P4 baseline.

## Upstream-first rule

Use mature routing/usage/health/observability mechanisms selectively, then map them into Glassbox-owned Run/Trace/Eval contracts.

Do not copy an upstream product's provider lineup, desktop assumptions, telemetry trust model or worker truth.

Audit:

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

Relevant paths:

| Upstream path | P5B use |
| --- | --- |
| src/opensquilla/squilla_router/controller.py | thinking/prompt post-processing |
| src/opensquilla/router_tiers.py | canonical tier/route-class shape |
| src/opensquilla/engine/routing/policy.py | RoutingDecision, capability/large-context/budget/fallback policy stages |
| src/opensquilla/observability/decision_log.py | structured per-turn routing evidence |
| src/opensquilla/observability/turn_call_log.py | content-minimizing diagnostic boundary |
| src/opensquilla/observability/usage_telemetry.py | privacy-aware usage aggregation ideas |

Focused tests:

~~~text
tests/test_engine/test_routing_policy_stages.py
tests/test_engine/test_routing_policy_parity.py
tests/test_engine/goldens/routing_policy_parity_golden.json
tests/test_observability/test_decision_log_contract.py
tests/test_observability/test_decision_log_cost_source.py
tests/test_observability/test_usage_telemetry.py
tests/test_observability/test_log_privacy.py
~~~

P5B should not begin by importing OpenSquilla's full ONNX/LightGBM router artifact, ensemble plans, provider presets or Gateway. First establish the policy seam and deterministic acceptance behavior.

### Javis603/token-monitor

Reviewed stable release:

~~~text
8031cf3b75c7f354db8a990a983999c69086da28
v0.60.0
MIT
~~~

Relevant paths:

~~~text
src/shared/usage.js
src/shared/clientCatalog.js
src/shared/clientHealth.js
src/shared/limits/collector.js
src/shared/limits/core.js
tests/shared/usage.test.js
tests/shared/clientHealth.test.js
tests/shared/usageThroughput.test.js
tests/shared/collectorLoadGuards.test.js
~~~

Adopt the adapter-specific normalization pattern, especially:

- input/output/cacheRead/cacheWrite/reasoning components;
- capability flags for fields such as throughput;
- unavailable vs exact zero;
- quota-window normalization;
- source freshness and health;
- no direct UI dependence on provider-specific files.

Pi is the first production data source. P5B does not need to port Token Monitor's whole client catalog.

### herdrdev/herdr

Reviewed P5 commit:

~~~text
7e91c4cd933201e1f578f89e87cd8b20bc87c658
Apache-2.0
~~~

Use the public protocol semantics first:

~~~text
session.snapshot
events.subscribe
events_lost recovery
pane.agent_status_changed
agent/pane state
connection health / heartbeat ideas
~~~

Reviewed paths:

~~~text
docs/next/website/src/content/docs/socket-api.mdx
src/client/endpoint/health.rs
src/api/schema/events.rs
~~~

Herdr events are live execution observations. Glassbox owns Task / TaskAttempt / WorkerBinding / review / rework / acceptance.

### OpenTelemetry

Reviewed references:

~~~text
open-telemetry/semantic-conventions
d0472f4ae331e8ef01aa571fe024d0d6a1a9b5e1

open-telemetry/opentelemetry-specification
148f27606cf0352c11a314e7bf9eefa6bf88db86
~~~

Use OpenTelemetry for interoperability/naming concepts only:

- spans represent operations;
- metrics use stable names/units and bounded dimensions;
- duration unit is seconds when exported as OTel metrics;
- Resource describes emitting service/runtime;
- content attributes can contain sensitive information;
- GenAI conventions are evolving and are not Glassbox's canonical domain model.

Raw Trace and Turso remain the evidence/product sources of truth. An OTel exporter is optional.

## Glassbox ownership

P5B owns:

~~~text
RoutingInput
RoutingDecision
ModelCapacity
route classes / floors / fallback trail
model/profile selection policy
thinking-depth selection
RuntimeUsage
RuntimeUsageCapabilities
RuntimeLimits
RuntimeHealth
OpsHealthSnapshot
routing evidence
routing Eval
sanitized optional OTel projection
~~~

P5B does not own:

~~~text
Context-budget arithmetic
Tool result truncation/projection
Context compression
authorization-scoped cache implementation
retrieval ranking
Memory/Taste promotion
Task acceptance
authorization grants
Delivery policy
~~~

## Security / correctness invariants

### Route changes do not change authority

~~~text
same Principal
same authorized Resources
same protected Tool decisions
same Delivery policy
different execution choice
~~~

A route cannot add a Tool, Resource or Memory source merely because a stronger model could use it.

### Capability/risk floor only tightens execution requirements

A trusted capability/risk/long-context signal may require a higher minimum route.

A cost/latency preference may never force a route below that minimum.

### Router metadata is not user authority

A local classifier, learned probability, provider hint, quota state or prior routing history cannot grant permission.

### Actual, estimated and unknown remain distinct

Examples:

~~~text
provider reported 0 tokens      → actual zero
provider did not expose field   → unknown
P5A estimated 4000 tokens       → estimate
pricing unavailable             → cost unknown, not $0.00
quota source unavailable        → unknown, not unlimited
~~~

## Shared P5 contract

~~~text
P5A ContextDemandEstimate
        ↓
P5B RoutingInput
        ↓
RoutingDecision + ModelCapacity
        ↓
P5A ContextBudgetSnapshot / projection
        ↓
Pi
        ↓
P5B RuntimeUsage / health / evidence
~~~

RoutingInput should use the current authorized request plus bounded derived features. It should not require raw protected retrieved text.

P5B starts with fixture ContextDemandEstimate values and integrates the P5A estimator in the combined PR.

## Module boundary in the combined implementation

P5B production ownership in the combined PR:

~~~text
apps/server/src/routing/**
apps/server/src/ops/health.ts
focused routing/observability tests
routing-specific Eval additions
Agent Ops health projection leaf modules
~~~

Shared integration hotspots:

~~~text
apps/server/src/runtime/pi/adapter.ts
apps/server/src/runtime/pi/configured-model.ts
apps/server/src/management/application.ts
apps/server/src/persistence/schema.ts
packages/contracts/src/index.ts
~~~

Core routing and normalization logic lives in leaf modules before these shared files are integrated.

P5B must not take ownership of runtime/efficiency modules.

## Routing contract

A RoutingDecision should be sufficient to reconstruct why and what executed without storing the whole prompt.

Target fields include:

~~~text
runId
policyVersion
decisionSource
routeClass
selectedProfileId
provider
model
thinkingLevel
promptPolicy / projection hint when supported
contextDemand summary
capabilityFloor
riskFloor
reasonCodes[]
fallbackTrail[]
ModelCapacity
createdAt
~~~

Route classes may use a small canonical vocabulary such as R0-R3, but they do not imply specific vendor/model names. Model assignments remain configured data.

## Baseline-first routing

P5B first inserts the routing seam with **no behavior change**:

~~~text
RoutingDecision
  source = configured_default
  selected route = current configured profile/model
~~~

Only after evidence/fixtures pass should policy stages alter selection.

This makes it possible to test:

- decision vs actual runtime identity;
- fallback recording;
- trace persistence;
- P5A handshake;

before introducing optimization risk.

## Deterministic policy stages

Port useful OpenSquilla policy ideas, adapted to trusted Glassbox signals.

Initial stages:

~~~text
explicit product/user override
configured availability
capability gate
Context capacity floor
trusted high-risk / strict-format / debug floor
anti-unsafe-downgrade / continuity rule where justified
known quota/budget policy
fallback
~~~

Do not make a probabilistic classifier the only reason for a security-sensitive floor.

The first production classifier may be deterministic / rules-based. A local learned classifier can be a later P5B slice only if differential Eval proves it improves routing without violating floors.

Full ensemble execution is not required for P5.

## Thinking-depth selection

P5B may adapt OpenSquilla's T0-T3 post-processing concept, but Glassbox stores a runtime-neutral requested level.

Example normalized levels:

~~~text
none
low
medium
high
unknown
~~~

Mapping to a provider/runtime happens at the adapter boundary.

Rules:

- unsupported stays unknown/null;
- explicit current instruction or profile override is respected;
- a high-risk/capability floor cannot be reduced by a cheap-route preference;
- selected thinking level is observable;
- hidden reasoning content is never logged/exposed.

## ModelCapacity

Routing must return verified capacity needed by P5A, not a universal hard-coded assumption.

Possible fields:

~~~text
contextWindowTokens
maxOutputTokens
supportedThinkingLevels
supportsUsageComponents
supportsStreaming
source
observed/configured version
~~~

Current main's configured Pi model path contains fixed contextWindow/maxTokens values. P5B must replace “one placeholder fits every model” with verified configured/provider capability data or an explicit unknown state before dynamic routing depends on it.

Unknown capacity must not be treated as safely huge.

## RuntimeUsage

Pi first.

The current Pi adapter already normalizes provider/model and token usage events. Build from that evidence before scanning unrelated local clients.

Target normalized shape:

~~~text
inputTokens
outputTokens
cacheReadTokens
cacheWriteTokens
reasoningTokens
totalTokens
durationMs
timeToFirstTokenMs when supported
costUsd
costSource
capabilities
observedAt
source
~~~

Cost rules:

- provider actual billing beats local estimate;
- explicit pinned pricing can be a separate estimate source;
- no pricing source → null/unknown;
- zero placeholder in a model declaration is not evidence of free usage.

## Runtime limits / quota

Adapt Token Monitor dispatch/normalization rather than mixing provider-specific code into UI.

Possible projection:

~~~text
available
source
observedAt
stale
windows[]
  kind
  remaining / used / limit when known
  resetAt
reasonCode
~~~

Do not create new provider credentials just to populate a dashboard.

Collector errors produce an honest unavailable/degraded state and never fail the Personal Agent execution path unless the selected provider itself is unusable.

## RuntimeHealth

Separate dimensions where useful:

~~~text
configuration
provider/model availability
session/runtime
quota source
usage source
freshness
last success/failure reason
~~~

Avoid one green/red boolean that hides an unknown source.

Management UI consumes the Glassbox projection, not Token Monitor objects.

## Agent Ops health / throughput

Use two truth classes:

~~~text
Glassbox durable truth
  Task
  TaskAttempt
  WorkerBinding
  Attention
  review / rework / acceptance timestamps

Herdr live observation
  connection
  snapshot
  pane/agent lifecycle
  event freshness
~~~

Examples of derived management metrics:

~~~text
active Tasks / Attempts
workers starting/working/blocked/unknown
Tasks waiting review
Tasks accepted/completed in a window
attempt throughput
review latency
blocked duration
rework count/rate
bridge connected/degraded/stale
last successful reconciliation
~~~

Herdr event-loss semantics matter:

~~~text
events_lost
→ cached live state is stale
→ resubscribe
→ session.snapshot
→ reconcile
→ only then healthy/fresh again
~~~

A Herdr done event never counts as a completed Glassbox Task until acceptance semantics say so.

## Routing / runtime evidence

Record safe structured evidence in existing Glassbox evidence paths.

A routing record should let an Owner answer:

~~~text
what route was chosen?
why?
which floor applied?
what fallback occurred?
which model actually ran?
what actual usage was reported?
was quota/health known?
which policy version made the decision?
~~~

Do not copy prompt, response, Tool body or Memory content solely for routing observability.

Raw Trace remains append-only evidence. Derived dashboards remain projections.

## Optional OpenTelemetry projection

P5B may provide an exporter/adapter after Glassbox-owned evidence works.

Rules:

- no prompt/response/Memory/Tool content by default;
- bounded low-cardinality metric attributes;
- Run/Trace correlation must not explode metric label cardinality;
- spans represent operations, metrics aggregate measurements;
- exporter failure is non-authoritative;
- no external backend is required for local correctness;
- current GenAI semantic-convention changes do not force Glassbox domain-schema churn.

## Routing Eval

Extend the existing Glassbox Eval system rather than introduce a second evaluator.

Initial routing suite should be deterministic.

Fixture expectations can express:

~~~text
exact route
minimum route
maximum route
required thinking floor
forbidden downgrade
required fallback
expected unknown fields
authorization surface digest unchanged
~~~

Required cases:

- simple low-demand request stays on safe default/low route where policy permits;
- long-context demand never selects a model that cannot fit;
- trusted high-risk/capability floor is respected;
- explicit route/model override is respected when configured/allowed;
- selected model unavailable → traceable safe fallback;
- quota unknown does not act like unlimited or exhausted;
- model change does not change Tools/Resources;
- decision record matches actual Pi provider/model;
- actual usage is not replaced by estimates;
- route disabled → current configured behavior preserved.

No LLM judge is the first acceptance oracle. Later differential Eval may compare quality/cost after deterministic invariants pass.

## Implementation route

### P5B.0 — Post-P4 / current-runtime audit

Rebase onto completed P4 main. Freeze contracts and baseline routing behavior.

### P5B.1 — Routing / observability contracts

Add RoutingDecision, ModelCapacity, usage/health/limits/Ops projections and fixtures.

### P5B.2 — No-op routing seam

Route every eligible Run through a structured decision that selects the current configured default.

Verify decision vs actual runtime identity.

### P5B.3 — Deterministic route policy + thinking selection

Add policy stages one at a time with parity/golden tests.

### P5B.4 — Pi RuntimeUsage

Persist/serve normalized actual Pi usage and honest capabilities.

### P5B.5 — Runtime limits / health

Add Pi/configured-provider collectors first. Keep unsupported runtimes out or unknown.

### P5B.6 — Agent Ops health

Add Herdr connection/freshness/reconciliation projection plus Glassbox durable throughput.

### P5B.7 — Routing evidence + management projections

Make routing/usage/health inspectable without raw content.

### P5B.8 — Routing Eval

Add deterministic routing suite to the existing Eval system.

### P5B.9 — Optional OTel adapter + acceptance

Only after Glassbox evidence is complete. Run restart/failure/adversarial acceptance and repository gates.

## Test matrix

At minimum:

~~~text
routing disabled
configured-default parity
small/large Context demand
unknown ModelCapacity
incapable model
trusted risk floor
explicit override
unavailable provider/model
fallback chain
thinking unsupported
Pi usage components present/absent
reasoning/cache fields
unknown pricing
known zero vs unknown cost
unknown quota
stale quota
collector failure
restart
Herdr reconnect
Herdr events_lost
Task REVIEW vs Herdr done
rework throughput
Visitor/group management denial
route authorization-surface equality
routing evidence vs actual runtime
Eval replay from stored evidence
OTel exporter failure
~~~

## Completion gate

P5B is complete when:

~~~text
routing is inspectable product logic
route changes never widen authority
capability/risk floors prevent unsafe downgrade
thinking selection is capability-aware
Pi actual usage is normalized honestly
cost/quota/health distinguish unknown from zero
Agent Ops health combines Task truth with Herdr observation correctly
fallbacks are reconstructable
routing Eval catches route/execution/safety drift
optional telemetry cannot replace Raw Trace
P5A consumes RoutingDecision/ModelCapacity without P5B internals
all P3/P4 security/retrieval/Delivery regressions remain green
~~~

## PR provenance requirement

The combined P5 implementation PR must list:

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

P5B does not add:

- P5A Tool/Context projection;
- a full OpenSquilla ML/ensemble stack as the baseline;
- new authorization semantics;
- new provider credentials merely for monitoring;
- broad Token Monitor desktop scanning without a product requirement;
- raw protected content in OTel;
- Herdr state as Task truth;
- P6 workflow/DAG/checkpoint/scheduler;
- P8 self-learning route promotion.
