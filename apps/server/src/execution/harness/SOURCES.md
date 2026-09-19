# Installed harness execution

The implemented adapter is Claude Code through the existing Anthropic Agent SDK dependency. Glassbox always supplies the host-selected installed executable. It never chooses the SDK bundled executable and never installs a CLI. No production module imports an upstream checkout.

## Source provenance

Repository: https://github.com/pingdotgg/t3code

Pinned commit: `4a4c6dd2adc350a68ba18bb28b24b5a7e4660dab`

License: MIT, copyright 2026 T3 Tools Inc. The complete license is preserved in `LICENSE.t3code`.

Inspected original paths:

- `apps/server/src/provider/Drivers/ClaudeHome.ts`
- `apps/server/src/provider/Drivers/ClaudeExecutable.ts`
- `apps/server/src/provider/Drivers/CodexHomeLayout.ts`
- `apps/server/src/provider/Layers/CodexSessionRuntime.ts`
- `apps/server/src/provider/Layers/codexLaunchArgs.ts`
- `packages/effect-codex-app-server/src/_generated/schema.gen.ts`

The home-selection and continuation-identity mechanism is adapted in `layout.ts` and `environment.ts`. The current owned `platform/executable.ts` contains the separately attributed Windows executable and npm shim resolution adaptation. This module imports that owned helper. `process.ts` preserves explicit executable selection and argument-array spawning without a shell.

Local changes enforce Glassbox boundaries. The adapter replaces the entire environment, creates fresh homes and configuration roots, and binds directories to Agent, Principal, Conversation, channel scope, execution reference and Run. It does not copy t3code's inherited HOME or broad environment spreading. It does not copy Codex auth overlays or their shared skills, plugins, sessions and cache symlinks.

## Verified SDK interface

Installed `@anthropic-ai/claude-agent-sdk` version `0.3.251`, `sdk.d.ts` and the local `sdk.mjs` launcher were inspected. The SDK is an ordinary dependency, not vendored framework source.

The adapter supplies `pathToClaudeCodeExecutable`, `tools: []`, `skills: []`, `settingSources: []`, `strictMcpConfig: true`, explicit MCP servers, `permissionMode: "dontAsk"`, a custom system prompt and an entirely replaced `env`. Settings disable hooks, auto-memory, bundled skills, Agent View, Remote Control, Workflows and artifacts. A real SDK test launches a disposable Node protocol process and verifies the transmitted CLI flags and environment. It makes no model request.

The SDK recognizes `.js` and `.mjs` launch paths as scripts. Its native/script distinction does not include `.cjs`, which the disposable fixture originally exposed. The fixture now uses the SDK-supported `.js` entry form. Windows native and resolved npm entries remain supported by the owned executable resolver.

## Integration contract

`createClaudeHarnessAdapter(options)` implements the existing `RunExecutionAdapter`. Required options are a trusted `dataDirectory`, an `executionRef`, an explicit installed `executablePath` and an async `credentials(input)` resolver. The resolver must authorize the selected credential for the caller. It returns exactly one of `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` or `CLAUDE_CODE_OAUTH_TOKEN`. Other fields and ambiguous credential choices fail closed. The adapter never loads a user's credential files itself.

Optional settings include the API base URL, model, trusted system prompt, limits, protected tools and an event sink. Only explicit SystemRoot information is taken from `hostEnvironment`. HOME, USERPROFILE, config, cache, data and temporary paths point inside the trusted data root. Stderr and arbitrary SDK errors are not published.

`supportsGroup` defaults to false. The host may supply `groupIsolation` only after separately validating the installed binary, machine policy and selected tool mode. The attestation contains the executable SHA-256 and either `none` or `protected-mcp`; the hash is checked before each execution. A changed executable or contradictory init tool, skill, plugin, agent, MCP, cwd or permission configuration fails closed. The hash is not an OS sandbox and does not prove that machine policy has stayed unchanged. Host policy changes require fresh validation.

Optional `ProtectedHarnessTool` definitions expose only named in-process MCP tools. Each definition supplies an input schema, current authorization checks for `execute` and `publish-result`, and an implementation that confines resources to its authorized workspace and honors AbortSignal. The wrapper checks execution authority before invoking the implementation and checks result visibility afterwards. No built-in Bash, Read, Write or other unrestricted tool is enabled as a fallback. File confinement and specific filesystem tools remain separate implementation work.

Events contain Run IDs, bounded visible text, named tool lifecycle states and safe terminal codes. Tool arguments, tool results, credentials, thinking blocks, raw init data and raw provider exceptions are excluded from events. The host must persist these events under the Run's authorized Trace boundary. Usage comes from SDK `modelUsage` and is an estimate. Absent or invalid usage is null.

Provider sessions are not resumed or returned. `persistSession` is false. Every Run receives only the current authorized history supplied by RunService and has a fresh workspace and home. Reopening the service does not load an old provider transcript. This deliberately avoids stale permissions surviving through provider session history.

Cancellation closes the SDK query, waits for the actual child exit and for in-process tool work to settle, and escalates process termination on a bounded deadline. Receiving abort or a successful kill call is not cancellation evidence. An unconfirmed exit or unfinished tool returns `unknown`. Timeout with confirmed termination returns `interrupted`. The service must not retry an unknown outcome automatically. An unknown outcome keeps that Conversation locked in the adapter instance because its work may still be running. Replacing the adapter is not evidence that the previous process stopped; the host must resolve that outcome before allowing another execution.

## Unfinished verification

Real installed Claude Code, its credentials and Windows isolation still require host acceptance. Tests use synthetic contexts, fake SDK events, disposable Node children and a local protocol fixture. They never invoke a real model, send QQ messages or write Personal Agent state.

Codex is not implemented in this new Run adapter slice. The inspected app-server schema exposes sandbox, approval, cwd and configuration settings, but did not establish a complete tools-off and implicit-context-off boundary. The existing Owner Workbench Codex integration is retained elsewhere. `CODEX_RUN_CAPABILITY` reports this unfinished state; it is not a substitute execution adapter and does not mark the product's Codex requirement complete. Owner Run integration, protected tools and platform sandbox verification remain required work.

No OS sandbox or protection against another process running with the same operating-system identity is claimed. The data directory must be private and host-owned. Its descendants are checked for links before use, but this is not protection against a concurrent privileged filesystem attacker.
