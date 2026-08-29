# Task: S5 — Refresh and reopen a Run without losing understanding (browser-verified)

S2-S4 are done: apps/server writes an append-only Raw Trace per session and derives state deterministically from it; apps/web projects derived state onto a tldraw Canvas with an Inspector. This ticket proves the Glassbox persistence rule end to end in the browser.

## Glassbox rule being verified
A browser refresh must not be treated as stopping a Run. Reopening a completed run must still let the user understand what happened. Reconstruction must come from Raw Trace and derived state, never from Canvas layout. (Notion: Runtime, Codex and Trace; AGENTS.md.)

## Goal
After a run finishes, reloading apps/web (or opening it with a session id) rebuilds the same Canvas objects from the trace, and the Inspector still works. No Canvas layout file is used as the source of truth.

## Steps
1. apps/web: persist the current sessionId across reloads. Use a URL search param (for example /?session=<id>) kept in sync as the run progresses, and also remember the last sessionId in localStorage. On load, if a sessionId is present, fetch GET /state/:sessionId and GET /trace/:sessionId and project the rebuilt objects onto the Canvas without starting a new run.
2. Add a small session control so a user can reopen a past session by id (a compact input or a recent-sessions list backed by the server; a compact input is enough for P0).
3. Reconstruction must read only trace and derived state. Do not add any layout persistence that becomes the source of truth. If you persist positions, they must be a cache only, and the view must still rebuild correctly with that cache deleted.
4. If a run is still active when the page reloads, the page should resubscribe to /ws for that sessionId and continue receiving live updates rather than showing a stale or finished state. Do not fake completion.
5. Extend apps/web/e2e/run.spec.mjs:
   - Run test, wait for task and result shapes.
   - Capture the shape texts.
   - page.reload() (with the session id preserved in the URL).
   - Assert the same task, result and trace shapes reappear from the trace with no new run started (assert the server received no second /run-test).
   - Select the result shape and assert the Inspector still shows status and duration.
   - Also assert the layout cache is not the source: delete the cache (or run with it disabled) and the shapes still rebuild.
   Keep iterating until all assertions pass.

## Verify
- Reload restores the full object set from trace, identical texts to before the reload.
- No duplicate Run is triggered by the reload.
- Inspector works after reload.

## Scope and safety
- Only modify apps/web, plus a read-only server endpoint only if something is genuinely missing (prefer none). Do not modify AGENTS.md, README, .plans.
- Codex turns keep the server readOnly sandbox + cwd /tmp/glassbox-codex-spike. Do not let codex write the user real filesystem.
- Do not touch the user real ~/.glassbox/. Session data stays under <repo>/.glassbox/.
- Kill only processes you started (dev servers, chromium), by PID.
- Follow AGENTS.md. Relative /api and /ws only.

## When done
Print: how the sessionId survives reload, the Playwright assertion results, and a screenshot path.
