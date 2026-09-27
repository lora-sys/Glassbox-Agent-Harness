import type { AgentOpsSnapshot, AgentTask, TaskPriority } from "@glassbox/contracts";
import { AccessDeniedError } from "../auth/service.js";
import { scopeKey, type CallerContext } from "../identity/scope.js";
import type { DomainStore } from "../persistence/index.js";
import type { HerdrBridge } from "./herdr-bridge.js";
import { buildOpsHealthSnapshot, type OpsHealthInput, type OpsHealthSnapshot } from "./health.js";
import { mkdir, writeFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";

export interface WorkerPolicy {
  databasePath: string;
  contextDirectory: string;
  resourceId: string;
}

const OPS_RESOURCE = "agent-operations";
type RunEvidence = { runId?: string; conversationId?: string };
type CreateTaskInput = RunEvidence & {
  title: string;
  description?: string;
  priority?: TaskPriority;
  acceptanceCriteria?: string[];
};

export class AuthorizedOpsService {
  constructor(
    private readonly store: DomainStore,
    private readonly bridge: HerdrBridge,
    private readonly workerPolicy?: WorkerPolicy,
  ) {}

  private async workerContext(
    caller: CallerContext,
    taskId: string,
    attemptId: string,
    root?: string,
  ): Promise<string | undefined> {
    if (!this.workerPolicy) return undefined;
    const policy = this.workerPolicy;
    if (!root || ![root, policy.databasePath, policy.contextDirectory].every(isAbsolute))
      throw new Error("Invalid worker policy paths");
    const canonicalRoot = await realpath(root);
    for (const protectedPath of [
      await realpath(policy.databasePath),
      await realpath(dirname(policy.contextDirectory)),
    ]) {
      const local = relative(canonicalRoot, protectedPath);
      if (!isAbsolute(local) && local !== ".." && !local.startsWith(`..${sep}`))
        throw new Error("Worker directory contains service state");
    }
    const allowedActions: string[] = [];
    for (const action of ["worker:file:read", "worker:file:write"]) {
      const decision = await this.store.authorization.check({
        caller,
        resourceId: policy.resourceId,
        action,
      });
      if (decision.decision === "ALLOW") allowedActions.push(action);
    }
    if (!allowedActions.length) throw new Error("No delegated file authority");
    await mkdir(policy.contextDirectory, { recursive: true, mode: 0o700 });
    const file = join(policy.contextDirectory, `${attemptId}.json`);
    await writeFile(
      file,
      JSON.stringify({
        databasePath: policy.databasePath,
        resourceId: policy.resourceId,
        root: canonicalRoot,
        taskId,
        attemptId,
        caller,
        allowedActions,
      }),
      { flag: "wx", mode: 0o600 },
    );
    return file;
  }

  private async authorize(
    caller: CallerContext,
    resourceId: string,
    action: string,
    evidence?: RunEvidence,
  ): Promise<void> {
    const decision = await this.store.authorization.check({
      caller,
      resourceId,
      action,
      ...evidence,
    });
    await this.store.tasks.recordAuthorizationTrace({
      principalId: caller.principalId,
      resourceId,
      action,
      scopeKey: scopeKey(caller.scope),
      decision: decision.decision,
      reason: decision.reason,
      ...evidence,
    });
    if (decision.decision !== "ALLOW") throw new AccessDeniedError(decision);
  }

  async status(caller: CallerContext, evidence?: RunEvidence): Promise<AgentOpsSnapshot> {
    await this.authorize(caller, OPS_RESOURCE, "ops:status");
    return this.store.tasks.getOpsSnapshot(caller, evidence);
  }

  async health(
    caller: CallerContext,
    observation: Pick<OpsHealthInput, "herdr" | "now" | "windowStart" | "staleAfterMs">,
    evidence?: RunEvidence,
  ): Promise<OpsHealthSnapshot> {
    await this.authorize(caller, OPS_RESOURCE, "ops:status");
    const records = await this.store.tasks.getOpsHealthRecords(caller, evidence);
    const observations = observation.herdr.observations.length
      ? observation.herdr.observations
      : records.bindings.map((binding) => ({
          taskAttemptId: binding.taskAttemptId,
          state: binding.lastObservedAgentState,
          observedAt: binding.updatedAt,
        }));
    return buildOpsHealthSnapshot({
      ...records,
      ...observation,
      herdr: { ...observation.herdr, observations },
    });
  }

  async list(caller: CallerContext, evidence?: RunEvidence): Promise<AgentTask[]> {
    await this.authorize(caller, OPS_RESOURCE, "task:list");
    return this.store.tasks.listTasks({ caller, ...evidence });
  }

  async get(caller: CallerContext, taskId: string): Promise<AgentTask | null> {
    await this.authorize(caller, `task-${taskId}`, "task:read");
    return this.store.tasks.getTask(taskId);
  }

  async create(caller: CallerContext, input: CreateTaskInput): Promise<AgentTask> {
    await this.authorize(caller, OPS_RESOURCE, "task:create");
    return this.createRecord(caller, input);
  }

  private async createRecord(caller: CallerContext, input: CreateTaskInput): Promise<AgentTask> {
    const task = await this.store.tasks.createTask({
      title: input.title,
      description: input.description,
      priority: input.priority,
      acceptanceCriteria: input.acceptanceCriteria,
      creatorPrincipalId: caller.principalId,
      runId: input.runId,
      conversationId: input.conversationId,
      authorizationScope: caller.scope,
    });
    return task;
  }

  async workerStatus(caller: CallerContext, taskId: string) {
    const { binding } = await this.binding(caller, taskId, "worker:status");
    return { state: binding.lastObservedAgentState, observedAt: binding.updatedAt };
  }

  async delegate(
    caller: CallerContext,
    input: {
      taskId?: string;
      title?: string;
      description?: string;
      priority?: TaskPriority;
      acceptanceCriteria?: string[];
      workspaceId: string;
      agentKind: string;
      worktreePath?: string;
      branch?: string;
      prompt: string;
      conversationId?: string;
      runId?: string;
    },
  ): Promise<AgentTask> {
    await this.authorize(
      caller,
      input.taskId ? `task-${input.taskId}` : OPS_RESOURCE,
      "task:delegate",
    );
    if (!input.taskId && !input.title) throw new Error("New Task requires a title");
    const task = input.taskId
      ? await this.store.tasks.getTask(input.taskId)
      : await this.createRecord(caller, {
          ...input,
          title: input.title!,
          description: input.description ?? input.prompt,
        });
    if (!task) throw new Error("Task is unavailable");
    const attempt = await this.store.tasks.createAttempt({ taskId: task.id });
    try {
      const worker = await this.bridge.startAgent({
        workspaceId: input.workspaceId,
        agentKind: input.agentKind,
        worktreePath: input.worktreePath,
        branch: input.branch,
        workerContextFile: await this.workerContext(
          caller,
          task.id,
          attempt.id,
          input.worktreePath,
        ),
      });
      const herdrSnapshot = await this.bridge.getSnapshot();
      const actualWorkspace = herdrSnapshot.workspaces.find((workspace) =>
        workspace.panes.some((pane) => pane.paneId === worker.paneId),
      );
      if (!actualWorkspace)
        throw new Error(`Herdr did not expose the started pane: ${worker.paneId}`);
      await this.store.tasks.bindWorker({
        taskAttemptId: attempt.id,
        herdrSession: herdrSnapshot.sessionId,
        workspaceId: actualWorkspace.workspaceId,
        paneId: worker.paneId,
        agentName: worker.agentName,
        agentKind: input.agentKind,
        runtimeEvidence: worker.runtimeEvidence,
        worktreePath: input.worktreePath,
        branch: input.branch,
      });
      await this.bridge.promptAgent({
        paneId: worker.paneId,
        agentName: worker.agentName,
        prompt: input.prompt,
      });
    } catch {
      await this.store.tasks.recordDispatchProblem(task.id, attempt.id, caller.principalId);
    }
    return (await this.store.tasks.getTask(task.id))!;
  }

  private async binding(caller: CallerContext, taskId: string, action: string) {
    await this.authorize(caller, `task-${taskId}`, action);
    const task = await this.store.tasks.getTask(taskId);
    if (!task?.activeAttemptId) throw new Error(`Task has no active attempt: ${taskId}`);
    const binding = await this.store.tasks.getWorkerBinding(task.activeAttemptId);
    if (!binding) throw new Error(`Task attempt has no WorkerBinding: ${task.activeAttemptId}`);
    if (!binding.agentName) throw new Error("Worker binding has no verified agent identity");
    return { task, binding };
  }

  async readWorker(caller: CallerContext, taskId: string, evidence?: RunEvidence) {
    const { binding } = await this.binding(caller, taskId, "worker:read");
    const sources = new Set(await this.store.tasks.workerSourceResources(taskId));
    if (this.workerPolicy) sources.add(this.workerPolicy.resourceId);
    for (const resourceId of sources)
      await this.authorize(caller, resourceId, "worker:file:read", evidence);
    return this.bridge.readAgent({ paneId: binding.paneId, agentName: binding.agentName });
  }

  async promptWorker(caller: CallerContext, taskId: string, prompt: string): Promise<void> {
    const { binding } = await this.binding(caller, taskId, "worker:prompt");
    await this.bridge.promptAgent({ paneId: binding.paneId, agentName: binding.agentName, prompt });
  }

  async accept(caller: CallerContext, taskId: string): Promise<void> {
    await this.authorize(caller, `task-${taskId}`, "task:accept");
    await this.store.tasks.acceptTask(taskId, caller.principalId);
  }

  async rework(
    caller: CallerContext,
    taskId: string,
    reason: string,
    prompt: string,
  ): Promise<AgentTask> {
    const current = await this.binding(caller, taskId, "task:rework");
    await this.authorize(caller, `task-${taskId}`, "worker:prompt");
    const result = await this.store.tasks.reworkTask(taskId, reason, caller.principalId);
    try {
      const worker = await this.bridge.startAgent({
        workspaceId: current.binding.workspaceId,
        agentKind: current.binding.agentKind,
        worktreePath: current.binding.worktreePath,
        branch: current.binding.branch,
        workerContextFile: await this.workerContext(
          caller,
          taskId,
          result.newAttempt.id,
          current.binding.worktreePath,
        ),
      });
      if (worker.paneId === current.binding.paneId)
        throw new Error("Rework requires a new Worker pane");
      await this.store.tasks.bindWorker({
        taskAttemptId: result.newAttempt.id,
        herdrSession: current.binding.herdrSession,
        workspaceId: current.binding.workspaceId,
        paneId: worker.paneId,
        agentName: worker.agentName,
        agentKind: current.binding.agentKind,
        runtimeEvidence: worker.runtimeEvidence,
        worktreePath: current.binding.worktreePath,
        branch: current.binding.branch,
        lastObservedAgentState: "working",
      });
      await this.bridge.promptAgent({ paneId: worker.paneId, agentName: worker.agentName, prompt });
    } catch {
      await this.store.tasks.recordDispatchProblem(
        taskId,
        result.newAttempt.id,
        caller.principalId,
      );
    }
    return (await this.store.tasks.getTask(taskId))!;
  }

  async cancel(caller: CallerContext, taskId: string, reason?: string): Promise<void> {
    await this.authorize(caller, `task-${taskId}`, "task:cancel");
    const task = await this.store.tasks.getTask(taskId);
    const binding = task?.activeAttemptId
      ? await this.store.tasks.getWorkerBinding(task.activeAttemptId)
      : null;
    if (binding) {
      if (!binding.agentName) throw new Error("Worker binding has no verified agent identity");
      await this.bridge.stopAgent({ paneId: binding.paneId, agentName: binding.agentName });
    }
    await this.store.tasks.cancelTask(taskId, reason, caller.principalId);
  }
}
