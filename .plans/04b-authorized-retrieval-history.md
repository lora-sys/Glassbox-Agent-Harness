# Plan 04B — Authorized Retrieval and QQ History Search

Status: ACTIVE PARALLEL P4 STREAM

Tracking Issue: #10

This plan is one of two intentionally parallel P4 implementation streams.

Sibling:

```text
.plans/04a-memory-taste.md
```

One Issue owns this plan and one later PR must stay inside this boundary.

## Goal

Build the read side of Glassbox history and learning by porting mature retrieval contracts and algorithms.

Acceptance sentence:

> The Agent can search the current QQ group's history, and an Owner in private chat can search only groups currently granted to that Owner. Unauthorized sources never enter the retrieval candidate set. Memory / Taste uses an MGP-compatible Recall / SearchResult contract, ranking uses an OpenSquilla-derived Retrieval Engine, source and timestamp remain inspectable, and Delivery authorization remains separate from read authorization.

## Upstream-first rule

Implementation order:

```text
MGP
  Recall / SearchResult contract

OpenSquilla
  Retrieval Engine

OpenHarness
  lexical fallback / relevance selection

NapCat / OneBot
  raw QQ history

Glassbox
  Principal / history:read / dual Owner scope / archive / Delivery
```

Do not invent a new generic ranking pipeline or SearchResult abstraction while these upstreams fit.

## Primary upstream source map

### MGP

Pinned:

```text
HKUDS/MGP
54ce6c00e3d0aa731ecbe17e74407cbbb5a96f10
```

Repository note:

```text
upstream/mgp/SOURCES.md
```

Port:

```text
schemas/recall-intent.schema.json
schemas/search-memory.request.schema.json
schemas/search-memory.response.schema.json
schemas/search-result-item.schema.json
schemas/retrieval-mode.schema.json
schemas/return-mode.schema.json
schemas/score-kind.schema.json
schemas/redaction-info.schema.json
schemas/policy-context.schema.json
spec/search-results.md
reference/gateway/semantics.py
compliance/search/test_search_results.py
compliance/access/test_access_control.py
```

Preserve:

```text
score
score_kind
backend_origin
retrieval_mode
return_mode
redaction_info
consumable_text
matched_terms
explanation
```

For non-Memory sources such as QQ group messages, use a thin Glassbox source wrapper with the same retrieval metadata. Do not pretend a ChannelMessage is canonical Memory.

### OpenSquilla

Use:

```text
upstream/opensquilla/SOURCES.md
```

Port Retrieval Engine behavior from:

```text
src/opensquilla/memory/retrieval.py
src/opensquilla/memory/store.py
src/opensquilla/memory/types.py

tests/test_memory_store_keyword_fallback.py
tests/test_memory_search_defaults.py
tests/test_memory_vector_normalization.py
tests/test_memory_retention.py
tests/live/test_search_retrieval_live.py
```

Preserve the pipeline:

```text
store.search
→ over-fetch candidates
→ optional temporal decay
→ source filtering
→ source weighting
→ optional MMR
→ final Top K
```

P4B first configuration:

```text
vector_weight = 0
text_weight = 1
```

This makes the first implementation lexical while keeping the mature hybrid-capable architecture.

Do not invent a lexical-only API that must later be replaced.

### OpenHarness search

Pinned:

```text
HKUDS/OpenHarness
9b2efd795c6aa09f88b0c257d269a9e518da6ae7
```

Use as fallback:

```text
src/openharness/memory/search.py
src/openharness/memory/relevance.py
src/openharness/memory/usage.py
```

Preserve ASCII and Han token handling, metadata/body matching, usage / recency signals, max results, duplicate suppression and freshness behavior.

If FTS5 is unavailable in the exact Turso path, port this fallback rather than inventing another one.

### NapCat / OneBot

Use the current authenticated OneBot connection.

```text
apps/server/src/channels/onebot/adapter.ts
```

Add a narrow typed call for:

```text
get_group_msg_history
```

Do not add a second QQ SDK and do not expose generic RPC to the model.

## Glassbox ownership

Glassbox owns:

```text
Principal
Resource
Grant
AuthorizationDecision
history:read
current trusted group scope
per-Owner authorized group set
Conversation / Run linkage
Audience / Delivery
Turso channel archive
Raw Trace
```

Current code to reuse:

```text
apps/server/src/auth/service.ts
apps/server/src/conversation/store.ts
apps/server/src/persistence/schema.ts
apps/server/src/channels/onebot/adapter.ts
apps/server/src/runtime/pi/protected-tools.ts
apps/server/src/runtime/pi/owner-tools.ts
```

## Security invariant

Always:

```text
resolve Principal
→ resolve authorized source set
→ load / search only inside that set
→ rank
→ bound results
→ Runtime Context
→ Delivery Gate
```

Forbidden:

```text
load all groups / Memory
→ rank
→ filter unauthorized results later
```

## Current persistence boundary

Keep:

```text
messages
  Agent Run inputs

channel_messages
  complete configured Channel history / retrieval source
```

Do not turn ordinary QQ history into fake Runs.

## history:read

Bulk history scanning gets an explicit protected Action:

```text
history:read
```

`conversation:read` does not imply this Action.

"Owner's groups" means:

```text
group Resources where the current Principal currently has history:read
```

Bot membership and another Owner's access do not grant it.

## QQ history tools

### Current group

Conceptual Tool:

```text
group_history_search
```

Model input:

```text
query?
sender?
mentionsMe?
since?
until?
limit?
```

No arbitrary group ID.

Glassbox derives the group from the trusted Run scope.

### Owner cross-group

Conceptual Tool:

```text
owner_history_search
```

Only discoverable in authorized Owner-private Runs.

Requested group filters are always intersected with the current Principal's `history:read` set before content is loaded.

## Channel archive

First prove the real NapCat history path.

Then add durable:

```text
channel_messages
```

Minimum source metadata:

```text
id
channel
connectionId
groupId
externalMessageId
senderId
senderName
mentionTargetIds
normalizedText
occurredAt
ingestedAt
group Resource linkage
dedupe key
```

Only configured / authorized sources are archived.

Bot membership alone does not imply archive permission.

The lexical index covers message text, sender identity, sender display name and mention targets.
Structured filters remain separate from free-text matching so punctuation-only requests such as
"who mentioned me" do not degrade into an unrelated recent-message listing. A deduplicated sync
may enrich an existing row and rebuild its derived index when provider metadata becomes available.

An empty result means no match was found inside the authorized, synchronized search window. It is
not evidence that the event never happened. Model-visible Tool results state this distinction.

## Retrieval Engine

Use an OpenSquilla-style retriever from the start.

Initial path:

```text
authorized source set
→ lexical / FTS store.search
→ over-fetch
→ source filter
→ optional temporal decay
→ optional source weighting
→ optional MMR
→ Top K
→ MGP-compatible result
```

Defaults stay simple:

```text
vector_weight = 0
text_weight = 1
MMR off until duplicate-heavy cases justify it
source weights neutral unless evidence justifies otherwise
```

Evergreen explicit facts should not receive blind temporal decay.

Apply decay by source semantics using the mature upstream mechanism.

## FTS capability

Test FTS5 against the exact Glassbox database path.

```text
FTS5 available
→ use behind OpenSquilla-style store

FTS5 unavailable
→ port OpenHarness bounded lexical fallback
```

Do not introduce Elasticsearch, a new SaaS search service, or an external vector database for P4B.

## Memory / Taste retrieval

P4A supplies canonical active Memory plus Glassbox scope / Resource mapping.

P4B uses:

```text
RecallIntent
→ authorized source set
→ OpenSquilla-style retriever
→ MGP-style SearchResult
→ bounded selected Context
```

P4B must not depend on P4A private table layout.

Project Taste only enters the matching project source set.

## Context and Delivery

P4B is not the P5 Context Budget Governor.

Use mature retrieval controls only:

```text
limit
time range
per-source cap
snippet
Top K
already-surfaced suppression
detail on demand
```

Read permission never implies Delivery permission.

Cross-group retrieval acceptance stays Owner-private.

## Implementation route

### P4B.0 — Port MGP retrieval contracts

Port RecallIntent, Search request / response metadata, RetrievalMode, ReturnMode, ScoreKind and RedactionInfo.

Add MGP compliance-inspired fixtures.

### P4B.1 — Port OpenSquilla retriever skeleton

Port the `MemoryRetriever` structure with `vector_weight = 0`, `text_weight = 1`.

### P4B.2 — Glassbox source-set authorization

Implement `history:read`, per-Owner group sets and revocation using existing Glassbox authorization.

### P4B.3 — OneBot history bridge

Add typed real history access to the existing OneBot adapter.

Normalize message ID, sender, group, text and timestamp.

### P4B.4 — Current-group Tool

Current group can search only itself.

### P4B.5 — Owner cross-group Tool

Owner private can search only currently authorized groups.

### P4B.6 — Channel archive and search store

Persist configured history separately from Runs.

Use FTS5 if proven. Otherwise port OpenHarness fallback.

### P4B.7 — Memory / Taste source adapter

Map P4A canonical Memory into the shared retriever without a second Memory search implementation.

### P4B.8 — Runtime projection and evidence

Record safe provenance:

```text
source kind
source ID
Resource
retrieval mode
score / rank
safe matched terms
Run
AuthorizationDecision
```

Denied evidence does not copy protected payload.

### P4B.9 — Real acceptance

Prove:

```text
real get_group_msg_history
current-group real hit
Owner-private cross-group hit across two authorized groups
zero candidates from unauthorized group
revocation affects next search
cross-group result delivered only to Owner private
```

## Tests

Bring behavior-compatible upstream tests.

Primary sources:

```text
MGP
  compliance/search/test_search_results.py
  compliance/access/test_access_control.py

OpenSquilla
  tests/test_memory_store_keyword_fallback.py
  tests/test_memory_search_defaults.py
  tests/test_memory_vector_normalization.py
  tests/test_memory_retention.py
  tests/live/test_search_retrieval_live.py

OpenHarness
  memory search / relevance behavior
```

Glassbox-specific tests:

```text
current group cannot choose another group
Owner A / Owner B source sets remain distinct
shared authorized group works for both
revocation affects next query
Bot membership does not imply history:read
unauthorized text never enters the retriever
channel_messages does not create a Run
archive dedupe survives restart
Owner cross-group Tool is hidden from Visitor / group Run
Delivery Gate blocks wrong audience
```

## Completion gate

P4B is complete only when:

```text
MGP-derived Recall / SearchResult contract is in use
OpenSquilla-derived Retrieval Engine is in use
OpenHarness-derived fallback exists if needed
real NapCat history source works
history:read is default-deny
per-Owner source set is enforced before load
channel history is separate from Run messages
Runtime receives bounded selected Context
Delivery remains a separate authorization decision
dual Owner / revoke / restart / non-leak tests pass
```

## PR provenance requirement

Every substantially ported mechanism records:

```text
upstream repository
pinned commit
original source path
license
ported behavior / tests
Glassbox-specific changes
```

## Non-goals

```text
Memory promotion
Taste learning / confidence mutation
generic Memory writes
external vector database
generic Context compression
P5 Context governor / routing
new Channels
LongTask
frontend search UI
```


## Shared QQ Capability Registry

P4B also owns the shared QQ Capability Registry used by Owner-private QQ tools and by P4A source adapters.

NapCat remains the implementation of QQ actions. Glassbox adds only category, risk, authorization and Resource mapping.

Target Owner-private domain Tool surface is approximately 8 to 12 stable Tools, such as:

```text
qq_capability_search
qq_groups
qq_group_members
qq_group_history
qq_group_content
qq_group_files
qq_group_moderation
qq_group_settings
qq_message_ops
qq_account_status
```

The registry maps allowlisted NapCat actions into these domain Tools.

Extend existing `owner_group_admin` with durable capability policy so an Owner can enable or disable categories for a managed group. Example categories:

```text
group.read
group.members
group.history
group.content
group.files.read
group.files.write
group.moderate
group.settings
message.manage
memory.source
```

Owner-private is the broadest remote product surface, but protected operations still re-authorize the concrete Resource immediately before execution.

Credential, raw packet and raw transport primitives remain server-only. Raw message send actions remain behind Glassbox Delivery.

See `upstream/napcat/SOURCES.md`.
