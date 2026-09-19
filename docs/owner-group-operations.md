# Owner and Group Operations

Status: P3+ ACTIVE / LATER CAPABILITIES PLANNED

This document owns the architecture for Owner private control and group-specific product behavior.

The active implementation slice is intentionally narrow. It does not require Memory.

## Core model

Glassbox still has one durable Personal Agent.

A QQ group is a scoped operating environment for that Agent.

~~~text
Personal Agent
  Owner private projection
  test-group projection
  future group projections
~~~

Group-specific behavior does not create a second Agent identity.

## Owner private control

The Owner private projection may receive protected management Actions that normal group participants never see.

The first P3+ surface is limited to:

~~~text
read runtime status
read test-group configuration
change the model used by future test-group Runs
enable or disable the fixed learning-checkin capability
inspect recent Run or failure state
inspect learning-assignment progress
~~~

Every mutation remains a Glassbox Action.

Owner identity is resolved by existing P3 identity and authorization code.

A prompt cannot grant Owner authority.

## Tool schema visibility

Tool definitions are model-visible Context.

Glassbox must therefore decide the Tool surface before Pi receives the Run.

~~~text
Kit profile
→ scope bindings
→ Principal authorization
→ RunCapabilitySet
→ model-visible Tool definitions
~~~

Only authorized definitions enter the runtime.

The existing Tool Gate still runs again immediately before execution.

Schema filtering reduces exposure. It does not replace execution authorization.

## Runtime configuration

P3+ adds a small durable group runtime configuration.

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

Changing the model changes future Runs only.

Historical Run metadata is not rewritten.

The first implementation only needs the current real test group.

## Fixed learning-checkin capability

The first group feature is built-in reviewed code.

Do not generate executable code from chat for this feature.

The feature owns:

~~~text
one daily schedule
one daily assignment
explicit participant check-in
durable participant progress
Owner private progress query
~~~

Human assignments are separate from Agent Operations Tasks.

~~~text
Task
  Agent or Worker work

GroupAssignment
  human participant work
~~~

Do not reuse TaskAttempt or WorkerBinding for human completion.

## Scheduling

For the one-group P3+ slice, an in-process scheduler is sufficient.

Glassbox persists:

~~~text
ScheduleDefinition
ScheduleOccurrence
~~~

Each occurrence has a durable idempotency key.

Restart, reconnect, or duplicate timer ticks must not produce a second publication for the same occurrence.

The scheduler transport is not product truth.

## Assignment state

Minimum records:

~~~text
GroupAssignment
AssignmentParticipant
CompletionEvidence
~~~

Minimum participant states:

~~~text
ASSIGNED
SUBMITTED
ACCEPTED
OVERDUE
~~~

The first version may use an explicit configured participant set for the test group.

Completion must have evidence.

General chat activity is not automatically completion.

## This is not Memory

The following records are product state:

~~~text
GroupRuntimeConfig
ScheduleDefinition
ScheduleOccurrence
GroupAssignment
AssignmentParticipant
CompletionEvidence
~~~

Persisting them in Turso does not make them Memory.

P3+ does not create:

~~~text
MemoryCandidate
Semantic Memory
Episodic Memory
TasteCandidate
TasteEntry
~~~

P4 may later select useful assignment, Conversation, Run, and Task evidence as input to the Memory promotion pipeline.

Nothing in P3+ should inject all stored assignment history into model Context.

## Deferred group operations

The following design is preserved as a later Group Operations track.

It is not part of the P3+ completion gate and does not block P4.

### G1 — Reminder policy and weekly reports

Automatic reminders require explicit policy rather than ad-hoc model behavior.

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
→ verify assignment is active
→ verify participant is incomplete
→ verify cooldown and maximum count
→ authorize delivery
→ send reminder
→ persist ReminderEvent
~~~

Every reminder needs an idempotency key.

A retry must not mention the same participant repeatedly.

Weekly reports are durable projections over assignment evidence.

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
recent improvement
attention needed
delivery failures
~~~

The natural-language report is a presentation layer.

The structured assignment evidence remains product truth.

### G2 — Group Tool Registry

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

A GroupToolBinding decides whether one group may use it and with which configuration.

Do not duplicate executable code per group when a parameterized binding is enough.

### G3 — Progressive Tool discovery

Most Runs should continue to receive a small direct Tool surface.

When a group later has many authorized capabilities, Glassbox may add progressive discovery.

A discovery Tool may return only authorized metadata such as:

~~~text
tool id
display name
short purpose
input summary
risk class
~~~

It must not return Owner-only or unrelated-group capability metadata.

A generic broker such as tool_invoke may be considered when schema secrecy is more important than model-side structured arguments.

The server must still validate the stored real schema and re-authorize execution.

Do not add a broker until real Tool volume justifies it.

### G4 — Template-driven capability creation

The Main Agent may later help the Owner create group-specific capability bindings.

Use the smallest mechanism that satisfies the need:

~~~text
configuration
→ fixed Tool template
→ Skill
→ new executable Tool code
~~~

Configuration is preferred when only safe parameters change.

Fixed templates are preferred for common group workflows such as:

~~~text
learning check-in
poll
attendance
reading log
daily question
weekly scorecard
simple approval flow
~~~

A template should have a fixed permission manifest and validated configuration schema.

Use a Skill when the new behavior is mainly a reusable procedure and does not require new server authority.

Only create executable Tool code when a capability needs a new integration, new side effect, or new protected Action.

The controlled development path is:

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

Do not load arbitrary chat-generated JavaScript into the production process.

### G5 — Multi-group Owner snapshot

After more than one real group exists, the Owner private Main Agent may retrieve a compact operational projection such as:

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

Use a compact summary and protected detail Tools.

## Deferred learning

Cross-group learning requires P4 Memory foundations.

After P4 exists, group-derived evidence may enter this path:

~~~text
group evidence
→ Memory Candidate
→ scope + visibility + reliability
→ group-scoped Memory
→ authorized Owner retrieval
~~~

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

The Owner private Main Agent may later query several authorized group namespaces for Owner use.

Cross-group synthesis should create an Owner-private derived insight with provenance:

~~~text
OwnerInsight
  statement
  sourceGroupScopes
  sourceRefs
  confidence
  visibility = owner_private
~~~

A later explicit promotion may turn repeated evidence into:

~~~text
Skill candidate
Rule candidate
system-learning candidate
product improvement proposal
~~~

Source group Memory remains unchanged.

## Deferred Main Agent improvement loop

The Owner Main Agent may later use real execution evidence to improve Glassbox.

A safe path is:

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

## First P3+ user loop

~~~text
Owner private:
  set test group model
  enable learning-checkin

scheduled occurrence:
  publish today's learning assignment

group member:
  submit explicit check-in

Glassbox:
  persist CompletionEvidence
  update AssignmentParticipant

Owner private:
  ask who has completed today

Glassbox:
  return authorized progress projection
~~~

This loop is enough to prove the direction before reminders, reports, Memory, or Tool generation are built.


## Later multi-group evolution

After the one-group P3+ loop works and later Group Operations slices are justified:

~~~text
add second real group
→ prove group configuration isolation
→ prove Tool binding isolation
→ prove schedule isolation
→ prove report isolation
→ add P4 group Memory
→ prove Owner cross-group retrieval
→ add controlled capability creation
~~~

Scale follows real use.

## Later data ownership

When the later Group Operations track is implemented, Glassbox and Turso may own structured metadata such as:

~~~text
GroupPolicy
ToolDefinition metadata
ToolVersion metadata
GroupToolBinding
RunCapabilitySet metadata when persisted
ReminderPolicy
ReminderEvent
ReportSnapshot
OwnerGroupOpsSnapshot projection inputs
OwnerInsight after P4
~~~

Large artifacts may use R2 with durable references in Turso.

Lora PI Kit may package executable Tool implementations, Skills, prompts, and runtime adapters.

The Kit does not own group authorization, assignment truth, or Memory truth.
