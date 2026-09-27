import type { Row } from "@libsql/client";
import type { HerdrAgentLifecycleState } from "@glassbox/contracts";
import type { HerdrEvent, HerdrSessionSnapshot } from "./herdr-bridge.js";
import { DomainDatabase, optionalString, stringColumn } from "../persistence/database.js";
import { LongWorkStore } from "./long-work-store.js";
import type { TaskStore } from "./task-store.js";

interface DurableWorkerClaim {
  bindingId: string;
  taskId: string;
  stepId: string;
  attemptId: string;
  leaseId: string;
  ownerInstanceId: string;
  expectedStepVersion: number;
  expectedLeaseVersion: number;
  leaseAcquiredAt: string;
  bindingUpdatedAt: string;
  stepKind: string;
  agentKind: string;
  agentName?: string;
  herdrSession: string;
  workspaceId: string;
  paneId: string;
  lastObservedAgentState: string;
}

function parseClaim(row: Row): DurableWorkerClaim {
  return {
    bindingId: stringColumn(row, "binding_id"),
    taskId: stringColumn(row, "task_id"),
    stepId: stringColumn(row, "step_id"),
    attemptId: stringColumn(row, "attempt_id"),
    leaseId: stringColumn(row, "lease_id"),
    ownerInstanceId: stringColumn(row, "owner_instance_id"),
    expectedStepVersion: Number(row.step_version),
    expectedLeaseVersion: Number(row.lease_version),
    leaseAcquiredAt: stringColumn(row, "lease_acquired_at"),
    bindingUpdatedAt: stringColumn(row, "binding_updated_at"),
    stepKind: stringColumn(row, "step_kind"),
    agentKind: stringColumn(row, "agent_kind"),
    agentName: optionalString(row, "agent_name") ?? undefined,
    herdrSession: stringColumn(row, "herdr_session"),
    workspaceId: stringColumn(row, "workspace_id"),
    paneId: stringColumn(row, "pane_id"),
    lastObservedAgentState: stringColumn(row, "last_observed_agent_state"),
  };
}

const SYSTEM_ORIGIN = { kind: "system", reason: "Herdr durable worker observation" } as const;

/** Maps authoritative Herdr observations to the exact durable Step claim they describe. */
export class DurableWorkerObserver {
  constructor(
    private readonly db: DomainDatabase,
    private readonly longWork: LongWorkStore,
    _tasks: TaskStore,
  ) {}

  /** Attempt IDs owned by the durable path, including claims that are currently uncertain. */
  async durableAttemptIds(herdrSession: string): Promise<ReadonlySet<string>> {
    return this.db.transaction(async (tx) => {
      const result = await tx.execute({
        sql: `SELECT b.task_attempt_id FROM worker_bindings b
          JOIN task_attempts a ON a.id = b.task_attempt_id
          JOIN tasks t ON t.id = a.task_id
          WHERE b.herdr_session = ? AND t.orchestration_mode = 'durable'`,
        args: [herdrSession],
      });
      return new Set(result.rows.map((row) => stringColumn(row, "task_attempt_id")));
    });
  }

  /** A disconnect or event gap records stale state but says nothing about pane existence. */
  async markSessionStale(herdrSession: string): Promise<void> {
    const claims = await this.claimsForSession(herdrSession);
    const observedAt = new Date().toISOString();
    for (const claim of claims)
      await this.observeClaim(claim, "unknown", `stale:${claim.bindingId}`, observedAt);
  }

  async observeSnapshot(snapshot: HerdrSessionSnapshot): Promise<void> {
    const claims = await this.claimsForSession(snapshot.sessionId);
    for (const claim of claims) {
      if (
        !this.isCurrentObservation(
          snapshot.timestamp,
          claim.leaseAcquiredAt,
          claim.bindingUpdatedAt,
        )
      )
        continue;
      const paneMatches = snapshot.workspaces.flatMap((workspace) =>
        workspace.workspaceId === claim.workspaceId
          ? workspace.panes.filter((pane) => pane.paneId === claim.paneId)
          : [],
      );
      const pane = paneMatches.length === 1 ? paneMatches[0] : undefined;
      if (!pane || !this.hasExactIdentity(claim, pane)) {
        await this.settleUnknown(
          claim,
          pane ? "worker-identity-mismatch" : "worker-pane-missing",
          snapshot.timestamp,
        );
        continue;
      }
      await this.observeState(
        claim,
        pane.state,
        `snapshot:${snapshot.timestamp}`,
        snapshot.timestamp,
      );
    }
  }

  async observeEvent(event: HerdrEvent): Promise<void> {
    if (event.type !== "agent.state" || !event.state) return;
    const claim = (await this.claimsForSession(event.sessionId)).find(
      (entry) => entry.workspaceId === event.workspaceId && entry.paneId === event.paneId,
    );
    if (!claim) return;
    // Events can be delayed across pane reuse. A mismatched event is not evidence
    // that the current worker disappeared; only a complete snapshot can establish that.
    if (!this.hasExactIdentity(claim, event)) return;
    if (!this.isCurrentObservation(event.timestamp, claim.leaseAcquiredAt, claim.bindingUpdatedAt))
      return;
    await this.observeState(claim, event.state, `event:${event.timestamp}`, event.timestamp);
  }

  private isCurrentObservation(
    observedAt: string,
    leaseAcquiredAt: string,
    bindingUpdatedAt: string,
  ): boolean {
    const observedTime = Date.parse(observedAt);
    const acquiredTime = Date.parse(leaseAcquiredAt);
    const priorObservationTime = Date.parse(bindingUpdatedAt);
    return (
      Number.isFinite(observedTime) &&
      Number.isFinite(acquiredTime) &&
      Number.isFinite(priorObservationTime) &&
      observedTime >= acquiredTime &&
      observedTime >= priorObservationTime
    );
  }

  private hasExactIdentity(claim: DurableWorkerClaim, observed: { agentName?: string }): boolean {
    return Boolean(claim.agentName && observed.agentName === claim.agentName);
  }

  private async observeState(
    claim: DurableWorkerClaim,
    state: HerdrAgentLifecycleState,
    evidencePrefix: string,
    observedAt: string,
  ): Promise<void> {
    const completed =
      state === "done" ||
      (state === "idle" && claim.agentKind === "pi" && claim.lastObservedAgentState === "working");
    if (claim.lastObservedAgentState === state) {
      if (completed)
        await this.settle(
          claim,
          "review",
          `${evidencePrefix}:${claim.bindingId}:${state}`,
          state,
          observedAt,
        );
      return;
    }
    if (completed) {
      await this.settle(
        claim,
        "review",
        `${evidencePrefix}:${claim.bindingId}:${state}`,
        state,
        observedAt,
      );
      return;
    }
    await this.observeClaim(
      claim,
      state,
      `${evidencePrefix}:${claim.bindingId}:${state}`,
      observedAt,
    );
  }

  private async settleUnknown(
    claim: DurableWorkerClaim,
    reason: string,
    observedAt: string,
  ): Promise<void> {
    await this.settle(claim, "unknown", `${reason}:${claim.bindingId}`, "unknown", observedAt);
  }

  private async observeClaim(
    claim: DurableWorkerClaim,
    state: HerdrAgentLifecycleState,
    evidenceRef: string,
    observedAt: string,
  ): Promise<void> {
    try {
      await this.longWork.observeClaimedWorkerState({
        taskId: claim.taskId,
        stepId: claim.stepId,
        attemptId: claim.attemptId,
        leaseId: claim.leaseId,
        workerBindingId: claim.bindingId,
        ownerInstanceId: claim.ownerInstanceId,
        expectedStepVersion: claim.expectedStepVersion,
        expectedLeaseVersion: claim.expectedLeaseVersion,
        state,
        observedAt,
        evidenceRef,
        origin: SYSTEM_ORIGIN,
      });
    } catch (error) {
      if (
        error instanceof Error &&
        /(?:observation conflict|ownership conflict|status conflict)/iu.test(error.message)
      )
        return;
      throw error;
    }
  }

  private async settle(
    claim: DurableWorkerClaim,
    outcome: "review" | "unknown",
    evidenceRef: string,
    observedAgentState?: "done" | "idle" | "unknown",
    observedAt?: string,
  ): Promise<void> {
    try {
      await this.longWork.settleClaimedStep({
        taskId: claim.taskId,
        stepId: claim.stepId,
        attemptId: claim.attemptId,
        leaseId: claim.leaseId,
        ownerInstanceId: claim.ownerInstanceId,
        expectedStepVersion: claim.expectedStepVersion,
        expectedLeaseVersion: claim.expectedLeaseVersion,
        workerBindingId: claim.bindingId,
        observedAgentState,
        observedAt,
        outcome,
        evidenceRef,
        origin: SYSTEM_ORIGIN,
      });
    } catch (error) {
      // A competing settlement, rework, or lease replacement makes this observation stale.
      // settleClaimedStep uses Step, Attempt, lease, owner, and version CAS checks.
      if (
        error instanceof Error &&
        /(?:settlement conflict|ownership conflict)/iu.test(error.message)
      )
        return;
      throw error;
    }
  }

  private async claimsForSession(herdrSession: string): Promise<DurableWorkerClaim[]> {
    return this.db.transaction(async (tx) => {
      const result = await tx.execute({
        sql: `SELECT b.id AS binding_id, b.task_attempt_id AS attempt_id, b.herdr_session,
            b.workspace_id, b.pane_id, b.agent_name, b.agent_kind,
            b.last_observed_agent_state, b.updated_at AS binding_updated_at,
            a.task_id, a.step_id, s.kind AS step_kind,
            s.version AS step_version, l.id AS lease_id, l.owner_instance_id,
            l.version AS lease_version, l.acquired_at AS lease_acquired_at
          FROM worker_bindings b
          JOIN task_attempts a ON a.id = b.task_attempt_id AND a.status = 'running'
          JOIN task_steps s ON s.id = a.step_id AND s.task_id = a.task_id AND s.status = 'running'
          JOIN task_step_leases l ON l.worker_binding_id = b.id AND l.attempt_id = a.id
            AND l.step_id = s.id AND l.task_id = a.task_id AND l.state = 'active'
          JOIN tasks t ON t.id = a.task_id AND t.orchestration_mode = 'durable'
          WHERE b.herdr_session = ? AND t.status NOT IN ('DONE','CANCELED','FAILED','ACCEPTED')`,
        args: [herdrSession],
      });
      return result.rows.map(parseClaim);
    });
  }
}
