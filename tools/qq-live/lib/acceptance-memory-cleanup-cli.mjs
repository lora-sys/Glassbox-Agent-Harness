import { open, readFile, lstat, mkdir, realpath, rm, chmod, readdir } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { dirname, join, resolve, posix } from "node:path";
import { homedir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { fail, digest, safeError, toolManifestDigest } from "./core.mjs";
import {
  runtimeInspectionSnapshot,
  runtimeSnapshot,
  readTraceEvents,
  verifyProductEvidence,
} from "./product-evidence.mjs";
import { acceptanceManagement } from "./management-client.mjs";
import { Recorder, doctor, replyCase } from "./runner.mjs";
import { OneBot } from "./onebot.mjs";
import { readMemoryRecoveryRecord } from "./memory-recovery-record.mjs";
import { verifyAcceptanceMemoryNoIngressReceipt } from "./acceptance-memory-attempt-reconciliation.mjs";
import { verifyMemoryProcessStopped } from "./memory-process.mjs";
import {
  acceptanceMemoryInventorySha256,
  buildAcceptanceMemoryCleanupPlan,
  verifyAcceptanceMemoryCleanup,
} from "./acceptance-memory-cleanup-plan.mjs";

const SHA256 = /^[a-f0-9]{64}$/u;
const ID = /^[A-Za-z0-9_-]{1,128}$/u;
const CANDIDATE = /^candidate_[a-f0-9]{32}$/u;
const MAX_MANIFEST_BYTES = 4096;
const MAX_INVENTORY_BYTES = 64 * 1024;
const MAX_REPORT_BYTES = 128 * 1024;
const MAX_AUDIT_BYTES = 16 * 1024 * 1024;
const MAX_GUARD_BYTES = 1024 * 1024;
const MAX_JOURNAL_BYTES = 40 * (1024 * 1024 + 1);

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, keys) {
  return record(value) && Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (record(value))
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  const result = JSON.stringify(value);
  if (result === undefined || (typeof value === "number" && !Number.isFinite(value)))
    throw new TypeError("Invalid cleanup evidence.");
  return result;
}

function sha(value) {
  return createHash("sha256").update(value).digest("hex");
}

function safeFailure(code, message = "固定清理证据无法核实，未继续执行。") {
  fail(code, message, "INCONCLUSIVE");
}

async function ensureNoUnresolvedCleanupSend(out, config, runtime, manifestPath, deps = {}) {
  let entries;
  try {
    entries = await readdir(out, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    safeFailure("CLEANUP_PRIOR_ATTEMPT", "先核实上一轮清理发送结果。");
  }
  const eligible = [];
  for (const entry of entries) {
    if (!entry.name.startsWith("acceptance-memory-cleanup_")) continue;
    if (!entry.isDirectory() || entry.isSymbolicLink()) safeFailure("CLEANUP_PRIOR_ATTEMPT");
    const directory = join(out, entry.name);
    const intentPath = join(directory, "send-intent.json");
    const failurePath = join(directory, "failure.json");
    const completionPath = join(directory, "report.json");
    const intentStat = await lstat(intentPath).catch((error) =>
      error.code === "ENOENT" ? null : safeFailure("CLEANUP_PRIOR_ATTEMPT"),
    );
    const failureStat = await lstat(failurePath).catch((error) =>
      error.code === "ENOENT" ? null : safeFailure("CLEANUP_PRIOR_ATTEMPT"),
    );
    const completionStat = await lstat(completionPath).catch((error) =>
      error.code === "ENOENT" ? null : safeFailure("CLEANUP_PRIOR_ATTEMPT"),
    );
    if (completionStat) {
      if (!completionStat.isFile() || completionStat.isSymbolicLink())
        safeFailure("CLEANUP_PRIOR_ATTEMPT");
      const completion = parseJson(
        (await readPrivateFile(completionPath, MAX_REPORT_BYTES)).bytes,
        "CLEANUP_PRIOR_ATTEMPT",
      );
      if (
        completion.kind === "acceptance-memory-cleanup" &&
        completion.status === "CLEANUP_VERIFIED" &&
        completion.cleanupOnly === true &&
        completion.featurePass === false
      )
        continue;
      safeFailure("CLEANUP_PRIOR_ATTEMPT");
    }
    if (intentStat && (!intentStat.isFile() || intentStat.isSymbolicLink()))
      safeFailure("CLEANUP_PRIOR_ATTEMPT");
    if (failureStat && (!failureStat.isFile() || failureStat.isSymbolicLink()))
      safeFailure("CLEANUP_PRIOR_ATTEMPT");
    if (!intentStat && !failureStat) continue;
    if (!failureStat)
      safeFailure(
        "CLEANUP_PRIOR_ATTEMPT",
        "上一轮清理可能已经发送。需要独立核实无入站消息、无 Run 和许可已撤销后，才能开始新一轮。",
      );
    const failure = parseJson(
      (await readPrivateFile(failurePath, MAX_REPORT_BYTES)).bytes,
      "CLEANUP_PRIOR_ATTEMPT",
    );
    const sendMayHaveOccurred = intentStat !== null || failure?.case?.sendAttempted === true;
    if (!sendMayHaveOccurred) continue;
    const receiptPath = join(directory, "no-ingress-receipt.json");
    const receiptStat = await lstat(receiptPath).catch((error) =>
      error.code === "ENOENT" ? null : safeFailure("CLEANUP_PRIOR_ATTEMPT"),
    );
    if (!receiptStat)
      safeFailure(
        "CLEANUP_PRIOR_ATTEMPT",
        "上一轮清理已经尝试发送。先独立核实该轮无入站消息、无 Run 和许可已撤销，禁止自动重发。",
      );
    if (!receiptStat.isFile() || receiptStat.isSymbolicLink()) safeFailure("CLEANUP_PRIOR_ATTEMPT");
    const valid = await verifyAcceptanceMemoryNoIngressReceipt({
      receiptPath,
      reportPath: failurePath,
      reportDirectory: directory,
      manifestPath,
      config,
      out,
      expectedRuntime: runtime,
      deps,
    });
    if (!valid) safeFailure("CLEANUP_PRIOR_ATTEMPT", "上一轮清理的无入站回执已经失效，禁止重发。");
    const usedPath = join(directory, "retry-used.json");
    const usedStat = await lstat(usedPath).catch((error) =>
      error.code === "ENOENT" ? null : safeFailure("CLEANUP_PRIOR_ATTEMPT"),
    );
    if (usedStat) {
      if (!usedStat.isFile() || usedStat.isSymbolicLink()) safeFailure("CLEANUP_PRIOR_ATTEMPT");
      const used = parseJson(
        (await readPrivateFile(usedPath, 4096)).bytes,
        "CLEANUP_PRIOR_ATTEMPT",
      );
      const receiptFile = await readPrivateFile(receiptPath, MAX_REPORT_BYTES);
      if (
        !exactKeys(used, ["schemaVersion", "kind", "receiptSha256", "planSha256", "at"]) ||
        used.schemaVersion !== 1 ||
        used.kind !== "acceptance-memory-no-ingress-retry-used" ||
        used.receiptSha256 !== receiptFile.sha256 ||
        used.planSha256 !== failure.planSha256 ||
        !Number.isFinite(Date.parse(used.at)) ||
        new Date(used.at).toISOString() !== used.at
      )
        safeFailure("CLEANUP_PRIOR_ATTEMPT");
      continue;
    }
    eligible.push({ directory, receiptPath, reportPath: failurePath, usedPath });
  }
  if (eligible.length > 1) safeFailure("CLEANUP_PRIOR_ATTEMPT", "多条上一轮清理回执无法唯一配对。");
  return eligible[0];
}

async function readPrivateFile(path, limit, { enforcePrivate = true } = {}) {
  if (typeof path !== "string" || !path.startsWith("/") || resolve(path) !== path)
    safeFailure("CLEANUP_PATH", "清理证据路径不是规范绝对路径。");
  let before;
  try {
    before = await lstat(path);
  } catch {
    safeFailure("CLEANUP_READ", "清理所需的固定证据文件无法读取。");
  }
  if (!before.isFile() || before.isSymbolicLink() || before.size > limit)
    safeFailure("CLEANUP_FILE", "清理证据必须是范围内的普通文件。");
  if (enforcePrivate && (before.mode & 0o077) !== 0)
    safeFailure("CLEANUP_FILE_MODE", "清理证据文件权限过宽。");
  if (typeof process.getuid === "function" && before.uid !== process.getuid())
    safeFailure("CLEANUP_FILE_OWNER", "清理证据文件不属于当前执行用户。");
  let bytes;
  try {
    if ((await realpath(path)) !== path) safeFailure("CLEANUP_PATH", "清理证据路径包含别名。");
    bytes = await readFile(path);
  } catch {
    safeFailure("CLEANUP_READ", "清理所需的固定证据文件无法读取。");
  }
  const after = await lstat(path);
  if (
    after.dev !== before.dev ||
    after.ino !== before.ino ||
    after.size !== before.size ||
    after.mtimeMs !== before.mtimeMs ||
    bytes.byteLength !== before.size
  )
    safeFailure("CLEANUP_FILE_CHANGED", "读取期间清理证据发生变化。");
  return { bytes, sha256: sha(bytes) };
}

function parseJson(bytes, code) {
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    safeFailure(code, "清理证据格式无效。");
  }
}

async function readManifest(path) {
  const { bytes } = await readPrivateFile(path, MAX_MANIFEST_BYTES);
  const manifest = parseJson(bytes, "CLEANUP_MANIFEST");
  if (
    !exactKeys(manifest, [
      "schemaVersion",
      "inventoryPath",
      "sourceAuditSnapshotPath",
      "originalReportPath",
      "pendingGuardPath",
    ]) ||
    manifest.schemaVersion !== 1 ||
    [
      manifest.inventoryPath,
      manifest.sourceAuditSnapshotPath,
      manifest.originalReportPath,
      manifest.pendingGuardPath,
    ].some((pathValue) => typeof pathValue !== "string" || !pathValue.startsWith("/"))
  )
    safeFailure("CLEANUP_MANIFEST", "清理清单必须匹配固定 schemaVersion 1。");
  return manifest;
}

function parseAuditSnapshot(bytes) {
  const text = bytes.toString("utf8");
  if (!text.endsWith("\n")) safeFailure("CLEANUP_SOURCE_AUDIT", "来源许可审计不完整。");
  const lines = text.slice(0, -1).split("\n");
  if (!lines.length || lines.length > 50000)
    safeFailure("CLEANUP_SOURCE_AUDIT", "来源许可审计超出核验范围。");
  const rows = [];
  for (const line of lines) {
    if (!line || Buffer.byteLength(line) > 32768)
      safeFailure("CLEANUP_SOURCE_AUDIT", "来源许可审计行无效。");
    const row = parseJson(Buffer.from(line), "CLEANUP_SOURCE_AUDIT");
    if (JSON.stringify(row) !== line || !record(row))
      safeFailure("CLEANUP_SOURCE_AUDIT", "来源许可审计行不是规范记录。");
    rows.push(row);
  }
  return rows;
}

function expectedScope(config) {
  return {
    connectionId: config.runtime.connectionId,
    botId: config.bot.qq,
    chatType: "private",
    chatId: config.driver.qq,
    senderId: config.driver.qq,
    threadId: config.runtime.threadId ?? null,
  };
}

function scopeKey(scope) {
  return JSON.stringify([
    scope.connectionId,
    String(scope.botId),
    scope.chatType,
    String(scope.chatId),
    String(scope.senderId),
    scope.threadId ?? null,
  ]);
}

function dbCanonicalJson(raw) {
  try {
    return canonical(JSON.parse(raw));
  } catch {
    safeFailure("CLEANUP_DB_JSON", "记忆候选的来源字段无法核实。");
  }
}

function allowedSourceScopes(config) {
  const base = expectedScope(config);
  return [
    base,
    ...(config.groups ?? [])
      .filter((group) => ["A", "B"].includes(group.alias))
      .map((group) => ({ ...base, chatType: "group", chatId: group.id })),
  ];
}

function sourceScope(scope, allowed) {
  if (!record(scope)) return undefined;
  const fields = ["connectionId", "botId", "chatType", "chatId", "senderId", "threadId"];
  const projection = Object.fromEntries(fields.map((field) => [field, scope[field] ?? null]));
  return allowed.find((candidate) => canonical(projection) === canonical(candidate));
}

export function validateAcceptanceMemorySourceAuditRows(rows, db, config) {
  const byRun = new Map();
  const registrations = new Map();
  const fullRevocations = new Map();
  const legacyRevocations = new Map();
  const indexOf = new Map(rows.map((row, index) => [row, index]));
  for (const row of rows) {
    if (!record(row) || typeof row.event !== "string")
      safeFailure("CLEANUP_SOURCE_AUDIT", "来源许可审计格式无效。");
    if (row.event === "lease_registered") {
      if (
        !exactKeys(row, [
          "at",
          "event",
          "expiresAt",
          "leaseId",
          "marker",
          "principalId",
          "scopeSha256",
          "toolsSha256",
        ]) ||
        !ID.test(row.leaseId ?? "") ||
        !/^[a-f0-9]{32}$/u.test(row.marker ?? "") ||
        !ID.test(row.principalId ?? "") ||
        !SHA256.test(row.scopeSha256 ?? "") ||
        !SHA256.test(row.toolsSha256 ?? "") ||
        !Number.isSafeInteger(row.expiresAt) ||
        !Number.isFinite(Date.parse(row.at))
      )
        safeFailure("CLEANUP_SOURCE_AUDIT", "许可登记来源记录无效。");
      const key = `${row.leaseId}\0${row.marker}`;
      if (registrations.has(key)) safeFailure("CLEANUP_SOURCE_AUDIT", "来源许可登记记录重复。");
      registrations.set(key, row);
    } else if (row.event === "lease_revoked") {
      const isFull = exactKeys(row, [
        "at",
        "event",
        "leaseId",
        "marker",
        "principalId",
        "scopeSha256",
      ]);
      const isLegacy = exactKeys(row, ["at", "event", "leaseId", "principalId"]);
      if (
        (!isFull && !isLegacy) ||
        !ID.test(row.leaseId ?? "") ||
        !ID.test(row.principalId ?? "") ||
        !Number.isFinite(Date.parse(row.at)) ||
        (isFull &&
          (!/^[a-f0-9]{32}$/u.test(row.marker ?? "") || !SHA256.test(row.scopeSha256 ?? "")))
      )
        safeFailure("CLEANUP_SOURCE_AUDIT", "来源许可撤销记录无效。");
      const target = isLegacy ? legacyRevocations : fullRevocations;
      const key = isLegacy ? row.leaseId : `${row.leaseId}\0${row.marker}`;
      if (target.has(key)) safeFailure("CLEANUP_SOURCE_AUDIT", "来源许可撤销记录重复。");
      target.set(key, row);
    } else if (row.event === "run_bound") {
      if (
        !exactKeys(row, [
          "at",
          "event",
          "leaseId",
          "marker",
          "messageId",
          "principalId",
          "runId",
          "scopeSha256",
          "textSha256",
          "toolsSha256",
        ]) ||
        !ID.test(row.leaseId ?? "") ||
        !/^[a-f0-9]{32}$/u.test(row.marker ?? "") ||
        !/^-?\d{1,20}$/u.test(String(row.messageId ?? "")) ||
        !ID.test(row.principalId ?? "") ||
        !ID.test(row.runId ?? "") ||
        !SHA256.test(row.scopeSha256 ?? "") ||
        !SHA256.test(row.textSha256 ?? "") ||
        !SHA256.test(row.toolsSha256 ?? "") ||
        !Number.isFinite(Date.parse(row.at)) ||
        byRun.has(row.runId)
      )
        safeFailure("CLEANUP_SOURCE_AUDIT", "Run 绑定来源记录无效或重复。");
      byRun.set(row.runId, row);
    } else safeFailure("CLEANUP_SOURCE_AUDIT", "来源许可审计包含不支持的记录类型。");
  }

  const registrationsByLease = new Map();
  for (const registration of registrations.values()) {
    const list = registrationsByLease.get(registration.leaseId) ?? [];
    list.push(registration);
    registrationsByLease.set(registration.leaseId, list);
  }
  const bindingsByLease = new Map();
  for (const bound of byRun.values()) {
    const list = bindingsByLease.get(bound.leaseId) ?? [];
    list.push(bound);
    bindingsByLease.set(bound.leaseId, list);
  }
  const revocationByRegistration = new Map();
  for (const registration of registrations.values()) {
    const key = `${registration.leaseId}\0${registration.marker}`;
    const full = fullRevocations.get(key);
    const legacy = legacyRevocations.get(registration.leaseId);
    if ((full ? 1 : 0) + (legacy ? 1 : 0) !== 1)
      safeFailure("CLEANUP_SOURCE_AUDIT", "许可登记没有唯一且匹配的撤销记录。");
    const revoked = full ?? legacy;
    if (
      revoked.principalId !== registration.principalId ||
      (full &&
        (revoked.marker !== registration.marker ||
          revoked.scopeSha256 !== registration.scopeSha256)) ||
      (legacy && registrationsByLease.get(registration.leaseId)?.length !== 1)
    )
      safeFailure("CLEANUP_SOURCE_AUDIT", "许可撤销主体或范围无法唯一绑定。");
    const bounds = bindingsByLease.get(registration.leaseId) ?? [];
    if (
      bounds.length > 1 ||
      bounds.some(
        (bound) =>
          bound.marker !== registration.marker ||
          bound.principalId !== registration.principalId ||
          bound.scopeSha256 !== registration.scopeSha256 ||
          bound.toolsSha256 !== registration.toolsSha256,
      )
    )
      safeFailure("CLEANUP_SOURCE_AUDIT", "许可登记与 Run 绑定存在歧义。");
    const bound = bounds[0];
    if (
      Date.parse(registration.at) > Date.parse(revoked.at) ||
      indexOf.get(registration) >= indexOf.get(revoked) ||
      (bound &&
        (Date.parse(registration.at) > Date.parse(bound.at) ||
          Date.parse(bound.at) > Date.parse(revoked.at) ||
          registration.expiresAt < Date.parse(bound.at) ||
          indexOf.get(registration) >= indexOf.get(bound) ||
          indexOf.get(bound) >= indexOf.get(revoked)))
    )
      safeFailure("CLEANUP_SOURCE_AUDIT", "许可登记、Run 绑定与撤销顺序无效。");
    revocationByRegistration.set(key, revoked);
  }
  for (const row of fullRevocations.values())
    if (!registrations.has(`${row.leaseId}\0${row.marker}`))
      safeFailure("CLEANUP_SOURCE_AUDIT", "许可撤销记录没有对应登记。");
  for (const [leaseId, row] of legacyRevocations) {
    const matching = registrationsByLease.get(leaseId) ?? [];
    if (matching.length !== 1 || matching[0].principalId !== row.principalId)
      safeFailure("CLEANUP_SOURCE_AUDIT", "旧格式许可撤销无法唯一绑定登记主体。");
  }
  for (const bound of byRun.values())
    if (!registrations.has(`${bound.leaseId}\0${bound.marker}`))
      safeFailure("CLEANUP_SOURCE_AUDIT", "Run 绑定没有对应许可登记。");

  const allowedScopes = allowedSourceScopes(config);
  const checked = new Map();
  for (const [runId, bound] of byRun) {
    const key = `${bound.leaseId}\0${bound.marker}`;
    const registered = registrations.get(key);
    const revoked = revocationByRegistration.get(key);
    if (!registered || !revoked)
      safeFailure("CLEANUP_SOURCE_AUDIT", "Run 绑定许可没有唯一撤销记录。");
    const run = db
      .prepare(
        `SELECT r.id,r.status,r.principal_id,r.scope_json,r.message_id,m.external_id,m.text FROM runs r JOIN messages m ON m.id=r.message_id WHERE r.id=?`,
      )
      .get(runId);
    if (
      !run ||
      run.principal_id !== bound.principalId ||
      ["running", "queued", "cancelling"].includes(run.status)
    )
      continue;
    const scope = parseJson(Buffer.from(run.scope_json), "CLEANUP_DB_JSON");
    const allowed = sourceScope(scope, allowedScopes);
    if (
      !allowed ||
      bound.scopeSha256 !== sha(scopeKey(allowed)) ||
      String(run.external_id) !== String(bound.messageId) ||
      bound.textSha256 !== sha(String(run.text).replace(/\r\n?/gu, "\n"))
    )
      continue;
    const principal = db.prepare("SELECT kind FROM principals WHERE id=?").get(bound.principalId);
    if (principal?.kind !== "owner") continue;
    const lookupKey = `${bound.principalId}\0${bound.scopeSha256}\0${bound.textSha256}`;
    checked.set(runId, {
      runId,
      principalId: bound.principalId,
      messageId: String(bound.messageId),
      leaseId: bound.leaseId,
      marker: bound.marker,
      scopeSha256: bound.scopeSha256,
      textSha256: bound.textSha256,
      toolsSha256: bound.toolsSha256,
      scope: allowed,
      lookupKey,
    });
  }
  return checked;
}

const validateSourceAuditRows = validateAcceptanceMemorySourceAuditRows;
function rawRowHash(row) {
  return sha(canonical(row));
}

function captureInventoryFromDb(db, statedInventory, sourceRuns, config) {
  if (
    !record(statedInventory) ||
    statedInventory.schemaVersion !== 1 ||
    !Array.isArray(statedInventory.candidates)
  )
    safeFailure("CLEANUP_INVENTORY", "候选清单格式无效。");
  const entries = [];
  for (const stated of statedInventory.candidates) {
    if (!CANDIDATE.test(stated?.candidateId ?? ""))
      safeFailure("CLEANUP_INVENTORY", "候选标识无效。");
    const candidate = db
      .prepare("SELECT * FROM memory_candidates WHERE id=?")
      .get(stated.candidateId);
    if (!candidate) safeFailure("CLEANUP_INVENTORY", "记录的候选不在当前数据库中。");
    const feedback = db
      .prepare("SELECT * FROM feedback_events WHERE candidate_id=? ORDER BY created_at,id")
      .all(candidate.id);
    if (feedback.length > 1) safeFailure("CLEANUP_PROVENANCE", "候选反馈来源存在歧义。");
    const sourceFeedback = feedback[0] ?? null;
    if (sourceFeedback && sourceFeedback.signal_type !== "explicit_positive")
      safeFailure("CLEANUP_PROVENANCE", "候选反馈来源类型不符合固定清理范围。");
    const target = sourceFeedback?.id ?? candidate.id;
    const audit = db
      .prepare(
        "SELECT * FROM memory_audit_events WHERE action='write' AND target_id=? ORDER BY sequence",
      )
      .all(target);
    if (audit.length !== 1) safeFailure("CLEANUP_PROVENANCE", "候选原始写入审计缺失或存在歧义。");
    const sourceAudit = audit[0];
    const sourceRun = sourceRuns.get(sourceAudit.run_id);
    if (!sourceRun || sourceRun.principalId !== sourceAudit.principal_id)
      safeFailure("CLEANUP_SOURCE_RUN", "候选来源 Run 未被独立许可记录绑定。");
    const run = db
      .prepare(
        "SELECT r.principal_id,r.scope_json,p.kind AS principal_kind FROM runs r JOIN principals p ON p.id=r.principal_id WHERE r.id=?",
      )
      .get(sourceAudit.run_id);
    if (!run || run.principal_id !== sourceAudit.principal_id || run.principal_kind !== "owner")
      safeFailure("CLEANUP_SOURCE_RUN", "候选来源 Run 不是已核实的 Owner Run。");
    const runScope = parseJson(Buffer.from(run.scope_json), "CLEANUP_DB_JSON");
    if (!sourceScope(runScope, allowedSourceScopes(config)))
      safeFailure("CLEANUP_SOURCE_RUN", "候选来源范围不是固定 Owner 私聊或配置群 A/B。");
    let lineage;
    try {
      lineage = JSON.parse(sourceAudit.lineage_json);
    } catch {
      safeFailure("CLEANUP_PROVENANCE", "候选审计来源链无效。");
    }
    const expectedLineage = sourceFeedback
      ? [candidate.id, `run:${sourceAudit.run_id}`]
      : [`run:${sourceAudit.run_id}`];
    if (
      canonical(lineage) !== canonical(expectedLineage) ||
      sourceAudit.created_at < candidate.created_at
    )
      safeFailure("CLEANUP_PROVENANCE", "候选原始写入来源链不符合固定范围。");
    const entry = {
      candidateId: candidate.id,
      status: candidate.status,
      promotedMemoryId: candidate.promoted_memory_id,
      candidateKind: candidate.candidate_kind,
      createdAt: candidate.created_at,
      scopeSha256: sha(canonical(JSON.parse(candidate.scope_json))),
      subjectSha256: sha(canonical(JSON.parse(candidate.subject_json))),
      statementSha256: sha(candidate.statement),
      sourceSha256: sha(canonical(JSON.parse(candidate.source_json))),
      principalId: sourceAudit.principal_id,
      sourceRunId: sourceAudit.run_id,
      auditWrite: {
        id: sourceAudit.id,
        sequence: sourceAudit.sequence,
        principalId: sourceAudit.principal_id,
        action: sourceAudit.action,
        targetId: sourceAudit.target_id,
        runId: sourceAudit.run_id,
        lineage,
        createdAt: sourceAudit.created_at,
        rowSha256: rawRowHash(sourceAudit),
      },
      sourceFeedback: sourceFeedback
        ? {
            id: sourceFeedback.id,
            candidateId: sourceFeedback.candidate_id,
            runId: sourceFeedback.run_id,
            signalType: sourceFeedback.signal_type,
            createdAt: sourceFeedback.created_at,
            rowSha256: rawRowHash(sourceFeedback),
          }
        : null,
    };
    if (
      sourceAudit.principal_id !== "owner" ||
      sourceRun.principalId !== entry.principalId ||
      sourceRun.scopeSha256 !== sha(scopeKey(sourceRun.scope))
    )
      safeFailure("CLEANUP_PROVENANCE", "候选来源与账号许可审计不匹配。");
    entries.push(entry);
  }
  entries.sort((a, b) => a.candidateId.localeCompare(b.candidateId));
  return { schemaVersion: 1, candidates: entries };
}

export function readCurrentInventory(runtime, stated, sourceAuditRows, config) {
  const db = openCurrentInventoryDb(join(runtime.dataDirectory, "glassbox.db"));
  try {
    const sourceRuns = validateSourceAuditRows(sourceAuditRows, db, config);
    const inventory = captureInventoryFromDb(db, stated, sourceRuns, config);
    return {
      inventory,
      inventorySha256: acceptanceMemoryInventorySha256(inventory),
      db,
    };
  } catch (error) {
    db.close();
    throw error;
  }
}

const INVENTORY_READ_BUSY_TIMEOUT_MS = 5_000;

export function openCurrentInventoryDb(
  path,
  { busyTimeoutMs = INVENTORY_READ_BUSY_TIMEOUT_MS } = {},
) {
  if (!Number.isSafeInteger(busyTimeoutMs) || busyTimeoutMs < 0 || busyTimeoutMs > 30_000)
    safeFailure("CLEANUP_DB_TIMEOUT", "只读数据库等待时限无效。");
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    db.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

export async function verifyAcceptanceMemoryCleanupOrigin(
  config,
  loaded,
  { verifyProcessStopped = verifyMemoryProcessStopped } = {},
) {
  const report = parseJson(loaded.report.bytes, "CLEANUP_REPORT");
  const guard = parseJson(loaded.guard.bytes, "CLEANUP_GUARD");
  if (
    !record(report) ||
    report.mode !== "run" ||
    report.status === "PASS" ||
    !record(report.runtime) ||
    !record(guard) ||
    guard.reportDirectory !== dirname(loaded.manifest.originalReportPath) ||
    guard.runId !== posix.basename(guard.reportDirectory) ||
    !record(guard.origin) ||
    !record(guard.origin.runtime)
  )
    safeFailure("CLEANUP_ORIGIN", "原测试报告和待处理记录无法建立固定绑定。");
  const savedRuntime = guard.origin.runtime;
  const cleanRuntimeKeys = [
    "checkout",
    "dataDirectory",
    "commit",
    "pid",
    "connectionId",
    "threadId",
  ];
  const developmentRuntimeKeys = [...cleanRuntimeKeys, "development", "sourceTreeSha256"];
  const originalRuntime = structuredClone(savedRuntime);
  const savedRuntimeKeys = Object.keys(savedRuntime).sort();
  if (
    ![cleanRuntimeKeys, developmentRuntimeKeys].some(
      (keys) => keys.slice().sort().join("\0") === savedRuntimeKeys.join("\0"),
    ) ||
    (savedRuntimeKeys.includes("development") &&
      (savedRuntime.development !== true || !SHA256.test(savedRuntime.sourceTreeSha256 ?? ""))) ||
    canonical(report.runtime) !== canonical(originalRuntime)
  )
    safeFailure("CLEANUP_ORIGIN_RUNTIME", "原测试运行身份不符合受支持的固定 schema。");

  // Read the original checkpoint bytes as written. The strict reader validates the saved Runtime
  // shape against itself, while the cleanup plan separately binds the current Runtime.
  const journalPath = join(guard.reportDirectory, "memory-fixture.jsonl");
  const journalFile = await readPrivateFile(journalPath, MAX_JOURNAL_BYTES);
  const originalFiles = new Map([
    [loaded.manifest.pendingGuardPath, loaded.guard.bytes],
    [journalPath, journalFile.bytes],
  ]);
  const recoveryRecord = await readMemoryRecoveryRecord({
    pendingPath: loaded.manifest.pendingGuardPath,
    driverQQ: config.driver.qq,
    scope: expectedScope(config),
    runtime: originalRuntime,
    read: async (path, limit) => {
      const bytes = originalFiles.get(path);
      if (!bytes) safeFailure("CLEANUP_ORIGIN", "原检查点文件路径超出固定范围。");
      if (bytes.byteLength > limit) safeFailure("CLEANUP_ORIGIN", "原检查点超过固定读取范围。");
      return bytes;
    },
  });
  if (
    recoveryRecord.runId !== guard.runId ||
    recoveryRecord.pending.checkpointSha256 !== guard.checkpointSha256 ||
    recoveryRecord.reportDirectory !== dirname(loaded.manifest.originalReportPath)
  )
    safeFailure("CLEANUP_ORIGIN", "待处理记录和原始进度链不匹配。");
  const processIds = new Map();
  for (const identity of [
    recoveryRecord.origin.process,
    ...recoveryRecord.rows.map((row) => row.recoveryAttempt?.process).filter(Boolean),
  ])
    processIds.set(JSON.stringify(identity), identity);
  for (const identity of processIds.values()) await verifyProcessStopped(identity);
  return { report, guard, record: recoveryRecord, originalRuntime };
}

export async function loadAcceptanceMemoryCleanupInputs(config, manifestPath) {
  const manifest = await readManifest(manifestPath);
  const [inventory, sourceAudit, report, guard] = await Promise.all([
    readPrivateFile(manifest.inventoryPath, MAX_INVENTORY_BYTES),
    readPrivateFile(manifest.sourceAuditSnapshotPath, MAX_AUDIT_BYTES),
    readPrivateFile(manifest.originalReportPath, MAX_REPORT_BYTES),
    readPrivateFile(manifest.pendingGuardPath, MAX_GUARD_BYTES),
  ]);
  return {
    manifest,
    manifestPath,
    manifestSha256: sha(await readFile(manifestPath)),
    inventory: parseJson(inventory.bytes, "CLEANUP_INVENTORY"),
    inventoryFileSha256: inventory.sha256,
    sourceAuditRows: parseAuditSnapshot(sourceAudit.bytes),
    sourceAuditSha256: sourceAudit.sha256,
    report,
    guard,
    origin: {
      reportSha256: report.sha256,
      guardSha256: guard.sha256,
      sourceAuditSha256: sourceAudit.sha256,
    },
    originState: await verifyAcceptanceMemoryCleanupOrigin(config, {
      manifest,
      report,
      guard,
    }),
  };
}

const loadInputs = loadAcceptanceMemoryCleanupInputs;

function inventoryMatches(stated, observed) {
  return acceptanceMemoryInventorySha256(stated) === acceptanceMemoryInventorySha256(observed);
}

async function stopFingerprint(path) {
  const info = await lstat(path).catch((error) =>
    error.code === "ENOENT" ? null : Promise.reject(error),
  );
  if (!info) safeFailure("CLEANUP_STOP_REQUIRED", "原验收停止标记缺失，禁止执行清理。");
  if (!info.isFile() || info.isSymbolicLink() || info.size > 16384 || (info.mode & 0o077) !== 0)
    safeFailure("CLEANUP_STOP_UNVERIFIED", "原验收停止标记无法安全核实。");
  const bytes = await readFile(path);
  const after = await lstat(path);
  if (
    info.dev !== after.dev ||
    info.ino !== after.ino ||
    info.size !== after.size ||
    info.mtimeMs !== after.mtimeMs
  )
    safeFailure("CLEANUP_STOP_CHANGED", "读取停止标记期间文件发生变化。");
  return `${info.dev}:${info.ino}:${info.mtimeMs}:${info.size}:${sha(bytes)}`;
}

async function acquireAccountLock(path, identity) {
  const handle = await open(path, "wx", 0o600).catch((error) => {
    if (error.code === "EEXIST")
      safeFailure("CLEANUP_ACCOUNT_LOCKED", "该账号已有实机验收进程，未并发执行。");
    throw error;
  });
  await handle.writeFile(
    JSON.stringify({
      pid: identity.pid,
      process: identity,
      startedAt: new Date().toISOString(),
    }),
  );
  await handle.sync();
  return handle;
}

async function releaseAccountLock(path, handle) {
  const owned = await handle.stat();
  const current = await lstat(path);
  if (!current.isFile() || current.ino !== owned.ino || current.dev !== owned.dev)
    safeFailure("CLEANUP_ACCOUNT_LOCK", "账号锁已被替换，保留当前锁文件。");
  await rm(path);
  await handle.close();
}

async function writeNewJson(dir, name, value) {
  const path = join(dir, name);
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(JSON.stringify(value, null, 2) + "\n");
    await handle.sync();
  } finally {
    await handle.close();
  }
  const folder = await open(dir, "r");
  try {
    await folder.sync();
  } finally {
    await folder.close();
  }
  return path;
}

function makeFixedSpec(plan) {
  return {
    id: "acceptance-memory-cleanup",
    chat: "private",
    prompt: plan.prompt,
    expectContains: ["{{nonce}}"],
    sideEffect: "acceptance_fixture",
    leaseTools: plan.leaseTools,
    featureAssertions: [
      {
        kind: "trace",
        type: "tool_result",
        where: { name: "owner_memory_admin", isError: false },
        count: 1,
      },
    ],
  };
}

function cleanupProofFromEvidence({ runtime, transportCase, productAcceptance, trace, db, plan }) {
  const verifiedCase =
    productAcceptance.cases?.length === 1 ? productAcceptance.cases[0] : undefined;
  const runId = verifiedCase?.runId;
  const runActor = ID.test(runId ?? "")
    ? db.prepare("SELECT principal_id FROM runs WHERE id=?").get(runId)
    : undefined;
  const principalId = runActor?.principal_id;
  if (
    productAcceptance.status !== "PASS" ||
    verifiedCase?.traceVerified !== true ||
    verifiedCase?.cleanupVerified !== true ||
    transportCase.status !== "PASS" ||
    transportCase.code !== "REAL_REPLY_RECEIVED" ||
    transportCase.sendAttempted !== true ||
    transportCase.inputObserved !== true ||
    transportCase.leaseRevoked !== true ||
    transportCase.anomalies?.length !== 0 ||
    !ID.test(runId ?? "") ||
    principalId !== plan.principalId
  )
    safeFailure(
      "CLEANUP_PRODUCT_EVIDENCE",
      "Owner 私聊 Run、许可、Trace 或实际 QQ 收发证据不完整。",
    );
  const toolCalls = trace.events.filter(
    (row) =>
      row.event?.runId === runId &&
      row.event?.type === "tool_call" &&
      row.event?.data?.name === "owner_memory_admin",
  );
  const toolResults = trace.events.filter(
    (row) =>
      row.event?.runId === runId &&
      row.event?.type === "tool_result" &&
      row.event?.data?.name === "owner_memory_admin",
  );
  if (
    toolCalls.length !== 1 ||
    toolResults.length !== 1 ||
    toolResults[0].event.data?.isError !== false
  )
    safeFailure("CLEANUP_TOOL_EVIDENCE", "固定治理工具调用和结果 Trace 不唯一。");
  const callRow = toolCalls[0];
  const resultRow = toolResults[0];
  const call = callRow.event;
  const result = resultRow.event;
  const expectedInput = { action: "reject", candidateIds: plan.candidateIds };
  if (canonical(call.data?.input) !== canonical(expectedInput))
    safeFailure("CLEANUP_TOOL_INPUT", "固定治理工具输入与已审批候选清单不匹配。");
  const authorizationById = new Map();
  const readAuthorization = db.prepare(
    `SELECT id,action,resource_id,principal_id,decision,run_id
     FROM authorization_decisions_all
     WHERE id=? AND run_id=? AND principal_id=? AND decision='ALLOW'
       AND action='memory:govern' AND resource_id='owner-memory'`,
  );
  const message = db
    .prepare(
      "SELECT r.message_id,m.external_id FROM runs r JOIN messages m ON m.id=r.message_id WHERE r.id=? AND r.principal_id=?",
    )
    .get(runId, principalId);
  if (!message || String(message.external_id) !== String(transportCase.inputBinding?.botMessageId))
    safeFailure("CLEANUP_MESSAGE_BINDING", "清理输入消息没有绑定到唯一 Run。");
  const delivery = verifiedCase.delivery;
  const input = transportCase.inputBinding;
  const binding = {
    internalMessageId: message.message_id,
    externalMessageId: String(message.external_id),
    runId,
    principalId,
    textSha256: digest(transportCase.prompt),
  };
  const rejectionAudits = plan.candidateIds.map((candidateId) => {
    const rows = db
      .prepare(
        "SELECT * FROM memory_audit_events WHERE action='reject' AND target_id=? AND run_id=? AND principal_id=?",
      )
      .all(candidateId, runId, principalId);
    if (rows.length !== 1) safeFailure("CLEANUP_REJECTION_AUDIT", "候选拒绝审计缺失或不唯一。");
    const decisionId = rows[0].decision_id;
    if (!ID.test(decisionId ?? ""))
      safeFailure("CLEANUP_AUTHORIZATION", "拒绝审计没有治理决策绑定。");
    const decisionRows = readAuthorization.all(decisionId, runId, principalId);
    if (
      decisionRows.length !== 1 ||
      decisionRows[0].id !== decisionId ||
      decisionRows[0].run_id !== runId
    )
      safeFailure("CLEANUP_AUTHORIZATION", "候选拒绝审计没有对应的 Owner 治理授权。");
    authorizationById.set(decisionId, decisionRows[0]);
    return {
      id: rows[0].id,
      sequence: rows[0].sequence,
      action: rows[0].action,
      targetId: rows[0].target_id,
      runId: rows[0].run_id,
      principalId: rows[0].principal_id,
      decisionId,
      rowSha256: rawRowHash(rows[0]),
    };
  });
  const learningWrites = {
    runId,
    principalId,
    candidateWriteAuditCount: db
      .prepare(
        "SELECT COUNT(*) AS n FROM memory_audit_events WHERE run_id=? AND principal_id=? AND action='write'",
      )
      .get(runId, principalId).n,
    feedbackWriteCount: db
      .prepare("SELECT COUNT(*) AS n FROM feedback_events WHERE run_id=? AND principal_id=?")
      .get(runId, principalId).n,
    candidateSourceCount: db
      .prepare("SELECT COUNT(*) AS n FROM memory_candidates WHERE source_json LIKE ?")
      .get(`%${runId}%`).n,
  };
  return {
    runId,
    principalId,
    token: transportCase.token,
    runtime,
    run: {
      runId,
      principalId,
      internalMessageId: message.message_id,
      externalMessageId: String(message.external_id),
    },
    binding,
    lease: {
      runId,
      principalId,
      registered: transportCase.leaseRegistrationAttempted === true,
      revoked: transportCase.leaseRevoked === true,
      toolsSha256: transportCase.acceptanceLease?.toolsSha256,
    },
    authorization: {
      runId,
      principalId,
      decisionId: rejectionAudits[0].decisionId,
      decision: authorizationById.get(rejectionAudits[0].decisionId).decision,
      action: authorizationById.get(rejectionAudits[0].decisionId).action,
      resourceId: authorizationById.get(rejectionAudits[0].decisionId).resource_id,
    },
    delivery: {
      runId,
      principalId,
      decisionId: delivery.id,
      decision: "ALLOW",
      route: "private",
      recipientPrincipalId: principalId,
      externalMessageId: String(delivery.external_id),
      delivered: delivery.status === "sent",
    },
    toolCall: {
      runId,
      principalId,
      toolCallId: call.data.toolCallId,
      name: call.data.name,
      inputSha256: digest(canonical(expectedInput)),
      sequence: callRow.seq,
    },
    toolResult: {
      runId,
      principalId,
      toolCallId: result.data.toolCallId,
      name: result.data.name,
      isError: result.data.isError,
      sequence: resultRow.seq,
      results: plan.candidateIds.map((candidateId) => ({
        candidateId,
        status: "rejected",
      })),
      outputBytes: result.data.outputBytes,
      outputSha256: result.data.outputSha256,
    },
    rejectionAudits,
    learningWrites,
  };
}

/** Plan by default. Live execution sends one fixed Owner-private cleanup request at most once. */
export async function runAcceptanceMemoryCleanupCli(config, options, out, deps = {}) {
  if (!record(options) || options.case || options.scenarios || typeof options.input !== "string")
    fail("ARGUMENT", "清理命令必须提供 --input，且不接受自定义用例或场景。");
  const injected = (name, fallback) => deps[name] ?? fallback;
  const getInputs = injected("loadInputs", loadInputs);
  const currentRuntime = injected("runtimeInspectionSnapshot", runtimeInspectionSnapshot);
  const liveRuntime = injected("runtimeSnapshot", runtimeSnapshot);
  const loadInventory = injected("readCurrentInventory", readCurrentInventory);
  const verifyOrigin = injected("verifyOrigin", verifyAcceptanceMemoryCleanupOrigin);
  const stopCheck = injected("stopFingerprint", stopFingerprint);
  const loaded = await getInputs(config, options.input);
  const runtime = await currentRuntime(config.runtime);
  const originState = deps.verifyOrigin ? await verifyOrigin(config, loaded) : loaded.originState;
  const current = loadInventory(runtime, loaded.inventory, loaded.sourceAuditRows, config);
  const observed = current.inventory ? current : await current;
  const closedDatabases = new WeakSet();
  const closeDatabase = (database) => {
    if (database && !closedDatabases.has(database)) {
      closedDatabases.add(database);
      database.close();
    }
  };
  try {
    if (!inventoryMatches(loaded.inventory, observed.inventory))
      safeFailure("CLEANUP_INVENTORY_DRIFT", "独立数据库观察与固定候选清单不一致。");
    const planRecord = buildAcceptanceMemoryCleanupPlan({
      inventory: observed.inventory,
      inventorySha256: observed.inventorySha256,
      runtime,
      origin: loaded.origin,
    });
    const planResult = {
      status: "PLAN",
      cleanupOnly: true,
      featurePass: false,
      plan: planRecord.plan,
      sha256: planRecord.sha256,
      originVerified: true,
      sourceAuditCount: loaded.sourceAuditRows.length,
    };
    if (options.live !== true) {
      closeDatabase(observed.db);
      return planResult;
    }
    if (options["approve-suite"] !== planRecord.sha256)
      safeFailure("APPROVAL_REQUIRED", "实机清理必须审批当前完整计划哈希。");
    const { validateConfig } = await import("./core.mjs");
    validateConfig(config, { live: true });
    const stopPath = join(out, "STOP");
    const initialStop = await stopCheck(stopPath);
    const identity = await (deps.captureProcess ?? (async () => ({ pid: process.pid })))();
    const lockRoot = deps.lockRoot ?? join(homedir(), ".glassbox-qq-live-locks");
    await mkdir(lockRoot, { recursive: true, mode: 0o700 });
    const lockPath = join(lockRoot, `${digest(config.driver.qq).slice(0, 24)}.lock`);
    let lock;
    let clients;
    let recorder;
    const unsubscribeRecorder = [];
    let reportDir;
    let report;
    let caseResult;
    let retryReceipt;
    let sendReceipt;
    let sendReceiptPath;
    const controller = new AbortController();
    const abort = () => controller.abort();
    const checkStable = async () => {
      if (controller.signal.aborted)
        safeFailure("CLEANUP_CANCELLED", "固定清理已取消，停止标记保留。");
      if ((await stopCheck(stopPath)) !== initialStop) {
        controller.abort();
        safeFailure("CLEANUP_STOP_CHANGED", "清理期间停止标记发生变化，保持清理未完成状态。");
      }
      const next = await getInputs(config, options.input);
      if (
        next.manifestSha256 !== loaded.manifestSha256 ||
        next.inventoryFileSha256 !== loaded.inventoryFileSha256 ||
        next.report.sha256 !== loaded.report.sha256 ||
        next.guard.sha256 !== loaded.guard.sha256 ||
        next.sourceAuditSha256 !== loaded.sourceAuditSha256
      )
        safeFailure("CLEANUP_ORIGIN_CHANGED", "清理来源文件发生变化，未继续执行。");
      const now = await liveRuntime(config.runtime);
      if (canonical(now) !== canonical(runtime))
        safeFailure("CLEANUP_RUNTIME_CHANGED", "清理期间待测服务身份发生变化。");
      return next;
    };
    const externalSignal = options.signal;
    if (externalSignal?.aborted) controller.abort();
    externalSignal?.addEventListener("abort", abort, { once: true });
    process.on("SIGINT", abort);
    process.on("SIGTERM", abort);
    let acceptance;
    let productAcceptance;
    let finalProof;
    try {
      await checkStable();
      lock = await (deps.acquireAccountLock ?? acquireAccountLock)(lockPath, identity);
      retryReceipt = await ensureNoUnresolvedCleanupSend(out, config, runtime, options.input, deps);
      await checkStable();
      const liveNow = await liveRuntime(config.runtime);
      if (canonical(liveNow) !== canonical(runtime))
        safeFailure("CLEANUP_RUNTIME_CHANGED", "实机清理前服务身份发生变化。");
      clients = deps.createClients
        ? await deps.createClients(config)
        : {
            driver: new OneBot(config, "driver"),
            bot: new OneBot(config, "bot"),
          };
      recorder = deps.createRecorder
        ? deps.createRecorder(config, clients)
        : new Recorder(config, [clients.driver.token, clients.bot.token]);
      for (const role of ["driver", "bot"]) {
        if (typeof clients[role]?.subscribe !== "function")
          safeFailure("CLEANUP_EVENT_OBSERVER", "OneBot 事件观察器接口不可用。");
        const unsubscribe = clients[role].subscribe((event) => recorder.ingest(role, event));
        if (typeof unsubscribe !== "function")
          safeFailure("CLEANUP_EVENT_OBSERVER", "OneBot 事件观察器接口不可用。");
        unsubscribeRecorder.push(unsubscribe);
      }
      await clients.driver.connect();
      await clients.bot.connect();
      await (deps.doctor ?? doctor)({ ...config, groups: [] }, clients);
      await checkStable();
      const attemptId = randomUUID().replaceAll("-", "");
      reportDir = join(out, `acceptance-memory-cleanup_${attemptId}`);
      await mkdir(reportDir, { recursive: false, mode: 0o700 });
      await chmod(reportDir, 0o700);
      report = {
        schemaVersion: 1,
        kind: "acceptance-memory-cleanup",
        status: "INCONCLUSIVE",
        cleanupOnly: true,
        featurePass: false,
        planSha256: planRecord.sha256,
        principalId: planRecord.plan.principalId,
        origin: loaded.origin,
        runtime,
        startedAt: new Date().toISOString(),
      };
      await writeNewJson(reportDir, "attempt.json", report);
      acceptance = await (deps.acceptanceManagement ?? acceptanceManagement)(config.runtime);
      acceptance.beforeRegister = async () => {
        await checkStable();
        return true;
      };
      acceptance.beforeSend = async (prepared, lease) => {
        if (lease.toolsSha256 !== planRecord.plan.toolsSha256)
          safeFailure("CLEANUP_LEASE", "服务端许可工具范围与固定计划不匹配。");
        await checkStable();
        if (retryReceipt) {
          const stillValid = await verifyAcceptanceMemoryNoIngressReceipt({
            receiptPath: retryReceipt.receiptPath,
            reportPath: retryReceipt.reportPath,
            reportDirectory: retryReceipt.directory,
            manifestPath: options.input,
            config,
            out,
            expectedRuntime: runtime,
            deps,
          });
          if (!stillValid)
            safeFailure("CLEANUP_PRIOR_ATTEMPT", "上一轮无入站回执已失效，禁止发送。");
          const receiptBytes = await readPrivateFile(retryReceipt.receiptPath, MAX_REPORT_BYTES);
          await writeNewJson(retryReceipt.directory, "retry-used.json", {
            schemaVersion: 1,
            kind: "acceptance-memory-no-ingress-retry-used",
            receiptSha256: receiptBytes.sha256,
            planSha256: planRecord.sha256,
            at: new Date().toISOString(),
          });
          retryReceipt = undefined;
        }
        await writeNewJson(reportDir, "send-intent.json", {
          schemaVersion: 1,
          kind: "acceptance-memory-cleanup-send-intent",
          status: "SEND_MAY_HAVE_STARTED",
          planSha256: planRecord.sha256,
          token: prepared.token,
          route: prepared.route,
          startedAt: prepared.startedAt,
          promptSha256: digest(prepared.prompt),
          leaseRegistrationAttempted: prepared.leaseRegistrationAttempted === true,
          acceptanceLease: structuredClone(lease),
        });
        return true;
      };
      acceptance.afterSend = async (sent) => {
        await checkStable();
        if (
          sent?.sendAttempted !== true ||
          !/^\d{1,20}$/.test(String(sent.sentMessageId ?? "")) ||
          sent.route !== "private" ||
          typeof sent.prompt !== "string" ||
          typeof sent.acceptanceLease?.leaseId !== "string" ||
          !sent.acceptanceLease.leaseId
        )
          safeFailure("CLEANUP_SEND_RECEIPT", "已发送消息缺少固定收据，停止继续核验。");
        const receipt = {
          schemaVersion: 1,
          kind: "acceptance-memory-cleanup-send-receipt",
          planSha256: planRecord.sha256,
          id: sent.id,
          sentMessageId: String(sent.sentMessageId),
          route: sent.route,
          sendAttempted: true,
          promptSha256: digest(sent.prompt),
          acceptanceLeaseId: sent.acceptanceLease?.leaseId,
          recordedAt: new Date().toISOString(),
        };
        sendReceipt = receipt;
        sendReceiptPath = await writeNewJson(reportDir, "send-receipt.json", receipt);
        await checkStable();
        return true;
      };
      const spec = makeFixedSpec(planRecord.plan);
      const sent = await (deps.replyCase ?? replyCase)(
        config,
        clients,
        recorder,
        spec,
        controller.signal,
        acceptance,
      );
      caseResult = sent;
      recorder.finalize();
      if (sent.status !== "PASS")
        safeFailure("CLEANUP_REPLY_UNCONFIRMED", "清理请求结果不确定，保留停止标记且不会重发。");
      await checkStable();
      const productReport = {
        mode: "run",
        status: "PASS",
        runtime,
        cases: [sent],
      };
      productAcceptance = await (deps.verifyProductEvidence ?? verifyProductEvidence)(
        productReport,
        config,
        clients,
      );
      if (productAcceptance.status !== "PASS" || productAcceptance.cases?.length !== 1)
        safeFailure("CLEANUP_PRODUCT_EVIDENCE", "清理 Run 缺少完整的产品证据。");
      const verifiedCase = productAcceptance.cases[0];
      const events = (deps.readTraceEvents ?? readTraceEvents)(
        runtime.checkout,
        runtime.dataDirectory,
        verifiedCase.runId,
        undefined,
        [],
      );
      if (events.runId !== verifiedCase.runId || !Array.isArray(events.events))
        safeFailure("CLEANUP_TRACE", "清理 Run Trace 与固定 Run 不匹配。");
      const proofDb = (
        deps.openReadOnlyDatabase ?? ((path) => new DatabaseSync(path, { readOnly: true }))
      )(join(runtime.dataDirectory, "glassbox.db"));
      let cleanup;
      let finalInventory;
      let finalInventorySha256;
      try {
        cleanup = cleanupProofFromEvidence({
          runtime,
          transportCase: sent,
          productAcceptance,
          trace: events,
          db: proofDb,
          plan: planRecord.plan,
        });
        const learning = cleanup.learningWrites;
        if (
          learning.candidateWriteAuditCount !== 0 ||
          learning.feedbackWriteCount !== 0 ||
          learning.candidateSourceCount !== 0
        )
          safeFailure("CLEANUP_NEW_LEARNING", "清理 Run 产生了新的候选或反馈写入。");
        const sourceAgain = await getInputs(config, options.input);
        const currentFinal = loadInventory(
          runtime,
          sourceAgain.inventory,
          sourceAgain.sourceAuditRows,
          config,
        );
        const finalCapture = currentFinal.inventory ? currentFinal : await currentFinal;
        try {
          finalInventory = finalCapture.inventory;
          finalInventorySha256 = finalCapture.inventorySha256;
        } finally {
          closeDatabase(finalCapture.db);
        }
      } finally {
        proofDb.close();
      }
      finalProof = verifyAcceptanceMemoryCleanup({
        plan: planRecord.plan,
        planSha256: planRecord.sha256,
        cleanup,
        finalInventory,
        finalInventorySha256,
      });
      await checkStable();
      const stableInputs = await getInputs(config, options.input);
      if (
        stableInputs.manifestSha256 !== loaded.manifestSha256 ||
        stableInputs.inventoryFileSha256 !== loaded.inventoryFileSha256 ||
        stableInputs.report.sha256 !== loaded.report.sha256 ||
        stableInputs.guard.sha256 !== loaded.guard.sha256 ||
        stableInputs.sourceAuditSha256 !== loaded.sourceAuditSha256
      )
        safeFailure("CLEANUP_ORIGIN_CHANGED", "清理来源文件发生变化，未继续执行。");
      const stableCaptureResult = loadInventory(
        runtime,
        stableInputs.inventory,
        stableInputs.sourceAuditRows,
        config,
      );
      const stableCapture = stableCaptureResult.inventory
        ? stableCaptureResult
        : await stableCaptureResult;
      try {
        if (
          !inventoryMatches(finalInventory, stableCapture.inventory) ||
          stableCapture.inventorySha256 !== finalInventorySha256
        )
          safeFailure("CLEANUP_FINAL_DRIFT", "清理验证后的候选状态再次读取时发生变化。");
      } finally {
        closeDatabase(stableCapture.db);
      }
      const runtimeAfter = await liveRuntime(config.runtime);
      if (canonical(runtimeAfter) !== canonical(runtime))
        safeFailure("CLEANUP_RUNTIME_CHANGED", "清理完成时待测服务身份发生变化。");
      await stopCheck(stopPath).then((fingerprint) => {
        if (fingerprint !== initialStop)
          safeFailure("CLEANUP_STOP_CHANGED", "原验收停止标记发生变化，保留人工核对状态。");
      });
      report.status = "CLEANUP_VERIFIED";
      report.cleanupProof = finalProof;
      report.cleanupEvidence = cleanup;
      report.transportEvidence = {
        id: sent.id,
        token: sent.token,
        route: sent.route,
        startedAt: sent.startedAt,
        status: sent.status,
        code: sent.code,
        sendAttempted: sent.sendAttempted === true,
        sentMessageId: String(sent.sentMessageId),
        sendReceiptSha256: digest(canonical(sendReceipt)),
        inputObserved: sent.inputObserved === true,
        leaseRegistrationAttempted: sent.leaseRegistrationAttempted === true,
        leaseRevoked: sent.leaseRevoked === true,
        anomalies: structuredClone(sent.anomalies ?? []),
        promptSha256: digest(sent.prompt),
        expectedSha256: digest(canonical(sent.expected)),
        acceptanceLease: structuredClone(sent.acceptanceLease),
        inputBinding: structuredClone(sent.inputBinding),
        replies: sent.replies.map(
          ({ route, messageId, textSha256, textBytes, matches, receivedAt }) => ({
            route,
            messageId,
            textSha256,
            textBytes,
            matches,
            receivedAt,
          }),
        ),
      };
      report.productEvidence = {
        runId: verifiedCase.runId,
        principalId: verifiedCase.principalId,
        traceVerified: verifiedCase.traceVerified === true,
        cleanupVerified: verifiedCase.cleanupVerified === true,
        inputBinding: structuredClone(verifiedCase.inputBinding),
        delivery: structuredClone(verifiedCase.delivery),
        messageBinding: structuredClone(verifiedCase.messageBinding),
      };
      report.finishedAt = new Date().toISOString();
      await writeNewJson(reportDir, "report.json", report);
      return {
        status: "CLEANUP_VERIFIED",
        cleanupOnly: true,
        featurePass: false,
        reportDirectory: reportDir,
        proof: finalProof,
      };
    } catch (error) {
      if (reportDir && report) {
        const sanitized = safeError(error);
        report.status = "INCONCLUSIVE";
        report.errorCode = sanitized.code;
        report.finishedAt = new Date().toISOString();
        if (caseResult) {
          report.case = {
            id: caseResult.id,
            status: caseResult.status,
            code: caseResult.code,
            sendAttempted: caseResult.sendAttempted === true,
            sentMessageId: /^\d{1,20}$/.test(String(caseResult.sentMessageId ?? ""))
              ? String(caseResult.sentMessageId)
              : undefined,
            sendReceiptPath: sendReceiptPath ? "send-receipt.json" : undefined,
            sendReceiptSha256: sendReceipt ? digest(canonical(sendReceipt)) : undefined,
            inputObserved: caseResult.inputObserved === true,
            leaseRegistrationAttempted: caseResult.leaseRegistrationAttempted === true,
            leaseRevoked: caseResult.leaseRevoked === true,
            anomalies: structuredClone(caseResult.anomalies ?? []),
            runId: productAcceptance?.cases?.[0]?.runId,
            token: caseResult.token,
            route: caseResult.route,
            startedAt: caseResult.startedAt,
            promptSha256:
              typeof caseResult.prompt === "string" ? digest(caseResult.prompt) : undefined,
            acceptanceLease: caseResult.acceptanceLease
              ? structuredClone(caseResult.acceptanceLease)
              : undefined,
            transportFailure: caseResult.transportFailure
              ? structuredClone(caseResult.transportFailure)
              : undefined,
          };
        }
        await writeNewJson(reportDir, "failure.json", report).catch(() => {});
      }
      throw error;
    } finally {
      externalSignal?.removeEventListener("abort", abort);
      process.removeListener("SIGINT", abort);
      process.removeListener("SIGTERM", abort);
      while (unsubscribeRecorder.length) {
        try {
          unsubscribeRecorder.pop()();
        } catch {
          /* Closing the clients still terminates their event source. */
        }
      }
      recorder?.finalize();
      clients?.driver.close();
      clients?.bot.close();
      if (lock) await (deps.releaseAccountLock ?? releaseAccountLock)(lockPath, lock);
      closeDatabase(observed.db);
    }
  } catch (error) {
    closeDatabase(observed.db);
    throw error;
  }
}
