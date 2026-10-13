import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, stat, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { resolveGroupMembersPolicyCli } from "../lib/group-members-policy-cli.mjs";
import { GROUP_MEMBERS_POLICY_FAMILY_ID } from "../lib/group-members-policy-scenario.mjs";
import { baseConfig } from "./fixture.mjs";
import { shouldCreateSafetyStop } from "../cli.mjs";

const cli = fileURLToPath(new URL("../cli.mjs", import.meta.url));
const config = {
  ...baseConfig(),
  runtime: {
    checkout: "/fixture/checkout",
    dataDirectory: "/fixture/data",
    expectedCommit: "a".repeat(40),
    connectionId: "fixture-connection",
  },
  groupPolicyFixtures: { enabled: true, retainAuditConfirmed: true, groupId: "20002" },
};
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "qq-group-members-policy-cli-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const configPath = join(directory, "config.json");
  await writeFile(configPath, JSON.stringify(config));
  return { directory, configPath, out: join(directory, "reports") };
}
async function run(args, directory) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], {
      cwd: directory,
      env: {
        ...process.env,
        HOME: directory,
        USERPROFILE: directory,
        DRIVER_TOKEN: "fixture",
        BOT_TOKEN: "fixture",
      },
    });
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.once("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

test("members-boundary plan binds only Group B, Owner private scope, and three fixed stages", () => {
  const planned = resolveGroupMembersPolicyCli({ command: "plan", config });
  assert.equal(planned.familyId, GROUP_MEMBERS_POLICY_FAMILY_ID);
  assert.equal(planned.groupId, "20002");
  assert.deepEqual(planned.bindings.groups, { A: "20001", B: "20002" });
  assert.deepEqual(
    planned.stages.map((stage) => stage.stage),
    ["disable", "members-check", "restore"],
  );
  assert.ok(planned.stages.every((stage) => stage.spec.chat === "private"));
  assert.equal(
    planned.stages[1].spec.requiredEvidenceFailure.failureCode,
    "required_evidence_missing",
  );
  assert.notEqual(
    resolveGroupMembersPolicyCli({
      command: "plan",
      config: { ...config, driver: { ...config.driver, qq: "10003" } },
    }).suiteSha256,
    planned.suiteSha256,
  );
  assert.throws(() =>
    resolveGroupMembersPolicyCli({
      command: "run",
      caseId: GROUP_MEMBERS_POLICY_FAMILY_ID,
      config,
      approvedSuite: "b".repeat(64),
    }),
  );
});

test("CLI prints the fixed members boundary plan without opening connections", async (t) => {
  const f = await fixture(t);
  const result = await run(
    ["plan", "--case", GROUP_MEMBERS_POLICY_FAMILY_ID, "--config", f.configPath, "--out", f.out],
    f.directory,
  );
  assert.equal(result.code, 0, result.stderr);
  const plan = JSON.parse(result.stdout);
  assert.deepEqual(
    plan.stages.map((stage) => stage.stage),
    ["disable", "members-check", "restore"],
  );
  assert.equal(plan.stages[1].spec.leaseTools[0].operations[0].action, "group:members:read");
  assert.match(plan.stages[1].spec.prompt, /只报告人数，不提供成员名单/u);
  await assert.rejects(stat(f.out), { code: "ENOENT" });
});

test("unresolved members-policy guard blocks sending, recovery, and delivery commands", async (t) => {
  const f = await fixture(t);
  const lockRoot = join(f.directory, ".glassbox-qq-live-locks");
  await mkdir(lockRoot, { recursive: true, mode: 0o700 });
  const account = createHash("sha256").update(config.driver.qq).digest("hex").slice(0, 24);
  await writeFile(join(lockRoot, account + ".group-members-policy-pending.json"), "{}", {
    mode: 0o600,
  });
  const commands = [
    ["run", "--live", "--case", GROUP_MEMBERS_POLICY_FAMILY_ID, "--approve-suite", "b".repeat(64)],
    ["reconcile-memory", "--live"],
    ["reconcile-taste", "--live"],
    [
      "cleanup-acceptance-memory",
      "--input",
      join(f.directory, "manifest.json"),
      "--live",
      "--approve-suite",
      "b".repeat(64),
    ],
    [
      "reconcile-acceptance-memory",
      "--input",
      join(f.directory, "manifest.json"),
      "--cleanup-report",
      join(f.directory, "cleanup.json"),
      "--live",
      "--approve-suite",
      "b".repeat(64),
    ],
    [
      "reconcile-completed-cleanup",
      "--input",
      join(f.directory, "manifest.json"),
      "--cleanup-failure",
      join(f.directory, "failed.json"),
    ],
    [
      "delivery-check",
      "--pr",
      "https://github.com/example/repo/pull/1",
      "--scenarios",
      "suite.json",
      "--reports",
      "reports.json",
      "--approve-suite",
      "b".repeat(64),
    ],
    [
      "deliver",
      "--live",
      "--pr",
      "https://github.com/example/repo/pull/1",
      "--scenarios",
      "suite.json",
      "--reports",
      "reports.json",
      "--approve-suite",
      "b".repeat(64),
    ],
    [
      "postmerge-check",
      "--pr",
      "https://github.com/example/repo/pull/1",
      "--scenarios",
      "suite.json",
      "--reports",
      "reports.json",
      "--approve-suite",
      "b".repeat(64),
    ],
  ];
  for (const args of commands) {
    const result = await run([...args, "--config", f.configPath, "--out", f.out], f.directory);
    assert.notEqual(result.code, 0, args[0]);
    assert.match(
      result.stderr + result.stdout,
      /GROUP_MEMBERS_POLICY_RECONCILIATION_REQUIRED|GROUP_MEMBERS_POLICY_FIXTURE_PENDING/u,
      args[0],
    );
  }
  await assert.rejects(stat(f.out), { code: "ENOENT" });
});

test("a restored boundary report clears the family guard only after exact report evidence", () => {
  const report = {
    status: "PASS",
    cases: [],
    productAcceptance: {
      status: "PASS",
      cleanupVerified: true,
      acceptanceKind: "GROUP_MEMBERS_POLICY_BOUNDARY",
    },
    groupMembersPolicyAcceptance: {
      status: "GROUP_MEMBERS_POLICY_BOUNDARY_VERIFIED",
      requiresReconciliation: false,
      actualQqDeliveryVerified: true,
      cleanupVerified: true,
    },
    groupMembersPolicyFinalStateProof: { status: "GROUP_MEMBERS_POLICY_FINAL_STATE_VERIFIED" },
  };
  assert.equal(
    shouldCreateSafetyStop(report, { pendingGroupMembersPolicyFixtureCreated: true }),
    false,
  );
  assert.equal(
    shouldCreateSafetyStop(
      { ...report, groupMembersPolicyFinalStateProof: undefined },
      { pendingGroupMembersPolicyFixtureCreated: true },
    ),
    true,
  );
  assert.equal(
    shouldCreateSafetyStop(
      {
        ...report,
        groupMembersPolicyAcceptance: {
          ...report.groupMembersPolicyAcceptance,
          status: "GROUP_MEMBERS_POLICY_WORKFLOW_VERIFIED",
        },
      },
      { pendingGroupMembersPolicyFixtureCreated: true },
    ),
    true,
  );
  assert.equal(
    shouldCreateSafetyStop(
      {
        ...report,
        productAcceptance: { ...report.productAcceptance, acceptanceKind: "FEATURE_SUCCESS" },
      },
      { pendingGroupMembersPolicyFixtureCreated: true },
    ),
    true,
  );
});
