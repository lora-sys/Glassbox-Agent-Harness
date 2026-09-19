# Model protocol source reuse

The protocol parsers, message conversion, tool-schema conversion, partial JSON assembly, retry helper, and streaming queue are copied from [earendil-works/pi](https://github.com/earendil-works/pi) at commit `71dca871bc80b6bc97be37f0ca3189399d651fff`. The package snapshot is version 0.85.1. The original MIT license is preserved in `vendor/pi/LICENSE`.

`vendor/pi/sources.json` records each original source path, original SHA-256, copy mode, and local change. `vendor/pi/index.ts` is a Glassbox-owned local export boundary.

The included APIs are `packages/ai/src/api/openai-completions.ts`, `openai-responses.ts`, and `anthropic-messages.ts`. Their copied dependency closure contains types, message transforms, constrained sampling, response stream parsing, cost and thinking helpers, schema validation, headers, diagnostics, JSON repair, Unicode handling, estimates, hashing, streaming queues and retries. Runtime and type-only imports resolve to owned local files or these ordinary dependencies.

| Dependency        | Pinned snapshot version | Purpose                             |
| ----------------- | ----------------------- | ----------------------------------- |
| openai            | 6.40.0                  | Official OpenAI protocol client     |
| @anthropic-ai/sdk | 0.124.0                 | Official Anthropic protocol client  |
| partial-json      | 0.1.7                   | Upstream partial JSON parsing       |
| typebox           | 1.3.27                  | Upstream tool schema and validation |

The full provider catalog, global auth registry, filesystem discovery, telemetry, other vendor clients, Pi Agent framework package, and Pi TUI are excluded. Copilot headers and Anthropic OAuth client creation are removed. Remaining message conversion handles transcript compatibility; it does not discover credentials or enable another provider.

`provider.ts` is Glassbox-owned integration. It accepts an explicit profile and resolved credential. It supports API-key authentication, plus a non-secret SDK placeholder for an explicitly configured loopback endpoint without a credential slot. Remote missing credentials fail before HTTP. Options supplied through the loop cannot override credentials, headers, endpoint, environment, payload or fetch implementation. No error response bodies or diagnostic fragments are emitted to clients. Hidden reasoning stays inside the provider stream consumed by the loop and is excluded from visible events and returned conversation messages.

The copied internal usage structure retains its numeric defaults for parser compatibility. Added `reported` markers distinguish protocol measurements from defaults. `modelUsage` exposes missing measurements as null, labels totals derived from components, and does not publish invented price estimates. Protocol capability declarations do not assert that an arbitrary configured remote model has passed a live test. Resume and image input are currently false.

`provider.test.ts` uses deterministic fragmented SSE responses for all three APIs. It verifies text, tool argument assembly, measurement presence, malformed responses, HTTP errors, cancellation and host credential exclusion. Tests make no live model requests.
