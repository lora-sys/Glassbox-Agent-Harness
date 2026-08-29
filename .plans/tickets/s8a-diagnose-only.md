# Task: S8a — Diagnose only (curl, no code change, no e2e)

Do NOT modify source files. Do NOT run Playwright e2e. Run the server and curl to diagnose, then report. Read-only.

## Steps
1. If port 3030 is taken, start apps/server on PORT=3031 (or another free port). Capture the PID.
2. POST the demo task to the demo workspace endpoint (runs codex against /tmp/glassbox-demo-repo). Print the sessionId. Use the right base URL for your port.
3. Poll GET /state/:sessionId until finalResult is set or 60s pass.
4. GET /state/:sessionId — print full derivedState JSON (task, artifacts, finalResult, turns, currentWork, testResult).
5. GET /trace/:sessionId — print event method names in order.
6. Answer: Is state.task empty and why? Is state.artifacts empty (did item/fileChange fire; did an approval fire and was it answered)? Is state.finalResult set?
7. Kill the server PID you started. Leave the repo unchanged.

## When done
Print: the port used, the derivedState JSON, the event method list, and the three answers. Do not modify files.
