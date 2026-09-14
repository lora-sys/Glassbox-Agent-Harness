# Glassbox Data, Storage, Observability, and Public Read Model

Status: CURRENT ARCHITECTURE DECISION

This document defines the cross-cutting data architecture for Glassbox.

It is not a phase plan. It describes the intended boundaries for durable state, search, evidence, analytics, public Trace and Eval views, and the Web UI regardless of when each capability is implemented.

The governing product rule is:

```text
Owner controls everything.
Other people do not get a management surface.
Other people may only see explicitly published Trace or Eval views.
```

Channel users may interact with the Personal Agent through QQ, email, or other authorized Channels. That does not grant access to the Glassbox management UI.

## 1. Product access model

Glassbox has two Web access planes.

### Owner control plane

The Owner is the only administrator.

The Owner Web UI may inspect and manage:

```text
Agent
Identity
Principal
Authorization
Conversation
Channel state
QQ state
Mail state
Calendar state
Runs
Raw Trace
Derived Trace
Eval
Memory
Retrieval
Skills
Assets
Journal
LongTask
Workers
Providers
Models
Prompts
Costs
Usage
System health
Storage
Publications
Configuration
```

Every mutation remains a server-side named Action and goes through authorization.

There is no generic admin, editor, operator, team member, or collaborator role unless the product decision is deliberately changed later.

### Public observer plane

A non-Owner Web visitor can read only an explicitly published Trace or Eval projection.

Public access does not include:

```text
Workbench
Canvas editing
Conversation history
Memory
QQ member data
Mail inbox
Calendar
Assets by default
Agent configuration
Provider configuration
Prompts by default
Secrets
Permissions
Approvals
Grants
Private authorization records
LongTask control
Worker control
Runtime control
Storage browser
Admin analytics
```

Public Trace and Eval are read-only observations. They never grant execution authority.

## 2. Public data must be a publication snapshot

Never expose private production tables directly through a public route.

A public Trace or Eval is a derived, sanitized publication snapshot created by an Owner-only Publish action.

```text
Private source
    ↓
Owner Publish action
    ↓
Redaction + allowlist projection
    ↓
Immutable publication snapshot
    ↓
Public API
    ↓
Public Trace / Eval page
```

This is stricter than adding a `public = true` flag to a raw trace row.

A publication record should contain at least:

```text
id
kind                  trace | eval
source_id
slug
visibility            public | unlisted
publication_version
redaction_policy_version
summary_json
stats_json
snapshot_object_key?
source_content_hash
snapshot_content_hash
published_at
revoked_at?
```

Republishing after source data or redaction policy changes creates a new publication version. It does not silently rewrite old evidence.

Revoking a publication removes public access. It does not delete or rewrite the private source evidence.

### Public Trace default allowlist

A public Trace may show:

```text
public trace id
title chosen for publication
start and end time
duration
status
provider
model
safe span tree
safe operation names
safe tool names
tool status and duration
token counts
estimated or actual cost
latency
safe authorization outcome summaries
safe artifact metadata selected for publication
published Eval scores linked to the Trace
```

The following are private by default and require an explicit publication decision:

```text
system instructions
user prompts
model input content
model output content
tool arguments
tool results
file paths
repository names
private resource identifiers
QQ ids
email addresses
calendar details
Memory contents
secret-screening payloads
browser cookies
headers
credentials
raw external messages
```

### Public Eval default allowlist

A public Eval may show:

```text
suite name
suite version
run status
agent version
git commit when safe
provider
model
model configuration when safe
sample count
completed count
aggregate scores
score distributions
pass rate
invariant violations
latency statistics
token statistics
cost statistics
safe per-sample summaries
links to separately published Traces
```

Private datasets, private prompts, hidden expected outputs, private source files, and unpublished Trace content remain private.

## 3. Storage topology

The selected architecture is intentionally small.

```text
                         Glassbox Server
                               │
              ┌────────────────┼────────────────┐
              │                │                │
            Turso              R2           AgentMail
              │                │                │
      structured state     raw evidence      email transport
      query indexes        large objects      inbox source
      FTS                  attachments        threads
      vectors              archives           webhooks
      analytics metadata   backups
              │
              └──── all product reads go through Glassbox server APIs ────┐
                                                                         │
                                                                  Web UI
```

The browser does not receive direct Turso, R2, or AgentMail credentials.

### Selected services

| Concern | Selected store or service | Role |
| --- | --- | --- |
| Structured durable state | Turso | Canonical relational state and metadata |
| Lexical retrieval | Turso FTS | Keyword and exact-text retrieval |
| Vector retrieval | Turso native vectors | Embeddings and nearest-neighbor retrieval |
| Raw execution evidence | Cloudflare R2 | Append-only Trace payloads and large evidence |
| Files and artifacts | Cloudflare R2 | Attachments, screenshots, PDFs, archives, generated outputs |
| Email transport | AgentMail | Inbox, thread, message, attachment and webhook source |
| Runtime execution | Glassbox server | Agent Runtime, QQ Bot, Workers, Browser, Scheduler, Web API |
| Ephemeral state | Glassbox server memory or local temporary storage | Active execution only |
| Secrets | Server secret environment or dedicated secret store | Never ordinary application data |

### Deliberately not selected as core dependencies

The current architecture does not require Supabase, Qdrant, Redis, Langfuse, ClickHouse, Elasticsearch, Meilisearch, or a separate queue service.

Their patterns may be studied. They should not become dependencies merely because they solve a category that Turso, R2, or the server already covers.

A later infrastructure change must preserve the contracts in this document.

## 4. Turso is the structured state center

Turso stores data that is structured, queryable, permission-aware, and useful to product UI.

It should hold metadata and state, not every large payload.

### Identity and authorization

```text
agents
users
principals
channel_identities
identity_bindings
relationships
resources
permissions
grants
revocations
approvals
authorization_decisions
authorization_policy_versions
```

Important properties:

```text
identity does not grant authority
revocation affects the next protected operation
denied private contents are never copied into denial evidence
all mutable authorization state is versionable and auditable
```

### Conversation and Channel state

```text
conversations
conversation_participants
messages
message_references
message_mentions
message_attachments
channel_events
```

The durable model keeps these identities separate:

```text
Conversation ≠ Session ≠ Run
```

### QQ data

QQ is a Channel, not a separate Agent.

Store normalized QQ state such as:

```text
qq_groups
qq_group_memberships
qq_message_metadata
qq_mentions
qq_replies
qq_channel_events
```

Useful fields include:

```text
external_user_id
external_group_id
display_name
first_seen_at
last_seen_at
message_count
interaction_count
agent_mention_count
agent_reply_count
```

Do not treat an inferred social relationship as a fact without evidence.

If Glassbox later derives social observations, store them separately:

```text
social_observations
subject_principal_id
object_principal_id
observation_type
confidence
source_run_id
source_message_id
first_observed_at
last_observed_at
```

These records remain Owner-only unless they are deliberately transformed into safe public Trace or Eval data.

### Provider and execution state

```text
provider_sessions
runs
run_inputs
run_results
model_calls
tool_calls
worker_jobs
worker_attempts
execution_policies
router_decisions
retry_records
cancellations
```

### Model and cost registry

```text
providers
models
model_capabilities
model_price_versions
usage_records
cost_records
budget_records
```

A stored cost should say whether it is:

```text
provider_reported
calculated_from_versioned_price
estimated
unknown
```

Never present an estimate as a provider invoice value.

### Memory

Memory is promoted durable knowledge, not raw Conversation history.

```text
memory_candidates
memories
memory_sources
memory_versions
memory_conflicts
memory_embeddings
memory_promotion_decisions
```

Suggested Memory fields include:

```text
id
agent_id
owner_principal_id
type                  semantic | episodic | procedural
content
visibility
resource_scope
reliability
future_utility
goal_relevance
novelty
staleness
privacy_risk
source_run_id
source_trace_id
content_hash
embedding_model
embedding_version
created_at
updated_at
```

Embeddings inherit the same protection as the source content. An embedding is not public merely because it is not human-readable.

### Retrieval

Glassbox should record retrieval as observable execution, not a hidden helper call.

```text
retrieval_runs
retrieval_candidates
retrieval_hits
retrieval_policies
```

A retrieval run should capture:

```text
run_id
principal_id
query_hash
query_text when allowed
embedding_model
lexical_weight
vector_weight
source_weight_policy
temporal_decay_policy
candidate_count
authorized_count
selected_count
context_budget
created_at
```

Each candidate or hit may record:

```text
resource_ref
lexical_score
vector_score
recency_score
source_score
final_score
selected
selection_reason
```

Protected content is never added to model-visible retrieval results before authorization.

If a vector index cannot efficiently pre-filter all authorization conditions, it may return opaque candidate ids and scores internally. Glassbox must re-authorize before fetching protected content and before exposing candidate details to the model or caller.

### Semantic cache

If semantic caching is used, it is permission-scoped.

```text
semantic_cache
scope_hash
principal_scope_hash
query_hash
query_embedding
model
prompt_version
execution_policy_hash
response_ref
created_at
expires_at
hit_count
```

An Owner-private cache entry can never be reused for a Visitor merely because the query is semantically similar.

### Assets and lineage metadata

Large bytes live in R2. Turso keeps metadata and provenance.

```text
assets
asset_versions
asset_sources
artifact_links
```

Suggested fields:

```text
id
name
type
mime_type
size_bytes
sha256
object_key
visibility
source_run_id
source_trace_id
source_tool_call_id
created_at
```

### Skills

```text
skill_candidates
skills
skill_versions
skill_sources
skill_eval_results
skill_promotion_decisions
```

A Skill version should preserve:

```text
procedure
preconditions
failure_modes
source_runs
verification_status
version
```

A successful Run by itself does not create a permanent Skill.

### Journal and review

```text
journal_entries
review_periods
review_entries
journal_sources
```

Journal and review records are products of explicit Runs and retain provenance to the evidence that produced them.

### Long work

```text
long_tasks
long_task_steps
long_task_events
long_task_checkpoints
long_task_signals
long_task_dependencies
worker_jobs
```

Durable task state should be sufficient to resume after server restart.

### Eval and experiments

```text
experiments
eval_suites
eval_cases
eval_runs
eval_samples
eval_scores
eval_score_configs
eval_reductions
eval_artifact_links
```

An Eval run should preserve the configuration that can explain a result:

```text
agent_version
git_commit
prompt_version
provider
model
model_version when available
thinking_level
temperature
seed when available
execution_policy
retrieval_policy
tool_versions
memory_snapshot_ref
dataset_version
scorer_versions
judge_model when used
started_at
ended_at
```

Eval measurements and judgments remain distinct.

Measurements include:

```text
latency
tokens
cost
tool count
exit code
invariant violations
```

Judgments include:

```text
LLM judge score
human score
categorical review
text review
```

### Mail mirror

AgentMail remains the email transport source. Glassbox stores the indexes and relationships required by the product.

```text
mail_accounts
mail_threads
mail_messages
mail_recipients
mail_labels
mail_events
mail_attachment_refs
```

Store AgentMail ids so Glassbox can fetch source data when required.

Large attachments should be copied to R2 when Glassbox needs durable local ownership, replay, or provenance.

### Calendar mirror

A future calendar provider remains the scheduling source, while Glassbox keeps product metadata and relationships.

```text
calendar_accounts
calendar_events
calendar_event_links
calendar_sync_state
```

Calendar contents are private resources by default.

### Publication state

```text
publications
publication_versions
publication_assets
publication_access_log
```

Only Trace and Eval publication kinds are allowed by the current public Web access rule.

## 5. Turso search responsibilities

Turso is also the default search engine for Glassbox product data.

### Lexical search

Use full-text search for values where exact terms matter:

```text
names
error codes
file names
commit ids
issue numbers
model names
tool names
email subjects
commands
Memory text
Skill text
Asset text metadata
```

### Vector search

Use native vectors for semantic retrieval over data such as:

```text
Memory
selected Asset text
Skill descriptions
safe document chunks
retrieval cache keys
```

Store embedding metadata:

```text
embedding_model
embedding_dimension
embedding_version
source_content_hash
chunk_strategy
chunk_version
created_at
```

Changing the embedding model must not leave incompatible vectors silently mixed in the same logical index.

### Hybrid retrieval

The target retrieval composition is:

```text
authorized scope
+ exact filters
+ lexical retrieval
+ vector retrieval
+ source weighting
+ temporal decay
+ diversity reranking
+ context budget
```

The search implementation remains behind a Glassbox-owned retrieval interface so storage technology cannot bypass authorization.

## 6. R2 is the evidence and large-object store

R2 stores bytes that are too large, too append-heavy, or too archival for the structured database.

Use R2 for:

```text
Raw Trace JSONL
model input and output evidence when retention permits
tool raw results
browser HAR
browser screenshots
console logs
QQ attachments
email attachments
PDF
HTML snapshots
images
audio
video
repository archives
large diffs
Eval full logs
Eval datasets
Eval large sample payloads
Arena or replay bundles
generated artifacts
Skill package exports
publication snapshot bundles
Turso exports and backups
```

### Object metadata

Turso should contain an index for every product-relevant object:

```text
object_key
sha256
size_bytes
mime_type
created_at
source_run_id?
source_trace_id?
asset_id?
visibility
retention_class
```

### Raw Trace remains append-only evidence

The existing Glassbox Trace store already writes append-only JSONL and never overwrites existing lines. That invariant remains.

The storage backend may evolve from local disk to R2, but Raw Trace must keep these properties:

```text
append-only
ordered
source provenance
stable ids
original timestamps
no retroactive rewrite to match newer Derived State
```

Local disk may be used as a write buffer or temporary fallback, but remote durable evidence should not depend on a single server disk.

### Historical analytics

For large historical Trace or Eval archives, Glassbox may compact safe analytical fields into Parquet or Iceberg data in R2.

R2 Data Catalog and R2 SQL can then support historical analytical queries without making them the source of truth for authorization or live product state.

The Web UI must remain backend-independent. It calls Glassbox APIs and does not query R2 SQL directly.

## 7. Trace data model

Glassbox should converge on an OpenTelemetry-compatible mental model without giving an external telemetry system authority over product semantics.

A Trace represents one end-to-end execution tree.

A Span represents one operation inside it.

```text
Trace
  Root Run span
    Authorization span
    Context assembly span
    Retrieval span
    Model span
      Tool span
      Tool span
    Worker span
    Persistence span
```

A trace index should support at least:

```text
trace_id
run_id
conversation_id
principal_id
channel
start_time
end_time
duration_ms
status
provider
model
input_tokens
output_tokens
cached_tokens
reasoning_tokens
cost
error_code
raw_object_key
content_hash
```

A span should support:

```text
span_id
trace_id
parent_span_id
name
kind
start_time
end_time
status
attributes
safe_summary
raw_payload_ref?
```

Trace events may represent:

```text
model generation
model streaming
tool call
tool result
retrieval
authorization decision
approval
file change
browser action
worker delegation
retry
checkpoint
error
user action
```

Use common telemetry naming where it is useful, especially for model, token, latency, tool, and error dimensions. Glassbox-specific concepts such as Principal, AuthorizationDecision, Conversation, Run, WorkerJob, and publication remain explicit Glassbox fields.

## 8. Eval data model

Eval is both a research object and a public evidence object.

The model should support:

```text
Benchmark
Differential Eval
Invariant Eval
Routing Eval
Permission Eval
Memory Retrieval Eval
Tool Eval
LongTask Eval
```

The storage split follows the same rule as Trace:

```text
Turso
  definitions
  versions
  sample index
  scores
  aggregates
  cost and token metadata
  links

R2
  full logs
  large inputs
  large outputs
  datasets
  attachments
  replay evidence
```

This allows the Web UI to load summaries quickly without reading multi-megabyte or multi-gigabyte log objects.

Scores should be attachable to the appropriate unit:

```text
Eval run
Eval sample
Trace
Span or observation
```

Supported score value types should include:

```text
numeric
boolean
categorical
text
```

## 9. Web UI observability contract

A Glassbox feature is not operationally complete if its important state exists only in a cloud provider dashboard, local file, hidden database table, or log line.

For every product-relevant durable object, the server should provide enough read API for the Owner Web UI to inspect it.

For every product-relevant metric, the Web UI should be able to query a normalized value, time range, unit, and source.

The UI must render `unknown` when Glassbox does not actually know a value. It must not invent estimates without labeling them.

### Owner dashboard surfaces

The Owner Web UI should be capable of displaying these views.

#### Overview

```text
Agent status
runs today
success rate
active Conversations
QQ activity
mail activity
LongTask backlog
Eval summary
token usage
cost
recent failures
security events
storage usage
```

#### Runs and Trace

```text
run list
trace tree
span timeline
provider and model
model calls
tool calls
retrieval
authorization decisions
artifacts
errors
latency
tokens
cost
raw evidence links
publication state
```

#### Eval

```text
suite list
run list
sample list
scores
score distributions
pass rate
invariant violations
version comparisons
model comparisons
prompt comparisons
cost
latency
tokens
linked Trace
publication state
```

#### Identity and authorization

```text
Principals
Channel identities
relationships
grants
revocations
approvals
allow and deny counts
denied actions
confused-deputy attempts
publication actions
```

#### QQ

```text
groups
known identities
active users
messages over time
mentions
agent triggers
agent replies
response latency
attachment counts
errors
```

QQ identities and social statistics remain Owner-only.

#### Mail

```text
inboxes
threads
received
sent
bounces
failed sends
response latency
attachments
webhook failures
```

#### Memory and retrieval

```text
Memory count by type
candidate count
promotion and rejection count
stale Memory
conflicts
retrieval volume
candidate count
authorized candidate count
selected count
retrieval latency
lexical and vector contribution
context budget use
retrieval Eval results
```

#### Skills

```text
candidate count
validated Skills
version history
usage
failure rate
Eval results
source Runs
```

#### LongTask and Workers

```text
queued
running
waiting
completed
failed
cancelled
retry count
checkpoint count
step duration
worker utilization
worker errors
```

#### Cost and usage

```text
input tokens
output tokens
cached tokens
reasoning tokens
cost by day
cost by provider
cost by model
cost by Channel
cost by feature
cost by Eval
cost per successful Run
```

#### System health

```text
server uptime
process memory
CPU when available
event loop lag
disk usage
open WebSocket count
active Runs
provider error rate
Turso query latency
R2 operation failures
AgentMail webhook failures
QQ Channel failures
scheduler lag
```

#### Storage

```text
Turso database size when available
rows or object counts by domain
R2 bytes by category
R2 object counts
Trace archive size
Asset size
attachment size
backup status
oldest and newest retained evidence
```

## 10. Metrics and rollups

Do not create a second untraceable analytics truth.

Operational measurements should be derivable from normalized fact records where possible.

For fast dashboards, maintain explicit rollups such as:

```text
metric_rollups_hourly
metric_rollups_daily
```

A rollup record should include:

```text
metric_name
window_start
window_end
dimensions_json
value
unit
source_version
updated_at
```

Useful dimensions include:

```text
provider
model
channel
run_status
tool
worker
eval_suite
score_name
memory_type
```

High-cardinality private identifiers such as QQ user ids should not become public metric dimensions.

### Required run metrics

```text
run_count
run_success_count
run_failure_count
run_cancel_count
latency_ms p50 p95 p99
time_to_first_output_ms when available
input_tokens
output_tokens
cached_tokens
reasoning_tokens
cost
model_call_count
tool_call_count
tool_failure_count
retry_count
```

### Required authorization metrics

```text
allow_count
deny_count
requires_approval_count
approval_count
revocation_count
protected_tool_deny_count
invariant_violation_count
```

### Required retrieval metrics

```text
retrieval_count
candidate_count
authorized_candidate_count
selected_count
retrieval_latency_ms
context_tokens_added
cache_hit_count
cache_miss_count
```

### Required Eval metrics

```text
eval_run_count
sample_count
completed_sample_count
failed_sample_count
score mean median distribution where meaningful
pass_rate
invariant_violation_count
latency
input_tokens
output_tokens
cost
```

Measurements such as token counts and latency are never collapsed into the same field as human or LLM judgments.

## 11. API boundary

The browser talks only to Glassbox server APIs.

A useful logical split is:

```text
/api/owner/*
/api/public/traces/*
/api/public/evals/*
```

The exact route names are not frozen, but the trust boundary is.

### Owner APIs

Owner APIs can return authorized private state after server-side authentication and authorization.

Mutation APIs execute named Actions such as:

```text
Publish Trace
Revoke Trace Publication
Publish Eval
Revoke Eval Publication
Grant
Revoke
Approve
Start Eval
Promote Memory
Promote Skill
Cancel LongTask
```

### Public APIs

Public APIs read only publication snapshots.

They must not query arbitrary source ids supplied by the browser and then apply client-side redaction.

A safe pattern is:

```text
public slug
  ↓
publication lookup
  ↓
prebuilt safe snapshot
  ↓
response
```

There is no public generic query endpoint over private Turso tables.

## 12. Auth and identity for the Web UI

Glassbox does not need a general multi-user admin system for the current product rule.

The Owner control plane needs strong Owner authentication.

Public Trace and Eval pages may be:

```text
public
unlisted by opaque link
```

Public viewers do not need a Glassbox account unless a future product decision adds one.

Channel identity is independent from Web management authentication.

A QQ user may be a valid Channel Principal while still having no access to the Owner control plane.

## 13. Secrets

Secret values do not belong in ordinary Turso tables, public Trace, public Eval, or R2 objects without dedicated encryption and policy.

Examples:

```text
model provider API keys
Turso auth token
R2 secret key
AgentMail API key
QQ credentials
OAuth refresh tokens
browser cookies
SSH private keys
GitHub tokens
```

Turso may store safe secret metadata such as:

```text
secret name
provider
scope
created_at
last_rotated_at
```

The value stays in the server secret environment or a dedicated secret store.

Secret screening applies before publication as well as during execution logging.

## 14. Data retention and deletion

Different data classes need explicit retention behavior.

### Durable product state

Identity, authorization, Conversation identity, Memory, Skills, Assets, and LongTask state remain until explicitly deleted or superseded according to product policy.

### Raw evidence

Raw Trace is append-only while retained. Retention may archive or delete whole evidence objects, but must not rewrite events to change historical meaning.

### Publications

A public publication can be revoked without modifying the private source.

### External source deletion

If an external message or attachment is deleted at AgentMail, QQ, or another provider, Glassbox must know whether it owns an independent retained copy. The UI should show the provenance and current source availability when relevant.

### Tombstones

When deletion matters for synchronization or audit, store a tombstone or deletion event instead of making historical references ambiguous.

## 15. Backup and recovery

A Personal Agent that depends on one VPS disk is not durable enough.

The recovery contract should cover:

```text
Turso structured state
R2 evidence and assets
server configuration without secret values
schema migrations
publication records
critical external ids
```

Backups should have manifests containing content hashes and creation time.

The Owner Web UI should expose backup status and last successful recovery-relevant checkpoint.

## 16. External service facts relevant to this decision

These limits are operational notes checked on 2026-09-14. They are not permanent product contracts.

### Turso

The current Free plan advertises:

```text
100 databases
5 GB storage
500 million rows read per month
10 million rows written per month
3 GB sync
1 day point-in-time restore
```

Turso documentation currently provides native vector functions and vector indexing, and current FTS documentation provides indexed full-text search with scoring.

References:

- https://turso.tech/pricing
- https://docs.turso.tech/features/ai-and-embeddings
- https://docs.turso.tech/guides/vector-search
- https://docs.turso.tech/sql-reference/functions/fts
- https://docs.turso.tech/guides/code-indexing

### Cloudflare R2

The current R2 Standard free tier advertises:

```text
10 GB-month storage per month
1 million Class A operations per month
10 million Class B operations per month
free Internet egress
```

R2 SQL currently includes 10 GB of data scanned per month and is in beta. R2 Data Catalog provides an Iceberg catalog for analytical archives.

References:

- https://developers.cloudflare.com/r2/pricing/
- https://developers.cloudflare.com/r2-data-catalog/platform/pricing/
- https://developers.cloudflare.com/r2-sql/
- https://developers.cloudflare.com/r2-sql/platform/pricing/

### AgentMail

The current Free plan advertises:

```text
3 inboxes
3,000 emails per month
3 GB storage
```

AgentMail supports inboxes, threads, messages, attachments, Webhooks, and WebSockets. Webhook payloads expose message and thread identifiers; large message bodies may need to be fetched through the API.

References:

- https://www.agentmail.to/pricing
- https://docs.agentmail.to/inboxes
- https://docs.agentmail.to/webhooks-overview
- https://docs.agentmail.to/events
- https://docs.agentmail.to/permissions

## 17. External design references

These are references for data shape and UI ideas, not infrastructure dependencies.

### OpenTelemetry

Use its Trace and Span model as a compatibility reference for operation trees, timestamps, status, attributes, events, and links.

- https://opentelemetry.io/docs/concepts/signals/traces/
- https://opentelemetry.io/docs/specs/otel/trace/api/
- https://opentelemetry.io/docs/specs/semconv/

### Langfuse

Useful patterns include typed scores, attaching scores to observations, metrics APIs, and explicit public Trace links. Glassbox keeps stricter publication snapshots because its Trace can include authorization and private Personal Agent evidence.

- https://langfuse.com/docs/evaluation/scores/overview
- https://langfuse.com/docs/api-and-data-platform/features/observations-api
- https://langfuse.com/docs/observability/features/url

### Inspect AI

Useful patterns include keeping Eval headers and aggregates cheap to read while allowing full sample logs to live in a larger log artifact.

- https://inspect.aisi.org.uk/eval-logs.html
- https://inspect.aisi.org.uk/reference/inspect_ai.log.html

## 18. Current Glassbox mapping

Current code already has a useful seed for this design.

The existing Raw Trace store writes append-only JSONL under `.glassbox/sessions/<sessionId>/trace.jsonl` and never overwrites existing lines.

The current Web Workbench already derives a Trace summary with event counts, duration, and token usage and displays Trace details in the Inspector.

Those behaviors should evolve into the storage and observability model above rather than being replaced by an unrelated observability stack.

The mapping is:

```text
existing local RawTraceStore
        ↓
retain append-only contract
        ↓
remote R2 evidence object + Turso Trace index

existing traceSummary / Inspector
        ↓
retain visible evidence model
        ↓
Owner observability surfaces + publishable Trace projection
```

## 19. Non-negotiable invariants

Keep these true even if individual storage technologies change.

```text
Owner is the only administrator.
Public Web visitors can only read published Trace or Eval projections.
Public readers never query private source rows directly.
All browser data access goes through Glassbox server APIs.
Authorization happens before protected content reaches model-visible Context.
Embeddings inherit source permissions.
Semantic cache is permission-scoped.
Raw Trace is append-only evidence.
Derived State can change without rewriting Raw Trace.
Large payloads live outside the structured database.
Every product-relevant durable object is inspectable in the Owner Web UI.
Every important metric has a defined source, value, unit, and time range.
Unknown measurements are shown as unknown, not guessed.
Trace and Eval publication is an explicit Owner action.
Publication redaction happens server-side.
Revoking public access does not rewrite private evidence.
Measurements and judgments remain distinct.
Canvas remains a projection, not storage authority.
Channel identity never implies management access.
```
