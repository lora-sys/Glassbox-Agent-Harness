import { createHash, randomUUID } from "node:crypto";
import type {
  AgentOpsSnapshot,
  AgentTask,
  ChildTaskLink,
  TaskPriority,
  TaskSignal,
  TaskStep,
} from "@glassbox/contracts";
import { AccessDeniedError, type AuthorizationDecision } from "../auth/service.js";
import { scopeKey, type CallerContext } from "../identity/scope.js";
import type { DomainStore } from "../persistence/index.js";
import { stringColumn } from "../persistence/database.js";
import type { HerdrBridge } from "./herdr-bridge.js";
import { DEFAULT_TASK_GRAPH_LIMITS } from "./task-graph.js";
import { parseTaskGetSpec } from "./tool-step-spec.js";
import { parseWorkerTextFileSpec } from "./worker-file-spec.js";
import { WorkerFiles } from "./worker-files.js";
import { WorkerArtifactCaptureError, type DurableWorkerClaim } from "./durable-worker-observer.js";
import { buildOpsHealthSnapshot, type OpsHealthInput, type OpsHealthSnapshot } from "./health.js";
import { mkdir, writeFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import type { WorkspaceRegistry } from "../workspace/registry.js";
import { WorkspaceWriteOccupancy, type WriteOccupancyLease } from "../workspace/write-occupancy.js";
import type { ClaimedTaskStep } from "./long-work-store.js";

export interface WorkerPolicy {
  databasePath: string;
  contextDirectory: string;
  resourceId: string;
}

export interface WorkerWorkspaceBoundary {
  registry: WorkspaceRegistry;
  writes: WorkspaceWriteOccupancy;
}

export interface ConfiguredWorkerTarget {
  workspaceId: string;
  agentKind: string;
  worktreePath: string;
}

export class ClaimedWorkerDispatchError extends Error {
  constructor(
    readonly outcome: "not_started" | "unknown",
    readonly decisionId?: string,
  ) {
    super(
      outcome === "not_started" ? "Worker was not started" : "Worker dispatch outcome is unknown",
    );
    this.name = "ClaimedWorkerDispatchError";
  }
}

type WorkerContext = { file: string; lease: WriteOccupancyLease | null };
type StartedWorker = Awaited<ReturnType<HerdrBridge["startAgent"]>>;

function textExcerpt(value: string, byteLimit: number): { text: string; truncated: boolean } {
  let bytes = 0;
  let text = "";
  for (const character of value) {
    const size = Buffer.byteLength(character);
    if (bytes + size > byteLimit) return { text, truncated: true };
    text += character;
    bytes += size;
  }
  return { text, truncated: false };
}

const OPS_RESOURCE = "agent-operations";
type RunEvidence = { runId?: string; conversationId?: string; delegatedTaskId?: string };
export interface LongWorkRuntimePort {
  available?(): boolean;
  start(taskId: string, policyRevision: number): Promise<unknown>;
  wake(taskId: string): Promise<void>;
}
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
    private readonly longWorkRuntime?: LongWorkRuntimePort,
    private readonly workspaceBoundary?: WorkerWorkspaceBoundary,
  ) {}

  private async workerContext(
    caller: CallerContext,
    taskId: string,
    attemptId: string,
    root?: string,
    delegated?: Pick<TaskStep, "delegatedPermissionSet">,
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
    const declared = (resourceId: string, action: string) =>
      !delegated ||
      delegated.delegatedPermissionSet.some(
        (permission) => permission.resourceId === resourceId && permission.action === action,
      );
    for (const action of ["worker:file:read", "worker:file:write"]) {
      if (!declared(policy.resourceId, action)) continue;
      const decision = await this.store.authorization.check({
        caller,
        resourceId: policy.resourceId,
        action,
        ...(delegated ? { delegatedTaskId: taskId } : {}),
      });
      if (decision.decision === "ALLOW") allowedActions.push(action);
    }
    if (!allowedActions.length) throw new Error("No delegated file authority");
    const writable = allowedActions.includes("worker:file:write");
    if (productWorkspaceId) {
      const workspaceAction = writable ? "workspace:write" : "workspace:read";
      if (!declared(`workspace:${productWorkspaceId}`, workspaceAction))
        throw new Error("Worker Step has no delegated workspace authority");
      await this.workspaceBoundary!.registry.resolveAuthorized(
        caller.principalId,
        productWorkspaceId,
        writable ? "write" : "read",
      );
      const decision = await this.store.authorization.check({
        caller,
        resourceId: `workspace:${productWorkspaceId}`,
        action: workspaceAction,
        ...(delegated ? { delegatedTaskId: taskId } : {}),
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

  async health(
    caller: CallerContext,
    observation: Pick<OpsHealthInput, "herdr" | "now" | "windowStart" | "staleAfterMs">,
    evidence?: RunEvidence,
  ): Promise<OpsHealthSnapshot> {
    return (await this.healthDetailed(caller, observation, evidence)).snapshot;
  }

  async healthDetailed(
    caller: CallerContext,
    observation: Pick<OpsHealthInput, "herdr" | "now" | "windowStart" | "staleAfterMs">,
    evidence?: RunEvidence,
  ): Promise<{ snapshot: OpsHealthSnapshot; visibleTaskIds: string[] }> {
    await this.authorize(caller, OPS_RESOURCE, "ops:status");
    const records = await this.store.tasks.getOpsHealthRecords(caller, evidence);
    const observations = observation.herdr.observations.length
      ? observation.herdr.observations
      : records.bindings.map((binding) => ({
          taskAttemptId: binding.taskAttemptId,
          state: binding.lastObservedAgentState,
          observedAt: binding.updatedAt,
        }));
    return {
      snapshot: buildOpsHealthSnapshot({
        ...records,
        ...observation,
        herdr: { ...observation.herdr, observations },
      }),
      visibleTaskIds: records.tasks.map((task) => task.id),
    };
  }

  async list(caller: CallerContext, evidence?: RunEvidence): Promise<AgentTask[]> {
    await this.authorize(caller, OPS_RESOURCE, "task:list");
    return this.store.tasks.listTasks({ caller, ...evidence });
  }

  async get(caller: CallerContext, taskId: string): Promise<AgentTask | null> {
    await this.authorize(caller, `task-${taskId}`, "task:read");
    return this.store.tasks.getTask(taskId);
  }

  async steps(caller: CallerContext, taskId: string): Promise<TaskStep[]> {
    await this.authorize(caller, `task-${taskId}`, "task:read");
    return this.store.longWork.listSteps(taskId);
  }

  async taskEvents(caller: CallerContext, taskId: string, afterSequence = 0) {
    await this.authorize(caller, `task-${taskId}`, "task:read");
    return this.store.longWork.listEvents(taskId, afterSequence);
  }

  /** Resolves only the configured Pi workspace authority for a planned Worker Step. */
  async plannedWorkerPermissions(
    caller: CallerContext,
    taskId: string,
    root: string,
    access: "read" | "write",
    evidence?: RunEvidence,
  ): Promise<TaskStep["delegatedPermissionSet"]> {
    await this.authorize(caller, `task-${taskId}`, "task:plan", {
      ...evidence,
      delegatedTaskId: taskId,
    });
    if (!this.workerPolicy || !this.workspaceBoundary || !isAbsolute(root))
      throw new Error("Configured Pi Worker workspace is unavailable");
    const canonicalRoot = await realpath(root);
    let workspaceId: string | undefined;
    for (const entry of await this.workspaceBoundary.registry.listForPrincipal(
      caller.principalId,
    )) {
      let candidate;
      try {
        candidate = await this.workspaceBoundary.registry.resolveAuthorized(
          caller.principalId,
          entry.id,
          "read",
        );
      } catch {
        continue;
      }
      if (candidate.canonicalPath === canonicalRoot) {
        workspaceId = entry.id;
        break;
      }
    }
    if (!workspaceId) throw new Error("Configured Worker directory is not a granted workspace");
    await this.workspaceBoundary.registry.resolveAuthorized(
      caller.principalId,
      workspaceId,
      access,
    );
    const required = [
      { resourceId: this.workerPolicy.resourceId, action: `worker:file:${access}` },
      { resourceId: `workspace:${workspaceId}`, action: `workspace:${access}` },
    ];
    for (const permission of required)
      await this.authorize(caller, permission.resourceId, permission.action, {
        ...evidence,
        delegatedTaskId: taskId,
      });
    if (access === "read") return required;
    const optionalRead = [
      { resourceId: this.workerPolicy.resourceId, action: "worker:file:read" },
      { resourceId: `workspace:${workspaceId}`, action: "workspace:read" },
    ];
    for (const permission of optionalRead) {
      const decision = await this.store.authorization.check({
        caller,
        resourceId: permission.resourceId,
        action: permission.action,
        delegatedTaskId: taskId,
        ...evidence,
      });
      if (decision.decision !== "ALLOW") return required;
    }
    return [...required, ...optionalRead];
  }

  async linkChildTask(
    caller: CallerContext,
    input: {
      parentTaskId: string;
      parentStepId: string;
      expectedStepVersion: number;
      childTaskId: string;
      acceptanceCriteria: readonly string[];
      cancellationPolicy: ChildTaskLink["cancellationPolicy"];
      failurePolicy: ChildTaskLink["failurePolicy"];
    },
    evidence?: RunEvidence,
  ): Promise<ChildTaskLink> {
    const continuation = await this.authorize(
      caller,
      `task-${input.parentTaskId}`,
      "task:continue",
      { ...evidence, delegatedTaskId: input.parentTaskId },
    );
    const delegation = await this.authorize(caller, `task-${input.parentTaskId}`, "task:delegate", {
      ...evidence,
      delegatedTaskId: input.parentTaskId,
    });
    const step = (await this.store.longWork.listSteps(input.parentTaskId)).find(
      (entry) => entry.id === input.parentStepId,
    );
    if (!step || step.kind !== "child_task" || step.version !== input.expectedStepVersion)
      throw new Error("Child Step version or kind conflict");
    const link = await this.store.longWork.createChildTaskLink({
      ...input,
      delegationDecisionId: delegation.id,
      delegatedPermissionSet: step.delegatedPermissionSet,
      origin: {
        kind: "decision",
        decisionId: continuation.id,
        actorPrincipalId: caller.principalId,
      },
    });
    await this.longWorkRuntime?.wake(input.parentTaskId).catch(() => undefined);
    return link;
  }

  async planExistingTask(
    caller: CallerContext,
    taskId: string,
    steps: readonly TaskStep[],
    rootStepId: string,
    evidence?: RunEvidence,
  ): Promise<void> {
    const decision = await this.authorize(caller, `task-${taskId}`, "task:plan", {
      ...evidence,
      delegatedTaskId: taskId,
    });
    for (const step of steps) {
      for (const permission of step.delegatedPermissionSet) {
        const delegated = await this.store.authorization.check({
          caller,
          resourceId: permission.resourceId,
          action: permission.action,
          delegatedTaskId: taskId,
          ...evidence,
        });
        if (delegated.decision !== "ALLOW") throw new AccessDeniedError(delegated);
      }
      if (step.kind !== "tool") continue;
      const spec = step.specRef ? parseTaskGetSpec(step.specRef) : null;
      if (!spec) throw new Error("Unsupported Tool Step spec");
      await this.authorize(caller, `task-${spec.targetTaskId}`, "task:read", {
        ...evidence,
        delegatedTaskId: taskId,
      });
    }
    if (!this.longWorkRuntime || this.longWorkRuntime.available?.() === false)
      throw new Error("Durable Task runtime is unavailable");
    await this.store.longWork.createGraph(taskId, steps, rootStepId, DEFAULT_TASK_GRAPH_LIMITS, {
      kind: "decision",
      decisionId: decision.id,
      actorPrincipalId: caller.principalId,
    });
    const task = await this.store.tasks.getTask(taskId);
    await this.longWorkRuntime.start(taskId, task?.policyRevision ?? 1);
  }

  async signal(
    caller: CallerContext,
    input: {
      taskId: string;
      stepId: string;
      targetStepVersion: number;
      targetAttemptId?: string;
      type: string;
      idempotencyKey: string;
      approval?: boolean;
    },
    evidence?: RunEvidence,
  ): Promise<TaskSignal> {
    const action = input.approval ? "task:approve" : "task:signal";
    const decision = await this.authorize(caller, `task-${input.taskId}`, action, evidence);
    const signal = await this.store.longWork.recordSignal({
      id: randomUUID(),
      taskId: input.taskId,
      stepId: input.stepId,
      targetStepVersion: input.targetStepVersion,
      targetAttemptId: input.targetAttemptId,
      type: input.type,
      source: "principal",
      actorPrincipalId: caller.principalId,
      authorizationDecisionId: decision.id,
      idempotencyKey: input.idempotencyKey,
      receivedAt: new Date().toISOString(),
    });
    if (signal.disposition === "applied")
      await this.longWorkRuntime?.wake(input.taskId).catch(() => undefined);
    return signal;
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
    if (!started) {
      if (context?.lease)
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
    if (!context?.lease) return;
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
    if (await this.store.longWork.getChildTaskLink(task.id))
      throw new Error("Linked child Task requires a durable graph before execution");
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

  /** Starts the already claimed durable Attempt. The configured target is server owned. */
  async dispatchClaimedWorker(
    caller: CallerContext,
    claim: ClaimedTaskStep,
    target: ConfiguredWorkerTarget,
  ): Promise<void> {
    if (
      claim.step.kind !== "herdr_worker" ||
      claim.step.status !== "running" ||
      claim.attempt.stepId !== claim.step.id ||
      claim.attempt.taskId !== claim.step.taskId ||
      claim.lease.attemptId !== claim.attempt.id ||
      claim.lease.stepId !== claim.step.id ||
      claim.lease.taskId !== claim.step.taskId ||
      claim.lease.state !== "active" ||
      claim.lease.workerBindingId ||
      !claim.step.instructions?.trim() ||
      (claim.step.specRef && !parseWorkerTextFileSpec(claim.step.specRef)) ||
      claim.step.requiredCapabilities.length > 0 ||
      target.agentKind !== "pi" ||
      !this.workerPolicy ||
      !this.workspaceBoundary
    )
      throw new ClaimedWorkerDispatchError("not_started");
    const taskId = claim.step.taskId;
    const attemptId = claim.attempt.id;
    if (await this.store.tasks.getWorkerBinding(attemptId))
      throw new ClaimedWorkerDispatchError("unknown");
    let context: WorkerContext | undefined;
    let started = false;
    let worker: StartedWorker | undefined;
    let dispatchSession: string | undefined;
    try {
      await this.authorize(caller, `task-${taskId}`, "task:continue", {
        delegatedTaskId: taskId,
      });
      const delegation = await this.authorize(caller, `task-${taskId}`, "task:delegate", {
        delegatedTaskId: taskId,
      });
      context = await this.workerContext(
        caller,
        taskId,
        attemptId,
        target.worktreePath,
        claim.step,
      );
      dispatchSession = (await this.bridge.getSnapshot()).sessionId;
      const agentName =
        context?.lease?.sandboxSessionId ??
        `glassbox-${createHash("sha256").update(attemptId).digest("hex").slice(0, 24)}`;
      started = true;
      worker = await this.bridge.startAgent({
        workspaceId: target.workspaceId,
        agentKind: target.agentKind,
        worktreePath: target.worktreePath,
        workerContextFile: context?.file,
        agentName,
      });
      const snapshot = await this.bridge.getSnapshot();
      if (snapshot.sessionId !== dispatchSession)
        throw new Error("Herdr session changed during Worker launch");
      const workspace = snapshot.workspaces.find((entry) =>
        entry.panes.some((pane) => pane.paneId === worker!.paneId),
      );
      const pane = workspace?.panes.find((entry) => entry.paneId === worker!.paneId);
      if (
        workspace?.workspaceId !== target.workspaceId ||
        pane?.agentName !== agentName ||
        pane.agentKind !== target.agentKind ||
        !pane.cwd ||
        (await realpath(pane.cwd)) !== (await realpath(target.worktreePath))
      )
        throw new Error("Herdr Worker identity or directory differs from the claimed target");
      const binding = await this.store.tasks.bindWorker({
        taskAttemptId: attemptId,
        herdrSession: dispatchSession,
        workspaceId: target.workspaceId,
        paneId: worker.paneId,
        agentName,
        agentKind: target.agentKind,
        runtimeEvidence: worker.runtimeEvidence,
        worktreePath: target.worktreePath,
        lastObservedAgentState: "starting",
      });
      await this.store.longWork.attachClaimedWorkerBinding({
        taskId,
        stepId: claim.step.id,
        attemptId,
        leaseId: claim.lease.id,
        workerBindingId: binding.id,
        ownerInstanceId: claim.lease.ownerInstanceId,
        expectedStepVersion: claim.step.version,
        expectedLeaseVersion: claim.lease.version,
        origin: {
          kind: "decision",
          decisionId: delegation.id,
          actorPrincipalId: caller.principalId,
        },
      });
      await this.bridge.promptAgent({
        paneId: worker.paneId,
        agentName,
        prompt: claim.step.specRef
          ? `${claim.step.instructions}\n\nWrite the final UTF-8 text result to ${parseWorkerTextFileSpec(claim.step.specRef)!.relativePath} using the authorized Worker file tool before finishing.`
          : claim.step.instructions,
      });
      if (!(await this.store.tasks.markWorkerPromptDispatched(attemptId, binding.id)))
        throw new Error("Worker prompt acknowledgement conflict");
    } catch (error) {
      try {
        await this.failedDispatch(attemptId, context, started, worker, dispatchSession);
      } catch {
        // Failure to verify closure leaves the external effect uncertain.
      }
      throw new ClaimedWorkerDispatchError(
        started ? "unknown" : "not_started",
        error instanceof AccessDeniedError ? error.decision.id : undefined,
      );
    }
  }

  /** Releases workspace write occupancy only after Herdr confirms the pane is closed. */
  async closeClaimedWorker(
    attemptId: string,
    worker: { paneId: string; agentName: string; herdrSession: string },
  ): Promise<void> {
    try {
      if (this.workspaceBoundary) await this.closeWorker(attemptId, worker);
      else await this.bridge.closeAgent(worker);
    } catch (error) {
      const current = this.workerLease(attemptId);
      if (current?.state === "active") {
        this.workspaceBoundary!.writes.quarantine(current.lease);
        await this.recordWorkerLease(attemptId, current.lease, "quarantined");
      }
      throw error;
    }
  }

  /** A lost dispatch cannot release a possible workspace writer without close evidence. */
  async quarantineClaimedWorker(attemptId: string): Promise<void> {
    const current = this.workerLease(attemptId);
    if (current?.state === "active") {
      this.workspaceBoundary!.writes.quarantine(current.lease);
      await this.recordWorkerLease(attemptId, current.lease, "quarantined");
    }
  }

  private async closeReviewedWorker(taskId: string, stepId: string): Promise<void> {
    const step = (await this.store.longWork.listSteps(taskId)).find((item) => item.id === stepId);
    if (step?.kind !== "herdr_worker" || step.status !== "review") return;
    const attempt = (await this.store.tasks.listAttempts(taskId))
      .filter((item) => item.stepId === stepId)
      .at(-1);
    if (!this.workspaceBoundary && !attempt) return;
    if (!attempt || attempt.status !== "review")
      throw new Error("Reviewed Worker Attempt is missing");
    const binding = await this.store.tasks.getWorkerBinding(attempt.id);
    if (!this.workspaceBoundary && !binding) return;
    if (!binding?.agentName) throw new Error("Reviewed Worker binding is unavailable");
    await this.closeClaimedWorker(attempt.id, {
      paneId: binding.paneId,
      agentName: binding.agentName,
      herdrSession: binding.herdrSession,
    });
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

  /** Snapshots a declared text file while the exact Worker claim still owns the Step. */
  async captureClaimedWorkerTextFile(
    caller: CallerContext,
    claim: DurableWorkerClaim,
    relativePath: string,
  ): Promise<{ relativePath: string; contentText: string; sha256: string }> {
    if (!this.workerPolicy || !this.workspaceBoundary) throw new WorkerArtifactCaptureError();
    const step = (await this.store.longWork.listSteps(claim.taskId)).find(
      (item) => item.id === claim.stepId,
    );
    const spec = step?.specRef ? parseWorkerTextFileSpec(step.specRef) : null;
    if (step?.kind !== "herdr_worker" || spec?.relativePath !== relativePath)
      throw new WorkerArtifactCaptureError();
    const binding = await this.store.tasks.getWorkerBinding(claim.attemptId);
    if (!binding?.worktreePath || binding.id !== claim.bindingId)
      throw new WorkerArtifactCaptureError();
    const root = await realpath(binding.worktreePath).catch(() => {
      throw new WorkerArtifactCaptureError();
    });
    const fileRead = step.delegatedPermissionSet.some(
      (permission) =>
        permission.resourceId === this.workerPolicy!.resourceId &&
        permission.action === "worker:file:read",
    );
    const workspaceResources = step.delegatedPermissionSet.filter(
      (permission) =>
        permission.action === "workspace:read" && permission.resourceId.startsWith("workspace:"),
    );
    if (!fileRead || workspaceResources.length !== 1) throw new WorkerArtifactCaptureError();
    const workspaceResource = workspaceResources[0]!.resourceId;
    const workspaceId = workspaceResource.slice("workspace:".length);
    const verify = async () => {
      const lease = await this.store.longWork.getActiveLease(claim.taskId, claim.stepId);
      if (
        !lease ||
        lease.id !== claim.leaseId ||
        lease.attemptId !== claim.attemptId ||
        lease.workerBindingId !== claim.bindingId ||
        lease.ownerInstanceId !== claim.ownerInstanceId ||
        lease.version !== claim.expectedLeaseVersion ||
        Date.parse(lease.expiresAt) <= Date.now()
      )
        throw new WorkerArtifactCaptureError();
      const currentStep = (await this.store.longWork.listSteps(claim.taskId)).find(
        (item) => item.id === claim.stepId,
      );
      if (currentStep?.status !== "running" || currentStep.version !== claim.expectedStepVersion)
        throw new WorkerArtifactCaptureError();
      const currentBinding = await this.store.tasks.getWorkerBinding(claim.attemptId);
      if (
        currentBinding?.id !== claim.bindingId ||
        !currentBinding.worktreePath ||
        (await realpath(currentBinding.worktreePath)) !== root
      )
        throw new WorkerArtifactCaptureError();
      const workspace = await this.workspaceBoundary!.registry.resolveAuthorized(
        caller.principalId,
        workspaceId,
        "read",
      );
      if (workspace.canonicalPath !== root) throw new WorkerArtifactCaptureError();
      const evidence = { delegatedTaskId: claim.taskId };
      for (const [resourceId, action] of [
        [`task-${claim.taskId}`, "task:continue"],
        [`task-${claim.taskId}`, "task:read"],
        [`task-${claim.taskId}`, "worker:read"],
        [this.workerPolicy!.resourceId, "worker:file:read"],
        [workspaceResource, "workspace:read"],
      ])
        await this.authorize(caller, resourceId, action, evidence);
    };
    try {
      await verify();
      const files = await WorkerFiles.open(root, { beforeOpen: verify });
      const bytes = await files.readBytes(relativePath);
      const contentText = bytes.toString("utf8");
      if (!Buffer.from(contentText, "utf8").equals(bytes)) throw new WorkerArtifactCaptureError();
      return {
        relativePath,
        contentText,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      };
    } catch {
      throw new WorkerArtifactCaptureError();
    }
  }

  /** Reads a captured durable Worker result only under current Task and source grants. */
  async workerCandidate(
    caller: CallerContext,
    taskId: string,
    stepId: string,
    attemptId: string,
    evidence?: RunEvidence,
  ) {
    // A consuming Run already carries its own Task binding. An external Run may
    // inspect another Task under current grants without becoming that Task's Run.
    const delegatedEvidence = evidence?.runId ? evidence : { ...evidence, delegatedTaskId: taskId };
    const decisions = [
      await this.authorize(caller, `task-${taskId}`, "task:read", delegatedEvidence),
      await this.authorize(caller, `task-${taskId}`, "worker:read", delegatedEvidence),
    ];
    const step = (await this.store.longWork.listSteps(taskId)).find((item) => item.id === stepId);
    if (step?.kind !== "herdr_worker") throw new Error("Durable Worker Step is unavailable");
    const candidate = await this.store.longWork.getWorkerCandidate(taskId, stepId, attemptId, {
      reviewableOnly: true,
    });
    if (!candidate) return null;
    const binding = await this.store.tasks.getWorkerBinding(attemptId);
    if (!binding || binding.id !== candidate.workerBindingId)
      throw new Error("Worker result binding is unavailable");
    for (const permission of step.delegatedPermissionSet) {
      let readAction: string;
      if (permission.action === "worker:file:read" || permission.action === "worker:file:write")
        readAction = "worker:file:read";
      else if (permission.action === "workspace:read" || permission.action === "workspace:write")
        readAction = "workspace:read";
      else throw new Error("Worker result has an unsupported content source");
      if (readAction === "workspace:read") {
        const workspaceId = permission.resourceId.startsWith("workspace:")
          ? permission.resourceId.slice("workspace:".length)
          : "";
        if (!workspaceId || !this.workspaceBoundary || !binding.worktreePath)
          throw new Error("Worker result workspace is unavailable");
        const workspace = await this.workspaceBoundary.registry.resolveAuthorized(
          caller.principalId,
          workspaceId,
          "read",
        );
        if (workspace.canonicalPath !== (await realpath(binding.worktreePath)))
          throw new Error("Worker result workspace differs from its binding");
      }
      decisions.push(
        await this.authorize(caller, permission.resourceId, readAction, delegatedEvidence),
      );
    }
    // The Worker instructions may have been planned from protected Run content.
    // A child Worker inherits the same obligation from every parent Task origin.
    const originSources = await this.store.db.transaction(async (tx) => {
      const rows = await tx.execute({
        sql: `WITH RECURSIVE lineage(task_id,depth) AS (
            SELECT ?,0
            UNION ALL
            SELECT links.parent_task_id,lineage.depth + 1
              FROM task_child_links links JOIN lineage ON links.child_task_id = lineage.task_id
              WHERE lineage.depth < 4
          )
          SELECT DISTINCT d.resource_id,d.action FROM lineage
            JOIN tasks task ON task.id = lineage.task_id
            JOIN authorization_decisions d ON d.run_id = task.run_id
          WHERE d.decision = 'ALLOW' AND d.delivery_source IS NOT NULL LIMIT 129`,
        args: [taskId],
      });
      if (rows.rows.length > 128)
        throw new Error("Worker result has too many protected origin sources");
      return rows.rows.map((row) => ({
        resourceId: stringColumn(row, "resource_id"),
        action: stringColumn(row, "action"),
      }));
    });
    for (const source of originSources)
      decisions.push(
        await this.authorize(caller, source.resourceId, source.action, delegatedEvidence),
      );
    if (evidence?.runId)
      for (const decision of decisions)
        await this.store.authorization.markDeliverySource(decision.id, "content_source");
    const artifact = await this.store.longWork.getWorkerFileArtifact(taskId, stepId, attemptId, {
      reviewableOnly: true,
    });
    if (step.specRef && !artifact) throw new Error("Declared Worker file artifact is unavailable");
    if (!artifact) return candidate;
    const excerpt = textExcerpt(artifact.contentText, 16 * 1024);
    return {
      ...candidate,
      fileArtifact: {
        relativePath: artifact.relativePath,
        sha256: artifact.contentSha256,
        contentExcerpt: excerpt.text,
        truncated: excerpt.truncated,
      },
    };
  }

  async promptWorker(caller: CallerContext, taskId: string, prompt: string): Promise<void> {
    const { binding } = await this.binding(caller, taskId, "worker:prompt");
    await this.bridge.promptAgent({ paneId: binding.paneId, agentName: binding.agentName, prompt });
  }

  async accept(caller: CallerContext, taskId: string): Promise<void> {
    const decision = await this.authorize(caller, `task-${taskId}`, "task:accept");
    const task = await this.store.tasks.getTask(taskId);
    if (task?.orchestrationMode === "durable") {
      await this.store.longWork.acceptDurableTask(taskId, {
        kind: "decision",
        decisionId: decision.id,
        actorPrincipalId: caller.principalId,
      });
    } else {
      if (this.workspaceBoundary) {
        if (task?.status !== "REVIEW") throw new Error("Task is not ready for acceptance");
        const binding = task.activeAttemptId
          ? await this.store.tasks.getWorkerBinding(task.activeAttemptId)
          : null;
        if (binding?.agentName)
          await this.closeWorker(task.activeAttemptId!, {
            paneId: binding.paneId,
            agentName: binding.agentName,
            herdrSession: binding.herdrSession,
          });
      }
      await this.store.tasks.acceptTask(taskId, caller.principalId);
    }
  }

  async acceptStep(
    caller: CallerContext,
    taskId: string,
    stepId: string,
    expectedStepVersion: number,
    evidence?: RunEvidence,
  ): Promise<TaskStep> {
    const decision = await this.authorize(caller, `task-${taskId}`, "task:accept", evidence);
    const task = await this.store.tasks.getTask(taskId);
    if (task?.orchestrationMode !== "durable")
      throw new Error("Step acceptance requires a durable Task");
    await this.closeReviewedWorker(taskId, stepId);
    const step = await this.store.longWork.acceptDurableStep({
      taskId,
      stepId,
      expectedStepVersion,
      origin: {
        kind: "decision",
        decisionId: decision.id,
        actorPrincipalId: caller.principalId,
      },
    });
    await this.longWorkRuntime?.wake(taskId).catch(() => undefined);
    return step;
  }

  async reworkStep(
    caller: CallerContext,
    taskId: string,
    stepId: string,
    expectedStepVersion: number,
    reason: string,
    evidence?: RunEvidence,
  ): Promise<TaskStep> {
    const decision = await this.authorize(caller, `task-${taskId}`, "task:rework", evidence);
    const task = await this.store.tasks.getTask(taskId);
    if (task?.orchestrationMode !== "durable")
      throw new Error("Step rework requires a durable Task");
    await this.closeReviewedWorker(taskId, stepId);
    const step = await this.store.longWork.reworkDurableStep({
      taskId,
      stepId,
      expectedStepVersion,
      reason,
      origin: {
        kind: "decision",
        decisionId: decision.id,
        actorPrincipalId: caller.principalId,
      },
    });
    await this.longWorkRuntime?.wake(taskId).catch(() => undefined);
    return step;
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
        lastObservedAgentState: "starting",
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

  async cancel(caller: CallerContext, taskId: string, reason?: string): Promise<boolean> {
    const decision = await this.authorize(caller, `task-${taskId}`, "task:cancel");
    const task = await this.store.tasks.getTask(taskId);
    if (task?.orchestrationMode === "durable") {
      const origin = {
        kind: "decision" as const,
        decisionId: decision.id,
        actorPrincipalId: caller.principalId,
      };
      const requested = await this.store.longWork.requestDurableCancellation(taskId, origin);
      if (requested.cancellationState === "settled") return true;
      const steps = await this.store.longWork.listSteps(taskId);
      if (steps.some((step) => step.status === "running")) {
        await this.longWorkRuntime?.wake(taskId).catch(() => undefined);
        return false;
      }
      try {
        await this.store.longWork.settleDurableCancellation(taskId, origin);
        await this.longWorkRuntime?.wake(taskId).catch(() => undefined);
        return true;
      } catch (error) {
        if (
          error instanceof Error &&
          error.message === "Task cancellation still has running Steps or active leases"
        )
          return false;
        throw error;
      }
    }
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
    return true;
  }
}
