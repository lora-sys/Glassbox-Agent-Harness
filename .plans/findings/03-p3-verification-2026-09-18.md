# P3 verification status

P3 implementation and the dedicated Windows acceptance environment completed the active Plan 03 gate on 2026-09-19. Issue 1 remains the dedicated issue. PR 4 remains the single Draft PR for P3.0 through P3.8 until the final review is published.

## Deterministic validation

- `npm run test:server` passed 641 tests. The one skipped test is the opt-in real Herdr socket test.
- The real Herdr socket test passed separately against the named `glassbox-p3` session.
- The security and reliability selection passed 62 tests across OneBot, shared Conversation isolation, Pi protected Tools and authorized Ops.
- The server TypeScript check passed.
- The non-frontend scope check passed formatting for 186 files and passed lint plus type analysis for 183 files with no warnings or errors.
- Windows parallel execution can make two integration fixtures exceed Vitest defaults. The repository test configuration now uses 30 second test and hook limits. The complete suite passes with that bound.
- A final parallel rerun exposed a 300 millisecond process-exit margin in the Claude harness fixture. The fixture now allows one second for the actual Windows child-exit signal before cleanup, and the complete 641-test suite passes.
- Root `npm run check` now reports only 23 formatting files under `apps/web`. P3 did not rewrite the separate frontend worktree to clear that independent baseline.

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
- Each accepted terminal QQ Run recorded one result delivery to the original private audience. P3+ removed the user-visible acknowledgement delivery and its internal Run identifier.

## P3+ Owner control and delivery closeout

- `npm run agent:up` started the named Herdr session, NapCat and Glassbox as detached local services. `agent:status`, `agent:logs` and `agent:down` use the same local state file and verify process identity before shutdown.
- Glassbox restored QQ after NapCat became ready later than the server. It restored configured identity and authorization before accepting ingress.
- Owner private Run `fcade8ff-fa13-4093-936e-58de1c3993bc` called Pi Tool `owner_group_set_access` and disabled group `1126022432`. Glassbox revoked all active Owner and Visitor grants for that group before removing it from the Channel profile.
- A later real group mention created no Run and no Delivery while the group was disabled.
- A first enable attempt exposed a provider behavior defect. Pi claimed the action was complete without a Tool call. Glassbox preserved that Run as evidence and marked it excluded from later Context.
- The repaired execution-integrity gate requires a successful matching Tool result for an explicit Owner group-access command. It permits one corrective Pi turn in the same Run, then fails closed.
- Real Owner private Run `5989cc51-39c6-4644-9065-887006e6cf5e` used that corrective turn, called `owner_group_set_access`, verified the Bot was in the group through OneBot and enabled the group.
- Owner group Run `7a68793d-1484-4799-8c05-11400e58bf24` and Visitor group Run `bd1bccc4-e2b9-41c3-a3ee-bf8e72c9e2bc` resolved to distinct Principals and the same durable group Conversation `7ffec5a3-0467-4700-a9d6-92b0fc233c79`.
- Both group Runs used Pi's `qq-group` profile and received an empty Tool schema list. Owner-private Tool schemas did not enter group Context.
- QQ result delivery rendered Markdown as readable plain text. The Owner-control Runs and both final group Runs each produced one result delivery and no acknowledgement delivery.
- The delivery gate blocks secrets, configured credentials, Windows drive and UNC paths, private POSIX paths, private URLs, internal domains and UUIDs. A blocked candidate creates no Delivery, appends digest-only evidence and cannot enter later Context.
- The real application composition test forced a stored Channel credential into a result candidate. The gate created no Delivery and the credential did not enter Trace.

## Restart and reconciliation

- Glassbox stopped cleanly at PID 11236 and restarted at PID 42776 against the same database.
- The Task, both TaskAttempts, both WorkerBindings, the originating Run and Conversation, authorization evidence and all 30 Task trace events survived.
- The restarted service reconnected to NapCat and kept the Task at `DONE`.
- The named Herdr session was stopped and restarted while Glassbox remained live.
- Task truth stayed `DONE` during the disconnect.
- The restarted Herdr snapshot retained panes `w2:p2` and `w2:p3`.
- The real SocketHerdrBridge connected to the restarted server, read its snapshot and established a protocol 22 event subscription.
- After the final P3+ restart, the Channel reconnected with group `1126022432` still enabled. The final Owner and Visitor group Runs each remained singletons with one Delivery, so reconnect created no replay side effect.
- Task `c1b9c21a-79b3-4d2e-823a-86501b8ca799` remained `DONE` with both TaskAttempts. The false execution claim remained excluded from Context.
- The real SocketHerdrBridge again connected to the restarted named session, read its snapshot and established an event subscription.

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
