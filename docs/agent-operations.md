# Glassbox Agent Operations

Status: CURRENT IMPLEMENTATION AND BOUNDARIES

This document describes Glassbox Task operations, durable long-work orchestration, and the boundary with Herdr-managed coding Workers.

The implementation record is [the durable long-work plan](../.plans/06-durable-long-work.md). [Issue #24 closeout](../.plans/issue-24-closeout.md) tracks the remaining real QQ Worker acceptance, and [the Linux migration runbook](linux-runtime-migration.md) tracks Issue #30 acceptance. Plan 03 remains the completed P3 foundation record. Implementation availability does not establish those acceptance results.

## Decision

Herdr is the live Agent Operations execution layer for coding work.

Glassbox remains the product control plane and source of durable task truth.

The operations loop is:

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

Pi's native Herdr integration reports `working`, `idle`, and `blocked`. For a Pi attempt, an `idle` observation can enter REVIEW only after Glassbox has persisted a `working` observation for that same attempt. Monitoring gaps marked `unknown` do not erase that evidence; `blocked` does not count as completed work. An initial idle pane is not evidence of completion. Durable Worker observations atomically retain the working-to-idle completion evidence in append-only Raw Trace, separately from the latest displayed Worker state. Repeated management observations and a database reopen cannot consume that evidence before the authorized Temporal owner captures the result and settles the Step. Newer working observations supersede an older idle observation. This mapping never accepts a Task or marks it DONE.

For a durable Herdr Step, Glassbox records the first terminal Worker output against its live TaskAttempt and WorkerBinding before the Step enters REVIEW. The stored candidate is immutable. It contains a SHA-256 digest of the bounded read and at most 16 KiB of terminal excerpt. The Step holds an opaque `worker-result` reference. A later read requires that exact Step and Attempt to be in review or succeeded state and checks current Task and Worker read grants, read grants for every declared file and workspace source, and protected sources from the Task's planning Run and ancestor Tasks. This permits review after Herdr closes the pane without exposing a captured output before Step settlement. After Step acceptance, a directly dependent Model Step can receive a bounded excerpt, including one from an accepted child Task's Worker root. The receiving Run rechecks the source grants and records them for delivery review. The excerpt is untrusted evidence, not a verified file artifact, and does not accept the Step or Task.

If Glassbox observes the same Worker resume work after its first output capture, it appends a candidate-invalidation marker to that attempt's observation Trace. The original candidate and declared file remain immutable, including across restart. A later completion cannot expose or reuse them for review. The Temporal owner records `worker-output-stale-rework-required`, blocks the Step, and quarantines its lease. The existing verified pane-closure path must release the old Worker before an authorized explicit Step Rework creates a new attempt and fresh candidate. First capture compares the current binding state, observation timestamp, and append-only observation sequence inside its write transaction. A changed observation prevents insertion, including a working-to-idle cycle within one timestamp. Settlement checks candidate invalidation again in its transaction. These checks never accept a Step or Task.

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

Task-level state machine:

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

The Task remains the product-level work record. A Task with `orchestrationMode: "durable"` also has a versioned Step graph, a root Step, active Step IDs, a current phase, a waiting reason, and a policy revision. Step state and TaskAttempt state do not replace Task-level review and acceptance.

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

Glassbox currently passes the configured `worktreePath` and `branch` through to Herdr and records
them in WorkerBinding. It does not create a branch or worktree for each TaskAttempt. Herdr owns the
execution workspace. The fixed worker target does not route each Task to a distinct worktree, so
concurrent coding Tasks against one configured target are not isolated by this integration.

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

The current interface is [`HerdrBridge`](../apps/server/src/ops/herdr-bridge.ts):

```text
connect / disconnect / isConnected
subscribe / unsubscribe
getSnapshot
startAgent
promptAgent
readAgent
waitAgent
stopAgent
closeAgent
closePreAgentPane
```

`startAgent` accepts a configured workspace, Agent kind, optional stable Agent name, worktree path, branch, and Worker context file. It returns the pane ID, Agent name, and optional runtime evidence. `closeAgent` checks the recorded Agent and session identity. `closePreAgentPane` handles an interrupted launch only after exact session, workspace, pane, Agent marker, Tab label, and directory checks, followed by proof that the pane is absent. Stop and close remain explicit authorized operations.

The interface does not create or open worktrees and does not expose arbitrary key injection. Use the protocol schema reported by the installed Herdr version when implementing or updating the bridge.

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

Both legacy and durable observations compare the original event or snapshot timestamp with the persisted binding timestamp under the database transaction. A buffered event older than the bootstrap or reconnect snapshot cannot change Task state. Legacy reconciliation also carries the exact binding and attempt identity into that transaction, so a replacement attempt cannot receive an earlier binding's observation.

Join barriers and overdue timers perform no external work. If an Activity stops after their running transition commits, the next advance completes the same Step without recording a second start. Cancellation settles these running Steps without waiting for a Worker that does not exist. These recoveries do not apply to Model, Tool, or Herdr Steps, whose side effects still require their existing attempt, lease, and outcome evidence.

A monitoring gap must not silently change a Task to DONE or FAILED.

When state cannot be observed, represent it as stale or unknown until reconciliation establishes a new fact.

## Main Agent Tool boundary

The main Pi Agent should not receive raw unrestricted Herdr terminal control from QQ.

[`OPS_TOOL_NAMES`](../apps/server/src/runtime/pi/ops-tools.ts) defines 20 Glassbox Ops Tools. A Run receives only the subset selected by its current authorization and capability policy.

```text
ops_status
task_list
task_get
task_create
worker_status
task_delegate
worker_read
task_worker_result
worker_prompt
task_accept
task_rework
task_step_accept
task_step_rework
task_signal
task_approve
task_cancel
task_steps
task_events
task_plan
task_link_child
```

`task_worker_result` reads captured evidence for an exact Step and Attempt. `task_steps` and `task_events` inspect the graph and append-only Task history. `task_plan` creates the bounded graph; `task_link_child` links a separate child Task. Step accept and rework require the expected Step version. Signal and approval target the current waiting Step version and require separate `task:signal` or `task:approve` authority. The model never supplies the Principal, origin routing, filesystem root, Herdr workspace, or Worker kind.

Every Tool is a protected Glassbox Action.

Authorization evaluates the current Principal, location, Task or worker Resource, requested operation, and result audience.

Remote users do not inherit Owner operations merely because the main Agent can control Herdr.

### Pi Worker file tools

The current remote Pi Worker launch disables built-in tools and enables only `worker_list_files`, `worker_read_file`, and `worker_write_file` through a Glassbox Extension. The server creates an immutable per-attempt context outside the Worker directory. It contains the caller, TaskAttempt, authorized directory, workspace Resource, and the file Actions allowed when delegation began. The model cannot choose these values.

Each operation checks the current Glassbox grant and active TaskAttempt before touching a file. A later grant cannot expand an existing attempt's delegated Action set. Revocation and Task termination prevent subsequent access. Reads and writes use relative paths inside the configured directory. Symlinks, hardlinks, private runtime directories, service state, and traversal paths are rejected. Tool evidence records the Action, Resource, decision ID, attempt, and outcome without copying file contents or denied input into Raw Trace.

For a workspace-bound Pi Worker, Glassbox resolves the configured Herdr directory to exactly one registered product workspace. The caller must hold the corresponding product workspace grant. A write-capable attempt acquires the durable workspace write occupancy shared with main Agent Runs before launch. Every write checks the original lease. Herdr pane closure and a confirming snapshot are required before release. A failed close, disconnected Herdr session, or server restart keeps the lease quarantined. The Worker cannot regain write permission from a stale context after restart. The lease and its state changes have TaskAttempt Trace evidence.

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

## Human group assignments are separate

A human learning or check-in assignment for group participants is not an Agent Operations Task.

```text
Task
  work performed by the Personal Agent or delegated Worker

GroupAssignment
  work assigned to human group participants
```

Do not reuse TaskAttempt or WorkerBinding to track human completion.

The planned group assignment, reminder, schedule, and report model is defined in `docs/owner-group-operations.md`.

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

Durable Task notifications use a separate outbox linked to an append-only TaskEvent. A Task with an exact external origin Run and audience may enqueue fixed status text. The send claim checks current Task read permission and Run delivery permission, then reserves the one send. A changed audience or stale review state suppresses the notice. An uncertain send remains unknown and is not replayed automatically. Tasks without an external origin Run have no implicit QQ recipient.

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

## Durable long work

Durable long work is implemented alongside the legacy single-Worker path. Glassbox persists its records in the local libSQL/SQLite database. Temporal coordinates wakeups and Activities; it does not own Task truth, authorization, or acceptance.

### Step graph and execution limits

[`packages/contracts/src/long-work.ts`](../packages/contracts/src/long-work.ts) defines `TaskStep`, `TaskEvent`, `TaskWait`, `TaskSignal`, `TaskCheckpoint`, `ChildTaskLink`, `TaskStepLease`, and `TaskWorkflowBinding`.

The supported Step kinds are `model`, `tool`, `herdr_worker`, `timer_wait`, `signal_wait`, `approval_wait`, `child_task`, and `join`. Step statuses are `pending`, `ready`, `running`, `waiting`, `blocked`, `review`, `succeeded`, `failed`, `cancelled`, and `skipped`.

[`task-graph.ts`](../apps/server/src/ops/task-graph.ts) validates dependencies and rejects cycles, missing or duplicate dependencies, and excess fan-out. The default limits are 64 Steps per Task, 8 dependencies per Step, 8 dependents per Step, 16 ready Steps, and 4 parallel running Steps. Admission also limits each Principal to 16 active durable Tasks and 8 unresolved Herdr Worker attempts. Quarantined Worker leases count toward that Worker limit.

[`LongWorkScheduler`](../apps/server/src/ops/long-work-scheduler.ts) computes dependency transitions and persists them with version checks. Each Step declares what a failed, cancelled, or skipped dependency means: continue, block, skip, or cancel. A blocked dependency is treated as failed for this calculation without rewriting its stored evidence. The scheduler completes no-op join barriers; execution of Model, Tool, and Herdr Steps belongs to the runtime path.

The current model-facing planning interface is deliberately bounded. Model Steps are text-only. Tool Steps support only `task_get` and `checkpoint_write`. Herdr Steps use the configured Pi Worker and its delegated file/workspace permissions. Shell Steps and arbitrary protected Tool dispatch are unavailable.

### Claims, leases, and recovery

[`LongWorkStore`](../apps/server/src/ops/long-work-store.ts) claims a ready Step in one transaction before external dispatch. The claim checks the current continuation grant and expected Step version, creates a TaskAttempt and lease, and appends `STEP_STARTED`. A Herdr launch also persists its exact launch identity before sending the start request.

The lease records the owner instance, Attempt, heartbeat, expiry, state, and version. Heartbeat and settlement require the current owner and versions. A replacement Herdr runtime can recover the same Attempt after the old lease expires only after checking the live session, pane identity, directory, prompt acknowledgement, and current authority. Successful transfer records `WORKER_RECOVERED`; an expired lease alone is not permission to launch another Worker.

Unknown side effects leave the Step blocked and its lease quarantined. Verified pane closure or the supported exact-Run/checkpoint reconciliation path must resolve the old claim before further work. Cancellation records durable intent before stopping execution, then settles after the relevant Run or Worker outcome is established. Neither a disconnect nor a stop request proves that side effects were rolled back.

[`long-work-authority.ts`](../apps/server/src/ops/long-work-authority.ts) reconstructs the persisted Task creator and origin scope, verifies their binding, and checks current grants before resumed protected work. A saved graph, checkpoint, workflow, or delegated permission declaration is not a grant.

### Checkpoints, retries, and waits

Checkpoints retain Task, Step, Attempt, state/artifact references, source evidence, and policy revision. Writes check current versions and append `CHECKPOINT_WRITTEN` without replacing older records. Recovery selects the latest checkpoint by event order, with a compatibility fallback for older records. The loaded single-checkpoint projection is bounded to 2,048 serialized bytes. The closed `checkpoint_write` Tool uses a stable operation generation and exact Run/Attempt/lease checks so an uncertain response can be reconciled against the persisted write.

[`long-work-retry.ts`](../apps/server/src/ops/long-work-retry.ts) applies a versioned policy with an attempt limit, capped exponential delay, error-class lists, and timeout outcome. Automatic retry requires evidence that the side effect was `not_started` or `not_applied`. An `applied` effect is not retried; an unknown effect remains unknown. Retry scheduling appends evidence and creates a durable wait rather than erasing the earlier Attempt.

Wait policies cover duration, due time, deadline, signal, approval, and retry. A signal carries the target Step version, optional Attempt, authorization decision, and idempotency key. A duplicate or stale signal cannot advance a newer wait. Approval requires `task:approve`; knowing the signal key is insufficient. Timer and join recovery can finish a previously started no-op Step without inventing another execution Attempt.

### Child Tasks and acceptance

A child link records the parent Step, child Task, exact delegated permission subset, acceptance criteria, cancellation policy, failure policy, and notification policy. `task_link_child` links a pristine same-owner Task to a ready child Step; the child receives its own graph through `task_plan`.

The parent Step waits for the child. Child acceptance moves the Step to review with a result reference. Child failure follows the recorded block, fail, or review policy. Parent cancellation either cancels or keeps the child according to the link. Rework preserves earlier links and Attempts. Accepted child results can supply bounded evidence to a directly dependent Model Step only after current source authorization.

Step acceptance and Task acceptance are separate actions. Model or Worker completion supplies review evidence. It does not automatically mark the Step succeeded or the Task DONE.

### Continuations and Temporal

[`continuation-store.ts`](../apps/server/src/ops/continuation-store.ts) persists schedules, immutable fired occurrences, pending occurrence delivery, and append-only schedule events. Schedules support one occurrence or a bounded interval cadence. A target is only a `task` or `activity` ID; it carries no instructions or authority. Rescheduling changes the generation and version. Cancelling future occurrences preserves occurrences that already fired.

[`AuthorizedContinuationService`](../apps/server/src/ops/continuation-service.ts) exposes Task scheduling, rescheduling, and cancellation under current `task:continue` authority, including a grant check in the write transaction. The current Temporal continuation Activity wakes Task targets and acknowledges their occurrences. Activity targets retain their own policy and consumer boundary. If Temporal is unavailable after a schedule write, the durable mutation remains committed and reports `runtimeReady: false` for later reconciliation.

[`ops/temporal/`](../apps/server/src/ops/temporal/) contains the workflow client, binding store, coordinators, Activities, Herdr runtime, and separate Worker entry point. `longWorkWorkflow` receives only the Task ID and policy revision; `continuationWorkflow` receives only a schedule ID. Activities reload Glassbox state. Workflows wait for the `longWorkWake` signal or a due time and use Continue-As-New after 100 advance iterations. Temporal Activity retries are distinct from the product's side-effect-aware Task retry policy.

The separate Worker runs the `@glassbox/server` package's `long-work:worker` script. It requires `GLASSBOX_TEMPORAL_ADDRESS`, accepts `GLASSBOX_TEMPORAL_NAMESPACE` with default `default`, and uses the `glassbox-long-work` queue. The application reconnects and reconciles persisted bindings. Backend status distinguishes not configured, connected, and unavailable; a successful Temporal Server probe does not prove a Worker is polling the queue.

General protected Tool dispatch, binary or unrestricted Worker file artifacts, and arbitrary unknown-side-effect recovery remain outside this implemented subset. Real Linux, QQ, and history-rollover acceptance must be checked against the plan records. The presence of code and deterministic tests is not deployment acceptance.

## Unconfirmed direct delivery attention

Direct Run delivery preserves execution and transport as separate facts. A successful Run
may have an `unknown` delivery: a timeout, disconnect, or lost acknowledgement does not
prove that QQ did not receive the message. Such deliveries are never automatically replayed
or rewritten as confirmed failure. `RunService.retryDelivery` accepts only confirmed
`failed` deliveries and rechecks current grants and protected content sources.

The direct-delivery settlement transaction creates one durable `delivery_failed` attention
item per failed or unconfirmed delivery. Its fixed summary distinguishes failure from
uncertainty and includes bounded reason codes and Run/delivery identifiers, never the
message payload or provider error text. Authenticated loopback-only `GET /manage/attention`
exposes these items; model-facing scoped Ops snapshots do not acquire this non-Task information.
The final `delivery_changed` Trace event carries the same fixed diagnostic reason. Task
notification Trace events also preserve their transport reason, without creating a new
notification attention workflow.

Startup recovery marks interrupted sends unknown and backfills at most 1,000 missing
attention items per start, prioritizing interrupted sends. Larger legacy backlogs need
additional recovery passes. Existing items, including acknowledged items, are not reopened
by recovery. A new explicit failed delivery attempt can reopen its item; only a confirmed
sent outcome resolves it automatically. Acknowledging attention does not establish delivery.
Unknown delivery currently requires manual inspection of provider or recipient evidence:
there is no receipt-reconciliation action, safe unknown retry API, or guarantee that a new
send would not duplicate an already received message. This addresses visibility and reason
loss in Issue #110; automatic retry of unknown remains unsupported without deduplication or
conclusive post-send evidence.

### Management access boundary

Committed management access checks the remote address against `127.0.0.1`, `::1`, and IPv4-mapped loopback, then checks the allowed Host, optional Origin, and Bearer management token. See [`management/access.ts`](../apps/server/src/management/access.ts).

The [Issue #156 audit](https://github.com/lora-sys/Glassbox-Agent-Harness/issues/156) also described an uncommitted LAN-address allowlist and `0.0.0.0` listener change. Those changes are not part of the committed implementation documented here. If adopted, they require a separate authorization-boundary review and a documentation update in the same change.
