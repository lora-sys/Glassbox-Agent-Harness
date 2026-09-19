# Glassbox runtime strategy

Status: CURRENT DIRECTION

This document defines the stable ownership boundary between Glassbox, Pi, Lora PI Kit, Herdr, Codex, Claude Code, and future runtimes.

The active implementation order remains `.plans/03-personal-agent-foundation.md`.

Read these companion documents for details:

```text
docs/lora-pi-kit.md
  Lora PI Kit distribution contents, Skills snapshot, MCP, profiles, install, locks

docs/agent-operations.md
  Herdr, Task, Attention, TaskAttempt, WorkerBinding, reconciliation

docs/memory-taste.md
  Rules, Skills, Taste, Feedback, Memory and retrieval ownership
```

## Core decision

Use this mental model:

```text
Pi
  Agent engine

Lora PI Kit
  Lora's reproducible Pi distribution

Glassbox
  durable Personal Agent system and product control plane

Herdr
  live coding-worker execution host
```

Glassbox remains the product and trust boundary.

Pi is the primary runtime engine for the main Personal Agent path.

Lora PI Kit turns a fresh Pi installation into Lora's configured Pi environment.

Herdr hosts live coding workers and worktrees. It does not replace Glassbox Task truth.

Codex and Claude Code remain supported execution backends for compatibility, specialist work, fallback, Herdr workers, and later differential Eval.

## Main runtime path

Plan 03 embeds Pi through `@earendil-works/pi-coding-agent` in the Glassbox Node.js server.

Conceptual path:

```text
QQ / Workbench / future Channels
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
Pi session configured with
Lora PI Kit package + profile
        ↓
Pi Agent engine
```

Lora PI Kit is not a second runtime and is not the Personal Agent identity.

It is the distribution and runtime customization layer loaded into Pi.

## Ownership

### Glassbox owns

```text
Agent identity
User / Principal
Channel identity resolution
Authorization
Ingress / Context / Tool / Delivery policy
Conversation
Task / TaskAttempt / AttentionItem
WorkerBinding
review / rework / acceptance
Taste / Memory durable truth
Audience / Delivery policy
Durable product state
Run identity
Raw Trace and product evidence
Workbench and product APIs
```

These semantics must survive changing Pi versions, switching Worker runtimes, or changing the Agent Operations host.

### Lora PI Kit owns

```text
Pi package manifest
bundled pinned Lora Skills snapshot
Pi Extensions
Prompt Templates
runtime profiles
MCP adapter and registry
model / thinking defaults
runtime Tool policy integration
Glassbox runtime bridges
Taste / Feedback / Trace hooks
notifications
settings / model templates
install / update / doctor / sync tooling
Pi + Skills compatibility locks
```

For the full boundary, read `docs/lora-pi-kit.md`.

### Upstream Pi owns

```text
Agent loop
sessions
model/provider support
built-in coding tools
package system
Extension API
Skill loading
Prompt Templates
settings
TUI
SDK
RPC
```

Do not copy Pi core into Lora PI Kit merely to change defaults or workflows.

### Herdr owns live execution facts

```text
Herdr session
workspace
worktree
tab
pane
terminal process
recognized coding Agent
working / blocked / done / idle / unknown
live terminal output
```

Herdr lifecycle state is an execution observation.

```text
Herdr Agent = done
≠
Glassbox Task = DONE
```

Review / rework / acceptance remain Glassbox product Actions.

## Lora PI Kit is a distribution, not a loose config folder

The previous description of Lora PI Kit as only a small configuration layer was too weak.

The intended relationship is:

```text
earendil-works/pi
      ↓
Pi package / Extension / Skill public boundaries
      ↓
lora-sys/lora-pi-kit
  Lora Skills snapshot
  Extensions
  MCP
  prompts
  profiles
  hooks
  locks
      ↓
Pi CLI / Glassbox / Herdr Pi Worker
```

The same Kit can support multiple roles through profiles:

```text
local-coding
main-agent
owner-direct
qq-group
herdr-worker
test
```

Sharing one Kit does not collapse role identity:

```text
Glassbox main Personal Agent
≠
Herdr delegated Pi Worker
```

## Skills rule

`lora-sys/skills` is the canonical source repository for Lora Skills.

A released Lora PI Kit bundles a pinned snapshot of the Skills selected for that release.

```text
lora-sys/skills
  canonical source
      ↓
sync-skills
      ↓
Kit skills/
      ↓
skills.lock.json
      ↓
release
```

Do not fetch an unpinned `lora-sys/skills@main` during every Pi startup.

Bundling a Skill does not mean injecting it into every task. Profiles and task-level selection narrow the active set.

## MCP rule

Pi core intentionally keeps workflow-specific systems such as MCP outside the required core.

Lora PI Kit may provide MCP through an owned Pi Extension / Package layer.

```text
Pi
  ↓
Lora PI Kit MCP adapter
  ↓
MCP Registry
  ↓
profile-selected servers
  ↓
Tools
```

Do not start every available MCP integration by default.

An installed MCP Tool is still subject to Glassbox authorization when used through Glassbox.

Glassbox selects the Tool schema list for each Run before it creates the Pi session. A Tool requires an explicit discovery grant for the current Principal and location before Pi receives its name, description or parameters. The Tool re-authorizes its concrete Resource and Action again when Pi calls it.

    Run caller and location
    → Tool discovery authorization
    → selected Pi Tool schemas
    → Pi Tool call
    → execution authorization
    → Tool result

Profiles and package configuration may narrow this list. They cannot add a Tool that Glassbox did not authorize.

For the explicit Owner group-access command, Glassbox also verifies that Pi produced a successful matching Tool result before it accepts an execution claim. It permits one corrective Pi turn in the same Run. If the Tool still does not execute, the Run fails with a safe result and product state stays unchanged.

## Package and settings rule

Use Pi's public package mechanism for distributable resources.

Pi Packages can distribute Extensions, Skills, Prompt Templates, and themes through npm, Git, or local paths.

Settings and package resources remain different concepts.

Lora PI Kit may bootstrap or generate Pi settings and model configuration where needed, but should not invent a second package loader.

## SDK first, core patch last

Plan 03 uses the Pi SDK as the primary Glassbox embedding boundary.

Prefer supported public surfaces such as:

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

Customization order:

```text
Pi setting / project config
→ Pi package resource
→ Skill
→ Extension
→ custom Tool
→ Pi SDK integration
→ upstream contribution
→ small local core patch only when a tested requirement cannot use public boundaries
```

RPC remains a valid upstream capability but is not the primary Glassbox P3 path.

A core patch requires:

```text
concrete failing requirement
compatibility test
recorded upstream version
reason public boundaries were insufficient
removal / upstreaming condition
```

## Glassbox runtime instances

Glassbox owns the concrete Pi environments that it launches.

The runtime instances should not reuse the user's normal interactive Pi state by default.

Conceptual isolation:

```text
~/.glassbox/pi/main/
~/.glassbox/pi/workers/<task-or-attempt-id>/
~/.glassbox/pi/test/
```

Exact paths are implementation details.

The invariant is:

```text
same pinned Lora PI Kit distribution
+ role-specific profile
+ isolated session/runtime state where needed
```

This must work the same way locally and on the target Linux server.

## Rules, Taste and Memory

Do not turn runtime configuration into product truth.

Glassbox owns durable Rules / Taste / Memory selection and authorization.

Lora PI Kit may receive a small authorized runtime projection and inject it into Pi.

```text
Glassbox selects
  Rules
  relevant Skills
  task-relevant Taste
  authorized Memory
      ↓
PiRuntimeAdapter
      ↓
Lora PI Kit runtime bridge
      ↓
Pi Context
```

The Kit does not own the canonical Taste or Memory database.

See `docs/memory-taste.md`.

## Agent Operations boundary

Runtime and Agent Operations are different layers.

```text
Runtime
  executes a session / Run

Agent Operations
  coordinates Tasks and live Workers
```

Keep these distinct:

```text
Pi Session ≠ Conversation
Run ≠ Task
Task ≠ Worker
TaskAttempt ≠ Herdr pane
Herdr state ≠ Task acceptance
Runtime ≠ Agent Operations
```

A delegated Task may execute through a Herdr-managed Pi, Codex, Claude Code, or another supported Worker.

The Worker runtime does not become another Personal Agent identity.

Glassbox talks to Herdr through `HerdrBridge`; Herdr protocol details stay behind that boundary.

See `docs/agent-operations.md` for lifecycle and reconciliation rules.

## Security

Glassbox authorization always wins.

None of these may widen caller authority:

```text
Pi profile
Pi Extension
Skill
Prompt
MCP integration
Lora PI Kit setting
Codex configuration
Claude Code configuration
Herdr state
Worker output
```

The main security order remains:

```text
receive Channel event
→ resolve Principal / location
→ Ingress authorization
→ resolve Conversation
→ authorize and build model Context
→ invoke runtime
→ re-authorize protected Tool / Ops execution
→ produce result with visibility provenance
→ authorize Delivery audience
→ deliver
→ record evidence
```

For remote QQ profiles, do not expose unrestricted shell, arbitrary MCP capability, raw Herdr pane input, destructive worktree operations, or unrelated Worker reads merely because the Kit contains those capabilities.

Delegation must satisfy:

```text
worker_permissions ⊆ delegated_permissions ⊆ caller_permissions
```

## Versioning

Do not let production behavior float with upstream `main`.

One tested runtime set should identify:

```text
Pi version / commit
Lora PI Kit version / commit
lora-sys/skills source commit
selected external package versions
Glassbox version / commit
```

Upgrade flow:

```text
update input
→ build / sync Kit
→ Kit compatibility tests
→ Glassbox runtime tests
→ real acceptance where required
→ update locks
→ pin / release
```

## Current P3 requirement

P3 does not need every future integration enabled.

It does need the real distribution architecture during P3.1:

```text
Pi package manifest
pinned bundled lora-sys/skills snapshot
main-agent / qq-group / herdr-worker / test profiles
Glassbox policy bridge
trace / usage hooks
minimal MCP adapter boundary
base prompts
settings / model templates
install / doctor / sync-skills
Pi + Skills compatibility locks
```

Do not build a throwaway P3 installer that will later be replaced by the actual Kit architecture.

## Migration rule

Do not perform a blind big-bang rewrite of existing Codex / Claude Code paths.

Add the Pi + Lora PI Kit path as a vertical slice, preserve useful existing adapters, and move shared behavior only after the new path proves the contracts.
