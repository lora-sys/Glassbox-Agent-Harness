# P3 delivery host review

Reviewed 2026-09-17 in the dirty P3 worktree while AGY implements Pi integration. Recheck these paths after that assignment because shared execution code may change.

- `channels/onebot/adapter.ts:184` still requires private destination chatId to equal config.ownerId. Visitor admission exists, but a valid Visitor private reply is rejected. Require a trusted admitted sender and matching private destination; reject forged cross-recipient destinations and self delivery. Add both allowed Visitor reply and denied target substitution tests.
- `channels/onebot/config.ts:62` rejects Owner in visitorIds but allows Bot in that list. Normalize already rejects self messages. Validate the configuration consistently and cover the case.
- `delivery/gate.ts` has no production callers. Repository search found only calls in `ops/p3-closed-loop.test.ts`. Passing these tests does not establish actual delivery enforcement.
- `LifecycleStore.createDelivery` authorizes run control and fixes the destination to ingress scope, but it receives arbitrary payload text without protected resource provenance. Connect separate delivery authorization to the real claim/send path and recheck current authority before transmission. Reading or controlling a Run cannot alone authorize delivering its protected contents.
- `checkDelivery` itself accepts caller-provided resource metadata and recipient lists and allows public metadata without a grant lookup. Treat it only as a policy predicate inside a trusted service that resolves resources, current delivery grants and Audience itself. Do not expose it as the sole authorization mechanism.

Required tests include private Owner and Visitor replies, group reply, denied private-resource delivery to group, read allowed but delivery denied, grant revoke before queued send, immutable destination/payload, restart pending delivery, duplicate event and uncertain send without automatic duplicate retry. Repeat applicable cases through the actual Pi and RunService path, then through real QQ for final acceptance.
