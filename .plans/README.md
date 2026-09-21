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

## Next plans — P5

P5 planning is frozen now so two developers can start from the same boundary immediately after P4 completes.

Production implementation MUST NOT begin from the pre-P4 main baseline. First merge/complete P4A and P4B, rerun their completion gates, then cut both P5 branches from the same post-P4 commit.

~~~text
P5A
  .plans/05a-context-budgeting-runtime-efficiency.md
  Issue #13
  owns Context / Tool / token budgeting and projection

P5B
  .plans/05b-routing-runtime-observability.md
  Issue #14
  owns routing / thinking choice / usage / health / Ops observability / routing Eval
~~~

Shared handshake:

~~~text
P5A ContextDemandEstimate
→ P5B RoutingDecision + ModelCapacity
→ P5A final ContextBudget / projection
→ Pi
→ P5B actual usage / health / Eval
~~~

The streams develop core logic in separate leaf modules and use deterministic sibling fixtures. Shared integration hotspots such as Pi adapter, management composition, contract barrel exports and schema changes are integrated serially after rebasing, not edited as two competing implementations.

Upstream review: .plans/findings/05-p5-upstream-review-2026-09-21.md.

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

## Read order for P5 implementation

After the P4 completion gate:

~~~text
AGENTS.md
→ .plans/05a-* or .plans/05b-*
→ matching Issue #13 / #14
→ .plans/findings/05-p5-upstream-review-2026-09-21.md
→ relevant upstream SOURCES.md + reviewed source paths
→ post-P4 production code + focused tests
~~~

Do not revive pre-P4 Context/retrieval assumptions from old history.

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
