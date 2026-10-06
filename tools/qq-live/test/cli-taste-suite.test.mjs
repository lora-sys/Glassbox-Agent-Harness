import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { digest } from "../lib/core.mjs";
import { TASTE_FAMILY_ID } from "../lib/taste-scenario.mjs";
import { baseConfig } from "./fixture.mjs";

const cli = fileURLToPath(new URL("../cli.mjs", import.meta.url));
const tasteFamily = {
  id: TASTE_FAMILY_ID,
  kind: "taste-lifecycle",
  chat: "private",
};
const readCase = {
  id: "ops-status",
  chat: "private",
  prompt: "Check status and include marker {{nonce}}.",
  expectContains: ["{{nonce}}"],
  sideEffect: "none",
  leaseTools: [
    {
      name: "ops_status",
      operations: [{ action: "ops:status", resourceId: "agent-ops", inputConstraint: {} }],
    },
  ],
  featureAssertions: [
    {
      kind: "trace",
      type: "tool_result",
      where: { name: "ops_status", isError: false },
      count: 1,
    },
  ],
};

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "qq-taste-suite-cli-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const configPath = join(directory, "config.json");
  const suitePath = join(directory, "suite.json");
  const out = join(directory, "reports");
  return { directory, configPath, suitePath, out };
}

async function writeConfig(path, overrides = {}) {
  const config = { ...baseConfig(), ...overrides };
  await writeFile(path, JSON.stringify(config));
  return config;
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

function approvedRunArgs({ configPath, suitePath, out, suiteSha256, caseId }) {
  return [
    "run",
    "--live",
    "--config",
    configPath,
    "--scenarios",
    suitePath,
    "--out",
    out,
    "--approve-suite",
    suiteSha256,
    ...(caseId ? ["--case", caseId] : []),
  ];
}

async function assertNoOutputDirectory(path) {
  await assert.rejects(stat(path), { code: "ENOENT" });
}

test("schema 6 Taste plan binds exact source bytes and fixed four-stage plan", async (t) => {
  const f = await fixture(t);
  const config = await writeConfig(f.configPath);
  const suiteText = `${JSON.stringify({ schemaVersion: 6, cases: [tasteFamily] }, null, 2)}\n`;
  await writeFile(f.suitePath, suiteText);
  const planned = await run(
    ["plan", "--config", f.configPath, "--scenarios", f.suitePath],
    f.directory,
  );
  assert.equal(planned.code, 0, planned.stderr);
  const result = JSON.parse(planned.stdout);
  assert.equal(result.suiteSha256, digest(suiteText));
  assert.deepEqual(
    result.tastePlan.stages.map((stage) => stage.id),
    ["taste-feedback", "taste-promote", "taste-negative-feedback", "taste-retire"],
  );
  assert.deepEqual(
    result.cases.map((item) => item.id),
    [TASTE_FAMILY_ID],
  );
  assert.equal(config.maxMessages, 12);
  await assertNoOutputDirectory(f.out);
});

test("schema 6 Taste run requires selecting its family before any output or network setup", async (t) => {
  const f = await fixture(t);
  await writeConfig(f.configPath);
  const suiteText = JSON.stringify({ schemaVersion: 6, cases: [tasteFamily] });
  await writeFile(f.suitePath, suiteText);
  const result = await run(
    approvedRunArgs({
      configPath: f.configPath,
      suitePath: f.suitePath,
      out: f.out,
      suiteSha256: digest(suiteText),
    }),
    f.directory,
  );
  assert.equal(result.code, 2);
  assert.match(result.stderr + result.stdout, /CASE_FAMILY_REQUIRED/);
  await assertNoOutputDirectory(f.out);
});

test("schema 6 Taste run enforces fixture, message budget and runtime guards locally", async (t) => {
  const f = await fixture(t);
  const suiteText = JSON.stringify({ schemaVersion: 6, cases: [tasteFamily] });
  await writeFile(f.suitePath, suiteText);
  const suiteSha256 = digest(suiteText);
  const base = {
    configPath: f.configPath,
    suitePath: f.suitePath,
    out: f.out,
    suiteSha256,
    caseId: TASTE_FAMILY_ID,
  };

  await writeConfig(f.configPath, {
    memoryFixtures: { enabled: true, retainAuditConfirmed: false },
  });
  const noAuditRetention = await run(approvedRunArgs(base), f.directory);
  assert.equal(noAuditRetention.code, 2);
  assert.match(noAuditRetention.stderr + noAuditRetention.stdout, /MEMORY_FIXTURE_DISABLED/);
  await assertNoOutputDirectory(f.out);

  await writeConfig(f.configPath, {
    maxMessages: 3,
    memoryFixtures: { enabled: true, retainAuditConfirmed: true },
  });
  const insufficientBudget = await run(approvedRunArgs(base), f.directory);
  assert.equal(insufficientBudget.code, 2);
  assert.match(insufficientBudget.stderr + insufficientBudget.stdout, /MESSAGE_BUDGET/);
  await assertNoOutputDirectory(f.out);

  await writeConfig(f.configPath, {
    memoryFixtures: { enabled: true, retainAuditConfirmed: true },
  });
  const missingRuntime = await run(approvedRunArgs(base), f.directory);
  assert.equal(missingRuntime.code, 2);
  assert.match(missingRuntime.stderr + missingRuntime.stdout, /FEATURE_RUNTIME_REQUIRED/);
  await assertNoOutputDirectory(f.out);
});

test("schema 6 Taste run rejects a byte-changed suite against its original approval", async (t) => {
  const f = await fixture(t);
  await writeConfig(f.configPath, {
    runtime: {},
    memoryFixtures: { enabled: true, retainAuditConfirmed: true },
  });
  const original = `${JSON.stringify({ schemaVersion: 6, cases: [tasteFamily] }, null, 2)}\n`;
  await writeFile(f.suitePath, original);
  const planned = await run(
    ["plan", "--config", f.configPath, "--scenarios", f.suitePath],
    f.directory,
  );
  assert.equal(planned.code, 0, planned.stderr);
  const approvedSha256 = JSON.parse(planned.stdout).suiteSha256;

  const changed = `${original}\n`;
  await writeFile(f.suitePath, changed);
  assert.notEqual(digest(changed), approvedSha256);
  const result = await run(
    approvedRunArgs({
      configPath: f.configPath,
      suitePath: f.suitePath,
      out: f.out,
      suiteSha256: approvedSha256,
      caseId: TASTE_FAMILY_ID,
    }),
    f.directory,
  );
  assert.equal(result.code, 2);
  assert.match(result.stderr + result.stdout, /SUITE_APPROVAL/);
  await assertNoOutputDirectory(f.out);
});

test("schema 6 mixed suite plan includes Taste and existing read cases without sending", async (t) => {
  const f = await fixture(t);
  await writeConfig(f.configPath);
  const suiteText = `${JSON.stringify({ schemaVersion: 6, cases: [tasteFamily, readCase] }, null, 2)}\n`;
  await writeFile(f.suitePath, suiteText);
  const planned = await run(
    ["plan", "--config", f.configPath, "--scenarios", f.suitePath],
    f.directory,
  );
  assert.equal(planned.code, 0, planned.stderr);
  const result = JSON.parse(planned.stdout);
  assert.equal(result.suiteSha256, digest(suiteText));
  assert.deepEqual(
    result.cases.map((item) => item.id),
    [TASTE_FAMILY_ID, "ops-status"],
  );
  assert.deepEqual(
    result.tastePlan.stages.map((stage) => stage.id),
    ["taste-feedback", "taste-promote", "taste-negative-feedback", "taste-retire"],
  );
  await assertNoOutputDirectory(f.out);
});

test("schema 6 mixed suite accepts selecting a read case without entering the Taste workflow", async (t) => {
  const f = await fixture(t);
  await writeConfig(f.configPath, { runtime: {} });
  const suiteText = JSON.stringify({ schemaVersion: 6, cases: [tasteFamily, readCase] });
  await writeFile(f.suitePath, suiteText);
  const result = await run(
    approvedRunArgs({
      configPath: f.configPath,
      suitePath: f.suitePath,
      out: f.out,
      suiteSha256: digest(suiteText),
      caseId: readCase.id,
    }),
    f.directory,
  );
  assert.equal(result.code, 2);
  const latest = JSON.parse(await readFile(join(f.out, "latest.json"), "utf8"));
  assert.equal(latest.error.code, "RUNTIME_CONFIG");
  assert.equal(Object.hasOwn(latest, "tasteFamily"), false);
});
