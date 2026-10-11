import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  applyMediaDeliveryGapCleanup,
  hasUnresolvedMediaDeliveryGapCleanup,
  planMediaDeliveryGapCleanup,
} from "../lib/media-delivery-gap-cleanup.mjs";

const sha = (value) => createHash("sha256").update(value).digest("hex");
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
const stopContent =
  "CLEANUP_UNCONFIRMED\n请先检查 Bot 的延迟任务、目标状态和本轮报告，再人工删除此文件。\n";

function fingerprint(stat) {
  return {
    dev: stat.dev,
    ino: stat.ino,
    mode: stat.mode,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
  };
}

async function fixture(t, { afterEvidenceFails = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), "media-delivery-gap-cleanup-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const out = join(root, "out");
  const locksDirectory = join(root, "locks");
  const reportRunId = "2026-10-07T14-53-57.389Z_821f79c8";
  const reportDirectory = join(out, reportRunId);
  await mkdir(reportDirectory, { recursive: true, mode: 0o700 });
  await mkdir(locksDirectory, { mode: 0o700 });
  const reportPath = join(reportDirectory, "report.json");
  const latestPath = join(out, "latest.json");
  const checkpointPath = join(reportDirectory, "media-fixture.jsonl");
  const config = {
    driver: { qq: "20002" },
    bot: { qq: "10001" },
    runtime: { connectionId: "fixture", threadId: null },
  };
  const driverSha256 = sha(config.driver.qq);
  const runtime = {
    checkout: "/fixture/checkout",
    dataDirectory: join(root, "data"),
    commit: "a".repeat(40),
    development: true,
    sourceTreeSha256: "b".repeat(64),
    pid: 1234,
    connectionId: "fixture",
    threadId: null,
  };
  const report = {
    runId: reportRunId,
    reportDirectory,
    mode: "run",
    status: "BLOCKED",
    productAcceptance: { status: "BLOCKED", code: "NOT_CHECKED" },
  };
  const latest = {
    runId: reportRunId,
    reportDirectory,
    mode: "run",
    status: "BLOCKED",
    productAcceptance: report.productAcceptance,
  };
  const checkpoint = `${JSON.stringify({ phase: "intent" })}\n${JSON.stringify({ phase: "lease_intent" })}\n${JSON.stringify({ phase: "send_intent" })}\n${JSON.stringify({ phase: "sent" })}\n`;
  const accountKey = sha(config.driver.qq).slice(0, 24);
  const pendingPath = join(locksDirectory, `${accountKey}.media-pending.json`);
  const stopPath = join(out, "STOP");
  await Promise.all(
    [
      [reportPath, JSON.stringify(report)],
      [latestPath, JSON.stringify(latest)],
      [checkpointPath, checkpoint],
      [pendingPath, '{"phase":"sent"}\n'],
      [stopPath, stopContent],
    ].map(async ([path, content]) => {
      await writeFile(path, content, { mode: 0o600 });
      await chmod(path, 0o600);
    }),
  );
  const planStatic = async () => {
    const files = {};
    for (const [key, path] of Object.entries({
      report: reportPath,
      latest: latestPath,
      checkpoint: checkpointPath,
      pending: pendingPath,
      stop: stopPath,
    })) {
      const bytes = await readFile(path);
      files[key] = { sha256: sha(bytes), fingerprint: fingerprint(await lstat(path)) };
    }
    const snapshot = {
      schemaVersion: 1,
      kind: "qq-live-media-image-prefix-recovery",
      out,
      locksDirectory,
      reportPath,
      reportSha256: files.report.sha256,
      reportFingerprint: files.report.fingerprint,
      latestPath,
      latestSha256: files.latest.sha256,
      latestFingerprint: files.latest.fingerprint,
      checkpointPath,
      checkpointSha256: files.checkpoint.sha256,
      checkpointFingerprint: files.checkpoint.fingerprint,
      pendingPath,
      pendingSha256: files.pending.sha256,
      pendingFingerprint: files.pending.fingerprint,
      stopPath,
      stopSha256: files.stop.sha256,
      stopFingerprint: files.stop.fingerprint,
      reportRunId,
      driverSha256,
      runtime,
      process: {
        pid: 1234,
        bootId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        startTicks: "123456",
      },
      caseId: "media-image-1k",
      suiteSha256: sha("suite"),
      stage: "image-1k",
    };
    const planSource = {
      reportPath: snapshot.reportPath,
      reportSha256: snapshot.reportSha256,
      reportFingerprint: snapshot.reportFingerprint,
      latestPath: snapshot.latestPath,
      latestSha256: snapshot.latestSha256,
      latestFingerprint: snapshot.latestFingerprint,
      checkpointPath: snapshot.checkpointPath,
      checkpointSha256: snapshot.checkpointSha256,
      checkpointFingerprint: snapshot.checkpointFingerprint,
      pendingPath: snapshot.pendingPath,
      pendingSha256: snapshot.pendingSha256,
      pendingFingerprint: snapshot.pendingFingerprint,
      stopPath: snapshot.stopPath,
      stopSha256: snapshot.stopSha256,
      stopFingerprint: snapshot.stopFingerprint,
      driverSha256: snapshot.driverSha256,
      runtime: snapshot.runtime,
      process: snapshot.process,
      reportRunId: snapshot.reportRunId,
      caseId: snapshot.caseId,
      suiteSha256: snapshot.suiteSha256,
      stage: snapshot.stage,
    };
    return { ...snapshot, planSha256: sha(canonical(planSource)) };
  };
  let evidenceCalls = 0;
  const cleanupEvidence = {
    status: "MEDIA_DELIVERY_GAP_CLEANUP_VERIFIED",
    cleanupOnly: true,
    featureStatus: "INCONCLUSIVE",
    productRunId: "48e5c10f-848b-4796-8cdf-a16605b6ce8b",
    productRunStatus: "succeeded",
    caseId: "media-image-1k",
    stage: "image-1k",
    leaseId: "11111111-1111-4111-8111-111111111111",
    toolsSha256: "c".repeat(64),
    cleanup: {
      leaseRevoked: true,
      dualAccountTextAndMediaReadsVerified: true,
      missingMediaDeliveryTraceWitness: true,
      taskWorkerScheduleResidue: {
        tasks: 0,
        taskAttemptRuns: 0,
        workerBindings: 0,
        workerLaunchIntents: 0,
        schedules: 0,
      },
    },
  };
  const overrides = {
    planMediaImageRecovery: async () => ({
      status: "MEDIA_RECOVERY_PLANNED",
      plan: await planStatic(),
    }),
    verifyMediaImageDeliveryGapEvidence: async () => {
      evidenceCalls++;
      if (afterEvidenceFails && evidenceCalls >= 3)
        throw Object.assign(new Error("post archive verification failed"), {
          code: "MEDIA_CLEANUP_POSTCHECK",
        });
      return structuredClone(cleanupEvidence);
    },
  };
  return {
    out,
    locksDirectory,
    reportRunId,
    reportPath,
    pendingPath,
    stopPath,
    config,
    runtime,
    input: {
      reportPath,
      config,
      expectedRuntime: runtime,
      clients: { driver: {}, bot: {} },
      locksDirectory,
    },
    overrides,
    cleanupEvidence,
    get evidenceCalls() {
      return evidenceCalls;
    },
  };
}

test("cleanup-only archive preserves the failed feature status and releases only exact guards", async (t) => {
  const f = await fixture(t);
  const planned = await planMediaDeliveryGapCleanup(f.input, f.overrides);
  assert.equal(planned.status, "MEDIA_DELIVERY_GAP_CLEANUP_PLANNED");
  assert.equal(planned.plan.cleanupOnly, true);
  assert.equal(planned.plan.featureStatus, "INCONCLUSIVE");
  assert.equal(f.evidenceCalls, 1);

  const receipt = await applyMediaDeliveryGapCleanup(
    planned.plan,
    f.input,
    planned.plan.planSha256,
    f.overrides,
  );
  assert.equal(receipt.status, "MEDIA_DELIVERY_GAP_CLEANUP_ARCHIVED");
  assert.equal(receipt.cleanupOnly, true);
  assert.equal(receipt.featureStatus, "INCONCLUSIVE");
  assert.equal(await readFile(receipt.archivedStopPath, "utf8"), stopContent);
  assert.equal(await readFile(receipt.archivedPendingPath, "utf8"), '{"phase":"sent"}\n');
  await assert.rejects(readFile(f.stopPath), { code: "ENOENT" });
  await assert.rejects(readFile(f.pendingPath), { code: "ENOENT" });
  assert.equal(
    await hasUnresolvedMediaDeliveryGapCleanup({
      config: f.config,
      locksDirectory: f.locksDirectory,
    }),
    false,
  );
  assert.equal(JSON.parse(await readFile(receipt.archivedLatestPath, "utf8")).runId, f.reportRunId);
  await writeFile(join(f.out, "latest.json"), '{"runId":"later-run"}\n', {
    mode: 0o600,
  });
  assert.equal(
    await hasUnresolvedMediaDeliveryGapCleanup({
      config: f.config,
      locksDirectory: f.locksDirectory,
    }),
    false,
  );
  await writeFile(join(f.out, f.reportRunId, "media-fixture.jsonl"), "changed\n", {
    mode: 0o600,
  });
  assert.equal(
    await hasUnresolvedMediaDeliveryGapCleanup({
      config: f.config,
      locksDirectory: f.locksDirectory,
    }),
    true,
  );
});

test("wrong plan approval and changed guard bytes never clear a guard", async (t) => {
  const f = await fixture(t);
  const planned = await planMediaDeliveryGapCleanup(f.input, f.overrides);
  await assert.rejects(
    applyMediaDeliveryGapCleanup(planned.plan, f.input, "0".repeat(64), f.overrides),
    { code: "MEDIA_CLEANUP_APPROVAL" },
  );
  assert.equal(await readFile(f.stopPath, "utf8"), stopContent);

  const next = await planMediaDeliveryGapCleanup(f.input, f.overrides);
  await writeFile(f.stopPath, `${stopContent}tampered`, { mode: 0o600 });
  await assert.rejects(
    applyMediaDeliveryGapCleanup(next.plan, f.input, next.plan.planSha256, f.overrides),
  );
  assert.equal(await readFile(f.stopPath, "utf8"), `${stopContent}tampered`);
});

test("any other account fixture guard blocks media cleanup before external evidence reads", async (t) => {
  const suffixes = [
    ".memory-pending.json",
    ".taste-pending.json",
    ".media-release-intent.json",
    ".task-worker-pending.json",
    ".group-policy-pending.json",
    ".group-members-policy-pending.json",
  ];
  for (const suffix of suffixes) {
    const f = await fixture(t);
    const accountKey = sha(f.config.driver.qq).slice(0, 24);
    await writeFile(join(f.locksDirectory, `${accountKey}${suffix}`), "pending\n", {
      mode: 0o600,
    });
    await assert.rejects(planMediaDeliveryGapCleanup(f.input, f.overrides), {
      code: "MEDIA_CLEANUP_ARCHIVE_EXISTS",
    });
    assert.equal(f.evidenceCalls, 0);
    assert.equal(await readFile(f.stopPath, "utf8"), stopContent);
  }
});

test("post-move verification failure retains a durable account fence", async (t) => {
  const f = await fixture(t, { afterEvidenceFails: true });
  const planned = await planMediaDeliveryGapCleanup(f.input, f.overrides);
  await assert.rejects(
    applyMediaDeliveryGapCleanup(planned.plan, f.input, planned.plan.planSha256, f.overrides),
    { code: "MEDIA_CLEANUP_POSTCHECK" },
  );
  const accountKey = sha(f.config.driver.qq).slice(0, 24);
  const intentPath = join(f.locksDirectory, `${accountKey}.media-cleanup-intent.json`);
  assert.equal(JSON.parse(await readFile(intentPath, "utf8")).status, "ARCHIVE_INTENT");
  assert.equal(
    await hasUnresolvedMediaDeliveryGapCleanup({
      config: f.config,
      locksDirectory: f.locksDirectory,
    }),
    true,
  );
});
