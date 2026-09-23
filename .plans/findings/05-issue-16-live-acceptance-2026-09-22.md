# Issue 16 live QQ acceptance, 2026-09-22

This record covers the real QQ acceptance for Issue 16. It is dated host evidence, not a
replacement for the completion gate in Issue 16 or the stable rules in `AGENTS.md`.

## Test topology

- Delivery branch: `feature/16-tool-plane-grounding`, PR 18.
- OneBot connection: `p3-qq`.
- Bot QQ: `3394947361`.
- Dedicated test group: `1126022432`.
- Glassbox Owner QQ: `3526039967`.
- Provider runtime: Tencent-signed QQ 9.9.33 build 52230 with NapCat 4.18.28.
- Glassbox data directory: the existing isolated P4 acceptance state.

The system QQ installation was not modified. Login completed once after the isolated runtime
change. Later tests reused the authenticated session and did not refresh the QR code.

## Read-only capability probe

The management capability probe completed at `2026-09-22T07:15:07.589Z` against the dedicated
group. All six provider-backed calls succeeded:

1. group metadata;
2. member list;
3. one live history page;
4. notices;
5. essence messages;
6. root group files and folders.

The provider-free managed-group projection also succeeded. The report distinguished the local
projection from provider calls and stored only safe shapes, counts, status, and observation time.
No mutation action was used for Issue 16 acceptance.

## Exact-identifier Run and defect found

Run `327c7354-77f5-4b8a-b990-4ef0c22d40fe` was created by the Owner in the dedicated group with an
explicit request to search for `P4B-A-1349` and return its sender, time, and original text.

The Run recorded:

- `group_history_search` as required evidence;
- one successful `group_history_search` Tool call;
- query `P4B-A-1349` bound to `group:1126022432`;
- the real matching sender, timestamp, and original text from the Tool result;
- a successful required-evidence resolution and successful Run finish.

The live Trace also exposed a paging defect. Source coverage was `partial` with
`sourceLimits=["cursor_stuck"]`. The first provider page was archived, but the next request repeated
the page. The answer correctly retained the partial-coverage boundary, but it also narrated Tool
parameters and coverage metadata after the user had requested only three result fields.

## Root cause and correction

NapCat's pinned `GetGroupMsgHistory` action calls its input `message_seq`, but resolves that value
through its short-message-id map before querying QQ. Its returned `message_seq` is the short id and
is not a chronological counter. The old Glassbox adapter selected the numerically smallest id and
sent it back without `reverse_order=true`. On the live provider this reads forward and can repeat
the same page.

Commit `f582cd7` corrects the contract:

- select the chronologically oldest raw record by provider `time`;
- keep its short `message_id` as an opaque cursor;
- send the cursor with `reverse_order=true`;
- continue deriving the cursor from raw records so attachment-only pages can advance;
- stop safely when a usable provider sequence or timestamp is absent;
- tell the model to return only requested fields and not narrate internal Tool metadata unless the
  user explicitly asks for it;
- document the pinned NapCat paging behavior in `upstream/napcat/SOURCES.md`.

A direct read-only provider probe confirmed the corrected parameters. Starting from the oldest
message in a 100-message page, the reverse request returned 98 older messages, the cursor message,
and no newer message. The same request without the reverse flag reproduced the forward-page
behavior.

## First corrected live Run and second finding

Run `f4648845-5552-4c39-a4be-4a2e4f13d881` used the corrected reverse walk. It advanced through
four provider pages instead of repeating the second page. A direct provider walk reconstructed the
four pages:

- page 1: 100 records, 100 new;
- page 2: 99 records, 98 new plus the inclusive cursor;
- page 3: 49 records, 48 new plus the inclusive cursor;
- page 4: the inclusive cursor alone, with no new or older record.

The source was exhausted, but Glassbox classified the final cursor-only page as `cursor_stuck`.
The same Run returned the real identifier hit and successful Tool evidence, but the model still
narrated Tool counts and coverage metadata despite the requested three-field response.

The follow-up correction treats only a one-record, already-seen inclusive cursor page as
`end_of_source`. A larger repeated page remains `cursor_stuck`, so a provider that actually stalls
cannot be promoted to complete coverage. The Glassbox system prompt now also requires the model to
follow an explicitly requested response shape and forbids unrequested Tool diagnostics for a
positive match. Partial-coverage limits remain mandatory for absence or completeness claims.

## Complete-coverage Run and prompt-only failure

Run `69da35ca-e0f6-434f-9931-deedbe8513b6` proved that the paging correction worked. The real
provider walk read four pages and stopped at `end_of_source`. The resulting coverage was
`complete`, with no `cursor_stuck`, no source limit, and no retrieval truncation. Required evidence
and the concrete `group_history_search` call both resolved successfully.

The delivered response still violated the user's explicit field contract. It included result
counts, coverage state, internal guidance, and additional assertions after the user requested only
sender, time, and original text. It also called one message unique even though the Tool returned
multiple messages containing the identifier. This Run disproved the prompt-only correction: a
system instruction can guide response shape, but it cannot enforce it.

Commit `e3a3f4c` moves that narrow contract below the model:

- a single segmented identifier in an explicit current-group history search is bound into the
  required Tool input, so a call for a different query cannot satisfy the Run;
- when the current message explicitly requests only supported exact-history fields, the final text
  is projected from the successful Tool's structured details rather than model-authored prose;
- the projection emits only the requested group, sender, time, and original-text fields;
- if the Tool result cannot prove any requested field, the Run fails closed instead of falling back
  to the model's answer;
- the retry path collapses the exact required call and its generic evidence requirement into one
  call, so the model is not told to run the same search twice.

Coverage, counts, and source-stop evidence remain present in the Tool result and Raw Trace. The
physical reply projection limits only delivery for the user's explicit narrow field contract.

## Runtime recovery findings

The next live confirmation first exposed two local service recovery problems rather than an Issue
16 retrieval failure.

The saved NapCat launch configuration pointed at the auto-updated system QQ 9.9.36 build 53489.
NapCat 4.18.28 reported that architecture as unsupported, and the QQ account later became offline
while the local OneBot socket still existed. The acceptance runtime was restored with the tested
isolated QQ 9.9.33 build 52230. The local launch configuration now pins that executable instead of
the system installation.

After login recovery, Run `706697fc-686c-4fe9-a011-4715650d9ec7` finished as `unknown` before any
Pi or Tool event. The manually started Glassbox process had `GLASSBOX_DATA_DIR` but omitted
`LORA_PI_KIT_PATH`, so the service accepted the QQ message but could not create the Pi session.
The service was restarted with the complete configured environment. The development documentation
now directs normal recovery through `npm run agent:up`, requires the Pi Kit path for `pi:*`
executions, and requires a tested isolated QQ executable for NapCat.

## Exact-text projection finding and correction

Run `df7da3c5-276f-4ead-8f6f-6d7938d5ec5d` proved that the physical field projection executed. It
removed model-authored diagnostics and emitted only sender, time, and original text. It still
projected every history message that contained `P4B-A-1349`, including old bot replies and search
requests. The first projected record was therefore a bot message rather than the bare canary
message.

The cause was a contract mismatch. Retrieval correctly uses identifier containment to avoid token
near-matches, while the user's phrase `精确查找` required the whole message text to equal the
identifier. The delivery projector reused the containment rule and had no exact-text mode.

The staged correction keeps retrieval broad enough to find every evidence-bearing match, then
applies an exact-text filter only for an explicit strict reply request that says `精确查找`,
`精确匹配`, `完全匹配`, or the corresponding English exact-match phrase. Case, full-width
characters, and surrounding whitespace do not change the identifier. Commentary before or after
the identifier does. If no exact-text record remains, the projector returns the bounded negative
form allowed by the Tool coverage instead of falling back to model prose.

## Repository verification

The first correction's focused history, management, and Tool-result suites passed 98 tests. Its
complete commit gate then passed:

- core check: 249 files;
- unit tests: 76 files passed, 1 skipped; 1100 tests passed, 1 skipped;
- deterministic end-to-end: 54 tests passed;
- regression: 93 tests passed;
- Web build: passed.

The physical reply correction's complete commit gate also passed:

- core check: 249 files;
- unit tests: 76 files passed, 1 skipped; 1105 tests passed, 1 skipped;
- deterministic end-to-end: 55 tests passed;
- regression: 93 tests passed;
- Web build: passed.

The exact-text projection correction's complete commit gate passed on the stacked Issue 17 branch:

- core check: 250 files;
- unit tests: 76 files passed, 1 skipped; 1128 tests passed, 1 skipped;
- deterministic end-to-end: 60 tests passed;
- regression: 101 tests passed;
- Web build: passed.

## Final live confirmation

Run `99ea6e67-b704-41cb-8159-bbb45c99bd4d` completed the final real QQ confirmation. The Owner
asked the Agent to search the current group for `P4B-A-1349` exactly and return only sender, time,
and original text. The Run recorded the required `group_history_search` input with query
`p4b-a-1349`, completed the real provider walk through four pages, and observed
`stop="end_of_source"`. The complete search returned 24 containment matches without a source
limit. Both concrete Tool calls succeeded, the required Tool evidence resolved successfully, the
Run finished as `succeeded`, and delivery reached `sent`.

The physical projector removed the 23 containment-only search requests, reports, and bot replies.
The delivered text contained exactly one record and only the requested fields:

```text
发送者：3526039967（lora）
时间：2026-09-20T13:48:07.000Z
原文：P4B-A-1349
```

This confirms the complete Issue 16 live path: authenticated QQ delivery, required Tool use, real
history paging to the provider boundary, exact-message filtering below the model, bounded field
projection, successful Run completion, and successful delivery.

## Fresh read-only capability probe

On 2026-09-23, the service was started with `npm run agent:up`. Glassbox reported ready, the
configured channel `p3-qq` connected to NapCat, and its Bot ID matched `3394947361`. The explicit
read-only probe targeted only dedicated test group `1126022432` at `2026-09-23T05:05:59Z`.

All six provider-backed calls succeeded. The managed listing also succeeded without claiming a
provider read:

| Tool | Operation | Outcome | Safe result shape | Raw Trace seq |
| --- | --- | --- | --- | --- |
| `qq_groups` | managed listing | success, not provider-backed | object: `connectionId`, `groups` | 106 |
| `qq_groups` | `get_group_info` | success | object with six metadata fields | 107 |
| `qq_group_members` | `get_group_member_list` | success | array, 4 members | 108 |
| `qq_group_history` | `get_group_msg_history` | success | object: `messages` | 109 |
| `qq_group_content` | `_get_group_notice` | success, empty | array, 0 items | 110 |
| `qq_group_content` | `get_essence_msg_list` | success, empty | array, 0 items | 111 |
| `qq_group_files` | `get_group_root_files` | success | object: `files`, `folders` | 112 |

The events are persisted as `capability.probed` in the Glassbox task Trace with Principal,
timestamp, target group, provider outcome, and result shape. They do not include message text or
member profiles. This probe does not cover an exact-identifier `group_history_search` Run; the
successful end-to-end exact search above remains its separate evidence.

For local startup, `docs/tech-stack.md` now uses `npm run agent:up/status/logs/down`. On Windows,
`vp run agent:up` cleans up its detached service child after the Vite+ task exits. Isolated
verification confirmed the npm commands leave the service running until `down` stops it.
