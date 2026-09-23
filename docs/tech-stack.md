# Glassbox Technology Stack

Status: CURRENT DIRECTION

This file records the preferred technology stack and implementation boundaries for Glassbox. It is not permission to add every listed technology before the active Plan needs it.

Read the topic-specific source of truth first:

```text
docs/runtime-strategy.md
  runtime ownership

docs/lora-pi-kit.md
  Lora PI Kit distribution, Skills, MCP, profiles, locks

docs/agent-operations.md
  Herdr / Task / Worker integration

docs/memory-taste.md
  Rules / Skills / Taste / Memory

docs/data-observability.md
  persistence, storage, observability
```

The current implementation order comes from the intentionally parallel `.plans/04a-memory-taste.md` and `.plans/04b-authorized-retrieval-history.md`. P3 is complete and remains the trust / QQ / Agent Ops foundation.

## Runtime and language

```text
Node.js 22+
TypeScript
ES modules
```

`apps/server` remains a Node.js server runtime.

The production target is a Linux server. Local development must preserve the same product contracts used on that server.

## Repository toolchain

Glassbox has selected Vite+ as the unified JavaScript / TypeScript toolchain direction.

The repository command surface is:

```text
vp install
vp dev
vp build
vp check
vp test
vp run <task>
```

Vite+ is expected to cover Vite / Rolldown, Vitest, Oxlint, Oxfmt, tsdown, and workspace task execution.

The configured local Personal Agent environment has one service command surface:

    npm run agent:up
    npm run agent:status
    npm run agent:logs
    npm run agent:down

Use the `npm` commands or invoke `node --import tsx scripts/agent-service.mts <command>`
directly. On Windows, do not use `vp run agent:up` for the long-lived service manager. Vite+
cleans detached descendants when its task exits, so the npm scripts or direct Node invocation
must launch the service process.

agent:up reads optional Herdr, NapCat and Glassbox launch settings from
<GLASSBOX_DATA_DIR>/service-launch.json. Without that environment variable, it uses
~/.glassbox so the durable database, process registry and launch settings do not depend
on a temporary worktree. Use docs/service-launch.example.json as the shape. Keep
credentials in the existing protected Channel and model stores. agent:up is idempotent.
It keeps verified running processes and starts only missing services.
For NapCat restart login, append the Bot QQ number to the launcher arguments after the QQ executable and injection library. Pin the first NapCat argument to the tested QQ executable. Do not point it at an auto-updated system QQ installation: an unsupported QQ build can leave OneBot listening while the account is offline. Keep the NapCat work directory, injection library and environment paths from one tested installation together.

The Glassbox launch environment must include `LORA_PI_KIT_PATH` whenever a configured Channel uses a `pi:*` execution reference. Starting only the HTTP server without that path can accept a message but fail before Pi creates the Run session. Use `npm run agent:up` for normal recovery instead of manually launching the three processes with partial environment variables.

If NapCat reports that its saved quick-login state has expired, keep the one `agent:up` process running and complete login through the local NapCat WebUI. Do not restart it repeatedly to refresh QR images. A successful login starts the configured OneBot endpoint, and the auto-connect Channel then reconnects without restarting Glassbox.

The service file accepts only the documented non-secret environment keys.

The service manager launches fixed executables without a shell. It records process identity in the
data directory and verifies it before shutdown. Named Herdr sessions use Herdr's public session
status and stop commands.

The `glassbox` CLI and `agent:up` use the same service data directory. By default both use
`~/.glassbox` and port 3030. Set `GLASSBOX_DATA_DIR` and `PORT` to the same values as the
service when using a custom launch configuration. For the default Windows service configuration:

```powershell
$env:GLASSBOX_DATA_DIR = Join-Path $env:USERPROFILE '.glassbox'
$env:PORT = '3030'
npm run glassbox -- capabilities probe p3-qq 1126022432 --json
```

When running `dev:server` directly, the server uses the repository's `.glassbox` directory unless
`GLASSBOX_DATA_DIR` is set. Set the same `GLASSBOX_DATA_DIR` and `PORT` in the CLI shell to target
that development server. The CLI does not create, rotate, or copy management credentials.

Do not keep parallel lint / format / type-check stacks without a demonstrated compatibility need.

## Web application

```text
React 19
TanStack Router / TanStack Start where already used
tldraw
Vite+ / Vite / Rolldown
```

The Workbench is one product surface.

Frontend choices must not redefine Agent, Conversation, Task, Run, Authorization, Taste, Memory, or durable-state semantics.

## Main Agent runtime

Pi is the primary Personal Agent runtime engine.

Glassbox embeds Pi through:

```text
@earendil-works/pi-coding-agent
```

Primary public surfaces include:

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

The runtime path is:

```text
Glassbox PiRuntimeAdapter
        ↓
Pi SDK
        ↓
Pi session configured with Lora PI Kit
        ↓
Pi Agent engine
```

RPC remains an upstream capability but is not the primary P3 embedding path.

Codex and Claude Code remain valid runtimes for compatibility, fallback, specialist execution, Herdr workers, and later differential Eval.

## Lora PI Kit

Lora PI Kit is Lora's reproducible Pi distribution, not just a loose configuration directory.

It should be a real Pi Package using upstream public package mechanisms.

A Kit release contains or manages:

```text
Pi package manifest
pinned bundled Lora Skills snapshot
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

Full design: `docs/lora-pi-kit.md`.

### Pi Package mechanism

Use Pi Packages for distributable runtime resources.

Pi Packages can expose:

```text
extensions
skills
prompt templates
themes
```

They can be installed from npm, Git, or local paths and filtered by global/project configuration.

Do not create a second custom package loader unless the Pi public mechanism proves insufficient for a tested requirement.

## Skills

`lora-sys/skills` is the canonical Skill source repository.

A released Lora PI Kit bundles every structurally valid owned Skill found at the pinned
`lora-sys/skills` commit. Invalid Skill packages remain excluded with a reason in the lock.

```text
lora-sys/skills
→ sync-skills
→ lora-pi-kit/skills
→ skills.lock.json
→ release
```

The snapshot makes one Kit version reproducible across local development, CI, Glassbox, and the Linux server.

Do not fetch an unpinned latest Skill set at runtime.

Bundled does not mean always injected. Profiles narrow the active Skill set. Glassbox may
narrow it again for one authorized location. QQ groups use a durable per-group whitelist.
Pi receives only the selected Skill names and descriptions. It reads locked Skill files on
demand through an authorized Tool.

## MCP

Pi core intentionally keeps MCP outside the required core.

Lora PI Kit may provide MCP through an owned Pi Extension / Package layer.

```text
Pi
→ Lora PI Kit MCP adapter
→ MCP Registry
→ profile-selected integrations
→ Tools
```

Do not start all configured MCP servers for every profile.

The presence of an MCP Tool does not grant Glassbox permission to call it. Protected execution remains behind Glassbox Tool / Ops authorization.

## Profiles

Profiles select the intended Pi environment from the broader Kit capability set.

Initial concepts:

```text
local-coding
main-agent
owner-direct
qq-group
herdr-worker
test
```

Profiles may control:

```text
Extensions
Skills
MCP integrations
prompts
model / thinking defaults
Tool surface
notifications
Glassbox bridge behavior
trace / usage hooks
```

Profiles may narrow capability. They may not widen Glassbox authority.

## Pi runtime state

Glassbox should launch isolated Pi runtime instances rather than writing to the user's normal interactive Pi state by default.

Conceptual layout:

```text
~/.glassbox/pi/main/
~/.glassbox/pi/workers/<task-or-attempt-id>/
~/.glassbox/pi/test/
```

Exact paths are not frozen.

The stable rule is:

```text
same pinned Kit distribution
+ role-specific profile
+ isolated session/runtime state where needed
```

## Agent Operations

Herdr is the live execution host for coding Workers.

```text
Glassbox Main Agent
        ↓
Task Registry + Attention Queue
        ↓
Glassbox Ops Tools
        ↓
HerdrBridge
        ↓
Herdr
  workspace / worktree / pane
  Pi / Codex / Claude worker
        ↓
Herdr events
        ↓
OpsReconciler
        ↓
TaskAttempt + WorkerBinding + Trace
```

Glassbox owns Task truth, review, rework, acceptance, authorization, and durable evidence.

Herdr owns live process topology and observed Worker lifecycle.

```text
Herdr done
≠
Glassbox Task DONE
```

The detailed synchronization contract lives in `docs/agent-operations.md`.

## QQ Channel

Plan 03 uses:

```text
QQ
→ NapCat
→ OneBot 11
→ Glassbox QQ Channel Adapter
```

QQ transport stays in Glassbox, not in Lora PI Kit.

Initial P3 scope covers private messages, group messages, explicit activation, reply delivery, reconnect, dedupe, health, and self-loop prevention.

## Authorization

Authorization is server-side and default-deny.

Decision:

```text
ALLOW
DENY
REQUIRES_APPROVAL
```

Stable protected path:

```text
Ingress Gate
Context Gate
Tool / Ops Gate
Delivery Gate
```

No runtime, profile, Skill, Extension, MCP integration, Herdr state, cache, or model output may bypass these gates.

The remote QQ profile must not expose unrestricted shell, raw Herdr control, unrelated Worker reads, arbitrary destructive workspace operations, or all Kit MCP capabilities by default.

Delegation must satisfy:

```text
worker_permissions ⊆ delegated_permissions ⊆ caller_permissions
```

## Persistence

Glassbox structured durable state uses Turso / SQLite-compatible storage behind server-owned boundaries.

Current / planned structured state includes:

```text
Agent / User / Principal / ChannelIdentity
Conversation
permissions / relationships
authorization decisions
approvals
Run metadata
message dedupe
runtime session bindings
visibility / Share metadata
AttentionItem
Task
TaskAttempt
WorkerBinding
FeedbackEvent
TasteCandidate
TasteEntry
Memory metadata
Skill / Asset / Journal metadata
Eval metadata
analytics projections
```

Cloudflare R2 is the target for large objects and Raw Trace evidence where object storage is appropriate.

Herdr is live execution state, not the canonical Task database.

Lora PI Kit is runtime distribution state, not the canonical Taste / Memory / Authorization database.

The model does not receive unrestricted SQL access.

The browser does not receive direct database or object-store credentials.

See `docs/data-observability.md`.

## Rules, Taste and Memory injection

Glassbox selects authorized task-relevant material.

```text
Rules
relevant Skills
task-relevant Taste
authorized Memory
```

The Runtime Adapter passes a small projection into the active Pi environment.

Lora PI Kit runtime bridges inject that projection into Pi.

Do not send the entire Taste / Memory store every turn.

See `docs/memory-taste.md`.

## Testing

Required repository checks:

```text
vp run verify:commit
vp run test:unit
vp run test:e2e
vp run test:regression
```

`vp run verify:commit` is the required pre-commit gate. Vite+ installs the repository-owned
`.vite-hooks/pre-commit` dispatcher during `vp install`. The gate checks staged formatting,
core lint and types, all deterministic unit tests, the P3 end-to-end suite, focused
regressions, and the web build. It also rejects deleted tests and newly disabled tests.

The `packageManager` field records the package-manager backend used by `vp install`. It does
not change the repository command surface. Developers use `vp` directly.

Playwright remains the browser / E2E layer.

P3 deterministic tests must not require real QQ accounts, paid model quota, the user's normal Pi state, or live Herdr workspaces.

They should use isolated substitutes such as:

```text
Fake OneBot
Fake identities
Disposable Turso / SQLite
isolated Pi agentDir
Lora PI Kit test profile
deterministic / recording model
FakeHerdrBridge
synthetic protected resources
Raw Trace capture
```

Kit tests should additionally verify:

```text
package loads
profile resolves
Skills lock matches bundled snapshot
Extensions load
MCP adapter boundary loads without starting unrelated services
Pi compatibility metadata matches the tested runtime
```

Use real Pi / QQ / Herdr / MCP integration only when that real protocol is the behavior under test or the active Plan requires acceptance.

## Versioning and upgrades

One tested runtime set should identify:

```text
Pi version / commit
Lora PI Kit version / commit
lora-sys/skills commit
selected external integration versions
Glassbox version / commit
```

Upgrade flow:

```text
update dependency / upstream
→ build / sync Kit
→ Kit compatibility tests
→ Glassbox runtime tests
→ integration acceptance where required
→ update locks
→ pin / release
```

Do not track upstream `main` implicitly in production.

## Observability

Product observability remains a Glassbox feature.

Glassbox should be able to inspect:

```text
Channel / Principal / location
Conversation
Authorization decisions
model-visible Context metadata
Run / Tool / Delivery state
runtime / profile / Kit identity
Pi / model usage
Task / TaskAttempt / Attention
WorkerBinding and Herdr observed state
review / rework / acceptance
Taste / Memory retrieval reasons later
```

External dashboards, Pi TUI, Herdr UI, and Moshi are not the canonical Glassbox observability surface.

## Local development to server

Target host:

```text
Linux server
  Glassbox server
  Pi SDK
  pinned Lora PI Kit
  NapCat
  Herdr
  coding Workers / worktrees
  durable state
```

Do not encode desktop GUI state, machine-specific absolute paths, or Moshi state as product truth.

Local tests and server deployment must use the same product contracts.
