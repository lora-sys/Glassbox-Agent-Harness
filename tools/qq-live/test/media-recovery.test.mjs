import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { digest, toolManifestDigest } from "../lib/core.mjs";
import {
  deriveMediaLeaseRequestWitness,
  MEDIA_REQUEST_SOURCE_TREE_SHA256,
} from "../lib/media-product-evidence.mjs";
import {
  mediaFixtureStep,
  mediaObservationFor,
  mediaFamilyPlan,
  MEDIA_FAMILY_ID,
} from "../lib/media-scenario.mjs";
import {
  planMediaImageRecovery,
  hasUnresolvedMediaRecoveryRelease,
  releaseMediaRecoveryGuards,
  mediaRecoveryPlanBinding,
  revalidateMediaImagePrefix,
  verifyActiveMediaRecoveryPlanBinding,
  verifyMediaImageDeliveryGapEvidence,
  verifyMediaRecoveryAppendOnly,
  verifyMediaImageRecoveryPlan,
} from "../lib/media-recovery.mjs";
import { writeMemoryCheckpoint } from "../lib/memory-checkpoint.mjs";

const sha = (value) => createHash("sha256").update(value).digest("hex");
const stopContent =
  "CLEANUP_UNCONFIRMED\n请先检查 Bot 的延迟任务、目标状态和本轮报告，再人工删除此文件。\n";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "media-recovery-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const out = join(root, "out");
  const runId = "2026-10-07T00-00-00.000Z_12345678";
  const reportDirectory = join(out, runId);
  const locksDirectory = join(root, "locks");
  await mkdir(reportDirectory, { recursive: true, mode: 0o700 });
  await mkdir(locksDirectory, { mode: 0o700 });
  const config = {
    bot: { qq: "10001" },
    driver: { qq: "20002" },
    runtime: {
      connectionId: "fixture",
      threadId: null,
      dataDirectory: join(root, "data"),
    },
  };
  const runtime = {
    checkout: root,
    dataDirectory: config.runtime.dataDirectory,
    commit: "a".repeat(40),
    development: true,
    sourceTreeSha256: MEDIA_REQUEST_SOURCE_TREE_SHA256,
    pid: 1234,
    connectionId: "fixture",
    threadId: null,
  };
  const spec = mediaFixtureStep("image-1k");
  const token = "1".repeat(32);
  const leaseId = "11111111-1111-4111-8111-111111111111";
  const leaseTools = JSON.parse(JSON.stringify(spec.leaseTools).replaceAll("{{nonce}}", token));
  const prompt = `GLASSBOX_ACCEPTANCE_V1 ${token}\n${spec.prompt.replaceAll("{{nonce}}", token).trim()}`;
  const sentMessageId = "701";
  const botInputId = "702";
  const textReplyId = "703";
  const driverImageId = "704";
  const botImageId = "705";
  const textSha256 = digest(prompt);
  const startedAt = "2026-10-07T00:00:00.000Z";
  const reportPath = join(reportDirectory, "report.json");
  const suite = await readFile(new URL("../examples/media-private.example.json", import.meta.url));
  const suiteSha256 = sha(suite);
  const driverSha256 = digest(config.driver.qq);
  const process = {
    pid: 1234,
    bootId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    startTicks: "123456",
  };
  const caseRecord = {
    id: spec.id,
    status: "PASS",
    code: "REAL_REPLY_RECEIVED",
    route: "private",
    token,
    startedAt,
    prompt,
    expected: [token],
    featureAssertions: JSON.parse(
      JSON.stringify(spec.featureAssertions).replaceAll("{{nonce}}", token),
    ),
    leasedToolNames: ["media_generate"],
    acceptanceLease: {
      leaseId,
      expiresAt: Date.parse("2026-10-07T00:10:00.000Z"),
      toolsSha256: toolManifestDigest(leaseTools),
    },
    sendAttempted: true,
    sentMessageId,
    inputObserved: true,
    leaseRegistrationAttempted: true,
    leaseRevoked: true,
    inputBinding: {
      driverMessageId: sentMessageId,
      botMessageId: botInputId,
      textSha256,
      time: 1791331200,
      driverTime: 1791331200,
    },
    replies: [{ route: "private", messageId: textReplyId, matches: true }],
    anomalies: [],
  };
  const report = {
    mode: "run",
    status: "BLOCKED",
    runId,
    reportDirectory,
    startedAt: "2026-10-07T00:00:00.000Z",
    finishedAt: "2026-10-07T00:00:02.000Z",
    suiteSha256,
    runtime,
    plannedCaseCount: 1,
    executedCaseCount: 1,
    productAcceptance: { status: "BLOCKED", code: "NOT_CHECKED" },
    safetyStopCreated: true,
    cleanupStopRequired: true,
    error: { code: "INTERNAL_ERROR", diagnostic: { type: "TypeError" } },
    cases: [caseRecord],
  };
  const common = {
    schemaVersion: 1,
    familyId: MEDIA_FAMILY_ID,
    driverSha256,
    suiteSha256,
    runtime,
    process,
    reportDirectory,
    stage: "image-1k",
  };
  const checkpointPath = join(reportDirectory, "media-fixture.jsonl");
  const pendingName = `${sha(config.driver.qq).slice(0, 24)}.media-pending.json`;
  const pendingPath = join(locksDirectory, pendingName);
  const latestPath = join(out, "latest.json");
  const stopPath = join(out, "STOP");
  const latest = {
    runId,
    reportDirectory,
    mode: "run",
    status: "BLOCKED",
    productAcceptance: report.productAcceptance,
    cases: report.cases.map((c) => ({
      id: c.id,
      status: c.status,
      code: c.code,
      detail: c.detail,
    })),
    error: report.error,
  };
  for (const [path, content] of [
    [reportPath, JSON.stringify(report)],
    [latestPath, JSON.stringify(latest)],
    [stopPath, stopContent],
  ]) {
    await writeFile(path, content, { mode: 0o600 });
    await chmod(path, 0o600);
  }
  const stageEntries = [
    { stage: "image-1k", phase: "intent" },
    {
      stage: "image-1k",
      phase: "lease_intent",
      caseId: spec.id,
      marker: token,
      textSha256,
    },
    {
      stage: "image-1k",
      phase: "send_intent",
      caseId: spec.id,
      marker: token,
      leaseId,
      toolsSha256: caseRecord.acceptanceLease.toolsSha256,
      textSha256,
    },
    {
      stage: "image-1k",
      phase: "sent",
      caseId: spec.id,
      driverMessageId: sentMessageId,
    },
  ];
  for (const [index, entry] of stageEntries.entries())
    await writeMemoryCheckpoint({
      pendingPath,
      journalPath: checkpointPath,
      first: index === 0,
      row: {
        schemaVersion: 1,
        familyId: MEDIA_FAMILY_ID,
        sequence: index + 1,
        driverSha256,
        suiteSha256,
        runtime,
        process,
        reportDirectory,
        recordedAt: startedAt,
        ...entry,
      },
    });
  const dbRun = {
    externalId: botInputId,
    runId: "product-run-1",
    status: "succeeded",
    principal_id: "owner-principal",
    mediaExternalId: botImageId,
  };
  const taskResidues = {
    tasks: 0,
    taskAttemptRuns: 0,
    workerBindings: 0,
    workerLaunchIntents: 0,
    schedules: 0,
  };
  const asset = {
    assetId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    mimeType: "image/png",
    sizeBytes: 1234,
    sha256: "b".repeat(64),
    width: 1024,
    height: 1024,
    fullDecodeVerified: true,
    retained: true,
  };
  const calls = { bound: 0, verify: 0 };
  const caption = mediaObservationFor("image-1k").expectedCaption;
  const captionSha256 = digest(caption);
  const historyRow = (account, messageId) => ({
    messageId,
    selfId: account,
    senderId: config.bot.qq,
    userId: account === config.bot.qq ? config.driver.qq : config.bot.qq,
    messageType: "private",
    time: 1791331201,
    realSequence: "808",
    textBytes: Buffer.byteLength(caption),
    textSha256: captionSha256,
    mediaType: "image",
    mediaLocatorPresent: true,
    segmentCount: 2,
    segmentTypes: ["text", "image"],
  });
  const expectedFilter = {
    mediaType: "image",
    captionSha256,
    afterTime: startedAt,
  };
  const driverClient = {
    allowMessageRead(id) {
      assert.equal(id, driverImageId);
    },
    async readOwnerBotPrivateMediaHistory(filter) {
      assert.deepEqual(filter, expectedFilter);
      return {
        accountIdentity: config.driver.qq,
        peerId: config.bot.qq,
        messages: [historyRow(config.driver.qq, driverImageId)],
      };
    },
  };
  const botClient = {
    allowMessageRead(id) {
      assert.equal(id, botImageId);
    },
    async readBotOwnerPrivateMediaHistory(filter) {
      assert.deepEqual(filter, expectedFilter);
      return {
        accountIdentity: config.bot.qq,
        peerId: config.driver.qq,
        messages: [historyRow(config.bot.qq, botImageId)],
      };
    },
  };
  const overrides = {
    verifyProcessStopped: async (identity) => assert.deepEqual(identity, process),
    openReadOnlyDatabase: () => ({
      prepare: () => ({
        all: (...args) => {
          assert.deepEqual(args, [
            JSON.stringify(["fixture", "10001", "private", "20002", "20002", null]),
            token,
          ]);
          return [dbRun];
        },
        get: () => ({ ...taskResidues }),
      }),
      close() {},
    }),
    boundMediaMessage: async (client, messageId, options) => {
      calls.bound++;
      assert.equal(options.mediaType, "image");
      const isDriver = client === driverClient;
      assert.equal(messageId, isDriver ? driverImageId : botImageId);
      return {
        messageId,
        realSequence: "808",
        time: 1791331201,
        mediaType: "image",
        textSha256: captionSha256,
        captionSha256,
        segmentCount: 2,
      };
    },
    verifyMediaCase: async ({ stage, caseRecord: actual, mediaObservations }) => {
      calls.verify++;
      assert.equal(stage, "image-1k");
      assert.equal(actual.id, spec.id);
      assert.equal(mediaObservations.candidates[0].messageId, driverImageId);
      const events = [
        {
          type: "session_start",
          seq: 10,
          runId: dbRun.runId,
          principalId: dbRun.principal_id,
          sessionId: "fixture-session",
          data: {
            acceptanceLease: {
              leaseId,
              marker: token,
              narrowedTools: ["media_generate"],
              toolsSha256: actual.acceptanceLease.toolsSha256,
            },
            authorizedTools: ["media_generate"],
          },
        },
        {
          type: "tool_call",
          seq: 11,
          runId: dbRun.runId,
          principalId: dbRun.principal_id,
          sessionId: "fixture-session",
          data: {
            name: "media_generate",
            runId: dbRun.runId,
            toolCallId: "fixture-tool-call",
            input: {
              action: "image",
              mode: "text2image",
              ratio: "1:1",
              size: "1K",
            },
          },
        },
        {
          type: "media_generation_completed",
          seq: 12,
          provenance: "glassbox-media",
          runId: dbRun.runId,
          provider: "agnes",
          mediaType: "image",
          assetIds: [asset.assetId],
        },
        {
          type: "tool_result",
          seq: 13,
          runId: dbRun.runId,
          principalId: dbRun.principal_id,
          sessionId: "fixture-session",
          data: {
            name: "media_generate",
            runId: dbRun.runId,
            toolCallId: "fixture-tool-call",
            isError: false,
          },
        },
      ];
      return {
        status: "PASS",
        stage,
        runId: dbRun.runId,
        leaseRequestWitness: deriveMediaLeaseRequestWitness({
          events,
          runId: dbRun.runId,
          principalId: dbRun.principal_id,
          caseRecord: actual,
          stage,
          runtime,
        }),
        cleanupVerified: true,
        actualQqDeliveryVerified: true,
        asset,
      };
    },
  };
  return {
    config,
    out,
    runtime,
    expectedRuntime: runtime,
    reportPath,
    latestPath,
    locksDirectory,
    pendingPath,
    checkpointPath,
    stopPath,
    calls,
    asset,
    dbRun,
    taskResidues,
    overrides,
    clients: { driver: driverClient, bot: botClient },
    driverClient,
    botClient,
    historyRow,
    driverImageId,
    botImageId,
  };
}

async function replaceLatestWithNoSendResumeBlock(input, overrides = {}) {
  const original = JSON.parse(await readFile(input.reportPath, "utf8"));
  const startedAt = "2026-10-07T00:01:00.000Z";
  const runId = "2026-10-07T00-01-00.100Z_abcdef12";
  const reportDirectory = join(input.out, runId);
  await mkdir(reportDirectory, { mode: 0o700 });
  const report = {
    schemaVersion: 1,
    toolVersion: "0.1.0",
    runId,
    mode: "resume-media",
    startedAt,
    productAcceptance: { status: "BLOCKED", code: "NOT_CHECKED" },
    status: "BLOCKED",
    suiteSha256: original.suiteSha256,
    workspace: {},
    cases: [],
    limitations: [],
    privacy: "fixture",
    finishedAt: "2026-10-07T00:01:05.000Z",
    reportDirectory,
    error: {
      code: "MEMORY_RECONCILIATION_REQUIRED",
      status: "BLOCKED",
      message: "该发起账号有未核实的记忆清理归档。先核实原始报告和归档收据，禁止续发。",
    },
    ...overrides,
  };
  await writeFile(join(reportDirectory, "report.json"), JSON.stringify(report), {
    mode: 0o600,
  });
  await writeFile(
    join(reportDirectory, "attempt.json"),
    JSON.stringify({
      runId,
      mode: "resume-media",
      startedAt,
      status: "STARTED",
    }),
    { mode: 0o600 },
  );
  const latest = {
    status: report.status,
    mode: report.mode,
    runId,
    reportDirectory,
    productAcceptance: report.productAcceptance,
    cases: report.cases.map((c) => ({
      id: c.id,
      status: c.status,
      code: c.code,
      detail: c.detail,
    })),
    error: report.error,
  };
  await writeFile(input.latestPath, JSON.stringify(latest), { mode: 0o600 });
}

test("read-only media recovery plan verifies the exact completed image prefix", async (t) => {
  const input = await fixture(t);
  const planned = await planMediaImageRecovery(input, input.overrides);
  assert.equal(planned.status, "MEDIA_RECOVERY_PLANNED");
  const verified = await verifyMediaImageRecoveryPlan(planned.plan, input, input.overrides);
  assert.equal(verified.status, "MEDIA_IMAGE_PREFIX_VERIFIED");
  assert.equal(verified.productRunId, "product-run-1");
  assert.equal(verified.cleanupVerified, true);
  assert.equal(verified.actualQqDeliveryVerified, true);
  assert.equal(
    verified.mediaAcceptance.leaseRequestWitness.derivation,
    "derived_from_execution_lease",
  );
  assert.equal(
    verified.mediaAcceptance.leaseRequestWitness.assetId,
    verified.mediaAcceptance.asset.assetId,
  );
  assert.equal(Object.hasOwn(verified.mediaAcceptance.leaseRequestWitness, "prompt"), false);
  assert.equal(input.calls.bound, 2);
  assert.equal(input.calls.verify, 1);
  assert.deepEqual(
    Object.keys(verified).sort(),
    [
      "actualQqDeliveryVerified",
      "cleanupVerified",
      "familyId",
      "mediaAcceptance",
      "mediaMessageBinding",
      "mediaObservations",
      "planSha256",
      "prefix",
      "productRunId",
      "productRunStatus",
      "proofSha256",
      "status",
      "transportCase",
    ].sort(),
  );
  assert.equal(
    await revalidateMediaImagePrefix(planned.plan, verified, input, input.overrides),
    verified.proofSha256,
  );
  assert.equal(input.calls.bound, 4);
  assert.equal(input.calls.verify, 2);
  await assert.rejects(
    revalidateMediaImagePrefix(
      planned.plan,
      { ...verified, productRunId: "other-run" },
      input,
      input.overrides,
    ),
  );
  await assert.rejects(
    revalidateMediaImagePrefix(
      planned.plan,
      {
        ...verified,
        mediaAcceptance: {
          ...verified.mediaAcceptance,
          leaseRequestWitness: {
            ...verified.mediaAcceptance.leaseRequestWitness,
            promptSha256: "f".repeat(64),
          },
        },
      },
      input,
      input.overrides,
    ),
  );
});

test("cleanup-only evidence accepts only the typed missing delivery Trace witness and zero task residue", async (t) => {
  const input = await fixture(t);
  input.overrides.verifyMediaCase = async () => {
    throw Object.assign(new Error("witness event absent"), {
      code: "MEDIA_TRACE_DELIVERY_WITNESS_MISSING",
    });
  };
  const evidence = await verifyMediaImageDeliveryGapEvidence(input, input.overrides);
  assert.equal(evidence.status, "MEDIA_DELIVERY_GAP_CLEANUP_VERIFIED");
  assert.equal(evidence.cleanupOnly, true);
  assert.equal(evidence.featureStatus, "INCONCLUSIVE");
  assert.equal(evidence.productRunId, input.dbRun.runId);
  assert.equal(evidence.cleanup.missingMediaDeliveryTraceWitness, true);
  assert.equal(evidence.cleanup.dualAccountTextAndMediaReadsVerified, true);

  input.overrides.verifyMediaCase = async () => {
    throw Object.assign(new Error("malformed witness"), {
      code: "MEDIA_TRACE_WITNESS",
    });
  };
  await assert.rejects(verifyMediaImageDeliveryGapEvidence(input, input.overrides), {
    code: "MEDIA_TRACE_WITNESS",
  });

  input.overrides.verifyMediaCase = async () => {
    throw Object.assign(new Error("witness event absent"), {
      code: "MEDIA_TRACE_DELIVERY_WITNESS_MISSING",
    });
  };
  input.taskResidues.tasks = 1;
  await assert.rejects(verifyMediaImageDeliveryGapEvidence(input, input.overrides), {
    code: "MEDIA_CLEANUP_TASK_RESIDUE",
  });
});

test("media recovery pins the exact no-send resume block and exposes a rechecked memory binding", async (t) => {
  const input = await fixture(t);
  await replaceLatestWithNoSendResumeBlock(input);
  const planned = await planMediaImageRecovery(input, input.overrides);
  assert.equal(planned.status, "MEDIA_RECOVERY_PLANNED");
  assert.match(planned.plan.resumeBlockReportPath, /report\.json$/u);
  assert.equal(planned.plan.resumeBlockReportSha256.length, 64);
  assert.equal(planned.plan.resumeBlockAttemptSha256.length, 64);
  const binding = mediaRecoveryPlanBinding(planned.plan);
  assert.equal(binding.proofKind, "active-media-recovery");
  assert.equal(binding.driverSha256, digest(input.config.driver.qq));
  assert.equal(
    await verifyActiveMediaRecoveryPlanBinding(binding, {
      config: input.config,
      expectedRuntime: input.expectedRuntime,
      locksDirectory: input.locksDirectory,
    }),
    true,
  );
  const latest = JSON.parse(await readFile(input.latestPath, "utf8"));
  await writeFile(input.latestPath, JSON.stringify({ ...latest, error: { code: "DIFFERENT" } }));
  assert.equal(
    await verifyActiveMediaRecoveryPlanBinding(binding, {
      config: input.config,
      expectedRuntime: input.expectedRuntime,
      locksDirectory: input.locksDirectory,
    }),
    false,
  );
});

test("media recovery rejects noncanonical or effectful resume-block latest reports", async (t) => {
  for (const overrides of [
    { error: { code: "OTHER", status: "BLOCKED", message: "blocked" } },
    { cases: [{ id: "media-video-4s" }] },
    { runtime: null },
    { productAcceptance: { status: "PASS", code: "NOT_CHECKED" } },
    { suiteSha256: "0".repeat(64) },
  ]) {
    const input = await fixture(t);
    await replaceLatestWithNoSendResumeBlock(input, overrides);
    await assert.rejects(planMediaImageRecovery(input, input.overrides));
  }
});

test("text reply IDs are not used as image receipts and ambiguous media history fails closed", async (t) => {
  const input = await fixture(t);
  const planned = await planMediaImageRecovery(input, input.overrides);
  input.clients.driver.readOwnerBotPrivateMediaHistory = async () => ({
    accountIdentity: input.config.driver.qq,
    peerId: input.config.bot.qq,
    messages: [
      input.historyRow(input.config.driver.qq, input.driverImageId),
      input.historyRow(input.config.driver.qq, "706"),
    ],
  });
  await assert.rejects(verifyMediaImageRecoveryPlan(planned.plan, input, input.overrides), {
    code: "MEDIA_RECOVERY_HISTORY",
  });
  assert.equal(input.calls.bound, 0);
  assert.equal(input.calls.verify, 0);
});

test("a modified pending checkpoint or STOP prevents prefix verification", async (t) => {
  for (const changed of ["pending", "stop", "video-stage"]) {
    const input = await fixture(t);
    const planned = await planMediaImageRecovery(input, input.overrides);
    if (changed === "pending")
      await writeFile(input.pendingPath, JSON.stringify({ phase: "sent", stage: "video-4s" }));
    if (changed === "stop") await writeFile(input.stopPath, "different\n");
    if (changed === "video-stage") {
      const rows = (await readFile(input.checkpointPath, "utf8"))
        .trim()
        .split("\n")
        .map(JSON.parse);
      rows.push({
        ...rows.at(-1),
        sequence: 5,
        stage: "video-4s",
        phase: "intent",
      });
      await writeFile(
        input.checkpointPath,
        rows.map((row) => JSON.stringify(row)).join("\n") + "\n",
      );
    }
    await assert.rejects(
      verifyMediaImageRecoveryPlan(
        planned.plan,
        { ...input, clients: { driver: { allowMessageRead() {} } } },
        input.overrides,
      ),
    );
    assert.equal(input.calls.bound, 0, changed);
    assert.equal(input.calls.verify, 0, changed);
  }
});

test("media recovery releases guards only after an append-only video proof is durable", async (t) => {
  const input = await fixture(t);
  const planned = await planMediaImageRecovery(input, input.overrides);
  const videoSpec = mediaFixtureStep("video-4s");
  const videoToken = "2".repeat(32);
  const videoLeaseId = "22222222-2222-4222-8222-222222222222";
  const videoTools = JSON.parse(
    JSON.stringify(videoSpec.leaseTools).replaceAll("{{nonce}}", videoToken),
  );
  const videoPrompt = `GLASSBOX_ACCEPTANCE_V1 ${videoToken}\n${videoSpec.prompt.replaceAll("{{nonce}}", videoToken).trim()}`;
  const videoCase = {
    id: "media-video-4s",
    token: videoToken,
    status: "PASS",
    leaseRevoked: true,
    sendAttempted: true,
    sentMessageId: "801",
    prompt: videoPrompt,
    acceptanceLease: {
      leaseId: videoLeaseId,
      toolsSha256: toolManifestDigest(videoTools),
    },
  };
  const asset = {
    assetId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    mimeType: "video/mp4",
    sizeBytes: 5678,
    sha256: "c".repeat(64),
    width: 1280,
    height: 720,
    fullDecodeVerified: true,
    retained: true,
    durationSeconds: 4,
    framesPerSecond: 30,
    durationToleranceSeconds: 1 / 30,
  };
  const videoAcceptance = {
    status: "PASS",
    stage: "video-4s",
    runId: "product-run-2",
    cleanupVerified: true,
    actualQqDeliveryVerified: true,
    asset,
  };
  const common = {
    schemaVersion: 1,
    familyId: MEDIA_FAMILY_ID,
    driverSha256: digest(input.config.driver.qq),
    suiteSha256: planned.plan.suiteSha256,
    runtime: input.runtime,
    process: {
      pid: 1234,
      bootId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      startTicks: "123456",
    },
    reportDirectory: join(input.out, "2026-10-07T00-01-00.000Z_87654321"),
    recordedAt: "2026-10-07T00:01:00.000Z",
    stage: "video-4s",
  };
  const videoEntries = [
    { phase: "intent" },
    {
      phase: "lease_intent",
      caseId: videoCase.id,
      marker: videoToken,
      textSha256: digest(videoPrompt),
    },
    {
      phase: "send_intent",
      caseId: videoCase.id,
      marker: videoToken,
      leaseId: videoLeaseId,
      toolsSha256: videoCase.acceptanceLease.toolsSha256,
      textSha256: digest(videoPrompt),
    },
    {
      phase: "sent",
      caseId: videoCase.id,
      driverMessageId: videoCase.sentMessageId,
    },
    { phase: "verified", runId: videoAcceptance.runId, assetId: asset.assetId },
  ];
  const finalRunDirectory = common.reportDirectory;
  for (const [index, entry] of videoEntries.entries())
    await writeMemoryCheckpoint({
      pendingPath: input.pendingPath,
      journalPath: input.checkpointPath,
      first: false,
      row: {
        schemaVersion: 1,
        familyId: MEDIA_FAMILY_ID,
        sequence: index + 5,
        driverSha256: digest(input.config.driver.qq),
        suiteSha256: planned.plan.suiteSha256,
        runtime: input.runtime,
        process: common.process,
        reportDirectory: finalRunDirectory,
        recordedAt: common.recordedAt,
        stage: "video-4s",
        ...entry,
      },
    });
  const rows = (await readFile(input.checkpointPath, "utf8")).trim().split("\n").map(JSON.parse);
  assert.equal(rows.length, 9);
  assert.equal(Object.hasOwn(rows[3], "marker"), false);
  assert.equal(Object.hasOwn(rows[7], "marker"), false);
  const processIdentity = common.process;
  await mkdir(finalRunDirectory, { mode: 0o700 });
  const proof = await verifyMediaRecoveryAppendOnly(planned.plan, {
    config: input.config,
    expectedRuntime: input.runtime,
    reportDirectory: finalRunDirectory,
    processIdentity,
    imagePrefixProofSha256: "e".repeat(64),
    imagePrefixProductRunId: "product-run-1",
    imagePrefixAssetId: input.asset.assetId,
    videoCase,
    videoAcceptance,
  });
  const stageReceipts = [
    {
      caseId: "media-image-1k",
      status: "PASS",
      runId: "product-run-1",
      asset: input.asset,
    },
    {
      caseId: "media-video-4s",
      status: "PASS",
      runId: "product-run-2",
      asset,
    },
  ];
  const familyAcceptance = {
    status: "PASS",
    familyId: MEDIA_FAMILY_ID,
    stageRunIds: ["product-run-1", "product-run-2"],
    retainedAssets: [input.asset, asset],
    cleanup: { required: true, leaseRevoked: true, assetsRetained: true },
    limitation: mediaFamilyPlan().limitation,
  };
  const resumedRunId = "2026-10-07T00-01-00.000Z_87654321";
  const finalReport = {
    runId: resumedRunId,
    mode: "resume-media",
    status: "PASS",
    productAcceptance: {
      status: "PASS",
      cleanupVerified: true,
      cases: stageReceipts,
    },
    mediaFamilyAcceptance: familyAcceptance,
    mediaRecoveryFinalProof: proof,
  };
  const finalLatest = {
    runId: resumedRunId,
    reportDirectory: finalRunDirectory,
    status: "PASS",
    productAcceptance: { status: "PASS", cases: stageReceipts },
    mediaFamilyAcceptance: familyAcceptance,
    mediaRecoveryFinalProof: proof,
  };
  const finalReportPath = join(finalRunDirectory, "report.json");
  await writeFile(finalReportPath, JSON.stringify(finalReport), {
    mode: 0o600,
  });
  await writeFile(input.latestPath, JSON.stringify(finalLatest), {
    mode: 0o600,
  });
  const released = await releaseMediaRecoveryGuards(planned.plan, proof, {
    finalReportPath,
    finalLatestPath: input.latestPath,
    reportRunId: resumedRunId,
  });
  assert.equal(released.status, "MEDIA_RECOVERY_GUARDS_RELEASED");
  assert.equal(await hasUnresolvedMediaRecoveryRelease(input.config, input.locksDirectory), false);
  await assert.rejects(readFile(input.pendingPath));
  await assert.rejects(readFile(input.stopPath));
});

test("an interrupted guard release leaves a durable fail-closed live-send fence", async (t) => {
  const input = await fixture(t);
  const releaseIntentPath = join(
    input.locksDirectory,
    `${sha(input.config.driver.qq).slice(0, 24)}.media-release-intent.json`,
  );
  assert.equal(await hasUnresolvedMediaRecoveryRelease(input.config, input.locksDirectory), false);
  await writeFile(
    releaseIntentPath,
    '{"schemaVersion":1,"kind":"media-recovery-guard-release-intent"}\n',
    { mode: 0o600 },
  );
  assert.equal(await hasUnresolvedMediaRecoveryRelease(input.config, input.locksDirectory), true);
  await writeFile(releaseIntentPath, "malformed\n");
  assert.equal(await hasUnresolvedMediaRecoveryRelease(input.config, input.locksDirectory), true);
});

test("recovery can independently verify an image after the post-text media observer was cancelled", async (t) => {
  const input = await fixture(t);
  const report = JSON.parse(await readFile(input.reportPath, "utf8"));
  report.status = "INCONCLUSIVE";
  report.error = { code: "CANCELLED", status: "INCONCLUSIVE", message: "媒体观察已停止。" };
  Object.assign(report.cases[0], {
    mediaObservationExpectedType: "image",
    mediaObservationExpectedCaptionSha256: digest("图片已生成"),
    mediaObservations: [],
    mediaObservationClosed: false,
    mediaObservationOverflow: false,
  });
  await writeFile(input.reportPath, JSON.stringify(report), { mode: 0o600 });
  const latest = JSON.parse(await readFile(input.latestPath, "utf8"));
  Object.assign(latest, { status: report.status, error: report.error });
  await writeFile(input.latestPath, JSON.stringify(latest), { mode: 0o600 });
  const plan = await planMediaImageRecovery(input, input.overrides);
  assert.equal(plan.status, "MEDIA_RECOVERY_PLANNED");
  const verified = await verifyMediaImageRecoveryPlan(plan.plan, input, input.overrides);
  assert.equal(verified.status, "MEDIA_IMAGE_PREFIX_VERIFIED");
  assert.equal(verified.actualQqDeliveryVerified, true);
  for (const patch of [
    { mediaObservationOverflow: true },
    { mediaObservationClosed: true },
    { mediaObservationExpectedType: "video" },
    { mediaObservations: [{ messageId: "unverified" }] },
  ]) {
    const changed = structuredClone(report);
    Object.assign(changed.cases[0], patch);
    await writeFile(input.reportPath, JSON.stringify(changed), { mode: 0o600 });
    await assert.rejects(planMediaImageRecovery(input, input.overrides), {
      code: "MEDIA_RECOVERY_REPORT",
    });
  }
});
