import { lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { LiveError, digest } from "./core.mjs";
import { writeDurableReport } from "./durable-report.mjs";
import { hasUnresolvedAcceptanceMemoryReconciliation } from "./acceptance-memory-reconciliation.mjs";
import {
  mediaRecoveryPlanBinding,
  planMediaImageRecovery,
  verifyMediaImageDeliveryGapEvidence,
} from "./media-recovery.mjs";

const HASH = /^[a-f0-9]{64}$/u;
const REPORT_RUN_ID = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z_[a-f0-9]{8}$/u;
const STOP_CONTENT =
  "CLEANUP_UNCONFIRMED\n请先检查 Bot 的延迟任务、目标状态和本轮报告，再人工删除此文件。\n";
const MAX_REPORT_BYTES = 512 * 1024;
const MAX_SMALL_FILE_BYTES = 64 * 1024;
const RECEIPT_KIND = "qq-live-media-delivery-gap-cleanup-v1";
const RECEIPT_KEYS = [
  "schemaVersion",
  "kind",
  "status",
  "cleanupOnly",
  "featureStatus",
  "planSha256",
  "reportRunId",
  "reportPath",
  "reportSha256",
  "reportFingerprint",
  "latestPath",
  "latestSha256",
  "latestFingerprint",
  "archivedLatestPath",
  "archivedLatestSha256",
  "archivedLatestFingerprint",
  "checkpointPath",
  "checkpointSha256",
  "checkpointFingerprint",
  "runtime",
  "driverSha256",
  "productRunId",
  "leaseId",
  "toolsSha256",
  "evidenceSha256",
  "archivedStopPath",
  "archivedStopSha256",
  "archivedStopFingerprint",
  "archivedPendingPath",
  "archivedPendingSha256",
  "archivedPendingFingerprint",
  "completedAt",
  "proofSha256",
];

function reject(code = "MEDIA_CLEANUP_RECONCILIATION") {
  throw new LiveError(
    code,
    "固定媒体清理归档无法独立核实，保留 STOP 和 pending guard。",
    "INCONCLUSIVE",
  );
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function same(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function exactKeys(value, keys) {
  const compare = (left, right) => left.localeCompare(right);
  return isRecord(value) && same(Object.keys(value).sort(compare), [...keys].sort(compare));
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (isRecord(value))
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  const result = JSON.stringify(value);
  if (result === undefined || (typeof value === "number" && !Number.isFinite(value)))
    reject("MEDIA_CLEANUP_PLAN");
  return result;
}

function sha(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function accountKey(config) {
  if (!/^\d{1,20}$/u.test(config?.driver?.qq ?? "")) reject("MEDIA_CLEANUP_IDENTITY");
  return createHash("sha256").update(config.driver.qq).digest("hex").slice(0, 24);
}

function fingerprint(stat) {
  return {
    dev: stat.dev,
    ino: stat.ino,
    mode: stat.mode,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
  };
}

async function stablePrivateFile(path, limit) {
  if (!path?.startsWith("/") || resolve(path) !== path) reject("MEDIA_CLEANUP_PATH");
  let before;
  try {
    before = await lstat(path);
  } catch {
    reject("MEDIA_CLEANUP_FILE");
  }
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.nlink !== 1 ||
    before.size > limit ||
    (before.mode & 0o077) !== 0 ||
    (typeof process.getuid === "function" && before.uid !== process.getuid())
  )
    reject("MEDIA_CLEANUP_FILE");
  const bytes = await readFile(path);
  const after = await lstat(path);
  if (!same(fingerprint(before), fingerprint(after)) || bytes.length !== before.size)
    reject("MEDIA_CLEANUP_FILE_CHANGED");
  return { path, bytes, sha256: sha(bytes), fingerprint: fingerprint(before) };
}

async function syncDirectory(path) {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function ensurePrivateDirectory(path) {
  try {
    await mkdir(path, { mode: 0o700 });
    await syncDirectory(dirname(path));
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
  const stat = await lstat(path);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (stat.mode & 0o077) !== 0 ||
    (typeof process.getuid === "function" && stat.uid !== process.getuid())
  )
    reject("MEDIA_CLEANUP_ARCHIVE_PATH");
}

async function absent(path) {
  try {
    await lstat(path);
    return false;
  } catch (error) {
    if (error?.code === "ENOENT") return true;
    throw error;
  }
}

function archivePaths(plan) {
  const key = plan.accountKey;
  return {
    stopDirectory: join(plan.out, ".media-cleanup-archives", plan.reportRunId),
    archivedStopPath: join(plan.out, ".media-cleanup-archives", plan.reportRunId, "STOP"),
    archivedLatestPath: join(plan.out, ".media-cleanup-archives", plan.reportRunId, "latest.json"),
    pendingDirectory: join(plan.locksDirectory, `${key}.media-cleanup-archives`, plan.reportRunId),
    archivedPendingPath: join(
      plan.locksDirectory,
      `${key}.media-cleanup-archives`,
      plan.reportRunId,
      "pending.json",
    ),
    receiptPath: join(
      plan.locksDirectory,
      `${key}.media-cleanup-archives`,
      plan.reportRunId,
      "receipt.json",
    ),
    intentPath: join(plan.locksDirectory, `${key}.media-cleanup-intent.json`),
    lockPath: join(plan.locksDirectory, `${key}.lock`),
  };
}

async function buildPlan(input, deps, { lockHeld = false } = {}) {
  if (
    !isRecord(input) ||
    !isRecord(input.config) ||
    !isRecord(input.clients) ||
    typeof input.reportPath !== "string"
  )
    reject("MEDIA_CLEANUP_INPUT");
  const locksDirectory = resolve(
    input.locksDirectory ?? join(homedir(), ".glassbox-qq-live-locks"),
  );
  const key = accountKey(input.config);
  const staticPlan = await deps.planMediaImageRecovery({
    reportPath: resolve(input.reportPath),
    config: input.config,
    expectedRuntime: input.expectedRuntime,
    locksDirectory,
  });
  if (staticPlan.status !== "MEDIA_RECOVERY_PLANNED") reject("MEDIA_CLEANUP_SOURCE");
  const recoveryPlan = staticPlan.plan;
  const paths = archivePaths({
    ...recoveryPlan,
    accountKey: key,
    locksDirectory,
  });
  if (!lockHeld && !(await absent(paths.lockPath))) reject("MEDIA_CLEANUP_ACCOUNT_LOCKED");
  if (!(await absent(paths.intentPath))) reject("MEDIA_CLEANUP_INTENT_PENDING");
  if (
    !(await absent(paths.receiptPath)) ||
    !(await absent(paths.archivedStopPath)) ||
    !(await absent(paths.archivedPendingPath)) ||
    !(await absent(paths.stopDirectory)) ||
    !(await absent(paths.pendingDirectory)) ||
    !(
      await Promise.all(
        [
          ".memory-pending.json",
          ".taste-pending.json",
          ".media-release-intent.json",
          ".task-worker-pending.json",
          ".group-policy-pending.json",
          ".group-members-policy-pending.json",
        ].map((suffix) => absent(join(locksDirectory, `${key}${suffix}`))),
      )
    ).every(Boolean)
  )
    reject("MEDIA_CLEANUP_ARCHIVE_EXISTS");
  const evidence = await deps.verifyMediaImageDeliveryGapEvidence({
    reportPath: resolve(input.reportPath),
    config: input.config,
    expectedRuntime: input.expectedRuntime,
    clients: input.clients,
    locksDirectory,
  });
  if (
    evidence?.status !== "MEDIA_DELIVERY_GAP_CLEANUP_VERIFIED" ||
    evidence.cleanupOnly !== true ||
    evidence.featureStatus !== "INCONCLUSIVE" ||
    evidence.productRunId === recoveryPlan.reportRunId ||
    evidence.caseId !== "media-image-1k" ||
    evidence.stage !== "image-1k" ||
    evidence.cleanup?.missingMediaDeliveryTraceWitness !== true ||
    evidence.cleanup?.dualAccountTextAndMediaReadsVerified !== true
  )
    reject("MEDIA_CLEANUP_EVIDENCE");
  if (
    await hasUnresolvedAcceptanceMemoryReconciliation(recoveryPlan.out, {
      stopPath: recoveryPlan.stopPath,
      guardPath: join(locksDirectory, `${key}.memory-pending.json`),
      replacementStop: mediaRecoveryPlanBinding(recoveryPlan),
      mediaRecoveryContext: {
        config: input.config,
        expectedRuntime: input.expectedRuntime,
        locksDirectory,
      },
    })
  )
    reject("MEDIA_CLEANUP_MEMORY_RECONCILIATION");
  const planBase = {
    schemaVersion: 1,
    kind: "qq-live-media-delivery-gap-cleanup",
    cleanupOnly: true,
    featureStatus: "INCONCLUSIVE",
    accountKey: key,
    locksDirectory,
    out: recoveryPlan.out,
    reportRunId: recoveryPlan.reportRunId,
    reportPath: recoveryPlan.reportPath,
    reportSha256: recoveryPlan.reportSha256,
    reportFingerprint: recoveryPlan.reportFingerprint,
    latestPath: recoveryPlan.latestPath,
    latestSha256: recoveryPlan.latestSha256,
    latestFingerprint: recoveryPlan.latestFingerprint,
    checkpointPath: recoveryPlan.checkpointPath,
    checkpointSha256: recoveryPlan.checkpointSha256,
    checkpointFingerprint: recoveryPlan.checkpointFingerprint,
    pendingPath: recoveryPlan.pendingPath,
    pendingSha256: recoveryPlan.pendingSha256,
    pendingFingerprint: recoveryPlan.pendingFingerprint,
    stopPath: recoveryPlan.stopPath,
    stopSha256: recoveryPlan.stopSha256,
    stopFingerprint: recoveryPlan.stopFingerprint,
    driverSha256: recoveryPlan.driverSha256,
    runtime: recoveryPlan.runtime,
    process: recoveryPlan.process,
    productRunId: evidence.productRunId,
    leaseId: evidence.leaseId,
    toolsSha256: evidence.toolsSha256,
    evidenceSha256: digest(canonical(evidence)),
    cleanupEvidence: evidence,
    ...paths,
  };
  return {
    ...planBase,
    planSha256: digest(canonical(planBase)),
  };
}

function validatePlan(plan) {
  const { planSha256, ...base } = plan ?? {};
  if (
    !exactKeys(plan, [
      "schemaVersion",
      "kind",
      "cleanupOnly",
      "featureStatus",
      "accountKey",
      "locksDirectory",
      "out",
      "reportRunId",
      "reportPath",
      "reportSha256",
      "reportFingerprint",
      "latestPath",
      "latestSha256",
      "latestFingerprint",
      "checkpointPath",
      "checkpointSha256",
      "checkpointFingerprint",
      "pendingPath",
      "pendingSha256",
      "pendingFingerprint",
      "stopPath",
      "stopSha256",
      "stopFingerprint",
      "driverSha256",
      "runtime",
      "process",
      "productRunId",
      "leaseId",
      "toolsSha256",
      "evidenceSha256",
      "cleanupEvidence",
      "stopDirectory",
      "archivedStopPath",
      "archivedLatestPath",
      "pendingDirectory",
      "archivedPendingPath",
      "receiptPath",
      "intentPath",
      "lockPath",
      "planSha256",
    ]) ||
    plan.schemaVersion !== 1 ||
    plan.kind !== "qq-live-media-delivery-gap-cleanup" ||
    plan.cleanupOnly !== true ||
    plan.featureStatus !== "INCONCLUSIVE" ||
    !REPORT_RUN_ID.test(plan.reportRunId ?? "") ||
    !HASH.test(plan.planSha256 ?? "") ||
    !HASH.test(plan.reportSha256 ?? "") ||
    !HASH.test(plan.latestSha256 ?? "") ||
    !HASH.test(plan.checkpointSha256 ?? "") ||
    !HASH.test(plan.pendingSha256 ?? "") ||
    !HASH.test(plan.stopSha256 ?? "") ||
    !HASH.test(plan.driverSha256 ?? "") ||
    !HASH.test(plan.toolsSha256 ?? "") ||
    !HASH.test(plan.evidenceSha256 ?? "") ||
    digest(canonical(base)) !== planSha256
  )
    reject("MEDIA_CLEANUP_PLAN");
  return plan;
}

export async function planMediaDeliveryGapCleanup(input, overrides = {}) {
  const deps = {
    planMediaImageRecovery,
    verifyMediaImageDeliveryGapEvidence,
    ...overrides,
  };
  const plan = await buildPlan(input, deps);
  return { status: "MEDIA_DELIVERY_GAP_CLEANUP_PLANNED", plan };
}

async function acquireCleanupLock(path) {
  let handle;
  try {
    handle = await open(path, "wx", 0o600);
    await handle.writeFile(
      JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
    );
    await handle.sync();
    await syncDirectory(dirname(path));
    return { handle, fingerprint: fingerprint(await handle.stat()) };
  } catch (error) {
    await handle?.close().catch(() => {});
    if (error?.code === "EEXIST") reject("MEDIA_CLEANUP_ACCOUNT_LOCKED");
    throw error;
  }
}

async function removeOwnedLock(path, owned) {
  await owned.handle.close().catch(() => {});
  const current = await lstat(path).catch(() => null);
  if (current && same(fingerprint(current), owned.fingerprint)) {
    await rm(path);
    await syncDirectory(dirname(path));
  }
}

async function checkedMove(sourcePath, archivedPath, expected) {
  const source = await stablePrivateFile(sourcePath, MAX_REPORT_BYTES);
  if (source.sha256 !== expected.sha256 || !same(source.fingerprint, expected.fingerprint))
    reject("MEDIA_CLEANUP_SOURCE_CHANGED");
  if (!(await absent(archivedPath))) reject("MEDIA_CLEANUP_ARCHIVE_EXISTS");
  await rename(sourcePath, archivedPath);
  await syncDirectory(dirname(sourcePath));
  await syncDirectory(dirname(archivedPath));
  const moved = await stablePrivateFile(archivedPath, MAX_REPORT_BYTES);
  if (moved.sha256 !== expected.sha256 || !same(moved.fingerprint, expected.fingerprint))
    reject("MEDIA_CLEANUP_ARCHIVE_CHANGED");
  return moved;
}

async function copyPinnedFile(sourcePath, archivedPath, expected) {
  const source = await stablePrivateFile(sourcePath, MAX_REPORT_BYTES);
  if (
    source.sha256 !== expected.sha256 ||
    !same(source.fingerprint, expected.fingerprint) ||
    !(await absent(archivedPath))
  )
    reject("MEDIA_CLEANUP_SOURCE_CHANGED");
  const handle = await open(archivedPath, "wx", 0o600);
  try {
    await handle.writeFile(source.bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await syncDirectory(dirname(archivedPath));
  const archived = await stablePrivateFile(archivedPath, MAX_REPORT_BYTES);
  if (archived.sha256 !== expected.sha256) reject("MEDIA_CLEANUP_ARCHIVE_CHANGED");
  return archived;
}

async function assertPinnedFile(path, expected, limit = MAX_REPORT_BYTES) {
  const file = await stablePrivateFile(path, limit);
  if (file.sha256 !== expected.sha256 || !same(file.fingerprint, expected.fingerprint))
    reject("MEDIA_CLEANUP_SOURCE_CHANGED");
  return file;
}

function receiptBase(plan, archivedStop, archivedLatest, archivedPending, completedAt) {
  return {
    schemaVersion: 1,
    kind: RECEIPT_KIND,
    status: "MEDIA_DELIVERY_GAP_CLEANUP_ARCHIVED",
    cleanupOnly: true,
    featureStatus: "INCONCLUSIVE",
    planSha256: plan.planSha256,
    reportRunId: plan.reportRunId,
    reportPath: plan.reportPath,
    reportSha256: plan.reportSha256,
    reportFingerprint: plan.reportFingerprint,
    latestPath: plan.latestPath,
    latestSha256: plan.latestSha256,
    latestFingerprint: plan.latestFingerprint,
    archivedLatestPath: plan.archivedLatestPath,
    archivedLatestSha256: archivedLatest.sha256,
    archivedLatestFingerprint: archivedLatest.fingerprint,
    checkpointPath: plan.checkpointPath,
    checkpointSha256: plan.checkpointSha256,
    checkpointFingerprint: plan.checkpointFingerprint,
    runtime: plan.runtime,
    driverSha256: plan.driverSha256,
    productRunId: plan.productRunId,
    leaseId: plan.leaseId,
    toolsSha256: plan.toolsSha256,
    evidenceSha256: plan.evidenceSha256,
    archivedStopPath: archivedStop.path,
    archivedStopSha256: archivedStop.sha256,
    archivedStopFingerprint: archivedStop.fingerprint,
    archivedPendingPath: archivedPending.path,
    archivedPendingSha256: archivedPending.sha256,
    archivedPendingFingerprint: archivedPending.fingerprint,
    completedAt,
  };
}

export async function applyMediaDeliveryGapCleanup(
  planInput,
  input,
  approvedPlanSha256,
  overrides = {},
) {
  const plan = validatePlan(planInput);
  if (approvedPlanSha256 !== plan.planSha256) reject("MEDIA_CLEANUP_APPROVAL");
  const dirs = [dirname(plan.lockPath), dirname(plan.reportPath)];
  for (const dir of dirs) await ensurePrivateDirectory(dir);
  const ownedLock = await acquireCleanupLock(plan.lockPath);
  let intentWritten = false;
  try {
    const deps = {
      planMediaImageRecovery,
      verifyMediaImageDeliveryGapEvidence,
      ...overrides,
    };
    const fresh = await buildPlan(input, deps, { lockHeld: true });
    if (!same(fresh, plan)) reject("MEDIA_CLEANUP_PLAN_CHANGED");
    await ensurePrivateDirectory(dirname(plan.intentPath));
    await ensurePrivateDirectory(join(plan.out, ".media-cleanup-archives"));
    await ensurePrivateDirectory(dirname(plan.stopDirectory));
    await ensurePrivateDirectory(dirname(plan.pendingDirectory));
    await ensurePrivateDirectory(plan.stopDirectory);
    await ensurePrivateDirectory(plan.pendingDirectory);
    const intent = {
      schemaVersion: 1,
      kind: "qq-live-media-delivery-gap-cleanup-intent",
      status: "ARCHIVE_INTENT",
      planSha256: plan.planSha256,
      reportRunId: plan.reportRunId,
      reportSha256: plan.reportSha256,
      stopPath: plan.stopPath,
      stopSha256: plan.stopSha256,
      stopFingerprint: plan.stopFingerprint,
      pendingPath: plan.pendingPath,
      pendingSha256: plan.pendingSha256,
      pendingFingerprint: plan.pendingFingerprint,
      latestPath: plan.latestPath,
      latestSha256: plan.latestSha256,
      latestFingerprint: plan.latestFingerprint,
      checkpointPath: plan.checkpointPath,
      checkpointSha256: plan.checkpointSha256,
      checkpointFingerprint: plan.checkpointFingerprint,
      archivedStopPath: plan.archivedStopPath,
      archivedLatestPath: plan.archivedLatestPath,
      archivedPendingPath: plan.archivedPendingPath,
    };
    await writeDurableReport(plan.intentPath, intent);
    intentWritten = true;
    const archivedLatest = await copyPinnedFile(plan.latestPath, plan.archivedLatestPath, {
      sha256: plan.latestSha256,
      fingerprint: plan.latestFingerprint,
    });
    const archivedStop = await checkedMove(plan.stopPath, plan.archivedStopPath, {
      sha256: plan.stopSha256,
      fingerprint: plan.stopFingerprint,
    });
    const archivedPending = await checkedMove(plan.pendingPath, plan.archivedPendingPath, {
      sha256: plan.pendingSha256,
      fingerprint: plan.pendingFingerprint,
    });
    const afterEvidence = await deps.verifyMediaImageDeliveryGapEvidence({
      ...input,
      archivedGuards: {
        stopPath: plan.archivedStopPath,
        pendingPath: plan.archivedPendingPath,
      },
      locksDirectory: plan.locksDirectory,
    });
    if (
      afterEvidence.status !== "MEDIA_DELIVERY_GAP_CLEANUP_VERIFIED" ||
      afterEvidence.featureStatus !== "INCONCLUSIVE" ||
      !same(afterEvidence, plan.cleanupEvidence)
    )
      reject("MEDIA_CLEANUP_POSTCHECK");
    await assertPinnedFile(plan.reportPath, {
      sha256: plan.reportSha256,
      fingerprint: plan.reportFingerprint,
    });
    await assertPinnedFile(plan.latestPath, {
      sha256: plan.latestSha256,
      fingerprint: plan.latestFingerprint,
    });
    await assertPinnedFile(plan.checkpointPath, {
      sha256: plan.checkpointSha256,
      fingerprint: plan.checkpointFingerprint,
    });
    const archivedLatestCheck = await stablePrivateFile(plan.archivedLatestPath, MAX_REPORT_BYTES);
    if (
      archivedLatestCheck.sha256 !== plan.latestSha256 ||
      !same(archivedLatestCheck.fingerprint, archivedLatest.fingerprint)
    )
      reject("MEDIA_CLEANUP_ARCHIVE_CHANGED");
    if (!(await absent(plan.stopPath)) || !(await absent(plan.pendingPath)))
      reject("MEDIA_CLEANUP_GUARD_REMAINS");
    const receiptData = receiptBase(
      plan,
      archivedStop,
      archivedLatest,
      archivedPending,
      new Date().toISOString(),
    );
    const receipt = {
      ...receiptData,
      proofSha256: digest(canonical(receiptData)),
    };
    await writeDurableReport(plan.receiptPath, receipt);
    const saved = await stablePrivateFile(plan.receiptPath, MAX_SMALL_FILE_BYTES);
    if (saved.sha256 !== sha(Buffer.from(JSON.stringify(receipt, null, 2) + "\n")))
      reject("MEDIA_CLEANUP_RECEIPT");
    const intentNow = await stablePrivateFile(plan.intentPath, MAX_SMALL_FILE_BYTES);
    const intentObj = JSON.parse(intentNow.bytes.toString("utf8"));
    if (intentObj.planSha256 !== plan.planSha256) reject("MEDIA_CLEANUP_INTENT_CHANGED");
    await rm(plan.intentPath);
    await syncDirectory(dirname(plan.intentPath));
    intentWritten = false;
    return receipt;
  } catch (error) {
    if (intentWritten) {
      // Keep the durable intent. A partial move must block all later live work.
      await syncDirectory(dirname(plan.intentPath)).catch(() => {});
    }
    throw error;
  } finally {
    await removeOwnedLock(plan.lockPath, ownedLock).catch(() => {});
  }
}

function validReceipt(receipt) {
  const { proofSha256, ...base } = receipt ?? {};
  return (
    exactKeys(receipt, RECEIPT_KEYS) &&
    receipt.schemaVersion === 1 &&
    receipt.kind === RECEIPT_KIND &&
    receipt.status === "MEDIA_DELIVERY_GAP_CLEANUP_ARCHIVED" &&
    receipt.cleanupOnly === true &&
    receipt.featureStatus === "INCONCLUSIVE" &&
    REPORT_RUN_ID.test(receipt.reportRunId ?? "") &&
    HASH.test(receipt.planSha256 ?? "") &&
    HASH.test(receipt.reportSha256 ?? "") &&
    HASH.test(receipt.latestSha256 ?? "") &&
    HASH.test(receipt.archivedLatestSha256 ?? "") &&
    HASH.test(receipt.checkpointSha256 ?? "") &&
    HASH.test(receipt.driverSha256 ?? "") &&
    HASH.test(receipt.toolsSha256 ?? "") &&
    HASH.test(receipt.evidenceSha256 ?? "") &&
    HASH.test(receipt.archivedStopSha256 ?? "") &&
    HASH.test(receipt.archivedPendingSha256 ?? "") &&
    isRecord(receipt.runtime) &&
    isRecord(receipt.reportFingerprint) &&
    isRecord(receipt.latestFingerprint) &&
    isRecord(receipt.archivedLatestFingerprint) &&
    isRecord(receipt.checkpointFingerprint) &&
    isRecord(receipt.archivedStopFingerprint) &&
    isRecord(receipt.archivedPendingFingerprint) &&
    typeof receipt.productRunId === "string" &&
    typeof receipt.leaseId === "string" &&
    Number.isFinite(Date.parse(receipt.completedAt)) &&
    digest(canonical(base)) === proofSha256
  );
}

/** Fail closed when a partial archive intent or incomplete account archive exists. */
export async function hasUnresolvedMediaDeliveryGapCleanup({ config, locksDirectory }) {
  try {
    const key = accountKey(config);
    const root = resolve(locksDirectory);
    const intentPath = join(root, `${key}.media-cleanup-intent.json`);
    if (!(await absent(intentPath))) return true;
    const archiveRoot = join(root, `${key}.media-cleanup-archives`);
    if (await absent(archiveRoot)) return false;
    const rootStat = await lstat(archiveRoot);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || (rootStat.mode & 0o077) !== 0)
      return true;
    const entries = await import("node:fs/promises").then(({ readdir }) =>
      readdir(archiveRoot, { withFileTypes: true }),
    );
    for (const entry of entries) {
      if (!entry.isDirectory() || !REPORT_RUN_ID.test(entry.name)) return true;
      const directory = join(archiveRoot, entry.name);
      const names = await import("node:fs/promises").then(({ readdir }) => readdir(directory));
      if (!same(names.sort(), ["pending.json", "receipt.json"])) return true;
      const receiptFile = await stablePrivateFile(
        join(directory, "receipt.json"),
        MAX_SMALL_FILE_BYTES,
      );
      const pendingFile = await stablePrivateFile(
        join(directory, "pending.json"),
        MAX_SMALL_FILE_BYTES,
      );
      const receipt = JSON.parse(receiptFile.bytes.toString("utf8"));
      if (!validReceipt(receipt)) return true;
      const archiveDirectory = join(
        dirname(dirname(receipt.reportPath)),
        ".media-cleanup-archives",
        entry.name,
      );
      if (
        receipt.reportPath !== join(dirname(receipt.reportPath), "report.json") ||
        receipt.latestPath !== join(dirname(dirname(receipt.reportPath)), "latest.json") ||
        receipt.checkpointPath !== join(dirname(receipt.reportPath), "media-fixture.jsonl") ||
        receipt.archivedLatestPath !== join(archiveDirectory, "latest.json") ||
        receipt.archivedStopPath !== join(archiveDirectory, "STOP") ||
        receipt.latestSha256 !== receipt.archivedLatestSha256
      )
        return true;
      if (
        receipt.reportRunId !== entry.name ||
        receipt.driverSha256 !== digest(config.driver.qq) ||
        receipt.reportRunId !== basename(dirname(receipt.reportPath)) ||
        receipt.archivedStopPath !==
          join(
            dirname(dirname(receipt.reportPath)),
            ".media-cleanup-archives",
            entry.name,
            "STOP",
          ) ||
        receipt.archivedPendingPath !== join(directory, "pending.json") ||
        receipt.archivedPendingSha256 !== pendingFile.sha256
      )
        return true;
      const stop = await stablePrivateFile(receipt.archivedStopPath, MAX_SMALL_FILE_BYTES);
      const archivedLatest = await stablePrivateFile(receipt.archivedLatestPath, MAX_REPORT_BYTES);
      const report = await stablePrivateFile(receipt.reportPath, MAX_REPORT_BYTES);
      const checkpoint = await stablePrivateFile(receipt.checkpointPath, MAX_SMALL_FILE_BYTES);
      if (
        stop.sha256 !== receipt.archivedStopSha256 ||
        !same(stop.fingerprint, receipt.archivedStopFingerprint) ||
        !same(pendingFile.fingerprint, receipt.archivedPendingFingerprint) ||
        stop.bytes.toString("utf8") !== STOP_CONTENT ||
        report.sha256 !== receipt.reportSha256 ||
        !same(report.fingerprint, receipt.reportFingerprint) ||
        archivedLatest.sha256 !== receipt.archivedLatestSha256 ||
        !same(archivedLatest.fingerprint, receipt.archivedLatestFingerprint) ||
        checkpoint.sha256 !== receipt.checkpointSha256 ||
        !same(checkpoint.fingerprint, receipt.checkpointFingerprint)
      )
        return true;
    }
    return false;
  } catch {
    return true;
  }
}
