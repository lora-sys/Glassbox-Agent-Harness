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
provider postcondition failure remains in Raw Trace. This historical Run still reports `unknown`,
because Raw Trace is immutable and already records the second error as `tool_execution_failed`.
The classifier now preserves `mutation_already_attempted` and maps it to the non-success `denied`
outcome for new Runs. A new real duplicate-attempt Run is required to verify that end to end.

## Follow-up read-only acceptance, 2026-09-23

The PR 19 service remained connected to the existing `p3-qq` NapCat session. No QR refresh,
login, group-role change, mute, or other group mutation was performed.

The authenticated `capabilities probe` was run against both configured groups:

| Group | Observed at | Paths | Provider-backed | Provider successes | Provider failures / unavailable / unknown |
| --- | --- | ---: | ---: | ---: | ---: |
| `1126022432` | `2026-09-23T06:30:52.166Z` | 7 | 6 | 6 | 0 / 0 / 0 |
| `1121579672` | `2026-09-23T06:31:05.306Z` | 7 | 6 | 6 | 0 / 0 / 0 |

Each probe covered managed-group projection, group metadata, member-list read, group history,
notices, essence messages, and root group files. Provider results were recorded as safe shapes
and counts only. The group-content result arrays were empty at the time of the probe; this does
not imply that no such content has ever existed. These probes confirm the current read-only
provider paths in both scopes. They do not prove native-admin discovery or mutation behavior.

The focused authorization and execution regression set was rerun on the PR 19 checkout:
8 files passed, 211 tests passed. The service process was confirmed to run from that checkout.

The user explicitly declined group-owner transfer testing. It was not attempted. Real QQ admin
caller discovery, successful admin-scoped moderation, role revocation and restoration, and a
successful `set_group_admin` postcondition remain unverified. They require a native QQ admin test
account to send the group request and, for the `set_group_admin` success path, a provider action
that changes the target's actual role. Do not substitute group-owner transfer for those checks.

## Payload-free Owner role audit view

An Owner-local `trace group-role-audit <channel-id> <group-id>` command and
`GET /manage/group-role-audit` route inspect the newest Owner Run and Visitor Run separately in a managed group without
relaxing the ordinary same-Principal `conversation:read` rule. The route requires a current
Owner `group:manage` grant, matches the configured connection and Bot, and returns only the
principal kind, normalized role, verification, allowlisted Tool-surface, outcome, and bounded
Trace-completeness metadata.
It excludes message bodies, Tool arguments/results, provider error text, member identifiers, and
Conversation scope. The route rechecks the group grant after reading Trace evidence. It passed
180 focused tests, 1162 unit tests, 69 deterministic end-to-end tests, 103 regression tests,
core lint/type checks, formatting, and the Web build. Static isolated review found no actionable
issue.

## Payload-free live role audit, 2026-09-23

After loading the audit route into the running Glassbox process, the managed-group view returned
separate latest Owner and Visitor projections. The Owner Run showed an ingress QQ admin role, a
fresh verified QQ admin role, `ALLOW` for `qq_group_moderation` / `set_group_ban`, a successful
Tool outcome, a succeeded Run, and sent delivery. The Trace page was complete at 19 of 200
records. This confirms that this Owner Run passed the role and authorization gates and the
provider call returned success. It does not establish the result for a Visitor Principal or an
independent provider postcondition.

The latest Visitor Run in the group is older. It showed `qq_group_member`, all three group-role
Tools excluded, no role verification, and no Tool calls. The reply was delivered even though the
Run status was failed. This is evidence for the ordinary-member read-only boundary, not evidence
for the current admin test account.

Still missing from real acceptance are a QQ admin who is not the Glassbox Owner receiving and
using the bounded surface, external role revoke and restore affecting the next mutation, the
Owner-private `set_group_admin` enable/disable paths with a named disposable test member, and a
real Bot-provider permission failure distinct from caller denial. No group-owner transfer was
attempted. Do not perform admin assignment or other QQ mutation without an exact test member and
an explicit user-approved action.

## Restarted queued Run role boundary

Code review found that a queued group Run could survive restart with its immutable ingress role
observation. Before this correction, the Run dispatcher also passed that old observation into
candidate Tool discovery, so an admin Tool could reappear after restart even though execution
would still perform fresh QQ role verification before any mutation.

The dispatcher now keeps the stored Run scope and Raw Trace unchanged, but omits a persisted
non-member role observation from the execution caller for queued group Runs present at any service
start, including `start()` without recovery mode. Only a new OneBot message can supply a fresh role
observation. A focused regression verifies that the resumed execution receives no stale role, the
stored Run retains the original observation for historical reconstruction, and a later member
message carries its current member observation.
This closes the stale candidate-surface window; real QQ acceptance remains outstanding.

## Post-restart QQ read-only probe, 2026-09-23

After restarting only the Glassbox process on the PR 19 worktree, `agent:status` reported Herdr,
NapCat, and Glassbox running. Their PIDs were 45524, 48832, and 46216 respectively. Ports 6700 and
3030 were listening. The NapCat process was not restarted, so no QR or re-login was needed.

The dedicated test-group probe at `2026-09-23T10:00:55.970Z` completed all seven observations.
Six QQ-provider reads succeeded for group metadata, member list, history, notices, essence messages,
and root files. There were no provider failures, unavailable results, denials, or unknown outcomes.
Notice and essence results were valid empty arrays. This confirms the read-only bridge after the
Glassbox restart; it does not prove Visitor admin discovery or mutation behavior.

## Payload-free group ingress diagnostics, 2026-09-23

During the next requested Visitor-admin test, the role audit still showed no Run newer than the
existing 16:33 Owner Run. The current NapCat log for the dedicated test group also had no later
group event. The WebSocket `connected` state therefore did not prove that QQ had delivered the
test message to Glassbox. The application had not connected `OneBotAdapter.onIngressError`, and
normal group messages without a recognized Bot mention were silently ignored by normalization.

The adapter now emits only configured group ID, a fixed ingress stage, and a fixed reason code.
The Owner-authorized group role audit adds in-memory counters since the current Glassbox process
started for normalized group events, missing Bot mentions, empty messages, malformed or unsupported
messages, queue overflow, and acceptance failures. It stores no message text, sender ID, or message
ID, and the counters reset on service restart. A focused adapter test verifies the missing-mention
diagnostic contains none of those payload fields. Focused OneBot and management tests passed 111
cases, and core lint/type checks passed across 254 files.

This does not establish why the prior test message was absent. A new Run or diagnostic delta is
still required to complete real Visitor-admin acceptance. No group-owner transfer or group
mutation was attempted.

## Owner QQ group-owner read-only question, 2026-09-23

The next group @ produced Owner Run `1ade2f47-c52b-4364-8118-2d0a574ba32e` at
`2026-09-23T10:21:30.847Z`. Its Trace was complete at 184 records and delivery succeeded. The
ingress principal was the Glassbox Owner, and the QQ-native role was `qq_group_owner`. The selected
current-group surface included moderation and local settings; `qq_group_settings` remained
excluded. There were no `tool_call` or `tool_result` records, so the read-only request did not
execute a mutation.

The generated answer nevertheless described prior moderation as tested. This Run contains no
evidence for that claim, so it is not counted as a test of any QQ capability or the non-Owner admin
path. Historical Runs must be checked separately before counting claims about earlier actions.

## Owner QQ group metadata read, 2026-09-23

Run `253cbb8a-26f7-4998-9d58-74f6cb396a03` tested a read-only request for the current group's
name and member count. The OneBot ingress identified the sender as the native group owner. The
Runtime authorized the read surfaces, but Trace recorded the required `qq_group_members` call as
`not_called`; there were no Tool-call or Tool-result records. The Run therefore failed closed.
Its stored result was `未能从 QQ 获取该信息，因此无法确认。`, and delivery reached `sent`.

The model's streamed Trace text claimed that it had called `qq_groups` and
`qq_group_members`, and included a group name, despite there being no corresponding provider-call
evidence. The Run service delivered only the terminal failure result after the evidence check, not
that unsupported streamed text. This is a negative live result for successful metadata retrieval,
and positive evidence that unsupported model text was withheld from final delivery. It does not
count as a successful provider-backed read or as non-Owner admin acceptance.

A follow-up review found the audit route returned early when a managed group had no Runs, omitting
the ingress counters. The route now returns an empty audit list with zeroed diagnostics, and a
focused management regression passed. This change does not alter QQ execution or require a service
restart.

## Owner QQ group metadata and member-list read, 2026-09-23

Run `5b3f3354-7788-4407-bc14-957f2e0f3d8c` was an Owner message in the dedicated group. Trace
recorded successful `qq_groups` and `qq_group_members` Tool calls, with successful Tool results.
The required `qq_group_members/get_group_member_list` evidence resolved as `success`; the Run
finished as `succeeded`, and delivery reached `sent`. The Run made no mutation Tool calls. The
provider result showed a non-Owner QQ admin in the group, but this Owner-sent Run does not verify
that account's bounded Tool surface. That still requires a message from the non-Owner admin.

## Native admin confirmation and member-result minimization, 2026-09-23

Run `c0592618-72ba-4c4d-92a5-f4fc2cb62b96` completed at `2026-09-23T11:01:45.037Z`. The
group-role audit recorded native ingress role `qq_group_admin`, selected `qq_group_moderation`,
excluded both settings surfaces, recorded no management Tool calls, and reported successful Run
and delivery. The sender is also a configured Glassbox Owner identity, so the Owner Principal
classification is expected and does not invalidate this role-surface test. Group Tool eligibility
uses the current QQ-native role and group policy; a Glassbox Owner Principal does not bypass the
group-role surface. This Run proves that a QQ admin receives the bounded current-group moderation
surface, but it did not execute a mutation.

The earlier successful member-list read returned profile fields beyond the requested group name
and member count, and the Run delivered that overbroad response to the group. Authorization to
read membership did not minimize the result or constrain the audience-facing fields. The
`qq_group_members/get_group_member_list` boundary now projects valid provider arrays to
`{ memberCount }` before the result reaches either model-visible Tool content or Trace details.
Every entry must contain a valid, unique QQ identity. The sibling
`qq_group_members/get_group_member_info` operation validates the returned group ID, member ID,
and native role, then returns only the normalized role. Both operations fail closed on malformed
or mismatched provider responses. The focused `capability-tools.test.ts` suite has regressions for
redaction in both Tool projections, invalid list entries, duplicate identities, empty lists, and
mismatched or malformed member-info responses. No live member-list or member-info read was
repeated after this finding.

This is a source-read minimization boundary, not a claim that the provider adapter never receives
raw profile data. The adapter receives the OneBot result internally; the capability Tool removes
profile fields before model-visible content and Trace details.

The current Channel configuration has distinct primary Owner and co-owner identities. The
co-owner resolves to a separate Owner Principal with its own scopes and grants. A later Run
`40c552b1-7d6a-41b6-a4a1-c310576fd5fa`, received after restarting only Glassbox to load the local
projection fix, was again classified as an Owner Principal and observed as `qq_group_owner` in
the QQ group. It exposed the Owner moderation and local-settings surfaces, called no Tools, and
was delivered successfully. The audit intentionally does not identify which configured Owner
sent it. This confirms the Owner path, not the non-Owner QQ-admin acceptance. NapCat remained
running, and the OneBot Channel reconnected without a QR login.

## Incomplete moderation request and Tool schema gap, 2026-09-23

Run `47f77e7f-3c95-4287-85e0-c5cfa2baba91` came from a QQ-native group admin. The message named a
member but did not specify a mute duration. Trace had no Tool calls, yet the model replied that it
had muted the member for 10 seconds. A payload-free SQL check confirmed the incoming request had
no duration. No QQ mutation occurred; the success claim and duration were fabricated.

The failure had two causes. The model-facing Tool schema used an unrestricted string/number/boolean
record for every operation, rather than declaring operation-specific required parameters. The
Run requirement parser also treated a recognized mutation with missing parameters as no mutation
intent, allowing ordinary model output instead of refusing the incomplete action.

The capability schema now exposes one strict variant per provider operation. Each variant lists
only that operation's parameters, marks the provider-required values required, disallows extra
keys, and keeps `group_id` server-bound. The Run adapter now blocks explicit but incomplete
mutations before creating a runtime session or invoking the model. It records only the operation
and a fixed reason code, without the target ID. Explicit group requests for operations not
permitted in group chat also fail before model execution. Capability execution still performs its
own input, authorization, mutation-intent, and fresh native-role checks.

Regressions cover the incomplete mute path, the forbidden group-admin path, safe evidence without
the target ID, exact required fields for mute/kick/whole-group-mute schemas, invalid runtime value
types, and the existing read-only moderation question. The full server suite passed 1,174 tests
with one existing environment-conditional skip. Server lint and types passed across 241 files, and
formatting passed for all six changed code and test files. This fixes the reproduced false-success
path; it does not yet count as real successful moderation acceptance. Retest after loading the
validated code, with an explicit target and duration, and inspect the resulting Trace for a
successful Tool call and provider result.

Glassbox is now running the validated worktree on port 3030 as PID 3144. Herdr PID 45524 and
NapCat PID 48832 remained running through the restart. The QQ read-only capability probe completed
all six provider-backed paths after Glassbox restarted; no login QR was generated. The earlier
managed-start attempt exited before readiness, and one retry started the service successfully.

## Successful complete mute request, 2026-09-23

Run `2a3091e8-0f75-4373-8733-0bf53ab73626` received the complete 60-second request. The required
Tool evidence bound `set_group_ban` to the requested member and duration. The QQ-native group owner
was freshly verified, authorization was `ALLOW`, and the moderation Tool call completed with
`isError: false`. The Run succeeded and delivery reached `sent`; the final Run result matched the
requested duration. No other Tool ran in this Run.

This is real acceptance of the validated schema, parameter binding, authorization, role recheck,
provider call, and truthful delivery for the QQ group-owner path. It does not close acceptance for
a non-Owner QQ admin: ingress identifies this sender as `qq_group_owner`. The Trace intentionally
does not retain the raw provider result payload, so this evidence proves a successful OneBot Tool
result rather than independently exposing the member's transient mute state.

## Sender-filtered no-hit search did not require retrieval, 2026-09-23

Live Run `fb0c662e-6c2c-4012-9ba7-bda8c6f0f150` asked for a sender-filtered search of a marker
that had no matches. It returned `未查到` and claimed complete coverage, but Trace had no
`group_history_search` call or `history_retrieval` event. The required evidence list was empty, so
the answer was unsupported.

The request used the natural order `搜索发送者 QQ <id> 发的群历史`. The intent recognizer only
accepted a search verb immediately followed by the group noun, so the sender filter hid the
history-search intent. The recognizer now accepts an explicit sender-qualified history request,
and the runtime binds both its single literal query and sender QQ id into the required Tool input.
If the model does not call that Tool with the bound input, the Run fails closed. Regression tests
cover the exact request shape, fail-closed behavior when no Tool call occurs, and a nearby
speculative mention that must not trigger a search.

Validation on the live integration worktree: 1,177 unit tests passed with one existing skip,
70 deterministic E2E tests passed, and core lint/types passed across 254 files. The focused runtime
tests also passed 111 cases. Glassbox restarted as PID 37540 to load the fix; NapCat PID 48832 and
Herdr PID 45524 remained running.

The post-restart live rerun is Run `d2aa3406-cef3-4e69-b407-2b3d20b378a9`. Required Tool evidence
bound `query=p4-nomatch-86731` and `sender=3067670134`. Trace records one successful
`group_history_search` call (`isError=false`) against group `1126022432`. Retrieval considered and
returned zero items, was not truncated, and reported `coverage=complete` after five pages reached
`end_of_source`. The Run succeeded, delivered `未查到`, and stated the search-window boundary.
NapCat stayed at PID 48832; no QR was generated. This accepts the sender-filtered no-hit path.
