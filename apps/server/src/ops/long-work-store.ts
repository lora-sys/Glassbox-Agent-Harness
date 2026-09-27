import { randomUUID } from "node:crypto";
import type { Row, Transaction } from "@libsql/client";
import {
  TASK_EVENT_TYPES,
  TASK_STEP_STATUSES,
  type TaskCheckpoint,
  type ChildTaskLink,
  type TaskEvent,
  type TaskEventType,
  type TaskSignal,
  type TaskAttempt,
  type TaskStep,
  type TaskStepStatus,
  type TaskWaitPolicy,
  type HerdrAgentLifecycleState,
} from "@glassbox/contracts";
import { requireIdentifier } from "../identity/scope.js";
import { evaluate } from "../auth/service.js";
import { DomainDatabase, optionalString, stringColumn } from "../persistence/database.js";
import { TaskGraphError, validateTaskGraph, type TaskGraphLimits } from "./task-graph.js";
import { decideTaskRetry, type RetrySideEffectOutcome } from "./long-work-retry.js";
import { parseTaskGetSpec } from "./tool-step-spec.js";
import { reconstructTaskOriginScope } from "./long-work-authority.js";

/** Only trusted services may call this store. A decision ID records evidence; it does not
 * prove that a grant is still current. Callers must reauthorize before protected work. */
export type LongWorkOrigin =
  | { kind: "decision"; decisionId: string; actorPrincipalId: string }
  | { kind: "system"; reason: string; decisionId?: string };

export const MAX_CHILD_TASKS_PER_PARENT = 16;
export const MAX_CHILD_TASK_ANCESTOR_DEPTH = 4;

export type ChildTaskLinkErrorCode = "CHILD_COUNT_LIMIT" | "CHILD_DEPTH_LIMIT";

export class ChildTaskLinkError extends Error {
  constructor(
    readonly code: ChildTaskLinkErrorCode,
    readonly limit: number,
    readonly attempted: number,
  ) {
    super(
      code === "CHILD_COUNT_LIMIT"
        ? `Parent Task child limit reached (${limit})`
        : `Child Task ancestor depth limit exceeded (${limit})`,
    );
    this.name = "ChildTaskLinkError";
  }
}

export interface StoredTaskEvent extends TaskEvent {
  authorizationDecisionId?: string;
}

export interface StoredTaskWait {
  id: string;
  taskId: string;
  stepId: string;
  attemptId?: string;
  generation: number;
  policy: TaskWaitPolicy;
  status: "waiting" | "resumed" | "cancelled" | "stale";
  startedAt: string;
  updatedAt: string;
}

export interface StoredStepLease {
  id: string;
  taskId: string;
  stepId: string;
  attemptId?: string;
  workerBindingId?: string;
  ownerInstanceId: string;
  state: "active" | "released" | "expired" | "quarantined";
  version: number;
  acquiredAt: string;
  heartbeatAt: string;
  expiresAt: string;
  releasedAt?: string;
}

export interface ClaimedTaskStep {
  step: TaskStep;
  attempt: TaskAttempt;
  lease: StoredStepLease;
}

function boundedCriteria(values: readonly string[]): string {
  if (
    !Array.isArray(values) ||
    values.length < 1 ||
    values.length > 20 ||
    values.some((value) => typeof value !== "string" || !value.trim() || value.length > 512)
  )
    throw new Error("Invalid child Task acceptance criteria");
  const json = JSON.stringify(values.map((value) => value.trim()));
  if (json.length > 8192) throw new Error("Child Task acceptance criteria are too large");
  return json;
}

function parseChildTaskLink(row: Row): ChildTaskLink {
  return {
    parentTaskId: stringColumn(row, "parent_task_id"),
    parentStepId: stringColumn(row, "parent_step_id"),
    childTaskId: stringColumn(row, "child_task_id"),
    delegatedPermissionSet: parseJson(row, "delegated_permissions_json"),
    acceptanceCriteria: parseJson(row, "acceptance_criteria_json"),
    cancellationPolicy: stringColumn(row, "cancel_policy") as ChildTaskLink["cancellationPolicy"],
    failurePolicy: stringColumn(row, "failure_policy") as ChildTaskLink["failurePolicy"],
    resultRef: optionalString(row, "result_ref") ?? undefined,
    createdAt: stringColumn(row, "created_at"),
  };
}

function parseJson<T>(row: Row, key: string): T {
  return JSON.parse(stringColumn(row, key)) as T;
}

function boundedMetadata(value?: TaskEvent["metadata"]): string {
  const metadata = value ?? {};
  for (const [key, item] of Object.entries(metadata)) {
    if (
      key.length > 128 ||
      (!["string", "number", "boolean"].includes(typeof item) && item !== null)
    )
      throw new Error("Invalid event metadata");
    if (typeof item === "string" && item.length > 512)
      throw new Error("Event metadata is too large");
    if (typeof item === "number" && !Number.isFinite(item))
      throw new Error("Invalid event metadata");
  }
  const json = JSON.stringify(metadata);
  if (json.length > 4096) throw new Error("Event metadata is too large");
  return json;
}

function boundedNames(values: readonly string[], label: string): void {
  if (
    !Array.isArray(values) ||
    values.length > 32 ||
    values.some((value) => typeof value !== "string" || !value.trim() || value.length > 128) ||
    new Set(values).size !== values.length
  )
    throw new Error(`Invalid ${label}`);
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    if (character.charCodeAt(0) < 32) return true;
  }
  return false;
}

function boundedDelegatedPermissions(
  values: TaskStep["delegatedPermissionSet"],
  label: string,
): void {
  if (
    !Array.isArray(values) ||
    values.length > 32 ||
    values.some(
      (permission) =>
        !permission ||
        typeof permission !== "object" ||
        Array.isArray(permission) ||
        Object.keys(permission).length !== 2 ||
        typeof permission.resourceId !== "string" ||
        !permission.resourceId.trim() ||
        permission.resourceId !== permission.resourceId.trim() ||
        permission.resourceId.length > 512 ||
        permission.resourceId.includes("*") ||
        hasControlCharacter(permission.resourceId) ||
        typeof permission.action !== "string" ||
        !permission.action.trim() ||
        permission.action !== permission.action.trim() ||
        permission.action.length > 128 ||
        permission.action.includes("*") ||
        hasControlCharacter(permission.action),
    ) ||
    new Set(values.map((permission) => JSON.stringify([permission.resourceId, permission.action])))
      .size !== values.length ||
    JSON.stringify(values).length > 32768
  )
    throw new Error(`Invalid ${label}`);
}

function validateInitialStep(step: TaskStep, taskId: string): void {
  const maxWaitHorizonMs = 365 * 24 * 60 * 60 * 1_000;
  const latestWaitAt = Date.now() + maxWaitHorizonMs;
  if (
    step.taskId !== taskId ||
    step.status !== "pending" ||
    step.version !== 1 ||
    !Number.isSafeInteger(step.maxAttempts) ||
    step.maxAttempts < 1 ||
    step.maxAttempts > 20 ||
    !step.title.trim() ||
    step.title.length > 256 ||
    (step.instructions?.length ?? 0) > 4096 ||
    (step.specRef?.length ?? 0) > 512 ||
    step.checkpointRef ||
    step.outputRef ||
    (step.timeoutMs !== undefined &&
      (!Number.isSafeInteger(step.timeoutMs) || step.timeoutMs < 1 || step.timeoutMs > 86_400_000))
  )
    throw new Error("Invalid initial step");
  boundedNames(step.requiredCapabilities, "required capabilities");
  boundedDelegatedPermissions(step.delegatedPermissionSet, "delegated permissions");
  if (
    step.kind === "tool" &&
    (typeof step.specRef !== "string" ||
      !parseTaskGetSpec(step.specRef) ||
      step.instructions !== undefined ||
      step.waitPolicy !== undefined)
  )
    throw new Error("Invalid Tool Step specification");
  const retry = step.retryPolicy;
  if (retry) {
    if (
      !Number.isSafeInteger(retry.version) ||
      retry.version < 1 ||
      retry.maxAttempts !== step.maxAttempts ||
      !Number.isSafeInteger(retry.initialDelayMs) ||
      retry.initialDelayMs < 0 ||
      !Number.isSafeInteger(retry.maxDelayMs) ||
      retry.maxDelayMs < retry.initialDelayMs ||
      retry.maxDelayMs > 86_400_000 ||
      !Number.isFinite(retry.backoffMultiplier) ||
      retry.backoffMultiplier < 1 ||
      retry.backoffMultiplier > 10 ||
      !["retryable", "failed", "unknown"].includes(retry.timeoutOutcome)
    )
      throw new Error("Invalid retry policy");
    boundedNames(retry.retryableErrorClasses, "retryable error classes");
    boundedNames(retry.nonRetryableErrorClasses, "nonretryable error classes");
  }
  const wait = step.waitPolicy;
  const waitKindMatchesStep =
    (step.kind === "timer_wait" &&
      !!wait &&
      ["duration", "until", "deadline"].includes(wait.kind)) ||
    (step.kind === "signal_wait" && wait?.kind === "signal") ||
    (step.kind === "approval_wait" && wait?.kind === "approval");
  if (
    (["timer_wait", "signal_wait", "approval_wait"].includes(step.kind) && !waitKindMatchesStep) ||
    (!["timer_wait", "signal_wait", "approval_wait"].includes(step.kind) && wait)
  )
    throw new Error("Wait policy does not match Step kind");
  if (
    wait &&
    (!Number.isSafeInteger(wait.version) ||
      wait.version < 1 ||
      !["duration", "until", "deadline", "signal", "approval", "retry"].includes(wait.kind) ||
      !["resume", "stale"].includes(wait.overdue) ||
      (wait.kind === "duration" &&
        (!Number.isSafeInteger(wait.durationMs) || !wait.durationMs || wait.durationMs < 1)) ||
      (["until", "deadline", "retry"].includes(wait.kind) && !wait.dueAt) ||
      (["signal", "approval"].includes(wait.kind) && !wait.signalKey?.trim()) ||
      (wait.durationMs !== undefined &&
        (!Number.isSafeInteger(wait.durationMs) ||
          wait.durationMs < 1 ||
          wait.durationMs > maxWaitHorizonMs)) ||
      (wait.dueAt !== undefined &&
        (!Number.isFinite(Date.parse(wait.dueAt)) || Date.parse(wait.dueAt) > latestWaitAt)) ||
      (wait.timeoutAt !== undefined &&
        (!Number.isFinite(Date.parse(wait.timeoutAt)) ||
          Date.parse(wait.timeoutAt) > latestWaitAt)) ||
      (wait.signalKey !== undefined && (!wait.signalKey.trim() || wait.signalKey.length > 128)))
  )
    throw new Error("Invalid wait policy");
  if (JSON.stringify(retry ?? {}).length > 4096 || JSON.stringify(wait ?? {}).length > 4096)
    throw new Error("Step policy is too large");
}

function parseStep(row: Row, dependencies: readonly string[]): TaskStep {
  return {
    id: stringColumn(row, "id"),
    taskId: stringColumn(row, "task_id"),
    kind: stringColumn(row, "kind") as TaskStep["kind"],
    title: stringColumn(row, "title"),
    instructions: optionalString(row, "instructions") ?? undefined,
    specRef: optionalString(row, "spec_ref") ?? undefined,
    status: stringColumn(row, "status") as TaskStepStatus,
    dependencyIds: dependencies,
    dependencyPolicy: parseJson(row, "dependency_policy_json"),
    maxAttempts: Number(row.max_attempts),
    timeoutMs: row.timeout_ms === null ? undefined : Number(row.timeout_ms),
    retryPolicy: row.retry_policy_json === null ? undefined : parseJson(row, "retry_policy_json"),
    waitPolicy: row.wait_policy_json === null ? undefined : parseJson(row, "wait_policy_json"),
    requiredCapabilities: parseJson(row, "required_capabilities_json"),
    delegatedPermissionSet: parseJson(row, "delegated_permissions_json"),
    checkpointRef: optionalString(row, "checkpoint_ref") ?? undefined,
    outputRef: optionalString(row, "output_ref") ?? undefined,
    version: Number(row.version),
    createdAt: stringColumn(row, "created_at"),
    updatedAt: stringColumn(row, "updated_at"),
  };
}

function parseEvent(row: Row): StoredTaskEvent {
  return {
    id: stringColumn(row, "id"),
    taskId: stringColumn(row, "task_id"),
    sequence: Number(row.sequence),
    type: stringColumn(row, "type") as TaskEventType,
    stepId: optionalString(row, "step_id") ?? undefined,
    attemptId: optionalString(row, "attempt_id") ?? undefined,
    actorPrincipalId: optionalString(row, "actor_principal_id") ?? undefined,
    authorizationDecisionId: optionalString(row, "decision_id") ?? undefined,
    evidenceRef: optionalString(row, "evidence_ref") ?? undefined,
    metadata: parseJson(row, "metadata_json"),
    createdAt: stringColumn(row, "created_at"),
  };
}

function parseWait(row: Row): StoredTaskWait {
  return {
    id: stringColumn(row, "id"),
    taskId: stringColumn(row, "task_id"),
    stepId: stringColumn(row, "step_id"),
    attemptId: optionalString(row, "attempt_id") ?? undefined,
    generation: Number(row.generation),
    policy: parseJson(row, "policy_json"),
    status: stringColumn(row, "status") as StoredTaskWait["status"],
    startedAt: stringColumn(row, "started_at"),
    updatedAt: stringColumn(row, "updated_at"),
  };
}

function parseLease(row: Row): StoredStepLease {
  return {
    id: stringColumn(row, "id"),
    taskId: stringColumn(row, "task_id"),
    stepId: stringColumn(row, "step_id"),
    attemptId: optionalString(row, "attempt_id") ?? undefined,
    workerBindingId: optionalString(row, "worker_binding_id") ?? undefined,
    ownerInstanceId: stringColumn(row, "owner_instance_id"),
    state: stringColumn(row, "state") as StoredStepLease["state"],
    version: Number(row.version),
    acquiredAt: stringColumn(row, "acquired_at"),
    heartbeatAt: stringColumn(row, "heartbeat_at"),
    expiresAt: stringColumn(row, "expires_at"),
    releasedAt: optionalString(row, "released_at") ?? undefined,
  };
}

const transitions: Readonly<Record<TaskStepStatus, readonly TaskStepStatus[]>> = {
  pending: ["ready", "blocked", "skipped", "cancelled"],
  ready: ["running", "waiting", "cancelled", "blocked"],
  running: ["waiting", "review", "succeeded", "failed", "cancelled"],
  waiting: ["ready", "running", "review", "failed", "cancelled"],
  blocked: ["ready", "cancelled"],
  review: ["succeeded", "failed", "cancelled", "running"],
  succeeded: [],
  failed: [],
  cancelled: [],
  skipped: [],
};

const statusEvents: Partial<Record<TaskStepStatus, TaskEventType>> = {
  ready: "STEP_READY",
  running: "STEP_STARTED",
  waiting: "STEP_WAITING",
  review: "STEP_REVIEW",
  succeeded: "STEP_SUCCEEDED",
  failed: "STEP_FAILED",
  cancelled: "STEP_CANCELLED",
  blocked: "STEP_BLOCKED",
  skipped: "STEP_SKIPPED",
};

export class LongWorkStore {
  constructor(private readonly db: DomainDatabase) {}

  /** Claims one ready Step and persists its attempt and lease before external dispatch. */
  async claimReadyStep(input: {
    taskId: string;
    stepId: string;
    expectedStepVersion: number;
    attemptId: string;
    leaseId: string;
    ownerInstanceId: string;
    leaseExpiresAt: string;
    origin: LongWorkOrigin;
  }): Promise<ClaimedTaskStep> {
    for (const value of [input.taskId, input.stepId, input.attemptId, input.leaseId])
      requireIdentifier(value);
    requireIdentifier(input.ownerInstanceId);
    if (
      input.ownerInstanceId.length > 128 ||
      !Number.isSafeInteger(input.expectedStepVersion) ||
      input.expectedStepVersion < 1
    )
      throw new Error("Invalid Step claim");
    const expiryMs = Date.parse(input.leaseExpiresAt);
    if (!Number.isFinite(expiryMs)) throw new Error("Invalid lease expiry");
    if (input.origin.kind !== "decision")
      throw new Error("Step execution needs a current principal decision");
    const origin = input.origin;

    return this.db.transaction(async (tx) => {
      await this.requireOrigin(tx, origin);
      const task = await this.requireActiveDurableTask(tx, input.taskId);
      const decision = await tx.execute({
        sql: `SELECT d.id FROM authorization_decisions d JOIN grants g ON g.id = d.grant_id
          WHERE d.id = ? AND d.principal_id = ? AND d.resource_id = ?
            AND d.action = 'task:continue' AND d.scope_key = ? AND d.decision = 'ALLOW'
            AND g.revoked_at IS NULL`,
        args: [
          origin.decisionId,
          origin.actorPrincipalId,
          `task-${input.taskId}`,
          task.origin_scope_key,
        ],
      });
      if (!decision.rows[0]) throw new Error("Current Task continuation grant is required");
      const step = await this.requireStep(tx, input.taskId, input.stepId);
      if (
        Number(step.version) !== input.expectedStepVersion ||
        stringColumn(step, "status") !== "ready"
      )
        throw new Error("Step claim conflict");
      const now = new Date().toISOString();
      if (expiryMs <= Date.parse(now) || expiryMs > Date.parse(now) + 86_400_000)
        throw new Error("Lease expiry must be within 24 hours");
      const taskStarted = await tx.execute({
        sql: "UPDATE tasks SET status = 'RUNNING', updated_at = ? WHERE id = ? AND orchestration_mode = 'durable' AND cancellation_state = 'none' AND status IN ('NEW','QUEUED','ASSIGNED','RUNNING','WAITING_INPUT')",
        args: [now, input.taskId],
      });
      if (taskStarted.rowsAffected !== 1) throw new Error("Task cannot start a Step");
      const activeLease = await tx.execute({
        sql: "SELECT id FROM task_step_leases WHERE step_id = ? AND state IN ('active','quarantined')",
        args: [input.stepId],
      });
      if (activeLease.rows[0]) throw new Error("Step already has an active lease");
      const attemptCount = await tx.execute({
        sql: `SELECT COUNT(*) AS count FROM task_attempts a
          WHERE a.task_id = ? AND a.step_id = ? AND a.attempt_number > COALESCE((
            SELECT previous.attempt_number FROM task_events e
              JOIN task_attempts previous ON previous.id = e.attempt_id
              WHERE e.task_id = ? AND e.step_id = ? AND e.type = 'TASK_REWORK'
              ORDER BY e.sequence DESC LIMIT 1
          ),0)`,
        args: [input.taskId, input.stepId, input.taskId, input.stepId],
      });
      const attemptsInCurrentCycle = Number(attemptCount.rows[0]?.count ?? 0);
      if (attemptsInCurrentCycle >= Number(step.max_attempts))
        throw new Error("Step attempt limit reached");
      const previousAttempt = await tx.execute({
        sql: "SELECT rework_reason FROM task_attempts WHERE task_id = ? AND step_id = ? ORDER BY attempt_number DESC LIMIT 1",
        args: [input.taskId, input.stepId],
      });
      const nextNumber = await tx.execute({
        sql: "SELECT COALESCE(MAX(attempt_number),0) + 1 AS value FROM task_attempts WHERE task_id = ?",
        args: [input.taskId],
      });
      const attemptNumber = Number(nextNumber.rows[0]?.value);
      if (!Number.isSafeInteger(attemptNumber) || attemptNumber < 1)
        throw new Error("Invalid attempt number");

      await tx.execute({
        sql: "INSERT INTO task_attempts(id,task_id,step_id,attempt_number,status,rework_reason,started_at) VALUES (?,?,?,?,'running',?,?)",
        args: [
          input.attemptId,
          input.taskId,
          input.stepId,
          attemptNumber,
          previousAttempt.rows[0]?.rework_reason ?? null,
          now,
        ],
      });
      const updated = await tx.execute({
        sql: "UPDATE task_steps SET status = 'running', version = version + 1, updated_at = ? WHERE id = ? AND task_id = ? AND version = ? AND status = 'ready'",
        args: [now, input.stepId, input.taskId, input.expectedStepVersion],
      });
      if (updated.rowsAffected !== 1) throw new Error("Step claim conflict");
      const leaseRow = await tx.execute({
        sql: "INSERT INTO task_step_leases(id,task_id,step_id,attempt_id,owner_instance_id,state,version,acquired_at,heartbeat_at,expires_at) VALUES (?,?,?,?,?,'active',1,?,?,?) RETURNING *",
        args: [
          input.leaseId,
          input.taskId,
          input.stepId,
          input.attemptId,
          input.ownerInstanceId,
          now,
          now,
          input.leaseExpiresAt,
        ],
      });
      await this.appendEventTx(tx, {
        taskId: input.taskId,
        stepId: input.stepId,
        attemptId: input.attemptId,
        type: "STEP_STARTED",
        origin: input.origin,
      });
      const dependencies = await tx.execute({
        sql: "SELECT dependency_id FROM task_step_dependencies WHERE task_id = ? AND step_id = ? ORDER BY dependency_id",
        args: [input.taskId, input.stepId],
      });
      return {
        step: parseStep(
          await this.requireStep(tx, input.taskId, input.stepId),
          dependencies.rows.map((row) => stringColumn(row, "dependency_id")),
        ),
        attempt: {
          id: input.attemptId,
          taskId: input.taskId,
          stepId: input.stepId,
          attemptNumber,
          status: "running",
          startedAt: now,
        },
        lease: parseLease(leaseRow.rows[0]!),
      };
    });
  }

  /** Attaches an existing Herdr WorkerBinding to the exact claimed Worker Step lease. */
  async attachClaimedWorkerBinding(input: {
    taskId: string;
    stepId: string;
    attemptId: string;
    leaseId: string;
    workerBindingId: string;
    ownerInstanceId: string;
    expectedStepVersion: number;
    expectedLeaseVersion: number;
    origin: LongWorkOrigin;
  }): Promise<StoredStepLease> {
    for (const value of [
      input.taskId,
      input.stepId,
      input.attemptId,
      input.leaseId,
      input.workerBindingId,
      input.ownerInstanceId,
    ])
      requireIdentifier(value);
    if (
      !Number.isSafeInteger(input.expectedStepVersion) ||
      input.expectedStepVersion < 1 ||
      !Number.isSafeInteger(input.expectedLeaseVersion) ||
      input.expectedLeaseVersion < 1
    )
      throw new Error("Invalid Worker binding lease version");

    return this.db.transaction(async (tx) => {
      await this.requireOrigin(tx, input.origin);
      const task = await this.requireActiveDurableTask(tx, input.taskId);
      if (stringColumn(task, "status") === "REVIEW") throw new Error("Task status conflict");
      const step = await this.requireStep(tx, input.taskId, input.stepId);
      if (
        step.kind !== "herdr_worker" ||
        step.status !== "running" ||
        Number(step.version) !== input.expectedStepVersion
      )
        throw new Error("Worker binding Step conflict");

      const attempt = await tx.execute({
        sql: "SELECT id FROM task_attempts WHERE id = ? AND task_id = ? AND step_id = ? AND status = 'running'",
        args: [input.attemptId, input.taskId, input.stepId],
      });
      if (!attempt.rows[0]) throw new Error("Worker binding Attempt conflict");

      const lease = await tx.execute({
        sql: "SELECT * FROM task_step_leases WHERE id = ? AND task_id = ? AND step_id = ? AND attempt_id = ?",
        args: [input.leaseId, input.taskId, input.stepId, input.attemptId],
      });
      const leaseRow = lease.rows[0];
      if (
        !leaseRow ||
        leaseRow.state !== "active" ||
        Number(leaseRow.version) !== input.expectedLeaseVersion ||
        leaseRow.owner_instance_id !== input.ownerInstanceId ||
        leaseRow.worker_binding_id !== null ||
        Date.parse(stringColumn(leaseRow, "expires_at")) <= Date.now()
      )
        throw new Error("Step lease ownership conflict");

      const binding = await tx.execute({
        sql: "SELECT id FROM worker_bindings WHERE id = ? AND task_attempt_id = ?",
        args: [input.workerBindingId, input.attemptId],
      });
      if (!binding.rows[0]) throw new Error("WorkerBinding does not belong to the claimed Attempt");

      const updated = await tx.execute({
        sql: `UPDATE task_step_leases SET worker_binding_id = ?, version = version + 1
          WHERE id = ? AND task_id = ? AND step_id = ? AND attempt_id = ?
            AND owner_instance_id = ? AND version = ? AND state = 'active'
            AND worker_binding_id IS NULL RETURNING *`,
        args: [
          input.workerBindingId,
          input.leaseId,
          input.taskId,
          input.stepId,
          input.attemptId,
          input.ownerInstanceId,
          input.expectedLeaseVersion,
        ],
      });
      if (!updated.rows[0]) throw new Error("Step lease ownership conflict");
      await this.appendEventTx(tx, {
        taskId: input.taskId,
        stepId: input.stepId,
        attemptId: input.attemptId,
        type: "WORKER_BOUND",
        origin: input.origin,
        metadata: { workerBindingId: input.workerBindingId },
      });
      return parseLease(updated.rows[0]);
    });
  }

  /** Settles a claimed external attempt under its exclusive lease. Unknown outcomes stay blocked. */
  async settleClaimedStep(input: {
    taskId: string;
    stepId: string;
    attemptId: string;
    leaseId: string;
    ownerInstanceId: string;
    expectedStepVersion: number;
    expectedLeaseVersion: number;
    workerBindingId?: string;
    observedAgentState?: "done" | "idle" | "unknown";
    observedAt?: string;
    outcome: "review" | "failed" | "unknown";
    evidenceRef: string;
    outputRef?: string;
    origin: LongWorkOrigin;
  }): Promise<TaskStep> {
    for (const value of [input.taskId, input.stepId, input.attemptId, input.leaseId])
      requireIdentifier(value);
    requireIdentifier(input.ownerInstanceId);
    if (input.workerBindingId !== undefined) requireIdentifier(input.workerBindingId);
    if (input.observedAgentState !== undefined && (!input.workerBindingId || !input.observedAt))
      throw new Error("Observed Worker state requires its binding");
    if (input.observedAt !== undefined && !Number.isFinite(Date.parse(input.observedAt)))
      throw new Error("Invalid Worker observation timestamp");
    if (
      !Number.isSafeInteger(input.expectedStepVersion) ||
      input.expectedStepVersion < 1 ||
      !Number.isSafeInteger(input.expectedLeaseVersion) ||
      input.expectedLeaseVersion < 1 ||
      !input.evidenceRef.trim() ||
      input.evidenceRef.length > 512 ||
      (input.outputRef !== undefined &&
        (!input.outputRef.trim() || input.outputRef.length > 512)) ||
      (input.outcome !== "review" && input.outputRef !== undefined)
    )
      throw new Error("Invalid Step settlement evidence or version");
    return this.db.transaction(async (tx) => {
      await this.requireOrigin(tx, input.origin);
      await this.requireActiveDurableTask(tx, input.taskId);
      const step = await this.requireStep(tx, input.taskId, input.stepId);
      if (step.status !== "running" || Number(step.version) !== input.expectedStepVersion)
        throw new Error("Step settlement conflict");
      const attempt = await tx.execute({
        sql: "SELECT status FROM task_attempts WHERE id = ? AND task_id = ? AND step_id = ?",
        args: [input.attemptId, input.taskId, input.stepId],
      });
      if (attempt.rows[0]?.status !== "running") throw new Error("Attempt settlement conflict");
      const lease = await tx.execute({
        sql: "SELECT state,version,owner_instance_id,attempt_id,worker_binding_id FROM task_step_leases WHERE id = ? AND task_id = ? AND step_id = ?",
        args: [input.leaseId, input.taskId, input.stepId],
      });
      const owner = lease.rows[0];
      if (
        owner?.state !== "active" ||
        Number(owner.version) !== input.expectedLeaseVersion ||
        owner.owner_instance_id !== input.ownerInstanceId ||
        owner.attempt_id !== input.attemptId ||
        (input.workerBindingId !== undefined && owner.worker_binding_id !== input.workerBindingId)
      )
        throw new Error("Step lease ownership conflict");
      const now = new Date().toISOString();
      const nextStepStatus = input.outcome === "unknown" ? "blocked" : input.outcome;
      const nextAttemptStatus = input.outcome === "unknown" ? "waiting_input" : input.outcome;
      const nextLeaseState = input.outcome === "unknown" ? "quarantined" : "released";
      const attemptUpdate = await tx.execute({
        sql: "UPDATE task_attempts SET status = ?, completed_at = ? WHERE id = ? AND task_id = ? AND step_id = ? AND status = 'running'",
        args: [
          nextAttemptStatus,
          input.outcome === "unknown" ? null : now,
          input.attemptId,
          input.taskId,
          input.stepId,
        ],
      });
      const stepUpdate = await tx.execute({
        sql: "UPDATE task_steps SET status = ?, output_ref = ?, version = version + 1, updated_at = ? WHERE id = ? AND task_id = ? AND version = ? AND status = 'running'",
        args: [
          nextStepStatus,
          input.outputRef ?? null,
          now,
          input.stepId,
          input.taskId,
          input.expectedStepVersion,
        ],
      });
      const leaseUpdate = await tx.execute({
        sql: "UPDATE task_step_leases SET state = ?, version = version + 1, heartbeat_at = ?, released_at = ? WHERE id = ? AND task_id = ? AND owner_instance_id = ? AND version = ? AND state = 'active'",
        args: [
          nextLeaseState,
          now,
          nextLeaseState === "released" ? now : null,
          input.leaseId,
          input.taskId,
          input.ownerInstanceId,
          input.expectedLeaseVersion,
        ],
      });
      if (
        attemptUpdate.rowsAffected !== 1 ||
        stepUpdate.rowsAffected !== 1 ||
        leaseUpdate.rowsAffected !== 1
      )
        throw new Error("Step settlement conflict");
      if (input.observedAgentState && input.workerBindingId) {
        const currentBinding = await tx.execute({
          sql: "SELECT updated_at FROM worker_bindings WHERE id = ? AND task_attempt_id = ?",
          args: [input.workerBindingId, input.attemptId],
        });
        const currentObservedAt = currentBinding.rows[0]
          ? Date.parse(stringColumn(currentBinding.rows[0], "updated_at"))
          : Number.NaN;
        if (
          !Number.isFinite(currentObservedAt) ||
          Date.parse(input.observedAt!) < currentObservedAt
        )
          throw new Error("Worker observation conflict");
        const observed = await tx.execute({
          sql: "UPDATE worker_bindings SET last_observed_agent_state = ?, updated_at = ? WHERE id = ? AND task_attempt_id = ?",
          args: [
            input.observedAgentState,
            input.observedAt!,
            input.workerBindingId,
            input.attemptId,
          ],
        });
        if (observed.rowsAffected !== 1) throw new Error("Step lease ownership conflict");
      }
      if (input.outcome === "review" && input.workerBindingId) {
        await tx.execute({
          sql: "UPDATE attention_items SET resolved_at = ? WHERE task_attempt_id = ? AND kind = 'worker_blocked' AND resolved_at IS NULL",
          args: [now, input.attemptId],
        });
      }
      if (input.outcome !== "unknown" || step.kind === "herdr_worker")
        await this.appendEventTx(tx, {
          taskId: input.taskId,
          stepId: input.stepId,
          attemptId: input.attemptId,
          type: input.outcome === "unknown" ? "WORKER_LOST" : "ATTEMPT_FINISHED",
          origin: input.origin,
          evidenceRef: input.evidenceRef,
          metadata: { outcome: input.outcome },
        });
      await this.appendEventTx(tx, {
        taskId: input.taskId,
        stepId: input.stepId,
        attemptId: input.attemptId,
        type: input.outcome === "unknown" ? "STEP_BLOCKED" : statusEvents[nextStepStatus]!,
        origin: input.origin,
        evidenceRef: input.evidenceRef,
        metadata: { outcome: input.outcome },
      });
      const dependencies = await tx.execute({
        sql: "SELECT dependency_id FROM task_step_dependencies WHERE task_id = ? AND step_id = ? ORDER BY dependency_id",
        args: [input.taskId, input.stepId],
      });
      return parseStep(
        await this.requireStep(tx, input.taskId, input.stepId),
        dependencies.rows.map((row) => stringColumn(row, "dependency_id")),
      );
    });
  }

  /** Settles a cancelled text-only Model Step after its internal Run reaches a terminal record.
   * An unknown Run stays unknown evidence; Task cancellation never claims rollback. */
  async settleClaimedStepCancellation(input: {
    taskId: string;
    stepId: string;
    attemptId: string;
    leaseId: string;
    ownerInstanceId: string;
    expectedStepVersion: number;
    expectedLeaseVersion: number;
    runId?: string;
    origin: LongWorkOrigin;
  }): Promise<TaskStep> {
    for (const value of [input.taskId, input.stepId, input.attemptId, input.leaseId])
      requireIdentifier(value);
    requireIdentifier(input.ownerInstanceId);
    if (input.runId !== undefined) requireIdentifier(input.runId);
    if (
      !Number.isSafeInteger(input.expectedStepVersion) ||
      input.expectedStepVersion < 1 ||
      !Number.isSafeInteger(input.expectedLeaseVersion) ||
      input.expectedLeaseVersion < 1
    )
      throw new Error("Invalid Step cancellation settlement version");
    return this.db.transaction(async (tx) => {
      await this.requireOrigin(tx, input.origin);
      const task = await this.requireTask(tx, input.taskId);
      if (
        task.orchestration_mode !== "durable" ||
        !["requested", "stopping"].includes(stringColumn(task, "cancellation_state"))
      )
        throw new Error("Task cancellation is not pending");
      const step = await this.requireStep(tx, input.taskId, input.stepId);
      if (
        (step.kind !== "model" && step.kind !== "tool") ||
        step.status !== "running" ||
        Number(step.version) !== input.expectedStepVersion
      )
        throw new Error("Step cancellation settlement conflict");
      const attempt = await tx.execute({
        sql: "SELECT status FROM task_attempts WHERE id = ? AND task_id = ? AND step_id = ?",
        args: [input.attemptId, input.taskId, input.stepId],
      });
      if (attempt.rows[0]?.status !== "running")
        throw new Error("Attempt cancellation settlement conflict");
      const lease = await tx.execute({
        sql: "SELECT state,version,owner_instance_id,attempt_id FROM task_step_leases WHERE id = ? AND task_id = ? AND step_id = ?",
        args: [input.leaseId, input.taskId, input.stepId],
      });
      const owner = lease.rows[0];
      if (
        owner?.state !== "active" ||
        Number(owner.version) !== input.expectedLeaseVersion ||
        owner.owner_instance_id !== input.ownerInstanceId ||
        owner.attempt_id !== input.attemptId
      )
        throw new Error("Step cancellation lease ownership conflict");

      const linkedRun = await tx.execute({
        sql: `SELECT r.id,r.status FROM task_attempt_runs ar
          JOIN runs r ON r.id = ar.run_id
          WHERE ar.attempt_id = ? AND ar.task_id = ? AND ar.step_id = ?`,
        args: [input.attemptId, input.taskId, input.stepId],
      });
      if (input.runId === undefined) {
        if (linkedRun.rows[0])
          throw new Error("Internal Run must be terminal before Step cancellation");
      } else {
        const linked = linkedRun.rows[0];
        if (
          !linked ||
          linked.id !== input.runId ||
          !["cancelled", "succeeded", "failed", "interrupted", "unknown"].includes(
            stringColumn(linked, "status"),
          )
        )
          throw new Error("Internal Run must be terminal before Step cancellation");
      }

      const now = new Date().toISOString();
      const attemptUpdate = await tx.execute({
        sql: "UPDATE task_attempts SET status = 'canceled', completed_at = ? WHERE id = ? AND task_id = ? AND step_id = ? AND status = 'running'",
        args: [now, input.attemptId, input.taskId, input.stepId],
      });
      const stepUpdate = await tx.execute({
        sql: "UPDATE task_steps SET status = 'cancelled', output_ref = NULL, version = version + 1, updated_at = ? WHERE id = ? AND task_id = ? AND version = ? AND status = 'running'",
        args: [now, input.stepId, input.taskId, input.expectedStepVersion],
      });
      const leaseUpdate = await tx.execute({
        sql: "UPDATE task_step_leases SET state = 'released', version = version + 1, heartbeat_at = ?, released_at = ? WHERE id = ? AND task_id = ? AND owner_instance_id = ? AND attempt_id = ? AND version = ? AND state = 'active'",
        args: [
          now,
          now,
          input.leaseId,
          input.taskId,
          input.ownerInstanceId,
          input.attemptId,
          input.expectedLeaseVersion,
        ],
      });
      if (
        attemptUpdate.rowsAffected !== 1 ||
        stepUpdate.rowsAffected !== 1 ||
        leaseUpdate.rowsAffected !== 1
      )
        throw new Error("Step cancellation settlement conflict");
      const evidenceRef = input.runId ? `run:${input.runId}` : `run-not-created:${input.attemptId}`;
      const runOutcome = linkedRun.rows[0]
        ? stringColumn(linkedRun.rows[0], "status")
        : "not_started";
      await this.appendEventTx(tx, {
        taskId: input.taskId,
        stepId: input.stepId,
        attemptId: input.attemptId,
        type: "ATTEMPT_FINISHED",
        origin: input.origin,
        evidenceRef,
        metadata: { outcome: "cancelled", runOutcome, runId: input.runId ?? null },
      });
      await this.appendEventTx(tx, {
        taskId: input.taskId,
        stepId: input.stepId,
        attemptId: input.attemptId,
        type: "STEP_CANCELLED",
        origin: input.origin,
        evidenceRef,
        metadata: {
          reason: "task_cancellation_settled",
          previousStatus: "running",
          status: "cancelled",
          runId: input.runId ?? null,
          runOutcome,
          rollbackPerformed: false,
        },
      });
      const dependencies = await tx.execute({
        sql: "SELECT dependency_id FROM task_step_dependencies WHERE task_id = ? AND step_id = ? ORDER BY dependency_id",
        args: [input.taskId, input.stepId],
      });
      return parseStep(
        await this.requireStep(tx, input.taskId, input.stepId),
        dependencies.rows.map((row) => stringColumn(row, "dependency_id")),
      );
    });
  }

  /** Settles a Worker cancellation only after a trusted caller verifies pane closure. */
  async settleClaimedWorkerCancellation(input: {
    taskId: string;
    stepId: string;
    attemptId: string;
    leaseId: string;
    workerBindingId: string;
    ownerInstanceId: string;
    expectedStepVersion: number;
    expectedLeaseVersion: number;
    closureEvidenceRef: string;
    origin: LongWorkOrigin;
  }): Promise<TaskStep> {
    for (const value of [
      input.taskId,
      input.stepId,
      input.attemptId,
      input.leaseId,
      input.workerBindingId,
      input.ownerInstanceId,
    ])
      requireIdentifier(value);
    if (
      !Number.isSafeInteger(input.expectedStepVersion) ||
      input.expectedStepVersion < 1 ||
      !Number.isSafeInteger(input.expectedLeaseVersion) ||
      input.expectedLeaseVersion < 1 ||
      !input.closureEvidenceRef.trim() ||
      input.closureEvidenceRef.length > 512
    )
      throw new Error("Invalid Worker cancellation settlement evidence or version");
    return this.db.transaction(async (tx) => {
      await this.requireOrigin(tx, input.origin);
      const task = await this.requireTask(tx, input.taskId);
      if (
        task.orchestration_mode !== "durable" ||
        !["requested", "stopping"].includes(stringColumn(task, "cancellation_state"))
      )
        throw new Error("Task cancellation is not pending");
      const step = await this.requireStep(tx, input.taskId, input.stepId);
      if (
        step.kind !== "herdr_worker" ||
        step.status !== "running" ||
        Number(step.version) !== input.expectedStepVersion
      )
        throw new Error("Worker cancellation Step conflict");
      const owned = await tx.execute({
        sql: `SELECT 1 FROM task_attempts a
          JOIN task_step_leases l ON l.attempt_id = a.id AND l.task_id = a.task_id
            AND l.step_id = a.step_id
          JOIN worker_bindings b ON b.id = l.worker_binding_id AND b.task_attempt_id = a.id
          WHERE a.id = ? AND a.task_id = ? AND a.step_id = ? AND a.status = 'running'
            AND l.id = ? AND l.worker_binding_id = ? AND l.owner_instance_id = ?
            AND l.version = ? AND l.state = 'active'`,
        args: [
          input.attemptId,
          input.taskId,
          input.stepId,
          input.leaseId,
          input.workerBindingId,
          input.ownerInstanceId,
          input.expectedLeaseVersion,
        ],
      });
      if (!owned.rows[0]) throw new Error("Worker cancellation ownership conflict");
      const now = new Date().toISOString();
      const attempt = await tx.execute({
        sql: "UPDATE task_attempts SET status = 'canceled', completed_at = ? WHERE id = ? AND task_id = ? AND step_id = ? AND status = 'running'",
        args: [now, input.attemptId, input.taskId, input.stepId],
      });
      const stepUpdate = await tx.execute({
        sql: "UPDATE task_steps SET status = 'cancelled', output_ref = NULL, version = version + 1, updated_at = ? WHERE id = ? AND task_id = ? AND version = ? AND status = 'running'",
        args: [now, input.stepId, input.taskId, input.expectedStepVersion],
      });
      const lease = await tx.execute({
        sql: "UPDATE task_step_leases SET state = 'released', version = version + 1, heartbeat_at = ?, released_at = ? WHERE id = ? AND task_id = ? AND step_id = ? AND attempt_id = ? AND worker_binding_id = ? AND owner_instance_id = ? AND version = ? AND state = 'active'",
        args: [
          now,
          now,
          input.leaseId,
          input.taskId,
          input.stepId,
          input.attemptId,
          input.workerBindingId,
          input.ownerInstanceId,
          input.expectedLeaseVersion,
        ],
      });
      if (attempt.rowsAffected !== 1 || stepUpdate.rowsAffected !== 1 || lease.rowsAffected !== 1)
        throw new Error("Worker cancellation settlement conflict");
      await this.appendEventTx(tx, {
        taskId: input.taskId,
        stepId: input.stepId,
        attemptId: input.attemptId,
        type: "ATTEMPT_FINISHED",
        origin: input.origin,
        evidenceRef: input.closureEvidenceRef,
        metadata: { outcome: "cancelled", rollbackPerformed: false },
      });
      await this.appendEventTx(tx, {
        taskId: input.taskId,
        stepId: input.stepId,
        attemptId: input.attemptId,
        type: "STEP_CANCELLED",
        origin: input.origin,
        evidenceRef: input.closureEvidenceRef,
        metadata: {
          reason: "worker_closed_after_task_cancellation",
          previousStatus: "running",
          status: "cancelled",
          rollbackPerformed: false,
        },
      });
      const deps = await tx.execute({
        sql: "SELECT dependency_id FROM task_step_dependencies WHERE task_id = ? AND step_id = ? ORDER BY dependency_id",
        args: [input.taskId, input.stepId],
      });
      return parseStep(
        await this.requireStep(tx, input.taskId, input.stepId),
        deps.rows.map((row) => stringColumn(row, "dependency_id")),
      );
    });
  }

  /** Reads linked Run state only for the current owned model Step during cancellation. */
  async getClaimedModelRunForCancellation(input: {
    taskId: string;
    stepId: string;
    attemptId: string;
    leaseId: string;
    ownerInstanceId: string;
    expectedStepVersion: number;
    expectedLeaseVersion: number;
  }): Promise<{ id: string; status: string } | null> {
    for (const value of [input.taskId, input.stepId, input.attemptId, input.leaseId])
      requireIdentifier(value);
    requireIdentifier(input.ownerInstanceId);
    if (
      !Number.isSafeInteger(input.expectedStepVersion) ||
      input.expectedStepVersion < 1 ||
      !Number.isSafeInteger(input.expectedLeaseVersion) ||
      input.expectedLeaseVersion < 1
    )
      throw new Error("Invalid Step cancellation observation version");
    return this.db.transaction(async (tx) => {
      const task = await this.requireTask(tx, input.taskId);
      if (
        task.orchestration_mode !== "durable" ||
        !["requested", "stopping"].includes(stringColumn(task, "cancellation_state"))
      )
        throw new Error("Task cancellation is not pending");
      const step = await this.requireStep(tx, input.taskId, input.stepId);
      if (
        (step.kind !== "model" && step.kind !== "tool") ||
        step.status !== "running" ||
        step.version !== input.expectedStepVersion
      )
        throw new Error("Step cancellation observation conflict");
      const attempt = await tx.execute({
        sql: "SELECT status FROM task_attempts WHERE id = ? AND task_id = ? AND step_id = ?",
        args: [input.attemptId, input.taskId, input.stepId],
      });
      if (attempt.rows[0]?.status !== "running")
        throw new Error("Attempt cancellation observation conflict");
      const lease = await tx.execute({
        sql: "SELECT state,version,owner_instance_id,attempt_id FROM task_step_leases WHERE id = ? AND task_id = ? AND step_id = ?",
        args: [input.leaseId, input.taskId, input.stepId],
      });
      const owner = lease.rows[0];
      if (
        owner?.state !== "active" ||
        Number(owner.version) !== input.expectedLeaseVersion ||
        owner.owner_instance_id !== input.ownerInstanceId ||
        owner.attempt_id !== input.attemptId
      )
        throw new Error("Step cancellation lease ownership conflict");
      const linked = await tx.execute({
        sql: `SELECT r.id,r.status FROM task_attempt_runs ar
          JOIN runs r ON r.id = ar.run_id
          WHERE ar.attempt_id = ? AND ar.task_id = ? AND ar.step_id = ?`,
        args: [input.attemptId, input.taskId, input.stepId],
      });
      const row = linked.rows[0];
      return row ? { id: stringColumn(row, "id"), status: stringColumn(row, "status") } : null;
    });
  }

  /** Finishes a failed claimed attempt and schedules a retry only with durable proof that
   * its side effect did not start or was not applied. The Step, Attempt, lease, wait, and
   * Raw Trace events change atomically under the exact current lease version. */
  async scheduleClaimedStepRetry(input: {
    taskId: string;
    stepId: string;
    attemptId: string;
    leaseId: string;
    ownerInstanceId: string;
    expectedStepVersion: number;
    expectedLeaseVersion: number;
    proof: {
      ref: string;
      sideEffectOutcome: Extract<RetrySideEffectOutcome, "not_started" | "not_applied">;
      errorClass?: string;
      timedOut?: boolean;
    };
    origin: LongWorkOrigin;
  }): Promise<TaskStep> {
    for (const value of [input.taskId, input.stepId, input.attemptId, input.leaseId])
      requireIdentifier(value);
    requireIdentifier(input.ownerInstanceId);
    if (
      !Number.isSafeInteger(input.expectedStepVersion) ||
      input.expectedStepVersion < 1 ||
      !Number.isSafeInteger(input.expectedLeaseVersion) ||
      input.expectedLeaseVersion < 1 ||
      !input.proof.ref.trim() ||
      input.proof.ref.length > 512 ||
      !["not_started", "not_applied"].includes(input.proof.sideEffectOutcome) ||
      (input.proof.errorClass !== undefined &&
        (!input.proof.errorClass.trim() || input.proof.errorClass.length > 128)) ||
      (input.proof.timedOut !== undefined && typeof input.proof.timedOut !== "boolean")
    )
      throw new Error("Invalid retry proof or version");

    return this.db.transaction(async (tx) => {
      await this.requireOrigin(tx, input.origin);
      await this.requireActiveDurableTask(tx, input.taskId);
      const stepRow = await this.requireStep(tx, input.taskId, input.stepId);
      const dependencyRows = await tx.execute({
        sql: "SELECT dependency_id FROM task_step_dependencies WHERE task_id = ? AND step_id = ? ORDER BY dependency_id",
        args: [input.taskId, input.stepId],
      });
      const dependencies = dependencyRows.rows.map((row) => stringColumn(row, "dependency_id"));
      const step = parseStep(stepRow, dependencies);
      if (step.status !== "running" || Number(step.version) !== input.expectedStepVersion)
        throw new Error("Step retry settlement conflict");
      if (!step.retryPolicy) throw new Error("Step retry policy is required");

      const attempt = await tx.execute({
        sql: "SELECT status FROM task_attempts WHERE id = ? AND task_id = ? AND step_id = ?",
        args: [input.attemptId, input.taskId, input.stepId],
      });
      if (attempt.rows[0]?.status !== "running")
        throw new Error("Attempt retry settlement conflict");
      const lease = await tx.execute({
        sql: "SELECT state,version,owner_instance_id,attempt_id FROM task_step_leases WHERE id = ? AND task_id = ? AND step_id = ?",
        args: [input.leaseId, input.taskId, input.stepId],
      });
      const owner = lease.rows[0];
      if (
        owner?.state !== "active" ||
        Number(owner.version) !== input.expectedLeaseVersion ||
        owner.owner_instance_id !== input.ownerInstanceId ||
        owner.attempt_id !== input.attemptId
      )
        throw new Error("Step lease ownership conflict");

      const currentCycleCount = await tx.execute({
        sql: `SELECT COUNT(*) AS count FROM task_attempts a
          WHERE a.task_id = ? AND a.step_id = ? AND a.attempt_number > COALESCE((
            SELECT previous.attempt_number FROM task_events e
              JOIN task_attempts previous ON previous.id = e.attempt_id
              WHERE e.task_id = ? AND e.step_id = ? AND e.type = 'TASK_REWORK'
              ORDER BY e.sequence DESC LIMIT 1
          ),0)`,
        args: [input.taskId, input.stepId, input.taskId, input.stepId],
      });
      const attemptNumber = Number(currentCycleCount.rows[0]?.count ?? 0);
      const now = new Date().toISOString();
      const decision = decideTaskRetry({
        policy: step.retryPolicy,
        attemptNumber,
        nowMs: Date.parse(now),
        errorClass: input.proof.errorClass,
        timedOut: input.proof.timedOut,
        sideEffectOutcome: input.proof.sideEffectOutcome,
      });
      if (decision.action !== "retry")
        throw new Error(`Retry was not authorized: ${decision.action}/${decision.reason}`);
      const dueAt = new Date(decision.retryAtMs).toISOString();
      const activeWait = await tx.execute({
        sql: "SELECT id FROM task_waits WHERE task_id = ? AND step_id = ? AND status = 'waiting' LIMIT 1",
        args: [input.taskId, input.stepId],
      });
      if (activeWait.rows[0]) throw new Error("Step already has an active wait");
      const generation =
        Number(
          (
            await tx.execute({
              sql: "SELECT COALESCE(MAX(generation),0) AS value FROM task_waits WHERE task_id = ? AND step_id = ?",
              args: [input.taskId, input.stepId],
            })
          ).rows[0]?.value ?? 0,
        ) + 1;
      const waitId = randomUUID();
      const waitPolicy: TaskWaitPolicy = { version: 1, kind: "retry", dueAt, overdue: "resume" };

      const attemptUpdate = await tx.execute({
        sql: "UPDATE task_attempts SET status = 'failed', completed_at = ? WHERE id = ? AND task_id = ? AND step_id = ? AND status = 'running'",
        args: [now, input.attemptId, input.taskId, input.stepId],
      });
      const stepUpdate = await tx.execute({
        sql: "UPDATE task_steps SET status = 'waiting', wait_policy_json = ?, version = version + 1, updated_at = ? WHERE id = ? AND task_id = ? AND version = ? AND status = 'running'",
        args: [
          JSON.stringify(waitPolicy),
          now,
          input.stepId,
          input.taskId,
          input.expectedStepVersion,
        ],
      });
      const leaseUpdate = await tx.execute({
        sql: "UPDATE task_step_leases SET state = 'released', version = version + 1, heartbeat_at = ?, released_at = ? WHERE id = ? AND task_id = ? AND owner_instance_id = ? AND attempt_id = ? AND version = ? AND state = 'active'",
        args: [
          now,
          now,
          input.leaseId,
          input.taskId,
          input.ownerInstanceId,
          input.attemptId,
          input.expectedLeaseVersion,
        ],
      });
      if (
        attemptUpdate.rowsAffected !== 1 ||
        stepUpdate.rowsAffected !== 1 ||
        leaseUpdate.rowsAffected !== 1
      )
        throw new Error("Step retry settlement conflict");
      await tx.execute({
        sql: "INSERT INTO task_waits(id,task_id,step_id,attempt_id,generation,kind,status,started_at,due_at,signal_key,timeout_at,policy_json,updated_at) VALUES (?,?,?,?,?,'retry','waiting',?,?,?,?,?,?)",
        args: [
          waitId,
          input.taskId,
          input.stepId,
          input.attemptId,
          generation,
          now,
          dueAt,
          null,
          null,
          JSON.stringify(waitPolicy),
          now,
        ],
      });
      const metadata = {
        attemptNumber,
        delayMs: decision.delayMs,
        reason: decision.reason,
        sideEffectOutcome: input.proof.sideEffectOutcome,
        errorClass: input.proof.errorClass ?? null,
        timedOut: input.proof.timedOut ?? false,
      };
      await this.appendEventTx(tx, {
        taskId: input.taskId,
        stepId: input.stepId,
        attemptId: input.attemptId,
        type: "ATTEMPT_FINISHED",
        origin: input.origin,
        evidenceRef: input.proof.ref,
        metadata: { outcome: "failed", ...metadata },
      });
      await this.appendEventTx(tx, {
        taskId: input.taskId,
        stepId: input.stepId,
        attemptId: input.attemptId,
        type: "RETRY_SCHEDULED",
        origin: input.origin,
        evidenceRef: input.proof.ref,
        metadata: { dueAt, generation, ...metadata },
      });
      await this.appendEventTx(tx, {
        taskId: input.taskId,
        stepId: input.stepId,
        attemptId: input.attemptId,
        type: "STEP_WAITING",
        origin: input.origin,
        evidenceRef: input.proof.ref,
        metadata: { generation, reason: "retry_scheduled" },
      });
      return parseStep(await this.requireStep(tx, input.taskId, input.stepId), step.dependencyIds);
    });
  }

  /** Records a current Herdr state and its blocked Attention under the exact claimed lease. */
  async observeClaimedWorkerState(input: {
    taskId: string;
    stepId: string;
    attemptId: string;
    leaseId: string;
    workerBindingId: string;
    ownerInstanceId: string;
    expectedStepVersion: number;
    expectedLeaseVersion: number;
    state: HerdrAgentLifecycleState;
    observedAt: string;
    evidenceRef: string;
    origin: LongWorkOrigin;
  }): Promise<void> {
    for (const value of [
      input.taskId,
      input.stepId,
      input.attemptId,
      input.leaseId,
      input.workerBindingId,
      input.ownerInstanceId,
    ])
      requireIdentifier(value);
    if (
      !Number.isSafeInteger(input.expectedStepVersion) ||
      input.expectedStepVersion < 1 ||
      !Number.isSafeInteger(input.expectedLeaseVersion) ||
      input.expectedLeaseVersion < 1 ||
      !input.evidenceRef.trim() ||
      input.evidenceRef.length > 512 ||
      !Number.isFinite(Date.parse(input.observedAt))
    )
      throw new Error("Invalid Worker observation evidence or version");
    return this.db.transaction(async (tx) => {
      await this.requireOrigin(tx, input.origin);
      const task = await this.requireActiveDurableTask(tx, input.taskId);
      if (stringColumn(task, "status") === "REVIEW") throw new Error("Task status conflict");
      const step = await this.requireStep(tx, input.taskId, input.stepId);
      if (
        step.kind !== "herdr_worker" ||
        step.status !== "running" ||
        step.version !== input.expectedStepVersion
      )
        throw new Error("Step observation conflict");
      const attempt = await tx.execute({
        sql: "SELECT status FROM task_attempts WHERE id = ? AND task_id = ? AND step_id = ?",
        args: [input.attemptId, input.taskId, input.stepId],
      });
      if (attempt.rows[0]?.status !== "running") throw new Error("Attempt observation conflict");
      const lease = await tx.execute({
        sql: "SELECT state,version,owner_instance_id,attempt_id,worker_binding_id FROM task_step_leases WHERE id = ? AND task_id = ? AND step_id = ?",
        args: [input.leaseId, input.taskId, input.stepId],
      });
      const owner = lease.rows[0];
      if (
        owner?.state !== "active" ||
        Number(owner.version) !== input.expectedLeaseVersion ||
        owner.owner_instance_id !== input.ownerInstanceId ||
        owner.attempt_id !== input.attemptId ||
        owner.worker_binding_id !== input.workerBindingId
      )
        throw new Error("Step lease ownership conflict");
      const now = new Date().toISOString();
      const binding = await tx.execute({
        sql: "UPDATE worker_bindings SET last_observed_agent_state = ?, updated_at = ? WHERE id = ? AND task_attempt_id = ? AND updated_at <= ?",
        args: [
          input.state,
          input.observedAt,
          input.workerBindingId,
          input.attemptId,
          input.observedAt,
        ],
      });
      if (binding.rowsAffected !== 1) throw new Error("Worker observation conflict");

      if (input.state === "blocked") {
        await tx.execute({
          sql: "UPDATE tasks SET status = 'WAITING_INPUT', updated_at = ? WHERE id = ? AND orchestration_mode = 'durable' AND cancellation_state = 'none' AND status NOT IN ('DONE','CANCELED','FAILED','ACCEPTED','REVIEW')",
          args: [now, input.taskId],
        });
        const existing = await tx.execute({
          sql: "SELECT id FROM attention_items WHERE task_attempt_id = ? AND kind = 'worker_blocked' AND resolved_at IS NULL LIMIT 1",
          args: [input.attemptId],
        });
        if (!existing.rows[0]) {
          await tx.execute({
            sql: "INSERT INTO attention_items(id,kind,summary,principal_id,task_id,task_attempt_id,created_at) VALUES (?,'worker_blocked','Durable Worker is waiting for input',?,?,?,?)",
            args: [
              randomUUID(),
              optionalString(task, "creator_principal_id"),
              input.taskId,
              input.attemptId,
              now,
            ],
          });
          await this.appendEventTx(tx, {
            taskId: input.taskId,
            stepId: input.stepId,
            attemptId: input.attemptId,
            type: "TASK_BLOCKED",
            origin: input.origin,
            evidenceRef: input.evidenceRef,
            metadata: { reason: "worker_blocked" },
          });
        }
      } else if (input.state === "working") {
        await tx.execute({
          sql: "UPDATE attention_items SET resolved_at = ? WHERE task_attempt_id = ? AND kind = 'worker_blocked' AND resolved_at IS NULL",
          args: [now, input.attemptId],
        });
        const attention = await tx.execute({
          sql: "SELECT 1 FROM attention_items WHERE task_id = ? AND resolved_at IS NULL LIMIT 1",
          args: [input.taskId],
        });
        const blockedSteps = await tx.execute({
          sql: "SELECT 1 FROM task_steps WHERE task_id = ? AND id <> ? AND status IN ('blocked','failed') LIMIT 1",
          args: [input.taskId, input.stepId],
        });
        const waits = await tx.execute({
          sql: "SELECT 1 FROM task_waits WHERE task_id = ? AND status = 'waiting' LIMIT 1",
          args: [input.taskId],
        });
        if (!attention.rows[0] && !blockedSteps.rows[0] && !waits.rows[0])
          await tx.execute({
            sql: "UPDATE tasks SET status = 'RUNNING', updated_at = ? WHERE id = ? AND status = 'WAITING_INPUT' AND cancellation_state = 'none'",
            args: [now, input.taskId],
          });
      }
    });
  }

  private async requireOrigin(tx: Transaction, origin: LongWorkOrigin): Promise<void> {
    if (origin.kind === "system") {
      if (!origin.reason.trim() || origin.reason.length > 256)
        throw new Error("System reason is required");
      if (origin.decisionId) {
        requireIdentifier(origin.decisionId);
        const result = await tx.execute({
          sql: "SELECT id FROM authorization_decisions WHERE id = ? AND decision = 'ALLOW'",
          args: [origin.decisionId],
        });
        if (!result.rows[0]) throw new Error("Recorded ALLOW decision is required");
      }
      return;
    }
    requireIdentifier(origin.decisionId);
    requireIdentifier(origin.actorPrincipalId);
    const result = await tx.execute({
      sql: "SELECT id FROM authorization_decisions WHERE id = ? AND principal_id = ? AND decision = 'ALLOW'",
      args: [origin.decisionId, origin.actorPrincipalId],
    });
    if (!result.rows[0]) throw new Error("Recorded ALLOW decision is required");
  }

  private async requireTask(tx: Transaction, taskId: string): Promise<Row> {
    const result = await tx.execute({ sql: "SELECT * FROM tasks WHERE id = ?", args: [taskId] });
    if (!result.rows[0]) throw new Error(`Task not found: ${taskId}`);
    return result.rows[0];
  }

  private async requireActiveDurableTask(tx: Transaction, taskId: string): Promise<Row> {
    const task = await this.requireTask(tx, taskId);
    if (
      task.orchestration_mode !== "durable" ||
      task.cancellation_state !== "none" ||
      ["DONE", "CANCELED", "ACCEPTED", "FAILED"].includes(stringColumn(task, "status"))
    )
      throw new Error("Task is not active durable work");
    return task;
  }

  private async requireStep(tx: Transaction, taskId: string, stepId: string): Promise<Row> {
    const result = await tx.execute({
      sql: "SELECT * FROM task_steps WHERE id = ? AND task_id = ?",
      args: [stepId, taskId],
    });
    if (!result.rows[0]) throw new Error(`Step not found in task: ${stepId}`);
    return result.rows[0];
  }

  private async requireAttempt(
    tx: Transaction,
    taskId: string,
    attemptId?: string,
    stepId?: string,
  ): Promise<void> {
    if (!attemptId) return;
    const result = await tx.execute({
      sql: "SELECT id,step_id FROM task_attempts WHERE id = ? AND task_id = ?",
      args: [attemptId, taskId],
    });
    if (!result.rows[0]) throw new Error("Attempt does not belong to task");
    if (stepId && result.rows[0].step_id !== null && result.rows[0].step_id !== stepId)
      throw new Error("Attempt does not belong to step");
  }

  private async appendEventTx(
    tx: Transaction,
    params: {
      taskId: string;
      type: TaskEventType;
      origin: LongWorkOrigin;
      stepId?: string;
      attemptId?: string;
      evidenceRef?: string;
      metadata?: TaskEvent["metadata"];
    },
  ): Promise<StoredTaskEvent> {
    if (!TASK_EVENT_TYPES.includes(params.type)) throw new Error("Invalid Task event type");
    await this.requireTask(tx, params.taskId);
    if (params.stepId) await this.requireStep(tx, params.taskId, params.stepId);
    await this.requireAttempt(tx, params.taskId, params.attemptId, params.stepId);
    await this.requireOrigin(tx, params.origin);
    const result = await tx.execute({
      sql: "INSERT INTO task_events(id,task_id,step_id,attempt_id,type,actor_principal_id,decision_id,evidence_ref,metadata_json,created_at) VALUES (?,?,?,?,?,?,?,?,?,?) RETURNING *",
      args: [
        randomUUID(),
        params.taskId,
        params.stepId ?? null,
        params.attemptId ?? null,
        params.type,
        params.origin.kind === "decision" ? params.origin.actorPrincipalId : null,
        params.origin.decisionId ?? null,
        params.evidenceRef ?? null,
        boundedMetadata(
          params.origin.kind === "system"
            ? { ...params.metadata, systemReason: params.origin.reason }
            : params.metadata,
        ),
        new Date().toISOString(),
      ],
    });
    await this.refreshTaskProjectionTx(tx, params.taskId);
    return parseEvent(result.rows[0]!);
  }

  private async refreshTaskProjectionTx(tx: Transaction, taskId: string): Promise<void> {
    const task = await this.requireTask(tx, taskId);
    if (task.orchestration_mode !== "durable") return;
    const steps = await tx.execute({
      sql: "SELECT id,status FROM task_steps WHERE task_id = ? ORDER BY created_at,id",
      args: [taskId],
    });
    const statuses = steps.rows.map((row) => stringColumn(row, "status"));
    const activeStepIds = steps.rows
      .filter((row) =>
        ["ready", "running", "waiting", "blocked", "review"].includes(stringColumn(row, "status")),
      )
      .map((row) => stringColumn(row, "id"));
    const wait = await tx.execute({
      sql: "SELECT kind FROM task_waits WHERE task_id = ? AND status = 'waiting' ORDER BY started_at,id LIMIT 1",
      args: [taskId],
    });
    const taskStatus = stringColumn(task, "status");
    const phase = ["DONE", "CANCELED", "FAILED"].includes(taskStatus)
      ? "complete"
      : taskStatus === "REVIEW"
        ? "review"
        : statuses.includes("blocked")
          ? "blocked"
          : statuses.includes("running")
            ? "running"
            : statuses.includes("ready")
              ? "ready"
              : statuses.includes("waiting")
                ? "waiting"
                : "planned";
    await tx.execute({
      sql: "UPDATE tasks SET active_step_ids_json = ?, current_phase = ?, waiting_reason = ? WHERE id = ? AND orchestration_mode = 'durable'",
      args: [
        JSON.stringify(activeStepIds),
        phase,
        wait.rows[0] ? stringColumn(wait.rows[0], "kind") : null,
        taskId,
      ],
    });
  }

  /** Internal read. The service must authorize the caller before exposing any result. */
  async listSteps(taskId: string): Promise<TaskStep[]> {
    requireIdentifier(taskId);
    return this.db.transaction(async (tx) => {
      await this.requireTask(tx, taskId);
      const result = await tx.execute({
        sql: "SELECT * FROM task_steps WHERE task_id = ? ORDER BY created_at,id",
        args: [taskId],
      });
      const deps = await tx.execute({
        sql: "SELECT step_id,dependency_id FROM task_step_dependencies WHERE task_id = ? ORDER BY dependency_id",
        args: [taskId],
      });
      const byStep = new Map<string, string[]>();
      for (const row of deps.rows) {
        const id = stringColumn(row, "step_id");
        byStep.set(id, [...(byStep.get(id) ?? []), stringColumn(row, "dependency_id")]);
      }
      return result.rows.map((row) => parseStep(row, byStep.get(stringColumn(row, "id")) ?? []));
    });
  }

  /** Links a pristine same-principal, same-scope Task to an authorized child_task Step. */
  async createChildTaskLink(input: {
    parentTaskId: string;
    parentStepId: string;
    expectedStepVersion: number;
    childTaskId: string;
    delegatedPermissionSet: ChildTaskLink["delegatedPermissionSet"];
    acceptanceCriteria: readonly string[];
    cancellationPolicy: ChildTaskLink["cancellationPolicy"];
    failurePolicy: ChildTaskLink["failurePolicy"];
    origin: LongWorkOrigin;
  }): Promise<ChildTaskLink> {
    for (const value of [input.parentTaskId, input.parentStepId, input.childTaskId])
      requireIdentifier(value);
    if (
      input.parentTaskId === input.childTaskId ||
      !Number.isSafeInteger(input.expectedStepVersion) ||
      input.expectedStepVersion < 1 ||
      !["cancel_child", "keep_child"].includes(input.cancellationPolicy) ||
      !["block_parent", "fail_parent", "review_parent"].includes(input.failurePolicy)
    )
      throw new Error("Invalid child Task link");
    boundedDelegatedPermissions(input.delegatedPermissionSet, "child delegated permissions");
    const acceptanceCriteriaJson = boundedCriteria(input.acceptanceCriteria);
    if (input.origin.kind !== "decision")
      throw new Error("Child Task creation needs a principal continuation decision");
    const origin = input.origin;

    return this.db.transaction(async (tx) => {
      await this.requireOrigin(tx, origin);
      const parent = await this.requireActiveDurableTask(tx, input.parentTaskId);
      const step = await this.requireStep(tx, input.parentTaskId, input.parentStepId);
      if (
        stringColumn(step, "kind") !== "child_task" ||
        !["ready", "running"].includes(stringColumn(step, "status")) ||
        Number(step.version) !== input.expectedStepVersion
      )
        throw new Error("Child Task Step version or state conflict");

      const decision = await tx.execute({
        sql: `SELECT d.id FROM authorization_decisions d JOIN grants g ON g.id = d.grant_id
          WHERE d.id = ? AND d.principal_id = ? AND d.resource_id = ?
            AND d.action = 'task:continue' AND d.scope_key = ? AND d.decision = 'ALLOW'
            AND g.revoked_at IS NULL`,
        args: [
          origin.decisionId,
          origin.actorPrincipalId,
          `task-${input.parentTaskId}`,
          parent.origin_scope_key,
        ],
      });
      if (!decision.rows[0]) throw new Error("Current Task continuation grant is required");

      const parentPermissions = parseJson<TaskStep["delegatedPermissionSet"]>(
        step,
        "delegated_permissions_json",
      );
      boundedDelegatedPermissions(parentPermissions, "parent Step delegated permissions");
      if (
        input.delegatedPermissionSet.some(
          (permission) =>
            !parentPermissions.some(
              (parentPermission) =>
                parentPermission.resourceId === permission.resourceId &&
                parentPermission.action === permission.action,
            ),
        )
      )
        throw new Error("Child permissions exceed the parent Step delegation");
      if (input.delegatedPermissionSet.length > 0) {
        const scope = reconstructTaskOriginScope(
          stringColumn(parent, "origin_scope_key"),
          parent.origin_scope_json,
        );
        for (const permission of input.delegatedPermissionSet) {
          const current = await evaluate(tx, {
            caller: { principalId: origin.actorPrincipalId, scope },
            resourceId: permission.resourceId,
            action: permission.action,
            delegatedTaskId: input.parentTaskId,
          });
          if (current.decision !== "ALLOW")
            throw new Error("Child permission is not currently granted to the parent Task");
        }
      }

      const childResult = await tx.execute({
        sql: "SELECT * FROM tasks WHERE id = ?",
        args: [input.childTaskId],
      });
      const child = childResult.rows[0];
      if (
        !child ||
        child.creator_principal_id !== origin.actorPrincipalId ||
        child.creator_principal_id !== parent.creator_principal_id ||
        child.origin_scope_key !== parent.origin_scope_key ||
        child.orchestration_mode !== "legacy" ||
        child.status !== "NEW" ||
        child.cancellation_state !== "none"
      )
        throw new Error("Child Task must be a new Task in the same principal and scope");

      const used = await tx.execute({
        sql: `SELECT
            EXISTS(SELECT 1 FROM task_steps WHERE task_id = ?) AS has_steps,
            EXISTS(SELECT 1 FROM task_attempts WHERE task_id = ?) AS has_attempts,
            EXISTS(SELECT 1 FROM task_child_links WHERE child_task_id = ? OR parent_task_id = ?) AS has_links`,
        args: [input.childTaskId, input.childTaskId, input.childTaskId, input.childTaskId],
      });
      const usage = used.rows[0]!;
      if (Number(usage.has_steps) || Number(usage.has_attempts) || Number(usage.has_links))
        throw new Error("Child Task must not have execution history or links");

      const existingStepLink = await tx.execute({
        sql: "SELECT 1 FROM task_child_links WHERE parent_task_id = ? AND parent_step_id = ? LIMIT 1",
        args: [input.parentTaskId, input.parentStepId],
      });
      if (existingStepLink.rows[0]) throw new Error("Child Task Step already has a link");

      const cycle = await tx.execute({
        sql: `WITH RECURSIVE descendants(task_id) AS (
            SELECT child_task_id FROM task_child_links WHERE parent_task_id = ?
            UNION
            SELECT links.child_task_id FROM task_child_links links
              JOIN descendants d ON links.parent_task_id = d.task_id
          ) SELECT 1 FROM descendants WHERE task_id = ? LIMIT 1`,
        args: [input.childTaskId, input.parentTaskId],
      });
      if (cycle.rows[0]) throw new Error("Child Task link would create a cycle");

      const childCountResult = await tx.execute({
        sql: "SELECT COUNT(*) AS count FROM task_child_links WHERE parent_task_id = ?",
        args: [input.parentTaskId],
      });
      const attemptedChildCount = Number(childCountResult.rows[0]?.count ?? 0) + 1;
      if (attemptedChildCount > MAX_CHILD_TASKS_PER_PARENT)
        throw new ChildTaskLinkError(
          "CHILD_COUNT_LIMIT",
          MAX_CHILD_TASKS_PER_PARENT,
          attemptedChildCount,
        );

      const ancestorDepthResult = await tx.execute({
        sql: `WITH RECURSIVE ancestors(task_id,depth) AS (
            SELECT ?,0
            UNION ALL
            SELECT links.parent_task_id,ancestors.depth + 1
              FROM task_child_links links
              JOIN ancestors ON links.child_task_id = ancestors.task_id
              WHERE ancestors.depth < ?
          ) SELECT MAX(depth) AS depth FROM ancestors`,
        args: [input.parentTaskId, MAX_CHILD_TASK_ANCESTOR_DEPTH],
      });
      const attemptedDepth = Number(ancestorDepthResult.rows[0]?.depth ?? 0) + 1;
      if (attemptedDepth > MAX_CHILD_TASK_ANCESTOR_DEPTH)
        throw new ChildTaskLinkError(
          "CHILD_DEPTH_LIMIT",
          MAX_CHILD_TASK_ANCESTOR_DEPTH,
          attemptedDepth,
        );

      const now = new Date().toISOString();
      const updated = await tx.execute({
        sql: `UPDATE task_steps SET status = 'running', version = version + 1, updated_at = ?
          WHERE id = ? AND task_id = ? AND version = ? AND status IN ('ready','running')
            AND kind = 'child_task'`,
        args: [now, input.parentStepId, input.parentTaskId, input.expectedStepVersion],
      });
      if (updated.rowsAffected !== 1) throw new Error("Child Task Step version conflict");
      const inserted = await tx.execute({
        sql: `INSERT INTO task_child_links(
            child_task_id,parent_task_id,parent_step_id,delegated_permissions_json,
            acceptance_criteria_json,cancel_policy,failure_policy,created_at
          ) VALUES (?,?,?,?,?,?,?,?) RETURNING *`,
        args: [
          input.childTaskId,
          input.parentTaskId,
          input.parentStepId,
          JSON.stringify(input.delegatedPermissionSet),
          acceptanceCriteriaJson,
          input.cancellationPolicy,
          input.failurePolicy,
          now,
        ],
      });
      await this.appendEventTx(tx, {
        taskId: input.parentTaskId,
        stepId: input.parentStepId,
        type: "CHILD_TASK_CREATED",
        origin,
        metadata: { childTaskId: input.childTaskId },
      });
      return parseChildTaskLink(inserted.rows[0]!);
    });
  }

  /** Internal read. The service must authorize the caller before exposing any result. */
  async getChildTaskLink(childTaskId: string): Promise<ChildTaskLink | null> {
    requireIdentifier(childTaskId);
    return this.db.transaction(async (tx) => {
      const result = await tx.execute({
        sql: "SELECT * FROM task_child_links WHERE child_task_id = ?",
        args: [childTaskId],
      });
      return result.rows[0] ? parseChildTaskLink(result.rows[0]) : null;
    });
  }

  /** Internal read. The service must authorize the caller before exposing any result. */
  async listChildTaskLinks(parentTaskId: string, parentStepId?: string): Promise<ChildTaskLink[]> {
    requireIdentifier(parentTaskId);
    if (parentStepId) requireIdentifier(parentStepId);
    return this.db.transaction(async (tx) => {
      await this.requireTask(tx, parentTaskId);
      if (parentStepId) await this.requireStep(tx, parentTaskId, parentStepId);
      const result = await tx.execute({
        sql: `SELECT * FROM task_child_links WHERE parent_task_id = ?
          ${parentStepId ? "AND parent_step_id = ?" : ""} ORDER BY created_at,child_task_id`,
        args: parentStepId ? [parentTaskId, parentStepId] : [parentTaskId],
      });
      return result.rows.map(parseChildTaskLink);
    });
  }

  /** Creates a new durable graph on an existing Task. Existing P3 Tasks remain legacy. */
  async createGraph(
    taskId: string,
    steps: readonly TaskStep[],
    rootStepId: string,
    limits: TaskGraphLimits,
    origin: LongWorkOrigin,
  ): Promise<void> {
    requireIdentifier(taskId);
    requireIdentifier(rootStepId);
    validateTaskGraph(steps, limits);
    if (!steps.some((step) => step.id === rootStepId)) throw new Error("Root step is missing");
    if (steps.length === 0) throw new Error("Graph must contain a step");
    for (const step of steps) {
      validateInitialStep(step, taskId);
      requireIdentifier(step.id);
    }
    await this.db.transaction(async (tx) => {
      await this.requireOrigin(tx, origin);
      const task = await this.requireTask(tx, taskId);
      if (origin.kind === "decision") {
        const currentDecision = await tx.execute({
          sql: `SELECT d.id FROM authorization_decisions d JOIN grants g ON g.id = d.grant_id
            WHERE d.id = ? AND d.principal_id = ? AND d.resource_id = ?
              AND d.action = 'task:plan' AND d.scope_key = ? AND d.decision = 'ALLOW'
              AND g.revoked_at IS NULL`,
          args: [
            origin.decisionId,
            origin.actorPrincipalId,
            `task-${taskId}`,
            task.origin_scope_key,
          ],
        });
        if (!currentDecision.rows[0]) throw new Error("Current Task planning grant is required");
        if (steps.some((step) => step.delegatedPermissionSet.length > 0)) {
          const scope = reconstructTaskOriginScope(
            stringColumn(task, "origin_scope_key"),
            task.origin_scope_json,
          );
          for (const step of steps) {
            for (const permission of step.delegatedPermissionSet) {
              const delegated = await evaluate(tx, {
                caller: { principalId: origin.actorPrincipalId, scope },
                resourceId: permission.resourceId,
                action: permission.action,
                delegatedTaskId: taskId,
              });
              if (delegated.decision !== "ALLOW")
                throw new Error("Declared Step permission is not currently granted");
            }
          }
        }
      }
      if (
        task.orchestration_mode !== "legacy" ||
        !["NEW", "QUEUED"].includes(stringColumn(task, "status")) ||
        task.cancellation_state !== "none" ||
        task.active_attempt_id !== null
      )
        throw new Error("Task cannot adopt a graph");
      const activeLimit = limits.maxActiveTasksPerPrincipal ?? 16;
      if (!Number.isSafeInteger(activeLimit) || activeLimit < 1)
        throw new TaskGraphError("INVALID_LIMIT", "Invalid active Task limit");
      const activeTasks = await tx.execute({
        sql: `SELECT COUNT(*) AS count FROM tasks
              WHERE creator_principal_id = ? AND orchestration_mode = 'durable'
                AND status NOT IN ('DONE','CANCELED','FAILED')`,
        args: [stringColumn(task, "creator_principal_id")],
      });
      if (Number(activeTasks.rows[0]?.count ?? 0) >= activeLimit)
        throw new TaskGraphError("ACTIVE_TASK_LIMIT", "Active durable Task limit reached");
      const existing = await tx.execute({
        sql: "SELECT 1 FROM task_steps WHERE task_id = ? LIMIT 1",
        args: [taskId],
      });
      if (existing.rows[0]) throw new Error("Task already has steps");
      for (const step of steps) {
        await tx.execute({
          sql: "INSERT INTO task_steps(id,task_id,kind,title,instructions,spec_ref,status,dependency_policy_json,max_attempts,timeout_ms,retry_policy_json,wait_policy_json,required_capabilities_json,delegated_permissions_json,checkpoint_ref,output_ref,version,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
          args: [
            step.id,
            taskId,
            step.kind,
            step.title,
            step.instructions ?? null,
            step.specRef ?? null,
            step.status,
            JSON.stringify(step.dependencyPolicy),
            step.maxAttempts,
            step.timeoutMs ?? null,
            step.retryPolicy ? JSON.stringify(step.retryPolicy) : null,
            step.waitPolicy ? JSON.stringify(step.waitPolicy) : null,
            JSON.stringify(step.requiredCapabilities),
            JSON.stringify(step.delegatedPermissionSet),
            step.checkpointRef ?? null,
            step.outputRef ?? null,
            1,
            step.createdAt,
            step.updatedAt,
          ],
        });
      }
      for (const step of steps)
        for (const dependencyId of step.dependencyIds) {
          await tx.execute({
            sql: "INSERT INTO task_step_dependencies(task_id,step_id,dependency_id) VALUES (?,?,?)",
            args: [taskId, step.id, dependencyId],
          });
        }
      const updated = await tx.execute({
        sql: "UPDATE tasks SET orchestration_mode = 'durable', root_step_id = ?, updated_at = ? WHERE id = ? AND orchestration_mode = 'legacy'",
        args: [rootStepId, new Date().toISOString(), taskId],
      });
      if (updated.rowsAffected !== 1) throw new Error("Task graph conflict");
      for (const step of steps)
        await this.appendEventTx(tx, { taskId, stepId: step.id, type: "STEP_ADDED", origin });
    });
  }

  async transitionStep(params: {
    taskId: string;
    stepId: string;
    expectedVersion: number;
    from: TaskStepStatus;
    to: TaskStepStatus;
    origin: LongWorkOrigin;
    attemptId?: string;
    evidenceRef?: string;
    metadata?: TaskEvent["metadata"];
  }): Promise<TaskStep> {
    requireIdentifier(params.taskId);
    requireIdentifier(params.stepId);
    if (
      !TASK_STEP_STATUSES.includes(params.from) ||
      !TASK_STEP_STATUSES.includes(params.to) ||
      !transitions[params.from].includes(params.to) ||
      params.to === "waiting"
    )
      throw new Error("Invalid step transition");
    return this.db.transaction(async (tx) => {
      await this.requireOrigin(tx, params.origin);
      await this.requireAttempt(tx, params.taskId, params.attemptId, params.stepId);
      const task = await this.requireTask(tx, params.taskId);
      const cancellationSettlement =
        task.orchestration_mode === "durable" &&
        ["requested", "stopping"].includes(stringColumn(task, "cancellation_state")) &&
        params.from === "running" &&
        params.to === "cancelled";
      if (!cancellationSettlement) await this.requireActiveDurableTask(tx, params.taskId);
      const step = await this.requireStep(tx, params.taskId, params.stepId);
      if (Number(step.version) !== params.expectedVersion || step.status !== params.from)
        throw new Error("Step version conflict");
      if (params.from === "running") {
        const claimed = await tx.execute({
          sql: "SELECT 1 FROM task_step_leases WHERE task_id = ? AND step_id = ? AND state IN ('active','quarantined') LIMIT 1",
          args: [params.taskId, params.stepId],
        });
        if (claimed.rows[0]) throw new Error("Claimed Step requires lease settlement");
      }
      if (params.to === "ready") {
        const uncertain = await tx.execute({
          sql: "SELECT 1 FROM task_step_leases WHERE task_id = ? AND step_id = ? AND state = 'quarantined' LIMIT 1",
          args: [params.taskId, params.stepId],
        });
        if (uncertain.rows[0]) throw new Error("Unknown Step outcome requires reconciliation");
      }
      const now = new Date().toISOString();
      const result = await tx.execute({
        sql: "UPDATE task_steps SET status = ?, version = version + 1, updated_at = ? WHERE id = ? AND task_id = ? AND version = ? AND status = ?",
        args: [params.to, now, params.stepId, params.taskId, params.expectedVersion, params.from],
      });
      if (result.rowsAffected !== 1) throw new Error("Step version conflict");
      if (params.from === "waiting") {
        const waits = await tx.execute({
          sql: "SELECT id,attempt_id FROM task_waits WHERE task_id = ? AND step_id = ? AND status = 'waiting'",
          args: [params.taskId, params.stepId],
        });
        if (
          waits.rows.length !== 1 ||
          (waits.rows[0]!.attempt_id ?? null) !== (params.attemptId ?? null)
        )
          throw new Error("Active wait conflict");
        const waitStatus = ["failed", "cancelled"].includes(params.to) ? "cancelled" : "resumed";
        const settled = await tx.execute({
          sql: "UPDATE task_waits SET status = ?, updated_at = ? WHERE id = ? AND status = 'waiting'",
          args: [waitStatus, now, stringColumn(waits.rows[0]!, "id")],
        });
        if (settled.rowsAffected !== 1) throw new Error("Active wait conflict");
      }
      const eventType = statusEvents[params.to];
      if (!eventType) throw new Error("Step transition has no event type");
      await this.appendEventTx(tx, {
        taskId: params.taskId,
        stepId: params.stepId,
        attemptId: params.attemptId,
        type: eventType,
        origin: params.origin,
        evidenceRef: params.evidenceRef,
        metadata: params.metadata,
      });
      const dependencies = await tx.execute({
        sql: "SELECT dependency_id FROM task_step_dependencies WHERE task_id = ? AND step_id = ? ORDER BY dependency_id",
        args: [params.taskId, params.stepId],
      });
      return parseStep(
        await this.requireStep(tx, params.taskId, params.stepId),
        dependencies.rows.map((row) => stringColumn(row, "dependency_id")),
      );
    });
  }

  /** Settles the current durable timer only after its persisted due time. */
  async fireDueWait(
    taskId: string,
    stepId: string,
    expectedVersion: number,
    origin: LongWorkOrigin,
  ): Promise<TaskStep> {
    requireIdentifier(taskId);
    requireIdentifier(stepId);
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1)
      throw new Error("Invalid Step version");
    return this.db.transaction(async (tx) => {
      await this.requireOrigin(tx, origin);
      await this.requireActiveDurableTask(tx, taskId);
      const step = await this.requireStep(tx, taskId, stepId);
      if (Number(step.version) !== expectedVersion || step.status !== "waiting")
        throw new Error("Step version conflict");
      const result = await tx.execute({
        sql: `SELECT * FROM task_waits WHERE task_id = ? AND step_id = ? AND status = 'waiting'
          AND generation = (SELECT MAX(generation) FROM task_waits WHERE task_id = ? AND step_id = ?)`,
        args: [taskId, stepId, taskId, stepId],
      });
      const wait = result.rows[0];
      if (!wait) throw new Error("Current wait is not active");
      const kind = stringColumn(wait, "kind");
      const timedWait = ["duration", "until", "deadline", "retry"].includes(kind);
      const timeoutWait = ["signal", "approval"].includes(kind);
      if (!timedWait && !timeoutWait) throw new Error("Current wait is not a timer wait");
      const dueAt = timedWait ? optionalString(wait, "due_at") : null;
      const timeoutAt = optionalString(wait, "timeout_at");
      const now = new Date().toISOString();
      const dueTime = dueAt ? Date.parse(dueAt) : Number.POSITIVE_INFINITY;
      const timeoutTime = timeoutAt ? Date.parse(timeoutAt) : Number.POSITIVE_INFINITY;
      if (!Number.isFinite(Math.min(dueTime, timeoutTime)))
        throw new Error("Wait due time is invalid");
      if (Math.min(dueTime, timeoutTime) > Date.parse(now)) throw new Error("Timer is not due");
      const policy = parseJson<TaskWaitPolicy>(wait, "policy_json");
      // A timer may resume on its deadline. An approval or signal timeout is never
      // evidence that the requested approval or external signal happened.
      const stale = timeoutWait || timeoutTime <= dueTime || policy.overdue === "stale";
      const waitOnlyStep = ["timer_wait", "signal_wait", "approval_wait"].includes(
        stringColumn(step, "kind"),
      );
      const nextStatus: TaskStepStatus = stale ? "blocked" : waitOnlyStep ? "succeeded" : "ready";
      const nextWaitStatus = stale ? "stale" : "resumed";
      const updated = await tx.execute({
        sql: "UPDATE task_steps SET status = ?, version = version + 1, updated_at = ? WHERE id = ? AND task_id = ? AND version = ? AND status = 'waiting'",
        args: [nextStatus, now, stepId, taskId, expectedVersion],
      });
      if (updated.rowsAffected !== 1) throw new Error("Step version conflict");
      const settled = await tx.execute({
        sql: "UPDATE task_waits SET status = ?, updated_at = ? WHERE id = ? AND status = 'waiting' AND generation = ?",
        args: [nextWaitStatus, now, stringColumn(wait, "id"), Number(wait.generation)],
      });
      if (settled.rowsAffected !== 1) throw new Error("Active wait conflict");
      await this.appendEventTx(tx, {
        taskId,
        stepId,
        attemptId: optionalString(wait, "attempt_id") ?? undefined,
        type: stale ? "STEP_BLOCKED" : nextStatus === "succeeded" ? "STEP_SUCCEEDED" : "STEP_READY",
        origin,
        metadata: {
          reason: stale
            ? "wait_overdue"
            : kind === "retry"
              ? "retry_due"
              : timedWait
                ? "timer_due"
                : "wait_timeout",
        },
      });
      const dependencies = await tx.execute({
        sql: "SELECT dependency_id FROM task_step_dependencies WHERE task_id = ? AND step_id = ? ORDER BY dependency_id",
        args: [taskId, stepId],
      });
      return parseStep(
        await this.requireStep(tx, taskId, stepId),
        dependencies.rows.map((row) => stringColumn(row, "dependency_id")),
      );
    });
  }

  /** Moves a completed durable graph into product review. */
  async markTaskNeedsAttention(
    taskId: string,
    origin: LongWorkOrigin,
    stepId?: string,
  ): Promise<void> {
    requireIdentifier(taskId);
    await this.db.transaction(async (tx) => {
      await this.requireOrigin(tx, origin);
      const task = await this.requireActiveDurableTask(tx, taskId);
      const targetStepId = stepId ?? optionalString(task, "root_step_id");
      if (!targetStepId) throw new Error("Task root Step is required");
      const targetStep = await this.requireStep(tx, taskId, targetStepId);
      if (!["blocked", "failed"].includes(stringColumn(targetStep, "status")))
        throw new Error("Task Step does not need failure attention");
      const kind = targetStep.status === "failed" ? "task_failed" : "worker_blocked";
      const existing = await tx.execute({
        sql: "SELECT id FROM attention_items WHERE task_id = ? AND kind = ? AND resolved_at IS NULL LIMIT 1",
        args: [taskId, kind],
      });
      const now = new Date().toISOString();
      await tx.execute({
        sql: "UPDATE tasks SET status = 'WAITING_INPUT', updated_at = ? WHERE id = ? AND orchestration_mode = 'durable' AND cancellation_state = 'none' AND status NOT IN ('DONE','CANCELED','FAILED','REVIEW')",
        args: [now, taskId],
      });
      if (existing.rows[0]) return;
      await tx.execute({
        sql: "INSERT INTO attention_items(id,kind,summary,principal_id,task_id,created_at) VALUES (?,?,?,?,?,?)",
        args: [
          randomUUID(),
          kind,
          `Task Step ${stringColumn(targetStep, "status")} requires action`,
          task.creator_principal_id,
          taskId,
          now,
        ],
      });
      await this.appendEventTx(tx, {
        taskId,
        stepId: targetStepId,
        type: "TASK_BLOCKED",
        origin,
        metadata: { stepStatus: stringColumn(targetStep, "status") },
      });
    });
  }

  async markTaskReview(taskId: string, origin: LongWorkOrigin): Promise<void> {
    requireIdentifier(taskId);
    await this.db.transaction(async (tx) => {
      await this.requireOrigin(tx, origin);
      const task = await this.requireTask(tx, taskId);
      if (task.orchestration_mode !== "durable") throw new Error("Task is not durable work");
      const currentStatus = stringColumn(task, "status");
      if (currentStatus === "REVIEW") return;
      if (
        task.cancellation_state !== "none" ||
        ["DONE", "CANCELED", "ACCEPTED", "FAILED"].includes(currentStatus)
      )
        throw new Error("Task is not active durable work");
      const rootStepId = optionalString(task, "root_step_id");
      if (!rootStepId) throw new Error("Task root Step is required");
      const steps = await tx.execute({
        sql: "SELECT id,status FROM task_steps WHERE task_id = ?",
        args: [taskId],
      });
      const root = steps.rows.find((row) => row.id === rootStepId);
      if (!root || root.status !== "succeeded")
        throw new Error("Root Step must succeed before Task review");
      const terminalNonRoot = steps.rows.filter((row) => row.id !== rootStepId);
      if (
        steps.rows.length === 0 ||
        terminalNonRoot.some(
          (row) =>
            !["succeeded", "failed", "cancelled", "skipped"].includes(stringColumn(row, "status")),
        )
      )
        throw new Error("All Task Steps must be terminal before review");
      const activeWaits = await tx.execute({
        sql: "SELECT 1 FROM task_waits WHERE task_id = ? AND status = 'waiting' LIMIT 1",
        args: [taskId],
      });
      const activeLeases = await tx.execute({
        sql: "SELECT 1 FROM task_step_leases WHERE task_id = ? AND state IN ('active','quarantined') LIMIT 1",
        args: [taskId],
      });
      if (activeWaits.rows[0] || activeLeases.rows[0])
        throw new Error("Task has active waits or leases");
      const now = new Date().toISOString();
      const update = await tx.execute({
        sql: "UPDATE tasks SET status = 'REVIEW', updated_at = ? WHERE id = ? AND status = ? AND orchestration_mode = 'durable' AND cancellation_state = 'none'",
        args: [now, taskId, currentStatus],
      });
      if (update.rowsAffected !== 1) throw new Error("Task status conflict");
      await this.appendEventTx(tx, { taskId, type: "TASK_REVIEW", origin });
      await tx.execute({
        sql: `INSERT INTO attention_items(id,kind,summary,principal_id,task_id,created_at,resolved_at)
          SELECT ?,'task_review',?,?,?, ?,NULL WHERE NOT EXISTS (
            SELECT 1 FROM attention_items WHERE task_id = ? AND kind = 'task_review' AND resolved_at IS NULL
          )`,
        args: [
          randomUUID(),
          `Task ready for review: ${stringColumn(task, "title")}`,
          task.creator_principal_id,
          taskId,
          now,
          taskId,
        ],
      });
    });
  }

  /** Records cancellation intent before the caller asks an external worker to stop. */
  async requestDurableCancellation(
    taskId: string,
    origin: LongWorkOrigin,
  ): Promise<{ status: string; cancellationState: string }> {
    requireIdentifier(taskId);
    if (origin.kind !== "decision") throw new Error("Task cancellation needs a principal decision");
    requireIdentifier(origin.decisionId);
    requireIdentifier(origin.actorPrincipalId);
    return this.db.transaction(async (tx) => {
      const task = await this.requireTask(tx, taskId);
      if (task.orchestration_mode !== "durable") throw new Error("Task is not durable work");
      const scope = optionalString(task, "origin_scope_key");
      if (!scope) throw new Error("Task scope is required for cancellation authorization");
      const decision = await tx.execute({
        sql: `SELECT d.id,d.grant_id FROM authorization_decisions d
          LEFT JOIN grants g ON g.id = d.grant_id
          WHERE d.id = ? AND d.principal_id = ? AND d.resource_id = ?
            AND d.action = 'task:cancel' AND d.scope_key = ? AND d.decision = 'ALLOW'
            AND (d.grant_id IS NULL OR (g.id IS NOT NULL AND g.revoked_at IS NULL))`,
        args: [origin.decisionId, origin.actorPrincipalId, `task-${taskId}`, scope],
      });
      if (!decision.rows[0])
        throw new Error("Matching Task cancellation ALLOW decision is required");

      const cancellationState = stringColumn(task, "cancellation_state");
      const currentStatus = stringColumn(task, "status");
      if (cancellationState === "settled") return { status: currentStatus, cancellationState };
      if (cancellationState !== "none") return { status: currentStatus, cancellationState };
      if (["DONE", "CANCELED", "ACCEPTED", "FAILED"].includes(currentStatus))
        throw new Error("Task is not active durable work");

      const now = new Date().toISOString();
      const update = await tx.execute({
        sql: `UPDATE tasks SET cancellation_state = 'requested', updated_at = ?
          WHERE id = ? AND orchestration_mode = 'durable' AND cancellation_state = 'none'
            AND status = ?`,
        args: [now, taskId, currentStatus],
      });
      if (update.rowsAffected !== 1) throw new Error("Task cancellation conflict");

      await this.appendEventTx(tx, {
        taskId,
        type: "TASK_CANCELLED",
        origin,
        metadata: {
          phase: "requested",
          status: currentStatus,
          cancellationState: "requested",
          rollbackPerformed: false,
        },
      });

      const futureSteps = await tx.execute({
        sql: `SELECT id,status FROM task_steps WHERE task_id = ?
          AND status IN ('pending','ready','waiting','blocked','review') ORDER BY created_at,id`,
        args: [taskId],
      });
      await tx.execute({
        sql: "UPDATE task_waits SET status = 'cancelled', updated_at = ? WHERE task_id = ? AND status = 'waiting'",
        args: [now, taskId],
      });
      for (const step of futureSteps.rows) {
        const stepId = stringColumn(step, "id");
        const previousStatus = stringColumn(step, "status");
        const cancelled = await tx.execute({
          sql: `UPDATE task_steps SET status = 'cancelled', version = version + 1, updated_at = ?
            WHERE task_id = ? AND id = ? AND status = ?`,
          args: [now, taskId, stepId, previousStatus],
        });
        if (cancelled.rowsAffected !== 1) throw new Error("Step cancellation conflict");
        await this.appendEventTx(tx, {
          taskId,
          stepId,
          type: "STEP_CANCELLED",
          origin,
          metadata: {
            reason: "task_cancellation_requested",
            previousStatus,
            status: "cancelled",
            rollbackPerformed: false,
          },
        });
      }
      return { status: currentStatus, cancellationState: "requested" };
    });
  }

  /** Marks Task cancellation complete after stopped workers and leases are reconciled. */
  async settleDurableCancellation(
    taskId: string,
    origin: LongWorkOrigin,
  ): Promise<{ status: string; cancellationState: string }> {
    requireIdentifier(taskId);
    return this.db.transaction(async (tx) => {
      await this.requireOrigin(tx, origin);
      const task = await this.requireTask(tx, taskId);
      if (task.orchestration_mode !== "durable") throw new Error("Task is not durable work");
      const cancellationState = stringColumn(task, "cancellation_state");
      const currentStatus = stringColumn(task, "status");
      if (cancellationState === "settled") return { status: currentStatus, cancellationState };
      if (!["requested", "stopping"].includes(cancellationState))
        throw new Error("Task cancellation has not been requested");
      const running = await tx.execute({
        sql: "SELECT 1 FROM task_steps WHERE task_id = ? AND status = 'running' LIMIT 1",
        args: [taskId],
      });
      const leases = await tx.execute({
        sql: "SELECT 1 FROM task_step_leases WHERE task_id = ? AND state IN ('active','quarantined') LIMIT 1",
        args: [taskId],
      });
      if (running.rows[0] || leases.rows[0])
        throw new Error("Task cancellation still has running Steps or active leases");

      const now = new Date().toISOString();
      const settled = await tx.execute({
        sql: `UPDATE tasks SET status = 'CANCELED', cancellation_state = 'settled',
          completed_at = COALESCE(completed_at, ?), updated_at = ?
          WHERE id = ? AND orchestration_mode = 'durable'
            AND cancellation_state IN ('requested','stopping')`,
        args: [now, now, taskId],
      });
      if (settled.rowsAffected !== 1) throw new Error("Task cancellation conflict");
      await tx.execute({
        sql: "UPDATE attention_items SET resolved_at = ? WHERE task_id = ? AND resolved_at IS NULL",
        args: [now, taskId],
      });
      await this.appendEventTx(tx, {
        taskId,
        type: "TASK_CANCELLED",
        origin,
        metadata: {
          phase: "settled",
          previousStatus: currentStatus,
          status: "CANCELED",
          cancellationState: "settled",
          completedAt: now,
          rollbackPerformed: false,
        },
      });
      return { status: "CANCELED", cancellationState: "settled" };
    });
  }

  /** Accepts a durable Task only with a matching recorded authorization decision. */
  async acceptDurableTask(taskId: string, origin: LongWorkOrigin): Promise<void> {
    requireIdentifier(taskId);
    if (origin.kind !== "decision") throw new Error("Task acceptance needs a principal decision");
    requireIdentifier(origin.decisionId);
    requireIdentifier(origin.actorPrincipalId);
    await this.db.transaction(async (tx) => {
      const task = await this.requireTask(tx, taskId);
      const decision = await tx.execute({
        sql: `SELECT d.id FROM authorization_decisions d
          LEFT JOIN grants g ON g.id = d.grant_id
          WHERE d.id = ? AND d.principal_id = ? AND d.resource_id = ?
            AND d.action = 'task:accept' AND d.scope_key = ? AND d.decision = 'ALLOW'
            AND (d.grant_id IS NULL OR (g.id IS NOT NULL AND g.revoked_at IS NULL))`,
        args: [origin.decisionId, origin.actorPrincipalId, `task-${taskId}`, task.origin_scope_key],
      });
      if (!decision.rows[0]) throw new Error("Matching Task acceptance ALLOW decision is required");
      if (task.orchestration_mode !== "durable") throw new Error("Task is not durable work");
      if (task.status !== "REVIEW") throw new Error("Task must be in REVIEW before acceptance");
      const now = new Date().toISOString();
      const update = await tx.execute({
        sql: "UPDATE tasks SET status = 'DONE', completed_at = ?, updated_at = ? WHERE id = ? AND status = 'REVIEW' AND orchestration_mode = 'durable' AND cancellation_state = 'none'",
        args: [now, now, taskId],
      });
      if (update.rowsAffected !== 1) throw new Error("Task status conflict");
      await tx.execute({
        sql: "UPDATE attention_items SET resolved_at = ? WHERE task_id = ? AND kind = 'task_review' AND resolved_at IS NULL",
        args: [now, taskId],
      });
      await this.appendEventTx(tx, {
        taskId,
        type: "TASK_ACCEPTED",
        origin,
        metadata: { previousStatus: "REVIEW", status: "DONE", completedAt: now },
      });
      await tx.execute({
        sql: `INSERT INTO ops_trace_events(event_id,ts,type,task_id,principal_id,data_json)
          VALUES (?,?, 'task.accepted',?,?,?)`,
        args: [
          randomUUID(),
          now,
          taskId,
          origin.actorPrincipalId,
          JSON.stringify({ previousStatus: "REVIEW", newStatus: "DONE", completedAt: now }),
        ],
      });
    });
  }

  /** Accepts one reviewed Step while leaving Task acceptance to the Task-level action. */
  async acceptDurableStep(input: {
    taskId: string;
    stepId: string;
    expectedStepVersion: number;
    origin: LongWorkOrigin;
  }): Promise<TaskStep> {
    requireIdentifier(input.taskId);
    requireIdentifier(input.stepId);
    if (
      !Number.isSafeInteger(input.expectedStepVersion) ||
      input.expectedStepVersion < 1 ||
      input.origin.kind !== "decision"
    )
      throw new Error("Step acceptance needs a principal decision and valid version");
    const origin = input.origin;
    requireIdentifier(origin.decisionId);
    requireIdentifier(origin.actorPrincipalId);

    return this.db.transaction(async (tx) => {
      const task = await this.requireActiveDurableTask(tx, input.taskId);
      const decision = await tx.execute({
        sql: `SELECT d.id FROM authorization_decisions d JOIN grants g ON g.id = d.grant_id
          WHERE d.id = ? AND d.principal_id = ? AND d.resource_id = ?
            AND d.action = 'task:accept' AND d.scope_key = ? AND d.decision = 'ALLOW'
            AND g.revoked_at IS NULL`,
        args: [
          origin.decisionId,
          origin.actorPrincipalId,
          `task-${input.taskId}`,
          task.origin_scope_key,
        ],
      });
      if (!decision.rows[0]) throw new Error("Matching Step acceptance ALLOW decision is required");
      const step = await this.requireStep(tx, input.taskId, input.stepId);
      if (step.status !== "review" || Number(step.version) !== input.expectedStepVersion)
        throw new Error("Step acceptance conflict");
      const leases = await tx.execute({
        sql: "SELECT 1 FROM task_step_leases WHERE task_id = ? AND step_id = ? AND state IN ('active','quarantined') LIMIT 1",
        args: [input.taskId, input.stepId],
      });
      if (leases.rows[0]) throw new Error("Step still has an active or quarantined lease");
      const attempts = await tx.execute({
        sql: "SELECT id,status FROM task_attempts WHERE task_id = ? AND step_id = ? ORDER BY attempt_number DESC LIMIT 1",
        args: [input.taskId, input.stepId],
      });
      const attempt = attempts.rows[0];
      if (!attempt || attempt.status !== "review")
        throw new Error("Latest Step attempt is not awaiting review");

      const now = new Date().toISOString();
      const taskStatus = stringColumn(task, "status");
      const taskUpdate = await tx.execute({
        sql: "UPDATE tasks SET updated_at = ? WHERE id = ? AND status = ? AND orchestration_mode = 'durable' AND cancellation_state = 'none'",
        args: [now, input.taskId, taskStatus],
      });
      const attemptUpdate = await tx.execute({
        sql: "UPDATE task_attempts SET status = 'succeeded', completed_at = COALESCE(completed_at, ?) WHERE id = ? AND task_id = ? AND step_id = ? AND status = 'review'",
        args: [now, stringColumn(attempt, "id"), input.taskId, input.stepId],
      });
      const stepUpdate = await tx.execute({
        sql: "UPDATE task_steps SET status = 'succeeded', version = version + 1, updated_at = ? WHERE id = ? AND task_id = ? AND version = ? AND status = 'review'",
        args: [now, input.stepId, input.taskId, input.expectedStepVersion],
      });
      if (
        taskUpdate.rowsAffected !== 1 ||
        attemptUpdate.rowsAffected !== 1 ||
        stepUpdate.rowsAffected !== 1
      )
        throw new Error("Step acceptance conflict");
      await this.appendEventTx(tx, {
        taskId: input.taskId,
        stepId: input.stepId,
        attemptId: stringColumn(attempt, "id"),
        type: "STEP_SUCCEEDED",
        origin,
        metadata: { previousStatus: "review", status: "succeeded", accepted: true },
      });
      const dependencies = await tx.execute({
        sql: "SELECT dependency_id FROM task_step_dependencies WHERE task_id = ? AND step_id = ? ORDER BY dependency_id",
        args: [input.taskId, input.stepId],
      });
      return parseStep(
        await this.requireStep(tx, input.taskId, input.stepId),
        dependencies.rows.map((row) => stringColumn(row, "dependency_id")),
      );
    });
  }

  /** Reopens a reviewed Step for a fresh, separately leased attempt. */
  async reworkDurableStep(input: {
    taskId: string;
    stepId: string;
    expectedStepVersion: number;
    reason: string;
    origin: LongWorkOrigin;
  }): Promise<TaskStep> {
    requireIdentifier(input.taskId);
    requireIdentifier(input.stepId);
    if (
      !Number.isSafeInteger(input.expectedStepVersion) ||
      input.expectedStepVersion < 1 ||
      typeof input.reason !== "string" ||
      !input.reason.trim() ||
      input.reason.length > 512 ||
      input.origin.kind !== "decision"
    )
      throw new Error("Step rework needs a principal decision, reason, and valid version");
    const origin = input.origin;
    requireIdentifier(origin.decisionId);
    requireIdentifier(origin.actorPrincipalId);

    return this.db.transaction(async (tx) => {
      const task = await this.requireActiveDurableTask(tx, input.taskId);
      const decision = await tx.execute({
        sql: `SELECT d.id FROM authorization_decisions d JOIN grants g ON g.id = d.grant_id
          WHERE d.id = ? AND d.principal_id = ? AND d.resource_id = ?
            AND d.action = 'task:rework' AND d.scope_key = ? AND d.decision = 'ALLOW'
            AND g.revoked_at IS NULL`,
        args: [
          origin.decisionId,
          origin.actorPrincipalId,
          `task-${input.taskId}`,
          task.origin_scope_key,
        ],
      });
      if (!decision.rows[0]) throw new Error("Matching Step rework ALLOW decision is required");
      const step = await this.requireStep(tx, input.taskId, input.stepId);
      if (step.status !== "review" || Number(step.version) !== input.expectedStepVersion)
        throw new Error("Step rework conflict");
      const leases = await tx.execute({
        sql: "SELECT 1 FROM task_step_leases WHERE task_id = ? AND step_id = ? AND state IN ('active','quarantined') LIMIT 1",
        args: [input.taskId, input.stepId],
      });
      if (leases.rows[0])
        throw new Error("Step has an active or quarantined lease and cannot be reworked");
      const attempts = await tx.execute({
        sql: "SELECT id,status FROM task_attempts WHERE task_id = ? AND step_id = ? ORDER BY attempt_number DESC LIMIT 1",
        args: [input.taskId, input.stepId],
      });
      const attempt = attempts.rows[0];
      if (!attempt || attempt.status !== "review")
        throw new Error("Latest Step attempt is not awaiting review");

      const now = new Date().toISOString();
      const previousTaskStatus = stringColumn(task, "status");
      const nextTaskStatus = ["WAITING_INPUT", "REVIEW"].includes(previousTaskStatus)
        ? "RUNNING"
        : previousTaskStatus;
      const taskUpdate = await tx.execute({
        sql: "UPDATE tasks SET status = ?, updated_at = ? WHERE id = ? AND status = ? AND orchestration_mode = 'durable' AND cancellation_state = 'none'",
        args: [nextTaskStatus, now, input.taskId, previousTaskStatus],
      });
      const stepUpdate = await tx.execute({
        sql: "UPDATE task_steps SET status = 'ready', output_ref = NULL, version = version + 1, updated_at = ? WHERE id = ? AND task_id = ? AND version = ? AND status = 'review'",
        args: [now, input.stepId, input.taskId, input.expectedStepVersion],
      });
      const attemptUpdate = await tx.execute({
        sql: "UPDATE task_attempts SET rework_reason = ? WHERE id = ? AND task_id = ? AND step_id = ? AND status = 'review'",
        args: [input.reason.trim(), stringColumn(attempt, "id"), input.taskId, input.stepId],
      });
      if (
        taskUpdate.rowsAffected !== 1 ||
        stepUpdate.rowsAffected !== 1 ||
        attemptUpdate.rowsAffected !== 1
      )
        throw new Error("Step rework conflict");
      await this.appendEventTx(tx, {
        taskId: input.taskId,
        stepId: input.stepId,
        attemptId: stringColumn(attempt, "id"),
        type: "TASK_REWORK",
        origin,
        metadata: {
          previousStepStatus: "review",
          status: "ready",
          previousTaskStatus,
          taskStatus: nextTaskStatus,
          priorAttemptPreserved: true,
        },
      });
      const dependencies = await tx.execute({
        sql: "SELECT dependency_id FROM task_step_dependencies WHERE task_id = ? AND step_id = ? ORDER BY dependency_id",
        args: [input.taskId, input.stepId],
      });
      return parseStep(
        await this.requireStep(tx, input.taskId, input.stepId),
        dependencies.rows.map((row) => stringColumn(row, "dependency_id")),
      );
    });
  }

  async listEvents(taskId: string, afterSequence = 0, limit = 100): Promise<StoredTaskEvent[]> {
    requireIdentifier(taskId);
    if (
      !Number.isSafeInteger(afterSequence) ||
      afterSequence < 0 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 500
    )
      throw new Error("Invalid event page");
    return this.db.transaction(async (tx) => {
      await this.requireTask(tx, taskId);
      const rows = await tx.execute({
        sql: "SELECT * FROM task_events WHERE task_id = ? AND sequence > ? ORDER BY sequence LIMIT ?",
        args: [taskId, afterSequence, limit],
      });
      return rows.rows.map(parseEvent);
    });
  }

  async writeCheckpoint(
    checkpoint: TaskCheckpoint,
    origin: LongWorkOrigin,
    expectedStepVersion?: number,
  ): Promise<void> {
    requireIdentifier(checkpoint.id);
    requireIdentifier(checkpoint.taskId);
    requireIdentifier(checkpoint.stateRef);
    requireIdentifier(checkpoint.sourceEvidenceRef);
    if (!Number.isSafeInteger(checkpoint.policyVersion) || checkpoint.policyVersion < 1)
      throw new Error("Invalid policy revision");
    await this.db.transaction(async (tx) => {
      await this.requireOrigin(tx, origin);
      const task = await this.requireActiveDurableTask(tx, checkpoint.taskId);
      if (Number(task.policy_revision) !== checkpoint.policyVersion)
        throw new Error("Checkpoint policy revision conflict");
      if (checkpoint.stepId) {
        const step = await this.requireStep(tx, checkpoint.taskId, checkpoint.stepId);
        if (
          !Number.isSafeInteger(expectedStepVersion) ||
          Number(step.version) !== expectedStepVersion
        )
          throw new Error("Step version conflict");
      }
      await this.requireAttempt(tx, checkpoint.taskId, checkpoint.attemptId, checkpoint.stepId);
      await tx.execute({
        sql: "INSERT INTO task_checkpoints(id,task_id,step_id,attempt_id,checkpoint_type,state_ref,artifact_ref,evidence_ref,policy_revision,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
        args: [
          checkpoint.id,
          checkpoint.taskId,
          checkpoint.stepId ?? null,
          checkpoint.attemptId ?? null,
          checkpoint.type,
          checkpoint.stateRef,
          checkpoint.artifactRef ?? null,
          checkpoint.sourceEvidenceRef,
          checkpoint.policyVersion,
          checkpoint.createdAt,
        ],
      });
      const updatedAt = new Date().toISOString();
      if (checkpoint.stepId) {
        const updated = await tx.execute({
          sql: "UPDATE task_steps SET checkpoint_ref = ?, version = version + 1, updated_at = ? WHERE id = ? AND task_id = ? AND version = ?",
          args: [
            checkpoint.stateRef,
            updatedAt,
            checkpoint.stepId,
            checkpoint.taskId,
            expectedStepVersion!,
          ],
        });
        if (updated.rowsAffected !== 1) throw new Error("Step version conflict");
      }
      await tx.execute({
        sql: "UPDATE tasks SET checkpoint_ref = ?, updated_at = ? WHERE id = ?",
        args: [checkpoint.stateRef, updatedAt, checkpoint.taskId],
      });
      await this.appendEventTx(tx, {
        taskId: checkpoint.taskId,
        stepId: checkpoint.stepId,
        attemptId: checkpoint.attemptId,
        type: "CHECKPOINT_WRITTEN",
        origin,
        evidenceRef: checkpoint.sourceEvidenceRef,
      });
    });
  }

  async latestCheckpoint(taskId: string, stepId?: string): Promise<TaskCheckpoint | null> {
    requireIdentifier(taskId);
    return this.db.transaction(async (tx) => {
      await this.requireTask(tx, taskId);
      if (stepId) await this.requireStep(tx, taskId, stepId);
      const rows = await tx.execute({
        sql: `SELECT * FROM task_checkpoints WHERE task_id = ? ${stepId ? "AND step_id = ?" : ""} ORDER BY rowid DESC LIMIT 1`,
        args: stepId ? [taskId, stepId] : [taskId],
      });
      const row = rows.rows[0];
      return row
        ? {
            id: stringColumn(row, "id"),
            taskId,
            stepId: optionalString(row, "step_id") ?? undefined,
            attemptId: optionalString(row, "attempt_id") ?? undefined,
            type: stringColumn(row, "checkpoint_type"),
            stateRef: stringColumn(row, "state_ref"),
            artifactRef: optionalString(row, "artifact_ref") ?? undefined,
            sourceEvidenceRef: stringColumn(row, "evidence_ref"),
            policyVersion: Number(row.policy_revision),
            createdAt: stringColumn(row, "created_at"),
          }
        : null;
    });
  }

  async createWait(params: {
    id: string;
    taskId: string;
    stepId: string;
    expectedStepVersion: number;
    attemptId?: string;
    policy: TaskWaitPolicy;
    origin: LongWorkOrigin;
  }): Promise<StoredTaskWait> {
    requireIdentifier(params.id);
    requireIdentifier(params.taskId);
    requireIdentifier(params.stepId);
    if (
      !["duration", "until", "deadline", "signal", "approval", "retry"].includes(
        params.policy.kind,
      ) ||
      !Number.isSafeInteger(params.policy.version) ||
      params.policy.version < 1
    )
      throw new Error("Invalid wait policy");
    return this.db.transaction(async (tx) => {
      await this.requireOrigin(tx, params.origin);
      await this.requireAttempt(tx, params.taskId, params.attemptId, params.stepId);
      await this.requireActiveDurableTask(tx, params.taskId);
      const step = await this.requireStep(tx, params.taskId, params.stepId);
      if (
        Number(step.version) !== params.expectedStepVersion ||
        !["ready", "running"].includes(stringColumn(step, "status"))
      )
        throw new Error("Step version conflict");
      const active = await tx.execute({
        sql: "SELECT id FROM task_waits WHERE task_id = ? AND step_id = ? AND status = 'waiting'",
        args: [params.taskId, params.stepId],
      });
      if (active.rows[0]) throw new Error("Step already has an active wait");
      const generation =
        Number(
          (
            await tx.execute({
              sql: "SELECT COALESCE(MAX(generation),0) AS value FROM task_waits WHERE step_id = ?",
              args: [params.stepId],
            })
          ).rows[0]?.value ?? 0,
        ) + 1;
      const now = new Date().toISOString();
      let dueAt = params.policy.dueAt;
      if (params.policy.kind === "duration") {
        if (
          !Number.isSafeInteger(params.policy.durationMs) ||
          !params.policy.durationMs ||
          params.policy.durationMs < 1
        )
          throw new Error("Duration wait needs positive durationMs");
        const due = new Date(Date.parse(now) + params.policy.durationMs);
        if (Number.isNaN(due.getTime()))
          throw new Error("Duration wait exceeds supported date range");
        dueAt = due.toISOString();
      }
      if (["until", "deadline", "retry"].includes(params.policy.kind) && !dueAt)
        throw new Error("Timer wait needs dueAt");
      if (dueAt && (!Number.isFinite(Date.parse(dueAt)) || Date.parse(dueAt) <= Date.parse(now)))
        throw new Error("Wait dueAt must be in the future");
      if (params.policy.timeoutAt && !Number.isFinite(Date.parse(params.policy.timeoutAt)))
        throw new Error("Invalid wait timeoutAt");
      if (["signal", "approval"].includes(params.policy.kind) && !params.policy.signalKey?.trim())
        throw new Error("Signal and approval waits need signalKey");
      const policy: TaskWaitPolicy = { ...params.policy, ...(dueAt ? { dueAt } : {}) };
      await tx.execute({
        sql: "INSERT INTO task_waits(id,task_id,step_id,attempt_id,generation,kind,status,started_at,due_at,signal_key,timeout_at,policy_json,updated_at) VALUES (?,?,?,?,?,?,'waiting',?,?,?,?,?,?)",
        args: [
          params.id,
          params.taskId,
          params.stepId,
          params.attemptId ?? null,
          generation,
          params.policy.kind,
          now,
          dueAt ?? null,
          params.policy.signalKey ?? null,
          params.policy.timeoutAt ?? null,
          JSON.stringify(policy),
          now,
        ],
      });
      const updated = await tx.execute({
        sql: "UPDATE task_steps SET status = 'waiting', version = version + 1, updated_at = ? WHERE id = ? AND task_id = ? AND version = ?",
        args: [now, params.stepId, params.taskId, params.expectedStepVersion],
      });
      if (updated.rowsAffected !== 1) throw new Error("Step version conflict");
      await this.appendEventTx(tx, {
        taskId: params.taskId,
        stepId: params.stepId,
        attemptId: params.attemptId,
        type: "STEP_WAITING",
        origin: params.origin,
        metadata: { generation },
      });
      return {
        id: params.id,
        taskId: params.taskId,
        stepId: params.stepId,
        attemptId: params.attemptId,
        generation,
        policy,
        status: "waiting",
        startedAt: now,
        updatedAt: now,
      };
    });
  }

  async listWaiting(taskId: string): Promise<StoredTaskWait[]> {
    requireIdentifier(taskId);
    return this.db.transaction(async (tx) => {
      await this.requireTask(tx, taskId);
      const rows = await tx.execute({
        sql: "SELECT * FROM task_waits WHERE task_id = ? AND status = 'waiting' ORDER BY started_at,id",
        args: [taskId],
      });
      return rows.rows.map(parseWait);
    });
  }

  /** A stable idempotency key returns the original disposition without touching later waits. */
  async recordSignal(input: Omit<TaskSignal, "disposition">): Promise<TaskSignal> {
    requireIdentifier(input.id);
    requireIdentifier(input.taskId);
    requireIdentifier(input.stepId);
    requireIdentifier(input.idempotencyKey);
    requireIdentifier(input.authorizationDecisionId);
    return this.db.transaction(async (tx) => {
      await this.requireTask(tx, input.taskId);
      const duplicate = await tx.execute({
        sql: "SELECT * FROM task_signals WHERE task_id = ? AND idempotency_key = ?",
        args: [input.taskId, input.idempotencyKey],
      });
      if (duplicate.rows[0]) {
        const row = duplicate.rows[0];
        return {
          ...input,
          id: stringColumn(row, "id"),
          stepId: stringColumn(row, "step_id"),
          targetStepVersion: Number(row.target_step_version),
          targetAttemptId: optionalString(row, "target_attempt_id") ?? undefined,
          type: stringColumn(row, "signal_type"),
          source: stringColumn(row, "source") as TaskSignal["source"],
          actorPrincipalId: optionalString(row, "principal_id") ?? undefined,
          authorizationDecisionId: stringColumn(row, "decision_id"),
          payloadRef: optionalString(row, "payload_ref") ?? undefined,
          metadata: parseJson(row, "metadata_json"),
          receivedAt: stringColumn(row, "received_at"),
          disposition: stringColumn(row, "disposition") as TaskSignal["disposition"],
        };
      }
      await this.requireActiveDurableTask(tx, input.taskId);
      if (input.source === "principal" && !input.actorPrincipalId)
        throw new Error("Signal principal is required");
      if (input.source === "trusted_system" && input.actorPrincipalId)
        throw new Error("Trusted system signal cannot name a principal");
      const task = await tx.execute({
        sql: "SELECT origin_scope_key FROM tasks WHERE id = ?",
        args: [input.taskId],
      });
      const taskScope = task.rows[0] ? optionalString(task.rows[0], "origin_scope_key") : null;
      if (!taskScope) throw new Error("Task scope is required for signal authorization");
      await this.requireAttempt(tx, input.taskId, input.targetAttemptId, input.stepId);
      const step = await this.requireStep(tx, input.taskId, input.stepId);
      const waitResult = await tx.execute({
        sql: "SELECT * FROM task_waits WHERE task_id = ? AND step_id = ? ORDER BY generation DESC LIMIT 1",
        args: [input.taskId, input.stepId],
      });
      const wait = waitResult.rows[0];
      const expectedAction =
        wait && stringColumn(wait, "kind") === "approval" ? "task:approve" : "task:signal";
      const decision = await tx.execute({
        sql: `SELECT d.id FROM authorization_decisions d
          LEFT JOIN grants g ON g.id = d.grant_id
          WHERE d.id = ? AND d.decision = 'ALLOW' AND d.resource_id = ?
            AND d.action = ? AND d.scope_key = ?
            AND ((? = 'principal' AND d.principal_id = ?) OR (? = 'trusted_system' AND d.principal_id IS NULL))
            AND (d.grant_id IS NULL OR (g.id IS NOT NULL AND g.revoked_at IS NULL))`,
        args: [
          input.authorizationDecisionId,
          `task-${input.taskId}`,
          expectedAction,
          taskScope,
          input.source,
          input.actorPrincipalId ?? null,
          input.source,
        ],
      });
      if (!decision.rows[0])
        throw new Error("Matching ALLOW decision is required for this Task signal");
      const receivedAt = new Date().toISOString();
      const waitPolicy = wait ? parseJson<TaskWaitPolicy>(wait, "policy_json") : null;
      const timeoutAt = wait ? optionalString(wait, "timeout_at") : null;
      const timedOutStale =
        timeoutAt !== null &&
        (waitPolicy?.overdue === "stale" ||
          (wait !== null && ["signal", "approval"].includes(stringColumn(wait, "kind")))) &&
        Date.parse(receivedAt) >= Date.parse(timeoutAt);
      const matches =
        wait &&
        step.status === "waiting" &&
        Number(step.version) === input.targetStepVersion &&
        (wait.attempt_id ?? null) === (input.targetAttemptId ?? null) &&
        Date.parse(receivedAt) >= Date.parse(stringColumn(wait, "started_at")) &&
        !timedOutStale &&
        ["signal", "approval"].includes(stringColumn(wait, "kind")) &&
        wait.signal_key !== null &&
        wait.signal_key === input.type;
      const disposition: TaskSignal["disposition"] = matches ? "applied" : "stale";
      await tx.execute({
        sql: "INSERT INTO task_signals(id,task_id,step_id,wait_id,target_step_version,target_attempt_id,signal_type,principal_id,source,decision_id,payload_ref,metadata_json,disposition,idempotency_key,received_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        args: [
          input.id,
          input.taskId,
          input.stepId,
          wait ? stringColumn(wait, "id") : null,
          input.targetStepVersion,
          input.targetAttemptId ?? null,
          input.type,
          input.actorPrincipalId ?? null,
          input.source,
          input.authorizationDecisionId,
          input.payloadRef ?? null,
          boundedMetadata(input.metadata),
          disposition,
          input.idempotencyKey,
          receivedAt,
        ],
      });
      const origin: LongWorkOrigin = input.actorPrincipalId
        ? {
            kind: "decision",
            decisionId: input.authorizationDecisionId,
            actorPrincipalId: input.actorPrincipalId,
          }
        : { kind: "system", reason: "trusted signal", decisionId: input.authorizationDecisionId };
      await this.appendEventTx(tx, {
        taskId: input.taskId,
        stepId: input.stepId,
        attemptId: input.targetAttemptId,
        type: "SIGNAL_RECEIVED",
        origin,
        metadata: { disposition, targetStepVersion: input.targetStepVersion },
      });
      if (matches) {
        const updated = await tx.execute({
          sql: "UPDATE task_waits SET status = 'resumed', updated_at = ? WHERE id = ? AND status = 'waiting'",
          args: [receivedAt, stringColumn(wait, "id")],
        });
        if (updated.rowsAffected !== 1) throw new Error("Wait conflict");
        const waitOnlyStep = ["signal_wait", "approval_wait"].includes(stringColumn(step, "kind"));
        const nextStatus: TaskStepStatus = waitOnlyStep ? "succeeded" : "ready";
        const stepUpdate = await tx.execute({
          sql: "UPDATE task_steps SET status = ?, version = version + 1, updated_at = ? WHERE id = ? AND task_id = ? AND status = 'waiting' AND version = ?",
          args: [nextStatus, receivedAt, input.stepId, input.taskId, input.targetStepVersion],
        });
        if (stepUpdate.rowsAffected !== 1) throw new Error("Step version conflict");
        await this.appendEventTx(tx, {
          taskId: input.taskId,
          stepId: input.stepId,
          attemptId: input.targetAttemptId,
          type: waitOnlyStep ? "STEP_SUCCEEDED" : "STEP_READY",
          origin,
        });
      } else if (timedOutStale && wait) {
        await tx.execute({
          sql: "UPDATE task_waits SET status = 'stale', updated_at = ? WHERE id = ? AND status = 'waiting'",
          args: [receivedAt, stringColumn(wait, "id")],
        });
        if (step.status === "waiting") {
          const blocked = await tx.execute({
            sql: "UPDATE task_steps SET status = 'blocked', version = version + 1, updated_at = ? WHERE id = ? AND task_id = ? AND status = 'waiting' AND version = ?",
            args: [receivedAt, input.stepId, input.taskId, Number(step.version)],
          });
          if (blocked.rowsAffected !== 1) throw new Error("Step version conflict");
          await this.appendEventTx(tx, {
            taskId: input.taskId,
            stepId: input.stepId,
            attemptId: optionalString(wait, "attempt_id") ?? undefined,
            type: "STEP_BLOCKED",
            origin: { kind: "system", reason: "wait timeout" },
            metadata: { waitId: stringColumn(wait, "id") },
          });
        }
      }
      return { ...input, receivedAt, disposition };
    });
  }

  /** Lease expiry never releases ownership automatically. Recovery must inspect the worker. */
  async acquireLease(input: {
    id: string;
    taskId: string;
    stepId: string;
    attemptId?: string;
    workerBindingId?: string;
    ownerInstanceId: string;
    expiresAt: string;
    origin: LongWorkOrigin;
  }): Promise<StoredStepLease | null> {
    requireIdentifier(input.id);
    requireIdentifier(input.taskId);
    requireIdentifier(input.stepId);
    requireIdentifier(input.ownerInstanceId);
    return this.db.transaction(async (tx) => {
      await this.requireOrigin(tx, input.origin);
      await this.requireActiveDurableTask(tx, input.taskId);
      const step = await this.requireStep(tx, input.taskId, input.stepId);
      if (!["ready", "running", "waiting"].includes(stringColumn(step, "status")))
        throw new Error("Step cannot hold a lease");
      await this.requireAttempt(tx, input.taskId, input.attemptId, input.stepId);
      if (input.workerBindingId) {
        if (!input.attemptId) throw new Error("Worker lease needs an attempt");
        const binding = await tx.execute({
          sql: "SELECT id FROM worker_bindings WHERE id = ? AND task_attempt_id = ?",
          args: [input.workerBindingId, input.attemptId],
        });
        if (!binding.rows[0]) throw new Error("Worker binding does not belong to attempt");
      }
      const active = await tx.execute({
        sql: "SELECT id FROM task_step_leases WHERE step_id = ? AND state IN ('active','quarantined')",
        args: [input.stepId],
      });
      if (active.rows[0]) return null;
      const now = new Date().toISOString();
      if (!(Date.parse(input.expiresAt) > Date.parse(now)))
        throw new Error("Lease expiry must be in the future");
      const inserted = await tx.execute({
        sql: "INSERT INTO task_step_leases(id,task_id,step_id,attempt_id,worker_binding_id,owner_instance_id,state,version,acquired_at,heartbeat_at,expires_at) VALUES (?,?,?,?,?,?,'active',1,?,?,?) RETURNING *",
        args: [
          input.id,
          input.taskId,
          input.stepId,
          input.attemptId ?? null,
          input.workerBindingId ?? null,
          input.ownerInstanceId,
          now,
          now,
          input.expiresAt,
        ],
      });
      return parseLease(inserted.rows[0]!);
    });
  }

  async updateLease(input: {
    taskId: string;
    leaseId: string;
    ownerInstanceId: string;
    expectedVersion: number;
    action: "heartbeat" | "release" | "quarantine";
    expiresAt?: string;
    origin: LongWorkOrigin;
  }): Promise<StoredStepLease> {
    requireIdentifier(input.taskId);
    requireIdentifier(input.leaseId);
    requireIdentifier(input.ownerInstanceId);
    return this.db.transaction(async (tx) => {
      await this.requireOrigin(tx, input.origin);
      const current = await tx.execute({
        sql: "SELECT * FROM task_step_leases WHERE id = ? AND task_id = ?",
        args: [input.leaseId, input.taskId],
      });
      const row = current.rows[0];
      if (
        !row ||
        row.owner_instance_id !== input.ownerInstanceId ||
        Number(row.version) !== input.expectedVersion ||
        row.state !== "active"
      )
        throw new Error("Lease version conflict");
      const now = new Date().toISOString();
      const state =
        input.action === "release"
          ? "released"
          : input.action === "quarantine"
            ? "quarantined"
            : "active";
      const expiresAt =
        input.action === "heartbeat" ? input.expiresAt : stringColumn(row, "expires_at");
      if (
        !expiresAt ||
        (input.action === "heartbeat" && !(Date.parse(expiresAt) > Date.parse(now)))
      )
        throw new Error("Invalid lease expiry");
      const updated = await tx.execute({
        sql: "UPDATE task_step_leases SET state = ?, version = version + 1, heartbeat_at = ?, expires_at = ?, released_at = ? WHERE id = ? AND task_id = ? AND owner_instance_id = ? AND version = ? AND state = ? RETURNING *",
        args: [
          state,
          now,
          expiresAt,
          state === "released" ? now : null,
          input.leaseId,
          input.taskId,
          input.ownerInstanceId,
          input.expectedVersion,
          row.state,
        ],
      });
      if (!updated.rows[0]) throw new Error("Lease version conflict");
      return parseLease(updated.rows[0]);
    });
  }

  async getActiveLease(taskId: string, stepId: string): Promise<StoredStepLease | null> {
    requireIdentifier(taskId);
    requireIdentifier(stepId);
    return this.db.transaction(async (tx) => {
      await this.requireStep(tx, taskId, stepId);
      const result = await tx.execute({
        sql: "SELECT * FROM task_step_leases WHERE task_id = ? AND step_id = ? AND state = 'active'",
        args: [taskId, stepId],
      });
      return result.rows[0] ? parseLease(result.rows[0]) : null;
    });
  }
}
