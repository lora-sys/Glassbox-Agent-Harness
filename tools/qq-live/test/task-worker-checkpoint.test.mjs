import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, test } from "node:test";
import {
  advanceTaskWorkerCheckpoint,
  completeTaskWorkerCheckpoint,
  createTaskWorkerCheckpoint,
  readTaskWorkerCheckpoint,
  TASK_WORKER_CHECKPOINT_STAGES,
} from "../lib/task-worker-checkpoint.mjs";

const directories = new Set();
const nonce = "a1b2c3d4e5f607182930aabbccddeeff";
const markerSha256 = "f".repeat(64);
const hash = (value) => createHash("sha256").update(value).digest("hex");
const uuid = () => randomUUID();

afterEach(async () => {
  await Promise.all([...directories].map((path) => rm(path, { recursive: true, force: true })));
  directories.clear();
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "task-worker-checkpoint-"));
  directories.add(root);
  const reportDirectory = join(root, "run-report");
  const lockDirectory = join(root, "account-lock");
  await Promise.all([mkdir(reportDirectory), mkdir(lockDirectory)]);
  const pendingPath = join(lockDirectory, "task-worker.pending.json");
  const identity = {
    runtime: {
      checkout: resolve(root),
      commit: "1".repeat(40),
      dataDirectory: join(root, "data"),
      pid: 2400,
      connectionId: "qq-account-fixture",
      threadId: null,
    },
    suiteSha256: "2".repeat(64),
    fixtureNonce: nonce,
    workerTarget: {
      workspaceId: "workspace-fixture",
      herdrSession: "herdr-fixture",
      agentKind: "coding-agent",
      markerSha256,
    },
    startedAt: new Date().toISOString(),
  };
  return { root, reportDirectory, pendingPath, identity };
}

function makeReceipts(identity, ids = {}) {
  const taskId = ids.taskId ?? uuid();
  const attemptId = ids.attemptId ?? uuid();
  const bindingId = ids.bindingId ?? uuid();
  const scope = {
    connectionId: "qq-account-fixture",
    botId: "bot-fixture",
    chatType: "private",
    chatId: "owner-fixture",
    senderId: "owner-fixture",
  };
  const base = (stage, runId, values) => ({
    stage,
    runId,
    taskId,
    principalId: "principal-owner",
    principalKind: "owner",
    scope,
    cleanupVerified: true,
    creationRunId: "run-create-001",
    attemptId,
    bindingId,
    ...values,
  });
  const create = base("create", "run-create-001", {
    taskStatus: "NEW",
    attemptId: null,
    bindingId: null,
  });
  const delegate = base("delegate", "run-delegate-002", {
    workspaceId: identity.workerTarget.workspaceId,
    herdrSession: identity.workerTarget.herdrSession,
    agentKind: identity.workerTarget.agentKind,
    dispatchVerified: true,
    taskStatus: "RUNNING",
    attemptStatus: "running",
  });
  const content = Buffer.from(`${identity.fixtureNonce}\n`, "utf8");
  const inspect = base("inspect", "run-inspect-003", {
    taskStatus: "REVIEW",
    attemptStatus: "review",
    workerTerminalVerified: true,
    artifact: {
      filename: `qq-live-worker-${identity.fixtureNonce}.txt`,
      sizeBytes: content.length,
      sha256: hash(content),
      fullContentVerified: true,
      markerSha256: identity.workerTarget.markerSha256,
    },
  });
  const accept = base("accept", "run-accept-004", {
    acceptedRunId: "run-accept-004",
    taskStatus: "DONE",
    attemptStatus: "succeeded",
    workerLeaseReleased: true,
    terminalVerified: true,
    pendingAttentionCount: 0,
  });
  return [create, delegate, inspect, accept];
}

const drainReceipt = {
  driver: { closed: true, pendingCount: 0 },
  bot: { closed: true, pendingCount: 0 },
};

async function advanceThroughAll(f, receipts) {
  let state = await createTaskWorkerCheckpoint(f);
  for (let index = 0; index < TASK_WORKER_CHECKPOINT_STAGES.length; index += 1) {
    const stage = TASK_WORKER_CHECKPOINT_STAGES[index];
    state = await advanceTaskWorkerCheckpoint({
      ...f,
      identity: state.identity,
      stage,
      phase: "intent",
    });
    state = await advanceTaskWorkerCheckpoint({
      ...f,
      identity: state.identity,
      stage,
      phase: "sent_unverified",
    });
    state = await advanceTaskWorkerCheckpoint({
      ...f,
      identity: state.identity,
      stage,
      phase: "verified",
      proof: receipts[index],
    });
  }
  return state;
}

test("creates a durable account guard outside the report directory and advances each stage once", async () => {
  const f = await fixture();
  const receipts = makeReceipts(f.identity);
  const state = await advanceThroughAll(f, receipts);
  assert.equal(state.phase, "verified");
  assert.equal(state.stage, "accept");
  assert.equal(state.stageRunIds.length, 4);
  assert.equal(state.originProcessMatchesCurrent, true);
  assert.equal((await stat(f.pendingPath)).isFile(), true);
  assert.equal(
    (
      await readTaskWorkerCheckpoint({
        pendingPath: f.pendingPath,
        reportDirectory: f.reportDirectory,
      })
    ).phase,
    "verified",
  );
  const firstRow = JSON.parse(
    (await readFile(join(f.reportDirectory, "task-worker.checkpoint.jsonl"), "utf8")).split(
      "\n",
    )[0],
  );
  assert.equal(firstRow.originProcess.pid, process.pid);
  assert.notEqual(firstRow.originProcess.pid, firstRow.identity.runtime.pid);
  assert.equal(firstRow.identity.startedAt, f.identity.startedAt);
  await assert.rejects(
    advanceTaskWorkerCheckpoint({
      ...f,
      identity: state.identity,
      stage: "accept",
      phase: "sent_unverified",
    }),
    { code: "TASK_WORKER_CHECKPOINT" },
  );
});

test("rejects skipped, repeated, malformed, or cross-run receipts without losing the guard", async () => {
  const f = await fixture();
  const created = await createTaskWorkerCheckpoint(f);
  await assert.rejects(
    advanceTaskWorkerCheckpoint({
      ...f,
      identity: created.identity,
      stage: "delegate",
      phase: "intent",
    }),
    { code: "TASK_WORKER_CHECKPOINT" },
  );
  await advanceTaskWorkerCheckpoint({
    ...f,
    identity: created.identity,
    stage: "create",
    phase: "intent",
  });
  await assert.rejects(
    advanceTaskWorkerCheckpoint({
      ...f,
      identity: created.identity,
      stage: "create",
      phase: "intent",
    }),
    { code: "TASK_WORKER_CHECKPOINT" },
  );
  await advanceTaskWorkerCheckpoint({
    ...f,
    identity: created.identity,
    stage: "create",
    phase: "sent_unverified",
  });
  const [create] = makeReceipts(f.identity);
  await assert.rejects(
    advanceTaskWorkerCheckpoint({
      ...f,
      identity: created.identity,
      stage: "create",
      phase: "verified",
      proof: { ...create, principalKind: "visitor" },
    }),
    { code: "TASK_WORKER_CHECKPOINT" },
  );
  await assert.rejects(
    advanceTaskWorkerCheckpoint({
      ...f,
      identity: { ...created.identity, fixtureNonce: "0".repeat(32) },
      stage: "create",
      phase: "verified",
      proof: create,
    }),
    { code: "TASK_WORKER_CHECKPOINT" },
  );
  assert.equal(
    (
      await readTaskWorkerCheckpoint({
        pendingPath: f.pendingPath,
        reportDirectory: f.reportDirectory,
      })
    ).phase,
    "sent_unverified",
  );
});

test("unknown or aborted work stays pending and read-only inspection never removes it", async () => {
  const f = await fixture();
  const created = await createTaskWorkerCheckpoint(f);
  await advanceTaskWorkerCheckpoint({
    ...f,
    identity: created.identity,
    stage: "create",
    phase: "intent",
  });
  await advanceTaskWorkerCheckpoint({
    ...f,
    identity: created.identity,
    stage: "create",
    phase: "sent_unverified",
  });
  const inspected = await readTaskWorkerCheckpoint({
    pendingPath: f.pendingPath,
    reportDirectory: f.reportDirectory,
  });
  assert.equal(inspected.phase, "sent_unverified");
  assert.equal((await stat(f.pendingPath)).isFile(), true);
  await assert.rejects(
    advanceTaskWorkerCheckpoint({
      ...f,
      identity: created.identity,
      stage: "create",
      phase: "intent",
    }),
    { code: "TASK_WORKER_CHECKPOINT" },
  );
  assert.equal(
    (
      await readTaskWorkerCheckpoint({
        pendingPath: f.pendingPath,
        reportDirectory: f.reportDirectory,
      })
    ).phase,
    "sent_unverified",
  );
});

test("a different CLI process cannot advance or remove the original process guard", async () => {
  const f = await fixture();
  const created = await createTaskWorkerCheckpoint(f);
  const script = [
    "const { advanceTaskWorkerCheckpoint } = await import(process.env.CHECKPOINT_MODULE);",
    "const input = JSON.parse(process.env.CHECKPOINT_INPUT);",
    "try { await advanceTaskWorkerCheckpoint(input); process.exitCode = 3; }",
    'catch (error) { if (error?.code !== "TASK_WORKER_CHECKPOINT") process.exitCode = 4; }',
  ].join("\n");
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    encoding: "utf8",
    env: {
      CHECKPOINT_MODULE: new URL("../lib/task-worker-checkpoint.mjs", import.meta.url).href,
      CHECKPOINT_INPUT: JSON.stringify({
        ...f,
        identity: created.identity,
        stage: "create",
        phase: "intent",
      }),
    },
  });
  assert.equal(child.error, undefined);
  assert.equal(child.status, 0, child.stderr || child.stdout);
  assert.equal((await stat(f.pendingPath)).isFile(), true);
  assert.equal(
    (
      await readTaskWorkerCheckpoint({
        pendingPath: f.pendingPath,
        reportDirectory: f.reportDirectory,
      })
    ).phase,
    "guarded",
  );
});

test("tampered journal bytes and a mismatched pending tip fail closed", async () => {
  const f = await fixture();
  const created = await createTaskWorkerCheckpoint(f);
  const journalPath = join(f.reportDirectory, "task-worker.checkpoint.jsonl");
  const original = await readFile(journalPath, "utf8");
  await writeFile(journalPath, `${original.trimEnd()} `, { mode: 0o600 });
  await assert.rejects(
    readTaskWorkerCheckpoint({ pendingPath: f.pendingPath, reportDirectory: f.reportDirectory }),
    { code: "TASK_WORKER_CHECKPOINT" },
  );
  await writeFile(journalPath, original, { mode: 0o600 });
  const pending = await readFile(f.pendingPath, "utf8");
  await writeFile(f.pendingPath, `${pending.trimEnd()} `, { mode: 0o600 });
  await assert.rejects(
    readTaskWorkerCheckpoint({
      pendingPath: f.pendingPath,
      reportDirectory: f.reportDirectory,
      identity: created.identity,
    }),
    { code: "TASK_WORKER_CHECKPOINT" },
  );
  assert.equal((await stat(f.pendingPath)).isFile(), true);
});

test("only four durable receipts and successful close-and-drain remove the account guard", async () => {
  const f = await fixture();
  const receipts = makeReceipts(f.identity);
  const state = await advanceThroughAll(f, receipts);
  await assert.rejects(
    completeTaskWorkerCheckpoint({
      ...f,
      identity: state.identity,
      receipts: receipts.slice(0, 3),
      drainReceipt,
    }),
    { code: "TASK_WORKER_CHECKPOINT" },
  );
  await assert.rejects(
    completeTaskWorkerCheckpoint({
      ...f,
      identity: state.identity,
      receipts,
      drainReceipt: { ...drainReceipt, bot: { closed: true, pendingCount: 1 } },
    }),
    { code: "TASK_WORKER_CHECKPOINT" },
  );
  assert.equal((await stat(f.pendingPath)).isFile(), true);
  const completed = await completeTaskWorkerCheckpoint({
    ...f,
    identity: state.identity,
    receipts,
    drainReceipt,
  });
  assert.equal(completed.status, "COMPLETED");
  assert.equal(completed.workerLeaseReleased, true);
  await assert.rejects(stat(f.pendingPath), { code: "ENOENT" });
  const audited = await readTaskWorkerCheckpoint({
    pendingPath: f.pendingPath,
    reportDirectory: f.reportDirectory,
    identity: state.identity,
  });
  assert.equal(audited.status, "COMPLETED");
  assert.equal(audited.phase, "completed");
  assert.equal(audited.pendingGuardPresent, false);
  await assert.rejects(
    readTaskWorkerCheckpoint({ pendingPath: f.pendingPath, reportDirectory: f.reportDirectory }),
    { code: "TASK_WORKER_CHECKPOINT" },
  );
  await assert.rejects(
    readTaskWorkerCheckpoint({
      pendingPath: f.pendingPath,
      reportDirectory: f.reportDirectory,
      identity: { ...state.identity, suiteSha256: "4".repeat(64) },
    }),
    { code: "TASK_WORKER_CHECKPOINT" },
  );
  const journal = await readFile(join(f.reportDirectory, "task-worker.checkpoint.jsonl"), "utf8");
  assert.match(journal.split("\n").at(-2), /"state":"completed"/u);
});

test("a later output directory cannot bypass a guard anchored in the account lock root", async () => {
  const f = await fixture();
  await createTaskWorkerCheckpoint(f);
  const anotherReport = join(f.root, "another-report");
  await mkdir(anotherReport);
  await assert.rejects(createTaskWorkerCheckpoint({ ...f, reportDirectory: anotherReport }), {
    code: "TASK_WORKER_CHECKPOINT",
  });
  assert.equal((await stat(f.pendingPath)).isFile(), true);
});

test("binds the exact production and explicit development runtime snapshot shapes", async () => {
  const production = await fixture();
  const productionGuard = await createTaskWorkerCheckpoint(production);
  assert.equal(productionGuard.identity.runtime.threadId, null);

  const development = await fixture();
  development.identity.runtime = {
    ...development.identity.runtime,
    development: true,
    sourceTreeSha256: "3".repeat(64),
  };
  const developmentGuard = await createTaskWorkerCheckpoint(development);
  assert.equal(developmentGuard.identity.runtime.development, true);
  assert.equal(developmentGuard.identity.runtime.sourceTreeSha256, "3".repeat(64));

  const missingThreadId = await fixture();
  delete missingThreadId.identity.runtime.threadId;
  await assert.rejects(createTaskWorkerCheckpoint(missingThreadId), {
    code: "TASK_WORKER_CHECKPOINT",
  });
  const falseDevelopment = await fixture();
  falseDevelopment.identity.runtime = {
    ...falseDevelopment.identity.runtime,
    development: false,
    sourceTreeSha256: "3".repeat(64),
  };
  await assert.rejects(createTaskWorkerCheckpoint(falseDevelopment), {
    code: "TASK_WORKER_CHECKPOINT",
  });
});
