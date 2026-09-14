# Pi source index

Reference project: `earendil-works/pi`

Pinned upstream commit: `ceea48f5d5d12fd7915dfefba2835ccd55f23bb9`

Upstream branch at review time: `main`

License: MIT.

Pi is the primary upstream reference for the future Glassbox local Agent runtime path. Glassbox does not import production code from this directory.

## Why it matters

Glassbox needs a runtime foundation that can stay small while allowing owned customization outside the core runtime.

Pi already provides the boundaries needed for that direction:

```text
runtime and Agent loop
packages
extensions
skills
prompt templates
settings
model support
SDK
RPC
```

The intended ownership model is:

```text
earendil-works/pi
      |
      v
Lora PI Kit
      |
      v
Glassbox Runtime Boundary
```

Glassbox keeps product identity, authorization, durable Conversation state, persistence, and Trace outside Pi.

## Source paths to consult

| Upstream path | What to study |
| --- | --- |
| `packages/coding-agent/README.md` | CLI modes, package install behavior, SDK entry point, general runtime surface |
| `packages/coding-agent/docs/packages.md` | Pi package structure, install sources, project scope, resource filtering |
| `packages/coding-agent/docs/extensions.md` | Extension lifecycle, tools, commands, events, tool-call interception, UI hooks |
| `packages/coding-agent/docs/skills.md` | Agent Skill discovery and loading |
| `packages/coding-agent/docs/settings.md` | Global and project configuration, trust behavior, package loading |
| `packages/coding-agent/docs/sdk.md` | Programmatic embedding boundary for a Glassbox runtime adapter |
| `packages/coding-agent/docs/rpc.md` | Process boundary for running Pi behind Glassbox without importing internal implementation |
| `packages/coding-agent/docs/models.md` | Model and provider configuration |
| `packages/coding-agent/src/index.ts` | Public coding-agent exports and supported integration surface |
| `packages/agent/` | Lower-level Agent loop primitives when the public coding-agent boundary is insufficient |

Read public docs and exports before reaching into internal source modules.

## Lora PI Kit boundary

Lora PI Kit is not vendored upstream code. It is the maintainer-owned Pi distribution and workflow layer.

Its intended resources include:

```text
extensions/
skills or selected skill installation
prompts/
themes when needed
runtime presets
bootstrap and doctor scripts
compatibility metadata
```

Pi packages currently provide a first-class distribution mechanism for extensions, skills, prompt templates, and themes. Use that mechanism rather than copying Pi core into the kit.

Project and global settings remain Pi configuration. Lora PI Kit should bootstrap or generate them rather than pretending package resources and settings are the same thing.

The existing `lora-sys/skills` repository remains the canonical source for reusable Agent Skills. Lora PI Kit should reference or install selected skills instead of maintaining duplicate copies without a concrete reason.

## Glassbox integration boundary

The first production Pi integration should use a supported public boundary such as SDK or RPC.

Target shape:

```text
Glassbox
  authorization
  Conversation
  Run
  Trace
      |
      v
Pi Runtime Adapter
      |
      v
Pi + Lora PI Kit
```

Do not make Pi session state the durable Glassbox Conversation model.

Do not make Pi project trust or extension permissions replace Glassbox authorization.

Do not let an extension widen the current Principal's effective authority.

## Extension first

Before changing Pi core, check whether the requirement can be implemented with:

```text
settings
package configuration
Skill
Extension
SDK
RPC
```

Only keep a local Pi patch when a concrete requirement cannot be implemented through those supported boundaries. Record the reason and add a compatibility test before adopting the patch.

Prefer contributing a generally useful fix upstream over maintaining a permanent fork.

## Other upstream references

Pi does not replace every specialized reference in this repository.

Use the narrowest useful source for each problem:

```text
Pi
  runtime foundation and extension model

T3 Code
  Claude Code protocol and permission integration patterns

OpenHarness
  channel, tool, skill, and harness patterns

OpenSquilla
  context, retrieval, routing, and token efficiency

Token Monitor
  local runtime usage, quota, health, and discovery collectors

AGY
  delegated worker and background job behavior

Inspect AI
  Eval execution and scoring
```

A useful mechanism may land in Lora PI Kit or in Glassbox. The ownership test is simple:

```text
Pi workflow customization -> Lora PI Kit
Glassbox product semantics or trust boundary -> Glassbox
```

## Vendoring rule

Do not vendor the whole Pi repository.

If a later task needs a concrete source slice:

- pin the source commit
- record the original path
- preserve license requirements
- copy only the smallest required mechanism
- port it behind a Glassbox-owned or Lora PI Kit-owned boundary
- bring focused tests with the behavior when useful

Production code must not import directly from `upstream/pi/`.

## Current phase boundary

Plan 03 remains unchanged:

```text
Identity
-> Authorization
-> Conversation
-> Turso persistence
-> Run and Authorization Trace
```

Adding Pi as the primary runtime reference does not make Pi migration a Plan 03 dependency.
