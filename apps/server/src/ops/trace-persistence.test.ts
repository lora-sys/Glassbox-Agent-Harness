import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vite-plus/test";
import { openDomainStore } from "../persistence/index.js";

it("returns durable trace sequences across reopen and leaves no event after a failed insert", async () => {
  const directory = await mkdtemp(join(tmpdir(), "glassbox-ops-trace-"));
  const databasePath = join(directory, "domain.db");
  let store = await openDomainStore({ databasePath });
  try {
    const first = await store.tasks.recordTrace({ type: "runtime.turn", data: { phase: "first" } });
    await store.close();
    store = await openDomainStore({ databasePath });
    const second = await store.tasks.recordTrace({
      type: "runtime.turn",
      data: { phase: "second" },
    });
    expect(second.seq).toBeGreaterThan(first.seq);
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    await expect(
      store.tasks.recordTrace({ type: "runtime.turn", data: circular }),
    ).rejects.toThrow();
    const persisted = await store.tasks.listTraceEvents();
    expect(persisted).toEqual([first, second]);
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true }).catch((error: NodeJS.ErrnoException) => {
      // libSQL can retain Windows file handles until the test process exits.
      if (process.platform !== "win32" || error.code !== "EBUSY") throw error;
    });
  }
});
