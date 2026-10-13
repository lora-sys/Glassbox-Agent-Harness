import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, lstat, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { fail } from "./core.mjs";
import { writeMemoryCheckpoint } from "./memory-checkpoint.mjs";
import { MODERATION_FAMILY_ID } from "./moderation-scenario.mjs";

const HASH = /^[a-f0-9]{64}$/u;
const SEQUENCE = ["mute", "unmute"].flatMap((stage) =>
  ["intent", "lease_intent", "prepared", "sent", "observed"].map((phase) => [stage, phase]),
);
const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

function invalid() {
  fail("MODERATION_CHECKPOINT", "禁言流程检查点未完成核验，保留停止标记。", "INCONCLUSIVE");
}

async function syncDirectory(path) {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function stableRead(path, maxBytes) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat({ bigint: true });
    if (
      !before.isFile() ||
      before.nlink !== 1n ||
      (before.mode & 0o077n) !== 0n ||
      before.size > BigInt(maxBytes)
    )
      invalid();
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    const named = await lstat(path, { bigint: true });
    for (const key of ["dev", "ino", "size", "mtimeNs", "ctimeNs", "nlink", "mode"])
      if (before[key] !== after[key] || before[key] !== named[key]) invalid();
    if (bytes.length !== Number(before.size)) invalid();
    await handle.sync();
    return bytes;
  } finally {
    await handle.close();
  }
}

/** The journal records the live process's ordered progress and never starts a recovery send. */
export async function createModerationCheckpoint({
  pendingPath,
  reportDirectory,
  runtime,
  suiteSha256,
  driverSha256,
  processIdentity,
}) {
  const pending = resolve(pendingPath);
  const report = resolve(reportDirectory);
  const child = relative(report, pending);
  if (
    pending !== pendingPath ||
    report !== reportDirectory ||
    !child ||
    (!isAbsolute(child) && child !== ".." && !child.startsWith(`..${sep}`)) ||
    !HASH.test(suiteSha256 ?? "") ||
    !HASH.test(driverSha256 ?? "") ||
    !runtime ||
    !processIdentity ||
    !((await realpath(dirname(pending))) === dirname(pending)) ||
    !((await realpath(report)) === report)
  )
    invalid();
  const journalPath = join(report, "moderation.checkpoint.jsonl");
  const reservation = await open(journalPath, "wx", 0o600);
  try {
    await reservation.sync();
  } finally {
    await reservation.close();
  }
  await syncDirectory(report);
  const identity = structuredClone({
    familyId: MODERATION_FAMILY_ID,
    runtime,
    suiteSha256,
    driverSha256,
    processIdentity,
    reportDirectory: report,
  });
  let count = 0;
  let previousSha256 = null;
  let last;
  let uncertain = false;
  let completed = false;
  return {
    async write(row) {
      row = structuredClone(row);
      if (
        uncertain ||
        completed ||
        count >= SEQUENCE.length ||
        row?.familyId !== MODERATION_FAMILY_ID ||
        !isDeepStrictEqual(row.runtime, identity.runtime) ||
        !isDeepStrictEqual([row.stage, row.phase], SEQUENCE[count]) ||
        !Array.isArray(row.steps) ||
        row.steps.length > 2
      )
        invalid();
      const entry = {
        schemaVersion: 1,
        identity,
        sequence: count + 1,
        previousSha256,
        recordedAt: new Date().toISOString(),
        observation: row,
      };
      if (Buffer.byteLength(JSON.stringify(entry)) > 65536) invalid();
      uncertain = true;
      await writeMemoryCheckpoint({
        pendingPath: pending,
        journalPath,
        first: count === 0,
        row: entry,
      });
      previousSha256 = hash(entry);
      last = row;
      count++;
      uncertain = false;
      return true;
    },
    async complete({ result, reportPath, connectionsDrained, recheck }) {
      if (
        uncertain ||
        completed ||
        count !== SEQUENCE.length ||
        result?.status !== "MODERATION_WORKFLOW_VERIFIED" ||
        result?.familyId !== MODERATION_FAMILY_ID ||
        result?.requiresReconciliation !== false ||
        result?.cleanupVerified !== true ||
        result?.actualQqDeliveryVerified !== true ||
        result.steps?.length !== 2 ||
        !result.steps.every(
          (step, index) =>
            step.stage === ["mute", "unmute"][index] &&
            step.proof?.cleanupVerified === true &&
            step.proof?.actualQqDeliveryVerified === true,
        ) ||
        !isDeepStrictEqual(result.steps, last?.steps) ||
        connectionsDrained !== true ||
        typeof recheck !== "function" ||
        reportPath !== join(report, "report.json")
      )
        invalid();
      await recheck();
      const bytes = await stableRead(reportPath, 4 * 1024 * 1024);
      const saved = JSON.parse(bytes.toString("utf8"));
      if (
        saved.status !== "PASS" ||
        saved.moderationAcceptance?.status !== "MODERATION_WORKFLOW_VERIFIED" ||
        saved.moderationAcceptance?.familyId !== MODERATION_FAMILY_ID ||
        saved.moderationAcceptance?.requiresReconciliation !== false ||
        saved.moderationAcceptance?.cleanupVerified !== true ||
        saved.moderationAcceptance?.actualQqDeliveryVerified !== true ||
        saved.moderationFinalStateProof?.status !== "MODERATION_FINAL_STATE_VERIFIED" ||
        saved.productAcceptance?.status !== "PASS" ||
        saved.productAcceptance?.cleanupVerified !== true
      )
        invalid();
      const completion = {
        schemaVersion: 1,
        familyId: MODERATION_FAMILY_ID,
        status: "MODERATION_GUARD_RELEASE_VERIFIED",
        suiteSha256,
        runtime,
        reportDirectory: report,
        reportSha256: createHash("sha256").update(bytes).digest("hex"),
        checkpointRows: count,
        finalProof: result.finalProof,
        actualQqDeliveryVerified: true,
        cleanupVerified: true,
      };
      const finalRow = {
        schemaVersion: 1,
        identity,
        sequence: count + 1,
        previousSha256,
        recordedAt: new Date().toISOString(),
        completion,
      };
      uncertain = true;
      await writeMemoryCheckpoint({
        pendingPath: pending,
        journalPath,
        first: false,
        row: finalRow,
      });
      previousSha256 = hash(finalRow);
      count++;
      uncertain = false;
      completed = true;
      return completion;
    },
  };
}
