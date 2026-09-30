import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vite-plus/test";
import { DomainDatabase } from "../../persistence/database.js";
import { TaskWorkflowBindingStore } from "./binding-store.js";
import { longWorkWorkflowId } from "./contracts.js";

const now = "2026-09-27T00:00:00.000Z";

async function seedTask(
  db: DomainDatabase,
  options: { durable?: boolean; policyRevision?: number; taskId?: string } = {},
) {
  const taskId = options.taskId ?? "task-1";
  await db.transaction(async (tx) => {
    await tx.execute({
      sql: "INSERT OR IGNORE INTO principals(id,kind,created_at) VALUES (?,?,?)",
      args: ["owner", "owner", now],
    });
    await tx.execute({
      sql: "INSERT INTO tasks(id,title,status,priority,creator_principal_id,orchestration_mode,policy_revision,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
      args: [
        taskId,
        "Binding test",
        "NEW",
        "normal",
        "owner",
        options.durable ? "durable" : "legacy",
        options.policyRevision ?? 1,
        now,
        now,
      ],
    });
  });
}

it("reserves the stable workflow ID idempotently for the matching durable policy", async () => {
  const db = await DomainDatabase.open(":memory:");
  try {
    await seedTask(db, { durable: true, policyRevision: 4 });
    const store = new TaskWorkflowBindingStore(db);
    const binding = await store.reserve("task-1", 4, now);
    expect(binding).toMatchObject({
      taskId: "task-1",
      workflowId: longWorkWorkflowId("task-1"),
      backend: "temporal",
      policyRevision: 4,
      status: "starting",
      continuation: 0,
    });
    expect(await store.reserve("task-1", 4, "2026-09-27T00:01:00.000Z")).toEqual(binding);
    await expect(store.reserve("task-1", 3, now)).rejects.toThrow("policy revision is stale");
  } finally {
    await db.close();
  }
});

it("rejects legacy and terminal Tasks", async () => {
  const db = await DomainDatabase.open(":memory:");
  try {
    await seedTask(db);
    const store = new TaskWorkflowBindingStore(db);
    await expect(store.reserve("task-1", 1, now)).rejects.toThrow("durable Task");
    await db.transaction(async (tx) => {
      await tx.execute(
        "UPDATE tasks SET orchestration_mode = 'durable', status = 'DONE' WHERE id = 'task-1'",
      );
    });
    await expect(store.reserve("task-1", 1, now)).rejects.toThrow("active durable work");
  } finally {
    await db.close();
  }
});

it("uses compare and set for state and run updates", async () => {
  const db = await DomainDatabase.open(":memory:");
  try {
    await seedTask(db, { durable: true });
    const store = new TaskWorkflowBindingStore(db);
    await store.reserve("task-1", 1, now);
    const running = await store.recordState({
      taskId: "task-1",
      policyRevision: 1,
      expectedStatus: "starting",
      expectedRunId: null,
      status: "running",
      runId: "run-1",
      updatedAt: now,
    });
    expect(running).toMatchObject({ status: "running", runId: "run-1" });
    await expect(
      store.recordState({
        taskId: "task-1",
        policyRevision: 1,
        expectedStatus: "starting",
        expectedRunId: null,
        status: "unavailable",
        updatedAt: now,
      }),
    ).rejects.toThrow("changed concurrently");
    await store.recordState({
      taskId: "task-1",
      policyRevision: 1,
      expectedStatus: "running",
      expectedRunId: "run-1",
      status: "closed",
      updatedAt: "2026-09-27T00:02:00.000Z",
    });
    await expect(
      store.recordState({
        taskId: "task-1",
        policyRevision: 1,
        expectedStatus: "unavailable",
        expectedRunId: "run-1",
        status: "running",
        updatedAt: now,
      }),
    ).rejects.toThrow("changed concurrently");
  } finally {
    await db.close();
  }
});

it("increments continuation once when a running workflow changes Temporal run ID", async () => {
  const db = await DomainDatabase.open(":memory:");
  try {
    await seedTask(db, { durable: true });
    const store = new TaskWorkflowBindingStore(db);
    await store.reserve("task-1", 1, now);
    const first = await store.recordState({
      taskId: "task-1",
      policyRevision: 1,
      expectedStatus: "starting",
      expectedRunId: null,
      status: "running",
      runId: "run-1",
      updatedAt: now,
    });
    expect(first).toMatchObject({ runId: "run-1", continuation: 0 });

    const continued = await store.recordState({
      taskId: "task-1",
      policyRevision: 1,
      expectedStatus: "running",
      expectedRunId: "run-1",
      status: "running",
      runId: "run-2",
      updatedAt: "2026-09-27T00:01:00.000Z",
    });
    expect(continued).toMatchObject({
      taskId: "task-1",
      workflowId: longWorkWorkflowId("task-1"),
      runId: "run-2",
      continuation: 1,
      status: "running",
    });
    await expect(
      store.recordState({
        taskId: "task-1",
        policyRevision: 1,
        expectedStatus: "running",
        expectedRunId: "run-1",
        status: "running",
        runId: "run-2",
        updatedAt: "2026-09-27T00:02:00.000Z",
      }),
    ).rejects.toThrow("changed concurrently");
  } finally {
    await db.close();
  }
});

it("lists starting, running, and unavailable bindings after reopening the database", async () => {
  const directory = await mkdtemp(join(tmpdir(), "glassbox-workflow-binding-"));
  const path = join(directory, "domain.db");
  let db = await DomainDatabase.open(path);
  try {
    await seedTask(db, { durable: true, taskId: "task-starting" });
    await seedTask(db, { durable: true, taskId: "task-running" });
    await seedTask(db, { durable: true, taskId: "task-unavailable" });
    await seedTask(db, { durable: true, taskId: "task-closed" });
    const store = new TaskWorkflowBindingStore(db);
    await store.reserve("task-starting", 1, now);
    await store.reserve("task-running", 1, now);
    await store.reserve("task-unavailable", 1, now);
    await store.reserve("task-closed", 1, now);
    await store.recordState({
      taskId: "task-running",
      policyRevision: 1,
      expectedStatus: "starting",
      expectedRunId: null,
      status: "running",
      runId: "run-running",
      updatedAt: "2026-09-27T00:01:00.000Z",
    });
    await store.recordState({
      taskId: "task-unavailable",
      policyRevision: 1,
      expectedStatus: "starting",
      expectedRunId: null,
      status: "unavailable",
      updatedAt: "2026-09-27T00:01:00.000Z",
    });
    await store.recordState({
      taskId: "task-closed",
      policyRevision: 1,
      expectedStatus: "starting",
      expectedRunId: null,
      status: "closed",
      updatedAt: "2026-09-27T00:01:00.000Z",
    });
  } finally {
    await db.close();
  }

  db = await DomainDatabase.open(path);
  try {
    const recovered = await new TaskWorkflowBindingStore(db).listRecoverable();
    expect(recovered.map(({ taskId, status }) => [taskId, status])).toEqual([
      ["task-starting", "starting"],
      ["task-running", "running"],
      ["task-unavailable", "unavailable"],
    ]);
  } finally {
    await db.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }).catch(
      (error: NodeJS.ErrnoException) => {
        if (process.platform !== "win32" || error.code !== "EBUSY") throw error;
      },
    );
  }
});
