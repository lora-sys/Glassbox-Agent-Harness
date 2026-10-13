import { open, readFile, lstat, realpath, chmod } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { digest, fail } from "./core.mjs";
import { runtimeInspectionSnapshot } from "./product-evidence.mjs";

const MAX_REPORT = 128 * 1024;
const MAX_INVENTORY = 64 * 1024;
const MAX_AUDIT = 32 * 1024 * 1024;
const MAX_STOP = 16 * 1024;
const HASH = /^[a-f0-9]{64}$/u;
const MARKER = /^[a-f0-9]{32}$/u;
const LEASE_ID = /^[a-f0-9-]{36}$/iu;
const ID = /^[A-Za-z0-9_-]{1,128}$/u;
const AUDIT_NAME = "qq-live-acceptance-audit.jsonl";

function blocked(code = "CLEANUP_NO_INGRESS_EVIDENCE") {
  fail(code, "上次固定清理尝试的无入站证据无法核实，禁止重发。", "INCONCLUSIVE");
}
function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function exact(value, keys) {
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
  if (result === undefined || (typeof value === "number" && !Number.isFinite(value))) blocked();
  return result;
}
function same(a, b) {
  return canonical(a) === canonical(b);
}
function sha(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
function time(value) {
  if (typeof value !== "string") return null;
  const result = Date.parse(value);
  return Number.isFinite(result) && new Date(result).toISOString() === value ? result : null;
}
async function readPrivate(path, limit) {
  if (typeof path !== "string" || !path.startsWith("/") || resolve(path) !== path)
    blocked("CLEANUP_NO_INGRESS_PATH");
  let before;
  try {
    before = await lstat(path);
  } catch {
    blocked("CLEANUP_NO_INGRESS_READ");
  }
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.size > limit ||
    (before.mode & 0o077) !== 0 ||
    (typeof process.getuid === "function" && before.uid !== process.getuid())
  )
    blocked("CLEANUP_NO_INGRESS_FILE");
  let bytes;
  try {
    if ((await realpath(path)) !== path) blocked("CLEANUP_NO_INGRESS_PATH");
    bytes = await readFile(path);
  } catch {
    blocked("CLEANUP_NO_INGRESS_READ");
  }
  const after = await lstat(path);
  if (
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.size !== after.size ||
    before.mtimeMs !== after.mtimeMs ||
    bytes.length !== before.size
  )
    blocked("CLEANUP_NO_INGRESS_CHANGED");
  return { bytes, sha256: sha(bytes) };
}
function parse(bytes) {
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    blocked("CLEANUP_NO_INGRESS_JSON");
  }
}
function readAudit(bytes) {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (!text.endsWith("\n")) blocked("CLEANUP_NO_INGRESS_AUDIT");
  const lines = text.slice(0, -1).split("\n");
  if (lines.length > 50000) blocked("CLEANUP_NO_INGRESS_AUDIT");
  return lines.map((line) => {
    if (!line || Buffer.byteLength(line, "utf8") > 32768) blocked("CLEANUP_NO_INGRESS_AUDIT");
    const row = parse(Buffer.from(line));
    if (!record(row) || JSON.stringify(row) !== line) blocked("CLEANUP_NO_INGRESS_AUDIT");
    return row;
  });
}
function scopeHash(config) {
  const runtime = config.runtime;
  const values = [
    runtime.connectionId,
    config.bot.qq,
    "private",
    config.driver.qq,
    config.driver.qq,
    runtime.threadId ?? null,
  ];
  if (values.slice(0, 5).some((value) => typeof value !== "string" || !value))
    blocked("CLEANUP_NO_INGRESS_SCOPE");
  return digest(JSON.stringify(values));
}
function safeReport(report) {
  const keys = [
    "schemaVersion",
    "kind",
    "status",
    "cleanupOnly",
    "featurePass",
    "planSha256",
    "origin",
    "runtime",
    "startedAt",
    "errorCode",
    "finishedAt",
    "case",
    "principalId",
  ];
  if (!record(report) || Object.keys(report).some((key) => !keys.includes(key)))
    blocked("CLEANUP_NO_INGRESS_REPORT");
  const c = report.case;
  const caseKeys = [
    "id",
    "status",
    "code",
    "sendAttempted",
    "inputObserved",
    "leaseRevoked",
    "leaseRegistrationAttempted",
    "anomalies",
    "runId",
    "token",
    "route",
    "startedAt",
    "promptSha256",
    "acceptanceLease",
    "transportFailure",
  ];
  if (!record(c) || Object.keys(c).some((key) => !caseKeys.includes(key)))
    blocked("CLEANUP_NO_INGRESS_REPORT");
  if (
    report.schemaVersion !== 1 ||
    report.kind !== "acceptance-memory-cleanup" ||
    report.status !== "INCONCLUSIVE" ||
    report.cleanupOnly !== true ||
    report.featurePass !== false ||
    report.errorCode !== "CLEANUP_REPLY_UNCONFIRMED" ||
    !HASH.test(report.planSha256 ?? "") ||
    !record(report.origin) ||
    !HASH.test(report.origin.reportSha256 ?? "") ||
    !HASH.test(report.origin.guardSha256 ?? "") ||
    !HASH.test(report.origin.sourceAuditSha256 ?? "") ||
    time(report.startedAt) === null ||
    time(report.finishedAt) === null ||
    time(report.finishedAt) < time(report.startedAt) ||
    c.id !== "acceptance-memory-cleanup" ||
    c.status !== "BLOCKED" ||
    c.code !== "API_REJECTED" ||
    c.sendAttempted !== true ||
    c.inputObserved !== false ||
    c.leaseRevoked !== true ||
    c.runId !== undefined ||
    (c.route !== undefined && c.route !== "private") ||
    (c.leaseRegistrationAttempted !== undefined && c.leaseRegistrationAttempted !== true) ||
    (c.anomalies !== undefined && (!Array.isArray(c.anomalies) || c.anomalies.length !== 0)) ||
    (c.token !== undefined && !MARKER.test(c.token)) ||
    (c.promptSha256 !== undefined && !HASH.test(c.promptSha256)) ||
    (report.principalId !== undefined && !ID.test(report.principalId))
  )
    blocked("CLEANUP_NO_INGRESS_REPORT");
  if (c.transportFailure !== undefined) {
    const failure = c.transportFailure;
    if (
      !(
        exact(failure, ["retcode"]) &&
        Number.isSafeInteger(failure.retcode) &&
        failure.retcode >= 0 &&
        failure.retcode <= 2147483647
      ) &&
      !(
        exact(failure, ["retcode", "classification", "providerResult"]) &&
        failure.retcode === 1200 &&
        failure.classification === "ACCOUNT_REAUTH_REQUIRED" &&
        failure.providerResult === -10003
      )
    )
      blocked("CLEANUP_NO_INGRESS_REPORT");
  }
  if (
    c.acceptanceLease !== undefined &&
    (!exact(c.acceptanceLease, ["leaseId", "expiresAt", "toolsSha256"]) ||
      !LEASE_ID.test(c.acceptanceLease.leaseId ?? "") ||
      !Number.isSafeInteger(c.acceptanceLease.expiresAt) ||
      !HASH.test(c.acceptanceLease.toolsSha256 ?? ""))
  )
    blocked("CLEANUP_NO_INGRESS_REPORT");
  return c;
}
function verifySendIntent(intent, report, c, marker, registration) {
  if (intent === undefined) return; // Original report versions did not persist this checkpoint.
  if (
    !exact(intent, [
      "schemaVersion",
      "kind",
      "status",
      "planSha256",
      "token",
      "route",
      "startedAt",
      "promptSha256",
      "leaseRegistrationAttempted",
      "acceptanceLease",
    ]) ||
    intent.schemaVersion !== 1 ||
    intent.kind !== "acceptance-memory-cleanup-send-intent" ||
    intent.status !== "SEND_MAY_HAVE_STARTED" ||
    intent.planSha256 !== report.planSha256 ||
    intent.token !== marker ||
    intent.route !== "private" ||
    intent.leaseRegistrationAttempted !== true ||
    (c.token !== undefined && intent.token !== c.token) ||
    (c.startedAt !== undefined && intent.startedAt !== c.startedAt) ||
    (c.promptSha256 !== undefined && intent.promptSha256 !== c.promptSha256) ||
    !exact(intent.acceptanceLease, ["leaseId", "expiresAt", "toolsSha256"]) ||
    intent.acceptanceLease.leaseId !== registration.leaseId ||
    intent.acceptanceLease.expiresAt !== registration.expiresAt ||
    intent.acceptanceLease.toolsSha256 !== registration.toolsSha256
  )
    blocked("CLEANUP_NO_INGRESS_INTENT");
}
function findLease(rows, report, c, plan, config) {
  const start = time(report.startedAt);
  const finish = time(report.finishedAt);
  const principalId = plan.plan.principalId;
  const expectedScope = scopeHash(config);
  const possible = rows.filter((row) => {
    const at = time(row.at);
    return (
      row.event === "lease_registered" &&
      exact(row, [
        "at",
        "event",
        "expiresAt",
        "leaseId",
        "marker",
        "principalId",
        "scopeSha256",
        "toolsSha256",
      ]) &&
      LEASE_ID.test(row.leaseId ?? "") &&
      MARKER.test(row.marker ?? "") &&
      row.principalId === principalId &&
      row.scopeSha256 === expectedScope &&
      row.toolsSha256 === plan.plan.toolsSha256 &&
      Number.isSafeInteger(row.expiresAt) &&
      at !== null &&
      at >= start - 2000 &&
      at <= finish + 5000 &&
      (c.token === undefined || row.marker === c.token) &&
      (c.acceptanceLease === undefined || row.leaseId === c.acceptanceLease.leaseId)
    );
  });
  if (possible.length !== 1) blocked("CLEANUP_NO_INGRESS_LEASE");
  const registration = possible[0];
  const related = rows.filter(
    (row) => row.leaseId === registration.leaseId || row.marker === registration.marker,
  );
  const revocations = related.filter((row) => row.event === "lease_revoked");
  const bindings = related.filter((row) => row.event === "run_bound");
  const otherEvents = related.filter(
    (row) => !["lease_registered", "lease_revoked", "run_bound"].includes(row.event),
  );
  if (
    related.filter((row) => row.event === "lease_registered").length !== 1 ||
    revocations.length > 1 ||
    bindings.length !== 0 ||
    otherEvents.length !== 0 ||
    registration.expiresAt <= time(registration.at)
  )
    blocked("CLEANUP_NO_INGRESS_LEASE");
  let revocation;
  if (revocations.length === 1) {
    revocation = revocations[0];
    const revokeAt = time(revocation.at);
    const full = exact(revocation, [
      "at",
      "event",
      "leaseId",
      "marker",
      "principalId",
      "scopeSha256",
    ]);
    const legacy = exact(revocation, ["at", "event", "leaseId", "principalId"]);
    if (
      (!full && !legacy) ||
      revocation.leaseId !== registration.leaseId ||
      revocation.principalId !== principalId ||
      (revocation.marker !== undefined && revocation.marker !== registration.marker) ||
      (revocation.scopeSha256 !== undefined && revocation.scopeSha256 !== expectedScope) ||
      revokeAt === null ||
      revokeAt < time(registration.at) ||
      revokeAt > finish + 5000
    )
      blocked("CLEANUP_NO_INGRESS_LEASE");
  } else if (registration.expiresAt > Date.now()) {
    blocked("CLEANUP_NO_INGRESS_LEASE");
  }
  const prompt = `GLASSBOX_ACCEPTANCE_V1 ${registration.marker}\n${plan.plan.prompt.replaceAll("{{nonce}}", registration.marker).trim()}`;
  const promptSha256 = digest(prompt.replace(/\r\n?/gu, "\n"));
  if (c.promptSha256 !== undefined && c.promptSha256 !== promptSha256)
    blocked("CLEANUP_NO_INGRESS_INTENT");
  return {
    marker: registration.marker,
    promptSha256,
    principalId,
    leaseId: registration.leaseId,
    expiresAt: registration.expiresAt,
    toolsSha256: registration.toolsSha256,
    scopeSha256: registration.scopeSha256,
    registeredAt: registration.at,
    revokedAt: revocation?.at ?? null,
    expired: revocation === undefined,
  };
}
function verifyAuditTail(receipt, auditFile) {
  const prefixBytes = receipt.sourceAuditPrefixBytes;
  if (
    !Number.isSafeInteger(prefixBytes) ||
    prefixBytes <= 0 ||
    prefixBytes > auditFile.bytes.length
  )
    return false;
  const prefix = auditFile.bytes.subarray(0, prefixBytes);
  if (prefix[prefix.length - 1] !== 10 || sha(prefix) !== receipt.sourceAuditSha256) return false;
  const tail = auditFile.bytes.subarray(prefixBytes);
  if (!tail.length) return true;
  let rows;
  try {
    rows = readAudit(tail);
  } catch {
    return false;
  }
  for (const row of rows) {
    const registered =
      exact(row, [
        "at",
        "event",
        "expiresAt",
        "leaseId",
        "marker",
        "principalId",
        "scopeSha256",
        "toolsSha256",
      ]) && row.event === "lease_registered";
    const revoked =
      (exact(row, ["at", "event", "leaseId", "marker", "principalId", "scopeSha256"]) ||
        exact(row, ["at", "event", "leaseId", "principalId"])) &&
      row.event === "lease_revoked";
    const bound =
      exact(row, [
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
      ]) && row.event === "run_bound";
    if (
      (!registered && !revoked && !bound) ||
      row.leaseId === receipt.lease.leaseId ||
      row.marker === receipt.marker
    )
      return false;
  }
  return true;
}
function verifyNoMessage(db, marker) {
  const message = db
    .prepare("SELECT COUNT(*) AS n FROM messages WHERE instr(text, ?) > 0")
    .get(marker)?.n;
  const run = db
    .prepare(
      "SELECT COUNT(*) AS n FROM runs r JOIN messages m ON m.id=r.message_id WHERE instr(m.text, ?) > 0",
    )
    .get(marker)?.n;
  if (message !== 0 || run !== 0) blocked("CLEANUP_NO_INGRESS_MESSAGE");
  return { matchingMessageCount: 0, matchingRunCount: 0 };
}
async function loadPlan({ config, manifestPath, report, runtime, deps }) {
  const loadInputs =
    deps.loadInputs ??
    (await import("./acceptance-memory-cleanup-cli.mjs")).loadAcceptanceMemoryCleanupInputs;
  const readInventory =
    deps.readCurrentInventory ??
    (await import("./acceptance-memory-cleanup-cli.mjs")).readCurrentInventory;
  const planBuilder =
    deps.buildPlan ??
    (await import("./acceptance-memory-cleanup-plan.mjs")).buildAcceptanceMemoryCleanupPlan;
  const loaded = await loadInputs(config, manifestPath);
  if (!same(report.origin, loaded.origin) || !same(report.runtime, runtime))
    blocked("CLEANUP_NO_INGRESS_ORIGIN");
  const observedValue = await readInventory(
    runtime,
    loaded.inventory,
    loaded.sourceAuditRows,
    config,
  );
  const observed = observedValue.inventory ? observedValue : await observedValue;
  try {
    if (!same(observed.inventory, loaded.inventory)) blocked("CLEANUP_NO_INGRESS_EFFECTS");
    const planRecord = planBuilder({
      inventory: observed.inventory,
      inventorySha256: observed.inventorySha256,
      runtime,
      origin: loaded.origin,
    });
    if (planRecord.sha256 !== report.planSha256) blocked("CLEANUP_NO_INGRESS_PLAN");
    return { loaded, observed, planRecord };
  } catch (error) {
    observed.db?.close();
    throw error;
  }
}
async function readOptionalPrivate(path, limit) {
  try {
    await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    blocked("CLEANUP_NO_INGRESS_READ");
  }
  return readPrivate(path, limit);
}
async function inspect({
  reportPath,
  reportDirectory,
  manifestPath,
  config,
  out,
  runtime,
  expectedRuntime,
  openDb,
  deps = {},
}) {
  const failureFile = await readPrivate(reportPath, MAX_REPORT);
  const intentPath = join(reportDirectory, "send-intent.json");
  const intentFile = await readOptionalPrivate(intentPath, 16 * 1024);
  const report = parse(failureFile.bytes);
  const c = safeReport(report);
  const readRuntime =
    typeof runtime === "function"
      ? runtime
      : (deps.runtimeInspectionSnapshot ?? deps.runtimeSnapshot ?? runtimeInspectionSnapshot);
  const currentRuntime = await readRuntime(config.runtime);
  if (expectedRuntime !== undefined && !same(expectedRuntime, currentRuntime))
    blocked("CLEANUP_NO_INGRESS_RUNTIME");
  const { loaded, observed, planRecord } = await loadPlan({
    config,
    manifestPath,
    report,
    runtime: currentRuntime,
    deps,
  });
  let db;
  try {
    const intent = intentFile ? parse(intentFile.bytes) : undefined;
    const auditPath = join(currentRuntime.dataDirectory, AUDIT_NAME);
    const auditFile = await readPrivate(auditPath, MAX_AUDIT);
    const lease = findLease(readAudit(auditFile.bytes), report, c, planRecord, config);
    if (intentFile)
      verifySendIntent(intent, report, c, lease.marker, {
        leaseId: lease.leaseId,
        expiresAt: lease.expiresAt,
        toolsSha256: lease.toolsSha256,
      });
    const stopPath = join(out, "STOP");
    const stopFile = await readPrivate(stopPath, MAX_STOP);
    db =
      observed.db ??
      (await (openDb ?? ((path) => new DatabaseSync(path, { readOnly: true })))(
        join(currentRuntime.dataDirectory, "glassbox.db"),
      ));
    const ingress = verifyNoMessage(db, lease.marker);
    return {
      failureFile,
      intentFile,
      intent,
      report,
      runtime: currentRuntime,
      loaded,
      planRecord,
      stopFile,
      auditFile,
      lease,
      ingress,
      reportPath,
      intentPath,
      reportDirectory,
      manifestPath,
      out,
    };
  } finally {
    db?.close();
  }
}
export async function createAcceptanceMemoryNoIngressReceipt({
  reportPath,
  reportDirectory,
  manifestPath,
  config,
  out,
  runtime,
  expectedRuntime,
  openDb,
  deps = {},
  writeReceipt = true,
}) {
  const evidence = await inspect({
    reportPath,
    reportDirectory,
    manifestPath,
    config,
    out,
    runtime,
    expectedRuntime,
    openDb,
    deps,
  });
  const receipt = {
    schemaVersion: 1,
    kind: "acceptance-memory-no-ingress",
    status: "NO_INGRESS_VERIFIED",
    cleanupOnly: true,
    featurePass: false,
    reportPath,
    reportSha256: evidence.failureFile.sha256,
    intentPath: evidence.intentFile ? evidence.intentPath : null,
    intentSha256: evidence.intentFile?.sha256 ?? null,
    manifestPath,
    manifestSha256: evidence.loaded.manifestSha256,
    inventorySha256: evidence.loaded.inventoryFileSha256,
    sourceAuditSnapshotSha256: evidence.loaded.sourceAuditSha256,
    planSha256: evidence.report.planSha256,
    origin: evidence.report.origin,
    runtime: evidence.runtime,
    stopPath: join(out, "STOP"),
    stopSha256: evidence.stopFile.sha256,
    sourceAuditPath: join(evidence.runtime.dataDirectory, AUDIT_NAME),
    sourceAuditSha256: evidence.auditFile.sha256,
    sourceAuditPrefixBytes: evidence.auditFile.bytes.length,
    marker: evidence.lease.marker,
    promptSha256: evidence.lease.promptSha256,
    lease: evidence.lease,
    ingress: evidence.ingress,
    verifiedAt: new Date().toISOString(),
  };
  if (!writeReceipt) return receipt;
  const path = join(reportDirectory, "no-ingress-receipt.json");
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(JSON.stringify(receipt, null, 2) + "\n");
    await handle.sync();
  } catch {
    blocked("CLEANUP_NO_INGRESS_WRITE");
  } finally {
    await handle.close();
  }
  await chmod(path, 0o600);
  const directory = await open(reportDirectory, "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
  return { status: receipt.status, receiptPath: path, retryPermitted: true };
}
export async function verifyAcceptanceMemoryNoIngressReceipt({
  receiptPath,
  reportPath,
  reportDirectory,
  manifestPath,
  config,
  out,
  runtime,
  expectedRuntime,
  openDb,
  deps = {},
}) {
  try {
    const receiptFile = await readPrivate(receiptPath, MAX_REPORT);
    const receipt = parse(receiptFile.bytes);
    const evidence = await inspect({
      reportPath,
      reportDirectory,
      manifestPath,
      config,
      out,
      runtime,
      expectedRuntime,
      openDb,
      deps,
    });
    return (
      exact(receipt, [
        "schemaVersion",
        "kind",
        "status",
        "cleanupOnly",
        "featurePass",
        "reportPath",
        "reportSha256",
        "intentPath",
        "intentSha256",
        "manifestPath",
        "manifestSha256",
        "inventorySha256",
        "sourceAuditSnapshotSha256",
        "planSha256",
        "origin",
        "runtime",
        "stopPath",
        "stopSha256",
        "sourceAuditPath",
        "sourceAuditSha256",
        "sourceAuditPrefixBytes",
        "marker",
        "promptSha256",
        "lease",
        "ingress",
        "verifiedAt",
      ]) &&
      receipt.schemaVersion === 1 &&
      receipt.kind === "acceptance-memory-no-ingress" &&
      receipt.status === "NO_INGRESS_VERIFIED" &&
      receipt.cleanupOnly === true &&
      receipt.featurePass === false &&
      receipt.reportPath === reportPath &&
      receipt.reportSha256 === evidence.failureFile.sha256 &&
      receipt.intentPath === (evidence.intentFile ? evidence.intentPath : null) &&
      receipt.intentSha256 === (evidence.intentFile?.sha256 ?? null) &&
      receipt.manifestPath === manifestPath &&
      receipt.manifestSha256 === evidence.loaded.manifestSha256 &&
      receipt.inventorySha256 === evidence.loaded.inventoryFileSha256 &&
      receipt.sourceAuditSnapshotSha256 === evidence.loaded.sourceAuditSha256 &&
      receipt.planSha256 === evidence.report.planSha256 &&
      same(receipt.origin, evidence.report.origin) &&
      same(receipt.runtime, evidence.runtime) &&
      receipt.stopPath === join(out, "STOP") &&
      receipt.stopSha256 === evidence.stopFile.sha256 &&
      receipt.sourceAuditPath === join(evidence.runtime.dataDirectory, AUDIT_NAME) &&
      verifyAuditTail(receipt, evidence.auditFile) &&
      receipt.marker === evidence.lease.marker &&
      receipt.promptSha256 === evidence.lease.promptSha256 &&
      same(receipt.lease, evidence.lease) &&
      same(receipt.ingress, evidence.ingress) &&
      time(receipt.verifiedAt) !== null
    );
  } catch {
    return false;
  }
}
