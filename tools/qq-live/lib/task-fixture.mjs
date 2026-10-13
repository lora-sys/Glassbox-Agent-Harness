import { fail } from "./core.mjs";
import { taskFixtureStep } from "./task-scenario.mjs";

const NONCE = /^[a-f0-9]{32}$/;
const TASK_UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const IDENTIFIER = /^[A-Za-z0-9_-]{1,128}$/;

function inconclusive(message) {
  fail("TASK_FIXTURE_EVIDENCE", message, "INCONCLUSIVE");
}

function requiredId(value, pattern = IDENTIFIER) {
  return typeof value === "string" && pattern.test(value);
}

function scopeFields(scope) {
  if (
    !scope ||
    typeof scope !== "object" ||
    Array.isArray(scope) ||
    scope.chatType !== "private" ||
    ![scope.connectionId, scope.botId, scope.chatId, scope.senderId].every(
      (x) => typeof x === "string" && x.length > 0,
    ) ||
    (scope.threadId !== undefined && (typeof scope.threadId !== "string" || !scope.threadId)) ||
    scope.nativeGroupRole !== undefined
  )
    inconclusive("Task fixture 必须绑定有效的 Owner 私聊位置。");
  return {
    connectionId: scope.connectionId,
    botId: scope.botId,
    chatType: "private",
    chatId: scope.chatId,
    senderId: scope.senderId,
    ...(scope.threadId === undefined ? {} : { threadId: scope.threadId }),
  };
}

function scopeKey(scope) {
  return JSON.stringify([
    scope.connectionId,
    scope.botId,
    "private",
    scope.chatId,
    scope.senderId,
    scope.threadId ?? null,
  ]);
}

function parseJson(value) {
  if (typeof value !== "string") inconclusive("Task fixture 的来源位置缺少持久证据。");
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    return parsed;
  } catch {
    inconclusive("Task fixture 的来源位置记录无效。");
  }
}

function exactScope(actualValue, expected, expectedKey) {
  const actual = parseJson(actualValue);
  const keys = Object.keys(actual).sort();
  const expectedKeys = Object.keys(expected).sort();
  return (
    JSON.stringify(keys) === JSON.stringify(expectedKeys) &&
    expectedKeys.every((key) => actual[key] === expected[key]) &&
    JSON.stringify([
      actual.connectionId,
      actual.botId,
      actual.chatType,
      actual.chatId,
      actual.senderId,
      actual.threadId ?? null,
    ]) === expectedKey
  );
}

function requireRun(db, runId, principalId, scope, message) {
  if (!requiredId(runId)) inconclusive(message);
  const rows = db
    .prepare(
      "SELECT r.id, r.principal_id, r.scope_json, p.kind AS principal_kind FROM runs r JOIN principals p ON p.id = r.principal_id WHERE r.id = ?",
    )
    .all(runId);
  if (
    rows.length !== 1 ||
    rows[0].principal_id !== principalId ||
    rows[0].principal_kind !== "owner" ||
    !exactScope(rows[0].scope_json, scope, scopeKey(scope))
  )
    inconclusive(message);
}

function requireDecision(db, { runId, principalId, scope, resourceId, action }) {
  const rows = db
    .prepare(
      "SELECT principal_id, resource_id, action, scope_key, decision FROM authorization_decisions_all WHERE run_id = ? AND resource_id = ? AND action = ? AND scope_key = ?",
    )
    .all(runId, resourceId, action, scopeKey(scope));
  if (
    rows.length === 0 ||
    rows.some((row) => row.principal_id !== principalId || row.decision !== "ALLOW")
  )
    inconclusive("Task fixture 缺少匹配的授权决定。");
}

function fixtureTaskSpec(nonce) {
  if (typeof nonce !== "string" || !NONCE.test(nonce))
    fail("TASK_FIXTURE_NONCE", "Task 测试需要唯一的本轮编号。", "BLOCKED");
  const spec = taskFixtureStep("create", { nonce });
  return spec.leaseTools[0].operations[0].inputConstraint;
}

function requireNoExecutionBindings(db, taskId) {
  const checks = [
    ["SELECT id FROM task_attempts WHERE task_id = ? LIMIT 1", [taskId]],
    ["SELECT id FROM task_steps WHERE task_id = ? LIMIT 1", [taskId]],
    ["SELECT 1 FROM task_workflow_bindings WHERE task_id = ? LIMIT 1", [taskId]],
    ["SELECT 1 FROM task_attempt_runs WHERE task_id = ? LIMIT 1", [taskId]],
    [
      "SELECT 1 FROM task_child_links WHERE child_task_id = ? OR parent_task_id = ? LIMIT 1",
      [taskId, taskId],
    ],
    [
      "SELECT id FROM durable_continuation_schedules WHERE target_kind = 'task' AND target_id = ? LIMIT 1",
      [taskId],
    ],
    [
      "SELECT id FROM durable_continuation_occurrences WHERE target_kind = 'task' AND target_id = ? LIMIT 1",
      [taskId],
    ],
    [
      "SELECT id FROM durable_continuation_events WHERE target_kind = 'task' AND target_id = ? LIMIT 1",
      [taskId],
    ],
  ];
  for (const [sql, args] of checks)
    if (db.prepare(sql).all(...args).length !== 0)
      inconclusive("Task fixture 已产生 attempt、step、worker 或 schedule 绑定。");
}

function creationAudit(db, taskId, principalId, creationRunId, expected) {
  const events = db
    .prepare(
      "SELECT sequence, type, run_id, principal_id, data_json FROM ops_trace_events WHERE task_id = ? ORDER BY sequence",
    )
    .all(taskId);
  const creates = events.filter((event) => event.type === "task.created");
  if (
    events.length === 0 ||
    events[0].type !== "task.created" ||
    creates.length !== 1 ||
    creates[0].run_id !== creationRunId ||
    creates[0].principal_id !== principalId
  )
    inconclusive("Task fixture 缺少唯一且来源正确的创建审计。");
  const data = parseJson(creates[0].data_json);
  if (
    data.title !== expected.title ||
    data.status !== "NEW" ||
    data.priority !== "normal" ||
    JSON.stringify(data.acceptanceCriteria) !== JSON.stringify(expected.acceptanceCriteria)
  )
    inconclusive("Task 创建审计与固定 fixture 不一致。");
  return events;
}

function loadTask(db, taskId, principalId, creationRunId, scope, nonce) {
  if (!requiredId(taskId, TASK_UUID)) inconclusive("Task fixture ID 不是有效 UUID。");
  const tasks = db.prepare("SELECT * FROM tasks WHERE id = ?").all(taskId);
  if (tasks.length !== 1) inconclusive("Task fixture 不存在或不唯一。");
  const task = tasks[0];
  const expected = fixtureTaskSpec(nonce);
  if (
    task.title !== expected.title ||
    task.description !== expected.description ||
    task.priority !== "normal" ||
    task.creator_principal_id !== principalId ||
    task.run_id !== creationRunId ||
    task.acceptance_criteria_json !== JSON.stringify(expected.acceptanceCriteria) ||
    task.origin_scope_key !== scopeKey(scope) ||
    !exactScope(task.origin_scope_json, scope, scopeKey(scope)) ||
    task.active_attempt_id !== null ||
    task.orchestration_mode !== "legacy" ||
    task.cancellation_state !== "none"
  )
    inconclusive("Task fixture 的内容或来源绑定与本轮不一致。");
  requireRun(
    db,
    creationRunId,
    principalId,
    scope,
    "Task fixture 创建 Run 的 Owner 或私聊来源不匹配。",
  );
  const events = creationAudit(db, taskId, principalId, creationRunId, expected);
  requireDecision(db, {
    runId: creationRunId,
    principalId,
    scope,
    resourceId: "agent-operations",
    action: "task:create",
  });
  requireNoExecutionBindings(db, taskId);
  return { task, events };
}

/** Read-only evidence observer for one fixed Owner-private Task lifecycle fixture. */
export function observeTaskFixture(db, input) {
  const { stage, fixtureNonce, principalId, creationRunId, inspectRunId, stepRunId, taskId } =
    input ?? {};
  if (!db || typeof db.prepare !== "function")
    inconclusive("Task fixture observer 缺少只读数据库句柄。");
  if (typeof fixtureNonce !== "string" || !NONCE.test(fixtureNonce))
    fail("TASK_FIXTURE_NONCE", "Task 测试需要唯一的本轮编号。", "BLOCKED");
  if (!requiredId(principalId) || !requiredId(stepRunId))
    inconclusive("Task fixture 缺少 Owner 或 Run 身份。");
  const scope = scopeFields(input.scope);

  if (stage === "create") {
    if (creationRunId !== undefined && creationRunId !== stepRunId)
      inconclusive("Task 创建阶段的 Run 身份不一致。");
    requireRun(
      db,
      stepRunId,
      principalId,
      scope,
      "Task fixture 创建 Run 的 Owner 或私聊来源不匹配。",
    );
    const rows = db
      .prepare(
        "SELECT id, creator_principal_id, origin_scope_key FROM tasks WHERE run_id = ? ORDER BY id",
      )
      .all(stepRunId);
    if (
      rows.length !== 1 ||
      rows[0].creator_principal_id !== principalId ||
      rows[0].origin_scope_key !== scopeKey(scope)
    )
      inconclusive("创建 Run 没有且仅有一个匹配本轮 Owner 私聊来源的 Task。");
    const taskIdFound = rows[0].id;
    const { task } = loadTask(db, taskIdFound, principalId, stepRunId, scope, fixtureNonce);
    if (task.status !== "NEW") inconclusive("新建 Task 状态不是 NEW。");
    return {
      stage,
      taskId: taskIdFound,
      status: task.status,
      principalId,
      creationRunId: stepRunId,
      stepRunId,
    };
  }

  if (stage !== "inspect" && stage !== "cancel")
    fail("TASK_FIXTURE_STAGE", "该 Task 观察阶段未实现。", "BLOCKED");
  if (!requiredId(creationRunId) || !requiredId(taskId, TASK_UUID) || stepRunId === creationRunId)
    inconclusive("Task fixture 后续阶段缺少独立 Run 或固定 Task UUID。");
  const { task, events } = loadTask(db, taskId, principalId, creationRunId, scope, fixtureNonce);
  requireRun(
    db,
    stepRunId,
    principalId,
    scope,
    "Task fixture 后续 Run 的 Owner 或私聊来源不匹配。",
  );

  if (stage === "inspect") {
    if (task.status !== "NEW" || events.some((event) => event.type === "task.canceled"))
      inconclusive("只读检查期间 Task 状态发生变化。");
    requireDecision(db, {
      runId: stepRunId,
      principalId,
      scope,
      resourceId: `task-${taskId}`,
      action: "task:read",
    });
    return { stage, taskId, status: task.status, principalId, creationRunId, stepRunId };
  }

  if (!requiredId(inspectRunId) || inspectRunId === creationRunId || inspectRunId === stepRunId)
    inconclusive("Task 取消必须使用独立于创建和检查步骤的 Run。");
  requireRun(
    db,
    inspectRunId,
    principalId,
    scope,
    "Task fixture 检查 Run 的 Owner 或私聊来源不匹配。",
  );
  requireDecision(db, {
    runId: inspectRunId,
    principalId,
    scope,
    resourceId: `task-${taskId}`,
    action: "task:read",
  });

  const cancellations = events.filter((event) => event.type === "task.canceled");
  if (
    task.status !== "CANCELED" ||
    cancellations.length !== 1 ||
    cancellations[0].run_id !== stepRunId ||
    cancellations[0].principal_id !== principalId
  )
    inconclusive("Task 取消状态或审计来源不匹配。");
  const activeAttention = db
    .prepare("SELECT id FROM attention_items WHERE task_id = ? AND resolved_at IS NULL LIMIT 1")
    .all(taskId);
  if (activeAttention.length !== 0) inconclusive("Task 取消后仍有未解决的关注项。");
  requireDecision(db, {
    runId: stepRunId,
    principalId,
    scope,
    resourceId: `task-${taskId}`,
    action: "task:cancel",
  });
  return { stage, taskId, status: task.status, principalId, creationRunId, stepRunId };
}
