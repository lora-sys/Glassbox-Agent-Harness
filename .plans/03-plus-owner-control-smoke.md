# Plan P3+ — Owner Control Smoke Slice

Status: ACTIVE AFTER P3

This is a deliberately tiny post-P3 validation slice.

It exists to prove that the Owner can privately control and inspect the already-working P3 runtime without changing the original roadmap order.

P3+ is not a new product phase. It should finish quickly, then work returns to P4.

## Goal

Reuse the completed P3 foundation and prove the smallest useful Owner control loop against the current real test group.

P3+ ends when:

- Owner private chat receives an Owner-only control surface;
- Owner can inspect the current test-group runtime configuration;
- Owner can change the model used by future Runs in that test group;
- Owner can enable or disable one already-existing safe capability for that group;
- Owner can inspect one recent Run or Trace projection;
- each Run receives only the Tool definitions authorized for that Principal and location;
- the real test group cannot observe or invoke Owner-only Tool definitions;
- every protected Tool still re-authorizes immediately before execution.

The acceptance sentence is:

> The Owner can privately inspect and change the test group's runtime configuration, the next group Run reflects the change, and the group cannot see or invoke the Owner-only control surface.

## P3 foundation reused

Do not reopen or rebuild P3.

Reuse:

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

## Explicit non-goals

Do not add these in P3+:

~~~text
Taste
Memory
group assignment
learning check-in
scheduler
automatic reminders
weekly reports
streaks or scoring
Group Tool Registry
generic Tool Factory
Tool code generation
cross-group learning
multi-group dashboard
LongTask
~~~

Those stay on the existing roadmap or the later group-specific phase.

## P3+.0 — Per-Run Tool surface

Tool definitions and schemas are model-visible Context.

P3 already protects Tool execution. This slice adds filtering before Pi invocation.

Required order:

~~~text
resolve Principal
→ resolve Location + Conversation
→ resolve runtime profile and scope configuration
→ authorize candidate capabilities
→ build RunCapabilitySet
→ attach only selected Tool definitions
→ invoke Pi
→ re-authorize selected Tool before execution
~~~

Do not attach all configured Tools and rely only on call-time denial.

### RunCapabilitySet

Conceptual projection:

~~~text
RunCapabilitySet
  runId
  principalId
  conversationId
  profile
  toolDefinitionIds
  policyRevision
~~~

This is an execution projection, not an authority source.

Completion:

> A group Run does not receive Owner-only Tool definitions. An Owner private Run receives only the allowed Owner control definitions. Existing Tool execution authorization still runs.

## P3+.1 — Minimal Owner control

Use explicit protected Actions, not a free-form god command.

Initial conceptual Actions:

~~~text
owner_status
owner_group_get
owner_group_set_model
owner_group_set_tool_enabled
owner_run_inspect
~~~

The first version only needs the current real test group.

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

Model changes affect future Runs only.

Historical Run metadata is never rewritten.

The capability toggle should target one capability that already exists in the P3 runtime. Do not invent a new learning or scheduling subsystem merely to test the toggle.

Completion:

> Owner private chat can change one model setting and one existing capability binding for the test group, and the next matching group Run reflects the new configuration without widening Visitor authority.

## P3+.2 — Real smoke acceptance

Use the existing real test group.

Prove this exact loop:

~~~text
Owner private
  inspect group runtime state

Owner private
  switch model for future group Runs

Owner private
  disable one existing safe Tool

test group
  trigger a normal Run
  verify selected model
  verify disabled Tool schema is absent
  verify Owner Tool schema is absent

Owner private
  re-enable the Tool
  inspect recent Run / Trace

test group
  trigger another normal Run
  verify normal behavior returns
~~~

No scheduler or learning assignment is needed for acceptance.

## Persistence

Only persist the configuration needed for the smoke slice.

~~~text
GroupRuntimeConfig
capability binding / revision metadata
RunCapabilitySet metadata only if useful for evidence
~~~

This state is not Memory.

## Security checks

At minimum test:

~~~text
Visitor cannot invoke Owner Actions
group prompt cannot claim Owner identity
group Run cannot list Owner-only Tool schemas
disabled capability disappears from the next Run Tool surface
revoked capability does not survive stale runtime state
model switch cannot widen permission
call-time Tool authorization still runs
Owner inspection output is delivered only to Owner-private audience
Trace records the relevant configuration revision
~~~

## Completion gate

P3+ is complete only when all are true:

- one real test group has a persisted runtime configuration;
- Owner private chat can inspect it;
- Owner can change the model for future group Runs;
- Owner can enable or disable one existing safe capability;
- the next matching Run uses the new configuration;
- RunCapabilitySet or an equivalent server-side projection filters model-visible Tool definitions;
- group Runs do not receive Owner-only Tool schemas;
- protected Tools still re-authorize at execution;
- Owner can inspect one recent Run or Trace projection;
- no Memory, learning assignment, scheduler, reminder, report, Tool Registry, or Tool generation work is required.

When this gate passes, stop expanding P3+ and continue with P4.
