# Glassbox Agent Instructions

Glassbox is evolving from a local Coding Agent workbench into a durable Personal Agent workbench with strict authorization, persistent Conversations, inspectable execution, long-running work, learning, assets, and evals.

The repository still contains working Coding Agent infrastructure from the earlier phase. Preserve it while introducing the new Personal Agent foundation in small verified slices.

## Start here

The only active implementation plan is:

`/.plans/03-personal-agent-foundation.md`

Read in this order before changing code:

1. `AGENTS.md`
2. `.plans/03-personal-agent-foundation.md`
3. only the relevant `.plans/findings/`
4. relevant upstream source or documentation
5. current production code and focused tests

`README.md` defines product direction.

`AGENTS.md` defines stable engineering, trust, and delivery rules.

The active plan defines current scope.

Do not implement future roadmap features merely because README describes them.

## Current implementation target

Plan 03 is deliberately narrow.

Build the foundation for:

```text
Identity
  ↓
Authorization
  ↓
Conversation
  ↓
Turso persistence
  ↓
Run / Authorization Trace
```

Until Plan 03's completion gate passes, do not make real WeChat, QQ, Mail, Calendar, AGY, LongTask, Eval, Arena, Skill evolution, or full Memory consolidation a dependency of the implementation.

Use fake Channels, fake protected Tools, and disposable persistence where they prove the boundary faster and more safely.

## Product boundary

The long-term product has one durable Personal Agent.

Workbench, WeChat, QQ, email, and other integrations are entry points to that Agent. They are not separate agents.

Codex, Claude Code, OpenHarness, AGY, and similar systems are providers, workers, or specialist execution capabilities. They are not the Personal Agent identity.

Canvas is an inspection and workspace view. It is not execution state and it is not the whole product.

Target direction:

```text
Channel / Workbench
        ↓
Identity Resolution
        ↓
Authorization
        ↓
Conversation + Personal Agent
        ↓
Skill / Tool / Provider / Worker / LongTask / Eval
        ↓
       Run
        ↓
 Raw Trace + Derived State
        ↓
Experience Mining
        ↓
Memory / Skills / Assets / Journal
        ↓
Timeline / Canvas / Inspector
```

## P0: authorization comes before intelligence

The Personal Agent must not cross permission boundaries.

Never rely on model behavior, a system prompt, hidden UI, or an upstream provider's permission mode as the primary protection for private resources.

Authorization is a server-side product invariant.

Every protected operation should reduce to:

```text
Principal
Resource
Action
Context
```

The result is exactly one of:

```text
ALLOW
DENY
REQUIRES_APPROVAL
```

No matching grant means `DENY`.

### Identity is not authorization

Resolve who is acting before loading protected data or executing a protected Tool.

A Principal may eventually represent:

```text
Owner
TrustedUser
Member
Visitor
Public
Worker
Service
```

Roles are convenience defaults, not the full authorization model.

A Workbench account, WeChat ID, QQ ID, email address, API identity, or Worker identity does not grant permission merely because it resolves to a known user.

Identity binding and authorization are separate trusted operations.

### Authorize before context assembly

Unauthorized data must never enter model-visible context and then be hidden by instruction.

Required order:

```text
Incoming Request
      ↓
Resolve Principal
      ↓
Authorization Check
      ↓
Load Authorized Data Only
      ↓
Authorized Context Builder
      ↓
Model / Agent Runtime
```

This rule applies to:

```text
Memory
Assets
Projects
Files
Mail
Calendar
Conversation history
Tool results
Worker results
Journal entries
Eval data
Secrets
```

If a Visitor cannot read the Owner's private resource, its contents must not appear in the prompt, retrieval result, Worker payload, model-visible trace, denial reason, or Tool result for that request.

### Recheck protected Tool execution

A Tool shown in the UI or present in a Skill is not automatically authorized.

Re-evaluate authorization at execution time using the current Principal and current grant state.

A stale Conversation, cached UI permission, old Context, or resumed LongTask must not preserve authority that has been revoked.

### Prevent confused-deputy escalation

Treat all external content as untrusted input.

This includes messages, email, webpages, documents, MCP results, Agent outputs, Worker outputs, game environments, and retrieved text.

An untrusted caller cannot instruct the Personal Agent to use broader Owner-only authority on its behalf.

The effective caller authority bounds every protected operation.

### Delegation can only reduce authority

Future Worker delegation must satisfy:

```text
worker_permissions ⊆ delegated_permissions ⊆ caller_permissions
```

AGY, Codex, Claude Code, or another Worker must not gain private data or side-effect capability merely because the upstream harness defaults to unrestricted execution.

### Approval is not permission

Approval cannot manufacture authority for a Principal that had no valid authorization path.

Use `REQUIRES_APPROVAL` only where policy already allows the Action after a valid approval.

Keep requester, approver, exact Resource, exact Action, consumed approval, Run, and LongTask linkage auditable.

### Authorization is evidence

Important decisions should produce inspectable records such as:

```text
AuthorizationDecision
  principalId
  resourceType
  resourceId
  action
  decision
  policyOrRule
  reason
  approvalId?
  conversationId?
  runId?
  timestamp
```

A denial log must explain the decision without copying protected contents.

## Core domain distinctions

Do not reuse one identifier for multiple concepts just because the first implementation is local or single-user.

Keep these boundaries explicit:

```text
Identity ≠ Authorization
Permission ≠ Approval
Channel ≠ Agent
Conversation ≠ Session
Session ≠ Run
LongTask ≠ Run
WorkerJob ≠ LongTask
Provider / Worker ≠ Personal Agent
Event ≠ Canvas Object
Asset ≠ Canvas Object
Canvas ≠ Execution State
Raw Trace ≠ Derived State
Edit ≠ Apply
```

Current and future product concepts may include:

```text
Agent
User
Principal
ChannelIdentity
Relationship
Permission
Conversation
Memory
Skill
Asset
Tool
Session
Run
WorkerJob
LongTask
JournalEntry
Experiment
EvalSuite
EvalRun
```

Only introduce the ones required by the current plan.

## Raw Trace and Derived State

Raw Trace is evidence.

Do not rewrite history to fit a newer UI or reducer interpretation.

Derived State may evolve as Glassbox learns to interpret traces better.

Authorization decisions, approvals, delegation, Run lifecycle, and later learning promotion should remain traceable to underlying evidence.

Do not dump protected payloads into Trace merely to make debugging convenient.

## Explicit execution

Edit freely. Execute explicitly.

Only named Actions change execution or authorization state.

Examples include:

```text
Apply
Steer
Approve
Grant
Revoke
Stop
Resume
Delegate
Cancel Worker
Continue Worker
Start Eval
Retry Step
Promote Memory
Promote Skill
Promote Asset
```

Moving, connecting, grouping, resizing, or annotating Canvas Objects must never grant permission or change a running Agent implicitly.

## Current code boundaries

Follow the actual repository structure:

```text
apps/
  server/
  web/
    e2e/

packages/
  contracts/
  shared/

.plans/
  03-personal-agent-foundation.md
  findings/

assets/
  readme/

upstream/
  t3-code/
```

`apps/server` owns the current Runtime, HTTP, WebSocket, Provider adapters, Session lifecycle, Trace, screening, and Derived State.

Plan 03 should initially add new server-side boundaries near this code. Reasonable module names include:

```text
auth/
identity/
conversation/
persistence/
```

These names are guidance, not mandatory architecture.

`apps/web` owns React, tldraw, Canvas projection, Inspector, and user interaction.

`packages/contracts` should contain only contracts with a real cross-boundary producer and consumer.

`packages/shared` stays small and runtime-independent.

Do not create `packages/agent-runtime` or another future package until a real dependency boundary requires it.

Keep Provider-specific behavior near Provider integration.

Keep Worker-specific behavior near Worker integration.

Keep Channel protocol behavior near Channel integration.

Keep tldraw-specific behavior in web projection and rendering.

Keep authorization enforcement in server-side boundaries that UI and adapters cannot bypass.

## Persistence and Turso

Plan 03 introduces Turso for structured durable state.

Start with the smallest records needed by the plan, such as:

```text
agents
users
channel_identities
conversations
relationships
permissions or authorization tuples
authorization_decisions
```

Do not build the entire future schema in the first migration.

Raw Trace remains separate append-only evidence unless a later concrete plan changes that decision.

Do not give the model unrestricted SQL access.

Expose narrow Domain APIs and authorize before reading or writing protected state.

Migrations and tests must use disposable databases.

## Channel rules

Real remote channels are not part of Plan 03.

Use a fake Visitor entry to prove identity, Conversation isolation, and authorization first.

When real channels arrive later, normalize them before the Agent Core.

A useful inbound shape will likely contain concepts such as:

```text
channel
externalUserId
externalConversationId
messageId
text
attachments
metadata
```

Private chat, group chat, thread, and sender routing must isolate unrelated users.

Never put QQ, WeChat, Telegram, Discord, or other protocol quirks into the Personal Agent core.

## Memory, Skill, Asset, Journal

These are roadmap consumers of the foundation, not Plan 03 dependencies.

Stable rules already apply:

- Memory is not raw Conversation history
- private sources produce private candidates by default
- automatic learning never widens visibility or capability
- one successful Run is evidence for a Skill Candidate, not automatic permanent promotion
- promoted Memory, Skill, and Asset should preserve provenance
- Journal is a user-readable reflection artifact, not private chain-of-thought storage
- public Skill visibility does not automatically expose private Tools underneath it

Primary references:

```text
zhibao-dev/Learning-Multi-Factor-Memory
langchain-ai/langmem
AMAP-ML/SkillClaw
Zhang-Henry/CoEvoSkills
MineDojo/Voyager
joonspk-research/generative_agents
usememos/memos
dagster-io/dagster
```

## Worker, LongTask, Eval, Arena

These are later layers.

Do not build them during Plan 03 unless a tiny fake is needed to prove an authorization invariant.

Stable future rules:

- Worker permissions can only shrink
- Worker result collection should be idempotent where practical
- waiting for user, approval, external condition, or Worker result must eventually become durable state
- LongTask retries require idempotency or deduplication for side effects
- Eval Sample should link back to real Run and evidence
- permission invariants are P0 eval targets
- Arena opponents and environments are untrusted callers

Primary references:

```text
keli-wen/agy-staff
temporalio/sdk-typescript
UKGovernmentBEIS/inspect_ai
google-deepmind/open_spiel
sotopia-lab/sotopia
```

## Upstream-first development

Before inventing a standard mechanism, inspect the relevant upstream first.

Current primary references:

```text
pingdotgg/t3code
  Provider integration, Claude Code adapter, permissions, resume

HKUDS/OpenHarness
  Agent loop, tools, skills, memory, permissions, channels, QQ

keli-wen/agy-staff
  AGY delegation and background Worker jobs

joyehuang/trajectory-panel
  trajectory parsing, timeline, redaction, Turso sync

UKGovernmentBEIS/inspect_ai
  eval tasks, datasets, scorers, experiment execution

temporalio/sdk-typescript
  durable workflows, retry, signals, continuation

tursodatabase/turso
  structured durable state

openfga/openfga
  relation-based fine-grained authorization
```

Vendoring rules:

- copy only files relevant to a real current problem
- record source repository, commit SHA, license, original path, and reason
- preserve copyright, license, and notice requirements
- keep vendored reference code isolated from runtime imports
- prefer proven mechanisms over rewrites made only to own more code
- never copy an upstream trust model blindly; Glassbox authorization rules win

## Existing E2E tests

`apps/web/e2e/` contains regression tests from the Coding Agent phase.

Some tests require live Providers, pre-generated sessions, historical fixtures, or environment assumptions. They are not the default first check for Plan 03.

Do not copy machine-specific absolute paths into new tests.

New Plan 03 tests should be portable and should prefer fake Channels, fake Tools, disposable Turso databases, and deterministic authorization fixtures.

## Test data and safety

Never use live Personal Agent state, real user data, real repositories, live channels, or production credentials as writable test state.

> Copy in. Never point in. Never write back.

At minimum, relevant Plan 03 authorization tests should cover:

```text
default deny
explicit allow
requires approval
cross-user read
private/public resource isolation
identity spoof attempt
identity binding does not grant authority
revocation
stale permission state
confused deputy
protected Tool call
approval replay
restart and resume
denial trace redaction
```

Async tests wait for real state transitions or completion signals. Do not hide races with arbitrary sleeps when a real signal exists.

## Performance

Treat measured regressions as bugs.

Large Sessions, LongTasks, Worker Jobs, Eval Runs, and learning histories can produce thousands of events.

Do not project every raw event onto Canvas.

Avoid broad React rerenders, unbounded DOM growth, huge live payloads, and full-history recomputation on every event.

Optimize measured bottlenecks, not imaginary future ones.

## Delivery

Commit directly to `main` as soon as a verified slice is complete unless the user asks for a branch or Pull Request workflow.

Do not accumulate unrelated changes.

One slice should have one main concern.

Update the active plan when implementation evidence changes its status or assumptions.

Do not use completed plan files as scratchpads. Git already preserves history.

Open a Pull Request only when the user asks.

## Taste

Use the smallest model and smallest abstraction that solve the current problem.

Prefer explicit state transitions over inferred magic.

Prefer deny-path correctness over UI polish when working on authorization.

The UI must not lie. A visible grant means server authorization grants it. A denial means protected data never reached the model. Waiting means durable waiting state exists. Delegated means a real Worker Job exists. Success means underlying work finished.

Validate unknown external data at system boundaries.

Avoid `any` when TypeScript can express the boundary.

Comments should explain intent, trust boundaries, provenance, or non-obvious behavior.

If this file conflicts with the actual product direction, update the rule instead of silently working around it.