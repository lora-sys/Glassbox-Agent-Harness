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

## Repository verification

The first correction's focused history, management, and Tool-result suites passed 98 tests. Its
complete commit gate then passed:

- core check: 249 files;
- unit tests: 76 files passed, 1 skipped; 1100 tests passed, 1 skipped;
- deterministic end-to-end: 54 tests passed;
- regression: 93 tests passed;
- Web build: passed.

## Remaining confirmation

After the follow-up correction is deployed through the stacked Issue 17 checkout, one final QQ Run must
repeat the exact-identifier request and confirm both of these observable results:

1. source coverage no longer stops at `cursor_stuck`;
2. the delivered answer contains only the requested sender, time, and original text.

Until that Run is recorded, the code and deterministic gate are complete, but the exact-identifier
live acceptance remains open.
