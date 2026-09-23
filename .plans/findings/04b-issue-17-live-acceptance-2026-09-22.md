# Issue 17 live QQ acceptance, 2026-09-22

This record covers the real QQ acceptance for Issue 17. It is dated host evidence, not a
replacement for the completion gate in `.plans/04b-authorized-retrieval-history.md`.

## Test topology

- Delivery branch: `codex/issue-17-native-group-role`, stacked on PR 18 branch
  `feature/16-tool-plane-grounding`.
- Live integration checkout: Issue 17 plus current `main`, using the existing P4 test state.
- OneBot connection: `p3-qq`.
- Bot QQ: `3394947361`.
- Dedicated test group: `1126022432`.
- Glassbox Owner QQ: `3526039967`.
- Test member QQ: `3654774349`.
- Second ordinary test member QQ: `3067670134`.

The system QQ installation remains unchanged. The live runtime uses an isolated extraction of
Tencent-signed QQ 9.9.33 build 52230 with NapCat 4.18.28. The installer SHA-256 matched the
published WinGet manifest and its Authenticode signature was valid. A complete account-data
backup was taken before the runtime change.

## Runtime and provider verification

- NapCat started with its native packet backend and reported a successful native packet hook.
- NapCat listened on `127.0.0.1:6700`.
- Glassbox listened on `127.0.0.1:3030` and held an authenticated established socket to NapCat.
- Login completed once after the runtime change. Subsequent work reused that live session and did
  not refresh the QR code.
- Fresh `get_group_member_info(no_cache=true)` calls succeeded with `retcode=0` for both configured
  groups.
- In the dedicated group, the provider reported the Glassbox Owner as `owner`, the Bot as `admin`,
  and both test accounts as `member`.
- The Issue 16 read-only capability probe completed at `2026-09-22T07:15:07.589Z`. All six
  provider-backed calls succeeded: group metadata, member list, one history page, notices, essence,
  and root group files. The provider-free managed-group projection also succeeded. The probe stored
  only safe result shapes and counts.

These observations replace the earlier failed attempt against unsupported QQ 9.9.36 build 53489.
That attempt remains useful evidence for fail-closed behavior, but it is no longer the current
provider state.

## Exact-history dependency confirmation

Run `99ea6e67-b704-41cb-8159-bbb45c99bd4d` completed the dependent Issue 16 history acceptance in
the same live topology. It required and successfully called `group_history_search`, walked the
provider through four pages to `end_of_source`, and delivered exactly one bare `P4B-A-1349` record
with only sender, time, and original text. Delivery reached `sent`. The detailed retrieval evidence
is recorded in `.plans/findings/05-issue-16-live-acceptance-2026-09-22.md`.

## Policy and negative-path evidence

The Glassbox Owner enabled `group.moderate` for the dedicated group through the Owner-private Tool
path. The durable policy changed from version 1 to version 2 and records `owner` as the actor.

A later moderation request was accidentally sent in the separate real-person test group
`1121579672`. That group's policy did not enable `group.moderate`. Run
`f095bb1a-8461-4dd3-8ef1-307d9d6f8ccb` recorded the sender as the QQ group owner, excluded
`qq_group_moderation` with `policy_disabled`, and did not mute the named member. This proves the
policy gate remains independent of native QQ role. It does not replace the dedicated-group
ordinary-member acceptance.

## Native group-owner mutation and cleanup

Run `dee64c81-f5a7-46a4-a7cf-913b49aec993` was created when the Glassbox Owner account
`3526039967`, which is also the native QQ group owner, sent the exact request to mute member
`3067670134` for 60 seconds in the dedicated group. This message was intended for the ordinary
member negative-path test but came from the Owner account, so it is positive group-owner evidence
instead.

The Run bound `qq_group_moderation`, `set_group_ban`, the trusted current group, target member, and
60-second duration. Its Trace recorded the ingress role as `qq_group_owner`, then performed a fresh
provider check before mutation. The verified role remained `qq_group_owner`, the authorization
decision was `ALLOW`, the Tool result succeeded, the Run finished as `succeeded`, and delivery
reached `sent`.

The accidental test mute was immediately reversed through the authenticated OneBot connection. A
fresh `get_group_member_info(no_cache=true)` read returned `retcode=0`, role `member`, and
`shut_up_timestamp=0` for `3067670134`. The test therefore left no mute state behind.

## Ordinary-member refusal

Run `a4482a22-77a5-4f67-90e8-5971f5c739fe` was created by ordinary member `3654774349` with the
same exact 60-second mute request. Its ingress evidence recorded Principal
`qq-visitor-3654774349`, Resource `group:1126022432`, and role `qq_group_member` from the OneBot
message sender.

Both session snapshots excluded `qq_group_moderation` with `scope_not_permitted`. The selected Tool
surface contained only the configured read capabilities, history search, and Skill reading. No
moderation Tool call or native-role verification occurred. The model attempted an unrelated
`qq_group_members` call with invalid input, which failed as `input_validation_failed`; it did not
change the authorization result or produce a provider mutation. Glassbox finished the Run as
`failed` and delivered the bounded failure response.

A fresh provider read after delivery returned role `member` and `shut_up_timestamp=0` for target
`3067670134`. This proves that the ordinary member did not gain the mutation Tool and no mute was
performed.

## Owner-private capability enablement

Run `d9bb6456-07ba-431e-954b-77c23edfda6a` enabled `group.settings` for the dedicated group through
the Owner-private `owner_group_admin` path. Required evidence bound action `set_capability`, group
`1126022432`, category `group.settings`, and `enabled=true`. The Tool succeeded, policy version
advanced to 3, the Run finished as `succeeded`, and delivery reached `sent`.

The live Trace exposed a separate observability defect: the safe `owner_group_admin` Tool-call
projection retained action, group, and enabled state but omitted the allowlisted capability
category. The durable policy and required-evidence record remained correct. PR 18 now preserves
the bounded `category`, `skillName`, and `sourceClass` fields in that projection and covers them in
the regression suite.

## Provider acknowledgement and single-attempt enforcement

Run `0dc83720-50aa-4404-b2a3-18260cf8d683` sent the exact Owner-private `set_group_admin` request for
member `3654774349`. NapCat acknowledged the action, but two fresh
`get_group_member_info(no_cache=true)` reads still reported `member`. The earlier implementation
treated the acknowledgement as success even though the requested role had not changed.

Glassbox now verifies the member role after every `set_group_admin` provider acknowledgement. It
records `provider_mutation_verification` with the expected and observed bounded roles, and returns
`provider_postcondition_failed` when they differ. The focused suite covers promotion, removal, and
provider no-op behavior.

Run `571c9852-9ef9-4f6b-8c9b-e9eca0a1ed90` repeated the exact live request after that correction.
Both fresh checks still observed `qq_group_member`, so the Tool failed and the delivered response
stated that the operation was not executed. The Trace then showed the model retrying the same
mutation once within the same Run. Both provider attempts were no-ops, but a repeated write attempt
is unsafe even when the provider does nothing.

The QQ mutation boundary now consumes the current Run's exact mutation request immediately before
the first provider or durable-policy attempt. Any later Tool call using the same request fails with
`mutation_already_attempted` before another side effect. Native-role and authorization refusals do
not consume the request because no mutation attempt has occurred. A new user message creates a new
Run and may explicitly retry. Focused tests cover provider-call deduplication, a failed durable
mutation followed by a model retry, and a pre-mutation role denial followed by one permitted
attempt.

Live Run `51804c1d-1b2d-4455-9a73-b23e6ab1f0d0` exercised this correction after the fixed
service started. The model called `qq_group_settings` twice for one exact Owner-private request.
Only the first call produced `provider_mutation_verification`; its fresh read observed
`qq_group_member` instead of the requested `qq_group_admin`. The second Tool call failed before a
second provider mutation or verification. The Run ended `failed` and delivery reached `sent`.
This proves the single-attempt gate on a real QQ path while keeping the provider's no-op result
visible as failure. It does not prove successful admin promotion.

## Final authorization review before live retry

An independent source review found additional boundaries that deterministic happy paths did not
cover. The current branch now refuses model-added top-level mutation fields not bound by the
current message. Owner configuration reads require that Owner's active managed-group assignment.
The provider bridge rejects a group number that JavaScript cannot represent exactly as an integer.
Disabling the last assignment revokes grants only for that connection's location, leaving a
different connection's grants for the same group number intact. Fresh native-role verification
records `DENY` when the role mismatches or the provider cannot verify it. The history capability
and memory-source policy now change in one database transaction and one policy-version step.

These are code and deterministic-test results, not new real QQ acceptance. The remaining real
steps below still apply.

## Repository verification

After rebasing Issue 17 onto the latest PR 18 branch, the repository gate passed:

- core check: 250 files;
- unit tests: 76 files passed, 1 skipped; 1131 tests passed, 1 skipped;
- deterministic end-to-end: 62 tests passed;
- regression: 102 tests passed;
- Web build: passed.

The focused native-role suite also passed 208 tests across the OneBot adapter, management
application, capability Tools, Run adapter, and shared-group lifecycle.

## Remaining live acceptance

The following real QQ steps still require messages or role changes from the named test accounts:

1. Use Owner-private `set_group_admin` with the exact group, member, and `enable=true` values. If the
   Bot's current QQ admin role cannot perform that provider action, record provider failure
   separately from caller authorization and temporarily give the Bot the required QQ authority.
2. Confirm the promoted member's next group Run receives only the configured current-group
   moderation surface.
3. Execute one reversible 60-second mute against the second ordinary test member and inspect the
   role-verification, authorization, provider, and Tool evidence.
4. Remove the caller's native admin role outside Glassbox and confirm the next mutation is refused
   before a provider mutation.
5. Restore the native admin role and confirm the next Run regains the bounded surface.
6. Use Owner-private `set_group_admin` with `enable=false`, then confirm the member's next Run loses
   the moderation surface.
7. Restore the dedicated group policy, Bot role, caller role, and mute state to their pre-test
    values.

Do not refresh the QR code while the authenticated OneBot connection remains healthy. A QR image is
not login evidence; the established authenticated socket and successful provider calls are.

## Tool-plane diagnosis of the duplicate attempt

After PR 19 was rebased onto the Owner Tool-plane diagnostic route, a live authenticated read of
Run `51804c1d-1b2d-4455-9a73-b23e6ab1f0d0` returned a complete bounded surface with 24 selected
Tools and 11 exclusions. The latest `qq_group_settings` call was reported as `unknown`: the
existing safe failure-code classifier did not recognize `mutation_already_attempted`. The earlier
provider postcondition failure remains in Raw Trace. The classifier now preserves this fixed code
and maps it to the non-success `denied` outcome, so the next diagnostic read can distinguish the
blocked duplicate from an unclassified failure without exposing Tool text.
