# Glassbox Data and Service Map

Status: CURRENT ARCHITECTURE DECISION

This document only records which Glassbox responsibility uses which service. Schema, UI layout, metrics definitions, retention rules, and implementation details are decided separately.

## Access boundary

```text
Owner
  full management access

Public visitor
  read-only access to explicitly published Trace or Eval
```

QQ, email, and other Channel identities do not receive management access.

## Service map

| Glassbox responsibility | Service |
| --- | --- |
| Agent Runtime | Glassbox server |
| QQ Bot and Channel handling | Glassbox server |
| Workers and background execution | Glassbox server |
| Scheduler and task execution | Glassbox server |
| Browser execution | Glassbox server |
| Owner management Web UI | Glassbox server |
| Public Trace and Eval Web pages | Glassbox server |
| Owner Web authentication | Better Auth |
| Structured durable state | Turso |
| User, Principal, ChannelIdentity, Conversation | Turso |
| Authorization and permission state | Turso |
| QQ user and group metadata | Turso |
| Session, Run, LongTask and Worker state | Turso |
| Memory metadata and durable memory | Turso |
| Full-text search | Turso FTS |
| Vector embeddings and vector search | Turso Vector |
| Retrieval metadata and statistics | Turso |
| Trace index and Trace statistics | Turso |
| Eval definitions, results and statistics | Turso |
| Prompt, model, provider and execution metadata | Turso |
| Skill, Journal and Asset metadata | Turso |
| Token, cost, latency and usage statistics | Turso |
| Web UI analytics and aggregated product statistics | Turso, queried through Glassbox server APIs |
| Public Trace and Eval publication metadata | Turso |
| Raw append-only Trace | Cloudflare R2 |
| Large model or Tool outputs | Cloudflare R2 |
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
| Delayed jobs and reliable HTTP task delivery | Upstash QStash |

## Storage split

```text
Turso
  structured state
  searchable metadata
  FTS
  vector search
  statistics

R2
  large objects
  raw evidence
  attachments
  artifacts
  backups

AgentMail
  email transport and mailbox

Glassbox server
  execution
  authorization
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
  delayed and reliable HTTP task delivery
```

## Public observability

All product statistics that Glassbox needs to display are exposed through Glassbox server APIs and rendered by the Web UI.

External provider dashboards are not the product observability surface.

Public visitors only receive read-only Trace or Eval views selected for publication by the Owner.

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

Turso covers the current structured, full-text, vector, and statistics requirements. R2 covers large and raw data. Additional infrastructure should only be introduced when a concrete requirement cannot be handled by this map.
