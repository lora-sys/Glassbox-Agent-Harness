import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { createHash } from "node:crypto";
import { toolManifestDigest } from "../lib/core.mjs";
import {
  archivePreRunStoppedReport,
  hasUnresolvedPreRunStopReconciliation,
  planPreRunStoppedReport,
  verifyPreRunStoppedReport,
} from "../lib/pre-run-stop-reconciliation.mjs";

const STOP_CONTENT =
  "CLEANUP_UNCONFIRMED\n请先检查 Bot 的延迟任务、目标状态和本轮报告，再人工删除此文件。\n";
const RUNTIME = {
  checkout: "/fixture/checkout",
  dataDirectory: "/fixture/data",
  commit: "a".repeat(40),
  pid: 123,
  connectionId: "qq-live",
  threadId: null,
};
const CASE = {
  id: "qq-group-a-root-files-read",
  status: "BLOCKED",
  code: "API_REJECTED",
  route: "private",
  sendAttempted: true,
  inputObserved: false,
  leaseRegistrationAttempted: true,
  leaseRevoked: true,
  token: "a".repeat(32),
  acceptanceLease: {
    leaseId: "11111111-1111-4111-8111-111111111111",
    expiresAt: Date.now() + 60_000,
    toolsSha256: "b".repeat(64),
  },
};

async function fixture(t, overrides = {}) {
  const root = await mkdtemp(join(tmpdir(), "pre-run-stop-reconciliation-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await chmod(root, 0o700);
  const out = join(root, "out");
  const reportDirectory = join(out, "2026-10-07T00-00-00.000Z_deadbeef");
  await (await import("node:fs/promises")).mkdir(reportDirectory, { recursive: true, mode: 0o700 });
  const reportPath = join(reportDirectory, "report.json");
  const stopPath = join(out, "STOP");
  const fixedSuite = await readFile(
    new URL("../examples/feature-read.example.json", import.meta.url),
  );
  const report = {
    mode: "run",
    status: "INCONCLUSIVE",
    runId: basename(reportDirectory),
    suiteSha256: createHash("sha256").update(fixedSuite).digest("hex"),
    reportDirectory,
    safetyStopCreated: true,
    cleanupStopRequired: true,
    productAcceptance: {
      status: "INCONCLUSIVE",
      code: "PRE_RUN_CLEANUP_EVIDENCE",
      cleanupVerified: false,
    },
    cases: [{ ...CASE }],
    ...overrides.report,
  };
  await writeFile(reportPath, JSON.stringify(report), { mode: 0o600 });
  await writeFile(
    join(out, "latest.json"),
    JSON.stringify({
      mode: report.mode,
      status: report.status,
      runId: report.runId,
      reportDirectory,
      productAcceptance: report.productAcceptance,
    }),
    { mode: 0o600 },
  );
  await writeFile(stopPath, overrides.stop ?? STOP_CONTENT, { mode: 0o600 });
  return { root, out, reportPath, stopPath, report };
}

function cleanupResult() {
  return {
    status: "CLEANUP_VERIFIED",
    runtime: RUNTIME,
    cases: [
      {
        caseId: CASE.id,
        leaseId: CASE.acceptanceLease.leaseId,
        marker: CASE.token,
        toolsSha256: CASE.acceptanceLease.toolsSha256,
        cleanupVerified: true,
        cleanupOnly: true,
        actualQqDeliveryVerified: false,
        featureStatus: "INCONCLUSIVE",
        zeroMarkedMessages: true,
        zeroMarkedRuns: true,
      },
    ],
  };
}

function failedReadCase() {
  return {
    ...CASE,
    id: "qq-account-status-read",
    status: "FAIL",
    code: "REPLY_ASSERTION_FAILED",
    inputObserved: true,
    sentMessageId: "1698441062",
    inputBinding: {
      driverMessageId: "1698441062",
      botMessageId: "1673552177",
      realSequence: "620",
      time: 1791382887,
      textSha256: "c".repeat(64),
    },
    replies: [
      {
        route: "private",
        messageId: "1673552180",
        textSha256: "d".repeat(64),
        textBytes: 51,
        matches: false,
        receivedAt: "2026-10-07T14:21:31.000Z",
      },
    ],
  };
}

function failedReadCleanupResult() {
  const runId = "c641b445-52e9-41de-8989-71c55980ca96";
  const caseRecord = failedReadCase();
  const proofBase = {
    proofKind: "fixed-qq-account-status-read-failed-run-v1",
    caseId: "qq-account-status-read",
    productRunId: runId,
    productRunStatus: "failed",
    productRunFailureCode: "required_evidence_missing",
    inputBinding: { ...caseRecord.inputBinding },
    reply: {
      botMessageId: "1673552181",
      driverMessageId: "1673552180",
      receivedAt: "2026-10-07T14:21:31.000Z",
      textSha256: "d".repeat(64),
      textBytes: 51,
      realSequence: "621",
      time: 1791382891,
      driverTime: 1791382891,
    },
    delivery: {
      id: "delivery-1",
      status: "sent",
      externalId: "1673552181",
      destinationScopeKey: "scope-private-owner",
    },
    lease: {
      leaseId: CASE.acceptanceLease.leaseId,
      marker: CASE.token,
      toolsSha256: CASE.acceptanceLease.toolsSha256,
      runId,
      revoked: true,
    },
    trace: {
      sessionStartCount: 2,
      toolCallCount: 3,
      toolResultCount: 3,
      statusReadCount: 1,
      identityLeaseDenialCount: 1,
      malformedInputDenialCount: 1,
      callOrder: ["invalid_input", "get_status", "get_login_info_denied_by_lease"],
    },
    authorization: {
      accountStatusReadDecisionCount: 1,
      decisionIdsSha256: "f".repeat(64),
    },
    safeRefusal: {
      textSha256: "a".repeat(64),
      textBytes: 51,
      markerAbsent: true,
      accountIdentityAbsent: true,
      numericIdentifierAbsent: true,
      refusalCuePresent: true,
    },
  };
  const proof = {
    ...proofBase,
    proofSha256: createHash("sha256").update(JSON.stringify(proofBase)).digest("hex"),
  };
  return {
    status: "CLEANUP_RECONCILED",
    runtime: RUNTIME,
    cases: [
      {
        caseId: "qq-account-status-read",
        leaseId: CASE.acceptanceLease.leaseId,
        marker: CASE.token,
        toolsSha256: CASE.acceptanceLease.toolsSha256,
        productRunId: runId,
        productRunStatus: "failed",
        productRunFailureCode: "required_evidence_missing",
        cleanupVerified: true,
        cleanupOnly: true,
        featureStatus: "FAIL",
        actualQqDeliveryVerified: true,
        productIngressVerified: true,
        productRunObserved: true,
        proof,
      },
    ],
  };
}

function verifierBusySuccessfulReadCase() {
  return {
    ...CASE,
    id: "qq-account-status-read",
    status: "PASS",
    code: "REAL_REPLY_RECEIVED",
    route: "private",
    inputObserved: true,
    sentMessageId: "1334326248",
    featureAssertions: [
      {
        kind: "trace",
        type: "tool_result",
        where: { name: "qq_account_status", isError: false },
        count: 1,
      },
    ],
    leasedToolNames: ["qq_account_status"],
    inputBinding: {
      driverMessageId: "1334326248",
      botMessageId: "1533550198",
      realSequence: "637",
      time: 1791429945,
      driverTime: 1791429945,
      textSha256: "c".repeat(64),
    },
    replies: [
      {
        route: "private",
        messageId: "130064340",
        receivedAt: "2026-10-08T03:25:59.551Z",
        textSha256: "d".repeat(64),
        textBytes: 78,
        matches: true,
      },
    ],
  };
}

function verifierBusyReportOverrides() {
  return {
    status: "BLOCKED",
    runtime: RUNTIME,
    productAcceptance: {
      status: "BLOCKED",
      code: "INTERNAL_ERROR",
      message: "测试器内部异常。未输出原始错误，以避免泄露凭证。请运行本地自检。",
      diagnostic: {
        type: "Error",
        sqliteCode: 5,
        frames: [
          { path: "tools/qq-live/lib/product-evidence.mjs", line: 493, column: 6 },
          { path: "tools/qq-live/lib/product-evidence.mjs", line: 1802, column: 22 },
          { path: "tools/qq-live/lib/product-evidence.mjs", line: 1961, column: 34 },
          { path: "tools/qq-live/cli.mjs", line: 2435, column: 21 },
        ],
      },
      cleanupVerified: false,
      cleanupRequired: true,
      cases: [],
    },
    cases: [verifierBusySuccessfulReadCase()],
  };
}

function recoveredReadCleanupResult(report) {
  const c = report.cases[0];
  const runId = "3771509a-0ff5-48b6-9d75-e9638c571182";
  const proofBase = {
    proofKind: "fixed-qq-account-status-read-verifier-busy-v1",
    caseId: c.id,
    productRunId: runId,
    productRunStatus: "succeeded",
    inputBinding: c.inputBinding,
    reply: {
      messageId: c.replies[0].messageId,
      receivedAt: c.replies[0].receivedAt,
      textSha256: c.replies[0].textSha256,
      textBytes: c.replies[0].textBytes,
      matches: true,
    },
    delivery: {
      id: "004d4870-405a-4b21-9efd-97eb1d449188",
      status: "sent",
      externalId: "1844305905",
      destinationScopeKey: "scope-private-owner",
    },
    lease: {
      leaseId: c.acceptanceLease.leaseId,
      marker: c.token,
      toolsSha256: c.acceptanceLease.toolsSha256,
      revoked: true,
    },
    verification: {
      status: "PASS",
      caseId: c.id,
      runId,
      traceVerified: true,
      cleanupVerified: true,
    },
  };
  return {
    status: "CLEANUP_RECONCILED",
    runtime: RUNTIME,
    cases: [
      {
        caseId: c.id,
        leaseId: c.acceptanceLease.leaseId,
        marker: c.token,
        toolsSha256: c.acceptanceLease.toolsSha256,
        productRunId: runId,
        productRunStatus: "succeeded",
        cleanupVerified: true,
        cleanupOnly: true,
        actualQqDeliveryVerified: true,
        productIngressVerified: true,
        productRunObserved: true,
        featureStatus: "INCONCLUSIVE",
        proof: {
          ...proofBase,
          proofSha256: createHash("sha256").update(JSON.stringify(proofBase)).digest("hex"),
        },
      },
    ],
  };
}

async function managedGroupsVerifierFailureReportOverrides() {
  const suiteBytes = await readFile(
    new URL("../examples/feature-read.example.json", import.meta.url),
  );
  const suite = JSON.parse(suiteBytes.toString("utf8"));
  const spec = suite.cases.find((item) => item.id === "qq-managed-groups-inventory-read");
  const token = "3f31fd1e6eb14164847a1653b31ee8f2";
  const leaseTools = JSON.parse(JSON.stringify(spec.leaseTools).replaceAll("{{nonce}}", token));
  return {
    status: "INCONCLUSIVE",
    runtime: RUNTIME,
    productAcceptance: {
      status: "INCONCLUSIVE",
      code: "AUTHORIZATION_EVIDENCE",
      message: "拒绝记录缺少独立且精确绑定的内容排除证据。",
      cleanupVerified: false,
      cleanupRequired: true,
      cases: [],
    },
    cases: [
      {
        ...CASE,
        id: spec.id,
        status: "PASS",
        code: "REAL_REPLY_RECEIVED",
        route: "private",
        inputObserved: true,
        sentMessageId: "1991790701",
        token,
        prompt: `GLASSBOX_ACCEPTANCE_V1 ${token}\n${spec.prompt.replaceAll("{{nonce}}", token)}`,
        expected: [token],
        featureAssertions: JSON.parse(
          JSON.stringify(spec.featureAssertions).replaceAll("{{nonce}}", token),
        ),
        leasedToolNames: leaseTools.map((tool) => tool.name),
        acceptanceLease: {
          leaseId: "8fd53a7d-f5c6-40f2-9123-cef39b979b64",
          expiresAt: 1791431342686,
          toolsSha256: toolManifestDigest(leaseTools),
        },
        inputBinding: {
          driverMessageId: "1991790701",
          botMessageId: "1878894180",
          realSequence: "649",
          time: 1791431224,
          driverTime: 1791431224,
          textSha256: "f".repeat(64),
        },
        replies: [
          {
            route: "private",
            messageId: "1145076718",
            receivedAt: "2026-10-08T03:47:20.904Z",
            textSha256: "6".repeat(64),
            textBytes: 67,
            matches: true,
          },
        ],
      },
    ],
  };
}

function managedGroupsCleanupResult(report) {
  const caseRecord = report.cases[0];
  const runId = "60eca939-64aa-4200-9f3e-a64fd8486a8d";
  const proofBase = {
    proofKind: "fixed-qq-managed-groups-inventory-read-verifier-recovery-v1",
    caseId: caseRecord.id,
    productRunId: runId,
    productRunStatus: "succeeded",
    inputBinding: caseRecord.inputBinding,
    reply: {
      messageId: caseRecord.replies[0].messageId,
      receivedAt: caseRecord.replies[0].receivedAt,
      textSha256: caseRecord.replies[0].textSha256,
      textBytes: caseRecord.replies[0].textBytes,
      matches: true,
    },
    delivery: {
      id: "delivery-managed-groups",
      status: "sent",
      externalId: "1878894180",
      destinationScopeKey: '["qq-live","3394947361","private","3526039967","3526039967",null]',
    },
    lease: {
      leaseId: caseRecord.acceptanceLease.leaseId,
      marker: caseRecord.token,
      toolsSha256: caseRecord.acceptanceLease.toolsSha256,
      revoked: true,
    },
    verification: {
      status: "PASS",
      caseId: caseRecord.id,
      runId,
      traceVerified: true,
      cleanupVerified: true,
    },
  };
  return {
    status: "CLEANUP_RECONCILED",
    runtime: RUNTIME,
    cases: [
      {
        caseId: caseRecord.id,
        leaseId: caseRecord.acceptanceLease.leaseId,
        marker: caseRecord.token,
        toolsSha256: caseRecord.acceptanceLease.toolsSha256,
        productRunId: runId,
        productRunStatus: "succeeded",
        cleanupVerified: true,
        cleanupOnly: true,
        actualQqDeliveryVerified: true,
        productIngressVerified: true,
        productRunObserved: true,
        featureStatus: "INCONCLUSIVE",
        proof: {
          ...proofBase,
          proofSha256: createHash("sha256").update(JSON.stringify(proofBase)).digest("hex"),
        },
      },
    ],
  };
}

function failedReadReportOverrides() {
  return {
    productAcceptance: {
      status: "INCONCLUSIVE",
      code: "RUN_EVIDENCE",
      cleanupRequired: true,
      cleanupVerified: false,
    },
    cases: [failedReadCase()],
  };
}

test("read-only stopped-report reconciliation binds exact report, STOP, lease and no-ingress proof", async (t) => {
  const { reportPath, stopPath } = await fixture(t);
  const config = { runtime: {} };
  const result = await verifyPreRunStoppedReport(
    { reportPath, stopPath, config },
    {
      readRuntime: () => RUNTIME,
      verifyReport: async () => cleanupResult(),
    },
  );
  assert.equal(result.status, "PRE_RUN_STOP_RECONCILED");
  assert.equal(
    result.reportSha256,
    createHash("sha256")
      .update(await readFile(reportPath))
      .digest("hex"),
  );
  assert.equal(result.stopSha256, createHash("sha256").update(STOP_CONTENT).digest("hex"));
  assert.equal(result.cleanupVerified, true);
  assert.equal(result.archiveEligible, true);
  assert.equal(result.caseStatus, "BLOCKED");
  assert.equal(result.caseCode, "API_REJECTED");
  assert.equal(result.sendAttempted, true);
  assert.equal(result.inputObserved, false);
  assert.equal(result.leaseRegistrationAttempted, true);
  assert.equal(result.leaseRevoked, true);
  assert.equal(result.actualQqDeliveryVerified, false);
  assert.equal(result.featureStatus, "INCONCLUSIVE");
  assert.equal(await readFile(stopPath, "utf8"), STOP_CONTENT);
});

test("stopped-report reconciliation rejects altered STOP and any PASS-like cleanup receipt", async (t) => {
  const wrongStop = await fixture(t, {
    stop: "CLEANUP_UNCONFIRMED\nmodified\n",
  });
  await assert.rejects(
    verifyPreRunStoppedReport(
      { ...wrongStop, config: { runtime: {} } },
      { readRuntime: () => RUNTIME, verifyReport: async () => cleanupResult() },
    ),
    { code: "PRE_RUN_STOP_CONTENT" },
  );

  const wrongSuite = await fixture(t, {
    report: { suiteSha256: "c".repeat(64) },
  });
  await assert.rejects(
    verifyPreRunStoppedReport(
      { ...wrongSuite, config: { runtime: {} } },
      { readRuntime: () => RUNTIME, verifyReport: async () => cleanupResult() },
    ),
    { code: "PRE_RUN_STOP_REPORT" },
  );

  const validFiles = await fixture(t);
  await assert.rejects(
    verifyPreRunStoppedReport(
      { ...validFiles, config: { runtime: {} } },
      {
        readRuntime: () => RUNTIME,
        verifyReport: async () => ({
          ...cleanupResult(),
          cases: [{ ...cleanupResult().cases[0], actualQqDeliveryVerified: true }],
        }),
      },
    ),
    { code: "PRE_RUN_STOP_RECONCILIATION" },
  );
});

test("approved archive moves only the planned STOP and persists cleanup-only intent and receipt", async (t) => {
  const files = await fixture(t);
  const locksDirectory = join(files.root, "locks");
  const config = { runtime: {}, driver: { qq: "10001" } };
  const readRuntime = () => RUNTIME;
  const verifyReport = async () => cleanupResult();
  const plan = await planPreRunStoppedReport(
    { reportPath: files.reportPath, stopPath: files.stopPath, config },
    { readRuntime, verifyReport, locksDirectory },
  );
  assert.equal(plan.status, "PRE_RUN_STOP_ARCHIVE_PLANNED");
  const receipt = await archivePreRunStoppedReport(plan, {
    config,
    approvedPlanSha256: plan.planSha256,
    readRuntime,
    verifyReport,
    locksDirectory,
  });
  assert.equal(receipt.status, "ARCHIVE_VERIFIED");
  assert.equal(receipt.featurePass, false);
  assert.equal(receipt.actualQqDeliveryVerified, false);
  assert.equal(receipt.cleanupOnly, true);
  assert.equal(await readFile(files.reportPath, "utf8"), JSON.stringify(files.report));
  await assert.rejects(readFile(files.stopPath), { code: "ENOENT" });
  assert.equal(await readFile(plan.plan.archivedStopPath, "utf8"), STOP_CONTENT);
  assert.equal(
    await readFile(join(plan.plan.archiveDirectory, "intent.json"), "utf8")
      .then(JSON.parse)
      .then((value) => value.status),
    "ARCHIVE_INTENT",
  );
  assert.equal(
    await readFile(join(plan.plan.archiveDirectory, "receipt.json"), "utf8")
      .then(JSON.parse)
      .then((value) => value.status),
    "ARCHIVE_VERIFIED",
  );
  assert.equal(await hasUnresolvedPreRunStopReconciliation(files.out), false);
  await writeFile(
    join(plan.plan.archiveDirectory, "receipt.json"),
    JSON.stringify({ ...receipt, archivedStopSha256: "d".repeat(64) }),
    { mode: 0o600 },
  );
  assert.equal(await hasUnresolvedPreRunStopReconciliation(files.out), true);
});

test("fixed failed-read archive binds the real failed Run and keeps feature status FAIL", async (t) => {
  const files = await fixture(t, { report: failedReadReportOverrides() });
  const locksDirectory = join(files.root, "locks");
  const config = { runtime: {}, driver: { qq: "10001" } };
  const readRuntime = () => RUNTIME;
  const verifyFailedReadReport = async () => failedReadCleanupResult();
  const plan = await planPreRunStoppedReport(
    { reportPath: files.reportPath, stopPath: files.stopPath, config },
    { readRuntime, verifyFailedReadReport, locksDirectory },
  );
  assert.equal(plan.plan.proofKind, "fixed-read-failed-run");
  assert.equal(plan.plan.productRunId, "c641b445-52e9-41de-8989-71c55980ca96");
  assert.equal(plan.plan.featureStatus, "FAIL");
  assert.equal(plan.plan.featurePass, false);
  const receipt = await archivePreRunStoppedReport(plan, {
    config,
    approvedPlanSha256: plan.planSha256,
    readRuntime,
    verifyFailedReadReport,
    locksDirectory,
  });
  assert.equal(receipt.status, "ARCHIVE_VERIFIED");
  assert.equal(receipt.featurePass, false);
  assert.equal(receipt.featureStatus, "FAIL");
  assert.equal(receipt.actualQqDeliveryVerified, true);
  assert.equal(receipt.productRunObserved, true);
  assert.equal(receipt.productRunId, "c641b445-52e9-41de-8989-71c55980ca96");
  assert.equal(Object.hasOwn(receipt, "zeroMarkedRuns"), false);
  assert.equal(await hasUnresolvedPreRunStopReconciliation(files.out), false);

  const receiptPath = join(plan.plan.archiveDirectory, "receipt.json");
  const saved = JSON.parse(await readFile(receiptPath, "utf8"));
  saved.plan.failedReadProof.safeRefusal.markerAbsent = false;
  saved.failedReadProof.safeRefusal.markerAbsent = false;
  await writeFile(receiptPath, JSON.stringify(saved), { mode: 0o600 });
  assert.equal(await hasUnresolvedPreRunStopReconciliation(files.out), true);
});

test("fixed failed-read archive rejects a different product Run failure code", async (t) => {
  const files = await fixture(t, { report: failedReadReportOverrides() });
  const bad = failedReadCleanupResult();
  bad.cases[0].productRunFailureCode = "some_other_failure";
  await assert.rejects(
    planPreRunStoppedReport(
      {
        reportPath: files.reportPath,
        stopPath: files.stopPath,
        config: { runtime: {} },
      },
      { readRuntime: () => RUNTIME, verifyFailedReadReport: async () => bad },
    ),
    { code: "PRE_RUN_STOP_RECONCILIATION" },
  );
});

test("fixed failed-read archive rejects a proof whose report input binding differs", async (t) => {
  const files = await fixture(t, { report: failedReadReportOverrides() });
  const bad = failedReadCleanupResult();
  bad.cases[0].proof.inputBinding.driverMessageId = "1999999999";
  const { proofSha256: _removed, ...proofBase } = bad.cases[0].proof;
  bad.cases[0].proof.proofSha256 = createHash("sha256")
    .update(JSON.stringify(proofBase))
    .digest("hex");
  await assert.rejects(
    planPreRunStoppedReport(
      {
        reportPath: files.reportPath,
        stopPath: files.stopPath,
        config: { runtime: {} },
      },
      { readRuntime: () => RUNTIME, verifyFailedReadReport: async () => bad },
    ),
    { code: "PRE_RUN_STOP_RECONCILIATION" },
  );
});

test("sqlite verifier-busy cleanup rechecks the exact successful fixed read and does not set featurePass", async (t) => {
  const files = await fixture(t, { report: verifierBusyReportOverrides() });
  const locksDirectory = join(files.root, "locks");
  const config = { runtime: {}, driver: { qq: "10001" } };
  const readRuntime = () => RUNTIME;
  const verifyRecoveredReadReport = async (report) => recoveredReadCleanupResult(report);
  const plan = await planPreRunStoppedReport(
    { reportPath: files.reportPath, stopPath: files.stopPath, config },
    { readRuntime, verifyRecoveredReadReport, locksDirectory },
  );
  assert.equal(plan.plan.proofKind, "fixed-read-verifier-busy-success");
  assert.equal(plan.plan.productRunId, "3771509a-0ff5-48b6-9d75-e9638c571182");
  assert.equal(plan.plan.productRunStatus, "succeeded");
  assert.equal(plan.plan.featurePass, false);
  assert.equal(plan.plan.featureStatus, "INCONCLUSIVE");
  const originalReport = await readFile(files.reportPath, "utf8");
  const receipt = await archivePreRunStoppedReport(plan, {
    config,
    approvedPlanSha256: plan.planSha256,
    readRuntime,
    verifyRecoveredReadReport,
    locksDirectory,
  });
  assert.equal(receipt.status, "ARCHIVE_VERIFIED");
  assert.equal(receipt.featurePass, false);
  assert.equal(receipt.featureStatus, "INCONCLUSIVE");
  assert.equal(receipt.actualQqDeliveryVerified, true);
  assert.equal(receipt.productRunObserved, true);
  assert.equal(receipt.productRunStatus, "succeeded");
  assert.equal(await readFile(files.reportPath, "utf8"), originalReport);
  assert.equal(await hasUnresolvedPreRunStopReconciliation(files.out), false);
});

test("sqlite verifier-busy cleanup rejects other SQLite codes, stacks, or altered tool assertions", async (t) => {
  for (const mutate of [
    (report) => {
      report.productAcceptance.diagnostic.sqliteCode = 6;
    },
    (report) => {
      report.productAcceptance.diagnostic.frames[0].line += 1;
    },
    (report) => {
      report.cases[0].featureAssertions[0].where.name = "qq_group_info";
    },
    (report) => {
      report.cases[0].leaseRevoked = false;
    },
  ]) {
    const files = await fixture(t, { report: verifierBusyReportOverrides() });
    const report = JSON.parse(await readFile(files.reportPath, "utf8"));
    mutate(report);
    await writeFile(files.reportPath, JSON.stringify(report), { mode: 0o600 });
    let verifierCalled = false;
    await assert.rejects(
      verifyPreRunStoppedReport(
        {
          reportPath: files.reportPath,
          stopPath: files.stopPath,
          config: { runtime: {} },
        },
        {
          readRuntime: () => RUNTIME,
          verifyRecoveredReadReport: async () => {
            verifierCalled = true;
            return recoveredReadCleanupResult(report);
          },
        },
      ),
      { code: "PRE_RUN_STOP_REPORT" },
    );
    assert.equal(verifierCalled, false);
  }
});

test("sqlite verifier-busy archive refuses a changed independent proof at final recheck", async (t) => {
  const files = await fixture(t, { report: verifierBusyReportOverrides() });
  const locksDirectory = join(files.root, "locks");
  const config = { runtime: {}, driver: { qq: "10001" } };
  let calls = 0;
  const verifyRecoveredReadReport = async (report) => {
    const result = recoveredReadCleanupResult(report);
    calls += 1;
    if (calls > 2) result.cases[0].proof.verification.traceVerified = false;
    return result;
  };
  const deps = { readRuntime: () => RUNTIME, verifyRecoveredReadReport, locksDirectory };
  const plan = await planPreRunStoppedReport(
    { reportPath: files.reportPath, stopPath: files.stopPath, config },
    deps,
  );
  await assert.rejects(
    archivePreRunStoppedReport(plan, {
      ...deps,
      config,
      approvedPlanSha256: plan.planSha256,
    }),
    { code: "PRE_RUN_STOP_FINAL_RECHECK" },
  );
  assert.equal(await readFile(files.stopPath, "utf8"), STOP_CONTENT);
  assert.equal(await hasUnresolvedPreRunStopReconciliation(files.out), true);
});

test("managed-groups authorization-verifier recovery rechecks the fixed successful case and remains inconclusive", async (t) => {
  const reportOverrides = await managedGroupsVerifierFailureReportOverrides();
  const files = await fixture(t, { report: reportOverrides });
  const config = { runtime: {}, driver: { qq: "10001" } };
  const locksDirectory = join(files.root, "locks");
  const readRuntime = () => RUNTIME;
  let verificationCount = 0;
  const verifyRecoveredGroupsReport = async (report, receivedConfig) => {
    verificationCount += 1;
    assert.equal(receivedConfig, config);
    assert.equal(report.status, "INCONCLUSIVE");
    assert.equal(report.cases[0].id, "qq-managed-groups-inventory-read");
    return managedGroupsCleanupResult(report);
  };
  const original = await readFile(files.reportPath, "utf8");
  const plan = await planPreRunStoppedReport(
    { reportPath: files.reportPath, stopPath: files.stopPath, config },
    { readRuntime, verifyRecoveredGroupsReport, locksDirectory },
  );
  assert.equal(plan.plan.proofKind, "fixed-groups-verifier-recovery-success");
  assert.equal(plan.plan.caseId, "qq-managed-groups-inventory-read");
  assert.equal(plan.plan.productRunStatus, "succeeded");
  assert.equal(plan.plan.featurePass, false);
  assert.equal(plan.plan.featureStatus, "INCONCLUSIVE");
  const receipt = await archivePreRunStoppedReport(plan, {
    config,
    approvedPlanSha256: plan.planSha256,
    readRuntime,
    verifyRecoveredGroupsReport,
    locksDirectory,
  });
  assert.equal(receipt.status, "ARCHIVE_VERIFIED");
  assert.equal(receipt.featurePass, false);
  assert.equal(receipt.featureStatus, "INCONCLUSIVE");
  assert.equal(receipt.actualQqDeliveryVerified, true);
  assert.equal(receipt.productIngressVerified, true);
  assert.equal(receipt.productRunStatus, "succeeded");
  assert.equal(verificationCount, 3);
  assert.equal(await readFile(files.reportPath, "utf8"), original);
  assert.equal(await hasUnresolvedPreRunStopReconciliation(files.out), false);
});

test("managed-groups recovery rejects changed fixed case metadata before calling the verifier", async (t) => {
  for (const mutate of [
    (report) => {
      report.productAcceptance.code = "RUN_EVIDENCE";
    },
    (report) => {
      report.cases[0].prompt += " extra";
    },
    (report) => {
      report.cases[0].featureAssertions[0].where.name = "qq_group_info";
    },
    (report) => {
      report.cases[0].acceptanceLease.toolsSha256 = "a".repeat(64);
    },
    (report) => {
      report.cases[0].leaseRevoked = false;
    },
  ]) {
    const reportOverrides = await managedGroupsVerifierFailureReportOverrides();
    const files = await fixture(t, { report: reportOverrides });
    const report = JSON.parse(await readFile(files.reportPath, "utf8"));
    mutate(report);
    await writeFile(files.reportPath, JSON.stringify(report), { mode: 0o600 });
    let verifierCalled = false;
    await assert.rejects(
      verifyPreRunStoppedReport(
        {
          reportPath: files.reportPath,
          stopPath: files.stopPath,
          config: { runtime: {} },
        },
        {
          readRuntime: () => RUNTIME,
          verifyRecoveredGroupsReport: async () => {
            verifierCalled = true;
            return managedGroupsCleanupResult(report);
          },
        },
      ),
      { code: "PRE_RUN_STOP_REPORT" },
    );
    assert.equal(verifierCalled, false);
  }
});

test("managed-groups recovery refuses a changed independent proof during archive final recheck", async (t) => {
  const reportOverrides = await managedGroupsVerifierFailureReportOverrides();
  const files = await fixture(t, { report: reportOverrides });
  const config = { runtime: {}, driver: { qq: "10001" } };
  const locksDirectory = join(files.root, "locks");
  let verificationCount = 0;
  const verifyRecoveredGroupsReport = async (report) => {
    verificationCount += 1;
    const result = managedGroupsCleanupResult(report);
    if (verificationCount === 3) {
      result.cases[0].proof.delivery.destinationScopeKey = "changed-scope";
      const { proofSha256: _oldDigest, ...proofBase } = result.cases[0].proof;
      result.cases[0].proof.proofSha256 = createHash("sha256")
        .update(JSON.stringify(proofBase))
        .digest("hex");
    }
    return result;
  };
  const plan = await planPreRunStoppedReport(
    { reportPath: files.reportPath, stopPath: files.stopPath, config },
    { readRuntime: () => RUNTIME, verifyRecoveredGroupsReport, locksDirectory },
  );
  await assert.rejects(
    archivePreRunStoppedReport(plan, {
      config,
      approvedPlanSha256: plan.planSha256,
      readRuntime: () => RUNTIME,
      verifyRecoveredGroupsReport,
      locksDirectory,
    }),
    { code: "PRE_RUN_STOP_FINAL_RECHECK" },
  );
  assert.equal(await readFile(files.stopPath, "utf8"), STOP_CONTENT);
});

test("sent INPUT_NOT_OBSERVED cleanup stays inconclusive and binds dual-account delivery", async (t) => {
  const files = await fixture(t, {
    report: {
      productAcceptance: {
        status: "INCONCLUSIVE",
        code: "LEASE_CLEANUP_EVIDENCE",
        cleanupRequired: true,
        cleanupVerified: false,
        cases: [],
      },
      cases: [
        {
          ...CASE,
          id: "ops-status-read",
          status: "INCONCLUSIVE",
          code: "INPUT_NOT_OBSERVED",
          sentMessageId: "1661975217",
        },
      ],
    },
  });
  const config = { runtime: {}, driver: { qq: "10001" } };
  const delivery = {
    verified: true,
    ownerMessageId: "1661975217",
    botMessageId: "177755181",
    realSequence: "617",
    time: 1791381344,
    textSha256: "0e7a8856ad005b901b311aa2244ef3d991843b4fe02e09a00570c40f89af7c08",
    textBytes: 238,
  };
  const verifyReport = async () => ({
    status: "CLEANUP_RECONCILED",
    runtime: RUNTIME,
    cases: [
      {
        caseId: "ops-status-read",
        leaseId: CASE.acceptanceLease.leaseId,
        marker: CASE.token,
        toolsSha256: CASE.acceptanceLease.toolsSha256,
        cleanupVerified: true,
        cleanupOnly: true,
        actualQqDeliveryVerified: true,
        productIngressVerified: false,
        productRunObserved: false,
        featureStatus: "INCONCLUSIVE",
        zeroMarkedMessages: true,
        zeroMarkedRuns: true,
        dualAccountDelivery: delivery,
      },
    ],
  });
  const plan = await planPreRunStoppedReport(
    { reportPath: files.reportPath, stopPath: files.stopPath, config },
    {
      readRuntime: () => RUNTIME,
      verifyReport,
      locksDirectory: join(files.root, "locks"),
    },
  );
  assert.equal(plan.plan.proofKind, "pre-run-sent-no-ingress");
  assert.equal(plan.plan.actualQqDeliveryVerified, true);
  assert.equal(plan.plan.productIngressVerified, false);
  assert.equal(plan.plan.productRunObserved, false);
  assert.equal(plan.plan.featurePass, false);
  const receipt = await archivePreRunStoppedReport(plan, {
    config,
    approvedPlanSha256: plan.planSha256,
    readRuntime: () => RUNTIME,
    verifyReport,
    locksDirectory: join(files.root, "locks"),
  });
  assert.equal(receipt.status, "ARCHIVE_VERIFIED");
  assert.equal(receipt.actualQqDeliveryVerified, true);
  assert.equal(receipt.productIngressVerified, false);
  assert.equal(receipt.productRunObserved, false);
  assert.equal(receipt.featurePass, false);
  assert.equal(await hasUnresolvedPreRunStopReconciliation(files.out), false);
  for (const [field, value] of [
    ["runId", "unexpected-run"],
    ["inputBinding", { botMessageId: "123" }],
  ]) {
    const altered = await fixture(t, {
      report: {
        productAcceptance: {
          status: "INCONCLUSIVE",
          code: "LEASE_CLEANUP_EVIDENCE",
          cleanupRequired: true,
          cleanupVerified: false,
          cases: [],
        },
        cases: [
          {
            ...CASE,
            id: "ops-status-read",
            status: "INCONCLUSIVE",
            code: "INPUT_NOT_OBSERVED",
            sentMessageId: "1661975217",
            [field]: value,
          },
        ],
      },
    });
    await assert.rejects(
      verifyPreRunStoppedReport(
        { reportPath: altered.reportPath, stopPath: altered.stopPath, config },
        { readRuntime: () => RUNTIME, verifyReport },
      ),
      { code: "PRE_RUN_STOP_REPORT" },
    );
  }
});

test("group-members policy pending guard blocks pre-run STOP archive planning", async (t) => {
  const files = await fixture(t);
  const locksDirectory = join(files.root, "locks");
  await (await import("node:fs/promises")).mkdir(locksDirectory, { mode: 0o700 });
  const suffix = `${createHash("sha256").update("10001").digest("hex").slice(0, 24)}.group-members-policy-pending.json`;
  await writeFile(join(locksDirectory, suffix), "pending", { mode: 0o600 });
  await assert.rejects(
    planPreRunStoppedReport(
      {
        reportPath: files.reportPath,
        stopPath: files.stopPath,
        config: { runtime: {}, driver: { qq: "10001" } },
      },
      {
        readRuntime: () => RUNTIME,
        verifyReport: async () => cleanupResult(),
        locksDirectory,
      },
    ),
    { code: "PRE_RUN_STOP_ACTIVE_OR_PENDING" },
  );
});

test("pre-run stop fence accepts the historical API rejection receipt schema", async (t) => {
  const files = await fixture(t);
  const locksDirectory = join(files.root, "locks");
  const config = { runtime: {}, driver: { qq: "10001" } };
  const plan = await planPreRunStoppedReport(
    { reportPath: files.reportPath, stopPath: files.stopPath, config },
    {
      readRuntime: () => RUNTIME,
      verifyReport: async () => cleanupResult(),
      locksDirectory,
    },
  );
  const receipt = await archivePreRunStoppedReport(plan, {
    config,
    approvedPlanSha256: plan.planSha256,
    readRuntime: () => RUNTIME,
    verifyReport: async () => cleanupResult(),
    locksDirectory,
  });
  const planRecord = { ...receipt.plan };
  delete planRecord.proofKind;
  const legacyReceipt = { ...receipt, plan: planRecord };
  delete legacyReceipt.proofKind;
  legacyReceipt.planSha256 = createHash("sha256").update(JSON.stringify(planRecord)).digest("hex");
  const receiptPath = join(plan.plan.archiveDirectory, "receipt.json");
  await writeFile(receiptPath, JSON.stringify(legacyReceipt, null, 2) + "\n", {
    mode: 0o600,
  });
  const intentPath = join(plan.plan.archiveDirectory, "intent.json");
  const intent = JSON.parse(await readFile(intentPath, "utf8"));
  intent.planSha256 = legacyReceipt.planSha256;
  await writeFile(intentPath, JSON.stringify(intent, null, 2) + "\n", {
    mode: 0o600,
  });
  assert.equal(await hasUnresolvedPreRunStopReconciliation(files.out), false);
});

test("a crash after STOP rename leaves an intent that blocks later runs", async (t) => {
  const files = await fixture(t);
  const locksDirectory = join(files.root, "locks");
  const config = { runtime: {}, driver: { qq: "10001" } };
  const planned = await planPreRunStoppedReport(
    { reportPath: files.reportPath, stopPath: files.stopPath, config },
    {
      readRuntime: () => RUNTIME,
      verifyReport: async () => cleanupResult(),
      locksDirectory,
    },
  );
  const plan = planned.plan;
  await (
    await import("node:fs/promises")
  ).mkdir(plan.archiveDirectory, { recursive: true, mode: 0o700 });
  await writeFile(
    join(plan.archiveDirectory, "intent.json"),
    JSON.stringify({
      schemaVersion: 1,
      kind: "qq-live-pre-run-stop-archive-intent",
      status: "ARCHIVE_INTENT",
      planSha256: planned.planSha256,
      reportSha256: plan.reportSha256,
      latestSha256: plan.latestSha256,
      stopSha256: plan.stopSha256,
      stopFingerprint: plan.stopFingerprint,
      stopPath: plan.stopPath,
      archivedStopPath: plan.archivedStopPath,
      runId: plan.runId,
    }),
    { mode: 0o600 },
  );
  await (await import("node:fs/promises")).rename(files.stopPath, plan.archivedStopPath);
  assert.equal(await hasUnresolvedPreRunStopReconciliation(files.out), true);
});

test("archive approval rejects changed latest receipt and active account lock", async (t) => {
  const files = await fixture(t);
  const locksDirectory = join(files.root, "locks");
  const config = { runtime: {}, driver: { qq: "10001" } };
  const deps = {
    readRuntime: () => RUNTIME,
    verifyReport: async () => cleanupResult(),
    locksDirectory,
  };
  const plan = await planPreRunStoppedReport(
    { reportPath: files.reportPath, stopPath: files.stopPath, config },
    deps,
  );
  await writeFile(
    join(files.out, "latest.json"),
    JSON.stringify({
      mode: "run",
      status: "PASS",
      runId: files.report.runId,
      reportDirectory: files.report.reportDirectory,
      productAcceptance: { status: "PASS", code: "PASS" },
    }),
    { mode: 0o600 },
  );
  await assert.rejects(
    archivePreRunStoppedReport(plan, {
      ...deps,
      config,
      approvedPlanSha256: plan.planSha256,
    }),
    { code: "PRE_RUN_STOP_LATEST" },
  );

  const locked = await fixture(t);
  const lockedRoot = join(locked.root, "locks");
  const lockPath = join(
    lockedRoot,
    `${createHash("sha256").update(config.driver.qq).digest("hex").slice(0, 24)}.lock`,
  );
  await (await import("node:fs/promises")).mkdir(lockedRoot, { mode: 0o700 });
  await writeFile(lockPath, "active", { mode: 0o600 });
  await assert.rejects(
    planPreRunStoppedReport(
      { reportPath: locked.reportPath, stopPath: locked.stopPath, config },
      { ...deps, locksDirectory: lockedRoot },
    ),
    { code: "PRE_RUN_STOP_ACTIVE_OR_PENDING" },
  );
});
