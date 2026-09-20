# MGP source index

Reference project: `HKUDS/MGP`

Pinned upstream commit: `54ce6c00e3d0aa731ecbe17e74407cbbb5a96f10`

Protocol version observed at review time: `v0.1.1`

License: MIT.

MGP is the primary P4 contract reference for governed Memory objects, Memory candidates, evidence, lifecycle operations, recall intent, search results, policy context, audit and compliance behavior.

Glassbox does not need to run the MGP Python gateway as a production dependency. Port the smallest stable schemas and semantics into the existing TypeScript / Turso product boundary.

## Why it matters

P4A and P4B need a shared contract between durable learning truth and retrieval.

MGP already standardizes most of that boundary:

```text
MemoryObject
MemoryCandidate
MemoryEvidence
MemoryMergeHint
PolicyContext
RecallIntent
SearchResultItem
Write / Update / Expire / Revoke / Delete / Purge
Audit
Compliance tests
```

Use these contracts before inventing Glassbox-specific equivalents.

## P4A source slices

| Upstream path | What to port / preserve |
| --- | --- |
| `schemas/memory-object.schema.json` | canonical governed Memory shape and lifecycle metadata |
| `schemas/memory-candidate.schema.json` | pre-canonical candidate contract |
| `schemas/memory-evidence.schema.json` | evidence references attached before promotion |
| `schemas/memory-merge-hint.schema.json` | create / dedupe / upsert / replace / merge / reinforce / manual-review intent |
| `spec/runtime-write-candidate.md` | runtime candidate semantics before canonical write |
| `reference/gateway/semantics.py` | candidate → memory mapping, dedupe lookup, merge / reinforce behavior |
| `schemas/audit-event.schema.json` | inspectable lifecycle evidence |
| `compliance/dedupe/test_dedupe_upsert.py` | behavioral tests for dedupe / upsert |
| `compliance/lifecycle/` | lifecycle behavior and deletion / purge distinctions |

Glassbox should preserve MGP behavior where compatible, but map MGP subjects/scopes onto Glassbox Principal / Project / Resource semantics instead of importing MGP as authorization truth.

## P4B source slices

| Upstream path | What to port / preserve |
| --- | --- |
| `schemas/recall-intent.schema.json` | normalized recall intent |
| `schemas/search-memory.request.schema.json` | search request structure |
| `schemas/search-memory.response.schema.json` | response envelope |
| `schemas/search-result-item.schema.json` | normalized retrieval item |
| `spec/search-results.md` | score, retrieval mode, return mode, consumable text and redaction semantics |
| `schemas/policy-context.schema.json` | policy metadata carried with a request, adapted to Glassbox trust model |
| `reference/gateway/semantics.py` | normalized recall payload and policy-shaped result view |
| `compliance/search/test_search_results.py` | result-contract tests |
| `compliance/access/test_access_control.py` | non-leakage / transformed-return behavior |

## Glassbox adoption boundary

Keep these Glassbox-owned:

```text
Agent identity
Principal
Project
Resource
Grant
AuthorizationDecision
Conversation
Run / Task
Audience / Delivery
Turso durable truth
Raw Trace
```

Do not copy MGP's policy engine as Glassbox authority.

Required shape:

```text
MGP contract / lifecycle semantics
        ↓
Glassbox TypeScript domain types
        ↓
Glassbox Authorization before protected read / write
        ↓
Turso persistence
        ↓
Glassbox Trace / Delivery
```

## Scope mapping

MGP's canonical scope vocabulary is not identical to Glassbox P4 Taste scope.

Do not force Glassbox `global / project` Taste semantics into incompatible MGP enum values merely for schema purity.

Port the contract structure and lifecycle behavior, then define an explicit mapping / extension for Glassbox-owned scope and resource identity.

## Do not copy blindly

Do not import:

```text
MGP Python runtime as a second product control plane
MGP adapter routing as a second persistence authority
MGP policy decisions as Glassbox authorization
MGP subject identity in place of Glassbox Principal
```

The useful upstream is the contract, lifecycle semantics, reference algorithms and compliance tests.
