# Glassbox Technology Stack

Status: CURRENT DIRECTION

This file records the preferred technology stack and toolchain direction for Glassbox. It is not permission to add every listed technology before the active plan needs it.

For the complete cross-cutting data, storage, search, observability, analytics, and public Trace / Eval read model, see [`data-observability.md`](./data-observability.md).

For the execution-runtime ownership boundary between Glassbox, Pi, Lora PI Kit, Codex, and Claude Code, see [`runtime-strategy.md`](./runtime-strategy.md).

The current implementation source of truth is `.plans/03-personal-agent-foundation.md`.

## Toolchain

Glassbox standardizes on **Vite+** as the primary JavaScript / TypeScript development toolchain direction.

Vite+ is the preferred command surface for:

```text
runtime / package-manager environment
install
workspace task execution
dev
build
format
lint
type check
test
staged checks
```

The intended developer interface is:

```bash
vp install
vp dev
vp build
vp check
vp test
vp run <task>
```

Use `vp run` for repository scripts and workspace tasks that are not Vite+ built-ins.

Vite+ currently unifies Vite, Rolldown, Vitest, Oxlint, Oxfmt, tsdown, and Vite Task behind the `vp` toolchain.

### Migration rule

Do not partially migrate the repository.

The Vite+ migration slice must update and verify together:

```text
package.json
package-lock.json
Vite configuration
Vitest resolution
workspace commands
README development instructions
AGENTS.md toolchain rules
CI when CI exists
```

Until that verified migration lands, existing npm / Vite scripts remain valid implementation reality even though Vite+ is the selected target toolchain.

When migrating, follow the Vite+ migration path rather than hand-building an imitation of it. Keep Vite / Vitest resolution aligned with the local `vite-plus` toolchain and regenerate the lockfile in the same verified change.

## Runtime and language

```text
Node.js 22+
TypeScript
ES modules
```

`apps/server` remains a Node.js runtime. Vite+ is the repository toolchain. It does not mean the server must become a Vite dev server.

Server processes may continue to use a focused runtime such as `tsx` when that is the smallest correct execution path. Run those commands through `vp run` once the migration is complete.

## Web application

```text
React 19
TanStack Router / TanStack Start where already used
tldraw
Vite+ / Vite / Rolldown
```

The Workbench is one product surface. Do not let frontend framework choices redefine Agent, Conversation, Run, authorization, or durable state semantics.

The Owner is the only Web administrator. Public Web access is read-only and limited to explicitly published Trace or Eval projections. Public pages never become a second control plane.

## Testing and code quality

Preferred Vite+ surfaces:

```text
vp check   -> format + lint + type checks
vp test    -> Vitest
vp fmt     -> Oxfmt
vp lint    -> Oxlint
```

Playwright remains the browser / E2E layer where browser behavior is the thing being tested.

Plan 03 also requires a deterministic QQ / OneBot test harness that does not depend on real QQ accounts or paid model quota.

Do not keep parallel ESLint / Prettier / ad-hoc TypeScript check stacks unless a concrete compatibility gap requires them.

## Persistence

Plan 03 introduces Turso / SQLite-compatible structured durable state behind a narrow server-side persistence boundary.

The selected cross-cutting storage model is:

```text
Turso
  structured durable state
  Agent / User / ChannelIdentity
  Conversation
  permissions / relationships
  authorization decisions
  approvals
  Run metadata
  message dedupe keys
  runtime session bindings
  visibility and Share metadata
  later lexical / vector search and analytics indexes

Cloudflare R2
  Raw Trace evidence
  large artifacts
  attachments
  archives
  backups

AgentMail
  later email transport and source objects

Glassbox server
  runtime execution
  authorization
  Channel adapters
  owner APIs
  public Trace / Eval APIs
```

Raw Trace remains independent append-only evidence.

The model does not receive unrestricted SQL access.

The browser does not receive direct Turso, R2, or AgentMail credentials.

## Agent execution

Current execution capabilities include Codex and Claude Code adapters from the earlier Coding Agent phase.

Plan 03 now makes Pi the primary Personal Agent runtime path:

```text
upstream Pi
    |
    v
Lora PI Kit
    |
    v
@earendil-works/pi-coding-agent SDK
    |
    v
Glassbox Runtime Boundary
```

Glassbox embeds Pi through the public SDK inside `apps/server`.

Primary Pi surfaces for P3 include:

```text
createAgentSession
createAgentSessionRuntime when replacement is required
ModelRuntime
SessionManager
DefaultResourceLoader
Extension API
customTools
session events
explicit agentDir
```

Lora PI Kit owns reusable Pi packages, extensions, selected Skills, prompts, runtime presets, observability hooks, and bootstrap tooling. It does not own Glassbox authorization, durable Conversation state, QQ identity, audience policy, product identity, or Raw Trace truth.

The customization order is:

```text
Pi settings / project config
-> Pi package
-> Skill
-> Extension
-> custom Tool
-> Pi SDK integration
-> upstream contribution
-> small local Pi core patch only when a tested requirement cannot use public boundaries
```

RPC remains available upstream but is not the primary Plan 03 integration path.

Codex and Claude Code remain valid runtimes for compatibility, fallback, specialist execution, and differential Eval while Pi becomes the primary Personal Agent path.

## QQ Channel

Plan 03 uses NapCat as the QQ protocol-side runtime and OneBot 11 as the application boundary.

```text
QQ
-> NapCat
-> OneBot 11
-> Glassbox QQ Channel Adapter
-> Identity / Conversation / Authorization
-> Pi SDK
-> Glassbox Delivery Gate
-> NapCat
-> QQ
```

QQ transport code belongs in Glassbox, not Lora PI Kit.

Initial P3 scope includes private messages, group messages, explicit group activation such as `@bot`, reply delivery, reconnect, health, message deduplication, and self-message loop prevention.

## Authorization

Authorization is server-side and default-deny.

The stable decision inputs must answer:

```text
Who
Where
What
How
Resource
Audience
Conversation
Run
```

Decision remains:

```text
ALLOW
DENY
REQUIRES_APPROVAL
```

Plan 03 enforces four hard gates:

```text
Ingress Gate
Context Gate
Tool Gate
Delivery Gate
```

No toolchain, framework, runtime, model router, Channel adapter, vector database, cache, Pi Extension, Skill, or runtime profile may bypass these boundaries.

Unauthorized protected content is filtered before Pi model Context is assembled.

Protected Tools are re-authorized immediately before execution.

Delivery is authorized separately from read access. An Owner being allowed to read a private resource does not make that resource safe to send into a QQ group.

The remote QQ Pi profile uses an explicit Tool allowlist. Generic unrestricted `bash` or `powershell` is not exposed as a remote escape hatch in P3.

## Test environments

Plan 03 has two test layers.

Deterministic automated tests use:

```text
Fake OneBot gateway
Fake Owner
Fake Visitor
Fake QQ group
Disposable Turso / SQLite database
isolated Pi agentDir
Lora PI Kit test preset
deterministic or recording model/provider
synthetic protected resources
Raw Trace capture
```

Real acceptance uses:

```text
Bot QQ
Owner QQ
Visitor QQ
Test QQ group
NapCat
isolated Glassbox test database
isolated Pi agentDir
Lora PI Kit
real model execution
```

Tests must never write to live Personal Agent state, normal `~/.pi/agent`, real writable repositories, or production QQ session data.

## Retrieval and efficiency

Hybrid retrieval, semantic cache, smart routing, aggressive Context budgets, TokenJuice-style Tool-result projection, and broader runtime optimization remain post-P3 work unless a minimal mechanism is required for the closed loop itself.

The selected architecture keeps retrieval behind Glassbox-owned authorization boundaries and uses Turso as the default structured, lexical, and vector store.

Primary later mechanisms include:

```text
authorized hybrid retrieval
vector + lexical search
context budgets
tool-result budgets
tool-result projection
routing
thinking-depth selection
token estimation
permission-scoped semantic cache
```

`TokenRhythm/opensquilla` is a primary upstream reference for these later mechanisms.

When a mechanism is generic Pi workflow customization, prefer implementing it in Lora PI Kit. When it changes Glassbox product state, authorization, retrieval visibility, audience policy, or evidence semantics, keep it in Glassbox.

## Observability and Eval

Product observability is a Glassbox feature, not an external dashboard dependency.

P3 must expose enough evidence to inspect Channel, Principal, location, Conversation, authorization decisions, model-visible Context metadata, Tool decisions, Run, runtime/session identity, token usage where available, and final Delivery decision.

OpenTelemetry, Langfuse, Inspect AI, and Token Monitor are reference models for trace structure, scores, analytics, runtime usage, and later Eval design. They are not required control-plane dependencies.

Public observers may read only sanitized, explicitly published Trace or Eval snapshots.

## Long work, eval, and learning

Future layers may use ideas from Temporal, AGY, Inspect AI, SkillClaw, CoEvoSkills, Voyager, Dagster, and other recorded upstream references.

Do not introduce their infrastructure until an active plan needs the concrete boundary.

## Documentation site

The documentation / Learning Lab is a separate product surface.

Do not choose its framework merely because the Workbench uses React. The future docs implementation should optimize for:

```text
content quality
MD / MDX-style authoring
fast static delivery
interactive concept demos
code and contract links
versionable documentation
low client-side cost
```

The docs stack should be selected when the documentation implementation plan starts.
