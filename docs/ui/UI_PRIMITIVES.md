# GlossBox UI Primitives

Status: **LOCKED IMPLEMENTATION PRIMITIVES**

This file constrains UI composition so implementation does not drift from the Design Freeze.

---

## 1. Rule

Implementation Agents should compose the approved primitives below.

Do not create a new generic visual primitive when an existing one can express the interaction.

The goal is consistency, not component maximalism.

---

## 2. Foundation tokens

### Surfaces

```text
canvas          #FAFAFA
surface         #FFFFFF
sidebar         #F5F5F5
border          #EAEAEA
border-strong   #D4D4D4
ink             #111111
body            #333333
secondary       #666666
metadata        #737373
disabled        #999999
```

### Semantics

```text
brand/current/auth    warm amber
success               green
danger/deny/error     red
focus                  blue
neutral-series         black / blue-gray / gray
```

### Radius

```text
small     6px
default   8px
large     10px
pill      999px
```

No large decorative rounding.

---

## 3. Typography tokens

```text
page-title       24–26
section-title    14–16
body             15–16
table-body       13–14
table-head       11–12
button-tab       12–13
metadata         11–12
technical        10–11
```

Chinese and English font stacks follow `DESIGN.md`.

---

## 4. PageShell

Responsibilities:

```text
Sidebar
Topbar
Breadcrumb
Page
```

Desktop:

```text
Sidebar 232px
```

Mobile:

```text
Sidebar Drawer
44px menu target
overlay
```

No page implements its own navigation shell.

---

## 5. PageHeader

Contains:

```text
h1
one concise explanatory paragraph
optional state badge
optional page-level action
```

Do not put KPI cards inside PageHeader.

---

## 6. SectionHeader

Contains:

```text
title
short secondary description
optional right-side action
```

Use the same spacing everywhere.

---

## 7. FilterBar

Approved controls:

```text
SearchInput
Select
SegmentedFilter
ResultCount
secondary action
```

Rules:

- native input/select semantics;
- mobile input ≥ 16px;
- filters do not mutate product truth.

---

## 8. DataTable

Default management primitive.

Use for:

```text
Runs
Tasks
Principals
Relationships
Authorization Decisions
Services
Storage
Channel activity
PI sessions
Model usage
Workers
```

Features where relevant:

```text
sticky header
local horizontal scroll
selected row
keyboard focus
sorting later
filters outside the table
```

Do not replace dense object management with card grids.

---

## 9. DetailRail

Use with selected object tables.

Reading order:

```text
Identity
State
Relationships
Activity
Usage
Evidence
```

Desktop:

```text
right rail
```

Mobile:

```text
stack below main content
```

Do not turn the DetailRail into another full page.

---

## 10. SummaryBar

Quiet, compact summary.

Use:

```text
4–6 compact values
```

Do not use giant KPI cards.

Examples:

```text
Overview key state
AgentOpsSnapshot
Permission totals
Monitor Ops health
```

---

## 11. EntityMark

Use for a recognized entity:

```text
PI
Herdr
QQ
Web
Turso
R2
Owner
Visitor
Worker
```

EntityMark is not the GlossBox mascot.

---

## 12. Status

Structure:

```text
small colored dot
neutral/white background
semantic text
thin border
```

Canonical visible states:

```text
已实现
P3 目标
设计数据
后续
未知
```

Object states remain domain-specific:

```text
运行中
等待输入
待验收
已完成
拒绝
需要批准
stale
unknown
```

Avoid full-color status pills when dot + text is enough.

---

## 13. PrimaryButton

Use black.

Use only for the primary action in a local context.

Examples:

```text
Accept result
Run decision check
Create Task when explicitly needed
```

Do not make every action black.

---

## 14. SecondaryButton

White surface, thin border.

Default management action.

---

## 15. DangerButton

Use for explicitly destructive operations.

Examples:

```text
Cancel Task
Remove worktree
Stop worker when destructive
```

Do not use danger styling merely for Deny status.

---

## 16. Tabs

Use for closely related views of the same object.

Approved example:

```text
Run Detail
  摘要
  文件与测试
  证据
```

Trace Inspector:

```text
摘要
用量
原始
```

Do not use Tabs as main navigation.

---

## 17. SettingsGroup

Vercel-style settings section:

```text
group header
rows
value
action / native switch
```

Native switch:

```html
<input type="checkbox">
```

with a visible or accessible label.

No fake div/span-only switches in production.

---

## 18. MasterDetail

Approved for Conversations.

Desktop:

```text
list | detail
```

Mobile:

```text
list
↓
detail
```

Conversation list remains searchable/filterable.

---

## 19. TraceRunList

Trace-specific primitive.

May show:

```text
Run title
model
Task / Attempt
event count
Turn count
Tool count
Token
Cost
duration
sparkline
state
```

This primitive is intentionally denser than ordinary page lists.

---

## 20. TraceEvent

Semantic event row/card.

Required fields:

```text
seq
type
method
summary
timestamp
references
provenance
usage
raw representation
```

Optional expanded detail:

```text
args / result
Memory flow
Skill metadata
Task / Worker metadata
File / Test evidence
Delivery data
```

TraceEvent type determines semantic accent.

Do not create a new card style per event kind.

---

## 21. TraceInspector

Tabs:

```text
摘要
用量
原始
```

Summary shows:

```text
method
kind
explanation
Conversation
Task
Run
Principal
Provenance
screening state
```

Usage shows normalized Token/cost fields.

Raw shows normalized JSON projection.

Raw source evidence remains separately accessible where required.

---

## 22. ChartPanel

Charts are secondary management context.

Structure:

```text
title
description
optional range tabs
chart
summary/footer
data definition
```

Rules:

- chart never replaces the precision table;
- no decorative chart;
- no brand amber as arbitrary series color;
- use line pattern + color;
- accessible tooltip;
- table/numeric fallback;
- show design-data label for fixtures.

---

## 23. EmptyState

Use when a real user action can produce zero items.

Examples:

```text
No Tasks match filter
No Trace events match search
No Conversations match filters
No quota reported
```

Keep compact.

Mascot allowed only if the empty state is meaningfully Agent-related.

---

## 24. Notice

Small, restrained inline explanation.

Use for:

```text
security boundary
data truth warning
screening note
product truth vs live state
```

Do not use Notice as decorative callout.

---

## 25. Native form controls

Use:

```text
button
input
select
checkbox
radio
label
```

Requirements:

```text
for/id association
visible focus
accessible name
mobile text input ≥16px
tap target ≈44px
```

---

## 26. Approved page compositions

### Overview

```text
PageHeader
SummaryBar
TwoColumn(AttentionList, CurrentRunDetail)
ChartPanel(one major trend)
DataTable(ModelUsage)
```

### Conversations

```text
PageHeader
FilterBar
MasterDetail
  ConversationList
  ConversationDetail
```

### Task Collaboration

```text
PageHeader
Notice
SummaryBar
FilterBar
DataTable + DetailRail
AttentionList
DataTable(Workers)
ReconcileSteps
```

### Identity

```text
PageHeader
SummaryBar
IdentityChain
DataTable(Principals) + DetailRail
DataTable(Relationships)
```

### Runs

```text
PageHeader
FilterBar
DataTable(Runs) + DetailRail(Tabs)
SummaryBar
```

### Trace

```text
PageHeader
TraceRunList
TraceTimeline
TraceInspector
```

### PI

```text
PageHeader
Notice
PIEnginePanel + PIKITPanel
ModelCards
ConfigProfileTable
ChartPanel
ModelUsageTable
SessionHealthTable
```

### Channels

```text
PageHeader
ChannelCards
ChartPanel(optional secondary)
ChannelContractTable
IdentityMappingTable
ActivityTable
```

### Permissions

```text
PageHeader
SummaryBar
DecisionTable + DecisionTester
ApprovalQueue
PolicyProvenance
ChartPanel(optional secondary)
GateReference
```

### Monitor

```text
PageHeader
ServiceHealthTable
ChartPanel(one trend)
SummaryBar(Agent Ops health)
StorageTable
AlertsList
```

### Settings

```text
PageHeader
SettingsGroup*
```

---

## 27. Primitive anti-patterns

Do not create:

```text
Giant KPI Card
Glass Card
Gradient Hero
AI Glow
Rounded-everything
Card-per-field
Card-per-event-kind
Provider Admin Card Grid
Analytics-first Overview
Analytics-first Permission page
Observability-SaaS Monitor wall
```

---

## 28. Implementation note

The v24 HTML is a visual reference.

Do not copy all prototype CSS directly into production.

Build a typed component system from these primitives, then compose pages according to `DESIGN.md`.
