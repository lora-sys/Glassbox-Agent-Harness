# Owner Control and Future Group Operations

Status: P3+ OWNER CONTROL ACTIVE / P9 GROUP FEATURES PLANNED

This document owns two related but differently timed areas:

~~~text
now
  minimal Owner private control
  per-Run Tool surface isolation

later
  group programs
  reminders / reports
  group-specific capability creation
  multi-group operations
~~~

The active implementation source is `.plans/03-plus-owner-control-smoke.md`.

## Current P3+ scope

P3+ is only a smoke slice on top of completed P3.

It proves:

~~~text
Owner private control
test-group runtime inspection
model override for future Runs
enable / disable one existing safe capability
recent Run / Trace inspection
model-visible Tool schema filtering
~~~

It does not add any new learning, scheduling, assignment, reminder, reporting, or Tool-generation subsystem.

## Owner private control

The Owner private projection may receive protected management Actions that normal group participants never see.

Initial conceptual Actions:

~~~text
owner_status
owner_group_get
owner_group_set_model
owner_group_set_tool_enabled
owner_run_inspect
~~~

Do not implement one unrestricted free-form command Tool.

Each mutation uses typed input, explicit Resource and Action, server-side authorization, and Trace evidence.

Owner identity comes from existing P3 identity resolution and authorization.

A prompt cannot grant Owner authority.

## Tool schema visibility

Tool definitions are model-visible Context.

Glassbox must therefore decide the Tool surface before Pi receives a Run.

~~~text
Kit profile
→ scope configuration
→ Principal authorization
→ RunCapabilitySet
→ model-visible Tool definitions
~~~

Only authorized definitions enter the runtime.

The existing Tool Gate still runs again immediately before execution.

Schema filtering reduces exposure. It does not replace execution authorization.

## GroupRuntimeConfig

P3+ may persist a small runtime configuration for the current real test group.

Conceptual shape:

~~~text
GroupRuntimeConfig
  groupScopeKey
  modelId
  enabledCapabilities
  revision
  updatedByPrincipal
  updatedAt
~~~

Changing the model affects future Runs only.

Historical Run metadata is not rewritten.

The first capability toggle should use one capability that already exists in the completed P3 runtime.

Do not invent a new group feature merely to test the toggle.

## P3+ smoke loop

~~~text
Owner private
  inspect test-group runtime

Owner private
  change model

Owner private
  disable one existing safe Tool

test group
  trigger normal Run
  verify selected model
  verify disabled Tool schema absent
  verify Owner Tool schema absent

Owner private
  re-enable Tool
  inspect recent Run / Trace
~~~

After this works, stop expanding P3+ and return to P4.

## P9 group programs and custom capabilities

The following features are intentionally late in the roadmap.

They are useful, but they should not interrupt P4 through P8.

### Scheduled group programs

A future group program may support:

~~~text
GroupAssignment
AssignmentParticipant
CompletionEvidence
ScheduleDefinition
ScheduleOccurrence
~~~

Human group assignments remain separate from Agent Operations Tasks.

~~~text
Task
  Agent or Worker work

GroupAssignment
  human participant work
~~~

A first learning-program implementation may later support daily assignment posting and explicit participant check-in.

Schedule truth belongs in Glassbox durable state.

Timer transport is not product truth.

Each occurrence requires a deterministic idempotency key so restart or retries do not duplicate a post.

### Reminder policy and weekly reports

Automatic reminders require explicit policy.

Conceptual controls:

~~~text
enabled
first reminder offset
repeat cooldown
maximum reminders
quiet hours
delivery audience
skip completed
skip excused
Owner override
~~~

Reminder flow:

~~~text
find overdue participant
→ verify assignment active
→ verify participant incomplete
→ verify cooldown
→ authorize delivery
→ send reminder
→ persist ReminderEvent
~~~

Weekly reports should be structured projections over assignment evidence.

Useful fields may include:

~~~text
period
assignments published
participants assigned
accepted completions
submitted pending review
overdue
excused
completion rate
streak when defined
attention needed
delivery failures
~~~

Natural-language summary is presentation. Structured state remains truth.

### Group Tool Registry

Glassbox may later own a versioned registry for reusable group capabilities.

Conceptual records:

~~~text
ToolDefinition
  id
  name
  version
  kind
  implementationRef
  inputSchemaRef
  outputSchemaRef
  permissionManifest
  riskClass
  status

GroupToolBinding
  groupScope
  toolDefinitionId
  enabled
  configuration
  audiencePolicy
  policyRevision
~~~

A ToolDefinition may be reused across groups.

A GroupToolBinding selects whether one group may use it and with which configuration.

### Progressive Tool discovery

Most Runs should receive a small direct Tool surface.

If a later group has many authorized capabilities, Glassbox may add progressive discovery.

A discovery Tool may reveal only authorized metadata:

~~~text
tool id
display name
short purpose
input summary
risk class
~~~

It must not reveal Owner-only or unrelated-group capability metadata.

A generic broker may be considered only when real Tool volume justifies it.

The server still validates the stored schema and re-authorizes execution.

### Template-driven capability creation

The Main Agent may later help the Owner create group-specific capability bindings.

Use this order:

~~~text
configuration
→ fixed Tool template
→ Skill
→ new executable Tool code
~~~

Fixed templates are suitable for common group workflows such as:

~~~text
learning check-in
poll
attendance
reading log
daily question
weekly scorecard
simple approval flow
~~~

Executable Tool code is only for genuinely new integration or side-effect requirements.

Controlled development path:

~~~text
Owner request
→ classify requirement
→ draft implementation
→ focused tests
→ permission manifest
→ security checks
→ Owner review when required
→ versioned activation
~~~

Do not load arbitrary chat-generated JavaScript into production.

### Multi-group Owner snapshot

After more than one real group exists, the Owner private Main Agent may retrieve a compact projection:

~~~text
OwnerGroupOpsSnapshot
  configuredGroups
  activeSchedules
  openAssignments
  overdueParticipants
  remindersDue
  recentReports
  enabledGroupTools
  failedDeliveries
  recentRuntimeFailures
~~~

Do not inject every group's full history into every Owner Run.

Use a compact summary plus protected detail Tools.

## Memory-dependent group learning

This section depends on P4 Memory being implemented first.

Default rule:

~~~text
group A evidence
→ group A Memory namespace
~~~

It must not silently become:

~~~text
group A evidence
→ group B Context
~~~

The Owner private Main Agent may later retrieve across authorized group namespaces.

Cross-group synthesis should create an Owner-private derived insight with provenance:

~~~text
OwnerInsight
  statement
  sourceGroupScopes
  sourceRefs
  confidence
  visibility = owner_private
~~~

Repeated evidence may later become a Skill candidate, Rule candidate, system-learning candidate, or product-improvement proposal through explicit promotion.

## Main Agent improvement loop

Late-stage system improvement may use real execution evidence.

~~~text
observe repeated failure or need
→ inspect Trace and product state
→ classify as configuration, template, Skill, or code
→ create proposed change
→ test
→ show evidence and diff
→ Owner approval when required
→ activate
~~~

Low-risk configuration changes may use explicit Owner Actions.

Authorization, secrets, production schema changes, arbitrary shell authority, and self-modification of Owner policy require stronger review.

## Stable boundaries

~~~text
Owner control ≠ unrestricted shell
RunCapabilitySet ≠ authorization policy
Tool availability ≠ Tool permission
Tool schema presence = model-visible Context exposure
GroupAssignment ≠ Agent Operations Task
structured product state ≠ Memory
Owner cross-group retrieval ≠ group-to-group sharing
generated proposal ≠ activated capability
~~~
