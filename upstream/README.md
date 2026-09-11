# upstream/

Selected reference implementations from mature open-source projects.

Nothing in this directory is imported at runtime. Vendor only the smallest source slices needed for a real implementation task.

## Rules

- Check relevant upstream implementations before inventing standard provider, channel, memory, eval, authorization, durable-task, trajectory, skill, asset, routing, retrieval, or token-budget infrastructure.
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
| `HKUDS/OpenHarness` | Agent loop, tools, skills, memory, channel gateway, QQ |
| `keli-wen/agy-staff` | AGY worker delegation and background job lifecycle |
| `TokenRhythm/opensquilla` | Context budgets, tool-result budgets, hybrid vector retrieval, model routing, token-efficient projection |
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

The approved-reference list is a research index, not a dependency list. Do not add a runtime dependency just because a project appears here.

OpenSquilla is specifically a post-foundation efficiency reference. Its routing, retrieval, context compression, and token-budget mechanisms must not become Plan 03 dependencies. Authorization, identity, Conversation isolation, persistence correctness, and auditable evidence come first.