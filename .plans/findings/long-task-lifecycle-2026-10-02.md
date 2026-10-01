# Long-task lifecycle audit fixes

Scope: the active backend audit remediation plan. Base commit `5883b955`. No Web changes, live service switch, real QQ acceptance, merge, or deployment.

## Reproduced failures and fixes

- LIFE-01: a management observer with `settleCompleted=false` persisted Pi `working` then `idle`. The Temporal observer subsequently saw only `idle` and lost the completion edge. Durable observations now append completion evidence in the binding-update transaction. Repeated idle and unknown observations preserve that evidence; a newer working observation supersedes it. Only the authorized Temporal path settles the Step.
- LIFE-02: a crash after the first of the join or overdue-timer transitions left the Step running indefinitely. The next Activity now completes the same side-effect-free Step, or settles cancellation. File-backed database reopen tests verify downstream progress and exactly one start and terminal event.
- LIFE-03: a buffered legacy idle event could overwrite a newer bootstrap working snapshot. Legacy observations now compare the source timestamp and exact binding/attempt identity in the write transaction. Bootstrap, reconnect, event-loss recovery, and database reopen are covered.
- Candidate races: output captured before resumed work could become reviewable or be reused at a later completion. The first candidate and declared file stay immutable. Resumed work appends an invalidation marker. Later completion blocks the Step and quarantines its lease until verified pane closure and explicit authorized rework. A fresh attempt can capture a fresh result. Capture checks state, timestamp, and observation sequence; settlement checks invalidation again. The sequence distinguishes working-to-idle cycles within one timestamp.

The initial regression run reproduced four failures: LIFE-01, LIFE-03, join recovery, and timer recovery. Four further focused reproductions established same-timestamp resumed-work settlement, stale-candidate reuse, same-timestamp working-to-idle before settlement, and the equivalent cycle before first insertion. These are deterministic fixture results, not claims about production incidents.

Production candidate writes occur only in the two `HerdrWorkerRuntime` branches for first capture and saved-candidate recovery. Both supply the expected state, timestamp, and observation sequence. Calls that omit observation metadata are test fixtures for store validation or previously persisted candidates; there is no unguarded production capture path.

## Verification

- Seven affected suites: 161 tests passed.
- Core lint and types: passed, including the Web type check.
- Staged commit gate: 54 affected test files, 655 tests passed; 15 validation-script tests passed.
- Web build: passed. Existing bundle-size and Vite plugin deprecation warnings remain.
- Full gate: 170 test files and 2,069 tests passed; one existing file/test remained skipped. All 15 tests in `socket-herdr-bridge.test.ts` failed because this sandbox rejects Unix-socket `listen` with `EPERM`. The gate stops before its Web build, which passed separately. The socket suite must pass in CI without weakening or bypassing it.
- Text portability: passed. The extra repository-hygiene run reports the shell's npm 11.9.0 instead of the required 12.0.2; it is a toolchain limitation, not a lifecycle failure.

External audit evidence includes `baseline-reproduction.log`, `settlement-race-reproduction.log`, `candidate-reuse-reproduction.log`, `candidate-settlement-aba-reproduction.log`, `candidate-insert-aba-reproduction.log`, and the `resumed-*` verification logs. No live credentials or QQ messages were used.

## Recovery limits and Owner acceptance

These fixes preserve evidence recorded after upgrade. They cannot reconstruct a working observation already overwritten by an older observer, prove whether a pre-fix candidate's Worker resumed without an invalidation record, or infer the original source time of a legacy observation that previously stored receipt time. They do not rewrite old Trace, reopen previously reviewed Steps, or automatically accept Tasks. An uncertain pre-fix attempt needs inspection and, when appropriate, verified Worker closure and explicit rework.

The Owner should exercise a real Pi Worker through management observation, process restart, completion, review, and acceptance. Also verify resumed work after capture requires closure/rework, and that a fresh attempt succeeds. Confirm QQ receives only the authorized result and preserves one Task identity. Local fixtures and a successful web build do not satisfy real QQ, Herdr socket, or Linux service acceptance.

## PR #130 Windows cleanup repair

Bounded rm retries did not remove all Windows EBUSY failures. The native libsql dependency can retain prepared-statement connection handles after logical close. File-backed observer and no-op recovery fixtures now execute in child processes; parent cleanup waits for actual process close. The same case matrices and assertions remain, with a completion marker and propagated child assertion failures. Production lifecycle code and dependency versions are unchanged. The scoped evidence, assertion map and remaining Windows timeout limits are in `long-task-ci-fixtures-2026-10-02.md`.

The final fixture-repair commit/full gates completed with 2,072 passing tests, 15 sandbox Unix-socket EPERM failures and one existing skipped test. Core/Web types, validation scripts, the separate Web build and pinned-npm hygiene passed. No test worker was killed or timed out, and the seven code/test hashes stayed unchanged. Windows acceptance remains pending on the updated CI run.
