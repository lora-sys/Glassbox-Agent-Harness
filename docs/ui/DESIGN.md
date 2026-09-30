# GlossBox Web Management — DESIGN.md

Status: **DESIGN FREEZE v2 — IMPLEMENTATION CONTRACT**

Canonical visual reference:

- `glossbox_vercel_admin_v24_vercel_compliance.html`

Supporting implementation contracts:

- `UI_PRIMITIVES.md`
- `DESIGN_EVAL.md`

This file defines the product, interaction, visual, data, and audit contract for the GlossBox management Web UI.

---

## 1. Product definition

GlossBox Web Management is the Owner-facing management, observability, audit, and configuration surface for a durable Personal Agent.

It is **not** the primary chat surface.

Conversation remains the primary control entry. The Web Management UI exists to answer:

```text
What is the Agent doing?
What work is waiting?
What ran?
Why did it run?
Which model / Tool / Skill / Memory / worker was involved?
What did it cost?
What authorization decision allowed or denied it?
What needs Owner action?
What is product truth vs live observation?
```

The approved execution hierarchy is:

```text
PI
→ Model
→ Run
→ Trace Event
```

The approved work-coordination hierarchy is:

```text
Conversation
→ Task
→ TaskAttempt
→ WorkerBinding
→ Herdr live worker
```

These hierarchies intersect, but must not be collapsed.

---

## 2. Core product boundaries

Keep these distinctions explicit in product code, contracts, UI labels, and Trace:

```text
Identity ≠ Authorization
Permission ≠ Approval
Channel ≠ Agent
Conversation ≠ Principal
Conversation ≠ PI Session
PI Session ≠ Run
Task ≠ Run
Task ≠ Worker
TaskAttempt ≠ Herdr pane
WorkerBinding ≠ Task truth
Herdr Agent state ≠ Task acceptance
Raw Trace ≠ Derived State
Canvas ≠ Execution State
```

Critical rule:

```text
Herdr worker = done
≠
Glassbox Task = DONE
```

Normal mapping:

```text
Herdr working
→ TaskAttempt RUNNING

Herdr blocked
→ Task may become WAITING_INPUT
→ AttentionItem(worker_blocked)

Herdr done
→ TaskAttempt settles
→ Task REVIEW
→ AttentionItem(task_review)

Authorized Accept
→ Task DONE

Authorized Rework
→ preserve prior attempt
→ create / resume next TaskAttempt
```

---

## 3. Current implementation truth

The UI must distinguish implementation truth from roadmap intent.

Canonical state vocabulary:

```text
已实现
P3 目标
设计数据
后续
未知
```

Definitions:

```text
已实现
  Current repository capability exists.

P3 目标
  Required by the current active P3 plan,
  but must not be presented as already implemented.

设计数据
  Prototype fixture / illustrative data only.

后续
  Roadmap capability outside the active implementation scope.

未知
  The field is meaningful, but the system cannot currently report it.
```

Use:

```text
—
```

only when a field is not applicable.

Never use `$0.00` for unknown pricing.

Never fabricate:

- Token usage
- USD cost
- quota
- model availability
- connection state
- health
- authorization result
- worker state
- Task state

---

## 4. Active P3 product direction

P3 contains two connected closed loops.

### Personal Agent loop

```text
QQ private / group
→ NapCat
→ OneBot 11 Channel Adapter
→ Ingress Gate
→ Identity Resolver
→ Conversation Resolver
→ Authorization Engine
→ Authorized Context Builder
→ PI SDK + Lora PI Kit
→ Tool Gate
→ direct answer OR durable Task
→ Delivery Gate
→ QQ reply
→ durable state + Trace
```

### Agent Operations loop

```text
Conversation / work request
→ Main Agent
→ Attention Queue + Task Registry
→ Ops Tools
→ HerdrBridge
→ Herdr workspace / worktree / pane / coding worker
→ Herdr lifecycle events
→ Ops Reconciler
→ TaskAttempt + WorkerBinding + AttentionItem
→ Review
  ├─ Accept → DONE
  └─ Rework → next attempt
→ Trace + authorized notification
```

PI is the main Agent execution core.

Herdr is the live coding-worker execution layer.

Glassbox remains the product control plane and source of durable Task truth.

---

## 5. Vercel-first visual direction

GlossBox uses a restrained Vercel-style management UI.

### Base surfaces

```text
Canvas        #FAFAFA
Surface       #FFFFFF
Sidebar       #F5F5F5
Ink           #111111
Body          #333333
Secondary     #666666
Metadata      #737373
Border        #EAEAEA
Strong border #D4D4D4
```

### Semantic colors

```text
Brand / Current / Authorization
  warm amber / brown family

Success
  green

Danger / Deny / Error
  red

Interaction focus
  blue

Neutral charts
  black / blue-gray / gray variants
```

Do not use brand amber as a generic second chart series.

### Surface rules

Use:

- thin borders;
- white surfaces;
- 6–10px radii;
- almost no shadow;
- black primary actions;
- tables and lists before card grids;
- comfortable density;
- restrained color.

Avoid:

- glassmorphism;
- decorative gradients;
- giant KPI tiles;
- oversized rounded cards;
- generic AI SaaS styling;
- random blue-purple “AI” palettes;
- dashboard decoration with no management purpose.

---

## 6. Typography

Locked density: **Comfort**.

Chinese stack:

```css
"Noto Sans SC",
"Source Han Sans SC",
"PingFang SC",
"Microsoft YaHei",
system-ui,
sans-serif
```

Latin/UI:

```css
"Geist Sans",
Geist,
system-ui,
sans-serif
```

Technical:

```css
"Geist Mono",
"SFMono-Regular",
Consolas,
monospace
```

Target sizing:

```text
Page title          24–26px
Section title       14–16px
Body                15–16px
Table body          13–14px
Table header        11–12px
Button / Tab        12–13px
Metadata            11–12px
Technical micro     10–11px minimum
```

Avoid large areas of 8–9px text.

Metadata must remain readable, not merely subtle.

---

## 7. Focus and accessibility

Keyboard focus is a separate interaction semantic.

Use:

```text
Focus ring → blue
Selected/current → brand amber
Authorization / warning → semantic amber
```

Do not use brand amber as the global focus ring.

Requirements:

- every interactive element has visible focus;
- icon-only buttons have an accessible name;
- labels use native `for` / `id`;
- switches use native checkbox semantics;
- primary workflows work by click / tap;
- chart meaning never depends on color alone.

Charts must combine:

```text
color
+
line pattern / geometry
+
legend
+
tooltip
+
numeric/table fallback
```

Recommended line semantics:

```text
Primary series     solid
Secondary series   dashed
Tertiary series    dotted
```

---

## 8. Responsive contract

### Desktop

```text
Sidebar: 232px
Detail rail: side-by-side
Dense tables: full management view
Trace: 3 columns
```

### Tablet

```text
Sidebar may compact
Detail rail may move below main content
Tables use local horizontal scroll
Charts reduce secondary annotation
```

### Mobile

```text
Sidebar → Drawer
Top bar contains menu button
Tap targets ≈ 44px minimum
Input text ≥ 16px
Tables scroll locally, not whole page
Master-detail becomes stacked
Trace becomes:
  Run list
  → Timeline
  → Inspector
```

Do not create page-level horizontal scroll.

---

## 9. Locked navigation

```text
工作台
  概览
  会话
  任务协作
  身份与访问
  运行记录
  追踪

PI
  PI
  渠道与集成
  权限
  监控

设置
```

Header:

```text
breadcrumb
repository
branch
P3 state
⌘K
打开对话
```

Do not add a prominent “New Run”.

---

## 10. Global information-order rule

Detail views should follow this reading order whenever applicable:

```text
Identity
→ State
→ Relationships
→ Activity
→ Usage
→ Evidence
```

Examples:

### Run

```text
Run / Conversation / Principal
→ status / model / duration
→ TaskAttempt / WorkerBinding
→ tools / files / tests
→ Token / Cost
→ Trace / Raw Evidence
```

### Task

```text
Task / creator / Conversation
→ Task truth
→ TaskAttempts / WorkerBinding
→ activity / review
→ duration / blocked time
→ evidence
```

This gives every management object a consistent reading model.

---

# PAGE CONTRACTS

## 11. Overview

Purpose:

> Give the Owner a fast operational read.

Overview must remain intentionally shallow.

Primary order:

```text
Key summary
→ Needs attention + Current Run
→ one major usage trend
→ PI Model Usage table
```

Approved key summary:

```text
24h Runs
Total Token
USD Cost
Needs Attention
```

Needs Attention may include:

```text
task_review
worker_blocked
approval_required
unanswered_message
delivery_failed
ops_connection_problem
```

Current Run should show:

```text
Run ID
Conversation
Task / Attempt
PI / Model
Status
Last Event
Token / Cost
```

Do not turn Overview into the most detailed analytics page.

---

## 12. Conversations

Selected layout: **Master-detail**.

Left list supports:

```text
search
channel filter
visibility filter
linked Task filter
```

Conversation list item may show:

```text
title
channel
PI model
visibility
Run count
Task count
Token
Cost
updated_at
```

Right-side facts:

```text
Principal
Channel
Scope
Visibility
PI Session
Runs
Tasks
24h Cost
Last Activity
```

Conversation sections should show their own:

```text
time range
PI / model
Run
Token
Input
Cache Read
Cost
Tool count
```

Execution lineage:

```text
Conversation
→ PI Session
→ Run
→ Task when durable coordination exists
→ Trace
```

Conversation is not a Task.

Do not force every user message into a durable Task.

---

## 13. Sanitized Conversation projection

Management UI displays a screened projection.

Use explicit markers:

```text
[REDACTED]
[REDACTED_ID]
[REDACTED_REPO_PATH]
[SCREENED_PATH]
```

Potentially sensitive data:

- API keys
- secrets
- credentials
- personal external identifiers
- private path data
- protected Tool output
- protected worker output

Raw Trace remains a separate evidence surface.

---

## 14. Task Collaboration

Chinese page name:

```text
任务协作
```

Domain objects:

```text
AttentionItem
Task
TaskAttempt
WorkerBinding
AgentOpsSnapshot
```

Main page structure:

```text
Workload summary
→ Task table
→ Task detail rail
→ Attention Queue
→ live Herdr workers
→ HerdrBridge reconciliation
```

### Task table

Fields:

```text
Task ID
Title
Status
Priority
Attempt
Worker
Updated
```

### Task detail

Must explicitly show:

```text
Glassbox Task truth
Herdr observed state
```

Then:

```text
TaskAttempt
tests
resultRef
review decision

WorkerBinding
Herdr session
workspace
worktree
pane
agent kind

Protected Actions
```

Actions:

```text
Accept
Rework
worker_read
worker_prompt
Cancel
```

Cancel / destructive actions use danger styling.

### AgentOpsSnapshot

Useful counts:

```text
attention.total
tasks.open
tasks.queued
tasks.running
tasks.waiting
tasks.review
tasks.doneToday
workers.total
workers.working
workers.blocked
workers.idle
workers.done
workers.unknown
```

Do not inject the full Task registry into every model prompt.

---

## 15. HerdrBridge reconciliation

Required bootstrap / reconnect sequence:

```text
events.subscribe
→ wait for ACK
→ session.snapshot
→ reconcile against durable WorkerBinding / TaskAttempt
→ consume later events
```

A connection gap means:

```text
stale / unknown observation
```

It must not silently mutate Task truth to DONE or FAILED.

---

## 16. Identity & Access

Purpose:

> Debug who an external identity resolves to, and what relationships that Principal has.

Primary chain:

```text
ChannelIdentity
→ User
→ Principal
```

Show:

```text
verified state
conflict state
last seen
Principal type
linked Conversations
relationships
visibility
relationship source
recent authorization
delegation constraints
```

Selected layout:

```text
identity chain
→ Principal table
→ resource relationships
→ detail rail
```

Useful action:

```text
以此主体测试
```

This should route the selected Principal into a Decision Tester or equivalent simulation, without mutating real policy state.

---

## 17. Runs

Selected layout:

```text
Run table + Detail Rail
```

Main table fields:

```text
Run ID
Work
Principal
Model
Task / Attempt
Tool count
File count
Test result
Token
Status
```

Run Detail has three groups:

```text
摘要
文件与测试
证据
```

### Summary

```text
Conversation
Principal
PI Session
Model
Thinking
Duration
Task
TaskAttempt
WorkerBinding
Input
Output
Cache Read
Reasoning
Cost
```

### Files & Tests

```text
files changed
diff stats
test suites
pass / fail
canary checks
```

### Evidence

```text
Trace event count
Raw event count
Artifacts
Diff artifact
Test report
Replay
Trace link
```

Run detail must not duplicate the full Trace timeline.

---

## 18. Trace

Trace is a core audit surface and an intentional exception to the ordinary Vercel object-management layout.

Selected structure:

```text
Run list
→ Event Timeline
→ Inspector
```

Trace UI must be capable of representing the full semantic execution path.

Canonical example:

```text
user.request
→ ingress.decision
→ identity.resolved
→ conversation.resolved
→ context.authorized
→ context.loaded
→ memory.search
→ memory.read
→ skill.match
→ skill.loaded
→ thinking.stage
→ task.created
→ task_delegate.decision
→ worker.binding
→ worker.state
→ tool.decision
→ tool.read
→ tool.shell
→ file.write
→ test.run
→ skill.result
→ memory.candidate
→ memory.write
→ worker.state(done)
→ task.review
→ delivery.decision
→ delivery.sent
→ assistant.response
```

Not every capability above is current P3 implementation.

The Trace contract may define later capability events, but the UI must label them honestly.

### Event categories

```text
User
Authorization
System
Context
Memory
Skill
Thinking Stage
Tool
File
Test
Agent Ops
Delivery
Assistant
Error
```

### Event colors

```text
User          blue
Authorization amber
Thinking      indigo
Tool          purple
System        neutral gray
Assistant     green
Error         red
Context       blue-gray
Memory        brown/amber-neutral
Skill         teal
Agent Ops     teal
Delivery      rose-neutral
```

Thinking may show:

```text
auditable stage summary
```

Never show hidden model chain-of-thought.

### Tool Event

Tool is one connected object:

```text
Tool
→ args
→ result
```

Show:

```text
status
duration
args
result summary
error
Token usage when applicable
```

### Memory events

Support:

```text
memory.search
memory.read
memory.candidate
memory.write
```

Useful fields:

```text
query
scope
visibility
candidate count
selected count
score
source Run / Task
dedupe result
promotion state
memory id
```

### Skill events

Support:

```text
skill.match
skill.loaded
skill.result
```

Useful fields:

```text
candidate skills
match score
selected skills
skill source
resources loaded
result
permission inheritance
```

Skill never widens authority.

### Agent Ops events

Support:

```text
task.created
task.updated
worker.binding
worker.state
task.review
task.accept
task.rework
task.cancel
ops.connection
ops.reconcile
```

### Delivery events

Support:

```text
delivery.decision
delivery.sent
delivery.failed
```

Actor read permission is different from delivery audience permission.

---

## 19. Raw Trace vs Timeline

Raw Trace:

```text
complete original evidence
append-only
provider / runtime fidelity
high event volume
may include stream deltas
```

Trace Timeline:

```text
normalized
deduplicated
screened
semantic events
human-auditable
```

Do not render every streaming token delta as a Timeline row.

Concept:

```text
Raw Trace
→ Normalize
→ Deduplicate
→ Screen
→ Timeline projection
```

Inspector tabs:

```text
摘要
用量
原始
```

Inspector references:

```text
Conversation
Task
Run
Principal
Provenance
```

Keyboard interactions:

```text
j / k  previous / next event
e      expand / collapse
/      focus search
```

Timeline supports:

```text
type filters
search
event scrubber
jump latest
copy JSON
export screened JSON
```

---

## 20. PI

PI page manages the main Agent execution core.

It owns:

```text
PI engine state
Lora PI Kit status
models
default model
configuration profiles
PI Session health
usage
quota
latency
compatibility
```

It does not recreate a separate model-provider administration layer.

### PI Engine

Useful implementation fields:

```text
integration mode
PI version
Lora PI Kit version
default model
active sessions
last event
session recovery
ModelRuntime
SessionManager
ResourceLoader
Extension API
customTools
last error
```

### Lora PI Kit

P3 target examples:

```text
glassbox-policy-bridge.ts
trace-hooks.ts
usage-hooks.ts
base prompt
owner-direct preset
visitor-direct preset
qq-group preset
test preset
compat metadata
doctor / install tooling
```

### Models

Model card may show:

```text
model
discovered source
default
thinking profile
tool profile
context limit
Runs
Token
Cost
quota
reset time
last error
```

Missing quota:

```text
未知（未上报）
```

### Usage schema

```ts
type ModelUsage = {
  modelId: string
  runs: number
  successRate?: number
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  reasoning: number
  totalTokens: number
  p50LatencyMs?: number
  p95LatencyMs?: number
  costTotalUsd: number | null
}
```

---

## 21. Token semantic colors

Across Overview, PI, Run, and Trace:

```text
Input        blue-gray
Output       green
Cache Read   amber
Cache Write  purple
Reasoning    indigo-gray
```

Cache hit UI metric:

```text
Cache Read / (Input + Cache Read)
```

Label it as a calculated UI metric unless a native provider/runtime metric exists.

---

## 22. Usage visualizations

Visualizations are a second layer.

They answer:

```text
Is usage changing?
Which model dominates?
Is latency getting worse?
Are Tasks backing up?
```

Tables answer:

```text
What exactly happened?
```

Detail rails answer:

```text
Why?
```

Approved visual patterns:

```text
single major trend
small comparison bars
donut for limited part-to-whole
activity heatmap only when it materially helps
sparklines inside dense lists
```

Do not add visualizations merely to fill space.

All prototype numbers must be marked as design data unless sourced from real product data.

---

## 23. Channels & Integrations

Selected layout:

```text
catalog cards
→ channel contract
→ identity mapping
→ recent activity
```

Current important channels:

```text
Workbench Web
QQ / NapCat / OneBot 11
future Channels
```

QQ is a P3 target.

Channel card may show:

```text
connection status
last inbound
last outbound
delivery success rate
duplicate events
reconnect count
last error
identity resolver status
activation rule
```

### QQ contract

```text
Ingress
→ Identity
→ Conversation
→ PI / Tool Gate
→ Delivery Gate
```

Group default:

```text
explicit @ mention
or configured activation rule
```

Unknown identities do not inherit Owner authority.

Duplicate message / event id must be suppressed.

---

## 24. Permissions

Permissions page is **decision-first**, not analytics-first.

Primary hierarchy:

```text
Decision Table
→ Decision Tester
→ Approval Queue
→ Policy Provenance
→ secondary distribution analytics
```

Decision request model:

```text
Who?
Where?
What?
How?
Resource?
Audience?
Conversation?
Run?
```

Conceptual:

```ts
AuthorizationRequest {
  principal
  location
  action
  resource
  execution
  audience
  conversationId
  runId
}
```

Result:

```text
ALLOW
DENY
REQUIRES_APPROVAL
```

No matching grant:

```text
DENY
```

Decision Tester is simulation only.

Approval is not Permission.

### Policy Provenance

Decision detail should explain:

```text
Principal
relation
resource
rule
location
audience
effective decision
```

### Approval Queue

Shows explicit high-risk decisions awaiting action.

Examples:

```text
worktree removal
private result sharing
privileged worker operation
```

---

## 25. Four hard gates

### Ingress Gate

Before PI invocation.

Checks:

```text
ChannelIdentity
Principal
location
group activation
self message
duplicate id
channel allow / deny
```

### Context Gate

Before model-visible context assembly.

Rule:

```text
authorize source
→ then load
```

Never:

```text
load private data
→ send to model
→ tell model not to leak it
```

### Tool / Ops Gate

Immediately before protected execution.

Applies to:

```text
Tools
Ops Actions
worker_read
worker_prompt
task_delegate
task_accept
task_rework
task_cancel
```

### Delivery Gate

Immediately before result leaves Glassbox.

Rule:

```text
actor_can_read
≠
audience_can_receive
```

---

## 26. Monitor

Monitor has two layers:

```text
system health
+
product operations health
```

Primary hierarchy:

```text
Service Health Table
→ one major latency/error trend
→ Agent Ops health
→ Storage
→ Alerts
```

Do not turn Monitor into a generic observability SaaS dashboard.

### Service health

Examples:

```text
PI Engine
HerdrBridge
WebSocket
Turso
R2 Evidence
Channel Gateway
```

Fields:

```text
status
latency / observation age
error rate
last success
last error
notes
```

### Observation freshness

Herdr requires:

```text
last snapshot
last reconcile
unknown workers
stale bindings
stale threshold
last successful lifecycle event
connection state
```

Use:

```text
stale / unknown
```

when live facts cannot currently be observed.

### Product operations

Useful metrics:

```text
Tasks awaiting review
blocked Tasks
blocked duration
rework rate
Herdr reconnects
stale WorkerBindings
Task throughput
```

### Storage

Show:

```text
Turso
R2 Evidence
Live buffers
```

with:

```text
usage
retention
main contents
truth / non-truth role
```

---

## 27. Settings

Settings manages stable defaults only.

Groups:

```text
通用
PI
渠道默认值
Trace 与证据
任务协作
告警与通知
```

Possible settings:

```text
language
density
repository
cost currency

default PI model
default thinking
PI profile
PI compatibility

QQ activation
duplicate event dedupe
unknown identity behavior
Delivery default rule

Raw Trace retention
large output retention
UI sanitization
Secret Screening
unknown pricing policy

HerdrBridge
reconnect flow
blocked worker threshold
stale threshold

Task review notification
worker blocked notification
authorization anomaly alert
Herdr connection alert
```

Do not edit:

```text
Task truth
Conversation truth
Permission relationships
authorization history
```

from Settings.

Production switches use native checkbox/switch semantics.

---

# UI SYSTEM

## 28. Entity icon rule

Recognizable entities should have an entity-specific mark.

Examples:

```text
PI
Herdr
Web
QQ
WeChat
Email
GitHub
Turso
R2
WebSocket
Owner
Visitor
Worker
```

Do not use the GlossBox mascot as a generic system icon.

Production should use appropriate local / official SVGs where practical.

---

## 29. Mascot rule

Use the mascot only for meaningful Agent identity or state:

```text
Agent identity
running
thinking
found
success
error
waiting
reminder
empty state
```

Do not place mascot art on every card.

---

## 30. Command palette

`⌘K` eventually searches:

```text
Page
Conversation
Task
Run
PI Model
Principal
Trace Event
File / Artifact
```

Examples:

```text
task-218
→ Task Collaboration detail

run_A83
→ Run detail

gemini-pro
→ PI Model

visitor:qq_group
→ Identity & Access

memory.write
→ Trace filtered event
```

---

## 31. Data honesty

Every displayed datum should be classified internally as one of:

```text
Observed
Calculated
Configured
Unknown
Planned
Fixture
```

The visible UI vocabulary remains:

```text
已实现
P3 目标
设计数据
后续
未知
```

Derived metrics must be distinguishable from native/runtime-provided metrics.

---

## 32. Component constraint

Production implementation must use the component contracts in:

```text
UI_PRIMITIVES.md
```

Do not let implementation Agents invent a new Card / Table / Detail pattern per page.

The prototype is a visual reference, not a source to copy arbitrary CSS from.

---

## 33. Design Freeze

Locked:

```text
Vercel-first overall direction
Comfort density
Main navigation
PI → Model → Run → Trace
Conversation Master-detail
Task Collaboration table + detail
Run table + detail tabs
Full semantic Trace timeline
Trace Inspector
Identity chain + table + detail
Permissions decision-first hierarchy
Channel catalog + contracts
Monitor service-table hierarchy
Grouped Settings
Usage visualizations as secondary layer
Token semantic colors
USD Cost
Quota / Limits
Entity icon rule
Sanitized projections
Capability-state vocabulary
Mobile drawer behavior
```

Implementation-stage refinements allowed:

```text
1–2px spacing
exact copy
minor field order
real model availability
real backend state
loading/error/empty copy
official/local icon replacement
responsive polish
accessibility fixes
```

Not allowed without reopening design:

```text
multi-runtime management UI
separate provider admin page
turning management UI into chat composer
replacing Trace with generic logs
turning Overview into analytics wall
turning Monitor into generic observability SaaS
collapsing Task truth into Herdr state
hiding authorization / audience boundaries
```

---

## 34. Canonical artifacts

```text
DESIGN.md
UI_PRIMITIVES.md
DESIGN_EVAL.md
glossbox_vercel_admin_v24_vercel_compliance.html
```

Precedence:

1. `DESIGN.md` for product semantics and page responsibility.
2. `UI_PRIMITIVES.md` for implementation composition rules.
3. v24 HTML for visual reference.
4. `DESIGN_EVAL.md` for acceptance checks.

If production intentionally deviates, document the reason.

---

## 35. Coding Agent instruction

Use this sentence when handing implementation to a Coding Agent:

> 请以 `DESIGN.md` 作为产品与页面实现契约、以 `UI_PRIMITIVES.md` 作为组件约束、以 v24 HTML 作为视觉基准，并用 `DESIGN_EVAL.md` 完成验收；不要自行重新设计。
