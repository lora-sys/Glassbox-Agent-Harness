# Glassbox Agent Operations

Status: CURRENT DIRECTION

This document defines the bidirectional operations boundary between the Glassbox main Agent and Herdr-managed coding workers.

The active implementation source of truth remains `.plans/03-personal-agent-foundation.md`.

## Decision

Herdr is the live Agent Operations execution layer for coding work.

Glassbox remains the product control plane and source of durable task truth.

The target shape is:

```text
User through QQ / Workbench
        ↓
Glassbox Main Agent
        ↓
Attention Queue + Task Registry
        ↓
Glassbox Ops Tools
        ↓
Herdr Bridge
        ↓
Herdr
  workspace
  worktree
  tab
  pane
  coding Agent
        ↓
Herdr event stream
        ↓
Ops Reconciler
        ↓
TaskAttempt + WorkerBinding + AttentionItem
        ↓
review / rework / accept
        ↓
Trace + notification
```

The user should increasingly be able to talk to one main Agent while that Agent knows how much work exists, what is currently running, what is blocked, and what needs review.

## Authority split

Glassbox owns:

```text
Task identity
Task status
priority
acceptance criteria
Attention Queue
TaskAttempt history
WorkerBinding history
authorization
review and acceptance
rework decisions
Conversation linkage
Run linkage
durable state
Raw Trace and evidence
```

Herdr owns live execution facts:

```text
session
workspace
worktree
tab
pane
terminal process
recognized Agent identity
Agent lifecycle state
live pane / Agent output
```

Herdr state is not product truth.

```text
Herdr agent = done
≠
Glassbox Task = DONE
```

The normal mapping is:

```text
Herdr working
→ TaskAttempt running

Herdr blocked
→ Task waiting for input when the attempt really requires input
→ AttentionItem(worker_blocked)

Herdr done
→ Task moves to REVIEW
→ AttentionItem(task_review)

Glassbox review ACCEPT
→ Task DONE

Glassbox review REWORK
→ preserve previous TaskAttempt
→ create or resume another attempt
```

Pi's native Herdr integration reports `working`, `idle`, and `blocked`. For a Pi attempt, an `idle` observation can enter REVIEW only after Glassbox has persisted a `working` observation for that same attempt and the previous observed state is `working`. An initial idle pane is not evidence of completed work. Raw Trace retains the reported `idle` state. This mapping never accepts a Task or marks it DONE.

## Core domain

### AttentionItem

Represents something that needs action now.

Minimum kinds:

```text
unanswered_message
worker_blocked
approval_required
task_review
task_failed
delivery_failed
ops_connection_problem
```

### Task

Minimum P3 state machine:

```text
NEW
→ QUEUED
→ ASSIGNED
→ RUNNING
→ WAITING_INPUT
→ REVIEW
  ├─ ACCEPTED → DONE
  └─ REWORK → RUNNING

FAILED
CANCELED
```

P3 Task is intentionally smaller than the future LongTask model.

### TaskAttempt

One real execution or rework attempt. Never overwrite prior attempts to make a later attempt look like the original run succeeded.

### WorkerBinding

Maps one TaskAttempt to its Herdr execution location.

```text
TaskAttempt
  ↓
WorkerBinding
  herdrSession
  workspaceId
  tabId?
  paneId
  worktreePath?
  branch?
  agentName?
  agentKind
  lastObservedAgentState
```

### AgentOpsSnapshot

Compact operational projection for the main Agent.

Example shape:

```text
attention
  total
  unansweredMessages
  approvals
  blockedWorkers
  awaitingReview
  failures

tasks
  open
  queued
  running
  waiting
  review
  doneToday

workers
  total
  working
  blocked
  idle
  done
  unknown
```

Do not inject the full task registry into every main-Agent prompt. Inject a small summary and expose detail through Ops Tools.

## Herdr integration

Glassbox uses a product-owned `HerdrBridge`.

For simple shell scripts and diagnostics, Herdr CLI wrappers are acceptable.

For Glassbox's long-lived integration, use the local socket API for request/response control and lifecycle subscriptions.

Do not parse the rendered Herdr TUI as the primary protocol.

Conceptual bridge:

```text
connect
disconnect
getSnapshot
subscribe
createWorktree
openWorktree
startAgent
promptAgent
waitAgent
readAgent
sendAgentKeys when deliberate UI interaction is required
stop or cancel through explicit authorized action
```

Use the protocol schema reported by the installed Herdr version when implementing or updating the bridge.

## Bootstrap and reconnect

Herdr `session.snapshot` is a one-time state bootstrap. Lifecycle subscriptions do not replay all events from before the subscription.

To avoid a bootstrap gap:

```text
open event subscription connection
→ events.subscribe
→ wait for acknowledgement
→ request session.snapshot
→ reconcile snapshot with durable WorkerBindings / TaskAttempts
→ process later events
```

After connection loss, repeat snapshot reconciliation.

A monitoring gap must not silently change a Task to DONE or FAILED.

When state cannot be observed, represent it as stale or unknown until reconciliation establishes a new fact.

## Main Agent Tool boundary

The main Pi Agent should not receive raw unrestricted Herdr terminal control from QQ.

P3 minimum Glassbox Ops Tools:

```text
ops_status
task_list
task_get
task_create
task_delegate
worker_status
worker_read
worker_prompt
task_accept
task_rework
task_cancel
```

Every Tool is a protected Glassbox Action.

Authorization evaluates the current Principal, location, Task or worker Resource, requested operation, and result audience.

Remote users do not inherit Owner operations merely because the main Agent can control Herdr.

### Pi Worker file tools

The current remote Pi Worker launch disables built-in tools and enables only `worker_list_files`, `worker_read_file`, and `worker_write_file` through a Glassbox Extension. The server creates an immutable per-attempt context outside the Worker directory. It contains the caller, TaskAttempt, authorized directory, workspace Resource, and the file Actions allowed when delegation began. The model cannot choose these values.

Each operation checks the current Glassbox grant and active TaskAttempt before touching a file. A later grant cannot expand an existing attempt's delegated Action set. Revocation and Task termination prevent subsequent access. Reads and writes use relative paths inside the configured directory. Symlinks, hardlinks, private runtime directories, service state, and traversal paths are rejected. Tool evidence records the Action, Resource, decision ID, attempt, and outcome without copying file contents or denied input into Raw Trace.

These tools do not execute generated code. The current acceptance uses an independent host test run before Accept. A future process-execution tool must have its own enforceable permissions; restoring built-in bash would bypass this boundary. The per-attempt Extension reads the same local durable database as Glassbox, so this configuration requires Glassbox and Herdr on the same host.

Each Worker starts in a new focused Herdr tab. This gives Pi a usable terminal size and keeps attempts in separate panes. Repeated horizontal splitting can reduce terminal width until Pi cannot render. Tab focus is a launch detail and does not change Task authority or acceptance.

## herdr-workflows

`aorumbayev/herdr-workflows` is useful for bounded linear stage recipes.

Example:

```text
implement
→ run tests
→ run review command
```

It is not the durable task database and does not own the review/rework loop.

Glassbox decides whether the result is accepted.

## Main Agent behavior

The main Agent should be able to answer operational questions from product state rather than guessing from conversation history.

Examples:

```text
How many tasks are open?
Which workers are blocked?
What is waiting for review?
Which QQ messages still need a response?
Where is task-123 running?
What did the worker return?
Why is this task waiting?
```

A user request may be handled in one of several ways:

```text
answer synchronously
create an AttentionItem
create a Task
request approval
delegate a Task to Herdr
review completed work
request rework
send a final authorized response
```

Do not force every user message to become a durable Task.

## Deployment invariant

Development happens locally, but the production target is a server.

Target host shape:

```text
Linux server
  Glassbox server
  Pi SDK + Lora PI Kit
  NapCat
  Herdr session server
  coding Agents and worktrees
  durable state
```

Glassbox and Herdr normally communicate through the local host control boundary.

A human may connect remotely over SSH. Moshi may act as a remote Herdr client and operational viewport, but Moshi is not required for product correctness and its UI state is not persisted as Glassbox domain state.

The same contracts must work locally and on the server:

```text
Task
TaskAttempt
WorkerBinding
AttentionItem
HerdrBridge
OpsReconciler
Authorization
Trace
```

Avoid hardcoded development-machine paths and desktop-only dependencies.

## Security rules

Herdr is a high-authority execution surface.

Do not let Channel input turn into unrestricted terminal authority.

At minimum:

```text
Ops Tools are server-side authorized
worker_read is scoped
worker_prompt is scoped
task_delegate is scoped
cancel / stop is explicit
worktree removal is explicit
Task result visibility is enforced
Worker output cannot bypass Delivery Gate
```

The rule remains:

```text
worker_permissions ⊆ delegated_permissions ⊆ caller_permissions
```

P3 may use a trusted Owner coding-worker profile with broad repository tools in an isolated worktree. That does not make those tools available to arbitrary QQ Principals.

## Testing

Most product tests use `FakeHerdrBridge` and deterministic Herdr events.

Focused integration tests use a real disposable Herdr session and repository.

Test at least:

```text
snapshot bootstrap
event subscription
working projection
blocked attention
done → review
accept
rework
prior attempt preserved
connection loss
reconnect snapshot reconciliation
worker disappears
wrong pane / replacement Agent
unauthorized worker_read
unauthorized worker_prompt
Ops Tool denial Trace
Task state survives Glassbox restart
```

P3 real acceptance includes at least one real supported coding Agent managed by Herdr.

## Later evolution

P3 proves the minimum operations loop.

The later LongTask phase adds richer durability and orchestration:

```text
dependency DAG
checkpoints
retry policy
signals
child tasks
continuations
leases / heartbeats
large-scale worker scheduling
```

Do not build those mechanisms in P3 unless a current completion-gate requirement proves they are necessary.
