# Issue 139 personal website knowledge and learning progress

Status: IMPLEMENTED; live acceptance outstanding

Issue: https://github.com/lora-sys/Glassbox-Agent-Harness/issues/139

## Scope

One Personal Agent uses a versioned public website corpus in Owner private, Visitor private and authorized QQ group Runs. Related answers may recommend an exact published article. A trusted QQ identity can resume its own group learning progress in private chat. Existing group Memory stays group-scoped.

## Contracts

- Website documents are separate from Canonical Memory. Sync is an explicit Owner action. Complete sync retires removed versions; incomplete sync preserves the last verified corpus and reports its age. Only the configured HTTPS site and published canonical article routes are accepted.
- Retrieval authorizes source and audience before loading bounded content. Successful reads register delivery dependencies. Article retirement, progress correction/deletion, identity remap and grant revocation invalidate subsequent provider requests and pending delivery.
- Learning progress is a source-bound personal projection. Persisted current messages provide evidence. Explicit goals are observations; repeated questions are weak cues. Neither is a confirmed preference. Explicit confirmation is required for a confirmed record. No model-supplied actor, source scope or message reference is trusted.
- Group Context includes only the current sender's progress from that exact group. Private Context includes that identity's own records only when both current private authority and current source authority permit it. Other people, group Memory and private Owner Memory cannot travel with it.
- Self-service inspection, confirmation, correction and deletion use exact commands in the persisted current Run input. Default group replies do not narrate previous questions. Website-derived Owner preferences use the existing pending candidate and Owner review mechanism.

## Implementation

1. Add website storage, versioned sync and authorized lexical retrieval using existing network guards and retrieval tokenizer.
2. Add source-bound progress storage, persisted-input capture and self-service Actions with identity and source rechecks.
3. Integrate schema, application provisioning, bounded runtime Context, explicit commands and evidence. Optional data is included in the existing Context budget and re-authorized before provider calls.
4. Run focused isolated tests, independent code review, commit verification and full verification. Create one PR linked to #139.

## Acceptance

- Website create/update/removal, canonical deduplication, malicious targets, incomplete sync and database reopen.
- Relevant article retrieval across private/group scopes; no forced link for irrelevant questions; retired versions fail reauthorization.
- No inferred article topic automatically becomes an Owner preference.
- Trusted sender group-to-private progress continuity, third-party denial, exact group isolation, nickname changes, identity unbind/remap and grant revocation.
- Capture excludes quotes, URLs, secrets and third-party content. Repeated questions remain weak evidence. Inspect/confirm/correct/delete is persisted and prevents stale Context reuse.
- All deterministic fixtures use disposable state. Real QQ ingress, article recommendation, same-user private continuation and final delivery require separate fresh message/Run/Trace evidence. Linux production readiness remains subject to #30 and cannot be inferred from tests.

## Verification record

- Focused website suite passed 11 tests. Progress and runtime suites passed 258 tests. Application coordinator passed 5 tests, including pending delivery after article removal. Schema upgrade/reopen passed. Management composition and routing suites passed.
- Independent review found and fixed inverted input filtering, omitted-context evidence, article incarnation reuse, sync commit authorization races, and optional Context budget accounting. Ordinary model routing was checked after limiting command dispatch to explicit commands.
- Commit and full delivery gates must pass before PR creation. The linked PR records final gate results. Real QQ messages, private continuity and outgoing delivery remain untested for this slice.
- A disposable live website sync attempt stopped at the existing DNS safety guard with `knowledge_network_target_denied`. No guard bypass or live data writes occurred. Source availability must be verified in the intended deployment environment.
