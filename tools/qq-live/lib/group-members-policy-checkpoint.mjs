import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, unlink, realpath, lstat } from "node:fs/promises";
import { dirname, join, resolve, relative, sep, isAbsolute } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { fail } from "./core.mjs";
import { GROUP_MEMBERS_POLICY_FAMILY_ID } from "./group-members-policy-scenario.mjs";
import { writeMemoryCheckpoint } from "./memory-checkpoint.mjs";

const phases = ["intent", "lease_intent", "prepared", "sent", "verified"];
const sequence = [
  ...phases.map((phase) => ["disable", phase]),
  ...phases.map((phase) => ["members-check", phase]),
  ...phases.map((phase) => ["restore", phase]),
  ["restore", "restored"],
];
const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
function invalid() {
  fail(
    "GROUP_MEMBERS_POLICY_CHECKPOINT",
    "群成员权限检查记录未完成核验，保留停止标记。",
    "INCONCLUSIVE",
  );
}
async function syncDirectory(path) {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
async function stablePrivateRead(path, maximum) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat({ bigint: true });
    if (
      !before.isFile() ||
      before.nlink !== 1n ||
      (before.mode & 0o077n) !== 0n ||
      before.size > BigInt(maximum)
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

/** Persist a single-use Group B members-policy journal. Imported journals cannot resume sends. */
export async function createGroupMembersPolicyCheckpoint({
  pendingPath,
  reportDirectory,
  runtime,
  suiteSha256,
  driverSha256,
  processIdentity,
}) {
  if (!/^[a-f0-9]{64}$/u.test(suiteSha256 ?? "") || !/^[a-f0-9]{64}$/u.test(driverSha256 ?? ""))
    invalid();
  const pending = resolve(pendingPath);
  const report = resolve(reportDirectory);
  const withinReport = relative(report, pending);
  if (
    pending !== pendingPath ||
    report !== reportDirectory ||
    !withinReport ||
    (!isAbsolute(withinReport) && withinReport !== ".." && !withinReport.startsWith(`..${sep}`))
  )
    invalid();
  if (
    (await realpath(dirname(pending))) !== dirname(pending) ||
    (await realpath(report)) !== report
  )
    invalid();
  const journal = join(report, "group-members-policy.checkpoint.jsonl");
  const reservation = await open(journal, "wx", 0o600);
  try {
    await reservation.sync();
  } finally {
    await reservation.close();
  }
  await syncDirectory(report);
  const identity = structuredClone({
    runtime,
    suiteSha256,
    driverSha256,
    processIdentity,
    reportDirectory: report,
  });
  let count = 0,
    previousSha256 = null,
    baseline,
    last,
    lastEntry,
    uncertain = false,
    completed = false;
  return {
    async write(row) {
      row = structuredClone(row);
      if (
        uncertain ||
        completed ||
        count >= sequence.length ||
        row?.familyId !== GROUP_MEMBERS_POLICY_FAMILY_ID ||
        !isDeepStrictEqual(row.runtime, identity.runtime) ||
        !isDeepStrictEqual([row.stage, row.phase], sequence[count])
      )
        invalid();
      if (count === 0) baseline = structuredClone(row.baseline);
      if (!isDeepStrictEqual(row.baseline, baseline)) invalid();
      const entry = {
        schemaVersion: 1,
        identity,
        sequence: count + 1,
        previousSha256,
        recordedAt: new Date().toISOString(),
        observation: row,
      };
      if (Buffer.byteLength(JSON.stringify(entry)) > 131072) invalid();
      uncertain = true;
      await writeMemoryCheckpoint({
        pendingPath: pending,
        journalPath: journal,
        first: count === 0,
        row: entry,
      });
      previousSha256 = hash(entry);
      last = structuredClone(row);
      lastEntry = `${JSON.stringify(entry)}\n`;
      count++;
      uncertain = false;
      return true;
    },
    async complete({ result, recheck, reportPath, connectionsDrained }) {
      const steps = result?.steps;
      const stepsVerified =
        Array.isArray(steps) &&
        steps.length === 3 &&
        isDeepStrictEqual(
          steps.map((step) => step?.stage),
          ["disable", "members-check", "restore"],
        ) &&
        steps.every(
          (step) =>
            step?.proof?.cleanupVerified === true && step?.proof?.actualQqDeliveryVerified === true,
        ) &&
        steps[0]?.proof?.status === "GROUP_MEMBERS_POLICY_RUN_VERIFIED" &&
        steps[1]?.proof?.status === "GROUP_MEMBERS_POLICY_REQUIRED_EVIDENCE_MISSING" &&
        steps[2]?.proof?.status === "GROUP_MEMBERS_POLICY_RUN_VERIFIED";
      const restored =
        result?.finalProof?.status === "STATE_TRANSITION_VERIFIED" &&
        result.finalProof.stage === "restore" &&
        result.finalProof.originalPolicyRestored === true;
      if (
        uncertain ||
        completed ||
        count !== sequence.length ||
        result?.status !== "GROUP_MEMBERS_POLICY_BOUNDARY_VERIFIED" ||
        result.requiresReconciliation !== false ||
        result.actualQqDeliveryVerified !== true ||
        result.cleanupVerified !== true ||
        !stepsVerified ||
        !restored ||
        !isDeepStrictEqual(result.steps, last.steps) ||
        !isDeepStrictEqual(result.finalProof, last.finalProof) ||
        typeof recheck !== "function" ||
        connectionsDrained !== true ||
        reportPath !== join(report, "report.json")
      )
        invalid();
      await recheck();
      const reportBytes = await stablePrivateRead(reportPath, 4194304);
      const saved = JSON.parse(reportBytes.toString("utf8"));
      if (
        saved.status !== "PASS" ||
        saved.productAcceptance?.status !== "PASS" ||
        saved.productAcceptance?.acceptanceKind !== "GROUP_MEMBERS_POLICY_BOUNDARY" ||
        saved.productAcceptance?.cleanupVerified !== true ||
        !isDeepStrictEqual(saved.groupMembersPolicyAcceptance, result)
      )
        invalid();
      await syncDirectory(report);
      await recheck();
      if (
        !(await stablePrivateRead(reportPath, 4194304)).equals(reportBytes) ||
        (await stablePrivateRead(pending, 131072)).toString("utf8") !== lastEntry
      )
        invalid();
      const releaseIntentPath = join(report, "group-members-policy.guard-release.json");
      const intent = {
        schemaVersion: 1,
        kind: "group-members-policy-guard-release-intent",
        status: "RELEASE_PREPARED",
        identity,
        finalCheckpointSha256: previousSha256,
        reportSha256: createHash("sha256").update(reportBytes).digest("hex"),
        recordedAt: new Date().toISOString(),
        automaticReplayAllowed: false,
      };
      const release = await open(releaseIntentPath, "wx", 0o600);
      try {
        await release.writeFile(JSON.stringify(intent) + "\n", "utf8");
        await release.sync();
      } finally {
        await release.close();
      }
      await syncDirectory(report);
      await recheck();
      if (
        !(await stablePrivateRead(reportPath, 4194304)).equals(reportBytes) ||
        (await stablePrivateRead(pending, 131072)).toString("utf8") !== lastEntry
      )
        invalid();
      await unlink(pending);
      await syncDirectory(dirname(pending));
      completed = true;
      return {
        status: "GROUP_MEMBERS_POLICY_GUARD_COMPLETED",
        releaseIntentPath,
        actualQqDeliveryVerified: true,
      };
    },
  };
}
