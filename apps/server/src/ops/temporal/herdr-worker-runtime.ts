import type { TaskStep } from "@glassbox/contracts";
import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import type { DomainStore } from "../../application/domain-store.js";
import { AccessDeniedError } from "../../auth/service.js";
import type { CallerContext } from "../../identity/scope.js";
import { DurableWorkerObserver } from "../durable-worker-observer.js";
import type { HerdrBridge } from "../herdr-bridge.js";
import { authorizeLongWorkAction, getLongWorkCaller } from "../long-work-authority.js";
import type { ClaimedTaskStep, StoredStepLease } from "../long-work-store.js";
import { AuthorizedOpsService, type ConfiguredWorkerTarget } from "../service.js";
import { parseWorkerTextFileSpec } from "../worker-file-spec.js";

const ORIGIN = { kind: "system", reason: "Temporal Herdr Worker reconciliation" } as const;
const WORKER_LEASE_MS = 60_000;

/** The Temporal process observes live Herdr state; Glassbox remains the Step authority. */
export class HerdrWorkerRuntime {
  readonly ownerInstanceId = `temporal-worker-${randomUUID()}`;
  private readonly observer: DurableWorkerObserver;

  constructor(
    private readonly store: DomainStore,
    private readonly service: AuthorizedOpsService,
    private readonly bridge: HerdrBridge,
    private readonly target: ConfiguredWorkerTarget,
  ) {
    this.observer = new DurableWorkerObserver(
      store.db,
      store.longWork,
      store.tasks,
      true,
      async (claim, state) => {
        const step = (await this.store.longWork.listSteps(claim.taskId)).find(
          (item) => item.id === claim.stepId,
        );
        const fileSpec = step?.specRef ? parseWorkerTextFileSpec(step.specRef) : null;
        const existing = await this.store.longWork.getWorkerCandidate(
          claim.taskId,
          claim.stepId,
          claim.attemptId,
        );
        if (existing) {
          const savedArtifact = await this.store.longWork.getWorkerFileArtifact(
            claim.taskId,
            claim.stepId,
            claim.attemptId,
          );
          if (
            existing.workerBindingId !== claim.bindingId ||
            (fileSpec &&
              (!savedArtifact ||
                savedArtifact.workerBindingId !== claim.bindingId ||
                savedArtifact.relativePath !== fileSpec.relativePath)) ||
            (!fileSpec && savedArtifact)
          )
            throw new Error("Persisted Worker candidate does not match its claim");
          // The first capture is immutable. Revalidate the live claim in the store,
          // then settle from saved evidence without rereading a changed workspace.
          return this.store.longWork.recordWorkerCandidate({
            taskId: claim.taskId,
            stepId: claim.stepId,
            attemptId: claim.attemptId,
            leaseId: claim.leaseId,
            ownerInstanceId: claim.ownerInstanceId,
            workerBindingId: claim.bindingId,
            expectedStepVersion: claim.expectedStepVersion,
            expectedLeaseVersion: claim.expectedLeaseVersion,
            output: existing.outputExcerpt,
            ...(savedArtifact
              ? {
                  artifact: {
                    relativePath: savedArtifact.relativePath,
                    contentText: savedArtifact.contentText,
                    sha256: savedArtifact.contentSha256,
                  },
                }
              : {}),
          });
        }
        const read = await this.bridge.readAgent({
          paneId: claim.paneId,
          agentName: claim.agentName,
        });
        if (read.state !== state)
          throw new Error("Worker state changed before candidate output capture");
        const artifact = fileSpec
          ? await this.service.captureClaimedWorkerTextFile(
              await getLongWorkCaller(this.store, claim.taskId),
              claim,
              fileSpec.relativePath,
            )
          : undefined;
        return this.store.longWork.recordWorkerCandidate({
          taskId: claim.taskId,
          stepId: claim.stepId,
          attemptId: claim.attemptId,
          leaseId: claim.leaseId,
          ownerInstanceId: claim.ownerInstanceId,
          workerBindingId: claim.bindingId,
          expectedStepVersion: claim.expectedStepVersion,
          expectedLeaseVersion: claim.expectedLeaseVersion,
          output: read.output,
          ...(artifact ? { artifact } : {}),
        });
      },
    );
  }

  dispatch(caller: CallerContext, claim: ClaimedTaskStep): Promise<void> {
    return this.service.dispatchClaimedWorker(caller, claim, this.target);
  }

  async cancel(taskId: string, step: TaskStep): Promise<"settled" | "pending"> {
    const lease = await this.store.longWork.getActiveLease(taskId, step.id);
    if (!lease?.attemptId || !lease.workerBindingId) return "pending";
    const binding = await this.store.tasks.getWorkerBinding(lease.attemptId);
    if (!binding?.agentName || binding.id !== lease.workerBindingId) return "pending";
    try {
      await this.service.closeClaimedWorker(lease.attemptId, {
        paneId: binding.paneId,
        agentName: binding.agentName,
        herdrSession: binding.herdrSession,
      });
    } catch {
      return "pending";
    }
    try {
      await this.store.longWork.settleClaimedWorkerCancellation({
        taskId,
        stepId: step.id,
        attemptId: lease.attemptId,
        leaseId: lease.id,
        workerBindingId: binding.id,
        ownerInstanceId: lease.ownerInstanceId,
        expectedStepVersion: step.version,
        expectedLeaseVersion: lease.version,
        closureEvidenceRef: `herdr-closed:${binding.id}`,
        origin: ORIGIN,
      });
    } catch (error) {
      if (
        error instanceof Error &&
        /(?:settlement conflict|ownership conflict|Step conflict)/iu.test(error.message)
      )
        return "pending";
      throw error;
    }
    return "settled";
  }

  /** Close the exact old Worker before releasing a quarantined Step claim. */
  async reconcileQuarantined(taskId: string, step: TaskStep): Promise<"settled" | "pending"> {
    if (step.kind !== "herdr_worker" || !["blocked", "cancelled"].includes(step.status))
      return "pending";
    const lease = await this.store.longWork.getQuarantinedLease(taskId, step.id);
    if (!lease?.attemptId || !lease.workerBindingId) return "pending";
    const binding = await this.store.tasks.getWorkerBinding(lease.attemptId);
    if (
      !binding ||
      binding.id !== lease.workerBindingId ||
      !binding.agentName ||
      !binding.worktreePath
    )
      return "pending";
    try {
      const snapshot = await this.bridge.getSnapshot();
      if (snapshot.sessionId !== binding.herdrSession) return "pending";
      const snapshotTime = Date.parse(snapshot.timestamp);
      if (
        !Number.isFinite(snapshotTime) ||
        snapshotTime < Date.parse(binding.updatedAt) ||
        snapshotTime < Date.parse(lease.acquiredAt)
      )
        return "pending";
      const pane = snapshot.workspaces
        .flatMap((workspace) =>
          workspace.panes.map((item) => ({ ...item, workspaceId: workspace.workspaceId })),
        )
        .find((item) => item.paneId === binding.paneId);
      if (pane) {
        if (
          pane.workspaceId !== binding.workspaceId ||
          pane.agentName !== binding.agentName ||
          pane.agentKind !== binding.agentKind ||
          !pane.cwd ||
          (await realpath(pane.cwd)) !== (await realpath(binding.worktreePath))
        )
          return "pending";
      }
      await this.service.closeClaimedWorker(lease.attemptId, {
        paneId: binding.paneId,
        agentName: binding.agentName,
        herdrSession: binding.herdrSession,
      });
    } catch {
      return "pending";
    }
    try {
      await this.store.longWork.settleQuarantinedWorkerStepClosure({
        taskId,
        stepId: step.id,
        attemptId: lease.attemptId,
        leaseId: lease.id,
        ownerInstanceId: lease.ownerInstanceId,
        expectedStepVersion: step.version,
        expectedLeaseVersion: lease.version,
        closure: {
          workerBindingId: binding.id,
          herdrSession: binding.herdrSession,
          workspaceId: binding.workspaceId,
          paneId: binding.paneId,
          evidenceRef: `herdr-closed:${binding.id}`,
        },
        origin: ORIGIN,
      });
    } catch (error) {
      if (
        error instanceof Error &&
        /(?:settlement conflict|ownership conflict|Step conflict|version conflict)/iu.test(
          error.message,
        )
      )
        return "pending";
      throw error;
    }
    return "settled";
  }

  private async settleUnknown(
    taskId: string,
    step: TaskStep,
    lease: StoredStepLease,
    reason: string,
  ): Promise<void> {
    if (!lease.attemptId) return;
    try {
      await this.store.longWork.settleClaimedStep({
        taskId,
        stepId: step.id,
        attemptId: lease.attemptId,
        leaseId: lease.id,
        ownerInstanceId: lease.ownerInstanceId,
        expectedStepVersion: step.version,
        expectedLeaseVersion: lease.version,
        ...(lease.workerBindingId ? { workerBindingId: lease.workerBindingId } : {}),
        outcome: "unknown",
        evidenceRef: `${reason}:${lease.attemptId}`,
        origin: ORIGIN,
      });
    } catch (error) {
      if (
        error instanceof Error &&
        /(?:settlement conflict|ownership conflict|status conflict)/iu.test(error.message)
      )
        return;
      throw error;
    }
  }

  async observe(taskId: string, step: TaskStep): Promise<"settled" | "pending"> {
    let lease = await this.store.longWork.getActiveLease(taskId, step.id);
    if (!lease?.attemptId) return "pending";
    if (lease.ownerInstanceId !== this.ownerInstanceId && Date.parse(lease.expiresAt) > Date.now())
      return "pending";
    const binding = await this.store.tasks.getWorkerBinding(lease.attemptId);
    if (!binding || !lease.workerBindingId || !binding.promptDispatchedAt) {
      if (Date.parse(lease.expiresAt) > Date.now()) return "pending";
      if (binding?.agentName) {
        try {
          await this.service.closeClaimedWorker(lease.attemptId, {
            paneId: binding.paneId,
            agentName: binding.agentName,
            herdrSession: binding.herdrSession,
          });
        } catch {
          await this.service.quarantineClaimedWorker(lease.attemptId);
        }
      } else {
        await this.service.quarantineClaimedWorker(lease.attemptId);
      }
      await this.settleUnknown(taskId, step, lease, "worker-dispatch-unconfirmed");
      return "settled";
    }

    let snapshot;
    try {
      snapshot = await this.bridge.getSnapshot();
    } catch {
      if (Date.parse(lease.expiresAt) <= Date.now()) {
        await this.service.quarantineClaimedWorker(lease.attemptId);
        await this.settleUnknown(taskId, step, lease, "worker-session-unavailable");
        return "settled";
      }
      return "pending";
    }
    if (snapshot.sessionId !== binding.herdrSession) {
      await this.service.quarantineClaimedWorker(lease.attemptId);
      await this.settleUnknown(taskId, step, lease, "worker-session-changed");
      return "settled";
    }
    const snapshotTime = Date.parse(snapshot.timestamp);
    if (
      !Number.isFinite(snapshotTime) ||
      snapshotTime < Date.parse(lease.acquiredAt) ||
      snapshotTime < Date.parse(binding.updatedAt)
    ) {
      if (Date.parse(lease.expiresAt) <= Date.now()) {
        await this.service.quarantineClaimedWorker(lease.attemptId);
        await this.settleUnknown(taskId, step, lease, "worker-snapshot-stale");
        return "settled";
      }
      return "pending";
    }
    const workspace = snapshot.workspaces.find(
      (entry) => entry.workspaceId === binding.workspaceId,
    );
    const pane = workspace?.panes.find((entry) => entry.paneId === binding.paneId);
    let exactPane = false;
    if (
      pane &&
      pane.agentName === binding.agentName &&
      pane.agentKind === binding.agentKind &&
      pane.cwd &&
      binding.worktreePath
    ) {
      try {
        exactPane = (await realpath(pane.cwd)) === (await realpath(binding.worktreePath));
      } catch {
        // An unavailable directory is not proof that this Worker still owns it.
      }
    }
    if (!exactPane) {
      await this.service.quarantineClaimedWorker(lease.attemptId);
      await this.settleUnknown(taskId, step, lease, "worker-identity-or-directory-changed");
      return "settled";
    }
    let continuationDecisionId: string;
    const caller = await getLongWorkCaller(this.store, taskId);
    try {
      for (const [resourceId, action] of [
        [`task-${taskId}`, "task:continue"],
        [`task-${taskId}`, "task:delegate"],
        ...step.delegatedPermissionSet.map((permission) => [
          permission.resourceId,
          permission.action,
        ]),
      ]) {
        const decisionId = await authorizeLongWorkAction(this.store, {
          taskId,
          caller,
          resourceId: resourceId!,
          action: action!,
        });
        if (action === "task:continue" && resourceId === `task-${taskId}`)
          continuationDecisionId = decisionId;
      }
    } catch (error) {
      if (!(error instanceof AccessDeniedError)) throw error;
      try {
        await this.service.closeClaimedWorker(lease.attemptId, {
          paneId: binding.paneId,
          agentName: binding.agentName!,
          herdrSession: binding.herdrSession,
        });
      } catch {
        await this.service.quarantineClaimedWorker(lease.attemptId);
      }
      await this.settleUnknown(
        taskId,
        step,
        lease,
        `worker-authority-revoked:${error.decision.id}`,
      );
      return "settled";
    }
    if (Date.parse(lease.expiresAt) <= Date.now()) {
      if (snapshotTime < Date.parse(lease.expiresAt)) return "pending";
      try {
        lease = await this.store.longWork.recoverClaimedWorkerLease({
          taskId,
          stepId: step.id,
          attemptId: lease.attemptId,
          leaseId: lease.id,
          workerBindingId: binding.id,
          previousOwnerInstanceId: lease.ownerInstanceId,
          nextOwnerInstanceId: this.ownerInstanceId,
          expectedStepVersion: step.version,
          expectedLeaseVersion: lease.version,
          expiresAt: new Date(Date.now() + WORKER_LEASE_MS).toISOString(),
          evidenceRef: `snapshot:${snapshot.timestamp}:${binding.id}`,
          origin: {
            kind: "decision",
            decisionId: continuationDecisionId!,
            actorPrincipalId: caller.principalId,
          },
        });
      } catch (error) {
        if (error instanceof Error && error.message.includes("Worker recovery lease conflict"))
          return "pending";
        throw error;
      }
    }
    await this.observer.observeSnapshot(snapshot, this.ownerInstanceId);
    const current = (await this.store.longWork.listSteps(taskId)).find(
      (item) => item.id === step.id,
    );
    if (!current || current.status !== "running") return "settled";
    const currentLease = await this.store.longWork.getActiveLease(taskId, step.id);
    if (
      !currentLease?.attemptId ||
      !currentLease.workerBindingId ||
      currentLease.ownerInstanceId !== this.ownerInstanceId
    )
      return "pending";
    const currentBinding = await this.store.tasks.getWorkerBinding(currentLease.attemptId);
    if (!currentBinding || snapshotTime < Date.parse(currentBinding.updatedAt)) return "pending";
    if (Date.parse(currentLease.expiresAt) <= Date.now()) {
      await this.service.quarantineClaimedWorker(currentLease.attemptId);
      await this.settleUnknown(taskId, current, currentLease, "worker-lease-expired");
      return "settled";
    }
    try {
      await this.store.longWork.updateLease({
        taskId,
        leaseId: currentLease.id,
        ownerInstanceId: currentLease.ownerInstanceId,
        expectedVersion: currentLease.version,
        action: "heartbeat",
        expiresAt: new Date(Date.now() + WORKER_LEASE_MS).toISOString(),
        origin: ORIGIN,
      });
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes("Lease version conflict"))
        throw error;
    }
    return "pending";
  }
}
