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

For a verified history-family lesson, select the final history-seed-recall or history-cross-group-private-exclusion Run. The verifier reconstructs both fixed stages and independently reads the archived successful Runs, authorization, stored inputs, sent text payloads, source archive, Raw Trace and lease cleanup audit. It requires the stored reply payload digest to match the reported actual reply digest and checks the exclusion fixture without retaining its text. Only direct text/result deliveries of at most 3500 Unicode codepoints are supported; merged-forward replies require their own archived node proof. Unsupported payload types, missing stages or fields, inconsistent hashes and unconfirmed revocation remain unverified. The verifier also checks the clean checkout and current service identity before and after reading, using the same recorded commit and PID. Both QQ accounts must be online so the verifier can independently re-read the existing input and reply messages. This path calls only get_msg and does not send or modify messages. A report from a replaced process or checkout remains a hypothesis because there is no independent historical service identity proof. An archived lesson never satisfies fresh QQ acceptance or delivery gates. Deleting family metadata or source assertions cannot downgrade verification to the single-Run path.

History-family verified records additionally require the existing local QQ configuration and its token environment variables. Reuse the acceptance configuration; do not copy token values into a report or lesson.

```bash
node .agents/skills/qq-live-testing/scripts/record-lesson.mjs --input <json-file> --config <local qq-live config>
```

The configuration must match the report's accounts, groups, runtime checkout, data directory and tested commit. Missing independent QQ message reads or a configuration mismatch refuses verified registration. Hypotheses still use the original command without QQ connections.

The qq-live CLI also exposes record-lesson --input <json-file> with its existing --config. Use this entry point when the protected acceptance launcher supplies Token environment variables. It rejects --live, case, output and PR options. Registration still performs independent checks before appending to the project skill; it does not execute a regression or merge.
