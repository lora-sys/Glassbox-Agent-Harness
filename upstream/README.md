# upstream/

Reference implementations and reference checkouts from open-source projects.

Nothing in this directory is imported at runtime by production code.

---

## Two Reference Tiers

Glassbox distinguishes between tracked reference files and local reference checkouts:

### 1. Tracked Selective References
- Directories: `upstream/opensquilla/SOURCES.md`
- Purpose: Curated reference slices and research source indices tracked in git.
- Scope: Not production code imports; used as inspectable reference material for adapters and provider contracts.

### 2. Local Reference Checkouts
- Directory: `upstream/repos/`
- Purpose: Full shallow checkouts (`--depth 1 --no-recurse-submodules`) for local reference, direct inspection, and pattern porting.
- Rules: Excluded from git via root `.gitignore`. Never run upstream install, build, or test scripts inside `upstream/repos/`. Tracked via `upstream/manifest.json` and the manifest table below.

---

## Approved future references

| Repository | Primary Area | Status |
| --- | --- | --- |
| `resend/resend-skills` | Agent email inbox, send/receive, inbound security | Approved future reference |
| `calcom/cal.diy` | Scheduling, availability, calendar integration | Approved future reference |

---

## Reference Checkout Manifest (`upstream/repos/`)

On 2026-09-12, 26 reference repositories were shallow-cloned locally into `upstream/repos/`. These ignored checkouts are not included when another developer clones Glassbox. Detailed machine-readable records are kept in [`upstream/manifest.json`](./manifest.json).

| Repository | Local Directory | Verified HEAD SHA | License File / Status | Verified License | Primary Reference Focus | Roadmap Phase |
| --- | --- | --- | --- | --- | --- | --- |
| [`HKUDS/OpenHarness`](https://github.com/HKUDS/OpenHarness.git) | `upstream/repos/OpenHarness` | `9b2efd795c6aa09f88b0c257d269a9e518da6ae7` | `upstream/repos/OpenHarness/LICENSE` | MIT | Agent loop, tools, skills, memory, channel gateway, QQ | P3 QQ Gateway |
| [`openfga/openfga`](https://github.com/openfga/openfga.git) | `upstream/repos/openfga` | `73591ef16ce508623920d5b706286ffcdfb6841b` | `upstream/repos/openfga/LICENSE` | Apache-2.0 | Fine-grained relation-based authorization | P3 Foundation |
| [`tursodatabase/turso`](https://github.com/tursodatabase/turso.git) | `upstream/repos/turso` | `a9a8779c1906247ae3ae78cd098ba713c27d8c9b` | `upstream/repos/turso/LICENSE.md` | MIT | Structured Personal Agent state and SQLite-compatible persistence | P3 Foundation |
| [`joyehuang/trajectory-panel`](https://github.com/joyehuang/trajectory-panel.git) | `upstream/repos/trajectory-panel` | `ef3ac78f48523d0902e71bca896eae28e2324fe6` | `upstream/repos/trajectory-panel/LICENSE` | MIT | Trajectory parsing, timeline, incremental tail, redaction, Turso sync | P3 Foundation |
| [`TokenRhythm/opensquilla`](https://github.com/TokenRhythm/opensquilla.git) | `upstream/repos/opensquilla` | `d695762b85cd2135b18982cd16efc51d2b69edd2` | `upstream/repos/opensquilla/LICENSE` | Apache-2.0 | Context budgets, tool-result budgets, hybrid retrieval, model routing, token projection | Post-P3 Efficiency |
| [`temporalio/sdk-typescript`](https://github.com/temporalio/sdk-typescript.git) | `upstream/repos/sdk-typescript` | `e37ed88b7c71dc35c022464d095bca69a9b2dcd3` | `upstream/repos/sdk-typescript/LICENSE` | MIT | Durable long tasks, retry, signal, cancellation, child work, continuation | P7 Durable work |
| [`UKGovernmentBEIS/inspect_ai`](https://github.com/UKGovernmentBEIS/inspect_ai.git) | `upstream/repos/inspect_ai` | `8ebe620d74c1eb679438db1b65324e30e2306092` | `upstream/repos/inspect_ai/LICENSE` | MIT | Eval tasks, datasets, scorers, eval sets, experiment execution | P8 Eval |
| [`langchain-ai/langmem`](https://github.com/langchain-ai/langmem.git) | `upstream/repos/langmem` | `9d033b47d9ce53e37e92c92241b0496c0278932e` | `upstream/repos/langmem/LICENSE` | MIT | Semantic, episodic, procedural memory and consolidation | P5 Memory |
| [`zhibao-dev/Learning-Multi-Factor-Memory`](https://github.com/zhibao-dev/Learning-Multi-Factor-Memory.git) | `upstream/repos/Learning-Multi-Factor-Memory` | `2d51bdf279cd837eed7d582bad2bde58caa74c61` | metadata_only | MIT (pyproject.toml declaration) | Memory value, forgetting, retrieval value, memory hygiene | P5 Memory |
| [`AMAP-ML/SkillClaw`](https://github.com/AMAP-ML/SkillClaw.git) | `upstream/repos/SkillClaw` | `3938f7537645c961d94498a0a79fc0a977019595` | `upstream/repos/SkillClaw/LICENSE` | MIT | Skill evolution from real sessions, deduplication, cross-session improvement | P8 Skill evolution |
| [`Zhang-Henry/CoEvoSkills`](https://github.com/Zhang-Henry/CoEvoSkills.git) | `upstream/repos/CoEvoSkills` | `da5a53db0e6d12e61e81e64588ad085e37a73e19` | `upstream/repos/CoEvoSkills/LICENSE` | Apache-2.0 | Skill generation, verification, refinement, validated promotion | P8 Skill evolution |
| [`MineDojo/Voyager`](https://github.com/MineDojo/Voyager.git) | `upstream/repos/Voyager` | `55e45a880755d0c8c66ca7fb5fe7962ac8974f89` | `upstream/repos/Voyager/LICENSE` | MIT | Skill library, successful-experience promotion, skill retrieval | P8 Skill evolution |
| [`joonspk-research/generative_agents`](https://github.com/joonspk-research/generative_agents.git) | `upstream/repos/generative_agents` | `fe05a71d3e4ed7d10bf68aa4eda6dd995ec070f4` | `upstream/repos/generative_agents/LICENSE` | Apache-2.0 | Memory stream, importance, reflection | P5 Memory |
| [`usememos/memos`](https://github.com/usememos/memos.git) | `upstream/repos/memos` | `751005bc190e9f68e92bfa0d850f3015bec7febc` | `upstream/repos/memos/LICENSE` | MIT | Journal timeline and selective visibility | Future Journal |
| [`dagster-io/dagster`](https://github.com/dagster-io/dagster.git) | `upstream/repos/dagster` | `249fbedf4d81541bf83b8e2727ae2fb6332a243d` | `upstream/repos/dagster/LICENSE` | Apache-2.0 | Asset lineage, dependency, ownership, version, materialization | P8 Assets |
| [`google-deepmind/open_spiel`](https://github.com/google-deepmind/open_spiel.git) | `upstream/repos/open_spiel` | `48401890ee9857e611678302371378175a8e4c6b` | `upstream/repos/open_spiel/LICENSE` | Apache-2.0 | Multi-player game environments and game evaluation | Future Arena |
| [`sotopia-lab/sotopia`](https://github.com/sotopia-lab/sotopia.git) | `upstream/repos/sotopia` | `a0aaafb440e570e5e61b7c44a44e5e417c545383` | `upstream/repos/sotopia/LICENSE` | MIT | Multi-Agent social environments and social evaluation | Future Arena |
| [`earendil-works/pi`](https://github.com/earendil-works/pi.git) | `upstream/repos/pi` | `71dca871bc80b6bc97be37f0ca3189399d651fff` | `upstream/repos/pi/LICENSE` | MIT | TypeScript model providers and existing Agent loop | P3 Provider |
| [`NapNeko/NapCatQQ`](https://github.com/NapNeko/NapCatQQ.git) | `upstream/repos/NapCatQQ` | `109d0c1dff755875f3b79795e99cee6115289fbb` | `upstream/repos/NapCatQQ/LICENSE` | LicenseRef-NapCat-Limited-Redistribution | External OneBot QQ connector and message delivery; no source vendoring | P3 QQ Gateway |
| [`SnowLuma/SnowLuma`](https://github.com/SnowLuma/SnowLuma.git) | `upstream/repos/SnowLuma` | `fb5f9b21558134db8803d216dfc19c6bce11f2c0` | `upstream/repos/SnowLuma/LICENSE` | LicenseRef-SnowLuma-Source-Available | Alternative OneBot 11 implementation reference, external protocol integration only | P3 QQ Gateway |
| [`botuniverse/onebot-11`](https://github.com/botuniverse/onebot-11.git) | `upstream/repos/onebot-11` | `d4456ee706f9ada9c2dfde56a2bcfc69752600e4` | no_license_file | Unspecified in repo | OneBot 11 standard interface and event specification | P3 QQ Gateway |
| [`tencent-connect/botpy`](https://github.com/tencent-connect/botpy.git) | `upstream/repos/botpy` | `e25f3e84bad7217357d8200a9d12939b58285b84` | `upstream/repos/botpy/LICENSE` | MIT | Official Tencent QQ Robot SDK (Python), channel event models | P3 QQ Gateway |
| [`tencent-connect/bot-docs`](https://github.com/tencent-connect/bot-docs.git) | `upstream/repos/bot-docs` | `645787a45937e5d9c4f0f61afefdffde0f38696e` | `upstream/repos/bot-docs/License` | MIT | Official Tencent QQ Robot API documentation and schemas | P3 QQ Gateway |
| [`deepseek-ai/deepseek-harness`](https://github.com/deepseek-ai/deepseek-harness.git) | `upstream/repos/deepseek-harness` | `c291e7961a515f6d7af9304e7fd1d257929aef26` | `upstream/repos/deepseek-harness/LICENSE` | MIT | Cordis plugin-based Agent runtime, capability lifecycle and composition | Runtime reference |

---

## Rules

- Check relevant upstream implementations before inventing standard provider, channel, memory, eval, authorization, durable-task, trajectory, skill, asset, routing, retrieval, or token-budget infrastructure.
- Each vendored project must include source repository, pinned commit, license, original paths, and the reason each file was copied.
- Preserve copyright, license, and NOTICE requirements when copying code.
- Do not vendor an entire repository into production when a few files are enough.
- Keep upstream-specific commands and quirks inside the relevant integration boundary.
- If a project is only an approved reference, do not create an empty directory for it in the tracked tree.
- A precise `SOURCES.md` research note is allowed when it records concrete source paths and adoption constraints even before source files are vendored.
- Upstream code is evidence and implementation material. Glassbox still owns its product model and security boundary.
- OpenSquilla is specifically a post-foundation efficiency reference. Its routing, retrieval, context compression, and token-budget mechanisms must not become Plan 03 dependencies. Authorization, identity, Conversation isolation, persistence correctness, and auditable evidence come first.
NapCat has a custom restricted license and remains an external protocol integration, not a source-vendoring candidate. A missing license or metadata-only declaration is not verified permission to copy source.

The current copy-and-adapt choices are documented in [.plans/findings/03-p3.2-source-reuse-map.md](../.plans/findings/03-p3.2-source-reuse-map.md). SnowLuma is source-available with non-commercial and derivative-distribution restrictions, and is not a source-vendoring candidate.
