# Glassbox Owner and Group Operations

Status: PLANNED POST-P3

This document defines the planned Owner control surface, group-specific operations, group assignment loop, per-run Tool surface, and safe group capability creation.

The active implementation source of truth remains `.plans/03-personal-agent-foundation.md`. Nothing in this document is permission to expand P3 before its completion gate passes.

## Decision

Glassbox still has one durable Personal Agent.

A QQ group is a scoped operating environment for that Agent. It is not another Agent identity.

```text
one durable Personal Agent
        ↓
Owner private projection
        ↓
group A projection
group B projection
group N projection
```

Each group may have its own:

```text
GroupPolicy
Tool bindings
Schedules
Assignments
Reminder policy
Reports
Memory namespace after P4
```

The Owner private Main Agent may inspect and manage those scopes through protected Glassbox Actions.

A group Principal receives only the Context and capability surface authorized for that Run.

## P3 dependency

This design depends on P3 proving:

```text
Principal and Channel identity
Conversation scope
server-side Authorization
Context Gate
Tool and Ops Gate
Delivery Gate
Pi Runtime Adapter
narrow runtime profiles
Turso durability
Raw Trace
QQ private and group transport
restart and dedupe
```

Do not create a second trust system for group features.

Reuse the P3 trust boundaries.

## Owner control surface

The Owner private projection is the highest-authority user-facing control surface.

It may expose protected Actions such as:

```text
owner_group_list
owner_group_get
owner_group_pause
owner_group_set_model
owner_group_set_profile
owner_group_set_override
owner_group_bind_tool
owner_group_unbind_tool
owner_schedule_create
owner_schedule_update
owner_schedule_pause
owner_assignment_create
owner_assignment_update
owner_assignment_report
owner_runtime_status
owner_trace_inspect
owner_failure_list
```

These names are conceptual.

Do not implement one unrestricted command string that can mutate anything.

Each Action should have:

```text
explicit Resource
explicit Action
typed input
authorization check
audience rule
Trace evidence
version or revision when state changes
```

Owner authority is still enforced server-side.

A Prompt that claims to be the Owner does not create Owner authority.

## Per-run capability resolution

Tool visibility is part of authorization.

A Tool schema is model-visible Context when it is attached to the Runtime.

Therefore the normal order is:

```text
resolve Principal
→ resolve Location and Conversation
→ load GroupPolicy
→ resolve profile
→ resolve group Tool bindings
→ authorize candidate capabilities
→ build RunCapabilitySet
→ attach only allowed Tool definitions
→ invoke Pi
→ re-authorize the chosen Tool immediately before execution
```

Do not use this order:

```text
attach every Tool schema
→ invoke model
→ deny unauthorized calls later
```

The second design still leaks capability names, descriptions, arguments, and implementation hints into model-visible Context.

### RunCapabilitySet

Conceptual shape:

```text
RunCapabilitySet
  runId
  principalId
  conversationId
  location
  profile
  toolDefinitionIds
  skillIds
  mcpToolIds
  policyRevision
  createdAt
```

This is an execution projection.

It is not a new source of authority.

Authorization policy and group bindings remain product truth.

### Profile and authorization

A Lora PI Kit profile narrows the possible runtime set.

Glassbox then narrows it again for the real Run.

```text
Kit capability set
→ profile capability set
→ group binding set
→ Principal authorization
→ RunCapabilitySet
```

A profile can reduce capability.

A profile cannot grant authority that Glassbox policy did not grant.

## Progressive Tool discovery

Most Runs should receive a small direct Tool surface.

When a group has many allowed capabilities, Glassbox may add progressive discovery.

A safe discovery Tool may return only authorized metadata such as:

```text
tool id
display name
short purpose
input summary
risk class
```

It must not return Owner-only or other-group capability metadata.

After discovery, Glassbox may attach a selected Tool definition to the next runtime step or next Run when the Runtime boundary supports it.

A generic broker such as `tool_invoke` may be used when schema secrecy is more important than model-side structured arguments. The server still validates the real stored schema before execution.

The preferred first implementation is simpler:

```text
small per-run Tool set
+ strict server-side validation
+ no unauthorized schemas
```

Do not add a broker until a real group has enough Tools to justify it.

## Group Tool Registry

Glassbox owns the product registry for group-specific capability bindings.

Conceptual records:

```text
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
```

A ToolDefinition may be reusable across groups.

A GroupToolBinding decides whether a configured group may use that Tool and with which parameters.

Do not copy executable code for every group when a parameterized binding is enough.

## Capability creation order

The Main Agent may help the Owner create a group capability.

Use the smallest mechanism that satisfies the need.

```text
configuration
→ fixed Tool template
→ Skill
→ new executable Tool code
```

### Configuration

Use configuration when behavior already exists and only parameters change.

Examples:

```text
post time
deadline
reminder cooldown
weekly report day
accepted check-in keywords
group-specific rubric
```

### Fixed Tool template

Use a template when the implementation is known and only a safe declarative specification changes.

Examples:

```text
learning check-in
poll
attendance
reading log
daily question
weekly scorecard
simple approval flow
```

A template should have a fixed permission manifest and validated configuration schema.

### Skill

Use a Skill when the new behavior is mainly a reusable procedure and does not need new server authority.

A Skill does not bypass Tool authorization.

### New executable Tool

Only create code when the capability needs a new external integration, new side effect, or new protected product Action.

The workflow should be:

```text
Owner request
→ requirement classification
→ draft implementation
→ focused tests
→ permission manifest
→ security checks
→ Owner review
→ versioned activation
```

The first group pilot should not load arbitrary generated JavaScript from a chat message.

## Group assignment model

Human learning assignments are not Agent Operations Tasks.

Keep them separate:

```text
Task
  durable work performed by the Personal Agent or delegated Worker

GroupAssignment
  durable work assigned to human group participants
```

### GroupAssignment

Conceptual shape:

```text
GroupAssignment
  id
  groupScope
  title
  instructions
  scheduleId
  opensAt
  dueAt
  completionPolicy
  reminderPolicyId
  createdByPrincipal
  status
```

### AssignmentParticipant

Tracks the assignment state for one group member.

```text
AssignmentParticipant
  assignmentId
  principalId
  state
  startedAt
  submittedAt
  acceptedAt
  overdueAt
  lastReminderAt
```

Initial states may be:

```text
ASSIGNED
IN_PROGRESS
SUBMITTED
ACCEPTED
OVERDUE
EXCUSED
```

Do not infer completion only from general conversation activity.

Completion should have evidence.

### CompletionEvidence

Evidence may include:

```text
explicit check-in command
message reference
attachment reference
answer text
link
Owner confirmation
Tool verification result
```

Conceptual record:

```text
CompletionEvidence
  id
  assignmentId
  principalId
  sourceType
  sourceRef
  verificationState
  verifier
  createdAt
```

The exact verification policy belongs to the assignment or template.

## Scheduled posting

Schedule truth belongs in Glassbox.

Conceptual records:

```text
ScheduleDefinition
ScheduleOccurrence
DeliveryAttempt
```

For one test group, an in-process scheduler is acceptable when Turso stores the durable schedule and occurrence identities.

A scheduler tick may be frequent, but each occurrence needs a deterministic idempotency key.

Example:

```text
schedule:<scheduleId>:2026-09-19
```

Posting flow:

```text
scheduler wakes
→ find due occurrence
→ claim occurrence
→ create assignment
→ authorize group delivery
→ send QQ message
→ record delivery result
```

Restart must not create the same assignment twice.

A later service such as QStash may deliver timer events, but it does not become the source of schedule truth.

## Reminder policy

Automatic reminders need explicit policy.

Conceptual controls:

```text
enabled
first reminder offset
repeat cooldown
maximum reminders
quiet hours
delivery audience
skip completed
skip excused
Owner override
```

Reminder flow:

```text
find overdue participant
→ verify assignment is still active
→ verify participant is incomplete
→ verify cooldown and maximum count
→ authorize delivery
→ send reminder
→ persist ReminderEvent
```

Every reminder should be deduplicated.

The bot should not repeatedly mention a participant because the scheduler retried.

## Weekly report

A report is a durable projection over assignment evidence.

Useful fields:

```text
period
assignments published
participants assigned
accepted completions
submitted pending review
overdue
excused
completion rate
streak when defined
recent improvement
attention needed
delivery failures
```

The report should show the underlying evidence when the Owner asks for details.

Do not treat a generated natural-language summary as the only source of truth.

## Owner group snapshot

The Owner private Main Agent should receive or retrieve a compact cross-group operational view.

Conceptual projection:

```text
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
```

Do not inject every group's full history into every Owner prompt.

Use a compact summary and protected detail Tools.

## Group Memory after P4

Group Memory begins only with the P4 Memory system.

Default rule:

```text
evidence from group A
→ group A Memory namespace
```

It does not become:

```text
group A evidence
→ group B Context
```

The Owner private Main Agent may query several authorized group namespaces for Owner use.

Cross-group synthesis should create a derived Owner-only insight:

```text
OwnerInsight
  statement
  sourceGroupScopes
  sourceRefs
  confidence
  visibility = owner_private
```

A derived insight must keep provenance.

It must not silently rewrite source group Memory.

A later explicit promotion may turn repeated evidence into:

```text
Skill candidate
Rule candidate
system-learning candidate
product improvement proposal
```

Those promotions follow their own validation and approval rules.

## Main Agent development loop

The Owner Main Agent may use execution evidence to improve Glassbox.

A safe path is:

```text
observe repeated failure or need
→ inspect Trace and product state
→ classify as configuration, template, Skill, or code
→ create proposed change
→ test
→ show evidence and diff
→ Owner approval when required
→ activate
```

Low-risk configuration changes may use explicit Owner Actions.

Authorization, secrets, production schema changes, arbitrary shell authority, and self-modification of Owner policy should require stronger review.

## Data ownership

Glassbox and Turso own:

```text
GroupPolicy
ToolDefinition metadata
ToolVersion metadata
GroupToolBinding
RunCapabilitySet metadata when persisted
ScheduleDefinition
ScheduleOccurrence
GroupAssignment
AssignmentParticipant
CompletionEvidence
ReminderPolicy
ReminderEvent
ReportSnapshot
OwnerGroupOpsSnapshot projection inputs
OwnerInsight after P4
```

Large artifacts may use R2 with durable references in Turso.

Lora PI Kit may package Tool implementations, Skills, prompts, and runtime adapters.

The Kit does not own group authorization or assignment truth.

## First test-group slice

The first useful demo after P3 should be intentionally narrow.

Use one real test group.

Prove:

```text
Owner creates one recurring learning assignment
→ assignment posts automatically
→ at least two test identities produce different progress states
→ one completion is verified
→ one incomplete participant becomes overdue
→ one controlled reminder is sent
→ Owner asks the Main Agent for current progress
→ a weekly report is produced
→ Owner enables or disables one group-specific Tool binding
→ group Run never receives Owner-only Tool schemas
```

Do not wait for broad semantic Memory, many groups, or automatic code generation before shipping this loop.

## Later multi-group evolution

After one group works:

```text
add second real group
→ prove group policy isolation
→ prove Tool binding isolation
→ prove schedule isolation
→ prove report isolation
→ add P4 group Memory
→ prove Owner cross-group retrieval
→ add controlled capability creation
```

Scale should follow real use.

## Security tests

At minimum test:

```text
group asks to list Owner Tools
group asks to reveal Tool schemas
group prompt injects fake Owner identity
group A asks for group B Tool metadata
group A asks for group B assignment state
revoked Tool binding
stale RunCapabilitySet
Tool version changed after Run start
unauthorized MCP Tool
duplicate schedule tick
duplicate QQ event
duplicate reminder trigger
weekly report delivered to wrong audience
participant leaves the group
identity remap
Owner-only cross-group insight requested from group chat
```

Unauthorized capability metadata should fail closed before model invocation where practical.

Call-time authorization remains mandatory even after schema filtering.

## Stable distinctions

Keep these distinct:

```text
Group ≠ Agent
GroupAssignment ≠ Task
GroupToolBinding ≠ Authorization
RunCapabilitySet ≠ Authorization policy
Tool availability ≠ Tool permission
Tool schema presence = model-visible Context exposure
Owner private retrieval ≠ group-to-group sharing
Schedule truth ≠ scheduler transport
generated proposal ≠ activated capability
```
