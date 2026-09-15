# OpenHarness source index

Reference project: `HKUDS/OpenHarness`

Pinned upstream commit: `9b2efd795c6aa09f88b0c257d269a9e518da6ae7`

Upstream branch at review time: `main`

License: MIT.

OpenHarness is the default upstream reference for standard Agent-harness capabilities that Pi does not already provide directly.

The rule is not to reproduce OpenHarness as a second runtime. The rule is to reuse its mature capability design, contracts, edge cases, and tests, then implement the needed behavior through Pi / Lora PI Kit or the correct Glassbox-owned boundary.

## Adoption order

For a standard Agent capability, use this order:

```text
1. Does upstream Pi already provide it?
   → use Pi directly

2. Does OpenHarness already provide a mature version?
   → port / adapt the smallest useful mechanism

3. Does another approved upstream own the problem better?
   → use that upstream instead

4. Only then design a new mechanism
   → record why the upstream boundaries were insufficient
```

Do not create a parallel implementation merely because rewriting it from scratch feels simpler.

When source code is substantially ported, preserve the upstream license / copyright requirements and record the original source path and pinned commit.

## What to study first

| Upstream path | Primary use in Glassbox / Lora PI Kit |
| --- | --- |
| `src/openharness/tools/__init__.py` | Default Tool capability inventory and registration patterns |
| `src/openharness/tools/base.py` | Tool contract, normalized result, execution context, registry behavior |
| `src/openharness/tools/mcp_tool.py` | MCP Tool → normal Agent Tool adapter |
| `src/openharness/tools/mcp_auth_tool.py` | MCP auth-management UX and boundary |
| `src/openharness/mcp/` | MCP client manager, config, transports, lifecycle |
| `src/openharness/tools/lsp_tool.py` | Structured code-intelligence Tool |
| `src/openharness/tools/glob_tool.py` | Structured filesystem discovery |
| `src/openharness/tools/grep_tool.py` | Structured content search |
| `src/openharness/tools/tool_search_tool.py` | Capability / Tool discovery instead of exposing everything at once |
| `src/openharness/tools/skill_tool.py` | Skill discovery / reading behavior |
| `src/openharness/tools/web_fetch_tool.py` | Web fetch Tool contract |
| `src/openharness/tools/web_search_tool.py` | Web search Tool contract |
| `src/openharness/hooks/` | Hook lifecycle and extension points |
| `src/openharness/config/` | Profiles, settings and override behavior |
| `src/openharness/channels/` | Channel adapter patterns |
| `src/openharness/gateway/` and `ohmo/gateway/` | Personal-Agent gateway patterns and remote-message handling |
| `src/openharness/memory/` | Research reference only; Glassbox uses its own Rules / Skills / Taste / Memory split |
| `tests/` | Edge cases and behavioral tests that should travel with a ported mechanism |

## Tool mapping

OpenHarness currently exposes a broad default Tool set. Use it as a capability checklist, not as a package to copy wholesale.

### Use Pi native capability when equivalent exists

```text
OpenHarness BashTool
→ Pi native bash

OpenHarness FileReadTool
→ Pi native read

OpenHarness FileWriteTool
→ Pi native write

OpenHarness FileEditTool
→ Pi native edit
```

Do not create duplicate `read` / `file_read`, `edit` / `file_edit`, or similar competing Tool surfaces without a tested reason.

### Primary Lora PI Kit ports / adaptations

These are strong candidates for TypeScript ports or behavior-compatible implementations in Lora PI Kit when the active plan needs them:

```text
MCP client / manager
McpToolAdapter
MCP resource listing / reading
MCP auth UX
LSP Tool
Glob Tool when Pi has no equivalent structured surface
Grep Tool when Pi has no equivalent structured surface
Tool Search / capability discovery
Skill discovery UX
Web Search
Web Fetch
Ask User interaction where runtime-local
Notebook editing when useful
selected Hooks
profile / config UX
```

Port the behavior into Pi Extension / custom Tool / Package APIs. Do not import Python runtime code into production.

### Borrow UX / contract, keep Glassbox as owner

OpenHarness has useful implementations for these concepts, but their durable truth belongs elsewhere in this architecture:

```text
OpenHarness Task Tools
→ Glassbox Task / Ops Tools

OpenHarness Agent / Team Tools
→ Glassbox delegation + Herdr workers

OpenHarness Worktree Tools
→ HerdrBridge / WorkerBinding

OpenHarness Cron Tools
→ future Glassbox durable scheduler

OpenHarness permission model
→ Glassbox Authorization

OpenHarness Memory
→ research input for Glassbox Rules / Skills / Taste / Memory

OpenHarness gateway / Channel behavior
→ adapt behind Glassbox Channel contracts
```

The upstream implementation can still supply naming, Tool schemas, failure cases, user interaction, and tests. Its product-state authority is not copied.

## Current OpenHarness Tool inventory

At the pinned commit, the default registry includes capabilities in these groups:

```text
Coding
  Bash
  File Read / Write / Edit
  Notebook Edit
  Glob
  Grep
  LSP

Interaction / workflow
  Ask User Question
  Brief
  Sleep
  Todo
  Plan mode

Skills / discovery
  Skill
  Tool Search

Web / image
  Web Fetch
  Web Search
  Image to Text
  Image Generation

MCP
  MCP auth
  MCP Tool adapter
  MCP resource list / read

Worktree
  enter / exit worktree

Config
  settings read / update

Cron
  create / list / delete / toggle

Task
  create / get / list / stop / output / update

Agent / team
  spawn Agent
  send message
  create / delete team

Remote
  remote trigger
```

Before adding a new Lora PI Kit Tool in one of these categories, inspect the corresponding OpenHarness implementation and tests first.

## Boundary rule

Use this decision test:

```text
Standard Pi workflow capability
→ Pi or Lora PI Kit

Personal-Agent identity / authorization / durable Conversation / Task / Taste / Memory / audience / evidence
→ Glassbox

Live coding workspace / worktree / pane / worker lifecycle
→ Herdr
```

If an OpenHarness mechanism crosses those boundaries, keep the reusable mechanism and replace the ownership / authorization layer with the Glassbox architecture.

## Do not cargo-cult

Upstream-first does not mean blind copying.

Do not copy:

```text
an incompatible runtime architecture
an upstream permission model as Glassbox authority
a second Task database
a second worker scheduler that conflicts with Herdr
a duplicate Pi-native Tool
a dependency whose license cannot be satisfied
```

The goal is faster, evidence-backed implementation, not accumulating multiple competing frameworks.
