# Pi source index

Reference project: `earendil-works/pi`

Pinned upstream commit for the next implementation review should be refreshed before P3.1 code starts. The previous research pin was `ceea48f5d5d12fd7915dfefba2835ccd55f23bb9`; current upstream has moved since then.

Upstream branch: `main`

License: MIT.

Pi is the primary runtime engine for the active Glassbox Personal Agent path.

Glassbox does not import production code from `upstream/pi/`.

## Current conclusion

Use this ownership model:

```text
Pi
  Agent engine and public runtime primitives

Lora PI Kit
  Lora's reproducible Pi distribution

Glassbox
  Personal Agent product / trust / durable-state boundary
```

The main runtime path established in P3 embeds Pi through the public SDK and loads Lora PI Kit resources / profile into the Pi environment.

## Why Pi fits

Pi keeps workflow-specific behavior outside the core and exposes the exact extension surfaces needed by Lora PI Kit:

```text
Packages
Extensions
Skills
Prompt Templates
settings
model/provider support
SDK
RPC
```

Pi's own documentation describes it as a small coding harness that should be adapted through Extensions, Skills, Prompt Templates, themes, and Pi Packages instead of requiring a fork.

Plan 03 chooses the SDK as the Glassbox embedding boundary.

## Important upstream facts

### Pi Packages

Pi Packages are the preferred Lora PI Kit distribution mechanism.

They can bundle:

```text
extensions
skills
prompt templates
themes
```

They can be installed from:

```text
npm
Git
local paths
```

Pi supports global and project package configuration, package resource filtering, and pinned package sources.

This means Lora PI Kit should be a real Pi Package, not a custom resource loader invented beside Pi's package system.

### Skills

Pi discovers Agent Skills through its public Skill / Package mechanism.

`lora-sys/skills` already uses `skills/<name>/SKILL.md`-style resources, so Lora PI Kit can bundle a pinned snapshot of selected Lora Skills directly under its Package `skills/` resource.

Canonical source and release payload remain different:

```text
canonical source
  lora-sys/skills

one reproducible Kit release
  pinned bundled Skill snapshot
```

### MCP

Pi core intentionally does not require built-in MCP.

Upstream documentation recommends using an Extension / Package when MCP support is desired.

This is a good fit for Lora PI Kit:

```text
Pi core
→ Lora PI Kit MCP Extension
→ Kit MCP registry / profiles
→ selected Tool integrations
```

Do not interpret this as permission to start every MCP integration on every run.

### SDK

Glassbox should continue to prefer public SDK surfaces such as:

```text
createAgentSession
createAgentSessionRuntime when required
ModelRuntime
SessionManager
DefaultResourceLoader
Extension API
customTools
session events
explicit agentDir
```

### Permissions

Pi runtime/package configuration is not the Glassbox authorization model.

Pi may run with broad local process permissions depending on how it is launched.

Glassbox remote execution must still enforce its own Ingress, Context, Tool / Ops, and Delivery authorization boundaries.

## Source paths to consult

| Upstream path | What to study |
| --- | --- |
| `packages/coding-agent/README.md` | runtime modes, default tools, customization model, SDK entry point |
| `packages/coding-agent/docs/packages.md` | Pi Package structure, npm/Git/local install, filtering, scope, dependencies |
| `packages/coding-agent/docs/extensions.md` | Extension lifecycle, Tools, commands, events, Tool-call interception |
| `packages/coding-agent/docs/skills.md` | Skill discovery and loading |
| `packages/coding-agent/docs/prompt-templates.md` | Prompt Template resources |
| `packages/coding-agent/docs/settings.md` | user/project settings and package configuration |
| `packages/coding-agent/docs/sdk.md` | primary Glassbox embedding boundary |
| `packages/coding-agent/docs/rpc.md` | secondary process integration boundary |
| `packages/coding-agent/docs/models.md` | models/providers and custom provider configuration |
| `packages/coding-agent/src/index.ts` | public coding-agent exports |
| `packages/coding-agent/examples/extensions/permission-gate.ts` | blocking protected Tool execution |

Read public docs and exports before relying on internal source modules.

## Lora PI Kit boundary

The detailed design lives in `docs/lora-pi-kit.md`.

The Kit should contain or manage:

```text
Pi package manifest
pinned bundled lora-sys/skills snapshot
Extensions
Prompt Templates
runtime profiles
MCP adapter / registry
model / thinking defaults
Glassbox bridges
Taste / Feedback / Trace hooks
settings / model templates
install / update / doctor / sync tooling
compatibility locks
```

The Kit is not:

```text
Pi core fork
Glassbox authorization database
Glassbox Task database
Taste / Memory database
QQ transport
Herdr Task truth
```

## Glassbox integration boundary

Target path:

```text
QQ / Workbench
      ↓
Glassbox
  Identity
  Authorization
  Conversation
  Task / Attention
  Taste / Memory truth
  Trace
      ↓
PiRuntimeAdapter
      ↓
Pi SDK
      ↓
Pi + pinned Lora PI Kit profile
      ↓
Tool / Ops authorization
      ↓
Delivery authorization
```

Do not make Pi Session equal Glassbox Conversation.

Do not make Pi project trust, Package settings, Extension state, Skills, MCP, or runtime profile replace Glassbox authorization.

## SDK first, core patch last

Before changing Pi core, check:

```text
settings
Pi Package configuration
Skill
Extension
custom Tool
SDK
upstream contribution
```

RPC remains useful for other integration shapes but is not the primary P3 path.

Only keep a local Pi patch when a concrete tested requirement cannot be implemented through supported public boundaries.

## P3 Tool rule

The remote QQ runtime uses a narrow explicit Tool surface.

The fact that Lora PI Kit may contain coding Skills, MCP integrations, or local shell support does not expose them all to a QQ Principal.

Protected execution must remain meaningful to the Glassbox Authorization Engine.

## Versioning rule

Do not pin documentation to a stale upstream commit forever.

Before P3.1 implementation:

1. fetch the current Pi release / tested commit;
2. record it in Lora PI Kit compatibility metadata;
3. run Package / SDK compatibility tests;
4. pin the tested runtime set.

A Glassbox release should be able to identify:

```text
Pi version / commit
Lora PI Kit version / commit
lora-sys/skills source commit
Glassbox version / commit
```

## Vendoring rule

Do not vendor the entire Pi repository.

If a source slice is needed:

- pin the source commit;
- record the original path;
- preserve license requirements;
- copy only the smallest required mechanism;
- port it behind a Glassbox-owned or Lora PI Kit-owned boundary;
- add focused tests when behavior is reused.

Production code must not import directly from `upstream/pi/`.
