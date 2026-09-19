import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vite-plus/test";
import { openDomainStore } from "../../persistence/index.js";
import { executeWorkerFileTool, type WorkerToolContext } from "./worker-tools-extension.js";

it("rechecks grants and active attempt for each worker file operation and records safe evidence", async () => {
  const directory = await mkdtemp(join(tmpdir(), "glassbox-worker-policy-"));
  const databasePath = join(directory, "glassbox.db");
  const root = join(directory, "workspace");
  await mkdir(root);
  const store = await openDomainStore({ databasePath });
  const caller = {
    principalId: "owner",
    scope: {
      connectionId: "test",
      botId: "bot",
      chatType: "private" as const,
      chatId: "owner",
      senderId: "owner",
    },
  };
  try {
    await store.identities.bindOwner("owner", caller.scope);
    const resourceId = "worker-workspace:test";
    await store.authorization.registerResource({
      id: resourceId,
      kind: "worker-files",
      visibility: "private",
      ownerId: "owner",
    });
    const task = await store.tasks.createTask({ title: "bounded", creatorPrincipalId: "owner" });
    const attempt = await store.tasks.createAttempt({ taskId: task.id });
    const context: WorkerToolContext = {
      databasePath,
      root,
      resourceId,
      taskId: task.id,
      attemptId: attempt.id,
      caller,
      allowedActions: ["worker:file:read", "worker:file:write"],
    };
    await expect(
      executeWorkerFileTool(context, "ungranted", "write", {
        path: "result.ts",
        content: "PRIVATE_CANARY",
      }),
    ).rejects.toThrow();
    const writeGrant = await store.authorization.grant({
      principalId: "owner",
      resourceId,
      action: "worker:file:write",
      scope: caller.scope,
      effect: "allow",
    });
    await executeWorkerFileTool(context, "write", "write", {
      path: "result.ts",
      content: "PRIVATE_CANARY",
    });
    expect(await readFile(join(root, "result.ts"), "utf8")).toBe("PRIVATE_CANARY");
    await expect(
      executeWorkerFileTool(context, "read-without-grant", "read", { path: "result.ts" }),
    ).rejects.toThrow();
    await store.authorization.grant({
      principalId: "owner",
      resourceId,
      action: "worker:file:read",
      scope: caller.scope,
      effect: "allow",
    });
    await expect(
      executeWorkerFileTool(
        { ...context, allowedActions: ["worker:file:write"] },
        "outside-delegation",
        "read",
        { path: "result.ts" },
      ),
    ).rejects.toThrow();
    expect(await executeWorkerFileTool(context, "read", "read", { path: "result.ts" })).toBe(
      "PRIVATE_CANARY",
    );
    const parallel = await Promise.all(
      ["parallel-1", "parallel-2", "parallel-3"].map((id) =>
        executeWorkerFileTool(context, id, "read", { path: "result.ts" }),
      ),
    );
    expect(parallel).toEqual(["PRIVATE_CANARY", "PRIVATE_CANARY", "PRIVATE_CANARY"]);
    await store.authorization.revoke(writeGrant);
    await expect(
      executeWorkerFileTool(context, "revoked", "write", {
        path: "result.ts",
        content: "overwrite",
      }),
    ).rejects.toThrow();
    await expect(
      executeWorkerFileTool(context, "traversal", "read", { path: "../glassbox.db" }),
    ).rejects.toThrow();
    await store.tasks.cancelTask(task.id, "stop");
    await expect(
      executeWorkerFileTool(context, "after-cancel", "read", { path: "result.ts" }),
    ).rejects.toThrow();
    const trace = await store.tasks.listTraceEvents({ taskId: task.id });
    expect(trace.filter((event) => event.type === "worker.tool")).toHaveLength(11);
    expect(JSON.stringify(trace)).not.toContain("PRIVATE_CANARY");
    expect(JSON.stringify(trace)).not.toContain("../glassbox.db");
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 2, retryDelay: 50 }).catch(
      (error) => {
        if (error.code !== "EBUSY") throw error;
      },
    );
  }
});
