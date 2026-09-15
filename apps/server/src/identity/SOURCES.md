# Identity source record

scope.ts adapts the session routing mechanism in HKUDS/OpenHarness at commit 9b2efd795c6aa09f88b0c257d269a9e518da6ae7, original path ohmo/gateway/router.py. The original MIT license is preserved in LICENSE.OpenHarness.

The upstream isolates shared chats by sender and optional thread. Glassbox preserves those dimensions, adds connection and bot account, always includes private-chat sender identity, and serializes a JSON tuple so separators cannot collide. Glassbox accepts no session key override and no nickname or message-text identity assertion. Identity binding is a separate trusted management operation and grants no authority.

router.py imports the upstream channels event type. Its provenance file src/openharness/channels/UPSTREAM records the following source lineage. No bus or channel implementation source is copied by this slice.

```text
repo: https://github.com/nanobot-ai/nanobot
commit: 473ae5ef18394ab839a3364eee66836ef9776902
synced: 2026-04-05T00:00:00Z
paths:
  nanobot/bus/     -> src/openharness/channels/bus/
  nanobot/channels/ -> src/openharness/channels/impl/
```

service.ts is Glassbox-specific binding and identity resolution. It imports no upstream runtime.
