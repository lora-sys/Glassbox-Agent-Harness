# Token Monitor source index

Reference project: `Javis603/token-monitor`

Pinned upstream commit: `97fa89108e9384b48b1d2ffe1c3635655636c1b0`

Upstream branch at review time: `main`

License: MIT.

Token Monitor is an approved reference for Glassbox Runtime observability: local Coding Runtime discovery, session/usage collection, normalized token and cost reporting, quota/limit collection, client health checks, and Antigravity-specific monitoring. No production code in Glassbox imports this directory.

## Why it matters

Glassbox now treats execution backends as Runtimes rather than a separate model-provider management layer:

```text
Runtime
→ Model
→ Run
→ Trace
```

The Web Management UI needs one normalized monitoring surface across the initial Runtime set:

```text
Codex
Claude Code
Pi
Antigravity
```

Token Monitor already solves many of the provider/runtime-specific collection problems that should remain outside Glassbox's product model, including:

- locating local Claude Code / Codex / Pi / Antigravity data roots
- normalizing client/runtime names
- collecting token usage and history
- handling per-client source-root differences
- checking whether a local client data source exists
- collecting provider/runtime limits and quotas
- Antigravity local usage / quota mechanisms
- tests that guard source-root and limit behavior

Glassbox should study and selectively port these mechanisms instead of recreating the same local-runtime discovery logic from scratch.

## Candidate source slices

| Upstream path | What to study / potentially port |
| --- | --- |
| `src/shared/collector.js` | Runtime/client source-root discovery, watch roots, local session collection, Antigravity conversation roots |
| `src/shared/usage.js` | Usage normalization, client-name normalization, aggregation semantics |
| `src/shared/clientCatalog.js` | Per-client capabilities, scan behavior, duplicate/import caveats |
| `src/shared/clientHealth.js` | Source-root health checks and useful user-facing failure states |
| `src/shared/limits/collector.js` | Unified limits/quota collection dispatch across supported runtimes |
| `src/shared/limits/core.js` | Limits normalization and common quota-window handling |
| `src/shared/providers/antigravity/limits.js` | Antigravity-specific quota collection and normalization |
| `docs/providers/antigravity.md` | Antigravity collection sources, local RPC / account behavior, operational constraints |
| `docs/API.md` | Usage / history projection semantics exposed by Token Monitor |
| `tests/shared/usage.test.js` | Usage normalization regression coverage |
| `tests/shared/clientHealth.test.js` | Source-root and health invariants |
| `tests/shared/antigravityLimits.test.js` | Antigravity quota behavior and edge cases |
| `tests/shared/collectorLoadGuards.test.js` | Collector loading / source-root guard behavior |

Do not vendor all of these at once. Copy a source slice only when a concrete Glassbox Runtime-monitoring task needs it.

## Proven patterns worth consulting

### Local Runtime discovery is adapter-specific

Different Coding Runtimes persist sessions and usage in different locations and formats. That logic should stay in Runtime-specific collectors rather than leaking into the Web UI or a global generic parser.

Target Glassbox shape:

```text
Codex local data ───────┐
Claude Code local data ─┤
Pi local data ──────────┤
Antigravity local data ─┤
                        ↓
             runtime/collectors/*
                        ↓
                 normalized usage
```

### Normalize before the Web UI

The UI should consume a Glassbox-owned contract, not Token Monitor objects directly.

Conceptual Glassbox projection:

```text
RuntimeUsage
  input
  output
  cacheRead
  cacheWrite
  reasoning
  totalTokens
  costTotalUsd
```

Related management projections may include:

```text
RuntimeHealth
RuntimeLimits
RuntimeModelUsage
RuntimePolicy
```

### Unknown must remain unknown

If a Runtime cannot report comparable usage, cost, quota, or balance:

```text
Unknown / unavailable / null
```

Do not turn missing data into zero and do not estimate pricing unless Glassbox has an explicit pricing source.

### Antigravity is a first-class Runtime slot

Token Monitor has concrete Antigravity handling for local conversation discovery and limit collection. Glassbox should study those mechanisms when implementing the Antigravity adapter.

The intended Glassbox boundary remains:

```text
Local Antigravity CLI / process
→ Glassbox Antigravity adapter
→ normalized Run / Trace / RuntimeUsage / RuntimeLimits
```

Do not make the Web UI depend directly on Antigravity's local storage or RPC shape.

### Collection must not widen authority

Runtime monitoring is observability, not authorization.

Collectors may discover local usage/session metadata for the Owner's management view, but they must not widen a Principal's effective permissions or bypass Glassbox authorization for protected runtime data exposed through APIs or remote channels.

### Preserve evidence separately from usage summaries

Token/cost summaries are management projections. They are not Raw Trace.

Glassbox should continue to preserve execution evidence independently while deriving usage/cost/limit summaries for management views.

### Privacy-first projection

The management UI should expose normalized usage and sanitized session metadata without unnecessarily copying prompts, source code, credentials, or private transcript bodies into remote monitoring payloads.

If a future sync/export mechanism is introduced, keep the payload deliberately narrower than local Raw Trace.

## Expected production boundary

Reference material belongs here:

```text
upstream/token-monitor/
```

Future Glassbox production code should live in Glassbox-owned runtime boundaries, for example:

```text
apps/server/src/runtime/
  usage/
  collectors/
  limits/
  health/
```

and shared API/domain contracts should live in Glassbox-owned contract packages rather than importing Token Monitor types.

The existing `ProviderAdapter` execution lifecycle should not be overloaded with historical usage scanning or quota polling. Runtime collection is a separate management/observability responsibility.

## Vendoring and license rules

This source is MIT licensed.

If Glassbox copies a substantial implementation slice:

- preserve the relevant MIT copyright and license notice
- record the original path and this pinned commit
- vendor only the smallest mechanism required
- port behavior into Glassbox-owned types and security boundaries
- keep Runtime-specific quirks inside the relevant adapter / collector
- bring over focused upstream tests when they encode important edge cases

Production code must not import directly from `upstream/token-monitor/`.

## Current phase boundary

Plan 03 remains focused on:

```text
Identity
→ Authorization
→ Conversation
→ Turso persistence
→ Run / Authorization Trace
```

Adding Token Monitor to `upstream/` does not make Runtime usage collection, quota monitoring, Antigravity support, or broader Runtime observability a Plan 03 dependency.

Use this reference when the concrete Runtime Monitoring / Antigravity implementation slice begins.