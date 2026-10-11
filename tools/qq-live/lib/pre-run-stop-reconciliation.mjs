import { createHash } from "node:crypto";
import { lstat, realpath, readFile, open, mkdir, rename, rm, readdir } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { LiveError, digest, toolManifestDigest } from "./core.mjs";
import {
  runtimeSnapshot,
  verifyFailedReadReport as verifyFixedFailedReadReport,
  verifyProductEvidence,
} from "./product-evidence.mjs";
import { verifyPreRunCleanupReport } from "./pre-run-cleanup-report.mjs";
import { writeDurableReport } from "./durable-report.mjs";
import { hasUnresolvedAcceptanceMemoryReconciliation } from "./acceptance-memory-reconciliation.mjs";
import { isFixedPreRunReadCase } from "./pre-run-cleanup-cases.mjs";

const MAX_REPORT_BYTES = 1024 * 1024;
const MAX_STOP_BYTES = 1024;
const HERE = dirname(fileURLToPath(import.meta.url));
const EXPECTED_STOP =
  "CLEANUP_UNCONFIRMED\n请先检查 Bot 的延迟任务、目标状态和本轮报告，再人工删除此文件。\n";

function reject(code = "PRE_RUN_STOP_RECONCILIATION", message = "预运行停止记录无法独立核验。") {
  throw new LiveError(code, message, "INCONCLUSIVE");
}

async function readPrivateFile(path, maxBytes) {
  if (typeof path !== "string" || !path.startsWith("/") || resolve(path) !== path)
    reject("PRE_RUN_STOP_PATH");
  let before;
  try {
    before = await lstat(path);
  } catch {
    reject("PRE_RUN_STOP_FILE");
  }
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.size > maxBytes ||
    (before.mode & 0o077) !== 0 ||
    (typeof process.getuid === "function" && before.uid !== process.getuid())
  )
    reject("PRE_RUN_STOP_FILE");
  let bytes;
  try {
    if ((await realpath(path)) !== path) reject("PRE_RUN_STOP_PATH");
    bytes = await readFile(path);
  } catch {
    reject("PRE_RUN_STOP_READ");
  }
  const after = await lstat(path);
  if (
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.size !== after.size ||
    before.mtimeMs !== after.mtimeMs ||
    bytes.length !== before.size
  )
    reject("PRE_RUN_STOP_CHANGED");
  return {
    bytes,
    sha256: sha256(bytes),
    fingerprint: {
      dev: before.dev,
      ino: before.ino,
      mode: before.mode,
      size: before.size,
      mtimeMs: before.mtimeMs,
    },
  };
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function reportObject(bytes) {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    reject("PRE_RUN_STOP_REPORT");
  }
}

function sameFingerprint(actual, expected) {
  return (
    actual.dev === expected?.dev &&
    actual.ino === expected?.ino &&
    actual.mode === expected?.mode &&
    actual.size === expected?.size &&
    actual.mtimeMs === expected?.mtimeMs
  );
}

function exactKeys(value, keys) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort())
  );
}

function validFingerprint(value) {
  return (
    exactKeys(value, ["dev", "ino", "mode", "size", "mtimeMs"]) &&
    Number.isSafeInteger(value.dev) &&
    Number.isSafeInteger(value.ino) &&
    Number.isSafeInteger(value.mode) &&
    Number.isSafeInteger(value.size) &&
    Number.isFinite(value.mtimeMs)
  );
}

function lockPaths(config, locksDirectory) {
  if (typeof config?.driver?.qq !== "string" || !config.driver.qq) reject("PRE_RUN_STOP_IDENTITY");
  const lockPath = join(
    locksDirectory,
    createHash("sha256").update(config.driver.qq).digest("hex").slice(0, 24) + ".lock",
  );
  return [
    lockPath,
    lockPath.replace(/\.lock$/u, ".memory-pending.json"),
    lockPath.replace(/\.lock$/u, ".taste-pending.json"),
    lockPath.replace(/\.lock$/u, ".media-pending.json"),
    lockPath.replace(/\.lock$/u, ".task-worker-pending.json"),
    lockPath.replace(/\.lock$/u, ".group-policy-pending.json"),
    lockPath.replace(/\.lock$/u, ".group-members-policy-pending.json"),
  ];
}

async function assertPathsAbsent(paths) {
  for (const path of paths) {
    try {
      await lstat(path);
      reject("PRE_RUN_STOP_ACTIVE_OR_PENDING");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
}

async function syncDirectory(path) {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function latestSnapshot(out, report) {
  const latestPath = join(out, "latest.json");
  const latestFile = await readPrivateFile(latestPath, MAX_REPORT_BYTES);
  const latest = reportObject(latestFile.bytes);
  if (
    latest?.mode !== report.mode ||
    latest.status !== report.status ||
    latest.runId !== report.runId ||
    latest.reportDirectory !== report.reportDirectory ||
    latest.productAcceptance?.status !== report.productAcceptance?.status ||
    latest.productAcceptance?.code !== report.productAcceptance?.code ||
    basename(report.reportDirectory ?? "") !== report.runId
  )
    reject("PRE_RUN_STOP_LATEST");
  return { path: latestPath, ...latestFile };
}

export function buildPreRunReplacementStopEvidence(verified, report, latest) {
  return {
    proofKind: verified.proofKind,
    ...(verified.dualAccountDelivery ? { dualAccountDelivery: verified.dualAccountDelivery } : {}),
    ...(verified.proofKind === "fixed-read-failed-run"
      ? {
          productRunId: verified.productRunId,
          productRunStatus: verified.productRunStatus,
          productRunFailureCode: verified.productRunFailureCode,
          failedReadProof: verified.failedReadProof,
        }
      : {}),
    ...(verified.proofKind === "fixed-read-verifier-busy-success"
      ? {
          productRunId: verified.productRunId,
          productRunStatus: verified.productRunStatus,
          recoveredReadProof: verified.recoveredReadProof,
        }
      : {}),
    ...(verified.proofKind === "fixed-groups-verifier-recovery-success"
      ? {
          caseId: verified.caseId,
          productRunId: verified.productRunId,
          productRunStatus: verified.productRunStatus,
          recoveredGroupsProof: verified.recoveredGroupsProof,
        }
      : {}),
    runId: report.runId,
    reportPath: verified.reportPath,
    reportSha256: verified.reportSha256,
    reportFingerprint: verified.reportFingerprint,
    latestPath: latest.path,
    latestSha256: latest.sha256,
    latestFingerprint: latest.fingerprint,
    stopPath: verified.stopPath,
    stopSha256: verified.stopSha256,
    stopFingerprint: verified.stopFingerprint,
  };
}

function reportProofKind(caseRecord, report) {
  if (caseRecord?.code === "INPUT_NOT_OBSERVED") return "pre-run-sent-no-ingress";
  if (caseRecord?.code === "API_REJECTED") return "pre-run-api-rejected";
  if (
    caseRecord?.id === "qq-account-status-read" &&
    caseRecord?.status === "FAIL" &&
    caseRecord?.code === "REPLY_ASSERTION_FAILED"
  )
    return "fixed-read-failed-run";
  if (isVerifierBusySuccessfulReadReport(report, caseRecord))
    return "fixed-read-verifier-busy-success";
  if (isVerifierFailureSuccessfulManagedGroupsReport(report, caseRecord))
    return "fixed-groups-verifier-recovery-success";
  return null;
}

const GROUPS_VERIFIER_FAILURE_MESSAGE = "拒绝记录缺少独立且精确绑定的内容排除证据。";

async function fixedManagedGroupsCase(caseRecord, suiteBytes) {
  let suite;
  try {
    suite = JSON.parse(suiteBytes.toString("utf8"));
  } catch {
    return null;
  }
  const matches = suite?.cases?.filter((item) => item?.id === "qq-managed-groups-inventory-read");
  const spec = suite?.schemaVersion === 2 && matches?.length === 1 ? matches[0] : null;
  const token = caseRecord?.token;
  if (
    !spec ||
    spec.chat !== "private" ||
    spec.sideEffect !== "none" ||
    !/^[a-f0-9]{32}$/u.test(token ?? "")
  )
    return null;
  const expectedPrompt = `GLASSBOX_ACCEPTANCE_V1 ${token}\n${spec.prompt.replaceAll("{{nonce}}", token)}`;
  const expected = [token];
  const expectedAssertions = JSON.parse(
    JSON.stringify(spec.featureAssertions).replaceAll("{{nonce}}", token),
  );
  const expectedTools = JSON.parse(JSON.stringify(spec.leaseTools).replaceAll("{{nonce}}", token));
  const expectedNames = expectedTools.map((tool) => tool.name);
  const expectedToolsSha256 = toolManifestDigest(expectedTools);
  const lease = caseRecord?.acceptanceLease;
  if (
    caseRecord.id !== spec.id ||
    caseRecord.status !== "PASS" ||
    caseRecord.code !== "REAL_REPLY_RECEIVED" ||
    caseRecord.route !== "private" ||
    caseRecord.prompt !== expectedPrompt ||
    JSON.stringify(caseRecord.expected) !== JSON.stringify(expected) ||
    JSON.stringify(caseRecord.featureAssertions) !== JSON.stringify(expectedAssertions) ||
    JSON.stringify(caseRecord.leasedToolNames) !== JSON.stringify(expectedNames) ||
    caseRecord.sendAttempted !== true ||
    caseRecord.inputObserved !== true ||
    caseRecord.leaseRegistrationAttempted !== true ||
    caseRecord.leaseRevoked !== true ||
    (caseRecord.runId !== undefined && caseRecord.runId !== null) ||
    !caseRecord.inputBinding ||
    !exactKeys(lease, ["leaseId", "expiresAt", "toolsSha256"]) ||
    !/^[a-f0-9-]{36}$/iu.test(lease.leaseId ?? "") ||
    !Number.isSafeInteger(lease.expiresAt) ||
    lease.toolsSha256 !== expectedToolsSha256 ||
    typeof caseRecord.sentMessageId !== "string" ||
    !/^[0-9]{1,20}$/u.test(caseRecord.sentMessageId) ||
    !Array.isArray(caseRecord.replies) ||
    caseRecord.replies.length !== 1 ||
    caseRecord.replies[0]?.route !== "private" ||
    caseRecord.replies[0]?.matches !== true ||
    typeof caseRecord.replies[0]?.messageId !== "string" ||
    !/^[0-9]{1,20}$/u.test(caseRecord.replies[0].messageId) ||
    !/^[a-f0-9]{64}$/u.test(caseRecord.replies[0]?.textSha256 ?? "") ||
    !Number.isSafeInteger(caseRecord.replies[0]?.textBytes) ||
    caseRecord.replies[0].textBytes < 1
  )
    return null;
  return { spec, expectedToolsSha256 };
}

function isVerifierFailureSuccessfulManagedGroupsReport(report, caseRecord) {
  const acceptance = report?.productAcceptance;
  return (
    exactKeys(acceptance, [
      "status",
      "code",
      "message",
      "cleanupVerified",
      "cleanupRequired",
      "cases",
    ]) &&
    report?.status === "INCONCLUSIVE" &&
    acceptance.status === "INCONCLUSIVE" &&
    acceptance.code === "AUTHORIZATION_EVIDENCE" &&
    acceptance.message === GROUPS_VERIFIER_FAILURE_MESSAGE &&
    acceptance.cleanupVerified === false &&
    acceptance.cleanupRequired === true &&
    Array.isArray(acceptance.cases) &&
    acceptance.cases.length === 0 &&
    caseRecord?.id === "qq-managed-groups-inventory-read" &&
    caseRecord?.status === "PASS" &&
    caseRecord?.code === "REAL_REPLY_RECEIVED"
  );
}

async function verifyRecoveredManagedGroupsReport(report, config, { clients }) {
  const suiteBytes = await readFile(join(HERE, "../examples/feature-read.example.json"));
  if (
    report?.suiteSha256 !== sha256(suiteBytes) ||
    report?.cases?.length !== 1 ||
    !isVerifierFailureSuccessfulManagedGroupsReport(report, report.cases[0]) ||
    !(await fixedManagedGroupsCase(report.cases[0], suiteBytes))
  )
    reject("PRE_RUN_STOP_REPORT");
  const verification = await verifyProductEvidence({ ...report, status: "PASS" }, config, clients);
  const verified = verification?.cases?.length === 1 ? verification.cases[0] : null;
  const caseRecord = report.cases[0];
  if (
    verification?.status !== "PASS" ||
    verified?.caseId !== "qq-managed-groups-inventory-read" ||
    !/^[a-f0-9-]{36}$/iu.test(verified?.runId ?? "") ||
    verified?.traceVerified !== true ||
    verified?.cleanupVerified !== true ||
    verified?.delivery?.status !== "sent" ||
    !verified.delivery.external_id ||
    !verified.delivery.destination_scope_key ||
    verified?.messageBinding?.reply?.textSha256 !== caseRecord.replies[0].textSha256
  )
    reject("PRE_RUN_STOP_PRODUCT_RECHECK");
  const proofBase = {
    proofKind: "fixed-qq-managed-groups-inventory-read-verifier-recovery-v1",
    caseId: caseRecord.id,
    productRunId: verified.runId,
    productRunStatus: "succeeded",
    inputBinding: caseRecord.inputBinding,
    reply: {
      messageId: caseRecord.replies[0].messageId,
      receivedAt: caseRecord.replies[0].receivedAt,
      textSha256: caseRecord.replies[0].textSha256,
      textBytes: caseRecord.replies[0].textBytes,
      matches: true,
    },
    delivery: {
      id: verified.delivery.id,
      status: verified.delivery.status,
      externalId: verified.delivery.external_id,
      destinationScopeKey: verified.delivery.destination_scope_key,
    },
    lease: {
      leaseId: caseRecord.acceptanceLease.leaseId,
      marker: caseRecord.token,
      toolsSha256: caseRecord.acceptanceLease.toolsSha256,
      revoked: true,
    },
    verification: {
      status: verification.status,
      caseId: verified.caseId,
      runId: verified.runId,
      traceVerified: verified.traceVerified,
      cleanupVerified: verified.cleanupVerified,
    },
  };
  return {
    status: "CLEANUP_RECONCILED",
    runtime: verification.runtime,
    cases: [
      {
        caseId: caseRecord.id,
        leaseId: caseRecord.acceptanceLease.leaseId,
        marker: caseRecord.token,
        toolsSha256: caseRecord.acceptanceLease.toolsSha256,
        productRunId: verified.runId,
        productRunStatus: "succeeded",
        cleanupVerified: true,
        cleanupOnly: true,
        actualQqDeliveryVerified: true,
        productIngressVerified: true,
        productRunObserved: true,
        featureStatus: "INCONCLUSIVE",
        proof: { ...proofBase, proofSha256: digest(JSON.stringify(proofBase)) },
      },
    ],
  };
}

const VERIFIER_BUSY_FRAMES = [
  { path: "tools/qq-live/lib/product-evidence.mjs", line: 493, column: 6 },
  { path: "tools/qq-live/lib/product-evidence.mjs", line: 1802, column: 22 },
  { path: "tools/qq-live/lib/product-evidence.mjs", line: 1961, column: 34 },
  { path: "tools/qq-live/cli.mjs", line: 2435, column: 21 },
];

function isVerifierBusySuccessfulReadReport(report, caseRecord) {
  const acceptance = report?.productAcceptance;
  const replies = caseRecord?.replies;
  return (
    exactKeys(acceptance, [
      "status",
      "code",
      "message",
      "diagnostic",
      "cleanupVerified",
      "cleanupRequired",
      "cases",
    ]) &&
    report?.status === "BLOCKED" &&
    acceptance?.status === "BLOCKED" &&
    acceptance?.code === "INTERNAL_ERROR" &&
    acceptance?.cleanupRequired === true &&
    acceptance?.cleanupVerified === false &&
    acceptance?.message === "测试器内部异常。未输出原始错误，以避免泄露凭证。请运行本地自检。" &&
    exactKeys(acceptance?.diagnostic, ["type", "sqliteCode", "frames"]) &&
    acceptance?.diagnostic?.type === "Error" &&
    acceptance.diagnostic.sqliteCode === 5 &&
    JSON.stringify(acceptance.diagnostic.frames) === JSON.stringify(VERIFIER_BUSY_FRAMES) &&
    Array.isArray(acceptance.cases) &&
    acceptance.cases.length === 0 &&
    caseRecord?.id === "qq-account-status-read" &&
    caseRecord?.status === "PASS" &&
    caseRecord?.code === "REAL_REPLY_RECEIVED" &&
    caseRecord?.route === "private" &&
    caseRecord?.sendAttempted === true &&
    caseRecord?.inputObserved === true &&
    caseRecord?.leaseRegistrationAttempted === true &&
    caseRecord?.leaseRevoked === true &&
    (caseRecord.runId === undefined || caseRecord.runId === null) &&
    typeof caseRecord?.sentMessageId === "string" &&
    /^[0-9]{1,20}$/u.test(caseRecord.sentMessageId) &&
    caseRecord?.acceptanceLease &&
    typeof caseRecord.acceptanceLease.leaseId === "string" &&
    /^[a-f0-9-]{36}$/iu.test(caseRecord.acceptanceLease.leaseId) &&
    Number.isSafeInteger(caseRecord.acceptanceLease.expiresAt) &&
    /^[a-f0-9]{64}$/u.test(caseRecord.acceptanceLease.toolsSha256 ?? "") &&
    caseRecord.token &&
    /^[a-f0-9]{32}$/u.test(caseRecord.token) &&
    Array.isArray(caseRecord.featureAssertions) &&
    caseRecord.featureAssertions.length === 1 &&
    JSON.stringify(caseRecord.featureAssertions[0]) ===
      JSON.stringify({
        kind: "trace",
        type: "tool_result",
        where: { name: "qq_account_status", isError: false },
        count: 1,
      }) &&
    JSON.stringify(caseRecord.leasedToolNames) === JSON.stringify(["qq_account_status"]) &&
    caseRecord.inputBinding &&
    Array.isArray(replies) &&
    replies.length === 1 &&
    replies[0]?.route === "private" &&
    replies[0]?.matches === true &&
    typeof replies[0]?.messageId === "string" &&
    /^[0-9]{1,20}$/u.test(replies[0].messageId) &&
    /^[a-f0-9]{64}$/u.test(replies[0]?.textSha256 ?? "") &&
    Number.isSafeInteger(replies[0]?.textBytes) &&
    replies[0].textBytes > 0
  );
}

const RECOVERED_READ_PROOF_KEYS = [
  "proofKind",
  "caseId",
  "productRunId",
  "productRunStatus",
  "inputBinding",
  "reply",
  "delivery",
  "lease",
  "verification",
  "proofSha256",
];

function validRecoveredReadProof(proof, caseRecord, runId) {
  if (
    !exactKeys(proof, RECOVERED_READ_PROOF_KEYS) ||
    JSON.stringify(Object.keys(proof)) !== JSON.stringify(RECOVERED_READ_PROOF_KEYS) ||
    proof.proofKind !== "fixed-qq-account-status-read-verifier-busy-v1" ||
    proof.caseId !== "qq-account-status-read" ||
    proof.productRunId !== runId ||
    proof.productRunStatus !== "succeeded" ||
    JSON.stringify(proof.inputBinding) !== JSON.stringify(caseRecord?.inputBinding) ||
    !exactKeys(proof.reply, ["messageId", "receivedAt", "textSha256", "textBytes", "matches"]) ||
    proof.reply.messageId !== caseRecord?.replies?.[0]?.messageId ||
    proof.reply.receivedAt !== caseRecord?.replies?.[0]?.receivedAt ||
    proof.reply.textSha256 !== caseRecord?.replies?.[0]?.textSha256 ||
    proof.reply.textBytes !== caseRecord?.replies?.[0]?.textBytes ||
    proof.reply.matches !== true ||
    !exactKeys(proof.delivery, ["id", "status", "externalId", "destinationScopeKey"]) ||
    typeof proof.delivery.id !== "string" ||
    !proof.delivery.id ||
    proof.delivery.status !== "sent" ||
    !/^[0-9]{1,20}$/u.test(proof.delivery.externalId ?? "") ||
    typeof proof.delivery.destinationScopeKey !== "string" ||
    !proof.delivery.destinationScopeKey ||
    !exactKeys(proof.lease, ["leaseId", "marker", "toolsSha256", "revoked"]) ||
    proof.lease.leaseId !== caseRecord?.acceptanceLease?.leaseId ||
    proof.lease.marker !== caseRecord?.token ||
    proof.lease.toolsSha256 !== caseRecord?.acceptanceLease?.toolsSha256 ||
    proof.lease.revoked !== true ||
    !exactKeys(proof.verification, [
      "status",
      "caseId",
      "runId",
      "traceVerified",
      "cleanupVerified",
    ]) ||
    proof.verification.status !== "PASS" ||
    proof.verification.caseId !== proof.caseId ||
    proof.verification.runId !== runId ||
    proof.verification.traceVerified !== true ||
    proof.verification.cleanupVerified !== true ||
    !/^[a-f0-9]{64}$/u.test(proof.proofSha256 ?? "")
  )
    return false;
  const proofBase = {};
  for (const key of RECOVERED_READ_PROOF_KEYS.slice(0, -1)) proofBase[key] = proof[key];
  return digest(JSON.stringify(proofBase)) === proof.proofSha256;
}

const RECOVERED_GROUPS_PROOF_KEYS = [
  "proofKind",
  "caseId",
  "productRunId",
  "productRunStatus",
  "inputBinding",
  "reply",
  "delivery",
  "lease",
  "verification",
  "proofSha256",
];

function validRecoveredGroupsProof(proof, caseRecord, runId) {
  const input = caseRecord?.inputBinding;
  const reply = caseRecord?.replies?.length === 1 ? caseRecord.replies[0] : null;
  const inputKeys = ["driverMessageId", "botMessageId", "realSequence", "time", "textSha256"];
  const inputWithDriverTime = [...inputKeys, "driverTime"];
  if (
    !exactKeys(proof, RECOVERED_GROUPS_PROOF_KEYS) ||
    JSON.stringify(Object.keys(proof)) !== JSON.stringify(RECOVERED_GROUPS_PROOF_KEYS) ||
    proof.proofKind !== "fixed-qq-managed-groups-inventory-read-verifier-recovery-v1" ||
    proof.caseId !== "qq-managed-groups-inventory-read" ||
    proof.productRunId !== runId ||
    proof.productRunStatus !== "succeeded" ||
    !(exactKeys(input, inputKeys) || exactKeys(input, inputWithDriverTime)) ||
    !/^\d{1,20}$/u.test(input.driverMessageId ?? "") ||
    !/^\d{1,20}$/u.test(input.botMessageId ?? "") ||
    !/^\d{1,30}$/u.test(input.realSequence ?? "") ||
    !Number.isSafeInteger(input.time) ||
    (input.driverTime !== undefined && !Number.isSafeInteger(input.driverTime)) ||
    !/^[a-f0-9]{64}$/u.test(input.textSha256 ?? "") ||
    JSON.stringify(proof.inputBinding) !== JSON.stringify(input) ||
    !exactKeys(proof.reply, ["messageId", "receivedAt", "textSha256", "textBytes", "matches"]) ||
    proof.reply.messageId !== reply?.messageId ||
    proof.reply.receivedAt !== reply?.receivedAt ||
    proof.reply.textSha256 !== reply?.textSha256 ||
    proof.reply.textBytes !== reply?.textBytes ||
    proof.reply.matches !== true ||
    !/^\d{1,20}$/u.test(proof.reply.messageId ?? "") ||
    !Number.isFinite(Date.parse(proof.reply.receivedAt ?? "")) ||
    !/^[a-f0-9]{64}$/u.test(proof.reply.textSha256 ?? "") ||
    !Number.isSafeInteger(proof.reply.textBytes) ||
    proof.reply.textBytes < 1 ||
    !exactKeys(proof.delivery, ["id", "status", "externalId", "destinationScopeKey"]) ||
    typeof proof.delivery.id !== "string" ||
    !proof.delivery.id ||
    proof.delivery.status !== "sent" ||
    !/^\d{1,20}$/u.test(proof.delivery.externalId ?? "") ||
    typeof proof.delivery.destinationScopeKey !== "string" ||
    !proof.delivery.destinationScopeKey ||
    !exactKeys(proof.lease, ["leaseId", "marker", "toolsSha256", "revoked"]) ||
    proof.lease.leaseId !== caseRecord?.acceptanceLease?.leaseId ||
    proof.lease.marker !== caseRecord?.token ||
    proof.lease.toolsSha256 !== caseRecord?.acceptanceLease?.toolsSha256 ||
    proof.lease.revoked !== true ||
    !exactKeys(proof.verification, [
      "status",
      "caseId",
      "runId",
      "traceVerified",
      "cleanupVerified",
    ]) ||
    proof.verification.status !== "PASS" ||
    proof.verification.caseId !== proof.caseId ||
    proof.verification.runId !== runId ||
    proof.verification.traceVerified !== true ||
    proof.verification.cleanupVerified !== true ||
    !/^[a-f0-9]{64}$/u.test(proof.proofSha256 ?? "")
  )
    return false;
  const proofBase = {};
  for (const key of RECOVERED_GROUPS_PROOF_KEYS.slice(0, -1)) proofBase[key] = proof[key];
  return digest(JSON.stringify(proofBase)) === proof.proofSha256;
}

async function verifyRecoveredSuccessfulRead(report, config, { clients }) {
  const verification = await verifyProductEvidence({ ...report, status: "PASS" }, config, clients);
  const verified = verification?.cases?.length === 1 ? verification.cases[0] : null;
  if (
    verification?.status !== "PASS" ||
    verified?.caseId !== "qq-account-status-read" ||
    !/^[a-f0-9-]{36}$/iu.test(verified?.runId ?? "") ||
    verified?.traceVerified !== true ||
    verified?.cleanupVerified !== true ||
    verified?.delivery?.status !== "sent" ||
    !verified.delivery.external_id ||
    !verified.delivery.destination_scope_key ||
    verified?.messageBinding?.reply?.textSha256 !== report.cases[0]?.replies?.[0]?.textSha256
  )
    reject("PRE_RUN_STOP_PRODUCT_RECHECK");
  const caseRecord = report.cases[0];
  const proofBase = {
    proofKind: "fixed-qq-account-status-read-verifier-busy-v1",
    caseId: caseRecord.id,
    productRunId: verified.runId,
    productRunStatus: "succeeded",
    inputBinding: caseRecord.inputBinding,
    reply: {
      messageId: caseRecord.replies[0].messageId,
      receivedAt: caseRecord.replies[0].receivedAt,
      textSha256: caseRecord.replies[0].textSha256,
      textBytes: caseRecord.replies[0].textBytes,
      matches: true,
    },
    delivery: {
      id: verified.delivery.id,
      status: verified.delivery.status,
      externalId: verified.delivery.external_id,
      destinationScopeKey: verified.delivery.destination_scope_key,
    },
    lease: {
      leaseId: caseRecord.acceptanceLease.leaseId,
      marker: caseRecord.token,
      toolsSha256: caseRecord.acceptanceLease.toolsSha256,
      revoked: true,
    },
    verification: {
      status: verification.status,
      caseId: verified.caseId,
      runId: verified.runId,
      traceVerified: verified.traceVerified,
      cleanupVerified: verified.cleanupVerified,
    },
  };
  return {
    status: "CLEANUP_RECONCILED",
    runtime: verification.runtime,
    cases: [
      {
        caseId: caseRecord.id,
        leaseId: caseRecord.acceptanceLease.leaseId,
        marker: caseRecord.token,
        toolsSha256: caseRecord.acceptanceLease.toolsSha256,
        productRunId: verified.runId,
        productRunStatus: "succeeded",
        cleanupVerified: true,
        cleanupOnly: true,
        actualQqDeliveryVerified: true,
        productIngressVerified: true,
        productRunObserved: true,
        featureStatus: "INCONCLUSIVE",
        proof: {
          ...proofBase,
          proofSha256: digest(JSON.stringify(proofBase)),
        },
      },
    ],
  };
}

const FAILED_READ_PROOF_KEYS = [
  "proofKind",
  "caseId",
  "productRunId",
  "productRunStatus",
  "productRunFailureCode",
  "inputBinding",
  "reply",
  "delivery",
  "lease",
  "trace",
  "authorization",
  "safeRefusal",
  "proofSha256",
];

function validFailedReadProof(proof, caseRecord, runId) {
  const replies = caseRecord?.replies;
  const input = caseRecord?.inputBinding;
  const lease = caseRecord?.acceptanceLease;
  if (
    !exactKeys(proof, FAILED_READ_PROOF_KEYS) ||
    JSON.stringify(Object.keys(proof)) !== JSON.stringify(FAILED_READ_PROOF_KEYS) ||
    proof.proofKind !== "fixed-qq-account-status-read-failed-run-v1" ||
    proof.caseId !== "qq-account-status-read" ||
    proof.productRunId !== runId ||
    proof.productRunStatus !== "failed" ||
    proof.productRunFailureCode !== "required_evidence_missing" ||
    JSON.stringify(proof.inputBinding) !== JSON.stringify(input) ||
    !Array.isArray(replies) ||
    replies.length !== 1 ||
    !exactKeys(proof.reply, [
      "botMessageId",
      "driverMessageId",
      "receivedAt",
      "textSha256",
      "textBytes",
      "realSequence",
      "time",
      "driverTime",
    ]) ||
    proof.reply.driverMessageId !== replies[0]?.messageId ||
    proof.reply.botMessageId !== proof.delivery?.externalId ||
    proof.reply.textSha256 !== replies[0]?.textSha256 ||
    proof.reply.textBytes !== replies[0]?.textBytes ||
    proof.reply.receivedAt !== replies[0]?.receivedAt ||
    !/^[a-f0-9]{64}$/u.test(proof.reply.textSha256 ?? "") ||
    !Number.isSafeInteger(proof.reply.textBytes) ||
    proof.reply.textBytes < 1 ||
    typeof proof.reply.realSequence !== "string" ||
    !/^\d{1,30}$/u.test(proof.reply.realSequence) ||
    !Number.isSafeInteger(proof.reply.time) ||
    !Number.isSafeInteger(proof.reply.driverTime) ||
    !exactKeys(proof.delivery, ["id", "status", "externalId", "destinationScopeKey"]) ||
    proof.delivery.status !== "sent" ||
    typeof proof.delivery.id !== "string" ||
    !proof.delivery.id ||
    typeof proof.delivery.destinationScopeKey !== "string" ||
    !proof.delivery.destinationScopeKey ||
    !exactKeys(proof.lease, ["leaseId", "marker", "toolsSha256", "runId", "revoked"]) ||
    proof.lease.leaseId !== lease?.leaseId ||
    proof.lease.marker !== caseRecord?.token ||
    proof.lease.toolsSha256 !== lease?.toolsSha256 ||
    proof.lease.runId !== runId ||
    proof.lease.revoked !== true ||
    !exactKeys(proof.trace, [
      "sessionStartCount",
      "toolCallCount",
      "toolResultCount",
      "statusReadCount",
      "identityLeaseDenialCount",
      "malformedInputDenialCount",
      "callOrder",
    ]) ||
    proof.trace.sessionStartCount !== 2 ||
    proof.trace.toolCallCount !== 3 ||
    proof.trace.toolResultCount !== 3 ||
    proof.trace.statusReadCount !== 1 ||
    proof.trace.identityLeaseDenialCount !== 1 ||
    proof.trace.malformedInputDenialCount !== 1 ||
    JSON.stringify(proof.trace.callOrder) !==
      JSON.stringify(["invalid_input", "get_status", "get_login_info_denied_by_lease"]) ||
    !exactKeys(proof.authorization, ["accountStatusReadDecisionCount", "decisionIdsSha256"]) ||
    !Number.isSafeInteger(proof.authorization.accountStatusReadDecisionCount) ||
    proof.authorization.accountStatusReadDecisionCount < 1 ||
    !/^[a-f0-9]{64}$/u.test(proof.authorization.decisionIdsSha256 ?? "") ||
    !exactKeys(proof.safeRefusal, [
      "textSha256",
      "textBytes",
      "markerAbsent",
      "accountIdentityAbsent",
      "numericIdentifierAbsent",
      "refusalCuePresent",
    ]) ||
    !/^[a-f0-9]{64}$/u.test(proof.safeRefusal.textSha256 ?? "") ||
    !Number.isSafeInteger(proof.safeRefusal.textBytes) ||
    proof.safeRefusal.textBytes < 1 ||
    proof.safeRefusal.markerAbsent !== true ||
    proof.safeRefusal.accountIdentityAbsent !== true ||
    proof.safeRefusal.numericIdentifierAbsent !== true ||
    proof.safeRefusal.refusalCuePresent !== true ||
    !/^[a-f0-9]{64}$/u.test(proof.proofSha256 ?? "")
  )
    return false;
  const proofBase = {};
  for (const key of FAILED_READ_PROOF_KEYS.slice(0, -1)) proofBase[key] = proof[key];
  return digest(JSON.stringify(proofBase)) === proof.proofSha256;
}

/** Read-only reconciliation for a STOP created by the fixed pre-Run API rejection path. */
export async function verifyPreRunStoppedReport(
  { reportPath, stopPath, config },
  {
    readRuntime = () => runtimeSnapshot(config.runtime),
    verifyReport = verifyPreRunCleanupReport,
    verifyFailedReadReport = verifyFixedFailedReadReport,
    verifyRecoveredReadReport = verifyRecoveredSuccessfulRead,
    verifyRecoveredGroupsReport = verifyRecoveredManagedGroupsReport,
    clients,
  } = {},
) {
  const reportFile = await readPrivateFile(reportPath, MAX_REPORT_BYTES);
  const stopFile = await readPrivateFile(stopPath, MAX_STOP_BYTES);
  if (stopFile.bytes.toString("utf8") !== EXPECTED_STOP) reject("PRE_RUN_STOP_CONTENT");
  let report;
  try {
    report = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(reportFile.bytes));
  } catch {
    reject("PRE_RUN_STOP_REPORT");
  }
  const resolvedReportPath = resolve(reportPath);
  const resolvedStopPath = resolve(stopPath);
  const reportDirectory = dirname(resolvedReportPath);
  const reportCase = report?.cases?.length === 1 ? report.cases[0] : undefined;
  const proofKind = reportProofKind(reportCase, report);
  const sentNoIngressReport = proofKind === "pre-run-sent-no-ingress";
  const failedReadReport = proofKind === "fixed-read-failed-run";
  const recoveredReadReport = proofKind === "fixed-read-verifier-busy-success";
  const recoveredGroupsReport = proofKind === "fixed-groups-verifier-recovery-success";
  let fixedSuite;
  try {
    fixedSuite = await readFile(join(HERE, "../examples/feature-read.example.json"));
  } catch {
    reject("PRE_RUN_STOP_SUITE");
  }
  if (
    report?.mode !== "run" ||
    report.suiteSha256 !== sha256(fixedSuite) ||
    report.reportDirectory !== reportDirectory ||
    resolvedStopPath !== resolve(dirname(reportDirectory), "STOP") ||
    report.status !== (recoveredReadReport ? "BLOCKED" : "INCONCLUSIVE") ||
    report.safetyStopCreated !== true ||
    report.cleanupStopRequired !== true ||
    report.productAcceptance?.code !==
      (sentNoIngressReport
        ? "LEASE_CLEANUP_EVIDENCE"
        : failedReadReport
          ? "RUN_EVIDENCE"
          : recoveredReadReport
            ? "INTERNAL_ERROR"
            : recoveredGroupsReport
              ? "AUTHORIZATION_EVIDENCE"
              : "PRE_RUN_CLEANUP_EVIDENCE") ||
    report.productAcceptance?.cleanupVerified !== false ||
    (sentNoIngressReport && report.productAcceptance?.cleanupRequired !== true) ||
    (failedReadReport && report.productAcceptance?.cleanupRequired !== true) ||
    (recoveredReadReport &&
      (report.productAcceptance?.cleanupRequired !== true ||
        report.productAcceptance?.diagnostic?.sqliteCode !== 5)) ||
    (recoveredGroupsReport && report.productAcceptance?.cleanupRequired !== true) ||
    (sentNoIngressReport &&
      (reportCase.id !== "ops-status-read" ||
        reportCase.status !== "INCONCLUSIVE" ||
        reportCase.route !== "private" ||
        reportCase.sendAttempted !== true ||
        reportCase.inputObserved !== false ||
        (reportCase.runId !== undefined && reportCase.runId !== null) ||
        (reportCase.inputBinding !== undefined && reportCase.inputBinding !== null) ||
        typeof reportCase.sentMessageId !== "string" ||
        !/^\d{1,20}$/u.test(reportCase.sentMessageId))) ||
    (failedReadReport &&
      (reportCase.route !== "private" ||
        reportCase.sendAttempted !== true ||
        reportCase.inputObserved !== true ||
        reportCase.leaseRegistrationAttempted !== true ||
        reportCase.leaseRevoked !== true ||
        typeof reportCase.sentMessageId !== "string" ||
        !/^\d{1,20}$/u.test(reportCase.sentMessageId) ||
        !reportCase.inputBinding ||
        (reportCase.runId !== undefined && reportCase.runId !== null))) ||
    (recoveredReadReport &&
      (reportCase.route !== "private" ||
        reportCase.sendAttempted !== true ||
        reportCase.inputObserved !== true ||
        reportCase.leaseRegistrationAttempted !== true ||
        reportCase.leaseRevoked !== true ||
        typeof reportCase.sentMessageId !== "string" ||
        !/^[0-9]{1,20}$/u.test(reportCase.sentMessageId) ||
        !reportCase.inputBinding)) ||
    (recoveredGroupsReport &&
      (reportCase.route !== "private" ||
        reportCase.sendAttempted !== true ||
        reportCase.inputObserved !== true ||
        reportCase.leaseRegistrationAttempted !== true ||
        reportCase.leaseRevoked !== true ||
        typeof reportCase.sentMessageId !== "string" ||
        !/^[0-9]{1,20}$/u.test(reportCase.sentMessageId) ||
        !reportCase.inputBinding)) ||
    (recoveredGroupsReport && !(await fixedManagedGroupsCase(reportCase, fixedSuite))) ||
    !proofKind ||
    report.cases?.length !== 1
  )
    reject("PRE_RUN_STOP_REPORT");
  if (failedReadReport && typeof verifyFailedReadReport !== "function")
    reject("PRE_RUN_STOP_REPORT");
  if (recoveredReadReport && typeof verifyRecoveredReadReport !== "function")
    reject("PRE_RUN_STOP_REPORT");
  if (recoveredGroupsReport && typeof verifyRecoveredGroupsReport !== "function")
    reject("PRE_RUN_STOP_REPORT");
  const cleanup = await (
    failedReadReport
      ? verifyFailedReadReport
      : recoveredReadReport
        ? verifyRecoveredReadReport
        : recoveredGroupsReport
          ? verifyRecoveredGroupsReport
          : verifyReport
  )(report, config, {
    readRuntime,
    clients,
  });
  const reportAfter = await readPrivateFile(reportPath, MAX_REPORT_BYTES);
  const stopAfter = await readPrivateFile(stopPath, MAX_STOP_BYTES);
  const suiteAfter = await readFile(join(HERE, "../examples/feature-read.example.json"));
  if (
    reportAfter.sha256 !== reportFile.sha256 ||
    !sameFingerprint(reportAfter.fingerprint, reportFile.fingerprint) ||
    stopAfter.sha256 !== stopFile.sha256 ||
    !sameFingerprint(stopAfter.fingerprint, stopFile.fingerprint) ||
    sha256(suiteAfter) !== report.suiteSha256
  )
    reject("PRE_RUN_STOP_CHANGED");
  const receipt = cleanup?.cases?.length === 1 ? cleanup.cases[0] : undefined;
  const caseRecord = report.cases[0];
  const sentNoIngress = proofKind === "pre-run-sent-no-ingress";
  const failedRead = proofKind === "fixed-read-failed-run";
  const recoveredRead = proofKind === "fixed-read-verifier-busy-success";
  const recoveredGroups = proofKind === "fixed-groups-verifier-recovery-success";
  const failedReadReceipt = cleanup?.cases?.length === 1 ? cleanup.cases[0] : undefined;
  if (
    cleanup?.status !==
      (sentNoIngress || failedRead || recoveredRead || recoveredGroups
        ? "CLEANUP_RECONCILED"
        : "CLEANUP_VERIFIED") ||
    !receipt ||
    (failedRead
      ? failedReadReceipt?.caseId !== caseRecord.id ||
        failedReadReceipt?.leaseId !== caseRecord.acceptanceLease?.leaseId ||
        failedReadReceipt?.marker !== caseRecord.token ||
        failedReadReceipt?.toolsSha256 !== caseRecord.acceptanceLease?.toolsSha256 ||
        failedReadReceipt?.cleanupVerified !== true ||
        failedReadReceipt?.cleanupOnly !== true ||
        failedReadReceipt?.actualQqDeliveryVerified !== true ||
        failedReadReceipt?.productIngressVerified !== true ||
        failedReadReceipt?.productRunObserved !== true ||
        failedReadReceipt?.productRunStatus !== "failed" ||
        failedReadReceipt?.productRunFailureCode !== "required_evidence_missing" ||
        !/^[a-f0-9-]{36}$/iu.test(failedReadReceipt?.productRunId ?? "") ||
        failedReadReceipt?.featureStatus !== "FAIL" ||
        !validFailedReadProof(
          failedReadReceipt?.proof,
          caseRecord,
          failedReadReceipt?.productRunId,
        ) ||
        cleanup?.runtime === undefined
      : recoveredRead
        ? failedReadReceipt?.caseId !== caseRecord.id ||
          failedReadReceipt?.leaseId !== caseRecord.acceptanceLease?.leaseId ||
          failedReadReceipt?.marker !== caseRecord.token ||
          failedReadReceipt?.toolsSha256 !== caseRecord.acceptanceLease?.toolsSha256 ||
          failedReadReceipt?.cleanupVerified !== true ||
          failedReadReceipt?.cleanupOnly !== true ||
          failedReadReceipt?.actualQqDeliveryVerified !== true ||
          failedReadReceipt?.productIngressVerified !== true ||
          failedReadReceipt?.productRunObserved !== true ||
          failedReadReceipt?.productRunStatus !== "succeeded" ||
          !/^[a-f0-9-]{36}$/iu.test(failedReadReceipt?.productRunId ?? "") ||
          failedReadReceipt?.featureStatus !== "INCONCLUSIVE" ||
          !validRecoveredReadProof(
            failedReadReceipt?.proof,
            caseRecord,
            failedReadReceipt?.productRunId,
          ) ||
          cleanup?.runtime === undefined
        : recoveredGroups
          ? receipt.caseId !== caseRecord.id ||
            receipt.leaseId !== caseRecord.acceptanceLease?.leaseId ||
            receipt.marker !== caseRecord.token ||
            receipt.toolsSha256 !== caseRecord.acceptanceLease?.toolsSha256 ||
            receipt.cleanupVerified !== true ||
            receipt.cleanupOnly !== true ||
            receipt.actualQqDeliveryVerified !== true ||
            receipt.productIngressVerified !== true ||
            receipt.productRunObserved !== true ||
            receipt.productRunStatus !== "succeeded" ||
            !/^[a-f0-9-]{36}$/iu.test(receipt.productRunId ?? "") ||
            receipt.featureStatus !== "INCONCLUSIVE" ||
            !validRecoveredGroupsProof(receipt.proof, caseRecord, receipt.productRunId) ||
            cleanup?.runtime === undefined
          : receipt.caseId !== caseRecord.id ||
            receipt.leaseId !== caseRecord.acceptanceLease?.leaseId ||
            receipt.marker !== caseRecord.token ||
            receipt.toolsSha256 !== caseRecord.acceptanceLease?.toolsSha256 ||
            receipt.cleanupVerified !== true ||
            receipt.cleanupOnly !== true ||
            receipt.actualQqDeliveryVerified !== sentNoIngress ||
            receipt.featureStatus !== "INCONCLUSIVE") ||
    (sentNoIngress &&
      (receipt.productIngressVerified !== false ||
        receipt.productRunObserved !== false ||
        receipt.dualAccountDelivery?.verified !== true ||
        receipt.dualAccountDelivery?.ownerMessageId !== caseRecord.sentMessageId)) ||
    (!failedRead &&
      !recoveredRead &&
      !recoveredGroups &&
      (receipt.zeroMarkedMessages !== true || receipt.zeroMarkedRuns !== true))
  )
    reject();
  return {
    status: "PRE_RUN_STOP_RECONCILED",
    proofKind,
    ...(failedRead
      ? {
          productRunId: failedReadReceipt.productRunId,
          productRunStatus: failedReadReceipt.productRunStatus,
          productRunFailureCode: failedReadReceipt.productRunFailureCode,
          failedReadProof: failedReadReceipt.proof,
        }
      : {}),
    ...(recoveredRead
      ? {
          productRunId: failedReadReceipt.productRunId,
          productRunStatus: failedReadReceipt.productRunStatus,
          recoveredReadProof: failedReadReceipt.proof,
        }
      : {}),
    ...(recoveredGroups
      ? {
          productRunId: receipt.productRunId,
          productRunStatus: receipt.productRunStatus,
          recoveredGroupsProof: receipt.proof,
        }
      : {}),
    ...(sentNoIngress ? { dualAccountDelivery: receipt.dualAccountDelivery } : {}),
    reportPath: resolvedReportPath,
    reportSha256: reportFile.sha256,
    reportFingerprint: reportFile.fingerprint,
    stopPath: resolvedStopPath,
    stopSha256: stopFile.sha256,
    stopFingerprint: stopFile.fingerprint,
    runtime: cleanup.runtime,
    caseId: receipt.caseId,
    caseStatus: caseRecord.status,
    caseCode: caseRecord.code,
    route: caseRecord.route,
    sendAttempted: caseRecord.sendAttempted,
    inputObserved: caseRecord.inputObserved,
    leaseRegistrationAttempted: caseRecord.leaseRegistrationAttempted,
    leaseRevoked: caseRecord.leaseRevoked,
    leaseId: receipt.leaseId,
    leaseExpiresAt: caseRecord.acceptanceLease.expiresAt,
    marker: receipt.marker,
    toolsSha256: receipt.toolsSha256,
    cleanupVerified: true,
    cleanupOnly: true,
    actualQqDeliveryVerified: failedRead || recoveredRead || recoveredGroups ? true : sentNoIngress,
    productIngressVerified: failedRead || recoveredRead || recoveredGroups ? true : false,
    productRunObserved: failedRead || recoveredRead || recoveredGroups ? true : false,
    featureStatus: failedRead ? "FAIL" : "INCONCLUSIVE",
    ...(!failedRead && !recoveredRead && !recoveredGroups
      ? { zeroMarkedMessages: true, zeroMarkedRuns: true }
      : {}),
    archiveEligible: true,
  };
}

/** Fail closed while any pre-Run STOP archive intent is incomplete or inconsistent. */
export async function hasUnresolvedPreRunStopReconciliation(out) {
  const root = join(out, "pre-run-stop-reconciliation");
  let entries;
  try {
    const rootStat = await lstat(root);
    if (
      !rootStat.isDirectory() ||
      rootStat.isSymbolicLink() ||
      (rootStat.mode & 0o077) !== 0 ||
      (typeof process.getuid === "function" && rootStat.uid !== process.getuid())
    )
      return true;
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    return error?.code !== "ENOENT";
  }
  const basePlanKeys = [
    "schemaVersion",
    "kind",
    "reportPath",
    "reportSha256",
    "reportFingerprint",
    "latestPath",
    "latestSha256",
    "latestFingerprint",
    "stopPath",
    "stopSha256",
    "stopFingerprint",
    "locksDirectory",
    "archiveDirectory",
    "archivedStopPath",
    "runId",
    "suiteSha256",
    "runtime",
    "caseId",
    "caseStatus",
    "caseCode",
    "route",
    "sendAttempted",
    "inputObserved",
    "leaseRegistrationAttempted",
    "leaseRevoked",
    "leaseId",
    "leaseExpiresAt",
    "marker",
    "toolsSha256",
    "cleanupOnly",
    "featurePass",
    "actualQqDeliveryVerified",
    "featureStatus",
  ];
  const apiPlanKeys = [...basePlanKeys, "proofKind"];
  const sentPlanKeys = [
    ...apiPlanKeys,
    "productIngressVerified",
    "productRunObserved",
    "dualAccountDelivery",
  ];
  const failedReadPlanKeys = [
    ...apiPlanKeys,
    "productIngressVerified",
    "productRunObserved",
    "productRunId",
    "productRunStatus",
    "productRunFailureCode",
    "failedReadProof",
  ];
  const recoveredReadPlanKeys = [
    ...apiPlanKeys,
    "productIngressVerified",
    "productRunObserved",
    "productRunId",
    "productRunStatus",
    "recoveredReadProof",
  ];
  const recoveredGroupsPlanKeys = [
    ...apiPlanKeys,
    "productIngressVerified",
    "productRunObserved",
    "productRunId",
    "productRunStatus",
    "recoveredGroupsProof",
  ];
  const legacyPlanKeys = basePlanKeys;
  const intentKeys = [
    "schemaVersion",
    "kind",
    "status",
    "planSha256",
    "reportSha256",
    "latestSha256",
    "stopSha256",
    "stopFingerprint",
    "stopPath",
    "archivedStopPath",
    "runId",
  ];
  const baseReceiptKeys = [
    "schemaVersion",
    "kind",
    "status",
    "plan",
    "planSha256",
    "archivedStopSha256",
    "cleanupVerified",
    "cleanupOnly",
    "featurePass",
    "actualQqDeliveryVerified",
    "featureStatus",
    "zeroMarkedMessages",
    "zeroMarkedRuns",
  ];
  const apiReceiptKeys = [...baseReceiptKeys, "proofKind"];
  const sentReceiptKeys = [
    ...apiReceiptKeys,
    "productIngressVerified",
    "productRunObserved",
    "dualAccountDelivery",
  ];
  const failedReadReceiptKeys = [
    ...baseReceiptKeys.filter((key) => key !== "zeroMarkedMessages" && key !== "zeroMarkedRuns"),
    "proofKind",
    "productIngressVerified",
    "productRunObserved",
    "productRunId",
    "productRunStatus",
    "productRunFailureCode",
    "failedReadProof",
  ];
  const recoveredReadReceiptKeys = [
    ...baseReceiptKeys.filter((key) => key !== "zeroMarkedMessages" && key !== "zeroMarkedRuns"),
    "proofKind",
    "productIngressVerified",
    "productRunObserved",
    "productRunId",
    "productRunStatus",
    "recoveredReadProof",
  ];
  const recoveredGroupsReceiptKeys = [
    ...baseReceiptKeys.filter((key) => key !== "zeroMarkedMessages" && key !== "zeroMarkedRuns"),
    "proofKind",
    "productIngressVerified",
    "productRunObserved",
    "productRunId",
    "productRunStatus",
    "recoveredGroupsProof",
  ];
  for (const entry of entries) {
    if (
      !entry.isDirectory() ||
      entry.isSymbolicLink() ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z_[a-f0-9]{8}$/u.test(entry.name)
    )
      return true;
    try {
      const directory = join(root, entry.name);
      const dirStat = await lstat(directory);
      if (
        (dirStat.mode & 0o077) !== 0 ||
        (typeof process.getuid === "function" && dirStat.uid !== process.getuid())
      ) {
        if (proofKind === "fixed-read-failed-run")
          console.error(
            "FAILED_READ_ARCHIVE_METADATA",
            JSON.stringify({
              expectedPlanKeys,
              actualPlanKeys: Object.keys(plan ?? {}),
              expectedReceiptKeys,
              actualReceiptKeys: Object.keys(receipt ?? {}),
              planDigest: digest(JSON.stringify(plan)) === receipt?.planSha256,
              validProof: validFailedReadProof(
                plan?.failedReadProof,
                undefined,
                plan?.productRunId,
              ),
              receiptProofEqual:
                JSON.stringify(receipt?.failedReadProof) === JSON.stringify(plan?.failedReadProof),
              status: receipt?.status,
              featureStatus: receipt?.featureStatus,
            }),
          );
        return true;
      }
      const names = (await readdir(directory)).sort();
      if (JSON.stringify(names) !== JSON.stringify(["STOP", "intent.json", "receipt.json"]))
        return true;
      const intentFile = await readPrivateFile(join(directory, "intent.json"), 16 * 1024);
      const receiptFile = await readPrivateFile(join(directory, "receipt.json"), MAX_REPORT_BYTES);
      const stopFile = await readPrivateFile(join(directory, "STOP"), MAX_STOP_BYTES);
      const intent = reportObject(intentFile.bytes);
      const receipt = reportObject(receiptFile.bytes);
      const plan = receipt?.plan;
      const proofKind = plan?.proofKind ?? "pre-run-api-rejected";
      const hasProofKind = Object.hasOwn(plan ?? {}, "proofKind");
      const expectedPlanKeys =
        proofKind === "fixed-read-failed-run"
          ? failedReadPlanKeys
          : proofKind === "fixed-read-verifier-busy-success"
            ? recoveredReadPlanKeys
            : proofKind === "fixed-groups-verifier-recovery-success"
              ? recoveredGroupsPlanKeys
              : proofKind === "pre-run-sent-no-ingress"
                ? sentPlanKeys
                : hasProofKind
                  ? apiPlanKeys
                  : legacyPlanKeys;
      const expectedReceiptKeys =
        proofKind === "fixed-read-failed-run"
          ? failedReadReceiptKeys
          : proofKind === "fixed-read-verifier-busy-success"
            ? recoveredReadReceiptKeys
            : proofKind === "fixed-groups-verifier-recovery-success"
              ? recoveredGroupsReceiptKeys
              : proofKind === "pre-run-sent-no-ingress"
                ? sentReceiptKeys
                : hasProofKind
                  ? apiReceiptKeys
                  : baseReceiptKeys;
      const reportFile = await readPrivateFile(plan.reportPath, MAX_REPORT_BYTES);
      const report = reportObject(reportFile.bytes);
      const caseRecord = report?.cases?.length === 1 ? report.cases[0] : undefined;
      if (
        !exactKeys(intent, intentKeys) ||
        !exactKeys(receipt, expectedReceiptKeys) ||
        !exactKeys(plan, expectedPlanKeys) ||
        receipt.schemaVersion !== 1 ||
        receipt.kind !== "qq-live-pre-run-stop-archive-receipt" ||
        receipt.status !== "ARCHIVE_VERIFIED" ||
        receipt.cleanupVerified !== true ||
        receipt.cleanupOnly !== true ||
        receipt.featurePass !== false ||
        ![
          "pre-run-api-rejected",
          "pre-run-sent-no-ingress",
          "fixed-read-failed-run",
          "fixed-read-verifier-busy-success",
          "fixed-groups-verifier-recovery-success",
        ].includes(proofKind) ||
        receipt.actualQqDeliveryVerified !== (proofKind !== "pre-run-api-rejected") ||
        (hasProofKind && receipt.proofKind !== proofKind) ||
        receipt.featureStatus !==
          (proofKind === "fixed-read-failed-run" ? "FAIL" : "INCONCLUSIVE") ||
        (proofKind !== "fixed-read-failed-run" &&
          proofKind !== "fixed-read-verifier-busy-success" &&
          proofKind !== "fixed-groups-verifier-recovery-success" &&
          (receipt.zeroMarkedMessages !== true || receipt.zeroMarkedRuns !== true)) ||
        intent.schemaVersion !== 1 ||
        intent.kind !== "qq-live-pre-run-stop-archive-intent" ||
        intent.status !== "ARCHIVE_INTENT" ||
        intent.planSha256 !== receipt.planSha256 ||
        digest(JSON.stringify(plan)) !== receipt.planSha256 ||
        receipt.archivedStopSha256 !== plan.stopSha256 ||
        intent.reportSha256 !== plan.reportSha256 ||
        intent.latestSha256 !== plan.latestSha256 ||
        intent.stopSha256 !== plan.stopSha256 ||
        !exactKeys(intent.stopFingerprint, ["dev", "ino", "mode", "size", "mtimeMs"]) ||
        JSON.stringify(intent.stopFingerprint) !== JSON.stringify(plan.stopFingerprint) ||
        intent.stopPath !== plan.stopPath ||
        intent.archivedStopPath !== plan.archivedStopPath ||
        intent.runId !== plan.runId ||
        plan.schemaVersion !== 1 ||
        plan.kind !== "qq-live-pre-run-stop-archive" ||
        plan.runId !== entry.name ||
        plan.archiveDirectory !== directory ||
        plan.archivedStopPath !== join(directory, "STOP") ||
        plan.stopPath !== join(out, "STOP") ||
        plan.latestPath !== join(out, "latest.json") ||
        dirname(dirname(plan.reportPath)) !== resolve(out) ||
        basename(dirname(plan.reportPath)) !== plan.runId ||
        plan.cleanupOnly !== true ||
        plan.featurePass !== false ||
        plan.actualQqDeliveryVerified !== (proofKind !== "pre-run-api-rejected") ||
        (proofKind === "pre-run-sent-no-ingress" &&
          (plan.productIngressVerified !== false ||
            plan.productRunObserved !== false ||
            receipt.productIngressVerified !== false ||
            receipt.productRunObserved !== false ||
            plan.dualAccountDelivery?.verified !== true)) ||
        (proofKind === "fixed-read-failed-run" &&
          (plan.caseId !== "qq-account-status-read" ||
            plan.productIngressVerified !== true ||
            plan.productRunObserved !== true ||
            !/^[a-f0-9-]{36}$/iu.test(plan.productRunId ?? "") ||
            plan.productRunStatus !== "failed" ||
            plan.productRunFailureCode !== "required_evidence_missing" ||
            !validFailedReadProof(plan.failedReadProof, caseRecord, plan.productRunId) ||
            receipt.productIngressVerified !== true ||
            receipt.productRunObserved !== true ||
            receipt.productRunId !== plan.productRunId ||
            receipt.productRunStatus !== plan.productRunStatus ||
            receipt.productRunFailureCode !== plan.productRunFailureCode ||
            JSON.stringify(receipt.failedReadProof) !== JSON.stringify(plan.failedReadProof))) ||
        (proofKind === "fixed-read-verifier-busy-success" &&
          (plan.caseId !== "qq-account-status-read" ||
            plan.caseStatus !== "PASS" ||
            plan.caseCode !== "REAL_REPLY_RECEIVED" ||
            plan.productIngressVerified !== true ||
            plan.productRunObserved !== true ||
            !/^[a-f0-9-]{36}$/iu.test(plan.productRunId ?? "") ||
            plan.productRunStatus !== "succeeded" ||
            !validRecoveredReadProof(plan.recoveredReadProof, caseRecord, plan.productRunId) ||
            receipt.productIngressVerified !== true ||
            receipt.productRunObserved !== true ||
            receipt.productRunId !== plan.productRunId ||
            receipt.productRunStatus !== plan.productRunStatus ||
            JSON.stringify(receipt.recoveredReadProof) !==
              JSON.stringify(plan.recoveredReadProof))) ||
        (proofKind === "fixed-groups-verifier-recovery-success" &&
          (plan.caseId !== "qq-managed-groups-inventory-read" ||
            plan.caseStatus !== "PASS" ||
            plan.caseCode !== "REAL_REPLY_RECEIVED" ||
            plan.inputObserved !== true ||
            plan.productIngressVerified !== true ||
            plan.productRunObserved !== true ||
            !/^[a-f0-9-]{36}$/iu.test(plan.productRunId ?? "") ||
            plan.productRunStatus !== "succeeded" ||
            !validRecoveredGroupsProof(plan.recoveredGroupsProof, caseRecord, plan.productRunId) ||
            receipt.productIngressVerified !== true ||
            receipt.productRunObserved !== true ||
            receipt.productRunId !== plan.productRunId ||
            receipt.productRunStatus !== plan.productRunStatus ||
            JSON.stringify(receipt.recoveredGroupsProof) !==
              JSON.stringify(plan.recoveredGroupsProof))) ||
        plan.featureStatus !== (proofKind === "fixed-read-failed-run" ? "FAIL" : "INCONCLUSIVE") ||
        plan.caseStatus !==
          (proofKind === "pre-run-sent-no-ingress"
            ? "INCONCLUSIVE"
            : proofKind === "fixed-read-failed-run"
              ? "FAIL"
              : proofKind === "fixed-read-verifier-busy-success"
                ? "PASS"
                : proofKind === "fixed-groups-verifier-recovery-success"
                  ? "PASS"
                  : "BLOCKED") ||
        plan.caseCode !==
          (proofKind === "pre-run-sent-no-ingress"
            ? "INPUT_NOT_OBSERVED"
            : proofKind === "fixed-read-failed-run"
              ? "REPLY_ASSERTION_FAILED"
              : proofKind === "fixed-read-verifier-busy-success"
                ? "REAL_REPLY_RECEIVED"
                : proofKind === "fixed-groups-verifier-recovery-success"
                  ? "REAL_REPLY_RECEIVED"
                  : "API_REJECTED") ||
        plan.route !== "private" ||
        plan.sendAttempted !== true ||
        plan.inputObserved !==
          (proofKind === "fixed-read-failed-run" ||
            proofKind === "fixed-read-verifier-busy-success" ||
            proofKind === "fixed-groups-verifier-recovery-success") ||
        plan.leaseRegistrationAttempted !== true ||
        plan.leaseRevoked !== true ||
        !isFixedPreRunReadCase(plan.caseId) ||
        !/^[a-f0-9]{64}$/u.test(plan.reportSha256 ?? "") ||
        !/^[a-f0-9]{64}$/u.test(plan.latestSha256 ?? "") ||
        !/^[a-f0-9]{64}$/u.test(plan.stopSha256 ?? "") ||
        !/^[a-f0-9]{64}$/u.test(plan.suiteSha256 ?? "") ||
        !/^[a-f0-9]{64}$/u.test(plan.toolsSha256 ?? "") ||
        !/^[a-f0-9]{32}$/u.test(plan.marker ?? "") ||
        !/^[a-f0-9-]{36}$/iu.test(plan.leaseId ?? "") ||
        !Number.isSafeInteger(plan.leaseExpiresAt) ||
        !validFingerprint(plan.reportFingerprint) ||
        !validFingerprint(plan.latestFingerprint) ||
        !validFingerprint(plan.stopFingerprint) ||
        !recordRuntime(plan.runtime) ||
        stopFile.sha256 !== plan.stopSha256 ||
        !sameFingerprint(stopFile.fingerprint, plan.stopFingerprint) ||
        stopFile.bytes.toString("utf8") !== EXPECTED_STOP
      )
        return true;
      if (
        reportFile.sha256 !== plan.reportSha256 ||
        !sameFingerprint(reportFile.fingerprint, plan.reportFingerprint) ||
        report.runId !== plan.runId ||
        report.mode !== "run" ||
        report.status !==
          (proofKind === "fixed-read-verifier-busy-success" ? "BLOCKED" : "INCONCLUSIVE") ||
        report.reportDirectory !== dirname(plan.reportPath) ||
        report.suiteSha256 !== plan.suiteSha256 ||
        report.safetyStopCreated !== true ||
        report.cleanupStopRequired !== true ||
        report.productAcceptance?.code !==
          (proofKind === "pre-run-sent-no-ingress"
            ? "LEASE_CLEANUP_EVIDENCE"
            : proofKind === "fixed-read-failed-run"
              ? "RUN_EVIDENCE"
              : proofKind === "fixed-read-verifier-busy-success"
                ? "INTERNAL_ERROR"
                : proofKind === "fixed-groups-verifier-recovery-success"
                  ? "AUTHORIZATION_EVIDENCE"
                  : "PRE_RUN_CLEANUP_EVIDENCE") ||
        report.productAcceptance?.cleanupVerified !== false ||
        (proofKind === "pre-run-sent-no-ingress" &&
          report.productAcceptance?.cleanupRequired !== true) ||
        (proofKind === "fixed-read-failed-run" &&
          report.productAcceptance?.cleanupRequired !== true) ||
        (proofKind === "fixed-read-verifier-busy-success" &&
          (report.productAcceptance?.cleanupRequired !== true ||
            JSON.stringify(report.runtime) !== JSON.stringify(plan.runtime) ||
            !isVerifierBusySuccessfulReadReport(report, caseRecord))) ||
        (proofKind === "fixed-groups-verifier-recovery-success" &&
          (report.productAcceptance?.cleanupRequired !== true ||
            report.productAcceptance?.status !== "INCONCLUSIVE" ||
            report.productAcceptance?.message !== GROUPS_VERIFIER_FAILURE_MESSAGE ||
            !Array.isArray(report.productAcceptance?.cases) ||
            report.productAcceptance.cases.length !== 0 ||
            JSON.stringify(report.runtime) !== JSON.stringify(plan.runtime) ||
            !isVerifierFailureSuccessfulManagedGroupsReport(report, caseRecord))) ||
        caseRecord?.id !== plan.caseId ||
        caseRecord.status !== plan.caseStatus ||
        caseRecord.code !== plan.caseCode ||
        caseRecord.route !== plan.route ||
        caseRecord.sendAttempted !== plan.sendAttempted ||
        caseRecord.inputObserved !== plan.inputObserved ||
        (proofKind === "pre-run-sent-no-ingress" &&
          ((caseRecord.runId !== undefined && caseRecord.runId !== null) ||
            (caseRecord.inputBinding !== undefined && caseRecord.inputBinding !== null) ||
            caseRecord.inputObserved !== false)) ||
        caseRecord.leaseRegistrationAttempted !== plan.leaseRegistrationAttempted ||
        caseRecord.leaseRevoked !== plan.leaseRevoked ||
        (proofKind === "pre-run-sent-no-ingress" &&
          (caseRecord.sentMessageId !== plan.dualAccountDelivery?.ownerMessageId ||
            !/^\d{1,20}$/u.test(plan.dualAccountDelivery?.botMessageId ?? "") ||
            !/^[a-f0-9]{64}$/u.test(plan.dualAccountDelivery?.textSha256 ?? "") ||
            !Number.isSafeInteger(plan.dualAccountDelivery?.textBytes) ||
            !/^\d{1,20}$/u.test(plan.dualAccountDelivery?.realSequence ?? "") ||
            !Number.isSafeInteger(plan.dualAccountDelivery?.time))) ||
        (proofKind === "fixed-read-failed-run" &&
          (caseRecord.route !== "private" ||
            caseRecord.sendAttempted !== true ||
            caseRecord.inputObserved !== true ||
            caseRecord.leaseRevoked !== true ||
            typeof caseRecord.sentMessageId !== "string" ||
            !/^\d{1,20}$/u.test(caseRecord.sentMessageId) ||
            !caseRecord.inputBinding ||
            (caseRecord.runId !== undefined && caseRecord.runId !== null))) ||
        (proofKind === "fixed-read-verifier-busy-success" &&
          (!isVerifierBusySuccessfulReadReport(report, caseRecord) ||
            caseRecord.leaseRevoked !== true)) ||
        (proofKind === "fixed-groups-verifier-recovery-success" &&
          (!isVerifierFailureSuccessfulManagedGroupsReport(report, caseRecord) ||
            !(await fixedManagedGroupsCase(
              caseRecord,
              await readFile(new URL("../examples/feature-read.example.json", import.meta.url)),
            )) ||
            caseRecord.leaseRevoked !== true)) ||
        caseRecord.token !== plan.marker ||
        caseRecord.acceptanceLease?.leaseId !== plan.leaseId ||
        caseRecord.acceptanceLease?.expiresAt !== plan.leaseExpiresAt ||
        caseRecord.acceptanceLease?.toolsSha256 !== plan.toolsSha256
      )
        return true;
    } catch {
      return true;
    }
  }
  return false;
}

function recordRuntime(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const base = ["checkout", "dataDirectory", "commit", "pid", "connectionId", "threadId"];
  const development = ["development", "sourceTreeSha256"];
  const keys = Object.keys(value).sort();
  const expected = [...base, ...(value.development === true ? development : [])].sort();
  return (
    JSON.stringify(keys) === JSON.stringify(expected) &&
    typeof value.checkout === "string" &&
    typeof value.dataDirectory === "string" &&
    /^[a-f0-9]{40}$/u.test(value.commit ?? "") &&
    Number.isSafeInteger(value.pid) &&
    typeof value.connectionId === "string" &&
    (value.threadId === null || typeof value.threadId === "string") &&
    (value.development === undefined ||
      (value.development === true && /^[a-f0-9]{64}$/u.test(value.sourceTreeSha256 ?? "")))
  );
}

/** Read-only approval plan. It never archives or rewrites the report or STOP. */
export async function planPreRunStoppedReport(
  input,
  {
    readRuntime,
    verifyReport = verifyPreRunCleanupReport,
    verifyFailedReadReport = verifyFixedFailedReadReport,
    verifyRecoveredReadReport = verifyRecoveredSuccessfulRead,
    verifyRecoveredGroupsReport = verifyRecoveredManagedGroupsReport,
    clients,
    locksDirectory = join(homedir(), ".glassbox-qq-live-locks"),
  } = {},
) {
  const verified = await verifyPreRunStoppedReport(input, {
    readRuntime,
    verifyReport,
    verifyFailedReadReport,
    verifyRecoveredReadReport,
    verifyRecoveredGroupsReport,
    clients,
  });
  const out = dirname(verified.stopPath);
  if (await hasUnresolvedPreRunStopReconciliation(out))
    reject("PRE_RUN_STOP_RECONCILIATION_PENDING");
  const report = reportObject((await readPrivateFile(verified.reportPath, MAX_REPORT_BYTES)).bytes);
  const reportFile = await readPrivateFile(verified.reportPath, MAX_REPORT_BYTES);
  const stopFile = await readPrivateFile(verified.stopPath, MAX_STOP_BYTES);
  if (reportFile.sha256 !== verified.reportSha256 || stopFile.sha256 !== verified.stopSha256)
    reject("PRE_RUN_STOP_CHANGED");
  const latest = await latestSnapshot(out, report);
  const lockRoot = resolve(locksDirectory);
  await assertPathsAbsent(lockPaths(input.config, lockRoot));
  if (
    await hasUnresolvedAcceptanceMemoryReconciliation(out, {
      stopPath: verified.stopPath,
      guardPath: lockPaths(input.config, lockRoot)[1],
      replacementStop: buildPreRunReplacementStopEvidence(verified, report, latest),
    })
  )
    reject("PRE_RUN_STOP_RECONCILIATION_PENDING");
  const archiveDirectory = join(out, "pre-run-stop-reconciliation", report.runId);
  try {
    await lstat(archiveDirectory);
    reject("PRE_RUN_STOP_ARCHIVE_EXISTS");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const plan = {
    schemaVersion: 1,
    kind: "qq-live-pre-run-stop-archive",
    reportPath: verified.reportPath,
    reportSha256: reportFile.sha256,
    reportFingerprint: reportFile.fingerprint,
    latestPath: latest.path,
    latestSha256: latest.sha256,
    latestFingerprint: latest.fingerprint,
    stopPath: verified.stopPath,
    stopSha256: verified.stopSha256,
    stopFingerprint: stopFile.fingerprint,
    locksDirectory: lockRoot,
    archiveDirectory,
    archivedStopPath: join(archiveDirectory, "STOP"),
    runId: report.runId,
    suiteSha256: report.suiteSha256,
    runtime: verified.runtime,
    caseId: verified.caseId,
    caseStatus: verified.caseStatus,
    caseCode: verified.caseCode,
    proofKind: verified.proofKind,
    route: verified.route,
    sendAttempted: verified.sendAttempted,
    inputObserved: verified.inputObserved,
    leaseRegistrationAttempted: verified.leaseRegistrationAttempted,
    leaseRevoked: verified.leaseRevoked,
    leaseId: verified.leaseId,
    leaseExpiresAt: verified.leaseExpiresAt,
    marker: verified.marker,
    toolsSha256: verified.toolsSha256,
    ...(verified.dualAccountDelivery ? { dualAccountDelivery: verified.dualAccountDelivery } : {}),
    ...(verified.proofKind === "fixed-read-failed-run"
      ? {
          productIngressVerified: true,
          productRunObserved: true,
          productRunId: verified.productRunId,
          productRunStatus: verified.productRunStatus,
          productRunFailureCode: verified.productRunFailureCode,
          failedReadProof: verified.failedReadProof,
        }
      : {}),
    ...(verified.proofKind === "fixed-read-verifier-busy-success"
      ? {
          productIngressVerified: true,
          productRunObserved: true,
          productRunId: verified.productRunId,
          productRunStatus: verified.productRunStatus,
          recoveredReadProof: verified.recoveredReadProof,
        }
      : {}),
    ...(verified.proofKind === "fixed-groups-verifier-recovery-success"
      ? {
          productIngressVerified: true,
          productRunObserved: true,
          productRunId: verified.productRunId,
          productRunStatus: verified.productRunStatus,
          recoveredGroupsProof: verified.recoveredGroupsProof,
        }
      : {}),
    cleanupOnly: true,
    featurePass: false,
    actualQqDeliveryVerified: verified.actualQqDeliveryVerified,
    ...(verified.proofKind === "pre-run-sent-no-ingress"
      ? { productIngressVerified: false, productRunObserved: false }
      : {}),
    featureStatus: verified.proofKind === "fixed-read-failed-run" ? "FAIL" : "INCONCLUSIVE",
  };
  return {
    status: "PRE_RUN_STOP_ARCHIVE_PLANNED",
    plan,
    planSha256: digest(JSON.stringify(plan)),
  };
}

/** Archive only the exact approved STOP after a second independent report/runtime/lease check. */
export async function archivePreRunStoppedReport(
  { plan, planSha256 },
  {
    config,
    approvedPlanSha256,
    readRuntime,
    verifyReport = verifyPreRunCleanupReport,
    verifyFailedReadReport,
    verifyRecoveredReadReport = verifyRecoveredSuccessfulRead,
    verifyRecoveredGroupsReport = verifyRecoveredManagedGroupsReport,
    clients,
    locksDirectory = join(homedir(), ".glassbox-qq-live-locks"),
  } = {},
) {
  if (
    !plan ||
    plan.kind !== "qq-live-pre-run-stop-archive" ||
    digest(JSON.stringify(plan)) !== planSha256 ||
    approvedPlanSha256 !== planSha256 ||
    resolve(locksDirectory) !== plan.locksDirectory
  )
    reject("PRE_RUN_STOP_APPROVAL");
  const out = dirname(plan.stopPath);
  if (
    plan.stopPath !== join(out, "STOP") ||
    plan.latestPath !== join(out, "latest.json") ||
    dirname(dirname(plan.reportPath)) !== out ||
    plan.runId !== basename(dirname(plan.reportPath)) ||
    plan.archiveDirectory !== join(out, "pre-run-stop-reconciliation", plan.runId) ||
    plan.archivedStopPath !== join(plan.archiveDirectory, "STOP") ||
    plan.cleanupOnly !== true ||
    plan.featurePass !== false ||
    ![
      "pre-run-api-rejected",
      "pre-run-sent-no-ingress",
      "fixed-read-failed-run",
      "fixed-read-verifier-busy-success",
      "fixed-groups-verifier-recovery-success",
    ].includes(plan.proofKind) ||
    plan.actualQqDeliveryVerified !== (plan.proofKind !== "pre-run-api-rejected") ||
    (plan.proofKind === "pre-run-sent-no-ingress" &&
      (plan.productIngressVerified !== false || plan.productRunObserved !== false)) ||
    (plan.proofKind === "fixed-read-failed-run" &&
      (plan.caseId !== "qq-account-status-read" ||
        plan.caseStatus !== "FAIL" ||
        plan.caseCode !== "REPLY_ASSERTION_FAILED" ||
        plan.inputObserved !== true ||
        plan.productIngressVerified !== true ||
        plan.productRunObserved !== true ||
        !/^[a-f0-9-]{36}$/iu.test(plan.productRunId ?? "") ||
        plan.productRunStatus !== "failed" ||
        plan.productRunFailureCode !== "required_evidence_missing" ||
        !plan.failedReadProof)) ||
    (plan.proofKind === "fixed-read-verifier-busy-success" &&
      (plan.caseId !== "qq-account-status-read" ||
        plan.caseStatus !== "PASS" ||
        plan.caseCode !== "REAL_REPLY_RECEIVED" ||
        plan.productIngressVerified !== true ||
        plan.productRunObserved !== true ||
        !/^[a-f0-9-]{36}$/iu.test(plan.productRunId ?? "") ||
        plan.productRunStatus !== "succeeded" ||
        !plan.recoveredReadProof)) ||
    (plan.proofKind === "fixed-groups-verifier-recovery-success" &&
      (plan.caseId !== "qq-managed-groups-inventory-read" ||
        plan.caseStatus !== "PASS" ||
        plan.caseCode !== "REAL_REPLY_RECEIVED" ||
        plan.inputObserved !== true ||
        plan.productIngressVerified !== true ||
        plan.productRunObserved !== true ||
        !/^[a-f0-9-]{36}$/iu.test(plan.productRunId ?? "") ||
        plan.productRunStatus !== "succeeded" ||
        !plan.recoveredGroupsProof)) ||
    plan.inputObserved !==
      (plan.proofKind === "fixed-read-failed-run" ||
        plan.proofKind === "fixed-read-verifier-busy-success" ||
        plan.proofKind === "fixed-groups-verifier-recovery-success") ||
    plan.sendAttempted !== true ||
    plan.leaseRevoked !== true
  )
    reject("PRE_RUN_STOP_PLAN");
  const [lockPath, ...guardPaths] = lockPaths(config, locksDirectory);
  let lock;
  let lockStat;
  let movedStop = false;
  try {
    await mkdir(locksDirectory, { recursive: true, mode: 0o700 });
    const locksStat = await lstat(locksDirectory);
    if (
      !locksStat.isDirectory() ||
      locksStat.isSymbolicLink() ||
      (locksStat.mode & 0o077) !== 0 ||
      (typeof process.getuid === "function" && locksStat.uid !== process.getuid())
    )
      reject("PRE_RUN_STOP_LOCK_PATH");
    lock = await open(lockPath, "wx", 0o600);
    lockStat = await lock.stat();
    await lock.writeFile(
      JSON.stringify({
        pid: process.pid,
        startedAt: new Date().toISOString(),
        action: "pre-run-stop-archive",
      }),
    );
    await lock.sync();
    await syncDirectory(locksDirectory);
    await assertPathsAbsent(guardPaths);
    if (await hasUnresolvedPreRunStopReconciliation(out))
      reject("PRE_RUN_STOP_RECONCILIATION_PENDING");
    const verifiedNow = await verifyPreRunStoppedReport(
      { reportPath: plan.reportPath, stopPath: plan.stopPath, config },
      {
        readRuntime,
        verifyReport,
        verifyFailedReadReport,
        verifyRecoveredReadReport,
        verifyRecoveredGroupsReport,
        clients,
      },
    );
    const reportNow = await readPrivateFile(plan.reportPath, MAX_REPORT_BYTES);
    const stopNow = await readPrivateFile(plan.stopPath, MAX_STOP_BYTES);
    const latestNow = await latestSnapshot(dirname(plan.stopPath), reportObject(reportNow.bytes));
    if (
      verifiedNow.reportSha256 !== plan.reportSha256 ||
      verifiedNow.stopSha256 !== plan.stopSha256 ||
      JSON.stringify(verifiedNow.runtime) !== JSON.stringify(plan.runtime) ||
      !sameFingerprint(stopNow.fingerprint, plan.stopFingerprint) ||
      reportNow.sha256 !== plan.reportSha256 ||
      latestNow.sha256 !== plan.latestSha256
    )
      reject("PRE_RUN_STOP_PLAN_CHANGED");
    const reportForReplacement = reportObject(reportNow.bytes);
    if (
      await hasUnresolvedAcceptanceMemoryReconciliation(out, {
        stopPath: plan.stopPath,
        guardPath: guardPaths[0],
        replacementStop: buildPreRunReplacementStopEvidence(
          verifiedNow,
          reportForReplacement,
          latestNow,
        ),
      })
    )
      reject("PRE_RUN_STOP_RECONCILIATION_PENDING");
    const archiveRoot = dirname(plan.archiveDirectory);
    try {
      const existing = await lstat(archiveRoot);
      if (!existing.isDirectory() || existing.isSymbolicLink() || (existing.mode & 0o077) !== 0)
        reject("PRE_RUN_STOP_ARCHIVE_PATH");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      await mkdir(archiveRoot, { mode: 0o700 });
      await syncDirectory(dirname(archiveRoot));
    }
    const parent = await lstat(archiveRoot);
    if (
      !parent.isDirectory() ||
      parent.isSymbolicLink() ||
      (parent.mode & 0o077) !== 0 ||
      (typeof process.getuid === "function" && parent.uid !== process.getuid())
    )
      reject("PRE_RUN_STOP_ARCHIVE_PATH");
    await mkdir(plan.archiveDirectory, { mode: 0o700 });
    const intent = {
      schemaVersion: 1,
      kind: "qq-live-pre-run-stop-archive-intent",
      status: "ARCHIVE_INTENT",
      planSha256,
      reportSha256: plan.reportSha256,
      latestSha256: plan.latestSha256,
      stopSha256: plan.stopSha256,
      stopFingerprint: plan.stopFingerprint,
      stopPath: plan.stopPath,
      archivedStopPath: plan.archivedStopPath,
      runId: plan.runId,
    };
    await writeDurableReport(join(plan.archiveDirectory, "intent.json"), intent);
    const currentStop = await readPrivateFile(plan.stopPath, MAX_STOP_BYTES);
    if (
      currentStop.sha256 !== plan.stopSha256 ||
      !sameFingerprint(currentStop.fingerprint, plan.stopFingerprint)
    )
      reject("PRE_RUN_STOP_CHANGED");
    await rename(plan.stopPath, plan.archivedStopPath);
    movedStop = true;
    await syncDirectory(dirname(plan.stopPath));
    await syncDirectory(plan.archiveDirectory);
    const archivedStop = await readPrivateFile(plan.archivedStopPath, MAX_STOP_BYTES);
    if (
      archivedStop.sha256 !== plan.stopSha256 ||
      !sameFingerprint(archivedStop.fingerprint, plan.stopFingerprint)
    )
      reject("PRE_RUN_STOP_ARCHIVE_CHANGED");
    const reportFile = await readPrivateFile(plan.reportPath, MAX_REPORT_BYTES);
    const latestFile = await readPrivateFile(plan.latestPath, MAX_REPORT_BYTES);
    if (reportFile.sha256 !== plan.reportSha256 || latestFile.sha256 !== plan.latestSha256)
      reject("PRE_RUN_STOP_PLAN_CHANGED");
    const report = reportObject(reportFile.bytes);
    const failedRead = plan.proofKind === "fixed-read-failed-run";
    const recoveredRead = plan.proofKind === "fixed-read-verifier-busy-success";
    const recoveredGroups = plan.proofKind === "fixed-groups-verifier-recovery-success";
    const cleanup = await (
      failedRead
        ? verifyFailedReadReport
        : recoveredRead
          ? verifyRecoveredReadReport
          : recoveredGroups
            ? verifyRecoveredGroupsReport
            : verifyReport
    )(report, config, {
      readRuntime,
      clients,
    });
    if (
      cleanup?.status !==
        (plan.proofKind === "pre-run-sent-no-ingress" ||
        failedRead ||
        recoveredRead ||
        recoveredGroups
          ? "CLEANUP_RECONCILED"
          : "CLEANUP_VERIFIED") ||
      JSON.stringify(cleanup.runtime) !== JSON.stringify(plan.runtime) ||
      cleanup.cases?.[0]?.leaseId !== plan.leaseId ||
      cleanup.cases?.[0]?.marker !== plan.marker ||
      cleanup.cases?.[0]?.actualQqDeliveryVerified !== plan.actualQqDeliveryVerified ||
      (failedRead
        ? cleanup.cases?.[0]?.productRunId !== plan.productRunId ||
          cleanup.cases?.[0]?.productRunStatus !== plan.productRunStatus ||
          cleanup.cases?.[0]?.productRunFailureCode !== plan.productRunFailureCode ||
          cleanup.cases?.[0]?.featureStatus !== "FAIL" ||
          cleanup.cases?.[0]?.productIngressVerified !== true ||
          cleanup.cases?.[0]?.productRunObserved !== true ||
          !validFailedReadProof(cleanup.cases?.[0]?.proof, report.cases[0], plan.productRunId) ||
          JSON.stringify(cleanup.cases?.[0]?.proof) !== JSON.stringify(plan.failedReadProof)
        : recoveredRead
          ? cleanup.cases?.[0]?.productRunId !== plan.productRunId ||
            cleanup.cases?.[0]?.productRunStatus !== plan.productRunStatus ||
            cleanup.cases?.[0]?.featureStatus !== "INCONCLUSIVE" ||
            cleanup.cases?.[0]?.productIngressVerified !== true ||
            cleanup.cases?.[0]?.productRunObserved !== true ||
            !validRecoveredReadProof(
              cleanup.cases?.[0]?.proof,
              report.cases[0],
              plan.productRunId,
            ) ||
            JSON.stringify(cleanup.cases?.[0]?.proof) !== JSON.stringify(plan.recoveredReadProof)
          : recoveredGroups
            ? cleanup.cases?.[0]?.productRunId !== plan.productRunId ||
              cleanup.cases?.[0]?.productRunStatus !== plan.productRunStatus ||
              cleanup.cases?.[0]?.featureStatus !== "INCONCLUSIVE" ||
              cleanup.cases?.[0]?.productIngressVerified !== true ||
              cleanup.cases?.[0]?.productRunObserved !== true ||
              !validRecoveredGroupsProof(
                cleanup.cases?.[0]?.proof,
                report.cases[0],
                plan.productRunId,
              ) ||
              JSON.stringify(cleanup.cases?.[0]?.proof) !==
                JSON.stringify(plan.recoveredGroupsProof)
            : cleanup.cases?.[0]?.zeroMarkedMessages !== true ||
              cleanup.cases?.[0]?.zeroMarkedRuns !== true)
    )
      reject("PRE_RUN_STOP_FINAL_RECHECK");
    const receipt = {
      schemaVersion: 1,
      kind: "qq-live-pre-run-stop-archive-receipt",
      status: "ARCHIVE_VERIFIED",
      plan,
      planSha256,
      proofKind: plan.proofKind,
      archivedStopSha256: archivedStop.sha256,
      cleanupVerified: true,
      cleanupOnly: true,
      featurePass: false,
      actualQqDeliveryVerified: plan.actualQqDeliveryVerified,
      featureStatus: failedRead ? "FAIL" : "INCONCLUSIVE",
      ...(!failedRead && !recoveredRead && !recoveredGroups
        ? { zeroMarkedMessages: true, zeroMarkedRuns: true }
        : {}),
      ...(plan.proofKind === "pre-run-sent-no-ingress"
        ? {
            productIngressVerified: false,
            productRunObserved: false,
            dualAccountDelivery: plan.dualAccountDelivery,
          }
        : {}),
      ...(failedRead
        ? {
            productIngressVerified: true,
            productRunObserved: true,
            productRunId: plan.productRunId,
            productRunStatus: plan.productRunStatus,
            productRunFailureCode: plan.productRunFailureCode,
            failedReadProof: plan.failedReadProof,
          }
        : {}),
      ...(recoveredRead
        ? {
            productIngressVerified: true,
            productRunObserved: true,
            productRunId: plan.productRunId,
            productRunStatus: plan.productRunStatus,
            recoveredReadProof: plan.recoveredReadProof,
          }
        : {}),
      ...(recoveredGroups
        ? {
            productIngressVerified: true,
            productRunObserved: true,
            productRunId: plan.productRunId,
            productRunStatus: plan.productRunStatus,
            recoveredGroupsProof: plan.recoveredGroupsProof,
          }
        : {}),
    };
    await writeDurableReport(join(plan.archiveDirectory, "receipt.json"), receipt);
    const saved = await readFile(join(plan.archiveDirectory, "receipt.json"));
    if (sha256(saved) !== sha256(Buffer.from(JSON.stringify(receipt, null, 2) + "\n")))
      reject("PRE_RUN_STOP_RECEIPT");
    return receipt;
  } catch (error) {
    if (movedStop) {
      try {
        const archived = await readPrivateFile(plan.archivedStopPath, MAX_STOP_BYTES);
        let originalExists = true;
        try {
          await lstat(plan.stopPath);
        } catch (statError) {
          if (statError?.code === "ENOENT") originalExists = false;
          else throw statError;
        }
        if (!originalExists && archived.sha256 === plan.stopSha256) {
          await rename(plan.archivedStopPath, plan.stopPath);
          await syncDirectory(dirname(plan.stopPath));
          movedStop = false;
        }
      } catch {
        // Preserve the archive intent and leave the exact archived STOP for manual review.
      }
    }
    if (error?.code === "EEXIST") reject("PRE_RUN_STOP_ACTIVE_OR_PENDING");
    throw error;
  } finally {
    await lock?.close().catch(() => {});
    if (lockStat) {
      try {
        const current = await lstat(lockPath);
        if (current.dev === lockStat.dev && current.ino === lockStat.ino) {
          await rm(lockPath);
          await syncDirectory(locksDirectory);
        }
      } catch {
        // A retained lock is safer than deleting an unverified replacement.
      }
    }
  }
}
