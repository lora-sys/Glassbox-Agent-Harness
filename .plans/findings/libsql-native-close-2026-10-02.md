# Native libsql close and test cleanup

Status: reproduced dependency resource-lifetime behavior. This change isolates test fixtures; it does not change production persistence or claim to fix native closure.

## CI evidence

PR #132 Windows job `110559140146` failed all 11 file-backed memory reopen cases during final removal of `glassbox.db`, with `EBUSY`. Their stores had been awaited closed before removal. The corresponding Linux job `110559140103` passed these memory cases. Windows failures in PR #130 remained after bounded removal retries, so retries alone are not a reliable native-resource release mechanism.

## Pinned implementation

The installed versions are `@libsql/client` 0.18.0 and `libsql` 0.5.29. The client closes its connection pool, and its native Database wrapper reports `open = false` after calling the native close function.

In the [pinned native Database implementation](https://github.com/tursodatabase/libsql-js/blob/v0.5.29/src/database.rs#L162-L170), close removes the Database's connection reference. Each [native Statement retains its own connection reference](https://github.com/tursodatabase/libsql-js/blob/v0.5.29/src/statement.rs#L11-L18). That reference lasts until statement finalization. The installed TypeScript API and [pinned native export list](https://github.com/tursodatabase/libsql-js/blob/v0.5.29/src/lib.rs#L51-L60) expose no explicit statement finalize or dispose operation.

The pool's `closeQuietly` suppresses native close errors, but such an error is not required for this reproduction. Direct native close returned successfully while a file descriptor remained open.

## Reproductions and limits

Disposable Linux fixtures inspected `/proc/self/fd`:

- A native database used only through `exec` had no remaining descriptor after close.
- A database with a prepared SELECT reported `open = false` after close, but retained its database descriptor. Explicit diagnostic garbage collection and one event-loop turn released it.
- Three real DomainStore open/write/close cycles on one file retained one, two and three descriptors respectively. The row counts were one, two and three, proving that the inspected logical reopen and writes worked. Diagnostic garbage collection released all remaining descriptors.

The standalone reproductions and their output are retained with the audit verification evidence. Forced garbage collection is used only to identify the native lifetime, never by the tests or production code in this change.

These results establish that logical close does not guarantee immediate OS file-handle release. Windows deletion can remain blocked, and repeated same-process reopen can accumulate descriptors until native statement objects are collected. This does not establish lost transactions, failed logical reopen or data corruption. Process exit remains a deterministic OS resource-release boundary. A production change would require a separately reviewed upstream fix or explicit native lifecycle mechanism; no dependency upgrade is included here.

## Bounded test repair

The 11 memory persistence cases keep their names, parameter matrices and assertions. Their file-backed work runs in short-lived child processes. The parent waits for the child's `close` event, including cancellation and failure paths, before removing its disposable directory with `maxRetries: 5` and `retryDelay: 50`. A nonzero child exit preserves assertion diagnostics and fails the parent test. No cleanup exception is swallowed.

The reusable test-only process helper has focused coverage for confirmed child exit, propagated assertion failure and abort-error ordering. Its cancellation test uses a real child and a controlled abort error, releases the child through stdin, then verifies its exit marker and dead PID before accepting the rejection. It does not depend on platform-specific signal handlers. The memory cases also require an explicit completion marker after their assertions and store close. No production database behavior is replaced or mocked.


### Preserved assertion map

The parameterized tests use `it.for` so each case receives Vitest's cancellation signal. The same 4 sensitivity, 5 stale-target and 2 retention cases remain. The former assertions now execute in `memory-reopen-fixture.ts` with Node's strict assertions:

- Sensitivity: candidate existence; explicit result sensitivity; exact group statements after reopen; replacement sensitivity, scope, statement and lineage; exact supersedes array; retired predecessor.
- Stale target: promotion refusal; pending candidate after reopen; exact surviving active statements; total canonical row count including inactive records.
- Retention: unchanged TTL, absolute deadline and policy before reopen; the same metadata and active state after reopen; no active result at the original deadline; expired inspected state.

The parent additionally requires the child's completion marker. A child assertion failure produces a nonzero exit and fails the parent case with its diagnostic output. The process helper waits for `close` even when `error` signals cancellation, so cleanup follows actual process termination rather than an abort request.


### Dependency tracking

The parent statically imports the child entry's inert script URL. An explicit main-module guard prevents fixture execution during import. This retains Vitest's changed-test dependency graph without validator changes: targeting `memory-reopen-fixture.ts` through `vp test related` now selects the parent test file and passes all 34 cases. A fresh-process diagnostic, with only tsx's compilation cache disabled, verified zero fixture filesystem writes or child-process calls during import.
