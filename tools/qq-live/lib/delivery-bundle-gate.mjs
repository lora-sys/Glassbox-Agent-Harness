import { isDeepStrictEqual } from "node:util";
import { digest, fail } from "./core.mjs";
import { evaluateDeliveryGate } from "./delivery-gate.mjs";
import { parseDeliveryBundle } from "./delivery-bundle.mjs";
import { resolveFeatureSuite } from "./feature-suite.mjs";
import { TASK_WORKER_FAMILY_ID } from "./task-worker-scenario.mjs";
import { MEDIA_FAMILY_ID } from "./media-scenario.mjs";
import { validMessageTimeBinding } from "./message-binding.mjs";

const SHA256 = /^[a-f0-9]{64}$/u;
const COMMIT = /^[a-f0-9]{40}$/u;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu;
const STAGES = ["create", "delegate", "inspect", "accept"];
const CASE_IDS = STAGES.map((stage) => `task-worker-${stage}`);
const INPUT_KEYS = [
  "botMessageId",
  "driverMessageId",
  "realSequence",
  "time",
  "driverTime",
  "textSha256",
];

function invalid(code, message) {
  fail(code, message);
}

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, keys) {
  return record(value) && isDeepStrictEqual(Object.keys(value).sort(), [...keys].sort());
}

function developmentRuntimeEvidence(report) {
  const runtimeIsNotClean = (runtime) =>
    runtime !== null &&
    typeof runtime === "object" &&
    ["development", "sourceTreeSha256", "expectedSourceTreeSha256", "launchSourceTreeSha256"].some(
      (key) => Object.hasOwn(runtime, key),
    );
  return (
    runtimeIsNotClean(report?.runtime) || runtimeIsNotClean(report?.productAcceptance?.runtime)
  );
}

function validateInputMetadata(value) {
  if (
    !exactKeys(value, INPUT_KEYS) ||
    typeof value.botMessageId !== "string" ||
    !value.botMessageId ||
    typeof value.driverMessageId !== "string" ||
    !value.driverMessageId ||
    typeof value.realSequence !== "string" ||
    !/^\d{1,30}$/u.test(value.realSequence) ||
    !validMessageTimeBinding(value) ||
    !Object.hasOwn(value, "driverTime") ||
    !SHA256.test(value.textSha256 ?? "")
  )
    invalid("TASK_WORKER_GATE", "Task Worker fresh message binding is invalid.");
  return value;
}

function validateWorkerReceipt(report, receipt, commit, suiteSha256, verifyTaskWorkerReport) {
  if (
    receipt?.status !== "PASS" ||
    receipt.familyId !== TASK_WORKER_FAMILY_ID ||
    receipt.runtime?.commit !== commit ||
    !isDeepStrictEqual(receipt.runtime, report.runtime) ||
    !isDeepStrictEqual(receipt.runtime, report.productAcceptance?.runtime) ||
    !UUID.test(receipt.taskId ?? "") ||
    !UUID.test(receipt.attemptId ?? "") ||
    !UUID.test(receipt.bindingId ?? "") ||
    receipt.terminalStatus !== "DONE" ||
    receipt.cleanupVerified !== true ||
    receipt.dispatchVerified !== true ||
    !Array.isArray(receipt.stageRunIds) ||
    receipt.stageRunIds.length !== STAGES.length ||
    receipt.stageRunIds.some((id) => typeof id !== "string" || !UUID.test(id)) ||
    new Set(receipt.stageRunIds).size !== STAGES.length ||
    !Array.isArray(receipt.stages) ||
    receipt.stages.length !== STAGES.length ||
    !Array.isArray(report.taskWorkerReceipts) ||
    report.taskWorkerReceipts.length !== STAGES.length ||
    !Array.isArray(report.cases) ||
    report.cases.length !== STAGES.length ||
    !Array.isArray(report.productAcceptance?.cases) ||
    report.productAcceptance.cases.length !== STAGES.length ||
    report.productAcceptance.status !== "PASS" ||
    report.productAcceptance.cleanupVerified !== true ||
    report.taskWorkerAcceptance?.status !== "PASS" ||
    report.taskWorkerAcceptance.familyId !== TASK_WORKER_FAMILY_ID ||
    report.taskWorkerAcceptance.taskId !== receipt.taskId ||
    report.taskWorkerAcceptance.creationRunId !== receipt.stageRunIds[0] ||
    report.taskWorkerAcceptance.attemptId !== receipt.attemptId ||
    report.taskWorkerAcceptance.bindingId !== receipt.bindingId ||
    report.taskWorkerAcceptance.terminalStatus !== "DONE" ||
    !isDeepStrictEqual(report.taskWorkerAcceptance.stageRunIds, receipt.stageRunIds) ||
    !isDeepStrictEqual(report.taskWorkerAcceptance.cleanup, {
      acceptanceLeasesRevoked: true,
      workerLeaseReleased: true,
      pendingAttentionCount: 0,
    })
  )
    invalid("TASK_WORKER_GATE", "Task Worker report does not match its fresh historical receipt.");

  let previousCreated = -Infinity;
  const normalizedStages = [];
  for (let index = 0; index < STAGES.length; index += 1) {
    const stage = STAGES[index];
    const freshStage = receipt.stages[index];
    const reportReceipt = report.taskWorkerReceipts[index];
    const transportCase = report.cases[index];
    const productCase = report.productAcceptance.cases[index];
    const created = Date.parse(freshStage?.runCreatedAt ?? "");
    if (
      !exactKeys(freshStage, ["stage", "runId", "runCreatedAt", "messageBinding"]) ||
      freshStage.stage !== stage ||
      freshStage.runId !== receipt.stageRunIds[index] ||
      !Number.isFinite(created) ||
      created <= previousCreated ||
      !record(freshStage.messageBinding) ||
      !exactKeys(freshStage.messageBinding, ["input"]) ||
      !exactKeys(reportReceipt, [
        "stage",
        "runId",
        "taskId",
        "principalId",
        "principalKind",
        "scope",
        "cleanupVerified",
        ...(stage === "create" ? ["creationRunId", "taskStatus", "attemptId", "bindingId"] : []),
        ...(stage === "delegate"
          ? [
              "attemptId",
              "bindingId",
              "creationRunId",
              "workspaceId",
              "herdrSession",
              "agentKind",
              "dispatchVerified",
              "taskStatus",
              "attemptStatus",
            ]
          : []),
        ...(stage === "inspect"
          ? [
              "attemptId",
              "bindingId",
              "creationRunId",
              "taskStatus",
              "attemptStatus",
              "workerTerminalVerified",
            ]
          : []),
        ...(stage === "accept"
          ? [
              "attemptId",
              "bindingId",
              "creationRunId",
              "taskStatus",
              "acceptedRunId",
              "attemptStatus",
              "workerLeaseReleased",
              "terminalVerified",
              "pendingAttentionCount",
            ]
          : []),
        ...(stage === "inspect" ? ["artifact"] : []),
      ]) ||
      reportReceipt.stage !== stage ||
      reportReceipt.runId !== freshStage.runId ||
      reportReceipt.taskId !== receipt.taskId ||
      reportReceipt.cleanupVerified !== true ||
      transportCase?.id !== CASE_IDS[index] ||
      transportCase.runId !== freshStage.runId ||
      productCase?.caseId !== CASE_IDS[index] ||
      productCase.runId !== freshStage.runId ||
      productCase.traceVerified !== true
    )
      invalid("TASK_WORKER_GATE", `Task Worker ${stage} report is not bound to the fresh receipt.`);
    const input = validateInputMetadata(freshStage.messageBinding.input);
    if (!isDeepStrictEqual(productCase.messageBinding?.input, input))
      invalid(
        "TASK_WORKER_GATE",
        "Task Worker report input differs from the fresh message binding.",
      );
    previousCreated = created;
    normalizedStages.push({
      stage,
      runId: freshStage.runId,
      runCreatedAt: new Date(created).toISOString(),
      messageBinding: { input: structuredClone(input) },
    });
  }
  return { receipt, stages: normalizedStages };
}

function validateResolvedMembers(bundle, memberSuiteTexts, suiteConfig) {
  const hasMedia = bundle.suites.some((entry) => entry.role === "media");
  const memberKeys = hasMedia ? ["coverage", "media", "task-worker"] : ["coverage", "task-worker"];
  if (
    !exactKeys(memberSuiteTexts, memberKeys) ||
    typeof memberSuiteTexts.coverage !== "string" ||
    typeof memberSuiteTexts["task-worker"] !== "string" ||
    (hasMedia && typeof memberSuiteTexts.media !== "string") ||
    Object.values(memberSuiteTexts).some((text) => Buffer.byteLength(text, "utf8") > 100000)
  )
    invalid("BUNDLE_SUITE_BINDING", "Delivery bundle member suite text is missing or invalid.");
  const entries = new Map(bundle.suites.map((entry) => [entry.role, entry]));
  const hashes = {
    coverage: digest(memberSuiteTexts.coverage),
    "task-worker": digest(memberSuiteTexts["task-worker"]),
    ...(hasMedia ? { media: digest(memberSuiteTexts.media) } : {}),
  };
  if (
    hashes.coverage !== entries.get("coverage")?.sha256 ||
    hashes["task-worker"] !== entries.get("task-worker")?.sha256 ||
    hashes.coverage === hashes["task-worker"]
  )
    invalid(
      "BUNDLE_SUITE_BINDING",
      "Delivery bundle member text does not match its approved raw hash.",
    );
  let coverageRaw;
  let taskWorkerRaw;
  let mediaRaw;
  try {
    coverageRaw = JSON.parse(memberSuiteTexts.coverage);
    taskWorkerRaw = JSON.parse(memberSuiteTexts["task-worker"]);
    if (hasMedia) mediaRaw = JSON.parse(memberSuiteTexts.media);
  } catch {
    invalid("BUNDLE_SUITE_BINDING", "Delivery bundle member suite is not valid JSON.");
  }
  let coverageSuite;
  let taskWorkerSuite;
  let mediaSuite;
  try {
    coverageSuite = resolveFeatureSuite(coverageRaw, suiteConfig);
    taskWorkerSuite = resolveFeatureSuite(taskWorkerRaw, suiteConfig);
    if (hasMedia) mediaSuite = resolveFeatureSuite(mediaRaw, suiteConfig);
  } catch {
    invalid(
      "BUNDLE_SUITE_BINDING",
      "Delivery bundle member suite does not match a supported fixed schema.",
    );
  }
  if (
    coverageSuite.taskWorkerFamilies?.length ||
    taskWorkerRaw?.schemaVersion !== 8 ||
    taskWorkerSuite.taskWorkerFamilies?.length !== 1 ||
    taskWorkerSuite.cases?.length !== 1 ||
    taskWorkerSuite.taskWorkerFamilies[0]?.id !== TASK_WORKER_FAMILY_ID ||
    (hasMedia &&
      (mediaRaw?.schemaVersion !== 7 ||
        mediaSuite.mediaFamilies?.length !== 1 ||
        mediaSuite.cases?.length !== 1 ||
        mediaSuite.mediaFamilies[0]?.id !== MEDIA_FAMILY_ID))
  )
    invalid(
      "BUNDLE_SUITE_ROLES",
      "Coverage and Task Worker suites are assigned to the wrong bundle roles.",
    );
  return {
    coverageText: memberSuiteTexts.coverage,
    coverageSuite,
    taskWorkerSuite,
    mediaSuite,
    hashes,
  };
}

function partitionReports(reports, hashes) {
  if (!Array.isArray(reports) || !reports.length)
    invalid("BUNDLE_REPORTS", "Delivery bundle needs coverage and Task Worker reports.");
  const coverage = [];
  const taskWorker = [];
  const media = [];
  const runIds = new Set();
  for (const report of reports) {
    if (!record(report) || typeof report.suiteSha256 !== "string")
      invalid("BUNDLE_REPORT_HASH", "A report is missing its approved member suite hash.");
    let target;
    if (report.suiteSha256 === hashes.coverage) target = coverage;
    else if (report.suiteSha256 === hashes["task-worker"]) target = taskWorker;
    else if (hashes.media && report.suiteSha256 === hashes.media) target = media;
    else invalid("BUNDLE_REPORT_HASH", "A report is not bound to either approved bundle member.");
    if (developmentRuntimeEvidence(report))
      invalid(
        "DEVELOPMENT_RUNTIME",
        "Explicit development evidence cannot enter a delivery bundle.",
      );
    if (target === coverage) {
      if (
        report.taskWorkerFamily !== undefined ||
        report.taskWorkerReceipts !== undefined ||
        report.taskWorkerAcceptance !== undefined ||
        report.taskWorkerGuardLifecycle !== undefined
      )
        invalid("BUNDLE_REPORT_ROLE", "A Task Worker report is assigned to the coverage suite.");
    } else if (
      (target === taskWorker &&
        (report.taskWorkerFamily?.familyId !== TASK_WORKER_FAMILY_ID ||
          report.taskWorkerAcceptance?.familyId !== TASK_WORKER_FAMILY_ID ||
          report.memoryLifecycle !== undefined ||
          report.memoryFamily !== undefined ||
          report.historyFamily !== undefined ||
          report.tasteFamily !== undefined ||
          report.mediaFamily !== undefined)) ||
      (target === media &&
        (report.mediaFamilyAcceptance?.familyId !== MEDIA_FAMILY_ID ||
          report.taskWorkerFamily !== undefined ||
          report.taskWorkerAcceptance !== undefined ||
          report.memoryFamily !== undefined ||
          report.historyFamily !== undefined ||
          report.tasteFamily !== undefined))
    )
      invalid(
        "BUNDLE_REPORT_ROLE",
        "The Task Worker suite report contains a different report family.",
      );
    for (const item of report.cases ?? []) {
      if (typeof item.runId !== "string" || !item.runId || runIds.has(item.runId))
        invalid(
          "BUNDLE_REPORT_DUPLICATE",
          "Delivery bundle reports repeat or omit a Run identity.",
        );
      runIds.add(item.runId);
    }
    target.push(report);
  }
  if (
    !coverage.length ||
    taskWorker.length !== 1 ||
    (hashes.media ? media.length !== 1 : media.length !== 0)
  )
    invalid(
      "BUNDLE_REPORTS",
      "Delivery bundle needs coverage reports and exactly one Task Worker report.",
    );
  return { coverage, taskWorker: taskWorker[0], media: media[0] };
}

function validateMediaReceipt(report, receipt, suiteSha256, commit) {
  const cases = report?.cases;
  const productCases = report?.productAcceptance?.cases;
  const family = report?.mediaFamilyAcceptance;
  const stages = receipt?.stages;
  if (
    typeof receipt !== "object" ||
    receipt === null ||
    Array.isArray(receipt) ||
    receipt.status !== "PASS" ||
    receipt.familyId !== MEDIA_FAMILY_ID ||
    receipt.runtime?.commit !== commit ||
    receipt.runtime?.commit !== report.runtime?.commit ||
    receipt.cleanupVerified !== true ||
    receipt.actualQqDeliveryVerified !== true ||
    report.status !== "PASS" ||
    report.mode !== "run" ||
    report.suiteSha256 !== suiteSha256 ||
    report.productAcceptance?.status !== "PASS" ||
    report.productAcceptance.cleanupVerified !== true ||
    report.productAcceptance.runtime?.commit !== commit ||
    report.plannedCaseCount !== 2 ||
    report.executedCaseCount !== 2 ||
    !Array.isArray(cases) ||
    cases.length !== 2 ||
    !Array.isArray(productCases) ||
    productCases.length !== 2 ||
    family?.familyId !== MEDIA_FAMILY_ID ||
    family.status !== "PASS" ||
    !Array.isArray(family.stageRunIds) ||
    family.stageRunIds.length !== 2 ||
    !Array.isArray(receipt.stageRunIds) ||
    receipt.stageRunIds.length !== 2 ||
    !Array.isArray(stages) ||
    stages.length !== 2 ||
    !Array.isArray(receipt.retainedAssets) ||
    receipt.retainedAssets.length !== 2 ||
    new Set(receipt.stageRunIds).size !== 2 ||
    !isDeepStrictEqual(receipt.stageRunIds, family.stageRunIds) ||
    !isDeepStrictEqual(receipt.retainedAssets, family.retainedAssets)
  )
    invalid("MEDIA_BUNDLE_GATE", "Media report is not bound to its fresh verification receipt.");

  const expectedStages = ["image-1k", "video-4s"];
  for (let index = 0; index < expectedStages.length; index += 1) {
    const stage = stages[index];
    const asset = receipt.retainedAssets[index];
    if (
      stage?.stage !== expectedStages[index] ||
      stage.runId !== receipt.stageRunIds[index] ||
      cases[index]?.id !== `media-${expectedStages[index]}` ||
      cases[index]?.runId !== stage.runId ||
      productCases[index]?.caseId !== `media-${expectedStages[index]}` ||
      productCases[index]?.runId !== stage.runId ||
      productCases[index]?.status !== "PASS" ||
      productCases[index]?.cleanupVerified !== true ||
      productCases[index]?.actualQqDeliveryVerified !== true ||
      !stage.asset ||
      !asset ||
      stage.asset.assetId !== asset.assetId ||
      stage.asset.sha256 !== asset.sha256 ||
      !UUID.test(stage.runId ?? "") ||
      !UUID.test(asset.assetId ?? "") ||
      !SHA256.test(asset.sha256 ?? "")
    )
      invalid(
        "MEDIA_BUNDLE_GATE",
        "Media stage, Run, or retained Asset does not match its report.",
      );
  }
  return receipt;
}

/** Validate the approved bundle and delegate unchanged coverage semantics to the existing gate. */
export async function evaluateBundledDeliveryGate(input, deps) {
  if (!record(input) || !record(deps) || typeof deps.verifyTaskWorkerReport !== "function")
    invalid(
      "TASK_WORKER_VERIFIER",
      "Delivery bundle requires an independent Task Worker report verifier.",
    );
  let bundle;
  try {
    bundle = parseDeliveryBundle(input.bundleText, input.suiteSha256);
  } catch {
    invalid("BUNDLE_APPROVAL", "Delivery bundle manifest does not match its approved raw hash.");
  }
  const members = validateResolvedMembers(bundle, input.memberSuiteTexts, input.suiteConfig);
  const partition = partitionReports(input.reports, members.hashes);
  if (partition.taskWorker.suiteSha256 !== members.hashes["task-worker"])
    invalid(
      "TASK_WORKER_REPORT_HASH",
      "Task Worker report does not match the approved Task Worker suite.",
    );
  if (
    partition.taskWorker.productAcceptance?.runtime?.commit !== input.commit ||
    partition.taskWorker.runtime?.commit !== input.commit ||
    partition.taskWorker.productAcceptance?.status !== "PASS" ||
    partition.taskWorker.status !== "PASS" ||
    partition.taskWorker.mode !== "run"
  )
    invalid("TASK_WORKER_REPORT", "Task Worker report is not a passing runtime-bound run.");
  const freshWorker = await deps.verifyTaskWorkerReport(partition.taskWorker, {
    approvedFamily: members.taskWorkerSuite.taskWorkerFamilies[0],
    commit: input.commit,
    suiteSha256: members.hashes["task-worker"],
    suiteBundleSha256: bundle.manifestSha256,
  });
  const checkedWorker = validateWorkerReceipt(
    partition.taskWorker,
    freshWorker,
    input.commit,
    members.hashes["task-worker"],
    deps.verifyTaskWorkerReport,
  );
  let checkedMedia;
  if (members.mediaSuite) {
    if (typeof deps.verifyMediaReport !== "function")
      invalid("MEDIA_VERIFIER", "Delivery bundle requires an independent media report verifier.");
    const report = partition.media;
    if (
      !report ||
      report.runtime?.commit !== input.commit ||
      report.productAcceptance?.runtime?.commit !== input.commit
    )
      invalid("MEDIA_REPORT", "Media report is not bound to this delivery commit.");
    const fresh = await deps.verifyMediaReport(report, { suiteSha256: members.hashes.media });
    checkedMedia = validateMediaReceipt(report, fresh, members.hashes.media, input.commit);
  }
  const coverageInput = {
    ...input,
    suiteText: members.coverageText,
    suiteSha256: members.hashes.coverage,
    reports: partition.coverage,
  };
  const base = await evaluateDeliveryGate(coverageInput, deps);
  if (input.suiteSha256 !== bundle.manifestSha256 || base.suiteSha256 !== members.hashes.coverage)
    invalid("BUNDLE_APPROVAL", "Base coverage gate returned an unexpected suite binding.");
  if (input.postMerge === true) {
    const mergedAt = Date.parse(base.mergedAt ?? "");
    if (!Number.isFinite(mergedAt))
      invalid("POST_MERGE_RUN", "Post-merge Task Worker evidence lacks a trusted merge time.");
    for (const stage of checkedWorker.stages) {
      const created = Date.parse(stage.runCreatedAt);
      const inputBinding = stage.messageBinding.input;
      const inputTime = inputBinding.time * 1000;
      const driverTime = inputBinding.driverTime * 1000;
      if (
        !Number.isFinite(created) ||
        created < mergedAt ||
        !Number.isSafeInteger(inputTime) ||
        !Number.isSafeInteger(driverTime)
      )
        invalid(
          "POST_MERGE_RUN",
          "Post-merge Task Worker evidence is invalid or predates the merge.",
        );
      if (inputTime <= mergedAt || driverTime <= mergedAt)
        invalid("POST_MERGE_INPUT", "Task Worker QQ messages must both be sent after the merge.");
    }
    for (const stage of checkedMedia?.stages ?? []) {
      const created = Date.parse(stage.runCreatedAt ?? "");
      const inputBinding = stage.messageBinding?.input;
      const inputTime = inputBinding?.time * 1000;
      const driverTime = inputBinding?.driverTime * 1000;
      if (
        !Number.isFinite(created) ||
        created < mergedAt ||
        !Number.isSafeInteger(inputTime) ||
        !Number.isSafeInteger(driverTime) ||
        inputTime <= mergedAt ||
        driverTime <= mergedAt
      )
        invalid(
          "POST_MERGE_MEDIA",
          "Post-merge media Runs and both QQ messages must follow the merge.",
        );
    }
  }
  return {
    ...base,
    suiteSha256: bundle.manifestSha256,
    suiteBundleSha256: bundle.manifestSha256,
    memberSuiteSha256: {
      coverage: members.hashes.coverage,
      taskWorker: members.hashes["task-worker"],
      ...(members.hashes.media ? { media: members.hashes.media } : {}),
    },
    taskWorkerReceipt: structuredClone(freshWorker),
    ...(checkedMedia ? { mediaReceipt: structuredClone(checkedMedia) } : {}),
  };
}
