# Audit remediation

Status: ACTIVE IMPLEMENTATION, scoped backend fixes. Each verified concern gets a reviewable change and regression coverage. No Web UI redesign, live QQ acceptance, service switch, merge, or deployment is included. The Owner performs real QQ acceptance after reviewing the PRs.

Baseline: `64fa57c475f5332f912a13c6e37fa4c33c47d483`.

## Acceptance contract

- Reproduce each confirmed failure in disposable fixtures before changing behavior.
- Preserve server-side authorization, delivery scope, evidence and runtime boundaries in AGENTS.md.
- Run focused tests, affected checks, the commit gate and the full pre-PR gate. Report blocked checks rather than weakening them.
- Keep historical Trace immutable. Do not infer production recovery from tests or a merged historical PR.
- Open draft PRs after self-review, push the actual reviewed changes, inspect CI for their exact commits, and leave merging to the Owner.
- Configuration or migration risks and lifecycle hypotheses must first be established; they are not all confirmed defects.

## First slice

Owner-private control-command parsing:

- [x] Independently reproduce capability-enable instructions that previously only passed as a combined fixture.
- [x] Reproduce model switches whose optional prefix disagreed with target extraction.
- [x] Use one model selection grammar for intent and target parsing.
- [x] Resolve explicit capability policy changes before QQ domain-action keywords.
- [x] Preserve direction and canonical category; reject negative or contradictory requests.
- [ ] Complete self-review, full gates and CI verification.

The policy parser binds a requested operation; it does not grant permission or mutate policy itself. Existing execution-time authorization and required-call checks remain responsible for execution. A success message still requires observed execution. This slice does not claim to fix every possible natural-language statement or provider failure.

## Remaining backend review queue

- Capability command / moderation parameter consistency and native-role versus Owner identity semantics.
- Grant revocation surviving inbound provisioning; delivery provenance for Tool outputs; policy revocation during in-flight delivery.
- Explicit model override recovery, candidate credential and image-capability requirements.
- Sanitized provider/runtime diagnostics and distinct execution versus policy-result health.
- Memory TTL pagination, sensitivity on supersession, stale correction promotion, batch confirmation and date ordering.
- Git artifact attribution, quoted paths, untracked files and deletion evidence.
- Web retrieval challenge detection, truncation reporting, cancellation and error classification.
- Linux process identity and migration acceptance risks, without changing a live service.
- Long-task lifecycle: creation, delegation, approval waiting, interruption, restart, retries, review/acceptance, result delivery and evidence.

For long tasks, additionally investigate observer completion, cross-transaction state transitions and stale terminal output. Treat these as hypotheses until reproduced. Do not manufacture a reproduction or add arbitrary sleeps. Check idempotent delivery and that a Worker finishing never automatically means the Task is accepted.

## Owner acceptance handoff

For each PR, explain the original behavior, root cause, changed contract if any, automated results, exact commit, remaining limits and manual QQ scenarios. Include negative and restart cases. Do not ask the Owner to discover basic parser or fake-transport regressions already testable locally.
