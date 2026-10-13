import { readFile, open, mkdir, rm, chmod, lstat } from "node:fs/promises";
import { appendFileSync, createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { fail, digest, safeError } from "./core.mjs";
import { captureMemoryProcess, verifyMemoryProcessStopped } from "./memory-process.mjs";
import { writeMemoryCheckpoint } from "./memory-checkpoint.mjs";
import {
  runtimeInspectionSnapshot,
  runtimeSnapshot,
  readTraceEvents,
  verifyProductEvidence,
} from "./product-evidence.mjs";
import { acceptanceManagement } from "./management-client.mjs";
import { Recorder, doctor, replyCase } from "./runner.mjs";
import { OneBot } from "./onebot.mjs";
import { verifyMemoryCleanup } from "./memory-fixture.mjs";
import { readMemoryRecoveryRecord } from "./memory-recovery-record.mjs";
import { observeMemoryRecovery } from "./memory-recovery-observer.mjs";
import { reconcileMemoryFixture, memoryRecoveryPlan } from "./memory-recovery.mjs";

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

function markers(record) {
  return new Set(
    record.rows
      .flatMap((row) => [row.preparedCase?.marker, row.recoveryAttempt?.preparedCase?.marker])
      .filter(Boolean),
  );
}

async function audits(dataDirectory, wanted) {
  const path = join(dataDirectory, "qq-live-acceptance-audit.jsonl");
  const info = await lstat(path);
  if (!info.isFile() || info.size > 32 * 1024 * 1024)
    fail("RECOVERY_AUDIT_LIMIT", "测试许可审计超过核实范围。", "INCONCLUSIVE");
  const input = createReadStream(path);
  const lines = createInterface({ input, crlfDelay: Infinity });
  const selected = [],
    leases = new Set();
  try {
    for await (const line of lines) {
      if (line.length > 32768) fail("RECOVERY_AUDIT_LIMIT", "测试许可审计行过大。", "INCONCLUSIVE");
      if (!line.trim()) continue;
      let row;
      try {
        row = JSON.parse(line);
      } catch {
        fail("RECOVERY_AUDIT_JSON", "测试许可审计不完整。", "INCONCLUSIVE");
      }
      if (wanted.has(row.marker) || leases.has(row.leaseId)) {
        if (row.leaseId) leases.add(row.leaseId);
        selected.push(row);
        if (selected.length > 200)
          fail("RECOVERY_AUDIT_LIMIT", "本轮许可审计存在过多记录。", "INCONCLUSIVE");
      }
    }
  } finally {
    lines.close();
    input.destroy();
  }
  return selected;
}

async function stopped(record) {
  const identities = [
    record.origin.process,
    ...record.rows.map((r) => r.recoveryAttempt?.process).filter(Boolean),
  ];
  const seen = new Set();
  for (const identity of identities) {
    const key = JSON.stringify(identity);
    if (seen.has(key)) continue;
    seen.add(key);
    await verifyMemoryProcessStopped(identity);
  }
  return { stopped: true };
}

async function takeAccountLock(path, identity, record) {
  let handle;
  try {
    handle = await open(path, "wx", 0o600);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const oldInfo = await lstat(path);
    if (!oldInfo.isFile() || oldInfo.isSymbolicLink()) fail("RUN_LOCKED", "测试锁不是普通文件。");
    const bytes = await readFile(path, "utf8");
    if (bytes.length > 2048) fail("RUN_LOCKED", "测试锁无法核实。");
    let old;
    try {
      old = JSON.parse(bytes);
    } catch {
      fail("RUN_LOCKED", "测试锁不完整。");
    }
    if (old.process) await verifyMemoryProcessStopped(old.process);
    else {
      const known = [
        record.origin.process,
        ...record.rows.map((r) => r.recoveryAttempt?.process).filter(Boolean),
      ];
      if (!known.some((p) => p.pid === old.pid))
        fail("RUN_LOCKED", "旧测试锁不属于本轮已核实进程。");
      try {
        process.kill(old.pid, 0);
        fail("RUN_LOCKED", "旧 PID 仍有进程，未删除测试锁。");
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
    }
    const currentInfo = await lstat(path);
    if (
      oldInfo.ino !== currentInfo.ino ||
      oldInfo.dev !== currentInfo.dev ||
      (await readFile(path, "utf8")) !== bytes
    )
      fail("RUN_LOCKED", "核实期间测试锁发生变化。");
    await rm(path);
    handle = await open(path, "wx", 0o600);
  }
  try {
    await handle.writeFile(
      JSON.stringify({ pid: identity.pid, process: identity, startedAt: new Date().toISOString() }),
    );
    await handle.sync();
  } catch (error) {
    await handle.close();
    throw error;
  }
  return handle;
}

async function syncDirectory(path) {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function releaseRecoveryLock(path, handle) {
  const owned = await handle.stat();
  const current = await lstat(path);
  if (!current.isFile() || owned.ino !== current.ino || owned.dev !== current.dev)
    fail("RUN_LOCKED", "测试锁已被替换，保留当前锁文件。", "INCONCLUSIVE");
  await rm(path);
}

export async function recoveryStopFingerprint(path) {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.size > 16384)
      fail("RECOVERY_STOP", "停止文件无法核实，未执行恢复。", "INCONCLUSIVE");
    return `${info.ino}:${info.mtimeMs}:${info.size}:${digest(await readFile(path))}`;
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

export function recoveryCheckpointState(state) {
  if (!["recovery_prepared", "recovery_cleaned"].includes(state?.phase))
    fail("RECOVERY_CHECKPOINT", "恢复检查点阶段无效。", "INCONCLUSIVE");
  const handles = {};
  for (const key of [
    "fixtureNonce",
    "projectId",
    "principalId",
    "candidateId",
    "creationRunId",
    "promoteRunId",
    "memoryId",
  ])
    if (state.handles?.[key] !== undefined) handles[key] = state.handles[key];
  return {
    stage: state.stage,
    handles,
    phase: state.phase === "recovery_prepared" ? "before_send" : "observed",
    ...(state.phase === "recovery_cleaned" ? { cleanupRunId: state.cleanupRunId } : {}),
  };
}

export async function runMemoryRecoveryCli(config, options, out) {
  if (
    !config.runtime ||
    config.memoryFixtures?.enabled !== true ||
    config.memoryFixtures?.retainAuditConfirmed !== true
  )
    fail("MEMORY_FIXTURE_DISABLED", "恢复需要已启用的固定记忆测试配置。");
  if (options.case || options.scenarios) fail("ARGUMENT", "恢复命令不接受自定义消息或用例。");
  const stopPath = join(out, "STOP");
  const originalStop = await recoveryStopFingerprint(stopPath);
  const identity = await captureMemoryProcess();
  const lockRoot = join(homedir(), ".glassbox-qq-live-locks");
  await mkdir(lockRoot, { recursive: true, mode: 0o700 });
  const accountKey = digest(config.driver.qq).slice(0, 24);
  const pendingPath = join(lockRoot, `${accountKey}.memory-pending.json`);
  const lockPath = join(lockRoot, `${accountKey}.lock`);
  // The kernel releases SQLite's writer lock after a crashed recovery process.
  const advisoryPath = join(lockRoot, `${accountKey}.recovery-lock.sqlite`);
  const advisory = new DatabaseSync(advisoryPath);
  let accountLock,
    clients,
    recorder,
    unsubscribe = [],
    timer;
  const controller = new AbortController();
  const stop = () => controller.abort();
  const checkStop = async () => {
    if ((await recoveryStopFingerprint(stopPath)) !== originalStop) stop();
    if (controller.signal.aborted)
      fail("RECOVERY_CANCELLED", "恢复已停止，未继续执行清理。", "INCONCLUSIVE");
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  let report, reportDir;
  try {
    await chmod(advisoryPath, 0o600);
    try {
      advisory.exec(
        "PRAGMA busy_timeout=0; CREATE TABLE IF NOT EXISTS recovery_lock(id INTEGER PRIMARY KEY); BEGIN IMMEDIATE;",
      );
    } catch {
      fail("RUN_LOCKED", "该账号已有恢复核实进程，未并发执行。");
    }
    const runtime = runtimeInspectionSnapshot(config.runtime);
    let record = await readMemoryRecoveryRecord({
      pendingPath,
      driverQQ: config.driver.qq,
      scope: scope(config),
      runtime,
    });
    await stopped(record);
    let latestRow = record.rows.at(-1),
      guardSha256 = record.pending.checkpointSha256;
    const inspect = async () => {
      const auditEvents = await audits(runtime.dataDirectory, markers(record));
      const runIds = new Set(auditEvents.map((a) => a.runId).filter(Boolean));
      for (const row of record.rows)
        for (const key of ["stepRunId", "creationRunId", "promoteRunId", "cleanupRunId"])
          if (row.handles?.[key]) runIds.add(row.handles[key]);
      for (const row of record.rows)
        if (row.recoveryAttempt?.cleanupRunId) runIds.add(row.recoveryAttempt.cleanupRunId);
      if (runIds.size > 12)
        fail("RECOVERY_RUN_LIMIT", "恢复需要核实的 Run 数量超过限制。", "INCONCLUSIVE");
      const eventsByRun = {};
      for (const runId of runIds) {
        if (!/^[A-Za-z0-9_-]{1,128}$/.test(runId))
          fail("RECOVERY_RUN_ID", "审计 Run 标识无效。", "INCONCLUSIVE");
        const trace = readTraceEvents(runtime.checkout, runtime.dataDirectory, runId, undefined, [
          "tool_call",
          "tool_result",
          "run_finished",
        ]);
        if (trace.runId !== runId || !Array.isArray(trace.events))
          fail("RECOVERY_TRACE", "恢复 Trace 与 Run 不一致。", "INCONCLUSIVE");
        eventsByRun[runId] = trace.events.map((r) => r.event);
      }
      const db = new DatabaseSync(join(runtime.dataDirectory, "glassbox.db"), { readOnly: true });
      try {
        return observeMemoryRecovery(db, { record, auditEvents, eventsByRun });
      } finally {
        db.close();
      }
    };
    const observation = await inspect();
    const plan =
      observation.status === "NEEDS_CLEANUP"
        ? memoryRecoveryPlan(record, observation, runtime)
        : null;
    if (options.live !== true) {
      console.log(
        JSON.stringify(
          {
            ...plan,
            observation,
            cleanupOnly: true,
            note: "只完成恢复核实与计划，没有发送、撤销许可或清除未完成记录。",
          },
          null,
          2,
        ),
      );
      process.exitCode = observation.status === "CLEANED" ? 0 : 2;
      return;
    }
    timer = setInterval(() => {
      checkStop().catch(stop);
    }, 250);
    accountLock = await takeAccountLock(lockPath, identity, record);
    const attemptId = randomUUID().replaceAll("-", "");
    reportDir = join(out, `recovery_${attemptId}`);
    await mkdir(reportDir, { recursive: true, mode: 0o700 });
    report = {
      mode: "reconcile-memory",
      cleanupOnly: true,
      runtime,
      sourceRunId: record.runId,
      sourceRecordSha256: guardSha256,
      startedAt: new Date().toISOString(),
      cases: [],
      status: "INCONCLUSIVE",
    };
    const acceptance = await acceptanceManagement(config.runtime);
    let recoveryState;
    const checkpoint = async (state) => {
      const row = {
        ...latestRow,
        sequence: latestRow.sequence + 1,
        previousSha256: latestRow.checkpointSha256,
        at: new Date().toISOString(),
        recoveryAttempt: { attemptId, process: identity, currentRuntime: runtime, ...state },
      };
      delete row.checkpointSha256;
      row.checkpointSha256 = digest(JSON.stringify(row));
      await writeMemoryCheckpoint({
        pendingPath,
        journalPath: join(record.reportDirectory, "memory-fixture.jsonl"),
        row,
        first: false,
      });
      latestRow = row;
      guardSha256 = row.checkpointSha256;
      recoveryState = state;
      record = {
        ...record,
        pending: row,
        rows: [...record.rows, row],
        confirmedSequence: row.sequence,
      };
      return { confirmed: true };
    };
    acceptance.beforeRegister = async (c) => {
      await checkStop();
      return checkpoint({
        ...recoveryState,
        phase: "lease_intent",
        preparedCase: {
          caseId: c.id,
          marker: c.token,
          textSha256: digest(c.prompt),
          startedAt: c.startedAt,
          route: c.route,
        },
      });
    };
    acceptance.beforeSend = async (c, lease) => {
      await checkStop();
      const rows = await audits(runtime.dataDirectory, new Set([c.token]));
      const registrations = rows.filter(
        (a) =>
          a.event === "lease_registered" && a.leaseId === lease.leaseId && a.marker === c.token,
      );
      if (
        registrations.length !== 1 ||
        registrations[0].principalId !== observation.handles?.principalId
      )
        fail("RECOVERY_OWNER_CHANGED", "恢复许可没有确认原 Owner 身份。", "INCONCLUSIVE");
      await checkpoint({
        ...recoveryState,
        phase: "prepared",
        preparedCase: {
          caseId: c.id,
          marker: c.token,
          textSha256: digest(c.prompt),
          startedAt: c.startedAt,
          route: c.route,
          leaseId: lease.leaseId,
          expiresAt: lease.expiresAt,
          toolsSha256: lease.toolsSha256,
        },
      });
      await checkStop();
    };
    acceptance.afterSend = async (c) =>
      checkpoint({
        ...recoveryState,
        phase: "sent",
        sentCase: { caseId: c.id, driverMessageId: c.sentMessageId, startedAt: c.startedAt },
      });
    report.result = await reconcileMemoryFixture({
      record,
      runtime,
      approvedPlanSha256: options["approve-suite"],
      signal: controller.signal,
      verifyStopped: stopped,
      revokeMarker: (marker) => acceptance.revokeMarker(marker),
      observe: inspect,
      checkpoint: async (state) => checkpoint(recoveryCheckpointState(state)),
      executeCleanup: async (stage, spec) => {
        const current = runtimeSnapshot(config.runtime);
        if (JSON.stringify(current) !== JSON.stringify(runtime))
          fail("RUNTIME_VERSION", "核实后恢复服务发生变化。");
        clients = { driver: new OneBot(config, "driver"), bot: new OneBot(config, "bot") };
        recorder = new Recorder(config, [clients.driver.token, clients.bot.token]);
        report.cases = recorder.cases;
        recorder.onEvent = (e) =>
          appendFileSync(join(reportDir, "events.jsonl"), `${JSON.stringify(e)}\n`, {
            mode: 0o600,
          });
        await clients.driver.connect();
        await clients.bot.connect();
        unsubscribe = [
          clients.driver.subscribe((e) => recorder.ingest("driver", e)),
          clients.bot.subscribe((e) => recorder.ingest("bot", e)),
        ];
        await doctor({ ...config, groups: [] }, clients);
        await checkStop();
        const transportCase = await replyCase(
          config,
          clients,
          recorder,
          spec,
          controller.signal,
          acceptance,
        );
        recorder.finalize();
        if (transportCase.status !== "PASS") return { transportCase };
        const productAcceptance = await verifyProductEvidence(
          { mode: "run", status: "PASS", runtime, cases: [transportCase] },
          config,
          clients,
        );
        return {
          transportCase,
          productAcceptance,
          successfulRun: productAcceptance.cases?.[0]?.runId,
        };
      },
      verifyCleanup: async (handles) => {
        const db = new DatabaseSync(join(runtime.dataDirectory, "glassbox.db"), { readOnly: true });
        try {
          const owner = db
            .prepare("SELECT kind FROM principals WHERE id=?")
            .get(handles.principalId);
          if (owner?.kind !== "owner")
            fail("RECOVERY_OWNER_CHANGED", "清理证据中的身份不是 Owner。", "INCONCLUSIVE");
          return { ...verifyMemoryCleanup(db, handles), principalKind: owner.kind };
        } finally {
          db.close();
        }
      },
    });
    report.status = report.result.status;
    if (recorder && recorder.finalize() !== "PASS") {
      report.status = "INCONCLUSIVE";
      report.result = {
        ...report.result,
        status: "INCONCLUSIVE",
        requiresReconciliation: true,
        error: { code: "RECOVERY_LATE_TRANSPORT_ANOMALY" },
      };
    }
    if (report.result.status === "CLEANED" && report.result.requiresReconciliation === false) {
      record = await readMemoryRecoveryRecord({
        pendingPath,
        driverQQ: config.driver.qq,
        scope: scope(config),
        runtime,
      });
      const finalObservation = await inspect();
      if (
        finalObservation.status !== "CLEANED" ||
        finalObservation.handles?.cleanupRunId !== report.result.cleanupRunId
      )
        fail(
          "RECOVERY_FINAL_EVIDENCE",
          "清理后的独立记录和状态核实未通过，保留未完成记录。",
          "INCONCLUSIVE",
        );
    }
    report.finishedAt = new Date().toISOString();
    const reportHandle = await open(join(reportDir, "report.json"), "wx", 0o600);
    try {
      await reportHandle.writeFile(JSON.stringify(report, null, 2) + "\n");
      await reportHandle.sync();
    } finally {
      await reportHandle.close();
    }
    await syncDirectory(reportDir);
    await syncDirectory(out);
    if (report.result.status === "CLEANED" && report.result.requiresReconciliation === false) {
      const finalRuntime = runtimeInspectionSnapshot(config.runtime);
      if (JSON.stringify(finalRuntime) !== JSON.stringify(runtime))
        fail("RUNTIME_VERSION", "清理期间服务发生变化，保留未完成记录。");
      const currentGuard = JSON.parse(await readFile(pendingPath, "utf8"));
      if (currentGuard.checkpointSha256 !== guardSha256)
        fail("RECOVERY_GUARD_CHANGED", "清理期间未完成记录发生变化。");
      await rm(pendingPath);
      await syncDirectory(lockRoot);
      console.log(
        `CLEANED 恢复报告位于 ${reportDir}。仅证明本轮测试资源清理，不代表实机验收通过。`,
      );
      process.exitCode = 0;
    } else {
      console.log(
        JSON.stringify(
          {
            status: report.status,
            result: report.result,
            reportDirectory: reportDir,
            cleanupOnly: true,
          },
          null,
          2,
        ),
      );
      process.exitCode = report.status === "BLOCKED" ? 2 : 3;
    }
  } catch (error) {
    if (report && reportDir) {
      report.error = safeError(error);
      report.status = "INCONCLUSIVE";
      report.finishedAt = new Date().toISOString();
      const handle = await open(join(reportDir, "failure.json"), "wx", 0o600);
      try {
        await handle.writeFile(JSON.stringify(report, null, 2) + "\n");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await syncDirectory(reportDir);
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
      if (accountLock) {
        try {
          await releaseRecoveryLock(lockPath, accountLock);
        } finally {
          await accountLock.close();
        }
      }
    } finally {
      try {
        advisory.exec("ROLLBACK;");
      } catch {}
      advisory.close();
    }
  }
}
