# Task: S7 — Editable task field with a send button (browser-verified)

S6 added named actions on a session. Now add a simple local-change-then-send pattern for the task text.

## Goal
The task object has a text field the user can change in the Inspector. A local change is visually marked as not-yet-sent. A Send button uses the edited text to start a new turn on the same thread. A local change alone starts no turn.

## Steps
1. apps/web: in the Inspector for the task object, show a textarea for the task text. When the text differs from the sent value, show a small marker so the local change is obvious.
2. Add a Send button, enabled only when the text differs. Pressing Send starts a new turn on the same session/thread with the edited task text.
3. A local change alone starts no turn. Closing the Inspector or pressing Cancel restores the sent text.
4. After Send, the new turn uses the edited task. The Canvas shows the new task as sent, the prior task stays as the previous turn, and the trace gets an action.send record with the new text and an ISO timestamp (append-only, same shape as the S6 action records).
5. apps/server: add POST /send-task {sessionId, task} that starts a new turn on the session's thread with the task text and appends an action.send trace record. Reuse the S6 steer path; the difference is the object is the task.
6. Extend apps/web/e2e/run.spec.mjs: after a run, edit the task text, assert the marker shows, assert no new turn started yet, press Send, assert a new turn starts with the edited task, assert trace has action.send in order, reload and assert both turns rebuild.

## Verify
- A local change shows a marker and starts no turn.
- Send starts a new turn with the edited task on the same thread.
- trace has action.send with the new text and timestamp.

## Scope and safety
- Modify apps/server and apps/web as needed. Do not modify AGENTS.md, README, .plans, or Notion.
- Codex turns keep the readOnly sandbox and cwd /tmp/glassbox-codex-spike.
- Session data stays under <repo>/.glassbox/. Do not touch the user real ~/.glassbox/.
- Kill only processes you started, by PID.
- Follow AGENTS.md. Relative /api and /ws only.

## When done
Print: the editable object, the marker, the Send path, the Playwright result, and a screenshot path.
