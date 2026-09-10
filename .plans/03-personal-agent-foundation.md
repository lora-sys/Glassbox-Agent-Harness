# Plan 03 — Personal Agent Foundation

Status: ACTIVE

This is the only active implementation plan in the repository.

## Goal

Build the smallest durable foundation for one Personal Agent with explicit identity, server-side authorization, durable Conversation state, Turso persistence, and auditable authorization decisions.

The acceptance sentence is:

> The same Agent can serve an Owner and a Visitor, persist their Conversations across restart, expose public resources to both, keep Owner-private resources invisible to the Visitor, and prove every allow or deny decision in Trace.

## Why this phase comes first

Remote channels, Memory, Mail, Calendar, Workers, LongTask, Eval, Journal, Skill evolution, and Asset Library all depend on one thing being correct first: who is acting and what that Principal is allowed to see or do.

Do not build those higher layers before this boundary exists in code and tests.

## Scope

In scope:

- `Agent`
- `User`
- `Principal`
- `ChannelIdentity`
- `Relationship`
- `Permission`
- `AuthorizationDecision`
- `Conversation`
- separation of `Conversation`, `Session`, and `Run`
- server-side default-deny authorization
- authorized context assembly boundary
- protected Tool execution boundary
- Turso-backed durable structured state
- authorization decisions written to inspectable evidence without leaking protected contents
- one local Owner path and one fake Visitor path for acceptance
- focused restart, isolation, denial, and confused-deputy tests

Out of scope for Plan 03:

- real WeChat or QQ integration
- real Mail or Calendar integration
- full Memory extraction or consolidation
- Skill evolution
- Asset Library
- AGY integration
- durable LongTask engine
- Eval workbench
- Arena
- multi-Agent product semantics
- collaborative Canvas features
- OpenFGA as a required production service
- large UI redesign

These are later consumers of the foundation, not prerequisites for it.

## Required invariants

### Authorization

All protected access is evaluated as:

```text
Principal × Resource × Action × Context → Decision
```

Decision is exactly one of:

```text
ALLOW
DENY
REQUIRES_APPROVAL
```

No matching grant means `DENY`.

### Context safety

Unauthorized data is filtered before model context assembly.

The forbidden pattern is:

```text
load private data → send to model → tell model not to reveal it
```

The required pattern is:

```text
resolve principal
→ authorize
→ load only authorized data
→ assemble context
→ execute model or tool
```

### Identity

A channel or Workbench identifier resolves identity. It does not grant permission by itself.

Binding two identities together is a trusted operation and must not silently merge permissions.

### Delegation

Any future Worker boundary must satisfy:

```text
worker_permissions ⊆ delegated_permissions ⊆ caller_permissions
```

Plan 03 does not need a real Worker, but the authorization model must not make this impossible later.

### Approval

Approval cannot manufacture permission. A Principal must already have an authorization path that permits the Action after approval.

### Evidence

Authorization evidence records the decision and reason, but denial logs must not copy protected resource contents.

### Persistence

Restart must preserve durable Agent, User, identity, relationship, permission, Conversation, and authorization metadata.

Raw Trace remains separate append-only evidence. Do not move all trace payloads into SQL merely because Turso is introduced.

## Suggested domain shape

Do not treat this as frozen schema. Keep it small and adjust when tests reveal a better boundary.

```text
Agent
  id
  ownerUserId

User
  id
  kind

ChannelIdentity
  id
  userId
  channel
  externalId

Conversation
  id
  agentId
  userId
  channelIdentityId?
  createdAt
  updatedAt

Relationship
  principalId
  relation
  resourceType
  resourceId

AuthorizationDecision
  id
  principalId
  resourceType
  resourceId
  action
  decision
  reason
  approvalId?
  conversationId?
  runId?
  createdAt
```

Do not add a generic policy DSL unless the first real rules require it.

## Implementation slices

### P3.0 — Domain boundary and tests

Create the minimum provider-neutral types and an authorization interface.

Prefer server-side modules before creating a new package. Move a contract into `packages/contracts` only when a real cross-process consumer exists.

Prove:

- Owner and Visitor are distinct Principals
- resource ownership is explicit
- default deny works
- allow and requires-approval are distinct

### P3.1 — Authorization engine

Implement a small internal authorization engine inspired by OpenFGA relation semantics.

Do not deploy OpenFGA as infrastructure yet.

Prove deny paths first:

- Visitor cannot read Owner-private resource
- Visitor cannot use Owner-only Tool
- a public resource is readable
- revocation takes effect on the next protected operation
- a stale Conversation cannot preserve revoked authority

### P3.2 — Turso persistence

Introduce Turso behind a narrow persistence boundary.

Persist only the structures needed by this plan first:

```text
agents
users
channel_identities
conversations
relationships
permissions or tuples
authorization_decisions
```

Add migrations or schema bootstrap that can run against disposable test databases.

Never point tests at live user state.

Prove restart and reopen behavior.

### P3.3 — Conversation boundary

Separate Conversation identity from runtime Session and Run.

Create a local Owner entry and a fake Visitor entry that both reach the same Agent but maintain separate Conversations.

No real chat-channel protocol belongs in this slice.

### P3.4 — Authorized Context and Tool Gate

Introduce two unavoidable server-side boundaries:

```text
AuthorizedContextBuilder
AuthorizedToolExecutor
```

Names may change, but the enforcement points must exist.

Prove that private data is never returned to the model-visible context for an unauthorized Principal.

Add a fake public Tool and fake Owner-only Tool to test confused-deputy behavior without touching real external services.

### P3.5 — Trace and vertical acceptance

Record authorization decisions and link them to Conversation and Run where available.

Build one minimal acceptance flow:

1. Owner opens the Agent and can read one private and one public fixture resource.
2. Visitor opens the same Agent and can read only the public fixture resource.
3. Visitor requests the private resource directly and is denied.
4. Visitor attempts to induce the Agent or fake Tool to fetch the private resource indirectly and is denied.
5. Restart the server or persistence layer.
6. Both Conversations and grants remain correct.
7. Trace explains each decision without leaking the private content.
8. Existing Codex and Claude Code flows still work.

## Test matrix

At minimum cover:

```text
default deny
explicit allow
requires approval
cross-user read
private/public scope
identity spoof attempt
identity binding does not grant authority
revocation
stale authorization state
confused deputy
protected Tool call
replayed approval
duplicate request or retry
restart and resume
denial trace redaction
```

Use fake resources, fake channels, and fake protected Tools for most tests.

Only use live Codex or Claude Code where a provider regression specifically needs it.

## Upstream references for this phase

Read before implementing:

- `openfga/openfga`: relation-based authorization model and tuple semantics
- `HKUDS/OpenHarness`: channel identity, session routing, permissions, and agent boundary patterns
- `tursodatabase/turso`: durable SQLite-compatible state
- `pingdotgg/t3code`: provider permission handling and session resume patterns
- existing `.plans/findings/`: current Glassbox Trace, state, provider, and WebSocket evidence

Do not vendor a whole repository to start this plan. Copy only proven code that solves a concrete current slice, with source commit and license preserved.

## Code placement guidance

Prefer incremental modules under `apps/server/src/` such as:

```text
auth/
identity/
conversation/
persistence/
```

These names are guidance, not mandatory architecture.

Do not create `packages/agent-runtime` or another shared package until more than one real runtime consumer requires it.

Keep Codex and Claude-specific behavior in their existing adapter areas.

Keep Canvas changes minimal during this plan. The acceptance target is runtime correctness, persistence, and authorization evidence.

## Completion gate

Plan 03 is complete only when all of these are true:

- default-deny authorization is enforced server-side
- Owner and Visitor isolation is covered by automated tests
- unauthorized content is excluded before context assembly
- protected Tool execution rechecks authorization
- Conversation is durable and distinct from Session and Run
- Turso-backed state survives restart in tests
- authorization decisions are inspectable and do not leak denied contents
- revocation works
- existing provider behavior has focused regression coverage
- no real WeChat, QQ, Mail, Calendar, Worker, LongTask, or Eval dependency was required to prove the foundation

When this gate passes, create the next plan based on the first real consumer. The likely next consumer is one remote Channel, but do not pre-commit that decision here.