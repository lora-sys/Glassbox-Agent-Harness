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

After the first test-group loop proves useful, later slices may add:

~~~text
automatic overdue reminders
weekly reports
streaks
scoring
more fixed group feature templates
Group Tool Registry
template-driven group capability creation
multi-group Owner snapshot
controlled new Tool development
~~~

These are not part of the P3+ completion gate.

## Deferred learning

Cross-group learning requires P4 Memory foundations.

Later flow may be:

~~~text
group evidence
→ Memory Candidate
→ scope + visibility + reliability
→ group-scoped Memory
→ authorized Owner retrieval
~~~

One group's evidence must not become another group's Context by default.

Cross-group synthesis and system-improvement proposals remain later work.

## Deferred Tool creation

When the system later creates group-specific capabilities, prefer this order:

~~~text
configuration
→ fixed template
→ Skill
→ new executable Tool code
~~~

Do not start with arbitrary generated Tool code.

New executable capability should require tests, a permission manifest, versioned activation, and Owner approval where appropriate.

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
