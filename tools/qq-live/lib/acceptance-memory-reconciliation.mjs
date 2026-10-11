import {
  open,
  readFile,
  lstat,
  mkdir,
  realpath,
  chmod,
  rename,
  unlink,
  readdir,
} from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { digest, fail, toolManifestDigest, validateConfig } from "./core.mjs";
import {
  loadAcceptanceMemoryCleanupInputs,
  readCurrentInventory,
  verifyAcceptanceMemoryCleanupOrigin,
} from "./acceptance-memory-cleanup-cli.mjs";
import {
  acceptanceMemoryInventorySha256,
  buildAcceptanceMemoryCleanupPlan,
  verifyAcceptanceMemoryCleanup,
} from "./acceptance-memory-cleanup-plan.mjs";
import { runtimeInspectionSnapshot, readTraceEvents } from "./product-evidence.mjs";
import { verifyLeaseCleanupEvidence } from "./lease-cleanup-evidence.mjs";
import { isFixedPreRunReadCase } from "./pre-run-cleanup-cases.mjs";

const HASH = /^[a-f0-9]{64}$/u;
const ID = /^[A-Za-z0-9_-]{1,128}$/u;
const UUID = /^[a-f0-9-]{36}$/iu;
const MAX_REPORT = 128 * 1024;
const MAX_STOP = 16 * 1024;
const MAX_JOURNAL = 40 * (1024 * 1024 + 1);
const VERIFIER_BUSY_FRAMES = [
  { path: "tools/qq-live/lib/product-evidence.mjs", line: 493, column: 6 },
  { path: "tools/qq-live/lib/product-evidence.mjs", line: 1802, column: 22 },
  { path: "tools/qq-live/lib/product-evidence.mjs", line: 1961, column: 34 },
  { path: "tools/qq-live/cli.mjs", line: 2435, column: 21 },
];
const MEDIA_RECOVERY_STOP =
  "CLEANUP_UNCONFIRMED\n请先检查 Bot 的延迟任务、目标状态和本轮报告，再人工删除此文件。\n";

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, keys) {
  return isRecord(value) && Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
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
    throw new TypeError("Invalid reconciliation evidence.");
  return result;
}

function sha(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function blocked(code = "MEMORY_RECONCILIATION_EVIDENCE") {
  fail(code, "固定记忆清理证据无法独立核实，保留停止标记。", "INCONCLUSIVE");
}

async function readPrivate(path, maxBytes) {
  if (typeof path !== "string" || !path.startsWith("/") || resolve(path) !== path)
    blocked("MEMORY_RECONCILIATION_PATH");
  let before;
  try {
    before = await lstat(path);
  } catch {
    blocked("MEMORY_RECONCILIATION_READ");
  }
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.size > maxBytes ||
    (before.mode & 0o077) !== 0 ||
    (typeof process.getuid === "function" && before.uid !== process.getuid())
  )
    blocked("MEMORY_RECONCILIATION_FILE");
  let bytes;
  try {
    if ((await realpath(path)) !== path) blocked("MEMORY_RECONCILIATION_PATH");
    bytes = await readFile(path);
  } catch {
    blocked("MEMORY_RECONCILIATION_READ");
  }
  const after = await lstat(path);
  if (
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.size !== after.size ||
    before.mtimeMs !== after.mtimeMs ||
    bytes.length !== before.size
  )
    blocked("MEMORY_RECONCILIATION_CHANGED");
  return { bytes, sha256: sha(bytes), stat: before };
}

function parseJson(bytes) {
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    blocked("MEMORY_RECONCILIATION_JSON");
  }
}

async function fingerprint(path, maxBytes = MAX_STOP) {
  const file = await readPrivate(path, maxBytes);
  return {
    sha256: file.sha256,
    dev: file.stat.dev,
    ino: file.stat.ino,
    size: file.stat.size,
    mtimeMs: file.stat.mtimeMs,
    bytes: file.bytes,
  };
}

function same(a, b) {
  return canonical(a) === canonical(b);
}

function validFileFingerprint(value) {
  return (
    isRecord(value) &&
    Object.keys(value).sort().join("\0") ===
      ["dev", "ino", "mode", "size", "mtimeMs"].sort().join("\0") &&
    Number.isSafeInteger(value.dev) &&
    Number.isSafeInteger(value.ino) &&
    Number.isSafeInteger(value.mode) &&
    Number.isSafeInteger(value.size) &&
    Number.isFinite(value.mtimeMs)
  );
}

function matchesFileFingerprint(file, expected) {
  return (
    validFileFingerprint(expected) &&
    file.stat.dev === expected.dev &&
    file.stat.ino === expected.ino &&
    file.stat.mode === expected.mode &&
    file.stat.size === expected.size &&
    file.stat.mtimeMs === expected.mtimeMs
  );
}

async function verifyRecoveredReadReplacementEvidence(evidence, report, latest, caseRecord) {
  let suite;
  try {
    suite = await readFile(new URL("../examples/feature-read.example.json", import.meta.url));
  } catch {
    return false;
  }
  let fixedSuite;
  try {
    fixedSuite = JSON.parse(suite.toString("utf8"));
  } catch {
    return false;
  }
  const specs = fixedSuite?.cases?.filter((item) => item?.id === "qq-account-status-read");
  const spec = specs?.length === 1 ? specs[0] : null;
  const token = caseRecord?.token;
  const proof = evidence.recoveredReadProof;
  const proofKeys = [
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
  const proofBase = {};
  if (isRecord(proof)) for (const key of proofKeys.slice(0, -1)) proofBase[key] = proof[key];
  const input = caseRecord?.inputBinding;
  const reply = caseRecord?.replies?.length === 1 ? caseRecord.replies[0] : null;
  const expectedPrompt =
    typeof token === "string" && /^[a-f0-9]{32}$/u.test(token)
      ? `GLASSBOX_ACCEPTANCE_V1 ${token}\n${spec?.prompt?.replaceAll("{{nonce}}", token)}`
      : "";
  const expectedTools = spec
    ? JSON.parse(JSON.stringify(spec.leaseTools).replaceAll("{{nonce}}", token))
    : [];
  const expectedAssertions = spec
    ? JSON.parse(JSON.stringify(spec.featureAssertions).replaceAll("{{nonce}}", token))
    : [];
  const inputKeys = ["driverMessageId", "botMessageId", "realSequence", "time", "textSha256"];
  const inputKeysWithDriverTime = [...inputKeys, "driverTime"];
  const validInputKeys = exactKeys(input, inputKeys) || exactKeys(input, inputKeysWithDriverTime);

  return (
    report.suiteSha256 === digest(suite) &&
    spec?.chat === "private" &&
    spec?.sideEffect === "none" &&
    evidence.productRunStatus === "succeeded" &&
    UUID.test(evidence.productRunId ?? "") &&
    caseRecord.id === "qq-account-status-read" &&
    caseRecord.status === "PASS" &&
    caseRecord.code === "REAL_REPLY_RECEIVED" &&
    caseRecord.route === "private" &&
    caseRecord.sendAttempted === true &&
    caseRecord.inputObserved === true &&
    caseRecord.leaseRegistrationAttempted === true &&
    caseRecord.leaseRevoked === true &&
    (caseRecord.runId === undefined || caseRecord.runId === null) &&
    caseRecord.prompt === expectedPrompt &&
    canonical(caseRecord.expected) === canonical([token]) &&
    Array.isArray(caseRecord.leasedToolNames) &&
    canonical(caseRecord.leasedToolNames) === canonical(expectedTools.map((tool) => tool.name)) &&
    canonical(caseRecord.featureAssertions) === canonical(expectedAssertions) &&
    exactKeys(caseRecord.acceptanceLease, ["leaseId", "expiresAt", "toolsSha256"]) &&
    UUID.test(caseRecord.acceptanceLease.leaseId ?? "") &&
    Number.isSafeInteger(caseRecord.acceptanceLease.expiresAt) &&
    caseRecord.acceptanceLease.expiresAt > 0 &&
    caseRecord.acceptanceLease.toolsSha256 === toolManifestDigest(expectedTools) &&
    validInputKeys &&
    /^[0-9]{1,20}$/u.test(input.driverMessageId ?? "") &&
    /^[0-9]{1,20}$/u.test(input.botMessageId ?? "") &&
    /^\d{1,30}$/u.test(input.realSequence ?? "") &&
    Number.isSafeInteger(input.time) &&
    (input.driverTime === undefined || Number.isSafeInteger(input.driverTime)) &&
    HASH.test(input.textSha256 ?? "") &&
    caseRecord.sentMessageId === input.driverMessageId &&
    caseRecord.botInputMessageId === input.botMessageId &&
    Array.isArray(caseRecord.botInputMessageIds) &&
    canonical(caseRecord.botInputMessageIds) === canonical([input.botMessageId]) &&
    Array.isArray(caseRecord.botInputCandidates) &&
    caseRecord.botInputCandidates.length === 1 &&
    caseRecord.botInputCandidates[0]?.messageId === input.botMessageId &&
    caseRecord.botInputCandidates[0]?.textSha256 === input.textSha256 &&
    input.textSha256 === digest(caseRecord.prompt) &&
    Array.isArray(caseRecord.replies) &&
    caseRecord.replies.length === 1 &&
    reply.route === "private" &&
    reply.matches === true &&
    /^[0-9]{1,20}$/u.test(reply.messageId ?? "") &&
    HASH.test(reply.textSha256 ?? "") &&
    Number.isSafeInteger(reply.textBytes) &&
    reply.textBytes > 0 &&
    typeof reply.receivedAt === "string" &&
    Number.isFinite(Date.parse(reply.receivedAt)) &&
    report.productAcceptance?.status === "BLOCKED" &&
    report.productAcceptance?.message ===
      "测试器内部异常。未输出原始错误，以避免泄露凭证。请运行本地自检。" &&
    report.productAcceptance?.diagnostic?.type === "Error" &&
    report.productAcceptance?.diagnostic?.sqliteCode === 5 &&
    JSON.stringify(report.productAcceptance?.diagnostic?.frames) ===
      JSON.stringify(VERIFIER_BUSY_FRAMES) &&
    Array.isArray(report.productAcceptance?.cases) &&
    report.productAcceptance.cases.length === 0 &&
    latest.productAcceptance?.status === "BLOCKED" &&
    exactKeys(proof, proofKeys) &&
    JSON.stringify(Object.keys(proof)) === JSON.stringify(proofKeys) &&
    proof.proofKind === "fixed-qq-account-status-read-verifier-busy-v1" &&
    proof.caseId === caseRecord.id &&
    proof.productRunId === evidence.productRunId &&
    proof.productRunStatus === evidence.productRunStatus &&
    canonical(proof.inputBinding) === canonical(input) &&
    exactKeys(proof.reply, ["messageId", "receivedAt", "textSha256", "textBytes", "matches"]) &&
    proof.reply.messageId === reply.messageId &&
    proof.reply.receivedAt === reply.receivedAt &&
    proof.reply.textSha256 === reply.textSha256 &&
    proof.reply.textBytes === reply.textBytes &&
    proof.reply.matches === true &&
    exactKeys(proof.delivery, ["id", "status", "externalId", "destinationScopeKey"]) &&
    typeof proof.delivery.id === "string" &&
    proof.delivery.id.length > 0 &&
    proof.delivery.status === "sent" &&
    /^[0-9]{1,20}$/u.test(proof.delivery.externalId ?? "") &&
    typeof proof.delivery.destinationScopeKey === "string" &&
    proof.delivery.destinationScopeKey.length > 0 &&
    exactKeys(proof.lease, ["leaseId", "marker", "toolsSha256", "revoked"]) &&
    proof.lease.leaseId === caseRecord.acceptanceLease.leaseId &&
    proof.lease.marker === token &&
    proof.lease.toolsSha256 === caseRecord.acceptanceLease.toolsSha256 &&
    proof.lease.revoked === true &&
    exactKeys(proof.verification, [
      "status",
      "caseId",
      "runId",
      "traceVerified",
      "cleanupVerified",
    ]) &&
    proof.verification.status === "PASS" &&
    proof.verification.caseId === caseRecord.id &&
    proof.verification.runId === evidence.productRunId &&
    proof.verification.traceVerified === true &&
    proof.verification.cleanupVerified === true &&
    HASH.test(proof.proofSha256 ?? "") &&
    digest(JSON.stringify(proofBase)) === proof.proofSha256
  );
}

async function verifyRecoveredGroupsReplacementEvidence(evidence, report, latest, caseRecord) {
  let suiteBytes;
  let suite;
  try {
    suiteBytes = await readFile(new URL("../examples/feature-read.example.json", import.meta.url));
    suite = JSON.parse(suiteBytes.toString("utf8"));
  } catch {
    return false;
  }
  const specs = suite?.cases?.filter((item) => item?.id === "qq-managed-groups-inventory-read");
  const spec = suite?.schemaVersion === 2 && specs?.length === 1 ? specs[0] : null;
  const token = caseRecord?.token;
  const proof = evidence.recoveredGroupsProof;
  const proofKeys = [
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
  const proofBase = {};
  if (isRecord(proof)) for (const key of proofKeys.slice(0, -1)) proofBase[key] = proof[key];
  const expectedPrompt =
    typeof token === "string" && /^[a-f0-9]{32}$/u.test(token)
      ? `GLASSBOX_ACCEPTANCE_V1 ${token}\n${spec?.prompt?.replaceAll("{{nonce}}", token)}`
      : "";
  const expectedAssertions = spec
    ? JSON.parse(JSON.stringify(spec.featureAssertions).replaceAll("{{nonce}}", token))
    : [];
  const expectedTools = spec
    ? JSON.parse(JSON.stringify(spec.leaseTools).replaceAll("{{nonce}}", token))
    : [];
  const lease = caseRecord?.acceptanceLease;
  const input = caseRecord?.inputBinding;
  const reply = caseRecord?.replies?.length === 1 ? caseRecord.replies[0] : null;
  const inputKeys = ["driverMessageId", "botMessageId", "realSequence", "time", "textSha256"];
  const inputWithDriverTime = [...inputKeys, "driverTime"];
  return (
    report.suiteSha256 === digest(suiteBytes) &&
    spec?.chat === "private" &&
    spec?.sideEffect === "none" &&
    caseRecord?.id === "qq-managed-groups-inventory-read" &&
    caseRecord.status === "PASS" &&
    caseRecord.code === "REAL_REPLY_RECEIVED" &&
    caseRecord.route === "private" &&
    caseRecord.prompt === expectedPrompt &&
    JSON.stringify(caseRecord.expected) === JSON.stringify([token]) &&
    JSON.stringify(caseRecord.featureAssertions) === JSON.stringify(expectedAssertions) &&
    JSON.stringify(caseRecord.leasedToolNames) ===
      JSON.stringify(expectedTools.map((tool) => tool.name)) &&
    caseRecord.sendAttempted === true &&
    caseRecord.inputObserved === true &&
    caseRecord.leaseRegistrationAttempted === true &&
    caseRecord.leaseRevoked === true &&
    (caseRecord.runId === undefined || caseRecord.runId === null) &&
    typeof caseRecord.sentMessageId === "string" &&
    /^\d{1,20}$/u.test(caseRecord.sentMessageId) &&
    (exactKeys(input, inputKeys) || exactKeys(input, inputWithDriverTime)) &&
    /^\d{1,20}$/u.test(input.driverMessageId ?? "") &&
    /^\d{1,20}$/u.test(input.botMessageId ?? "") &&
    /^\d{1,30}$/u.test(input.realSequence ?? "") &&
    Number.isSafeInteger(input.time) &&
    (input.driverTime === undefined || Number.isSafeInteger(input.driverTime)) &&
    HASH.test(input.textSha256 ?? "") &&
    exactKeys(lease, ["leaseId", "expiresAt", "toolsSha256"]) &&
    /^[a-f0-9-]{36}$/iu.test(lease.leaseId ?? "") &&
    Number.isSafeInteger(lease.expiresAt) &&
    lease.toolsSha256 === toolManifestDigest(expectedTools) &&
    Array.isArray(caseRecord.replies) &&
    caseRecord.replies.length === 1 &&
    reply.route === "private" &&
    reply.matches === true &&
    /^\d{1,20}$/u.test(reply.messageId ?? "") &&
    Number.isFinite(Date.parse(reply.receivedAt ?? "")) &&
    HASH.test(reply.textSha256 ?? "") &&
    Number.isSafeInteger(reply.textBytes) &&
    reply.textBytes > 0 &&
    evidence.productRunId === proof.productRunId &&
    evidence.productRunStatus === "succeeded" &&
    exactKeys(proof, proofKeys) &&
    JSON.stringify(Object.keys(proof)) === JSON.stringify(proofKeys) &&
    proof.proofKind === "fixed-qq-managed-groups-inventory-read-verifier-recovery-v1" &&
    proof.caseId === caseRecord.id &&
    proof.productRunStatus === "succeeded" &&
    JSON.stringify(proof.inputBinding) === JSON.stringify(input) &&
    exactKeys(proof.reply, ["messageId", "receivedAt", "textSha256", "textBytes", "matches"]) &&
    proof.reply.messageId === reply.messageId &&
    proof.reply.receivedAt === reply.receivedAt &&
    proof.reply.textSha256 === reply.textSha256 &&
    proof.reply.textBytes === reply.textBytes &&
    proof.reply.matches === true &&
    exactKeys(proof.delivery, ["id", "status", "externalId", "destinationScopeKey"]) &&
    typeof proof.delivery.id === "string" &&
    proof.delivery.id.length > 0 &&
    proof.delivery.status === "sent" &&
    /^\d{1,20}$/u.test(proof.delivery.externalId ?? "") &&
    typeof proof.delivery.destinationScopeKey === "string" &&
    proof.delivery.destinationScopeKey.length > 0 &&
    exactKeys(proof.lease, ["leaseId", "marker", "toolsSha256", "revoked"]) &&
    proof.lease.leaseId === lease.leaseId &&
    proof.lease.marker === token &&
    proof.lease.toolsSha256 === lease.toolsSha256 &&
    proof.lease.revoked === true &&
    exactKeys(proof.verification, [
      "status",
      "caseId",
      "runId",
      "traceVerified",
      "cleanupVerified",
    ]) &&
    proof.verification.status === "PASS" &&
    proof.verification.caseId === caseRecord.id &&
    proof.verification.runId === evidence.productRunId &&
    proof.verification.traceVerified === true &&
    proof.verification.cleanupVerified === true &&
    HASH.test(proof.proofSha256 ?? "") &&
    digest(JSON.stringify(proofBase)) === proof.proofSha256 &&
    evidence.proofKind === "fixed-groups-verifier-recovery-success" &&
    evidence.caseId === caseRecord.id &&
    latest?.productAcceptance?.status === report.productAcceptance.status &&
    latest?.productAcceptance?.code === report.productAcceptance.code
  );
}

async function verifyReplacementStopEvidence(
  evidence,
  receipt,
  stopPath,
  archivedStop,
  currentStopStat,
  mediaRecoveryContext,
) {
  if (evidence?.proofKind === "active-media-recovery")
    return verifyActiveMediaRecoveryStopEvidence(
      evidence,
      receipt,
      stopPath,
      archivedStop,
      currentStopStat,
      mediaRecoveryContext,
    );
  const baseKeys = [
    "runId",
    "reportPath",
    "reportSha256",
    "reportFingerprint",
    "latestPath",
    "latestSha256",
    "latestFingerprint",
    "stopPath",
    "stopSha256",
    "stopFingerprint",
  ];
  const proofKind = evidence?.proofKind;
  const recoveredRead = proofKind === "fixed-read-verifier-busy-success";
  const recoveredGroups = proofKind === "fixed-groups-verifier-recovery-success";
  const keys =
    proofKind === "pre-run-sent-no-ingress"
      ? [...baseKeys, "proofKind", "dualAccountDelivery"]
      : proofKind === "fixed-read-failed-run"
        ? [
            ...baseKeys,
            "proofKind",
            "productRunId",
            "productRunStatus",
            "productRunFailureCode",
            "failedReadProof",
          ]
        : recoveredRead
          ? [...baseKeys, "proofKind", "productRunId", "productRunStatus", "recoveredReadProof"]
          : recoveredGroups
            ? [
                ...baseKeys,
                "proofKind",
                "productRunId",
                "productRunStatus",
                "caseId",
                "recoveredGroupsProof",
              ]
            : [...baseKeys, "proofKind"];
  const runIdMatch = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})(\.\d{3}Z)_([a-f0-9]{8})$/u.exec(
    evidence?.runId ?? "",
  );
  if (
    !exactKeys(evidence, keys) ||
    ![
      "pre-run-api-rejected",
      "pre-run-sent-no-ingress",
      "fixed-read-failed-run",
      "fixed-read-verifier-busy-success",
      "fixed-groups-verifier-recovery-success",
    ].includes(proofKind) ||
    evidence.stopPath !== stopPath ||
    evidence.latestPath !== join(dirname(stopPath), "latest.json") ||
    !runIdMatch ||
    evidence.reportPath !== join(dirname(stopPath), evidence.runId, "report.json") ||
    !HASH.test(evidence.reportSha256 ?? "") ||
    !HASH.test(evidence.latestSha256 ?? "") ||
    !HASH.test(evidence.stopSha256 ?? "") ||
    !validFileFingerprint(evidence.reportFingerprint) ||
    !validFileFingerprint(evidence.latestFingerprint) ||
    !validFileFingerprint(evidence.stopFingerprint)
  )
    return false;
  const archivedAt = Date.parse(receipt.archivedAt);
  const runTimestamp = Date.parse(
    `${runIdMatch[1]}T${runIdMatch[2]}:${runIdMatch[3]}:${runIdMatch[4]}${runIdMatch[5]}`,
  );
  if (!Number.isFinite(archivedAt) || !Number.isFinite(runTimestamp) || runTimestamp <= archivedAt)
    return false;
  const [currentStop, reportFile, latestFile] = await Promise.all([
    readPrivate(stopPath, MAX_STOP),
    readPrivate(evidence.reportPath, MAX_REPORT),
    readPrivate(evidence.latestPath, MAX_REPORT),
  ]);
  if (
    !matchesFileFingerprint(currentStop, evidence.stopFingerprint) ||
    !matchesFileFingerprint(reportFile, evidence.reportFingerprint) ||
    !matchesFileFingerprint(latestFile, evidence.latestFingerprint) ||
    reportFile.sha256 !== evidence.reportSha256 ||
    latestFile.sha256 !== evidence.latestSha256 ||
    currentStop.sha256 !== evidence.stopSha256 ||
    currentStop.sha256 !== archivedStop.sha256 ||
    (currentStop.stat.dev === archivedStop.stat.dev &&
      currentStop.stat.ino === archivedStop.stat.ino) ||
    currentStop.stat.dev !== currentStopStat.dev ||
    currentStop.stat.ino !== currentStopStat.ino ||
    currentStop.stat.mtimeMs <= archivedAt ||
    currentStop.stat.mtimeMs > reportFile.stat.mtimeMs ||
    reportFile.stat.mtimeMs > latestFile.stat.mtimeMs
  )
    return false;
  const report = parseJson(reportFile.bytes);
  const latest = parseJson(latestFile.bytes);
  const caseRecord = report?.cases?.length === 1 ? report.cases[0] : null;
  const failedRead = proofKind === "fixed-read-failed-run";
  const fixedBase =
    report?.mode === "run" &&
    report.runId === evidence.runId &&
    report.reportDirectory === dirname(evidence.reportPath) &&
    report.status === (recoveredRead ? "BLOCKED" : "INCONCLUSIVE") &&
    report.safetyStopCreated === true &&
    report.cleanupStopRequired === true &&
    report.productAcceptance?.code ===
      (proofKind === "pre-run-sent-no-ingress"
        ? "LEASE_CLEANUP_EVIDENCE"
        : failedRead
          ? "RUN_EVIDENCE"
          : recoveredRead
            ? "INTERNAL_ERROR"
            : recoveredGroups
              ? "AUTHORIZATION_EVIDENCE"
              : "PRE_RUN_CLEANUP_EVIDENCE") &&
    report.productAcceptance?.cleanupVerified === false &&
    ((proofKind !== "pre-run-sent-no-ingress" &&
      !failedRead &&
      !recoveredRead &&
      !recoveredGroups) ||
      report.productAcceptance?.cleanupRequired === true) &&
    (!recoveredGroups ||
      (report.productAcceptance?.status === "INCONCLUSIVE" &&
        report.productAcceptance?.message === "拒绝记录缺少独立且精确绑定的内容排除证据。" &&
        Array.isArray(report.productAcceptance?.cases) &&
        report.productAcceptance.cases.length === 0)) &&
    caseRecord &&
    isFixedPreRunReadCase(caseRecord.id) &&
    caseRecord.route === "private" &&
    caseRecord.sendAttempted === true &&
    caseRecord.inputObserved === (failedRead || recoveredRead || recoveredGroups) &&
    caseRecord.leaseRegistrationAttempted === true &&
    caseRecord.leaseRevoked === true &&
    latest?.mode === report.mode &&
    latest.runId === report.runId &&
    latest.status === report.status &&
    latest.reportDirectory === report.reportDirectory &&
    latest.productAcceptance?.status === report.productAcceptance.status &&
    latest.productAcceptance?.code === report.productAcceptance.code;
  if (!fixedBase) return false;
  if (proofKind === "pre-run-api-rejected")
    return caseRecord.status === "BLOCKED" && caseRecord.code === "API_REJECTED";
  if (recoveredRead)
    return verifyRecoveredReadReplacementEvidence(evidence, report, latest, caseRecord);
  if (recoveredGroups)
    return verifyRecoveredGroupsReplacementEvidence(evidence, report, latest, caseRecord);
  if (failedRead) {
    let fixedSuite;
    let suiteCase;
    try {
      fixedSuite = JSON.parse(
        await readFile(new URL("../examples/feature-read.example.json", import.meta.url), "utf8"),
      );
      suiteCase = fixedSuite.cases.filter((item) => item?.id === "qq-account-status-read");
    } catch {
      return false;
    }
    const spec = suiteCase?.length === 1 ? suiteCase[0] : null;
    const proof = evidence.failedReadProof;
    const proofKeys = [
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
    const proofBase = {};
    if (isRecord(proof)) for (const key of proofKeys.slice(0, -1)) proofBase[key] = proof[key];
    const reply = caseRecord.replies?.length === 1 ? caseRecord.replies[0] : null;
    const input = caseRecord.inputBinding;
    const lease = caseRecord.acceptanceLease;
    const expectedPrompt =
      typeof caseRecord.token === "string" && /^[a-f0-9]{32}$/u.test(caseRecord.token)
        ? `GLASSBOX_ACCEPTANCE_V1 ${caseRecord.token}\n${spec?.prompt?.replaceAll("{{nonce}}", caseRecord.token)}`
        : "";
    const expectedTools = spec
      ? JSON.parse(JSON.stringify(spec.leaseTools).replaceAll("{{nonce}}", caseRecord.token))
      : [];
    const expectedAssertions = spec
      ? JSON.parse(JSON.stringify(spec.featureAssertions).replaceAll("{{nonce}}", caseRecord.token))
      : [];
    return (
      report.suiteSha256 ===
        digest(await readFile(new URL("../examples/feature-read.example.json", import.meta.url))) &&
      spec?.chat === "private" &&
      spec?.sideEffect === "none" &&
      caseRecord.id === "qq-account-status-read" &&
      caseRecord.status === "FAIL" &&
      caseRecord.code === "REPLY_ASSERTION_FAILED" &&
      caseRecord.inputObserved === true &&
      caseRecord.runId == null &&
      caseRecord.prompt === expectedPrompt &&
      canonical(caseRecord.expected) === canonical([caseRecord.token]) &&
      Array.isArray(caseRecord.leasedToolNames) &&
      canonical(caseRecord.leasedToolNames) === canonical(expectedTools.map((tool) => tool.name)) &&
      canonical(caseRecord.featureAssertions) === canonical(expectedAssertions) &&
      lease?.toolsSha256 === toolManifestDigest(expectedTools) &&
      typeof caseRecord.sentMessageId === "string" &&
      caseRecord.sentMessageId === input?.driverMessageId &&
      input?.textSha256 === digest(caseRecord.prompt) &&
      input?.botMessageId === caseRecord.botInputMessageId &&
      Array.isArray(caseRecord.botInputMessageIds) &&
      canonical(caseRecord.botInputMessageIds) === canonical([input.botMessageId]) &&
      Array.isArray(caseRecord.botInputCandidates) &&
      caseRecord.botInputCandidates.length === 1 &&
      caseRecord.botInputCandidates[0]?.messageId === input.botMessageId &&
      caseRecord.botInputCandidates[0]?.textSha256 === input.textSha256 &&
      exactKeys(proof, proofKeys) &&
      JSON.stringify(Object.keys(proof)) === JSON.stringify(proofKeys) &&
      proof.proofKind === "fixed-qq-account-status-read-failed-run-v1" &&
      proof.caseId === caseRecord.id &&
      proof.productRunId === evidence.productRunId &&
      proof.productRunStatus === "failed" &&
      proof.productRunFailureCode === "required_evidence_missing" &&
      evidence.productRunStatus === "failed" &&
      evidence.productRunFailureCode === "required_evidence_missing" &&
      UUID.test(evidence.productRunId ?? "") &&
      JSON.stringify(proof.inputBinding) === JSON.stringify(input) &&
      exactKeys(proof.delivery, ["id", "status", "externalId", "destinationScopeKey"]) &&
      proof.delivery.status === "sent" &&
      typeof proof.delivery.id === "string" &&
      proof.delivery.id.length > 0 &&
      proof.reply?.driverMessageId === reply?.messageId &&
      proof.reply?.botMessageId === proof.delivery.externalId &&
      proof.reply?.textSha256 === reply?.textSha256 &&
      proof.reply?.textBytes === reply?.textBytes &&
      proof.reply?.receivedAt === reply?.receivedAt &&
      exactKeys(proof.lease, ["leaseId", "marker", "toolsSha256", "runId", "revoked"]) &&
      proof.lease.leaseId === lease?.leaseId &&
      proof.lease.marker === caseRecord.token &&
      proof.lease.toolsSha256 === lease?.toolsSha256 &&
      proof.lease.runId === evidence.productRunId &&
      proof.lease.revoked === true &&
      exactKeys(proof.trace, [
        "sessionStartCount",
        "toolCallCount",
        "toolResultCount",
        "statusReadCount",
        "identityLeaseDenialCount",
        "malformedInputDenialCount",
        "callOrder",
      ]) &&
      proof.trace.sessionStartCount === 2 &&
      proof.trace.toolCallCount === 3 &&
      proof.trace.toolResultCount === 3 &&
      proof.trace.statusReadCount === 1 &&
      proof.trace.identityLeaseDenialCount === 1 &&
      proof.trace.malformedInputDenialCount === 1 &&
      JSON.stringify(proof.trace.callOrder) ===
        JSON.stringify(["invalid_input", "get_status", "get_login_info_denied_by_lease"]) &&
      exactKeys(proof.authorization, ["accountStatusReadDecisionCount", "decisionIdsSha256"]) &&
      Number.isSafeInteger(proof.authorization.accountStatusReadDecisionCount) &&
      proof.authorization.accountStatusReadDecisionCount > 0 &&
      HASH.test(proof.authorization.decisionIdsSha256 ?? "") &&
      exactKeys(proof.safeRefusal, [
        "textSha256",
        "textBytes",
        "markerAbsent",
        "accountIdentityAbsent",
        "numericIdentifierAbsent",
        "refusalCuePresent",
      ]) &&
      HASH.test(proof.safeRefusal.textSha256 ?? "") &&
      Number.isSafeInteger(proof.safeRefusal.textBytes) &&
      proof.safeRefusal.markerAbsent === true &&
      proof.safeRefusal.accountIdentityAbsent === true &&
      proof.safeRefusal.numericIdentifierAbsent === true &&
      proof.safeRefusal.refusalCuePresent === true &&
      HASH.test(proof.proofSha256 ?? "") &&
      digest(JSON.stringify(proofBase)) === proof.proofSha256
    );
  }
  const delivery = evidence.dualAccountDelivery;
  return (
    caseRecord.id === "ops-status-read" &&
    caseRecord.status === "INCONCLUSIVE" &&
    caseRecord.code === "INPUT_NOT_OBSERVED" &&
    caseRecord.inputObserved === false &&
    (caseRecord.runId === undefined || caseRecord.runId === null) &&
    (caseRecord.inputBinding === undefined || caseRecord.inputBinding === null) &&
    typeof caseRecord.sentMessageId === "string" &&
    delivery?.verified === true &&
    delivery.ownerMessageId === caseRecord.sentMessageId &&
    typeof delivery.botMessageId === "string" &&
    /^\d{1,20}$/u.test(delivery.botMessageId) &&
    /^\d{1,20}$/u.test(delivery.realSequence ?? "") &&
    Number.isSafeInteger(delivery.time) &&
    /^[a-f0-9]{64}$/u.test(delivery.textSha256 ?? "") &&
    Number.isSafeInteger(delivery.textBytes) &&
    delivery.textBytes > 0
  );
}

async function verifyActiveMediaRecoveryStopEvidence(
  evidence,
  receipt,
  stopPath,
  archivedStop,
  currentStopStat,
  mediaRecoveryContext,
) {
  const evidenceKeys = [
    "proofKind",
    "planSha256",
    "driverSha256",
    "reportPath",
    "reportSha256",
    "latestPath",
    "latestSha256",
    "checkpointPath",
    "checkpointSha256",
    "pendingPath",
    "pendingSha256",
    "stopPath",
    "stopSha256",
  ];
  const resumeBlockKeys = [
    "resumeBlockReportPath",
    "resumeBlockReportSha256",
    "resumeBlockReportFingerprint",
  ];
  const hasResumeBlockEvidence = resumeBlockKeys.some((key) => Object.hasOwn(evidence ?? {}, key));
  const keys = hasResumeBlockEvidence ? [...evidenceKeys, ...resumeBlockKeys] : evidenceKeys;
  if (
    !exactKeys(evidence, keys) ||
    evidence.proofKind !== "active-media-recovery" ||
    !HASH.test(evidence.planSha256 ?? "") ||
    !HASH.test(evidence.driverSha256 ?? "") ||
    !HASH.test(evidence.reportSha256 ?? "") ||
    !HASH.test(evidence.latestSha256 ?? "") ||
    !HASH.test(evidence.checkpointSha256 ?? "") ||
    !HASH.test(evidence.pendingSha256 ?? "") ||
    !HASH.test(evidence.stopSha256 ?? "") ||
    evidence.stopPath !== stopPath ||
    evidence.latestPath !== join(dirname(stopPath), "latest.json") ||
    !validAbsolutePath(evidence.reportPath) ||
    !validAbsolutePath(evidence.checkpointPath) ||
    !validAbsolutePath(evidence.pendingPath) ||
    (hasResumeBlockEvidence &&
      (!validAbsolutePath(evidence.resumeBlockReportPath) ||
        !HASH.test(evidence.resumeBlockReportSha256 ?? "") ||
        !validFileFingerprint(evidence.resumeBlockReportFingerprint))) ||
    !isRecord(mediaRecoveryContext) ||
    !isRecord(mediaRecoveryContext.config) ||
    typeof mediaRecoveryContext.config.driver?.qq !== "string" ||
    typeof mediaRecoveryContext.locksDirectory !== "string" ||
    !mediaRecoveryContext.locksDirectory.startsWith("/") ||
    resolve(mediaRecoveryContext.locksDirectory) !== mediaRecoveryContext.locksDirectory
  )
    return false;

  const identity = createHash("sha256")
    .update(mediaRecoveryContext.config.driver.qq)
    .digest("hex")
    .slice(0, 24);
  if (
    receipt?.plan?.guardPath !==
      join(mediaRecoveryContext.locksDirectory, identity + ".memory-pending.json") ||
    evidence.pendingPath !==
      join(mediaRecoveryContext.locksDirectory, identity + ".media-pending.json")
  )
    return false;

  const archivedAt = Date.parse(receipt.archivedAt);
  if (!Number.isFinite(archivedAt) || evidence.stopSha256 !== sha(Buffer.from(MEDIA_RECOVERY_STOP)))
    return false;
  let currentStop;
  try {
    currentStop = await readPrivate(stopPath, MAX_STOP);
  } catch {
    return false;
  }
  if (
    currentStop.sha256 !== evidence.stopSha256 ||
    currentStop.stat.dev !== currentStopStat.dev ||
    currentStop.stat.ino !== currentStopStat.ino ||
    currentStop.stat.mode !== currentStopStat.mode ||
    currentStop.stat.size !== currentStopStat.size ||
    currentStop.stat.mtimeMs !== currentStopStat.mtimeMs ||
    currentStop.stat.mtimeMs <= archivedAt ||
    (currentStop.stat.dev === archivedStop.stat.dev &&
      currentStop.stat.ino === archivedStop.stat.ino)
  )
    return false;

  try {
    const { verifyActiveMediaRecoveryPlanBinding } = await import("./media-recovery.mjs");
    return await verifyActiveMediaRecoveryPlanBinding(evidence, mediaRecoveryContext);
  } catch {
    return false;
  }
}

function validAbsolutePath(value) {
  return typeof value === "string" && value.startsWith("/") && resolve(value) === value;
}

function verifyTransportAndProduct(report, plan) {
  const t = report.transportEvidence;
  const p = report.productEvidence;
  const proof = report.cleanupEvidence;
  if (
    !isRecord(t) ||
    !isRecord(p) ||
    !isRecord(proof) ||
    t.id !== "acceptance-memory-cleanup" ||
    t.route !== "private" ||
    !/^[a-f0-9]{32}$/u.test(t.token ?? "") ||
    t.status !== "PASS" ||
    t.code !== "REAL_REPLY_RECEIVED" ||
    t.sendAttempted !== true ||
    t.inputObserved !== true ||
    t.leaseRegistrationAttempted !== true ||
    t.leaseRevoked !== true ||
    !Array.isArray(t.anomalies) ||
    t.anomalies.length !== 0 ||
    t.promptSha256 !==
      digest(
        "GLASSBOX_ACCEPTANCE_V1 " +
          t.token +
          "\n" +
          plan.prompt.replaceAll("{{nonce}}", t.token).trim(),
      ) ||
    t.expectedSha256 !==
      digest(canonical(["{{nonce}}"].map((x) => x.replaceAll("{{nonce}}", t.token)))) ||
    !same(t.acceptanceLease, {
      leaseId: t.acceptanceLease?.leaseId,
      expiresAt: t.acceptanceLease?.expiresAt,
      toolsSha256: plan.toolsSha256,
    }) ||
    !UUID.test(t.acceptanceLease?.leaseId ?? "") ||
    !Number.isSafeInteger(t.acceptanceLease?.expiresAt) ||
    !isRecord(t.inputBinding) ||
    !Array.isArray(t.replies) ||
    t.replies.length !== 1 ||
    t.replies[0]?.route !== "private" ||
    t.replies[0]?.matches !== true ||
    !HASH.test(t.replies[0]?.textSha256 ?? "") ||
    !Number.isSafeInteger(t.replies[0]?.textBytes) ||
    t.replies[0].textBytes < 1 ||
    p.runId !== proof.runId ||
    p.principalId !== plan.principalId ||
    p.traceVerified !== true ||
    p.cleanupVerified !== true ||
    !same(p.inputBinding, t.inputBinding) ||
    proof.run?.runId !== p.runId ||
    proof.run?.principalId !== p.principalId ||
    proof.binding?.runId !== p.runId ||
    proof.binding?.principalId !== p.principalId ||
    proof.delivery?.runId !== p.runId ||
    proof.delivery?.principalId !== p.principalId ||
    proof.delivery?.delivered !== true ||
    proof.delivery?.route !== "private" ||
    proof.delivery?.recipientPrincipalId !== p.principalId ||
    t.inputBinding.botMessageId !== proof.binding.externalMessageId ||
    t.inputBinding.textSha256 !== proof.binding.textSha256 ||
    proof.toolCall?.runId !== p.runId ||
    proof.toolResult?.runId !== p.runId
  )
    blocked("MEMORY_RECONCILIATION_PRODUCT");
  const input = p.messageBinding?.input;
  const reply = p.messageBinding?.reply;
  if (
    !isRecord(input) ||
    !isRecord(reply) ||
    input.messageId !== t.inputBinding.botMessageId ||
    input.textSha256 !== t.inputBinding.textSha256 ||
    reply.botMessageId !== t.replies[0].messageId ||
    reply.textSha256 !== t.replies[0].textSha256 ||
    reply.driverMessageId !== proof.delivery.externalMessageId
  )
    blocked("MEMORY_RECONCILIATION_MESSAGE_BINDING");
}

function verifyTrace(trace, plan, proof) {
  if (!isRecord(trace) || trace.runId !== proof.runId || !Array.isArray(trace.events))
    blocked("MEMORY_RECONCILIATION_TRACE");
  const rows = trace.events;
  const calls = rows.filter(
    (row) => row.event?.type === "tool_call" && row.event?.data?.name === "owner_memory_admin",
  );
  const results = rows.filter(
    (row) => row.event?.type === "tool_result" && row.event?.data?.name === "owner_memory_admin",
  );
  if (calls.length !== 1 || results.length !== 1) blocked("MEMORY_RECONCILIATION_TRACE");
  const call = calls[0];
  const result = results[0];
  const inputProjection = proof.toolCall.inputProjection ?? "full";
  const expectedInput =
    inputProjection === "full"
      ? { action: "reject", candidateIds: plan.candidateIds }
      : inputProjection === "array-values-omitted"
        ? { action: "reject" }
        : null;
  if (
    call.event.runId !== proof.runId ||
    result.event.runId !== proof.runId ||
    !ID.test(call.event.data?.toolCallId ?? "") ||
    result.event.data?.toolCallId !== call.event.data.toolCallId ||
    expectedInput === null ||
    !same(call.event.data?.input, expectedInput) ||
    result.event.data?.isError !== false ||
    Number(result.seq) <= Number(call.seq) ||
    call.seq !== proof.toolCall.sequence ||
    result.seq !== proof.toolResult.sequence ||
    result.event.data?.outputBytes !== proof.toolResult.outputBytes ||
    result.event.data?.outputSha256 !== proof.toolResult.outputSha256
  )
    blocked("MEMORY_RECONCILIATION_TRACE");
}

function verifyDatabase(db, plan, proof, finalInventory, finalInventorySha256, cleanupReport) {
  const checked = verifyAcceptanceMemoryCleanup({
    plan,
    planSha256: cleanupReport.planSha256,
    cleanup: proof,
    finalInventory,
    finalInventorySha256,
  });
  if (checked.status !== "CLEANUP_VERIFIED" || checked.featurePass !== false)
    blocked("MEMORY_RECONCILIATION_CLEANUP_PROOF");
  const run = db
    .prepare(
      "SELECT r.id,r.status,r.principal_id,r.message_id,m.external_id,m.text FROM runs r JOIN messages m ON m.id=r.message_id WHERE r.id=?",
    )
    .get(proof.runId);
  if (
    !run ||
    run.principal_id !== proof.principalId ||
    run.status !== "succeeded" ||
    String(run.external_id) !== String(proof.binding.externalMessageId) ||
    digest(String(run.text).replace(/\r\n?/gu, "\n")) !== proof.binding.textSha256
  )
    blocked("MEMORY_RECONCILIATION_RUN");
  const sourceRunStatus = db.prepare("SELECT status FROM runs WHERE id=?");
  for (const sourceRunId of new Set(
    plan.inventory.candidates.map((candidate) => candidate.sourceRunId),
  )) {
    const source = sourceRunStatus.get(sourceRunId);
    if (!source || !["succeeded", "failed", "cancelled", "interrupted"].includes(source.status))
      blocked("MEMORY_RECONCILIATION_SOURCE_RUN");
  }
  const delivery = db
    .prepare("SELECT status,external_id,payload_text FROM deliveries WHERE id=? AND run_id=?")
    .get(proof.delivery.decisionId, proof.runId);
  const replyProof = cleanupReport.productEvidence?.messageBinding?.reply;
  if (
    !delivery ||
    delivery.status !== "sent" ||
    String(delivery.external_id) !== String(proof.delivery.externalMessageId) ||
    !replyProof ||
    digest(delivery.payload_text) !== replyProof.textSha256
  )
    blocked("MEMORY_RECONCILIATION_DELIVERY");
  const audits = db
    .prepare(
      "SELECT * FROM memory_audit_events WHERE run_id=? AND principal_id=? AND action='reject' ORDER BY sequence",
    )
    .all(proof.runId, proof.principalId);
  if (audits.length !== plan.candidateIds.length) blocked("MEMORY_RECONCILIATION_AUDIT");
  const auth = db.prepare(
    "SELECT id,action,resource_id,principal_id,decision,run_id FROM authorization_decisions_all WHERE id=? AND run_id=? AND principal_id=? AND decision='ALLOW' AND action='memory:govern' AND resource_id='owner-memory'",
  );
  for (let i = 0; i < audits.length; i++) {
    const row = audits[i];
    const expected = proof.rejectionAudits[i];
    const rowHash = sha(Buffer.from(canonical(row)));
    const decisions = auth.all(expected.decisionId, proof.runId, proof.principalId);
    if (
      row.id !== expected.id ||
      row.target_id !== plan.candidateIds[i] ||
      row.decision_id !== expected.decisionId ||
      rowHash !== expected.rowSha256 ||
      decisions.length !== 1
    )
      blocked("MEMORY_RECONCILIATION_AUDIT");
  }
  verifyAcceptanceMemoryLearningIsolation(db, proof.runId, proof.principalId, proof.learningWrites);
  verifyAcceptanceMemoryCandidateStates(db, plan.candidateIds);
  return checked;
}

export function verifyAcceptanceMemoryLearningIsolation(db, runId, principalId, stated) {
  const writes = db
    .prepare(
      "SELECT COUNT(*) AS n FROM memory_audit_events WHERE run_id=? AND principal_id=? AND action='write'",
    )
    .get(runId, principalId)?.n;
  const feedback = db
    .prepare("SELECT COUNT(*) AS n FROM feedback_events WHERE run_id=? AND principal_id=?")
    .get(runId, principalId)?.n;
  const sourced = db
    .prepare("SELECT COUNT(*) AS n FROM memory_candidates WHERE source_json LIKE ?")
    .get(`%${runId}%`)?.n;
  if (
    writes !== 0 ||
    feedback !== 0 ||
    sourced !== 0 ||
    !same(stated, {
      runId,
      principalId,
      candidateWriteAuditCount: 0,
      feedbackWriteCount: 0,
      candidateSourceCount: 0,
    })
  )
    blocked("MEMORY_RECONCILIATION_LEARNING");
  return true;
}

export function verifyAcceptanceMemoryCandidateStates(db, candidateIds) {
  if (
    !Array.isArray(candidateIds) ||
    candidateIds.length < 2 ||
    candidateIds.length > 20 ||
    new Set(candidateIds).size !== candidateIds.length ||
    candidateIds.some((id) => typeof id !== "string" || !/^candidate_[a-f0-9]{32}$/u.test(id)) ||
    candidateIds.some((id, index) => index > 0 && candidateIds[index - 1] >= id)
  )
    blocked("MEMORY_RECONCILIATION_INVENTORY");
  const targetRows = db
    .prepare(
      `SELECT id,status,promoted_memory_id FROM memory_candidates
       WHERE id IN (${candidateIds.map(() => "?").join(",")}) ORDER BY id`,
    )
    .all(...candidateIds);
  if (
    targetRows.length !== candidateIds.length ||
    targetRows.some(
      (row, index) =>
        row.id !== candidateIds[index] ||
        row.status !== "rejected" ||
        row.promoted_memory_id !== null,
    )
  )
    blocked("MEMORY_RECONCILIATION_INVENTORY");
  return true;
}

async function collect(config, options, out, deps) {
  if (typeof options.input !== "string" || typeof options.cleanupReport !== "string")
    fail("ARGUMENT", "归档核验需要固定清理清单和清理报告路径。");
  const getInputs = deps.loadInputs ?? loadAcceptanceMemoryCleanupInputs;
  const currentRuntime = deps.runtimeSnapshot ?? runtimeInspectionSnapshot;
  const readInventory = deps.readCurrentInventory ?? readCurrentInventory;
  const inputs = deps.inputsSnapshot ?? (await getInputs(config, options.input));
  if (deps.inputsSnapshot)
    await verifyInputSnapshotFiles(inputs, deps.guardArchivePath, deps.expectedJournalSha256);
  const reportFile = await readPrivate(options.cleanupReport, MAX_REPORT);
  const cleanupReport = parseJson(reportFile.bytes);
  const completedCleanupReceipt =
    cleanupReport.kind === "acceptance-memory-completed-cleanup" &&
    cleanupReport.status === "CLEANUP_RECONCILED";
  if (
    (!completedCleanupReceipt && cleanupReport.status !== "CLEANUP_VERIFIED") ||
    cleanupReport.cleanupOnly !== true ||
    cleanupReport.featurePass !== false ||
    !same(cleanupReport.origin, inputs.origin)
  )
    blocked("MEMORY_RECONCILIATION_REPORT");
  const runtime = await currentRuntime(config.runtime);
  if (!same(runtime, cleanupReport.runtime)) blocked("MEMORY_RECONCILIATION_RUNTIME");
  const planRecord = buildAcceptanceMemoryCleanupPlan({
    inventory: inputs.inventory,
    inventorySha256: acceptanceMemoryInventorySha256(inputs.inventory),
    runtime,
    origin: inputs.origin,
  });
  if (planRecord.sha256 !== cleanupReport.planSha256) blocked("MEMORY_RECONCILIATION_PLAN");
  if (completedCleanupReceipt) {
    const verifier =
      deps.verifyCompletedCleanupReceipt ??
      (await import("./acceptance-memory-completed-cleanup.mjs"))
        .verifyAcceptanceMemoryCompletedCleanupReceipt;
    const verified = await verifier({
      receiptPath: options.cleanupReport,
      reportPath: cleanupReport.failedReportPath,
      reportDirectory: dirname(cleanupReport.failedReportPath),
      manifestPath: options.input,
      config,
      out,
      expectedRuntime: runtime,
      deps: {
        ...deps,
        inputsSnapshot: inputs,
        ...(deps.guardArchivePath ? { guardArchivePath: deps.guardArchivePath } : {}),
        ...(deps.expectedJournalSha256
          ? { expectedJournalSha256: deps.expectedJournalSha256 }
          : {}),
      },
    });
    if (!verified) blocked("MEMORY_RECONCILIATION_COMPLETED_RECEIPT");
  } else {
    verifyTransportAndProduct(cleanupReport, planRecord.plan);
  }
  const observedResult = readInventory(runtime, inputs.inventory, inputs.sourceAuditRows, config);
  const observed = observedResult.inventory ? observedResult : await observedResult;
  let checked;
  try {
    (deps.verifyTrace ?? verifyTrace)(
      (deps.readTraceEvents ?? readTraceEvents)(
        runtime.checkout,
        runtime.dataDirectory,
        cleanupReport.cleanupProof.cleanupRunId,
        undefined,
        [],
      ),
      planRecord.plan,
      cleanupReport.cleanupEvidence,
    );
    checked = (deps.verifyDatabase ?? verifyDatabase)(
      observed.db,
      planRecord.plan,
      cleanupReport.cleanupEvidence,
      observed.inventory,
      observed.inventorySha256,
      cleanupReport,
    );
    if (!same(checked, cleanupReport.cleanupProof)) blocked("MEMORY_RECONCILIATION_PROOF");
    const scope = {
      connectionId: config.runtime.connectionId,
      botId: config.bot.qq,
      chatType: "private",
      chatId: config.driver.qq,
      senderId: config.driver.qq,
      threadId: config.runtime.threadId ?? null,
    };
    const leaseCase = {
      token: cleanupReport.transportEvidence.token,
      startedAt: cleanupReport.transportEvidence.startedAt,
      acceptanceLease: cleanupReport.transportEvidence.acceptanceLease,
      leaseRevoked: true,
      prompt: `GLASSBOX_ACCEPTANCE_V1 ${cleanupReport.transportEvidence.token}\n${planRecord.plan.prompt.replaceAll("{{nonce}}", cleanupReport.transportEvidence.token).trim()}`,
      inputBinding: cleanupReport.transportEvidence.inputBinding,
    };
    const lease = await (deps.verifyLease ?? verifyLeaseCleanupEvidence)({
      dataDirectory: runtime.dataDirectory,
      caseRecord: leaseCase,
      runId: cleanupReport.cleanupProof.cleanupRunId,
      scope,
      principalId: cleanupReport.cleanupProof.principalId,
    });
    if (
      lease.status !== "PASS" ||
      lease.revoked !== true ||
      lease.leaseId !== leaseCase.acceptanceLease.leaseId
    )
      blocked("MEMORY_RECONCILIATION_LEASE");
  } finally {
    observed.db.close();
  }
  const guardPath = inputs.manifest.pendingGuardPath;
  const stopPath = join(out, "STOP");
  const guardFile = await fingerprint(deps.guardArchivePath ?? guardPath, 1024 * 1024);
  if (guardFile.sha256 !== inputs.guard.sha256) blocked("MEMORY_RECONCILIATION_ORIGIN");
  const stopFile = await fingerprint(stopPath);
  const originState = await (deps.verifyOrigin ?? verifyAcceptanceMemoryCleanupOrigin)(
    config,
    inputs,
  );
  if (!same(originState.originalRuntime, inputs.originState?.originalRuntime))
    blocked("MEMORY_RECONCILIATION_ORIGIN");
  const currentAgain = await currentRuntime(config.runtime);
  if (!same(currentAgain, runtime)) blocked("MEMORY_RECONCILIATION_RUNTIME");
  const journalPath = join(dirname(inputs.manifest.originalReportPath), "memory-fixture.jsonl");
  const journalFile = await readPrivate(journalPath, MAX_JOURNAL);
  if (deps.expectedJournalSha256 && journalFile.sha256 !== deps.expectedJournalSha256)
    blocked("MEMORY_RECONCILIATION_ORIGIN");
  const plan = {
    schemaVersion: 1,
    kind: "acceptance-memory-guard-archive",
    cleanupOnly: true,
    featurePass: false,
    runtime,
    manifestPath: inputs.manifestPath,
    inventoryPath: inputs.manifest.inventoryPath,
    sourceAuditSnapshotPath: inputs.manifest.sourceAuditSnapshotPath,
    originalReportPath: inputs.manifest.originalReportPath,
    journalPath,
    journalSha256: journalFile.sha256,
    cleanupReportPath: options.cleanupReport,
    cleanupReportSha256: reportFile.sha256,
    cleanupPlanSha256: cleanupReport.planSha256,
    origin: inputs.origin,
    manifestSha256: inputs.manifestSha256,
    inventorySha256: inputs.inventoryFileSha256,
    sourceAuditSha256: inputs.sourceAuditSha256,
    cleanupProofSha256: digest(canonical(cleanupReport.cleanupProof)),
    stopPath,
    stopSha256: stopFile.sha256,
    guardPath,
    guardSha256: guardFile.sha256,
    cleanupRunId: cleanupReport.cleanupProof.cleanupRunId,
    candidateIds: cleanupReport.cleanupProof.candidateIds,
    rejectedCount: cleanupReport.cleanupProof.rejectedCount,
  };
  const sha256 = digest(canonical(plan));
  return {
    plan,
    sha256,
    paths: { guardPath, stopPath },
    fingerprints: { guard: guardFile, stop: stopFile },
    inputs,
    cleanupReport,
  };
}

async function verifyInputSnapshotFiles(inputs, guardArchivePath, expectedJournalSha256) {
  const manifestFile = await readPrivate(inputs.manifestPath, 4096);
  if (manifestFile.sha256 !== inputs.manifestSha256) blocked("MEMORY_RECONCILIATION_ORIGIN");
  const current = await Promise.all([
    readPrivate(inputs.manifest.inventoryPath, 64 * 1024),
    readPrivate(inputs.manifest.sourceAuditSnapshotPath, 16 * 1024 * 1024),
    readPrivate(inputs.manifest.originalReportPath, MAX_REPORT),
    readPrivate(
      join(dirname(inputs.manifest.originalReportPath), "memory-fixture.jsonl"),
      MAX_JOURNAL,
    ),
    readPrivate(guardArchivePath ?? inputs.manifest.pendingGuardPath, 1024 * 1024),
  ]);
  if (
    current[0].sha256 !== inputs.inventoryFileSha256 ||
    current[1].sha256 !== inputs.sourceAuditSha256 ||
    current[2].sha256 !== inputs.report.sha256 ||
    current[3].sha256 !== (expectedJournalSha256 ?? current[3].sha256) ||
    current[4].sha256 !== inputs.guard.sha256
  )
    blocked("MEMORY_RECONCILIATION_ORIGIN");
}

async function lockAccount(config, deps) {
  const root = deps.lockRoot ?? join(homedir(), ".glassbox-qq-live-locks");
  await mkdir(root, { recursive: true, mode: 0o700 });
  const path = join(root, `${digest(config.driver.qq).slice(0, 24)}.lock`);
  let handle;
  try {
    handle = await open(path, "wx", 0o600);
  } catch {
    fail("MEMORY_RECONCILIATION_LOCK", "该账号已有验收操作，保留当前标记。", "BLOCKED");
  }
  await handle.writeFile(
    JSON.stringify({
      pid: process.pid,
      action: "archive-acceptance-memory-guard",
      at: new Date().toISOString(),
    }),
  );
  await handle.sync();
  return { path, handle, identity: await handle.stat() };
}

/** Plan by default. Approved live action archives only the exact verified STOP and pending guard. */
export async function runAcceptanceMemoryReconciliationCli(config, options, out, deps = {}) {
  if (!isRecord(options) || options.case || options.scenarios)
    fail("ARGUMENT", "归档核验不接受自定义用例或场景。");
  const collectEvidence = deps.collectVerified ?? collect;
  const collected = await collectEvidence(config, options, out, deps);
  if (options.live !== true)
    return {
      status: "PLAN",
      cleanupOnly: true,
      featurePass: false,
      plan: collected.plan,
      sha256: collected.sha256,
    };
  if (options["approve-suite"] !== collected.sha256) blocked("APPROVAL_REQUIRED");
  (deps.validateConfig ?? validateConfig)(config, { live: true });
  const lock = await lockAccount(config, deps);
  try {
    const check = await collectEvidence(config, options, out, deps);
    if (check.sha256 !== collected.sha256) blocked("MEMORY_RECONCILIATION_CHANGED");
    const archiveId = randomUUID();
    const archiveBase = join(out, "acceptance-memory-reconciliation");
    await mkdir(archiveBase, { recursive: true, mode: 0o700 });
    await chmod(archiveBase, 0o700);
    const archiveDirectory = join(archiveBase, archiveId);
    await mkdir(archiveDirectory, { recursive: false, mode: 0o700 });
    await chmod(archiveDirectory, 0o700);
    const guardArchive = join(archiveDirectory, "pending-memory-fixture.json");
    const stopArchive = join(archiveDirectory, "STOP");
    await copyNew(guardArchive, check.fingerprints.guard.bytes);
    await copyNew(stopArchive, check.fingerprints.stop.bytes);
    const receipt = {
      schemaVersion: 1,
      kind: "acceptance-memory-guard-archive",
      status: "ARCHIVE_VERIFIED",
      cleanupOnly: true,
      featurePass: false,
      planSha256: check.sha256,
      plan: check.plan,
      archivedAt: new Date().toISOString(),
      archiveDirectory,
      archivedGuardPath: guardArchive,
      archivedStopPath: stopArchive,
      archivedGuardSha256: check.fingerprints.guard.sha256,
      archivedStopSha256: check.fingerprints.stop.sha256,
    };
    await writeNewJson(archiveDirectory, "intent.json", {
      schemaVersion: 1,
      kind: "acceptance-memory-guard-archive-intent",
      status: "ARCHIVE_INTENT",
      planSha256: check.sha256,
      guardPath: check.paths.guardPath,
      guardSha256: check.fingerprints.guard.sha256,
      stopPath: check.paths.stopPath,
      stopSha256: check.fingerprints.stop.sha256,
    });
    const latest = await collectEvidence(config, options, out, deps);
    if (latest.sha256 !== check.sha256) blocked("MEMORY_RECONCILIATION_CHANGED");
    await assertFileStill(check.paths.guardPath, check.fingerprints.guard);
    await assertFileStill(check.paths.stopPath, check.fingerprints.stop);
    // Move the guard first while STOP continues to block all normal runs. STOP moves last.
    let guardMoved = false;
    let stopMoved = false;
    try {
      const beforeGuardMove = await collectEvidence(config, options, out, deps);
      if (beforeGuardMove.sha256 !== check.sha256) blocked("MEMORY_RECONCILIATION_CHANGED");
      await assertFileStill(check.paths.guardPath, check.fingerprints.guard);
      await assertFileStill(check.paths.stopPath, check.fingerprints.stop);
      await (deps.rename ?? rename)(check.paths.guardPath, guardArchive);
      guardMoved = true;
      const movedGuard = await readPrivate(guardArchive, 1024 * 1024);
      if (movedGuard.sha256 !== check.fingerprints.guard.sha256)
        blocked("MEMORY_RECONCILIATION_CHANGED");
      const beforeStopMove = await collectEvidence(config, options, out, {
        ...deps,
        inputsSnapshot: check.inputs,
        guardArchivePath: guardArchive,
        expectedJournalSha256: check.plan.journalSha256,
      });
      if (beforeStopMove.sha256 !== check.sha256) blocked("MEMORY_RECONCILIATION_CHANGED");
      await assertFileStill(check.paths.stopPath, check.fingerprints.stop);
      await (deps.rename ?? rename)(check.paths.stopPath, stopArchive);
      stopMoved = true;
      const movedStop = await readPrivate(stopArchive, MAX_STOP);
      if (movedStop.sha256 !== check.fingerprints.stop.sha256)
        blocked("MEMORY_RECONCILIATION_CHANGED");
      for (const directoryPath of new Set([
        out,
        archiveDirectory,
        dirname(check.paths.guardPath),
        dirname(check.paths.stopPath),
      ])) {
        const directory = await open(directoryPath, "r");
        try {
          await directory.sync();
        } finally {
          await directory.close();
        }
      }
      await writeNewJson(archiveDirectory, "receipt.json", receipt);
      const resolved = await verifyAcceptanceMemoryReconciliationReceipt({
        receiptPath: join(archiveDirectory, "receipt.json"),
        stopPath: check.paths.stopPath,
        guardPath: check.paths.guardPath,
      });
      if (!resolved) blocked("MEMORY_RECONCILIATION_RECEIPT");
    } catch (error) {
      await writeNewJson(archiveDirectory, "failure.json", {
        schemaVersion: 1,
        kind: "acceptance-memory-guard-archive-failure",
        status: "INCONCLUSIVE",
        planSha256: check.sha256,
        errorCode:
          typeof error?.code === "string" && /^[A-Z0-9_]{1,64}$/u.test(error.code)
            ? error.code
            : "ARCHIVE_FAILED",
        at: new Date().toISOString(),
      }).catch(() => {});
      let restoreError;
      if (stopMoved) {
        try {
          await restoreExact(check.paths.stopPath, check.fingerprints.stop.bytes);
        } catch (restoreFailure) {
          restoreError = restoreFailure;
          await ensureBlockingStop(check.paths.stopPath, check.fingerprints.stop.bytes).catch(
            () => {},
          );
        }
      }
      if (guardMoved) {
        try {
          await restoreExact(check.paths.guardPath, check.fingerprints.guard.bytes);
        } catch (restoreFailure) {
          restoreError ??= restoreFailure;
        }
      }
      if (restoreError) throw restoreError;
      await ensureBlockingStop(check.paths.stopPath, check.fingerprints.stop.bytes);
      throw error;
    }
    return {
      status: "ARCHIVE_VERIFIED",
      cleanupOnly: true,
      featurePass: false,
      receiptPath: join(archiveDirectory, "receipt.json"),
      planSha256: check.sha256,
    };
  } finally {
    await lock.handle.close();
    const current = await lstat(lock.path).catch(() => null);
    if (current && current.dev === lock.identity.dev && current.ino === lock.identity.ino)
      await unlink(lock.path).catch(() => {});
  }
}

async function copyNew(path, bytes) {
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writeNewJson(directory, name, value) {
  const path = join(directory, name);
  await copyNew(path, Buffer.from(JSON.stringify(value, null, 2) + "\n"));
  const folder = await open(directory, "r");
  try {
    await folder.sync();
  } finally {
    await folder.close();
  }
}

async function assertFileStill(path, expected) {
  const current = await readPrivate(path, Math.max(expected.bytes.length, 1));
  if (
    current.sha256 !== expected.sha256 ||
    current.stat.dev !== expected.dev ||
    current.stat.ino !== expected.ino ||
    current.stat.mtimeMs !== expected.mtimeMs
  )
    blocked("MEMORY_RECONCILIATION_CHANGED");
}

async function restoreExact(path, bytes) {
  try {
    const current = await readPrivate(path, Math.max(bytes.length, 1));
    if (!current.bytes.equals(Buffer.from(bytes))) blocked("MEMORY_RECONCILIATION_RESTORE");
  } catch (error) {
    if (error?.code !== "MEMORY_RECONCILIATION_READ") throw error;
    await copyNew(path, bytes);
  }
}

async function ensureBlockingStop(path, expectedBytes) {
  const present = await lstat(path).catch((error) =>
    error.code === "ENOENT" ? null : Promise.reject(error),
  );
  if (!present) {
    try {
      await copyNew(path, expectedBytes);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
  }
  const current = await readPrivate(path, MAX_STOP);
  if (!current.bytes.equals(Buffer.from(expectedBytes))) blocked("MEMORY_RECONCILIATION_RESTORE");
}

/** Normal-run guard readers may clear only when both originals are absent and exact archived bytes exist. */
export async function verifyAcceptanceMemoryReconciliationReceipt({
  receiptPath,
  stopPath,
  guardPath,
  replacementStop,
  mediaRecoveryContext,
} = {}) {
  try {
    const receiptFile = await readPrivate(receiptPath, 64 * 1024);
    const receipt = parseJson(receiptFile.bytes);
    const receiptKeys = [
      "schemaVersion",
      "kind",
      "status",
      "cleanupOnly",
      "featurePass",
      "planSha256",
      "plan",
      "archivedAt",
      "archiveDirectory",
      "archivedGuardPath",
      "archivedStopPath",
      "archivedGuardSha256",
      "archivedStopSha256",
    ];
    const planKeys = [
      "schemaVersion",
      "kind",
      "cleanupOnly",
      "featurePass",
      "runtime",
      "manifestPath",
      "inventoryPath",
      "sourceAuditSnapshotPath",
      "originalReportPath",
      "journalPath",
      "journalSha256",
      "cleanupReportPath",
      "cleanupReportSha256",
      "cleanupPlanSha256",
      "origin",
      "manifestSha256",
      "inventorySha256",
      "sourceAuditSha256",
      "cleanupProofSha256",
      "stopPath",
      "stopSha256",
      "guardPath",
      "guardSha256",
      "cleanupRunId",
      "candidateIds",
      "rejectedCount",
    ];
    if (
      !exactKeys(receipt, receiptKeys) ||
      !exactKeys(receipt.plan, planKeys) ||
      receipt.schemaVersion !== 1 ||
      receipt.kind !== "acceptance-memory-guard-archive" ||
      receipt.status !== "ARCHIVE_VERIFIED" ||
      receipt.cleanupOnly !== true ||
      receipt.featurePass !== false ||
      !HASH.test(receipt.planSha256 ?? "") ||
      digest(canonical(receipt.plan)) !== receipt.planSha256 ||
      receipt.archiveDirectory !== dirname(receiptPath) ||
      receiptPath !== join(receipt.archiveDirectory, "receipt.json") ||
      !UUID.test(receipt.archiveDirectory.split("/").at(-1) ?? "") ||
      !Number.isFinite(Date.parse(receipt.archivedAt)) ||
      new Date(receipt.archivedAt).toISOString() !== receipt.archivedAt ||
      receipt.plan.schemaVersion !== 1 ||
      receipt.plan.kind !== "acceptance-memory-guard-archive" ||
      receipt.plan.cleanupOnly !== true ||
      receipt.plan.featurePass !== false ||
      receipt.plan.stopPath !== stopPath ||
      receipt.plan.guardPath !== guardPath ||
      receipt.archivedStopPath !== join(receipt.archiveDirectory, "STOP") ||
      receipt.archivedGuardPath !== join(receipt.archiveDirectory, "pending-memory-fixture.json") ||
      !HASH.test(receipt.plan.stopSha256 ?? "") ||
      !HASH.test(receipt.plan.guardSha256 ?? "") ||
      !HASH.test(receipt.plan.cleanupReportSha256 ?? "") ||
      !HASH.test(receipt.plan.journalSha256 ?? "") ||
      !HASH.test(receipt.plan.cleanupProofSha256 ?? "") ||
      !HASH.test(receipt.plan.cleanupPlanSha256 ?? "") ||
      !HASH.test(receipt.plan.manifestSha256 ?? "") ||
      !HASH.test(receipt.plan.inventorySha256 ?? "") ||
      !HASH.test(receipt.plan.sourceAuditSha256 ?? "") ||
      !ID.test(receipt.plan.cleanupRunId ?? "") ||
      !Array.isArray(receipt.plan.candidateIds) ||
      receipt.plan.candidateIds.length < 2 ||
      receipt.plan.candidateIds.length > 20 ||
      new Set(receipt.plan.candidateIds).size !== receipt.plan.candidateIds.length ||
      receipt.plan.candidateIds.some((id) => !/^candidate_[a-f0-9]{32}$/u.test(id)) ||
      receipt.plan.rejectedCount !== receipt.plan.candidateIds.length ||
      receipt.archivedStopSha256 !== receipt.plan.stopSha256 ||
      receipt.archivedGuardSha256 !== receipt.plan.guardSha256
    )
      return false;
    const currentStopStat = await lstat(stopPath).catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    await lstat(guardPath).then(
      () => {
        throw new Error("original guard remains");
      },
      (error) => {
        if (error.code !== "ENOENT") throw error;
      },
    );
    const [
      archivedStop,
      archivedGuard,
      manifestFile,
      inventoryFile,
      sourceAuditFile,
      originalReportFile,
      cleanupReportFile,
      journalFile,
    ] = await Promise.all([
      readPrivate(receipt.archivedStopPath, MAX_STOP),
      readPrivate(receipt.archivedGuardPath, 1024 * 1024),
      readPrivate(receipt.plan.manifestPath, 4096),
      readPrivate(receipt.plan.inventoryPath, 64 * 1024),
      readPrivate(receipt.plan.sourceAuditSnapshotPath, 16 * 1024 * 1024),
      readPrivate(receipt.plan.originalReportPath, MAX_REPORT),
      readPrivate(receipt.plan.cleanupReportPath, MAX_REPORT),
      readPrivate(receipt.plan.journalPath, MAX_JOURNAL),
    ]);
    const manifest = parseJson(manifestFile.bytes);
    const receiptVerified =
      exactKeys(manifest, [
        "schemaVersion",
        "inventoryPath",
        "sourceAuditSnapshotPath",
        "originalReportPath",
        "pendingGuardPath",
      ]) &&
      manifest.schemaVersion === 1 &&
      manifest.inventoryPath === receipt.plan.inventoryPath &&
      manifest.sourceAuditSnapshotPath === receipt.plan.sourceAuditSnapshotPath &&
      manifest.originalReportPath === receipt.plan.originalReportPath &&
      manifest.pendingGuardPath === receipt.plan.guardPath &&
      receipt.plan.journalPath ===
        join(dirname(receipt.plan.originalReportPath), "memory-fixture.jsonl") &&
      manifestFile.sha256 === receipt.plan.manifestSha256 &&
      inventoryFile.sha256 === receipt.plan.inventorySha256 &&
      sourceAuditFile.sha256 === receipt.plan.sourceAuditSha256 &&
      originalReportFile.sha256 === receipt.plan.origin.reportSha256 &&
      cleanupReportFile.sha256 === receipt.plan.cleanupReportSha256 &&
      journalFile.sha256 === receipt.plan.journalSha256 &&
      archivedStop.sha256 === receipt.archivedStopSha256 &&
      archivedStop.sha256 === receipt.plan.stopSha256 &&
      archivedGuard.sha256 === receipt.archivedGuardSha256 &&
      archivedGuard.sha256 === receipt.plan.guardSha256;
    if (!receiptVerified) return false;
    if (!currentStopStat) return true;
    return verifyReplacementStopEvidence(
      replacementStop,
      receipt,
      stopPath,
      archivedStop,
      currentStopStat,
      mediaRecoveryContext,
    );
  } catch {
    return false;
  }
}

/** Any interrupted archive intent blocks normal runs until the exact receipt is verified. */
export async function hasUnresolvedAcceptanceMemoryReconciliation(
  out,
  { stopPath = join(out, "STOP"), guardPath, replacementStop, mediaRecoveryContext } = {},
) {
  const root = join(out, "acceptance-memory-reconciliation");
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return false;
    return true;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || !UUID.test(entry.name)) return true;
    const directory = join(root, entry.name);
    const intentPath = join(directory, "intent.json");
    const hasIntent = await lstat(intentPath).then(
      (stat) => stat.isFile() && !stat.isSymbolicLink(),
      (error) => (error.code === "ENOENT" ? false : true),
    );
    if (!hasIntent) continue;
    const receiptPath = join(directory, "receipt.json");
    const receiptFile = await readPrivate(receiptPath, 64 * 1024).catch(() => null);
    if (!receiptFile) return true;
    const receipt = parseJson(receiptFile.bytes);
    const intentFile = await readPrivate(intentPath, 4096).catch(() => null);
    if (!intentFile) return true;
    const intent = parseJson(intentFile.bytes);
    const boundGuard = guardPath ?? receipt?.plan?.guardPath;
    if (
      !exactKeys(intent, [
        "schemaVersion",
        "kind",
        "status",
        "planSha256",
        "guardPath",
        "guardSha256",
        "stopPath",
        "stopSha256",
      ]) ||
      intent.schemaVersion !== 1 ||
      intent.kind !== "acceptance-memory-guard-archive-intent" ||
      intent.status !== "ARCHIVE_INTENT" ||
      intent.planSha256 !== receipt?.planSha256 ||
      intent.guardPath !== receipt?.plan?.guardPath ||
      intent.guardSha256 !== receipt?.plan?.guardSha256 ||
      intent.stopPath !== receipt?.plan?.stopPath ||
      intent.stopSha256 !== receipt?.plan?.stopSha256 ||
      receipt?.plan?.stopPath !== stopPath ||
      typeof boundGuard !== "string" ||
      receipt?.plan?.guardPath !== boundGuard ||
      !(await verifyAcceptanceMemoryReconciliationReceipt({
        receiptPath,
        stopPath,
        guardPath: boundGuard,
        replacementStop,
        mediaRecoveryContext,
      }))
    )
      return true;
  }
  return false;
}
