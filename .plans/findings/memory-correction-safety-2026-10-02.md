# Memory correction safety

Scope: backend audit remediation D1, D2 and D3, based on commit `5883b955`. No Web changes, real QQ acceptance, service switch, merge or deployment.

## Reproduced failures

- D1: newer expired rows consumed the SQL limit before read-side filtering. Group reads also let newer non-public rows consume that limit. Eligible older memories disappeared from bounded reads.
- D2: direct and pending statement corrections dropped public sensitivity. The replacement then disappeared from its group's public Memory read. The same replacement construction also dropped `retentionPolicy`, `ttlSeconds` and `expiresAt`, making a temporary memory non-expiring.
- A matching pending suggestion could also replace explicit correction metadata during candidate deduplication. An explicit confidential, zero-TTL correction reused a public, one-hour pending suggestion and its old retention policy instead. The inherited-metadata case could similarly downgrade a confidential original.
- D3: a candidate whose `ifMatchMemoryId` target had been superseded, expired, revoked, retired or deleted became a new active memory. A separate same-target case ignored the already declared `ifMatchUpdatedAt` field and replaced a memory that had changed after review began.

The original nine regression cases failed before the initial fixes. After adding the TTL and retention tests, both new retention cases failed while the other seventeen expanded cases passed. The five version-precondition cases and both pending-candidate collision cases also failed before their fixes. Disposable fixtures reproduce these behaviors without live QQ or model calls.

## Changes

- Apply active lifecycle and TTL predicates before `LIMIT`. Apply the group's public sensitivity predicate there too. Keep the final read-side eligibility checks and explicit inactive inspection.
- Inherit omitted sensitivity and retention policy in both correction paths. Inherit the original TTL and absolute expiration together, so a correction does not restart the clock. Explicit values, including zero TTL, take precedence.
- Give each explicit supersession its own confirmation candidate. Keep matching pending suggestions unchanged and pending; never reuse their metadata or evidence for the explicit action. A later attempt to promote the old suggestion fails against its retired target.
- Reject inactive or absent matched targets with `memory_not_active`. Direct supersession also checks effective TTL activity before creating a candidate.
- Enforce an explicitly supplied `ifMatchUpdatedAt` with `memory_version_conflict`. The protected Tool boundary permits that exact fixed code, so a real Owner Tool promotion reports the stale-version reason without exposing Memory content or identifiers. New Owner Tool correction candidates record the observed target timestamp. The consolidator records the timestamp from the snapshot passed into extraction, including update and retire decisions. Validation and all replacement writes share one transaction.
- Failed promotion leaves the candidate pending and does not change canonical Memory. Historical candidates without a timestamp still use their declared active-ID precondition; no version is invented for them.

The version token remains the existing `updatedAt` field, not a new schema or monotonic revision. Confidence and retention scoring behavior are unchanged. No authorization or public visibility condition is weakened.

## Regression coverage

- Owner and group limits of 1, 40 and 100, each behind more newer expired rows than the limit. Group fixtures also contain newer confidential and unclassified rows.
- Just before and exactly at a TTL deadline, with inactive inspection retained.
- Real Owner Tool explicit and pending corrections for public and confidential group Memory. Visibility, replacement lineage and predecessor retirement are checked after database reopen.
- Omitted TTL and retention policy preserve the exact deadline after database reopen and expire at that deadline. Explicit changed metadata and zero TTL are honored.
- Superseded, expired, revoked, retired and missing targets leave stale candidates pending with no replacement, including persistence after reopen. The expiry case advances time between candidate creation and promotion.
- Explicit supersession honors inherited and supplied metadata even when an identical-statement pending suggestion has conflicting public visibility and TTL. The original suggestion and its evidence stay unchanged.
- Direct supersession rejects expired, revoked, retired and missing targets without creating a candidate.
- Owner Tool same-ID edits, concurrent extraction updates and retire decisions fail their observed-version precondition. A real Owner Tool promotion of a stale candidate returns only the fixed conflict code; this regression first reproduced the incorrect `protected_tool_failed` wrapper result. Matching version preconditions succeed for manual-review and replacement strategies.

## Verification

- Focused learning, Owner Memory Tool and protected Tool coverage: 7 files, 83 tests passed, including 34 new regression cases. The real Owner Tool stale-promotion assertion failed before the fixed-code allowlist change and passed afterward.
- Formatting, lint and types passed for all five changed code files. Full core lint and types passed across 430 files; Web types also passed.
- Final serialized commit gate: exit 1 with 2,082 tests passed. The 15 failures are all `listen EPERM` in `socket-herdr-bridge.test.ts`, where this executor denies Unix socket binding. One existing skipped test remains unchanged. The aggregate gate is blocked, not green.
- Final serialized full gate: exit 1 after core checks and all 15 selector/migration script checks passed. Its unit run also finished with 2,082 passed, the same 15 Unix-socket `EPERM` failures and one existing skipped test. No worker was killed or timed out. All five implementation/test file hashes matched before and after these gates.
- The Web build passed separately because the full gate stops before its build stage when unit tests fail.
- Text portability passed for 681 files. Repository hygiene initially reported the executor's npm 11.9.0 instead of the pinned 12.0.2. A rerun under pinned npm 12.0.2 passed for all four workspace packages.

Tests use isolated temporary databases and Pi state. No test was disabled or weakened, and socket restrictions were not bypassed. Real QQ acceptance remains with the Owner.

## Owner QQ acceptance

1. Correct an existing public group fact through an Owner-private supersede command, then ask in that same group. The corrected fact should remain available and its predecessor should be retired.
2. Ask for a suggested correction, change its original fact before promotion, then try promoting the older candidate. Expect a stale-version failure and a still-pending candidate.
3. Repeat with a target that expires before review. Expect `memory_not_active`, with no restored fact.
4. Inspect a time-limited corrected Memory after a restart. Its original expiration deadline should remain unchanged.

## PR #132 CI repair

The Windows run exposed native libsql file handles surviving logical close, so the file-backed reopen cases now execute in isolated child processes. Parent cleanup waits for confirmed child exit, then uses bounded removal retries. Case matrices and assertions remain intact. The dependency resource lifetime and production limits are recorded separately in `libsql-native-close-2026-10-02.md`.

The Linux run exposed an independent fake Codex proof-file race. Its in-place shutdown write could leave truncated JSON when interrupted. The fixture now writes a temporary file and renames the complete snapshot into place. A deterministic interrupted-write case reproduced the CI parse error before the change and passes afterward. Existing Codex assertions remain unchanged.

Focused verification after these fixture repairs: the memory/Codex cases and process-helper cases passed. The added cancellation regression verifies that an abort error does not settle the helper before the child writes its exit marker and actually exits. Formatting, lint and types passed for all six changed code/fixture files. The existing staged-test integrity function returned no issues for the actual staged diff; validation configuration is unchanged. Windows acceptance still requires the next CI run. No full gate was started while another repair owned the shared verification slot.

Final serialized verification of the CI-repair snapshot completed with unchanged hashes for all six changed code/test files. Both the commit gate and full gate exited 1 after 2,086 tests passed; their only failures were the same 15 Unix-socket EPERM cases, with one existing skipped test. Full core/Web types and validation scripts passed. The separate Web build and pinned-npm repository hygiene both exited 0. The related-test command now selects all 34 memory cases through the statically imported fixture entry. Import-side-effect verification also passed. The production native-close limitation remains unchanged; Windows cleanup acceptance still requires CI on the updated commit.
