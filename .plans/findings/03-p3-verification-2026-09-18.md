# P3 verification status

P3 implementation and the dedicated Windows acceptance environment completed the active Plan 03 gate on 2026-09-19. Issue 1 remains the dedicated issue. PR 4 remains the single Draft PR for P3.0 through P3.8 until the final review is published.

## Deterministic validation

- `npm run test:server` passed 620 tests. The one skipped test is the opt-in real Herdr socket test.
- The real Herdr socket test passed separately against the named `glassbox-p3` session.
- The security and reliability selection passed 62 tests across OneBot, shared Conversation isolation, Pi protected Tools and authorized Ops.
- The server TypeScript check passed.
- Changed server and contracts files passed strict lint and formatting.
- Windows parallel execution can make two integration fixtures exceed Vitest defaults. The repository test configuration now uses 30 second test and hook limits. The complete suite passes with that bound.
- Root `npm run check` still reports 236 unrelated baseline formatting files in legacy and frontend paths. P3 did not rewrite the separate frontend worktree to clear that baseline.

## Lora PI Kit

- Kit commit `870a025775f28e314eeef974aa09511802f3e3d2` is the Glassbox pin.
- Kit build passed and all 21 Kit tests passed.
- A packed Kit artifact was installed in an independent npm consumer with an isolated Pi agent directory.
- The installed artifact loaded its locked bundled Skill and executed a real stdio MCP fixture through Pi.
- Main Agent, QQ group, Herdr worker and test profiles resolve through supported Pi Package, Extension and Skill mechanisms.
- The test profile and acceptance runs do not write to the normal interactive Pi state.

## Real QQ Task loop

The dedicated environment used separate Bot, Owner and Visitor accounts, a dedicated QQ group, NapCat, a persistent Glassbox database, the pinned Kit, MiniMax through Pi and the named Herdr session `glassbox-p3`.

Owner private Run `e1e47769-d5b0-47e9-9ddf-c1c72dda5755` created Task `c1b9c21a-79b3-4d2e-823a-86501b8ca799` through the protected Pi `task_delegate` Tool.

- TaskAttempt 1 was bound to Herdr Pi pane `w2:p2` and agent `glassbox-pi-4786c2a5`.
- The Worker wrote `qq-sum.ts` and `qq-sum.test.ts` in the disposable worker repository.
- Local `node --test qq-sum.test.ts` passed all 9 initial tests.
- Worker completion moved the Task to `REVIEW`. It did not set `DONE` or accept the result.
- Owner requested Rework through QQ.
- TaskAttempt 2 `09b9e9f0-00ea-4252-9215-0fe8e3f8ee9d` used a new Herdr Pi pane `w2:p3` and agent `glassbox-pi-5511cc46`.
- Both attempts and both WorkerBindings remained durable.
- Local validation after Rework passed all 10 tests.
- The Task returned to `REVIEW`.
- Owner then used explicit Accept. Trace event `task.accepted` was recorded and the Task entered `DONE`.
- Each QQ Run recorded sent ack and result deliveries to the original private audience.

## Restart and reconciliation

- Glassbox stopped cleanly at PID 11236 and restarted at PID 42776 against the same database.
- The Task, both TaskAttempts, both WorkerBindings, the originating Run and Conversation, authorization evidence and all 30 Task trace events survived.
- The restarted service reconnected to NapCat and kept the Task at `DONE`.
- The named Herdr session was stopped and restarted while Glassbox remained live.
- Task truth stayed `DONE` during the disconnect.
- The restarted Herdr snapshot retained panes `w2:p2` and `w2:p3`.
- The real SocketHerdrBridge connected to the restarted server, read its snapshot and established a protocol 22 event subscription.

## Real authorization and delivery checks

- Owner and Visitor resolved to distinct Principals.
- Owner private, Visitor private and the configured group used durable scope identities.
- Group Runs recorded the actual sending Principal.
- Owner tried to read and deliver the private Task from the QQ group. `task:read` returned `DENY` with reason `private_group_context`.
- The group received only the denial response. The private worker output did not enter the group result or delivery.
- Visitor tried to read the Owner Task and Worker output from private chat. `task:read` and `worker:read` both returned `DENY` with reason `no_grant`.
- The Visitor result and delivery contained neither the worker source nor `PRIVATE_CANARY_7F92A1`.
- NapCat received a normal group message without a Bot mention. The database stayed at 38 Runs and created no reply for that message.
- Database probes found no `PRIVATE_CANARY_7F92A1` in messages, Run results, deliveries, authorization reasons or Ops Trace.

## Reliability and evidence

- Durable ingress dedupe tests replay the same OneBot event ID and preserve one Message, Run and reply side effect.
- NapCat disconnect and reconnect did not replay completed work into a duplicate Run or delivery.
- Raw Trace records Task creation, each WorkerBinding, Worker state observations, file Tool calls, Rework, the second TaskAttempt and explicit acceptance.
- Authorization decisions preserve action, resource, Principal, scope, decision and reason without copying protected payloads into denial evidence.
- Runtime trace records actual Pi provider, model and token usage when supplied by the provider.

No Linux or macOS acceptance is claimed. Frontend implementation remains in its separate worktree and PR.
