import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { lockSync } from "proper-lockfile";

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
  instanceId: string;
}
interface Ledger {
  version: 1;
  entries: Record<string, Entry>;
}

export class WorkspaceWriteBusyError extends Error {
  constructor(
    public readonly workspaceId: string,
    public readonly state: OccupancyState,
  ) {
    super(`Workspace write occupancy ${state}`);
  }
}

function validate(value: unknown): Ledger {
  if (!value || typeof value !== "object") throw new Error("Invalid write occupancy record");
  const state = value as Partial<Ledger>;
  if (
    state.version !== 1 ||
    !state.entries ||
    typeof state.entries !== "object" ||
    Array.isArray(state.entries)
  )
    throw new Error("Unsupported write occupancy record");
  for (const [workspaceId, entry] of Object.entries(state.entries)) {
    if (
      !entry ||
      !["active", "closing", "quarantined"].includes(entry.state) ||
      !entry.lease ||
      entry.lease.workspaceId !== workspaceId ||
      typeof entry.instanceId !== "string" ||
      !entry.instanceId ||
      Object.values(entry.lease).some((part) => typeof part !== "string" || !part.trim())
    )
      throw new Error("Invalid write occupancy entry");
  }
  return state as Ledger;
}

/** Share one host-side ledger across all main-Agent and Worker writers. */
export class WorkspaceWriteOccupancy {
  private readonly file: string;
  private readonly anchor: string;
  private readonly instanceId = randomUUID();

  constructor(
    readonly dataRoot: string,
    options: { recoverOnOpen?: boolean } = {},
  ) {
    if (!path.isAbsolute(dataRoot) || /^(?:\\\\|\/\/)/u.test(dataRoot))
      throw new Error("An absolute local data root is required");
    mkdirSync(dataRoot, { recursive: true, mode: 0o700 });
    const root = realpathSync.native(dataRoot);
    this.file = path.join(root, "workspace-write-occupancy.json");
    this.anchor = path.join(root, ".workspace-write-occupancy-lock");
    closeSync(openSync(this.anchor, "a", 0o600));
    // An earlier server may have crashed while its sandbox kept running.
    if (options.recoverOnOpen !== false)
      this.change((state) => {
        for (const entry of Object.values(state.entries)) {
          if (entry.state !== "quarantined") entry.state = "quarantined";
        }
      });
  }

  private read(): Ledger {
    if (!existsSync(this.file)) return { version: 1, entries: {} };
    return validate(JSON.parse(readFileSync(this.file, "utf8")) as unknown);
  }

  private save(state: Ledger): void {
    const temp = path.join(path.dirname(this.file), `.workspace-write-${randomUUID()}.tmp`);
    try {
      writeFileSync(temp, JSON.stringify(state), { flag: "wx", mode: 0o600 });
      const descriptor = openSync(temp, "r+");
      try {
        fsyncSync(descriptor);
      } finally {
        closeSync(descriptor);
      }
      renameSync(temp, this.file);
    } finally {
      if (existsSync(temp)) unlinkSync(temp);
    }
  }

  private change<T>(operation: (state: Ledger) => T): T {
    const release = lockSync(this.anchor);
    try {
      const state = this.read();
      const result = operation(state);
      this.save(state);
      return result;
    } finally {
      release();
    }
  }

  private get(state: Ledger, lease: WriteOccupancyLease): Entry {
    const entry = Object.hasOwn(state.entries, lease.workspaceId)
      ? state.entries[lease.workspaceId]
      : undefined;
    if (!entry || entry.lease.leaseId !== lease.leaseId)
      throw new Error("Unknown workspace write lease");
    return entry;
  }

  acquire(claim: WriteOccupancyClaim): WriteOccupancyLease {
    for (const value of Object.values(claim)) {
      if (typeof value !== "string" || !value.trim())
        throw new Error("Invalid write occupancy claim");
    }
    return this.change((state) => {
      const current = Object.hasOwn(state.entries, claim.workspaceId)
        ? state.entries[claim.workspaceId]
        : undefined;
      if (current) {
        const old = current.lease;
        if (
          current.state === "active" &&
          current.instanceId === this.instanceId &&
          old.principalId === claim.principalId &&
          old.executionId === claim.executionId &&
          old.sandboxSessionId === claim.sandboxSessionId &&
          old.policyVersion === claim.policyVersion
        )
          return { ...old };
        throw new WorkspaceWriteBusyError(claim.workspaceId, current.state);
      }
      const lease = { ...claim, leaseId: randomUUID() };
      Object.defineProperty(state.entries, claim.workspaceId, {
        value: { lease, state: "active", instanceId: this.instanceId },
        writable: true,
        enumerable: true,
        configurable: true,
      });
      return { ...lease };
    });
  }

  status(workspaceId: string): OccupancyState | "free" {
    const state = this.read();
    return Object.hasOwn(state.entries, workspaceId) ? state.entries[workspaceId]!.state : "free";
  }

  /** A Worker Tool may write only while its original attempt owns an active lease. */
  assertActive(lease: WriteOccupancyLease): void {
    const entry = this.get(this.read(), lease);
    if (entry.state !== "active") throw new WorkspaceWriteBusyError(lease.workspaceId, entry.state);
  }

  /** The supervisor can use these identifiers to prove old Docker or Herdr sessions stopped. */
  listUnresolved(): Array<{ lease: WriteOccupancyLease; state: OccupancyState }> {
    return Object.values(this.read().entries).map((entry) => ({
      lease: { ...entry.lease },
      state: entry.state,
    }));
  }

  /** Only successful closure of the entire sandbox session frees the workspace. */
  async closeAndRelease(
    lease: WriteOccupancyLease,
    closeSandbox: () => Promise<void>,
  ): Promise<void> {
    this.change((state) => {
      const entry = this.get(state, lease);
      if (entry.state !== "active" || entry.instanceId !== this.instanceId)
        throw new WorkspaceWriteBusyError(lease.workspaceId, entry.state);
      entry.state = "closing";
    });
    try {
      await closeSandbox();
      this.change((state) => {
        const entry = this.get(state, lease);
        if (entry.state !== "closing")
          throw new WorkspaceWriteBusyError(lease.workspaceId, entry.state);
        delete state.entries[lease.workspaceId];
      });
    } catch (error) {
      this.quarantine(lease);
      throw error;
    }
  }

  quarantine(lease: WriteOccupancyLease): void {
    this.change((state) => {
      const entry = this.get(state, lease);
      if (entry.instanceId !== this.instanceId)
        throw new WorkspaceWriteBusyError(lease.workspaceId, entry.state);
      entry.state = "quarantined";
    });
  }

  /** Call only with a trusted positive stop check; failure leaves the lease quarantined. */
  async releaseQuarantined(
    lease: WriteOccupancyLease,
    verifyIsolation: (lease: WriteOccupancyLease) => Promise<boolean>,
  ): Promise<void> {
    if (this.get(this.read(), lease).state !== "quarantined")
      throw new Error("Write lease is not quarantined");
    if (!(await verifyIsolation({ ...lease }))) throw new Error("Old sandbox is not isolated");
    this.change((state) => {
      if (this.get(state, lease).state !== "quarantined")
        throw new Error("Write lease changed during recovery");
      delete state.entries[lease.workspaceId];
    });
  }
}
