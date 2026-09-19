# P3 host implementation evidence

The user canceled AGY execution and assigned implementation directly to Codex. All changes remain on the existing P3 worktree and branch. This record does not mark P3 complete.

## Verified changes

- The real Pi SDK executes a deterministic local provider through createAgentSession with the isolated Kit fixture. SDK execution is verified; a real external model conversation is still required.
- Pi enables only explicitly registered custom tools. Trace persistence failures fail the Run. Visitor trace routing uses the persisted Run actor and current trace:write authorization.
- OneBot private responses target the admitted sender. Cross-account private targets and Bot-as-Visitor configuration are rejected.
- Delivery creation, reservation and transition require a separate delivery:send grant. This does not yet prove protected output provenance and audience enforcement.
- Delegation no longer manufactures Worker control or Task acceptance grants. Ops summaries filter Task, Attention and Worker counts by current task:read grants.
- Rework starts a new Worker pane and checks worker:prompt separately. Delayed completion from the prior pane cannot complete the new attempt.
- Accept and Rework preserve the prior execution result and completion timestamp.
- Durable Ops Trace sequences come from SQLite. TaskStore no longer publishes an uncommitted in-memory trace copy.
- Missing or disconnected active workers become unknown without changing Task acceptance.
- Socket RPC validates response IDs and limits frames. Subscription failures close sockets once. Intentional unsubscribe does not emit a disconnect event.

## Protocol correction

Installed Herdr 0.9.0 protocol 22 has two envelope schemas. Global EventEnvelope uses underscore names. SubscriptionEventEnvelope uses dotted names such as `pane.agent_status_changed`, without a data.type field. Earlier host review checked only the global schema and incorrectly generalized its spelling. Both formats are now normalized. A pane.agent_status_changed subscription requires pane_id. New Worker panes receive their own acknowledged subscriptions before launch; the startup subscription cannot cover future pane IDs.

`agent.read` uses the socket enum `recent_unwrapped` and returns text under `result.read.text`. Its CLI spelling is different. Worker prompting now checks the named Agent's interactive readiness before submitting input, because the observed Windows socket launch response can precede readiness.

## Later host integration evidence

- Main Agent model resolution and all eleven minimum Ops tools are connected to the production Pi adapter. Per-Task list and summary reads are linked to the current Run for later delivery checks.
- Real Owner private messages and real Owner/Visitor messages in the replacement QQ group completed through Pi, the actual Kit, MiniMax-M3, and OneBot replies. The Visitor also completed a private Run. The two group actors share one Conversation and retain distinct Principals and Pi Sessions. Local evidence is in `qq-acceptance-evidence.json` under the dedicated integration directory. The previous Visitor and group grants were revoked when the user changed the fixture.
- The real Kit test, main-agent, and qq-group profiles passed with the actual Pi SDK and a deterministic provider. Actual SDK Tool calls were also tested with the real Kit: an ungranted protected read does not execute or expose its canary to model-visible Tool results.
- Runtime trace now records profile and resource SHA-256 fingerprints. Selected Skills are checked against the Kit's Skills lock before loading. The configured Kit commit is labeled as configured, not as a verified checkout attestation.
- The user selected Pi for Herdr coding Workers. Two Codex probe panes were closed. Pi 0.85.1 now launches with explicit Kit Worker resources, isolated credentials/session configuration, disabled ambient Skills discovery, and Herdr's official Pi lifecycle extension.
- A real Pi Worker created TypeScript implementation/tests in a disposable repository. A host rerun passed all nine tests. This is real Worker execution evidence, not yet proof of the complete QQ Task review/rework/accept loop.
- Worker dispatch failures now preserve the Task, attempt, any existing binding, and a generic Attention/Trace record. They do not silently create another Worker or replay an uncertain prompt.

## Host-run validation

The real Pi Task `fa5e7d80-6a2c-4bf6-bf32-6470a4f3ad4a` entered REVIEW from persisted native working/idle observations. An explicit Rework created attempt `5a5d6033-a789-43b7-b3de-48818c7ba5c8` in a new Pi pane, preserving attempt `591c9553-de80-4016-865d-d77feffe1c5b`. The second Pi Worker added finite-result overflow validation. All ten generated tests passed when rerun by the host. Explicit Accept then marked the Task DONE. Reopening the isolated Ops database and reconnecting to the real Herdr session preserved DONE, both attempts, and their distinct Pi bindings. Local evidence is `herdr/pi-accepted-evidence.json` under the integration directory. This test used AuthorizedOpsService directly; QQ-driven Task acceptance remains unverified.

The later complete server run passed 606 tests, with one opt-in live test skipped. A repeated CLI timeout was traced to importing the entire management application and Pi SDK solely to parse the port. Moving the parser to a dependency-free configuration module removed that startup dependency; the full suite passed with its original timeout.

After existing-Task delegation, rework failure handling, and Worker identity checks, the complete server run passed 609 tests with one live test skipped. Server TypeScript checking passed. Running TypeScript checking concurrently with the preceding full suite caused a Workbench setup import to exceed its unchanged ten-second hook timeout; the subsequent full suite ran alone and passed in 10.13 seconds. Final verification should avoid overlapping these two CPU-heavy checks. `git diff --check` still reports a pre-existing trailing blank line in the persistent-record finding.

On 2026-09-18, `node node_modules/vitest/vitest.mjs run apps/server/src` passed 585 tests across 37 files. The opt-in live Herdr test was skipped in that deterministic run.

The live Herdr test was separately executed with GLASSBOX_TEST_HERDR_SOCKET pointing at the dedicated glassbox-p3 session. It passed real ping, snapshot and subscription acknowledgement against Herdr 0.9.0 protocol 22. The host started that dedicated service with PID 12772. PID is historical evidence and must be checked before reuse.

The server TypeScript check passed before the final unsubscribe test addition. Recheck final artifacts before committing.

## Remaining integration work

### Pi integration follow-up on 2026-09-18

The QQ service now provisions Owner-private Ops permissions through the authenticated management API. Task creation records its origin scope, and explicit task-policy grants apply only to that Principal and origin scope. Reopening the database preserves those grants; revoking them affects existing Tasks. Workspace read and workspace delivery remain separate grants. Worker output retains the workspace source Resource in Run evidence, and delivery checks its current authority again.

Herdr snapshots now resolve the named Agent from `snapshot.agents`, rather than treating the runtime kind in `pane.agent` as an instance name. Reconciliation marks missing or replaced named Workers unknown. Nameless lifecycle events trigger a current snapshot instead of assigning their possibly delayed status to a replacement Worker. Pi working evidence survives an unknown observation, so reconnect can recover idle completion into REVIEW. It never accepts the Task.

An actual Pi SDK test with a deterministic provider invokes task_delegate, task_rework, worker_read and task_accept. It verifies two REVIEW transitions, two attempts and Pi bindings in distinct panes, explicit acceptance, and independently denied delivery. This uses FakeHerdrBridge and does not replace the real QQ acceptance.

Worker launch evidence now includes Kit profile/resource fingerprints, model/provider, Herdr extension digest and the guarded Tool names. Configuration revalidates Kit resources for each launch. Worker authorization uses the actual configured product database path; an in-memory database cannot back an independent Pi Worker.

The complete server suite passed 619 tests with one live test skipped. The live Herdr test was then enabled separately and passed against the dedicated session. After the MCP guard, TypeScript checking and the full 619-test suite passed again. The obsolete trailing blank lines in the persistent record were removed, and git diff --check passed. The QQ acceptance service restarted and reconnected to NapCat with pi:p3-minimax.

Review found that the current standalone Kit MCP adapter falls back to local-coding when Pi supplies no profileName in session_start. Glassbox now excludes that auto-discovery adapter when no MCP server is selected, and rejects explicit MCP activation without an authorized Tool registration. The Pi SDK regression includes an unselected adapter that throws if loaded. The full selected MCP/profile acceptance remains open and must not be described as complete.

The latest QQ database inspection contained the ten prior successful Runs and no Task. The pending user step is the Owner-private Task delegation message. QQ review/rework/accept, per-Task worktree isolation, and the remaining final security matrix are still open.

The Kit `herdr-worker` profile declares built-in coding tools, but Glassbox's remote launch now overrides them with three guarded file tools. The independent Pi process loads a Glassbox Extension with per-attempt context, current database authorization, an Action ceiling captured at delegation, Task liveness checks, path checks, and safe tool evidence. Raw bash is absent. A remaining process-execution capability must receive a separate enforceable boundary before it is exposed. The current acceptance executes generated tests independently on the host.

Real bounded Pi Task `a5781e97-f45f-43d9-88eb-e9744864e267` generated `bounded-sum.ts` and its tests through guarded file tools. Host inspection and execution passed all eighteen tests. Rework launched a second Pi attempt in another tab and wrote `bounded-review.txt`. Two absolute-path reads in that attempt were rejected; relative reads succeeded. Explicit Accept, database reopen, and Herdr reconnect preserved DONE and both Pi bindings. Local evidence is `herdr/bounded-pi-accepted-evidence.json`. The first run exposed native libsql lock contention when several tools opened transactions concurrently in one Pi process. Worker tools now request sequential execution and serialize their database/file operations. A deterministic concurrent-call regression passes. Failed attempts and failed tool outcomes remain in history.

The real run also exposed two launch issues. Pi's `--no-tools` disables Extension tools unless an explicit allowlist is provided. Repeated horizontal pane splitting and an unfocused tab both produced terminal widths too small for Pi. New Workers now receive a focused, separate Herdr tab. The public SDK loader test verifies that only the three guarded tools are active. A missing Kit launch policy or per-attempt context fails before a Pi Worker is created.

After these changes, the full server suite passed 612 tests across 46 files, with the single opt-in live test skipped. The server TypeScript check passed. QQ Task delegation remains unwired to this policy: its workspace Resource grants and per-Task lifecycle grants still need a production provisioning path, followed by actual QQ Task acceptance and cross-audience security checks.

Existing Task delegation now accepts a Task ID and requires its specific `task:delegate` grant. The initial-attempt transaction rejects an already-started or terminal Task, including concurrent requests. Rework dispatch errors persist WAITING_INPUT without replay. Worker-bound trace entries now include the Task ID. Production read/prompt/stop calls carry the persisted Agent name, and the socket bridge refuses a mismatched name before reading output or submitting control input. Reconciliation still needs equivalent native identity evidence; pane identity alone does not prove the original Worker is present.

- Complete protected Context and result provenance checks, including current per-resource read and delivery authorization.
- Complete bounded Worker delegation policy, isolated worktree creation, failure recovery and replaced-worker identity checks.
- Exercise real Worker execution, review, rework, acceptance, server restart and reconnect through the production path.
- Complete real duplicate-event, restart, and leakage acceptance using the confirmed separate Bot and updated Owner/Visitor/group fixture.
- Run final self-review, repository-required checks, and update the single Issue and Draft PR with actual evidence.
