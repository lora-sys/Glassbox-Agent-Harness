# Plan 04B — Authorized Retrieval and QQ History Search

Status: ACTIVE PARALLEL P4 STREAM

This plan is one of two intentionally parallel P4 implementation streams.

The sibling plan is:

\`\`\`text
.plans/04a-memory-taste.md
\`\`\`

One Issue owns this plan and one later PR must stay inside this plan's boundary.

## Goal

Build the durable read side of Glassbox history and learning.

P4B decides what the current Principal may search, searches only inside that authorized source set, returns compact cited results, and injects only task-relevant authorized material into Runtime Context.

It also adds the first real QQ history-search tools:

\`\`\`text
current group history search
Owner-private authorized cross-group history search
\`\`\`

Acceptance sentence:

> The Agent can search the current QQ group's history, and an Owner in private chat can search only the groups currently granted to that Owner. Unauthorized groups never enter the candidate set, results preserve source and timestamp, Memory and Taste can be retrieved through the same authorization-first boundary, and cross-group content cannot be delivered into a group merely because the requesting Owner can read it.

## Ownership

P4B owns:

\`\`\`text
authorized source-set resolution
QQ group-history retrieval
current-group search Tool
Owner-private cross-group search Tool
channel-message archive / index when needed
lexical retrieval
Memory retrieval
Taste retrieval
ranking
Top K projection
retrieval reason / source metadata
Runtime Context projection
retrieval Trace / Eval
\`\`\`

P4B does not own:

\`\`\`text
FeedbackEvent creation
Taste confidence updates
Taste promotion / demotion
Memory promotion
Memory mutation
learning truth
\`\`\`

## Security invariant

Always:

\`\`\`text
resolve Principal
→ resolve allowed Resource set
→ query only inside that set
→ rank
→ apply result limit
→ assemble model-visible Context
\`\`\`

Forbidden:

\`\`\`text
search all groups / memories
→ send candidates to model
→ ask model to ignore unauthorized rows
\`\`\`

Read authorization and Delivery authorization remain separate.

## What can be reused now

Current Glassbox already has:

\`\`\`text
Principal and dual-Owner identity
Resource / Grant / AuthorizationDecision
Conversation scope
conversation_locations
messages
runs
Delivery Gate
protected Tool wrapper
Owner-private Tool discovery pattern
OneBot combined WebSocket adapter
generic internal OneBot RPC request path
Turso / SQLite-compatible DomainDatabase
\`\`\`

Relevant code:

\`\`\`text
apps/server/src/auth/service.ts
apps/server/src/conversation/store.ts
apps/server/src/persistence/schema.ts
apps/server/src/channels/onebot/adapter.ts
apps/server/src/runtime/pi/protected-tools.ts
apps/server/src/runtime/pi/owner-tools.ts
\`\`\`

Important current limitation:

\`\`\`text
messages
  = messages accepted into Glassbox Runs

messages
  ≠ complete QQ group history
\`\`\`

P3 intentionally does not create Runs for every ordinary non-activated group message. Do not reinterpret the current \`messages\` table as a complete channel archive.

## Confirmed external capability

NapCat currently exposes:

\`\`\`text
get_group_msg_history
\`\`\`

and marks the go-cqhttp-compatible group-history API as available.

Official references:

\`\`\`text
https://napneko.github.io/onebot/api
https://napneko.github.io/develop/api
https://napcat.apifox.cn/
\`\`\`

The OneBot message model includes message ID, group ID, sender and event time. That is enough to normalize history results into Glassbox source records.

Reuse the existing authenticated OneBot connection. Do not add a second QQ SDK merely for history.

## Source model

P4B searches several source kinds behind one authorization-first interface:

\`\`\`text
group_message
semantic_memory
episodic_memory
taste
\`\`\`

Conceptual result shape:

\`\`\`text
sourceKind
sourceId
resourceId
text or snippet
occurredAt
sender?
groupId?
scope?
confidence?
reason
\`\`\`

Every result must remain attributable to its real source.

## QQ history design

### Current-group search

Expose a protected Tool conceptually named:

\`\`\`text
group_history_search
\`\`\`

The model may provide:

\`\`\`text
query
after?
before?
limit?
\`\`\`

The model must not choose an arbitrary group ID.

Glassbox derives the target group from the current trusted Run scope and authorizes history read before any protected history is loaded.

### Owner cross-group search

Expose a separate Owner-private Tool conceptually named:

\`\`\`text
owner_history_search
\`\`\`

The model may provide:

\`\`\`text
query
group filters?
after?
before?
limit?
\`\`\`

Any requested group filter must be intersected with the Owner's current authorized group set.

Define "Owner's groups" as:

\`\`\`text
groups for which this Principal currently has history:read
\`\`\`

Do not define it as:

\`\`\`text
all groups the Bot joined
all enabled groups
all groups assigned to another Owner
\`\`\`

With two Owners, their searchable group sets may overlap without becoming identical.

### New Action

Introduce an explicit protected read Action:

\`\`\`text
history:read
\`\`\`

Do not assume ordinary \`conversation:read\` automatically grants bulk history scanning.

## Live history and durable archive

P4B should land in two steps.

### Step 1 — real NapCat history path

Use \`get_group_msg_history\` through the existing OneBot adapter to prove real group-history access and normalization.

This provides immediate product value and real-protocol acceptance.

### Step 2 — Glassbox channel archive

Add a separate durable table, conceptually:

\`\`\`text
channel_messages
\`\`\`

Do not reuse \`messages\`.

The new table represents Channel facts, including messages that never created an Agent Run.

Minimum direction:

\`\`\`text
id
channel
connectionId
groupId
externalMessageId
senderId
text / normalized searchable text
occurredAt
ingestedAt
resourceId or group resource linkage
dedupe key
\`\`\`

Archive only configured / authorized group sources needed by the product. Do not silently turn every reachable QQ group into a permanent Glassbox archive.

## Search engine direction

Start with lexical retrieval.

SQLite FTS5 is a proven full-text-search mechanism with BM25 and snippet support:

\`\`\`text
https://www.sqlite.org/fts5.html
\`\`\`

Do not assume production support without a capability test against the exact Glassbox database path.

The first implementation slice must prove one of:

\`\`\`text
FTS5 works in the current Turso / SQLite-compatible environment
\`\`\`

or:

\`\`\`text
use a bounded deterministic lexical fallback
\`\`\`

Do not make Turso's newer native FTS or any external vector database a P4B dependency.

Vector / hybrid retrieval may be added only if lexical retrieval fails an explicit eval.

## Taste and Memory retrieval

P4A owns the records.

P4B consumes only the stable retrieval-facing projection.

Normal path:

\`\`\`text
current task
→ authorized Principal / project / group source set
→ lexical candidates
→ relevance + confidence + recency where applicable
→ small Top K
→ Runtime Context
\`\`\`

Do not inject the entire Taste or Memory store every turn.

Taste retrieval must preserve global / project scope.

Memory retrieval must preserve source visibility and provenance.

## Context and delivery

P4B is not a generic P5 Context Budget Governor.

P4B only needs bounded retrieval controls such as:

\`\`\`text
result count
time range
snippet length
per-source cap
Top K
detail-on-demand
\`\`\`

Cross-group search should normally be callable only from Owner private Runs.

If future policy allows a cross-group read from another audience, Delivery Gate must still separately authorize what can be sent to that audience.

## Implementation route

### P4B.0 — Contracts and authorization

Define:

\`\`\`text
history:read
retrieval source record
retrieval result
source-set resolver
result provenance
\`\`\`

Add deterministic dual-Owner fixtures with overlapping group grants.

### P4B.1 — OneBot group-history bridge

Extend the existing OneBot adapter with a narrow typed history method using the existing authenticated RPC path.

Normalize message ID, sender, group, text and timestamp.

Do not expose raw generic RPC to Pi.

### P4B.2 — Current-group Tool

Implement \`group_history_search\` or equivalent.

Prove the model cannot select another group.

### P4B.3 — Owner cross-group Tool

Implement \`owner_history_search\` or equivalent.

Visible only to authorized Owner-private Runs.

Resolve the allowed group set server-side before querying.

### P4B.4 — Channel archive and lexical index

Persist configured group history separately from Run input messages.

Add dedupe, restart safety and lexical search.

Prove FTS capability before depending on it.

### P4B.5 — Memory and Taste retrieval

Consume P4A retrieval-facing records.

Apply authorization before query and return only relevant Top K.

P4B must be able to develop against deterministic fixtures before P4A merges.

### P4B.6 — Runtime projection and evidence

Inject only selected authorized snippets / records.

Record:

\`\`\`text
source kind
source ID
resource ID
retrieval reason
rank / score when meaningful
Run linkage
authorization decision linkage
\`\`\`

Avoid copying unnecessary protected payload into denial evidence.

### P4B.7 — Eval and real acceptance

Measure at least:

\`\`\`text
retrieval precision
scope leakage rate
unauthorized candidate count
current-group hit quality
cross-group hit quality
Taste retrieval precision
Memory retrieval precision
\`\`\`

## Tests

Deterministic tests must cover at least:

\`\`\`text
current group can search itself
current-group Tool cannot select another group
Owner A searches only Owner A authorized groups
Owner B searches only Owner B authorized groups
shared group can appear for both when both are granted
revocation affects the next search
Bot membership does not imply history permission
unauthorized group content never enters model-visible Context
search result carries source and time
channel_messages does not create fake Runs
dedupe survives restart
Memory / Taste source scope is preserved
cross-group result cannot bypass Delivery Gate
Owner-private Tool is undiscoverable to Visitor / group Runs
\`\`\`

Real acceptance must prove:

\`\`\`text
NapCat real get_group_msg_history path works
current test group returns real historical messages
Owner-private query can find a term across at least two authorized test groups
a deliberately unauthorized test group contributes zero candidates
revoking one group removes it from the next cross-group query
result delivery stays private for cross-group acceptance
\`\`\`

## Completion gate

P4B is complete only when:

- current-group history search works through a protected Tool;
- Owner-private cross-group search uses the current per-Owner authorized group set;
- \`history:read\` is explicit and default-deny;
- complete Channel history is not confused with Run input \`messages\`;
- a durable archive / index exists where required for useful repeated search;
- Memory and Taste retrieval consume P4A through a stable contract;
- authorization occurs before protected candidates are loaded;
- only bounded relevant results reach Runtime Context;
- every result preserves source and time metadata;
- Delivery Gate still controls the final audience;
- deterministic dual-Owner, revocation, restart and leakage tests pass;
- real NapCat history acceptance passes.

## Non-goals

Do not add in this Issue:

\`\`\`text
Memory promotion
Taste learning
Taste confidence mutation
generic model-controlled memory writes
vector database dependency
generic Context compression
P5 routing / token governor
new Channels
LongTask
frontend search UI
\`\`\`
