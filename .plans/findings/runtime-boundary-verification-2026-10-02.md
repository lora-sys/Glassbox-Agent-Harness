# Runtime boundary repair verification

This reviewed combination contains M1 (Linux process ownership), W3 (Web caller cancellation), and DATA04/DATA05 (workspace artifact snapshots), built on the reviewed Web provider-result repair 82729f4. The three component patches applied without source conflicts.

Final production/test tree before this results note: 55bc158e10ec38e6547d0452aef54b65d0db05f0. All source and test files stayed unchanged during the gates.

- Commit gate: exit 1, 2,182 passed, 15 unchanged Unix-socket listen EPERM failures, one existing skip
- Full gate: exit 1, the same 2,182 passes and 15/1 restriction/skip
- Core lint/types, Web types and validator/selector checks passed in the full gate
- Separate Web build: exit 0
- Repository hygiene using pinned npm 12.0.2: exit 0
- Text portability: exit 0 across 691 text files before this note

Focused component coverage passed 66 process/environment tests, 158 Web/Tool tests, and 65 Git/platform/adapter tests. These overlap existing tests and must not be added to the full-suite count. The new process fixture uses native path construction even when it simulates Linux process state on a Windows runner.

Limits remain explicit in each findings document: numeric PID signaling is not atomic pidfd signaling; DNS and initial browser-session acquisition cannot be interrupted through the existing ports; artifacts are bounded observations, not a complete filesystem journal or proof of actor identity. Credential-like paths get no content preview, but filename filtering is not a complete secret detector. No live service, provider, QQ action or configuration was changed. CI for the published commit is still required; local socket restrictions are not counted as passed.
