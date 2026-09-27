# Issue 24 closeout

Status: ACTIVE

Tracking Issue: #24

## Scope

- Recheck every protected read source actually used by a Run before delivery. Keep the source authorization decision separate from `delivery:send`.
- Bind each Pi Herdr Worker attempt to a registered product workspace, its caller, its delegated file Actions, and a durable write lease shared with main Agent Runs.
- Preserve the lease until Herdr confirms the Worker pane has closed. On uncertainty, keep the lease quarantined. A restarted Worker process cannot use a quarantined lease.
- Review the Worker file path race, update the current-plan pointers, and record local and real integration acceptance separately.

## Boundaries

The Pi Worker retains the existing bounded `worker_read_file`, `worker_write_file`, and `worker_list_files` tools. Built-in Shell and Kit sandbox tools remain disabled on this path. A future write-capable Tool must join the same workspace lease and authorization contract before it is enabled. Other Worker kinds have no bounded file policy and cannot use this workspace-bound delegation path.

Herdr owns the live pane and process. Glassbox owns the Task, TaskAttempt, WorkerBinding, workspace grant, lease, and Trace. Worker `done` does not accept the Task or release a live write capability.

## Verification

- Focused deterministic tests cover QQ capability, ordinary read, and history read revocation before delivery; Worker and main Run write contention; two Owners; distinct workspaces; Worker cancellation, revocation, disconnect, and restart quarantine; and Worker file path replacement.
- `vp run verify:commit` runs before each commit. `vp run verify:full` runs before the PR.
- Real QQ Owner delegation through a dedicated Herdr workspace, including Review, Rework or Accept, revocation, and cleanup, remains a separate acceptance gate. The user will run it with us after returning. Do not call Issue #24 fully accepted before that evidence exists.
- Issue #17's dated record proves some real Owner and ordinary-member paths. A non-Glassbox-Owner QQ admin's bounded moderation, native role revoke and restore, Owner-private `set_group_admin` enable and disable, and a distinct Bot-provider failure remain unverified. These need the named disposable test accounts; Issue #17's closed state alone is not evidence that they passed.
- Linux full-stack migration belongs to Issue #30.
