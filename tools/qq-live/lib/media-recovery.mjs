import { constants } from "node:fs";
import { open, lstat, readFile, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { digest, fail, toolManifestDigest } from "./core.mjs";
import { boundMediaMessage, compareSameMessage } from "./message-binding.mjs";
import {
  mediaFixtureStep,
  mediaFamilyPlan,
  mediaObservationFor,
  MEDIA_FAMILY_ID,
} from "./media-scenario.mjs";
import { verifyMediaCase, verifyMediaLeaseRequestWitness } from "./media-product-evidence.mjs";
import { openReadOnlyDatabase } from "./read-only-database.mjs";
import { verifyMemoryProcessStopped } from "./memory-process.mjs";

const HASH = /^[a-f0-9]{64}$/u;
const TOKEN = /^[a-f0-9]{32}$/u;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const RUN_ID = /^[A-Za-z0-9_-]{1,128}$/u;
const REPORT_RUN_ID = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z_[a-f0-9]{8}$/u;
const MESSAGE_ID = /^-?\d{1,20}$/u;
const STOP_CONTENT =
  "CLEANUP_UNCONFIRMED\n请先检查 Bot 的延迟任务、目标状态和本轮报告，再人工删除此文件。\n";
const RELEASE_INTENT_SUFFIX = ".media-release-intent.json";
const MAX_REPORT_BYTES = 512 * 1024;
const MAX_CHECKPOINT_BYTES = 64 * 1024;
const MAX_PENDING_BYTES = 16 * 1024;
const MAX_STOP_BYTES = 16 * 1024;
const IMAGE_ASSET_KEYS = [
  "assetId",
  "mimeType",
  "sizeBytes",
  "sha256",
  "width",
  "height",
  "fullDecodeVerified",
  "retained",
];

function reject(code = "MEDIA_RECOVERY_EVIDENCE") {
  fail(code, "媒体恢复计划无法独立核实，保留 pending guard 与 STOP。", "INCONCLUSIVE");
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, keys) {
  return isRecord(value) && Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
}

function same(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (isRecord(value))
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  const result = JSON.stringify(value);
  if (result === undefined || (typeof value === "number" && !Number.isFinite(value))) reject();
  return result;
}

function sha(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
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

function sameFingerprint(left, right) {
  return same(left, right);
}

async function readPrivate(path, limit) {
  if (typeof path !== "string" || !path.startsWith("/") || resolve(path) !== path) reject();
  let before;
  try {
    before = await lstat(path);
  } catch {
    reject("MEDIA_RECOVERY_FILE");
  }
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.nlink !== 1 ||
    before.size > limit ||
    (before.mode & 0o077) !== 0 ||
    (typeof process.getuid === "function" && before.uid !== process.getuid())
  )
    reject("MEDIA_RECOVERY_FILE");
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = await handle.stat();
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size)
      reject("MEDIA_RECOVERY_FILE_CHANGED");
    const bytes = await handle.readFile();
    const afterHandle = await handle.stat();
    const afterPath = await lstat(path);
    if (
      !sameFingerprint(fingerprint(before), fingerprint(afterHandle)) ||
      !sameFingerprint(fingerprint(before), fingerprint(afterPath))
    )
      reject("MEDIA_RECOVERY_FILE_CHANGED");
    return {
      path,
      bytes,
      sha256: sha(bytes),
      fingerprint: fingerprint(before),
    };
  } catch (error) {
    if (error?.code?.startsWith("MEDIA_RECOVERY")) throw error;
    reject("MEDIA_RECOVERY_FILE");
  } finally {
    await handle?.close().catch(() => {});
  }
}

function parseJson(file) {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(file.bytes));
  } catch {
    reject("MEDIA_RECOVERY_JSON");
  }
}

function latestProjection(report) {
  return {
    status: report.status,
    mode: report.mode,
    runId: report.runId,
    reportDirectory: report.reportDirectory,
    productAcceptance: report.productAcceptance,
    ...(report.mediaRecoveryFinalProof
      ? { mediaRecoveryFinalProof: report.mediaRecoveryFinalProof }
      : {}),
    ...(report.mediaFamilyAcceptance
      ? { mediaFamilyAcceptance: report.mediaFamilyAcceptance }
      : {}),
    ...(report.groupMembersPolicyAcceptance
      ? { groupMembersPolicyAcceptance: report.groupMembersPolicyAcceptance }
      : {}),
    ...(report.groupMembersPolicyFinalStateProof
      ? {
          groupMembersPolicyFinalStateProof: report.groupMembersPolicyFinalStateProof,
        }
      : {}),
    ...(report.transportOnly
      ? { transportOnly: true, transportStatus: report.transportStatus }
      : {}),
    cases: report.cases.map((c) => ({
      id: c.id,
      status: c.status,
      code: c.code,
      detail: c.detail,
    })),
    error: report.error,
  };
}

async function verifyNoSendResumeLatest(latest, latestFile, out, imageReport, suiteSha256) {
  const runId = latest?.runId;
  if (
    !REPORT_RUN_ID.test(runId ?? "") ||
    latest.mode !== "resume-media" ||
    latest.reportDirectory !== join(out, runId)
  )
    reject("MEDIA_RECOVERY_LATEST");
  const reportPath = join(latest.reportDirectory, "report.json");
  const attemptPath = join(latest.reportDirectory, "attempt.json");
  const [reportFile, attemptFile] = await Promise.all([
    readPrivate(reportPath, MAX_REPORT_BYTES),
    readPrivate(attemptPath, 4096),
  ]);
  const report = parseJson(reportFile);
  const attempt = parseJson(attemptFile);
  const now = Date.now() + 5000;
  const startedAt = Date.parse(report?.startedAt);
  const finishedAt = Date.parse(report?.finishedAt);
  const imageFinishedAt = Date.parse(imageReport?.finishedAt);
  const idTime = Date.parse(
    runId
      ?.slice(0, 24)
      .replace(/^(\d{4}-\d{2}-\d{2}T\d{2})-(\d{2})-(\d{2}\.\d{3}Z)$/u, "$1:$2:$3") ?? "",
  );
  if (
    !exactKeys(report, [
      "schemaVersion",
      "toolVersion",
      "runId",
      "mode",
      "startedAt",
      "productAcceptance",
      "status",
      "suiteSha256",
      "workspace",
      "cases",
      "limitations",
      "privacy",
      "finishedAt",
      "reportDirectory",
      "error",
    ]) ||
    report.schemaVersion !== 1 ||
    report.toolVersion !== "0.1.0" ||
    report.runId !== runId ||
    basename(reportPath) !== "report.json" ||
    report.reportDirectory !== latest.reportDirectory ||
    report.mode !== "resume-media" ||
    report.status !== "BLOCKED" ||
    report.suiteSha256 !== suiteSha256 ||
    !isRecord(report.workspace) ||
    !Array.isArray(report.limitations) ||
    typeof report.privacy !== "string" ||
    !Array.isArray(report.cases) ||
    report.cases.length !== 0 ||
    !exactKeys(report.productAcceptance, ["status", "code"]) ||
    report.productAcceptance.status !== "BLOCKED" ||
    report.productAcceptance.code !== "NOT_CHECKED" ||
    !exactKeys(report.error, ["code", "status", "message"]) ||
    report.error.code !== "MEMORY_RECONCILIATION_REQUIRED" ||
    report.error.status !== "BLOCKED" ||
    report.error.message !==
      "该发起账号有未核实的记忆清理归档。先核实原始报告和归档收据，禁止续发。" ||
    !exactKeys(attempt, ["runId", "mode", "startedAt", "status"]) ||
    attempt.runId !== runId ||
    attempt.mode !== "resume-media" ||
    attempt.startedAt !== report.startedAt ||
    attempt.status !== "STARTED" ||
    !Number.isFinite(startedAt) ||
    !Number.isFinite(finishedAt) ||
    !Number.isFinite(imageFinishedAt) ||
    !Number.isFinite(idTime) ||
    startedAt <= imageFinishedAt ||
    idTime < startedAt ||
    idTime > finishedAt + 1000 ||
    finishedAt < startedAt ||
    finishedAt > now ||
    report.runtime !== undefined ||
    !same(latest, latestProjection(report))
  )
    reject("MEDIA_RECOVERY_LATEST");
  return {
    resumeBlockReportPath: reportPath,
    resumeBlockReportSha256: reportFile.sha256,
    resumeBlockReportFingerprint: reportFile.fingerprint,
    resumeBlockAttemptSha256: attemptFile.sha256,
    resumeBlockAttemptFingerprint: attemptFile.fingerprint,
  };
}

function validRuntime(runtime) {
  if (!isRecord(runtime)) return false;
  const keys = Object.keys(runtime).sort();
  const base = ["checkout", "dataDirectory", "commit", "pid", "connectionId", "threadId"];
  const expected = [
    ...base,
    ...(runtime.development === true ? ["development", "sourceTreeSha256"] : []),
  ].sort();
  return (
    same(keys, expected) &&
    typeof runtime.checkout === "string" &&
    typeof runtime.dataDirectory === "string" &&
    /^[a-f0-9]{40}$/u.test(runtime.commit ?? "") &&
    Number.isSafeInteger(runtime.pid) &&
    typeof runtime.connectionId === "string" &&
    (runtime.threadId === null || typeof runtime.threadId === "string") &&
    (runtime.development === undefined ||
      (runtime.development === true && HASH.test(runtime.sourceTreeSha256 ?? "")))
  );
}

function scopeFor(config) {
  return JSON.stringify([
    config.runtime.connectionId,
    String(config.bot.qq),
    "private",
    String(config.driver.qq),
    String(config.driver.qq),
    config.runtime.threadId ?? null,
  ]);
}

function driverDigest(config) {
  if (typeof config?.driver?.qq !== "string" || !/^\d{1,20}$/u.test(config.driver.qq)) reject();
  return digest(config.driver.qq);
}

function pendingPathFor(config, locksDirectory) {
  const name = `${createHash("sha256").update(config.driver.qq).digest("hex").slice(0, 24)}.media-pending.json`;
  return join(locksDirectory, name);
}

function releaseIntentPathFor(config, locksDirectory) {
  if (
    typeof config?.driver?.qq !== "string" ||
    !/^\d{1,20}$/u.test(config.driver.qq) ||
    typeof locksDirectory !== "string" ||
    !locksDirectory.startsWith("/") ||
    resolve(locksDirectory) !== locksDirectory
  )
    reject("MEDIA_RECOVERY_RELEASE_INTENT");
  return `${pendingPathFor(config, locksDirectory).replace(/\.media-pending\.json$/u, "")}${RELEASE_INTENT_SUFFIX}`;
}

function releaseIntentPathForPending(pendingPath) {
  if (
    typeof pendingPath !== "string" ||
    !pendingPath.startsWith("/") ||
    resolve(pendingPath) !== pendingPath ||
    !pendingPath.endsWith(".media-pending.json")
  )
    reject("MEDIA_RECOVERY_RELEASE_INTENT");
  return `${pendingPath.replace(/\.media-pending\.json$/u, "")}${RELEASE_INTENT_SUFFIX}`;
}

function verifyTransportReport(report, suiteSha256, reportPath, expectedRuntime) {
  const spec = mediaFixtureStep("image-1k");
  const cases = report?.cases;
  const c = Array.isArray(cases) && cases.length === 1 ? cases[0] : null;
  const leaseTools = c?.token
    ? JSON.parse(JSON.stringify(spec.leaseTools).replaceAll("{{nonce}}", c.token))
    : [];
  const tokenPrompt = c?.token
    ? `GLASSBOX_ACCEPTANCE_V1 ${c.token}\n${spec.prompt.replaceAll("{{nonce}}", c.token).trim()}`
    : "";
  // Both shapes lost only the observer. Neither grants a retry: the subsequent proof must
  // establish the terminal original Run, exact asset, revoked lease and matching QQ histories.
  const legacyObserverFailure =
    report?.status === "BLOCKED" &&
    report.error?.code === "INTERNAL_ERROR" &&
    report.error?.diagnostic?.type === "TypeError";
  const interruptedObserver =
    report?.status === "INCONCLUSIVE" &&
    report.error?.code === "CANCELLED" &&
    report.error?.status === "INCONCLUSIVE" &&
    c?.mediaObservationExpectedType === "image" &&
    c.mediaObservationExpectedCaptionSha256 ===
      digest(mediaObservationFor("image-1k").expectedCaption) &&
    Array.isArray(c.mediaObservations) &&
    c.mediaObservations.length === 0 &&
    c.mediaObservationClosed === false &&
    c.mediaObservationOverflow === false;
  if (
    report?.mode !== "run" ||
    (!legacyObserverFailure && !interruptedObserver) ||
    !REPORT_RUN_ID.test(report.runId ?? "") ||
    report.reportDirectory !== dirname(reportPath) ||
    report.runId !== basename(dirname(reportPath)) ||
    report.suiteSha256 !== suiteSha256 ||
    !same(report.runtime, expectedRuntime) ||
    report.productAcceptance?.status !== "BLOCKED" ||
    report.productAcceptance?.code !== "NOT_CHECKED" ||
    report.safetyStopCreated !== true ||
    report.cleanupStopRequired !== true ||
    c?.id !== spec.id ||
    c.status !== "PASS" ||
    c.code !== "REAL_REPLY_RECEIVED" ||
    c.route !== "private" ||
    c.sendAttempted !== true ||
    c.inputObserved !== true ||
    c.leaseRegistrationAttempted !== true ||
    c.leaseRevoked !== true ||
    !TOKEN.test(c.token ?? "") ||
    c.prompt !== tokenPrompt ||
    !same(
      c.expected,
      spec.expectContains.map((value) => value.replaceAll("{{nonce}}", c.token)),
    ) ||
    !same(
      c.featureAssertions,
      JSON.parse(JSON.stringify(spec.featureAssertions).replaceAll("{{nonce}}", c.token)),
    ) ||
    !same(c.leasedToolNames, ["media_generate"]) ||
    !exactKeys(c.acceptanceLease, ["leaseId", "expiresAt", "toolsSha256"]) ||
    !UUID.test(c.acceptanceLease.leaseId ?? "") ||
    c.acceptanceLease.toolsSha256 !== toolManifestDigest(leaseTools) ||
    !Number.isSafeInteger(c.acceptanceLease.expiresAt) ||
    c.acceptanceLease.expiresAt <= Date.parse(c.startedAt) ||
    !Array.isArray(c.replies) ||
    c.replies.length !== 1 ||
    c.replies[0]?.route !== "private" ||
    c.replies[0]?.matches !== true ||
    !MESSAGE_ID.test(String(c.sentMessageId ?? "")) ||
    !Array.isArray(c.anomalies) ||
    c.anomalies.length !== 0 ||
    !isRecord(c.inputBinding) ||
    c.inputBinding.driverMessageId !== c.sentMessageId ||
    !MESSAGE_ID.test(String(c.inputBinding.driverMessageId ?? "")) ||
    !MESSAGE_ID.test(String(c.inputBinding.botMessageId ?? "")) ||
    !HASH.test(c.inputBinding.textSha256 ?? "") ||
    c.inputBinding.textSha256 !== digest(c.prompt) ||
    !Number.isSafeInteger(c.inputBinding.time) ||
    !Number.isSafeInteger(c.inputBinding.driverTime) ||
    typeof c.replies[0].messageId !== "string" ||
    !MESSAGE_ID.test(c.replies[0].messageId) ||
    (c.mediaObservationExpectedType !== undefined && c.mediaObservationExpectedType !== "image") ||
    (c.mediaObservationExpectedCaptionSha256 !== undefined &&
      c.mediaObservationExpectedCaptionSha256 !==
        digest(mediaObservationFor("image-1k").expectedCaption))
  )
    reject("MEDIA_RECOVERY_REPORT");
  return c;
}

function verifyCheckpoint(
  rows,
  pending,
  report,
  reportPath,
  runtime,
  processIdentity,
  suiteSha256,
  driverSha256,
) {
  const c = report.cases[0];
  if (!Array.isArray(rows) || rows.length !== 4) reject("MEDIA_RECOVERY_CHECKPOINT");
  const phases = ["intent", "lease_intent", "send_intent", "sent"];
  const common = (row, sequence) =>
    row?.schemaVersion === 1 &&
    row.familyId === MEDIA_FAMILY_ID &&
    row.sequence === sequence &&
    row.driverSha256 === driverSha256 &&
    row.suiteSha256 === suiteSha256 &&
    same(row.runtime, runtime) &&
    same(row.process, processIdentity) &&
    row.reportDirectory === dirname(reportPath) &&
    Number.isFinite(Date.parse(row.recordedAt)) &&
    row.stage === "image-1k" &&
    row.phase === phases[sequence - 1];
  if (!rows.every((row, index) => common(row, index + 1))) reject("MEDIA_RECOVERY_CHECKPOINT");
  const [intent, leaseIntent, sendIntent, sent] = rows;
  if (
    !exactKeys(intent, [
      "schemaVersion",
      "familyId",
      "sequence",
      "driverSha256",
      "suiteSha256",
      "runtime",
      "process",
      "reportDirectory",
      "recordedAt",
      "stage",
      "phase",
    ]) ||
    !exactKeys(leaseIntent, [
      "schemaVersion",
      "familyId",
      "sequence",
      "driverSha256",
      "suiteSha256",
      "runtime",
      "process",
      "reportDirectory",
      "recordedAt",
      "stage",
      "phase",
      "caseId",
      "marker",
      "textSha256",
    ]) ||
    !exactKeys(sendIntent, [
      "schemaVersion",
      "familyId",
      "sequence",
      "driverSha256",
      "suiteSha256",
      "runtime",
      "process",
      "reportDirectory",
      "recordedAt",
      "stage",
      "phase",
      "caseId",
      "marker",
      "leaseId",
      "toolsSha256",
      "textSha256",
    ]) ||
    !exactKeys(sent, [
      "schemaVersion",
      "familyId",
      "sequence",
      "driverSha256",
      "suiteSha256",
      "runtime",
      "process",
      "reportDirectory",
      "recordedAt",
      "stage",
      "phase",
      "caseId",
      "driverMessageId",
    ]) ||
    [leaseIntent, sendIntent].some((row) => row.caseId !== c.id || row.marker !== c.token) ||
    sent.caseId !== c.id ||
    leaseIntent.textSha256 !== c.inputBinding.textSha256 ||
    sendIntent.textSha256 !== c.inputBinding.textSha256 ||
    sendIntent.leaseId !== c.acceptanceLease.leaseId ||
    sendIntent.toolsSha256 !== c.acceptanceLease.toolsSha256 ||
    sent.driverMessageId !== c.sentMessageId ||
    !same(pending, sent)
  )
    reject("MEDIA_RECOVERY_CHECKPOINT");
}

function prefixSource(plan) {
  return {
    reportPath: plan.reportPath,
    reportSha256: plan.reportSha256,
    reportFingerprint: plan.reportFingerprint,
    latestPath: plan.latestPath,
    latestSha256: plan.latestSha256,
    latestFingerprint: plan.latestFingerprint,
    checkpointPath: plan.checkpointPath,
    checkpointSha256: plan.checkpointSha256,
    checkpointFingerprint: plan.checkpointFingerprint,
    pendingPath: plan.pendingPath,
    pendingSha256: plan.pendingSha256,
    pendingFingerprint: plan.pendingFingerprint,
    stopPath: plan.stopPath,
    stopSha256: plan.stopSha256,
    stopFingerprint: plan.stopFingerprint,
    driverSha256: plan.driverSha256,
    runtime: plan.runtime,
    process: plan.process,
    reportRunId: plan.reportRunId,
    caseId: plan.caseId,
    suiteSha256: plan.suiteSha256,
    stage: plan.stage,
    ...(plan.resumeBlockReportPath
      ? {
          resumeBlockReportPath: plan.resumeBlockReportPath,
          resumeBlockReportSha256: plan.resumeBlockReportSha256,
          resumeBlockReportFingerprint: plan.resumeBlockReportFingerprint,
          resumeBlockAttemptSha256: plan.resumeBlockAttemptSha256,
          resumeBlockAttemptFingerprint: plan.resumeBlockAttemptFingerprint,
        }
      : {}),
  };
}

async function loadPinnedSources(input, deps) {
  const reportPath = resolve(input.reportPath ?? "");
  const reportFile = await readPrivate(reportPath, MAX_REPORT_BYTES);
  const report = parseJson(reportFile);
  const out = dirname(dirname(reportPath));
  const reportDirectory = dirname(reportPath);
  if (
    reportPath !== join(reportDirectory, "report.json") ||
    report.reportDirectory !== reportDirectory
  )
    reject("MEDIA_RECOVERY_PATH");
  const stopPath = join(out, "STOP");
  const latestPath = join(out, "latest.json");
  const checkpointPath = join(reportDirectory, "media-fixture.jsonl");
  const locksDirectory = resolve(
    input.locksDirectory ?? join(homedir(), ".glassbox-qq-live-locks"),
  );
  const pendingPath = pendingPathFor(input.config, locksDirectory);
  const archivedGuards = input.archivedGuards;
  let readStopPath = stopPath;
  let readPendingPath = pendingPath;
  if (archivedGuards !== undefined) {
    const accountKey = createHash("sha256")
      .update(input.config.driver.qq)
      .digest("hex")
      .slice(0, 24);
    const expectedArchivedGuards = {
      stopPath: join(out, ".media-cleanup-archives", report.runId, "STOP"),
      pendingPath: join(
        locksDirectory,
        `${accountKey}.media-cleanup-archives`,
        report.runId,
        "pending.json",
      ),
    };
    if (!same(archivedGuards, expectedArchivedGuards)) reject("MEDIA_RECOVERY_ARCHIVED_GUARD");
    readStopPath = expectedArchivedGuards.stopPath;
    readPendingPath = expectedArchivedGuards.pendingPath;
  }
  const [latestFile, checkpointFile, pendingFile, stopFile, suiteBytes] = await Promise.all([
    readPrivate(latestPath, MAX_REPORT_BYTES),
    readPrivate(checkpointPath, MAX_CHECKPOINT_BYTES),
    readPrivate(readPendingPath, MAX_PENDING_BYTES),
    readPrivate(readStopPath, MAX_STOP_BYTES),
    readFile(new URL("../examples/media-private.example.json", import.meta.url)),
  ]);
  const latest = parseJson(latestFile);
  const pending = parseJson(pendingFile);
  const runtime = input.expectedRuntime;
  const processIdentity = pending?.process;
  const suiteSha256 = sha(suiteBytes);
  const driverSha256 = driverDigest(input.config);
  let resumeBlock = null;
  const originalLatestMatches =
    latest.runId === report.runId &&
    latest.reportDirectory === reportDirectory &&
    latest.mode === report.mode &&
    latest.status === report.status &&
    latest.productAcceptance?.status === report.productAcceptance?.status &&
    latest.productAcceptance?.code === report.productAcceptance?.code;
  if (!originalLatestMatches)
    resumeBlock = await verifyNoSendResumeLatest(latest, latestFile, out, report, suiteSha256);
  const runtimeIdentityValid =
    validRuntime(runtime) && same(runtime, report.runtime) && same(runtime, pending.runtime);
  if (
    !runtimeIdentityValid ||
    report.suiteSha256 !== suiteSha256 ||
    report.runId !== basename(reportDirectory) ||
    (!originalLatestMatches && !resumeBlock) ||
    pending.schemaVersion !== 1 ||
    pending.familyId !== MEDIA_FAMILY_ID ||
    pending.driverSha256 !== driverSha256 ||
    pending.suiteSha256 !== suiteSha256 ||
    pending.reportDirectory !== reportDirectory ||
    pending.stage !== "image-1k" ||
    pending.phase !== "sent" ||
    pending.sequence !== 4 ||
    !exactKeys(processIdentity, ["pid", "bootId", "startTicks"]) ||
    !Number.isSafeInteger(processIdentity.pid) ||
    !UUID.test(processIdentity.bootId ?? "") ||
    !/^[1-9]\d{0,31}$/u.test(processIdentity.startTicks ?? "") ||
    stopFile.bytes.toString("utf8") !== STOP_CONTENT
  )
    reject("MEDIA_RECOVERY_BINDING");
  let rows;
  try {
    rows = checkpointFile.bytes
      .toString("utf8")
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line));
  } catch {
    reject("MEDIA_RECOVERY_CHECKPOINT");
  }
  const caseRecord = verifyTransportReport(report, suiteSha256, reportPath, runtime);
  verifyCheckpoint(
    rows,
    pending,
    report,
    reportPath,
    runtime,
    processIdentity,
    suiteSha256,
    driverSha256,
  );
  await deps.verifyProcessStopped(processIdentity);
  const snapshot = {
    schemaVersion: 1,
    kind: "qq-live-media-image-prefix-recovery",
    out,
    locksDirectory,
    reportPath,
    reportSha256: reportFile.sha256,
    reportFingerprint: reportFile.fingerprint,
    latestPath,
    latestSha256: latestFile.sha256,
    latestFingerprint: latestFile.fingerprint,
    checkpointPath,
    checkpointSha256: checkpointFile.sha256,
    checkpointFingerprint: checkpointFile.fingerprint,
    pendingPath,
    pendingSha256: pendingFile.sha256,
    pendingFingerprint: pendingFile.fingerprint,
    stopPath,
    stopSha256: stopFile.sha256,
    stopFingerprint: stopFile.fingerprint,
    driverSha256,
    runtime,
    process: processIdentity,
    reportRunId: report.runId,
    caseId: caseRecord.id,
    suiteSha256,
    stage: "image-1k",
    ...(resumeBlock ?? {}),
  };
  return { snapshot, report, caseRecord };
}

async function verifyUniqueMarkerRun(input, caseRecord, deps) {
  const db = deps.openReadOnlyDatabase(join(input.expectedRuntime.dataDirectory, "glassbox.db"));
  try {
    const rows = db
      .prepare(
        "SELECT m.external_id AS externalId, r.id AS runId, r.status AS status, d.external_id AS mediaExternalId FROM messages m JOIN runs r ON r.message_id=m.id JOIN deliveries d ON d.run_id=r.id AND d.payload_kind='media_artifact' AND d.status='sent' WHERE m.scope_key=? AND instr(m.text,?)>0",
      )
      .all(scopeFor(input.config), caseRecord.token);
    if (
      rows.length !== 1 ||
      rows[0].externalId !== caseRecord.inputBinding.botMessageId ||
      typeof rows[0].runId !== "string" ||
      rows[0].status !== "succeeded" ||
      !MESSAGE_ID.test(String(rows[0].mediaExternalId ?? ""))
    )
      reject("MEDIA_RECOVERY_RUN_SET");
    return {
      runId: rows[0].runId,
      mediaMessageId: String(rows[0].mediaExternalId),
    };
  } finally {
    db.close();
  }
}

function historyCandidate(receipt, accountIdentity, peerId, expected) {
  if (
    !exactKeys(receipt, ["accountIdentity", "peerId", "messages"]) ||
    receipt.accountIdentity !== accountIdentity ||
    receipt.peerId !== peerId ||
    !Array.isArray(receipt.messages) ||
    receipt.messages.length !== 1
  )
    reject("MEDIA_RECOVERY_HISTORY");
  const [candidate] = receipt.messages;
  if (
    !exactKeys(candidate, [
      "messageId",
      "selfId",
      "senderId",
      "userId",
      "messageType",
      "time",
      "realSequence",
      "textBytes",
      "textSha256",
      "mediaType",
      "mediaLocatorPresent",
      "segmentCount",
      "segmentTypes",
    ]) ||
    !MESSAGE_ID.test(String(candidate.messageId ?? "")) ||
    candidate.selfId !== accountIdentity ||
    candidate.senderId !== expected.botId ||
    ![expected.driverId, expected.botId].includes(candidate.userId) ||
    candidate.messageType !== "private" ||
    !Number.isSafeInteger(candidate.time) ||
    candidate.time < expected.afterTime - 1 ||
    candidate.time > Math.floor(Date.now() / 1000) + 5 ||
    !/^\d{1,20}$/u.test(candidate.realSequence ?? "") ||
    candidate.textBytes !== expected.textBytes ||
    candidate.textSha256 !== expected.captionSha256 ||
    candidate.mediaType !== expected.mediaType ||
    candidate.mediaLocatorPresent !== true ||
    candidate.segmentCount !== 2 ||
    !Array.isArray(candidate.segmentTypes) ||
    !same([...candidate.segmentTypes].sort(), ["image", "text"])
  )
    reject("MEDIA_RECOVERY_HISTORY");
  return candidate;
}

async function verifyMediaHistoryPair(input, caseRecord, deps, mediaMessageId) {
  const observation = mediaObservationFor("image-1k");
  const expected = {
    mediaType: observation.expectedType,
    caption: observation.expectedCaption,
    captionSha256: digest(observation.expectedCaption),
    textBytes: Buffer.byteLength(observation.expectedCaption),
    afterTime: Math.floor(Date.parse(caseRecord.startedAt) / 1000),
    driverId: String(input.config.driver.qq),
    botId: String(input.config.bot.qq),
  };
  const filter = {
    mediaType: expected.mediaType,
    captionSha256: expected.captionSha256,
    afterTime: caseRecord.startedAt,
  };
  if (
    typeof input.clients.driver.readOwnerBotPrivateMediaHistory !== "function" ||
    typeof input.clients.bot.readBotOwnerPrivateMediaHistory !== "function"
  )
    reject("MEDIA_RECOVERY_HISTORY");
  const [driverPage, botPage] = await Promise.all([
    input.clients.driver.readOwnerBotPrivateMediaHistory(filter),
    input.clients.bot.readBotOwnerPrivateMediaHistory(filter),
  ]);
  const driverCandidate = historyCandidate(driverPage, expected.driverId, expected.botId, expected);
  const botCandidate = historyCandidate(botPage, expected.botId, expected.driverId, expected);
  if (
    botCandidate.messageId !== mediaMessageId ||
    driverCandidate.messageId === botCandidate.messageId ||
    driverCandidate.realSequence !== botCandidate.realSequence ||
    driverCandidate.time !== botCandidate.time ||
    driverCandidate.textSha256 !== botCandidate.textSha256 ||
    driverCandidate.textBytes !== botCandidate.textBytes ||
    driverCandidate.mediaType !== botCandidate.mediaType ||
    !same([...driverCandidate.segmentTypes].sort(), [...botCandidate.segmentTypes].sort())
  )
    reject("MEDIA_RECOVERY_HISTORY_PAIR");

  input.clients.driver.allowMessageRead(driverCandidate.messageId);
  input.clients.bot.allowMessageRead(botCandidate.messageId);
  const [driver, bot] = await Promise.all([
    deps.boundMediaMessage(input.clients.driver, driverCandidate.messageId, {
      selfId: expected.driverId,
      senderId: expected.botId,
      messageType: "private",
      mediaType: expected.mediaType,
      caption: expected.caption,
      afterTime: caseRecord.startedAt,
    }),
    deps.boundMediaMessage(input.clients.bot, botCandidate.messageId, {
      selfId: expected.botId,
      senderId: expected.botId,
      messageType: "private",
      mediaType: expected.mediaType,
      caption: expected.caption,
      afterTime: caseRecord.startedAt,
    }),
  ]);
  const paired = compareSameMessage(bot, driver);
  if (
    driver.messageId !== driverCandidate.messageId ||
    bot.messageId !== botCandidate.messageId ||
    bot.messageId === driver.messageId ||
    bot.realSequence !== botCandidate.realSequence ||
    driver.realSequence !== driverCandidate.realSequence ||
    bot.time !== botCandidate.time ||
    driver.time !== driverCandidate.time ||
    bot.textSha256 !== botCandidate.textSha256 ||
    driver.textSha256 !== driverCandidate.textSha256 ||
    bot.mediaType !== expected.mediaType ||
    driver.mediaType !== expected.mediaType ||
    bot.segmentCount !== 2 ||
    driver.segmentCount !== 2 ||
    paired.realSequence !== botCandidate.realSequence ||
    paired.time !== botCandidate.time ||
    paired.driverTime !== driverCandidate.time ||
    paired.textSha256 !== expected.captionSha256
  )
    reject("MEDIA_RECOVERY_HISTORY_PAIR");
  return {
    driverMessageId: driverCandidate.messageId,
    botMessageId: botCandidate.messageId,
    driver,
  };
}

function verifyNoTaskWorkerScheduleResidue(db, runId) {
  const row = db
    .prepare(
      `SELECT
        (SELECT COUNT(*) FROM tasks WHERE run_id=?) AS tasks,
        (SELECT COUNT(*) FROM task_attempt_runs WHERE run_id=?) AS taskAttemptRuns,
        (SELECT COUNT(*) FROM worker_bindings wb JOIN task_attempt_runs tar ON tar.attempt_id=wb.task_attempt_id WHERE tar.run_id=?) AS workerBindings,
        (SELECT COUNT(*) FROM worker_launch_intents wli WHERE wli.task_id IN (SELECT id FROM tasks WHERE run_id=?)) AS workerLaunchIntents,
        (SELECT COUNT(*) FROM durable_continuation_schedules s WHERE s.target_id=? OR (s.target_kind='task' AND s.target_id IN (SELECT id FROM tasks WHERE run_id=?))) AS schedules`,
    )
    .get(runId, runId, runId, runId, runId, runId);
  if (
    !isRecord(row) ||
    !["tasks", "taskAttemptRuns", "workerBindings", "workerLaunchIntents", "schedules"].every(
      (key) => row[key] === 0,
    )
  )
    reject("MEDIA_CLEANUP_TASK_RESIDUE");
  return row;
}

/** Verify cleanup evidence for the fixed image run whose sole gap is a missing delivery Trace event. */
export async function verifyMediaImageDeliveryGapEvidence(input, overrides = {}) {
  const deps = { ...defaultDeps, ...overrides };
  if (!isRecord(input) || !input.config || !isRecord(input.clients)) reject("MEDIA_CLEANUP_INPUT");
  const { snapshot, caseRecord } = await loadPinnedSources(input, deps);
  const run = await verifyUniqueMarkerRun(input, caseRecord, deps);
  const observed = await verifyMediaHistoryPair(input, caseRecord, deps, run.mediaMessageId);
  const expected = mediaObservationFor("image-1k");
  const mediaObservations = {
    overflow: false,
    candidates: [
      {
        messageId: observed.driverMessageId,
        mediaType: observed.driver.mediaType,
        captionSha256: observed.driver.captionSha256,
        segmentCount: observed.driver.segmentCount,
        receivedAt: new Date(observed.driver.time * 1000).toISOString(),
      },
    ],
  };
  let missingDeliveryWitness = false;
  try {
    await deps.verifyMediaCase({
      stage: "image-1k",
      caseRecord: {
        ...caseRecord,
        mediaObservationExpectedType: expected.expectedType,
        mediaObservationExpectedCaptionSha256: digest(expected.expectedCaption),
      },
      config: input.config,
      clients: input.clients,
      expectedRuntime: input.expectedRuntime,
      mediaObservations,
    });
  } catch (error) {
    if (error?.code !== "MEDIA_TRACE_DELIVERY_WITNESS_MISSING") throw error;
    missingDeliveryWitness = true;
  }
  if (!missingDeliveryWitness) reject("MEDIA_CLEANUP_NOT_APPLICABLE");

  const db = deps.openReadOnlyDatabase(join(input.expectedRuntime.dataDirectory, "glassbox.db"));
  let residue;
  try {
    residue = verifyNoTaskWorkerScheduleResidue(db, run.runId);
  } finally {
    db.close();
  }
  return {
    status: "MEDIA_DELIVERY_GAP_CLEANUP_VERIFIED",
    cleanupOnly: true,
    featureStatus: "INCONCLUSIVE",
    productRunId: run.runId,
    productRunStatus: "succeeded",
    caseId: caseRecord.id,
    stage: "image-1k",
    leaseId: caseRecord.acceptanceLease.leaseId,
    toolsSha256: caseRecord.acceptanceLease.toolsSha256,
    inputBinding: {
      driverMessageId: caseRecord.inputBinding.driverMessageId,
      botMessageId: caseRecord.inputBinding.botMessageId,
      textSha256: caseRecord.inputBinding.textSha256,
      time: caseRecord.inputBinding.time,
      driverTime: caseRecord.inputBinding.driverTime,
    },
    mediaMessageBinding: {
      driverMessageId: observed.driverMessageId,
      botMessageId: observed.botMessageId,
      realSequence: observed.driver.realSequence,
      time: observed.driver.time,
      textSha256: observed.driver.textSha256,
      mediaType: observed.driver.mediaType,
      segmentCount: observed.driver.segmentCount,
    },
    cleanup: {
      leaseRevoked: true,
      dualAccountTextAndMediaReadsVerified: true,
      missingMediaDeliveryTraceWitness: true,
      taskWorkerScheduleResidue: residue,
    },
    sourcePins: {
      reportSha256: snapshot.reportSha256,
      latestSha256: snapshot.latestSha256,
      checkpointSha256: snapshot.checkpointSha256,
      pendingSha256: snapshot.pendingSha256,
      stopSha256: snapshot.stopSha256,
      runtime: snapshot.runtime,
    },
  };
}

function validatePlan(plan) {
  const keys = [
    "schemaVersion",
    "kind",
    "out",
    "locksDirectory",
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
    "reportRunId",
    "caseId",
    "suiteSha256",
    "stage",
    "planSha256",
  ];
  const hasResumeBlock = plan?.resumeBlockReportPath !== undefined;
  if (hasResumeBlock)
    keys.push(
      "resumeBlockReportPath",
      "resumeBlockReportSha256",
      "resumeBlockReportFingerprint",
      "resumeBlockAttemptSha256",
      "resumeBlockAttemptFingerprint",
    );
  if (
    !exactKeys(plan, keys) ||
    plan.schemaVersion !== 1 ||
    plan.kind !== "qq-live-media-image-prefix-recovery" ||
    plan.stage !== "image-1k" ||
    plan.caseId !== "media-image-1k" ||
    !REPORT_RUN_ID.test(plan.reportRunId ?? "") ||
    !validRuntime(plan.runtime) ||
    !HASH.test(plan.driverSha256 ?? "") ||
    !HASH.test(plan.planSha256 ?? "") ||
    (hasResumeBlock &&
      (!isRecord(plan.resumeBlockReportFingerprint) ||
        !isRecord(plan.resumeBlockAttemptFingerprint) ||
        !HASH.test(plan.resumeBlockReportSha256 ?? "") ||
        !HASH.test(plan.resumeBlockAttemptSha256 ?? "")))
  )
    reject("MEDIA_RECOVERY_PLAN");
  if (digest(canonical(prefixSource(plan))) !== plan.planSha256) reject("MEDIA_RECOVERY_PLAN");
}

export function mediaRecoveryPlanBinding(plan) {
  validatePlan(plan);
  return {
    proofKind: "active-media-recovery",
    planSha256: plan.planSha256,
    driverSha256: driverDigestFromPlan(plan),
    reportPath: plan.reportPath,
    reportSha256: plan.reportSha256,
    latestPath: plan.latestPath,
    latestSha256: plan.latestSha256,
    checkpointPath: plan.checkpointPath,
    checkpointSha256: plan.checkpointSha256,
    pendingPath: plan.pendingPath,
    pendingSha256: plan.pendingSha256,
    stopPath: plan.stopPath,
    stopSha256: plan.stopSha256,
    ...(plan.resumeBlockReportPath
      ? {
          resumeBlockReportPath: plan.resumeBlockReportPath,
          resumeBlockReportSha256: plan.resumeBlockReportSha256,
          resumeBlockReportFingerprint: plan.resumeBlockReportFingerprint,
        }
      : {}),
  };
}

function driverDigestFromPlan(plan) {
  if (!HASH.test(plan.driverSha256 ?? "")) reject("MEDIA_RECOVERY_PLAN");
  return plan.driverSha256;
}

export async function verifyActiveMediaRecoveryPlanBinding(evidence, context = {}) {
  try {
    const { config, expectedRuntime, locksDirectory } = context;
    const baseKeys = [
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
    const blockKeys = [
      "resumeBlockReportPath",
      "resumeBlockReportSha256",
      "resumeBlockReportFingerprint",
    ];
    const keys =
      isRecord(evidence) && Object.hasOwn(evidence, "resumeBlockReportPath")
        ? [...baseKeys, ...blockKeys]
        : baseKeys;
    if (
      !exactKeys(evidence, keys) ||
      evidence.proofKind !== "active-media-recovery" ||
      !isRecord(config) ||
      !validRuntime(expectedRuntime) ||
      typeof locksDirectory !== "string"
    )
      return false;
    const planned = await planMediaImageRecovery({
      reportPath: evidence.reportPath,
      config,
      expectedRuntime,
      locksDirectory,
    });
    return same(evidence, mediaRecoveryPlanBinding(planned.plan));
  } catch {
    return false;
  }
}

const defaultDeps = {
  verifyProcessStopped: verifyMemoryProcessStopped,
  boundMediaMessage,
  verifyMediaCase,
  openReadOnlyDatabase,
};

/** Read-only static plan. It preserves the partial family guard and never sends or clears it. */
export async function planMediaImageRecovery(input, overrides = {}) {
  const deps = { ...defaultDeps, ...overrides };
  if (!isRecord(input) || !input.config || !validRuntime(input.expectedRuntime)) reject();
  const { snapshot } = await loadPinnedSources(input, deps);
  const base = prefixSource(snapshot);
  const plan = { ...snapshot, planSha256: digest(canonical(base)) };
  return {
    status: "MEDIA_RECOVERY_PLANNED",
    plan,
    planSha256: plan.planSha256,
  };
}

/** Re-read every pinned local file and independently verify the existing image stage. */
export async function verifyMediaImageRecoveryPlan(plan, input, overrides = {}) {
  const deps = { ...defaultDeps, ...overrides };
  validatePlan(plan);
  if (
    !isRecord(input) ||
    !input.config ||
    !isRecord(input.clients) ||
    !validRuntime(input.expectedRuntime)
  )
    reject();
  const { snapshot, report, caseRecord } = await loadPinnedSources(input, deps);
  const currentPlan = { ...snapshot, planSha256: plan.planSha256 };
  const currentBase = prefixSource(snapshot);
  if (
    digest(canonical(currentBase)) !== plan.planSha256 ||
    !same({ ...plan, planSha256: undefined }, { ...currentPlan, planSha256: undefined })
  )
    reject("MEDIA_RECOVERY_SOURCE_CHANGED");
  const run = await verifyUniqueMarkerRun(input, caseRecord, deps);
  const observed = await verifyMediaHistoryPair(input, caseRecord, deps, run.mediaMessageId);
  const expected = mediaObservationFor("image-1k");
  const mediaObservations = {
    overflow: false,
    candidates: [
      {
        messageId: observed.driverMessageId,
        mediaType: observed.driver.mediaType,
        captionSha256: observed.driver.captionSha256,
        segmentCount: observed.driver.segmentCount,
        receivedAt: new Date(observed.driver.time * 1000).toISOString(),
      },
    ],
  };
  const caseForVerification = {
    ...caseRecord,
    mediaObservationExpectedType: expected.expectedType,
    mediaObservationExpectedCaptionSha256: digest(expected.expectedCaption),
  };
  const stageReceipt = await deps.verifyMediaCase({
    stage: "image-1k",
    caseRecord: caseForVerification,
    config: input.config,
    clients: input.clients,
    expectedRuntime: plan.runtime,
    mediaObservations,
  });
  if (
    stageReceipt?.status !== "PASS" ||
    stageReceipt.stage !== "image-1k" ||
    stageReceipt.runId !== run.runId ||
    stageReceipt.cleanupVerified !== true ||
    stageReceipt.actualQqDeliveryVerified !== true
  )
    reject("MEDIA_RECOVERY_STAGE");
  const leaseRequestWitnessSha256 = verifyMediaLeaseRequestWitness(
    stageReceipt.leaseRequestWitness,
    {
      stage: "image-1k",
      runId: run.runId,
      caseRecord: caseRecord,
      runtime: plan.runtime,
      assetId: stageReceipt.asset.assetId,
    },
  );
  const { snapshot: after } = await loadPinnedSources(input, deps);
  const afterBase = prefixSource(after);
  if (digest(canonical(afterBase)) !== plan.planSha256) reject("MEDIA_RECOVERY_SOURCE_CHANGED");
  const prefixBase = {
    schemaVersion: 1,
    familyId: MEDIA_FAMILY_ID,
    stage: "image-1k",
    token: caseRecord.token,
    runId: run.runId,
    leaseId: caseRecord.acceptanceLease.leaseId,
    asset: stageReceipt.asset,
    planSha256: plan.planSha256,
  };
  if (!exactKeys(stageReceipt.asset, IMAGE_ASSET_KEYS)) reject("MEDIA_RECOVERY_ASSET");
  const proofSha256 = digest(
    canonical({
      planSha256: plan.planSha256,
      reportRunId: plan.reportRunId,
      inputMessageId: caseRecord.inputBinding.botMessageId,
      receivedDriverMediaMessageId: observed.driverMessageId,
      receivedBotMediaMessageId: observed.botMessageId,
      productRunId: run.runId,
      leaseId: caseRecord.acceptanceLease.leaseId,
      assetId: stageReceipt.asset.assetId,
      assetSha256: stageReceipt.asset.sha256,
      mediaDeliveryVerified: stageReceipt.actualQqDeliveryVerified,
      cleanupVerified: stageReceipt.cleanupVerified,
      leaseRequestWitnessSha256,
    }),
  );
  const prefix = { ...prefixBase, proofSha256 };
  return {
    status: "MEDIA_IMAGE_PREFIX_VERIFIED",
    familyId: MEDIA_FAMILY_ID,
    planSha256: plan.planSha256,
    proofSha256,
    productRunId: run.runId,
    productRunStatus: "succeeded",
    cleanupVerified: true,
    actualQqDeliveryVerified: true,
    prefix,
    transportCase: caseRecord,
    mediaAcceptance: stageReceipt,
    mediaObservations,
    mediaMessageBinding: {
      driverMessageId: observed.driverMessageId,
      botMessageId: observed.botMessageId,
      realSequence: observed.driver.realSequence,
      time: observed.driver.time,
      textSha256: observed.driver.textSha256,
    },
  };
}

/** Revalidate the original image prefix immediately before a resumed video send. */
export async function revalidateMediaImagePrefix(plan, receipt, input, overrides = {}) {
  if (
    !exactKeys(receipt, [
      "status",
      "familyId",
      "planSha256",
      "proofSha256",
      "productRunId",
      "productRunStatus",
      "cleanupVerified",
      "actualQqDeliveryVerified",
      "prefix",
      "transportCase",
      "mediaAcceptance",
      "mediaObservations",
      "mediaMessageBinding",
    ]) ||
    receipt.status !== "MEDIA_IMAGE_PREFIX_VERIFIED" ||
    receipt.familyId !== MEDIA_FAMILY_ID ||
    receipt.planSha256 !== plan?.planSha256 ||
    receipt.productRunStatus !== "succeeded" ||
    receipt.cleanupVerified !== true ||
    receipt.actualQqDeliveryVerified !== true ||
    receipt.prefix?.proofSha256 !== receipt.proofSha256 ||
    receipt.prefix?.planSha256 !== receipt.planSha256
  )
    reject("MEDIA_RECOVERY_RECEIPT");
  const fresh = await verifyMediaImageRecoveryPlan(plan, input, overrides);
  if (
    fresh.proofSha256 !== receipt.proofSha256 ||
    fresh.productRunId !== receipt.productRunId ||
    !same(fresh.mediaMessageBinding, receipt.mediaMessageBinding) ||
    !same(fresh.mediaAcceptance, receipt.mediaAcceptance)
  )
    reject("MEDIA_RECOVERY_RECEIPT_CHANGED");
  return fresh.proofSha256;
}

/** Verify that recovery appended one complete video stage without changing the image prefix. */
export async function verifyMediaRecoveryAppendOnly(
  plan,
  {
    config,
    expectedRuntime,
    reportDirectory,
    processIdentity,
    imagePrefixProofSha256,
    imagePrefixProductRunId,
    imagePrefixAssetId,
    videoCase,
    videoAcceptance,
  },
) {
  validatePlan(plan);
  if (
    !same(expectedRuntime, plan.runtime) ||
    !HASH.test(imagePrefixProofSha256 ?? "") ||
    !RUN_ID.test(imagePrefixProductRunId ?? "") ||
    !UUID.test(imagePrefixAssetId ?? "") ||
    !isRecord(processIdentity) ||
    !REPORT_RUN_ID.test(basename(reportDirectory ?? "")) ||
    !same(resolve(reportDirectory), join(plan.out, basename(reportDirectory))) ||
    videoCase?.id !== "media-video-4s" ||
    videoCase.status !== "PASS" ||
    videoCase.leaseRevoked !== true ||
    videoCase.sendAttempted !== true ||
    videoAcceptance?.status !== "PASS" ||
    videoAcceptance.stage !== "video-4s" ||
    videoAcceptance.runId === plan.reportRunId ||
    videoAcceptance.cleanupVerified !== true ||
    videoAcceptance.actualQqDeliveryVerified !== true
  )
    reject("MEDIA_RECOVERY_COMPLETION");

  const [oldReport, oldLatest, oldStop, checkpoint, pending] = await Promise.all([
    readPrivate(plan.reportPath, MAX_REPORT_BYTES),
    readPrivate(plan.latestPath, MAX_REPORT_BYTES),
    readPrivate(plan.stopPath, MAX_STOP_BYTES),
    readPrivate(plan.checkpointPath, MAX_CHECKPOINT_BYTES),
    readPrivate(plan.pendingPath, MAX_PENDING_BYTES),
  ]);
  if (
    oldReport.sha256 !== plan.reportSha256 ||
    !sameFingerprint(oldReport.fingerprint, plan.reportFingerprint) ||
    oldLatest.sha256 !== plan.latestSha256 ||
    !sameFingerprint(oldLatest.fingerprint, plan.latestFingerprint) ||
    oldStop.sha256 !== plan.stopSha256 ||
    !sameFingerprint(oldStop.fingerprint, plan.stopFingerprint) ||
    oldStop.bytes.toString("utf8") !== STOP_CONTENT
  )
    reject("MEDIA_RECOVERY_SOURCE_CHANGED");

  let rows;
  try {
    rows = checkpoint.bytes
      .toString("utf8")
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line));
  } catch {
    reject("MEDIA_RECOVERY_CHECKPOINT");
  }
  if (rows.length !== 9) reject("MEDIA_RECOVERY_CHECKPOINT");
  const prefixBytes = Buffer.from(
    rows
      .slice(0, 4)
      .map((row) => JSON.stringify(row))
      .join("\n") + "\n",
  );
  if (sha(prefixBytes) !== plan.checkpointSha256) reject("MEDIA_RECOVERY_CHECKPOINT");

  const stages = rows.slice(4);
  const phases = ["intent", "lease_intent", "send_intent", "sent", "verified"];
  const base = {
    schemaVersion: 1,
    familyId: MEDIA_FAMILY_ID,
    driverSha256: driverDigest(config),
    suiteSha256: plan.suiteSha256,
    runtime: plan.runtime,
    process: processIdentity,
    reportDirectory,
    stage: "video-4s",
  };
  for (const [index, row] of stages.entries()) {
    if (
      !isRecord(row) ||
      row.schemaVersion !== 1 ||
      row.familyId !== MEDIA_FAMILY_ID ||
      row.sequence !== index + 5 ||
      row.driverSha256 !== base.driverSha256 ||
      row.suiteSha256 !== base.suiteSha256 ||
      !same(row.runtime, base.runtime) ||
      !same(row.process, base.process) ||
      row.reportDirectory !== reportDirectory ||
      row.stage !== "video-4s" ||
      row.phase !== phases[index] ||
      !Number.isFinite(Date.parse(row.recordedAt))
    )
      reject("MEDIA_RECOVERY_CHECKPOINT");
  }
  const videoSpec = mediaFixtureStep("video-4s");
  const leaseTools = JSON.parse(
    JSON.stringify(videoSpec.leaseTools).replaceAll("{{nonce}}", videoCase.token),
  );
  const [intent, leaseIntent, sendIntent, sent, verified] = stages;
  if (
    !exactKeys(intent, [
      "schemaVersion",
      "familyId",
      "sequence",
      "driverSha256",
      "suiteSha256",
      "runtime",
      "process",
      "reportDirectory",
      "recordedAt",
      "stage",
      "phase",
    ]) ||
    !exactKeys(leaseIntent, [
      "schemaVersion",
      "familyId",
      "sequence",
      "driverSha256",
      "suiteSha256",
      "runtime",
      "process",
      "reportDirectory",
      "recordedAt",
      "stage",
      "phase",
      "caseId",
      "marker",
      "textSha256",
    ]) ||
    !exactKeys(sendIntent, [
      "schemaVersion",
      "familyId",
      "sequence",
      "driverSha256",
      "suiteSha256",
      "runtime",
      "process",
      "reportDirectory",
      "recordedAt",
      "stage",
      "phase",
      "caseId",
      "marker",
      "leaseId",
      "toolsSha256",
      "textSha256",
    ]) ||
    !exactKeys(sent, [
      "schemaVersion",
      "familyId",
      "sequence",
      "driverSha256",
      "suiteSha256",
      "runtime",
      "process",
      "reportDirectory",
      "recordedAt",
      "stage",
      "phase",
      "caseId",
      "driverMessageId",
    ]) ||
    !exactKeys(verified, [
      "schemaVersion",
      "familyId",
      "sequence",
      "driverSha256",
      "suiteSha256",
      "runtime",
      "process",
      "reportDirectory",
      "recordedAt",
      "stage",
      "phase",
      "runId",
      "assetId",
    ]) ||
    [leaseIntent, sendIntent].some(
      (row) => row.caseId !== videoCase.id || row.marker !== videoCase.token,
    ) ||
    sent.caseId !== videoCase.id ||
    leaseIntent.textSha256 !== digest(videoCase.prompt) ||
    sendIntent.textSha256 !== digest(videoCase.prompt) ||
    sendIntent.leaseId !== videoCase.acceptanceLease?.leaseId ||
    sendIntent.toolsSha256 !== videoCase.acceptanceLease?.toolsSha256 ||
    sendIntent.toolsSha256 !== toolManifestDigest(leaseTools) ||
    sent.driverMessageId !== videoCase.sentMessageId ||
    verified.runId !== videoAcceptance.runId ||
    verified.assetId !== videoAcceptance.asset?.assetId
  )
    reject("MEDIA_RECOVERY_CHECKPOINT");
  let pendingRow;
  try {
    pendingRow = JSON.parse(pending.bytes.toString("utf8"));
  } catch {
    reject("MEDIA_RECOVERY_CHECKPOINT");
  }
  if (!same(pendingRow, verified)) reject("MEDIA_RECOVERY_CHECKPOINT");

  const proofBase = {
    kind: "media-image-prefix-video-append-only-v1",
    planSha256: plan.planSha256,
    imageProofSha256: imagePrefixProofSha256,
    imageRunId: imagePrefixProductRunId,
    imageAssetId: imagePrefixAssetId,
    originalReportSha256: plan.reportSha256,
    originalLatestSha256: plan.latestSha256,
    stopSha256: plan.stopSha256,
    checkpointSha256: sha(checkpoint.bytes),
    reportDirectory,
    process: processIdentity,
    videoCaseId: videoCase.id,
    videoRunId: videoAcceptance.runId,
    videoAssetId: videoAcceptance.asset.assetId,
    pendingSequence: verified.sequence,
  };
  return { ...proofBase, proofSha256: digest(canonical(proofBase)) };
}

/** Remove the original media guard only after durable complete evidence has been written. */
export async function releaseMediaRecoveryGuards(
  plan,
  proof,
  { finalReportPath, finalLatestPath, reportRunId },
) {
  validatePlan(plan);
  const proofBase = { ...proof };
  delete proofBase.proofSha256;
  if (
    proof?.kind !== "media-image-prefix-video-append-only-v1" ||
    proof.planSha256 !== plan.planSha256 ||
    proof.proofSha256 !== digest(canonical(proofBase)) ||
    finalReportPath !== join(proof.reportDirectory, "report.json") ||
    finalLatestPath !== plan.latestPath ||
    !REPORT_RUN_ID.test(reportRunId ?? "")
  )
    reject("MEDIA_RECOVERY_RELEASE");
  const intentPath = releaseIntentPathForPending(plan.pendingPath);
  const intent = {
    schemaVersion: 1,
    kind: "media-recovery-guard-release-intent",
    planSha256: plan.planSha256,
    proofSha256: proof.proofSha256,
    reportRunId,
    reportDirectory: proof.reportDirectory,
    pendingPath: plan.pendingPath,
    stopPath: plan.stopPath,
    checkpointSha256: proof.checkpointSha256,
    recordedAt: new Date().toISOString(),
  };
  let intentHandle;
  try {
    intentHandle = await open(
      intentPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    await intentHandle.writeFile(JSON.stringify(intent) + "\n", "utf8");
    await intentHandle.sync();
  } catch {
    reject("MEDIA_RECOVERY_RELEASE_INTENT");
  } finally {
    await intentHandle?.close().catch(() => {});
  }
  await syncDirectory(dirname(intentPath));
  const [reportFile, latestFile, checkpointFile, pendingFile, stopFile] = await Promise.all([
    readPrivate(finalReportPath, MAX_REPORT_BYTES),
    readPrivate(finalLatestPath, MAX_REPORT_BYTES),
    readPrivate(plan.checkpointPath, MAX_CHECKPOINT_BYTES),
    readPrivate(plan.pendingPath, MAX_PENDING_BYTES),
    readPrivate(plan.stopPath, MAX_STOP_BYTES),
  ]);
  const finalReport = parseJson(reportFile);
  const latest = parseJson(latestFile);
  const rows = checkpointFile.bytes
    .toString("utf8")
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line));
  const pending = parseJson(pendingFile);
  if (
    finalReport.runId !== reportRunId ||
    finalReport.mode !== "resume-media" ||
    finalReport.status !== "PASS" ||
    finalReport.productAcceptance?.status !== "PASS" ||
    finalReport.productAcceptance?.cleanupVerified !== true ||
    !same(finalReport.mediaFamilyAcceptance, {
      status: "PASS",
      familyId: MEDIA_FAMILY_ID,
      stageRunIds: [proof.imageRunId, proof.videoRunId],
      retainedAssets: [
        finalReport.productAcceptance?.cases?.[0]?.asset,
        finalReport.productAcceptance?.cases?.[1]?.asset,
      ],
      cleanup: { required: true, leaseRevoked: true, assetsRetained: true },
      limitation: mediaFamilyPlan().limitation,
    }) ||
    !Array.isArray(finalReport.productAcceptance?.cases) ||
    finalReport.productAcceptance.cases.length !== 2 ||
    finalReport.productAcceptance.cases[0]?.caseId !== "media-image-1k" ||
    finalReport.productAcceptance.cases[0]?.runId !== proof.imageRunId ||
    finalReport.productAcceptance.cases[0]?.status !== "PASS" ||
    finalReport.productAcceptance.cases[0]?.asset?.assetId !== proof.imageAssetId ||
    finalReport.productAcceptance.cases[1]?.caseId !== "media-video-4s" ||
    finalReport.productAcceptance.cases[1]?.runId !== proof.videoRunId ||
    finalReport.productAcceptance.cases[1]?.status !== "PASS" ||
    finalReport.productAcceptance.cases[1]?.asset?.assetId !== proof.videoAssetId ||
    finalReport.mediaRecoveryFinalProof?.proofSha256 !== proof.proofSha256 ||
    latest.runId !== reportRunId ||
    latest.reportDirectory !== proof.reportDirectory ||
    latest.status !== "PASS" ||
    latest.productAcceptance?.status !== "PASS" ||
    !Array.isArray(latest.productAcceptance?.cases) ||
    latest.productAcceptance.cases.length !== 2 ||
    latest.productAcceptance.cases[0]?.runId !== proof.imageRunId ||
    latest.productAcceptance.cases[0]?.asset?.assetId !== proof.imageAssetId ||
    latest.productAcceptance.cases[1]?.runId !== proof.videoRunId ||
    latest.productAcceptance.cases[1]?.asset?.assetId !== proof.videoAssetId ||
    !same(latest.mediaFamilyAcceptance, finalReport.mediaFamilyAcceptance) ||
    latest.mediaRecoveryFinalProof?.proofSha256 !== proof.proofSha256 ||
    sha(checkpointFile.bytes) !== proof.checkpointSha256 ||
    rows.length !== 9 ||
    !same(pending, rows.at(-1)) ||
    rows.at(-1)?.phase !== "verified" ||
    rows.at(-1)?.stage !== "video-4s" ||
    stopFile.sha256 !== plan.stopSha256 ||
    !sameFingerprint(stopFile.fingerprint, plan.stopFingerprint) ||
    stopFile.bytes.toString("utf8") !== STOP_CONTENT
  )
    reject("MEDIA_RECOVERY_RELEASE");

  const initialStop = await lstat(plan.stopPath).catch(() => null);
  if (!initialStop || !sameFingerprint(fingerprint(initialStop), plan.stopFingerprint))
    reject("MEDIA_RECOVERY_RELEASE");
  await rm(plan.pendingPath);
  await syncDirectory(dirname(plan.pendingPath));
  const currentStop = await lstat(plan.stopPath).catch(() => null);
  if (!currentStop || !sameFingerprint(fingerprint(currentStop), plan.stopFingerprint))
    reject("MEDIA_RECOVERY_RELEASE");
  await rm(plan.stopPath);
  await syncDirectory(plan.out);
  await rm(intentPath);
  await syncDirectory(dirname(intentPath));
  return {
    status: "MEDIA_RECOVERY_GUARDS_RELEASED",
    reportRunId,
    proofSha256: proof.proofSha256,
  };
}

/** Any unfinished release intent blocks live sends until a human reconciles it. */
export async function hasUnresolvedMediaRecoveryRelease(config, locksDirectory) {
  let intentPath;
  try {
    intentPath = releaseIntentPathFor(config, locksDirectory);
  } catch {
    return true;
  }
  try {
    await lstat(intentPath);
    return true;
  } catch (error) {
    return error?.code !== "ENOENT";
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
