# Long-task Windows fixture isolation

PR #130 Windows job `110554625661` reported three cleanup `EBUSY` failures in the durable worker observer and timer recovery reopen cases. The same job reported seven other timeout failures, which this scoped fixture change does not alter or claim to resolve.

The installed libsql 0.5.29 native close removes the database's connection reference, but prepared statements retain their own references until finalization. Its public API exposes no explicit statement disposal. A standalone Linux reproduction retained native database descriptors after successful close and released them after diagnostic garbage collection. Real DomainStore reopen and writes preserved all rows, so this evidence establishes resource-release timing rather than lost state. See the pinned [database close](https://github.com/tursodatabase/libsql-js/blob/v0.5.29/src/database.rs#L162-L170) and [statement ownership](https://github.com/tursodatabase/libsql-js/blob/v0.5.29/src/statement.rs#L11-L18) implementations.

## Test-only change

The four file-backed observer cases and four no-op recovery cases execute in short-lived children. The parent waits for the child's `close` event, then removes its directory with bounded retries. The process helper and its tests are copied unchanged from the reviewed PR #132 repair. Child failures retain diagnostics and fail the parent case. Cancellation is passed through Vitest's signal, and the helper does not settle on an abort error before process close.

Fixture entries export inert script URLs for static imports by their parent tests. An explicit main-module guard runs the fixture only in the child. This preserves Vitest's related-test dependency tracking. A fresh-process check verifies that importing either entry performs no mkdir, mkdtemp, writeFile, rm or child-process call. No lifecycle product code, dependency version, garbage-collection setting, timeout, assertion or validation configuration changes.

## Preserved assertion map

- Candidate invalidation after reopen: the Step is blocked; the candidate is not reviewable; its immutable first output remains; the stale-rework evidence reference is present.
- Three Pi observation sequences: the Step remains running before reopen; repeated terminal observations move it to review; the Task is not DONE; exactly one ATTEMPT_FINISHED event exists.
- Four join/timer recovery cases: the injected error follows a committed running transition; the original Step is running before reopen.
- Cancellation branches: authorization is ALLOW; repeated advancement returns complete; the Task is CANCELED; both Steps are cancelled; exactly one cancellation event and no success event exists for the original Step.
- Success branches: both Steps succeed; advancement returns complete; the Task is REVIEW; exactly one start event and one success event exists for the original Step.

The original case matrices and names remain. Parent tests additionally require a completion marker after the child assertions and store close.

## Focused verification

Observer, no-op recovery and helper suites passed 36 tests in three files. The related-test command targeting both child entry files selected both parent suites and passed all 33 tests. All seven changed code/fixture files passed lint and types after the inert import wiring. The existing staged-test integrity function reports no issues on the actual staged diff; validation configuration is unchanged. Windows cleanup acceptance awaits CI on the updated commit.

## Final serialized gates

The staged commit gate and full gate both exited 1 after completing 2,072 passing tests. Their only failures were the same 15 Unix-socket `listen EPERM` cases in this executor; one existing test remained skipped. Core/Web types and validation scripts passed. The separate Web build and repository hygiene under pinned npm 12.0.2 both exited 0. No worker was killed or timed out. All seven changed code/test file hashes remained unchanged across the gates. This does not certify the unresolved Windows timeout cases or Windows cleanup until CI runs the new commit.
