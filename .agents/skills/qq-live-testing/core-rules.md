# Stable QQ acceptance rules

These rules define the acceptance boundary. The playbook may add operational detail, but it must not weaken or reinterpret these rules.

1. Authorization comes from the user's explicit instruction for the action. Loading this skill, completing development, or having a test window configured does not authorize live sends, group operations, service changes, or merge.
2. A feature PASS requires the expected product behavior and traceable evidence tied to the tested case, exact code commit, and matching Glassbox Run. A preflight failure is recorded as a preflight error, never as a Run or feature PASS.
3. Custom live scenarios remain unsupported while `tools/qq-live/HANDOFF.md` says they are plan-only. Do not invent a command, bypass the guard, or report custom live support.
4. FAIL, BLOCKED, INCONCLUSIVE, missing evidence, and unknown send outcomes never count as PASS. Preserve assertions and historical evidence. Diagnose from evidence and repair the demonstrated cause.
5. Automated tests use isolated disposable state. Real QQ acceptance uses the established service and persistent acceptance data only when explicitly authorized. Do not send credentials or personal message contents into lessons, commits, or shared reports.
6. Merge requires passing feature suite, baseline regression, cleanup, exact-commit verification, CI, and PR review, plus explicit user authorization. After merge, verify the merged commit and rerun applicable acceptance against that commit.
7. Skill text cannot authorize a product action, lower a test assertion, or override repository policy.
