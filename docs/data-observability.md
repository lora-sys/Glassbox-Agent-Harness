# Glassbox Data and Service Map

Status: CURRENT ARCHITECTURE DECISION

This document records which Glassbox responsibility uses which service and where product truth lives. Detailed schema, UI layout, retention, and metric definitions remain implementation concerns.

## Access boundary

```text
Owner
  full management access

Authorized Channel Principal
  only the resources and Actions allowed by Glassbox policy

Public visitor
  read-only access to explicitly published Trace or Eval
```

QQ, email, Moshi, Herdr clients, and other external entry points do not receive management authority merely because they can reach a process or UI.

## Service map

| Glassbox responsibility | Service / authority |
| --- | --- |
| Personal Agent Runtime | Glassbox server + Pi SDK |
| Pi customization | Lora PI Kit |
| QQ Bot and Channel handling | Glassbox server + NapCat / OneBot transport |
| Agent Operations control plane | Glassbox server |
| Live coding-worker workspaces / worktrees / panes / Agent lifecycle | Herdr |
| Task, TaskAttempt, AttentionItem, WorkerBinding truth | Glassbox server + Turso |
| Herdr state reconciliation | Glassbox server through `HerdrBridge` |
| Bounded Herdr stage recipe | optional `herdr-workflows`; never canonical Task truth |
| Scheduler and later durable task execution | Glassbox server; later LongTask boundary when selected |
| Browser execution | Glassbox server |
| Owner management Web UI | Glassbox server |
| Public Trace and Eval Web pages | Glassbox server |
| Owner Web authentication | Better Auth |
| Structured durable state | Turso |
| User, Principal, ChannelIdentity, Conversation | Turso |
| Authorization and permission state | Turso |
| QQ user and group metadata | Turso |
| Session and Run metadata | Turso |
| AttentionItem, Task, TaskAttempt, WorkerBinding | Turso |
| Herdr observed-state projection and reconciliation metadata | Turso when durability is required; live source remains Herdr |
| Future LongTask and durable Worker state | Turso or deliberately selected durable orchestration boundary |
| Memory metadata and durable memory | Turso |
| Full-text search | Turso FTS |
| Vector embeddings and vector search | Turso Vector |
| Retrieval metadata and statistics | Turso |
| Trace index and Trace statistics | Turso |
| Eval definitions, results and statistics | Turso |
| Prompt, model, provider and execution metadata | Turso |
| Skill, Journal and Asset metadata | Turso |
| Token, cost, latency and usage statistics | Turso |
| Task throughput, blocked time, review / rework and worker statistics | Turso-derived product projections |
| Web UI analytics and aggregated product statistics | Turso, queried through Glassbox server APIs |
| Public Trace and Eval publication metadata | Turso |
| Raw append-only Trace | Cloudflare R2 |
| Large model, Tool, or worker outputs when retained as evidence/artifacts | Cloudflare R2 |
| Screenshots, HAR, HTML and browser evidence | Cloudflare R2 |
| QQ and email attachments | Cloudflare R2 |
| PDFs, images, audio, archives and generated artifacts | Cloudflare R2 |
| Eval datasets and large Eval logs | Cloudflare R2 |
| Replay bundles and backups | Cloudflare R2 |
| Email inbox, sending, receiving and threads | AgentMail |
| Email events | AgentMail |
| DNS, TLS and public ingress | Cloudflare |
| Private connection from Cloudflare to Glassbox server | Cloudflare Tunnel |
| Owner admin perimeter access | Cloudflare Access |
| Infrastructure uptime, logs and error monitoring | Better Stack |
| Secrets and service credentials | Infisical |
| Webhook delivery, retry and replay | Hookdeck |
| Delayed jobs and reliable HTTP task delivery | Upstash QStash when a later active plan needs it |
| Human remote access to server / Herdr | SSH; Moshi may be an optional client |

## Product truth vs live execution state

This distinction is required for the Herdr integration.

```text
Glassbox / Turso
  Task truth
  TaskAttempt history
  Attention Queue
  WorkerBinding
  authorization
  review / rework / acceptance
  Conversation and Run linkage

Herdr
  live session
  workspace
  worktree
  pane
  terminal process
  recognized Agent
  working / blocked / done / idle / unknown
  live output
```

Herdr lifecycle data is an execution observation.

```text
Herdr agent = done
≠
Glassbox Task = DONE
```

A `done` worker normally produces a review state. An authorized Glassbox Action records acceptance or rework.

If Herdr becomes temporarily unreachable, Glassbox records the observation as stale / unknown and reconciles after reconnect. A connection gap does not silently change Task truth.

## Agent Operations synchronization

Glassbox maintains a long-lived Herdr connection through `HerdrBridge`.

The bootstrap and reconnect rule is:

```text
connect event stream
→ events.subscribe
→ receive subscription acknowledgement
→ session.snapshot
→ reconcile snapshot against durable WorkerBinding / TaskAttempt state
→ consume later events
```

The main Agent receives a compact `AgentOpsSnapshot` instead of all raw Herdr events.

Useful product projections include:

```text
messages awaiting response
open Tasks
queued Tasks
running Tasks
waiting Tasks
Tasks awaiting review
blocked workers
approvals requiring action
failed work
workers working / idle / unknown
done today
```

Raw Herdr event volume is not itself a user-facing metric. Normalize and deduplicate lifecycle transitions before exposing product status.

## Storage split

```text
Turso
  structured product state
  Task / Attention / WorkerBinding truth
  searchable metadata
  FTS
  vector search
  statistics and product projections

R2
  large objects
  raw evidence
  large worker / Tool results
  attachments
  artifacts
  backups

Herdr
  live coding-worker execution state
  workspaces / worktrees / panes
  not canonical Task truth

AgentMail
  email transport and mailbox

Glassbox server
  main Agent execution
  authorization
  Task / Agent Ops control
  Herdr reconciliation
  APIs
  management UI
  public Trace and Eval UI
```

## Supporting infrastructure

```text
Cloudflare Tunnel
  private server ingress

Cloudflare Access
  owner admin perimeter

Better Stack
  infrastructure observability

Infisical
  secrets

Hookdeck
  webhook reliability

QStash
  later delayed and reliable HTTP task delivery when an active plan requires it

SSH / Moshi
  optional human remote operations access
  never a product authority source
```

## Public observability

All product statistics that Glassbox needs to display are exposed through Glassbox server APIs and rendered by the Web UI or an authorized Channel projection.

External provider dashboards, Herdr UI, and Moshi are not the canonical Glassbox observability surface.

The Owner management view may eventually show:

```text
Channel activity
Conversation activity
Authorization decisions
Run / Tool / Delivery state
Token / cost / latency
Task and TaskAttempt state
Attention Queue
WorkerBinding and Herdr observed state
blocked duration
review / rework history
reconciliation / connection health
```

The main Agent consumes a narrower authorized operational projection through `AgentOpsSnapshot` and Ops Tools.

Public visitors only receive read-only Trace or Eval views selected for publication by the Owner. Worker output, private Tasks, Herdr pane data, and private operational metadata are not public by default.

## Server deployment rule

Local testing and the production Linux server use the same product contracts.

Target production host:

```text
Linux server
  Glassbox server
  Pi SDK + Lora PI Kit
  NapCat
  Herdr session server
  coding Agents / worktrees
  Turso-compatible durable state
```

Do not encode local GUI state, Moshi state, developer terminal window identifiers, or machine-specific absolute paths as durable domain truth.

## Not selected as core dependencies

The current architecture does not require:

```text
Supabase
Qdrant
Redis
Langfuse
ClickHouse
Elasticsearch
Meilisearch
```

Turso covers the current structured, full-text, vector, and statistics requirements. R2 covers large and raw data. Herdr covers live coding-worker execution and observation, not durable product state. Additional infrastructure should only be introduced when a concrete active-plan requirement cannot be handled by this map.