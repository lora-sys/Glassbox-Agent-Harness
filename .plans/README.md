# Plans

This directory contains the active implementation plans and durable technical findings.

## Active plans

P3 completed on 2026-09-19.

P4A, P4B, and Issue #21 are complete. Issue #24 owns the current closeout before the next product phase:

```text
issue-24-closeout.md
  Issue #24
  Delivery-source reauthorization, Herdr Worker workspace occupancy, acceptance
```

The P4 and Issue #21 plans remain as completed architecture and acceptance records. This closeout does not implement P5 product behavior.

## Completed P4 plans

```text
04a-memory-taste.md
  Issue #9
  Memory / Taste durable learning truth

04b-authorized-retrieval-history.md
  Issue #10
  Authorized retrieval / QQ history search
```

## Read order for the current closeout

1. `../AGENTS.md`
2. `issue-24-closeout.md`
3. Issue #24
4. only the relevant files under `findings/`
5. current production code and focused tests

`README.md` defines product direction. `AGENTS.md` defines stable engineering and safety rules. The active plan and its Issue define the implementation scope.

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
