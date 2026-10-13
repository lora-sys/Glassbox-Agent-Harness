# Agent loop source reuse

`vendor/agent-loop.ts` and `vendor/types.ts` are copied from [earendil-works/pi](https://github.com/earendil-works/pi) at commit `71dca871bc80b6bc97be37f0ca3189399d651fff`, package version 0.85.1, under MIT. Their original paths are `packages/agent/src/agent-loop.ts` and `packages/agent/src/types.ts`. The original license is retained in `vendor/LICENSE`.

The loop preserves upstream message lifecycle, sequential and parallel tool execution mechanics, argument validation, incomplete-output tool rejection, cancellation propagation and turn-end hooks. Internal Pi package imports resolve to the locally copied model module. `runAgentLoop` and `runAgentLoopContinue` require an explicit stream function; the module-global default fallback is not part of this runtime. Tool exceptions become a generic message before reaching model context, rather than including an arbitrary exception payload.

`index.ts` is the Glassbox invocation boundary. It calls `runAgentLoop` directly so asynchronous failures settle the invocation instead of leaving an event iterator waiting. Each call supplies an authorized context, explicit provider, explicit tools, cancellation signal, turn budget and tool budget. There are no implicit filesystem or shell tools, provider catalogs, credential stores, default home directories or replayed side effects.

The wrapper executes tools sequentially. Each protected operation checks current authorization immediately before execution and again before releasing the result. The surrounding domain owns policy, identity, resource grants, authorized context assembly, result projection and evidence persistence. A Tool returning true must implement that domain decision; this module does not infer authority from a tool name.

Visible events contain text deltas, safe tool status, measurements and lifecycle. They exclude tool arguments, raw result payloads, credentials, provider diagnostic fragments and hidden reasoning. Returned messages contain only the new authorized transcript messages, so the caller owns durable conversation history. This is a bounded execution loop, not durable task orchestration or native provider resume.

`model-agent.test.ts` exercises actual copied provider parsing and loop behavior using deterministic synthetic SSE, including authorized execution, denied calls, revoked result access, invalid schemas, tool failures, turn and tool limits, absence of default tools, and cancellation that waits for the active tool to settle.
