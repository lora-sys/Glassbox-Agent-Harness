# S6 Plan — Mid-run steering implementation

## New endpoints

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/pause` | Interrupt active turn by sessionId, record `action.pause`, keep session |
| POST | `/steer` | Send instruction to existing session (same thread, new turn), record `action.steer` |

The existing `/stop` endpoint closes the session; `/pause` keeps it open for `/steer`.

## Trace action-record format

Trace entries are appended by `RawTraceStore` and streamed via WS. The schema is stable.

### action.pause (appended after turn/completed)

```jsonc
{
  "seq": N,
  "ts": "ISO-8601 timestamp",
  "event": {
    "method": "action.pause",
    "params": {
      "kind": "action.pause",         // discriminator
      "source": "glassbox-user",      // who initiated
      "sessionId": "<uuid>",          // Glassbox session
      "threadId": "<uuid>",          // provider thread (unchanged)
      "turnId": "<uuid>",            // provider turn UUID (just interrupted)
      "turnStatus": "interrupted",    // final status of the interrupted turn
      "ts": "ISO-8601 timestamp"
    }
  },
  "provenance": "codex-app-server"
}
```

### action.steer (appended after turn 2 providers events)

```jsonc
{
  "seq": N,
  "ts": "ISO-8601 timestamp",
  "event": {
    "method": "action.steer",
    "params": {
      "kind": "action.steer",
      "source": "glassbox-user",
      "sessionId": "<uuid>",
      "threadId": "<uuid>",          // SAME threadId as turn 1
      "turnId": "<uuid>",            // provider turn UUID for the new turn
      "instruction": "now say goodbye",
      "ts": "ISO-8601 timestamp"
    }
  },
  "provenance": "codex-app-server"
}
```

Distinguished from provider events by:
- `method` starting with `action.` (never emitted by provider)
- Stored via `RawTraceStore.append()` — append-only, never overwrites
- Reducer cases `actionPause`/`actionSteer` count in traceSummary only

## Trace order (live, same thread)

```
provider turn-1 events → action.pause → provider turn-2 events → action.steer
```

No new thread spawned for the steered turn. `DerivedState.turns[]` grows monotonically.

## Pending-approval finding

**Can `turn/interrupt` be triggered while a provider approval request is pending?**

The readOnly sandbox (`{ type: "readOnly", networkAccess: false }`, cwd `/tmp/glassbox-t2.2`) consistently produces a single code path: no write operations, no network. A `say ready` style turn triggers only string generation — no ApprovalRequest events appear in the trace. The codex binary hosts its own approval machinery internally, but a read-only string turn has no artifacts to touch and no egress to review, so it never reaches that machinery.

To intentionally produce an approval request you'd need either (a) a writable sandbox so the run modifies files requiring user consent, or (b) a tool invocation the binary would require confirmation for. In the current readOnly-only test setup, `turn/interrupt` while approval is pending cannot be produced. Streaming it as code would require a major test-environment expansion outside S6 scope.

## Conclusions

- `turn/interrupt` cleanly disposes the active turn and emits turn/completed status "interrupted"
- The adapter's `_collectHandler` is reset by `collectTurnEvents`, so after a turn ends the adapter resets `_collectHandler = null` (line 316) — handleSingleEvent chains correctly because each `startNewTurn` re-registers
- Action records never modify provider trace lines — they are in a distinct branch from the original trace

## Pending step

2. Try `/steer` with action.util.turnId backfill
