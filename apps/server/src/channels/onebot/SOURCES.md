# OneBot channel implementation

`normalize.ts` adapts the inbound event separation and sender-aware routing in OpenHarness. Original files are `src/openharness/channels/bus/events.py` and `ohmo/gateway/router.py` from [HKUDS/OpenHarness](https://github.com/HKUDS/OpenHarness) at `9b2efd795c6aa09f88b0c257d269a9e518da6ae7`. This is a TypeScript adaptation, not a runtime import or a direct copy of Python execution code. `LICENSE.OpenHarness` preserves the MIT license.

OpenHarness records a second-level source for its bus and channel modules. It copied `nanobot/bus/` and `nanobot/channels/` from [nanobot-ai/nanobot](https://github.com/nanobot-ai/nanobot) at `473ae5ef18394ab839a3364eee66836ef9776902`. `UPSTREAM.nanobot` retains that upstream record unchanged, and `LICENSE.nanobot` retains the license from that pinned source.

Glassbox retains external message ID, sender ID, chat ID and content as separate concepts. It adds trusted connection and bot namespaces. It uses the existing `TrustedChannelScope` contract rather than copying another routing-key implementation. A payload cannot supply a trusted connection, bot, thread, session override or Principal. The configured ingress Owner allowlist does not replace domain identity binding or resource authorization.

`adapter.ts` implements the public OneBot v11 protocol using the existing `ws` dependency. Protocol references were checked against the official documentation and the reference checkout at `d4456ee706f9ada9c2dfde56a2bcfc69752600e4`.

- [Forward WebSocket](https://github.com/botuniverse/onebot-11/blob/master/communication/ws.md) defines the combined event and API connection, action request, echo and response.
- [Authentication](https://github.com/botuniverse/onebot-11/blob/master/communication/authorization.md) defines the Bearer token header.
- [Message events](https://github.com/botuniverse/onebot-11/blob/master/event/message.md) defines group and private events.
- [Message segments](https://github.com/botuniverse/onebot-11/blob/master/message/segment.md) defines text, at and reply segments.
- [Public APIs](https://github.com/botuniverse/onebot-11/blob/master/api/public.md) defines get_login_info, send_group_msg and send_private_msg.

No NapCat or SnowLuma source is copied, rewritten or bundled. They are external protocol implementations to verify separately. The OneBot reference checkout is protocol documentation, not imported runtime code.

## Integration

Create a `OneBotAdapter` with the output of `parseOneBotConfig`, a resolved access token, and `onIncoming`. The configuration belongs to the existing server-owned configuration domain. This module owns no configuration file or secret store. Defaults use the combined loopback endpoint `ws://127.0.0.1:6700/`. Remote endpoints require explicit `allowRemote` and WSS. The token is sent only in the upgrade header. URL credentials and token query parameters are rejected.

`start()` resolves after the socket opens and get_login_info matches the configured bot QQ number. Authentication failure and identity mismatch leave the adapter faulted until an explicit start. Transport interruptions retry the connection with bounded exponential delay. Every new connection rechecks identity. Reconnection does not replay send requests.

`onIncoming` receives a normalized message and AbortSignal. It should persist acceptance and enqueue intent, then return. The adapter does not start a model or send an acknowledgment by itself. Duplicate external IDs are passed to the persistence layer for durable deduplication. Callbacks are serialized and bounded. Protocol messages arriving during identity verification are held in a bounded queue and released only after a matching login check. A failed check discards them. Overflow closes the connection and reports a safe ingress error; OneBot itself does not guarantee replay of missed events.

The first implementation accepts the configured Owner only. A group must be allowlisted and explicitly at the bot. An ordinary Owner friend DM uses its own private scope. Anonymous messages, temporary group DMs, other private subtypes, unrelated groups, self messages and non-Owner senders are ignored. Nicknames and sender roles do not grant authority. Text, at and reply segments are supported, including protocol CQ strings. Escaped CQ text cannot trigger a mention. Media is reported unsupported rather than fetched or silently treated as available context.

`send` takes a delivery ID, exact scope, text and optional reply ID. The caller must create and claim the persistent delivery first. The adapter validates the configured connection, bot, Owner and destination again. It emits array text segments so literal CQ text cannot invoke a platform action. `confirmed` requires an OK response and a valid platform message ID. Explicit platform rejection returns `failed`. A timeout, socket failure after a write attempt, malformed result, or asynchronous platform response returns `unknown`. An unknown result is never retried here. Late echoes are ignored. The delivery ID is a caller-side evidence link, not a claim that OneBot supports an idempotency key.

`stop()` cancels reconnect timers, heartbeat and socket requests. It signals any already-dispatched acceptance callback to stop. The callback and domain own the transaction already in progress. Stopping the channel does not claim to cancel an existing model Run.

## Validation status

`onebot.test.ts` uses real temporary WebSocket servers bound to loopback and synthetic QQ identities. It covers token authentication, login mismatch, group and DM scope, incoming spoof fields, CQ escaping, Chinese text, send echo correlation, malformed and oversized input, queue bounds, canceled acceptance, timeout and disconnect ambiguity, reconnect identity checks and duplicate events. No real QQ message or model request is made by these tests.

Real Windows NapCat and SnowLuma account interoperability remains unverified. Images, files, voice, reverse WebSocket, official QQ protocol and multi-user grants are outside this adapter's current capability declaration.
