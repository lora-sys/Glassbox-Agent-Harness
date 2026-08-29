# Task: S3 fix — apps/server codex adapter initialize hang

apps/web is built (board projector + WS + UI), but the real apps/server /run-test hangs during the codex app-server initialize handshake (claude worked around it with a mock server at apps/web/mock-server.mjs). This ticket fixes the real adapter so /run-test works against a real codex app-server.

## Symptom
POST /run-test against apps/server (port 3030) hangs. The mock-server.mjs in apps/web was a workaround.

## Goal
Diagnose and fix the initialize handshake in apps/server/src/codex/adapter.ts so that POST /run-test completes: initialize -> initialized -> thread/start -> turn/start -> stream events -> turn/completed, and returns the event summary + sessionId.

## S1 verified protocol (must match)
- Send initialize request (protocolVersion, capabilities, clientInfo). Wait for the response (serverInfo, codexHome).
- Send initialized notification.
- thread/start with a client threadId, then receive thread/started with the server UUID.
- turn/start with input array + sandboxPolicy readOnly + cwd.
- Stream events to turn/completed.

## Steps
1. Read apps/server/src/codex/adapter.ts. Find why initialize hangs. Common causes: not waiting for the initialize response before sending initialized; not sending initialized at all; a JSON-RPC correlator bug that never resolves the initialize response; reading stdio line-by-line incorrectly; the app-server process not starting.
2. Fix it. Make the initialize handshake complete before thread/start.
3. Start apps/server (PORT=3030). POST /run-test with {prompt:"say ready"}. Confirm it returns within ~30s with a real event summary (item/agentMessage/delta count > 0, turn/completed with status). No hang.
4. Keep the readOnly sandbox and cwd /tmp/glassbox-codex-spike safety.
5. Do not touch apps/web in this ticket.

## Verify
- POST /run-test returns a real event summary from codex (not a hang, not a mock).
- The trace is written (GET /trace/:sessionId works).

## Scope and safety
- Only modify apps/server/src/codex/adapter.ts (and types.ts if needed). Do not modify apps/web, AGENTS.md, README, .plans.
- Codex turns readOnly + cwd /tmp/glassbox-codex-spike. Do not let codex write the user real filesystem.
- Do not touch ~/.glassbox/ or anything outside this repo and /tmp/glassbox-codex-spike.
- Follow AGENTS.md.

## When done
Print: the root cause of the hang, the fix, and the real /run-test event summary you got.
