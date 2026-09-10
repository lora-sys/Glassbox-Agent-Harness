# Plans

This directory holds current implementation plans and durable technical findings.

## Current status

Plan 01 and Plan 02 were completed historical phases from the earlier canvas-first coding-agent workbench. They were removed from the active tree during the Personal Agent reset. Their full text remains available in Git history.

The current product direction is defined by `README.md`. Stable engineering and safety rules live in `AGENTS.md`.

Create a new numbered plan only when implementation of the next product slice actually starts. Do not keep an old phase in the active tree merely because it once described the roadmap.

## Keep here

- active numbered plans
- reusable technical findings
- provider and protocol spikes with evidence
- acceptance measurements worth reusing
- architecture decisions that still constrain current implementation

## Do not keep here

- completed ticket scratch files
- commit chores
- one-off debugging breadcrumbs
- copied roadmap status that is no longer current
- generated logs or test output

`findings/` is intentionally retained. It contains verified evidence about the existing runtime, providers, Raw Trace, Derived State, WebSocket contracts, and performance behavior. Treat those files as historical technical evidence, not as the current product roadmap.
