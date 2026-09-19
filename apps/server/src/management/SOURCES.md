# Management sources

`access.ts` adapts credential comparison from `apps/server/src/auth/utils.ts` in pingdotgg/t3code, commit `4a4c6dd2adc350a68ba18bb28b24b5a7e4660dab`. The MIT license is retained as `LICENSE.t3code`.

Glassbox compares the canonical bearer token bytes, validates loopback socket and explicit Host and Origin allowlists, and persists one server-owned management key. It omits T3 cloud OAuth, DPoP, cookies, client telemetry, and environment services. Authentication only opens the local management boundary. It does not authorize QQ callers or replace domain resource authorization.

The HTTP controller is Glassbox integration code for shared CLI and WebUI configuration. Request bodies are bounded, unknown operations remain unavailable, and credential-bearing parser or internal exception details are never returned.

`runtime.ts` uses the normal dependency `proper-lockfile` 4.1.2 for exclusive service ownership, its heartbeat and crash-stale handling. This is not copied framework code. The implementation is documented in https://github.com/moxystudio/node-proper-lockfile. The service acquires ownership before opening credentials or settings and releases it after closing listeners. WebSocket access uses short-lived, single-use session-bound tickets issued by the same authenticated API.
