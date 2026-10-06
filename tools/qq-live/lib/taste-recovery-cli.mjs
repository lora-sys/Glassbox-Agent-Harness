import { appendFileSync } from "node:fs";
import { readFile, open, mkdir, rm, lstat } from "node:fs/promises";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { digest, fail, safeError } from "./core.mjs";
import {
  runtimeInspectionSnapshot,
  runtimeSnapshot,
  verifyProductEvidence,
} from "./product-evidence.mjs";
import { captureMemoryProcess, verifyMemoryProcessStopped } from "./memory-process.mjs";
import { readTasteCheckpointRecord, writeTasteCheckpoint } from "./taste-checkpoint.mjs";
import { observeTasteRecoveryFixture, reconcileTasteFixture } from "./taste-recovery.mjs";
import { acceptanceManagement } from "./management-client.mjs";
import { OneBot } from "./onebot.mjs";
import { Recorder, doctor, replyCase } from "./runner.mjs";

function scope(config) {
  return {
    connectionId: config.runtime.connectionId,
    botId: config.bot.qq,
    chatType: "private",
    chatId: config.driver.qq,
    senderId: config.driver.qq,
    threadId: config.runtime.threadId ?? null,
  };
}

export function finalizeTasteRecoveryTransport(report, recorder) {
  report.status = report.result.status;
  if (recorder && recorder.finalize() !== "PASS") {
    report.status = "INCONCLUSIVE";
    report.result = {
      ...report.result,
      status: "INCONCLUSIVE",
      requiresReconciliation: true,
      error: { code: "TASTE_RECOVERY_LATE_TRANSPORT_ANOMALY" },
    };
  }
}

function sealCheckpointRow(row) {
  delete row.checkpointSha256;
  row.checkpointSha256 = digest(JSON.stringify(row));
  return row;
}

async function syncDirectory(path) {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function readStopFingerprint(path) {
  try {
    const bytes = await readFile(path);
    return digest(bytes);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    fail("TASTE_RECOVERY_STOP", "无法核实测试停止文件。", "INCONCLUSIVE");
  }
}

async function takeProcessLock(path, processIdentity, code) {
  let handle;
  try {
    handle = await open(path, "wx", 0o600);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    let oldInfo;
    let old;
    try {
      oldInfo = await lstat(path);
      if (!oldInfo.isFile() || oldInfo.isSymbolicLink()) throw new Error("invalid lock file");
      const bytes = await readFile(path, "utf8");
      if (bytes.length > 2048) throw new Error("lock file too large");
      old = JSON.parse(bytes);
    } catch {
      fail(code, "偏好恢复锁无法核实。", "BLOCKED");
    }
    if (!old?.process) fail(code, "偏好恢复锁缺少进程身份。", "BLOCKED");
    await verifyMemoryProcessStopped(old.process);
    await rm(path);
    await syncDirectory(dirname(path));
    try {
      handle = await open(path, "wx", 0o600);
    } catch {
      fail(code, "偏好恢复锁被其他进程取得。", "BLOCKED");
    }
  }
  try {
    await handle.writeFile(JSON.stringify({ pid: process.pid, process: processIdentity }));
    await handle.sync();
  } catch (error) {
    await handle.close();
    await rm(path, { force: true });
    await syncDirectory(dirname(path));
    throw error;
  }
  return handle;
}

async function releaseProcessLock(path, handle, processIdentity) {
  await handle?.close();
  let info;
  let current;
  try {
    info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) return;
    current = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  if (
    current.pid !== process.pid ||
    JSON.stringify(current.process) !== JSON.stringify(processIdentity)
  )
    return;
  await rm(path);
  await syncDirectory(dirname(path));
}

export async function runTasteRecoveryCli(config, options, out) {
  if (
    !config.runtime ||
    config.memoryFixtures?.enabled !== true ||
    config.memoryFixtures?.retainAuditConfirmed !== true
  )
    fail("MEMORY_FIXTURE_DISABLED", "偏好恢复需要启用固定测试并保留审计记录。");
  if (options.case || options.scenarios) fail("ARGUMENT", "偏好恢复命令不接受自定义消息或用例。");
  const lockRoot = join(homedir(), ".glassbox-qq-live-locks");
  await mkdir(lockRoot, { recursive: true, mode: 0o700 });
  const accountKey = digest(config.driver.qq).slice(0, 24);
  const pendingPath = join(lockRoot, `${accountKey}.taste-pending.json`);
  const lockPath = join(lockRoot, `${accountKey}.lock`);
  const tasteLockPath = join(lockRoot, `${accountKey}.taste-recovery.lock`);
  const advisoryPath = join(lockRoot, `${accountKey}.taste-recovery.sqlite`);
  const advisory = new DatabaseSync(advisoryPath);
  let tasteLock;
  let accountLock;
  let tasteLockOwned = false;
  let accountLockOwned = false;
  let recoveryProcess;
  let clients;
  let recorder;
  let timer;
  const unsubscribe = [];
  const controller = new AbortController();
  const stopPath = join(out, "STOP");
  const initialStop = await readStopFingerprint(stopPath);
  const checkStop = async () => {
    if ((await readStopFingerprint(stopPath)) !== initialStop) controller.abort();
    if (controller.signal.aborted)
      fail("TASTE_RECOVERY_CANCELLED", "偏好恢复已停止，测试资源仍需核实。", "INCONCLUSIVE");
  };
  const stop = () => controller.abort();
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  let report;
  let reportDirectory;
  try {
    try {
      advisory.exec(
        "PRAGMA busy_timeout=0; CREATE TABLE IF NOT EXISTS lock(id INTEGER PRIMARY KEY); BEGIN IMMEDIATE;",
      );
    } catch {
      fail("RUN_LOCKED", "该账号已有偏好恢复核验进程。", "BLOCKED");
    }
    const runtime = runtimeInspectionSnapshot(config.runtime);
    const record = await readTasteCheckpointRecord({
      pendingPath,
      outDirectory: out,
      runtime,
      scope: scope(config),
      driverQQ: config.driver.qq,
    });
    const sourceProcesses = new Map();
    for (const row of record.rows) {
      const identity = row.origin?.process;
      if (identity) sourceProcesses.set(JSON.stringify(identity), identity);
      const previousRecovery = row.recoveryAttempt?.process;
      if (previousRecovery) sourceProcesses.set(JSON.stringify(previousRecovery), previousRecovery);
    }
    if (!sourceProcesses.size)
      fail("TASTE_RECOVERY_PROCESS_UNKNOWN", "没有可核验的原测试进程身份。", "INCONCLUSIVE");
    recoveryProcess = await captureMemoryProcess();
    const verifyStopped = async () => {
      for (const identity of sourceProcesses.values()) await verifyMemoryProcessStopped(identity);
      return { stopped: true };
    };
    const inspect = () => {
      const db = new DatabaseSync(join(runtime.dataDirectory, "glassbox.db"), { readOnly: true });
      try {
        return observeTasteRecoveryFixture(db, record);
      } finally {
        db.close();
      }
    };
    const observation = inspect();
    const runtimeIdentity = runtimeInspectionSnapshot(config.runtime);
    if (JSON.stringify(runtimeIdentity) !== JSON.stringify(runtime))
      fail("RUNTIME_VERSION", "偏好恢复读取期间服务身份发生变化。", "INCONCLUSIVE");
    const planResult = (await import("./taste-recovery.mjs")).tasteRecoveryPlan(
      record,
      observation,
      runtime,
    );
    if (options.live !== true) {
      console.log(
        JSON.stringify(
          {
            ...planResult,
            observation,
            cleanupOnly: true,
            note: "只核实未完成偏好流程并生成固定清理计划，没有发送清理消息。",
          },
          null,
          2,
        ),
      );
      process.exitCode = observation.status === "CLEANED" ? 0 : 2;
      return;
    }
    if (options["approve-suite"] !== planResult?.sha256)
      fail("TASTE_RECOVERY_APPROVAL_REQUIRED", "先审阅恢复计划，再传入其 SHA256。", "BLOCKED");
    accountLock = await takeProcessLock(lockPath, recoveryProcess, "RUN_LOCKED");
    accountLockOwned = true;
    tasteLock = await takeProcessLock(tasteLockPath, recoveryProcess, "TASTE_RECOVERY_LOCKED");
    tasteLockOwned = true;
    await mkdir(out, { recursive: true, mode: 0o700 });
    reportDirectory = join(out, `taste_recovery_${randomUUID().replaceAll("-", "")}`);
    await mkdir(reportDirectory, { recursive: true, mode: 0o700 });
    report = {
      mode: "reconcile-taste",
      cleanupOnly: true,
      runtime,
      sourceRunId: record.pending.runId,
      sourceCheckpointSha256: record.pending.checkpointSha256,
      startedAt: new Date().toISOString(),
      status: "INCONCLUSIVE",
      cases: [],
    };
    await open(join(reportDirectory, "attempt.json"), "wx", 0o600).then(async (f) => {
      try {
        await f.writeFile(JSON.stringify({ status: "STARTED", startedAt: report.startedAt }));
        await f.sync();
      } finally {
        await f.close();
      }
    });
    const eventPath = join(reportDirectory, "events.jsonl");
    const acceptance = await acceptanceManagement(config.runtime);
    timer = setInterval(() => {
      checkStop().catch(stop);
    }, 250);
    let latestRow = record.rows.at(-1);
    let journalRecord = record;
    let activeRecovery;
    const checkpoint = async (state) => {
      const row = {
        ...latestRow,
        sequence: latestRow.sequence + 1,
        previousSha256: latestRow.checkpointSha256,
        phase: state.phase,
        handles: state.handles ?? latestRow.handles,
        at: new Date().toISOString(),
        recoveryAttempt: {
          action: state.action ?? activeRecovery?.action,
          planSha256: state.planSha256 ?? planResult.sha256,
          process: recoveryProcess,
          ...(state.phase === "recovery_observed"
            ? { cleanupRunId: state.handles?.cleanupRunId }
            : {}),
        },
      };
      sealCheckpointRow(row);
      await writeTasteCheckpoint({
        pendingPath,
        journalPath: join(record.reportDirectory, "taste-fixture.jsonl"),
        row,
        first: false,
      });
      latestRow = row;
      journalRecord = {
        ...journalRecord,
        pending: row,
        rows: [...journalRecord.rows, row],
      };
      return { confirmed: true };
    };
    acceptance.beforeRegister = async (c) => {
      activeRecovery = { action: latestRow.recoveryAttempt?.action ?? activeRecovery?.action };
      const row = {
        ...latestRow,
        phase: "recovery_prepared",
        recoveryAttempt: {
          action: activeRecovery.action,
          planSha256: planResult.sha256,
          process: recoveryProcess,
        },
        preparedCase: {
          caseId: c.id,
          marker: c.token,
          textSha256: digest(c.prompt),
          startedAt: c.startedAt,
          route: c.route,
        },
      };
      row.sequence = latestRow.sequence + 1;
      row.previousSha256 = latestRow.checkpointSha256;
      row.at = new Date().toISOString();
      sealCheckpointRow(row);
      await writeTasteCheckpoint({
        pendingPath,
        journalPath: join(record.reportDirectory, "taste-fixture.jsonl"),
        row,
        first: false,
      });
      latestRow = row;
      journalRecord = { ...journalRecord, pending: row, rows: [...journalRecord.rows, row] };
      return { confirmed: true };
    };
    acceptance.beforeSend = async (c, lease) => {
      const registration = {
        ...latestRow,
        sequence: latestRow.sequence + 1,
        previousSha256: latestRow.checkpointSha256,
        at: new Date().toISOString(),
        preparedCase: {
          ...latestRow.preparedCase,
          leaseId: lease.leaseId,
          expiresAt: lease.expiresAt,
          toolsSha256: lease.toolsSha256,
        },
      };
      sealCheckpointRow(registration);
      await writeTasteCheckpoint({
        pendingPath,
        journalPath: join(record.reportDirectory, "taste-fixture.jsonl"),
        row: registration,
        first: false,
      });
      latestRow = registration;
      journalRecord = {
        ...journalRecord,
        pending: registration,
        rows: [...journalRecord.rows, registration],
      };
      return { confirmed: true };
    };
    acceptance.afterSend = async (c) => {
      const row = {
        ...latestRow,
        sequence: latestRow.sequence + 1,
        previousSha256: latestRow.checkpointSha256,
        phase: "recovery_prepared",
        at: new Date().toISOString(),
        sentCase: { caseId: c.id, driverMessageId: c.sentMessageId, startedAt: c.startedAt },
      };
      sealCheckpointRow(row);
      await writeTasteCheckpoint({
        pendingPath,
        journalPath: join(record.reportDirectory, "taste-fixture.jsonl"),
        row,
        first: false,
      });
      latestRow = row;
      journalRecord = { ...journalRecord, pending: row, rows: [...journalRecord.rows, row] };
      return { confirmed: true };
    };
    report.result = await reconcileTasteFixture({
      record,
      observation,
      runtime,
      approvedPlanSha256: options["approve-suite"],
      signal: controller.signal,
      verifyStopped,
      revokeMarker: (marker) => acceptance.revokeMarker(marker),
      checkpoint,
      readRuntime: async () => runtimeInspectionSnapshot(config.runtime),
      executeCleanup: async (action, spec) => {
        activeRecovery = { action };
        await checkStop();
        if (JSON.stringify(runtimeSnapshot(config.runtime)) !== JSON.stringify(runtime))
          fail("RUNTIME_VERSION", "恢复前服务版本或进程发生变化。", "INCONCLUSIVE");
        if (!clients) {
          clients = { driver: new OneBot(config, "driver"), bot: new OneBot(config, "bot") };
          recorder = new Recorder(config, [clients.driver.token, clients.bot.token]);
          recorder.onEvent = (event) =>
            appendFileSync(eventPath, `${JSON.stringify(event)}\n`, { mode: 0o600 });
          await clients.driver.connect();
          await clients.bot.connect();
          unsubscribe.push(
            clients.driver.subscribe((event) => recorder.ingest("driver", event)),
            clients.bot.subscribe((event) => recorder.ingest("bot", event)),
          );
        }
        await doctor({ ...config, groups: [] }, clients);
        const currentRuntime = runtimeSnapshot(config.runtime);
        if (JSON.stringify(currentRuntime) !== JSON.stringify(runtime))
          fail("RUNTIME_VERSION", "恢复发送前服务版本或进程发生变化。", "INCONCLUSIVE");
        const transportCase = await replyCase(
          config,
          clients,
          recorder,
          spec,
          controller.signal,
          acceptance,
        );
        recorder.finalize();
        report.cases.push(transportCase);
        if (transportCase.status !== "PASS") return { transportCase };
        const productAcceptance = await verifyProductEvidence(
          { mode: "run", status: "PASS", runtime, cases: [transportCase] },
          config,
          clients,
        );
        const evidence = productAcceptance.cases?.[0];
        if (evidence?.cleanupVerified !== true)
          fail("TASTE_RECOVERY_CLEANUP", "偏好恢复 Run 缺少独立许可清理证据。", "INCONCLUSIVE");
        transportCase.runId = evidence.runId;
        return { transportCase, productAcceptance };
      },
      verifyCleanup: async (action, execution, handles) => {
        if (action === "final") {
          const latest = await readTasteCheckpointRecord({
            pendingPath,
            outDirectory: out,
            runtime,
            scope: scope(config),
            driverQQ: config.driver.qq,
          });
          const db = new DatabaseSync(join(runtime.dataDirectory, "glassbox.db"), {
            readOnly: true,
          });
          try {
            return observeTasteRecoveryFixture(db, latest);
          } finally {
            db.close();
          }
        }
        const transportCase = execution?.transportCase;
        const evidence = execution?.productAcceptance?.cases?.[0];
        if (
          transportCase?.status !== "PASS" ||
          execution?.productAcceptance?.status !== "PASS" ||
          evidence?.cleanupVerified !== true ||
          !evidence.runId
        )
          return { status: "INCONCLUSIVE" };
        const cleanupHandles = { ...handles, cleanupRunId: evidence.runId };
        const pending = {
          ...journalRecord.pending,
          phase: "recovery_observed",
          handles: cleanupHandles,
          recoveryAttempt: {
            action,
            planSha256: planResult.sha256,
            cleanupRunId: evidence.runId,
          },
        };
        const db = new DatabaseSync(join(runtime.dataDirectory, "glassbox.db"), { readOnly: true });
        try {
          const observed = observeTasteRecoveryFixture(db, { ...journalRecord, pending });
          const expectedStatus = action === "reject-correction" ? "NEEDS_CLEANUP" : "CLEANED";
          return observed.status === expectedStatus
            ? { status: "PASS", runId: evidence.runId, observation: observed }
            : { status: "INCONCLUSIVE" };
        } finally {
          db.close();
        }
      },
    });
    if (clients)
      await Promise.all([
        Promise.resolve(clients.driver.closeAndDrain()),
        Promise.resolve(clients.bot.closeAndDrain()),
      ]);
    for (const off of unsubscribe.splice(0)) off();
    finalizeTasteRecoveryTransport(report, recorder);
    report.finishedAt = new Date().toISOString();
    report.reportDirectory = reportDirectory;
    await open(join(reportDirectory, "report.json"), "wx", 0o600).then(async (file) => {
      try {
        await file.writeFile(JSON.stringify(report, null, 2) + "\n");
        await file.sync();
      } finally {
        await file.close();
      }
    });
    await syncDirectory(reportDirectory);
    await syncDirectory(out);
    if (report.status === "CLEANED" && report.result.requiresReconciliation === false) {
      const finalRuntime = runtimeInspectionSnapshot(config.runtime);
      const latest = await readTasteCheckpointRecord({
        pendingPath,
        outDirectory: out,
        runtime,
        scope: scope(config),
        driverQQ: config.driver.qq,
      });
      const finalObservation = (() => {
        const db = new DatabaseSync(join(runtime.dataDirectory, "glassbox.db"), { readOnly: true });
        try {
          return observeTasteRecoveryFixture(db, latest);
        } finally {
          db.close();
        }
      })();
      if (
        JSON.stringify(finalRuntime) !== JSON.stringify(runtime) ||
        finalObservation.status !== "CLEANED" ||
        finalObservation.activeCount !== 0 ||
        finalObservation.pendingCount !== 0
      )
        fail(
          "TASTE_RECOVERY_FINAL_EVIDENCE",
          "整族偏好资源清理未通过最终独立核验。",
          "INCONCLUSIVE",
        );
      await rm(pendingPath);
      await syncDirectory(lockRoot);
      console.log(`CLEANED 恢复报告位于 ${reportDirectory}。这只证明清理，不代表验收通过。`);
      process.exitCode = 0;
    } else {
      if (initialStop === null)
        await import("node:fs/promises").then(({ writeFile }) =>
          writeFile(stopPath, "TASTE_CLEANUP_UNCONFIRMED\n请先核实报告和固定测试资源。\n", {
            mode: 0o600,
          }),
        );
      console.log(
        JSON.stringify({ status: report.status, reportDirectory, cleanupOnly: true }, null, 2),
      );
      process.exitCode = 3;
    }
  } catch (error) {
    if (report && reportDirectory) {
      report.error = safeError(error);
      report.status = "INCONCLUSIVE";
      report.finishedAt = new Date().toISOString();
      await import("node:fs/promises").then(({ writeFile }) =>
        writeFile(join(reportDirectory, "failure.json"), JSON.stringify(report, null, 2) + "\n", {
          mode: 0o600,
        }),
      );
      if (initialStop === null)
        await import("node:fs/promises").then(({ writeFile }) =>
          writeFile(stopPath, "TASTE_CLEANUP_UNCONFIRMED\n请先核实报告和固定测试资源。\n", {
            mode: 0o600,
          }),
        );
    }
    throw error;
  } finally {
    clearInterval(timer);
    for (const off of unsubscribe) off();
    clients?.driver.close();
    clients?.bot.close();
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    try {
      if (tasteLockOwned) await releaseProcessLock(tasteLockPath, tasteLock, recoveryProcess);
      else await tasteLock?.close();
      if (accountLockOwned) await releaseProcessLock(lockPath, accountLock, recoveryProcess);
      else await accountLock?.close();
    } finally {
      try {
        advisory.exec("ROLLBACK;");
      } catch {}
      advisory.close();
    }
  }
}
