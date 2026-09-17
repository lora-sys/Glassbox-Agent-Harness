import { randomUUID } from "node:crypto";
import type { InValue, Row } from "@libsql/client";
import type {
  AgentOpsSnapshot,
  AgentTask,
  AttentionItem,
  AttentionKind,
  AttemptStatus,
  HerdrAgentLifecycleState,
  TaskAttempt,
  TaskPriority,
  TaskStatus,
  WorkerBinding,
} from "@glassbox/contracts";
import { DomainDatabase, optionalString, stringColumn } from "../persistence/database.js";
import { requireIdentifier } from "../identity/scope.js";

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
    createdAt: stringColumn(row, "created_at"),
    updatedAt: stringColumn(row, "updated_at"),
  };
}

function parseAttempt(row: Row): TaskAttempt {
  return {
    id: stringColumn(row, "id"),
    taskId: stringColumn(row, "task_id"),
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
    lastObservedAgentState: stringColumn(row, "last_observed_agent_state") as HerdrAgentLifecycleState,
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

  async createTask(params: {
    id?: string;
    title: string;
    description?: string;
    priority?: TaskPriority;
    creatorPrincipalId: string;
    conversationId?: string;
    runId?: string;
    acceptanceCriteria?: string[];
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

  async updateTaskStatus(taskId: string, status: TaskStatus, activeAttemptId?: string | null): Promise<void> {
    requireIdentifier(taskId);
    const now = new Date().toISOString();
    await this.db.transaction(async (tx) => {
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

  async listTasks(options?: { creatorPrincipalId?: string; status?: TaskStatus }): Promise<AgentTask[]> {
    return this.db.transaction(async (tx) => {
      let sql = "SELECT * FROM tasks WHERE 1=1";
      const args: InValue[] = [];
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
      return res.rows.map(parseTask);
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
        args: [
          id,
          params.taskId,
          num,
          "running",
          params.reworkReason ?? null,
          now,
          null,
          null,
        ],
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

  async updateAttemptStatus(attemptId: string, status: AttemptStatus, resultSummary?: string): Promise<void> {
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
  }): Promise<WorkerBinding> {
    requireIdentifier(params.taskAttemptId);
    const id = randomUUID();
    const now = new Date().toISOString();
    const state: HerdrAgentLifecycleState = params.lastObservedAgentState ?? "working";

    await this.db.transaction(async (tx) => {
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

  async getWorkerBindingByPane(paneId: string): Promise<WorkerBinding | null> {
    return this.db.transaction(async (tx) => {
      const res = await tx.execute({
        sql: "SELECT * FROM worker_bindings WHERE pane_id = ? ORDER BY updated_at DESC LIMIT 1",
        args: [paneId],
      });
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

  async listAttentionItems(onlyUnresolved = true): Promise<AttentionItem[]> {
    return this.db.transaction(async (tx) => {
      const sql = onlyUnresolved
        ? "SELECT * FROM attention_items WHERE resolved_at IS NULL ORDER BY created_at DESC"
        : "SELECT * FROM attention_items ORDER BY created_at DESC";
      const res = await tx.execute(sql);
      return res.rows.map(parseAttention);
    });
  }

  async getOpsSnapshot(): Promise<AgentOpsSnapshot> {
    return this.db.transaction(async (tx) => {
      // Attention items
      const attentionRows = await tx.execute(
        "SELECT kind, COUNT(*) as count FROM attention_items WHERE resolved_at IS NULL GROUP BY kind",
      );
      const attentionCounts: Record<string, number> = {};
      let totalAttention = 0;
      for (const row of attentionRows.rows) {
        const count = Number(row.count);
        attentionCounts[stringColumn(row, "kind")] = count;
        totalAttention += count;
      }

      // Tasks
      const taskRows = await tx.execute(
        "SELECT status, COUNT(*) as count FROM tasks GROUP BY status",
      );
      const taskCounts: Record<string, number> = {};
      for (const row of taskRows.rows) {
        taskCounts[stringColumn(row, "status")] = Number(row.count);
      }

      // Done today
      const startOfDay = new Date();
      startOfDay.setHours(0, 0, 0, 0);
      const doneTodayRes = await tx.execute({
        sql: "SELECT COUNT(*) as count FROM tasks WHERE status = 'DONE' AND updated_at >= ?",
        args: [startOfDay.toISOString()],
      });
      const doneToday = Number(doneTodayRes.rows[0]?.count ?? 0);

      // Workers
      const workerRows = await tx.execute(
        "SELECT last_observed_agent_state as state, COUNT(*) as count FROM worker_bindings GROUP BY last_observed_agent_state",
      );
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
