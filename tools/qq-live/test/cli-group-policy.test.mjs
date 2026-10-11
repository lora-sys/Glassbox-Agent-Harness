import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolveGroupPolicyCli } from "../lib/group-policy-cli.mjs";
import { GROUP_POLICY_FAMILY_ID } from "../lib/group-policy-scenario.mjs";
import { baseConfig } from "./fixture.mjs";
import { shouldCreateSafetyStop } from "../cli.mjs";

const cli = fileURLToPath(new URL("../cli.mjs", import.meta.url));

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "qq-group-policy-cli-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return {
    directory,
    configPath: join(directory, "config.json"),
    out: join(directory, "reports"),
  };
}

function validConfig() {
  return {
    ...baseConfig(),
    runtime: {
      checkout: "/fixture/checkout",
      dataDirectory: "/fixture/data",
      expectedCommit: "a".repeat(40),
      connectionId: "fixture-connection",
    },
    groupPolicyFixtures: {
      enabled: true,
      retainAuditConfirmed: true,
      groupId: "20002",
    },
  };
}

async function writeConfig(path, value = validConfig()) {
  await writeFile(path, JSON.stringify(value));
}

async function run(args, directory) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], {
      cwd: directory,
      env: {
        ...process.env,
        HOME: directory,
        USERPROFILE: directory,
        DRIVER_TOKEN: "fixture-token-only",
        BOT_TOKEN: "fixture-token-only",
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.once("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

async function assertMissing(path) {
  await assert.rejects(stat(path), { code: "ENOENT" });
}

test("fixed group policy plan prints the exact B-only three-stage workflow without connecting", async (t) => {
  const f = await fixture(t);
  await writeConfig(f.configPath);
  const result = await run(
    ["plan", "--case", GROUP_POLICY_FAMILY_ID, "--config", f.configPath, "--out", f.out],
    f.directory,
  );
  assert.equal(result.code, 0, result.stderr);
  const plan = JSON.parse(result.stdout);
  const expected = resolveGroupPolicyCli({
    command: "plan",
    config: validConfig(),
  });
  assert.equal(plan.familyId, GROUP_POLICY_FAMILY_ID);
  assert.equal(plan.suiteSha256, expected.suiteSha256);
  assert.deepEqual(plan.bindings, expected.bindings);
  assert.deepEqual(
    plan.stages.map((stage) => stage.stage),
    ["disable", "history-check", "restore"],
  );
  assert.ok(plan.stages.every((stage) => stage.spec.chat === "private"));
  assert.ok(
    plan.stages.every(
      (stage) =>
        stage.spec.leaseTools[0].name ===
        (stage.stage === "history-check" ? "owner_history_search" : "owner_group_admin"),
    ),
  );
  await assertMissing(f.out);
});

test("planning refuses a disabled or unconfirmed group policy fixture before creating output", async (t) => {
  const f = await fixture(t);
  await writeConfig(f.configPath, {
    ...validConfig(),
    groupPolicyFixtures: {
      enabled: false,
      retainAuditConfirmed: true,
      groupId: "20002",
    },
  });
  const result = await run(
    ["plan", "--case", GROUP_POLICY_FAMILY_ID, "--config", f.configPath, "--out", f.out],
    f.directory,
  );
  assert.notEqual(result.code, 0);
  assert.match(result.stderr + result.stdout, /GROUP_POLICY_FIXTURE_DISABLED/u);
  await assertMissing(f.out);
});

test("live group policy run refuses a changed plan hash before creating output or connecting", async (t) => {
  const f = await fixture(t);
  await writeConfig(f.configPath);
  const result = await run(
    [
      "run",
      "--live",
      "--case",
      GROUP_POLICY_FAMILY_ID,
      "--config",
      f.configPath,
      "--out",
      f.out,
      "--approve-suite",
      "b".repeat(64),
    ],
    f.directory,
  );
  assert.notEqual(result.code, 0);
  assert.match(result.stderr + result.stdout, /SUITE_APPROVAL/u);
  assert.doesNotMatch(result.stderr + result.stdout, /CONNECT_TIMEOUT|ECONNREFUSED/u);
  await assertMissing(f.out);
});

test("an approval made for a different Owner identity is refused before connecting", async (t) => {
  const f = await fixture(t);
  const original = validConfig();
  const oldPlan = resolveGroupPolicyCli({ command: "plan", config: original });
  const changed = {
    ...original,
    driver: { ...original.driver, qq: "10003" },
  };
  await writeConfig(f.configPath, changed);
  const result = await run(
    [
      "run",
      "--live",
      "--case",
      GROUP_POLICY_FAMILY_ID,
      "--config",
      f.configPath,
      "--out",
      f.out,
      "--approve-suite",
      oldPlan.suiteSha256,
    ],
    f.directory,
  );
  assert.notEqual(result.code, 0);
  assert.match(result.stderr + result.stdout, /SUITE_APPROVAL/u);
  assert.doesNotMatch(result.stderr + result.stdout, /CONNECT_TIMEOUT|ECONNREFUSED/u);
  await assertMissing(f.out);
});

test("live group policy run requires explicit fixture enablement before network setup", async (t) => {
  const f = await fixture(t);
  const config = validConfig();
  delete config.groupPolicyFixtures;
  await writeConfig(f.configPath, config);
  const result = await run(
    ["run", "--live", "--case", GROUP_POLICY_FAMILY_ID, "--config", f.configPath, "--out", f.out],
    f.directory,
  );
  assert.notEqual(result.code, 0);
  assert.match(result.stderr + result.stdout, /GROUP_POLICY_FIXTURE_DISABLED/u);
  assert.doesNotMatch(result.stderr + result.stdout, /CONNECT_TIMEOUT|ECONNREFUSED/u);
  await assertMissing(f.out);
});

test("a partial group-policy proof requires STOP while a fully verified result does not", () => {
  const report = {
    status: "PASS",
    groupPolicyAcceptance: {
      status: "GROUP_POLICY_WORKFLOW_VERIFIED",
      requiresReconciliation: false,
      actualQqDeliveryVerified: true,
      cleanupVerified: true,
    },
    groupPolicyFinalStateProof: { status: "GROUP_POLICY_FINAL_STATE_VERIFIED" },
    productAcceptance: { status: "PASS", cleanupVerified: true },
    cases: [],
  };
  assert.equal(shouldCreateSafetyStop(report, { pendingGroupPolicyFixtureCreated: true }), false);
  assert.equal(
    shouldCreateSafetyStop(
      {
        ...report,
        status: "INCONCLUSIVE",
        groupPolicyAcceptance: {
          ...report.groupPolicyAcceptance,
          status: "INCONCLUSIVE",
          requiresReconciliation: true,
        },
        productAcceptance: { status: "INCONCLUSIVE", cleanupVerified: false },
      },
      { pendingGroupPolicyFixtureCreated: true },
    ),
    true,
  );
});
