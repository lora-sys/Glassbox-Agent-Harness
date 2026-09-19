# Plan P3+ — Owner Control + Test Group Utility

Status: ACTIVE AFTER P3

This is the small fast-follow plan that runs immediately after the P3 completion gate.

It deliberately does not implement Taste, Memory, cross-group learning, generic Tool generation, or the full group-operations product.

## Goal

Use the completed P3 trust and runtime foundation to make the current real test group visibly useful without waiting for P4.

P3+ ends when:

- Owner private chat can inspect runtime and group state through protected Owner Actions;
- Owner can change the model used for future Runs in the test group;
- Owner can enable or disable the small group capability set;
- each Run receives only the Tool definitions authorized for that Principal and location;
- the test group can receive one durable daily learning assignment automatically;
- group members can explicitly check in against that assignment;
- the Owner can ask for current completion progress;
- restart or duplicate scheduler ticks do not duplicate an assignment post;
- no P3+ feature claims to be Memory or Taste.

The acceptance sentence is:

> The Owner can privately control the model and enabled capabilities for the real test group, the group receives one scheduled learning assignment, members can check in, the Owner can inspect progress, and group Runs never receive Owner-only or unrelated Tool schemas.

## What P3 already provides

P3 is the foundation and is not reopened by this Plan.

P3 already provides the contracts P3+ reuses:

~~~text
Principal
ChannelIdentity
Conversation
Run
Authorization
Ingress Gate
Context Gate
Tool / Ops Gate
Delivery Gate
Pi SDK runtime
Lora PI Kit profiles
Turso persistence
Raw Trace
QQ private / group transport
restart / dedupe
~~~

P3+ adds product behavior on top of those contracts.

## Explicit non-goals

Do not implement these in P3+:

~~~text
Semantic Memory
Episodic Memory
Taste
cross-group Memory retrieval
group knowledge distillation
OwnerInsight
automatic Skill promotion
generic Tool Factory
chat-generated executable Tool code
automatic reminder engine
weekly report engine
multi-group dashboard
broad scheduler infrastructure
LongTask
~~~

Those remain later work.

## Closed loop A — Owner direct control

~~~text
Owner QQ private message
        ↓
existing Identity + Authorization
        ↓
owner-direct runtime projection
        ↓
Owner Actions
        ↓
Glassbox product state
        ↓
Trace
        ↓
authorized private reply
~~~

Initial conceptual Owner Actions:

~~~text
owner_status
owner_group_get
owner_group_set_model
owner_group_set_tool_enabled
owner_run_inspect
owner_learning_assignment_get
owner_learning_progress
~~~

Names may change during implementation.

Do not build a free-form god tool.

Each mutation must use typed input, explicit Resource and Action, server-side authorization, and Trace evidence.

## P3+.0 — Per-Run capability surface

Tool definitions are model-visible Context.

The P3 Tool Gate already protects execution. P3+ adds capability filtering before runtime invocation.

Required order:

~~~text
resolve Principal
→ resolve Location + Conversation
→ load runtime profile
→ load scope capability bindings
→ authorize candidate capabilities
→ build RunCapabilitySet
→ attach only selected Tool definitions
→ invoke Pi
→ re-authorize the selected Tool before execution
~~~

Do not use:

~~~text
attach every configured Tool schema
→ invoke model
→ deny unauthorized calls only at execution time
~~~

The second design leaks Tool names, descriptions, arguments, and implementation hints.

### RunCapabilitySet

Conceptual execution projection:

~~~text
RunCapabilitySet
  runId
  principalId
  conversationId
  profile
  toolDefinitionIds
  policyRevision
~~~

It is not a new authority source.

Authorization and product bindings remain authoritative.

Completion:

> A group Run cannot observe Owner-only Tool definitions, while Owner private Runs receive the allowed Owner surface. Protected Tool execution still performs the existing call-time authorization check.

## P3+.1 — Minimal Owner control

Add the smallest useful control state for the current test group.

### GroupRuntimeConfig

Conceptual state:

~~~text
GroupRuntimeConfig
  groupScopeKey
  modelId
  enabledCapabilities
  revision
  updatedByPrincipal
  updatedAt
~~~

The first version only needs one configured test group.

Required behavior:

~~~text
Owner asks current group status
Owner changes model for future Runs
Owner enables or disables learning-checkin capability
Owner inspects a recent Run / failure
~~~

Model changes affect new Runs only.

Do not rewrite historical Run metadata.

Completion:

> The Owner can change the test group's model and capability binding from private chat, and the next matching group Run uses the new configuration without widening any Visitor permission.

## P3+.2 — Fixed learning check-in capability

The first group-specific capability is fixed and reviewed code.

It is not generated dynamically.

It is also not Agent Operations Task.

Keep this distinction:

~~~text
Task
  work performed by the Personal Agent or a delegated Worker

GroupAssignment
  work assigned to human participants in a group
~~~

### Minimal durable records

~~~text
ScheduleDefinition
ScheduleOccurrence
GroupAssignment
AssignmentParticipant
CompletionEvidence
~~~

No Memory tables are required.

### ScheduleDefinition

The first version supports one daily schedule for the test group.

Conceptual state:

~~~text
ScheduleDefinition
  id
  groupScopeKey
  kind = learning_assignment
  localTime
  enabled
  assignmentTemplate
~~~

### ScheduleOccurrence

Every intended publication has a durable occurrence identity.

Example idempotency key:

~~~text
schedule:<scheduleId>:<local-date>
~~~

The first implementation may use an in-process timer.

Turso stores schedule truth and occurrence truth.

Restart or repeated timer ticks must not duplicate the same daily assignment.

### GroupAssignment

Conceptual state:

~~~text
GroupAssignment
  id
  groupScopeKey
  occurrenceId
  title
  instructions
  opensAt
  dueAt
  status
~~~

### AssignmentParticipant

For the current test group, participants may be the explicitly configured test Principals.

Conceptual states:

~~~text
ASSIGNED
SUBMITTED
ACCEPTED
OVERDUE
~~~

P3+ does not need automatic overdue reminders.

### CompletionEvidence

The first version accepts explicit check-in evidence.

Examples:

~~~text
member invokes check-in behavior
member replies with completion text
Owner explicitly accepts a submission when verification is needed
~~~

The stored record keeps the source message or Run reference when available.

### Runtime surface

A normal group participant only needs the small group surface, for example:

~~~text
learning_checkin
learning_assignment_status
~~~

The Owner private surface may expose:

~~~text
owner_learning_progress
owner_learning_assignment_get
~~~

Completion:

> One real daily assignment is automatically posted in the test group, at least two test identities can end in different completion states, and the Owner can privately inspect the current progress.

## Persistence rule

Structured product state is not Memory.

P3+ records:

~~~text
group runtime configuration
capability bindings
schedule definitions
schedule occurrences
assignments
participant states
completion evidence
~~~

These records exist because the product needs deterministic behavior.

They are not automatically injected into model Context.

They are not Semantic Memory or Episodic Memory.

P4 may later use selected P3+ evidence as input to Memory Candidate creation.

## Security

At minimum prove:

~~~text
Visitor cannot invoke Owner Actions
group prompt cannot claim Owner identity
group Run cannot list Owner-only Tool schemas
disabled group capability disappears from the next Run surface
call-time Tool authorization still runs
model switch cannot widen permission
duplicate scheduler tick does not duplicate post
duplicate QQ event does not duplicate check-in
Owner-only progress detail is not delivered to an unauthorized audience
~~~

## Code placement guidance

Expected Glassbox-owned boundaries may include:

~~~text
apps/server/src/
  runtime/capabilities/
  owner/
  group/
  schedule/
  assignments/
~~~

Use existing auth, conversation, persistence, runtime, delivery, and trace code instead of creating parallel systems.

The exact directory layout is not frozen.

## Deferred group operations

After this Plan proves real use, later work may add:

~~~text
automatic overdue reminders
weekly reports
streaks and scoring
more group-specific fixed templates
Group Tool Registry
template-driven capability creation
multi-group Owner snapshot
controlled Tool code generation
~~~

These do not need to block P4 Memory work.

## Relationship to P4

P4 remains the first Memory / Taste phase.

P3+ produces evidence that P4 can later learn from.

Example:

~~~text
P3+ now
  AssignmentParticipant = ACCEPTED
  CompletionEvidence = message reference

P4 later
  selected assignment outcome
  → Memory Candidate
  → scope / reliability / visibility checks
  → promoted Memory when justified
~~~

Do not skip the promotion and authorization layer.

## Completion gate

P3+ is complete only when all are true:

- one real test group has a persisted GroupRuntimeConfig;
- Owner private chat can read the group config;
- Owner can change the model for future group Runs;
- Owner can enable or disable the learning-checkin capability;
- RunCapabilitySet or an equivalent server-side projection filters model-visible Tool definitions;
- group Runs do not receive Owner-only Tool schemas;
- protected Tools still re-authorize at execution;
- one daily learning schedule survives restart without duplicate occurrence creation;
- one real assignment is delivered to the test group;
- at least two configured participants can have different durable progress states;
- explicit check-in evidence is persisted;
- Owner can privately query progress;
- no Memory, Taste, cross-group learning, reminder engine, weekly report engine, or Tool generation is required to pass the gate.

When this gate passes, either P4 may begin or a later bounded group-operations slice may be chosen based on real usage.
