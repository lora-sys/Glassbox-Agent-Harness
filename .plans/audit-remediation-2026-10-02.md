# Audit remediation

Status: IMPLEMENTATION MERGED in [PR #136](https://github.com/lora-sys/Glassbox-Agent-Harness/pull/136) on 2026-10-02, merge commit `074eaf77851b1f1ce85ee962bc209fa5a709a4e6`. This scoped backend repair plan is a historical implementation record, not an active implementation queue. The per-slice status notes and unchecked items below describe the work before integration; they do not supersede this merged status. Real QQ acceptance and any unreproduced review hypotheses remain unverified. No Web UI redesign, live QQ acceptance, service switch, or deployment was included.

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

## AUTH03 source-policy revocation

Status: local implementation and regression verification. Publication and Owner QQ acceptance
remain pending. Derived Memory enforcement is implemented locally; final review remains open.

- Reproduced grant-only access after a QQ category disable and the sibling-Owner history path.
- Added versioned conditions to live and archived authorization decisions in schema v26.
- Kept category flags independent from Memory-source-class flags, including shared Actions.
- Applied grant and source-policy checks in one authorization transaction before consuming
  approvals. Conditions come from trusted registry/retrieval producers, not Tool input.
- Propagated conditions through delivery create/claim/retry, history reuse, internal Steps,
  Task ancestry, and content-bearing Task/Worker projections without collapsing shared Actions.
- Added fresh/upgrade/archive/reopen, malformed/legacy provenance, bounded lineage, and actual
  registered QQ Tool regressions. Legacy QQ dependencies with unknown routes fail closed.
- Reproduced derived Memory promotion/read/automatic-Context bypasses, then added server-owned
  v27 dependency snapshots, archive-aware reconstruction, source-preserving merge/supersession,
  authoritative Run lineage, verified raw imports, and trusted literal capture.
- Closed held-provider and Worker-read completion windows. A selected-Memory recheck immediately
  before every Runtime continuation closes the reproduced asynchronous Context-preparation
  window. Real SDK tests also enforce its public stream and final payload boundaries for both
  initial Memory and new mid-Run Tool sources; extension hooks alone did not stop transport.
- Metadata-only expire/revoke/retire/reject remains available under current governance authority,
  returning a body-free action receipt when collection/source reads are refused.
- Added v27 fresh/v26-upgrade/archive/process-reopen tests, explicit legacy ancestry and ambiguous
  retention controls, actual Runtime loading and delivery create/claim/retry checks, source-class
  independence, forged metadata, older-dedupe, group reads, and all merge strategies.
- Still required: final aggregate checks, independent review, eventual exact-commit CI, and
  Owner-run real QQ acceptance. No live state or
  service switch belongs to this slice.

Existing tests that supplied only an `isHistoryEnabled` callback now seed durable policy in
fixtures. Execution uses the database policy in the grant transaction. Category denial now
reports `source_policy_denied` before provider execution. Assertions changed only for that
intentional contract, with negative-policy and unchanged-grant regressions retained.

A disposable follow-on reproduction confirmed that group-only archive queries returned a
same-group row from another connection and let it consume the requested limit. AUTH03 now
binds both Memory-source and history queries to the trusted connection in SQL. The archive
has no durable Bot attribution, so reconfiguring one connection across Bot identities remains
a separate provenance/migration risk rather than a completed isolation claim.
