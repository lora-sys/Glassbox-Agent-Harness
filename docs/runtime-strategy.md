# Glassbox runtime strategy

Status: CURRENT DIRECTION

This document defines the ownership boundary between Glassbox, Pi, Lora PI Kit, Herdr, and other execution runtimes.

The active Plan 03 implements the first real Pi path, QQ closed loop, and minimal Agent Operations loop. The current implementation source of truth remains `.plans/03-personal-agent-foundation.md`.

For the Herdr-specific Task / Attention / Worker boundary, also read [`agent-operations.md`](./agent-operations.md).

## Decision

Glassbox remains the product and trust boundary.

Pi is the primary runtime foundation for the active Personal Agent path.

Lora PI Kit is the owned configuration and extension layer that adapts Pi to the maintainer's workflow.

Plan 03 embeds Pi through the public SDK inside the Glassbox Node.js server. It does not use RPC as the primary integration path.

Herdr is the live Agent Operations execution layer for coding workers. It manages real terminal workspaces, worktrees, panes, and coding-Agent lifecycle facts. It does not replace Glassbox Task truth or authorization.

Codex and Claude Code remain supported execution runtimes where they provide useful compatibility, specialist behavior, fallback, worker execution, or differential Eval coverage.

The intended direction is:

```text
QQ / Workbench / future Channels
        |
        v
Glassbox
  identity
  authorization
  conversation
  task / attention
  persistence
  trace
  delivery policy
        |
        +-----------------------------+
        |                             |
        v                             v
Glassbox Runtime Boundary       Agent Operations Boundary
        |                             |
        |                             v
        |                         HerdrBridge
        |                             |
        |                             v
        |                           Herdr
        |                    workspace / worktree / pane
        |                    Pi / Codex / Claude workers
        |
        +-------------------+-------------------+
        |                   |                   |
        v                   v                   v
Pi SDK + Lora PI Kit     Codex              Claude Code
primary main-Agent path  adapter             adapter
        |
        v
upstream Pi
```

Glassbox is not a Pi wrapper. Pi is not the Personal Agent identity.

Herdr is not the Personal Agent identity and is not the durable Task database.

## Ownership

Glassbox owns product semantics that must stay stable even if execution runtimes or worker hosts change:

```text
Agent identity
User and Principal
Channel identity resolution
Authorization
Ingress policy
Authorized Context
Conversation
Audience and Delivery policy
Task
TaskAttempt
AttentionItem
WorkerBinding
review / rework / acceptance
Durable product state
Run identity
Raw Trace and authorization evidence
Memory and Asset visibility rules
Workbench and public product APIs
```

Lora PI Kit owns reusable Pi customization:

```text
Pi extensions
Pi package manifest
selected skills
prompt templates
runtime presets
model and thinking profiles
observability hooks
notification hooks
project bootstrap
compatibility checks
install, update, and doctor scripts
```

Herdr owns live execution facts and process topology:

```text
Herdr session
workspace
tab
pane
worktree
terminal process
recognized coding Agent
Agent lifecycle state
live pane / Agent output
```

Upstream Pi owns its runtime, Agent loop, package system, Extension API, tool execution primitives, model support, TUI, SDK, and RPC behavior.

Existing Codex and Claude Code adapters keep runtime-specific protocol behavior close to those integrations.

NapCat and OneBot transport belong to the Glassbox QQ Channel boundary, not Lora PI Kit.

## Runtime and Agent Operations are different boundaries

A runtime executes one Agent session or Run.

Agent Operations coordinates multiple pieces of work and multiple live coding workers.

Do not collapse these concepts:

```text
Pi Session ≠ Conversation
Run ≠ Task
Task ≠ Worker
TaskAttempt ≠ Herdr pane
Herdr Agent state ≠ Task acceptance state
Runtime ≠ Agent Operations
```

The main Personal Agent runs through Pi SDK in Glassbox.

A delegated coding Task may run through a Herdr-managed Pi, Codex, Claude Code, or another supported coding Agent.

The worker runtime does not become a second Personal Agent identity.

## Lora PI Kit is a separate owned layer

Do not copy Pi source into Glassbox to create Lora PI Kit.

The repository boundary is:

```text
earendil-works/pi
      |
      | upstream releases and public APIs
      v
lora-sys/lora-pi-kit
      |
      | configured Pi capabilities
      v
Glassbox Pi SDK integration
```

Plan 03 creates `lora-sys/lora-pi-kit` during the P3.1 slice. The first kit is deliberately small and exists only to support the closed loop.

Pi packages can bundle extensions, skills, prompt templates, and themes. Lora PI Kit should use that package mechanism first. Global or project settings stay in the Pi configuration layer and should be installed or generated by the kit's bootstrap tooling.

The existing `lora-sys/skills` repository remains the canonical source for reusable Agent Skills. Lora PI Kit may select or install those skills, but should not duplicate their source by default.

## SDK first, core patch last

Plan 03 integrates through `@earendil-works/pi-coding-agent`.

Use public SDK surfaces such as:

```text
createAgentSession
createAgentSessionRuntime when replacement is required
ModelRuntime
SessionManager
DefaultResourceLoader
Extension API
customTools
session events
```

When Lora PI Kit needs a capability, use this order:

```text
Pi setting or project config
Pi package resource
Pi Skill
Pi Extension
custom Tool
Pi SDK integration
small upstream contribution
local core patch only when no supported boundary can implement the requirement
```

RPC remains a supported upstream capability but is not the primary Glassbox P3 path.

A core patch must have a concrete failing requirement and a compatibility test. Do not fork Pi merely to change defaults or add workflow behavior that the package, Extension, Tool, or SDK boundaries already support.

If a core patch becomes necessary, keep it small and record:

```text
upstream commit
patch purpose
why settings, package, Skill, Extension, Tool, or SDK was insufficient
test that proves the requirement
rebase or removal condition
```

## Herdr integration boundary

Glassbox integrates Herdr through a product-owned `HerdrBridge`.

For simple scripts and diagnostics, Herdr CLI wrappers are acceptable.

For the long-lived product connection, use the local socket API for direct request/response control and lifecycle subscriptions.

Do not parse Herdr's rendered TUI as the primary protocol.

The bridge should expose only the operations Glassbox needs, for example:

```text
connect / disconnect
get session snapshot
subscribe to lifecycle events
create or open worktree
start coding Agent
prompt coding Agent
wait for Agent state
read Agent output
send deliberate Agent keys when required
cancel through explicit authorized action
```

Herdr state is reconciled into Glassbox projections. It does not directly write Task truth.

Example:

```text
Herdr working
→ WorkerBinding observed state = working
→ TaskAttempt may be RUNNING

Herdr blocked
→ AttentionItem(worker_blocked)
→ Task may become WAITING_INPUT

Herdr done
→ TaskAttempt execution settled
→ Task enters REVIEW
→ not automatic DONE
```

Review / rework / acceptance remain Glassbox Actions.

## Herdr bootstrap and reconnect

Herdr `session.snapshot` is a one-time state bootstrap. Event subscriptions do not replay all lifecycle events from before the subscription.

To avoid an event gap:

```text
open event subscription connection
→ events.subscribe
→ wait for acknowledgement
→ request session.snapshot
→ reconcile snapshot against durable WorkerBindings and TaskAttempts
→ process later events continuously
```

After reconnect, repeat snapshot reconciliation.

Connection loss is an observation problem. Do not infer Task completion or failure only because Herdr cannot currently be observed.

## Upstream references are evidence, not product code

The repository `upstream/` directory stays read-only reference material.

Pi belongs there as the primary runtime reference. Herdr, T3 Code, OpenHarness, OpenSquilla, Token Monitor, NapCat, OneBot, AGY, Inspect AI, and other projects remain mechanism references for specific boundaries.

The relationship is:

```text
upstream references
      |
      | research and selective ports
      v
Lora PI Kit or Glassbox-owned boundary
      |
      v
production behavior
```

Production code must not import from `upstream/`.

A mechanism that belongs to Pi workflow customization should land in Lora PI Kit.

A mechanism that changes Glassbox identity, authorization, Conversation, Channel behavior, durable state, Task truth, audience policy, or evidence stays in Glassbox.

Herdr-specific protocol behavior stays behind `HerdrBridge`.

## Runtime boundary

Glassbox exposes one product-owned execution contract above concrete runtimes.

The contract normalizes only what Glassbox needs, for example:

```text
start or resume execution
send authorized user input
receive normalized events
request approval
stop or cancel
usage metadata
runtime health
runtime identity and capabilities
```

Do not force every runtime to pretend it has identical tools, sessions, permissions, or lifecycle behavior.

Runtime-specific behavior remains inside the corresponding adapter.

## Agent Operations Tool boundary

The main Pi Agent interacts with Task and Herdr operations through Glassbox Tools.

P3 minimum surface includes concepts such as:

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

These are protected product Actions.

A QQ caller does not gain raw terminal authority merely because the main Agent can operate Herdr.

Do not expose unrestricted Herdr `pane.send_input`, arbitrary worktree deletion, or unrelated pane reads as generic remote capabilities.

## Security rule

Glassbox authorization always wins.

Pi extensions, skills, prompts, runtime settings, Codex configuration, Claude Code configuration, Herdr state, Herdr plugins, workflow recipes, and future workers cannot expand the caller's Glassbox permissions.

Plan 03 uses four unavoidable server-side gates:

```text
Ingress Gate
Context Gate
Tool Gate
Delivery Gate
```

Every protected decision must carry enough structured context to answer:

```text
Who is acting?
Where are they acting?
What are they trying to do?
How will it be done?
Which resource is involved?
Who will receive the result?
Which Conversation and Run does this belong to?
```

The trusted order is:

```text
receive Channel event
-> resolve Principal and location
-> Ingress Gate
-> resolve Conversation
-> Context Gate
-> build authorized model Context
-> invoke Pi SDK
-> Tool Gate on protected execution or Ops action
-> direct execution or authorized Task delegation
-> produce result with visibility provenance
-> Delivery Gate for target audience
-> deliver
-> record evidence
```

Runtime configuration and Herdr topology never become authorization sources.

QQ group execution does not inherit Owner-private visibility merely because the Owner sent the message.

Worker output cannot bypass the same visibility and Delivery rules as Tool output.

The delegation invariant remains:

```text
worker_permissions ⊆ delegated_permissions ⊆ caller_permissions
```

## Current phase

Plan 03 is `QQ Personal Agent Closed Loop` with a minimal Herdr-backed Agent Operations foundation.

It deliberately combines the trusted foundation, first real runtime and Channel, and the smallest useful multi-worker control loop:

```text
Deterministic test environment
-> Lora PI Kit MVP
-> Pi SDK Runtime
-> Identity + four hard authorization gates
-> scope-based Conversation + Turso
-> Herdr Agent Ops Foundation
-> NapCat / OneBot QQ Channel
-> private chat + group chat
-> direct answer or delegated Task
-> worker status + review + rework
-> Trace + restart + dedupe + reconciliation
-> real QQ + Herdr acceptance
```

Plan 03 uses a strict QQ Tool allowlist. Generic unrestricted shell execution is not exposed through the remote QQ profile.

Codex and Claude Code remain available as compatibility, regression, and worker paths while Pi becomes the primary Personal Agent runtime.

P3 Agent Operations remains deliberately small. Complex DAGs, checkpoints, generalized retry policy, child tasks, and large-scale durable workflow semantics stay in the later LongTask phase.

## Local test to server deployment

P3 is developed locally, but production is expected to run on a server.

Target host shape:

```text
Linux server
  Glassbox server
  Pi SDK + Lora PI Kit
  NapCat
  Herdr session server
  coding Agents / worktrees
  durable state
```

When Glassbox and Herdr are on the same host, keep their integration on the local host control boundary.

A human may attach over SSH. Moshi may be used as a remote Herdr client and operational viewport, but Moshi state is not required for product correctness.

Do not bake developer-machine absolute paths, local GUI state, or Herdr sidebar presentation into product state.

The same contracts must work locally and on the server:

```text
Authorization
Conversation
Task
TaskAttempt
AttentionItem
WorkerBinding
HerdrBridge
OpsReconciler
Trace
```

## Migration rule

Do not perform a blind big-bang rewrite of unrelated runtime code.

Implement the P3 Pi, QQ, and Herdr paths as vertical closed loops, preserve existing useful adapters, and move shared behavior only when the new path proves the required contracts.

P3 acceptance is based on task success, authorization invariants, non-leak canary tests, Conversation restart behavior, Task / worker reconciliation, Trace quality, QQ transport correctness, and delivery correctness.