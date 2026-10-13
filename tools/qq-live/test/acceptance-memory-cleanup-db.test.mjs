import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { Worker } from "node:worker_threads";
import { DatabaseSync } from "node:sqlite";
import { openCurrentInventoryDb } from "../lib/acceptance-memory-cleanup-cli.mjs";

const lockWorker = `
  const { parentPort, workerData } = require("node:worker_threads");
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(workerData.path);
  db.exec("BEGIN EXCLUSIVE");
  parentPort.postMessage({ type: "locked" });
  setTimeout(() => {
    db.exec("COMMIT");
    db.close();
    parentPort.postMessage({ type: "released" });
  }, workerData.releaseAfterMs);
`;

async function lockedDatabase(t, { releaseAfterMs, busyTimeoutMs }) {
  const directory = await mkdtemp(join(tmpdir(), "cleanup-db-busy-"));
  const path = join(directory, "glassbox.db");
  const setup = new DatabaseSync(path);
  setup.exec("CREATE TABLE busy_test (value TEXT); INSERT INTO busy_test VALUES ('ready')");
  setup.close();
  const worker = new Worker(lockWorker, {
    eval: true,
    workerData: { path, releaseAfterMs },
  });
  t.after(async () => {
    if (worker.threadId !== -1) await worker.terminate();
    await rm(directory, { recursive: true, force: true });
  });
  const [ready] = await once(worker, "message");
  assert.deepEqual(ready, { type: "locked" });
  const db = openCurrentInventoryDb(path, { busyTimeoutMs });
  return { db, worker };
}

test("current inventory reader waits for a held writer within its SQLite busy timeout", async (t) => {
  const { db, worker } = await lockedDatabase(t, {
    releaseAfterMs: 100,
    busyTimeoutMs: 1_000,
  });
  try {
    assert.equal(db.prepare("SELECT value FROM busy_test").get().value, "ready");
  } finally {
    db.close();
  }
  const [released] = await once(worker, "message");
  assert.deepEqual(released, { type: "released" });
});

test("current inventory reader returns a bounded lock failure when the writer exceeds SQLite busy timeout", async (t) => {
  const { db, worker } = await lockedDatabase(t, {
    releaseAfterMs: 250,
    busyTimeoutMs: 60,
  });
  try {
    assert.throws(() => db.prepare("SELECT value FROM busy_test").get(), /database is locked/u);
  } finally {
    db.close();
  }
  const [released] = await once(worker, "message");
  assert.deepEqual(released, { type: "released" });
});

test("current inventory reader rejects invalid busy timeout values", () => {
  assert.throws(
    () => openCurrentInventoryDb("unused", { busyTimeoutMs: 30_001 }),
    (error) => error.code === "CLEANUP_DB_TIMEOUT",
  );
});
