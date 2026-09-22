# Issue 17 live QQ acceptance, 2026-09-22

This record covers the real QQ attempt for Issue 17. It is evidence from one host and one dated
attempt, not a replacement for the completion gate in `.plans/04b-authorized-retrieval-history.md`.

## Test topology

- Glassbox branch: `codex/issue-17-native-group-role`, stacked on
  `feature/16-tool-plane-grounding` while PR 18 remains open.
- Live-only integration checkout: Issue 17 plus current `origin/main`, so the existing Memory
  acceptance state remained available during QQ testing.
- OneBot connection: `p3-qq`.
- Bot QQ: `3394947361`.
- Dedicated test group: `1126022432`.
- Glassbox Owner QQ: `3526039967`.
- Test member QQ: `3654774349`.

The service reused the existing QQ quick-login state. This attempt did not generate a QR code or
ask the Owner to scan again.

## Verified before live mutation

- Herdr, NapCat, and Glassbox were running.
- Glassbox listened on `127.0.0.1:3030`.
- NapCat listened on `127.0.0.1:6700` and had an established authenticated Glassbox socket.
- NapCat reported both configured groups in `get_group_list`.
- The dedicated group reported four members.
- Before the attempted role change, the Bot was a native QQ `member`, not an administrator.
- The dedicated group policy did not enable `group.moderate`.
- No new Owner private command entered Glassbox during the observation window, so the policy did
  not change.

The repository gate passed after the Issue 17 implementation and the provider-failure regression:

- core check: 239 files;
- unit tests: 73 files passed, 1 skipped; 1093 tests passed, 1 skipped;
- deterministic end-to-end: 58 tests passed;
- regression: 101 tests passed;
- Web build: passed.

## Provider incompatibility found

NapCat 4.18.28 logged that its packet backend does not support the installed QQ
`9.9.36-53489-x64`. Its official v4.18.28 release recommends QQ 9.9.26 build 44343.

Fresh `get_group_member_info` calls with `no_cache=true` returned `retcode=1200` for the Bot in
both configured groups. Repeating the read after a Glassbox-only restart produced the same result.
Glassbox therefore reports provider failure and blocks the mutation. It does not turn this into a
caller authorization denial.

`get_group_member_list` is not an authorization fallback. Inspection of the bundled NapCat 4.18.28
implementation showed that when a member cache already exists, the action can return that cache
before its requested refresh finishes. A stale administrator record would violate Issue 17's
execution-time re-verification rule. The adapter therefore continues to require the narrow fresh
member read and fails closed when it is unavailable.

## Acceptance state

The deterministic suite covers the Issue 17 role, scope, policy, intent, restart, demotion,
provider-failure, and Owner-private `set_group_admin` cases. Real QQ acceptance is not complete.
The following live items remain:

1. Run with a NapCat-compatible QQ build without discarding the existing quick-login state when
   possible.
2. Confirm `get_group_member_info(no_cache=true)` returns the exact group, user, and role.
3. Make the Bot an administrator in the dedicated group through the QQ client.
4. Enable `group.moderate` through the Glassbox Owner private control path.
5. Confirm an ordinary member does not discover moderation Tools.
6. Promote the test member to QQ administrator and confirm the next addressed group Run discovers
   only the configured current-group moderation surface.
7. Execute one reversible 60-second mute against the dedicated test member and inspect the Trace.
8. Remove the caller's QQ administrator role outside Glassbox and confirm the next mutation is
   denied before the provider action by fresh role verification.
9. Restore the caller's QQ administrator role and confirm the next Run regains the bounded surface.
10. Exercise Owner-private `set_group_admin` with exact group, user, and enable values in both
    directions, then confirm those changes affect the next group Run without creating local role
    truth.
11. Separately confirm insufficient Bot authority is reported as provider failure.
12. Restore the dedicated group policy, Bot role, caller role, and mute state to their pre-test
    values.

Do not downgrade QQ, restart NapCat, or trigger a new login merely to finish this checklist without
the Owner's explicit approval. Those operations may invalidate the cached login and cause another
QR scan, which this acceptance attempt intentionally avoided.
