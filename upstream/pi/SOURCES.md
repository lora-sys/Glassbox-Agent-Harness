# Pi source index

Reference project: `earendil-works/pi`

Pinned upstream commit: `ceea48f5d5d12fd7915dfefba2835ccd55f23bb9`

Upstream branch at review time: `main`

License: MIT.

Pi is the primary runtime reference for the active Glassbox Personal Agent path. Glassbox does not import production code from this directory.

## Why it matters

Glassbox needs a runtime foundation that can stay small while allowing owned customization outside the core runtime.

Pi provides the boundaries needed for the active P3 path:

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

Plan 03 chooses the public SDK as the primary integration boundary.

The ownership model is:

```text
earendil-works/pi
      |
      v
Lora PI Kit
      |
      v
Pi SDK integration inside Glassbox
      |
      v
Glassbox Runtime Boundary
```

Glassbox keeps product identity, authorization, QQ Channel identity, durable Conversation state, persistence, audience policy, and Trace outside Pi.

## Source paths to consult

| Upstream path | What to study |
| --- | --- |
| `packages/coding-agent/README.md` | CLI modes, package install behavior, SDK entry point, general runtime surface |
| `packages/coding-agent/docs/packages.md` | Pi package structure, install sources, project scope, resource filtering |
| `packages/coding-agent/docs/extensions.md` | Extension lifecycle, tools, commands, events, tool-call interception, blocking |
| `packages/coding-agent/docs/skills.md` | Agent Skill discovery and loading |
| `packages/coding-agent/docs/settings.md` | Global and project configuration, trust behavior, package loading |
| `packages/coding-agent/docs/sdk.md` | Primary Glassbox embedding boundary, sessions, ResourceLoader, custom Tools, events |
| `packages/coding-agent/docs/rpc.md` | Secondary process boundary, not the primary P3 integration |
| `packages/coding-agent/docs/models.md` | Model and provider configuration |
| `packages/coding-agent/src/index.ts` | Public coding-agent exports and supported integration surface |
| `packages/agent/` | Lower-level Agent loop primitives only when the public coding-agent boundary is insufficient |
| `packages/coding-agent/examples/extensions/permission-gate.ts` | Example of blocking a Tool call before execution |

Read public docs and exports before reaching into internal source modules.

## Lora PI Kit boundary

Lora PI Kit is not vendored upstream code. It is the maintainer-owned Pi distribution and workflow layer.

Its P3 MVP includes only what the QQ closed loop needs:

```text
package manifest
extensions
selected Skill installation
prompts
runtime presets
model/settings templates
bootstrap and doctor scripts
Pi compatibility metadata
```

Pi packages provide a first-class distribution mechanism for extensions, skills, prompt templates, and themes. Use that mechanism rather than copying Pi core into the kit.

Project and global settings remain Pi configuration. Lora PI Kit should bootstrap or generate them rather than pretending package resources and settings are the same thing.

The existing `lora-sys/skills` repository remains the canonical source for reusable Agent Skills. Lora PI Kit should reference or install selected skills instead of maintaining duplicate copies without a concrete reason.

## Glassbox integration boundary

Plan 03 embeds Pi through `@earendil-works/pi-coding-agent` inside the Glassbox Node.js server.

Target shape:

```text
QQ / Workbench
      |
      v
Glassbox
  Ingress Gate
  Identity
  Conversation
  Context Gate
  Authorization
  Run / Trace
      |
      v
Pi SDK Runtime Adapter
      |
      v
Pi + Lora PI Kit
      |
      v
Tool Gate
      |
      v
Glassbox Delivery Gate
```

Do not make Pi session state the durable Glassbox Conversation model.

Do not make Pi project trust or extension permissions replace Glassbox authorization.

Do not let an extension widen the current Principal's effective authority.

The Pi extension layer may enforce Tool-call blocking, but the authorization decision itself comes from Glassbox.

## SDK first

Before changing Pi core, check whether the requirement can be implemented with:

```text
settings
package configuration
Skill
Extension
custom Tool
SDK
```

RPC remains useful for other integrations but is not the primary Plan 03 path.

Only keep a local Pi patch when a concrete tested requirement cannot be implemented through supported public boundaries. Record the reason and add a compatibility test before adopting the patch.

Prefer contributing a generally useful fix upstream over maintaining a permanent fork.

## P3 Tool rule

The QQ runtime uses an explicit Tool allowlist.

Do not expose unrestricted `bash` or `powershell` through the remote QQ profile. Remote Tools should have explicit resource and action semantics so the Glassbox Authorization Engine can evaluate them before execution.

Pi's `tool_call` blocking mechanism is suitable as an enforcement bridge for P3, but Glassbox remains the policy authority.

## Other upstream references

Pi does not replace every specialized reference in this repository.

Use the narrowest useful source for each problem:

```text
Pi
  runtime foundation, SDK, package and extension model

NapCat / OneBot
  QQ transport

T3 Code
  Claude Code protocol and permission integration patterns

OpenHarness
  channel, tool, skill, and harness patterns

OpenSquilla
  later context, retrieval, routing, and token efficiency

Token Monitor
  runtime usage, quota, health, and discovery collectors

AGY
  delegated worker and background job behavior

Inspect AI
  Eval execution and scoring
```

A useful mechanism may land in Lora PI Kit or in Glassbox. The ownership test is simple:

```text
Pi workflow customization -> Lora PI Kit
Glassbox identity, authorization, Channel, Conversation, audience, durable state or evidence -> Glassbox
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

Plan 03 actively implements:

```text
Deterministic test environment
-> Lora PI Kit MVP
-> Pi SDK runtime integration
-> hard authorization gates
-> scope-based Conversation + Turso
-> NapCat / OneBot QQ private and group Channel
-> restart / dedupe / reconnect / Trace
-> real QQ acceptance
```

Pi SDK integration is therefore a Plan 03 dependency. Broad Pi core modification is not.
