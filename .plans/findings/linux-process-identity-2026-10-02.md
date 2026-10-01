# Linux service process identity

Audit M1. The former lowercased substring check accepted unrelated argv suffixes, wrong case, reordered/extra arguments and reused PIDs. This repair uses exact NUL-separated argv, a canonical executable path and a persisted Linux boot ID/start-time token. The token is rechecked around executable/argv inspection and before escalation.

Alive processes whose ownership cannot be established are unknown, not stopped. Up, down, checkout switch and rollback preserve their records and refuse to start a conflicting replacement or signal an unverified process. A zombie is treated as exited. Windows and named Herdr session behavior remain separate.

66 focused tests passed, covering legacy records, PID reuse, unreadable procfs, permission denial, unsafe argv, startup/rollback paths, Windows and named-session behavior. Changed-file lint/types and diff checks passed. A read-only check against the test Node process verified real procfs identity; no real signals or production service changes were used. Aggregate gates remain pending.

Node's signaling API still targets a numeric PID. There is a narrow kernel check-to-signal race; this repair does not claim atomic pidfd signaling. Historical records without a birth token cannot be safely adopted automatically. M2/M3 migration and environment findings are outside this patch.
