# NapCat source index

Reference project: `NapNeko/NapCatQQ`

License: Limited Redistribution License.

Glassbox treats NapCat as an external QQ / OneBot runtime. Do not vendor NapCat source code into Glassbox.

## P4 use

P4 reuses NapCat's mature QQ capability surface through the existing authenticated OneBot connection.

NapCat's action layer already carries:

```text
actionName
payloadSchema
returnSchema
actionSummary
actionDescription
actionTags
```

and the project generates OpenAPI from those action definitions.

Relevant upstream locations:

```text
packages/napcat-onebot/action/index.ts
packages/napcat-onebot/action/OneBotAction.ts
packages/napcat-onebot/action/schemas.ts
packages/napcat-schema/index.ts
```

Important action families:

```text
group/
msg/
file/
user/
system/
go-cqhttp/
extends/
```

P4B should consume the public OneBot / generated OpenAPI contract for a pinned NapCat version and maintain only a Glassbox allowlisted capability mapping.

Do not copy NapCat implementation code to recreate actions locally.

## Capability pattern

Use:

```text
NapCat Action
→ Glassbox QQ Capability Registry
→ category / risk / Glassbox Action / Resource resolver
→ protected domain Tool
→ Pi
```

Do not expose every NapCat action as a permanent model Tool.

Do not expose a raw generic OneBot RPC Tool.

## P4 history

Use the existing NapCat action:

```text
get_group_msg_history
```

through the current OneBot connection.

Group history remains a protected source and is authorized before retrieval.

## Owner capabilities

Owner-private Runs may receive a broad allowlisted QQ capability surface for authorized groups, including group reads, member reads, history, content, file operations, moderation and settings.

Credential / low-level protocol primitives stay server-only in P4:

```text
get_credentials
get_cookies
get_csrf
get_clientkey
get_rkey / get_rkey_ex
send_packet
bot_exit
raw generic OneBot RPC
```

Raw send actions are also not exposed as Agent Tools because Glassbox Delivery must remain the only outbound message path.

## OpenAPI synchronization

Prefer a controlled sync / generation step from the pinned NapCat public OpenAPI contract rather than hand-maintaining every provider parameter schema.

Generated provider contracts never grant authority. Glassbox Tool discovery and execution still use server-side authorization.
