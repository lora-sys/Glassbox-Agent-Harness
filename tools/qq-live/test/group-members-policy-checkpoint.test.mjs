import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, writeFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createGroupMembersPolicyCheckpoint } from "../lib/group-members-policy-checkpoint.mjs";
import { GROUP_MEMBERS_POLICY_FAMILY_ID } from "../lib/group-members-policy-scenario.mjs";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "group-members-policy-checkpoint-"));
  t.after(async () =>
    (await import("node:fs/promises")).rm(root, { recursive: true, force: true }),
  );
  const reportDirectory = join(root, "report");
  await mkdir(reportDirectory, { mode: 0o700 });
  const pendingPath = join(root, "pending.json");
  const runtime = { pid: 123, commit: "a".repeat(40) };
  const writer = await createGroupMembersPolicyCheckpoint({
    pendingPath,
    reportDirectory,
    runtime,
    suiteSha256: "a".repeat(64),
    driverSha256: "b".repeat(64),
    processIdentity: { pid: process.pid },
  });
  const steps = ["disable", "members-check", "restore"].map((stage, index) => ({
    stage,
    proof: {
      status:
        index === 1
          ? "GROUP_MEMBERS_POLICY_REQUIRED_EVIDENCE_MISSING"
          : "GROUP_MEMBERS_POLICY_RUN_VERIFIED",
      cleanupVerified: true,
      actualQqDeliveryVerified: true,
    },
  }));
  const finalProof = {
    status: "STATE_TRANSITION_VERIFIED",
    stage: "restore",
    originalPolicyRestored: true,
  };
  const result = {
    status: "GROUP_MEMBERS_POLICY_BOUNDARY_VERIFIED",
    requiresReconciliation: false,
    actualQqDeliveryVerified: true,
    cleanupVerified: true,
    steps,
    finalProof,
  };
  return { root, reportDirectory, pendingPath, runtime, writer, steps, finalProof, result };
}

test("members-policy checkpoint accepts only the expected refusal after exact restore", async (t) => {
  const f = await fixture(t);
  const baseline = { fixed: "B-only" };
  for (const stage of ["disable", "members-check", "restore"])
    for (const phase of ["intent", "lease_intent", "prepared", "sent", "verified"])
      await f.writer.write({
        familyId: GROUP_MEMBERS_POLICY_FAMILY_ID,
        stage,
        phase,
        runtime: f.runtime,
        baseline,
        steps: f.steps,
      });
  await f.writer.write({
    familyId: GROUP_MEMBERS_POLICY_FAMILY_ID,
    stage: "restore",
    phase: "restored",
    runtime: f.runtime,
    baseline,
    steps: f.steps,
    finalProof: f.finalProof,
  });
  const journal = (
    await readFile(join(f.reportDirectory, "group-members-policy.checkpoint.jsonl"), "utf8")
  )
    .trim()
    .split("\n");
  assert.equal(journal.length, 16);
  assert.equal((await stat(f.pendingPath)).mode & 0o777, 0o600);
  const reportPath = join(f.reportDirectory, "report.json");
  await writeFile(
    reportPath,
    JSON.stringify({
      status: "PASS",
      productAcceptance: {
        status: "PASS",
        cleanupVerified: true,
        acceptanceKind: "GROUP_MEMBERS_POLICY_BOUNDARY",
      },
      groupMembersPolicyAcceptance: f.result,
    }),
    { mode: 0o600 },
  );
  let rechecks = 0;
  const receipt = await f.writer.complete({
    result: f.result,
    reportPath,
    connectionsDrained: true,
    recheck: async () => {
      rechecks++;
    },
  });
  assert.equal(rechecks, 3);
  assert.equal(receipt.status, "GROUP_MEMBERS_POLICY_GUARD_COMPLETED");
  assert.equal(
    JSON.parse(await readFile(receipt.releaseIntentPath, "utf8")).automaticReplayAllowed,
    false,
  );
  await assert.rejects(stat(f.pendingPath), { code: "ENOENT" });
});

test("members-policy checkpoint rejects a positive-feature label or altered required-evidence result", async (t) => {
  const f = await fixture(t);
  const baseline = { fixed: "B-only" };
  for (const stage of ["disable", "members-check", "restore"])
    for (const phase of ["intent", "lease_intent", "prepared", "sent", "verified"])
      await f.writer.write({
        familyId: GROUP_MEMBERS_POLICY_FAMILY_ID,
        stage,
        phase,
        runtime: f.runtime,
        baseline,
        steps: f.steps,
      });
  await f.writer.write({
    familyId: GROUP_MEMBERS_POLICY_FAMILY_ID,
    stage: "restore",
    phase: "restored",
    runtime: f.runtime,
    baseline,
    steps: f.steps,
    finalProof: f.finalProof,
  });
  await assert.rejects(
    f.writer.complete({
      result: { ...f.result, status: "GROUP_MEMBERS_POLICY_WORKFLOW_VERIFIED" },
      reportPath: "",
      connectionsDrained: true,
      recheck: async () => {},
    }),
    { code: "GROUP_MEMBERS_POLICY_CHECKPOINT" },
  );
  const altered = structuredClone(f.result);
  altered.steps[1].proof.status = "GROUP_MEMBERS_POLICY_RUN_VERIFIED";
  await assert.rejects(
    f.writer.complete({
      result: altered,
      reportPath: "",
      connectionsDrained: true,
      recheck: async () => {},
    }),
    { code: "GROUP_MEMBERS_POLICY_CHECKPOINT" },
  );
  assert.equal((await stat(f.pendingPath)).isFile(), true);
});
