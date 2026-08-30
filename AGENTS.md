# Glassbox

Glassbox is a canvas-native Agent research workbench for running, inspecting, steering, and studying AI agents.

The canvas is the primary workspace. Agent work, artifacts, editable research inputs, and inspection tools stay visible without turning raw execution events into a node graph.

Glassbox connects to existing agents. It should help people understand and improve how those agents work without forcing every provider into the same behavior.

## What makes Glassbox special?

### 1. Open at the core

Glassbox is built in the open. Keep the code, architecture, product decisions, experiments, and important tradeoffs understandable.

Prefer open formats and replaceable components when they make the system simpler.

Do not add abstraction only to make the architecture look complete.

### 2. Canvas-native

The canvas is the workspace. It is not decoration around a chat page.

Plans, artifacts, files, diffs, tests, sources, annotations, results, and selected research inputs can become persistent Canvas Objects.

Keep normal whiteboard behavior useful. Text, drawing, arrows, images, frames, web references, and annotations are part of the workspace.

Do not turn the product into a node workflow builder.

Spatial relationships do not change execution by themselves.

### 3. Agent-native, not agent-specific

Glassbox connects to existing agents instead of replacing every Agent loop.

Providers may expose different tools, events, approval flows, context behavior, and lifecycle controls. Keep provider-specific behavior close to the provider integration.

Share only the concepts Glassbox actually needs.

Do not flatten useful provider behavior just to produce a cleaner common interface.

### 4. Researchable by default

Glassbox should preserve enough evidence to answer:

- What did the Agent actually receive?
- What did it do?
- What changed during the run?
- Who changed it?
- Which result came from which configuration?

Prompt, Plan, Context, Skill, Tool Config, Artifact, and other execution-relevant inputs may become editable research objects when the current plan needs them.

Editing must not erase what an active or completed Run actually used.

### 5. Quiet by default

Show the work that matters now.

Keep raw logs, full event streams, metadata, and deep Trace details behind inspection.

Use this order:

```text
Work → Inspect → Understand
```

Chat is optional UI. Closing Chat must not make the current Run impossible to understand.

### 6. Performance without compromise

An infinite canvas receiving live Agent activity can get slow quickly.

Watch for broad rerenders, too many live shapes, large payloads, heavy DOM nodes, large diffs, noisy logs, expensive visual effects, and state that grows without a limit.

Treat performance regressions as bugs.

Do not turn every raw event into a Canvas Object.

## Project owner note

When a requirement is ambiguous, choose the smaller implementation that preserves the product rules in this file.

Do not silently expand the task.

Do not create abstractions for providers, clients, protocols, research models, or product ideas that the current plan does not need.

If the current task conflicts with a rule in this file, stop and ask for approval before breaking the rule.

Product history and future ideas belong in project notes. Current implementation scope belongs in `.plans/`. This file should contain rules that remain useful across plans.

## A small glossary

Use these terms consistently.

- **you** means the coding Agent reading this file and changing Glassbox.
- **we**, **us**, and **maintainers** mean the people building and maintaining Glassbox.
- **user** means the person using Glassbox.
- **agent** means the AI Agent doing work through Glassbox.
- **provider** means an external Agent runtime or harness that Glassbox connects to.
- **runtime** means the Glassbox-side process or module that manages provider interaction and Run lifecycle.
- **project** means the working environment associated with real files, repositories, or another execution target.
- **session** means durable work that the user can leave and return to.
- **run** means one concrete Agent execution inside a Session.
- **raw trace** means the provider-level execution record kept as evidence of what happened.
- **derived state** means Glassbox's interpretation of provider activity for product behavior.
- **event** means a normalized record of something that happened during a Run.
- **canvas** means the interactive 2D workspace.
- **canvas object** means something shown on the Canvas because it helps the user understand, edit, inspect, or act on the work.
- **artifact** means a durable output such as a file, diff, document, image, webpage, dataset, or generated design.
- **revision** means a saved version of an execution-relevant object or Artifact.
- **provenance** means the information needed to know where a value came from, who changed it, and when it affected execution.
- **action** means an explicit command that may change Agent execution or Session state.
- **inspector** means contextual detail UI for a selected object.
- **chat** means an optional conversation UI. Chat is not the source of truth for Session or Run state.

Keep these distinctions clear:

```text
Session ≠ Run
Event ≠ Canvas Object
Artifact ≠ Canvas Object
Canvas Object ≠ tldraw Shape
Agent ≠ Avatar
Canvas ≠ Execution State
Raw Trace ≠ Derived State
Edit ≠ Apply
```

Avoid using `node` as the default name for Canvas Objects. Use it only when the code is actually dealing with a graph node or a library type that uses that term.

## The easiest ways to hurt this project

1. **Turning raw activity into node spam.** Raw provider events belong in Trace. Only materialize objects that help the user understand or act on the work.

2. **Giving layout hidden execution meaning.** Moving, grouping, connecting, resizing, or annotating Canvas Objects must not silently change a running Agent.

3. **Rewriting history.** Never overwrite Raw Trace or execution-relevant values in a way that makes an old Run appear to have used a newer Prompt, Plan, Context, Tool Config, Skill, or Artifact revision.

4. **Making the Canvas the source of truth.** tldraw state is a projection of Glassbox objects and UI state. Core Run, Artifact, Plan, Context, and research state must not depend on tldraw shape records.

5. **Designing for imaginary future systems.** Do not add abstractions or product systems that the current plan does not need. Keep parked ideas in project notes until a real task requires them.

## Explicit execution semantics

Edit freely. Execute explicitly.

Canvas edits do not change Agent execution by themselves.

Only a named Action may change execution. Examples include:

```text
Apply
Steer
Approve
Stop
Add to context
Remove from context
Use from next turn
Run from here
```

The UI must make the difference between a draft edit and an applied change obvious.

If an execution-relevant value changes during a Run, preserve enough information to reconstruct what the Run started with and when the new value took effect.

## Preserve evidence

Keep Raw Trace separate from Derived State.

Raw Trace records what happened. Do not rewrite it to match the current UI model.

Derived State may change as Glassbox learns to interpret provider activity better.

A visible claim about a Run should be traceable to evidence when practical.

Measurements and judgments are different. Token counts, tool calls, duration, file changes, and exit codes are measurements. Eval scores, LLM judgments, and human review are judgments. Do not merge them into a fake universal score.

## Check every affected path

Before calling a change done, check the parts that apply.

- **Entry points.** The same Action may appear in the Canvas, Inspector, Chat, context menu, command palette, or keyboard shortcut.
- **Execution semantics.** Confirm that layout changes stay harmless and explicit Actions are the only path that changes execution.
- **Provider behavior.** If a feature depends on a provider capability, define what happens when that provider does not support it.
- **Contracts.** When cross-boundary state changes, check every producer and consumer.
- **Persistence and resume.** Decide what survives refresh, reconnect, Session reopen, and runtime restart.
- **Provenance.** Execution-relevant edits must preserve which revision was used, who changed it, and when it took effect.
- **Canvas projection.** Verify both Glassbox state and visible tldraw behavior when selection, grouping, restore, or custom shapes matter.
- **Reverse states.** If something can be opened, applied, approved, stopped, pinned, grouped, or attached, define how the user leaves or reverses that state when reversal makes sense.
- **Docs.** Update the current plan or stable internal docs when behavior or a settled boundary changes.

## Dev servers

Document only commands that exist in the current repository.

Before running a command, inspect the repository scripts and tool configuration. Do not invent commands, ports, paths, or environment variables because an old note mentioned them.

Do not hardcode a localhost origin into client code unless the current architecture requires it and the plan says so.

Stop only processes you started or processes you verified belong to the current development instance.

## Test data

Never use the user's live Glassbox state as writable test state.

Use repo-local or otherwise disposable test state.

Reading or copying real data for debugging is acceptable when needed. Write to a safe copy.

Never point tests, migrations, cleanup jobs, or test Agents at the user's real repositories or live Glassbox data.

> Copy in. Never point in. Never write back.

Use realistic fixtures when empty state or tiny mocks would hide the behavior being tested.

## Verifying

Prove the change with the smallest useful check.

Behavior changes need focused tests for the behavior that changed.

Runtime changes should test runtime behavior. Canvas changes should test the state projection or interaction that changed.

Async tests should wait on a real completion signal, event, promise, drain, or state transition. Do not make timing-sensitive tests pass with arbitrary sleeps when a real signal exists.

Run browser-level verification when the behavior depends on real tldraw interaction, selection, drag and drop, visual state, or browser APIs.

Do not launch unrelated browsers, simulators, external processes, or broad test suites unless the task needs them.

For tldraw behavior, test both the underlying Glassbox state and the visible Canvas behavior when both matter.

## Delivery cadence

These rules govern the build loop itself. They exist because slices were left uncommitted and roadmap entries went unlogged until the owner intervened.

Commit directly to main as soon as a slice passes its verification (tests plus browser checks when they apply). Never accumulate more than one verified slice without a commit.

Log the slice to the roadmap before starting the next one: update the Notion roadmap DB row when one exists, otherwise append a dated entry to the Delivery page. Keep roadmap writes append-only.

One ticket, one concern. Before dispatching a browser-verification ticket, verify the server layer with curl or direct API calls first. Keep the slice small enough to finish in one session.

Run tickets that will take longer than about 15 minutes detached: background process, a progress file the ticket appends to, and periodic polling. Never block on a foreground wait that a timeout will kill.

## Pull requests

Commit straight to main. Open a Pull Request only when the user asks for one.

Push only when the user asks. Local commits ahead of the remote are an acceptable resting state between slices.

Keep one main concern per PR.

Use the repository's existing commit and PR conventions. Do not invent a new convention inside one change.

For user-visible UI changes, include before and after screenshots when practical. Use a short recording when motion, timing, drag and drop, or multi-step interaction is the point of the change.

Treat automated review findings as claims to verify against the source. Fix the issue when the finding is real. Do not change code just to satisfy a bot comment that does not match the code.

## How it works

The intended product boundary is:

```text
Provider / Agent runtime
        ↓
     Raw Trace
        ↓
Normalization and interpretation
        ↓
   Derived State
        ↓
  Canvas Objects
        ↓
 tldraw projection
```

Execution changes travel the other way through explicit Actions:

```text
User or Agent Action
        ↓
 Glassbox command
        ↓
 Runtime / Provider
```

Keep these rules true even if the internal implementation changes:

- Raw Trace and Derived State are separate.
- Canvas is not the source of truth for execution.
- tldraw Shapes are a view of Glassbox objects.
- Provider quirks stay close to the provider integration.
- Explicit Actions change execution. Layout does not.
- Chat is optional UI.

Do not document a layer as implemented until it actually exists.

## Where code lives

Follow the current repository structure.

Do not create directories or shared packages only because an old design note proposed them. Follow the structure that actually exists and change it only when the current task needs a new boundary.

Keep provider-specific code near the provider integration.

Keep tldraw-specific code near the Canvas projection and interaction code.

Put cross-boundary contracts in the smallest existing shared location that needs them.

Create a new shared package only when more than one real consumer needs the code and keeping it local would create duplication or a dependency problem.

## Taste

Use the smallest model that solves the current problem.

Do not add abstractions for providers, clients, protocols, research objects, or future product modes that do not exist yet.

Reuse mature code when it already solves the problem well. Do not rebuild standard Chat UI, Canvas behavior, streaming helpers, or provider integration code just to own it.

Prefer explicit state transitions over inferred magic.

Keep provider quirks out of generic product state.

Keep tldraw quirks out of core Agent and research state.

A tldraw Shape is a view of a Glassbox object, not the object itself.

The UI must not lie. A spinner means work is pending. Success means the underlying work finished. A draft edit must not look applied. A disconnected Agent must not look active.

Prefer inferred TypeScript types when the compiler already knows the type. Avoid `any`. Validate unknown external data when it enters the system.

Comments should explain intent, constraints, or non-obvious behavior. Do not narrate obvious code.

Keep the Canvas responsive during long Runs.

Do not grow the task while fixing it. Record adjacent work instead.

## Additional tips

Use current project tools and upstream patterns before adding a dependency or service.

Do not pull parked product ideas into the current plan because they sound likely.

Research notes, future ideas, rejected alternatives, and open product questions belong outside this file.

If a rule here becomes wrong because the product changed, update the rule. Do not work around it silently.
