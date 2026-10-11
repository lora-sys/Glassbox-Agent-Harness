import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, writeFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createGroupPolicyCheckpoint } from "../lib/group-policy-checkpoint.mjs";
import { GROUP_POLICY_FAMILY_ID } from "../lib/group-policy-scenario.mjs";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "group-policy-checkpoint-"));
  t.after(async () => {
    const { rm } = await import("node:fs/promises");
    await rm(root, { recursive: true, force: true });
  });
  const reportDirectory = join(root, "report");
  await mkdir(reportDirectory, { mode: 0o700 });
  const pendingPath = join(root, "pending.json");
  const runtime = { pid: 123, commit: "a".repeat(40) };
  const writer = await createGroupPolicyCheckpoint({
    pendingPath,
    reportDirectory,
    runtime,
    suiteSha256: "a".repeat(64),
    driverSha256: "b".repeat(64),
    processIdentity: { pid: process.pid },
  });
  const steps = [
    {
      stage: "disable",
      proof: {
        status: "GROUP_POLICY_RUN_VERIFIED",
        cleanupVerified: true,
        actualQqDeliveryVerified: true,
      },
    },
    {
      stage: "history-check",
      proof: {
        status: "HISTORY_REVOCATION_RESULT_VERIFIED",
        cleanupVerified: true,
        actualQqDeliveryVerified: true,
      },
    },
    {
      stage: "restore",
      proof: {
        status: "GROUP_POLICY_RUN_VERIFIED",
        cleanupVerified: true,
        actualQqDeliveryVerified: true,
      },
    },
  ];
  const finalProof = {
    status: "STATE_TRANSITION_VERIFIED",
    stage: "restore",
    originalPolicyRestored: true,
  };
  const baseline = { fixture: true };
  let fResultSteps = steps;
  const result = {
    status: "GROUP_POLICY_WORKFLOW_VERIFIED",
    requiresReconciliation: false,
    actualQqDeliveryVerified: true,
    cleanupVerified: true,
    steps,
    finalProof,
  };
  const complete = async () => {
    for (const stage of ["disable", "history-check", "restore"])
      for (const phase of ["intent", "lease_intent", "prepared", "sent", "verified"])
        await writer.write({
          familyId: GROUP_POLICY_FAMILY_ID,
          stage,
          phase,
          runtime,
          baseline,
          steps: fResultSteps,
        });
    await writer.write({
      familyId: GROUP_POLICY_FAMILY_ID,
      stage: "restore",
      phase: "restored",
      runtime,
      baseline,
      steps: fResultSteps,
      finalProof,
    });
  };
  return {
    writer,
    pendingPath,
    reportDirectory,
    runtime,
    baseline,
    result,
    setSteps(value) {
      fResultSteps = value;
    },
    complete,
  };
}

test("checkpoint persists ordered private measurements and completes only after durable report and fresh checks", async (t) => {
  const f = await fixture(t);
  await f.complete();
  const lines = (await readFile(join(f.reportDirectory, "group-policy.checkpoint.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map(JSON.parse);
  assert.equal(lines.length, 16);
  assert.equal(lines[0].previousSha256, null);
  assert.match(lines[1].previousSha256, /^[a-f0-9]{64}$/u);
  assert.equal((await stat(f.pendingPath)).mode & 0o777, 0o600);
  const reportPath = join(f.reportDirectory, "report.json");
  await writeFile(
    reportPath,
    JSON.stringify({
      status: "PASS",
      productAcceptance: { status: "PASS", cleanupVerified: true },
      groupPolicyAcceptance: f.result,
    }),
    { mode: 0o600 },
  );
  let rechecks = 0;
  const receipt = await f.writer.complete({
    result: f.result,
    recheck: async () => {
      rechecks++;
    },
    reportPath,
    connectionsDrained: true,
  });
  assert.equal(rechecks, 3);
  assert.equal(receipt.status, "GROUP_POLICY_GUARD_COMPLETED");
  const intent = JSON.parse(await readFile(receipt.releaseIntentPath, "utf8"));
  assert.equal(intent.status, "RELEASE_PREPARED");
  assert.equal(intent.automaticReplayAllowed, false);
  assert.match(intent.reportSha256, /^[a-f0-9]{64}$/u);
  assert.match(intent.finalCheckpointSha256, /^[a-f0-9]{64}$/u);
  await assert.rejects(stat(f.pendingPath), { code: "ENOENT" });
  await assert.rejects(f.writer.complete({ result: f.result }));
});

test("failure after durable release intent retains the guard and cannot replay completion", async (t) => {
  const f = await fixture(t);
  await f.complete();
  const reportPath = join(f.reportDirectory, "report.json");
  await writeFile(
    reportPath,
    JSON.stringify({
      status: "PASS",
      productAcceptance: { status: "PASS", cleanupVerified: true },
      groupPolicyAcceptance: f.result,
    }),
    { mode: 0o600 },
  );
  let checks = 0;
  await assert.rejects(
    f.writer.complete({
      result: f.result,
      reportPath,
      connectionsDrained: true,
      recheck: async () => {
        if (++checks === 3) throw new Error("state drift");
      },
    }),
  );
  const intent = JSON.parse(
    await readFile(join(f.reportDirectory, "group-policy.guard-release.json"), "utf8"),
  );
  assert.equal(intent.status, "RELEASE_PREPARED");
  assert.equal((await stat(f.pendingPath)).isFile(), true);
  await assert.rejects(
    f.writer.complete({
      result: f.result,
      reportPath,
      connectionsDrained: true,
      recheck: async () => {},
    }),
    { code: "EEXIST" },
  );
  assert.equal((await stat(f.pendingPath)).isFile(), true);
});

test("out of order observations or baseline drift cannot overwrite a pending guard", async (t) => {
  const f = await fixture(t);
  const row = {
    familyId: GROUP_POLICY_FAMILY_ID,
    runtime: f.runtime,
    baseline: f.baseline,
    stage: "disable",
    phase: "intent",
  };
  await f.writer.write(row);
  const saved = await readFile(f.pendingPath, "utf8");
  await assert.rejects(f.writer.write({ ...row, phase: "prepared" }));
  await assert.rejects(
    f.writer.write({
      ...row,
      phase: "lease_intent",
      baseline: { drift: true },
    }),
  );
  assert.equal(await readFile(f.pendingPath, "utf8"), saved);
});

test("unverified delivery, undrained connections, report mismatch and state drift retain the guard", async (t) => {
  for (const mode of ["delivery", "drain", "report", "state"]) {
    const f = await fixture(t);
    await f.complete();
    const reportPath = join(f.reportDirectory, "report.json");
    await writeFile(
      reportPath,
      JSON.stringify({
        status: mode === "report" ? "FAIL" : "PASS",
        productAcceptance: { status: "PASS", cleanupVerified: true },
        groupPolicyAcceptance: f.result,
      }),
      { mode: 0o600 },
    );
    await assert.rejects(
      f.writer.complete({
        result: mode === "delivery" ? { ...f.result, actualQqDeliveryVerified: false } : f.result,
        connectionsDrained: mode !== "drain",
        reportPath,
        recheck: async () => {
          if (mode === "state") throw new Error("drift");
        },
      }),
    );
    assert.equal((await stat(f.pendingPath)).isFile(), true, mode);
  }
});

test("guards stay outside the report tree and a report directory cannot host two journals", async (t) => {
  const f = await fixture(t);
  const options = {
    reportDirectory: f.reportDirectory,
    runtime: f.runtime,
    suiteSha256: "a".repeat(64),
    driverSha256: "b".repeat(64),
    processIdentity: { pid: process.pid },
  };
  const nested = join(f.reportDirectory, "locks");
  await mkdir(nested);
  await assert.rejects(
    createGroupPolicyCheckpoint({
      ...options,
      pendingPath: join(nested, "pending.json"),
    }),
  );
  await assert.rejects(createGroupPolicyCheckpoint({ ...options, pendingPath: f.pendingPath }), {
    code: "EEXIST",
  });
});

test("a replaced pending observation or a changed durable report cannot release the guard", async (t) => {
  for (const target of ["pending", "report"]) {
    const f = await fixture(t);
    await f.complete();
    const reportPath = join(f.reportDirectory, "report.json");
    await writeFile(
      reportPath,
      JSON.stringify({
        status: "PASS",
        productAcceptance: { status: "PASS", cleanupVerified: true },
        groupPolicyAcceptance: f.result,
      }),
      { mode: 0o600 },
    );
    let checks = 0;
    await assert.rejects(
      f.writer.complete({
        result: f.result,
        connectionsDrained: true,
        reportPath,
        recheck: async () => {
          if (++checks === 2)
            await writeFile(target === "pending" ? f.pendingPath : reportPath, "{}\n", {
              mode: 0o600,
            });
        },
      }),
    );
    assert.equal((await stat(f.pendingPath)).isFile(), true);
  }
});

test("verified restoration releases a feature-failed report only with bound history failure cleanup", async (t) => {
  const f = await fixture(t);
  const result = structuredClone(f.result);
  result.status = "GROUP_POLICY_RESTORED_FEATURE_FAILED";
  result.steps[1].proof.status = "HISTORY_REVOCATION_RESULT_FAILED";
  result.steps[1].proof.cleanupVerified = true;
  f.result.steps = result.steps;
  f.setSteps(result.steps);
  await f.complete();
  const reportPath = join(f.reportDirectory, "report.json");
  await writeFile(
    reportPath,
    JSON.stringify({
      status: "FAIL",
      productAcceptance: { status: "FAIL", cleanupVerified: true },
      groupPolicyAcceptance: result,
    }),
    { mode: 0o600 },
  );
  const receipt = await f.writer.complete({
    result,
    recheck: async () => {},
    reportPath,
    connectionsDrained: true,
  });
  assert.equal(receipt.status, "GROUP_POLICY_GUARD_COMPLETED");
  await assert.rejects(stat(f.pendingPath), { code: "ENOENT" });
});

test("feature-failed report without a restored, verified history step retains the guard", async (t) => {
  const f = await fixture(t);
  const result = structuredClone(f.result);
  result.status = "GROUP_POLICY_RESTORED_FEATURE_FAILED";
  f.result.steps = result.steps;
  f.setSteps(result.steps);
  await f.complete();
  const reportPath = join(f.reportDirectory, "report.json");
  await writeFile(
    reportPath,
    JSON.stringify({
      status: "FAIL",
      productAcceptance: { status: "FAIL", cleanupVerified: true },
      groupPolicyAcceptance: result,
    }),
    { mode: 0o600 },
  );
  await assert.rejects(
    f.writer.complete({
      result,
      recheck: async () => {},
      reportPath,
      connectionsDrained: true,
    }),
  );
  assert.equal((await stat(f.pendingPath)).isFile(), true);
});
