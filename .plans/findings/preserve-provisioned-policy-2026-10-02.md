# Preserve explicit policy during automatic provisioning

Backend audit AUTH-01. Verified against disposable real DomainStore and fake OneBot fixtures; no live QQ, credentials or production database was used.

## Failure and boundary

Ordinary group ingress called the default grant bundle whenever run:create was not ALLOW. A revoked or approval-only tuple was therefore treated like an uninitialized member, granting new ALLOW authority without approval. Reconnect and reader-delivery backfill had the same conflation.

Initial provisioning now checks all policy history for the exact Principal/resource/action/scope tuple in the same transaction that would insert its first grant. Existing policy, including revoked rows and approval-only rows, is preserved. Explicit management grants remain able to restore authority. Content-source delivery backfill fills only never-configured tuples.

Explicit group enable restores only built-in defaults for configured members and currently bound historical dynamic-member scopes in that exact connection/bot/group, preserving thread identity. Removed/re-added Channel membership likewise restores only that membership's default policy after its explicit configuration save. Routine reconnect is not explicit re-enable. Custom historical actions, unrelated scopes, unbound and rebound identities are not restored. Explicit enable intentionally resets the built-in baseline, as the previous configured-member contract already did; it does not provide per-member block survival across that named reset.

## Regression evidence

Six initial cases failed before the fix: configured and dynamic members with revoked/approval run:create, plus revoked/approval delivery backfill. Two additional tests independently reproduced explicit reopen/re-add regressions introduced by the first repair and were fixed before publication. The focused full application/provisioning suite passes 91 tests, including database reopen, Owner A-to-B-to-A, dynamic thread scopes, custom grants, unchanged-member revocation and namespace isolation.

The three existing legacy-backfill tests previously represented a never-created grant by revoking an existing grant. They now cover both distinct states: delete only the exact row in disposable test state to simulate true historical absence and expect ALLOW after backfill; retain the original revoke setup and expect DENY after reconnect/restart. No production history is deleted and no test is removed or skipped.

## Remaining checks and limits

Full staged commit and pre-PR gates are required; their results are recorded in the PR. Real QQ remains Owner acceptance. The all-history exact-tuple query is not covered by the existing active-row-only index; measured large-history performance and a separately reviewed index migration remain follow-up work. No schema or production service changes are made here.
