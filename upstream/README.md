# upstream/

Selected reference implementations from mature open-source projects.

Nothing in this directory is imported at runtime. Vendor only the smallest source slices needed for a real implementation task.

## Rules

- Check relevant upstream implementations before inventing standard runtime, provider, channel, Agent operations, memory, eval, authorization, durable-task, trajectory, skill, asset, routing, retrieval, or token-budget infrastructure.
- Each vendored project must include source repository, pinned commit, license, original paths, and the reason each file was copied.
- Preserve copyright, license, and NOTICE requirements when copying code.
- Do not vendor an entire repository when a few files are enough.
- Keep upstream-specific commands and quirks inside the relevant integration boundary.
- If a project is only an approved reference, do not create an empty directory for it.
- A precise `SOURCES.md` research note is allowed when it records concrete source paths and adoption constraints even before source files are vendored.
- Upstream code is evidence and implementation material. Glassbox still owns its product model and security boundary.

## Currently vendored

- `pingdotgg/t3code`: Claude Code provider integration, permission handling, binary/config isolation, session resume, and event normalization. See `t3-code/SOURCES.md` for the pinned source and copied files.

## Approved references

Vendor selectively when a current implementation slice needs them.

| Project | Primary reference area |
| --- | --- |
| `earendil-works/pi` | Active primary Agent runtime foundation, SDK, packages, extensions, skills, tools, settings |
| `herdrdev/herdr` | Active P3 Agent Operations layer: persistent workspaces, worktrees, panes, coding-Agent lifecycle, socket API, event subscriptions, snapshot reconciliation |
| `aorumbayev/herdr-workflows` | Bounded linear Herdr workflow recipes; not durable Glassbox Task truth |
| `NapNeko/NapCatQQ` | QQ protocol-side runtime and OneBot connectivity for the active P3 Channel |
| `botuniverse/onebot-11` | OneBot 11 event and API contract for the active P3 QQ Channel |
| `HKUDS/OpenHarness` | Agent loop, tools, skills, memory, channel gateway, QQ patterns |
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
| `MineDojo/Voyager` | Skill library, successful-experience promotion, skill retrieval |
| `joonspk-research/generative_agents` | Memory stream, importance, reflection |
| `usememos/memos` | Journal timeline and selective visibility |
| `resend/resend-skills` | Agent email inbox, send/receive, inbound-email security |
| `calcom/cal.diy` | Scheduling, availability, calendar integration |
| `dagster-io/dagster` | Asset lineage, dependency, ownership, version, materialization |
| `google-deepmind/open_spiel` | Multi-player game environments and game evaluation |
| `sotopia-lab/sotopia` | Multi-Agent social environments and social evaluation |

The approved-reference list is a research index, not a dependency list. A project becomes a production dependency only when the active plan explicitly needs it.

Pi is the active primary runtime foundation for Plan 03. Glassbox embeds it through the public SDK and loads Lora PI Kit resources. Glassbox does not become a Pi fork or a Pi wrapper. Product identity, authorization, QQ Channel identity, Conversation, Turso state, audience policy, Task truth, and Trace remain Glassbox-owned. See `pi/SOURCES.md` and `../docs/runtime-strategy.md`.

Herdr is an active P3 execution dependency for the Agent Operations foundation. Glassbox integrates it through a product-owned `HerdrBridge`; Herdr workspace / pane / Agent state remains an execution observation, while Glassbox owns `Task`, `TaskAttempt`, `AttentionItem`, `WorkerBinding`, review, rework, authorization, and acceptance. See `herdr/SOURCES.md` and `../docs/agent-operations.md`.

`herdr-workflows` may run bounded stage recipes inside Herdr. It does not replace the Glassbox Task state machine or become the source of review/rework truth.

NapCat and OneBot are active P3 references for QQ transport. QQ transport stays in Glassbox and does not move into Lora PI Kit.

OpenSquilla remains a post-P3 efficiency reference. Its routing, retrieval, semantic cache, context compression, and token-budget mechanisms must not be added merely to complete the QQ and Agent Ops closed loops.

Token Monitor is a Runtime observability reference. P3 may reuse narrow Pi usage or health patterns when needed for Trace and acceptance, but full quota dashboards, Antigravity support, and broad cross-runtime history collection are not P3 requirements.