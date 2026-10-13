import test from "node:test";
import assert from "node:assert/strict";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { mediaFixtureStep, MEDIA_FAMILY_ID } from "../lib/media-scenario.mjs";
import { toolManifestDigest } from "../lib/core.mjs";
import {
  planMediaImageRecovery,
  mediaRecoveryPlanBinding,
  verifyActiveMediaRecoveryPlanBinding,
} from "../lib/media-recovery.mjs";
import { baseConfig } from "./fixture.mjs";
import {
  runAcceptanceMemoryReconciliationCli,
  verifyAcceptanceMemoryReconciliationReceipt,
  hasUnresolvedAcceptanceMemoryReconciliation,
  verifyAcceptanceMemoryCandidateStates,
  verifyAcceptanceMemoryLearningIsolation,
} from "../lib/acceptance-memory-reconciliation.mjs";
import {
  acceptanceMemoryInventorySha256,
  buildAcceptanceMemoryCleanupPlan,
} from "../lib/acceptance-memory-cleanup-plan.mjs";
import { buildPreRunReplacementStopEvidence } from "../lib/pre-run-stop-reconciliation.mjs";

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
function hash(text) {
  return createHash("sha256").update(text).digest("hex");
}

const PRE_RUN_STOP =
  "CLEANUP_UNCONFIRMED\n请先检查 Bot 的延迟任务、目标状态和本轮报告，再人工删除此文件。\n";

async function fixture(
  t,
  { stopContent = '{"status":"INCONCLUSIVE"}\n', accountBoundGuard = false } = {},
) {
  const out = await mkdtemp(join(tmpdir(), "memory-reconcile-"));
  t.after(() => rm(out, { recursive: true, force: true }));
  await chmod(out, 0o700);
  const config = baseConfig();
  const locksDirectory = join(out, "locks");
  await mkdir(locksDirectory, { mode: 0o700 });
  const accountIdentity = hash(config.driver.qq).slice(0, 24);
  const guardPath = accountBoundGuard
    ? join(locksDirectory, accountIdentity + ".memory-pending.json")
    : join(out, "pending.json");
  const stopPath = join(out, "STOP");
  await writeFile(guardPath, '{"schemaVersion":1}\n', { mode: 0o600 });
  await writeFile(stopPath, stopContent, { mode: 0o600 });
  const guard = await lstat(guardPath);
  const stop = await lstat(stopPath);
  const manifestPath = join(out, "input.json");
  const inventoryPath = join(out, "inventory.json");
  const sourceAuditSnapshotPath = join(out, "source-audit.jsonl");
  const originalReportPath = join(out, "original-report.json");
  const journalPath = join(out, "memory-fixture.jsonl");
  const cleanupReportPath = join(out, "cleanup-report.json");
  const manifest = {
    schemaVersion: 1,
    inventoryPath,
    sourceAuditSnapshotPath,
    originalReportPath,
    pendingGuardPath: guardPath,
  };
  await writeFile(manifestPath, JSON.stringify(manifest) + "\n", {
    mode: 0o600,
  });
  await writeFile(inventoryPath, "{}\n", { mode: 0o600 });
  await writeFile(sourceAuditSnapshotPath, "{}\n", { mode: 0o600 });
  await writeFile(originalReportPath, "{}\n", { mode: 0o600 });
  await writeFile(journalPath, "{}\n", { mode: 0o600 });
  await writeFile(cleanupReportPath, "{}\n", { mode: 0o600 });
  const plan = {
    schemaVersion: 1,
    kind: "acceptance-memory-guard-archive",
    cleanupOnly: true,
    featurePass: false,
    runtime: {
      checkout: "/workspace",
      dataDirectory: "/data",
      commit: "a".repeat(40),
      pid: 123,
      connectionId: "qq-live",
      threadId: null,
    },
    origin: {
      reportSha256: hash(await readFile(originalReportPath)),
      guardSha256: "c".repeat(64),
      sourceAuditSha256: hash(await readFile(sourceAuditSnapshotPath)),
    },
    manifestPath,
    inventoryPath,
    sourceAuditSnapshotPath,
    originalReportPath,
    journalPath,
    journalSha256: hash(await readFile(journalPath)),
    cleanupReportPath,
    cleanupReportSha256: hash(await readFile(cleanupReportPath)),
    cleanupPlanSha256: "f".repeat(64),
    manifestSha256: hash(await readFile(manifestPath)),
    inventorySha256: hash(await readFile(inventoryPath)),
    sourceAuditSha256: hash(await readFile(sourceAuditSnapshotPath)),
    cleanupProofSha256: "4".repeat(64),
    stopPath,
    stopSha256: hash(await readFile(stopPath)),
    guardPath,
    guardSha256: hash(await readFile(guardPath)),
    cleanupRunId: "cleanup-run",
    candidateIds: ["candidate_" + "1".repeat(32), "candidate_" + "2".repeat(32)],
    rejectedCount: 2,
  };
  const sha256 = hash(canonical(plan));
  const collected = {
    plan,
    sha256,
    paths: { guardPath, stopPath },
    fingerprints: {
      guard: {
        bytes: await readFile(guardPath),
        sha256: plan.guardSha256,
        dev: guard.dev,
        ino: guard.ino,
        mtimeMs: guard.mtimeMs,
      },
      stop: {
        bytes: await readFile(stopPath),
        sha256: plan.stopSha256,
        dev: stop.dev,
        ino: stop.ino,
        mtimeMs: stop.mtimeMs,
      },
    },
  };
  const deps = {
    collectVerified: async () => structuredClone(collected),
    validateConfig: () => {},
    lockRoot: locksDirectory,
  };
  return { out, guardPath, stopPath, deps, config, collected, locksDirectory };
}

async function createMediaRecoveryState(f) {
  const reportRunId = "2026-10-07T00-00-00.000Z_12345678";
  const reportDirectory = join(f.out, reportRunId);
  await mkdir(reportDirectory, { recursive: true, mode: 0o700 });
  const config = f.config;
  config.runtime = {
    connectionId: "fixture",
    threadId: null,
    dataDirectory: join(f.out, "data"),
  };
  const expectedRuntime = {
    checkout: f.out,
    dataDirectory: config.runtime.dataDirectory,
    commit: "a".repeat(40),
    pid: 1234,
    connectionId: config.runtime.connectionId,
    threadId: null,
  };
  const spec = mediaFixtureStep("image-1k");
  const token = "1".repeat(32);
  const leaseId = "11111111-1111-4111-8111-111111111111";
  const leaseTools = JSON.parse(JSON.stringify(spec.leaseTools).replaceAll("{{nonce}}", token));
  const prompt =
    "GLASSBOX_ACCEPTANCE_V1 " + token + "\n" + spec.prompt.replaceAll("{{nonce}}", token).trim();
  const textSha256 = hash(prompt);
  const reportPath = join(reportDirectory, "report.json");
  const suite = await readFile(new URL("../examples/media-private.example.json", import.meta.url));
  const suiteSha256 = hash(suite);
  const processIdentity = {
    pid: 1234,
    bootId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    startTicks: "123456",
  };
  const startedAt = new Date(Date.now() - 60_000).toISOString();
  const report = {
    mode: "run",
    status: "BLOCKED",
    runId: reportRunId,
    reportDirectory,
    suiteSha256,
    runtime: expectedRuntime,
    safetyStopCreated: true,
    cleanupStopRequired: true,
    error: { code: "INTERNAL_ERROR", diagnostic: { type: "TypeError" } },
    productAcceptance: { status: "BLOCKED", code: "NOT_CHECKED" },
    finishedAt: startedAt,
    cases: [
      {
        id: spec.id,
        status: "PASS",
        code: "REAL_REPLY_RECEIVED",
        route: "private",
        token,
        startedAt,
        prompt,
        expected: spec.expectContains.map((value) => value.replaceAll("{{nonce}}", token)),
        featureAssertions: JSON.parse(
          JSON.stringify(spec.featureAssertions).replaceAll("{{nonce}}", token),
        ),
        leasedToolNames: ["media_generate"],
        acceptanceLease: {
          leaseId,
          expiresAt: Date.parse(startedAt) + 60_000,
          toolsSha256: toolManifestDigest(leaseTools),
        },
        sendAttempted: true,
        sentMessageId: "701",
        inputObserved: true,
        leaseRegistrationAttempted: true,
        leaseRevoked: true,
        inputBinding: {
          driverMessageId: "701",
          botMessageId: "702",
          textSha256,
          time: 1791331200,
          driverTime: 1791331200,
        },
        replies: [{ route: "private", messageId: "703", matches: true }],
        anomalies: [],
      },
    ],
  };
  const latestPath = join(f.out, "latest.json");
  await writeFile(reportPath, JSON.stringify(report) + "\n", { mode: 0o600 });
  await writeFile(
    latestPath,
    JSON.stringify({
      runId: reportRunId,
      reportDirectory,
      mode: "run",
      status: "BLOCKED",
      productAcceptance: report.productAcceptance,
    }) + "\n",
    { mode: 0o600 },
  );

  const checkpointPath = join(reportDirectory, "media-fixture.jsonl");
  const driverSha256 = hash(config.driver.qq);
  const common = {
    schemaVersion: 1,
    familyId: MEDIA_FAMILY_ID,
    driverSha256,
    suiteSha256,
    runtime: expectedRuntime,
    process: processIdentity,
    reportDirectory,
    recordedAt: startedAt,
    stage: "image-1k",
  };
  const sent = {
    ...common,
    sequence: 4,
    phase: "sent",
    caseId: spec.id,
    driverMessageId: "701",
  };
  const rows = [
    { ...common, sequence: 1, phase: "intent" },
    {
      ...common,
      sequence: 2,
      phase: "lease_intent",
      caseId: spec.id,
      marker: token,
      textSha256,
    },
    {
      ...common,
      sequence: 3,
      phase: "send_intent",
      caseId: spec.id,
      marker: token,
      leaseId,
      toolsSha256: report.cases[0].acceptanceLease.toolsSha256,
      textSha256,
    },
    sent,
  ];
  await writeFile(checkpointPath, rows.map((row) => JSON.stringify(row)).join("\n") + "\n", {
    mode: 0o600,
  });
  const pendingPath = join(
    f.locksDirectory,
    hash(config.driver.qq).slice(0, 24) + ".media-pending.json",
  );
  await writeFile(pendingPath, JSON.stringify(sent) + "\n", { mode: 0o600 });

  const noSendStarted = new Date().toISOString();
  const noSendRunId = noSendStarted.replaceAll(":", "-") + "_87654321";
  const noSendDirectory = join(f.out, noSendRunId);
  await mkdir(noSendDirectory, { mode: 0o700 });
  const noSendReport = {
    schemaVersion: 1,
    toolVersion: "0.1.0",
    runId: noSendRunId,
    mode: "resume-media",
    startedAt: noSendStarted,
    productAcceptance: { status: "BLOCKED", code: "NOT_CHECKED" },
    status: "BLOCKED",
    suiteSha256,
    workspace: { checkout: f.out },
    cases: [],
    limitations: ["No real execution."],
    privacy: "Private test fixture.",
    finishedAt: noSendStarted,
    reportDirectory: noSendDirectory,
    error: {
      code: "MEMORY_RECONCILIATION_REQUIRED",
      status: "BLOCKED",
      message: "该发起账号有未核实的记忆清理归档。先核实原始报告和归档收据，禁止续发。",
    },
  };
  await writeFile(join(noSendDirectory, "report.json"), JSON.stringify(noSendReport) + "\n", {
    mode: 0o600,
  });
  await writeFile(
    join(noSendDirectory, "attempt.json"),
    JSON.stringify({
      runId: noSendRunId,
      mode: "resume-media",
      startedAt: noSendStarted,
      status: "STARTED",
    }) + "\n",
    { mode: 0o600 },
  );
  await writeFile(
    latestPath,
    JSON.stringify({
      status: noSendReport.status,
      mode: noSendReport.mode,
      runId: noSendRunId,
      reportDirectory: noSendDirectory,
      productAcceptance: noSendReport.productAcceptance,
      cases: [],
      error: noSendReport.error,
    }) + "\n",
    { mode: 0o600 },
  );

  return {
    reportPath,
    latestPath,
    checkpointPath,
    pendingPath,
    stopPath: f.stopPath,
    expectedRuntime,
  };
}

test("plan is read only and identifies exact guard and STOP hashes", async (t) => {
  const f = await fixture(t);
  const result = await runAcceptanceMemoryReconciliationCli(
    f.config,
    { input: "/private/input.json", cleanupReport: "/private/report.json" },
    f.out,
    f.deps,
  );
  assert.equal(result.status, "PLAN");
  assert.equal(result.plan.guardSha256, f.collected.plan.guardSha256);
  assert.equal(result.plan.stopSha256, f.collected.plan.stopSha256);
  assert.equal(
    await verifyAcceptanceMemoryReconciliationReceipt({
      receiptPath: "/does/not/exist",
      stopPath: f.stopPath,
      guardPath: f.guardPath,
    }),
    false,
  );
  assert.equal((await readFile(f.stopPath)).length > 0, true);
  assert.equal((await readFile(f.guardPath)).length > 0, true);
});

test("approved archive moves only the exact guard and STOP and leaves an immutable receipt", async (t) => {
  const f = await fixture(t);
  const result = await runAcceptanceMemoryReconciliationCli(
    f.config,
    {
      input: "/private/input.json",
      cleanupReport: "/private/report.json",
      live: true,
      "approve-suite": f.collected.sha256,
    },
    f.out,
    f.deps,
  );
  assert.equal(result.status, "ARCHIVE_VERIFIED");
  assert.equal(
    await verifyAcceptanceMemoryReconciliationReceipt({
      receiptPath: result.receiptPath,
      stopPath: f.stopPath,
      guardPath: f.guardPath,
    }),
    true,
  );
  assert.equal(
    await hasUnresolvedAcceptanceMemoryReconciliation(f.out, {
      stopPath: f.stopPath,
      guardPath: f.guardPath,
    }),
    false,
  );
  await assert.rejects(readFile(f.stopPath), { code: "ENOENT" });
  await assert.rejects(readFile(f.guardPath), { code: "ENOENT" });
  const receipt = JSON.parse(await readFile(result.receiptPath, "utf8"));
  assert.equal(receipt.status, "ARCHIVE_VERIFIED");
  assert.equal(receipt.featurePass, false);
  assert.equal(hash(await readFile(receipt.archivedStopPath)), f.collected.plan.stopSha256);
  assert.equal(hash(await readFile(receipt.archivedGuardPath)), f.collected.plan.guardSha256);
});

test("an exact active media recovery plan keeps its new STOP active while the old memory archive remains verified", async (t) => {
  const f = await fixture(t, {
    stopContent: PRE_RUN_STOP,
    accountBoundGuard: true,
  });
  const archived = await runAcceptanceMemoryReconciliationCli(
    f.config,
    {
      input: "/private/input.json",
      cleanupReport: "/private/report.json",
      live: true,
      "approve-suite": f.collected.sha256,
    },
    f.out,
    f.deps,
  );
  const media = await createMediaRecoveryState(f);
  await writeFile(f.stopPath, PRE_RUN_STOP, { flag: "wx", mode: 0o600 });
  await utimes(f.stopPath, new Date(Date.now() + 1000), new Date(Date.now() + 1000));
  await rm(f.stopPath);
  assert.equal(
    await verifyAcceptanceMemoryReconciliationReceipt({
      receiptPath: archived.receiptPath,
      stopPath: f.stopPath,
      guardPath: f.guardPath,
    }),
    true,
  );
  await writeFile(f.stopPath, PRE_RUN_STOP, { flag: "wx", mode: 0o600 });
  await utimes(f.stopPath, new Date(Date.now() + 1000), new Date(Date.now() + 1000));
  const latestBeforePlan = JSON.parse(await readFile(media.latestPath, "utf8"));
  const pinnedPathsBeforePlan = [
    media.reportPath,
    media.latestPath,
    media.checkpointPath,
    media.pendingPath,
    media.stopPath,
    join(latestBeforePlan.reportDirectory, "report.json"),
    join(latestBeforePlan.reportDirectory, "attempt.json"),
  ];
  for (const path of pinnedPathsBeforePlan) {
    const stat = await lstat(path);
    const time = new Date(Math.floor(stat.mtimeMs));
    await utimes(path, time, time);
  }
  const planned = await planMediaImageRecovery({
    reportPath: media.reportPath,
    config: f.config,
    expectedRuntime: media.expectedRuntime,
    locksDirectory: f.locksDirectory,
  });
  const replacementStop = mediaRecoveryPlanBinding(planned.plan);
  const mediaRecoveryContext = {
    config: f.config,
    expectedRuntime: media.expectedRuntime,
    locksDirectory: f.locksDirectory,
  };
  assert.equal(
    await verifyActiveMediaRecoveryPlanBinding(replacementStop, mediaRecoveryContext),
    true,
  );
  const savedReceipt = JSON.parse(await readFile(archived.receiptPath, "utf8"));
  assert.equal(savedReceipt.plan.guardPath, f.guardPath);
  assert.equal(
    savedReceipt.plan.guardPath,
    join(f.locksDirectory, hash(f.config.driver.qq).slice(0, 24) + ".memory-pending.json"),
  );
  assert.equal(replacementStop.stopPath, f.stopPath);
  assert.equal(replacementStop.latestPath, join(f.out, "latest.json"));
  assert.equal(replacementStop.stopSha256, hash(PRE_RUN_STOP));
  const activeStopStat = await lstat(f.stopPath);
  const archivedStopStat = await lstat(savedReceipt.archivedStopPath);
  assert.ok(activeStopStat.mtimeMs > Date.parse(savedReceipt.archivedAt));
  assert.ok(
    activeStopStat.dev !== archivedStopStat.dev || activeStopStat.ino !== archivedStopStat.ino,
  );
  assert.equal(
    replacementStop.pendingPath,
    join(f.locksDirectory, hash(f.config.driver.qq).slice(0, 24) + ".media-pending.json"),
  );
  const options = {
    stopPath: f.stopPath,
    guardPath: f.guardPath,
    replacementStop,
    mediaRecoveryContext,
  };
  assert.equal(
    await verifyAcceptanceMemoryReconciliationReceipt({
      receiptPath: archived.receiptPath,
      ...options,
    }),
    true,
  );
  assert.equal(await hasUnresolvedAcceptanceMemoryReconciliation(f.out, options), false);

  const pinnedPaths = [
    replacementStop.reportPath,
    replacementStop.latestPath,
    replacementStop.checkpointPath,
    replacementStop.pendingPath,
    replacementStop.stopPath,
    replacementStop.resumeBlockReportPath,
    replacementStop.resumeBlockReportPath.replace(/report\.json$/u, "attempt.json"),
  ];
  for (const path of pinnedPaths) {
    const original = await readFile(path);
    const originalStat = await lstat(path);
    const mutated = Buffer.from(original);
    mutated[0] ^= 1;
    await writeFile(path, mutated);
    assert.equal(await hasUnresolvedAcceptanceMemoryReconciliation(f.out, options), true, path);
    await writeFile(path, original);
    await utimes(path, new Date(originalStat.atimeMs), new Date(originalStat.mtimeMs));
    assert.equal(await hasUnresolvedAcceptanceMemoryReconciliation(f.out, options), false, path);
  }
  assert.equal(
    await hasUnresolvedAcceptanceMemoryReconciliation(f.out, {
      stopPath: f.stopPath,
      guardPath: f.guardPath,
    }),
    true,
  );
  assert.equal(
    await hasUnresolvedAcceptanceMemoryReconciliation(f.out, {
      ...options,
      replacementStop: { ...replacementStop, proofKind: "unknown-family" },
    }),
    true,
  );
  assert.equal(
    await hasUnresolvedAcceptanceMemoryReconciliation(f.out, {
      ...options,
      replacementStop: {
        ...replacementStop,
        checkpointSha256: "0".repeat(64),
      },
    }),
    true,
  );

  assert.equal(
    await hasUnresolvedAcceptanceMemoryReconciliation(f.out, {
      ...options,
      replacementStop: { ...replacementStop, planSha256: "f".repeat(64) },
    }),
    true,
  );
  assert.equal(
    await hasUnresolvedAcceptanceMemoryReconciliation(f.out, {
      ...options,
      replacementStop: { ...replacementStop, unexpected: true },
    }),
    true,
  );
  assert.equal(
    await hasUnresolvedAcceptanceMemoryReconciliation(f.out, {
      ...options,
      mediaRecoveryContext: {
        ...mediaRecoveryContext,
        config: {
          ...f.config,
          driver: { ...f.config.driver, qq: "99999" },
        },
      },
    }),
    true,
  );

  const stat = await lstat(f.stopPath);
  await utimes(
    f.stopPath,
    new Date(
      Date.parse(JSON.parse(await readFile(archived.receiptPath, "utf8")).archivedAt) - 1000,
    ),
    new Date(
      Date.parse(JSON.parse(await readFile(archived.receiptPath, "utf8")).archivedAt) - 1000,
    ),
  );
  assert.equal(await hasUnresolvedAcceptanceMemoryReconciliation(f.out, options), true);
  await utimes(f.stopPath, new Date(stat.mtimeMs), new Date(stat.mtimeMs));

  await rm(f.stopPath);
  await rename(
    JSON.parse(await readFile(archived.receiptPath, "utf8")).archivedStopPath,
    f.stopPath,
  );
  assert.equal(await hasUnresolvedAcceptanceMemoryReconciliation(f.out, options), true);
});

test("a verified later pre-Run STOP does not revive a completed older memory archive", async (t) => {
  const f = await fixture(t, { stopContent: PRE_RUN_STOP });
  const archived = await runAcceptanceMemoryReconciliationCli(
    f.config,
    {
      input: "/private/input.json",
      cleanupReport: "/private/report.json",
      live: true,
      "approve-suite": f.collected.sha256,
    },
    f.out,
    f.deps,
  );
  const receipt = JSON.parse(await readFile(archived.receiptPath, "utf8"));
  assert.equal(
    await verifyAcceptanceMemoryReconciliationReceipt({
      receiptPath: archived.receiptPath,
      stopPath: f.stopPath,
      guardPath: f.guardPath,
    }),
    true,
  );

  const runTimestamp = new Date(Date.parse(receipt.archivedAt) + 60_000);
  const runId =
    runTimestamp.toISOString().replace(/T(\d{2}):(\d{2}):(\d{2})/u, "T$1-$2-$3") + "_deadbeef";
  const reportDirectory = join(f.out, runId);
  await mkdir(reportDirectory, { mode: 0o700 });
  const reportPath = join(reportDirectory, "report.json");
  const report = {
    mode: "run",
    status: "INCONCLUSIVE",
    runId,
    reportDirectory,
    suiteSha256: "a".repeat(64),
    safetyStopCreated: true,
    cleanupStopRequired: true,
    productAcceptance: {
      status: "INCONCLUSIVE",
      code: "PRE_RUN_CLEANUP_EVIDENCE",
      cleanupVerified: false,
    },
    cases: [
      {
        id: "ops-status-read",
        status: "BLOCKED",
        code: "API_REJECTED",
        route: "private",
        sendAttempted: true,
        inputObserved: false,
        leaseRegistrationAttempted: true,
        leaseRevoked: true,
      },
    ],
  };
  await writeFile(reportPath, JSON.stringify(report) + "\n", { mode: 0o600 });
  await writeFile(
    join(f.out, "latest.json"),
    JSON.stringify({
      mode: report.mode,
      status: report.status,
      runId,
      reportDirectory,
      productAcceptance: {
        status: report.productAcceptance.status,
        code: report.productAcceptance.code,
      },
    }) + "\n",
    { mode: 0o600 },
  );
  await writeFile(f.stopPath, PRE_RUN_STOP, { mode: 0o600 });
  const fileTime = runTimestamp.getTime();
  await utimes(f.stopPath, new Date(fileTime + 1000), new Date(fileTime + 1000));
  await utimes(reportPath, new Date(fileTime + 2000), new Date(fileTime + 2000));
  const latestPath = join(f.out, "latest.json");
  await utimes(latestPath, new Date(fileTime + 3000), new Date(fileTime + 3000));
  const fingerprint = async (path) => {
    const stat = await lstat(path);
    return {
      dev: stat.dev,
      ino: stat.ino,
      mode: stat.mode,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
    };
  };
  const stopFingerprint = await fingerprint(f.stopPath);
  const reportFingerprint = await fingerprint(reportPath);
  const latestFingerprint = await fingerprint(latestPath);
  const replacementStop = {
    proofKind: "pre-run-api-rejected",
    runId,
    reportPath,
    reportSha256: hash(await readFile(reportPath)),
    reportFingerprint,
    latestPath,
    latestSha256: hash(await readFile(latestPath)),
    latestFingerprint,
    stopPath: f.stopPath,
    stopSha256: hash(await readFile(f.stopPath)),
    stopFingerprint,
  };
  assert.equal(
    await hasUnresolvedAcceptanceMemoryReconciliation(f.out, {
      stopPath: f.stopPath,
      guardPath: f.guardPath,
    }),
    true,
  );
  assert.equal(
    await hasUnresolvedAcceptanceMemoryReconciliation(f.out, {
      stopPath: f.stopPath,
      guardPath: f.guardPath,
      replacementStop,
    }),
    false,
  );

  await rm(f.stopPath);
  await rename(receipt.archivedStopPath, f.stopPath);
  assert.equal(
    await hasUnresolvedAcceptanceMemoryReconciliation(f.out, {
      stopPath: f.stopPath,
      guardPath: f.guardPath,
      replacementStop: {
        ...replacementStop,
        stopFingerprint: await fingerprint(f.stopPath),
      },
    }),
    true,
  );
});

test("a completed memory archive accepts only the pinned fixed-read verifier-busy replacement proof", async (t) => {
  const f = await fixture(t, { stopContent: PRE_RUN_STOP });
  const archived = await runAcceptanceMemoryReconciliationCli(
    f.config,
    {
      input: "/private/input.json",
      cleanupReport: "/private/report.json",
      live: true,
      "approve-suite": f.collected.sha256,
    },
    f.out,
    f.deps,
  );
  const receipt = JSON.parse(await readFile(archived.receiptPath, "utf8"));
  const runTimestamp = new Date(Date.parse(receipt.archivedAt) + 60_000);
  const runId =
    runTimestamp.toISOString().replace(/T(\d{2}):(\d{2}):(\d{2})/u, "T$1-$2-$3") + "_deadbeef";
  const reportDirectory = join(f.out, runId);
  await mkdir(reportDirectory, { mode: 0o700 });
  const reportPath = join(reportDirectory, "report.json");
  const token = "a".repeat(32);
  const suiteBytes = await readFile(
    new URL("../examples/feature-read.example.json", import.meta.url),
  );
  const suite = JSON.parse(suiteBytes.toString("utf8"));
  const spec = suite.cases.find((item) => item.id === "qq-account-status-read");
  const prompt = `GLASSBOX_ACCEPTANCE_V1 ${token}\n${spec.prompt.replaceAll("{{nonce}}", token)}`;
  const leaseTools = JSON.parse(JSON.stringify(spec.leaseTools).replaceAll("{{nonce}}", token));
  const featureAssertions = JSON.parse(
    JSON.stringify(spec.featureAssertions).replaceAll("{{nonce}}", token),
  );
  const inputBinding = {
    driverMessageId: "100001",
    botMessageId: "200002",
    realSequence: "615",
    time: 1791376248,
    textSha256: hash(prompt),
    driverTime: 1791376248,
  };
  const reply = {
    route: "private",
    messageId: "300003",
    receivedAt: "2026-10-08T03:25:50.000Z",
    textSha256: "b".repeat(64),
    textBytes: 24,
    matches: true,
  };
  const lease = {
    leaseId: "11111111-2222-4333-8444-555555555555",
    expiresAt: 1791377000,
    toolsSha256: toolManifestDigest(leaseTools),
  };
  const caseRecord = {
    id: spec.id,
    token,
    status: "PASS",
    code: "REAL_REPLY_RECEIVED",
    route: "private",
    sendAttempted: true,
    inputObserved: true,
    leaseRegistrationAttempted: true,
    leaseRevoked: true,
    sentMessageId: inputBinding.driverMessageId,
    prompt,
    expected: [token],
    leasedToolNames: ["qq_account_status"],
    featureAssertions,
    acceptanceLease: lease,
    inputBinding,
    botInputMessageId: inputBinding.botMessageId,
    botInputMessageIds: [inputBinding.botMessageId],
    botInputCandidates: [
      { messageId: inputBinding.botMessageId, textSha256: inputBinding.textSha256 },
    ],
    replies: [reply],
  };
  const productRunId = "3771509a-0ff5-48b6-9d75-e9638c571182";
  const proofBase = {
    proofKind: "fixed-qq-account-status-read-verifier-busy-v1",
    caseId: caseRecord.id,
    productRunId,
    productRunStatus: "succeeded",
    inputBinding,
    reply: {
      messageId: reply.messageId,
      receivedAt: reply.receivedAt,
      textSha256: reply.textSha256,
      textBytes: reply.textBytes,
      matches: true,
    },
    delivery: {
      id: "delivery-1",
      status: "sent",
      externalId: "400004",
      destinationScopeKey: "qq:private:owner",
    },
    lease: {
      leaseId: lease.leaseId,
      marker: token,
      toolsSha256: lease.toolsSha256,
      revoked: true,
    },
    verification: {
      status: "PASS",
      caseId: caseRecord.id,
      runId: productRunId,
      traceVerified: true,
      cleanupVerified: true,
    },
  };
  const recoveredReadProof = {
    ...proofBase,
    proofSha256: hash(JSON.stringify(proofBase)),
  };
  const report = {
    mode: "run",
    status: "BLOCKED",
    runId,
    reportDirectory,
    suiteSha256: hash(suiteBytes),
    safetyStopCreated: true,
    cleanupStopRequired: true,
    productAcceptance: {
      status: "BLOCKED",
      code: "INTERNAL_ERROR",
      message: "测试器内部异常。未输出原始错误，以避免泄露凭证。请运行本地自检。",
      diagnostic: {
        type: "Error",
        sqliteCode: 5,
        frames: [
          { path: "tools/qq-live/lib/product-evidence.mjs", line: 493, column: 6 },
          { path: "tools/qq-live/lib/product-evidence.mjs", line: 1802, column: 22 },
          { path: "tools/qq-live/lib/product-evidence.mjs", line: 1961, column: 34 },
          { path: "tools/qq-live/cli.mjs", line: 2435, column: 21 },
        ],
      },
      cleanupVerified: false,
      cleanupRequired: true,
      cases: [],
    },
    cases: [caseRecord],
  };
  await writeFile(reportPath, JSON.stringify(report) + "\n", { mode: 0o600 });
  const latestPath = join(f.out, "latest.json");
  const latest = {
    mode: report.mode,
    status: report.status,
    runId,
    reportDirectory,
    productAcceptance: { status: "BLOCKED", code: "INTERNAL_ERROR" },
  };
  await writeFile(latestPath, JSON.stringify(latest) + "\n", { mode: 0o600 });
  await writeFile(f.stopPath, PRE_RUN_STOP, { mode: 0o600 });
  const fileTime = runTimestamp.getTime();
  await utimes(f.stopPath, new Date(fileTime + 1000), new Date(fileTime + 1000));
  await utimes(reportPath, new Date(fileTime + 2000), new Date(fileTime + 2000));
  await utimes(latestPath, new Date(fileTime + 3000), new Date(fileTime + 3000));
  const fingerprint = async (path) => {
    const stat = await lstat(path);
    return {
      dev: stat.dev,
      ino: stat.ino,
      mode: stat.mode,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
    };
  };
  const replacementStop = {
    proofKind: "fixed-read-verifier-busy-success",
    runId,
    reportPath,
    reportSha256: hash(await readFile(reportPath)),
    reportFingerprint: await fingerprint(reportPath),
    latestPath,
    latestSha256: hash(await readFile(latestPath)),
    latestFingerprint: await fingerprint(latestPath),
    stopPath: f.stopPath,
    stopSha256: hash(await readFile(f.stopPath)),
    stopFingerprint: await fingerprint(f.stopPath),
    productRunId,
    productRunStatus: "succeeded",
    recoveredReadProof,
  };
  const options = {
    stopPath: f.stopPath,
    guardPath: f.guardPath,
    replacementStop,
  };
  assert.equal(await hasUnresolvedAcceptanceMemoryReconciliation(f.out, options), false);

  assert.equal(
    await hasUnresolvedAcceptanceMemoryReconciliation(f.out, {
      ...options,
      replacementStop: {
        ...replacementStop,
        recoveredReadProof: { ...recoveredReadProof, proofSha256: "f".repeat(64) },
      },
    }),
    true,
  );
  assert.equal(
    await hasUnresolvedAcceptanceMemoryReconciliation(f.out, {
      ...options,
      replacementStop: { ...replacementStop, productRunStatus: "failed" },
    }),
    true,
  );

  await writeFile(reportPath, JSON.stringify({ ...report, suiteSha256: "c".repeat(64) }) + "\n", {
    mode: 0o600,
  });
  assert.equal(await hasUnresolvedAcceptanceMemoryReconciliation(f.out, options), true);
});

test("a completed memory archive accepts only the exact managed-groups verifier recovery proof", async (t) => {
  const f = await fixture(t, { stopContent: PRE_RUN_STOP });
  const archived = await runAcceptanceMemoryReconciliationCli(
    f.config,
    {
      input: "/private/input.json",
      cleanupReport: "/private/report.json",
      live: true,
      "approve-suite": f.collected.sha256,
    },
    f.out,
    f.deps,
  );
  const receipt = JSON.parse(await readFile(archived.receiptPath, "utf8"));
  const runTimestamp = new Date(Date.parse(receipt.archivedAt) + 60_000);
  const runId =
    runTimestamp.toISOString().replace(/T(\d{2}):(\d{2}):(\d{2})/u, "T$1-$2-$3") + "_deadbeef";
  const reportDirectory = join(f.out, runId);
  await mkdir(reportDirectory, { mode: 0o700 });
  const reportPath = join(reportDirectory, "report.json");
  const token = "b".repeat(32);
  const suiteBytes = await readFile(
    new URL("../examples/feature-read.example.json", import.meta.url),
  );
  const suite = JSON.parse(suiteBytes.toString("utf8"));
  const spec = suite.cases.find((item) => item.id === "qq-managed-groups-inventory-read");
  const prompt = `GLASSBOX_ACCEPTANCE_V1 ${token}\n${spec.prompt.replaceAll("{{nonce}}", token)}`;
  const leaseTools = JSON.parse(JSON.stringify(spec.leaseTools).replaceAll("{{nonce}}", token));
  const featureAssertions = JSON.parse(
    JSON.stringify(spec.featureAssertions).replaceAll("{{nonce}}", token),
  );
  const inputBinding = {
    driverMessageId: "100001",
    botMessageId: "200002",
    realSequence: "615",
    time: 1791376248,
    textSha256: hash(prompt),
    driverTime: 1791376248,
  };
  const reply = {
    route: "private",
    messageId: "300003",
    receivedAt: "2026-10-08T03:25:50.000Z",
    textSha256: "b".repeat(64),
    textBytes: 24,
    matches: true,
  };
  const lease = {
    leaseId: "11111111-2222-4333-8444-555555555555",
    expiresAt: 1791377000,
    toolsSha256: toolManifestDigest(leaseTools),
  };
  const caseRecord = {
    id: spec.id,
    token,
    status: "PASS",
    code: "REAL_REPLY_RECEIVED",
    route: "private",
    sendAttempted: true,
    inputObserved: true,
    leaseRegistrationAttempted: true,
    leaseRevoked: true,
    sentMessageId: inputBinding.driverMessageId,
    prompt,
    expected: [token],
    leasedToolNames: leaseTools.map((tool) => tool.name),
    featureAssertions,
    acceptanceLease: lease,
    inputBinding,
    replies: [reply],
  };
  const productRunId = "60eca939-64aa-4200-9f3e-a64fd8486a8d";
  const proofBase = {
    proofKind: "fixed-qq-managed-groups-inventory-read-verifier-recovery-v1",
    caseId: caseRecord.id,
    productRunId,
    productRunStatus: "succeeded",
    inputBinding,
    reply: {
      messageId: reply.messageId,
      receivedAt: reply.receivedAt,
      textSha256: reply.textSha256,
      textBytes: reply.textBytes,
      matches: true,
    },
    delivery: {
      id: "delivery-managed-groups",
      status: "sent",
      externalId: "1878894180",
      destinationScopeKey:
        '[\\"qq-live\\",\\"3394947361\\",\\"private\\",\\"3526039967\\",\\"3526039967\\",null]',
    },
    lease: {
      leaseId: lease.leaseId,
      marker: token,
      toolsSha256: lease.toolsSha256,
      revoked: true,
    },
    verification: {
      status: "PASS",
      caseId: caseRecord.id,
      runId: productRunId,
      traceVerified: true,
      cleanupVerified: true,
    },
  };
  const recoveredGroupsProof = {
    ...proofBase,
    proofSha256: hash(JSON.stringify(proofBase)),
  };
  const report = {
    mode: "run",
    status: "INCONCLUSIVE",
    runId,
    reportDirectory,
    suiteSha256: hash(suiteBytes),
    safetyStopCreated: true,
    cleanupStopRequired: true,
    productAcceptance: {
      status: "INCONCLUSIVE",
      code: "AUTHORIZATION_EVIDENCE",
      message: "拒绝记录缺少独立且精确绑定的内容排除证据。",
      cleanupVerified: false,
      cleanupRequired: true,
      cases: [],
    },
    cases: [caseRecord],
  };
  await writeFile(reportPath, JSON.stringify(report) + "\n", { mode: 0o600 });
  const latestPath = join(f.out, "latest.json");
  const latest = {
    mode: report.mode,
    status: report.status,
    runId,
    reportDirectory,
    productAcceptance: { status: "INCONCLUSIVE", code: "AUTHORIZATION_EVIDENCE" },
  };
  await writeFile(latestPath, JSON.stringify(latest) + "\n", { mode: 0o600 });
  await writeFile(f.stopPath, PRE_RUN_STOP, { mode: 0o600 });
  const fileTime = runTimestamp.getTime();
  await utimes(f.stopPath, new Date(fileTime + 1000), new Date(fileTime + 1000));
  await utimes(reportPath, new Date(fileTime + 2000), new Date(fileTime + 2000));
  await utimes(latestPath, new Date(fileTime + 3000), new Date(fileTime + 3000));
  const fingerprint = async (path) => {
    const stat = await lstat(path);
    return {
      dev: stat.dev,
      ino: stat.ino,
      mode: stat.mode,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
    };
  };
  const replacementStop = buildPreRunReplacementStopEvidence(
    {
      proofKind: "fixed-groups-verifier-recovery-success",
      caseId: caseRecord.id,
      productRunId,
      productRunStatus: "succeeded",
      recoveredGroupsProof,
      reportPath,
      reportSha256: hash(await readFile(reportPath)),
      reportFingerprint: await fingerprint(reportPath),
      stopPath: f.stopPath,
      stopSha256: hash(await readFile(f.stopPath)),
      stopFingerprint: await fingerprint(f.stopPath),
    },
    report,
    {
      path: latestPath,
      sha256: hash(await readFile(latestPath)),
      fingerprint: await fingerprint(latestPath),
    },
  );
  const options = { stopPath: f.stopPath, guardPath: f.guardPath, replacementStop };
  assert.equal(await hasUnresolvedAcceptanceMemoryReconciliation(f.out, options), false);
  assert.equal(
    await hasUnresolvedAcceptanceMemoryReconciliation(f.out, {
      ...options,
      replacementStop: {
        ...replacementStop,
        recoveredGroupsProof: {
          ...recoveredGroupsProof,
          proofSha256: "f".repeat(64),
        },
      },
    }),
    true,
  );
  assert.equal(
    await hasUnresolvedAcceptanceMemoryReconciliation(f.out, {
      ...options,
      replacementStop: { ...replacementStop, productRunStatus: "failed" },
    }),
    true,
  );
  await writeFile(reportPath, JSON.stringify({ ...report, suiteSha256: "c".repeat(64) }) + "\n", {
    mode: 0o600,
  });
  assert.equal(await hasUnresolvedAcceptanceMemoryReconciliation(f.out, options), true);
});

test("completed-cleanup receipt rechecks the exact archived guard after its atomic move", async (t) => {
  const out = await mkdtemp(join(tmpdir(), "completed-cleanup-archive-"));
  await chmod(out, 0o700);
  t.after(() => rm(out, { recursive: true, force: true }));
  const guardPath = join(out, "pending.json");
  const stopPath = join(out, "STOP");
  const guardBytes = Buffer.from('{"schemaVersion":1,"pending":true}\n');
  const stopBytes = Buffer.from('{"status":"INCONCLUSIVE"}\n');
  await writeFile(guardPath, guardBytes, { mode: 0o600 });
  await writeFile(stopPath, stopBytes, { mode: 0o600 });
  const inventoryPath = join(out, "inventory.json");
  const sourceAuditSnapshotPath = join(out, "source-audit.jsonl");
  const originalReportPath = join(out, "original-report.json");
  const journalPath = join(out, "memory-fixture.jsonl");
  const manifestPath = join(out, "manifest.json");
  const cleanupReportPath = join(out, "completed-cleanup-receipt.json");
  const sourceReportBytes = Buffer.from('{"status":"INCONCLUSIVE"}\n');
  const sourceAuditBytes = Buffer.from("{}\n");
  const journalBytes = Buffer.from("{}\n");
  const sourceHash = (bytes) => hash(bytes);
  const inventory = {
    schemaVersion: 1,
    candidates: [1, 2].map((index) => {
      const candidateId = "candidate_" + String(index).padStart(32, "0");
      const sourceRunId = `source-run-${index}`;
      return {
        candidateId,
        status: "pending",
        promotedMemoryId: null,
        candidateKind: "assertion",
        createdAt: "2026-10-07T08:00:00.000Z",
        scopeSha256: "a".repeat(64),
        subjectSha256: "b".repeat(64),
        statementSha256: "c".repeat(64),
        sourceSha256: "d".repeat(64),
        principalId: "owner-principal",
        sourceRunId,
        auditWrite: {
          id: `write-audit-${index}`,
          sequence: index,
          principalId: "owner-principal",
          action: "write",
          targetId: candidateId,
          runId: sourceRunId,
          lineage: [`run:${sourceRunId}`],
          createdAt: "2026-10-07T08:00:00.000Z",
          rowSha256: "e".repeat(64),
        },
        sourceFeedback: null,
      };
    }),
  };
  const inventoryBytes = Buffer.from(JSON.stringify(inventory) + "\n");
  const manifest = {
    schemaVersion: 1,
    inventoryPath,
    sourceAuditSnapshotPath,
    originalReportPath,
    pendingGuardPath: guardPath,
  };
  const manifestBytes = Buffer.from(JSON.stringify(manifest) + "\n");
  await writeFile(manifestPath, manifestBytes, { mode: 0o600 });
  await writeFile(inventoryPath, inventoryBytes, { mode: 0o600 });
  await writeFile(sourceAuditSnapshotPath, sourceAuditBytes, { mode: 0o600 });
  await writeFile(originalReportPath, sourceReportBytes, { mode: 0o600 });
  await writeFile(journalPath, journalBytes, { mode: 0o600 });
  const runtime = {
    checkout: "/workspace",
    dataDirectory: "/data",
    commit: "a".repeat(40),
    pid: 123,
    connectionId: "qq-live",
    threadId: null,
  };
  const origin = {
    reportSha256: sourceHash(sourceReportBytes),
    guardSha256: sourceHash(guardBytes),
    sourceAuditSha256: sourceHash(sourceAuditBytes),
  };
  const planRecord = buildAcceptanceMemoryCleanupPlan({
    inventory,
    inventorySha256: acceptanceMemoryInventorySha256(inventory),
    runtime,
    origin,
  });
  const proof = {
    cleanupRunId: "cleanup-run-1",
    principalId: "owner-principal",
    candidateIds: planRecord.plan.candidateIds,
    rejectedCount: planRecord.plan.candidateIds.length,
    toolCall: {
      runId: "cleanup-run-1",
      principalId: "owner-principal",
      toolCallId: "reject-call-1",
      sequence: 4,
      inputProjection: "array-values-omitted",
    },
    toolResult: {
      runId: "cleanup-run-1",
      principalId: "owner-principal",
      toolCallId: "reject-call-1",
      sequence: 5,
      outputBytes: 1608,
      outputSha256: "9".repeat(64),
    },
  };
  const traceProof = {
    runId: proof.cleanupRunId,
    principalId: proof.principalId,
    toolCall: proof.toolCall,
    toolResult: proof.toolResult,
  };
  const cleanupReport = {
    schemaVersion: 1,
    kind: "acceptance-memory-completed-cleanup",
    status: "CLEANUP_RECONCILED",
    cleanupOnly: true,
    featurePass: false,
    failedReportPath: join(out, "failed-report.json"),
    origin,
    runtime,
    planSha256: planRecord.sha256,
    cleanupProof: proof,
    cleanupEvidence: traceProof,
    transportEvidence: {
      token: "f".repeat(32),
      startedAt: "2026-10-07T08:30:00.000Z",
      acceptanceLease: {
        leaseId: "11111111-1111-4111-8111-111111111111",
        expiresAt: Date.parse("2026-10-07T08:45:00.000Z"),
        toolsSha256: planRecord.plan.toolsSha256,
      },
      inputBinding: { botMessageId: "12345" },
    },
  };
  await writeFile(cleanupReportPath, JSON.stringify(cleanupReport) + "\n", {
    mode: 0o600,
  });
  const inputs = {
    manifestPath,
    manifest,
    manifestSha256: sourceHash(manifestBytes),
    inventory,
    inventoryFileSha256: sourceHash(inventoryBytes),
    sourceAuditRows: [],
    sourceAuditSha256: sourceHash(sourceAuditBytes),
    report: { sha256: sourceHash(sourceReportBytes) },
    guard: { sha256: sourceHash(guardBytes) },
    origin,
    originState: {
      originalRuntime: { commit: runtime.commit, pid: runtime.pid },
    },
  };
  const finalInventory = {
    schemaVersion: 1,
    candidates: inventory.candidates.map((candidate) => ({
      ...candidate,
      status: "rejected",
    })),
  };
  const db = { close() {} };
  let archivedReceiptChecks = 0;
  const config = baseConfig();
  const sharedDeps = {
    inputsSnapshot: inputs,
    runtimeSnapshot: async () => runtime,
    verifyOrigin: async () => inputs.originState,
    readCurrentInventory: () => ({
      inventory: finalInventory,
      inventorySha256: acceptanceMemoryInventorySha256(finalInventory),
      db,
    }),
    verifyCompletedCleanupReceipt: async ({ deps: receiptDeps }) => {
      if (receiptDeps.guardArchivePath) {
        archivedReceiptChecks += 1;
        assert.notEqual(receiptDeps.guardArchivePath, guardPath);
        assert.equal(
          sourceHash(await readFile(receiptDeps.guardArchivePath)),
          sourceHash(guardBytes),
        );
        await assert.rejects(readFile(guardPath), { code: "ENOENT" });
      }
      return true;
    },
    readTraceEvents: () => ({
      runId: proof.cleanupRunId,
      events: [
        {
          seq: 4,
          event: {
            type: "tool_call",
            runId: proof.cleanupRunId,
            data: {
              name: "owner_memory_admin",
              toolCallId: "reject-call-1",
              input: { action: "reject" },
            },
          },
        },
        {
          seq: 5,
          event: {
            type: "tool_result",
            runId: proof.cleanupRunId,
            data: {
              name: "owner_memory_admin",
              toolCallId: "reject-call-1",
              isError: false,
              outputBytes: proof.toolResult.outputBytes,
              outputSha256: proof.toolResult.outputSha256,
            },
          },
        },
      ],
    }),
    verifyDatabase: () => proof,
    verifyLease: async ({ runId }) => ({
      status: "PASS",
      revoked: true,
      leaseId: cleanupReport.transportEvidence.acceptanceLease.leaseId,
      runId,
    }),
    validateConfig: () => {},
    lockRoot: join(out, "locks"),
  };
  const planned = await runAcceptanceMemoryReconciliationCli(
    {
      ...config,
      runtime: { connectionId: runtime.connectionId, threadId: null },
    },
    { input: manifestPath, cleanupReport: cleanupReportPath },
    out,
    sharedDeps,
  );
  const result = await runAcceptanceMemoryReconciliationCli(
    {
      ...config,
      runtime: { connectionId: runtime.connectionId, threadId: null },
    },
    {
      input: manifestPath,
      cleanupReport: cleanupReportPath,
      live: true,
      "approve-suite": planned.sha256,
    },
    out,
    sharedDeps,
  );
  assert.equal(result.status, "ARCHIVE_VERIFIED");
  assert.ok(archivedReceiptChecks > 0);
  assert.equal(
    await verifyAcceptanceMemoryReconciliationReceipt({
      receiptPath: result.receiptPath,
      stopPath,
      guardPath,
    }),
    true,
  );
});

test("receipt refuses changed original journal, manifest, inventory, or audit snapshots", async (t) => {
  const f = await fixture(t);
  const result = await runAcceptanceMemoryReconciliationCli(
    f.config,
    {
      input: "/private/input.json",
      cleanupReport: "/private/report.json",
      live: true,
      "approve-suite": f.collected.sha256,
    },
    f.out,
    f.deps,
  );
  const receipt = JSON.parse(await readFile(result.receiptPath, "utf8"));
  for (const path of [
    receipt.plan.journalPath,
    receipt.plan.manifestPath,
    receipt.plan.inventoryPath,
    receipt.plan.sourceAuditSnapshotPath,
    receipt.plan.originalReportPath,
    receipt.plan.cleanupReportPath,
  ]) {
    const original = await readFile(path);
    await writeFile(path, Buffer.concat([original, Buffer.from("changed")]), {
      mode: 0o600,
    });
    assert.equal(
      await verifyAcceptanceMemoryReconciliationReceipt({
        receiptPath: result.receiptPath,
        stopPath: f.stopPath,
        guardPath: f.guardPath,
      }),
      false,
    );
    await writeFile(path, original, { mode: 0o600 });
  }
});

test("unresolved intent requires an intent bound to the exact verified receipt", async (t) => {
  const f = await fixture(t);
  const result = await runAcceptanceMemoryReconciliationCli(
    f.config,
    {
      input: "/private/input.json",
      cleanupReport: "/private/report.json",
      live: true,
      "approve-suite": f.collected.sha256,
    },
    f.out,
    f.deps,
  );
  const intentPath = join(
    result.receiptPath.slice(0, result.receiptPath.lastIndexOf("/")),
    "intent.json",
  );
  const intent = JSON.parse(await readFile(intentPath, "utf8"));
  intent.stopSha256 = "0".repeat(64);
  await writeFile(intentPath, JSON.stringify(intent) + "\n", { mode: 0o600 });
  assert.equal(
    await hasUnresolvedAcceptanceMemoryReconciliation(f.out, {
      stopPath: f.stopPath,
      guardPath: f.guardPath,
    }),
    true,
  );
});

test("wrong approval does not move either blocking file", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    runAcceptanceMemoryReconciliationCli(
      f.config,
      {
        input: "/private/input.json",
        cleanupReport: "/private/report.json",
        live: true,
        "approve-suite": "0".repeat(64),
      },
      f.out,
      f.deps,
    ),
    { code: "APPROVAL_REQUIRED" },
  );
  assert.equal(hash(await readFile(f.stopPath)), f.collected.plan.stopSha256);
  assert.equal(hash(await readFile(f.guardPath)), f.collected.plan.guardSha256);
});

test("a STOP rename failure restores the original guard and preserves STOP", async (t) => {
  const f = await fixture(t);
  let renames = 0;
  const deps = {
    ...f.deps,
    rename: async (source, destination) => {
      renames++;
      if (renames === 2) throw Object.assign(new Error("test failure"), { code: "EIO" });
      await rename(source, destination);
    },
  };
  await assert.rejects(
    runAcceptanceMemoryReconciliationCli(
      f.config,
      {
        input: "/private/input.json",
        cleanupReport: "/private/report.json",
        live: true,
        "approve-suite": f.collected.sha256,
      },
      f.out,
      deps,
    ),
    { code: "EIO" },
  );
  assert.equal(hash(await readFile(f.stopPath)), f.collected.plan.stopSha256);
  assert.equal(hash(await readFile(f.guardPath)), f.collected.plan.guardSha256);
  const dirs = await (
    await import("node:fs/promises")
  ).readdir(join(f.out, "acceptance-memory-reconciliation"));
  const failure = JSON.parse(
    await readFile(
      join(f.out, "acceptance-memory-reconciliation", dirs[0], "failure.json"),
      "utf8",
    ),
  );
  assert.equal(failure.status, "INCONCLUSIVE");
});

test("receipt refuses altered archived bytes, wrong paths, or still-present original markers", async (t) => {
  const f = await fixture(t);
  const result = await runAcceptanceMemoryReconciliationCli(
    f.config,
    {
      input: "/private/input.json",
      cleanupReport: "/private/report.json",
      live: true,
      "approve-suite": f.collected.sha256,
    },
    f.out,
    f.deps,
  );
  const receipt = JSON.parse(await readFile(result.receiptPath, "utf8"));
  assert.equal(
    await verifyAcceptanceMemoryReconciliationReceipt({
      receiptPath: result.receiptPath,
      stopPath: f.stopPath,
      guardPath: join(f.out, "wrong-guard"),
    }),
    false,
  );
  await writeFile(receipt.archivedStopPath, "tampered", { mode: 0o600 });
  assert.equal(
    await verifyAcceptanceMemoryReconciliationReceipt({
      receiptPath: result.receiptPath,
      stopPath: f.stopPath,
      guardPath: f.guardPath,
    }),
    false,
  );
});

test("rechecks pinned evidence and refuses an origin race before moving markers", async (t) => {
  const f = await fixture(t);
  let calls = 0;
  const deps = {
    ...f.deps,
    collectVerified: async () => {
      calls++;
      if (calls === 2) {
        const changed = structuredClone(f.collected);
        changed.sha256 = "0".repeat(64);
        return changed;
      }
      return structuredClone(f.collected);
    },
  };
  await assert.rejects(
    runAcceptanceMemoryReconciliationCli(
      f.config,
      {
        input: "/private/input.json",
        cleanupReport: "/private/report.json",
        live: true,
        "approve-suite": f.collected.sha256,
      },
      f.out,
      deps,
    ),
    { code: "MEMORY_RECONCILIATION_CHANGED" },
  );
  assert.equal(hash(await readFile(f.stopPath)), f.collected.plan.stopSha256);
  assert.equal(hash(await readFile(f.guardPath)), f.collected.plan.guardSha256);
});

test("an interrupted intent without a verified receipt blocks normal runs", async (t) => {
  const f = await fixture(t);
  const directory = join(
    f.out,
    "acceptance-memory-reconciliation",
    "11111111-1111-4111-8111-111111111111",
  );
  await (await import("node:fs/promises")).mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(join(directory, "intent.json"), "{}\n", { mode: 0o600 });
  assert.equal(
    await hasUnresolvedAcceptanceMemoryReconciliation(f.out, {
      stopPath: f.stopPath,
      guardPath: f.guardPath,
    }),
    true,
  );
});

test("a cleanup plan bound to a different guard cannot archive either file", async (t) => {
  const f = await fixture(t);
  const wrong = structuredClone(f.collected);
  wrong.plan.guardSha256 = "f".repeat(64);
  wrong.sha256 = hash(canonical(wrong.plan));
  const deps = {
    ...f.deps,
    collectVerified: async () => structuredClone(wrong),
  };
  await assert.rejects(
    runAcceptanceMemoryReconciliationCli(
      f.config,
      {
        input: "/private/input.json",
        cleanupReport: "/private/report.json",
        live: true,
        "approve-suite": wrong.sha256,
      },
      f.out,
      deps,
    ),
    { code: "MEMORY_RECONCILIATION_RECEIPT" },
  );
  assert.equal(hash(await readFile(f.stopPath)), f.collected.plan.stopSha256);
  assert.equal(hash(await readFile(f.guardPath)), f.collected.plan.guardSha256);
});

test("candidate-state verification checks only the exact fixed IDs and preserves unrelated candidates", () => {
  const ids = ["candidate_" + "1".repeat(32), "candidate_" + "2".repeat(32)];
  const rows = [
    { id: ids[0], status: "rejected", promoted_memory_id: null },
    { id: ids[1], status: "rejected", promoted_memory_id: null },
    {
      id: "candidate_" + "3".repeat(32),
      status: "pending",
      promoted_memory_id: null,
    },
    {
      id: "candidate_" + "4".repeat(32),
      status: "promoted",
      promoted_memory_id: "memory_4",
    },
    {
      id: "candidate_" + "5".repeat(32),
      status: "rejected",
      promoted_memory_id: null,
    },
  ];
  const db = {
    prepare: (sql) => ({
      all: (...requested) => {
        assert.match(sql, /WHERE id IN \(/u);
        assert.deepEqual(requested, ids);
        return rows
          .filter((row) => requested.includes(row.id))
          .sort((a, b) => a.id.localeCompare(b.id));
      },
    }),
  };
  assert.equal(verifyAcceptanceMemoryCandidateStates(db, ids), true);
});

test("candidate-state verification rejects missing, duplicated, altered or noncanonical target IDs", () => {
  const ids = ["candidate_" + "1".repeat(32), "candidate_" + "2".repeat(32)];
  for (const state of [
    [
      { id: ids[0], status: "pending", promoted_memory_id: null },
      { id: ids[1], status: "rejected", promoted_memory_id: null },
    ],
    [
      { id: ids[0], status: "rejected", promoted_memory_id: "memory_1" },
      { id: ids[1], status: "rejected", promoted_memory_id: null },
    ],
    [{ id: ids[0], status: "rejected", promoted_memory_id: null }],
    [
      { id: ids[0], status: "rejected", promoted_memory_id: null },
      { id: ids[0], status: "rejected", promoted_memory_id: null },
    ],
  ]) {
    const db = { prepare: () => ({ all: () => state }) };
    assert.throws(() => verifyAcceptanceMemoryCandidateStates(db, ids), {
      code: "MEMORY_RECONCILIATION_INVENTORY",
    });
  }
  for (const invalidIds of [
    [ids[1], ids[0]],
    [ids[0], "candidate_1"],
    [ids[0], ids[0]],
  ]) {
    const db = {
      prepare: () => ({ all: () => [] }),
    };
    assert.throws(() => verifyAcceptanceMemoryCandidateStates(db, invalidIds), {
      code: "MEMORY_RECONCILIATION_INVENTORY",
    });
  }
});

test("learning-isolation verification rejects each new write, feedback, or sourced candidate", () => {
  const runId = "cleanup-run";
  const principalId = "owner";
  const stated = {
    runId,
    principalId,
    candidateWriteAuditCount: 0,
    feedbackWriteCount: 0,
    candidateSourceCount: 0,
  };
  for (const [queryPart, column] of [
    ["action='write'", "candidateWriteAuditCount"],
    ["feedback_events", "feedbackWriteCount"],
    ["source_json LIKE", "candidateSourceCount"],
  ]) {
    const db = {
      prepare: (sql) => ({
        get: () => ({ n: sql.includes(queryPart) ? 1 : 0 }),
      }),
    };
    const invalid = { ...stated, [column]: 1 };
    assert.throws(() => verifyAcceptanceMemoryLearningIsolation(db, runId, principalId, invalid), {
      code: "MEMORY_RECONCILIATION_LEARNING",
    });
  }
});
