# Interactive Demo Curriculum

Status: DESIGN

These demos teach Glassbox concepts by letting the reader manipulate a small system and inspect the resulting state and evidence.

They are documentation experiences, not production control surfaces.

## Demo 01 — Owner vs Visitor

Teaches:

```text
Identity ≠ Authorization
Default deny
Public vs private Resource
```

Initial fixture:

```text
Agent: Lora Agent
Principals:
  Owner
  Visitor
Resources:
  public_profile
  private_notes
```

Controls:

```text
select Principal
select Resource
attempt Read
Grant
Revoke
reset
```

Output:

```text
ALLOW / DENY
policy reason
model-visible data
AuthorizationDecision event
```

The critical lesson is that a known Visitor identity still has no permission unless a valid grant exists.

## Demo 02 — Permission vs Approval

Teaches:

```text
Permission ≠ Approval
Approval cannot manufacture authority
Approval is consumable evidence
```

Scenario:

```text
Action A: public read
Action B: owner-approved send
Action C: owner-only secret read
```

The reader should see that approving C does not make an unauthorized Visitor authorized.

Show approval creation, consumption, replay rejection, and linked evidence.

## Demo 03 — Authorize Before Context

Teaches the most important context-safety invariant.

Show two pipelines side by side.

Forbidden:

```text
load private + public data
→ put both in prompt
→ tell model not to reveal private data
```

Required:

```text
resolve Principal
→ authorize Resource set
→ load allowed data only
→ assemble Context
```

Controls:

```text
Principal
resource visibility
permission state
prompt-injection attempt
```

Output should show the exact model-visible Context after filtering.

Private fixture content should literally disappear from the Visitor-side context rather than appear redacted after model assembly.

## Demo 04 — Conversation vs Session vs Run

Teaches:

```text
Conversation ≠ Session
Session ≠ Run
```

Use a timeline where one durable Conversation survives:

```text
browser refresh
provider reconnect
multiple Runs
server restart
```

Let the reader trigger a new Run and restart the simulated runtime while preserving Conversation identity.

Show IDs and lifetimes explicitly.

## Demo 05 — Raw Trace to Derived State to Canvas

Teaches:

```text
Event ≠ Canvas Object
Raw Trace ≠ Derived State
Canvas ≠ Execution State
```

Start with a short event stream:

```text
run.started
tool.called
tool.result
file.changed
test.completed
authorization.decided
run.completed
```

Let the reader step event by event.

Show three synchronized panes:

```text
Raw Trace
Derived State
Canvas Projection
```

Controls may change Canvas grouping or layout, but the Raw Trace and execution state must not change.

## Demo 06 — Memory Retrieval Lab

Target phase: after P5.

Teaches authorized hybrid retrieval.

Synthetic memory corpus should include:

```text
public evergreen memory
private owner memory
recent episodic memory
old episodic memory
lexically exact but semantically weak result
semantically similar but lexically weak result
near-duplicate results
```

Controls:

```text
Principal
vector weight
lexical weight
source weight
time decay on/off
MMR on/off
max results
context budget
```

Visualization:

```text
authorization filter
→ candidate recall
→ score composition
→ rerank
→ selected Context
```

Private Owner-only candidates must be absent before scoring for a Visitor.

## Demo 07 — Context Budget Simulator

Target phase: after P6.

Inspired by OpenSquilla's `ContextBudgetGovernor`.

Controls:

```text
model context window
max output tokens
thinking budget
overflow threshold
conversation size
memory size
retrieval size
tool-result size
```

Show:

```text
reserved output
reserved thinking
usable context
provider request budget
tool argument budget
tool result budget
what gets projected or dropped
```

The reader should be able to create an overflow and see how the policy responds without losing Raw Trace evidence.

## Demo 08 — Tool Result Projection

Target phase: after P6.

Teaches why full Tool output and model-facing Tool output are different things.

Fixture examples:

```text
large Git diff
web search result set
command output
large JSON API result
```

Show:

```text
Raw Tool Result
→ classification
→ budget
→ rule-driven projection
→ Model-facing Result
```

Display character or token counts before and after projection.

Do not claim compression quality from size reduction alone. Include a small required-facts checklist for the fixture and show whether projected output retained them.

## Demo 09 — Execution Routing Lab

Target phase: after P6.

Inspired by OpenSquilla routing concepts but adapted to Glassbox's wider execution policy.

Fixture tasks should span:

```text
simple factual reply
small formatting task
normal coding task
large repo investigation
high-risk protected action
debugging with long context
```

Controls:

```text
router on/off
task
cost ceiling
allowed providers
quality preference
```

Show selected:

```text
route class
model tier
provider
model
thinking level
prompt policy
context budget
retrieval budget
tool budget
reason
```

The router cannot alter Principal or authorization scope.

## Demo 10 — Router Eval

Target phase: after P6 Eval support.

Compare two configurations over fixed samples:

```text
Router OFF
Router ON
```

Show:

```text
task success
permission invariant failures
input tokens
output tokens
estimated cost
latency
route distribution
fallback count
```

The point is to teach evidence-based optimization.

A cheaper configuration is not better if task success or permission correctness falls outside the accepted threshold.

## Demo 11 — LongTask State Machine

Target phase: after durable LongTask support.

Controls:

```text
start
fail step
retry
wait for approval
send signal
cancel
resume
```

Show durable state transitions and append-only events.

Restart the simulated worker in the middle of a task and demonstrate that the task state survives.

## Demo 12 — Memory Promotion

Target phase: after the learning loop exists.

Teaches:

```text
Conversation history is not automatically Memory
one successful Run is not automatically a permanent Skill
visibility cannot widen during learning
```

Show a candidate moving through:

```text
Evidence
→ Candidate
→ Value / Privacy / Dedup checks
→ Eval
→ Promote or Reject
```

The reader should be able to modify reliability, reuse count, contradiction, staleness, and privacy risk and see the promotion decision change.

## Shared demo requirements

Every demo should include:

```text
Reset
Current simulated state
Inputs
State transition
Evidence / event output
What is simulated
Related real concept
Lifecycle status
```

Do not hide the interesting mechanism behind animation.

Prefer small data sets that fit on screen and make every state transition inspectable.

## Accessibility

All primary interactions must work without drag.

Use native form controls where possible. Keyboard users must be able to complete every lesson. State changes need visible text, not color alone.

Respect reduced-motion preferences.

## Fixture policy

Fixtures are public synthetic learning data.

They should intentionally include:

```text
allowed path
denied path
stale state
revoked permission
ambiguous retrieval
large Tool result
fallback routing
```

Never use copied private user data to make a demo feel realistic.

## Implementation order

Do not build all demos at once.

First public set after P3:

```text
01 Owner vs Visitor
02 Permission vs Approval
03 Authorize Before Context
04 Conversation vs Session vs Run
05 Raw Trace to Derived State to Canvas
```

The next set should be driven by actual shipped runtime features, not by the roadmap alone.
