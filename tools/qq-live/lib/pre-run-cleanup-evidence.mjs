import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open as openFile, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fail, toolManifestDigest } from "./core.mjs";
import { openReadOnlyDatabase } from "./read-only-database.mjs";
import { resolveReadFeatureSpecs } from "./feature-specs.mjs";
import { isFixedPreRunReadCase } from "./pre-run-cleanup-cases.mjs";
import { boundMessage, compareSameMessage } from "./message-binding.mjs";

const AUDIT_NAME = "qq-live-acceptance-audit.jsonl";
const MAX_AUDIT_BYTES = 32 * 1024 * 1024;
const MAX_LINE_BYTES = 32 * 1024;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const MARKER = /^[a-f0-9]{32}$/u;
const HASH = /^[a-f0-9]{64}$/u;
const HERE = dirname(fileURLToPath(import.meta.url));

function invalid() {
  fail(
    "PRE_RUN_CLEANUP_EVIDENCE",
    "发送前失败用例的测试许可清理证据缺失或不一致。",
    "INCONCLUSIVE",
  );
}
function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
function canonicalTime(value) {
  if (typeof value !== "string") return null;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value
    ? milliseconds
    : null;
}
function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function exactKeys(value, keys) {
  return (
    record(value) &&
    JSON.stringify(Object.keys(value).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) ===
      JSON.stringify([...keys].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)))
  );
}
function canonical(value) {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (record(value))
    return (
      "{" +
      Object.keys(value)
        .sort()
        .map((key) => JSON.stringify(key) + ":" + canonical(value[key]))
        .join(",") +
      "}"
    );
  return JSON.stringify(value);
}
function expectedScope(config) {
  const runtime = config?.runtime;
  if (
    !runtime ||
    typeof runtime.connectionId !== "string" ||
    !runtime.connectionId ||
    typeof config?.bot?.qq !== "string" ||
    typeof config?.driver?.qq !== "string" ||
    (runtime.threadId !== undefined &&
      runtime.threadId !== null &&
      typeof runtime.threadId !== "string")
  )
    invalid();
  return {
    connectionId: runtime.connectionId,
    botId: config.bot.qq,
    chatType: "private",
    chatId: config.driver.qq,
    senderId: config.driver.qq,
    threadId: runtime.threadId ?? null,
  };
}
function scopeHash(scope) {
  return sha256(
    JSON.stringify([
      scope.connectionId,
      scope.botId,
      scope.chatType,
      scope.chatId,
      scope.senderId,
      scope.threadId,
    ]),
  );
}
async function loadFixedSpec(config, caseId) {
  if (!isFixedPreRunReadCase(caseId)) invalid();
  let parsed;
  try {
    parsed = JSON.parse(
      await readFile(join(HERE, "../examples/feature-read.example.json"), "utf8"),
    );
  } catch {
    invalid();
  }
  if (parsed?.schemaVersion !== 2 || !Array.isArray(parsed.cases)) invalid();
  const matches = parsed.cases.filter((item) => item?.id === caseId);
  if (matches.length !== 1 || matches[0].chat !== "private" || matches[0].sideEffect !== "none")
    invalid();
  try {
    return resolveReadFeatureSpecs({ schemaVersion: 2, cases: matches }, config)[0];
  } catch {
    invalid();
  }
}
function verifyFixedCase(caseRecord, spec) {
  const marker = caseRecord?.token;
  if (!MARKER.test(marker ?? "")) invalid();
  const prompt =
    "GLASSBOX_ACCEPTANCE_V1 " + marker + "\n" + spec.prompt.trim().replaceAll("{{nonce}}", marker);
  const expectedTools = JSON.parse(JSON.stringify(spec.leaseTools).replaceAll("{{nonce}}", marker));
  const expectedAssertions = JSON.parse(
    JSON.stringify(spec.featureAssertions).replaceAll("{{nonce}}", marker),
  );
  const lease = caseRecord?.acceptanceLease;
  if (
    caseRecord?.id !== spec.id ||
    caseRecord.route !== "private" ||
    caseRecord.status !== "BLOCKED" ||
    caseRecord.code !== "API_REJECTED" ||
    caseRecord.prompt !== prompt ||
    canonical(caseRecord.expected) !== canonical([marker]) ||
    caseRecord.sendAttempted !== true ||
    caseRecord.leaseRegistrationAttempted !== true ||
    caseRecord.leaseRevoked !== true ||
    caseRecord.inputObserved !== false ||
    Object.hasOwn(caseRecord, "sentMessageId") ||
    Object.hasOwn(caseRecord, "inputBinding") ||
    Object.hasOwn(caseRecord, "botInputMessageId") ||
    !Array.isArray(caseRecord.botInputMessageIds) ||
    caseRecord.botInputMessageIds.length !== 0 ||
    !Array.isArray(caseRecord.botInputCandidates) ||
    caseRecord.botInputCandidates.length !== 0 ||
    !Array.isArray(caseRecord.replies) ||
    caseRecord.replies.length !== 0 ||
    !Array.isArray(caseRecord.leasedToolNames) ||
    canonical(caseRecord.leasedToolNames) !== canonical(expectedTools.map((tool) => tool.name)) ||
    canonical(caseRecord.featureAssertions) !== canonical(expectedAssertions) ||
    (caseRecord.leaseTools !== undefined &&
      canonical(caseRecord.leaseTools) !== canonical(expectedTools)) ||
    !exactKeys(lease, ["leaseId", "expiresAt", "toolsSha256"]) ||
    !UUID.test(lease.leaseId ?? "") ||
    !Number.isSafeInteger(lease.expiresAt) ||
    !HASH.test(lease.toolsSha256 ?? "") ||
    lease.toolsSha256 !== toolManifestDigest(expectedTools)
  )
    invalid();
  const startedAt = canonicalTime(caseRecord.startedAt);
  const finishedAt = canonicalTime(caseRecord.finishedAt);
  if (startedAt === null || finishedAt === null || finishedAt < startedAt) invalid();
  return { marker, prompt, lease, startedAt, finishedAt };
}

function verifyFixedSentCase(caseRecord, spec) {
  const marker = caseRecord?.token;
  if (!MARKER.test(marker ?? "")) invalid();
  const prompt =
    "GLASSBOX_ACCEPTANCE_V1 " + marker + "\n" + spec.prompt.trim().replaceAll("{{nonce}}", marker);
  const expectedTools = JSON.parse(JSON.stringify(spec.leaseTools).replaceAll("{{nonce}}", marker));
  const expectedAssertions = JSON.parse(
    JSON.stringify(spec.featureAssertions).replaceAll("{{nonce}}", marker),
  );
  const lease = caseRecord?.acceptanceLease;
  if (
    caseRecord?.id !== "ops-status-read" ||
    caseRecord.id !== spec.id ||
    caseRecord.route !== "private" ||
    caseRecord.status !== "INCONCLUSIVE" ||
    caseRecord.code !== "INPUT_NOT_OBSERVED" ||
    caseRecord.prompt !== prompt ||
    canonical(caseRecord.expected) !== canonical([marker]) ||
    caseRecord.sendAttempted !== true ||
    caseRecord.leaseRegistrationAttempted !== true ||
    caseRecord.leaseRevoked !== true ||
    caseRecord.inputObserved !== false ||
    typeof caseRecord.sentMessageId !== "string" ||
    !/^\d{1,20}$/u.test(caseRecord.sentMessageId) ||
    (caseRecord.inputBinding !== undefined && caseRecord.inputBinding !== null) ||
    (caseRecord.runId !== undefined && caseRecord.runId !== null) ||
    !Array.isArray(caseRecord.botInputMessageIds) ||
    caseRecord.botInputMessageIds.length !== 0 ||
    !Array.isArray(caseRecord.botInputCandidates) ||
    caseRecord.botInputCandidates.length !== 0 ||
    !Array.isArray(caseRecord.replies) ||
    caseRecord.replies.length !== 0 ||
    !Array.isArray(caseRecord.leasedToolNames) ||
    canonical(caseRecord.leasedToolNames) !== canonical(expectedTools.map((tool) => tool.name)) ||
    canonical(caseRecord.featureAssertions) !== canonical(expectedAssertions) ||
    (caseRecord.leaseTools !== undefined &&
      canonical(caseRecord.leaseTools) !== canonical(expectedTools)) ||
    !exactKeys(lease, ["leaseId", "expiresAt", "toolsSha256"]) ||
    !UUID.test(lease.leaseId ?? "") ||
    !Number.isSafeInteger(lease.expiresAt) ||
    !HASH.test(lease.toolsSha256 ?? "") ||
    lease.toolsSha256 !== toolManifestDigest(expectedTools)
  )
    invalid();
  const startedAt = canonicalTime(caseRecord.startedAt);
  const finishedAt = canonicalTime(caseRecord.finishedAt);
  if (startedAt === null || finishedAt === null || finishedAt < startedAt) invalid();
  return { marker, prompt, lease, startedAt, finishedAt };
}
async function readAudit(dataDirectory) {
  if (typeof dataDirectory !== "string" || !dataDirectory) invalid();
  const path = join(dataDirectory, AUDIT_NAME);
  let handle;
  try {
    const before = await lstat(path);
    if (!before.isFile() || before.isSymbolicLink() || before.size > MAX_AUDIT_BYTES) invalid();
    handle = await openFile(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = await handle.stat();
    const current = await lstat(path);
    if (
      !opened.isFile() ||
      !current.isFile() ||
      current.isSymbolicLink() ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      current.dev !== before.dev ||
      current.ino !== before.ino ||
      opened.size !== before.size ||
      current.size !== before.size
    )
      invalid();
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (
      bytes.length !== opened.size ||
      after.size !== opened.size ||
      after.mtimeMs !== opened.mtimeMs ||
      bytes.length > MAX_AUDIT_BYTES
    )
      invalid();
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    invalid();
  } finally {
    await handle?.close().catch(() => {});
  }
}
function parseAudit(text) {
  if (!text || !text.endsWith("\n")) invalid();
  const rows = [];
  for (const line of text.slice(0, -1).split("\n")) {
    if (!line || Buffer.byteLength(line, "utf8") > MAX_LINE_BYTES) invalid();
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      invalid();
    }
    if (!record(row)) invalid();
    rows.push(row);
  }
  return rows;
}
function ownerPrincipalId(db, scope) {
  const identityKey = JSON.stringify([scope.connectionId, scope.botId, scope.senderId]);
  const rows = db
    .prepare(
      "SELECT p.id FROM channel_identities ci JOIN principals p ON p.id=ci.principal_id WHERE ci.identity_key=? AND p.kind='owner'",
    )
    .all(identityKey);
  if (rows.length !== 1 || typeof rows[0].id !== "string" || !rows[0].id) invalid();
  return rows[0].id;
}
function verifyAudit(data, rows, scope, principalId) {
  const { marker, lease, startedAt, finishedAt } = data;
  const leaseRows = rows.filter((row) => row.leaseId === lease.leaseId);
  const registrations = rows.filter(
    (row) => row.event === "lease_registered" && row.marker === marker,
  );
  const boundRows = rows.filter(
    (row) => row.event === "run_bound" && (row.leaseId === lease.leaseId || row.marker === marker),
  );
  if (
    registrations.length !== 1 ||
    registrations[0].leaseId !== lease.leaseId ||
    boundRows.length !== 0 ||
    leaseRows.length !== 2
  )
    invalid();
  const registration = registrations[0];
  const revocations = leaseRows.filter((row) => row.event === "lease_revoked");
  if (revocations.length !== 1) invalid();
  const revocation = revocations[0];
  const registrationAt = canonicalTime(registration.at);
  const revocationAt = canonicalTime(revocation.at);
  const expectedHash = scopeHash(scope);
  if (
    registrationAt === null ||
    revocationAt === null ||
    registrationAt < startedAt - 2_000 ||
    registrationAt > finishedAt ||
    revocationAt < registrationAt ||
    revocationAt > Date.now() + 2_000 ||
    registrationAt >= lease.expiresAt ||
    lease.expiresAt > registrationAt + 30 * 60 * 1000 ||
    rows.indexOf(registration) >= rows.indexOf(revocation) ||
    registration.principalId !== principalId ||
    registration.marker !== marker ||
    registration.expiresAt !== lease.expiresAt ||
    registration.toolsSha256 !== lease.toolsSha256 ||
    registration.scopeSha256 !== expectedHash ||
    revocation.principalId !== principalId ||
    (revocation.marker !== undefined && revocation.marker !== marker) ||
    (revocation.scopeSha256 !== undefined && revocation.scopeSha256 !== expectedHash)
  )
    invalid();
  const expectedTextHash = sha256(data.prompt.replace(/\r\n?/gu, "\n"));
  const promptRegistrationVerified =
    registration.textSha256 === undefined || registration.textSha256 === null
      ? false
      : registration.textSha256 === expectedTextHash;
  if (!promptRegistrationVerified && registration.textSha256 != null) invalid();
  return { promptRegistrationVerified, scopeSha256: expectedHash };
}

/** Verify lease cleanup for fixed pre-Run reads; sent no-ingress cases may separately prove QQ delivery. */
export async function verifyPreRunCleanupEvidence({ dataDirectory, caseRecord, config, clients }) {
  let db;
  try {
    if (
      !config?.runtime?.dataDirectory ||
      resolve(dataDirectory ?? "") !== resolve(config.runtime.dataDirectory)
    )
      invalid();
    const spec = await loadFixedSpec(config, caseRecord?.id);
    const sentNoIngress = caseRecord?.code === "INPUT_NOT_OBSERVED";
    const data = sentNoIngress
      ? verifyFixedSentCase(caseRecord, spec)
      : verifyFixedCase(caseRecord, spec);
    const scope = expectedScope(config);
    db = openReadOnlyDatabase(join(resolve(dataDirectory), "glassbox.db"));
    const principalId = ownerPrincipalId(db, scope);
    const auditRows = parseAudit(await readAudit(dataDirectory));
    const audit = verifyAudit(data, auditRows, scope, principalId);
    const markerPrefix = "GLASSBOX_ACCEPTANCE_V1 " + data.marker + "\n";
    const prefixBytes = Buffer.byteLength(markerPrefix, "utf8");
    const markedMessages = db
      .prepare("SELECT COUNT(*) AS count FROM messages WHERE substr(text,1,?)=?")
      .get(prefixBytes, markerPrefix).count;
    const markedRuns = db
      .prepare(
        "SELECT COUNT(*) AS count FROM runs r JOIN messages m ON m.id=r.message_id WHERE substr(m.text,1,?)=?",
      )
      .get(prefixBytes, markerPrefix).count;
    if (markedMessages !== 0 || markedRuns !== 0) invalid();
    let dualAccountDelivery;
    if (sentNoIngress) {
      if (!clients?.driver?.readOwnerBotPrivateHistory || !clients?.bot?.readBotOwnerPrivateHistory)
        invalid();
      const textSha256 = sha256(data.prompt);
      const textBytes = Buffer.byteLength(data.prompt, "utf8");
      const driverHistory = await clients.driver.readOwnerBotPrivateHistory();
      const botHistory = await clients.bot.readBotOwnerPrivateHistory();
      const findUnique = (history, accountIdentity, peerId, senderId) => {
        if (
          history?.accountIdentity !== accountIdentity ||
          history.peerId !== peerId ||
          !Array.isArray(history.messages)
        )
          invalid();
        const matches = history.messages.filter(
          (row) =>
            row.selfId === accountIdentity &&
            row.senderId === senderId &&
            row.messageType === "private" &&
            row.textSha256 === textSha256 &&
            row.textBytes === textBytes &&
            row.time >= Math.floor(data.startedAt / 1000) - 2 &&
            row.time <= Math.floor(data.finishedAt / 1000) + 120,
        );
        if (
          matches.length !== 1 ||
          !/^\d{1,20}$/u.test(matches[0].messageId ?? "") ||
          !/^\d{1,20}$/u.test(matches[0].realSequence ?? "")
        )
          invalid();
        return matches[0];
      };
      const driverRow = findUnique(
        driverHistory,
        config.driver.qq,
        config.bot.qq,
        config.driver.qq,
      );
      const botRow = findUnique(botHistory, config.bot.qq, config.driver.qq, config.driver.qq);
      if (
        driverRow.messageId !== caseRecord.sentMessageId ||
        driverRow.realSequence !== botRow.realSequence ||
        driverRow.time !== botRow.time ||
        driverRow.textSha256 !== botRow.textSha256
      )
        invalid();
      clients.driver.allowMessageRead(driverRow.messageId);
      clients.bot.allowMessageRead(botRow.messageId);
      const driverMessage = await boundMessage(clients.driver, driverRow.messageId, {
        selfId: config.driver.qq,
        senderId: config.driver.qq,
        messageType: "private",
        text: data.prompt,
        afterTime: caseRecord.startedAt,
      });
      const botMessage = await boundMessage(clients.bot, botRow.messageId, {
        selfId: config.bot.qq,
        senderId: config.driver.qq,
        messageType: "private",
        text: data.prompt,
        afterTime: caseRecord.startedAt,
      });
      const binding = compareSameMessage(botMessage, driverMessage);
      if (
        binding.realSequence !== driverRow.realSequence ||
        binding.time !== driverRow.time ||
        binding.textSha256 !== textSha256
      )
        invalid();
      dualAccountDelivery = {
        verified: true,
        ownerMessageId: driverRow.messageId,
        botMessageId: botRow.messageId,
        realSequence: binding.realSequence,
        time: binding.time,
        textSha256,
        textBytes,
      };
      const afterMessages = db
        .prepare("SELECT COUNT(*) AS count FROM messages WHERE substr(text,1,?)=?")
        .get(prefixBytes, markerPrefix).count;
      const afterRuns = db
        .prepare(
          "SELECT COUNT(*) AS count FROM runs r JOIN messages m ON m.id=r.message_id WHERE substr(m.text,1,?)=?",
        )
        .get(prefixBytes, markerPrefix).count;
      if (afterMessages !== 0 || afterRuns !== 0) invalid();
    }
    return {
      status: sentNoIngress ? "CLEANUP_RECONCILED" : "CLEANUP_VERIFIED",
      caseId: spec.id,
      leaseId: data.lease.leaseId,
      marker: data.marker,
      principalId,
      scopeSha256: audit.scopeSha256,
      toolsSha256: data.lease.toolsSha256,
      cleanupVerified: true,
      cleanupOnly: true,
      actualQqDeliveryVerified: sentNoIngress,
      productIngressVerified: false,
      productRunObserved: false,
      featureStatus: "INCONCLUSIVE",
      promptRegistrationVerified: audit.promptRegistrationVerified,
      promptRegistrationStatus: audit.promptRegistrationVerified ? "VERIFIED" : "NOT_RECORDED",
      zeroMarkedMessages: true,
      zeroMarkedRuns: true,
      ...(dualAccountDelivery ? { dualAccountDelivery } : {}),
    };
  } catch (error) {
    if (error?.code === "PRE_RUN_CLEANUP_EVIDENCE") throw error;
    invalid();
  } finally {
    db?.close();
  }
}
