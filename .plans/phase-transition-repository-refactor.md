# Plan: Repository Modularization Before the Next Product Phase

Status: ACTIVE

Tracking Issue: #21

## Goal

Improve server module boundaries, test organization, and validation speed before starting the next product phase. This plan changes engineering structure and verification workflow only. It does not implement P5 features or modify frontend pages.

## Stable invariants

- Authorization stays before protected data enters retrieval candidates or Runtime Context.
- Delivery authorization remains separate from read authorization.
- Conversation, Session, Run, Task, and TaskAttempt remain distinct.
- Raw Trace remains append-only evidence.
- Store transactions and durable state transitions remain atomic.
- Existing tests and assertions are preserved. No test is removed, skipped, isolated, or weakened to make the refactor pass.

## Implementation order

### 1. Validation workflow

- Remove duplicate execution of test files from the commit gate.
- Add a focused commit gate that checks staged code and tests related to the current change.
- Fall back to the full relevant suite when the change affects shared contracts, authorization, persistence, runtime setup, test configuration, or when impact cannot be determined.
- Keep a separate full verification command for completion and pull-request acceptance.
- Report changed paths, selected test scope, and full-suite fallback reasons.
- Reuse prior successful results only when the test dependency graph, code, fixtures, configuration, toolchain, and relevant environment inputs are unchanged.

### 2. Narrow domain boundaries

- Move shared domain-store assembly out of the persistence entry point.
- Replace Retrieval's broad cross-domain store dependency with a narrow port.
- Keep authorization policy in its owning domain and prevent Retrieval from depending on Management implementation details.

### 3. Split oversized coordinators

- Extract Management HTTP routing behind an explicit route dependency interface.
- Cover each extracted boundary with focused tests while preserving route behavior and authorization rechecks.

### 4. Improve test module structure

- Split the oversized Management application suite by behavior.
- Share its isolated fixture while giving each behavior suite its own cleanup scope.
- Use unique temporary state per test or suite and clean it up deterministically.
- Retain end-to-end tests for cross-module behavior.

### 5. Review stateful stores

- Review Learning, Conversation, and Task storage boundaries.
- Do not split a store solely because of file length or across transaction boundaries.
- Leave store extraction for a separate change when an independently testable workflow boundary is established.

## Deferred boundaries

The large HTTP/session coordinator in `apps/server/src/index.ts`, the Pi Tool plane, and further stateful-store decomposition are not part of this refactor slice. They need separate boundary designs and focused acceptance matrices. No P5 behavior is implied by that follow-up work.

## Completion gate

- Focused tests cover each extracted module boundary.
- Existing Management scenarios remain byte-for-byte unchanged when moved into behavior suites.
- Existing authorization, persistence, Run, Task, delivery, and Trace behavior remains covered.
- The full deterministic suite runs once in the full gate, without duplicate suite execution.
- A successful unchanged test result is reused only with a matching input fingerprint. Unknown impact runs the full relevant suite.
- Hooks, command documentation, active-plan references, and toolchain requirements match the implementation.
- The branch contains no P5 product feature work.
