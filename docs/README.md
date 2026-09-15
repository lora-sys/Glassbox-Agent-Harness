# Glassbox Documentation Site

Status: DESIGN / CONTENT FOUNDATION

This directory defines the public documentation and learning experience for Glassbox.

The documentation site should help a technically curious user understand Glassbox's key mechanisms without requiring them to read the repository first.

The target is not a reference manual with a search box. The target is a concept-learning site with interactive demonstrations.

## Architecture references

The cross-cutting data, storage, observability, analytics, and public read boundary is defined in [`data-observability.md`](./data-observability.md).

The execution-runtime ownership boundary between Glassbox, Pi, Lora PI Kit, Codex, Claude Code, and Herdr is defined in [`runtime-strategy.md`](./runtime-strategy.md).

The bidirectional Task / Attention / worker coordination boundary is defined in [`agent-operations.md`](./agent-operations.md).

The Rules / Skills / Taste / Feedback / Memory learning boundary is defined in [`memory-taste.md`](./memory-taste.md).

Those documents fix these ownership rules:

```text
Glassbox
  product, trust, Conversation, Task, Taste, Memory, review and evidence boundary

Pi
  primary Personal Agent runtime foundation

Lora PI Kit
  maintainer-owned Pi configuration and extension layer
  may bridge selected Taste / Memory into Pi
  not canonical Taste / Memory truth

Herdr
  live coding-worker execution host and lifecycle observation layer

Codex / Claude Code
  supported alternate runtimes and worker backends
```

The data and observability architecture also fixes the current Web access rule:

```text
Owner
  full management and private observability

Public visitor
  read-only access to explicitly published Trace or Eval projections only
```

The public documentation site is separate from both the Owner control plane and the public Trace / Eval observer pages.

## Audience

The site should serve several readers without turning every page into a generic introduction:

```text
User
  wants to understand what the Agent can do and why permissions matter

Builder
  wants to understand the runtime model and integrate a Channel, Tool, Worker, Runtime, or Agent Operations host

Contributor
  wants to understand invariants, architecture, contracts, evidence, and upstream decisions

Researcher
  wants to inspect routing, memory, taste learning, eval, token economy, task coordination, and learning behavior
```

Each page should state which audience it is primarily for.

## Core teaching model

Every important concept should follow this progression where appropriate:

```text
1. Explain
2. Show the mechanism
3. Let the reader change inputs
4. Show the resulting state transition
5. Show the evidence
6. Link to the real contract or implementation when it exists
```

A reader should leave a page knowing what the concept means, why Glassbox needs it, what can go wrong, and where the invariant is enforced.

## Truthfulness rule

Every capability page must show a visible lifecycle status:

```text
Implemented
Experimental
Planned
```

Do not document future architecture using present-tense claims that imply production support.

When implementation changes, update the documentation status before adding more polish.

## Proposed information architecture

### Start Here

```text
What is Glassbox?
Why one durable Personal Agent?
Why authorization comes before intelligence
How to read a Run
How the main Agent tracks work
How Glassbox learns preference without growing one giant prompt
Current implementation status
Roadmap
```

### Core Concepts

```text
Agent
User and Principal
Identity Resolution
Authorization
Permission and Approval
Conversation
Session
Run
Task
TaskAttempt
AttentionItem
WorkerBinding
Tool
Runtime
Provider
Worker
LongTask
Rule
Skill
Taste
FeedbackEvent
Memory
Asset
Trace
Derived State
Canvas Projection
Eval
```

### Trust and Safety Architecture

```text
Default deny
Authorize before Context
Protected Tool re-authorization
Agent Ops authorization
Confused deputy
Delegation can only reduce authority
Revocation
Approval replay protection
Private / public visibility
Delivery authorization
Taste / Memory scope isolation
Trace redaction
```

### Runtime

```text
Glassbox Runtime Boundary
Pi and Lora PI Kit
Codex and Claude Code adapters
Agent loop
Tool boundary
Context assembly
Context budgets
Tool-result budgets
Routing
Retries
Persistence
```

### Agent Operations

```text
Main Agent and workers
Attention Queue
Task state machine
TaskAttempt
WorkerBinding
AgentOpsSnapshot
HerdrBridge
Herdr working / blocked / done
Snapshot reconciliation
Review and rework
Herdr-workflows boundary
Local test to server deployment
Moshi as optional remote operations client
```

The docs must make this distinction explicit:

```text
Herdr Agent state = execution observation
Glassbox Task state = product truth
```

### Taste, Memory and Learning

Start with the stable split:

```text
Rules
  explicit hard constraints

Skills
  reusable validated procedures

Taste
  learned user preferences

Memory
  durable facts, decisions, events, and prior-work knowledge
```

The docs must keep these distinctions visible:

```text
Rules ≠ Skills ≠ Taste ≠ Memory
```

Teach at least:

```text
FeedbackEvent
accept / reject / edit / revert
TasteCandidate
confidence
supporting vs contradicting evidence
global vs project scope
promotion / demotion
task-aware Taste retrieval
Semantic Memory
Episodic Memory
Memory candidates
promotion
forgetting and staleness
contradiction handling
Authorized Retrieval
Skill evolution
Asset lineage
Journal and review
```

A stable reusable procedure should be taught as a Skill rather than left inside a generic "procedural memory" bucket.

### Observability

```text
Raw Trace
AuthorizationDecision
Derived State
Timeline
Inspector
Canvas
Replay
Cost and token usage
Task / worker state
Attention Queue
Review / rework evidence
Feedback evidence
Taste confidence / scope / retrieval reason
Memory promotion / retrieval evidence
Public Trace publication
Public Eval publication
```

### Eval Lab

```text
Benchmark
Differential Eval
Invariant Eval
Routing Eval
Permission Eval
Taste Eval
Memory retrieval Eval
Task / worker Eval
```

Taste Eval should measure correction reduction, not only how many preferences exist.

Useful concepts include:

```text
Correction Rate
Revert Rate
Taste Hit Rate
Preference Compliance
False Preference Rate
Scope Leakage Rate
```

### Build with Glassbox

```text
Add a Channel
Add a Tool
Add a Runtime adapter
Add a Worker
Add an Agent Operations adapter
Add a protected Resource type
Add a Feedback signal adapter
Add a Taste retrieval feature
Add a Canvas projection
Add an Eval
```

### Upstream Notes

Explain which problems Glassbox studies from mature upstream projects and which trust or product assumptions Glassbox intentionally does not copy.

The upstream Pi note should explain why Glassbox uses a separate Lora PI Kit layer rather than carrying a broad Pi fork.

The Herdr note should explain why Glassbox reuses Herdr for live workspaces, worktrees, panes, and worker lifecycle while retaining Task, acceptance, authorization, and evidence as Glassbox-owned state.

The Command Code note should explain the useful Taste pattern: accept, reject, and edit behavior can become preference-learning signals, while Glassbox still owns confidence, scope, authorization, provenance, and durable Taste truth.

## Page anatomy

A concept page should usually contain:

```text
Status
One-sentence definition
Why it exists
Minimal model
Interactive demo or executable example
Failure mode
Glassbox invariant
Evidence produced
Related concepts
Implementation links
Upstream references
```

Do not force this shape when a page is naturally a short reference page.

## Visual language

Use the same domain vocabulary as the product.

Prefer state diagrams, timelines, flow diagrams, small tables, and event traces over decorative illustrations.

Diagrams must distinguish:

```text
trusted boundary
untrusted input
persistent state
ephemeral execution
external execution observation
learned preference
hard Rule
derived projection
human approval / review
```

Canvas screenshots should explain projection behavior rather than implying Canvas is the execution source of truth.

Herdr screenshots should explain live execution state rather than implying a pane or workspace is the Task database.

## Interactive demo principles

Interactive demos are part of the curriculum.

They should be:

```text
deterministic by default
fast
resettable
mobile-usable
keyboard-usable
safe to run locally
based on synthetic fixtures
explicit about what is simulated
```

A demo should expose a real mechanism, not merely animate a diagram.

Good interactions include:

```text
change Principal
change Resource visibility
Grant or Revoke permission
attempt a protected Tool call
simulate worker working / blocked / done
accept or rework a Task
simulate Herdr reconnect reconciliation
accept / reject / edit an Agent result
change Taste evidence and confidence
switch global vs project Taste scope
inspect why one Taste was retrieved
change retrieval weights
change context budget
change task difficulty
inspect generated events
step through a LongTask state machine
```

Bad interactions include buttons that only reveal paragraphs or animations with no change in system behavior.

## Relationship to production code

The first version of a demo may use a small deterministic model of the mechanism.

Once a production contract becomes stable, prefer sharing types, schemas, fixtures, or pure functions where this does not create a runtime dependency from production code into the docs site.

Never duplicate a security invariant in client-only demo code and then treat the demo as proof that the product is secure.

Never duplicate a fake Task state machine in docs and present it as proof of Herdr integration correctness.

Never create a client-only Taste simulator and treat it as proof that production scope or authorization is correct.

Production authorization, Task truth, Taste truth, and Memory truth remain server-side.

## Data safety

Public documentation demos must not require:

```text
real Personal Agent state
real user Taste
real user Memory
private FeedbackEvents
private Conversation history
production credentials
private repositories
real Herdr workspaces or worker output
real Mail or Calendar data
production Trace containing protected payloads
```

Use synthetic fixtures specifically designed to show both allowed and denied paths.

Public production observation is a different surface. It may expose only the sanitized publication snapshots defined in [`data-observability.md`](./data-observability.md), and only for Trace or Eval.

## Search and navigation

Search should prioritize concepts and terminology, not only exact page titles.

Important aliases should resolve to the canonical concept. For example:

```text
chat history -> Conversation
permission prompt -> Approval
agent session -> distinguish Conversation / Session / Run
job / task -> distinguish Task / TaskAttempt / Run / LongTask
worker status -> Agent Operations and WorkerBinding
Herdr done -> Task review, not automatic acceptance
coding preference -> Taste
accept / reject / edit learning -> FeedbackEvent and Taste
procedural memory -> Skill when it is a stable reusable procedure
facts from prior work -> Semantic Memory
past task outcome -> Episodic Memory
logs -> Trace
RAG -> Authorized Retrieval
model router -> Execution Routing
Pi config -> Lora PI Kit and Runtime Strategy
```

The site should make conceptual distinctions easier to discover, not silently collapse them.

## Site implementation boundary

Do not create an `apps/docs` package until implementation work actually begins.

When the site implementation starts, choose a stack that supports:

```text
MDX or equivalent content
React-quality interactive islands or components
static generation
code highlighting
versionable content
accessible client-side demos
fast local authoring
search
```

Prefer a mostly static documentation site. Interactive demos should hydrate only where needed.

The docs site is not the Personal Agent runtime and should not become a second control plane.

## First publishing milestone

The first useful public version does not need every future concept.

A strong initial release after P3 should include:

```text
What is Glassbox?
Architecture overview
Identity vs Authorization
Owner vs Visitor interactive demo
Permission vs Approval interactive demo
Authorize before Context interactive demo
Conversation vs Session vs Run
Task vs TaskAttempt vs Run
Attention Queue
Herdr state vs Task acceptance
Review / rework demo
Trace and AuthorizationDecision
Canvas is a Projection
Runtime strategy
Agent Operations strategy
Current status and roadmap
```

After P4 is implemented, add the first learning lab for:

```text
Rules vs Skills vs Taste vs Memory
FeedbackEvent
Taste confidence
Global vs Project scope
Task-aware Taste retrieval
Semantic vs Episodic Memory
Authorized Retrieval
```

The P3 publishing acceptance test is:

> A new engineer can spend 20 minutes on the site and correctly explain who is acting, what they are allowed to access, what a Conversation is, what a Run is, what a Task and TaskAttempt are, why Herdr `done` does not mean accepted, why Canvas is not execution state, where evidence comes from, and why Pi runtime customization lives in Lora PI Kit instead of the Glassbox domain model.

See `.plans/roadmap.md` for sequencing and `docs/interactive-demos.md` for the demo curriculum.
