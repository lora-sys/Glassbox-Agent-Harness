# Issue #156 documentation freshness

Status: DOCUMENTATION RECONCILED against committed `main` at `176ea9faa34a2f736f4564cdfc29d2a240006153`, checked 2026-10-06. Verification results belong in the fixing PR. This record does not claim new live QQ acceptance or change runtime authorization.

Issue: https://github.com/lora-sys/Glassbox-Agent-Harness/issues/156

## Scope and source rules

The original audit included the author's uncommitted working tree. This change documents the published source tree. Code, remote issue state, merged PR metadata, and recorded acceptance evidence take precedence over the audit's line numbers or counts.

- P5A/P5B completed and Issues #13/#14 closed on 2026-09-27. Their plans retain the original implementation sequence as history.
- Issue #24 remains open. Its implementation has merged, but real QQ Owner delegation acceptance is still required.
- Issue #33 closed on 2026-09-30. Plan 06 retains unmet Linux-native and real QQ gates under Issue #30, which remains open.
- PR #136 merged on 2026-10-02. The audit-remediation plan's old per-slice publication notes are historical; outstanding live acceptance is not inferred from the merge.
- Issue #20 is closed with the accepted deferrals recorded in its plan. README links to that evidence rather than claiming universal Web acceptance.
- Issue #123 closed the repository planning task. It did not by itself prove all Owner/group pilot scenarios complete.

## Reconciled documentation

- AGENTS, README, the roadmap and plan status headers distinguish implementation from acceptance. The implementation and documentation indexes include the omitted plans, migration/sandbox/archive/deployment documents and the committed `glassbox-ops` skill.
- Agent operations describes the implemented durable long-work subsystem, current Ops tool list and actual HerdrBridge interface. Task acceptance remains separate from workflow or Worker completion.
- The Trace reference records missing events and provenance producers. Both committed skill copies are kept in sync.
- Storage documentation describes local libSQL/SQLite through `@libsql/client`, with Turso compatibility. It does not imply a configured remote Turso service. The current schema is v29, including `runs.channel_default_execution_ref`.
- Learning documentation identifies `apps/server/src/learning/`, MemoryCandidate/CanonicalMemory and the `glassbox:taste` extension. Conceptual TasteEntry/OwnerInsight names are not presented as implemented tables or types.
- Upstream documentation distinguishes tracked source records from ignored local checkouts and links existing t3code production-port pin/license records while distinguishing the absent manifest entry and uninspected local checkout. UI documentation identifies the canonical design entry and the secondary implementation review materials.

## Local-only and deferred findings

### Management network boundary

Committed `management/access.ts` accepts only IPv4/IPv6 loopback, and `index.ts` binds to `127.0.0.1`. The issue's proposed `192.168.3.*` / `172.*` allowance and `0.0.0.0` listener are not in this base. The documentation therefore retains the authenticated loopback-only contract. No network or permission setting changes here.

If the LAN changes are published later, their own commit and review must describe the expanded reachability, exact allowed source ranges, authentication and origin checks, deployment/network assumptions, and negative tests. Update the management documentation with that implementation, not in advance of it.

### Local NapCat files

None of `qr_*.png`, `napcat-*.png`, `test_napcat.sh`, `tmp_napcat_login.sh`, or `scripts/send-qq-test.mjs` is tracked in this base. The cloud checkout does not contain the original author's untracked files. No local login artifacts or scripts were copied, deleted, or published. Cleanup of that other working tree remains a separate local operation.

## Verification contract

Run `vp run verify:commit` on the staged changes and `vp run verify:full` before opening the PR. Review Markdown targets, exact Ops tool names, the schema version and Trace event/provenance names against source. Keep dependency or environment failures distinct from passing checks. This documentation-only change does not require sending live QQ messages, switching a service, or changing credentials.
