# Plans

This directory contains the active implementation plans and durable technical findings.

## Active plans

P3 completed on 2026-09-19.

P4 is intentionally split into two parallel implementation streams:

```text
04a-memory-taste.md
  Issue #9
  Memory / Taste durable learning truth

04b-authorized-retrieval-history.md
  Issue #10
  Authorized retrieval / QQ history search
```

This is an intentional exception to the normal one-active-plan rule. The two streams have separate ownership and should land through separate PRs.

Shared boundary:

```text
P4A
  writes and manages durable Memory / Taste truth

P4B
  reads authorized history / Memory / Taste
  ranks and projects retrieval results
```

Neither stream may silently absorb the sibling stream.

## Read order for P4 implementation

1. `../AGENTS.md`
2. the owned P4A or P4B plan
3. the matching GitHub Issue
4. only the relevant files under `findings/`
5. the relevant upstream source or official documentation
6. current production code and focused tests

For P4A also read:

```text
../docs/memory-taste.md
../upstream/mgp/SOURCES.md
../upstream/command-code/SOURCES.md
../upstream/openharness/SOURCES.md

Issue #9 contains the exact LangMem, OpenHarness and
Learning-Multi-Factor-Memory source paths to port.
```

For P4B also read:

```text
../upstream/mgp/SOURCES.md
../upstream/opensquilla/SOURCES.md
../upstream/openharness/SOURCES.md

../apps/server/src/auth/
../apps/server/src/conversation/
../apps/server/src/channels/onebot/

Issue #10 contains the exact retrieval source paths and tests to port.
```

`README.md` defines product direction. `AGENTS.md` defines stable engineering and safety rules. The owned active plan and its Issue define the implementation scope.

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
