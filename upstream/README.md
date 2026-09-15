# upstream/

Selected reference implementations from mature open-source projects.

Nothing in this directory is imported at runtime. Vendor only the smallest source slices needed for a real implementation task.

## Upstream-first rule

Do not invent a standard mechanism before checking whether a mature upstream already solves it.

This applies to:

```text
runtime
provider
Tool
MCP
Skill loading
hooks
profiles / config
Channel
Agent operations
Task / workflow mechanics
memory / Taste mechanics
Eval
authorization mechanisms
trajectory / Trace
assets
routing
retrieval
token / context budgets
observability
```

Use this order:

```text
1. Reuse an existing public upstream API or dependency directly when it fits.
2. Port / adapt the smallest mature upstream mechanism when direct reuse does not fit.
3. Preserve the upstream behavior, contracts, edge cases, and useful tests where practical.
4. Design a new mechanism only after recording why the relevant upstream options are insufficient.
```

A custom implementation needs evidence that the upstream boundary is incompatible, insufficient, unsafe for Glassbox, or cannot satisfy license / deployment constraints.

Do not rewrite a mature mechanism from scratch merely to make it look locally consistent.

Upstream-first does not mean copying another project's product truth or trust model. Glassbox keeps its own identity, authorization, Conversation, Task, Taste / Memory, audience, and evidence semantics. Herdr keeps live worker execution truth. Pi remains the primary Agent engine.

## Copy / port rules

- Check relevant upstream implementations before inventing standard runtime, provider, Tool, MCP, Channel, Agent operations, memory, Taste, Eval, authorization, durable-task, trajectory, Skill, asset, routing, retrieval, or token-budget infrastructure.
- Each vendored or substantially ported mechanism must record source repository, pinned commit, license, original paths, and why it was adopted.
- Preserve copyright, license, NOTICE, and attribution requirements when copying or porting code.
- Prefer a direct dependency or public API over copied source when the upstream package boundary is stable and compatible.
- Do not vendor an entire repository when a few files or one package are enough.
- Keep upstream-specific commands and quirks inside the relevant integration boundary.
- If a project is only an approved reference, do not create an empty directory for it.
- A precise `SOURCES.md` research note is allowed when it records concrete source paths and adoption constraints even before source files are vendored.
- Bring focused upstream tests or equivalent behavioral tests with a ported mechanism when they capture important edge cases.
- Upstream code is evidence and implementation material. Glassbox still owns its product model and security boundary.

## Default harness reference

`HKUDS/OpenHarness` is the default reference for general Agent-harness capabilities that upstream Pi does not already provide directly.

Before designing a new Tool, MCP adapter, Skill loader, Hook, profile/config mechanism, Web Tool, LSP Tool, capability search, or similar harness feature:

```text
check Pi first
→ check OpenHarness
→ check a more specialized approved upstream when one exists
→ only then invent
```

Use OpenHarness heavily for Tool inventory, schemas, UX, failure handling, MCP, Hooks, profiles, Channel patterns, and tests.

Do not copy its Task, Agent-team, worktree, permission, or memory ownership wholesale when those concepts already belong to Glassbox / Herdr. Borrow the mature contract and behavior, then map it to the correct owner.

See `openharness/SOURCES.md`.

## Currently vendored

- `pingdotgg/t3code`: Claude Code provider integration, permission handling, binary/config isolation, session resume, and event normalization. See `t3-code/SOURCES.md` for the pinned source and copied files.

## Approved references

Vendor selectively when a current implementation slice needs them.

| Project | Primary reference area |
| --- | --- |
| `earendil-works/pi` | Active primary Agent runtime foundation, SDK, Packages, Extensions, Skills, Tools, settings |
| `HKUDS/OpenHarness` | Default general harness reference: Tool inventory, MCP, Skills, Hooks, profiles, Channels, Agent-loop UX, tests |
| `herdrdev/herdr` | Active P3 Agent Operations layer: persistent workspaces, worktrees, panes, coding-Agent lifecycle, socket API, event subscriptions, snapshot reconciliation |
| `aorumbayev/herdr-workflows` | Bounded linear Herdr workflow recipes; not durable Glassbox Task truth |
| `NapNeko/NapCatQQ` | QQ protocol-side runtime and OneBot connectivity for the active P3 Channel |
| `botuniverse/onebot-11` | OneBot 11 event and API contract for the active P3 QQ Channel |
| `CommandCodeAI/command-code` | P4 Taste mechanics: learn preferences from accept/reject/edit behavior, project/user scope, continuous preference learning |
| `keli-wen/agy-staff` | AGY worker delegation and background job lifecycle |
| `TokenRhythm/opensquilla` | Later context budgets, tool-result budgets, hybrid retrieval, routing, token-efficient projection |
| `Javis603/token-monitor` | Runtime discovery, token/cost history, quotas/limits, health checks, session usage |
| `joyehuang/trajectory-panel` | Trajectory parsing, timeline, incremental tail, redaction, Turso sync |
| `UKGovernmentBEIS/inspect_ai` | Eval tasks, datasets, scorers, eval sets, experiment execution |
| `temporalio/sdk-typescript` | Durable long tasks, retry, signal, cancellation, child work, continuation |
| `tursodatabase/turso` | Structured Personal Agent state and SQLite-compatible persistence |
| `openfga/openfga` | Fine-grained relation-based authorization |
| `zhibao-dev/Learning-Multi-Factor-Memory` | Memory value, forgetting, retrieval value, memory hygiene |
| `langchain-ai/langmem` | Semantic, episodic, procedural memory and consolidation |
| `AMAP-ML/SkillClaw` | Skill evolution from real sessions, deduplication, cross-session improvement |
| `Zhang-Henry/CoEvoSkills` | Skill generation, verification, refinement, validated promotion |
| `MineDojo/Voyager` | Skill library, successful-experience promotion, Skill retrieval |
| `joonspk-research/generative_agents` | Memory stream, importance, reflection |
| `usememos/memos` | Journal timeline and selective visibility |
| `resend/resend-skills` | Agent email inbox, send/receive, inbound-email security |
| `calcom/cal.diy` | Scheduling, availability, calendar integration |
| `dagster-io/dagster` | Asset lineage, dependency, ownership, version, materialization |
| `google-deepmind/open_spiel` | Multi-player game environments and game evaluation |
| `sotopia-lab/sotopia` | Multi-Agent social environments and social evaluation |

The approved-reference list is a research index, not a dependency list. A project becomes a production dependency only when the active plan explicitly needs it.

Pi is the active primary runtime foundation for Plan 03. Glassbox embeds it through the public SDK and loads Lora PI Kit resources. Glassbox does not become a Pi fork or a Pi wrapper. Product identity, authorization, QQ Channel identity, Conversation, Turso state, audience policy, Task truth, and Trace remain Glassbox-owned. See `pi/SOURCES.md`, `../docs/runtime-strategy.md`, and `../docs/lora-pi-kit.md`.

OpenHarness is the default general capability reference after Pi. Pi-native capability wins when equivalent functionality already exists. Otherwise, Lora PI Kit should prefer a focused OpenHarness-derived port over a fresh design for standard harness features such as MCP, LSP, capability discovery, Web Tools, Hooks, profiles, and Skill UX. OpenHarness product-state ownership does not override Glassbox / Herdr boundaries. See `openharness/SOURCES.md`.

Herdr is an active P3 execution dependency for the Agent Operations foundation. Glassbox integrates it through a product-owned `HerdrBridge`; Herdr workspace / pane / Agent state remains an execution observation, while Glassbox owns `Task`, `TaskAttempt`, `AttentionItem`, `WorkerBinding`, review, rework, authorization, and acceptance. See `herdr/SOURCES.md` and `../docs/agent-operations.md`.

`herdr-workflows` may run bounded stage recipes inside Herdr. It does not replace the Glassbox Task state machine or become the source of review/rework truth.

NapCat and OneBot are active P3 references for QQ transport. QQ transport stays in Glassbox and does not move into Lora PI Kit.

Command Code is a P4 research reference for Taste. Glassbox adopts the useful pattern of treating accept, reject, edit, revert, and correction behavior as feedback, but keeps FeedbackEvent, Taste, confidence, scope, authorization, and retrieval as Glassbox-owned durable product state. Command Code is not a dependency. See `command-code/SOURCES.md` and `../docs/memory-taste.md`.

OpenSquilla remains a post-P3 efficiency reference. Its routing, retrieval, semantic cache, context compression, and token-budget mechanisms must not be added merely to complete the QQ and Agent Ops closed loops.

Token Monitor is a Runtime observability reference. P3 may reuse narrow Pi usage or health patterns when needed for Trace and acceptance, but full quota dashboards, Antigravity support, and broad cross-runtime history collection are not P3 requirements.
