import type { AgentOpsSnapshot, AgentTask, TaskPriority } from "@glassbox/contracts";
import { AccessDeniedError, type AuthorizationDecision } from "../auth/service.js";
import { scopeKey, type CallerContext } from "../identity/scope.js";
import type { DomainStore } from "../persistence/index.js";
import type { HerdrBridge } from "./herdr-bridge.js";
import { mkdir, writeFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import type { WorkspaceRegistry } from "../workspace/registry.js";
import { WorkspaceWriteOccupancy, type WriteOccupancyLease } from "../workspace/write-occupancy.js";

export interface WorkerPolicy {
  databasePath: string;
  contextDirectory: string;
  resourceId: string;
}

export interface WorkerWorkspaceBoundary {
  registry: WorkspaceRegistry;
  writes: WorkspaceWriteOccupancy;
}

type WorkerContext = { file: string; lease: WriteOccupancyLease | null };
type StartedWorker = Awaited<ReturnType<HerdrBridge["startAgent"]>>;

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
    private readonly workspaceBoundary?: WorkerWorkspaceBoundary,
  ) {}

  private async workerContext(
    caller: CallerContext,
    taskId: string,
    attemptId: string,
    root?: string,
  ): Promise<WorkerContext | undefined> {
    if (!this.workerPolicy) {
      if (this.workspaceBoundary) throw new Error("Worker has no bounded file policy");
      return undefined;
    }
    const policy = this.workerPolicy;
    if (!root || ![root, policy.databasePath, policy.contextDirectory].every(isAbsolute))
      throw new Error("Invalid worker policy paths");
    const canonicalRoot = await realpath(root);
    let productWorkspaceId: string | undefined;
    if (this.workspaceBoundary) {
      for (const candidate of await this.workspaceBoundary.registry.listForPrincipal(
        caller.principalId,
      )) {
        let workspace;
        try {
          workspace = await this.workspaceBoundary.registry.resolveAuthorized(
            caller.principalId,
            candidate.id,
            "read",
          );
        } catch {
          continue;
        }
        if (workspace.canonicalPath === canonicalRoot) {
          productWorkspaceId = workspace.id;
          break;
        }
      }
      if (!productWorkspaceId) throw new Error("Worker directory is not a granted workspace");
    }
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
    const writable = allowedActions.includes("worker:file:write");
    if (productWorkspaceId) {
      await this.workspaceBoundary!.registry.resolveAuthorized(
        caller.principalId,
        productWorkspaceId,
        writable ? "write" : "read",
      );
      const decision = await this.store.authorization.check({
        caller,
        resourceId: `workspace:${productWorkspaceId}`,
        action: writable ? "workspace:write" : "workspace:read",
      });
      if (decision.decision !== "ALLOW") throw new AccessDeniedError(decision);
    }
    const lease =
      writable && productWorkspaceId
        ? this.workspaceBoundary!.writes.acquire({
            workspaceId: productWorkspaceId,
            principalId: caller.principalId,
            executionId: attemptId,
            sandboxSessionId: `glassbox-pi-${attemptId.replace(/-/gu, "").slice(0, 20)}`,
            policyVersion: "herdr-worker-v1",
          })
        : null;
    const file = join(policy.contextDirectory, `${attemptId}.json`);
    try {
      await mkdir(policy.contextDirectory, { recursive: true, mode: 0o700 });
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
          ...(productWorkspaceId
            ? { productWorkspaceId, occupancyRoot: this.workspaceBoundary!.writes.dataRoot, lease }
            : {}),
        }),
        { flag: "wx", mode: 0o600 },
      );
      if (lease)
        await this.store.tasks.recordTrace({
          type: "worker.workspace_lease",
          taskId,
          taskAttemptId: attemptId,
          principalId: caller.principalId,
          data: { workspaceId: lease.workspaceId, leaseId: lease.leaseId, state: "acquired" },
        });
    } catch (error) {
      if (lease) await this.workspaceBoundary!.writes.closeAndRelease(lease, async () => undefined);
      throw error;
    }
    return { file, lease };
  }

  private async authorize(
    caller: CallerContext,
    resourceId: string,
    action: string,
    evidence?: RunEvidence,
  ): Promise<AuthorizationDecision> {
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
    return decision;
  }

  async status(caller: CallerContext, evidence?: RunEvidence): Promise<AgentOpsSnapshot> {
    await this.authorize(caller, OPS_RESOURCE, "ops:status");
    return this.store.tasks.getOpsSnapshot(caller, evidence);
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

  private workerLease(attemptId: string) {
    return this.workspaceBoundary?.writes
      .listUnresolved()
      .find(
        ({ lease }) => lease.policyVersion === "herdr-worker-v1" && lease.executionId === attemptId,
      );
  }

  private async recordWorkerLease(
    attemptId: string,
    lease: WriteOccupancyLease,
    state: "released" | "quarantined",
  ): Promise<void> {
    const attempt = await this.store.tasks.getAttempt(attemptId);
    await this.store.tasks.recordTrace({
      type: "worker.workspace_lease",
      ...(attempt ? { taskId: attempt.taskId } : {}),
      taskAttemptId: attemptId,
      principalId: lease.principalId,
      data: { workspaceId: lease.workspaceId, leaseId: lease.leaseId, state },
    });
  }

  private async closeWorker(
    attemptId: string,
    worker: { paneId: string; agentName: string; herdrSession: string },
  ): Promise<void> {
    if (!this.workspaceBoundary) {
      await this.bridge.stopAgent(worker);
      return;
    }
    const current = this.workerLease(attemptId);
    if (!current) {
      await this.bridge.closeAgent(worker);
      return;
    }
    const writes = this.workspaceBoundary!.writes;
    if (current.state === "quarantined") {
      await writes.releaseQuarantined(current.lease, async () => {
        await this.bridge.closeAgent(worker);
        return true;
      });
    } else {
      await writes.closeAndRelease(current.lease, () => this.bridge.closeAgent(worker));
    }
    await this.recordWorkerLease(attemptId, current.lease, "released");
  }

  private async failedDispatch(
    attemptId: string,
    context: WorkerContext | undefined,
    started: boolean,
    worker?: StartedWorker,
    herdrSession?: string,
  ): Promise<void> {
    if (!context?.lease) return;
    if (!started) {
      await this.workspaceBoundary!.writes.closeAndRelease(context.lease, async () => undefined);
      return;
    }
    if (worker && herdrSession) {
      try {
        await this.closeWorker(attemptId, { ...worker, herdrSession });
        return;
      } catch {
        // The durable quarantine below remains until a trusted stop check succeeds.
      }
    }
    const current = this.workerLease(attemptId);
    if (current?.state === "active") {
      this.workspaceBoundary!.writes.quarantine(current.lease);
      await this.recordWorkerLease(attemptId, current.lease, "quarantined");
    }
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
    let context: WorkerContext | undefined;
    let started = false;
    let worker: StartedWorker | undefined;
    let dispatchSession: string | undefined;
    try {
      context = await this.workerContext(caller, task.id, attempt.id, input.worktreePath);
      if (this.workspaceBoundary) dispatchSession = (await this.bridge.getSnapshot()).sessionId;
      started = true;
      worker = await this.bridge.startAgent({
        workspaceId: input.workspaceId,
        agentKind: input.agentKind,
        worktreePath: input.worktreePath,
        branch: input.branch,
        workerContextFile: context?.file,
        ...(context?.lease ? { agentName: context.lease.sandboxSessionId } : {}),
      });
      const startedWorker = worker;
      const herdrSnapshot = await this.bridge.getSnapshot();
      if (dispatchSession && herdrSnapshot.sessionId !== dispatchSession)
        throw new Error("Herdr session changed during Worker launch");
      const actualWorkspace = herdrSnapshot.workspaces.find((workspace) =>
        workspace.panes.some((pane) => pane.paneId === startedWorker.paneId),
      );
      if (!actualWorkspace)
        throw new Error(`Herdr did not expose the started pane: ${startedWorker.paneId}`);
      const actualPane = actualWorkspace.panes.find((pane) => pane.paneId === startedWorker.paneId);
      if (
        this.workspaceBoundary &&
        (!actualPane?.cwd ||
          !input.worktreePath ||
          (await realpath(actualPane.cwd)) !== (await realpath(input.worktreePath)))
      )
        throw new Error("Herdr Worker directory differs from the authorized workspace");
      await this.store.tasks.bindWorker({
        taskAttemptId: attempt.id,
        herdrSession: herdrSnapshot.sessionId,
        workspaceId: actualWorkspace.workspaceId,
        paneId: startedWorker.paneId,
        agentName: startedWorker.agentName,
        agentKind: input.agentKind,
        runtimeEvidence: startedWorker.runtimeEvidence,
        worktreePath: input.worktreePath,
        branch: input.branch,
      });
      await this.bridge.promptAgent({
        paneId: startedWorker.paneId,
        agentName: startedWorker.agentName,
        prompt: input.prompt,
      });
    } catch {
      await this.failedDispatch(attempt.id, context, started, worker, dispatchSession);
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
    const sources = await this.store.tasks.workerSourceResources(taskId);
    const resourceIds = new Set(sources.map((source) => source.resourceId));
    if (this.workerPolicy) resourceIds.add(this.workerPolicy.resourceId);
    const sourceDecisionIds: string[] = [];
    for (const resourceId of resourceIds)
      sourceDecisionIds.push(
        (await this.authorize(caller, resourceId, "worker:file:read", evidence)).id,
      );
    if (this.workspaceBoundary && sources.length) {
      if (!binding.worktreePath) throw new Error("Worker source directory is unavailable");
      const boundPath = await realpath(binding.worktreePath);
      for (const source of sources) {
        let workspaceId = source.productWorkspaceId;
        if (!workspaceId) {
          for (const candidate of await this.workspaceBoundary.registry.listForPrincipal(
            caller.principalId,
          )) {
            const workspace = await this.workspaceBoundary.registry.resolveAuthorized(
              caller.principalId,
              candidate.id,
              "read",
            );
            if (workspace.canonicalPath === boundPath) {
              workspaceId = workspace.id;
              break;
            }
          }
        }
        if (!workspaceId) throw new Error("Worker source workspace is unavailable");
        const workspace = await this.workspaceBoundary.registry.resolveAuthorized(
          caller.principalId,
          workspaceId,
          "read",
        );
        if (workspace.canonicalPath !== boundPath)
          throw new Error("Worker source directory differs from the bound workspace");
        const decision = await this.authorize(
          caller,
          `workspace:${workspaceId}`,
          "workspace:read",
          evidence,
        );
        sourceDecisionIds.push(decision.id);
      }
    }
    const result = await this.bridge.readAgent({
      paneId: binding.paneId,
      agentName: binding.agentName,
    });
    if (evidence?.runId)
      for (const decisionId of sourceDecisionIds)
        await this.store.authorization.markDeliverySource(decisionId, "content_source");
    return result;
  }

  async promptWorker(caller: CallerContext, taskId: string, prompt: string): Promise<void> {
    const { binding } = await this.binding(caller, taskId, "worker:prompt");
    await this.bridge.promptAgent({ paneId: binding.paneId, agentName: binding.agentName, prompt });
  }

  async accept(caller: CallerContext, taskId: string): Promise<void> {
    await this.authorize(caller, `task-${taskId}`, "task:accept");
    if (this.workspaceBoundary) {
      const task = await this.store.tasks.getTask(taskId);
      if (task?.status !== "REVIEW") throw new Error("Task is not ready for acceptance");
      const binding = task?.activeAttemptId
        ? await this.store.tasks.getWorkerBinding(task.activeAttemptId)
        : null;
      if (binding?.agentName)
        await this.closeWorker(task!.activeAttemptId!, {
          paneId: binding.paneId,
          agentName: binding.agentName,
          herdrSession: binding.herdrSession,
        });
    }
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
    if (current.task.status !== "REVIEW") throw new Error("Task is not ready for rework");
    if (this.workspaceBoundary)
      await this.closeWorker(current.task.activeAttemptId!, {
        paneId: current.binding.paneId,
        agentName: current.binding.agentName!,
        herdrSession: current.binding.herdrSession,
      });
    const result = await this.store.tasks.reworkTask(taskId, reason, caller.principalId);
    let context: WorkerContext | undefined;
    let started = false;
    let worker: StartedWorker | undefined;
    let dispatchSession: string | undefined;
    try {
      context = await this.workerContext(
        caller,
        taskId,
        result.newAttempt.id,
        current.binding.worktreePath,
      );
      if (this.workspaceBoundary) dispatchSession = (await this.bridge.getSnapshot()).sessionId;
      started = true;
      worker = await this.bridge.startAgent({
        workspaceId: current.binding.workspaceId,
        agentKind: current.binding.agentKind,
        worktreePath: current.binding.worktreePath,
        branch: current.binding.branch,
        workerContextFile: context?.file,
        ...(context?.lease ? { agentName: context.lease.sandboxSessionId } : {}),
      });
      if (this.workspaceBoundary) {
        const snapshot = await this.bridge.getSnapshot();
        if (dispatchSession && snapshot.sessionId !== dispatchSession)
          throw new Error("Herdr session changed during Worker launch");
        const pane = snapshot.workspaces
          .flatMap((workspace) => workspace.panes)
          .find((candidate) => candidate.paneId === worker!.paneId);
        if (
          !pane?.cwd ||
          !current.binding.worktreePath ||
          (await realpath(pane.cwd)) !== (await realpath(current.binding.worktreePath))
        )
          throw new Error("Herdr Worker directory differs from the authorized workspace");
      }
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
      await this.failedDispatch(result.newAttempt.id, context, started, worker, dispatchSession);
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
      await this.closeWorker(task!.activeAttemptId!, {
        paneId: binding.paneId,
        agentName: binding.agentName,
        herdrSession: binding.herdrSession,
      });
    }
    await this.store.tasks.cancelTask(taskId, reason, caller.principalId);
  }
}
