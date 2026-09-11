# Glassbox Documentation Site

Status: DESIGN / CONTENT FOUNDATION

This directory defines the public documentation and learning experience for Glassbox.

The documentation site should help a technically curious user understand Glassbox's key mechanisms without requiring them to read the repository first.

The target is not a reference manual with a search box. The target is a concept-learning site with interactive demonstrations.

## Audience

The site should serve several readers without turning every page into a generic introduction:

```text
User
  wants to understand what the Agent can do and why permissions matter

Builder
  wants to understand the runtime model and integrate a Channel, Tool, Worker, or Provider

Contributor
  wants to understand invariants, architecture, contracts, evidence, and upstream decisions

Researcher
  wants to inspect routing, memory, eval, token economy, and learning behavior
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
Tool
Provider
Worker
LongTask
Memory
Skill
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
Confused deputy
Delegation can only reduce authority
Revocation
Approval replay protection
Private / public visibility
Trace redaction
```

### Runtime

```text
Provider adapters
Agent loop
Tool boundary
Context assembly
Context budgets
Tool-result budgets
Routing
Retries
Persistence
Long work
```

### Memory and Learning

```text
Memory candidates
Semantic / episodic / procedural memory
Promotion
Forgetting and staleness
Contradiction handling
Authorized retrieval
Skill evolution
Asset lineage
Journal and review
```

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
```

### Eval Lab

```text
Benchmark
Differential Eval
Invariant Eval
Routing Eval
Permission Eval
Memory retrieval Eval
```

### Build with Glassbox

```text
Add a Channel
Add a Tool
Add a Provider
Add a Worker
Add a protected Resource type
Add a Canvas projection
Add an Eval
```

### Upstream Notes

Explain which problems Glassbox studies from mature upstream projects and which trust or product assumptions Glassbox intentionally does not copy.

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
derived projection
human approval
```

Canvas screenshots should explain projection behavior rather than implying Canvas is the execution source of truth.

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

Production authorization remains server-side.

## Data safety

Public documentation demos must not require:

```text
real Personal Agent state
real user Memory
private Conversation history
production credentials
private repositories
real Mail or Calendar data
production Trace containing protected payloads
```

Use synthetic fixtures specifically designed to show both allowed and denied paths.

## Search and navigation

Search should prioritize concepts and terminology, not only exact page titles.

Important aliases should resolve to the canonical concept. For example:

```text
chat history → Conversation
permission prompt → Approval
agent session → distinguish Conversation / Session / Run
logs → Trace
RAG → Authorized Retrieval
model router → Execution Routing
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
Trace and AuthorizationDecision
Canvas is a Projection
Current status and roadmap
```

The acceptance test is simple:

> A new engineer can spend 20 minutes on the site and correctly explain who is acting, what they are allowed to access, what a Conversation is, what a Run is, why Canvas is not execution state, and where evidence comes from.

See `.plans/roadmap.md` for sequencing and `docs/interactive-demos.md` for the demo curriculum.
