# CLI source provenance

The CLI calls the same local management API as WebUI. It does not own another configuration file. This slice adapts command grouping and bounded local-client behavior from the pinned references below. It does not import their checkout directories, frameworks, or complete command implementations.

## OpenHarness

- Repository: https://github.com/HKUDS/OpenHarness
- Commit: `9b2efd795c6aa09f88b0c257d269a9e518da6ae7`
- License: MIT, preserved in [LICENSE.openharness](LICENSE.openharness)
- Original paths: `ohmo/cli.py`, `ohmo/gateway/provider_commands.py`
- Local files: `commands.ts`, `run.ts`
- Reused behavior: explicit command groups for service and configuration management; named provider profiles; separate display, configuration, and runtime actions.
- Adaptation: Python Typer commands become Node `util.parseArgs` commands. Configuration writes go through the authorized server API. Model credentials enter through bounded standard input. The CLI does not copy gateway process control, private workspace initialization, memory commands, or interactive channel setup.

## t3code

- Repository: https://github.com/pingdotgg/t3code
- Commit: `4a4c6dd2adc350a68ba18bb28b24b5a7e4660dab`
- License: MIT, preserved in [LICENSE.t3code](LICENSE.t3code)
- Original paths: `apps/server/src/cli/app.ts`, `apps/server/src/cli/config.ts`, `apps/server/src/cli/invocation.ts`
- Local files: `client.ts`, `errors.ts`, `main.ts`
- Reused behavior: local control requests have a response deadline and byte limit; configuration and bootstrap credentials are separate; command logic and process invocation stay separate.
- Adaptation: the HTTP client replaces the desktop activation socket and uses one loopback origin with a bearer credential. It rejects redirects and does not try a fallback address. Request and response bodies are bounded. Both the fetch and response body use one deadline. Error output uses an allowed code and a locally defined message instead of printing upstream payloads. Bootstrap token lookup and actual service startup remain injected application dependencies.

## Local integration

`runCli(args, dependencies)` returns an exit code without terminating the host process. `main(args, dependencies)` adds Node standard streams and bounded stdin reading. The application entrypoint supplies `resolveConnection` and `startServer`. The resolver reads the server-owned `management-token` file and the configured management origin. It must not create a token, read model credentials, or maintain another settings file.

`resolveConnection` returns `baseUrl` and `token`. `startServer` returns public startup status after the server is ready. An unwired starter or unavailable endpoint produces `NOT_AVAILABLE`. The caller sets `process.exitCode` to the returned value. A foreground server keeps its ordinary server handles active.

Successful `--json` output is `{ "ok": true, "data": ... }`. Errors are `{ "ok": false, "error": { "code": ..., "message": ... } }`. Exit code 2 means invalid arguments or channel JSON, 1 means an operation failed, and 0 means the server request succeeded. Returned Run states determine whether work or cancellation has finished.

The management client expects JSON objects or arrays. Errors use `{ "error": { "code": ..., "message": ... } }`. Model list returns `{ "profiles": [...] }`; model save returns `{ "profile": ... }`. The CLI preserves usage fields such as `inputTokens` and `tokenUsage` while omitting explicit credential fields. API credentials are never accepted as argv option values.

Pi TUI remains a future interaction reference. This command client has no dependency on a TUI runtime or another Agent framework.

## Current management commands

Channel commands use `GET /manage/channels`, `POST /manage/channels` and `POST /manage/channels/:id/connect` or `/disconnect`. `channels save` reads a complete `ChannelSaveInput` JSON object from piped stdin. It never accepts a token argument or a second configuration file path. Its local validator rejects unknown fields and credential-bearing endpoints before contacting the server; the server remains authoritative for persistence and connection permissions. Omitting `token` preserves the saved value, null clears it, and a string replaces it. Save and connect remain separate operations.

`CliDependencies.readInput` is the injectable channel input source. `main` supplies the bounded `readJsonFromStdin` implementation by default, so the application entrypoint does not need another input hook. JSON input permits newlines and has a 64 KiB limit and a 30 second deadline. Interactive terminals are rejected. API-key stdin keeps its existing single-line 16 KiB limit. Both readers reject invalid UTF-8 and remove their stream listeners after completion or failure.

`conversations list` and `runs list` use their shared management endpoints. `runs show` and `runs cancel` use `/manage/runs/:id` and `/cancel`. `trace show <run-id>` and the compatibility command `runs trace <run-id>` both use `/manage/runs/:id/trace`.

`eval run <run-id>` posts `{ "suiteId": "run-integrity-v1" }` to `/manage/runs/:id/evals`. `eval list <run-id>` reads that same endpoint. Either command can use `--run-id <id>` instead of its positional Run ID, but cannot supply both. The old global Eval sample endpoint is no longer called. If the service has not implemented the Run Eval route, its actual unavailable response remains a nonzero failure.

List and Trace commands accept `--cursor` and forward it as the only allowed query parameter. `ManagementRequest.query` is limited to `{ cursor: string }`, and only GET requests can include it. Opaque cursor values are bounded base64url characters including the Trace prefix, and the client preserves the server's `nextCursor`. IDs cannot contain query delimiters, encoded separators, dots or path traversal. The client never reconstructs domain state or substitutes a fabricated empty page for an unavailable service.

The channel integration test runs the CLI over real loopback HTTP into `ManagementApplication` and the shared configuration store. A disposable local WebSocket peer answers only synthetic OneBot login checks. No real QQ service, messages, model or installed harness is used. The test covers save, list, connect, refusal to edit an active connection, disconnect and the returned restart intent.
