# Glassbox Data and Service Map

Status: CURRENT ARCHITECTURE DECISION

This document records where durable product truth lives and which service owns each responsibility.

Detailed schema, UI layout, retention, and metric definitions remain implementation concerns.

## Access boundary

```text
Owner
  full management access

Authorized Channel Principal
  only Resources and Actions allowed by Glassbox policy

Public visitor
  read-only access to explicitly published Trace or Eval
```

QQ, email, Pi, Lora PI Kit, MCP, Herdr, Moshi, and other external entry points do not receive management authority merely because they can reach a process or UI.

QQ-native group roles are provider observations scoped to one message sender and one group
Resource. `qq_group_admin` and `qq_group_owner` are not Principal kinds and are not stored as
durable Glassbox role truth. The Run keeps its ingress observation for reconstruction. A
protected mutation re-verifies the role through the current authenticated OneBot connection, so
a restart or old Run record cannot preserve revoked QQ authority.

The local Owner may inspect `trace group-role-audit <channel-id> <group-id>` for one currently
managed group. The endpoint reports the newest Owner Run and newest Visitor Run separately. It requires the current
Owner `group:manage` grant and an exact match to
the configured Channel connection, bot, and group. It returns only normalized role observations,
principal kind, role-verification status, allowlisted role Tool selection and outcome metadata, and bounded Trace
completeness. It never returns message text, Tool arguments or results, provider error text,
member identifiers, or Conversation scope. The ordinary Run and Trace endpoints keep their
same-Principal `conversation:read` boundary; this audit view does not grant access to Visitor
Conversation content. Losing the group grant before the response is sent denies the audit result.

## Service / authority map

| Responsibility | Service / authority |
| --- | --- |
| Personal Agent product control plane | Glassbox server |
| Main Agent engine | Pi through Glassbox Pi SDK adapter |
| Pi distribution / Skills snapshot / profiles / MCP adapter / runtime hooks | Lora PI Kit |
| Canonical reusable Lora Skill source | `lora-sys/skills` |
| QQ transport | Glassbox server + NapCat / OneBot |
| Agent Operations control plane | Glassbox server |
| Live coding-worker workspaces / worktrees / panes / Agent lifecycle | Herdr |
| Task / TaskAttempt / AttentionItem / WorkerBinding truth | Glassbox server + Turso |
| Herdr reconciliation | Glassbox server through `HerdrBridge` |
| Optional bounded Herdr stage recipe | `herdr-workflows`; never canonical Task truth |
| Structured durable product state | Turso |
| Raw append-only Trace / large evidence | Cloudflare R2 where appropriate |
| Owner Web authentication | Better Auth |
| Email transport later | AgentMail |
| Secrets | Infisical |
| Public ingress / private tunnel / access perimeter | Cloudflare |
| Infrastructure uptime / error monitoring | Better Stack |
| Webhook reliability when used | Hookdeck |
| Delayed HTTP task delivery when later required | Upstash QStash |
| Human remote operations access | SSH; Moshi may be an optional client |

## Turso product state

Turso is the default structured durable store for Glassbox product truth.

Current / planned records include:

```text
Agent
User / Principal
ChannelIdentity
Conversation
relationships / permissions
AuthorizationDecision
Approval
Run metadata
Run-scoped external role observation and verification evidence
message dedupe
runtime session binding
visibility / Share metadata

AttentionItem
Task
TaskAttempt
WorkerBinding
Herdr reconciliation metadata

FeedbackEvent
TasteCandidate
TasteEntry
Taste confidence / scope / provenance
Memory metadata
Rules metadata when represented as product state
Skill registry metadata
Journal / Asset metadata

Eval definitions / results
retrieval metadata
statistics / product projections
```

The model does not receive unrestricted SQL access.

Raw QQ member profiles do not enter model-visible Context or durable role state. Native-role
Trace events contain only Principal, group Resource, sender id, normalized observed and verified
roles, role source, verification status, requested Tool and operation, Run, Conversation, and a
safe authorization status. Provider response bodies and error text are excluded.

The browser does not receive direct Turso credentials.

## Runtime distribution identity

Lora PI Kit is runtime distribution state, not product truth.

Glassbox should still record enough runtime identity on Runs / Trace to reproduce behavior.

Useful metadata includes:

```text
Pi version / commit
Lora PI Kit version / commit
active Kit profile
lora-sys/skills source commit
skills.lock identity
selected external package / integration versions when material
model / provider identity
```

This metadata may live in Run / runtime configuration records and Trace projections.

Do not store the entire Kit package payload in Turso merely for provenance.

## Product truth vs Pi / Lora PI Kit state

```text
Glassbox / Turso
  Agent identity
  Principal
  Authorization
  Conversation
  Task truth
  Taste / Memory truth
  Delivery policy
  product evidence

Pi
  runtime session / Agent execution

Lora PI Kit
  Package resources
  pinned Skill snapshot
  profile
  MCP registry / adapter
  runtime hooks
  templates / compatibility locks
```

Neither Pi Session nor Kit Profile replaces durable Glassbox product state.

The same Kit can be used by several roles without making those roles the same Agent identity.

## Product truth vs Herdr live execution

```text
Glassbox / Turso
  Task
  TaskAttempt history
  Attention Queue
  WorkerBinding
  authorization
  review / rework / acceptance
  Conversation / Run linkage

Herdr
  live session
  workspace
  worktree
  pane
  terminal process
  recognized coding Agent
  working / blocked / done / idle / unknown
  live output
```

Herdr lifecycle state is an execution observation.

```text
Herdr agent = done
≠
Glassbox Task = DONE
```

If Herdr becomes temporarily unreachable, Glassbox records the observation as stale / unknown and reconciles after reconnect.

A connection gap does not silently change Task truth.

## Learning truth vs runtime projection

Rules, Skills, Taste, and Memory have different authority.

```text
Glassbox / Turso
  FeedbackEvent
  TasteCandidate
  TasteEntry
  confidence
  scope
  promotion / demotion
  Semantic Memory
  Episodic Memory
  retrieval evidence
  visibility / authorization

lora-sys/skills
  canonical reusable Skill source

Lora PI Kit release
  pinned bundled Skill snapshot
  Taste / Feedback / Memory runtime bridges

Pi Context
  only the selected task-relevant authorized projection
```

Taste is preference, not permission.

A single edit is evidence, not a permanent preference.

Large before/after feedback artifacts may live in R2 while Turso stores structured FeedbackEvent metadata and references.

## Herdr synchronization

Glassbox maintains long-lived Herdr integration through `HerdrBridge`.

Bootstrap / reconnect:

```text
connect event stream
→ subscribe
→ receive acknowledgement
→ session.snapshot
→ reconcile against durable WorkerBinding / TaskAttempt state
→ consume later events
```

The main Agent receives a compact `AgentOpsSnapshot`, not all raw Herdr events.

Useful product projections include:

```text
messages awaiting response
open / queued / running / waiting Tasks
Tasks awaiting review
blocked workers
approvals
failures
workers working / idle / unknown
done today
```

Raw event volume is not itself a user-facing metric.

## Storage split

```text
Turso
  structured product truth
  searchable metadata
  FTS / Vector when later used
  retrieval records
  product statistics

R2
  Raw Trace
  large Tool / Worker output
  large feedback payloads
  screenshots / HAR / HTML
  attachments / artifacts / archives / backups

Lora PI Kit
  versioned Pi distribution package
  not canonical Glassbox product truth

Herdr
  live coding-worker execution state
  not canonical Task truth

AgentMail
  later email transport
```

## Product observability

Glassbox server APIs are the canonical product observability surface.

External provider dashboards, Pi TUI, Lora PI Kit package files, Herdr UI, and Moshi are not the authoritative Glassbox observability model.

Owner views may eventually show:

```text
Channel / Conversation activity
Authorization decisions
Run / Tool / Delivery state
Pi / Kit / profile / model identity
Token / cost / latency
Task / TaskAttempt state
Attention Queue
WorkerBinding / Herdr observed state
blocked duration
review / rework history
reconciliation health
Feedback events
Taste candidates / confidence / scope
Correction / Revert Rate
Taste retrieval reason
Memory candidates / retrieval evidence
```

The main Agent receives narrower authorized projections rather than raw databases.

Public visitors only receive sanitized, explicitly published Trace or Eval projections.

Private Tasks, Taste, Memory, feedback payloads, Worker output, Herdr pane data, runtime credentials, and private operational metadata are not public by default.

The local authenticated management controller exposes `/manage/runs/{runId}/tool-plane` as a
bounded projection of that one Owner Run's Raw Trace. It returns surface Tool names, providers,
readiness values and observed call outcomes. It never returns Tool inputs or results, and it is
not a global live-provider inventory. The projection reads at most 200 Trace records. If the
Trace is absent or the read is capped before its indexed end, `trace.complete` is false and
unobserved execution state remains unknown.

QQ result delivery applies a content gate before it creates a Delivery. The gate checks the raw model candidate, renders QQ plain text, and checks the rendered text again. A blocked candidate creates no Delivery and is excluded from later model Context.

The append-only delivery_blocked event stores reason codes, candidate byte count and a SHA-256 digest. It does not store the blocked candidate in that event. The original protected Run result remains subject to its existing database and authorization boundary.

## Server deployment rule

Local testing and the production Linux server use the same product contracts.

Target host:

```text
Linux server
  Glassbox server
  Pi SDK
  pinned Lora PI Kit
  NapCat
  Herdr
  coding Workers / worktrees
  Turso-compatible durable state
```

Do not encode desktop GUI state, Moshi state, developer terminal-window identity, or machine-specific absolute paths as durable domain truth.

## Supporting infrastructure

Potential supporting services remain implementation choices, not product authority:

```text
Cloudflare Tunnel
Cloudflare Access
Better Stack
Infisical
Hookdeck
QStash
SSH / Moshi
```

## Not selected as core dependencies

The current architecture does not require these as core product-state dependencies:

```text
Supabase
Qdrant
Redis
Langfuse
ClickHouse
Elasticsearch
Meilisearch
```

Turso covers current structured / search / statistics needs. R2 covers large / raw data. Herdr covers live coding-worker execution. Lora PI Kit covers reproducible Pi distribution. Additional infrastructure should be introduced only for a concrete active-Plan requirement.
