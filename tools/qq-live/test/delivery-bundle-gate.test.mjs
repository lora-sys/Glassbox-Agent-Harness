import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { toolManifestDigest } from "../lib/core.mjs";
import { evaluateBundledDeliveryGate } from "../lib/delivery-bundle-gate.mjs";

const commit = "a".repeat(40);
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const hash = (text) => createHash("sha256").update(text, "utf8").digest("hex");
const coverageSuite = (ids = ["ops-status-read"]) =>
  JSON.stringify({
    schemaVersion: 2,
    cases: ids.map((id) => ({
      id,
      chat: "private",
      prompt: `Read current status for {{nonce}} (${id}).`,
      expectContains: ["{{nonce}}"],
      sideEffect: "none",
      leaseTools: [
        {
          name: "ops_status",
          operations: [
            { action: "ops:status", resourceId: "agent-operations", inputConstraint: {} },
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
    })),
  });
const taskText = JSON.stringify({
  schemaVersion: 8,
  cases: [
    {
      id: "task-worker-artifact-lifecycle",
      kind: "task-worker-artifact-lifecycle",
      chat: "private",
    },
  ],
});
const runtime = { commit, dataDirectory: "/fixture/data" };

function addMedia(f) {
  const text = JSON.stringify({
    schemaVersion: 7,
    cases: [{ id: "media-private-delivery", kind: "media-private-delivery", chat: "private" }],
  });
  const manifest = JSON.parse(f.input.bundleText);
  manifest.suites.push({
    id: "media",
    role: "media",
    path: "reports/media.json",
    sha256: hash(text),
  });
  f.input.bundleText = JSON.stringify(manifest);
  f.input.suiteSha256 = hash(f.input.bundleText);
  f.input.memberSuiteTexts.media = text;
  const stages = ["image-1k", "video-4s"].map((stage, i) => ({
    stage,
    runId: uuid(70 + i),
    runCreatedAt: new Date(2200000000000 + i * 1000).toISOString(),
    messageBinding: {
      input: {
        botMessageId: `media-b${i}`,
        driverMessageId: `media-d${i}`,
        realSequence: String(80 + i),
        time: 2300000000 + i,
        driverTime: 2300000000 + i,
        textSha256: "c".repeat(64),
      },
    },
    asset: { assetId: uuid(90 + i), sha256: "d".repeat(64) },
  }));
  const family = {
    status: "PASS",
    familyId: "media-private-delivery",
    stageRunIds: stages.map((s) => s.runId),
    retainedAssets: stages.map((s) => s.asset),
  };
  const cases = stages.map((s) => ({ id: `media-${s.stage}`, runId: s.runId }));
  const report = {
    mode: "run",
    status: "PASS",
    suiteSha256: hash(text),
    runtime,
    plannedCaseCount: 2,
    executedCaseCount: 2,
    cases: cases.map((c, i) => ({
      ...c,
      mediaObservationClosed: true,
      mediaObservationOverflow: false,
      mediaObservations: [{ messageId: `media-message-${i}` }],
    })),
    productAcceptance: {
      status: "PASS",
      cleanupVerified: true,
      runtime,
      cases: cases.map((c, i) => ({
        caseId: c.id,
        runId: c.runId,
        status: "PASS",
        asset: stages[i].asset,
        cleanupVerified: true,
        actualQqDeliveryVerified: true,
      })),
    },
    mediaFamilyAcceptance: family,
  };
  const fresh = {
    ...structuredClone(family),
    runtime,
    stages,
    cleanupVerified: true,
    actualQqDeliveryVerified: true,
  };
  f.input.reports.push(report);
  f.deps.verifyMediaReport = async (_report, options) => {
    assert.equal(options.suiteSha256, hash(text));
    return fresh;
  };
  return { fresh, report };
}

function setup({ ids, postMerge = false } = {}) {
  const coverageText = coverageSuite(ids);
  const coverageHash = hash(coverageText),
    workerHash = hash(taskText);
  const manifestText = JSON.stringify({
    schemaVersion: 1,
    suites: [
      { id: "coverage", role: "coverage", path: "reports/coverage.json", sha256: coverageHash },
      {
        id: "task-worker",
        role: "task-worker",
        path: "reports/task-worker.json",
        sha256: workerHash,
      },
    ],
  });
  const workerRuns = [1, 2, 3, 4].map(uuid);
  const input = (n, time = 2300000000) => ({
    botMessageId: `b${n}`,
    driverMessageId: `d${n}`,
    realSequence: String(n),
    time,
    driverTime: time,
    textSha256: hash(`message${n}`),
  });
  const workerStages = ["create", "delegate", "inspect", "accept"].map((stage, i) => ({
    stage,
    runId: workerRuns[i],
    runCreatedAt: new Date((postMerge ? 2200000000000 : 2000000000000) + i * 1000).toISOString(),
    messageBinding: { input: input(i + 1) },
  }));
  const workerScope = {
    connectionId: "qq-onebot",
    botId: "10002",
    chatType: "private",
    chatId: "10001",
    senderId: "10001",
    threadId: null,
  };
  const workerTaskId = uuid(99),
    workerAttemptId = uuid(98),
    workerBindingId = uuid(97);
  const markerSha256 = hash("worker marker");
  const workerReport = {
    suiteSha256: workerHash,
    status: "PASS",
    mode: "run",
    runtime,
    productAcceptance: {
      status: "PASS",
      cleanupVerified: true,
      runtime,
      cases: workerStages.map((s, i) => ({
        caseId: `task-worker-${s.stage}`,
        runId: s.runId,
        traceVerified: true,
        messageBinding: { input: s.messageBinding.input },
      })),
    },
    taskWorkerFamily: { familyId: "task-worker-artifact-lifecycle" },
    taskWorkerAcceptance: { status: "PASS", familyId: "task-worker-artifact-lifecycle" },
    cases: workerStages.map((s, i) => ({ id: `task-worker-${s.stage}`, runId: s.runId })),
    taskWorkerReceipts: workerStages.map((s, index) => {
      const common = {
        stage: s.stage,
        runId: s.runId,
        taskId: workerTaskId,
        principalId: "owner-principal",
        principalKind: "owner",
        scope: workerScope,
        cleanupVerified: true,
      };
      if (index === 0)
        return {
          ...common,
          creationRunId: s.runId,
          taskStatus: "NEW",
          attemptId: null,
          bindingId: null,
        };
      const linked = {
        ...common,
        creationRunId: workerRuns[0],
        attemptId: workerAttemptId,
        bindingId: workerBindingId,
      };
      if (index === 1)
        return {
          ...linked,
          workspaceId: "workspace-fixture",
          herdrSession: "session-fixture",
          agentKind: "pi",
          dispatchVerified: true,
          taskStatus: "RUNNING",
          attemptStatus: "running",
        };
      if (index === 2)
        return {
          ...linked,
          taskStatus: "REVIEW",
          attemptStatus: "review",
          workerTerminalVerified: true,
          artifact: {
            filename: `qq-live-worker-${"c".repeat(32)}.txt`,
            sizeBytes: 33,
            sha256: hash("artifact"),
            fullContentVerified: true,
            markerSha256,
          },
        };
      return {
        ...linked,
        acceptedRunId: s.runId,
        taskStatus: "DONE",
        attemptStatus: "succeeded",
        workerLeaseReleased: true,
        terminalVerified: true,
        pendingAttentionCount: 0,
      };
    }),
  };
  workerReport.taskWorkerAcceptance = {
    status: "PASS",
    familyId: "task-worker-artifact-lifecycle",
    taskId: workerTaskId,
    creationRunId: workerRuns[0],
    stageRunIds: workerRuns,
    attemptId: workerAttemptId,
    bindingId: workerBindingId,
    terminalStatus: "DONE",
    cleanup: { acceptanceLeasesRevoked: true, workerLeaseReleased: true, pendingAttentionCount: 0 },
  };
  const coverageCases = ids ?? ["ops-status-read"];
  const coverageReport = {
    suiteSha256: coverageHash,
    status: "PASS",
    mode: "run",
    runtime,
    productAcceptance: {
      status: "PASS",
      runtime,
      cases: coverageCases.map((caseId, i) => ({
        caseId,
        runId: uuid(20 + i),
        traceVerified: true,
        feature: { status: "PASS" },
        ...(postMerge
          ? {
              runCreatedAt: new Date(2100000000000).toISOString(),
              messageBinding: { input: input(i + 20, 2200000000) },
            }
          : {}),
      })),
    },
    cases: coverageCases.map((id, i) => ({
      id,
      token: "b".repeat(32),
      route: "private",
      prompt:
        `GLASSBOX_ACCEPTANCE_V1 ${"b".repeat(32)}\nRead current status for {{nonce}} (${id}).`.replaceAll(
          "{{nonce}}",
          "b".repeat(32),
        ),
      expected: ["b".repeat(32)],
      acceptanceLease: {
        toolsSha256: toolManifestDigest([
          {
            name: "ops_status",
            operations: [
              { action: "ops:status", resourceId: "agent-operations", inputConstraint: {} },
            ],
          },
        ]),
      },
      leaseRevoked: true,
      leasedToolNames: ["ops_status"],
      featureAssertions: [
        {
          kind: "trace",
          type: "tool_result",
          where: { name: "ops_status", isError: false },
          count: 1,
        },
      ],
      status: "PASS",
      runId: uuid(20 + i),
    })),
  };
  const baseInput = {
    commit,
    suiteSha256: hash(manifestText),
    bundleText: manifestText,
    memberSuiteTexts: { coverage: coverageText, "task-worker": taskText },
    suiteConfig: { groups: [] },
    reports: [coverageReport, workerReport],
    requiredCaseIds: coverageCases,
    requiredCheckNames: ["verify"],
    deterministic: { commit, full: "PASS", commitGate: "PASS" },
    checkOnly: postMerge,
    candidateCommit: postMerge ? "b".repeat(40) : undefined,
    userAuthorizedMerge: !postMerge,
    postMerge,
  };
  const deps = {
    verifyTaskWorkerReport: async () => ({
      status: "PASS",
      familyId: "task-worker-artifact-lifecycle",
      runtime,
      taskId: uuid(99),
      stageRunIds: workerRuns,
      attemptId: uuid(98),
      bindingId: uuid(97),
      terminalStatus: "DONE",
      cleanupVerified: true,
      dispatchVerified: true,
      stages: workerStages,
    }),
    verifyReport: async (candidate) => ({
      status: "PASS",
      runtime,
      cases: candidate.cases.map((c) => ({
        caseId: c.id,
        runId: c.runId,
        traceVerified: true,
        feature: { status: "PASS" },
        ...(postMerge
          ? {
              runCreatedAt: new Date(2100000000000).toISOString(),
              messageBinding: { input: input(50, 2200000000) },
            }
          : {}),
      })),
    }),
    verifyCoverage: async ({ suite }) => ({
      status: "PASS",
      requiredCaseIds: suite.cases.map((c) => c.id),
    }),
    resolveRoute: (route) => (route === "private" ? "private" : null),
    readRemote: async () =>
      postMerge
        ? {
            headCommit: "b".repeat(40),
            state: "MERGED",
            mergeCommit: commit,
            mergedAt: new Date(2100000000000).toISOString(),
            checks: [{ name: "verify", commit, status: "SUCCESS" }],
          }
        : {
            headCommit: commit,
            state: "OPEN",
            draft: false,
            mergeable: true,
            checks: [{ name: "verify", commit, status: "SUCCESS" }],
            review: { commit, status: "PASS", evidenceId: "review-1" },
          },
    ...(postMerge
      ? {
          verifyAgentReview: async () => ({
            status: "PASS",
            candidateCommit: "b".repeat(40),
            hostOperatorIdentityAttested: true,
            receiptSha256: "c".repeat(64),
            bindingSha256: "d".repeat(64),
            artifactSha256: "e".repeat(64),
            reviewerId: "reviewer",
            implementationAgentIds: ["implementer"],
          }),
        }
      : {}),
  };
  return {
    input: baseInput,
    deps,
    coverageReport,
    workerReport,
    workerStages,
    workerRuns,
    coverageHash,
    workerHash,
  };
}

test("approved media joins Worker and coverage evidence without replacing catalog cases", async () => {
  const f = setup();
  const media = addMedia(f);
  const receipt = await evaluateBundledDeliveryGate(f.input, f.deps);
  assert.deepEqual(receipt.mediaReceipt, media.fresh);
  assert.equal(receipt.memberSuiteSha256.media, media.report.suiteSha256);
  const missing = setup();
  addMedia(missing);
  missing.input.requiredCaseIds.push("missing-case");
  await assert.rejects(evaluateBundledDeliveryGate(missing.input, missing.deps));
});

test("media requires its verifier, exact role, unique reports, Runs and retained Assets", async () => {
  for (const mutate of [
    (f) => {
      delete f.deps.verifyMediaReport;
    },
    (f) => {
      f.input.reports.pop();
    },
    (f, m) => {
      f.input.reports.push(structuredClone(m.report));
    },
    (_f, m) => {
      m.report.taskWorkerFamily = {};
    },
    (_f, m) => {
      m.fresh.cleanupVerified = false;
    },
    (_f, m) => {
      m.fresh.actualQqDeliveryVerified = false;
    },
    (_f, m) => {
      m.fresh.stages[0].runId = uuid(1);
    },
    (_f, m) => {
      m.fresh.stages[1].asset.assetId = m.fresh.stages[0].asset.assetId;
    },
    (_f, m) => {
      m.report.status = "INCONCLUSIVE";
    },
  ]) {
    const f = setup();
    const m = addMedia(f);
    mutate(f, m);
    await assert.rejects(evaluateBundledDeliveryGate(f.input, f.deps));
  }
});

test("post-merge media requires both QQ input times after the trusted merge", async () => {
  const valid = setup({ postMerge: true });
  addMedia(valid);
  assert.equal(
    (await evaluateBundledDeliveryGate(valid.input, valid.deps)).mediaReceipt.status,
    "PASS",
  );
  for (const key of ["time", "driverTime"]) {
    const f = setup({ postMerge: true });
    const m = addMedia(f);
    m.fresh.stages[0].messageBinding.input[key] = 2100000000;
    await assert.rejects(evaluateBundledDeliveryGate(f.input, f.deps));
  }
});

test("bundle wrapper passes only coverage reports and retains bundle and member approvals", async () => {
  const state = setup();
  const result = await evaluateBundledDeliveryGate(state.input, state.deps);
  assert.equal(result.status, "PASS");
  assert.equal(result.suiteSha256, state.input.suiteSha256);
  assert.equal(result.suiteBundleSha256, state.input.suiteSha256);
  assert.deepEqual(result.memberSuiteSha256, {
    coverage: state.coverageHash,
    taskWorker: state.workerHash,
  });
  assert.deepEqual(result.caseIds, ["ops-status-read"]);
});

test("coverage catalog remains complete and the legacy gate rejects omitted cases", async () => {
  const state = setup({ ids: ["ops-status-read", "second-read"] });
  state.coverageReport.cases.pop();
  state.coverageReport.productAcceptance.cases.pop();
  await assert.rejects(
    evaluateBundledDeliveryGate(state.input, state.deps),
    (error) => error.code === "COVERAGE_GATE",
  );
});

test("missing verifier, unknown member hash, and duplicate worker reports fail closed", async () => {
  const missing = setup();
  delete missing.deps.verifyTaskWorkerReport;
  await assert.rejects(
    evaluateBundledDeliveryGate(missing.input, missing.deps),
    (e) => e.code === "TASK_WORKER_VERIFIER",
  );
  const unknown = setup();
  unknown.workerReport.suiteSha256 = "f".repeat(64);
  await assert.rejects(
    evaluateBundledDeliveryGate(unknown.input, unknown.deps),
    (e) => e.code === "BUNDLE_REPORT_HASH",
  );
  const duplicate = setup();
  duplicate.input.reports.push(duplicate.workerReport);
  await assert.rejects(
    evaluateBundledDeliveryGate(duplicate.input, duplicate.deps),
    (e) => e.code === "BUNDLE_REPORT_DUPLICATE",
  );
});

test("both bundle roles are required and reports cannot change roles or mix families", async () => {
  const coverageOnly = setup();
  coverageOnly.input.reports = [coverageOnly.coverageReport];
  await assert.rejects(
    evaluateBundledDeliveryGate(coverageOnly.input, coverageOnly.deps),
    (e) => e.code === "BUNDLE_REPORTS",
  );

  const workerOnly = setup();
  workerOnly.input.reports = [workerOnly.workerReport];
  await assert.rejects(
    evaluateBundledDeliveryGate(workerOnly.input, workerOnly.deps),
    (e) => e.code === "BUNDLE_REPORTS",
  );

  const roleSwap = setup();
  roleSwap.workerReport.suiteSha256 = roleSwap.coverageHash;
  await assert.rejects(
    evaluateBundledDeliveryGate(roleSwap.input, roleSwap.deps),
    (e) => e.code === "BUNDLE_REPORT_ROLE",
  );

  const mixed = setup();
  mixed.workerReport.memoryLifecycle = { status: "PASS" };
  await assert.rejects(
    evaluateBundledDeliveryGate(mixed.input, mixed.deps),
    (e) => e.code === "BUNDLE_REPORT_ROLE",
  );
});

test("fresh Worker receipt must bind runtime, stage Run IDs, and all four stages", async () => {
  for (const mutate of [
    (fresh) => {
      fresh.runtime = { ...fresh.runtime, commit: "c".repeat(40) };
    },
    (fresh) => {
      fresh.stageRunIds[1] = uuid(90);
    },
    (fresh) => {
      fresh.stages.pop();
    },
  ]) {
    const state = setup();
    const original = state.deps.verifyTaskWorkerReport;
    state.deps.verifyTaskWorkerReport = async (...args) => {
      const fresh = await original(...args);
      mutate(fresh);
      return fresh;
    };
    await assert.rejects(
      evaluateBundledDeliveryGate(state.input, state.deps),
      (e) => e.code === "TASK_WORKER_GATE",
    );
  }
});

test("post-merge Worker QQ evidence rejects either queued side", async () => {
  const state = setup({ postMerge: true });
  const originalVerifier = state.deps.verifyTaskWorkerReport;
  state.deps.verifyTaskWorkerReport = async () => {
    const base = await originalVerifier();
    base.stages[2].messageBinding.input.time = 2000000000;
    base.stages[2].messageBinding.input.driverTime = 2200000000;
    state.workerReport.productAcceptance.cases[2].messageBinding.input.time = 2000000000;
    state.workerReport.productAcceptance.cases[2].messageBinding.input.driverTime = 2200000000;
    return base;
  };
  await assert.rejects(
    evaluateBundledDeliveryGate(state.input, state.deps),
    (e) => e.code === "POST_MERGE_INPUT",
  );
});
