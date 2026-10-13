import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile, open, lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { acquireRunLock } from "../cli.mjs";
import { digest } from "../lib/core.mjs";
import { captureMemoryProcess, verifyMemoryProcessStopped } from "../lib/memory-process.mjs";
import { recoverFinalizedTasteLock } from "../lib/taste-finalized-recovery.mjs";
import { writeTasteCheckpoint } from "../lib/taste-checkpoint.mjs";
import { TASTE_FAMILY_ID } from "../lib/taste-scenario.mjs";

const runtime = {
  checkout: "/isolated/checkout",
  dataDirectory: "/isolated/data",
  commit: "a".repeat(40),
  pid: 1234,
  connectionId: "taste-connection",
  threadId: null,
};
const accountScope = {
  connectionId: runtime.connectionId,
  botId: "bot-1",
  chatType: "private",
  chatId: "owner-1",
  senderId: "owner-1",
  threadId: null,
};
const fixtureHandles = {
  fixtureNonce: "1".repeat(32),
  projectId: "qqtest-" + "1".repeat(32),
  principalId: "owner-principal",
  candidateId: "candidate_" + "2".repeat(32),
  creationRunId: "product-run-1",
  promotionRunId: "product-run-2",
  memoryId: "memory_" + "3".repeat(32),
  negativeRunId: "product-run-3",
  correctionCandidateId: "candidate_" + "4".repeat(32),
  cleanupRunId: "product-run-4",
  stepRunId: "product-run-4",
};
const accepted = {
  status: "PASS",
  familyId: TASTE_FAMILY_ID,
  runtime,
  scope: { chatType: "private" },
  stageRunIds: ["product-run-1", "product-run-2", "product-run-3", "product-run-4"],
  fixture: { projectId: fixtureHandles.projectId, lifecycleState: "retired" },
};

function rowFor({ sequence, previous, phase, stage, steps, handles, origin, reportDirectory }) {
  const row = {
    schemaVersion: 1,
    familyId: TASTE_FAMILY_ID,
    sequence,
    previousSha256: previous?.checkpointSha256 ?? null,
    phase,
    stage,
    steps,
    handles,
    origin,
    at: origin.startedAt,
    runId: "taste-cli-run",
    reportDirectory,
  };
  row.checkpointSha256 = digest(JSON.stringify(row));
  return row;
}

async function buildCompletedJournal({ pendingPath, journalPath, reportDirectory, origin }) {
  let previous;
  let steps = [];
  let sequence = 0;
  for (const stage of ["feedback", "promote", "negative-feedback", "retire"]) {
    for (const phase of ["before_send", "lease_intent", "prepared", "sent", "observed"]) {
      const nextSteps =
        phase === "observed"
          ? [
              ...steps,
              {
                stage,
                runId:
                  fixtureHandles[
                    stage === "feedback"
                      ? "creationRunId"
                      : stage === "promote"
                        ? "promotionRunId"
                        : stage === "negative-feedback"
                          ? "negativeRunId"
                          : "cleanupRunId"
                  ],
                observation: {
                  lifecycleState: stage === "retire" ? "retired" : "active",
                  activeCount: stage === "retire" ? 0 : 1,
                  pendingCount: 0,
                },
              },
            ]
          : steps;
      const row = rowFor({
        sequence: ++sequence,
        previous,
        phase,
        stage,
        steps: nextSteps,
        handles: fixtureHandles,
        origin,
        reportDirectory,
      });
      await writeTasteCheckpoint({
        pendingPath,
        journalPath,
        row,
        first: previous === undefined,
      });
      previous = row;
      steps = nextSteps;
    }
  }
}

async function startCrashChild(lockPath, pendingPath) {
  const childScript =
    "import { acquireRunLock } from " +
    JSON.stringify(new URL("../cli.mjs", import.meta.url).href) +
    ";\n" +
    'import { rm } from "node:fs/promises";\n' +
    "const acquired = await acquireRunLock({ lockPath: " +
    JSON.stringify(lockPath) +
    ", identityRequired: true });\n" +
    "console.log(JSON.stringify({ processIdentity: acquired.processIdentity, startedAt: acquired.startedAt }));\n" +
    'process.stdin.setEncoding("utf8");\n' +
    'process.stdin.once("data", async () => { await rm(' +
    JSON.stringify(pendingPath) +
    '); console.log("PENDING_REMOVED"); setInterval(() => {}, 1000); });\n';
  const child = spawn(process.execPath, ["--input-type=module", "-e", childScript], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  let buffer = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  const lines = [];
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    while (buffer.includes("\n")) {
      const index = buffer.indexOf("\n");
      lines.push(buffer.slice(0, index));
      buffer = buffer.slice(index + 1);
    }
  });
  const waitLine = async () => {
    while (!lines.length) await new Promise((resolve) => setTimeout(resolve, 5));
    return lines.shift();
  };
  const ready = JSON.parse(await waitLine());
  return { child, ready, waitLine };
}

async function scenario(t, { writeReport = true } = {}) {
  if (process.platform !== "linux") return null;
  const root = await mkdtemp(join(tmpdir(), "taste-finalized-sigkill-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const outDirectory = join(root, "reports");
  const reportDirectory = join(outDirectory, "taste-cli-run");
  const lockDirectory = join(root, "locks");
  await mkdir(reportDirectory, { recursive: true });
  await mkdir(lockDirectory, { recursive: true });
  const lockPath = join(lockDirectory, "account.lock");
  const pendingPath = join(lockDirectory, "account.taste-pending.json");
  const journalPath = join(reportDirectory, "taste-fixture.jsonl");
  const stopPath = join(outDirectory, "STOP");
  await mkdir(outDirectory, { recursive: true });
  const { child, ready, waitLine } = await startCrashChild(lockPath, pendingPath);
  const origin = {
    familyId: TASTE_FAMILY_ID,
    runtime,
    scope: accountScope,
    driverSha256: digest("owner-1"),
    suiteSha256: "b".repeat(64),
    startedAt: ready.startedAt,
    process: ready.processIdentity,
  };
  await buildCompletedJournal({ pendingPath, journalPath, reportDirectory, origin });
  if (writeReport) {
    const report = {
      mode: "run",
      status: "PASS",
      runId: "taste-cli-run",
      reportDirectory,
      startedAt: ready.startedAt,
      suiteSha256: origin.suiteSha256,
      runtime,
      tasteFamily: { familyId: TASTE_FAMILY_ID },
      productAcceptance: { status: "PASS" },
      tasteLifecycle: {
        status: "PASS",
        requiresReconciliation: false,
        handles: fixtureHandles,
        steps: accepted.stageRunIds.map((runId, index) => ({
          stage: ["feedback", "promote", "negative-feedback", "retire"][index],
          runId,
        })),
      },
      tasteFamilyAcceptance: accepted,
    };
    await writeFile(join(reportDirectory, "report.json"), JSON.stringify(report) + "\n", {
      mode: 0o600,
    });
  }
  child.stdin.end("remove pending");
  assert.equal(await waitLine(), "PENDING_REMOVED");
  return {
    root,
    outDirectory,
    reportDirectory,
    lockPath,
    pendingPath,
    journalPath,
    stopPath,
    child,
    ready,
    kill: async () => {
      child.kill("SIGKILL");
      await new Promise((resolve) => child.once("exit", resolve));
    },
  };
}

async function replaceLock(path, expected, beforeRemove, oldProcess) {
  const info = await lstat(path);
  const bytes = await readFile(path);
  assert.deepEqual({ dev: info.dev, ino: info.ino, sha256: digest(bytes) }, expected);
  await verifyMemoryProcessStopped(oldProcess);
  await beforeRemove();
  const current = await lstat(path);
  assert.equal(current.dev, info.dev);
  assert.equal(current.ino, info.ino);
  assert.deepEqual(await readFile(path), bytes);
  await rm(path);
  const identity = await captureMemoryProcess();
  const handle = await open(path, "wx", 0o600);
  await handle.writeFile(
    JSON.stringify({ pid: identity.pid, process: identity, startedAt: new Date().toISOString() }),
  );
  await handle.sync();
  return handle;
}

function recoveryInput(s, extra = {}) {
  return {
    pendingPath: s.pendingPath,
    lockPath: s.lockPath,
    outDirectory: s.outDirectory,
    runtime,
    scope: accountScope,
    driverQQ: "owner-1",
    stopPath: s.stopPath,
    verifyStopped: verifyMemoryProcessStopped,
    verifyFinalized: async (report) => report.tasteFamilyAcceptance,
    replaceLock: (expected, beforeRemove) =>
      replaceLock(s.lockPath, expected, beforeRemove, s.ready.processIdentity),
    ...extra,
  };
}

test("SIGKILL after durable Taste finalization recovers only the stale lock", async (t) => {
  const s = await scenario(t);
  if (!s) return;
  await s.kill();
  const recovered = await recoverFinalizedTasteLock(recoveryInput(s));
  assert.equal(recovered.runId, "taste-cli-run");
  assert.equal(recovered.stopUnchanged, true);
  assert.equal(JSON.parse(await readFile(s.lockPath, "utf8")).pid, process.pid);
  await recovered.handle.close();
  await rm(s.lockPath);
});

test("missing pending without a complete finalized report leaves the account lock untouched", async (t) => {
  const s = await scenario(t, { writeReport: false });
  if (!s) return;
  await s.kill();
  const before = await readFile(s.lockPath);
  await assert.rejects(recoverFinalizedTasteLock(recoveryInput(s)), {
    code: "TASTE_FINALIZED_RECOVERY_NOT_PROVEN",
  });
  assert.deepEqual(await readFile(s.lockPath), before);
});

test("a live source process cannot be reclaimed even after pending was removed", async (t) => {
  const s = await scenario(t);
  if (!s) return;
  const before = await readFile(s.lockPath);
  await assert.rejects(recoverFinalizedTasteLock(recoveryInput(s)), {
    code: "MEMORY_PROCESS_RUNNING",
  });
  assert.deepEqual(await readFile(s.lockPath), before);
  await s.kill();
});
