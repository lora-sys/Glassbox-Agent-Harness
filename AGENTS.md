# Glassbox

Glassbox is evolving from a local Coding Agent workbench into a durable Personal Agent workbench with explicit identity, strict authorization, persistent Conversations, inspectable execution, learning, assets, evals, and controlled multi-worker operations.

The product has one durable Personal Agent. Workbench, messaging Channels, email, API access, and future integrations are entry points to that Agent, not separate Agents.

Glassbox should help people use the Agent, understand what it did, verify why it was allowed to do it, and see what delegated work is currently running or waiting.

## What makes Glassbox special?

### 1. Authorization before intelligence

Permission is a server-side product invariant.

Every protected operation reduces to:

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

Unauthorized data must be filtered before model-visible Context is assembled. Never load private data, send it to a model, and rely on a Prompt telling the model not to reveal it.

Protected Tool execution rechecks current authorization at execution time.

Approval does not manufacture Permission.

Plan 03 adds explicit hard gates around the QQ and Agent Operations closed loops. Every protected path must be able to answer:

```text
Who is acting?
Where are they acting?
What are they trying to do?
How will it be done?
Which Resource is involved?
Who will receive the result?
Which Conversation and Run does this belong to?
```

Authorization is enforced at Ingress, Context assembly, Tool execution, Agent Ops actions, and Delivery. None of these gates may be replaced by Prompt instructions.

### 2. One durable Personal Agent

Channel identity is not Agent identity.

Workbench, WeChat, QQ, Telegram, Discord, Slack, email, API access, and future Channels resolve a caller into a User / Principal that reaches the same Personal Agent.

A User may be the Agent Owner or another person who is allowed to use the Agent. A User may have multiple Channel Identities. Trusted identity binding may resolve those Channel Identities to the same User, but identity binding never widens that User's permissions.

Conversation is durable product state. Runtime Session and Run are execution concepts underneath it.

A direct Conversation may be scoped to one user. A group Conversation belongs to the group scope, while each Run still records the real acting Principal.

Task is also durable product state. A coding worker, Herdr pane, worktree, Runtime Session, or Run may execute a TaskAttempt, but none of them is the Task itself.

Keep these boundaries clear:

```text
Channel ≠ Agent
ChannelIdentity ≠ User
Identity ≠ Authorization
Conversation ≠ Principal
Conversation ≠ Session
Session ≠ Run
Task ≠ Run
Task ≠ Worker
TaskAttempt ≠ Herdr pane
Herdr Agent state ≠ Task acceptance
Actor permission ≠ Delivery permission
Runtime / Provider / Worker ≠ Personal Agent
```

### 3. Researchable by default

Glassbox should preserve enough evidence to answer:

- Who was acting?
- Where were they acting?
- What was that Principal allowed to see or do?
- What Context actually reached the Agent?
- Which Tool or Runtime executed?
- Which Task or TaskAttempt was involved?
- Which Herdr workspace / worktree / pane / worker was bound to that attempt?
- Which audience was the result intended for?
- What changed during the Run or Task lifecycle?
- Why was an operation allowed, denied, sent for approval, blocked at delivery, sent for review, or returned for rework?
- Which result came from which configuration and evidence?

Editing, projection, compression, reconciliation, or a newer reducer must not erase what an active or completed Run or TaskAttempt actually used.

### 4. Agent-native, not provider-specific

Glassbox connects to existing Agent runtimes and specialist workers instead of forcing every runtime into one behavior.

Pi, Codex, Claude Code, OpenHarness, AGY, Herdr-managed workers, and future systems may expose different tools, lifecycle controls, context behavior, permission modes, and events.

Plan 03 uses the Pi SDK directly inside the Glassbox Node.js server. The primary package is `@earendil-works/pi-coding-agent`.

Lora PI Kit is the maintainer-owned Pi configuration and extension layer. Glassbox remains the product and trust boundary.

Herdr is the selected live Agent Operations execution layer for coding workers. Glassbox owns Task truth, Attention, TaskAttempt history, WorkerBinding, authorization, review, rework, and acceptance.

Do not turn Glassbox into a Pi wrapper. Do not copy Pi core into Glassbox to create Lora PI Kit.

Do not turn Herdr workspace or pane state into the Glassbox Task database.

For Pi customization, use this order before considering a core patch:

```text
Pi settings / project config
Pi package resources
Skill
Extension
custom Tool
Pi SDK integration
upstream contribution
local core patch
```

Do not use RPC as the primary Plan 03 Pi integration path.

For Herdr, use its public CLI / local socket API and installed protocol schema before reaching into implementation internals. Long-lived event integration belongs behind a Glassbox-owned `HerdrBridge`.

Read `docs/runtime-strategy.md` before changing the runtime boundary. Read `docs/agent-operations.md` before changing Herdr integration, Task / Attention / WorkerBinding semantics, Ops Tools, or worker reconciliation.

Keep runtime-specific and host-specific behavior close to the corresponding integration.

Share only the concepts Glassbox actually needs.

Never copy an upstream trust model blindly. Glassbox authorization rules win.

### 5. Canvas-native, but Canvas is a projection

Canvas remains a powerful workspace and inspection surface. It is not execution state and it is not the whole product.

Moving, connecting, grouping, resizing, or annotating Canvas Objects must not silently change Agent execution, Task state, worker state, or authorization.

Do not turn every raw event into a Canvas Object.

Keep normal whiteboard behavior useful, but preserve this boundary:

```text
Raw Trace
→ Derived State
→ Canvas Objects
→ tldraw projection
```

### 6. Performance and efficiency without compromising trust

Treat measured regressions as bugs.

Watch for broad rerenders, huge live payloads, unbounded event history projections, repeated retrieval, oversized Tool results, unnecessary model Context, duplicated QQ events, repeated model execution, duplicated delivery, unbounded Herdr event ingestion, and repeated worker reconciliation.

Later efficiency work may use context budgets, Tool-result projection, hybrid retrieval, smart routing, semantic cache, model-tier selection, and richer worker scheduling.

Those mechanisms may reduce cost or increase capability. They may never widen authority, hide evidence, or bypass authorization.

## Project owner note

When a requirement is ambiguous, choose the smaller implementation that preserves the product rules in this file and completes the active closed loop.

Do not silently expand the task.

The only active implementation plan is:

`/.plans/03-personal-agent-foundation.md`

Read in this order before changing code:

1. `AGENTS.md`
2. `.plans/03-personal-agent-foundation.md`
3. `docs/runtime-strategy.md` when changing runtime, provider, worker, Pi, Lora PI Kit, execution integration, runtime-level Skills, Extensions, custom Tools, or model execution policy
4. `docs/agent-operations.md` when changing Herdr, Task, TaskAttempt, AttentionItem, WorkerBinding, Ops Tools, worker review/rework, or reconciliation
5. `docs/tech-stack.md` when changing tooling, dependencies, build, test, lint, format, or package management
6. only the relevant `.plans/findings/`
7. relevant upstream source or documentation
8. current production code and focused tests

`README.md` defines product direction.

`.plans/roadmap.md` records sequencing, not permission to implement future phases.

Current P3 is one usable Personal Agent loop plus one minimal Agent Operations loop:

```text
QQ private / group message
        ↓
NapCat
        ↓
OneBot 11 Channel Adapter
        ↓
Ingress Gate
        ↓
Identity Resolver
        ↓
Conversation Resolver
        ↓
Authorization Engine
        ↓
Authorized Context Builder
        ↓
Pi SDK + Lora PI Kit
        ↓
Tool Gate
        ↓
Direct answer OR Task / Attention
        ↓
HerdrBridge when delegated
        ↓
Herdr worker lifecycle
        ↓
Review / Rework / Accept
        ↓
Delivery Gate
        ↓
QQ reply
        ↓
Turso durable state + Raw Trace
```

Plan 03 includes the deterministic test harness, Lora PI Kit MVP, direct Pi SDK integration, the four hard authorization gates, scope-based Conversation persistence, NapCat / OneBot QQ private and group chat, message deduplication, restart recovery, Trace, AttentionQueue, TaskRegistry, TaskAttempt, WorkerBinding, AgentOpsSnapshot, HerdrBridge, reconciliation, Ops Tools, and real QQ + Herdr acceptance.

P3 does not include a full durable workflow engine. Complex Task DAGs, generalized retry policy, checkpoints, child tasks, continuations, and large-scale worker scheduling remain later LongTask work.

Until P3 passes its completion gate, do not add real WeChat, Telegram, Discord, Slack, Mail, Calendar, AGY product integration, full LongTask, Eval Workbench, Arena, full Memory consolidation, vector retrieval, semantic cache, smart routing, broad Skill evolution, serverless deployment, or a large UI redesign as implementation dependencies.

Product history and future ideas belong in `README.md`, `.plans/roadmap.md`, `docs/`, or research notes. Current implementation scope belongs in the active plan.

If the current task conflicts with a stable rule in this file, stop and ask before breaking the rule.

## A small glossary

Use these terms consistently.

- **you** means the coding Agent reading this file and changing Glassbox.
- **we**, **us**, and **maintainers** mean the people building and maintaining Glassbox.
- **user** means a person who uses the Personal Agent. This includes the Agent Owner and other people the Owner allows to access the Agent through Workbench or a Channel. A User's identity does not itself grant access; effective access is determined through Principal and Authorization.
- **principal** means the effective actor used for an authorization decision.
- **channel** means an entry point through which a User reaches the Personal Agent, such as Workbench, QQ, WeChat, Telegram, Discord, Slack, email, API access, or a future messaging or integration channel.
- **channel identity** means a User's external identity inside one Channel. One User may have multiple Channel Identities. Trusted identity binding may map them to the same User but never grants additional Permission by itself.
- **location** means the concrete place where an Action originates, including Channel, scope type, and scope key such as one QQ private chat or one QQ group.
- **audience** means the destination that can receive an output. Read permission and delivery permission are separate decisions.
- **agent** means the durable Personal Agent product identity unless a runtime-specific context clearly means an external Agent runtime.
- **runtime** means an execution backend or Agent runtime integration such as Pi, Codex, or Claude Code.
- **provider** means a model-provider or runtime-specific integration detail below the Glassbox product boundary.
- **worker** means delegated specialist execution. In P3, a Herdr-managed coding Agent can be a Worker for one TaskAttempt.
- **resource** means protected data or capability addressed by authorization.
- **action** means an explicit operation on a Resource or execution state.
- **conversation** means durable thread state for an Agent and a scope. A direct QQ Conversation may use `qq:user:<id>`. A group QQ Conversation may use `qq:group:<id>`.
- **session** means provider or runtime execution context such as a Pi Session. It is not the Conversation.
- **run** means one concrete Agent execution by one Principal inside one Conversation.
- **task** means durable product work tracked by Glassbox. It is not a Run, pane, worktree, or external Agent state.
- **task attempt** means one concrete execution or rework attempt for a Task.
- **attention item** means something that currently needs main-Agent or human action, such as an unanswered message, blocked worker, approval, review, failure, or operations connection problem.
- **worker binding** means the mapping from one TaskAttempt to the concrete Herdr execution location and worker identity.
- **agent ops snapshot** means the compact current projection of task, attention, and worker counts used by the main Agent.
- **Herdr** means the live Agent Operations host for workspaces, worktrees, panes, terminal processes, and coding-Agent lifecycle facts. Herdr is not Task truth or authorization.
- **raw trace** means append-only execution evidence.
- **derived state** means Glassbox's current interpretation of evidence for product behavior.
- **authorization decision** means inspectable evidence of an `ALLOW`, `DENY`, or `REQUIRES_APPROVAL` result.
- **approval** means explicit human authorization for a policy path that already permits approval. It is not Permission.
- **visibility** means the scope in which protected content may be used or delivered, such as `public`, `owner-private`, `user:<id>`, `group:<id>`, or `conversation:<id>`.
- **memory** means promoted durable knowledge. It is not raw Conversation history.
- **skill** means a reusable validated procedure or capability description.
- **asset** means a durable output with provenance, lineage, or version identity.
- **canvas** means the interactive tldraw workspace and projection surface.
- **canvas object** means something shown on Canvas because it helps the user understand, inspect, edit, or act on work.
- **artifact** means a durable output such as a file, diff, document, image, webpage, dataset, or generated design.
- **inspector** means contextual detail UI for a selected object or execution record.

Keep these distinctions clear:

```text
User ≠ Principal
ChannelIdentity ≠ User
ChannelIdentity ≠ Permission
Identity ≠ Authorization
Conversation ≠ Principal
Conversation ≠ Session
Session ≠ Run
Task ≠ Run
Task ≠ Worker
TaskAttempt ≠ Herdr pane
Herdr Agent state ≠ Task acceptance
Actor permission ≠ Delivery permission
Permission ≠ Approval
Channel ≠ Agent
LongTask ≠ Task
WorkerJob ≠ LongTask
Runtime / Provider / Worker ≠ Personal Agent
Event ≠ Canvas Object
Asset ≠ Canvas Object
Canvas ≠ Execution State
Raw Trace ≠ Derived State
Edit ≠ Apply
```

Do not reuse one identifier for multiple concepts merely because the current implementation is local or single-user.

## The easiest ways to hurt this project

1. **Authorizing after private data is loaded.** Permission filtering happens before protected Context, retrieval results, Worker payloads, Tool results, caches, or projections reach an unauthorized caller or model.

2. **Treating Prompt text as a security boundary.** System prompts may guide behavior. They do not replace Ingress, Context, Tool, Agent Ops, or Delivery authorization gates.

3. **Creating a confused deputy.** QQ messages, external messages, email, webpages, documents, MCP results, Agent outputs, Worker outputs, and retrieved text are untrusted input. They cannot borrow broader Owner authority.

4. **Letting actor permission imply delivery permission.** An Owner may be allowed to read owner-private data in a private context and still be forbidden from sending that data to a QQ group.

5. **Letting stale authority survive.** A stale Conversation, cached UI permission, Pi Session, old Context, resumed Run, TaskAttempt, or previous approval must not preserve a revoked grant.

6. **Exposing unrestricted shell or Herdr control through QQ.** P3 QQ execution uses explicit Tool allowlists. Generic `bash`, `powershell`, raw `pane.send_input`, arbitrary worktree removal, and unrelated worker reads must not become remote escape hatches.

7. **Treating Herdr `done` as Task acceptance.** Worker lifecycle is execution evidence. Only a Glassbox review / acceptance Action moves a reviewed Task to DONE.

8. **Using Herdr as the Task database.** Workspace labels, pane state, plugin files, and worktree branches are not durable Glassbox Task truth.

9. **Losing task truth during reconnect.** Herdr subscriptions do not replace snapshot reconciliation. A monitoring gap must not silently complete or fail work.

10. **Escalating through delegation.** Delegation must satisfy:

```text
worker_permissions ⊆ delegated_permissions ⊆ caller_permissions
```

11. **Rewriting evidence.** Never alter Raw Trace, TaskAttempt history, or execution-relevant history so an old Run or attempt appears to have used newer state.

12. **Making Canvas the source of truth.** tldraw records are a view. Core Agent, Conversation, Permission, Task, Run, Trace, Memory, Skill, and Asset state must not depend on Canvas layout.

13. **Designing for imaginary future systems.** Do not build roadmap features because they sound inevitable. The active plan decides implementation scope.

14. **Writing to live user state.** Never run tests, migrations, cleanup, fixtures, or test Agents against the user's real Personal Agent state, normal `~/.pi/agent`, real writable repositories, production QQ state, or production Herdr workspaces.

15. **Doing a half toolchain migration.** `package.json`, lockfile, Vite, Vitest, and Vite+ must describe one coherent toolchain after migration.

16. **Forking Pi too early.** Do not maintain a broad Pi fork for behavior that settings, packages, Skills, Extensions, custom Tools, ResourceLoader configuration, or the public SDK can implement.

17. **Putting QQ transport into Lora PI Kit.** NapCat and OneBot application behavior belong to the Glassbox QQ Channel. Lora PI Kit owns Pi customization, not Channel transport or Glassbox authorization.

## Explicit execution semantics

Edit freely. Execute explicitly.

Only named Actions may change execution, Task, or authorization state.

Examples include:

```text
Apply
Steer
Approve
Grant
Revoke
Share
Delegate
Prompt Worker
Accept Task
Rework Task
Cancel Task
Stop
Resume
Cancel Worker
Continue Worker
Start Eval
Retry Step
Promote Memory
Promote Skill
Promote Asset
```

Layout changes, notes, grouping, arrows, Canvas movement, QQ text, Herdr focus changes, workspace renames, or model suggestions do not implicitly execute product Actions.

The UI and Channel behavior must make draft state, applied state, permission state, delivery state, Task state, review state, and running state truthful.

If an execution-relevant value changes during a Run or TaskAttempt, preserve enough information to reconstruct what it started with and when the new value took effect.

## Preserve evidence

Raw Trace is evidence. Derived State is interpretation.

Do not rewrite Raw Trace to match a newer UI model or reducer.

Authorization decisions, approvals, Share actions, delivery decisions, Task assignment, worker binding, worker lifecycle observations, review, rework, acceptance, delegation, Run lifecycle, and later learning promotion must remain traceable to underlying evidence.

A denial record explains why access was denied without copying denied private contents.

Context compression and Tool-result projection may reduce model-facing data later. They do not delete Raw Trace evidence.

Herdr screen output is not by itself the canonical result of a TaskAttempt. Preserve the accepted result reference and relevant evidence separately.

Measurements and judgments are different. Token counts, tool calls, duration, file changes, exit codes, QQ message ids, delivery attempts, reconnect counts, worker state transitions, and task durations are measurements. Review decisions, Eval scores, LLM judgments, and human review are judgments. Do not merge them into a fake universal score.

## Check every affected path

Before calling a change done, check the parts that apply.

- **Identity.** Confirm who the QQ or Workbench caller resolves to and that identity binding does not grant permission by itself.
- **Ingress.** Check self-message filtering, allowed identities, allowed groups, group activation, duplicate event handling, and whether denial happens before Pi invocation.
- **Authorization.** Check allow, deny, approval, revoke, Share, stale-state, location, audience, Task, and worker-control paths.
- **Context.** Verify denied Resource, Task result, or Worker output contents never enter Pi model-visible Context.
- **Tools.** Protected Tool calls re-authorize immediately before execution. QQ profiles use an explicit Tool allowlist.
- **Agent Operations.** Check Task truth separately from Herdr state. Verify AttentionItem, TaskAttempt, WorkerBinding, AgentOpsSnapshot, Ops Tools, and review/rework semantics.
- **Herdr integration.** Use public protocol surfaces. For bootstrap/reconnect, subscribe and wait for acknowledgement before snapshot reconciliation. Do not infer Task completion from connection loss.
- **Delivery.** Verify generated output can be sent to the actual audience. Actor read permission does not automatically permit group delivery.
- **Conversation / Session / Run / Task.** Preserve the correct lifetime and identity for each. Group Conversation state must not erase the acting Principal. TaskAttempt history must survive rework.
- **Persistence.** Decide what survives refresh, reconnect, restart, and database reopen. Restore current grants and Task state without restoring revoked authority or stale worker assumptions.
- **QQ transport.** Check OneBot event parsing, private and group reply, mention activation, reconnect, dedupe, and self-message loop prevention.
- **Pi SDK.** Use explicit `agentDir`, ResourceLoader, SessionManager, model runtime, Tool set, and subscriptions where the test or runtime boundary requires them.
- **Lora PI Kit.** Keep Pi configuration, Extensions, Skills, prompts, presets, hooks, install, doctor, and compatibility metadata there. Do not move Glassbox product authority there.
- **Trace.** Verify evidence is useful without leaking protected payloads or the private canary.
- **Runtime behavior.** Define what happens when a Runtime does not support a capability and keep runtime-specific behavior inside its integration boundary.
- **Contracts.** When cross-boundary state changes, check every producer and consumer.
- **Canvas projection.** Check both Glassbox state and visible tldraw behavior where relevant.
- **Reverse states.** Grant / Revoke, share / unshare, start / stop, assign / cancel, review / rework / accept, connect / reconnect, and similar paired states need explicit behavior.
- **Toolchain.** Keep workspace config, package manifests, lockfile, test runner, lint, and format behavior coherent.
- **Docs.** Update the active plan or stable docs when a settled boundary changes.

## Dev servers

Document and run only commands that exist in the current repository.

Glassbox has selected **Vite+** as the unified JavaScript / TypeScript toolchain direction. Read `docs/tech-stack.md` before changing it.

The intended command surface after the verified migration is:

```text
vp install
vp dev
vp build
vp check
vp test
vp run <task>
```

Vite+ is expected to unify Vite / Rolldown, Vitest, Oxlint, Oxfmt, and workspace task execution.

Playwright remains the browser / E2E layer.

`apps/server` remains a Node.js runtime. Pi SDK runs inside that server boundary for Plan 03.

Herdr is a separate local session server / process boundary. Keep its lifecycle independent from the Glassbox web dev server lifecycle unless the active task explicitly owns both.

The production target is a Linux server. Local development must use the same Glassbox Task, WorkerBinding, HerdrBridge, reconciliation, authorization, and Trace contracts intended for that server.

Do not make product correctness depend on a desktop GUI or Moshi. Moshi may later attach remotely over SSH as an operations client.

Until the Vite+ dependency migration is actually verified and committed, inspect the repository scripts and use the commands that exist. Do not pretend planned commands are already repository reality.

Do not introduce a second ESLint / Prettier / ad-hoc TypeScript check stack unless a demonstrated compatibility gap requires it.

Do not hardcode localhost origins into client code. Development clients use relative `/api` and `/ws` boundaries through the dev server.

Stop only processes you started or processes you verified belong to the current development instance.

## Test data

Never use live Personal Agent state as writable automated-test state.

Plan 03 has deterministic tests and real integration acceptance.

The deterministic automated environment runs without real QQ accounts and without consuming paid model quota. It uses:

```text
Fake OneBot Gateway
Fake Owner
Fake Visitor
Fake Group
Disposable Turso / SQLite database
isolated Pi agentDir
Lora PI Kit test preset
recording or deterministic fake model/provider
FakeHerdrBridge
deterministic Herdr event fixtures
synthetic protected resources
Raw Trace capture
```

Pi tests must not use the user's normal `~/.pi/agent`. Use explicit isolated configuration and session state.

Herdr domain tests should not use the user's normal live workspaces. Use `FakeHerdrBridge` for most tests and a dedicated disposable Herdr session / repository for focused protocol integration.

A disposable local test root may use this shape:

```text
.glassbox-test/
  pi/
    settings.json
    models.json
    skills/
    extensions/
    sessions/
  db/
    p3-test.db
  fixtures/
    users.json
    groups.json
    resources.json
    onebot-events/
    herdr-events/
  worktrees/
  traces/
```

The real acceptance environment uses dedicated test identities and disposable worker state:

```text
Bot QQ
Owner QQ
Visitor QQ
Test QQ Group
  Bot
  Owner
  Visitor
Dedicated Herdr test session / workspace
Disposable test repo / worktree
At least one real supported coding Agent
```

Use isolated Glassbox state and isolated Pi configuration for real acceptance. Do not commit QQ credentials, NapCat session data, API keys, production secrets, or Herdr state containing private user work.

For Plan 03, keep one deterministic fixture containing at least:

```text
one Agent
Owner
Visitor
Bot ChannelIdentity
Owner ChannelIdentity
Visitor ChannelIdentity
one direct Owner Conversation
one direct Visitor Conversation
one group Conversation
one public Resource
one Owner-private Resource
one group-visible Resource
one public Tool
one Owner-only Tool
AttentionItems
Tasks in queued / running / review states
TaskAttempts
WorkerBindings
Grant / Revoke
restart
message dedupe
Herdr reconnect
AuthorizationDecision + Run + Delivery + Task evidence
```

The Owner-private fixture contains a distinctive security canary such as:

```text
PRIVATE_CANARY_7F92A1
```

That value must never appear in unauthorized Pi Context, unauthorized Tool or Worker results, QQ output, unauthorized Trace projections, or denial messages.

The same fixture may be reused by automated tests, local acceptance UI, examples, and later documentation demos.

Reading or copying real data for debugging is acceptable when required. Write only to a safe copy.

> Copy in. Never point in. Never write back.

Use realistic fixtures when empty state or tiny mocks would hide the behavior being tested.

## Verifying

Prove the change with the smallest useful check, then run the relevant P3 closed-loop checks before calling a slice complete.

Behavior changes need focused tests for the behavior that changed.

Plan 03 coverage should include the relevant subset of:

```text
default deny
explicit allow
requires approval
cross-user read
private / public / group visibility
identity spoof attempt
identity binding does not grant authority
revocation
stale authorization state
confused deputy
protected Tool call
QQ Tool allowlist
generic shell blocked from QQ
Ops Tool authorization
unauthorized worker_read
unauthorized worker_prompt
approval replay
Owner private delivery allowed
Owner group private delivery denied
Visitor private exfiltration attempt
Visitor group exfiltration attempt
prompt injection exfiltration attempt
indirect Tool / Worker exfiltration attempt
private canary non-leak
message dedupe
group message without activation
self-message loop prevention
NapCat reconnect
restart and Conversation resume
runtime session rebinding
Task state persistence
Herdr subscription bootstrap
Herdr snapshot reconciliation
worker working projection
worker blocked attention
worker done → review
review accept
review rework
previous TaskAttempt preserved
Herdr disconnect / reconnect
worker replacement / disappearance
denial Trace redaction
delivery decision Trace
```

Persistence tests use disposable Turso or SQLite-compatible Turso databases.

Pi SDK tests use isolated `agentDir`, controlled ResourceLoader, controlled SessionManager, explicit Tool sets, and a deterministic or recording model/provider when real model behavior is not the thing being tested.

Agent Operations tests use `FakeHerdrBridge` by default and focused real Herdr integration only when protocol behavior is the thing being tested.

Async tests wait on real completion signals or state transitions. Do not hide races with arbitrary sleeps when a real signal exists.

Run browser-level verification when behavior depends on real tldraw interaction, selection, drag and drop, visual state, or browser APIs.

Real QQ and Herdr acceptance are required for the P3 completion gate, but they are not the default unit-test path.

After the Vite+ migration is complete, `vp check`, `vp test`, and `vp build` become the preferred broad toolchain checks. Before that migration lands, use the repository commands that actually exist.

Do not launch unrelated browsers, providers, external processes, live QQ accounts, or broad live-provider suites unless the task requires them.

## Pull requests

Do not create a Pull Request unless the user asks for one.

Commit directly to `main` after a verified slice is complete unless the user requests a branch or PR workflow.

Keep one main concern per change.

Use existing commit conventions. Do not invent a new convention inside one task.

For user-visible UI, QQ Channel, or Agent Operations changes, include the smallest useful real verification when practical. A short recording is useful when motion, timing, reconnect, group activation, worker state, review/rework, or a multi-step interaction is the point of the change.

Treat automated review findings as claims to verify against the source. Fix real issues; do not change code merely to satisfy an incorrect bot comment.

## How it works

The Plan 03 trusted path is:

```text
QQ / Workbench
        ↓
ChannelIdentity
        ↓
Ingress Gate
        ↓
Identity Resolution
        ↓
User → Principal + Conversation
        ↓
Authorization
        ↓
Authorized Context
        ↓
Pi SDK + Lora PI Kit
        ↓
Authorized Tool Gate
        ↓
Direct Run
   OR
Task + Attention
        ↓
Authorized Ops Tool
        ↓
HerdrBridge
        ↓
Herdr worker / worktree / pane
        ↓
OpsReconciler
        ↓
TaskAttempt + WorkerBinding
        ↓
Review / Rework / Accept
        ↓
Delivery Gate
        ↓
QQ / Workbench result
        ↓
Raw Trace + Authorization + Delivery + Task Evidence
        ↓
Derived State
        ↓
Memory / Skills / Assets / Journal
        ↓
Timeline / Canvas / Inspector
```

Execution, Task, or authorization changes travel through explicit Actions:

```text
User / Agent intent
        ↓
Named Action
        ↓
Authorization
        ↓
Runtime / Tool / Agent Ops / Persistence / Delivery
        ↓
Evidence
```