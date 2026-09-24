import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WorkspaceWriteBusyError, WorkspaceWriteOccupancy } from "./write-occupancy.js";

const first = {
  workspaceId: "shared",
  principalId: "owner-a",
  executionId: "attempt-1",
  sandboxSessionId: "sandbox-a",
  policyVersion: "policy-1",
};
const roots: string[] = [];
function fixture(): { root: string; manager: WorkspaceWriteOccupancy } {
  const root = mkdtempSync(join(tmpdir(), "glassbox-write-occupancy-"));
  roots.push(root);
  return { root, manager: new WorkspaceWriteOccupancy(root) };
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("WorkspaceWriteOccupancy", () => {
  it("reuses one TaskAttempt and blocks other writers until sandbox closure finishes", async () => {
    const { manager } = fixture();
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
    const { manager } = fixture();
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
    const { manager } = fixture();
    const lease = manager.acquire(first);
    expect(manager.acquire({ ...first, workspaceId: "other" }).workspaceId).toBe("other");
    await expect(
      manager.closeAndRelease({ ...lease, leaseId: "stale" }, async () => undefined),
    ).rejects.toThrow("Unknown");
    expect(manager.status(first.workspaceId)).toBe("active");
  });

  it("atomically blocks another manager using the same host ledger", () => {
    const { root, manager } = fixture();
    const second = new WorkspaceWriteOccupancy(root);
    const lease = manager.acquire(first);
    expect(second.status(first.workspaceId)).toBe("active");
    expect(() => second.acquire({ ...first, principalId: "owner-b" })).toThrow(
      WorkspaceWriteBusyError,
    );
    expect(() => second.acquire(first)).toThrow(WorkspaceWriteBusyError);
    expect(manager.acquire(first).leaseId).toBe(lease.leaseId);
  });

  it("restarts into quarantine until a positive stop check releases the old writer", async () => {
    const { root, manager } = fixture();
    const old = manager.acquire(first);
    const restarted = new WorkspaceWriteOccupancy(root);
    expect(restarted.status(first.workspaceId)).toBe("quarantined");
    expect(restarted.listUnresolved()).toEqual([{ lease: old, state: "quarantined" }]);
    expect(() => restarted.acquire({ ...first, principalId: "owner-b" })).toThrow(
      WorkspaceWriteBusyError,
    );
    await expect(
      restarted.releaseQuarantined(old, async (lease) => {
        expect(lease.sandboxSessionId).toBe(first.sandboxSessionId);
        return false;
      }),
    ).rejects.toThrow("not isolated");
    expect(restarted.status(first.workspaceId)).toBe("quarantined");
    await restarted.releaseQuarantined(old, async () => true);
    expect(restarted.status(first.workspaceId)).toBe("free");
    expect(restarted.acquire({ ...first, principalId: "owner-b" }).principalId).toBe("owner-b");
  });

  it("keeps an interrupted close quarantined across restart", async () => {
    const { root, manager } = fixture();
    const old = manager.acquire(first);
    let finish!: () => void;
    const pendingClose = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const release = manager.closeAndRelease(old, () => pendingClose);
    expect(manager.status(first.workspaceId)).toBe("closing");
    const restarted = new WorkspaceWriteOccupancy(root);
    expect(restarted.status(first.workspaceId)).toBe("quarantined");
    finish();
    await expect(release).rejects.toThrow(WorkspaceWriteBusyError);
    expect(restarted.status(first.workspaceId)).toBe("quarantined");
  });
});
