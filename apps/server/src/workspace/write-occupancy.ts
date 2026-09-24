import { randomUUID } from "node:crypto";

export interface WriteOccupancyClaim {
  workspaceId: string;
  principalId: string;
  /** One Run or durable TaskAttempt. The server supplies this, never the model. */
  executionId: string;
  sandboxSessionId: string;
  policyVersion: string;
}

export interface WriteOccupancyLease extends WriteOccupancyClaim {
  leaseId: string;
}

type OccupancyState = "active" | "closing" | "quarantined";
interface Entry {
  lease: WriteOccupancyLease;
  state: OccupancyState;
}

export class WorkspaceWriteBusyError extends Error {
  constructor(
    public readonly workspaceId: string,
    public readonly state: OccupancyState,
  ) {
    super(`Workspace write occupancy ${state}`);
  }
}

/** One instance must be shared by every writable main-Agent and Worker execution in this server. */
export class WorkspaceWriteOccupancy {
  private readonly occupied = new Map<string, Entry>();

  acquire(claim: WriteOccupancyClaim): WriteOccupancyLease {
    for (const value of Object.values(claim)) {
      if (typeof value !== "string" || !value.trim())
        throw new Error("Invalid write occupancy claim");
    }
    const current = this.occupied.get(claim.workspaceId);
    if (current) {
      const old = current.lease;
      if (
        current.state === "active" &&
        old.principalId === claim.principalId &&
        old.executionId === claim.executionId &&
        old.sandboxSessionId === claim.sandboxSessionId &&
        old.policyVersion === claim.policyVersion
      )
        return { ...old };
      throw new WorkspaceWriteBusyError(claim.workspaceId, current.state);
    }
    const lease = { ...claim, leaseId: randomUUID() };
    this.occupied.set(claim.workspaceId, { lease, state: "active" });
    return { ...lease };
  }

  status(workspaceId: string): OccupancyState | "free" {
    return this.occupied.get(workspaceId)?.state ?? "free";
  }

  private get(lease: WriteOccupancyLease): Entry {
    const current = this.occupied.get(lease.workspaceId);
    if (!current || current.lease.leaseId !== lease.leaseId)
      throw new Error("Unknown workspace write lease");
    return current;
  }

  /** Stop the entire sandbox session and its child process tree before freeing the workspace. */
  async closeAndRelease(
    lease: WriteOccupancyLease,
    closeSandbox: () => Promise<void>,
  ): Promise<void> {
    const current = this.get(lease);
    if (current.state !== "active")
      throw new WorkspaceWriteBusyError(lease.workspaceId, current.state);
    current.state = "closing";
    try {
      await closeSandbox();
      this.occupied.delete(lease.workspaceId);
    } catch (error) {
      current.state = "quarantined";
      throw error;
    }
  }

  /** A crashed or unconfirmed sandbox keeps the workspace unavailable for new writers. */
  quarantine(lease: WriteOccupancyLease): void {
    this.get(lease).state = "quarantined";
  }

  /** Recovery requires a trusted, positive proof that the old sandbox can no longer write. */
  async releaseQuarantined(
    lease: WriteOccupancyLease,
    verifyIsolation: () => Promise<boolean>,
  ): Promise<void> {
    const current = this.get(lease);
    if (current.state !== "quarantined") throw new Error("Write lease is not quarantined");
    if (!(await verifyIsolation())) throw new Error("Old sandbox is not isolated");
    this.occupied.delete(lease.workspaceId);
  }
}
