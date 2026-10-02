# Nickname moderation and provider projection repair

## Scope and reproduced failures

The FUNC-02 adapter emitted `groupId` and `operation` but omitted both target and duration
for a nickname mute. The exact mutation gate forbade adding the provider parameters needed
to execute it. The first regression tests failed in the real capability Tool and adapter.

A second reproduction used `ManagementApplication.createRuntimeTools` with a disposable
provider boundary, without a network socket. The application passed the verified OneBot
success envelope to projections that require its data. Login, member list, and member info
all returned `invalid_response`. The repair projects data only for these three operations.
Other operations, including moderation mutations, retain their success envelope. Failed,
unknown and nested data-shaped responses have fail-closed regressions.

The prior numeric member extractor also selected a number from another clause. For example,
`禁言 Ripped 30 秒，另外查看成员 10005` pinned `10005`. Mute targets now come only from the mute
clause. A private mute cannot borrow its group from an unrelated read clause.

Final review found the same problem in duration parsing. Both numeric and nickname requests
could borrow `30 秒` from a later read clause, while a valid mute duration plus an unrelated
duration was rejected. Twenty adapter regressions cover both group and private requests;
sixteen failed before the repair. Target, duration and explicit group now use the same single
mute clause. Multiple mute requests fail before a model turn instead of selecting one or
combining their parameters.

## Contract

- Numeric requests keep the fixed `user_id` and explicit duration path
- Nickname requests bind `memberSelector` and `params.duration`, with no model-supplied ID
- Resolution requires the current member Tool, registry Action `group:members:read`, and
  category `group.members`, independently of moderation permission
- The server rechecks authorization after roster I/O before using its data and after native
  role verification before mutation dispatch
- Exact case-sensitive card/nickname comparison uses no Unicode or whitespace normalization
- Multiple matches for one QQ ID deduplicate; different matching IDs remain ambiguous
- The first resolved ID, group, selector and duration stay pinned to the original Run intent
- Missing, ambiguous, malformed, changed or unauthorized targets get fixed actionable replies
- Resolution evidence records only the selected ID, duration, match method and read receipt
- Evidence-write failure, changed target, extra parameters and cancellation cannot dispatch
- The existing single-attempt intent and live native-role checks remain in place

No live QQ calls, provider probes, credentials, deployment or configuration changes were used.

## Focused verification

The focused suite covers the real application composition, actual capability Tool and actual
Run adapter with disposable DomainStores and a fresh isolated Pi directory. It covers both a
Glassbox Owner and a visitor whose trusted QQ role is admin. It also covers current grant and
category changes during I/O, exact Unicode matching, concurrent calls, provider failures,
resolution evidence, target substitution, missing/range durations, and cancellation.

Changed code and tests pass the repository lint/type checker. Full serialized commit and
publication gates are still required; focused checks are not a substitute for them.

## Authorization-policy integration

The FUNC02 change is integrated with frozen AUTH03 core tree
`05a4e1d28cd7b829791f73f5e85dc3a3c3190746`, based on `437c469`. The original standalone
repair and core snapshots remain unchanged.

`authorizeMemberResolution` constructs one trusted roster AuthorizationRequest with
`qqCategoryCondition(context.caller, groupId, members.category)`. It retains the initial
ALLOW decision ID and returns a completion closure over that exact request and receipt.
The closure calls `authorizeReadResults` after the provider returns, before inspecting the
roster. After resolution evidence, live-role I/O and both category projections finish, it
calls `authorizeReadResultsAndAction` with the same original receipt and a distinct mutation
request. One transaction rechecks the read and mutation's current identity, grants,
delegation and category policies. It records the read completion only when both allow,
without consuming the initial read approval twice.

Initial and ordinary read-completion denials map to `moderation_member_id_required`. A final
compound denial maps to `moderation_authority_changed`; detailed denial evidence identifies
the failed request without guessing which permission changed in the fixed reply.
The original selector mutation intent, application trace callback, three-operation
verified-success projection, and SDK provider-boundary source checks are preserved.

Final review reproduced a remaining window between separate awaited read and mutation
checks: revoking `group.members` during the final moderation-category projection still
allowed dispatch. A deterministic real-Tool regression now covers that interleaving and
reciprocal mutation-policy revocation. Moving both checks into the final transaction closes
that window; reordering separate checks would leave the opposite window.

Six integration regression failures established the missing durable policy checks, absent
roster source markers, and repeated approval consumption before the completion closure was
wired in. The tests exercise actual Tools, the real authorization service, and application
composition with disposable state. A stale category projection cannot override durable policy.

## Model-facing group call projection

The real Pi SDK adapter and retry prompt both printed the trusted required input as an exact
model call. That input includes the group bound by the server, but the capability Tool rejects
a model-supplied `groupId` in group chat. Actual Pi model-context regressions reproduced the
invalid example for numeric and nickname mutes. The shared prompt helper now omits only that
server-bound field for registered group capability calls inside groups. Private call examples
keep their explicit group, and the trusted required input retains every field unchanged.
