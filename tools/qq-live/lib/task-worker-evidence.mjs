import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fail, toolManifestDigest } from "./core.mjs";
import {
  caseEvidence,
  observeFeature,
  readTraceEvents,
  verifyCaseLeaseCleanupEvidence,
  verifyLeaseTraceEvidence,
  verifyMessageBindings,
  verifyTraceEvidence,
} from "./product-evidence.mjs";
import { inspectTaskWorkerArtifact } from "./task-worker-artifact.mjs";
import { taskWorkerFixtureStep } from "./task-worker-scenario.mjs";

const NONCE = /^[a-f0-9]{32}$/u;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu;
const HASH = /^[a-f0-9]{64}$/u;
const IDENTIFIER = /^[A-Za-z0-9_-]{1,128}$/u;
const MESSAGE_ID = /^[1-9]\d{0,19}$/u;

function inconclusive() {
  fail(
    "TASK_WORKER_EVIDENCE",
    "Task Worker lifecycle evidence is missing or inconsistent.",
    "INCONCLUSIVE",
  );
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (isRecord(value))
    return `{${Object.keys(value)
      .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

function same(left, right) {
  return canonical(left) === canonical(right);
}

function exactKeys(value, keys) {
  return (
    isRecord(value) &&
    same(
      Object.keys(value).sort((left, right) => (left < right ? -1 : left > right ? 1 : 0)),
      [...keys].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0)),
    )
  );
}

function scopeKey(scope) {
  return JSON.stringify([
    scope.connectionId,
    scope.botId,
    scope.chatType,
    scope.chatId,
    scope.senderId,
    scope.threadId ?? null,
  ]);
}

function fixedScope(scope, config) {
  return (
    exactKeys(scope, ["connectionId", "botId", "chatType", "chatId", "senderId", "threadId"]) &&
    scope.connectionId === config.runtime.connectionId &&
    scope.botId === String(config.bot.qq) &&
    scope.chatType === "private" &&
    scope.chatId === String(config.driver.qq) &&
    scope.senderId === String(config.driver.qq) &&
    (scope.threadId === null || typeof scope.threadId === "string")
  );
}

function runIdentity(db, runId, expectedScope, expectedPrincipalId) {
  if (typeof runId !== "string" || !IDENTIFIER.test(runId)) inconclusive();
  const rows = db
    .prepare(
      "SELECT r.id, r.principal_id, r.scope_json, p.kind AS principal_kind FROM runs r JOIN principals p ON p.id = r.principal_id WHERE r.id = ?",
    )
    .all(runId);
  if (rows.length !== 1) inconclusive();
  let scope;
  try {
    scope = JSON.parse(rows[0].scope_json);
  } catch {
    inconclusive();
  }
  if (
    rows[0].id !== runId ||
    rows[0].principal_kind !== "owner" ||
    typeof rows[0].principal_id !== "string" ||
    !rows[0].principal_id ||
    (expectedPrincipalId !== undefined && rows[0].principal_id !== expectedPrincipalId) ||
    !fixedScope(scope, expectedScope)
  )
    inconclusive();
  return { principalId: rows[0].principal_id, scope };
}

function authorize(db, { runId, principalId, scope, resourceId, action }) {
  const rows = db
    .prepare(
      "SELECT principal_id, resource_id, action, scope_key, decision, run_id FROM authorization_decisions_all WHERE run_id = ? AND resource_id = ? AND action = ? AND scope_key = ?",
    )
    .all(runId, resourceId, action, scopeKey(scope));
  if (
    rows.length === 0 ||
    rows.some(
      (row) =>
        row.principal_id !== principalId ||
        row.resource_id !== resourceId ||
        row.action !== action ||
        row.scope_key !== scopeKey(scope) ||
        row.run_id !== runId ||
        row.decision !== "ALLOW",
    )
  )
    inconclusive();
}

function parseData(value) {
  try {
    const parsed = JSON.parse(value);
    if (!isRecord(parsed)) inconclusive();
    return parsed;
  } catch {
    inconclusive();
  }
}

function eventsForTask(db, taskId) {
  return db
    .prepare(
      "SELECT sequence, type, task_attempt_id, run_id, principal_id, data_json FROM ops_trace_events WHERE task_id = ? ORDER BY sequence",
    )
    .all(taskId)
    .map((row) => ({ ...row, data: parseData(row.data_json) }));
}

function loadTask(db, taskId, ctx, scope, principalId) {
  if (typeof taskId !== "string" || !UUID.test(taskId)) inconclusive();
  const rows = db
    .prepare(
      `SELECT id, title, description, status, priority, creator_principal_id, conversation_id,
              run_id, active_attempt_id, acceptance_criteria_json, origin_scope_key,
              origin_scope_json, orchestration_mode, cancellation_state
       FROM tasks WHERE id = ?`,
    )
    .all(taskId);
  if (rows.length !== 1) inconclusive();
  const task = rows[0];
  const createInput = taskWorkerFixtureStep("create", { fixtureNonce: ctx.fixtureNonce })
    .leaseTools[0].operations[0].inputConstraint;
  let taskScope;
  let criteria;
  try {
    taskScope = JSON.parse(task.origin_scope_json);
    criteria = JSON.parse(task.acceptance_criteria_json);
  } catch {
    inconclusive();
  }
  if (
    task.id !== taskId ||
    task.title !== createInput.title ||
    task.description !== createInput.description ||
    task.priority !== "normal" ||
    task.creator_principal_id !== principalId ||
    task.run_id !== ctx.creationRunId ||
    task.acceptance_criteria_json !== JSON.stringify(createInput.acceptanceCriteria) ||
    task.origin_scope_key !== scopeKey(scope) ||
    !same(taskScope, scope) ||
    task.orchestration_mode !== "legacy" ||
    task.cancellation_state !== "none"
  )
    inconclusive();
  const taskEvents = eventsForTask(db, taskId);
  const created = taskEvents.filter((event) => event.type === "task.created");
  if (
    created.length !== 1 ||
    created[0].run_id !== ctx.creationRunId ||
    created[0].principal_id !== principalId ||
    !same(created[0].data, {
      title: createInput.title,
      priority: "normal",
      status: "NEW",
      acceptanceCriteria: createInput.acceptanceCriteria,
    })
  )
    inconclusive();
  return { task, taskEvents };
}

function taskForCreationRun(db, ctx, scope, principalId) {
  const rows = db
    .prepare(
      "SELECT id, creator_principal_id, origin_scope_key FROM tasks WHERE run_id = ? ORDER BY id",
    )
    .all(ctx.runId);
  if (
    rows.length !== 1 ||
    rows[0].creator_principal_id !== principalId ||
    rows[0].origin_scope_key !== scopeKey(scope)
  )
    inconclusive();
  const taskId = rows[0].id;
  const { task, taskEvents } = loadTask(db, taskId, ctx, scope, principalId);
  authorize(db, {
    runId: ctx.runId,
    principalId,
    scope,
    resourceId: "agent-operations",
    action: "task:create",
  });
  const attempts = db.prepare("SELECT id FROM task_attempts WHERE task_id = ?").all(taskId);
  const bindings = db
    .prepare(
      "SELECT b.id FROM worker_bindings b JOIN task_attempts a ON a.id = b.task_attempt_id WHERE a.task_id = ?",
    )
    .all(taskId);
  if (
    task.status !== "NEW" ||
    task.active_attempt_id !== null ||
    attempts.length ||
    bindings.length
  )
    inconclusive();
  if (taskEvents.length !== 1) inconclusive();
  return taskId;
}

function loadWorkerExecution(db, ctx, scope, principalId, trustedFixture) {
  const { task, taskEvents } = loadTask(db, ctx.taskId, ctx, scope, principalId);
  const attempts = db
    .prepare(
      "SELECT id, task_id, attempt_number, status, rework_reason, step_id FROM task_attempts WHERE task_id = ? ORDER BY attempt_number",
    )
    .all(ctx.taskId);
  if (
    attempts.length !== 1 ||
    !UUID.test(attempts[0].id) ||
    attempts[0].attempt_number !== 1 ||
    attempts[0].task_id !== ctx.taskId ||
    attempts[0].rework_reason !== null ||
    attempts[0].step_id !== null ||
    task.active_attempt_id !== attempts[0].id
  )
    inconclusive();
  const attempt = attempts[0];
  const bindings = db
    .prepare(
      `SELECT id, task_attempt_id, herdr_session, workspace_id, pane_id, agent_name, agent_kind,
              worktree_path, last_observed_agent_state
       FROM worker_bindings WHERE task_attempt_id = ?`,
    )
    .all(attempt.id);
  if (bindings.length !== 1) inconclusive();
  const binding = bindings[0];
  if (
    !UUID.test(binding.id) ||
    binding.task_attempt_id !== attempt.id ||
    binding.herdr_session !== ctx.expectedWorkerTarget.herdrSession ||
    binding.workspace_id !== ctx.expectedWorkerTarget.workspaceId ||
    binding.agent_kind !== ctx.expectedWorkerTarget.agentKind ||
    binding.worktree_path !== trustedFixture.canonicalRoot ||
    typeof binding.pane_id !== "string" ||
    !binding.pane_id ||
    typeof binding.agent_name !== "string" ||
    !binding.agent_name
  )
    inconclusive();
  const bound = taskEvents.filter(
    (event) => event.type === "task.worker_bound" && event.task_attempt_id === attempt.id,
  );
  if (
    bound.length !== 1 ||
    bound[0].data.bindingId !== binding.id ||
    bound[0].data.workspaceId !== binding.workspace_id ||
    bound[0].data.herdrSession !== binding.herdr_session ||
    bound[0].data.agentKind !== binding.agent_kind ||
    bound[0].data.worktreePath !== trustedFixture.canonicalRoot
  )
    inconclusive();

  const leaseEvents = taskEvents.filter(
    (event) => event.type === "worker.workspace_lease" && event.task_attempt_id === attempt.id,
  );
  const parsedLeaseEvents = leaseEvents.map((event) => ({
    ...event,
    lease: event.data,
  }));
  const acquired = parsedLeaseEvents.filter((event) => event.lease.state === "acquired");
  if (
    acquired.length !== 1 ||
    typeof acquired[0].lease.leaseId !== "string" ||
    !UUID.test(acquired[0].lease.leaseId) ||
    acquired[0].lease.workspaceId !== trustedFixture.productWorkspaceId ||
    acquired[0].principal_id !== principalId
  )
    inconclusive();
  return {
    task,
    taskEvents,
    attempt,
    binding,
    leaseEvents: parsedLeaseEvents,
    lease: acquired[0].lease,
  };
}

function verifyWorkerWrite(db, ctx, execution) {
  const writes = execution.taskEvents.filter(
    (event) => event.type === "worker.tool" && event.task_attempt_id === execution.attempt.id,
  );
  if (
    writes.length !== 1 ||
    writes[0].principal_id !== ctx.principalId ||
    writes[0].data.action !== "worker:file:write" ||
    writes[0].data.outcome !== "succeeded" ||
    writes[0].data.productWorkspaceId !== ctx.trustedFixture.productWorkspaceId ||
    typeof writes[0].data.resourceId !== "string" ||
    !writes[0].data.resourceId ||
    typeof writes[0].data.decisionId !== "string" ||
    !writes[0].data.decisionId ||
    typeof writes[0].data.workspaceDecisionId !== "string" ||
    !writes[0].data.workspaceDecisionId ||
    writes[0].data.workspaceDecisionId === writes[0].data.decisionId
  )
    inconclusive();
  const decisions = db
    .prepare(
      "SELECT id, principal_id, resource_id, action, decision FROM authorization_decisions_all WHERE id = ?",
    )
    .all(writes[0].data.decisionId);
  if (
    decisions.length !== 1 ||
    decisions[0].principal_id !== ctx.principalId ||
    decisions[0].resource_id !== writes[0].data.resourceId ||
    decisions[0].action !== "worker:file:write" ||
    decisions[0].decision !== "ALLOW"
  )
    inconclusive();
  const workspaceDecisions = db
    .prepare(
      "SELECT id, principal_id, resource_id, action, decision, scope_key, run_id FROM authorization_decisions_all WHERE id = ?",
    )
    .all(writes[0].data.workspaceDecisionId);
  if (
    workspaceDecisions.length !== 1 ||
    workspaceDecisions[0].id === decisions[0].id ||
    workspaceDecisions[0].principal_id !== ctx.principalId ||
    workspaceDecisions[0].resource_id !== `workspace:${ctx.trustedFixture.productWorkspaceId}` ||
    workspaceDecisions[0].action !== "workspace:write" ||
    workspaceDecisions[0].scope_key !== scopeKey(ctx.scope) ||
    workspaceDecisions[0].run_id !== ctx.creationRunId ||
    workspaceDecisions[0].decision !== "ALLOW"
  )
    inconclusive();
}

function requireAttentionClear(db, taskId) {
  const rows = db
    .prepare("SELECT id FROM attention_items WHERE task_id = ? AND resolved_at IS NULL")
    .all(taskId);
  if (rows.length !== 0) inconclusive();
}

/** Recheck the accepted Task, released Worker lease and cleared Attention after transport drain. */
export function verifyTaskWorkerTerminalState({
  db,
  taskId,
  attemptId,
  bindingId,
  creationRunId,
  acceptedRunId,
  fixtureNonce,
  expectedWorkerTarget,
  trustedFixture,
  scope,
  principalId,
}) {
  if (
    !db ||
    typeof db.prepare !== "function" ||
    !UUID.test(taskId ?? "") ||
    !UUID.test(attemptId ?? "") ||
    !UUID.test(bindingId ?? "") ||
    !IDENTIFIER.test(creationRunId ?? "") ||
    !IDENTIFIER.test(acceptedRunId ?? "") ||
    !NONCE.test(fixtureNonce ?? "") ||
    !isRecord(expectedWorkerTarget) ||
    !isRecord(trustedFixture) ||
    !isRecord(scope) ||
    typeof principalId !== "string" ||
    !principalId
  )
    inconclusive();
  const identity = runIdentity(db, acceptedRunId, scope, principalId);
  const ctx = { taskId, creationRunId, fixtureNonce, expectedWorkerTarget };
  const execution = loadWorkerExecution(db, ctx, identity.scope, principalId, trustedFixture);
  if (execution.attempt.id !== attemptId || execution.binding.id !== bindingId) inconclusive();
  verifyWorkerWrite(db, { ...ctx, principalId, trustedFixture, scope: identity.scope }, execution);
  const accepted = execution.taskEvents.filter(
    (event) =>
      event.type === "task.accepted" &&
      event.task_attempt_id === attemptId &&
      event.run_id === acceptedRunId &&
      event.principal_id === principalId &&
      event.data.previousStatus === "REVIEW" &&
      event.data.newStatus === "DONE",
  );
  const released = execution.leaseEvents.filter(
    (event) =>
      event.lease.state === "released" &&
      event.lease.leaseId === execution.lease.leaseId &&
      event.lease.workspaceId === trustedFixture.productWorkspaceId &&
      event.principal_id === principalId,
  );
  if (
    execution.task.status !== "DONE" ||
    execution.attempt.status !== "succeeded" ||
    accepted.length !== 1 ||
    released.length !== 1
  )
    inconclusive();
  requireAttentionClear(db, taskId);
  return {
    status: "PASS",
    taskId,
    attemptId,
    bindingId,
    acceptedRunId,
    taskStatus: execution.task.status,
    attemptStatus: execution.attempt.status,
    workerLeaseReleased: true,
    pendingAttentionCount: 0,
  };
}

function requireReceiptContext(ctx) {
  const product = ctx.productAcceptance;
  if (
    !isRecord(product) ||
    product.status !== "PASS" ||
    !same(product.runtime, ctx.runtime) ||
    !Array.isArray(product.cases) ||
    product.cases.length !== 1
  )
    inconclusive();
  const evidence = product.cases[0];
  const expected = taskWorkerFixtureStep(ctx.spec.id.replace("task-worker-", ""), {
    fixtureNonce: ctx.fixtureNonce,
    ...(ctx.taskId ? { taskId: ctx.taskId } : {}),
  });
  const expectedPrompt = `GLASSBOX_ACCEPTANCE_V1 ${ctx.transportCase.token}\n${expected.prompt
    .replaceAll("{{nonce}}", ctx.transportCase.token)
    .trim()}`;
  if (
    ctx.transportCase.id !== expected.id ||
    ctx.transportCase.prompt !== expectedPrompt ||
    !same(ctx.transportCase.featureAssertions, expected.featureAssertions) ||
    !same(ctx.transportCase.leaseTools, expected.leaseTools) ||
    evidence.caseId !== ctx.spec.id ||
    evidence.runId !== ctx.runId ||
    evidence.traceVerified !== true ||
    evidence.cleanupVerified !== true ||
    evidence.feature?.status !== "PASS" ||
    evidence.feature?.runId !== ctx.runId
  )
    inconclusive();
  return evidence;
}

function verifyProductProjection(evidence, fresh) {
  if (
    !same(evidence.scope, fresh.scope) ||
    !same(evidence.delivery, fresh.delivery) ||
    !same(evidence.messageBinding, fresh.messageBinding) ||
    !same(evidence.feature, fresh.feature)
  )
    inconclusive();
}

/** Build a `verifyStep` callback backed by the read-only product database and gbxtrace. */
export function createTaskWorkerStepVerifier({
  db,
  dataDirectory,
  config,
  clients,
  trustedFixture,
  captureTrace = execFileSync,
  inspectArtifact = inspectTaskWorkerArtifact,
} = {}) {
  if (
    !db ||
    typeof db.prepare !== "function" ||
    typeof dataDirectory !== "string" ||
    !dataDirectory ||
    !config ||
    !clients?.bot ||
    !clients?.driver ||
    !exactKeys(trustedFixture, ["canonicalRoot", "productWorkspaceId", "markerSha256"]) ||
    typeof trustedFixture.canonicalRoot !== "string" ||
    !resolve(trustedFixture.canonicalRoot) === trustedFixture.canonicalRoot ||
    typeof trustedFixture.productWorkspaceId !== "string" ||
    !trustedFixture.productWorkspaceId ||
    !HASH.test(trustedFixture.markerSha256 ?? "") ||
    typeof captureTrace !== "function" ||
    typeof inspectArtifact !== "function"
  )
    inconclusive();

  return async (stage, ctx) => {
    try {
      if (
        !NONCE.test(ctx.fixtureNonce ?? "") ||
        !IDENTIFIER.test(ctx.runId ?? "") ||
        !isRecord(ctx.expectedWorkerTarget) ||
        ctx.expectedWorkerTarget.markerSha256 !== trustedFixture.markerSha256 ||
        !same(ctx.runtime?.dataDirectory, dataDirectory)
      )
        inconclusive();
      const productCase = requireReceiptContext(ctx);
      const evidence = caseEvidence(db, ctx.transportCase, config);
      if (evidence.runId !== ctx.runId) inconclusive();
      const identity = runIdentity(db, ctx.runId, evidence.scope, ctx.principalId);
      if (!same(identity.scope, evidence.scope)) inconclusive();
      await verifyCaseLeaseCleanupEvidence(db, dataDirectory, ctx.transportCase, evidence);
      const messageBinding = await verifyMessageBindings(
        ctx.transportCase,
        config,
        clients,
        evidence.delivery,
      );
      const trace = readTraceEvents(
        ctx.runtime.checkout,
        dataDirectory,
        ctx.runId,
        captureTrace,
        ctx.spec.featureAssertions.map((assertion) => assertion.type),
      );
      const events = trace.events?.map((row) => row.event);
      if (!Array.isArray(events)) inconclusive();
      verifyTraceEvidence(events, ctx.transportCase, config, evidence.delivery);
      verifyLeaseTraceEvidence(events, ctx.transportCase, ctx.runId);
      const feature = observeFeature(ctx.spec.featureAssertions, {
        db,
        events,
        runId: ctx.runId,
        inputBinding: ctx.transportCase.inputBinding,
      });
      const fresh = { scope: evidence.scope, delivery: evidence.delivery, messageBinding, feature };
      verifyProductProjection(productCase, fresh);

      if (stage === "create") {
        if (
          ctx.taskId !== undefined ||
          ctx.creationRunId !== ctx.runId ||
          ctx.priorReceipts.length !== 0
        )
          inconclusive();
        authorize(db, {
          runId: ctx.runId,
          principalId: identity.principalId,
          scope: evidence.scope,
          resourceId: "agent-operations",
          action: "task:create",
        });
        const taskId = taskForCreationRun(db, ctx, evidence.scope, identity.principalId);
        return {
          stage,
          runId: ctx.runId,
          taskId,
          principalId: identity.principalId,
          principalKind: "owner",
          scope: evidence.scope,
          cleanupVerified: true,
          creationRunId: ctx.runId,
          taskStatus: "NEW",
          attemptId: null,
          bindingId: null,
        };
      }

      if (
        typeof ctx.taskId !== "string" ||
        !UUID.test(ctx.taskId) ||
        typeof ctx.creationRunId !== "string" ||
        !UUID.test(ctx.creationRunId) ||
        ctx.priorReceipts.length !== (stage === "delegate" ? 1 : stage === "inspect" ? 2 : 3)
      )
        inconclusive();
      const createRun = runIdentity(db, ctx.creationRunId, evidence.scope, identity.principalId);
      if (createRun.scope.chatType !== "private") inconclusive();
      const execution = loadWorkerExecution(
        db,
        ctx,
        evidence.scope,
        identity.principalId,
        trustedFixture,
      );

      if (stage === "delegate") {
        authorize(db, {
          runId: ctx.runId,
          principalId: identity.principalId,
          scope: evidence.scope,
          resourceId: `task-${ctx.taskId}`,
          action: "task:delegate",
        });
        if (
          !["RUNNING", "REVIEW"].includes(execution.task.status) ||
          !["running", "review"].includes(execution.attempt.status) ||
          execution.leaseEvents.some((event) => event.lease.state === "released")
        )
          inconclusive();
        return {
          stage,
          runId: ctx.runId,
          taskId: ctx.taskId,
          principalId: identity.principalId,
          principalKind: "owner",
          scope: evidence.scope,
          cleanupVerified: true,
          creationRunId: ctx.creationRunId,
          attemptId: execution.attempt.id,
          bindingId: execution.binding.id,
          workspaceId: execution.binding.workspace_id,
          herdrSession: execution.binding.herdr_session,
          agentKind: execution.binding.agent_kind,
          dispatchVerified: true,
          taskStatus: execution.task.status,
          attemptStatus: execution.attempt.status,
        };
      }

      if (ctx.attemptId !== execution.attempt.id || ctx.bindingId !== execution.binding.id)
        inconclusive();
      if (stage === "inspect") {
        authorize(db, {
          runId: ctx.runId,
          principalId: identity.principalId,
          scope: evidence.scope,
          resourceId: `task-${ctx.taskId}`,
          action: "task:read",
        });
        authorize(db, {
          runId: ctx.runId,
          principalId: identity.principalId,
          scope: evidence.scope,
          resourceId: `task-${ctx.taskId}`,
          action: "worker:read",
        });
        if (
          execution.task.status !== "REVIEW" ||
          execution.attempt.status !== "review" ||
          execution.binding.last_observed_agent_state !== "done" ||
          execution.leaseEvents.some((event) => event.lease.state === "released")
        )
          inconclusive();
        const terminal = execution.taskEvents.filter(
          (event) =>
            event.type === "worker.state_observed" &&
            event.task_attempt_id === execution.attempt.id &&
            event.data.state === "done" &&
            event.data.status === "REVIEW",
        );
        if (terminal.length !== 1) inconclusive();
        verifyWorkerWrite(
          db,
          { ...ctx, principalId: identity.principalId, trustedFixture },
          execution,
        );
        const artifactEvidence = await inspectArtifact({
          fixtureNonce: ctx.fixtureNonce,
          canonicalRoot: trustedFixture.canonicalRoot,
          markerSha256: trustedFixture.markerSha256,
          workerBindingPath: execution.binding.worktree_path,
          productWorkspacePath: trustedFixture.canonicalRoot,
        });
        return {
          stage,
          runId: ctx.runId,
          taskId: ctx.taskId,
          principalId: identity.principalId,
          principalKind: "owner",
          scope: evidence.scope,
          cleanupVerified: true,
          creationRunId: ctx.creationRunId,
          attemptId: execution.attempt.id,
          bindingId: execution.binding.id,
          taskStatus: execution.task.status,
          attemptStatus: execution.attempt.status,
          workerTerminalVerified: true,
          artifact: {
            ...artifactEvidence,
            markerSha256: trustedFixture.markerSha256,
          },
        };
      }

      if (stage !== "accept") inconclusive();
      authorize(db, {
        runId: ctx.runId,
        principalId: identity.principalId,
        scope: evidence.scope,
        resourceId: `task-${ctx.taskId}`,
        action: "task:accept",
      });
      verifyWorkerWrite(
        db,
        { ...ctx, principalId: identity.principalId, trustedFixture },
        execution,
      );
      const accepted = execution.taskEvents.filter(
        (event) =>
          event.type === "task.accepted" &&
          event.task_attempt_id === execution.attempt.id &&
          event.run_id === ctx.runId &&
          event.principal_id === identity.principalId &&
          event.data.previousStatus === "REVIEW" &&
          event.data.newStatus === "DONE",
      );
      const released = execution.leaseEvents.filter(
        (event) =>
          event.lease.state === "released" &&
          event.lease.leaseId === execution.lease.leaseId &&
          event.lease.workspaceId === trustedFixture.productWorkspaceId &&
          event.principal_id === identity.principalId,
      );
      if (
        execution.task.status !== "DONE" ||
        execution.attempt.status !== "succeeded" ||
        accepted.length !== 1 ||
        released.length !== 1
      )
        inconclusive();
      requireAttentionClear(db, ctx.taskId);
      return {
        stage,
        runId: ctx.runId,
        taskId: ctx.taskId,
        principalId: identity.principalId,
        principalKind: "owner",
        scope: evidence.scope,
        cleanupVerified: true,
        creationRunId: ctx.creationRunId,
        attemptId: execution.attempt.id,
        bindingId: execution.binding.id,
        acceptedRunId: ctx.runId,
        taskStatus: execution.task.status,
        attemptStatus: execution.attempt.status,
        workerLeaseReleased: true,
        terminalVerified: true,
        pendingAttentionCount: 0,
      };
    } catch {
      inconclusive();
    }
  };
}
