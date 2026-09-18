# P3 Ops host review

Reviewed 2026-09-17 against the current dirty P3 worktree. These are open findings, not completed acceptance. The concurrent AGY assignment covers Pi integration and does not modify Ops implementation.

## Required fixes before real worker acceptance

- `apps/server/src/ops/service.ts:28` authorizes a global status action then returns every Task and AttentionItem. Filter resources for the current Principal before loading protected descriptions or worker output. Test two Principals with separate Tasks.
- `apps/server/src/ops/service.ts:61` creates read, prompt, accept, rework and cancel grants as a side effect of delegation. Delegation permission must not manufacture independent permissions. Apply explicit trusted policy and bound delegated capabilities to caller capabilities. Test a delegate-only caller cannot accept or read a worker without those grants.
- `apps/server/src/ops/service.ts:115` reuses the same pane for a new TaskAttempt. A delayed old done event can target the new attempt because observation matches session/workspace/pane without execution generation. Use an identifiable fresh execution binding and reject replaced or stale occupants. Preserve prior attempt evidence.
- `apps/server/src/ops/reconciler.ts:73` only visits panes present in a snapshot. Missing or replaced workers remain apparently current. Reconcile durable active bindings against the complete snapshot and represent missing observations as unknown, without silently accepting or failing Tasks.
- `apps/server/src/ops/reconciler.ts:86` creates an attention item on disconnect but does not invalidate observed bindings or repeat acknowledged subscription and snapshot reconciliation. Add deterministic disconnect/reconnect coverage and deduplicate connection attention.
- `apps/server/src/ops/reconciler.ts:68` copies arbitrary error messages into attention summaries. Use bounded diagnostic codes and protected evidence references instead of possible worker payloads.
- `TaskStore.appendTraceTx` calls `trace.append` before the SQL insert or transaction commit. A failing insert or later rollback leaves an in-memory event for a product change that did not commit. Its returned sequence also comes from a fresh process-local counter instead of durable SQL sequence. Test injected rollback and reopen with an existing event sequence.
- `TaskStore.reworkTask` overwrites the previous attempt `result_summary` with the rework reason and resets `completed_at`. `acceptTask` overwrites the accepted attempt result with a generic reviewer message. Preserve the worker result and completion observation as evidence; record review reason and accepted result references separately. Test that prior result evidence is unchanged through rework and acceptance.

## Socket protocol review

- Installed Herdr protocol schema saved in the local temporary `herdr-p3-schema.json` defines subscription messages with required `event` and `data`. `event` is a string enum such as `pane.agent_status_changed`; its data object has no required `type`. `SocketHerdrBridge.mapEvent` ignores a string `message.event`, reads `data.type`, and compares snake-case variants. Real subscribed lifecycle messages can therefore be discarded. Add fixtures from the installed schema and test the exact envelope, not a bridge-shaped fake.
- Subscription JSON parsing has no exception boundary. Malformed frames can escape the socket callback. Acknowledgement handling accepts the first non-error JSON frame without matching the request ID or validating the result.
- Subscription acknowledgement timeout rejects without destroying its socket. Both error and close can emit disconnect for one failure. Early close before acknowledgement is not handled immediately. Add single-settlement cleanup and intentional-unsubscribe behavior.
- Request parsing lacks response-ID validation and a frame-size bound. Peer close before response only resolves through timeout. Reject malformed and mismatched replies explicitly.
- `startAgent` selects any idle or unknown pane in the requested workspace. It does not establish exclusive ownership of that execution slot. The optional branch argument does not create or validate a Git worktree. Real delegation must create or verify an isolated disposable execution location through the supported protocol.

## Acceptance evidence still required

Prove scoped status/read/prompt, bounded delegation, subscription-before-snapshot, worker replacement/disappearance, delayed old-attempt events, rework with a new attempt, explicit accept, restart/reopen and real supported coding Agent execution in a disposable Herdr session and repository. A ping and empty snapshot do not prove these requirements.
