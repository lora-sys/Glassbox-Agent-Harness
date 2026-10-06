import { readTaskSourceRows, reauthorizeSourceRows } from "../auth/source-dependencies.js";
import { randomUUID } from "node:crypto";
import type { InValue, Row, Transaction } from "@libsql/client";
import type {
  AgentOpsSnapshot,
  AgentTask,
  AttentionItem,
  AttentionKind,
  AttemptStatus,
  DecisionValue,
  HerdrAgentLifecycleState,
  TaskAttempt,
  TaskPriority,
  TaskStatus,
  WorkerBinding,
} from "@glassbox/contracts";
import { DomainDatabase, optionalString, stringColumn } from "../persistence/database.js";
import {
  identityKey,
  requireIdentifier,
  scopeKey,
  type TrustedChannelScope,
  type CallerContext,
} from "../identity/scope.js";
import { taskPolicyResourceId } from "../auth/task-policy.js";
import { authorizedValue, evaluate, type AuthorizedResult } from "../auth/service.js";

export type TaskTraceEventType =
  | "task.created"
  | "task.worker_bound"
  | "worker.state_observed"
  | "worker.tool"
  | "worker.workspace_lease"
  | "worker.cleanup_failed"
  | "task.status_changed"
  | "task.review_ready"
  | "task.accepted"
  | "task.reworked"
  | "task.canceled"
  | "authorization.checked"
  | "authorization.granted"
  | "authorization.revoked"
  | "capability.probed"
  | "runtime.turn";

export interface TaskTraceEvent {
  seq: number;
  ts: string;
  type: TaskTraceEventType;
  taskId?: string;
  taskAttemptId?: string;
  runId?: string;
  principalId?: string;
  data: Record<string, unknown>;
}

export class OpsTraceCapture {
  private events: TaskTraceEvent[] = [];
  private seq = 0;

  append(entry: Omit<TaskTraceEvent, "seq" | "ts"> & { ts?: string }): TaskTraceEvent {
    this.seq += 1;
    const event: TaskTraceEvent = {
      seq: this.seq,
      ts: entry.ts ?? new Date().toISOString(),
      type: entry.type,
      taskId: entry.taskId,
      taskAttemptId: entry.taskAttemptId,
      runId: entry.runId,
      principalId: entry.principalId,
      data: entry.data,
    };
    this.events.push(Object.freeze({ ...event }));
    return event;
  }

  getEvents(filter?: { taskId?: string; type?: TaskTraceEventType }): readonly TaskTraceEvent[] {
    return this.events.filter((e) => {
      if (filter?.taskId && e.taskId !== filter.taskId) return false;
      if (filter?.type && e.type !== filter.type) return false;
      return true;
    });
  }

  getAllEvents(): readonly TaskTraceEvent[] {
    return [...this.events];
  }

  clear(): void {
    this.events = [];
    this.seq = 0;
  }
}

function parseTask(row: Row): AgentTask {
  const criteriaJson = optionalString(row, "acceptance_criteria_json");
  let acceptanceCriteria: string[] | undefined;
  if (criteriaJson) {
    try {
      acceptanceCriteria = JSON.parse(criteriaJson) as string[];
    } catch {
      acceptanceCriteria = undefined;
    }
  }
  return {
    id: stringColumn(row, "id"),
    title: stringColumn(row, "title"),
    description: optionalString(row, "description") ?? undefined,
    status: stringColumn(row, "status") as TaskStatus,
    priority: stringColumn(row, "priority") as TaskPriority,
    creatorPrincipalId: stringColumn(row, "creator_principal_id"),
    conversationId: optionalString(row, "conversation_id") ?? undefined,
    runId: optionalString(row, "run_id") ?? undefined,
    activeAttemptId: optionalString(row, "active_attempt_id"),
    acceptanceCriteria,
    ...(row.orchestration_mode === "durable"
      ? {
          orchestrationMode: "durable" as const,
          currentPhase: optionalString(row, "current_phase") ?? undefined,
          rootStepId: optionalString(row, "root_step_id") ?? undefined,
          activeStepIds: JSON.parse(stringColumn(row, "active_step_ids_json")) as string[],
          waitingReason: optionalString(row, "waiting_reason") ?? undefined,
          checkpointRef: optionalString(row, "checkpoint_ref") ?? undefined,
          cancellationState: stringColumn(row, "cancellation_state") as NonNullable<
            AgentTask["cancellationState"]
          >,
          policyRevision: Number(row.policy_revision),
          completedAt: optionalString(row, "completed_at") ?? undefined,
        }
      : {}),
    createdAt: stringColumn(row, "created_at"),
    updatedAt: stringColumn(row, "updated_at"),
  };
}

/** The same explicit-grant and creator policy precedence as auth.evaluate, expressed once in
 * SQL for list projections. The exact current identity binding is part of the predicate. */
function visibleTaskSubquery(caller: CallerContext): { sql: string; args: InValue[] } {
  const principal = caller.principalId;
  const scope = scopeKey(caller.scope);
  return {
    sql: `SELECT t.id FROM tasks t JOIN resources r ON r.id = 'task-' || t.id AND r.kind = 'task'
      WHERE EXISTS (SELECT 1 FROM channel_identities ci
        WHERE ci.identity_key = ? AND ci.principal_id = ?)
      AND (? <> 'group' OR r.visibility = 'public')
      AND (EXISTS (SELECT 1 FROM grants g WHERE g.principal_id = ? AND g.resource_id = r.id
        AND g.action = 'task:read' AND g.scope_key = ? AND g.effect = 'allow' AND g.revoked_at IS NULL)
      OR (NOT EXISTS (SELECT 1 FROM grants g WHERE g.principal_id = ? AND g.resource_id = r.id
        AND g.action = 'task:read' AND g.scope_key = ? AND g.revoked_at IS NULL)
        AND t.creator_principal_id = ? AND t.origin_scope_key = ?
        AND EXISTS (SELECT 1 FROM grants g WHERE g.principal_id = ? AND g.resource_id = ?
          AND g.action = 'task:read' AND g.scope_key = ? AND g.effect = 'allow'
          AND g.revoked_at IS NULL)))`,
    args: [
      identityKey(caller.scope),
      principal,
      caller.scope.chatType,
      principal,
      scope,
      principal,
      scope,
      principal,
      scope,
      principal,
      taskPolicyResourceId(caller),
      scope,
    ],
  };
}

function parseAttempt(row: Row): TaskAttempt {
  return {
    id: stringColumn(row, "id"),
    taskId: stringColumn(row, "task_id"),
    stepId: optionalString(row, "step_id") ?? undefined,
    attemptNumber: Number(row.attempt_number),
    status: stringColumn(row, "status") as AttemptStatus,
    reworkReason: optionalString(row, "rework_reason") ?? undefined,
    startedAt: stringColumn(row, "started_at"),
    completedAt: optionalString(row, "completed_at"),
    resultSummary: optionalString(row, "result_summary") ?? undefined,
  };
}

function parseBinding(row: Row): WorkerBinding {
  return {
    id: stringColumn(row, "id"),
    taskAttemptId: stringColumn(row, "task_attempt_id"),
    herdrSession: stringColumn(row, "herdr_session"),
    workspaceId: stringColumn(row, "workspace_id"),
    paneId: stringColumn(row, "pane_id"),
    tabId: optionalString(row, "tab_id") ?? undefined,
    worktreePath: optionalString(row, "worktree_path") ?? undefined,
    branch: optionalString(row, "branch") ?? undefined,
    agentName: optionalString(row, "agent_name") ?? undefined,
    agentKind: stringColumn(row, "agent_kind"),
    lastObservedAgentState: stringColumn(
      row,
      "last_observed_agent_state",
    ) as HerdrAgentLifecycleState,
    promptDispatchedAt: optionalString(row, "prompt_dispatched_at") ?? undefined,
    updatedAt: stringColumn(row, "updated_at"),
  };
}

function parseAttention(row: Row): AttentionItem {
  return {
    id: stringColumn(row, "id"),
    kind: stringColumn(row, "kind") as AttentionKind,
    summary: stringColumn(row, "summary"),
    principalId: optionalString(row, "principal_id") ?? undefined,
    conversationId: optionalString(row, "conversation_id") ?? undefined,
    taskId: optionalString(row, "task_id") ?? undefined,
    taskAttemptId: optionalString(row, "task_attempt_id") ?? undefined,
    createdAt: stringColumn(row, "created_at"),
    resolvedAt: optionalString(row, "resolved_at"),
  };
}

export class TaskStore {
  constructor(private readonly db: DomainDatabase) {}

  /** Current authority and attempt liveness are checked under the same lock as
   * the bounded file operation. Revocation cannot commit midway through it. */
  async executeWorkerTool<T>(
    input: {
      caller: CallerContext;
      taskId: string;
      attemptId: string;
      resourceId: string;
      action: string;
      allowedActions: readonly string[];
      callId: string;
      productWorkspaceId?: string;
    },
    operation: () => Promise<T>,
  ): Promise<T> {
    const result = await this.db.transaction<
      AuthorizedResult<{ ok: false } | { ok: true; value: T }>
    >(async (tx) => {
      const rows = await tx.execute({
        sql: "SELECT * FROM tasks WHERE id = ?",
        args: [input.taskId],
      });
      const task = rows.rows[0];
      let durableWorkerLive = false;
      let durableWorkerPermitted = false;
      if (task?.orchestration_mode === "durable" && task.cancellation_state === "none") {
        const worker = await tx.execute({
          sql: `SELECT s.delegated_permissions_json FROM task_attempts a
                JOIN task_steps s ON s.task_id = a.task_id AND s.id = a.step_id
                JOIN task_step_leases l ON l.task_id = a.task_id AND l.step_id = s.id
                  AND l.attempt_id = a.id
                JOIN worker_bindings b ON b.id = l.worker_binding_id
                  AND b.task_attempt_id = a.id
                WHERE a.id = ? AND a.task_id = ? AND a.status = 'running'
                  AND s.kind = 'herdr_worker' AND s.status = 'running'
                  AND l.state = 'active' AND l.expires_at > ?`,
          args: [input.attemptId, input.taskId, new Date().toISOString()],
        });
        durableWorkerLive = worker.rows.length > 0;
        if (worker.rows[0]) {
          try {
            const declared: unknown = JSON.parse(
              stringColumn(worker.rows[0], "delegated_permissions_json"),
            );
            const hasPermission = (resourceId: string, action: string) =>
              Array.isArray(declared) &&
              declared.some(
                (permission) =>
                  permission?.resourceId === resourceId && permission?.action === action,
              );
            durableWorkerPermitted =
              hasPermission(input.resourceId, input.action) &&
              (!input.productWorkspaceId ||
                hasPermission(
                  `workspace:${input.productWorkspaceId}`,
                  input.action === "worker:file:write" ? "workspace:write" : "workspace:read",
                ));
          } catch {
            durableWorkerPermitted = false;
          }
        }
      }
      const live =
        task &&
        task.creator_principal_id === input.caller.principalId &&
        ["RUNNING", "WAITING_INPUT"].includes(stringColumn(task, "status")) &&
        (task.orchestration_mode === "durable"
          ? task.cancellation_state === "none" && durableWorkerLive && durableWorkerPermitted
          : task.active_attempt_id === input.attemptId);
      // Legacy Tasks without an origin scope predate Task-bound delegation.
      const delegatedTaskId =
        task && optionalString(task, "origin_scope_key") ? input.taskId : undefined;
      const decision = await evaluate(tx, {
        caller: input.caller,
        resourceId: input.resourceId,
        action: input.action,
        runId: task ? (optionalString(task, "run_id") ?? undefined) : undefined,
        conversationId: task ? (optionalString(task, "conversation_id") ?? undefined) : undefined,
        delegatedTaskId,
      });
      const workspaceDecision = input.productWorkspaceId
        ? await evaluate(tx, {
            caller: input.caller,
            resourceId: `workspace:${input.productWorkspaceId}`,
            action: input.action === "worker:file:write" ? "workspace:write" : "workspace:read",
            runId: task ? (optionalString(task, "run_id") ?? undefined) : undefined,
            conversationId: task
              ? (optionalString(task, "conversation_id") ?? undefined)
              : undefined,
            delegatedTaskId,
          })
        : null;
      const record = async (outcome: string) =>
        this.appendTraceTx(tx, {
          type: "worker.tool",
          taskId: input.taskId,
          taskAttemptId: input.attemptId,
          principalId: input.caller.principalId,
          data: {
            action: input.action,
            callId: input.callId,
            resourceId: input.resourceId,
            ...(input.productWorkspaceId ? { productWorkspaceId: input.productWorkspaceId } : {}),
            decisionId: decision.id,
            outcome,
          },
        });
      if (
        decision.decision !== "ALLOW" ||
        (workspaceDecision !== null && workspaceDecision.decision !== "ALLOW")
      ) {
        await record("denied");
        return { denied: decision.decision !== "ALLOW" ? decision : workspaceDecision! };
      }
      if (!live || !input.allowedActions.includes(input.action)) {
        await record("inactive_or_outside_delegation");
        return { value: { ok: false as const } };
      }
      try {
        const value = await operation();
        await record("succeeded");
        return { value: { ok: true as const, value } };
      } catch {
        await record("failed");
        return { value: { ok: false as const } };
      }
    });
    const value = authorizedValue(result);
    if (!value.ok) throw new Error("worker_tool_denied_or_failed");
    return value.value;
  }

  private async appendTraceTx(
    tx: Transaction,
    entry: Omit<TaskTraceEvent, "seq" | "ts"> & { ts?: string },
  ): Promise<TaskTraceEvent> {
    const event = { ...entry, ts: entry.ts ?? new Date().toISOString() };
    const inserted = await tx.execute({
      sql: `INSERT INTO ops_trace_events(
        event_id, ts, type, task_id, task_attempt_id, run_id, principal_id, data_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING sequence`,
      args: [
        randomUUID(),
        event.ts,
        event.type,
        event.taskId ?? null,
        event.taskAttemptId ?? null,
        event.runId ?? null,
        event.principalId ?? null,
        JSON.stringify(event.data),
      ],
    });
    return { ...event, seq: Number(inserted.rows[0]!.sequence) };
  }

  async recordTrace(entry: Omit<TaskTraceEvent, "seq" | "ts">): Promise<TaskTraceEvent> {
    return this.db.transaction((tx) => this.appendTraceTx(tx, entry));
  }

  async listTraceEvents(filter?: {
    taskId?: string;
    type?: TaskTraceEventType;
  }): Promise<TaskTraceEvent[]> {
    return this.db.transaction(async (tx) => {
      let sql = "SELECT * FROM ops_trace_events WHERE 1=1";
      const args: InValue[] = [];
      if (filter?.taskId) {
        sql += " AND task_id = ?";
        args.push(filter.taskId);
      }
      if (filter?.type) {
        sql += " AND type = ?";
        args.push(filter.type);
      }
      sql += " ORDER BY sequence ASC";
      const result = await tx.execute({ sql, args });
      return result.rows.map((row) => ({
        seq: Number(row.sequence),
        ts: stringColumn(row, "ts"),
        type: stringColumn(row, "type") as TaskTraceEventType,
        taskId: optionalString(row, "task_id") ?? undefined,
        taskAttemptId: optionalString(row, "task_attempt_id") ?? undefined,
        runId: optionalString(row, "run_id") ?? undefined,
        principalId: optionalString(row, "principal_id") ?? undefined,
        data: JSON.parse(stringColumn(row, "data_json")) as Record<string, unknown>,
      }));
    });
  }

  /** Retained authorization trace interface for P3.3 integration */
  async recordAuthorizationTrace(params: {
    principalId?: string | null;
    resourceId: string;
    action: string;
    scopeKey: string;
    decision: DecisionValue;
    reason: string;
    conversationId?: string;
    runId?: string;
  }): Promise<TaskTraceEvent> {
    return this.recordTrace({
      type: "authorization.checked",
      principalId: params.principalId ?? undefined,
      runId: params.runId,
      data: {
        resourceId: params.resourceId,
        action: params.action,
        scopeKey: params.scopeKey,
        decision: params.decision,
        reason: params.reason,
        conversationId: params.conversationId,
      },
    });
  }

  async createTask(params: {
    id?: string;
    title: string;
    description?: string;
    priority?: TaskPriority;
    creatorPrincipalId: string;
    conversationId?: string;
    runId?: string;
    acceptanceCriteria?: string[];
    authorizationScope?: TrustedChannelScope;
  }): Promise<AgentTask> {
    const id = params.id ?? randomUUID();
    requireIdentifier(id);
    requireIdentifier(params.creatorPrincipalId);
    if (!params.title.trim()) throw new Error("Task title cannot be empty");

    const now = new Date().toISOString();
    const priority = params.priority ?? "normal";
    const status: TaskStatus = "NEW";

    await this.db.transaction(async (tx) => {
      await tx.execute({
        sql: `INSERT INTO tasks(
          id, title, description, status, priority, creator_principal_id,
          conversation_id, run_id, active_attempt_id, acceptance_criteria_json,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          id,
          params.title.trim(),
          params.description ?? null,
          status,
          priority,
          params.creatorPrincipalId,
          params.conversationId ?? null,
          params.runId ?? null,
          null,
          params.acceptanceCriteria ? JSON.stringify(params.acceptanceCriteria) : null,
          now,
          now,
        ],
      });
      if (params.authorizationScope) {
        const scope = params.authorizationScope;
        const policy = taskPolicyResourceId({ principalId: params.creatorPrincipalId, scope });
        const visibility = scope.chatType === "group" ? "public" : "private";
        await tx.execute({
          sql: "UPDATE tasks SET origin_scope_key = ?, origin_scope_json = ? WHERE id = ?",
          args: [
            scopeKey(scope),
            JSON.stringify({
              connectionId: scope.connectionId,
              botId: scope.botId,
              chatType: scope.chatType,
              chatId: scope.chatId,
              senderId: scope.senderId,
              ...(scope.threadId ? { threadId: scope.threadId } : {}),
            }),
            id,
          ],
        });
        await tx.execute({
          sql: "INSERT OR IGNORE INTO resources(id, kind, visibility, owner_id) VALUES (?, 'task-policy', ?, ?)",
          args: [policy, visibility, params.creatorPrincipalId],
        });
        await tx.execute({
          sql: "INSERT INTO resources(id, kind, visibility, owner_id) VALUES (?, 'task', ?, ?)",
          args: [`task-${id}`, visibility, params.creatorPrincipalId],
        });
      }
      await this.appendTraceTx(tx, {
        type: "task.created",
        taskId: id,
        runId: params.runId,
        principalId: params.creatorPrincipalId,
        data: {
          title: params.title.trim(),
          priority,
          status,
          acceptanceCriteria: params.acceptanceCriteria,
        },
      });
    });

    return {
      id,
      title: params.title.trim(),
      description: params.description,
      status,
      priority,
      creatorPrincipalId: params.creatorPrincipalId,
      conversationId: params.conversationId,
      runId: params.runId,
      activeAttemptId: null,
      acceptanceCriteria: params.acceptanceCriteria,
      createdAt: now,
      updatedAt: now,
    };
  }

  async getTask(taskId: string): Promise<AgentTask | null> {
    requireIdentifier(taskId);
    return this.db.transaction(async (tx) => {
      const res = await tx.execute({
        sql: "SELECT * FROM tasks WHERE id = ?",
        args: [taskId],
      });
      return res.rows[0] ? parseTask(res.rows[0]) : null;
    });
  }

  async workerSourceResources(
    taskId: string,
  ): Promise<Array<{ resourceId: string; productWorkspaceId?: string }>> {
    return this.db.transaction(async (tx) => {
      const result = await tx.execute({
        sql: "SELECT DISTINCT json_extract(data_json, '$.resourceId') AS resource_id, json_extract(data_json, '$.productWorkspaceId') AS product_workspace_id FROM ops_trace_events WHERE task_id = ? AND type = 'worker.tool' AND json_extract(data_json, '$.outcome') = 'succeeded'",
        args: [taskId],
      });
      return result.rows.map((row) => ({
        resourceId: stringColumn(row, "resource_id"),
        ...(typeof row.product_workspace_id === "string"
          ? { productWorkspaceId: row.product_workspace_id }
          : {}),
      }));
    });
  }

  async recordDispatchProblem(
    taskId: string,
    attemptId: string,
    principalId: string,
    failure?: { phase: string; errorName: string },
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      const now = new Date().toISOString();
      const binding = await tx.execute({
        sql: "SELECT task_attempt_id FROM worker_bindings WHERE task_attempt_id = ?",
        args: [attemptId],
      });
      const bound = binding.rows.length > 0;
      const status = bound ? "WAITING_INPUT" : "FAILED";
      const updated = await tx.execute({
        sql: "UPDATE tasks SET status = ?, updated_at = ? WHERE id = ? AND active_attempt_id = ? AND status IN ('RUNNING', 'WAITING_INPUT')",
        args: [status, now, taskId, attemptId],
      });
      if (updated.rowsAffected !== 1) return;
      await tx.execute({
        sql: "UPDATE task_attempts SET status = ?, completed_at = ? WHERE id = ?",
        args: [bound ? "waiting_input" : "failed", bound ? null : now, attemptId],
      });
      await tx.execute({
        sql: "INSERT INTO attention_items(id, kind, summary, task_id, task_attempt_id, created_at) VALUES (?, 'ops_connection_problem', ?, ?, ?, ?)",
        args: [
          randomUUID(),
          bound
            ? `Worker dispatch incomplete at ${failure?.phase ?? "unknown"}. Inspect the bound worker before canceling; input may have been submitted.`
            : `Worker dispatch failed at ${failure?.phase ?? "unknown"} without a binding. Inspect Herdr for a partial launch before creating a replacement Task.`,
          taskId,
          attemptId,
          now,
        ],
      });
      await this.appendTraceTx(tx, {
        type: "task.status_changed",
        taskId,
        taskAttemptId: attemptId,
        principalId,
        data: {
          status,
          reason: bound ? "worker_dispatch_incomplete" : "worker_dispatch_unbound",
          ...(failure ? { failure } : {}),
        },
      });
    });
  }

  async recordWorkerCleanupProblem(
    taskId: string,
    attemptId: string,
    principalId: string,
    errorName: string,
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      const now = new Date().toISOString();
      await tx.execute({
        sql: "INSERT INTO attention_items(id, kind, summary, task_id, task_attempt_id, created_at) VALUES (?, 'ops_connection_problem', ?, ?, ?, ?)",
        args: [
          randomUUID(),
          "Task was canceled, but worker stop was not confirmed. Inspect Herdr before reusing the workspace.",
          taskId,
          attemptId,
          now,
        ],
      });
      await this.appendTraceTx(tx, {
        type: "worker.cleanup_failed",
        taskId,
        taskAttemptId: attemptId,
        principalId,
        data: { errorName },
      });
    });
  }

  async updateTaskStatus(
    taskId: string,
    status: TaskStatus,
    activeAttemptId?: string | null,
  ): Promise<void> {
    requireIdentifier(taskId);
    const now = new Date().toISOString();
    await this.db.transaction(async (tx) => {
      const task = await tx.execute({
        sql: "SELECT orchestration_mode FROM tasks WHERE id = ?",
        args: [taskId],
      });
      if (task.rows[0]?.orchestration_mode !== "legacy")
        throw new Error("Durable Task requires step-aware status transitions");
      if (activeAttemptId !== undefined) {
        await tx.execute({
          sql: "UPDATE tasks SET status = ?, active_attempt_id = ?, updated_at = ? WHERE id = ?",
          args: [status, activeAttemptId, now, taskId],
        });
      } else {
        await tx.execute({
          sql: "UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?",
          args: [status, now, taskId],
        });
      }
    });
  }

  async listTasks(options?: {
    creatorPrincipalId?: string;
    status?: TaskStatus;
    caller?: CallerContext;
    runId?: string;
    conversationId?: string;
  }): Promise<AgentTask[]> {
    return this.db.transaction(async (tx) => {
      let sql = "SELECT * FROM tasks WHERE 1=1";
      const args: InValue[] = [];
      if (options?.caller) {
        const visible = visibleTaskSubquery(options.caller);
        sql += ` AND id IN (${visible.sql})`;
        args.push(...visible.args);
      }
      if (options?.creatorPrincipalId) {
        sql += " AND creator_principal_id = ?";
        args.push(options.creatorPrincipalId);
      }
      if (options?.status) {
        sql += " AND status = ?";
        args.push(options.status);
      }
      sql += " ORDER BY created_at DESC";
      const res = await tx.execute({ sql, args });
      const rows: Row[] = [];
      for (const row of res.rows) {
        if (options?.caller) {
          const sources = await reauthorizeSourceRows(
            tx,
            options.caller,
            await readTaskSourceRows(tx, stringColumn(row, "id")),
            { runId: options.runId, conversationId: options.conversationId },
          );
          if ("denied" in sources) continue;
        }
        rows.push(row);
      }
      return rows.map(parseTask);
    });
  }

  /** Loads only caller-authorized durable records for the Ops health projection. */
  async getOpsHealthRecords(
    caller: CallerContext,
    evidence?: { runId?: string; conversationId?: string },
  ): Promise<{ tasks: AgentTask[]; attempts: TaskAttempt[]; bindings: WorkerBinding[] }> {
    return this.db.transaction(async (tx) => {
      const visible = visibleTaskSubquery(caller);
      const taskRows = await tx.execute({
        sql: `SELECT * FROM tasks WHERE id IN (${visible.sql})`,
        args: visible.args,
      });
      const attemptRows = await tx.execute({
        sql: `SELECT * FROM task_attempts WHERE task_id IN (${visible.sql})`,
        args: visible.args,
      });
      const bindingRows = await tx.execute({
        sql: `SELECT b.* FROM worker_bindings b JOIN tasks t ON t.active_attempt_id = b.task_attempt_id WHERE t.id IN (${visible.sql}) AND t.status NOT IN ('DONE', 'ACCEPTED', 'FAILED', 'CANCELED')`,
        args: visible.args,
      });

      const allowed: Row[] = [];
      for (const row of taskRows.rows) {
        const sources = await reauthorizeSourceRows(
          tx,
          caller,
          await readTaskSourceRows(tx, stringColumn(row, "id")),
          evidence ?? {},
        );
        if (!("denied" in sources)) allowed.push(row);
      }
      const ids = new Set(allowed.map((row) => row.id));
      const attempts = attemptRows.rows.filter((row) => ids.has(row.task_id));
      const attemptIds = new Set(attempts.map((row) => row.id));
      return {
        tasks: allowed.map(parseTask),
        attempts: attempts.map(parseAttempt),
        bindings: bindingRows.rows
          .filter((row) => attemptIds.has(row.task_attempt_id))
          .map(parseBinding),
      };
    });
  }

  async createAttempt(params: {
    taskId: string;
    attemptNumber?: number;
    reworkReason?: string;
  }): Promise<TaskAttempt> {
    requireIdentifier(params.taskId);
    const id = randomUUID();
    const now = new Date().toISOString();

    return this.db.transaction(async (tx) => {
      let num = params.attemptNumber;
      const tasks = await tx.execute({
        sql: "SELECT status, active_attempt_id, orchestration_mode FROM tasks WHERE id = ?",
        args: [params.taskId],
      });
      const task = tasks.rows[0];
      if (
        !task ||
        task.orchestration_mode !== "legacy" ||
        task.active_attempt_id != null ||
        !["NEW", "QUEUED", "ASSIGNED"].includes(stringColumn(task, "status"))
      ) {
        throw new Error("Task cannot start another initial attempt; use Rework after review");
      }
      if (num === undefined) {
        const existing = await tx.execute({
          sql: "SELECT MAX(attempt_number) as max_num FROM task_attempts WHERE task_id = ?",
          args: [params.taskId],
        });
        const maxNum = existing.rows[0]?.max_num;
        num = (typeof maxNum === "number" ? maxNum : 0) + 1;
      }

      await tx.execute({
        sql: `INSERT INTO task_attempts(
          id, task_id, attempt_number, status, rework_reason, started_at, completed_at, result_summary
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [id, params.taskId, num, "running", params.reworkReason ?? null, now, null, null],
      });

      await tx.execute({
        sql: "UPDATE tasks SET status = 'RUNNING', active_attempt_id = ?, updated_at = ? WHERE id = ?",
        args: [id, now, params.taskId],
      });

      return {
        id,
        taskId: params.taskId,
        attemptNumber: num,
        status: "running",
        reworkReason: params.reworkReason,
        startedAt: now,
        completedAt: null,
      };
    });
  }

  async getAttempt(attemptId: string): Promise<TaskAttempt | null> {
    requireIdentifier(attemptId);
    return this.db.transaction(async (tx) => {
      const res = await tx.execute({
        sql: "SELECT * FROM task_attempts WHERE id = ?",
        args: [attemptId],
      });
      return res.rows[0] ? parseAttempt(res.rows[0]) : null;
    });
  }

  async getLatestAttempt(taskId: string): Promise<TaskAttempt | null> {
    requireIdentifier(taskId);
    return this.db.transaction(async (tx) => {
      const res = await tx.execute({
        sql: "SELECT * FROM task_attempts WHERE task_id = ? ORDER BY attempt_number DESC LIMIT 1",
        args: [taskId],
      });
      return res.rows[0] ? parseAttempt(res.rows[0]) : null;
    });
  }

  async updateAttemptStatus(
    attemptId: string,
    status: AttemptStatus,
    resultSummary?: string,
  ): Promise<void> {
    requireIdentifier(attemptId);
    const now = new Date().toISOString();
    const completedAt = ["succeeded", "failed", "canceled", "review"].includes(status) ? now : null;
    await this.db.transaction(async (tx) => {
      await tx.execute({
        sql: "UPDATE task_attempts SET status = ?, completed_at = COALESCE(?, completed_at), result_summary = COALESCE(?, result_summary) WHERE id = ?",
        args: [status, completedAt, resultSummary ?? null, attemptId],
      });
    });
  }

  async listAttempts(taskId: string): Promise<TaskAttempt[]> {
    requireIdentifier(taskId);
    return this.db.transaction(async (tx) => {
      const res = await tx.execute({
        sql: "SELECT * FROM task_attempts WHERE task_id = ? ORDER BY attempt_number ASC",
        args: [taskId],
      });
      return res.rows.map(parseAttempt);
    });
  }

  async bindWorker(params: {
    taskAttemptId: string;
    herdrSession: string;
    workspaceId: string;
    paneId: string;
    tabId?: string;
    worktreePath?: string;
    branch?: string;
    agentName?: string;
    agentKind: string;
    lastObservedAgentState?: HerdrAgentLifecycleState;
    runtimeEvidence?: Record<string, unknown>;
  }): Promise<WorkerBinding> {
    requireIdentifier(params.taskAttemptId);
    const id = randomUUID();
    const now = new Date().toISOString();
    const state: HerdrAgentLifecycleState = params.lastObservedAgentState ?? "starting";

    await this.db.transaction(async (tx) => {
      // A legacy Task names its live attempt in `active_attempt_id`, so a Worker may only bind
      // to that one. A durable Task runs one attempt per Step and `active_attempt_id` stays null
      // by design — adopting a graph requires it — so requiring it here would refuse every
      // durable dispatch. For those the running attempt of a RUNNING Task is the live one, and
      // `attachClaimedWorkerBinding` is what then checks the Step, its lease and its owner.
      const active = await tx.execute({
        sql: `SELECT t.id FROM tasks t JOIN task_attempts a ON a.task_id = t.id
          WHERE a.id = ? AND t.status = 'RUNNING' AND a.status = 'running'
            AND (t.orchestration_mode = 'durable' OR t.active_attempt_id = ?)`,
        args: [params.taskAttemptId, params.taskAttemptId],
      });
      if (!active.rows.length) throw new Error("Worker attempt is no longer running");
      await tx.execute({
        sql: `INSERT INTO worker_bindings(
          id, task_attempt_id, herdr_session, workspace_id, pane_id, tab_id,
          worktree_path, branch, agent_name, agent_kind, last_observed_agent_state, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          id,
          params.taskAttemptId,
          params.herdrSession,
          params.workspaceId,
          params.paneId,
          params.tabId ?? null,
          params.worktreePath ?? null,
          params.branch ?? null,
          params.agentName ?? null,
          params.agentKind,
          state,
          now,
        ],
      });
      await this.appendTraceTx(tx, {
        type: "task.worker_bound",
        taskId: stringColumn(
          (
            await tx.execute({
              sql: "SELECT task_id FROM task_attempts WHERE id = ?",
              args: [params.taskAttemptId],
            })
          ).rows[0]!,
          "task_id",
        ),
        taskAttemptId: params.taskAttemptId,
        data: {
          bindingId: id,
          herdrSession: params.herdrSession,
          workspaceId: params.workspaceId,
          paneId: params.paneId,
          agentKind: params.agentKind,
          agentName: params.agentName,
          runtimeEvidence: params.runtimeEvidence,
          worktreePath: params.worktreePath,
          branch: params.branch,
        },
      });
    });

    return {
      id,
      taskAttemptId: params.taskAttemptId,
      herdrSession: params.herdrSession,
      workspaceId: params.workspaceId,
      paneId: params.paneId,
      tabId: params.tabId,
      worktreePath: params.worktreePath,
      branch: params.branch,
      agentName: params.agentName,
      agentKind: params.agentKind,
      lastObservedAgentState: state,
      updatedAt: now,
    };
  }

  async getWorkerBinding(taskAttemptId: string): Promise<WorkerBinding | null> {
    requireIdentifier(taskAttemptId);
    return this.db.transaction(async (tx) => {
      const res = await tx.execute({
        sql: "SELECT * FROM worker_bindings WHERE task_attempt_id = ?",
        args: [taskAttemptId],
      });
      return res.rows[0] ? parseBinding(res.rows[0]) : null;
    });
  }

  /** Persist the first prompt acknowledgement for this exact Attempt and WorkerBinding. */
  async markWorkerPromptDispatched(
    attemptId: string,
    bindingId: string,
    observedAt = new Date().toISOString(),
  ): Promise<boolean> {
    requireIdentifier(attemptId);
    requireIdentifier(bindingId);
    return this.db.transaction(async (tx) => {
      const result = await tx.execute({
        sql: `UPDATE worker_bindings
          SET prompt_dispatched_at = ?, updated_at = ?
          WHERE task_attempt_id = ? AND id = ? AND prompt_dispatched_at IS NULL`,
        args: [observedAt, observedAt, attemptId, bindingId],
      });
      return result.rowsAffected === 1;
    });
  }

  async activeWorkerBindings(herdrSession: string): Promise<WorkerBinding[]> {
    return this.db.transaction(async (tx) => {
      const result = await tx.execute({
        sql: `SELECT b.* FROM worker_bindings b JOIN tasks t ON t.active_attempt_id = b.task_attempt_id
          WHERE b.herdr_session = ? AND t.status NOT IN ('DONE', 'CANCELED', 'FAILED', 'REVIEW', 'ACCEPTED')`,
        args: [herdrSession],
      });
      return result.rows.map(parseBinding);
    });
  }

  async getWorkerBindingByPane(
    paneId: string,
    scope?: { herdrSession?: string; workspaceId?: string },
  ): Promise<WorkerBinding | null> {
    return this.db.transaction(async (tx) => {
      let sql = "SELECT * FROM worker_bindings WHERE pane_id = ?";
      const args: InValue[] = [paneId];

      if (scope?.herdrSession) {
        sql += " AND herdr_session = ?";
        args.push(scope.herdrSession);
      }
      if (scope?.workspaceId) {
        sql += " AND workspace_id = ?";
        args.push(scope.workspaceId);
      }

      sql += " ORDER BY updated_at DESC LIMIT 1";

      const res = await tx.execute({ sql, args });
      return res.rows[0] ? parseBinding(res.rows[0]) : null;
    });
  }

  async updateWorkerState(taskAttemptId: string, state: HerdrAgentLifecycleState): Promise<void> {
    requireIdentifier(taskAttemptId);
    const now = new Date().toISOString();
    await this.db.transaction(async (tx) => {
      await tx.execute({
        sql: "UPDATE worker_bindings SET last_observed_agent_state = ?, updated_at = ? WHERE task_attempt_id = ?",
        args: [state, now, taskAttemptId],
      });
      await this.appendTraceTx(tx, {
        type: "worker.state_observed",
        taskAttemptId,
        data: {
          state,
          updatedAt: now,
        },
      });
    });
  }

  /** Apply an observation and its product transition under the same write lock as review actions. */
  async observeWorker(
    scope: {
      herdrSession: string;
      workspaceId: string;
      paneId: string;
      id?: string;
      taskAttemptId?: string;
    },
    state: HerdrAgentLifecycleState,
    observedAt = new Date().toISOString(),
  ): Promise<void> {
    const observedTime = Date.parse(observedAt);
    if (!Number.isFinite(observedTime)) return;
    const observationTimestamp = new Date(observedTime).toISOString();
    await this.db.transaction(async (tx) => {
      const rows = await tx.execute({
        sql: `SELECT b.*, t.id AS task_id, t.status AS task_status, t.orchestration_mode AS orchestration_mode FROM worker_bindings b
          JOIN task_attempts a ON a.id = b.task_attempt_id
          JOIN tasks t ON t.id = a.task_id AND t.active_attempt_id = a.id
          WHERE b.herdr_session = ? AND b.workspace_id = ? AND b.pane_id = ?`,
        args: [scope.herdrSession, scope.workspaceId, scope.paneId],
      });
      if (rows.rows.length !== 1) return;
      const row = rows.rows[0]!;
      if (row.orchestration_mode !== "legacy") return;
      if (
        (scope.id && row.id !== scope.id) ||
        (scope.taskAttemptId && row.task_attempt_id !== scope.taskAttemptId) ||
        observedTime < Date.parse(stringColumn(row, "updated_at"))
      )
        return;
      const taskId = stringColumn(row, "task_id");
      const attemptId = stringColumn(row, "task_attempt_id");
      const current = stringColumn(row, "task_status");
      if (["DONE", "CANCELED", "FAILED", "REVIEW", "ACCEPTED"].includes(current)) return;
      // Pi's native Herdr hook reports working -> idle at turn completion.
      // Initial idle is not completion: require persisted observation of working,
      // rather than the optimistic state supplied when the binding was created.
      let completed = state === "done";
      if (state === "idle" && stringColumn(row, "agent_kind") === "pi") {
        const observed = await tx.execute({
          sql: "SELECT json_extract(data_json, '$.state') AS state FROM ops_trace_events WHERE task_attempt_id = ? AND type = 'worker.state_observed' AND json_extract(data_json, '$.state') != 'unknown' ORDER BY sequence DESC LIMIT 1",
          args: [attemptId],
        });
        completed = observed.rows[0]?.state === "working";
      }
      const now = new Date().toISOString();
      await tx.execute({
        sql: "UPDATE worker_bindings SET last_observed_agent_state = ?, updated_at = ? WHERE id = ?",
        args: [state, observationTimestamp, stringColumn(row, "id")],
      });
      const status = completed
        ? "REVIEW"
        : state === "blocked"
          ? "WAITING_INPUT"
          : state === "working"
            ? "RUNNING"
            : null;
      if (status && status !== current) {
        await tx.execute({
          sql: "UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?",
          args: [status, now, taskId],
        });
        await tx.execute({
          sql: "UPDATE task_attempts SET status = ?, completed_at = ? WHERE id = ?",
          args: [
            completed ? "review" : state === "blocked" ? "waiting_input" : "running",
            completed ? now : null,
            attemptId,
          ],
        });
      }
      if (state === "working" || completed) {
        await tx.execute({
          sql: "UPDATE attention_items SET resolved_at = ? WHERE task_attempt_id = ? AND kind = 'worker_blocked' AND resolved_at IS NULL",
          args: [now, attemptId],
        });
      }
      if (state === "blocked" || completed) {
        const kind = completed ? "task_review" : "worker_blocked";
        await tx.execute({
          sql: `INSERT INTO attention_items(id, kind, summary, task_id, task_attempt_id, created_at)
            SELECT ?, ?, ?, ?, ?, ? WHERE NOT EXISTS
            (SELECT 1 FROM attention_items WHERE task_attempt_id = ? AND kind = ? AND resolved_at IS NULL)`,
          args: [
            randomUUID(),
            kind,
            completed ? "Worker execution awaits review" : "Worker awaits input",
            taskId,
            attemptId,
            now,
            attemptId,
            kind,
          ],
        });
      }
      await this.appendTraceTx(tx, {
        type: "worker.state_observed",
        taskId,
        taskAttemptId: attemptId,
        data: {
          state,
          observedAt: observationTimestamp,
          previousStatus: current,
          status: status ?? current,
        },
      });
    });
  }

  /**
   * Atomic product review action: ACCEPT
   * Performs CAS verification on task status to prevent race conditions.
   * Updates task to DONE, active attempt to succeeded, resolves review attention,
   * and appends to append-only RawTrace in a single atomic database transaction.
   */
  async acceptTask(taskId: string, reviewerPrincipalId?: string): Promise<AgentTask> {
    requireIdentifier(taskId);
    const now = new Date().toISOString();

    return this.db.transaction(async (tx) => {
      const res = await tx.execute({
        sql: "SELECT * FROM tasks WHERE id = ?",
        args: [taskId],
      });
      if (!res.rows[0]) {
        throw new Error(`Task not found: ${taskId}`);
      }
      const task = parseTask(res.rows[0]);
      if (res.rows[0].orchestration_mode !== "legacy")
        throw new Error("Durable Task requires step-aware acceptance");
      if (task.status !== "REVIEW") {
        throw new Error(`Cannot accept task in status ${task.status}; must be in REVIEW`);
      }

      // CAS: Update task status to DONE only if it is still in REVIEW
      const updateResult = await tx.execute({
        sql: "UPDATE tasks SET status = 'DONE', updated_at = ? WHERE id = ? AND status = 'REVIEW'",
        args: [now, taskId],
      });

      if (updateResult.rowsAffected === 0) {
        throw new Error(`Concurrent modification: task ${taskId} is no longer in REVIEW status`);
      }

      if (task.activeAttemptId) {
        await tx.execute({
          sql: "UPDATE task_attempts SET status = 'succeeded', completed_at = COALESCE(completed_at, ?) WHERE id = ? AND task_id = ?",
          args: [now, task.activeAttemptId, taskId],
        });
      }

      await tx.execute({
        sql: "UPDATE attention_items SET resolved_at = ? WHERE task_id = ? AND resolved_at IS NULL",
        args: [now, taskId],
      });

      await this.appendTraceTx(tx, {
        type: "task.accepted",
        taskId,
        taskAttemptId: task.activeAttemptId ?? undefined,
        principalId: reviewerPrincipalId,
        data: {
          previousStatus: task.status,
          newStatus: "DONE",
          completedAt: now,
        },
      });

      return {
        ...task,
        status: "DONE",
        updatedAt: now,
      };
    });
  }

  /**
   * Atomic product review action: REWORK
   * Performs CAS verification on task status to prevent concurrent accept/rework races.
   * Closes prior attempt evidence, generates attempt N+1, updates task to RUNNING with
   * active_attempt_id = attemptN+1, resolves review attention, and appends to RawTrace.
   */
  async reworkTask(
    taskId: string,
    reworkReason: string,
    reviewerPrincipalId?: string,
  ): Promise<{ task: AgentTask; newAttempt: TaskAttempt }> {
    requireIdentifier(taskId);
    if (!reworkReason || reworkReason.trim() === "") {
      throw new Error("Rework reason is required");
    }
    const now = new Date().toISOString();
    const newAttemptId = randomUUID();

    return this.db.transaction(async (tx) => {
      const res = await tx.execute({
        sql: "SELECT * FROM tasks WHERE id = ?",
        args: [taskId],
      });
      if (!res.rows[0]) {
        throw new Error(`Task not found: ${taskId}`);
      }
      const task = parseTask(res.rows[0]);
      if (res.rows[0].orchestration_mode !== "legacy")
        throw new Error("Durable Task requires step-aware rework");
      if (task.status !== "REVIEW") {
        throw new Error(
          `Cannot request rework for task in status ${task.status}; must be in REVIEW`,
        );
      }

      // CAS: Update task status to RUNNING and active_attempt_id to newAttemptId only if still in REVIEW
      const updateResult = await tx.execute({
        sql: "UPDATE tasks SET status = 'RUNNING', active_attempt_id = ?, updated_at = ? WHERE id = ? AND status = 'REVIEW'",
        args: [newAttemptId, now, taskId],
      });

      if (updateResult.rowsAffected === 0) {
        throw new Error(`Concurrent modification: task ${taskId} is no longer in REVIEW status`);
      }

      // The previous attempt is already in review. Its execution result and
      // completion time remain intact; the new attempt and trace hold rework.

      const maxNumRes = await tx.execute({
        sql: "SELECT MAX(attempt_number) as max_num FROM task_attempts WHERE task_id = ?",
        args: [taskId],
      });
      const maxNum = maxNumRes.rows[0]?.max_num;
      const attemptNumber = (typeof maxNum === "number" ? maxNum : 0) + 1;

      await tx.execute({
        sql: `INSERT INTO task_attempts(
          id, task_id, attempt_number, status, rework_reason, started_at, completed_at, result_summary
        ) VALUES (?, ?, ?, 'running', ?, ?, NULL, NULL)`,
        args: [newAttemptId, taskId, attemptNumber, reworkReason, now],
      });

      await tx.execute({
        sql: "UPDATE attention_items SET resolved_at = ? WHERE task_id = ? AND kind = 'task_review' AND resolved_at IS NULL",
        args: [now, taskId],
      });

      await this.appendTraceTx(tx, {
        type: "task.reworked",
        taskId,
        taskAttemptId: newAttemptId,
        principalId: reviewerPrincipalId,
        data: {
          priorAttemptId: task.activeAttemptId,
          newAttemptNumber: attemptNumber,
          reworkReason,
        },
      });

      const updatedTask: AgentTask = {
        ...task,
        status: "RUNNING",
        activeAttemptId: newAttemptId,
        updatedAt: now,
      };

      const newAttempt: TaskAttempt = {
        id: newAttemptId,
        taskId,
        attemptNumber,
        status: "running",
        reworkReason,
        startedAt: now,
        completedAt: null,
      };

      return { task: updatedTask, newAttempt };
    });
  }

  /**
   * Atomic product action: CANCEL
   * Performs CAS verification on task status to ensure terminal tasks are not altered.
   */
  async cancelTask(
    taskId: string,
    reason?: string,
    callerPrincipalId?: string,
    runId?: string,
  ): Promise<AgentTask> {
    requireIdentifier(taskId);
    const now = new Date().toISOString();

    return this.db.transaction(async (tx) => {
      const res = await tx.execute({
        sql: "SELECT * FROM tasks WHERE id = ?",
        args: [taskId],
      });
      if (!res.rows[0]) {
        throw new Error(`Task not found: ${taskId}`);
      }
      const task = parseTask(res.rows[0]);
      if (res.rows[0].orchestration_mode !== "legacy")
        throw new Error("Durable Task requires step-aware cancellation");
      if (task.status === "DONE" || task.status === "CANCELED") {
        throw new Error(`Cannot cancel task in terminal status ${task.status}`);
      }

      // CAS: Update task status to CANCELED only if not terminal
      const updateResult = await tx.execute({
        sql: "UPDATE tasks SET status = 'CANCELED', updated_at = ? WHERE id = ? AND status NOT IN ('DONE', 'CANCELED')",
        args: [now, taskId],
      });

      if (updateResult.rowsAffected === 0) {
        throw new Error(`Concurrent modification: task ${taskId} is already terminal`);
      }

      if (task.activeAttemptId) {
        await tx.execute({
          sql: "UPDATE task_attempts SET status = 'canceled', completed_at = ?, result_summary = ? WHERE id = ? AND task_id = ?",
          args: [now, reason ?? "Task canceled", task.activeAttemptId, taskId],
        });
      }

      await tx.execute({
        sql: "UPDATE attention_items SET resolved_at = ? WHERE task_id = ? AND resolved_at IS NULL",
        args: [now, taskId],
      });

      await this.appendTraceTx(tx, {
        type: "task.canceled",
        taskId,
        taskAttemptId: task.activeAttemptId ?? undefined,
        runId,
        principalId: callerPrincipalId,
        data: {
          reason: reason ?? "Task canceled",
        },
      });

      return {
        ...task,
        status: "CANCELED",
        updatedAt: now,
      };
    });
  }

  async createAttentionItem(params: {
    kind: AttentionKind;
    summary: string;
    principalId?: string;
    conversationId?: string;
    taskId?: string;
    taskAttemptId?: string;
  }): Promise<AttentionItem> {
    const id = randomUUID();
    const now = new Date().toISOString();

    await this.db.transaction(async (tx) => {
      await tx.execute({
        sql: `INSERT INTO attention_items(
          id, kind, summary, principal_id, conversation_id, task_id, task_attempt_id, created_at, resolved_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          id,
          params.kind,
          params.summary,
          params.principalId ?? null,
          params.conversationId ?? null,
          params.taskId ?? null,
          params.taskAttemptId ?? null,
          now,
          null,
        ],
      });
    });

    return {
      id,
      kind: params.kind,
      summary: params.summary,
      principalId: params.principalId,
      conversationId: params.conversationId,
      taskId: params.taskId,
      taskAttemptId: params.taskAttemptId,
      createdAt: now,
      resolvedAt: null,
    };
  }

  async resolveAttentionItem(id: string): Promise<void> {
    requireIdentifier(id);
    const now = new Date().toISOString();
    await this.db.transaction(async (tx) => {
      await tx.execute({
        sql: "UPDATE attention_items SET resolved_at = ? WHERE id = ? AND resolved_at IS NULL",
        args: [now, id],
      });
    });
  }

  async resolveAttentionByTask(taskId: string, kind?: AttentionKind): Promise<void> {
    requireIdentifier(taskId);
    const now = new Date().toISOString();
    await this.db.transaction(async (tx) => {
      if (kind) {
        await tx.execute({
          sql: "UPDATE attention_items SET resolved_at = ? WHERE task_id = ? AND kind = ? AND resolved_at IS NULL",
          args: [now, taskId, kind],
        });
      } else {
        await tx.execute({
          sql: "UPDATE attention_items SET resolved_at = ? WHERE task_id = ? AND resolved_at IS NULL",
          args: [now, taskId],
        });
      }
    });
  }

  async resolveGlobalAttentionByKind(kind: AttentionKind): Promise<void> {
    const now = new Date().toISOString();
    await this.db.transaction(async (tx) => {
      await tx.execute({
        sql: "UPDATE attention_items SET resolved_at = ? WHERE kind = ? AND task_id IS NULL AND task_attempt_id IS NULL AND resolved_at IS NULL",
        args: [now, kind],
      });
    });
  }

  async listAttentionItems(onlyUnresolved = true): Promise<AttentionItem[]> {
    return this.db.transaction(async (tx) => {
      const sql = onlyUnresolved
        ? "SELECT * FROM attention_items WHERE resolved_at IS NULL ORDER BY created_at DESC"
        : "SELECT * FROM attention_items ORDER BY created_at DESC";
      const res = await tx.execute(sql);
      return res.rows.map(parseAttention);
    });
  }

  async getOpsSnapshot(
    caller?: CallerContext,
    _evidence?: { runId?: string; conversationId?: string },
  ): Promise<AgentOpsSnapshot> {
    return this.db.transaction(async (tx) => {
      const visible = caller ? visibleTaskSubquery(caller) : null;
      const taskFilter = visible ? `id IN (${visible.sql})` : "1 = 1";
      const attentionFilter = visible ? `task_id IN (${visible.sql})` : "1 = 1";
      const workerFilter = caller
        ? `task_attempt_id IN (SELECT id FROM task_attempts WHERE task_id IN (${visible!.sql}))`
        : "1 = 1";
      // Attention items
      const attentionRows = await tx.execute({
        sql: `SELECT kind, COUNT(*) as count FROM attention_items WHERE resolved_at IS NULL AND ${attentionFilter} GROUP BY kind`,
        args: visible?.args ?? [],
      });
      const attentionCounts: Record<string, number> = {};
      let totalAttention = 0;
      for (const row of attentionRows.rows) {
        const count = Number(row.count);
        attentionCounts[stringColumn(row, "kind")] = count;
        totalAttention += count;
      }

      // Tasks
      const taskRows = await tx.execute({
        sql: `SELECT status, COUNT(*) as count FROM tasks WHERE ${taskFilter} GROUP BY status`,
        args: visible?.args ?? [],
      });
      const taskCounts: Record<string, number> = {};
      for (const row of taskRows.rows) {
        taskCounts[stringColumn(row, "status")] = Number(row.count);
      }

      // Done today
      const startOfDay = new Date();
      startOfDay.setHours(0, 0, 0, 0);
      const doneTodayRes = await tx.execute({
        sql: `SELECT COUNT(*) as count FROM tasks WHERE status = 'DONE' AND updated_at >= ? AND ${taskFilter}`,
        args: [startOfDay.toISOString(), ...(visible?.args ?? [])],
      });
      const doneToday = Number(doneTodayRes.rows[0]?.count ?? 0);

      // Workers
      const workerRows = await tx.execute({
        sql: `SELECT last_observed_agent_state as state, COUNT(*) as count FROM worker_bindings WHERE ${workerFilter} GROUP BY last_observed_agent_state`,
        args: visible?.args ?? [],
      });
      const workerCounts: Record<string, number> = {};
      let totalWorkers = 0;
      for (const row of workerRows.rows) {
        const count = Number(row.count);
        workerCounts[stringColumn(row, "state")] = count;
        totalWorkers += count;
      }

      return {
        attention: {
          total: totalAttention,
          unansweredMessages: attentionCounts["unanswered_message"] ?? 0,
          approvals: attentionCounts["approval_required"] ?? 0,
          blockedWorkers: attentionCounts["worker_blocked"] ?? 0,
          awaitingReview: attentionCounts["task_review"] ?? 0,
          failures:
            (attentionCounts["task_failed"] ?? 0) +
            (attentionCounts["delivery_failed"] ?? 0) +
            (attentionCounts["ops_connection_problem"] ?? 0),
        },
        tasks: {
          open:
            (taskCounts["NEW"] ?? 0) +
            (taskCounts["QUEUED"] ?? 0) +
            (taskCounts["ASSIGNED"] ?? 0) +
            (taskCounts["RUNNING"] ?? 0) +
            (taskCounts["WAITING_INPUT"] ?? 0) +
            (taskCounts["REVIEW"] ?? 0),
          queued: (taskCounts["NEW"] ?? 0) + (taskCounts["QUEUED"] ?? 0),
          running: (taskCounts["ASSIGNED"] ?? 0) + (taskCounts["RUNNING"] ?? 0),
          waiting: taskCounts["WAITING_INPUT"] ?? 0,
          review: taskCounts["REVIEW"] ?? 0,
          doneToday,
        },
        workers: {
          total: totalWorkers,
          working: workerCounts["working"] ?? 0,
          blocked: workerCounts["blocked"] ?? 0,
          idle: workerCounts["idle"] ?? 0,
          done: workerCounts["done"] ?? 0,
          unknown: (workerCounts["unknown"] ?? 0) + (workerCounts["starting"] ?? 0),
        },
      };
    });
  }
}
