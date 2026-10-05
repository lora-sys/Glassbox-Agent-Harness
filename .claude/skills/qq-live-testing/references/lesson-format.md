# Lesson format

`record-lesson.mjs` accepts one JSON object and appends an allowlisted record to `lessons.jsonl`:

```json
{
  "case": "group-A.reply",
  "commit": "0123456789abcdef0123456789abcdef01234567",
  "status": "hypothesis",
  "evidence": { "type": "run", "runId": "run_example123" },
  "symptom": "The expected reply did not arrive.",
  "lesson": "The test service was running from another checkout.",
  "nextStep": "Confirm the active checkout before matching the Run."
}
```

This form records an unverified finding. Use `status: "hypothesis"` until evidence verifies the cause. A preflight that stops before a Run must use `"evidence": { "type": "preflight_error", "errorCode": "SERVICE_NOT_READY" }`. Both forms require a case identifier and the full tested commit SHA. A caller cannot set `verified` by supplying a Run ID. A verified record also requires a local `qq-live` report path and its SHA-256 in the same JSON object:

```json
"verification": {
  "type": "qq_live_report",
  "reportPath": "<local report.json path>",
  "reportSha256": "<sha256 of the exact report file>"
}
```

The helper checks report and product-acceptance PASS fields, a clean workspace and running service on the exact commit, the matching case and Run, ALLOW decisions, sent delivery, message bindings, and the report hash. It then asks the existing `gbxtrace events` command to confirm the reported input and delivery events. The test uses a disposable report and trace fixture. If any check fails, do not label the lesson verified.

Save the JSON in a local temporary file, then run:

```bash
node .agents/skills/qq-live-testing/scripts/record-lesson.mjs --input <json-file>
```

The helper rejects unknown fields, credential patterns, phone or QQ identifiers, numeric personal IDs, quoted text, and common conversational phrases. It stores only the listed fields. Do not put message text, account details, screenshots, tokens, or paths in the description fields. Review each proposed record before appending it. Lessons are append-only. Never edit an old record to make it match a newer conclusion.
