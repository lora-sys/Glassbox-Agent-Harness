import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vite-plus/test";
import { openDomainStore, type DomainStore } from "../persistence/index.js";

const stores: DomainStore[] = [];
const directories: string[] = [];

async function createBinding(databasePath = ":memory:") {
  const store = await openDomainStore({ databasePath });
  stores.push(store);
  await store.identities.createPrincipal("owner", "owner");
  const task = await store.tasks.createTask({
    title: "Worker prompt",
    creatorPrincipalId: "owner",
  });
  const attempt = await store.tasks.createAttempt({ taskId: task.id });
  const binding = await store.tasks.bindWorker({
    taskAttemptId: attempt.id,
    herdrSession: "session-1",
    workspaceId: "workspace-1",
    paneId: "pane-1",
    agentKind: "codex",
  });
  return { store, attempt, binding };
}

afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
  for (const directory of directories.splice(0)) {
    try {
      await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch {
      // Windows may retain the SQLite handle briefly after libsql closes it.
    }
  }
});

it("records prompt acknowledgement once for the exact Attempt and WorkerBinding", async () => {
  const { store, attempt, binding } = await createBinding();
  expect(binding.promptDispatchedAt).toBeUndefined();

  expect(await store.tasks.markWorkerPromptDispatched("wrong-attempt", binding.id)).toBe(false);
  expect(await store.tasks.markWorkerPromptDispatched(attempt.id, "wrong-binding")).toBe(false);

  const firstAcknowledgement = "2026-09-27T01:02:03.000Z";
  expect(
    await store.tasks.markWorkerPromptDispatched(attempt.id, binding.id, firstAcknowledgement),
  ).toBe(true);
  expect(
    await store.tasks.markWorkerPromptDispatched(
      attempt.id,
      binding.id,
      "2026-09-27T02:00:00.000Z",
    ),
  ).toBe(false);
  expect((await store.tasks.getWorkerBinding(attempt.id))?.promptDispatchedAt).toBe(
    firstAcknowledgement,
  );
});

it("adds nullable prompt acknowledgement when upgrading a version 14 database", async () => {
  const directory = await mkdtemp(join(tmpdir(), "glassbox-worker-prompt-v14-"));
  directories.push(directory);
  const databasePath = join(directory, "glassbox.db");
  const { store, attempt, binding } = await createBinding(databasePath);

  await store.db.transaction(async (tx) => {
    await tx.execute("ALTER TABLE worker_bindings DROP COLUMN prompt_dispatched_at");
    await tx.execute("PRAGMA user_version = 14");
  });
  await store.close();
  stores.splice(stores.indexOf(store), 1);

  const upgraded = await openDomainStore({ databasePath });
  stores.push(upgraded);
  expect(await upgraded.tasks.getWorkerBinding(attempt.id)).toMatchObject({
    id: binding.id,
    taskAttemptId: attempt.id,
    paneId: "pane-1",
    promptDispatchedAt: undefined,
  });
  expect(
    await upgraded.db.transaction(async (tx) => tx.execute("PRAGMA user_version")),
  ).toMatchObject({
    rows: [{ user_version: 19 }],
  });
});
