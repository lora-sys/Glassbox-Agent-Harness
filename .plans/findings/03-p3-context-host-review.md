# P3 runtime Context host review

On 2026-09-18, real QQ responses exposed the local checkout name. Inspection of the installed Pi 0.85.1 SDK confirmed that `buildSystemPrompt` appends the working directory even when a custom system prompt is configured. A custom prompt alone was insufficient isolation.

The Glassbox Pi adapter now uses the public `before_agent_start` Extension event to replace the assembled system prompt with the selected Kit prompt and locked Skill bodies. It does not include the host cwd, agent directory or Skill file locations. Guarded custom tools do not activate Pi's built-in read/bash Skill injection, so selected Skill bodies are included explicitly after lock verification.

The Herdr Pi worker applies the same replacement through its final guarded-tools Extension. Missing worker prompt configuration produces a safe fixed prompt and blocks tools. Worker execution remains Pi, with product-authorized file tools.

History containment uses an explicit `Exclude Run Context` action. It appends a `context.excluded` event and prevents reuse of that exchange before its message or result content is loaded. It preserves original messages, results, deliveries and Raw Trace. Local Owner management can withdraw unsafe context across affected Runs without reading their protected contents or granting channel permissions. The operation is not exposed as a model Tool.

The stopped acceptance instance had 32 successful Pi Runs. These were excluded from future Context because the unsafe prompt construction affected that runtime generation. Local evidence is stored in `context-exclusion-evidence.json` under the isolated integration directory. A first actor-scoped exclusion attempt was denied for a scope without run-control authority; the subsequent local management action did not add grants.

Host verification:

- Actual Pi SDK with actual Kit profiles test, main-agent and qq-group passed all three checks. The local provider inspected the final system prompt and found no cwd footer, temporary directory or Skill location tag. Selected unslop content was present.
- History exclusion survived database reopen, rejected Visitor management authority, remained idempotent and preserved the original canary result.
- Actual Pi Extension loading verified the safe worker fallback prompt.
- Repository test command passed 792 tests with one opt-in integration test skipped. Focused worker and Conversation checks passed again after the fallback change.
- Server TypeScript check passed.

The real QQ service was restarted with `pi:p3-minimax` and a connected NapCat channel. Real QQ Task delegation, subsequent review/rework/accept and final delivery remain open. These checks do not establish completion of P3.
