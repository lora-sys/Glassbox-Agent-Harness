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

## Policy and negative-path evidence

The Glassbox Owner enabled `group.moderate` for the dedicated group through the Owner-private Tool
path. The durable policy changed from version 1 to version 2 and records `owner` as the actor.

A later moderation request was accidentally sent in the separate real-person test group
`1121579672`. That group's policy did not enable `group.moderate`. Run
`f095bb1a-8461-4dd3-8ef1-307d9d6f8ccb` recorded the sender as the QQ group owner, excluded
`qq_group_moderation` with `policy_disabled`, and did not mute the named member. This proves the
policy gate remains independent of native QQ role. It does not replace the dedicated-group
ordinary-member acceptance.

## Repository verification

After rebasing Issue 17 onto the completed PR 18 merge commit, the repository gate passed:

- core check: 250 files;
- unit tests: 76 files passed, 1 skipped; 1120 tests passed, 1 skipped;
- deterministic end-to-end: 59 tests passed;
- regression: 101 tests passed;
- Web build: passed.

The focused native-role suite also passed 208 tests across the OneBot adapter, management
application, capability Tools, Run adapter, and shared-group lifecycle.

## Remaining live acceptance

The following real QQ steps still require messages or role changes from the named test accounts:

1. Run the exact-identifier history request in the dedicated group and verify successful Tool
   evidence rather than model narration.
2. Have an ordinary member address the Bot with an exact moderation request and confirm the Tool is
   absent and no provider mutation occurs.
3. Enable `group.settings` for the dedicated group through the Owner-private control path.
4. Use Owner-private `set_group_admin` with the exact group, member, and `enable=true` values. If the
   Bot's current QQ admin role cannot perform that provider action, record provider failure
   separately from caller authorization and temporarily give the Bot the required QQ authority.
5. Confirm the promoted member's next group Run receives only the configured current-group
   moderation surface.
6. Execute one reversible 60-second mute against the second ordinary test member and inspect the
   role-verification, authorization, provider, and Tool evidence.
7. Remove the caller's native admin role outside Glassbox and confirm the next mutation is refused
   before a provider mutation.
8. Restore the native admin role and confirm the next Run regains the bounded surface.
9. Use Owner-private `set_group_admin` with `enable=false`, then confirm the member's next Run loses
   the moderation surface.
10. Restore the dedicated group policy, Bot role, caller role, and mute state to their pre-test
    values.

Do not refresh the QR code while the authenticated OneBot connection remains healthy. A QR image is
not login evidence; the established authenticated socket and successful provider calls are.
