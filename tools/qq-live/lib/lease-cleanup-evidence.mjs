import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { join } from "node:path";
import { LiveError } from "./core.mjs";

const AUDIT_NAME = "qq-live-acceptance-audit.jsonl";
const MAX_BYTES = 32 * 1024 * 1024;
const MAX_LINE_BYTES = 32 * 1024;
const MAX_MATCHING_ROWS = 200;
const HASH = /^[a-f0-9]{64}$/;
const LEASE_ID = /^[a-f0-9-]{36}$/i;
const MARKER = /^[a-f0-9]{32}$/;

function invalid() {
  throw new LiveError(
    "LEASE_CLEANUP_EVIDENCE",
    "QQ acceptance lease cleanup evidence is missing or inconsistent.",
    "INCONCLUSIVE",
  );
}

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function canonicalTime(value) {
  if (typeof value !== "string") return null;
  const millis = Date.parse(value);
  return Number.isFinite(millis) && new Date(millis).toISOString() === value ? millis : null;
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function expectedScopeHash(scope) {
  if (
    !isRecord(scope) ||
    ["connectionId", "botId", "chatType", "chatId", "senderId"].some(
      (key) => typeof scope[key] !== "string" || scope[key].length === 0,
    ) ||
    !["private", "group"].includes(scope.chatType) ||
    (scope.threadId !== undefined && scope.threadId !== null && typeof scope.threadId !== "string")
  )
    invalid();
  return sha256(
    JSON.stringify([
      scope.connectionId,
      scope.botId,
      scope.chatType,
      scope.chatId,
      scope.senderId,
      scope.threadId ?? null,
    ]),
  );
}

async function readAuditFile(dataDirectory) {
  if (typeof dataDirectory !== "string" || !dataDirectory) invalid();
  const path = join(dataDirectory, AUDIT_NAME);
  let handle;
  try {
    const before = await lstat(path);
    if (!before.isFile() || before.isSymbolicLink() || before.size > MAX_BYTES) invalid();
    const noFollow = constants.O_NOFOLLOW ?? 0;
    handle = await open(path, constants.O_RDONLY | noFollow);
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
      current.size !== opened.size ||
      opened.size > MAX_BYTES
    )
      invalid();
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (
      bytes.length > MAX_BYTES ||
      bytes.length !== opened.size ||
      after.size !== opened.size ||
      after.mtimeMs !== opened.mtimeMs
    )
      invalid();
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    invalid();
  } finally {
    await handle?.close().catch(() => {});
  }
}

function parseAudit(text, leaseId) {
  if (!text.length || !text.endsWith("\n")) invalid();
  const lines = text.slice(0, -1).split("\n");
  const matching = [];
  for (const line of lines) {
    if (!line || Buffer.byteLength(line, "utf8") > MAX_LINE_BYTES) invalid();
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      invalid();
    }
    if (!isRecord(row)) invalid();
    if (row.leaseId === leaseId) {
      matching.push(row);
      if (matching.length > MAX_MATCHING_ROWS) invalid();
    }
  }
  return matching;
}

/** Independently verify the persisted registration, Run binding and revocation audit rows. */
export async function verifyLeaseCleanupEvidence({
  dataDirectory,
  caseRecord,
  runId,
  scope,
  principalId,
}) {
  try {
    const lease = caseRecord?.acceptanceLease;
    const marker = caseRecord?.token;
    const startedAt = canonicalTime(caseRecord?.startedAt);
    const leaseId = lease?.leaseId;
    const toolsSha256 = lease?.toolsSha256;
    if (
      !isRecord(lease) ||
      typeof leaseId !== "string" ||
      !LEASE_ID.test(leaseId) ||
      typeof marker !== "string" ||
      !MARKER.test(marker) ||
      typeof toolsSha256 !== "string" ||
      !HASH.test(toolsSha256) ||
      !Number.isSafeInteger(lease.expiresAt) ||
      startedAt === null ||
      caseRecord?.leaseRevoked !== true ||
      typeof caseRecord?.prompt !== "string" ||
      typeof runId !== "string" ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(runId) ||
      typeof caseRecord?.inputBinding?.botMessageId !== "string" ||
      !/^-?\d{1,20}$/.test(caseRecord.inputBinding.botMessageId) ||
      typeof principalId !== "string" ||
      !principalId
    )
      invalid();

    const scopeSha256 = expectedScopeHash(scope);
    const rows = parseAudit(await readAuditFile(dataDirectory), leaseId);
    const registrations = rows.filter((row) => row.event === "lease_registered");
    const bindings = rows.filter((row) => row.event === "run_bound");
    const revocations = rows.filter((row) => row.event === "lease_revoked");
    if (registrations.length !== 1 || bindings.length !== 1 || revocations.length !== 1) invalid();

    const [registration] = registrations;
    const [binding] = bindings;
    const [revocation] = revocations;
    const registrationIndex = rows.indexOf(registration);
    const bindingIndex = rows.indexOf(binding);
    const revocationIndex = rows.indexOf(revocation);
    const registeredAt = canonicalTime(registration.at);
    const boundAt = canonicalTime(binding.at);
    const revokedAt = canonicalTime(revocation.at);
    const now = Date.now();
    const prompt = caseRecord.prompt;
    if (
      registeredAt === null ||
      boundAt === null ||
      revokedAt === null ||
      registeredAt > now ||
      boundAt > now ||
      revokedAt > now ||
      registeredAt < startedAt - 2_000 ||
      registeredAt >= lease.expiresAt ||
      boundAt > lease.expiresAt ||
      registeredAt > boundAt ||
      boundAt > revokedAt ||
      registrationIndex >= bindingIndex ||
      bindingIndex >= revocationIndex ||
      registration.principalId !== principalId ||
      registration.marker !== marker ||
      registration.expiresAt !== lease.expiresAt ||
      registration.toolsSha256 !== toolsSha256 ||
      registration.scopeSha256 !== scopeSha256 ||
      binding.principalId !== principalId ||
      binding.leaseId !== leaseId ||
      binding.marker !== marker ||
      binding.runId !== runId ||
      binding.messageId !== caseRecord.inputBinding.botMessageId ||
      binding.textSha256 !== sha256(prompt.replace(/\r\n?/gu, "\n")) ||
      binding.toolsSha256 !== toolsSha256 ||
      binding.scopeSha256 !== scopeSha256 ||
      revocation.principalId !== principalId ||
      (revocation.marker !== undefined && revocation.marker !== marker) ||
      (revocation.scopeSha256 !== undefined && revocation.scopeSha256 !== scopeSha256) ||
      (revocation.runId !== undefined && revocation.runId !== runId)
    )
      invalid();

    return { status: "PASS", leaseId, runId, revoked: true };
  } catch (error) {
    if (error instanceof LiveError && error.code === "LEASE_CLEANUP_EVIDENCE") throw error;
    invalid();
  }
}
