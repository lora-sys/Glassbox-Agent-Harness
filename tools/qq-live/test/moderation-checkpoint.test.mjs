import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModerationCheckpoint } from "../lib/moderation-checkpoint.mjs";
import { MODERATION_FAMILY_ID } from "../lib/moderation-scenario.mjs";

const sha = "a".repeat(64);
const runtime = { checkout: "/fixture", dataDirectory: "/fixture-data", pid: 77 };
const processIdentity = { pid: 77, startTime: "fixture-start" };

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "moderation-checkpoint-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const reportDirectory = join(root, "report");
  const lockDirectory = join(root, "locks");
  const pendingPath = join(lockDirectory, "account.moderation-pending.json");
  await import("node:fs/promises").then(({ mkdir }) =>
    Promise.all([mkdir(reportDirectory, { mode: 0o700 }), mkdir(lockDirectory, { mode: 0o700 })]),
  );
  const reportPath = join(reportDirectory, "report.json");
  const checkpoint = await createModerationCheckpoint({
    pendingPath,
    reportDirectory,
    runtime,
    suiteSha256: sha,
    driverSha256: "b".repeat(64),
    processIdentity,
  });
  return { checkpoint, pendingPath, reportDirectory, reportPath };
}

const steps = ["mute", "unmute"].map((stage) => ({
  stage,
  proof: {
    cleanupVerified: true,
    actualQqDeliveryVerified: true,
    runId: `run-${stage}`,
  },
}));

async function writeSequence(checkpoint) {
  for (const stage of ["mute", "unmute"]) {
    for (const phase of ["intent", "lease_intent", "prepared", "sent", "observed"]) {
      await checkpoint.write({
        familyId: MODERATION_FAMILY_ID,
        runtime,
        stage,
        phase,
        steps:
          phase === "observed"
            ? steps.slice(0, stage === "mute" ? 1 : 2)
            : steps.slice(0, stage === "mute" ? 0 : 1),
      });
    }
  }
}

function successfulResult() {
  return {
    status: "MODERATION_WORKFLOW_VERIFIED",
    familyId: MODERATION_FAMILY_ID,
    requiresReconciliation: false,
    cleanupVerified: true,
    actualQqDeliveryVerified: true,
    steps,
    finalProof: { status: "MODERATION_FINAL_STATE_VERIFIED" },
  };
}

async function reportFile(path) {
  await writeFile(
    path,
    JSON.stringify({
      status: "PASS",
      moderationAcceptance: {
        status: "MODERATION_WORKFLOW_VERIFIED",
        familyId: MODERATION_FAMILY_ID,
        requiresReconciliation: false,
        cleanupVerified: true,
        actualQqDeliveryVerified: true,
      },
      moderationFinalStateProof: { status: "MODERATION_FINAL_STATE_VERIFIED" },
      productAcceptance: { status: "PASS", cleanupVerified: true },
    }),
    { mode: 0o600 },
  );
}

test("moderation checkpoint accepts only the ordered two-stage journal and verified completion", async (t) => {
  const f = await fixture(t);
  await writeSequence(f.checkpoint);
  await reportFile(f.reportPath);
  let rechecked = false;
  const completed = await f.checkpoint.complete({
    result: successfulResult(),
    reportPath: f.reportPath,
    connectionsDrained: true,
    recheck: async () => {
      rechecked = true;
    },
  });
  assert.equal(completed.status, "MODERATION_GUARD_RELEASE_VERIFIED");
  assert.equal(completed.cleanupVerified, true);
  assert.equal(rechecked, true);
  const lines = (await readFile(join(f.reportDirectory, "moderation.checkpoint.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(lines.length, 11);
  assert.equal(lines.at(-1).completion.status, "MODERATION_GUARD_RELEASE_VERIFIED");
});

test("checkpoint rejects an out-of-order phase before publishing a pending guard", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    f.checkpoint.write({
      familyId: MODERATION_FAMILY_ID,
      runtime,
      stage: "mute",
      phase: "prepared",
      steps: [],
    }),
    { code: "MODERATION_CHECKPOINT" },
  );
  await assert.rejects(readFile(f.pendingPath), { code: "ENOENT" });
});

test("completion refuses missing restoration or undrained connections and keeps the guard", async (t) => {
  const f = await fixture(t);
  await writeSequence(f.checkpoint);
  await reportFile(f.reportPath);
  const result = successfulResult();
  result.actualQqDeliveryVerified = false;
  await assert.rejects(
    f.checkpoint.complete({
      result,
      reportPath: f.reportPath,
      connectionsDrained: true,
      recheck: async () => {},
    }),
    { code: "MODERATION_CHECKPOINT" },
  );
  await assert.rejects(
    f.checkpoint.complete({
      result: successfulResult(),
      reportPath: f.reportPath,
      connectionsDrained: false,
      recheck: async () => {},
    }),
    { code: "MODERATION_CHECKPOINT" },
  );
  await readFile(f.pendingPath);
});
