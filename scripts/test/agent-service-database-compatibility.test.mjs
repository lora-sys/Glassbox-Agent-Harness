import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { assertDatabaseCompatible } from "../agent-service.mts";

const schemaVersion = 29;

function fixture(t, databaseVersion = schemaVersion) {
  const root = mkdtempSync(join(tmpdir(), "agent-service-db-compat-"));
  chmodSync(root, 0o700);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const checkout = join(root, "checkout");
  const schemaPath = join(checkout, "apps/server/src/persistence/schema.ts");
  mkdirSync(dirname(schemaPath), { recursive: true, mode: 0o700 });
  writeFileSync(schemaPath, `export const CURRENT_SCHEMA_VERSION = ${schemaVersion};\n`);
  const databasePath = join(root, "glassbox.db");
  const database = new DatabaseSync(databasePath);
  database.exec(`PRAGMA journal_mode=DELETE; PRAGMA user_version=${databaseVersion};`);
  database.close();
  return { checkout, databasePath };
}

function exclusiveLockWorker(databasePath, releaseAfterMs) {
  const source = `
    const { parentPort, workerData } = require("node:worker_threads");
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(workerData.databasePath);
    db.exec("BEGIN EXCLUSIVE");
    parentPort.postMessage("locked");
    let isReleased = false;
    const release = () => {
      if (isReleased) return;
      isReleased = true;
      db.exec("ROLLBACK");
      db.close();
      parentPort.postMessage("released");
    };
    parentPort.on("message", (message) => {
      if (message === "release") release();
      if (message === "start-read" && workerData.releaseAfterMs !== null)
        setTimeout(release, workerData.releaseAfterMs);
    });
  `;
  return new Worker(source, {
    eval: true,
    workerData: { databasePath, releaseAfterMs },
  });
}

function waitForMessage(worker, expected) {
  return new Promise((resolveMessage, reject) => {
    const onMessage = (message) => {
      if (message !== expected) return;
      worker.off("message", onMessage);
      worker.off("error", onError);
      resolveMessage();
    };
    const onError = (error) => {
      worker.off("message", onMessage);
      reject(error);
    };
    worker.on("message", onMessage);
    worker.once("error", onError);
  });
}

test("database compatibility waits for a transient exclusive SQLite lock", async (t) => {
  const { checkout, databasePath } = fixture(t);
  const worker = exclusiveLockWorker(databasePath, 250);
  t.after(async () => {
    worker.terminate();
  });
  await waitForMessage(worker, "locked");

  const released = waitForMessage(worker, "released");
  const originalPrepare = DatabaseSync.prototype.prepare;
  DatabaseSync.prototype.prepare = function (sql, ...args) {
    if (sql === "PRAGMA user_version") worker.postMessage("start-read");
    return originalPrepare.call(this, sql, ...args);
  };
  const startedAt = Date.now();
  let elapsedMs;
  try {
    await assertDatabaseCompatible(checkout, databasePath);
    elapsedMs = Date.now() - startedAt;
  } finally {
    DatabaseSync.prototype.prepare = originalPrepare;
  }
  await released;
  assert.ok(
    elapsedMs >= 100,
    `compatibility check returned before the lock release (${elapsedMs}ms)`,
  );
});

test("database compatibility fails closed after its busy timeout", async (t) => {
  const { checkout, databasePath } = fixture(t);
  const worker = exclusiveLockWorker(databasePath, null);
  let releasedByTest = false;
  t.after(async () => {
    if (!releasedByTest) worker.postMessage("release");
    await worker.terminate();
  });
  await waitForMessage(worker, "locked");

  const released = waitForMessage(worker, "released");
  const originalPrepare = DatabaseSync.prototype.prepare;
  DatabaseSync.prototype.prepare = function (sql, ...args) {
    if (sql === "PRAGMA user_version") worker.postMessage("start-read");
    return originalPrepare.call(this, sql, ...args);
  };
  try {
    await assert.rejects(
      assertDatabaseCompatible(checkout, databasePath),
      (error) => error?.code === "ERR_SQLITE_ERROR" && /locked/u.test(error.message),
    );
  } finally {
    DatabaseSync.prototype.prepare = originalPrepare;
  }
  worker.postMessage("release");
  await released;
  releasedByTest = true;
});

test("database compatibility still rejects a schema newer than the checkout", async (t) => {
  const { checkout, databasePath } = fixture(t, schemaVersion + 1);
  await assert.rejects(
    assertDatabaseCompatible(checkout, databasePath),
    new RegExp(
      `supports database version ${schemaVersion}, but shared data uses ${schemaVersion + 1}`,
      "u",
    ),
  );
});
