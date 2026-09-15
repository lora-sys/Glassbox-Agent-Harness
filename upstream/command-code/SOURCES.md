# Command Code source index

Reference project: `CommandCodeAI/command-code`

Pinned upstream commit: `5c8f1b48c9d6704210cb3f9a476fdcffe5093e9a`

Upstream branch at review time: `main`

Repository metadata did not expose a license at review time. Treat this as a research reference only. Do not vendor code until license terms are confirmed.

Public product documentation:

```text
https://commandcode.ai/docs/taste
https://commandcode.ai/blog/taste-skills-rules
https://commandcode.ai/launch
```

## Why it matters

Command Code is a useful reference for one narrow problem: learning user coding preferences from behavior instead of forcing users to maintain a growing prompt.

Its public Taste documentation describes these signals:

```text
accept
reject
edit
```

and describes separate project-level and user-level Taste controls.

Glassbox extends that idea with its own product requirements:

```text
Rules ≠ Skills ≠ Taste ≠ Memory
FeedbackEvent evidence before preference promotion
confidence
supporting and contradicting observations
recency
scope
Glassbox authorization
project isolation
runtime-independent preference truth
```

## Adoption boundary

Command Code is not a Glassbox dependency.

Do not depend on its proprietary Taste model, internal backend, hosted Studio, or undocumented implementation.

Glassbox owns:

```text
FeedbackEvent
TasteCandidate
TasteEntry
confidence and scope
promotion / demotion
Memory
retrieval
authorization
provenance
```

Lora PI Kit may bridge selected Taste into Pi, but canonical preference truth remains Glassbox-owned.

## Patterns worth adopting

### Behavior is signal

Users should not need to manually write every preference.

Useful events include:

```text
accept
reject
edit
revert
repeated correction
explicit positive feedback
explicit negative feedback
```

### Taste is separate from Rules and Skills

Rules are explicit constraints.

Skills are reusable procedures.

Taste is learned preference.

Do not turn a preference into a hard Rule merely because it was observed repeatedly.

### Scope matters

P4 starts with:

```text
global
project
```

A project preference must not silently become a global preference.

### Continuous learning should remain inspectable

Glassbox should preserve the feedback evidence behind a TasteEntry so the user can understand why a preference exists and why its confidence changed.

## Patterns Glassbox should not copy blindly

Do not assume:

```text
one edit means permanent Taste
all Taste should be injected every turn
project Taste is safe globally
Taste replaces Semantic / Episodic Memory
Taste can bypass authorization
Runtime-specific preference files are the system of record
```

## Glassbox target loop

```text
Runtime output
→ user behavior
→ FeedbackEvent
→ TasteCandidate
→ confidence update
→ scoped Taste Store
→ task-aware retrieval
→ selected Taste projection
→ Runtime Context
```

See `docs/memory-taste.md` for the Glassbox architecture.
