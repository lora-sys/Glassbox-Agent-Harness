# Glassbox current context

Updated 2026-09-12. This file records current implementation facts and agreed boundaries. [AGENTS.md](AGENTS.md) owns engineering rules and vocabulary. [Plan 03](.plans/03-personal-agent-foundation.md) owns the current implementation scope. [Roadmap](.plans/roadmap.md) owns later sequencing.

## Current release

Build the Windows personal assistant used through QQ group mentions and Owner private chat. Keep platform-dependent paths and process discovery isolated so macOS and Linux can be verified later. Do not claim those platforms work before testing them.

The release includes configurable model APIs through agy-staff, durable Conversations and Runs, task control and delivery, inspectable Trace, a fixed Eval suite, and one WebUI and CLI for management. Both management clients use the same server-owned configuration and domain APIs. Deterministic tests use disposable state and fake providers.

Broader user roles, automatic Memory consolidation, Skill evolution, general LongTask orchestration, Arena, and the full Eval platform remain later work.

## Current source boundaries

| Location | Current responsibility | Status |
| --- | --- | --- |
| apps/server/src/index.ts | Service startup, authenticated Workbench HTTP API and in-memory Session lifecycle | Local management and CLI integrated; broader domain integration pending |
| apps/server/src/provider | Common adapter interface and factory | Existing; shared contracts isolated by provider boundary |
| apps/server/src/agy-staff | agy-staff execution integration | Existing; profile validation and provider claims need verification |
| apps/server/src/codex | 兼容性适配器历史目录 | Existing; retained for historical evidence only, not active execution path |
| apps/server/src/trace | Append-only JSONL evidence and loading | Existing; new Run indexing and authorized querying not yet implemented |
| apps/server/src/state | Trace reduction and replay | Existing and reusable |
| apps/server/src/screening | Pattern-based output screening | Existing; supplementary to authorization |
| apps/server/src/config | Named model profiles, credential slots, public configuration views, atomic writes | Save, reopen, credential projection and shared-slot regression checks pass |
| apps/server/src/management | Shared local CLI and WebUI HTTP boundary, bearer authentication, exclusive directory ownership, WebSocket tickets | Main server and CLI integration checks pass; Chrome pending |
| apps/server/src/persistence, identity, auth, conversation | Local database, scoped identities, explicit grants, Conversations and Run state | Eleven disposable database tests pass; Run supervisor integration in progress |
| apps/server/src/cli | Unified management commands and local HTTP client | Eighty-two focused tests and main-server model query pass; domain commands await handlers |
| apps/server/src/model, execution/model-agent | Selected Pi model protocols and explicit tool loop | Thirty-eight fixed tests and scoped type/lint check pass; real model acceptance pending |
| apps/server/src/ws | Workbench live events | Existing; does not yet carry new domain state |
| apps/web/src/routes | Workbench and Canvas | Existing; unified management navigation not yet implemented |
| apps/web/src/inspector | Selected execution details | Existing and reusable |
| packages/contracts | Shared model configuration, management status and diagnostics | Used by server and WebUI |
| packages/shared | Runtime-independent helpers | Keep small |
| upstream/repos | Pinned reference checkouts | Ignored; never imported or packaged |

Add identity, authorization, configuration, conversation, persistence, channel, execution, and eval modules under apps/server/src as real slices require them. Directory names alone do not establish completed boundaries.

## Domain decisions

- One Personal Agent accepts multiple Channels. A Channel does not create a new Agent identity.
- A Principal identifies the effective caller. Binding an identity does not grant permission.
- Authorize before assembling model context. Recheck protected tools when they execute.
- A Conversation is durable product state. Provider Session is execution context. A Run is one execution. These identifiers remain distinct.
- QQ routing includes trusted connection and bot account, chat type, group, sender, and thread. Group and private conversations never reuse their history or Provider Session.
- Owner private resources cannot enter a group task through prompts, tools, files, attachments, traces, or implicit harness configuration discovery.
- ModelProvider handles a model protocol. ExecutionAdapter owns execution and cancellation. ChannelAdapter owns transport and message normalization. Capabilities describe tested behavior.
- Use local Turso/libSQL structured persistence first. Raw Trace remains append-only evidence. Database projections can be rebuilt from cursors; file and database writes are not one transaction.
- Persist incoming deduplication and queue intent before acknowledging a task. Delivery distinguishes confirmed success, failure, and unknown result. Unknown delivery is not blindly retried.
- Cancellation and recovery reflect underlying execution facts. A restart does not turn an unfinished Run into success or replay a non-idempotent tool.
- Eval results link sample, Run, Trace, scorer version, expected result, and observation. Missing usage is unknown, not zero.

The full shared glossary is in [AGENTS.md](AGENTS.md#a-small-glossary). Keep one definition there instead of introducing competing terms here.

## Source reuse

Copy permitted source into owned modules and record source repository, commit, original file, license, notices, and local changes. Adapt incompatible languages from the verified implementation. Runtime code cannot import upstream checkouts or depend on complete upstream frameworks.

Use PI for model requests and the Agent loop, local adaptation for execution orchestration and channel wiring, trajectory-panel for trace projection and database patterns, and Inspect AI for Sample and Score semantics. Normal SDKs, database drivers, ws, and build tools remain normal dependencies.

NapCat and SnowLuma are external OneBot implementations. Their restricted source is not copied into Glassbox. QQ official is a separate adapter with separate identities and capabilities.

Pinned sources and licenses live in [upstream/manifest.json](upstream/manifest.json). The [source reuse map](.plans/findings/03-p3.2-source-reuse-map.md) records concrete entry points and adaptation limits.

## WebUI decisions

One management homepage shows connection health, active tasks, and failures needing attention. Navigation covers Conversations, Channels, Models and executors, Runs and Trace, Eval, and Workbench. Reuse Canvas and Inspector for execution inspection.

Local setup binds the Owner, configures QQ and providers, and authorizes a work directory. Save and connection-check states remain distinct. The browser never receives stored credentials. Explicit actions start, cancel, retry, or send work.

The server supplies authorized paginated records and capability states. The UI does not infer grants, hide errors behind success labels, or expose future empty modules. Chrome acceptance covers the working flow, errors, keyboard use, and narrow and wide layouts.

## CLI decisions

The unified CLI manages service startup, diagnostics, configuration, Channels, Conversations, Runs, Trace, and Eval. Command grouping follows local management boundaries. Commands call the same local management API as WebUI. They do not keep another settings file or bypass server authorization.

The service owns configuration writes. Offline configuration access must first acquire exclusive service ownership; it must not race a running service. JSON output supports scripts, with nonzero exit status on failure. Credentials are accepted through private input or explicit credential references, not command-line arguments exposed in process listings. Pi TUI is a reference for later interactive presentation, not a second runtime or configuration system.

## Current evidence

- The repository was fast-forwarded to eda142d before preparation.
- Twenty-six upstream references are pinned locally. Preparation removed obsolete image upload fragments and unused JPG copies; working runtime and regression tests were retained.
- Vite+ runs dependency installation, fixed tests and Web builds. Full workspace quality validation remains open; scoped checks are not a complete A0 acceptance.
- Configuration, management, platform, persistence, copied model loop and CLI passed a combined run of 159 tests. Main-server integration and retained WebSocket tests passed 15 tests after authentication integration. These are separate command results, not an aggregate suite count.
- Main-server checks cover startup without a provider, retry after synchronous provider failure, exclusive data ownership, authenticated HTTP and single-use WebSocket tickets, CLI configuration projection and clean restart.
- OneBot, Run scheduling and incremental Trace are in progress. The management page has passed 36 focused tests; Chrome and unified Workbench authentication are pending. Real QQ and agy-staff execution acceptance remain pending.

Update this section when checks finish. Keep command output and detailed findings in the relevant plan finding rather than duplicating them in every document.
