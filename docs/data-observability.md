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

This map includes planned service choices and group-assignment concepts. It does not assert that every external service is configured. Current structured storage is local libSQL/SQLite; the local Trace implementation uses append-only JSONL files, with R2 retained as an object-storage target.

| Responsibility | Service / authority |
| --- | --- |
| Personal Agent product control plane | Glassbox server |
| Main Agent engine | Pi through Glassbox Pi SDK adapter |
| Pi distribution / Skills snapshot / profiles / MCP adapter / runtime hooks | Lora PI Kit |
| Canonical reusable Lora Skill source | `lora-sys/skills` |
| QQ transport | Glassbox server + NapCat / OneBot |
| Agent Operations control plane | Glassbox server |
| Live coding-worker workspaces / worktrees / panes / Agent lifecycle | Herdr |
| Task / TaskAttempt / AttentionItem / WorkerBinding truth | Glassbox server + local libSQL/SQLite |
| Herdr reconciliation | Glassbox server through `HerdrBridge` |
| Optional bounded Herdr stage recipe | `herdr-workflows`; never canonical Task truth |
| Structured durable product state | Local libSQL/SQLite, Turso-compatible |
| Raw append-only Trace / large evidence | Local JSONL Trace; Cloudflare R2 is an object-storage target |
| Owner Web authentication | Better Auth |
| Email transport later | AgentMail |
| Secrets | Infisical |
| Public ingress / private tunnel / access perimeter | Cloudflare |
| Infrastructure uptime / error monitoring | Better Stack |
| Webhook reliability when used | Hookdeck |
| Delayed HTTP task delivery when later required | Upstash QStash |
| Group schedule truth, planned | Glassbox server + local libSQL/SQLite |
| Group assignment / progress / reminder / report truth, planned | Glassbox server + local libSQL/SQLite |
| General group Tool registry and bindings, planned | Glassbox server + local libSQL/SQLite metadata; executable implementation stays in reviewed runtime code / Kit resources |
| Human remote operations access | SSH; Moshi may be an optional client |

## Local libSQL/SQLite product state

Glassbox uses `@libsql/client` with a local `file:` SQLite database. `localDatabaseUrl` in `apps/server/src/persistence/database.ts` accepts a local path or `:memory:` and rejects remote URLs and network paths. This is Turso-compatible storage, not a configured remote Turso service. The current schema version is 29 in `apps/server/src/persistence/schema.ts`.

The list below combines implemented records with planned product concepts. `MemoryCandidate`, `CanonicalMemory` and `FeedbackEvent` are implemented in `apps/server/src/learning/` and the shared Memory contracts. `TasteEntry`, `OwnerInsight`, and the group assignment/registry records are conceptual; they do not name existing tables. See `docs/memory-taste.md` and `docs/owner-group-operations.md` for that distinction.

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

GroupCapabilityPolicy, implemented
ToolDefinition metadata, planned
ToolVersion metadata
GroupToolBinding
ScheduleDefinition
ScheduleOccurrence
GroupAssignment
AssignmentParticipant
CompletionEvidence
ReminderPolicy
ReminderEvent
ReportSnapshot

AttentionItem
Task
TaskAttempt
WorkerBinding
Herdr reconciliation metadata

FeedbackEvent
MemoryCandidate
CanonicalMemory, including preference records for Taste
Memory confidence / scope / provenance
OwnerInsight metadata, planned
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

The browser does not receive direct database credentials or database access.

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

Do not store the entire Kit package payload in the local database merely for provenance.

## Product truth vs Pi / Lora PI Kit state

```text
Glassbox / local libSQL/SQLite
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

Configured private QQ image messages keep validated image bytes on their Conversation message
attachment rows in the durable database. Run input reads those bytes only after the same
Conversation authorization used for the message. Raw Trace and plain-text Conversation history
store no image bytes, provider URL, or OneBot file token. A model receives an image only when its
selected profile explicitly declares `supportsVision`.

The same Kit can be used by several roles without making those roles the same Agent identity.

## Product truth vs Herdr live execution

```text
Glassbox / local libSQL/SQLite
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
Glassbox / local libSQL/SQLite
  FeedbackEvent
  MemoryCandidate
  CanonicalMemory with type = preference for Taste
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

Large before/after feedback artifacts may live in R2 while the local database stores structured FeedbackEvent metadata and references.

## Group operations state

The current `group_capability_policies` table stores versioned `GroupCapabilityPolicy` records. `owner_group_admin` controls access, Skills, capability categories, history and Memory-source switches. These switches narrow the runtime Tool set and source reads; they do not replace authorization.

The group scheduling, assignment and report model below remains planned. It follows the same durable-state rule as implemented product behavior. Durable Task/Activity continuations already exist, but they do not implement this group-assignment domain.

```text
Local libSQL/SQLite
  schedule definition
  occurrence identity
  assignment state
  participant progress
  reminder history
  report inputs
  Tool binding state

scheduler transport
  wakes Glassbox and asks it to process due work
```

For the first single-group pilot, an in-process scheduler is acceptable if schedule and occurrence identities are durable and idempotent.

A later QStash or similar timer transport may replace the wake-up mechanism without becoming schedule truth.

Tool executable code should not be stored as arbitrary chat-generated blobs and loaded directly into production. The local database may store Tool metadata, version references, configuration, permission manifests, and group bindings. Reviewed code or Kit resources own executable implementation.

See `docs/owner-group-operations.md`.

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
Local libSQL/SQLite
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

The P6 long-work health projection rechecks `task:read` for each candidate Task before aggregating Task, Step, lease, wait, and TaskEvent evidence. Duration estimates include sample counts. Each history source has a 10,000-row projection cap; if exceeded, dependent estimates and counts are `null` and the snapshot marks that source truncated. Persisted workflow binding status remains separate from the authorized Ops health response's fresh, two-second Temporal Server probe. The probe result includes its sample time, is cached for at most five seconds, and does not establish whether a workflow Worker is polling.

A declared Worker text file is captured before Step review under the live Attempt, WorkerBinding, and lease. The immutable record stores the validated relative path, at most 256 KiB of UTF-8 text, and its SHA-256 digest. `task_worker_result` returns at most 16 KiB of that file after current Task, Worker, file, workspace, and protected origin authorization checks. The full record stays private in Glassbox storage; the text is not copied into TaskEvent metadata or delivered automatically.

Public visitors only receive sanitized, explicitly published Trace or Eval projections.

Private Tasks, Taste, Memory, feedback payloads, Worker output, Herdr pane data, runtime credentials, and private operational metadata are not public by default.

The local authenticated management controller exposes `/manage/runs/{runId}/tool-plane` as a
bounded projection of that one Owner Run's Raw Trace. It returns surface Tool names, providers,
readiness values and observed call outcomes. It never returns Tool inputs or results, and it is
not a global live-provider inventory. The projection reads at most 200 Trace records. If the
Trace is absent or the read is capped before its indexed end, `trace.complete` is false and
unobserved execution state remains unknown.

QQ result delivery applies a content gate before it creates a Delivery. The gate checks the raw model candidate, renders QQ plain text, and checks the rendered text again. A blocked candidate creates no Delivery and is excluded from later model Context.

An allowed authorization decision becomes a delivery source only after its protected read actually returns. The decision stores the source class. Before initial delivery and every retry, Glassbox rechecks the original read Action against current authority. A content source also requires a separate `delivery:send` decision for that Resource. Protected search gates are rechecked as Actions; concrete search results retain their own content-source decisions. The same source checks apply before an earlier answer enters a later Run's Context. Older decisions retain conservative legacy source classes after database migration.

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
  local libSQL/SQLite durable state, Turso-compatible
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

Local libSQL/SQLite covers current structured / search / statistics needs. R2 is the object-storage target for large / raw data. Herdr covers live coding-worker execution. Lora PI Kit covers reproducible Pi distribution. Additional infrastructure should be introduced only for a concrete active-Plan requirement.

## Source-policy conditions on authorization decisions

Schema v26 stores a validated `policy_condition_json` beside each live and archived
AuthorizationDecision. New ordinary decisions write an explicit versioned `none` condition.
A QQ capability read records its connection, group, and registry category. A QQ Memory-source
read records its connection, group, and source class. Those routes remain separate even when
they share an Action. The current flag must be exactly `true`, and the current grant must still
allow the Action. Both checks run in the same authorization transaction before approval
consumption.

Only trusted Tool and retrieval code produces conditions. Condition fields are absent from
model-facing Tool schemas. Conditions narrow grants; they never create authority. Replayed
content keeps the original source's policy location, rather than adopting the later reader's
connection or a different source route. Delivery still requires its separate `delivery:send`
grant. All source conditions are conjunctive, including different source classes on the same
Resource and Action.

Conversation-history admission, internal Step dependencies, child Task results, and Worker
results preserve these dependencies through archive-inclusive reads. Task descriptions and
content-bearing Task projections recheck their origin Run and bounded parent chain. Missing,
cyclic, overlong, or malformed lineage fails closed. A later read records new authorization
evidence without rewriting the original decisions or Raw Trace.

The v26 upgrade leaves historical condition fields NULL. NULL means unknown provenance,
which differs from explicit `none`. Ambiguous legacy QQ source content is withheld from
replay and pending delivery because its category versus Memory-source route cannot be
reconstructed from its Resource and Action. New authorized reads can still proceed. Legacy
non-QQ reads retain grant-based behavior. The migration preserves source markers, archive
rows, and historical payloads; it does not invent provenance or erase evidence.

Read producers also reauthorize exact successful read receipts after awaited provider work and
before returning protected bodies. Multi-group history, QQ source imports, and Worker reads
check every consumed condition atomically. Original execution evidence remains intact; a
withheld read is not represented as a rolled-back provider operation. Mutating provider calls
retain truthful execution outcomes. The documented workspace-write and owner-model-switch
result markers remain valid inherited content receipts; ordinary unmarked writes and other
marked write Actions are not accepted as read receipts. A nickname-selected mutation uses
one final transaction for its exact roster receipt and mutation authority after all external
checks, so neither policy can change between two separate authorization snapshots.

### Derived Memory dependencies

Schema v27 adds a server-owned `source_dependencies_json` column to candidates and canonical
Memory. It is not exposed in model-editable content or Tool input. Versioned empty dependency
sets mean a proven source-free origin; NULL means historical origin must be reconstructed.
Decision references resolve across live and archived evidence. Missing, malformed, cyclic, or
unbounded dependencies fail closed without deleting the stored content or Raw Trace.

Model-created candidates inherit the consuming Run's recorded source dependencies even when
model-authored evidence omits them or claims a human origin. Consolidation includes dependencies
of every Memory supplied to the extractor, regardless of its claimed update target. Raw QQ
imports use a separately verified archive row and exact successful source receipt, so an
unrelated history read cannot turn a notice import into a history-derived inference. Fresh
explicit user writes and server-derived literal current-user-message capture can remain
source-free. Pending deduplication, merge, replacement, supersession, and subsequent explicit
edits preserve the union of existing dependencies. Owner promotion confirms an assertion; it
does not declassify its source.

Candidate inspection and promotion, Memory get/list/group reads, and automatic Runtime learning
Context evaluate current grants and policy before exposing content. Lists omit refused items
before satisfying their requested limit. Successful reads propagate exact dependencies to the
consuming Run, so later history reuse, Tasks, Workers, and delivery create/claim/retry remain
constrained. Runtime rechecks its selected Memory and current Run sources after asynchronous
context preparation and before every explicit or SDK-internal provider continuation. The SDK's
public stream boundary and final payload callback enforce this check directly, because extension
hook errors are swallowed by the SDK. A revoked source cannot be rescued by an earlier read.
The current Run retains an Owner collection access gate when it reads only public group records;
only that exact explicit-none access gate is omitted from durable content derivation. Private or
mixed reads remain content sources, and all underlying QQ dependencies remain conjunctive.

For legacy rows, reconstruction uses server-written operation-specific ancestry and valid
source decisions. Generic candidate audit lineage and confirmation flags are model-editable
and cannot prove source-free origin. Explicit write/supersede ancestry is corroborated with
persisted candidate-to-Memory links; literal capture must match the complete stored user
message-derived body and evidence, and prior creation/deduplication origins are still retained.
Legacy Runs with missing markers for protected reads, native workspace results, or model-switch
results are incomplete and remain unknown. A matching valid producer marker can cover a
same-context duplicate preflight; unmarked Memory reads still lack their consumed record set.
Only the exact same-scope personal-Agent conversation admission check is exempted as a known
non-producing gate. Neighboring resources, Actions, and scopes are not exempted.

Ambiguous records remain stored but inaccessible through content-bearing learning APIs, with
the fixed `memory_source_provenance_unavailable` reason. Restoring a revoked policy makes known
lineage readable again. Unknown lineage needs evidence repair or a new independently authored
record; there is no automatic reset/declassification recovery command. Otherwise-authorized
Owners can still expire, revoke, retire, or reject withheld records using metadata-only paths.
Those operations return a minimal typed action receipt without the body or provenance IDs.
When both collection-read and source authorization allow the body, the existing full result is
retained. Promote, update, and supersede still require content/source authorization.

QQ source import and history search also constrain archive queries by the trusted connection
ID before loading payloads or applying limits. An enabled connection cannot authorize rows
archived for another connection with the same group ID. The current archive does not retain
Bot ID, `self_id`, raw provider events, or a configuration revision. Caller/grant checks still
use Bot identity, but cannot establish which Bot collected old archive rows after the same
connection is reconfigured. Historical Bot attribution remains an explicit contract and
migration follow-up; this slice does not claim Bot-isolated archive provenance.


## Exact Channel history time windows

Schema v28 adds an indexed integer `occurred_at_ms` projection to `channel_messages`.
The migration backfills at most 500 rows per read using the timestamp formats already
accepted by `Date.parse`. It retains each original `occurred_at` string and message body;
Raw Trace is unchanged. Unparseable legacy timestamps remain stored with a NULL time
projection. Time-bounded reads exclude them; untimed reads retain their original evidence.

New ingestion and deduplicated enrichment validate timestamps and store canonical UTC
text plus exact integer milliseconds. History Tools and source reads compare inclusive
millisecond bounds before SQL LIMIT, keeping the existing authorized group, source-class
and trusted connection filters. The retriever's secondary filter compares instants before
duplicate suppression. Equivalent UTC and offset inputs select the same records; invalid
bounds, reversed windows and invalid limits return fixed input-error codes. Time precision
is the existing JavaScript Date millisecond precision, with no Julian-day floating-point
arithmetic.


## Channel default routing provenance

Schema v29 adds nullable `runs.channel_default_execution_ref`. Trusted ingress can record the Channel default execution reference separately from the Run's selected `execution_ref` when applying an Owner model preference. Runtime routing uses this provenance to distinguish a saved preference from an explicit one-Run selection before considering recovery to the Channel default.

Historical and explicit Runs remain unmarked. The migration does not infer old routing provenance or rewrite Run results. See `apps/server/src/persistence/schema.ts`, `apps/server/src/conversation/store.ts`, and the ingress/routing paths in `apps/server/src/management/application.ts`.
