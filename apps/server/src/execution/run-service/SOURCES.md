# Run service source record

The implementation adapts HKUDS/OpenHarness at commit 9b2efd795c6aa09f88b0c257d269a9e518da6ae7.

| Original path           | Local use                                                                                                |
| ----------------------- | -------------------------------------------------------------------------------------------------------- |
| ohmo/gateway/bridge.py  | Session-indexed active task tracking, explicit cancellation and ingress-bound output routing in index.ts |
| ohmo/gateway/runtime.py | Conversation-specific runtime input and isolated execution session selection                             |
| ohmo/session_storage.py | Durable per-conversation history and saved provider session lookup                                       |

The original MIT license is preserved in ../../identity/LICENSE.OpenHarness. These Python mechanisms are adapted to TypeScript. No upstream runtime or channels package is imported. The upstream channels lineage is recorded in ../../identity/SOURCES.md.

Glassbox queues subsequent messages instead of implicitly cancelling prior work. SQL owns queue order, deduplication and active-run reservation. In-memory maps track only this process's execution handles. The global concurrency limit defaults to two. Context contains the current input and bounded prior completed exchanges from this exact Conversation. Provider session reuse additionally requires the same execution configuration reference. No host workspace, private memory or configuration discovery occurs here.

Execution and delivery leases record facts after a previously authorized reservation. They cannot load context, invoke tools or send messages. Revocation can prevent publication without preventing the supervisor from recording that execution or a send actually ended. Cancellation remains cancelling until an executor confirms its outcome. Unconfirmed transport failures remain unknown and never retry automatically.

Call start only after obtaining the server's exclusive data-directory ownership. Startup recovery is explicit and must only run after the supervisor has established that no old execution is still live. stop prevents new dispatch; cancelling active execution still waits for each adapter's terminal result. drain waits for this process's work, not blocked queued Runs. refresh clears authorization-blocked queue entries after an explicit policy/configuration change.

waitForRun registers a terminal-event observer before checking the current persisted state. Each observation reads through the caller's current authorization. Aborting the wait does not cancel the Run. Terminal completion, access denial, observer abort and service shutdown remove the subscription.

publishControlReply sends fixed status or cancellation replies independently of the execution queue. Its destination is the caller's existing scope. It persists control:messageId before transport invocation, reuses the original payload on duplicate commands, and never automatically resends sent, failed or unknown outcomes. It creates no new Run or model input.
