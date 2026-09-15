# Herdr source index

Primary reference project: `herdrdev/herdr`

Pinned upstream commit: `32503f81f7f22552d86f048afb3de179f44e049a`

Upstream branch at review time: `master`

License: Apache-2.0.

Workflow reference project: `aorumbayev/herdr-workflows`

Pinned workflow commit: `3a218fce44f73caf6045b01d4e0628d8b06c6cfe`

Plan 03 uses Herdr as the live Agent Operations execution layer for coding workers. Glassbox remains the product control plane and source of durable Task truth.

## Why Herdr matters

Herdr provides the execution facts Glassbox should not recreate:

```text
persistent session server
workspace / tab / pane topology
Git worktree lifecycle
real terminal processes
recognized coding Agents
Agent lifecycle state
Agent prompt / wait / read control
local socket API
lifecycle event subscriptions
session snapshot
remote attach over SSH
```

The Glassbox relationship is:

```text
Glassbox Main Agent
        ↓
Task Registry + Attention Queue
        ↓
HerdrBridge
        ↓
Herdr workspace / worktree / pane / Agent
        ↓
Herdr events
        ↓
OpsReconciler
        ↓
Glassbox TaskAttempt / WorkerBinding / Trace
```

## Source paths and docs to consult

| Upstream source | What to study |
| --- | --- |
| `https://herdr.dev/docs/socket-api/` | raw socket methods, `session.snapshot`, `events.subscribe`, worktree and Agent control |
| `https://herdr.dev/docs/agent-automation/` | Agent start, prompt, wait, read, pane/Agent distinction and automation recipes |
| `https://herdr.dev/docs/agents/` | supported Agent detection and lifecycle authority |
| `https://herdr.dev/docs/session-state/` | persistence, detach, restart, restore semantics |
| `https://herdr.dev/docs/remote/` and connecting-machine docs | remote server / SSH operating model |
| `skills/herdr/SKILL.md` | official Agent-facing Herdr operation skill |
| Herdr protocol schema from `herdr api schema --json` | authoritative schema for the installed Herdr binary |

Prefer the public protocol and installed schema over internal Rust implementation details.

## Socket integration rule

Use CLI wrappers for simple scripts and debugging.

Use the raw local socket API for the long-lived Glassbox integration because Glassbox needs direct request/response control and event subscriptions.

Herdr documents `session.snapshot` as a one-time bootstrap snapshot. Event subscriptions do not replay earlier lifecycle events.

The Glassbox bootstrap order is therefore:

```text
connect event stream
→ events.subscribe
→ wait for subscription acknowledgement
→ session.snapshot
→ reconcile durable WorkerBindings / TaskAttempts
→ process later events
```

Repeat snapshot reconciliation after reconnect.

## Methods relevant to P3

The public Herdr surface currently includes methods in these areas:

```text
session.snapshot

events.subscribe
events.wait

workspace.create / list / get / close
worktree.list / create / open / remove
pane.list / get / read / send input / wait for output
agent.list / get / read / prompt / wait / start / focus
```

Do not depend on every method at once. Implement the smallest `HerdrBridge` required by the active P3 slice.

## Product-state rule

Herdr facts are execution observations.

They do not become Glassbox Task truth automatically.

```text
Herdr working
→ TaskAttempt may be RUNNING

Herdr blocked
→ may create AttentionItem(worker_blocked)

Herdr done
→ Task normally enters REVIEW
→ not automatic Task acceptance
```

Glassbox owns:

```text
Task
TaskAttempt
AttentionItem
WorkerBinding
acceptance criteria
review
rework
priority
authorization
Conversation linkage
Trace
```

Do not store the canonical Glassbox Task database in Herdr plugin state, pane metadata, workspace names, or worktree branch names.

## Security rule

Herdr is a high-authority execution surface.

Do not expose raw terminal control to arbitrary QQ callers.

Glassbox provides explicit authorized Ops Tools such as:

```text
ops_status
task_delegate
worker_status
worker_read
worker_prompt
task_accept
task_rework
task_cancel
```

Each operation must resolve the current Principal, protected Task / worker Resource, location, action, and result audience.

Worker output remains protected data and cannot bypass Glassbox Context or Delivery gates.

## herdr-workflows

`aorumbayev/herdr-workflows` is an approved helper for bounded linear workflow recipes.

At the pinned review point it sequences workflow steps such as:

```text
agent
run
herdr
workflow
```

Glassbox may use it for a stage recipe such as:

```text
implement
→ test
→ review command
```

It must not become the durable Task state machine.

Glassbox owns:

```text
review decision
acceptance
rework
cross-attempt history
priority
Task completion
```

## Local-to-server rule

P3 is tested locally, but the intended production host is a Linux server running Glassbox and Herdr close to the coding work.

Do not design the integration around desktop-only UI state.

Human remote clients such as Moshi may attach to Herdr over SSH for inspection and intervention. Moshi is an operational client, not a Glassbox source of truth.

## Vendoring rule

Do not vendor the whole Herdr repository.

Use the public API and installed binary first.

If a concrete future task needs a source slice:

- pin the source commit
- record the original path
- preserve Apache-2.0 requirements
- copy only the smallest required mechanism
- keep Herdr protocol quirks behind `HerdrBridge`
- bring focused tests when upstream behavior encodes important edge cases

Production Glassbox code must not import from `upstream/herdr/`.
