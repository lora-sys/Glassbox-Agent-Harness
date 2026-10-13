# Plans

This directory contains implementation plans, completed acceptance records, and durable technical findings.

## Current implementation scope

No numbered implementation Plan is active. P3, P4A, P4B, the Issue #21 repository refactor, P5A, P5B, and the implementation of Issue #24 are complete.

Issue #24 remains open for real QQ Owner delegation acceptance. Issue #30 tracks the Linux-native acceptance prerequisite. Keep the completed plans below as architecture and acceptance records. Select new implementation work from an open Issue in `roadmap.md` and its linked plan, when one exists.

## Completed P4 plans

```text
04a-memory-taste.md
  Issue #9
  Memory / Taste durable learning truth

04b-authorized-retrieval-history.md
  Issue #10
  Authorized retrieval / QQ history search
```

## Read order for a selected Issue

1. `../AGENTS.md`
2. The active Plan, when one exists. Otherwise select the open Issue from `roadmap.md` that owns the requested work.
3. The selected Issue and its linked plan, when one exists.
4. The relevant architecture document from `../docs/`.
5. Only the relevant files under `findings/`.
6. Relevant upstream sources, then current production code and focused tests.

`README.md` defines product direction. `AGENTS.md` defines stable engineering and safety rules. An active Plan and its Issue define implementation scope. When no active Plan exists, the selected open Issue and `roadmap.md` define scope.

## Historical phases

Plan 01 and Plan 02 were completed phases of the earlier canvas-first coding-agent workbench. Their history remains in Git.

Plan 03 established the first usable QQ Personal Agent and Agent Operations closed loop. It is retained because P4 depends on its trust, Conversation, persistence, Tool and Delivery contracts.

`03-plus-owner-control-smoke.md` records the completed P3 closeout.

## Keep here

- active numbered plans
- reusable technical findings
- provider and protocol spikes with evidence
- performance measurements worth comparing later
- architecture decisions that still constrain current work

## Do not keep here

- completed Ticket scratch files
- commit chores
- generated logs
- test output
- debugging breadcrumbs already represented by code or tests
- copied roadmap status that is no longer current

`findings/` is intentionally retained as historical technical evidence. A finding is not permission to expand the owned active plan.
