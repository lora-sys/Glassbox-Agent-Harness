import { readFile, readdir, lstat } from "node:fs/promises";
import { dirname, join, relative, resolve, sep, isAbsolute } from "node:path";
import { digest, fail } from "./core.mjs";
import { readTasteJournalRecord } from "./taste-checkpoint.mjs";
import { TASTE_FAMILY_ID } from "./taste-scenario.mjs";

function invalid(code, message) {
  fail(code, message, "BLOCKED");
}
function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stable(value[key])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
function same(a, b) {
  return stable(a) === stable(b);
}
async function regularFile(path, maxBytes = 4 * 1024 * 1024) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > maxBytes)
    invalid("TASTE_FINALIZED_RECOVERY_FILE", "Taste finalized-run evidence file is unsafe.");
  const bytes = await readFile(path);
  const current = await lstat(path);
  if (info.dev !== current.dev || info.ino !== current.ino || info.size !== current.size)
    invalid("TASTE_FINALIZED_RECOVERY_FILE", "Taste finalized-run evidence changed while reading.");
  return { bytes, info };
}
async function fingerprint(path) {
  try {
    const { bytes, info } = await regularFile(path, 16384);
    return {
      dev: info.dev,
      ino: info.ino,
      size: info.size,
      mtimeMs: info.mtimeMs,
      sha256: digest(bytes),
    };
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}
async function readLock(path) {
  const { bytes, info } = await regularFile(path, 2048);
  let value;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    invalid("RUN_LOCKED", "Taste account lock cannot be verified.");
  }
  if (
    !value ||
    !Number.isSafeInteger(value.pid) ||
    value.pid <= 0 ||
    typeof value.startedAt !== "string" ||
    !value.process ||
    value.process.pid !== value.pid
  )
    invalid("RUN_LOCKED", "Taste account lock lacks a verifiable process identity.");
  return {
    bytes: bytes.toString("utf8"),
    snapshot: { dev: info.dev, ino: info.ino, sha256: digest(bytes) },
    value,
  };
}
function sameLock(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.sha256 === right.sha256;
}
async function reportForCandidate(
  directory,
  outDirectory,
  runtime,
  scope,
  driverQQ,
  processIdentity,
) {
  const journalPath = join(directory, "taste-fixture.jsonl");
  const { bytes: journalBytes } = await regularFile(journalPath, 40 * 1024 * 1024);
  const firstLine = journalBytes.toString("utf8").split("\n", 1)[0];
  let first;
  try {
    first = JSON.parse(firstLine);
  } catch {
    return null;
  }
  if (!same(first?.origin?.process, processIdentity)) return null;
  const record = await readTasteJournalRecord({
    journalPath,
    outDirectory,
    runtime,
    scope,
    driverQQ,
  });
  const tip = record.pending;
  if (
    !same(record.origin?.process, processIdentity) ||
    tip?.phase !== "observed" ||
    tip?.stage !== "retire" ||
    tip.steps?.length !== 4 ||
    tip.handles?.cleanupRunId !== tip.steps.at(-1)?.runId ||
    tip.handles?.stepRunId !== tip.handles?.cleanupRunId ||
    tip.steps.at(-1)?.observation?.lifecycleState !== "retired" ||
    tip.steps.at(-1)?.observation?.activeCount !== 0 ||
    tip.steps.at(-1)?.observation?.pendingCount !== 0
  )
    return null;
  const { bytes } = await regularFile(join(directory, "report.json"));
  let report;
  try {
    report = JSON.parse(bytes.toString("utf8"));
  } catch {
    invalid("TASTE_FINALIZED_RECOVERY_REPORT", "Taste finalized-run report is invalid JSON.");
  }
  if (
    report?.mode !== "run" ||
    report?.status !== "PASS" ||
    report?.runId !== tip.runId ||
    report?.reportDirectory !== directory ||
    report?.startedAt !== record.origin.startedAt ||
    report?.suiteSha256 !== record.origin.suiteSha256 ||
    !same(report.runtime, runtime) ||
    !same(record.origin.runtime, runtime) ||
    !same(report.tasteFamily, { familyId: TASTE_FAMILY_ID }) ||
    report.productAcceptance?.status !== "PASS" ||
    report.tasteLifecycle?.status !== "PASS" ||
    report.tasteLifecycle?.requiresReconciliation !== false ||
    report.tasteFamilyAcceptance?.status !== "PASS" ||
    report.tasteFamilyAcceptance?.familyId !== TASTE_FAMILY_ID
  )
    invalid(
      "TASTE_FINALIZED_RECOVERY_REPORT",
      "Taste finalized-run report does not match its journal.",
    );
  return { report, record };
}

/**
 * Replace a stale account lock only after independently revalidating the completed Taste family.
 * `verifyFinalized` must perform fresh product, database, and runtime reads. `replaceLock` must
 * compare the returned old-lock fingerprint while atomically taking over the account lock.
 */
export async function recoverFinalizedTasteLock({
  pendingPath,
  lockPath,
  outDirectory,
  runtime,
  scope,
  driverQQ,
  stopPath,
  verifyStopped,
  verifyFinalized,
  replaceLock,
  readPending = lstat,
  readEntries = readdir,
}) {
  if (![verifyStopped, verifyFinalized, replaceLock].every((fn) => typeof fn === "function"))
    invalid(
      "TASTE_FINALIZED_RECOVERY_INPUT",
      "Taste finalized recovery requires strict verifiers.",
    );
  try {
    await readPending(pendingPath);
    invalid("TASTE_CHECKPOINT_PENDING", "Taste pending checkpoint still exists.");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const out = resolve(outDirectory);
  const lock = await readLock(lockPath);
  const stopBefore = await fingerprint(stopPath);
  await verifyStopped(lock.value.process);
  const entries = await readEntries(out, { withFileTypes: true });
  const candidates = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const directory = resolve(out, entry.name);
    const rel = relative(out, directory);
    if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) continue;
    try {
      const candidate = await reportForCandidate(
        directory,
        out,
        runtime,
        scope,
        driverQQ,
        lock.value.process,
      );
      if (candidate) candidates.push(candidate);
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
  }
  if (candidates.length !== 1)
    invalid(
      "TASTE_FINALIZED_RECOVERY_NOT_PROVEN",
      "No unique completed Taste run matches the stale lock.",
    );
  const { report, record } = candidates[0];
  const fresh = await verifyFinalized(report, record);
  if (
    fresh?.status !== "PASS" ||
    fresh?.familyId !== TASTE_FAMILY_ID ||
    !same(fresh, report.tasteFamilyAcceptance)
  )
    invalid(
      "TASTE_FINALIZED_RECOVERY_NOT_PROVEN",
      "Fresh Taste family verification did not match its report.",
    );
  await verifyStopped(lock.value.process);
  if (!same(await fingerprint(stopPath), stopBefore))
    invalid("TASTE_FINALIZED_RECOVERY_STOP_CHANGED", "STOP changed during Taste lock recovery.");
  const currentLock = await readLock(lockPath);
  if (!sameLock(lock.snapshot, currentLock.snapshot) || lock.bytes !== currentLock.bytes)
    invalid("RUN_LOCKED", "Taste account lock changed during finalized-run verification.");
  const handle = await replaceLock(lock.snapshot, async () => {
    await verifyStopped(lock.value.process);
    if (!same(await fingerprint(stopPath), stopBefore))
      invalid(
        "TASTE_FINALIZED_RECOVERY_STOP_CHANGED",
        "STOP changed before Taste lock replacement.",
      );
  });
  return {
    handle,
    runId: report.runId,
    reportDirectory: report.reportDirectory,
    stopUnchanged: true,
  };
}
