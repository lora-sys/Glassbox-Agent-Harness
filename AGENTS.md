# Glassbox

Glassbox is evolving from a canvas-native coding-agent research workbench into a Personal Agent workbench with inspectable execution, long-running tasks, external chat channels, memory, evals, and delegated workers.

The current repository still implements the earlier coding-agent workbench. Do not pretend future systems already exist. Preserve working behavior while moving the product toward the newer architecture in small verified slices.

## Product boundary

The long-term product has one durable Personal Agent.

Workbench, WeChat, QQ, and other chat integrations are entry points to that Agent. They are not separate agents.

Codex, Claude Code, OpenHarness, AGY, and other runtimes or workers may be connected providers or specialized execution capabilities. They are not the product identity.

Canvas is a useful workspace and inspection view, but it is not the entire product and it is not the source of truth for execution.

The intended direction is:

```text
Channel / Workbench
        ↓
Identity + Conversation
        ↓
   Personal Agent
        ↓
 Skill / Tool / Provider / Worker
        ↓
       Run
        ↓
 Raw Trace + Derived State
        ↓
Timeline / Canvas / Inspector
```

Long-running tasks and evals sit beside normal runs:

```text
Personal Agent
├── Conversation
├── Memory
├── Skills
├── Tools
├── Worker Delegation
├── LongTask Engine
└── Experiment / Eval Runner
```

## Core product rules

### Keep execution inspectable

Preserve enough evidence to answer:

- What did the Agent receive?
- Which user and Conversation caused the Run?
- Which Memory, Skill, Tool, Provider, Worker, or configuration did it use?
- What work was delegated and to which Worker?
- What actions did it take?
- What changed?
- Which approvals were requested or granted?
- Which result came from which revision and configuration?
- If this is an eval sample, which Dataset, Variant, Scorer, and Eval Run produced it?

Raw Trace is evidence. Do not rewrite history to match a newer UI or interpretation.

Derived State may evolve as Glassbox learns to interpret traces better.

### Edit freely, execute explicitly

Draft edits must not silently affect active execution.

Only explicit Actions change execution. Examples:

```text
Apply
Steer
Approve
Stop
Resume
Add to context
Remove from context
Use from next turn
Run from here
Delegate
Cancel Worker
Continue Worker
Start Eval
Cancel Eval
Retry Step
```

The UI must clearly distinguish draft, applied, pending, running, completed, failed, cancelled, waiting, and delegated states.

### Canvas is a projection

Canvas layout has no hidden execution meaning.

Moving, grouping, connecting, resizing, or annotating Canvas Objects must not silently change a running Agent, Worker, or LongTask.

Keep these distinctions clear:

```text
Event ≠ Canvas Object
Artifact ≠ Canvas Object
Canvas Object ≠ tldraw Shape
Canvas ≠ Execution State
Raw Trace ≠ Derived State
Edit ≠ Apply
Provider / Worker ≠ Personal Agent
```

Do not turn every raw event into a Canvas Object.

### Conversation is not Session

External messaging introduces a new durable boundary.

Keep these concepts separate:

```text
User
ChannelIdentity
Conversation
Session
Run
LongTask
WorkerJob
```

A Conversation represents an interaction thread between a user and the Personal Agent.

A Session represents resumable runtime context.

A Run is one concrete execution.

A LongTask is a durable task that may span many Runs, waits, retries, checkpoints, external signals, and delegated Worker jobs.

A WorkerJob is one delegated execution owned by a Provider or Worker backend such as AGY.

Do not use one identifier to represent these concepts.

### Channel is only transport

Channel-specific behavior stays in Channel Adapter code.

Normalize inbound messages before they reach the Agent Core. A useful normalized shape contains concepts such as:

```text
channel
externalUserId
externalConversationId
messageId
text
attachments
metadata
```

The Personal Agent should not contain QQ, WeChat, Telegram, Discord, or Slack protocol logic.

Private chat, group chat, thread, and sender routing must prevent unrelated users from sharing the same Conversation or Memory accidentally.

### Privacy is enforced by code

Do not rely on a system prompt to protect private data.

Memory must support explicit scope. The first useful scopes are:

```text
private
public
user
conversation
```

Tool and Worker access must also have explicit authorization boundaries. External users do not inherit the owner's Gmail, Calendar, GitHub write access, files, secrets, private Memory, or unrestricted Worker permissions simply because they can message the Agent.

Approval and Secret Screening are part of this boundary.

When a capability can cause an external side effect, define authorization, approval, retry, and audit behavior before exposing it to remote users.

## Personal Agent model

Do not create speculative abstractions, but when the current plan requires them, prefer these stable product concepts:

```text
Agent
User
ChannelIdentity
Conversation
Memory
Skill
Tool
Session
Run
WorkerJob
LongTask
Experiment
EvalSuite
EvalRun
```

Keep Provider and Worker quirks out of these generic product objects.

Do not make the core model inherit Codex, Claude, or AGY-specific types when a provider-neutral boundary is actually needed by multiple consumers.

At the same time, do not flatten useful Provider or Worker behavior merely to make a clean abstraction. Share only concepts the product truly needs.

## Worker delegation and AGY

AGY is a specialized Worker candidate, not a second Personal Agent.

The main Agent may delegate bounded work such as research, review, second opinions, or scoped implementation to AGY while retaining ownership of the user Conversation, permissions, final answer, and durable task state.

Keep the generic delegation boundary small. Useful concepts include:

```text
delegate
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

Do not expose AGY-specific slash commands or CLI flags as core product semantics. Translate them inside an AGY Adapter, Skill, or Worker integration.

Every delegated Worker job should have a stable identifier and should be traceable to its parent Run or LongTask.

A wait timeout is not automatically a Worker failure. If a Worker keeps running after the caller stops waiting, persist that state and allow later observation or result collection.

Worker result collection must be idempotent where practical. Reconnecting or retrying a result fetch must not duplicate downstream side effects.

Cancellation, continuation, and restart are different operations. Preserve the distinction in state and trace.

If a Worker modifies files or performs external side effects, Glassbox authorization rules still apply. Do not trust an upstream Worker's unrestricted default merely because its own harness allows it.

When AGY is used as a fast second model, keep enough provenance to compare its result with Codex, Claude Code, or the Personal Agent in Eval.

## Persistence and Turso

Turso is a planned structured persistence layer for Personal Agent state.

Candidate durable records include:

```text
agents
users
channel_identities
conversations
messages
memories
sessions
runs
worker_jobs
long_tasks
jobs
approvals
eval_suites
eval_runs
eval_samples
eval_scores
```

Do not move Raw Trace into SQL merely because Turso exists. Raw Trace remains append-only evidence unless a concrete plan requires a different storage strategy.

Use Turso for business state, indexes, ownership, routing, resumability, and queryable metadata.

Do not give the model unrestricted SQL access to core Agent state. Expose narrow tools such as memory search, remember, update, or forget, and enforce scope before data reaches the model.

Schema migrations and tests must never point at the user's live database.

## Long-running task semantics

LongTask exists for work that cannot safely depend on one process, request, model context, or Worker wait staying alive.

When implementing long tasks, think in terms of durable workflow semantics:

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

Waiting for a user, approval, webhook, scheduled time, external condition, or Worker result must be represented as durable state rather than a sleeping in-memory promise.

Long histories may compact into checkpoints and continuations. Compaction may reduce active context, but it must not rewrite prior Run evidence.

When a long task resumes, the system should be able to explain what was completed, what remains, what Worker jobs are still active, what it is waiting for, and why.

## Eval and experiment semantics

Eval is a product feature, not a loose collection of benchmark scripts.

Users should eventually be able to describe an experiment in natural language. The Agent may prepare an Eval Draft, but execution begins only after an explicit Start Eval action.

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

Each Eval Sample should reference the real Run and Raw Trace that produced it whenever practical.

Measurements and judgments are different.

Measurements include token counts, duration, tool calls, file changes, retries, Worker jobs, exit codes, and cost.

Judgments include LLM graders, human review, semantic quality, and composite eval decisions.

Do not collapse them into a fake universal score.

Initial eval support should prioritize real needs such as:

```text
Benchmark
Differential Eval
Invariant Eval
```

Differential Eval may compare Personal Agent versions, model providers, Coding Agents, or delegated Workers such as AGY when the same task boundary can be applied fairly.

Do not create empty abstractions for Fuzz, Simulation, Chaos, or Formal Verification until a current plan requires them.

Invariant checks are especially important for Personal Agent safety, for example:

```text
never expose private memory to an unauthorized user
never use another user's user-scoped memory
never write outside an allowed workspace
never send a side-effecting message without required approval
never let a delegated worker escape the permissions assigned by Glassbox
```

## Upstream-first development

`upstream/` contains selected reference implementations copied from mature open-source projects.

Nothing in `upstream/` is imported at runtime.

Before inventing a Provider, Agent Harness, Worker delegation protocol, Channel, Eval, trajectory, persistence, or durable-task mechanism, inspect relevant upstream code first.

Current primary references are:

```text
pingdotgg/t3code
  Provider integration, Claude Code adapter, permissions, resume

HKUDS/OpenHarness
  Agent loop, tools, skills, memory, permissions, channels, QQ

keli-wen/agy-staff
  AGY worker delegation, personas, background jobs, wait, observe, result, cancel, continue, restart
  reference commit: 67d3fd8fdc04b57006a829ae376ae7ffdc7ee714
  license: MIT

joyehuang/trajectory-panel
  trajectory parsing, timeline UI, incremental tail, redaction, Turso sync

UKGovernmentBEIS/inspect_ai
  eval tasks, datasets, scorers, eval sets, experiment execution

temporalio/sdk-typescript
  durable workflows, retry, signal, cancellation, child work, continuation

tursodatabase/turso
  SQLite-compatible structured state, local database capabilities, vector and MCP references
```

Vendoring rules:

- Copy only files relevant to a real current problem.
- Each upstream directory must record source repository, commit SHA, license, original path, and why the file was copied.
- Preserve required copyright and license notices for copied code.
- Prefer proven mechanisms over rewrites made only to own the code.
- Do not copy an upstream abstraction blindly when our product boundary is different.
- Keep vendored reference code isolated from production imports.
- When copying AGY integration code, keep AGY-specific protocol and command handling inside the AGY integration boundary.

## Current architecture

The implementation today is still primarily Provider-driven:

```text
Provider / Agent runtime
        ↓
     Raw Trace
        ↓
Normalization and replay
        ↓
   Derived State
        ↓
 Canvas / Inspector
```

Execution changes travel through explicit commands:

```text
User Action
    ↓
Glassbox command
    ↓
Runtime / Provider
```

The target adds Personal Agent orchestration and Worker delegation without invalidating the existing trace path:

```text
Channel / Workbench
        ↓
Identity + Conversation
        ↓
   Personal Agent
        │
        ├── Skill / Tool / Provider
        ├── Worker Delegation
        │      └── AGY / Codex / Claude Code / others
        ├── LongTask Engine
        └── Eval Runner
        ↓
       Run
        ↓
 Raw Trace + Derived State
        ↓
Timeline / Canvas / Inspector
```

Keep the current path correct while introducing Personal Agent concepts incrementally.

Do not document a future layer as implemented before code and tests exist.

## Where code lives

Follow the actual repository structure, not an old design note.

Current top-level structure includes:

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

`apps/server` owns current Runtime, HTTP, WebSocket, Provider integration, Session lifecycle, Trace, screening, and derived state.

`apps/web` owns React, tldraw, Canvas projection, Inspector, and current user interaction.

`packages/contracts` is currently small. Put cross-boundary contracts there only when more than one real producer or consumer needs them.

`packages/shared` should stay boring and small.

Create a new package only when an actual dependency boundary requires it.

Keep Provider-specific code near Provider integration.

Keep Worker-specific code, including AGY integration, near Worker integration.

Keep Channel-specific code near Channel integration.

Keep tldraw-specific code near Canvas projection and interaction.

Keep Eval orchestration separate from ordinary Agent execution, while linking Eval Samples back to Runs.

Keep LongTask orchestration separate from one Provider Turn or Worker Job.

## Performance

Treat performance regressions as bugs.

Do not project every raw event to Canvas.

Large Sessions, LongTasks, Worker Jobs, and Eval Runs can produce thousands of events. Avoid broad React rerenders, unbounded DOM growth, huge live payloads, expensive visual effects, and full-history recomputation on every event.

Prefer incremental reducers, indexed persistence, lazy inspection, and explicit pagination or virtualization when real load requires it.

Do not optimize imaginary bottlenecks before measurement.

## Dev servers

Document only commands that exist in the current repository.

Before running a command, inspect package scripts and tool configuration.

Do not hardcode localhost origins or development ports in client code unless the current architecture explicitly requires it.

Stop only processes you started or verified belong to the active development instance.

## Test data and safety

Never use the user's live Glassbox state as writable test state.

Never point tests, migrations, cleanup jobs, evals, fuzzers, chaos tests, test Agents, or Worker integrations at the user's real repositories, real Personal Agent database, live channels, or live credentials.

Reading or copying real data for debugging is acceptable when necessary. Write to a safe copy.

> Copy in. Never point in. Never write back.

Use realistic fixtures when tiny mocks would hide the behavior being tested.

Remote-channel tests should use fake adapters unless the plan explicitly requires a real integration test.

Worker tests should use fake workers unless the plan explicitly requires a live AGY or other Worker integration test.

Eval tests should use disposable datasets and isolated run state.

LongTask recovery tests should deliberately exercise restart, retry, duplicate delivery, waiting, resume, Worker result recovery, and cancellation paths when those semantics change.

## Verification

Prove changes with the smallest useful check.

Runtime changes should test runtime behavior.

Persistence changes should test restart and resume behavior when relevant.

Channel changes should test normalization, routing, deduplication, and authorization.

Memory changes should test scope isolation.

Worker changes should test delegation, stable job identity, status mapping, timeout behavior, cancellation, continuation, restart, result collection, permission boundaries, and parent Run or LongTask linkage.

LongTask changes should test durable transitions and idempotency.

Eval changes should test Dataset selection, Variant assignment, Scoring, result linkage, and resume behavior where applicable.

Canvas changes should test both Glassbox state and visible tldraw behavior when both matter.

Async tests must wait on real completion signals, events, promises, drains, or state transitions. Do not make timing-sensitive tests pass with arbitrary sleeps when a real signal exists.

Run browser verification only when behavior depends on browser APIs or real interaction.

## Delivery cadence

Commit directly to main as soon as a verified slice is complete unless the user asks for a branch or PR workflow.

Do not accumulate unrelated verified slices into one commit.

One ticket should have one main concern.

Keep each slice small enough that its behavior, tests, and rollback boundary are understandable.

Record current implementation scope in `.plans/`. Product history, future ideas, and research notes should not silently expand an active ticket.

If roadmap logging exists for the current plan, update it before starting the next slice.

## Pull requests

Open a Pull Request only when the user asks for one.

Push only when the user asks.

Keep one main concern per PR.

For user-visible UI changes, include before and after screenshots when practical. Use a short recording when motion, timing, drag and drop, or multi-step interaction is the point.

Treat automated review findings as claims to verify against source code. Fix real problems. Do not change correct code merely to satisfy a mistaken bot comment.

## Taste

Use the smallest model that solves the current problem.

Prefer explicit state transitions over inferred magic.

Do not create speculative frameworks for providers, workers, channels, memory, evals, long tasks, or deployment modes that the current plan does not need.

Reuse mature upstream code and patterns when they solve the problem well.

The UI must not lie. A spinner means work is pending. Success means underlying work completed. Waiting means the system has durable knowledge of what it is waiting for. Resume means execution actually resumed from persisted state. Delegated means a real Worker job exists and can be inspected.

Avoid `any` when TypeScript can express the boundary. Validate unknown external data when it enters the system.

Comments should explain intent, constraints, provenance, or non-obvious behavior. Do not narrate obvious code.

If a rule here becomes wrong because the product changed, update the rule instead of working around it silently.