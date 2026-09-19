# Persistence source record

The SQL statement arrays, transactional batch writes, conflict handling, per-session indexes, and explicit row-to-domain mapping are adapted from the following MIT sources. Glassbox uses its own domain schema and local configuration.

| Repository | Commit | Original path | Local use |
| --- | --- | --- | --- |
| joyehuang/trajectory-panel | ef3ac78f48523d0902e71bca896eae28e2324fe6 | daemon/lib/db.js | schema.ts, database.ts, evidence.ts and conversation writes adapt schema arrays, batch transactions and upserts |
| joyehuang/trajectory-panel | ef3ac78f48523d0902e71bca896eae28e2324fe6 | api/_lib/db.js | Explicit typed row mapping in evidence.ts and conversation/store.ts |

The original MIT license is preserved in LICENSE.trajectory-panel. The upstream package declares @libsql/client ^0.17.4. Glassbox imports only the normal database driver, never the reference checkout.

Local changes include explicit local file configuration, a transaction queue, transactional versioned migrations, enforced foreign keys, caller scope checks before payload reads, durable ingress deduplication, queued Run intent, guarded state transitions, and delivery uncertainty. Missing usage stays null. Database cursors refer to external append-only trace; they are not a replacement for raw trace. There is no implicit cloud sync, environment credential loading, or model SQL interface.

## Integration contract

`openDomainStore` in index.ts opens an explicitly selected local path or `:memory:`. Call and await close before removing temporary state. No default user directory is selected.

The trusted management boundary calls createAgent, bindOwner or bindPrincipal, registerResource, grant, revoke and approve. None of these methods is a chat command or an authentication implementation. Incoming adapters must only supply validated, authenticated transport identity fields.

Grants use an exact Principal, Resource, Action and full channel scope. Agent grants use `agentResourceId`. The actions used by this slice are run:create, conversation:read, run:control, trace:write and eval:write. Binding an identity does not create any grant. Other resources and protected Tools use their own resource IDs and actions.

acceptIncoming requires run:create. A duplicate message returns the original Run after checking conversation:read. It never dispatches execution. Message persistence and queued Run intent commit together. Conversation and Run reads require a verified CallerContext and enforce the complete scope again. Rebinding a channel identity does not transfer old conversations.

transitionRun enters running only for the first queued Run while that Conversation has no active Run. Call it before starting the executor. Cancellation requires the executor to confirm stopping before recording cancelled. Terminal Runs cannot restart in place. An explicit new message can create a new Run. Provider Session identifiers are unique per provider across Conversations.

createDelivery persists an explicit destination that must match the Run's authorized ingress scope, plus immutable payloadText and payloadKind. The text limit is 64,000 characters. A repeated deduplication key with different text or kind is rejected. Retry sends the persisted payload instead of reconstructing it from a newer Run or UI state. Payload text never enters authorization reason fields. Reserve the delivery with pending to sending before transport invocation. Record sent only after confirmation. Record unknown when the send outcome cannot be established. Only an explicit failed to pending transition permits a retry. Recovery changes sending to unknown and does not resend.

recover is a trusted startup operation. It changes running to interrupted and cancelling to unknown, preserves queued Runs, and returns changed IDs for raw trace recording. It does not test whether a detached external process is still alive. The executor supervisor owns that check before deciding whether recovery should run.

advanceTrace runs after indexing complete external records and advances byte and event cursors monotonically. recordEval requires an existing Run and an indexed trace range. Trace and Eval reads enforce the same caller scope as Conversation reads. Fixed denial reasons never contain rejected resource contents or SQL error text.

withAuthorizedResource commits the current decision and any approval consumption before invoking an external loader or Tool. A timeout cannot roll back consumption and permit a second side effect. The wrapper must be used again for every protected operation. It is not a long-lived permission token.

## Validation boundary

foundation.test.ts uses real local libSQL with disposable state. It covers identity spoofing, default deny, private group isolation, revocation, approval replay, concurrent ingress, complete routing scope, Provider Session isolation, Run controls, reopen and recovery, bounded pagination, foreign keys, delivery uncertainty, and linked Eval evidence. No QQ account, live model, or personal state is used.
