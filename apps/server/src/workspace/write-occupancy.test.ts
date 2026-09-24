import { describe, expect, it } from "vitest";
import { WorkspaceWriteBusyError, WorkspaceWriteOccupancy } from "./write-occupancy.js";

const first = {
  workspaceId: "shared",
  principalId: "owner-a",
  executionId: "attempt-1",
  sandboxSessionId: "sandbox-a",
  policyVersion: "policy-1",
};

describe("WorkspaceWriteOccupancy", () => {
  it("reuses one TaskAttempt and blocks other writers until sandbox closure finishes", async () => {
    const manager = new WorkspaceWriteOccupancy();
    const lease = manager.acquire(first);
    expect(manager.acquire(first).leaseId).toBe(lease.leaseId);
    expect(() => manager.acquire({ ...first, principalId: "owner-b" })).toThrow(
      WorkspaceWriteBusyError,
    );
    expect(() => manager.acquire({ ...first, executionId: "attempt-2" })).toThrow(
      WorkspaceWriteBusyError,
    );
    let finish!: () => void;
    const closed = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const release = manager.closeAndRelease(lease, () => closed);
    expect(manager.status(first.workspaceId)).toBe("closing");
    expect(() => manager.acquire(first)).toThrow(WorkspaceWriteBusyError);
    finish();
    await release;
    expect(manager.status(first.workspaceId)).toBe("free");
    expect(manager.acquire({ ...first, principalId: "owner-b" }).principalId).toBe("owner-b");
  });

  it("quarantines failed close and needs positive isolation proof", async () => {
    const manager = new WorkspaceWriteOccupancy();
    const lease = manager.acquire(first);
    await expect(
      manager.closeAndRelease(lease, async () => {
        throw new Error("close failed");
      }),
    ).rejects.toThrow("close failed");
    expect(manager.status(first.workspaceId)).toBe("quarantined");
    expect(() => manager.acquire(first)).toThrow(WorkspaceWriteBusyError);
    await expect(manager.releaseQuarantined(lease, async () => false)).rejects.toThrow(
      "not isolated",
    );
    await manager.releaseQuarantined(lease, async () => true);
    expect(manager.status(first.workspaceId)).toBe("free");
  });

  it("keeps different workspaces independent and rejects stale lease release", async () => {
    const manager = new WorkspaceWriteOccupancy();
    const lease = manager.acquire(first);
    expect(manager.acquire({ ...first, workspaceId: "other" }).workspaceId).toBe("other");
    await expect(
      manager.closeAndRelease({ ...lease, leaseId: "stale" }, async () => undefined),
    ).rejects.toThrow("Unknown");
    expect(manager.status(first.workspaceId)).toBe("active");
  });
});
