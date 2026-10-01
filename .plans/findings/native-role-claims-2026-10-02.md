# Native QQ role claims and Glassbox Owner

## Confirmed failure

FUNC-03 used one role-word list for both Glassbox Owner and native QQ administrator/group-owner claims. A Visitor Principal with a trusted current `qq_group_admin` or `qq_group_owner` observation was refused before the model when it truthfully named that role. The output gate also rejected truthful role acknowledgements.

The isolated regression matrix failed 15 cases before the implementation changed. Existing audit evidence is recorded in the identity and authorization audit. No real QQ, model provider, production data, or credentials were used.

## Changed behavior

- Parse complete role labels before comparing them with the current caller's native role observation. `group owner` is a native role label. Bare `Owner`, including `这个群的 Owner`, remains Glassbox authority. Explicit Glassbox-qualified labels remain protected.
- Require the matching observed native role, using the current Run's caller scope rather than an older shared Conversation scope. Missing observations and ordinary membership do not substantiate admin/group-owner claims.
- Apply the same distinction to declarative output acknowledgements. Explicit mixed Owner or protected-name claims remain refused, including coordinated clauses after a truthful native role.
- Preserve Principal identity, the authorized Tool surface, grants, mutation intent, policy checks, and execution-time OneBot role revalidation. A native-role acknowledgement grants no authority.

The change keeps the existing Chinese assertion grammar, with Chinese and English role labels. Pure-English assertions such as `I am the Owner` and `You are the Owner` remain a separate known language-detection gap. These expression checks are not the authorization boundary.

## Verification

- Initial unchanged-baseline regression run: 15 failed, 179 passed.
- Independent review reproduced two additional cases before their corrections: a native role followed by an explicit Owner denial, and Glassbox-qualified native-looking labels. Both have regression coverage. Exact `administrator` titles are also preserved without treating `administering` as a role.
- Final focused adapter, capability-tool and OneBot suites: 293 passed.
- Final staged commit gate and full pre-PR gate both completed on the same frozen code, each with exit 1. Each ran 2,092 tests across 171 files: 2,076 passed, 15 failed, and 1 existing conditional test was skipped. All 15 failures were unchanged Herdr fixture tests whose local sockets returned `listen EPERM`. No role regression failed. The gates therefore did not pass; a supported CI runner must establish the socket-suite result. No tests were weakened or skipped by this change.
- Final formatting/lint/types checks passed for both changed code files. The full gate passed core lint/types across 429 files, web types, and all 15 validation-selector tests.
- The separate web build passed after linking the existing workspace-local web dependencies. Repository hygiene passed with pinned npm 12.0.2 for all 4 workspace packages.
- Both final gates verified unchanged source and test hashes. Earlier interrupted and mixed-snapshot runs are not final-candidate evidence.
- Independent review cleared the mixed-role negation and explicit Glassbox-qualifier corrections with 68 direct assertions. Reconfirmation of the final exact `administrator` vocabulary addition and root review are pending. No commit or push has been made.

Existing capability tests cover the authorized native-role Tool subset, demotion before provider mutation, provider verification failure, and exact current-group binding. Real QQ acceptance is still the Owner's responsibility.

## Windows CI phase diagnostics

PR #131 at `0b5bf2739874aa7216e721b6bf3626a2f4dc3bfe` passed Ubuntu and browser checks but failed Windows jobs `110553648373` and `110567213875`. The existing Owner assignment/reopen test exceeded 90 seconds twice. The second job also exceeded 30 seconds in Visitor provisioning/reopen and the future-MCP contract test. Logs locate the tests, not the pending operations. The same fixture, database, trace and Windows ACL source blobs passed in PR #133 and #134; none of the three failed cases invokes the changed Pi identity parser. This does not establish a root cause.

The next diagnostic revision observes only those three test cases on Windows. Test-local wrappers preserve the real database transactions, trace appends and ACL operations. Phase records contain fixed labels, elapsed time, outcome and cumulative metric counts/times only. They exclude paths, SQL, arguments, results, messages and error text. Slow-operation records are capped at eight per case; completion reports unfinished phases and pending operation ages. Test-finished hooks restore the wrappers. Transaction wrappers do not retain a spy call history or native handles.

The measurements distinguish fixture open, provisioning, group assignment, close/reopen and verification, and distinguish transaction callback time from total queued transaction time. No production implementation, workflow, timeout, assertion or test selection changed. The diagnostic helper's local contract tests run its enabled path with real isolated database and trace operations, including rejection propagation, redaction and restoration. Actual Windows phase evidence is still pending.

## Owner acceptance

After review, use a QQ admin, QQ group owner and ordinary member in the same configured group. Send truthful native-role claims and confirm the expected response. Then try false native-role claims, bare Owner claims and a truthful native role combined with an Owner claim. Confirm Principal and Tool authorization records do not change because of text. For a permitted moderation request, demote the sender before execution and confirm live OneBot verification refuses the mutation. Do not interpret a successful conversational acknowledgement as moderation acceptance.
