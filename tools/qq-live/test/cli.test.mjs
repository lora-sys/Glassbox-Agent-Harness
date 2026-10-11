import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm, mkdir, stat, open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { world, baseConfig } from "./fixture.mjs";
import { digest } from "../lib/core.mjs";
import { acquireRunLock, shouldCreateSafetyStop, shouldWriteLatest } from "../cli.mjs";
import { verifyMemoryProcessStopped } from "../lib/memory-process.mjs";
const cli = fileURLToPath(new URL("../cli.mjs", import.meta.url));

test("resume-media updates latest only after verified two-stage completion", () => {
  assert.equal(shouldWriteLatest("resume-media", { status: "BLOCKED" }, null), false);
  assert.equal(
    shouldWriteLatest(
      "resume-media",
      { status: "INCONCLUSIVE" },
      { status: "MEDIA_RECOVERY_COMPLETE" },
    ),
    false,
  );
  assert.equal(shouldWriteLatest("resume-media", { status: "PASS" }, null), false);
  assert.equal(
    shouldWriteLatest("resume-media", { status: "PASS" }, { status: "MEDIA_RECOVERY_COMPLETE" }),
    true,
  );
  assert.equal(shouldWriteLatest("run", { status: "FAIL" }, null), true);
});

test("acceptance memory cleanup rejects custom execution and repeated input before config or QQ access", async (t) => {
  const d = await dir(t);
  for (const options of [
    [],
    ["--input", "manifest.json", "--case", "group-A"],
    ["--input", "manifest.json", "--scenarios", "custom.json"],
    ["--input", "manifest.json", "--input", "other.json"],
    ["--input", "manifest.json", "--pr", "https://example.invalid/pr"],
  ]) {
    const result = await run(["cleanup-acceptance-memory", ...options], d);
    assert.notEqual(result.code, 0);
    assert.ok(result.stderr.includes("ARGUMENT"), result.stderr);
    assert.ok(!result.stderr.includes("CONNECT_TIMEOUT"));
    assert.ok(!result.stderr.includes("CONFIG_READ"));
  }
});

test("lesson registration rejects execution flags before reading configuration or sending", async (t) => {
  const d = await dir(t);
  for (const options of [
    [],
    ["--input", "lesson.json", "--live"],
    ["--input", "lesson.json", "--case", "group-A"],
    ["--input", "lesson.json", "--pr", "https://example.invalid/pr"],
  ]) {
    const result = await run(["record-lesson", ...options], d);
    assert.notEqual(result.code, 0);
    assert.ok(result.stderr.includes("ARGUMENT"));
  }
  const input = join(d, "invalid-lesson.json");
  await writeFile(input, '{"private":"do-not-expose-this-value"');
  const invalid = await run(["record-lesson", "--input", input], d);
  assert.notEqual(invalid.code, 0);
  assert.ok(!`${invalid.stdout}${invalid.stderr}`.includes("do-not-expose-this-value"));
});

test("media recovery CLI requires its fixed report, family, and both reviewed hashes", async (t) => {
  const d = await dir(t);
  for (const args of [
    ["resume-media"],
    ["resume-media", "--live", "--report", "report.json"],
    [
      "resume-media",
      "--live",
      "--report",
      "report.json",
      "--case",
      "other-case",
      "--scenarios",
      "suite.json",
      "--approve-suite",
      "a".repeat(64),
      "--approve-recovery",
      "b".repeat(64),
    ],
    [
      "resume-media",
      "--live",
      "--report",
      "report.json",
      "--case",
      "media-private-delivery",
      "--scenarios",
      "suite.json",
      "--approve-suite",
      "a".repeat(64),
      "--approve-recovery",
      "invalid",
    ],
  ]) {
    const result = await run(args, d);
    assert.notEqual(result.code, 0);
    assert.ok(result.stderr.includes("ARGUMENT"), result.stderr);
    assert.ok(!result.stderr.includes("CONNECT_TIMEOUT"));
  }
  const plan = await run(["plan-media-recovery"], d);
  assert.notEqual(plan.code, 0);
  assert.ok(plan.stderr.includes("ARGUMENT"), plan.stderr);
});

test("media delivery-gap cleanup CLI accepts only its fixed plan and approved archive options", async (t) => {
  const d = await dir(t);
  for (const args of [
    ["plan-media-delivery-gap-cleanup"],
    ["plan-media-delivery-gap-cleanup", "--report", "report.json", "--live"],
    ["reconcile-media-delivery-gap-cleanup", "--report", "report.json", "--live"],
    [
      "reconcile-media-delivery-gap-cleanup",
      "--report",
      "report.json",
      "--approve-plan",
      "a".repeat(64),
    ],
    [
      "reconcile-media-delivery-gap-cleanup",
      "--report",
      "report.json",
      "--live",
      "--approve-plan",
      "invalid",
    ],
    [
      "reconcile-media-delivery-gap-cleanup",
      "--report",
      "report.json",
      "--live",
      "--approve-plan",
      "a".repeat(64),
      "--case",
      "other",
    ],
  ]) {
    const result = await run(args, d);
    assert.equal(result.code, 2);
    assert.match(result.stderr, /ARGUMENT/);
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, /CONNECT_TIMEOUT/);
  }
  const help = await run(["help"], d);
  assert.match(help.stdout, /plan-media-delivery-gap-cleanup --report/);
  assert.match(help.stdout, /reconcile-media-delivery-gap-cleanup --report/);
});

test("unfinished media cleanup intent blocks live sends and delivery before network access", async (t) => {
  const d = await dir(t);
  const configPath = join(d, "config.json");
  const lockRoot = join(d, ".glassbox-qq-live-locks");
  await mkdir(lockRoot, { recursive: true, mode: 0o700 });
  await writeFile(configPath, JSON.stringify(baseConfig()));
  await writeFile(
    join(lockRoot, `${digest("10001").slice(0, 24)}.media-cleanup-intent.json`),
    '{"kind":"qq-live-media-delivery-gap-cleanup-intent"}\n',
    { mode: 0o600 },
  );
  const blockedRun = await run(
    ["run", "--live", "--config", configPath, "--out", join(d, "reports")],
    d,
  );
  assert.notEqual(blockedRun.code, 0);
  assert.match(blockedRun.stderr, /MEDIA_DELIVERY_GAP_CLEANUP_REQUIRED/);
  assert.doesNotMatch(`${blockedRun.stdout}${blockedRun.stderr}`, /CONNECT_TIMEOUT/);

  const blockedDelivery = await run(
    [
      "deliver",
      "--live",
      "--config",
      configPath,
      "--pr",
      "https://example.invalid/pr/1",
      "--scenarios",
      "scenarios.json",
      "--reports",
      "manifest.json",
      "--approve-suite",
      "a".repeat(64),
    ],
    d,
  );
  assert.notEqual(blockedDelivery.code, 0);
  assert.match(blockedDelivery.stderr, /MEDIA_DELIVERY_GAP_CLEANUP_REQUIRED/);
  assert.doesNotMatch(`${blockedDelivery.stdout}${blockedDelivery.stderr}`, /CONNECT_TIMEOUT/);
});

test("unfinished media-release intent blocks every live run before OneBot connection", async (t) => {
  const d = await dir(t);
  const scenarioPath = new URL("../examples/media-private.example.json", import.meta.url);
  const scenarioText = await readFile(scenarioPath, "utf8");
  const configPath = join(d, "config.json");
  const out = join(d, "reports");
  const lockRoot = join(d, ".glassbox-qq-live-locks");
  await mkdir(out, { recursive: true });
  await mkdir(lockRoot, { recursive: true });
  await writeFile(
    join(lockRoot, `${digest("10001").slice(0, 24)}.media-release-intent.json`),
    "malformed intent\n",
    {
      mode: 0o600,
    },
  );
  await writeFile(
    configPath,
    JSON.stringify({
      ...baseConfig(),
      runtime: {},
      mediaFixtures: {
        enabled: true,
        retainAssetsConfirmed: true,
        timeoutMs: 1000,
      },
    }),
  );
  const result = await run(
    [
      "run",
      "--live",
      "--case",
      "media-private-delivery",
      "--scenarios",
      fileURLToPath(scenarioPath),
      "--approve-suite",
      digest(scenarioText),
      "--config",
      configPath,
      "--out",
      out,
    ],
    d,
  );
  assert.notEqual(result.code, 0);
  const latest = JSON.parse(await readFile(join(out, "latest.json"), "utf8"));
  assert.equal(latest.error.code, "MEDIA_RECOVERY_RELEASE_REQUIRED");
  assert.equal(latest.environment, undefined);
  assert.ok(!result.stderr.includes("CONNECT_TIMEOUT"));
});
async function run(args, dir, extraEnv = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, ...args], {
      cwd: dir,
      env: {
        ...process.env,
        HOME: dir,
        USERPROFILE: dir,
        DRIVER_TOKEN: "fixture-token-only",
        BOT_TOKEN: "fixture-token-only",
        ...extraEnv,
      },
    });
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (b) => (stdout += b));
    child.stderr.on("data", (b) => (stderr += b));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}
async function dir(t) {
  const d = await mkdtemp(join(tmpdir(), "qq-live-cli-"));
  t.after(() => rm(d, { recursive: true, force: true }));
  return d;
}
test("acceptance-memory reconciliation CLI validates its fixed arguments and dispatches read-only plans", async (t) => {
  const d = await dir(t);
  const configPath = join(d, "config.json");
  const config = baseConfig();
  delete config.safety;
  await writeFile(configPath, JSON.stringify(config));

  for (const options of [
    ["--input", "manifest.json"],
    ["--input", "manifest.json", "--cleanup-report", "report.json", "--case", "other"],
    ["--input", "manifest.json", "--cleanup-report", "report.json", "--input", "again.json"],
  ]) {
    const result = await run(
      ["reconcile-acceptance-memory", "--config", configPath, ...options],
      d,
    );
    assert.equal(result.code, 2);
    assert.match(result.stderr, /ARGUMENT/);
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, /CONNECT_TIMEOUT/);
  }
  const help = await run(["help"], d);
  assert.match(
    help.stdout,
    /reconcile-acceptance-memory --input <manifest-json> --cleanup-report <report-json>/,
  );

  const dry = await run(
    [
      "reconcile-acceptance-memory",
      "--config",
      configPath,
      "--input",
      join(d, "missing-manifest.json"),
      "--cleanup-report",
      join(d, "missing-cleanup-report.json"),
      "--out",
      join(d, "reports"),
    ],
    d,
  );
  assert.equal(dry.code, 3);
  assert.match(dry.stderr, /CLEANUP_READ/);
  assert.doesNotMatch(`${dry.stdout}${dry.stderr}`, /CONNECT_TIMEOUT/);

  const live = await run(
    [
      "reconcile-acceptance-memory",
      "--config",
      configPath,
      "--input",
      join(d, "missing-manifest.json"),
      "--cleanup-report",
      join(d, "missing-cleanup-report.json"),
      "--live",
      "--approve-suite",
      "a".repeat(64),
    ],
    d,
  );
  assert.equal(live.code, 2);
  assert.match(live.stderr, /ACCEPTANCE_SERVICE_REQUIRED/);
  assert.doesNotMatch(`${live.stdout}${live.stderr}`, /CONNECT_TIMEOUT/);
});

test("completed cleanup reconciliation has a bounded read-only command and rejects execution flags", async (t) => {
  const d = await dir(t);
  for (const options of [
    [],
    ["--input", "manifest.json"],
    ["--cleanup-failure", "failure.json"],
    ["--input", "manifest.json", "--cleanup-failure", "failure.json", "--live"],
    [
      "--input",
      "manifest.json",
      "--cleanup-failure",
      "failure.json",
      "--approve-suite",
      "a".repeat(64),
    ],
    [
      "--input",
      "manifest.json",
      "--cleanup-failure",
      "failure.json",
      "--cleanup-failure",
      "other.json",
    ],
  ]) {
    const result = await run(["reconcile-completed-cleanup", ...options], d);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /ARGUMENT/);
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, /CONNECT_TIMEOUT|CONFIG_READ/);
  }
  const help = await run(["help"], d);
  assert.match(
    help.stdout,
    /reconcile-completed-cleanup --input <manifest-json> --cleanup-failure <failed-report-json>/,
  );
});

test("cleanup report option is unavailable to ordinary commands", async (t) => {
  const d = await dir(t);
  const result = await run(["run", "--cleanup-report", join(d, "report.json")], d);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /ARGUMENT/);
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, /CONFIG_READ|CONNECT_TIMEOUT/);
});

test("a known history failure releases STOP only after verified restore and cleanup", () => {
  const report = {
    status: "FAIL",
    cases: [],
    groupPolicyAcceptance: {
      status: "GROUP_POLICY_RESTORED_FEATURE_FAILED",
      requiresReconciliation: false,
      cleanupVerified: true,
      actualQqDeliveryVerified: true,
    },
    productAcceptance: { status: "FAIL", cleanupVerified: true },
    groupPolicyFinalStateProof: { status: "GROUP_POLICY_FINAL_STATE_VERIFIED" },
  };
  assert.equal(shouldCreateSafetyStop(report, { pendingGroupPolicyFixtureCreated: true }), false);
  for (const mutate of [
    (value) => (value.groupPolicyAcceptance.cleanupVerified = false),
    (value) => (value.groupPolicyAcceptance.requiresReconciliation = true),
    (value) => (value.productAcceptance.cleanupVerified = false),
    (value) => (value.groupPolicyFinalStateProof.status = "INCONCLUSIVE"),
  ]) {
    const changed = structuredClone(report);
    mutate(changed);
    assert.equal(
      shouldCreateSafetyStop(changed, {
        pendingGroupPolicyFixtureCreated: true,
      }),
      true,
    );
  }
});

test("unverified acceptance-memory ARCHIVE_INTENT blocks normal live runs before QQ connection", async (t) => {
  const d = await dir(t);
  const w = await world();
  t.after(() => w.close());
  const configPath = join(d, "config.json");
  const out = join(d, "reports");
  const config = { ...w.config, runtime: {} };
  await writeFile(configPath, JSON.stringify(config));
  const planned = await run(["plan", "--config", configPath], d);
  assert.equal(planned.code, 0, planned.stderr);
  const suiteSha256 = JSON.parse(planned.stdout).suiteSha256;
  const archive = join(
    out,
    "acceptance-memory-reconciliation",
    "11111111-1111-4111-8111-111111111111",
  );
  await mkdir(archive, { recursive: true });
  await writeFile(join(archive, "intent.json"), JSON.stringify({ status: "ARCHIVE_INTENT" }));
  const result = await run(
    ["run", "--live", "--approve-suite", suiteSha256, "--config", configPath, "--out", out],
    d,
  );
  assert.equal(result.code, 2, `${result.stdout}${result.stderr}`);
  assert.equal(w.driver.authCount, 0);
  assert.equal(w.bot.authCount, 0);
  assert.equal(w.actions.length, 0);
  const latest = JSON.parse(await readFile(join(out, "latest.json"), "utf8"));
  assert.equal(latest.error.code, "MEMORY_RECONCILIATION_REQUIRED");
});

test("schema 8 plans four fixed Worker stages and refuses disabled live fixtures", async (t) => {
  const d = await dir(t);
  const config = join(d, "config.json");
  const scenarios = join(d, "worker.json");
  await writeFile(config, JSON.stringify(baseConfig()));
  await writeFile(
    scenarios,
    JSON.stringify({
      schemaVersion: 8,
      cases: [
        {
          id: "task-worker-artifact-lifecycle",
          kind: "task-worker-artifact-lifecycle",
          chat: "private",
        },
      ],
    }),
  );
  const result = await run(["plan", "--config", config, "--scenarios", scenarios], d);
  assert.equal(result.code, 0, result.stderr);
  const plan = JSON.parse(result.stdout);
  assert.deepEqual(
    plan.taskWorkerPlan.stages.map((s) => s.stage),
    ["create", "delegate", "inspect", "accept"],
  );
  assert.match(plan.suiteSha256, /^[a-f0-9]{64}$/);
  const refused = await run(
    [
      "run",
      "--live",
      "--config",
      config,
      "--scenarios",
      scenarios,
      "--case",
      "task-worker-artifact-lifecycle",
    ],
    d,
  );
  assert.notEqual(refused.code, 0);
  assert.ok(refused.stderr.includes("TASK_WORKER_FIXTURE_DISABLED"), refused.stderr);
  assert.ok(!refused.stderr.includes("CONNECT_TIMEOUT"));
});
test("schema 7 plan displays both fixed media stages without connecting QQ", async (t) => {
  const d = await dir(t);
  const config = join(d, "config.json");
  const scenarios = join(d, "media.json");
  await writeFile(config, JSON.stringify(baseConfig()));
  await writeFile(
    scenarios,
    JSON.stringify({
      schemaVersion: 7,
      cases: [
        {
          id: "media-private-delivery",
          kind: "media-private-delivery",
          chat: "private",
        },
      ],
    }),
  );
  const result = await run(["plan", "--config", config, "--scenarios", scenarios], d);
  assert.equal(result.code, 0, result.stderr);
  const plan = JSON.parse(result.stdout);
  assert.deepEqual(
    plan.mediaPlan.stages.map((s) => s.stage),
    ["image-1k", "video-4s"],
  );
  assert.ok(plan.mediaPlan.stages.every((s) => s.spec.chat === "private"));
  assert.equal(plan.mediaPlan.familyId, "media-private-delivery");
  assert.match(plan.suiteSha256, /^[a-f0-9]{64}$/);
});
test("media live entry rejects disabled fixtures and non-fixed selection before connecting", async (t) => {
  const d = await dir(t);
  const configPath = join(d, "config.json");
  const scenarios = join(d, "media.json");
  await writeFile(
    scenarios,
    JSON.stringify({
      schemaVersion: 7,
      cases: [
        {
          id: "media-private-delivery",
          kind: "media-private-delivery",
          chat: "private",
        },
      ],
    }),
  );
  for (const variant of [
    {
      selected: "media-private-delivery",
      config: baseConfig(),
      code: "MEDIA_FIXTURE_DISABLED",
    },
    { selected: "private", config: baseConfig(), code: "CASE_FAMILY_REQUIRED" },
    {
      selected: "media-private-delivery",
      config: {
        ...baseConfig(),
        maxMessages: 1,
        mediaFixtures: {
          enabled: true,
          retainAssetsConfirmed: true,
          timeoutMs: 1000,
        },
      },
      code: "MESSAGE_BUDGET",
    },
  ]) {
    await writeFile(configPath, JSON.stringify(variant.config));
    const result = await run(
      [
        "run",
        "--live",
        "--case",
        variant.selected,
        "--config",
        configPath,
        "--scenarios",
        scenarios,
        "--approve-suite",
        "invalid",
      ],
      d,
    );
    assert.equal(result.code, 2);
    assert.ok(result.stderr.includes(variant.code), result.stderr);
    assert.ok(!result.stderr.includes("CONNECT_TIMEOUT"));
  }
});
test("Linux live-run lock captures identity before opening and fsyncs the complete record", async (t) => {
  const d = await dir(t);
  const lockPath = join(d, "account.lock");
  const identity = {
    pid: 123,
    bootId: "01234567-1234-1234-1234-0123456789ab",
    startTicks: "456",
  };
  const order = [];
  const acquired = await acquireRunLock({
    lockPath,
    startedAt: "2026-10-06T00:00:00.000Z",
    identityRequired: true,
    platform: "linux",
    pid: 999,
    captureProcess: async () => {
      order.push("capture");
      await assert.rejects(stat(lockPath), { code: "ENOENT" });
      return identity;
    },
    openFile: async (...args) => {
      order.push("open");
      const file = await open(...args);
      return {
        stat: () => file.stat(),
        writeFile: (...writeArgs) => file.writeFile(...writeArgs),
        sync: async () => {
          order.push("file-sync");
          return file.sync();
        },
        close: () => file.close(),
      };
    },
    syncDirectoryFn: async () => order.push("directory-sync"),
  });
  assert.deepEqual(order, ["capture", "open", "file-sync", "directory-sync"]);
  assert.deepEqual(JSON.parse(await readFile(lockPath, "utf8")), {
    pid: identity.pid,
    startedAt: "2026-10-06T00:00:00.000Z",
    process: identity,
  });
  assert.deepEqual(acquired.processIdentity, identity);
  await acquired.lock.close();
});

test("Linux identity capture and lock persistence failures leave no half-lock", async (t) => {
  const d = await dir(t);
  const lockPath = join(d, "account.lock");
  await assert.rejects(
    acquireRunLock({
      lockPath,
      identityRequired: true,
      platform: "linux",
      captureProcess: async () => {
        throw Object.assign(new Error("capture failed"), {
          code: "MEMORY_PROCESS_BOOT",
        });
      },
    }),
    { code: "MEMORY_PROCESS_BOOT" },
  );
  await assert.rejects(stat(lockPath), { code: "ENOENT" });

  let closed = false;
  await assert.rejects(
    acquireRunLock({
      lockPath,
      identityRequired: true,
      platform: "linux",
      captureProcess: async () => ({
        pid: 123,
        bootId: "01234567-1234-1234-1234-0123456789ab",
        startTicks: "456",
      }),
      openFile: async (...args) => {
        const file = await open(...args);
        return {
          stat: () => file.stat(),
          writeFile: (...writeArgs) => file.writeFile(...writeArgs),
          sync: async () => {
            throw new Error("sync failed");
          },
          close: async () => {
            closed = true;
            return file.close();
          },
        };
      },
    }),
    { code: "RUN_LOCK_WRITE" },
  );
  assert.equal(closed, true);
  await assert.rejects(stat(lockPath), { code: "ENOENT" });
});

test("nonlive cross-platform lock keeps its legacy shape without process capture", async (t) => {
  const d = await dir(t);
  const lockPath = join(d, "account.lock");
  const acquired = await acquireRunLock({
    lockPath,
    startedAt: "2026-10-06T00:00:00.000Z",
    identityRequired: false,
    platform: "win32",
    captureProcess: async () => assert.fail("nonlive lock must not capture a Linux process"),
    syncDirectoryFn: async () => assert.fail("nonlive lock must not sync a Linux directory"),
  });
  assert.deepEqual(JSON.parse(await readFile(lockPath, "utf8")), {
    pid: process.pid,
    startedAt: "2026-10-06T00:00:00.000Z",
  });
  await acquired.lock.close();
});

test("Linux child-process lock records durable process identity for recovery checks", async (t) => {
  if (process.platform !== "linux") return;
  const d = await dir(t);
  const lockPath = join(d, "child.lock");
  const childScript = `
    import { acquireRunLock } from ${JSON.stringify(new URL("../cli.mjs", import.meta.url).href)};
    const lock = await acquireRunLock({ lockPath: ${JSON.stringify(lockPath)}, identityRequired: true });
    console.log(JSON.stringify(lock.processIdentity));
    process.stdin.once("data", async () => { await lock.lock.close(); process.exit(0); });
    process.stdin.resume();
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", childScript], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  let childExited = false;
  child.once("exit", () => {
    childExited = true;
  });
  t.after(() => {
    if (!childExited) child.kill("SIGKILL");
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
  child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
  const ready = await new Promise((resolve, reject) => {
    child.stdout.once("data", (chunk) => resolve(String(chunk).trim()));
    child.once("error", reject);
    child.once("exit", (code) =>
      reject(new Error(`child exited before lock ready: ${code} ${stderr}`)),
    );
  });
  const identity = JSON.parse(ready);
  const stored = JSON.parse(await readFile(lockPath, "utf8"));
  assert.equal(stored.pid, child.pid);
  assert.deepEqual(stored.process, identity);
  await assert.rejects(verifyMemoryProcessStopped(identity), {
    code: "MEMORY_PROCESS_RUNNING",
  });
  child.stdin.end("stop");
  const exitCode = await new Promise((resolve) => child.once("exit", resolve));
  assert.equal(exitCode, 0);
  assert.deepEqual(await verifyMemoryProcessStopped(identity), {
    stopped: true,
    reason: "process_absent",
    identity,
  });
});
test("delivery commands reject missing inputs and implicit merge before network access", async (t) => {
  const d = await dir(t);
  const configPath = join(d, "config.json");
  const out = join(d, "reports");
  await writeFile(configPath, JSON.stringify({ ...baseConfig(), runtime: {} }));
  const checked = await run(["delivery-check", "--config", configPath, "--out", out], d);
  assert.equal(checked.code, 2);
  assert.ok(checked.stderr.includes("DELIVERY_ARGUMENT"));
  const merged = await run(["deliver", "--config", configPath, "--out", out], d);
  assert.equal(merged.code, 2);
  assert.ok(merged.stderr.includes("LIVE_REQUIRED"));
  await assert.rejects(stat(out), { code: "ENOENT" });
});

test("init creates config and refuses overwriting", async (t) => {
  const d = await dir(t);
  const p = join(d, "c.json");
  assert.equal((await run(["init", "--config", p], d)).code, 0);
  assert.equal((await run(["init", "--config", p], d)).code, 2);
});
test("help requires no credentials or network", async (t) => {
  const d = await dir(t);
  assert.equal((await run(["help"], d)).code, 0);
});

test("reconcile-memory is a named command and requires enabled isolated fixture configuration", async (t) => {
  const d = await dir(t);
  const p = join(d, "c.json");
  await writeFile(p, JSON.stringify(baseConfig()));
  const result = await run(["reconcile-memory", "--config", p], d);
  assert.equal(result.code, 2);
  assert.match(result.stderr + result.stdout, /MEMORY_FIXTURE_DISABLED/);
  assert.doesNotMatch(result.stderr + result.stdout, /未知命令/);
  const helpResult = await run(["help"], d);
  assert.match(helpResult.stdout, /reconcile-memory --live --approve-suite/);
});
test("reconcile-taste is a named command and refuses recovery when fixture audit retention is disabled", async (t) => {
  const d = await dir(t);
  const p = join(d, "c.json");
  await writeFile(p, JSON.stringify(baseConfig()));
  const result = await run(["reconcile-taste", "--config", p], d);
  assert.equal(result.code, 2);
  assert.match(result.stderr + result.stdout, /MEMORY_FIXTURE_DISABLED/);
  assert.doesNotMatch(result.stderr + result.stdout, /未知命令/);
});
test("fixed Memory lifecycle plan exposes all steps without enabling writes", async (t) => {
  const d = await dir(t),
    p = join(d, "c.json");
  await writeFile(p, JSON.stringify(baseConfig()));
  const r = await run(["plan", "--case", "memory-lifecycle", "--config", p], d);
  assert.equal(r.code, 0);
  const plan = JSON.parse(r.stdout);
  assert.deepEqual(
    plan.stages.map((s) => s.stage),
    ["feedback", "promote", "expire"],
  );
  assert.ok(plan.stages[0].spec.prompt.includes("qqtest-{{fixture_nonce}}"));
  assert.ok(plan.stages[1].spec.prompt.includes("{{candidate_id}}"));
  assert.ok(plan.stages[2].spec.prompt.includes("{{memory_id}}"));
  assert.match(plan.suiteSha256, /^[a-f0-9]{64}$/);
  const blocked = await run(
    [
      "run",
      "--live",
      "--case",
      "memory-lifecycle",
      "--config",
      p,
      "--approve-suite",
      plan.suiteSha256,
    ],
    d,
  );
  assert.equal(blocked.code, 2);
  assert.ok(blocked.stderr.includes("FEATURE_RUNTIME_REQUIRED"));
});
test("fixed Taste lifecycle plan binds four exact feedback and governance steps", async (t) => {
  const d = await dir(t);
  const p = join(d, "taste-config.json");
  await writeFile(p, JSON.stringify(baseConfig()));
  const planned = await run(["plan", "--case", "taste-lifecycle", "--config", p], d);
  assert.equal(planned.code, 0);
  const plan = JSON.parse(planned.stdout);
  assert.equal(plan.familyId, "taste-project-feedback-lifecycle");
  assert.deepEqual(
    plan.stages.map((stage) => stage.id),
    ["taste-feedback", "taste-promote", "taste-negative-feedback", "taste-retire"],
  );
  assert.ok(plan.stages[0].prompt.includes("explicit_positive"));
  assert.ok(plan.stages[2].prompt.includes("explicit_negative"));
  assert.equal(plan.stages[0].inputConstraint.statement, "qqtest-taste-" + "0".repeat(32));
  assert.equal(plan.stages[3].inputConstraint.action, "promote");
  assert.deepEqual(plan.recovery, ["reject-candidate", "reject-correction", "expire-original"]);
  assert.match(plan.suiteSha256, /^[a-f0-9]{64}$/);
});
test("Taste lifecycle requires audit retention and blocks any account with pending Taste state", async (t) => {
  const d = await dir(t);
  const p = join(d, "taste-config.json");
  const out = join(d, "reports");
  const config = {
    ...baseConfig(),
    runtime: {},
    memoryFixtures: { enabled: true, retainAuditConfirmed: true },
  };
  await writeFile(p, JSON.stringify({ ...config, memoryFixtures: { enabled: true } }));
  const disabled = await run(
    ["run", "--live", "--case", "taste-lifecycle", "--config", p, "--out", out],
    d,
  );
  assert.equal(disabled.code, 2);
  assert.match(disabled.stderr + disabled.stdout, /MEMORY_FIXTURE_DISABLED/);

  await writeFile(p, JSON.stringify(config));
  const planned = JSON.parse(
    (await run(["plan", "--case", "taste-lifecycle", "--config", p], d)).stdout,
  );
  const lockRoot = join(d, ".glassbox-qq-live-locks");
  await mkdir(lockRoot, { recursive: true });
  const accountKey = digest(config.driver.qq).slice(0, 24);
  await writeFile(join(lockRoot, `${accountKey}.taste-pending.json`), "pending");
  const blocked = await run(
    [
      "run",
      "--live",
      "--case",
      "taste-lifecycle",
      "--config",
      p,
      "--out",
      out,
      "--approve-suite",
      planned.suiteSha256,
    ],
    d,
  );
  assert.equal(blocked.code, 2);
  const latest = JSON.parse(await readFile(join(out, "latest.json"), "utf8"));
  assert.equal(latest.error.code, "TASTE_RECONCILIATION_REQUIRED");
  assert.doesNotMatch(latest.error.code, /RUN_LOCKED/);
});
test("Memory fixture writes require explicit enablement before networking", async (t) => {
  const d = await dir(t),
    p = join(d, "c.json");
  await writeFile(p, JSON.stringify({ ...baseConfig(), runtime: {} }));
  const r = await run(["run", "--live", "--case", "memory-lifecycle", "--config", p], d);
  assert.equal(r.code, 2);
  assert.ok(r.stderr.includes("MEMORY_FIXTURE_DISABLED"));
});
test("fixed Memory lifecycle rejects changed approval, insufficient budget, and custom suites", async (t) => {
  const d = await dir(t),
    p = join(d, "c.json"),
    suite = join(d, "s.json");
  const config = {
    ...baseConfig(),
    runtime: {},
    memoryFixtures: { enabled: true, retainAuditConfirmed: true },
  };
  await writeFile(p, JSON.stringify(config));
  await writeFile(suite, "{}");
  const approved = JSON.parse(
    (await run(["plan", "--case", "memory-lifecycle", "--config", p], d)).stdout,
  ).suiteSha256;
  const wrong = await run(
    [
      "run",
      "--live",
      "--case",
      "memory-lifecycle",
      "--config",
      p,
      "--approve-suite",
      "0".repeat(64),
    ],
    d,
  );
  assert.equal(wrong.code, 2);
  assert.ok(wrong.stderr.includes("SUITE_APPROVAL"));
  await writeFile(p, JSON.stringify({ ...config, maxMessages: 2 }));
  const budget = await run(
    ["run", "--live", "--case", "memory-lifecycle", "--config", p, "--approve-suite", approved],
    d,
  );
  assert.equal(budget.code, 2);
  assert.ok(budget.stderr.includes("MESSAGE_BUDGET"));
  const mixed = await run(
    ["plan", "--case", "memory-lifecycle", "--config", p, "--scenarios", suite],
    d,
  );
  assert.equal(mixed.code, 2);
  assert.ok(mixed.stderr.includes("ARGUMENT"));
});
test("pending Memory fixtures block the account even with another report directory", async (t) => {
  const d = await dir(t),
    w = await world();
  t.after(() => w.close());
  const p = join(d, "c.json"),
    locks = join(d, ".glassbox-qq-live-locks");
  await writeFile(p, JSON.stringify(w.config));
  const suiteSha256 = JSON.parse((await run(["plan", "--config", p], d)).stdout).suiteSha256;
  await writeFile(p, JSON.stringify({ ...w.config, runtime: {} }));
  await mkdir(locks);
  const pending = join(locks, digest(w.config.driver.qq).slice(0, 24) + ".memory-pending.json");
  await writeFile(pending, "{}");
  const r = await run(
    [
      "run",
      "--live",
      "--approve-suite",
      suiteSha256,
      "--config",
      p,
      "--out",
      join(d, "different-reports"),
    ],
    d,
  );
  assert.equal(r.code, 2);
  assert.ok(
    JSON.parse(await readFile(join(d, "different-reports", "latest.json"), "utf8")).error.code ===
      "MEMORY_RECONCILIATION_REQUIRED",
  );
  assert.equal(w.actions.length, 0);
  assert.equal(await readFile(pending, "utf8"), "{}");
});
test("an incomplete pre-Run STOP archive blocks a new live CLI run before OneBot connects", async (t) => {
  const d = await dir(t);
  const w = await world();
  t.after(() => w.close());
  const configPath = join(d, "config.json");
  const out = join(d, "reports");
  const interrupted = join(out, "pre-run-stop-reconciliation", "2026-10-07T00-00-00.000Z_deadbeef");
  await writeFile(configPath, JSON.stringify(w.config));
  await mkdir(interrupted, { recursive: true, mode: 0o700 });
  const result = await run(["run", "--live", "--config", configPath, "--out", out], d);
  assert.equal(result.code, 2);
  assert.ok(result.stderr.includes("PRE_RUN_STOP_RECONCILIATION_REQUIRED"), result.stderr);
  assert.equal(w.actions.length, 0);
});
test("an incomplete pre-Run STOP archive blocks live delivery before merge", async (t) => {
  const d = await dir(t);
  const configPath = join(d, "config.json");
  const out = join(d, "reports");
  const interrupted = join(out, "pre-run-stop-reconciliation", "2026-10-07T00-00-00.000Z_deadbeef");
  await writeFile(configPath, JSON.stringify({ ...baseConfig(), runtime: {} }));
  await mkdir(interrupted, { recursive: true, mode: 0o700 });
  const result = await run(
    [
      "deliver",
      "--live",
      "--config",
      configPath,
      "--out",
      out,
      "--pr",
      "https://github.com/example/repo/pull/1",
      "--scenarios",
      "scenarios.json",
      "--reports",
      "reports.json",
      "--approve-suite",
      "a".repeat(64),
    ],
    d,
  );
  assert.equal(result.code, 2);
  assert.match(result.stderr, /PRE_RUN_STOP_RECONCILIATION_REQUIRED/);
});
test("default sends are blocked without runtime and identity-bound zero-tool approval", async (t) => {
  const d = await dir(t),
    w = await world();
  t.after(() => w.close());
  const p = join(d, "c.json"),
    out = join(d, "reports");
  await writeFile(p, JSON.stringify(w.config));
  const blocked = await run(["run", "--live", "--config", p, "--out", out], d);
  assert.equal(blocked.code, 2);
  assert.match(blocked.stderr, /TRANSPORT_RUNTIME_REQUIRED/);
  assert.equal(w.actions.length, 0);
  await writeFile(p, JSON.stringify({ ...w.config, runtime: {} }));
  const unapproved = await run(
    ["run", "--live", "--approve-suite", "0".repeat(64), "--config", p, "--out", out],
    d,
  );
  assert.equal(unapproved.code, 2);
  assert.match(unapproved.stderr, /SUITE_APPROVAL/);
  assert.equal(w.actions.length, 0);
});
test("transport suite rejects partial route selection before networking", async (t) => {
  const d = await dir(t);
  const w = await world();
  t.after(() => w.close());
  const p = join(d, "c.json"),
    out = join(d, "reports");
  await writeFile(p, JSON.stringify(w.config));
  for (const route of ["private", "group-A", "group-B"]) {
    const result = await run(["run", "--live", "--case", route, "--config", p, "--out", out], d);
    assert.equal(result.code, 2);
    assert.match(result.stderr, /TRANSPORT_SUITE_FIXED/);
  }
  assert.equal(w.driver.authCount, 0);
  assert.equal(w.bot.authCount, 0);
  await assert.rejects(stat(out), { code: "ENOENT" });
});
test("custom live prompts are blocked before any network operation", async (t) => {
  const d = await dir(t),
    p = join(d, "c.json"),
    suite = join(d, "s.json");
  await writeFile(p, JSON.stringify(baseConfig()));
  await writeFile(suite, "{}");
  const r = await run(["run", "--live", "--config", p, "--scenarios", suite], d);
  assert.equal(r.code, 2);
  assert.ok(r.stderr.includes("CUSTOM_LIVE_UNSUPPORTED"));
});
test("structured read suite plans locally but cannot run without runtime identity", async (t) => {
  const d = await dir(t),
    p = join(d, "c.json"),
    suite = join(d, "s.json");
  await writeFile(p, JSON.stringify(baseConfig()));
  await writeFile(
    suite,
    JSON.stringify({
      schemaVersion: 2,
      cases: [
        {
          id: "ops-read",
          chat: "private",
          prompt: "查询 ops_status 并回复 {{nonce}}",
          expectContains: ["{{nonce}}"],
          sideEffect: "none",
          leaseTools: [
            {
              name: "ops_status",
              operations: [
                {
                  action: "ops:status",
                  resourceId: "agent-operations",
                  inputConstraint: {},
                },
              ],
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
        },
      ],
    }),
  );
  const planned = await run(["plan", "--config", p, "--scenarios", suite], d);
  assert.equal(planned.code, 0, planned.stderr);
  assert.match(JSON.parse(planned.stdout).suiteSha256, /^[a-f0-9]{64}$/);
  const blocked = await run(["run", "--live", "--config", p, "--scenarios", suite], d);
  assert.equal(blocked.code, 2);
  assert.ok(blocked.stderr.includes("FEATURE_RUNTIME_REQUIRED"));
});

test("schema 3 Memory family hashes original suite bytes and plans without network access", async (t) => {
  const d = await dir(t);
  const configPath = join(d, "c.json");
  const suitePath = join(d, "memory-suite.json");
  const suiteText = `{
  "schemaVersion": 3,
  "cases": [
    {
      "id": "memory-project-promote-expire",
      "kind": "memory-lifecycle",
      "workflow": "promote-expire",
      "chat": "private"
    }
  ]
}
`;
  await writeFile(configPath, JSON.stringify(baseConfig()));
  await writeFile(suitePath, suiteText);

  const planResult = await run(
    ["plan", "--config", configPath, "--scenarios", suitePath, "--out", join(d, "plan-out")],
    d,
  );
  assert.equal(planResult.code, 0);
  const plan = JSON.parse(planResult.stdout);
  assert.equal(plan.suiteSha256, digest(suiteText));
  assert.deepEqual(plan.cases, [
    {
      id: "memory-project-promote-expire",
      kind: "memory-lifecycle",
      workflow: "promote-expire",
      chat: "private",
    },
  ]);
  assert.deepEqual(
    plan.memoryPlan.stages.map((stage) => stage.stage),
    ["feedback", "promote", "expire"],
  );
});

test("schema 3 plans both fixed Memory families with original suite approval", async (t) => {
  const d = await dir(t);
  const configPath = join(d, "c.json");
  const suitePath = join(d, "families.json");
  const suiteText = JSON.stringify({
    schemaVersion: 3,
    cases: [
      {
        id: "memory-project-promote-expire",
        kind: "memory-lifecycle",
        workflow: "promote-expire",
        chat: "private",
      },
      {
        id: "memory-project-feedback-reject",
        kind: "memory-lifecycle",
        workflow: "feedback-reject",
        chat: "private",
      },
    ],
  });
  await writeFile(configPath, JSON.stringify(baseConfig()));
  await writeFile(suitePath, suiteText);
  const result = await run(["plan", "--config", configPath, "--scenarios", suitePath], d);
  assert.equal(result.code, 0, result.stderr);
  const plan = JSON.parse(result.stdout);
  assert.equal(plan.suiteSha256, digest(suiteText));
  assert.deepEqual(
    plan.memoryPlans.map(({ plan }) => plan.stages.map(({ stage }) => stage)),
    [
      ["feedback", "promote", "expire"],
      ["feedback", "reject"],
    ],
  );
});

test("schema 3 reject family blocks a one-message budget before network", async (t) => {
  const d = await dir(t);
  const configPath = join(d, "c.json");
  const suitePath = join(d, "reject.json");
  const suiteText = JSON.stringify({
    schemaVersion: 3,
    cases: [
      {
        id: "memory-project-feedback-reject",
        kind: "memory-lifecycle",
        workflow: "feedback-reject",
        chat: "private",
      },
    ],
  });
  await writeFile(
    configPath,
    JSON.stringify({
      ...baseConfig(),
      runtime: {},
      maxMessages: 1,
      memoryFixtures: { enabled: true, retainAuditConfirmed: true },
    }),
  );
  await writeFile(suitePath, suiteText);
  const out = join(d, "out");
  const result = await run(
    [
      "run",
      "--live",
      "--config",
      configPath,
      "--scenarios",
      suitePath,
      "--case",
      "memory-project-feedback-reject",
      "--approve-suite",
      digest(suiteText),
      "--out",
      out,
    ],
    d,
  );
  assert.equal(result.code, 2);
  assert.match(result.stderr + result.stdout, /MESSAGE_BUDGET/);
  await assert.rejects(stat(out), { code: "ENOENT" });
});

test("schema 3 Memory run rejects missing case, approval, fixture enablement and message budget before network", async (t) => {
  const d = await dir(t);
  const configPath = join(d, "c.json");
  const suitePath = join(d, "memory-suite.json");
  const out = join(d, "run-out");
  const suiteText = JSON.stringify({
    schemaVersion: 3,
    cases: [
      {
        id: "memory-project-promote-expire",
        kind: "memory-lifecycle",
        workflow: "promote-expire",
        chat: "private",
      },
    ],
  });
  const suiteSha256 = digest(suiteText);
  const config = {
    ...baseConfig(),
    runtime: {},
    memoryFixtures: { enabled: true, retainAuditConfirmed: true },
  };
  await writeFile(configPath, JSON.stringify(config));
  await writeFile(suitePath, suiteText);
  const common = ["run", "--live", "--config", configPath, "--scenarios", suitePath, "--out", out];

  const missingCase = await run([...common, "--approve-suite", suiteSha256], d);
  assert.equal(missingCase.code, 2);
  assert.match(missingCase.stderr + missingCase.stdout, /CASE_FAMILY_REQUIRED/);

  const chosen = [...common, "--case", "memory-project-promote-expire"];
  const wrongApproval = await run([...chosen, "--approve-suite", "0".repeat(64)], d);
  assert.equal(wrongApproval.code, 2);
  assert.match(wrongApproval.stderr + wrongApproval.stdout, /SUITE_APPROVAL/);

  await writeFile(
    configPath,
    JSON.stringify({
      ...config,
      memoryFixtures: { enabled: false, retainAuditConfirmed: true },
    }),
  );
  const disabled = await run([...chosen, "--approve-suite", suiteSha256], d);
  assert.equal(disabled.code, 2);
  assert.match(disabled.stderr + disabled.stdout, /MEMORY_FIXTURE_DISABLED/);

  await writeFile(configPath, JSON.stringify({ ...config, maxMessages: 2 }));
  const insufficientBudget = await run([...chosen, "--approve-suite", suiteSha256], d);
  assert.equal(insufficientBudget.code, 2);
  assert.match(insufficientBudget.stderr + insufficientBudget.stdout, /MESSAGE_BUDGET/);

  await assert.rejects(stat(out), { code: "ENOENT" });
});

test("schema 3 Memory plan rejects custom family fields before network access", async (t) => {
  const d = await dir(t);
  const configPath = join(d, "c.json");
  const suitePath = join(d, "memory-suite.json");
  await writeFile(configPath, JSON.stringify(baseConfig()));
  await writeFile(
    suitePath,
    JSON.stringify({
      schemaVersion: 3,
      cases: [
        {
          id: "memory-project-promote-expire",
          kind: "memory-lifecycle",
          workflow: "promote-expire",
          chat: "private",
          prompt: "custom command {{nonce}}",
        },
      ],
    }),
  );
  const out = join(d, "invalid-out");
  const result = await run(
    ["plan", "--config", configPath, "--scenarios", suitePath, "--out", out],
    d,
  );
  assert.equal(result.code, 2);
  assert.match(result.stderr + result.stdout, /FEATURE_MEMORY_FAMILY/);
  await assert.rejects(stat(out), { code: "ENOENT" });
});
test("default feature inventory reports unimplemented executable coverage without credentials", async (t) => {
  const d = await dir(t),
    result = await run(["coverage"], d);
  assert.equal(result.code, 2, result.stderr);
  assert.equal(JSON.parse(result.stdout).status, "BLOCKED");
  assert.ok(JSON.parse(result.stdout).gaps.some((g) => g.code === "CASE_NOT_EXECUTABLE"));
});
test("history plan resolves the configured group but approves the original suite bytes", async (t) => {
  const d = await dir(t),
    configPath = join(d, "c.json"),
    suitePath = join(d, "s.json");
  await writeFile(configPath, JSON.stringify(baseConfig()));
  const suiteText = JSON.stringify({
    schemaVersion: 2,
    cases: [
      {
        id: "history-test",
        chat: "A",
        prompt: "帮我查找群里的 gbxhistory1-{{nonce}}，只返回一条结果。",
        expectContains: ["{{nonce}}"],
        sideEffect: "none",
        leaseTools: [
          {
            name: "group_history_search",
            operations: [
              {
                action: "history:read",
                resourceId: "group:{{group:A}}",
                inputConstraint: { query: "gbxhistory1-{{nonce}}", limit: 1 },
              },
            ],
          },
        ],
        featureAssertions: [
          {
            kind: "trace",
            type: "tool_result",
            where: { name: "group_history_search", isError: false },
            count: 1,
          },
          {
            kind: "trace",
            type: "history_retrieval",
            where: {
              query: "gbxhistory1-{{nonce}}",
              groups: ["{{group:A}}"],
              resources: ["group:{{group:A}}"],
              sourceKind: "channel_message",
              retrievalMode: "lexical",
            },
            count: 1,
          },
        ],
      },
    ],
  });
  await writeFile(suitePath, suiteText);
  const planned = await run(["plan", "--config", configPath, "--scenarios", suitePath], d);
  assert.equal(planned.code, 0, planned.stderr);
  const plan = JSON.parse(planned.stdout);
  assert.equal(plan.suiteSha256, digest(suiteText));
  assert.equal(plan.cases[0].leaseTools[0].operations[0].resourceId, "group:20001");
  assert.deepEqual(plan.cases[0].featureAssertions[1].where.groups, ["20001"]);
  assert.equal(plan.cases[0].featureAssertions[1].where.query, "gbxhistory1-{{nonce}}");
});
test("invalid configuration blocks before networking", async (t) => {
  const d = await dir(t);
  const p = join(d, "c.json");
  await writeFile(p, '{"schemaVersion":1}');
  assert.equal((await run(["doctor", "--config", p], d)).code, 2);
});
test("transport plan fixes the three zero-tool cases and binds identities into approval", async (t) => {
  const d = await dir(t);
  const p = join(d, "c.json");
  const config = baseConfig();
  await writeFile(p, JSON.stringify(config));
  const planned = await run(["plan", "--case", "transport-smoke", "--config", p], d);
  assert.equal(planned.code, 0, planned.stderr);
  const plan = JSON.parse(planned.stdout);
  assert.equal(plan.transportOnly, true);
  assert.equal(plan.familyId, "qq-transport-smoke");
  assert.deepEqual(
    plan.cases.map((c) => [c.id, c.chat, c.leaseTools]),
    [
      ["transport-private", "private", []],
      ["transport-group-A", "A", []],
      ["transport-group-B", "B", []],
    ],
  );
  assert.match(plan.suiteSha256, /^[a-f0-9]{64}$/);

  const changed = {
    ...config,
    groups: [config.groups[0], { ...config.groups[1], id: "20009" }],
  };
  await writeFile(p, JSON.stringify(changed));
  const replanned = await run(["plan", "--config", p], d);
  assert.notEqual(JSON.parse(replanned.stdout).suiteSha256, plan.suiteSha256);
});

test("transport run rejects missing runtime and approval before creating output or connecting", async (t) => {
  const d = await dir(t);
  const w = await world();
  t.after(() => w.close());
  const p = join(d, "c.json"),
    out = join(d, "reports");
  await writeFile(p, JSON.stringify(w.config));
  const noRuntime = await run(["run", "--live", "--config", p, "--out", out], d);
  assert.equal(noRuntime.code, 2);
  assert.match(noRuntime.stderr, /TRANSPORT_RUNTIME_REQUIRED/);
  await assert.rejects(stat(out), { code: "ENOENT" });
  assert.equal(w.driver.authCount, 0);
  assert.equal(w.bot.authCount, 0);

  const plan = JSON.parse((await run(["plan", "--config", p], d)).stdout);
  await writeFile(p, JSON.stringify({ ...w.config, runtime: {} }));
  const noApproval = await run(["run", "--live", "--config", p, "--out", out], d);
  assert.equal(noApproval.code, 2);
  assert.match(noApproval.stderr, /SUITE_APPROVAL/);
  await assert.rejects(stat(out), { code: "ENOENT" });
  assert.equal(w.driver.authCount, 0);
  assert.equal(w.bot.authCount, 0);

  const missingRuntime = await run(
    ["run", "--live", "--approve-suite", plan.suiteSha256, "--config", p, "--out", out],
    d,
  );
  assert.equal(missingRuntime.code, 2);
  const blockedReport = JSON.parse(await readFile(join(out, "latest.json"), "utf8"));
  assert.equal(blockedReport.error.code, "RUNTIME_CONFIG");
  assert.equal(w.driver.authCount, 0);
  assert.equal(w.bot.authCount, 0);
  const explicitFamily = await run(
    [
      "run",
      "--case",
      "transport-smoke",
      "--live",
      "--approve-suite",
      plan.suiteSha256,
      "--config",
      p,
      "--out",
      out,
    ],
    d,
  );
  assert.equal(explicitFamily.code, 2);
  const explicitReport = JSON.parse(await readFile(join(out, "latest.json"), "utf8"));
  assert.equal(explicitReport.error.code, "RUNTIME_CONFIG");
  assert.doesNotMatch(explicitFamily.stderr, /CASE_NOT_FOUND/);
  assert.equal(w.driver.authCount, 0);
  assert.equal(w.bot.authCount, 0);
});
test("STOP file blocks all outgoing messages", async (t) => {
  const d = await dir(t);
  const w = await world();
  t.after(() => w.close());
  const p = join(d, "c.json"),
    out = join(d, "reports");
  await writeFile(p, JSON.stringify(w.config));
  const suiteSha256 = JSON.parse((await run(["plan", "--config", p], d)).stdout).suiteSha256;
  await writeFile(p, JSON.stringify({ ...w.config, runtime: {} }));
  await mkdir(out);
  await writeFile(join(out, "STOP"), "stop");
  const r = await run(
    ["run", "--live", "--approve-suite", suiteSha256, "--config", p, "--out", out],
    d,
  );
  assert.equal(r.code, 2);
  assert.equal(w.actions.length, 0);
});
test("missing --live is not silently accepted", async (t) => {
  const d = await dir(t);
  const p = join(d, "c.json");
  await writeFile(p, JSON.stringify(baseConfig()));
  const r = await run(["run", "--config", p], d);
  assert.equal(r.code, 2);
  assert.ok(r.stderr.includes("LIVE_REQUIRED"));
});
test("unknown case cannot produce an empty pass", async (t) => {
  const d = await dir(t);
  const p = join(d, "c.json");
  await writeFile(p, JSON.stringify(baseConfig()));
  const r = await run(["run", "--live", "--case", "unknown", "--config", p], d);
  assert.equal(r.code, 2);
  assert.ok(r.stderr.includes("CASE_NOT_FOUND"));
});
test("moderation live command is blocked before creating files or connecting", async (t) => {
  const d = await dir(t);
  const w = await world({ mode: "pretend" });
  t.after(() => w.close());
  const p = join(d, "c.json"),
    out = join(d, "reports");
  await writeFile(p, JSON.stringify(w.config));
  const r = await run(["run", "--live", "--case", "moderation", "--config", p, "--out", out], d);
  assert.equal(r.code, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /MODERATION_LEASE_UNSUPPORTED/);
  await assert.rejects(stat(out), { code: "ENOENT" });
  assert.equal(w.driver.authCount, 0);
  assert.equal(w.bot.authCount, 0);
});

test("fixed moderation plan is reviewable locally and run requires a source pin before connecting", async (t) => {
  const d = await dir(t);
  const w = await world({ mode: "pretend" });
  t.after(() => w.close());
  const config = {
    ...w.config,
    groups: [w.config.groups[0], { alias: "B", id: "1126022432" }],
    runtime: {
      checkout: d,
      dataDirectory: join(d, "data"),
      expectedCommit: "a".repeat(40),
      connectionId: "qq-main",
    },
    moderation: {
      ...w.config.moderation,
      enabled: true,
      group: "B",
      target: "10003",
      consentConfirmed: true,
      consentConfirmedAt: new Date().toISOString(),
      consentUntil: new Date(Date.now() + 60 * 60_000).toISOString(),
      durationSeconds: 45,
    },
  };
  const path = join(d, "config.json");
  await writeFile(path, JSON.stringify(config));
  const result = await run(["plan", "--config", path, "--case", "qq-group-moderation-exact-b"], d);
  assert.equal(result.code, 0, result.stderr);
  const plan = JSON.parse(result.stdout);
  assert.equal(plan.familyId, "qq-group-moderation-exact-b");
  assert.equal(plan.plan.groupId, "1126022432");
  assert.deepEqual(
    plan.plan.stages.map((entry) => entry.stage),
    ["mute", "unmute"],
  );
  assert.equal(plan.plan.durationSeconds, 45);
  assert.match(plan.suiteSha256, /^[a-f0-9]{64}$/u);
  const blockedRun = await run(
    [
      "run",
      "--live",
      "--config",
      path,
      "--case",
      "qq-group-moderation-exact-b",
      "--approve-suite",
      plan.suiteSha256,
      "--out",
      join(d, "reports"),
    ],
    d,
  );
  assert.equal(blockedRun.code, 2);
  assert.match(blockedRun.stderr, /MODERATION_RUNTIME_SOURCE_REQUIRED/);
  await assert.rejects(stat(join(d, "reports")), { code: "ENOENT" });
  assert.equal(w.driver.authCount, 0);
  assert.equal(w.bot.authCount, 0);
});

test("fixed moderation run rejects stale consent and undersized message budget before connecting", async (t) => {
  const d = await dir(t);
  const w = await world({ mode: "pretend" });
  t.after(() => w.close());
  const config = {
    ...w.config,
    groups: [w.config.groups[0], { alias: "B", id: "1126022432" }],
    runtime: {
      checkout: d,
      dataDirectory: join(d, "data"),
      expectedCommit: "a".repeat(40),
      connectionId: "qq-main",
    },
    moderation: {
      ...w.config.moderation,
      enabled: true,
      group: "B",
      target: "10003",
      consentConfirmed: true,
      consentConfirmedAt: new Date(Date.now() - 16 * 60_000).toISOString(),
      consentUntil: new Date(Date.now() + 60 * 60_000).toISOString(),
    },
  };
  const path = join(d, "config.json");
  await writeFile(path, JSON.stringify(config));
  const result = await run(
    [
      "run",
      "--live",
      "--config",
      path,
      "--case",
      "qq-group-moderation-exact-b",
      "--approve-suite",
      "a".repeat(64),
    ],
    d,
  );
  assert.equal(result.code, 2);
  assert.match(result.stderr, /MODERATION_SCENARIO/);
  assert.equal(w.driver.authCount, 0);
  assert.equal(w.bot.authCount, 0);
});

test("an unfinished moderation guard blocks live delivery before merge or network access", async (t) => {
  const d = await dir(t);
  const w = await world({ mode: "pretend" });
  t.after(() => w.close());
  const configPath = join(d, "config.json");
  await writeFile(configPath, JSON.stringify(w.config));
  const { createHash } = await import("node:crypto");
  const account = createHash("sha256").update(w.config.driver.qq).digest("hex").slice(0, 24);
  const lockDirectory = join(d, ".glassbox-qq-live-locks");
  await import("node:fs/promises").then(({ mkdir }) => mkdir(lockDirectory, { mode: 0o700 }));
  await writeFile(join(lockDirectory, `${account}.moderation-pending.json`), "pending\n", {
    mode: 0o600,
  });
  const result = await run(["deliver", "--live", "--config", configPath, "--pr", "123"], d);
  assert.equal(result.code, 3);
  assert.match(result.stderr, /MODERATION_RECONCILIATION_REQUIRED/);
  assert.equal(w.driver.authCount, 0);
  assert.equal(w.bot.authCount, 0);
});

test("history family plan exposes fixed seed and evidence-derived recall without network", async (t) => {
  const d = await dir(t),
    p = join(d, "config.json"),
    suite = join(d, "history-suite.json");
  await writeFile(p, JSON.stringify(baseConfig()));
  await writeFile(
    suite,
    JSON.stringify({
      schemaVersion: 4,
      cases: [
        {
          id: "history-group-seed-private-recall",
          kind: "history-seed",
          chat: "A",
        },
      ],
    }),
  );
  const r = await run(["plan", "--config", p, "--scenarios", suite], d);
  assert.equal(r.code, 0, r.stderr);
  const plan = JSON.parse(r.stdout);
  assert.deepEqual(
    plan.historyPlan.stages.map((s) => s.stage),
    ["seed", "recall"],
  );
  assert.equal(plan.historyPlan.stages[0].spec.chat, "A");
  assert.match(plan.historyPlan.stages[1].note, /verified seed/);
  assert.match(plan.suiteSha256, /^[a-f0-9]{64}$/);
});

test("isolation family plan exposes B seed and A-only exclusion without network", async (t) => {
  const d = await dir(t),
    p = join(d, "config.json"),
    suite = join(d, "isolation-suite.json");
  await writeFile(p, JSON.stringify(baseConfig()));
  await writeFile(
    suite,
    JSON.stringify({
      schemaVersion: 5,
      cases: [
        {
          id: "history-cross-group-isolation",
          kind: "history-isolation",
          chat: "B",
        },
      ],
    }),
  );
  const r = await run(["plan", "--config", p, "--scenarios", suite], d);
  assert.equal(r.code, 0, r.stderr);
  const plan = JSON.parse(r.stdout);
  assert.deepEqual(
    plan.historyIsolationPlan.stages.map((s) => s.stage),
    ["seed", "exclusion"],
  );
  assert.equal(plan.historyIsolationPlan.stages[0].spec.chat, "B");
  assert.match(plan.historyIsolationPlan.stages[1].note, /group A/);
  assert.match(plan.suiteSha256, /^[a-f0-9]{64}$/);
  const unselected = await run(["run", "--live", "--config", p, "--scenarios", suite], d);
  assert.equal(unselected.code, 2);
  assert.match(unselected.stdout + unselected.stderr, /CASE_FAMILY_REQUIRED/);
});
