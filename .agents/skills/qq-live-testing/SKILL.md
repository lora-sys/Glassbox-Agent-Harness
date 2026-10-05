---
name: qq-live-testing
description: Guide feature acceptance and QQ live regression for Glassbox, use the current qq-live HANDOFF for supported operations, diagnose failures from evidence, and preserve strict merge gates.
metadata:
  short-description: Glassbox QQ feature acceptance
---

# QQ live testing

Use this skill while implementing a Glassbox feature that needs acceptance through real QQ, when rerunning QQ regressions, or when fixing a failure found by those checks. It guides the workflow. It does not grant permission to send messages, operate a group, change runtime state, or merge.

Before testing, read `AGENTS.md`, the applicable active plan, `docs/tech-stack.md`, `tools/qq-live/README.md`, and `tools/qq-live/HANDOFF.md`. Read [core-rules.md](core-rules.md) and verify its lock with `node .agents/skills/qq-live-testing/scripts/verify-core.mjs`. Review [lessons.jsonl](references/lessons.jsonl) for relevant verified lessons. Run helper coverage with `node --test .agents/skills/qq-live-testing/scripts/helpers.test.mjs` when changing this skill.

The current CLI supports its documented fixed cases and schema-v2 read-only feature cases through server leases. Schema-v1 free-text scenarios support planning only. The executable read seed does not cover the complete existing-feature baseline. Run coverage against the actual suite and keep missing domains BLOCKED. Follow HANDOFF for these boundaries. If the requested feature has no supported live case or product-evidence check, add the narrow case, observer, and evidence checks to the existing CLI and isolated fixture suite when they fit the authorized implementation scope. Do not treat a transport smoke check as feature acceptance. If the required product path exceeds that scope, use HANDOFF to name the missing contract and owner before continuing. Do not invent a command or claim support.

For an authorized iteration:

1. Record the target feature cases, baseline regression scope, checkout, and exact commit. Use isolated disposable state for automated tests and the repository's established shared service/data directory only for explicitly authorized real QQ acceptance.
2. Run the feature suite and relevant baseline regression before and after a code fix. Use the repository's documented commands, including `npm --prefix tools/qq-live test`, `npm run test:regression`, and focused tests selected by the active plan. Run only documented live cases after explicit authorization for those sends and any group action.
3. Require product evidence for each live PASS. Match the case to the exact Glassbox Run and verify the expected authorization and delivery evidence. A transport result, `doctor`, simulated event, or Bot claim alone is not product acceptance. Follow HANDOFF for FAIL, BLOCKED, INCONCLUSIVE, STOP, cleanup, and bounded evidence-led repair.
4. Fix the demonstrated cause and keep or add regression assertions. Never skip a failed case, weaken an assertion, rewrite evidence, or relabel unknown results as PASS. Record only reusable lessons with `record-lesson.mjs`. Findings without a passing report stay hypotheses. Verified lessons require a hashed successful `qq-live` report whose workspace, runtime, case, authorization, delivery, and exact commit match, plus matching input and delivery events confirmed by the existing `gbxtrace` CLI. The helper stores the report hash and Run ID, not the report or Raw Trace.
5. Clean up only resources created for this acceptance and confirm the test environment is restored. Keep reports local when they contain account or message data. Do not copy credentials, personal messages, screenshots with identifiers, or tokens into a lesson or shared report.
6. Merge only when the feature suite, baseline regression, cleanup, exact tested commit, CI, and PR review all pass, and the user has explicitly authorized the merge. Confirm CI and review apply to that exact commit. After merging, verify the merged commit and repeat the applicable acceptance against it. If any gate is missing or the commit changes, do not merge.

The stable acceptance rules are defined in [core-rules.md](core-rules.md), protected by [core-rules.sha256](core-rules.sha256). Change the core only as an explicitly reviewed policy change and update the lock in the same change. Routine improvements belong in this skill's playbook or append-only lessons. Changes to a secondary playbook require regression evidence. See [lesson-format.md](references/lesson-format.md) for the lesson schema and command. No skill update expands the user's authorization.
