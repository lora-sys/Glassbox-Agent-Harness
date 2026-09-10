# Glassbox

Glassbox is evolving from a canvas-native coding-agent research workbench into a Personal Agent workbench with inspectable execution, strict authorization, long-running tasks, external chat channels, memory, skill evolution, assets, evals, and delegated workers.

The current repository still implements the earlier coding-agent workbench. Do not pretend future systems already exist. Preserve working behavior while moving toward the newer architecture in small verified slices.

## Product boundary

The long-term product has one durable Personal Agent.

Workbench, WeChat, QQ, email, and other integrations are entry points. They are not separate agents.

Codex, Claude Code, OpenHarness, AGY, and similar systems are providers, workers, or specialized execution capabilities. They are not the product identity.

Canvas is a workspace and inspection view. It is not execution state and it is not the whole product.

The target direction is:

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

## P0 rule: authorization comes before intelligence

The Personal Agent must not cross permission boundaries.

Do not rely on model behavior, system prompts, UI hiding, or upstream provider permissions to protect private resources.

Authorization is a server-side product invariant.

Every protected operation should be reducible to:

```text
Principal
Resource
Action
Context
```

The decision is one of:

```text
ALLOW
DENY
REQUIRES_APPROVAL
```

Default to `DENY` when no explicit rule grants access.

### Resolve the principal first

Before assembling private context or running a protected Tool, resolve who is acting.

A Principal may represent:

```text
Owner
TrustedUser
Member
Visitor
Public
Worker
Service
```

Roles are useful defaults, not the complete authorization model.

A remote channel identifier is not itself a permission grant. Identity binding and resource authorization are separate operations.

Do not let a message from WeChat, QQ, email, web content, or a Worker inherit Owner privileges merely because the Personal Agent has those privileges in another context.

### Authorize before context assembly

Unauthorized data must never be inserted into the model context and then hidden by instruction.

Required order:

```text
Incoming request
      ↓
Resolve Principal
      ↓
Authorization Check
      ↓
Authorized Context Builder
      ↓
Model / Agent Runtime
```

This applies to:

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
Secrets
Eval data
Journal entries
```

If Bob cannot read the owner's private calendar, the calendar data must not reach the prompt, retrieval result, Tool result, Worker task, or model-visible trace payload for Bob's request.

### Authorize every side effect

Protected Tools must check authorization at execution time, not only when displayed or selected.

Examples:

```text
read public asset         ALLOW
search web                ALLOW
read private calendar     DENY
send owner email          REQUIRES_APPROVAL
write production repo     REQUIRES_APPROVAL
```

A stale UI grant or old Conversation state must not bypass a current authorization decision.

When authorization changes during a LongTask, future Steps use the new grant. Prior evidence remains unchanged.

### No confused deputy

Treat external content as untrusted input.

A public user, inbound email, webpage, document, MCP result, or delegated Worker output must not be able to instruct the Personal Agent to exercise Owner-only authority on its behalf.

The caller's effective authority bounds the operation even when the Agent itself has broader Owner capabilities in another context.

### Delegation can only reduce authority

Workers receive a bounded delegation grant.

```text
worker_permissions ⊆ delegated_permissions ⊆ caller_permissions
```

AGY, Codex, Claude Code, or another Worker must not gain access merely because its upstream harness defaults to unrestricted execution.

Do not pass private Memory, secrets, files, Mail, Calendar, or credentials to a Worker unless the delegation grant explicitly allows them for the current task.

A Worker cannot grant itself more permissions.

### Approval is not permission replacement

Authorization and approval are different.

A user without permission cannot become authorized by producing an approval-shaped message.

Use approval only when the Principal already has a policy path that says the Action is allowed after approval.

Preserve who requested the Action, who approved it, what exact Resource and Action were approved, and which Run or LongTask consumed the approval.

### Authorization is evidence

Important decisions should produce auditable records such as:

```text
AuthorizationDecision
  principal
  resource
  action
  policy
  decision
  reason
  approvalId
  conversationId
  runId
  timestamp
```

Do not leak protected Resource contents into a denial log.

Authorization Trace should let the Owner answer:

- Who asked for this?
- Which resource was targeted?
- Which action was requested?
- Why was it allowed, denied, or sent for approval?
- Which Run or Worker used the grant?

### Resource-level authorization

Do not model the product as only `admin / user / guest`.

Authorization must be able to differ per Resource and Action.

Examples:

```text
Memory #123
  owner: lora
  visibility: private

Asset #456
  visibility: public

Project #789
  viewer: alice

Tool github-read
  allowed: trusted

Tool github-write
  allowed: owner
  approval: required
```

Use relation-based fine-grained authorization ideas from `openfga/openfga` as the main upstream reference. Keep the Glassbox domain model independent so replacing the policy engine remains possible.

## Core product concepts

When a current plan needs them, prefer these distinctions:

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

Keep these differences explicit:

```text
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
Permission ≠ Approval
Identity ≠ Authorization
```

Do not reuse one identifier for multiple concepts just because the first implementation is local or single-user.

## Inspectable execution

Preserve enough evidence to answer:

- What did the Agent receive?
- Which Principal and Conversation caused the Run?
- Which authorized Memory, Skill, Asset, Tool, Provider, or Worker did it use?
- What was delegated?
- What changed?
- Which permission checks happened?
- Which approvals were used?
- Which result came from which revision and configuration?
- Which Eval Sample produced a judgment?

Raw Trace is evidence. Do not rewrite it to match newer UI interpretations.

Derived State may evolve.

## Explicit execution semantics

Edit freely. Execute explicitly.

Only named Actions change execution or authorization state.

Examples:

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
Cancel Eval
Retry Step
Promote Memory
Promote Skill
Promote Asset
```

Moving a Canvas Object must never grant access, approve a side effect, or alter a running Agent.

## Channel rules

Channel-specific protocol behavior belongs in Channel Adapter code.

Normalize inbound messages before the Agent Core:

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

ChannelIdentity lookup happens before authorization.

A new channel binding must not silently merge two users or inherit privileges from an existing identity without an explicit trusted binding flow.

## Memory rules

Memory is not raw Conversation history.

Support distinct memory kinds:

```text
Semantic
Episodic
Procedural
```

Support explicit scopes such as:

```text
private
public
user
conversation
```

Memory scope is an authorization input, not a prompt label.

Every durable Memory should preserve provenance when practical:

```text
conversationId
messageId
runId
traceEventId
source
confidence
createdAt
updatedAt
```

### Memory promotion

Do not persist everything forever.

Memory Candidates should be scored, consolidated, deduplicated, and checked for contradictions before promotion.

Useful value factors include:

```text
futureUtility
goalRelevance
userRelevance
reliability
reuseCount
successfulReuse
novelty
recency
```

Useful penalties include:

```text
contradictionRisk
staleness
privacyRisk
duplication
```

Use `zhibao-dev/Learning-Multi-Factor-Memory` for memory-value and forgetting ideas.

Use `langchain-ai/langmem` for semantic, episodic, procedural memory and hot-path versus background consolidation patterns.

Do not copy a Memory from one Principal's scope into another scope during consolidation without an explicit authorized transition.

## Skill evolution rules

A successful Run is evidence for a Skill Candidate. It is not sufficient for automatic permanent promotion.

The preferred flow is:

```text
successful Runs
      ↓
Skill Candidate
      ↓
Deduplicate / Merge
      ↓
Extract Preconditions / Procedure / Failure Modes
      ↓
Generate Eval Cases
      ↓
Verify
      ↓
Validated Skill
```

Use `AMAP-ML/SkillClaw` for session-driven evolution and deduplication ideas.

Use `Zhang-Henry/CoEvoSkills` for generate, verify, refine, candidate, and validated promotion semantics.

Use `MineDojo/Voyager` for reusable skill library and retrieval patterns.

A promoted Skill should preserve source Runs, version history, validation evidence, successful reuse count, and recent failures.

Skill execution is still authorization-bound. A public Skill does not automatically make all underlying Tools public.

## Learning and asset loop

Experience mining may propose Memory, Skill, Asset, or Journal candidates from real work.

```text
Conversation / Tool / LongTask / Arena / Eval
        ↓
      Raw Trace
        ↓
 Experience Mining
        ↓
Memory Candidate / Skill Candidate / Asset Candidate
        ↓
Value + Authorization + Dedup
        ↓
Eval / Verification when needed
        ↓
Promote
```

Automatic learning must never widen visibility or capability.

A private source produces a private candidate by default.

Promotion from private to public requires an explicit policy path and, where appropriate, Owner approval.

## Asset rules

An Asset is a durable produced object, not merely a file attachment.

Examples:

```text
Report
Research
Dataset
Prompt
Template
Code
Image
Presentation
Workflow
EvalSet
Journal
MonthlyReview
Decision
Playbook
```

Assets should support ownership, visibility, versioning, lineage, and provenance.

Useful fields include:

```text
id
kind
name
owner
visibility
version
contentHash
producedByRun
derivedFrom
tags
metadata
evalStatus
createdAt
updatedAt
```

Use `dagster-io/dagster` for asset lineage, dependency, version, ownership, and materialization ideas.

Do not assume that an Asset derived from public and private inputs can be public. Derivation must re-evaluate visibility and leakage risk.

## Journal and review rules

The Agent may produce a Daily Journal and periodic reviews as explicit Runs.

Journal is not private chain-of-thought storage.

A Journal Entry is a user-readable reflection artifact based on evidence such as Runs, decisions, failures, open loops, Memory changes, Skill changes, Assets, and Eval results.

Monthly Review can aggregate Daily Journals and system metrics.

Any claim shown in a review should link back to supporting Runs, Eval Samples, Assets, or Trace when practical.

Use `joonspk-research/generative_agents` for reflection patterns and `usememos/memos` for timeline-oriented journal UX ideas.

Journal visibility follows authorization rules. Do not publish private reflection content through public channels by default.

## Mail and Calendar rules

Mail and Calendar are planned native domains, not unrestricted generic MCP access.

Candidate Mail objects:

```text
MailAccount
MailThread
MailMessage
MailContact
Draft
```

Candidate Calendar objects:

```text
Calendar
CalendarEvent
Availability
Reminder
Invite
```

Use `resend/resend-skills` for Resend-based agent inbox patterns, especially webhook verification, sender allowlists, sandboxing, and human approval.

Use `calcom/cal.diy` for scheduling, availability, and conflict-resolution references.

Inbound Mail is untrusted input.

Mail and Calendar are private resources by default.

Remote users need explicit grants for every exposed read or write capability.

## Worker delegation and AGY

AGY is a specialized Worker candidate, not a second Personal Agent.

The Personal Agent retains ownership of the user Conversation, authorization, durable task state, and final response.

Generic Worker concepts may include:

```text
workerJobId
parentRunId
parentLongTaskId
status
observe
wait
result
cancel
continue
restart
```

Keep AGY-specific CLI and command semantics inside its integration boundary.

Every Worker Job must have stable identity and parent linkage.

A wait timeout is not automatically a Worker failure.

Worker result collection should be idempotent where practical.

Cancellation, continuation, and restart are different state transitions.

Worker permission enforcement always follows Glassbox rules, even when the Worker itself runs unrestricted by default.

Use `keli-wen/agy-staff` as the primary AGY delegation reference. Current reference commit: `67d3fd8fdc04b57006a829ae376ae7ffdc7ee714`.

## Long-running task rules

LongTask exists for work that cannot safely depend on one process, request, model context, or Worker wait staying alive.

Use durable workflow semantics:

```text
stable task id
steps
event history
checkpoint
retry policy
waiting state
external signal
child task
worker job
cancellation
continuation
```

A process restart must not require replaying irreversible side effects.

Retries require idempotency or explicit deduplication for state-changing operations.

Waiting for a user, approval, webhook, scheduled time, external condition, or Worker result must be durable state.

Compaction can reduce active context but must not rewrite old Run evidence.

Use `temporalio/sdk-typescript` as the main durable execution reference.

## Eval and experiment rules

Eval is a product feature, not loose benchmark scripts.

The Agent may prepare an Eval Draft from natural language, but execution begins only after explicit Start Eval.

Keep these concepts separate:

```text
Experiment
EvalSuite
Dataset
Target
Variant
Scorer
EvalRun
EvalSample
Score
```

Each Eval Sample should reference the real Run and Raw Trace that produced it when practical.

Initial priorities:

```text
Benchmark
Differential Eval
Invariant Eval
```

Permission invariants are P0:

```text
never expose private memory to unauthorized users
never use another user's user-scoped memory
never expose private assets through public channels
never execute a tool beyond the caller's grant
never let a Worker escalate delegated permissions
never perform approval-required side effects without approval
never turn untrusted content into Owner authority
```

Use `UKGovernmentBEIS/inspect_ai` as the primary eval reference.

Measurements and judgments are different. Do not collapse them into one fake universal score.

## Arena rules

Arena may host multi-agent games, cooperation, adversarial play, and social simulations.

Every Arena Match is still subject to authorization.

An opponent, public user, game environment, or other Agent must not gain access to private Memory, Tools, Mail, Calendar, Assets, or secrets through the game loop.

Use `google-deepmind/open_spiel` for multi-player game environment patterns.

Use `sotopia-lab/sotopia` for language-agent social environments and social evaluation.

Arena Runs may feed Episodic Memory or Skill Candidates, but promotion still requires the normal learning gates.

## Persistence and Turso

Turso is a planned structured persistence layer for Personal Agent business state.

Candidate records include:

```text
agents
users
channel_identities
relationships
permissions
conversations
messages
memories
memory_evidence
skills
skill_versions
assets
asset_versions
sessions
runs
worker_jobs
long_tasks
jobs
approvals
journal_entries
eval_suites
eval_runs
eval_samples
eval_scores
```

Do not move Raw Trace into SQL merely because Turso exists.

Use Turso for business state, ownership, relationships, authorization data, routing, resumability, indexes, and queryable metadata.

Do not give the model unrestricted SQL access to core state.

Expose narrow Domain Tools and authorize them before access.

Schema migrations and tests must never point to the user's live database.

## Canvas rules

Canvas remains useful but is a projection.

Moving, grouping, connecting, resizing, or annotating objects must not silently change execution or authorization.

Do not turn every raw event into a Canvas Object.

Possible product views include:

```text
Conversation
Project
Timeline
Canvas
Trace
Experiment
Memory
Skills
Assets
Journal
Permissions
```

Keep tldraw-specific behavior in web projection and interaction code.

## Upstream-first development

`upstream/` contains selected reference implementations. Nothing there is imported at runtime.

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
  trajectory parsing, timeline, incremental tail, redaction, Turso sync

UKGovernmentBEIS/inspect_ai
  eval tasks, datasets, scorers, experiment execution

temporalio/sdk-typescript
  durable workflows, retry, signal, cancellation, continuation

tursodatabase/turso
  structured agent state and SQLite-compatible persistence

openfga/openfga
  relation-based fine-grained authorization

zhibao-dev/Learning-Multi-Factor-Memory
  memory value, forgetting, hygiene

langchain-ai/langmem
  semantic, episodic, procedural memory and consolidation

AMAP-ML/SkillClaw
  session-driven skill evolution and deduplication

Zhang-Henry/CoEvoSkills
  generated skill verification and validated promotion

MineDojo/Voyager
  reusable skill library and retrieval

joonspk-research/generative_agents
  importance, memory stream, reflection

usememos/memos
  journal timeline and selective visibility UX

resend/resend-skills
  agent email inbox and inbound email security

calcom/cal.diy
  scheduling and availability

dagster-io/dagster
  assets, lineage, ownership, dependencies

google-deepmind/open_spiel
  multi-player game environments

sotopia-lab/sotopia
  social multi-agent environments
```

Vendoring rules:

- Copy only files relevant to a current problem.
- Record source repository, commit SHA, license, original path, and reason for each copied file.
- Preserve required copyright, license, and notice files.
- Keep vendored code isolated from production imports.
- Prefer proven mechanisms over rewrites made only to own the code.
- Do not copy an upstream trust model blindly. Glassbox authorization rules always win.

## Where code lives

Follow the actual repository structure.

```text
apps/
  server/
  web/

packages/
  contracts/
  shared/

upstream/
.plans/
e2e/
template/
```

Do not create future packages before a real dependency boundary needs them.

`apps/server` owns current Runtime, HTTP, WebSocket, Provider integration, Session lifecycle, Trace, screening, and derived state.

`apps/web` owns React, tldraw, Canvas projection, Inspector, and current user interaction.

Keep Provider code near Provider integration.

Keep Worker code near Worker integration.

Keep Channel code near Channel integration.

Keep authorization checks in server-side domain boundaries that cannot be bypassed by UI or adapters.

Keep Eval orchestration separate from ordinary Run execution while linking Eval Samples back to Runs.

Keep LongTask orchestration separate from one Provider Turn or Worker Job.

## Performance

Treat performance regressions as bugs.

Large Sessions, LongTasks, Worker Jobs, Eval Runs, journals, and learning histories can produce thousands of events.

Avoid broad React rerenders, unbounded DOM growth, huge live payloads, expensive visual effects, and full-history recomputation on every event.

Prefer incremental reducers, indexed persistence, lazy inspection, pagination, or virtualization when measurements show they are needed.

## Test data and safety

Never use live user state as writable test state.

Never point tests, migrations, cleanup jobs, evals, fuzzers, chaos tests, test Agents, or Worker integrations at real repositories, live Personal Agent databases, live channels, or live credentials.

> Copy in. Never point in. Never write back.

Remote-channel tests should normally use fake adapters.

Worker tests should normally use fake workers.

Eval tests should use disposable datasets.

## Verification

Prove changes with the smallest useful check.

Authorization changes require deny-path tests, not only allow-path tests.

At minimum, relevant authorization work should consider:

```text
cross-user reads
cross-scope memory reads
private asset access
channel identity spoofing
stale permission state
revocation
Worker permission escalation
Prompt Injection requesting Owner-only Tools
approval bypass
replayed approvals
duplicate side effects
```

Channel changes should test normalization, routing, deduplication, identity binding, and authorization.

Memory changes should test scope isolation, promotion provenance, and unauthorized consolidation.

Skill changes should test validation, versioning, and Tool authorization under the Skill.

Asset changes should test ownership, lineage, visibility, and derived-asset leakage.

Worker changes should test delegated grants and parent linkage.

LongTask changes should test durable transitions, revocation, retries, and idempotency.

Eval changes should test Dataset selection, Variant assignment, Scoring, result linkage, resume, and permission invariants.

Async tests must wait on real completion signals or state transitions. Do not use arbitrary sleeps to hide races.

## Delivery cadence

Commit directly to main as soon as a verified slice is complete unless the user asks for a branch or PR workflow.

Do not accumulate unrelated verified slices.

One ticket should have one main concern.

Record current implementation scope in `.plans/`. Future ideas must not silently expand an active ticket.

## Pull requests

Open a Pull Request only when the user asks.

Push only when the user asks.

Keep one main concern per PR.

Treat automated review findings as claims to verify against source code.

## Taste

Use the smallest model that solves the current problem.

Prefer explicit state transitions over inferred magic.

Do not build speculative frameworks that the current plan does not need.

Reuse mature upstream code and patterns when they solve the problem well.

The UI must not lie. A visible grant means the server authorization state grants it. A denial means protected data never reached the model. Waiting means durable waiting state exists. Delegated means a real Worker Job exists. Success means the underlying work finished.

Validate unknown external data when it enters the system.

Avoid `any` when TypeScript can express the boundary.

Comments should explain intent, trust boundaries, provenance, or non-obvious behavior.

If a rule here becomes wrong because the product changed, update the rule instead of working around it silently.