# Plans

This directory contains the active implementation plan and durable technical findings.

## Active plan

`03-personal-agent-foundation.md` is the only active plan.

Its goal is to establish the first durable Personal Agent foundation:

```text
Identity
  ↓
Authorization
  ↓
Conversation
  ↓
Turso persistence
  ↓
Run / Authorization Trace
```

Authorization is P0. Do not start real WeChat, QQ, Mail, Calendar, Memory consolidation, Skill evolution, LongTask, Eval, Arena, or AGY integration before Plan 03's completion gate is satisfied.

## Read order for implementation

1. `../AGENTS.md`
2. `03-personal-agent-foundation.md`
3. only the relevant files under `findings/`
4. the relevant upstream source or documentation
5. current production code and focused tests

`README.md` defines product direction. `AGENTS.md` defines stable engineering and safety rules. The active plan defines the current scope.

## Historical phases

Plan 01 and Plan 02 were completed phases of the earlier canvas-first coding-agent workbench. They and their completed Ticket files were removed from the active tree. Their full history remains in Git.

Do not restore old plans merely to preserve history.

## Keep here

- one active numbered plan unless parallel work is explicitly intentional
- reusable technical findings
- provider and protocol spikes with evidence
- performance measurements worth comparing later
- architecture decisions that still constrain current work

## Do not keep here

- completed Ticket scratch files
- commit chores
- generated logs
- test output
- debugging breadcrumbs that are already represented by code or tests
- copied roadmap status that is no longer current

`findings/` is intentionally retained as historical technical evidence. A finding is not permission to expand the current plan.