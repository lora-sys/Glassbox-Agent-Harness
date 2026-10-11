import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { runModerationNoEffectRecoveryCli } from "../cli.mjs";

const cli = fileURLToPath(new URL("../cli.mjs", import.meta.url));
const approved = "a".repeat(64);
const planned = {
  status: "MODERATION_KNOWN_NO_EFFECT_RECOVERY_PLANNED",
  plan: { kind: "qq-live-moderation-known-no-effect-recovery" },
  planSha256: approved,
};

function clients() {
  const counts = { driverConnect: 0, botConnect: 0, driverClose: 0, botClose: 0 };
  return {
    counts,
    value: {
      driver: {
        async connect() {
          counts.driverConnect += 1;
        },
        close() {
          counts.driverClose += 1;
        },
      },
      bot: {
        async connect() {
          counts.botConnect += 1;
        },
        close() {
          counts.botClose += 1;
        },
      },
    },
  };
}

async function directory(t) {
  const path = await mkdtemp(join(tmpdir(), "qq-live-moderation-cli-"));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

test("moderation reconciliation defaults to a read-only plan and closes both clients", async (t) => {
  const dir = await directory(t);
  const clientSet = clients();
  let archived = false;
  const result = await runModerationNoEffectRecoveryCli(
    {},
    { reportPath: join(dir, "report.json") },
    {
      clients: clientSet.value,
      recovery: {
        async planModerationKnownNoEffectRecovery(input) {
          assert.equal(input.reportPath, join(dir, "report.json"));
          assert.equal(input.clients, clientSet.value);
          return planned;
        },
        async archiveModerationKnownNoEffectRecovery() {
          archived = true;
          throw new Error("archive must not run for a plan");
        },
      },
    },
  );
  assert.deepEqual(result, planned);
  assert.equal(archived, false);
  assert.deepEqual(clientSet.counts, {
    driverConnect: 1,
    botConnect: 1,
    driverClose: 1,
    botClose: 1,
  });
});

test("live moderation reconciliation requires the exact reviewed plan before archiving", async (t) => {
  const dir = await directory(t);
  const clientSet = clients();
  let archiveCalls = 0;
  const recovery = {
    async planModerationKnownNoEffectRecovery() {
      return planned;
    },
    async archiveModerationKnownNoEffectRecovery(args, options) {
      archiveCalls += 1;
      assert.equal(args.planSha256, approved);
      assert.equal(options.approvedPlanSha256, approved);
      return { status: "ARCHIVE_VERIFIED", cleanupOnly: true, featurePass: false };
    },
  };
  await assert.rejects(
    runModerationNoEffectRecoveryCli(
      {},
      {
        reportPath: join(dir, "report.json"),
        live: true,
        approvedPlanSha256: "b".repeat(64),
      },
      { clients: clientSet.value, recovery },
    ),
    /计划已变化/,
  );
  assert.equal(archiveCalls, 0);
  assert.deepEqual(clientSet.counts, {
    driverConnect: 1,
    botConnect: 1,
    driverClose: 1,
    botClose: 1,
  });

  const result = await runModerationNoEffectRecoveryCli(
    {},
    {
      reportPath: join(dir, "report.json"),
      live: true,
      approvedPlanSha256: approved,
    },
    { clients: clientSet.value, recovery },
  );
  assert.equal(result.status, "ARCHIVE_VERIFIED");
  assert.equal(result.cleanupOnly, true);
  assert.equal(result.featurePass, false);
  assert.equal(archiveCalls, 1);
  assert.deepEqual(clientSet.counts, {
    driverConnect: 2,
    botConnect: 2,
    driverClose: 2,
    botClose: 2,
  });
});

test("moderation recovery rejects missing approval and non-absolute report before creating clients", async () => {
  let clientsCreated = false;
  const dependencies = {
    get clients() {
      clientsCreated = true;
      return clients().value;
    },
    recovery: {},
  };
  await assert.rejects(
    runModerationNoEffectRecoveryCli(
      {},
      { reportPath: "/tmp/report.json", live: true },
      dependencies,
    ),
    /SHA256/,
  );
  await assert.rejects(
    runModerationNoEffectRecoveryCli({}, { reportPath: "relative/report.json" }, dependencies),
    /绝对报告路径/,
  );
  assert.equal(clientsCreated, false);
});

test("CLI requires an absolute source report and explicit approval for archive", async (t) => {
  const dir = await directory(t);
  const result = spawnSync(
    process.execPath,
    [cli, "reconcile-moderation", "--report", resolve(dir, "report.json"), "--live"],
    {
      cwd: dir,
      encoding: "utf8",
      env: { ...process.env, HOME: dir, USERPROFILE: dir },
    },
  );
  assert.equal(result.status, 2);
  assert.match(result.stderr, /ARGUMENT/);
  assert.doesNotMatch(result.stderr, /CONFIG_READ|CONNECT_TIMEOUT/);
});
