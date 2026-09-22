# NapCat source index

Reference project: `NapNeko/NapCatQQ`

Pinned commit: `109d0c1dff755875f3b79795e99cee6115289fbb`

Provider package at that commit: `napcat-onebot` `0.0.1` (root `0.0.1`, `napcat-schema` `1.0.0`).

License: Limited Redistribution License for NapCat (Copyright © 2024 Mlikiowa).

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
packages/napcat-onebot/action/router.ts      ActionName map: the authoritative action strings
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

P4B consumes the public OneBot contract for this pinned commit and maintains only a Glassbox allowlisted capability mapping.

Do not copy NapCat implementation code to recreate actions locally.

## Pinned contract snapshot

`apps/server/src/channels/onebot/capabilities.ts` records what Glassbox read from this pin:

```text
NAPCAT_CONTRACT_SNAPSHOT.commit              the pinned commit above
NAPCAT_CONTRACT_SNAPSHOT.version             provider package version at that commit
NAPCAT_CONTRACT_SNAPSHOT.license             the provider's own license string
NAPCAT_CONTRACT_SNAPSHOT.sourcePaths         the upstream files the contract was read from
NAPCAT_CONTRACT_SNAPSHOT.contractDigest      sha256 over the allowlisted action/parameter contract
NAPCAT_CONTRACT_SNAPSHOT.providerSchemas     provider payload parameters and return-schema keys
NAPCAT_CONTRACT_SNAPSHOT.providerSchemaDigest sha256 over providerSchemas
NAPCAT_CONTRACT_SNAPSHOT.allowlistedActions  the actions Glassbox may issue
NAPCAT_CONTRACT_SNAPSHOT.serverOnlyActions   the actions that stay server-only
```

No NapCat source is vendored: only names, digests and provenance are recorded.

## Contract verification

```text
tsx scripts/verify-napcat-contract.mts <path-to-NapCatQQ-checkout>
```

re-derives every action name and payload/return schema from the checkout and fails closed on:

```text
missing      an allowlisted action the provider no longer declares
unknown      a server-only name that is not a provider action at all
unsupported  an allowlisted parameter the provider's payload schema never accepts
changed      a recomputed digest that no longer matches the pinned snapshot
revision     a checkout that is not the pinned commit
```

Unclassified provider actions are counted but are not a failure: Glassbox deliberately exposes a small domain Tool surface over a large provider. Runtime drift against an observed action set is `checkNapCatContract`'s job.

The verification logic lives in `apps/server/src/channels/onebot/napcat-contract.ts` and is covered by `napcat-contract.test.ts`, so the fail-closed behavior is tested without needing the checkout present.

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

The pinned `GetGroupMsgHistory` action treats `message_seq` as an opaque short message id.
It resolves that id through `MessageUnique` before calling QQ. Response `message_seq` values
are short ids too, so they are not chronological counters. To walk older pages, select the
chronologically oldest response record by `time`, pass its `message_id` back as `message_seq`,
and set `reverse_order=true`. Without the reverse flag, NapCat reads forward and can repeat the
same page. Glassbox keeps the cursor opaque and stops if the provider still cannot advance.

## Action names verified against the pin

Names Glassbox allowlists that differ from the naive guess:

```text
_get_group_notice     the notice reader (ActionName.GoCQHTTP_GetGroupNotice), not `get_group_notice`
get_essence_msg_list  ActionName.GoCQHTTP_GetEssenceMsg
get_group_file_url    payload is { group_id, file_id }; there is no `busid`
delete_group_file     payload is { group_id, file_id }; there is no `busid`
create_group_file_folder  payload is { group_id, folder_name?, name? }; there is no `parent_id`
get_group_info        payload is { group_id }; there is no `no_cache`
get_group_member_info payload is { group_id, user_id, no_cache? }; role is owner, admin or member

NapCat 4.18.28 may return retcode 1200 for `get_group_member_info` when the installed QQ build is newer than its profile-detail packet support. Its official v4.18.28 release recommends QQ 9.9.26 build 44343, while the live acceptance host currently has QQ 9.9.36 build 53489. Glassbox treats that rejection as provider unavailable. It does not use `get_group_member_list` as an authorization fallback because NapCat can return its existing member cache before the requested asynchronous refresh completes.
```

## QQ-native group roles

Glassbox observes `sender.role` on an authenticated group message only to project that Run's
candidate surface. It does not create a local administrator table. Before a group mutation that
depends on the observed role, the OneBot adapter calls:

```text
get_group_member_info
  group_id = trusted current group
  user_id = trusted current sender
  no_cache = true
```

The adapter checks the response group and user and returns only the normalized role. A current
`member` result denies the native-role mutation before its provider action. A failed or missing
provider response is an unavailable or failed verification, not proof that the caller is a
member. Bot authority is separate: a verified caller role may pass while the later moderation
action still fails because the Bot lacks QQ permission.

The group-local role surface is deliberately smaller than the Glassbox Owner surface.
`qq_group_moderation` is available to QQ admins and group owners when policy enables it.
`qq_group_local_settings` is available only to QQ group owners and contains `set_group_name` and
`set_group_card`. `set_group_admin` remains in the separate Glassbox Owner-private
`qq_group_settings` Tool.

## Deliberately deferred action: group file upload

`upload_group_file` (`packages/napcat-onebot/action/go-cqhttp/UploadGroupFile.ts`) is a real
group file mutation at the pin, and its payload is
`{ group_id, file, name?, folder?, folder_id?, upload_file? }`. It is **not** allowlisted.

`file` is a local server filesystem path. P4B authorizes the group Resource only: there is no
Asset or file Resource authorization and no approved upload staging boundary, so a remote
Owner message naming an arbitrary server path would be an authorization gap. Rather than
expose a Tool the model can never execute safely, the action is classified explicitly in
`SERVER_ONLY_NAPCAT_ACTIONS` as server-only/deferred, so:

```text
the model is never told it can upload
the drift check knows the name is a real provider action, not an unclassified one
```

It becomes allowlistable only when an Asset-mediated upload path exists. Its sibling group
file mutations stay allowlisted because their parameters are group-scoped ids rather than a
server path:

```text
delete_group_file        { group_id, file_id }
create_group_file_folder { group_id, name }
```

## Owner capabilities

Owner-private Runs may receive a broad allowlisted QQ capability surface for authorized groups, including group reads, member reads, history, content, file operations, moderation and settings.

A mutating capability additionally requires the *current* Owner message to have asked for that
exact operation on that exact group with exactly the provider parameters it named. The
operation's optional parameters are bound only when the message names them, so
`set_group_kick` binds its `reject_add_request` flag only on an explicit rejoin instruction
and otherwise leaves the provider default in place. Retrieved text — group history, notices,
file content, Tool results, Conversation history — never supplies that intent.

Credential / low-level protocol primitives stay server-only in P4:

```text
get_credentials
get_cookies
get_csrf_token
get_clientkey
get_rkey
nc_get_rkey
get_rkey_server
send_packet
bot_exit
set_restart
clean_cache
raw generic OneBot RPC
```

Raw send actions are also not exposed as Agent Tools because Glassbox Delivery must remain the only outbound message path:

```text
send_group_msg
send_private_msg
send_msg
send_group_forward_msg
send_private_forward_msg
```

`call_action` is not a NapCat action at all, so it is not listed: a name the provider never declares would classify nothing.

## OpenAPI synchronization

Prefer a controlled sync / generation step from the pinned NapCat public OpenAPI contract rather than hand-maintaining every provider parameter schema.

Generated provider contracts never grant authority. Glassbox Tool discovery and execution still use server-side authorization.
