import { appendFile, readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createHistoryLessonReader } from "../../../../tools/qq-live/lib/history-lesson-reader.mjs";
import {
  observeFeature,
  validateFeatureAssertions,
} from "../../../../tools/qq-live/lib/feature-observer.mjs";
import {
  readTraceEvents,
  verifyLeaseTraceEvidence,
  verifyTraceEvidence as verifyProductTraceEvidence,
} from "../../../../tools/qq-live/lib/product-evidence.mjs";
import {
  discoverFeedbackCandidate,
  verifyMemoryCleanup,
} from "../../../../tools/qq-live/lib/memory-fixture.mjs";
import { memoryFixtureStep } from "../../../../tools/qq-live/lib/memory-scenario.mjs";
import { toolManifestDigest, validateConfig } from "../../../../tools/qq-live/lib/core.mjs";
import { verifyMemoryFamilyReport } from "../../../../tools/qq-live/lib/memory-family-evidence.mjs";
import { verifyArchivedHistoryLesson } from "../../../../tools/qq-live/lib/history-lesson-evidence.mjs";
import {
  MEMORY_FAMILY_ID,
  MEMORY_REJECT_FAMILY_ID,
} from "../../../../tools/qq-live/lib/memory-workflow.mjs";

const CASE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{1,79}$/;
const COMMIT = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i;
const EVIDENCE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/;
const ERROR_CODE = /^[A-Z][A-Z0-9_]{1,79}$/;
const SECRET =
  /(?:\bBearer\s+[A-Za-z0-9._~+/-]{8,}|\b(?:gh[pousr]_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9]{16,}|AKIA[A-Z0-9]{16})\b|\b(?:token|password|secret|api[_ -]?key)\s*[:=]\s*\S+)/i;
const PERSONAL_ID =
  /(?:\bQQ\s*[:#]?\s*\d{5,12}\b|(?<!\d)(?:\+?86[ -]?)?1[3-9]\d{9}(?!\d)|(?<!\d)\d{9,12}(?!\d))/i;
const PERSONAL_MESSAGE =
  /[“”「」『』]|(^|\s)["'][^"']{3,}["']|(?:^|[\s,，。！？])(?:我|你|您)(?:想|要|是|在|能|可以|帮|给|觉得|怎么|为什么|请|好|吗|呢)|(?:您好|你好|谢谢|请问|在吗|麻烦|能不能)/i;
const FIELDS = new Set(["case", "commit", "status", "evidence", "symptom", "lesson", "nextStep"]);
const VERIFIED_FIELDS = new Set([...FIELDS, "verification"]);
const MEMORY_LIFECYCLE_CASES = new Set([
  "memory-feedback",
  "memory-promote",
  "memory-expire",
  "memory-reject",
]);
const COMPLETE_HISTORY_CASES = new Set([
  "history-current-group-complete",
  "history-owner-group-a-complete",
]);
const HISTORY_RESULT_CASES = new Map([
  ["history-current-group-hit", { tool: "group_history_search", result: "hit" }],
  ["history-owner-group-a-no-match", { tool: "owner_history_search", result: "no_match" }],
]);
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "../../../..");

function invalid(message) {
  throw new Error(message);
}

function safeText(value, field) {
  if (typeof value !== "string" || value.trim().length < 3 || value.length > 500)
    invalid(`Invalid ${field}`);
  if (SECRET.test(value) || PERSONAL_ID.test(value) || PERSONAL_MESSAGE.test(value))
    invalid(`Sensitive content refused in ${field}`);
  return value.trim();
}

export function validateLesson(input) {
  if (!input || typeof input !== "object" || Array.isArray(input))
    invalid("Lesson must be a JSON object");
  for (const key of Object.keys(input))
    if (!VERIFIED_FIELDS.has(key)) invalid(`Unexpected field: ${key}`);
  if (typeof input.case !== "string" || !CASE_ID.test(input.case))
    invalid("case must be a non-personal case identifier");
  if (typeof input.commit !== "string" || !COMMIT.test(input.commit))
    invalid("commit must be a full 40 or 64 character Git SHA");
  if (input.status !== "verified" && input.status !== "hypothesis")
    invalid("status must be verified or hypothesis");
  if (!input.evidence || typeof input.evidence !== "object" || Array.isArray(input.evidence))
    invalid("evidence is required");
  let evidence;
  if (
    input.evidence.type === "run" &&
    Object.keys(input.evidence).length === 2 &&
    EVIDENCE_ID.test(input.evidence.runId ?? "")
  ) {
    evidence = { type: "run", runId: input.evidence.runId };
  } else if (
    input.evidence.type === "preflight_error" &&
    Object.keys(input.evidence).length === 2 &&
    ERROR_CODE.test(input.evidence.errorCode ?? "")
  ) {
    evidence = { type: "preflight_error", errorCode: input.evidence.errorCode };
  } else {
    invalid("evidence must contain a Run ID or an explicit preflight error code");
  }
  if (input.status === "verified") {
    if (evidence.type !== "run")
      invalid("A verified lesson requires a passing QQ live report for a Run");
    validateVerification(input.verification);
  } else if (input.verification !== undefined) {
    invalid("verification is only valid for a verified lesson");
  }
  const lesson = {
    case: input.case,
    commit: input.commit.toLowerCase(),
    status: input.status,
    evidence,
    symptom: safeText(input.symptom, "symptom"),
    lesson: safeText(input.lesson, "lesson"),
    nextStep: safeText(input.nextStep, "nextStep"),
  };
  return { lesson, verification: input.verification };
}

function validateVerification(value) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== 3 ||
    value.type !== "qq_live_report" ||
    typeof value.reportPath !== "string" ||
    value.reportPath.trim().length === 0 ||
    typeof value.reportSha256 !== "string" ||
    !/^[a-f0-9]{64}$/i.test(value.reportSha256)
  )
    invalid("verified requires a QQ live report path and its SHA-256");
  return value;
}

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function identifier(value) {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/.test(value);
}

function passingBinding(value) {
  return (
    value &&
    typeof value === "object" &&
    /^\d{1,30}$/.test(String(value.realSequence ?? "")) &&
    Number.isSafeInteger(value.time) &&
    /^[a-f0-9]{64}$/i.test(value.textSha256 ?? "")
  );
}

function hasMarkedMemoryMutationPrompt(caseRecord) {
  if (typeof caseRecord?.prompt !== "string") return false;
  const [markerLine, ...body] = caseRecord.prompt.split(/\r\n|\n|\r/u);
  return (
    /^GLASSBOX_ACCEPTANCE_V1 [a-f0-9]{32}$/u.test(markerLine ?? "") &&
    body.some((line) => /^\s*\/memory\s+(?:feedback|promote|reject|expire)(?:\s|$)/u.test(line))
  );
}

function hasUnsafeMemoryToolTrace(events, runId) {
  const runEvents = events.filter((event) => event?.runId === runId);
  const memoryEvents = runEvents.filter(
    (event) =>
      ["tool_call", "tool_result"].includes(event?.type) &&
      event.data?.name === "owner_memory_admin",
  );
  return memoryEvents.some((event) => {
    const toolCallId = event.toolCallId ?? event.data?.toolCallId;
    if (typeof toolCallId !== "string" || !toolCallId) return true;
    const pairedEvents = runEvents.filter(
      (candidate) =>
        ["tool_call", "tool_result"].includes(candidate?.type) &&
        (candidate.toolCallId ?? candidate.data?.toolCallId) === toolCallId,
    );
    const calls = pairedEvents.filter((candidate) => candidate.type === "tool_call");
    const results = pairedEvents.filter((candidate) => candidate.type === "tool_result");
    if (
      pairedEvents.length !== 2 ||
      calls.length !== 1 ||
      results.length !== 1 ||
      pairedEvents.some((candidate) => candidate.data?.name !== "owner_memory_admin")
    )
      return true;
    const action = calls[0].data?.input?.action;
    return !["list", "get", "list_candidates"].includes(action);
  });
}

function requiresMemoryLifecycleVerification(report, events, runId) {
  return (
    Object.hasOwn(report, "memoryLifecycle") ||
    Object.hasOwn(report, "memoryFamily") ||
    (Array.isArray(report.cases) &&
      report.cases.some(
        (item) => MEMORY_LIFECYCLE_CASES.has(item?.id) || hasMarkedMemoryMutationPrompt(item),
      )) ||
    hasUnsafeMemoryToolTrace(events, runId)
  );
}

function requiresIndependentMemberCountVerification(caseRecord, accepted, events, runId) {
  const hasAggregateAssertion = caseRecord?.featureAssertions?.some(
    (assertion) =>
      assertion?.kind === "aggregate_projection" && assertion.tool === "qq_group_members",
  );
  const hasAggregateObservation = accepted?.feature?.observations?.some(
    (observation) =>
      observation?.kind === "aggregate_projection" && observation.tool === "qq_group_members",
  );
  const hasLeasedTool = caseRecord?.leasedToolNames?.includes("qq_group_members");
  const hasRawToolTrace = events.some(
    (event) =>
      event?.runId === runId &&
      ["tool_call", "tool_result"].includes(event?.type) &&
      event.data?.name === "qq_group_members",
  );
  const hasRawNarrowedTool = events.some(
    (event) =>
      event?.runId === runId &&
      event?.type === "session_start" &&
      event.data?.acceptanceLease?.narrowedTools?.includes("qq_group_members"),
  );
  return (
    hasAggregateAssertion ||
    hasAggregateObservation ||
    hasLeasedTool ||
    hasRawToolTrace ||
    hasRawNarrowedTool
  );
}

function verifyCompleteHistoryCase(caseRecord, accepted, events, runId) {
  const resultContract = HISTORY_RESULT_CASES.get(caseRecord?.id);
  if (!COMPLETE_HISTORY_CASES.has(caseRecord?.id) && !resultContract) return;
  const currentGroup =
    caseRecord.id === "history-current-group-complete" ||
    caseRecord.id === "history-current-group-hit";
  const toolName =
    resultContract?.tool ?? (currentGroup ? "group_history_search" : "owner_history_search");
  const calls = events.filter(
    (event) =>
      event?.runId === runId && event.type === "tool_call" && event.data?.name === toolName,
  );
  const results = events.filter(
    (event) =>
      event?.runId === runId && event.type === "tool_result" && event.data?.name === toolName,
  );
  const token = caseRecord.token;
  const groupId = currentGroup ? caseRecord.route : calls[0]?.data?.input?.groupIds?.[0];
  const input = calls[0]?.data?.input;
  const scopedRoute = currentGroup
    ? caseRecord.route === groupId &&
      accepted.scope?.chatType === "group" &&
      String(accepted.scope?.chatId) === String(groupId)
    : caseRecord.route === "private" &&
      accepted.scope?.chatType === "private" &&
      accepted.scope?.chatId === accepted.scope?.senderId;
  const expectedInput = currentGroup
    ? { query: token, limit: 1 }
    : { query: token, groupIds: [groupId], limit: 1 };
  const tools = [
    {
      name: toolName,
      operations: [
        {
          action: currentGroup ? "history:read" : "history:search",
          resourceId: currentGroup ? `group:${groupId}` : "owner-history",
          inputConstraint: expectedInput,
        },
      ],
    },
  ];
  const expectedAssertions = [
    {
      kind: "trace",
      type: "tool_result",
      where: { name: toolName, isError: false },
      count: 1,
    },
    {
      kind: "trace",
      type: "history_retrieval",
      where: {
        query: token,
        groups: [groupId],
        resources: [`group:${groupId}`],
        sourceKind: "channel_message",
        retrievalMode: "lexical",
      },
      count: 1,
    },
    { kind: "history_coverage", query: token, groupId, count: 1 },
  ];
  if (resultContract)
    expectedAssertions.push({
      kind: "history_result",
      tool: resultContract.tool,
      query: token,
      groupId,
      result: resultContract.result,
      count: 1,
    });
  if (
    !/^[a-f0-9]{32}$/.test(token ?? "") ||
    !caseRecord.prompt?.startsWith(`GLASSBOX_ACCEPTANCE_V1 ${token}\n`) ||
    !/^\d{1,16}$/.test(String(groupId ?? "")) ||
    !scopedRoute ||
    !isDeepStrictEqual(caseRecord.leasedToolNames, [toolName]) ||
    caseRecord.leaseRegistrationAttempted !== true ||
    caseRecord.leaseRevoked !== true ||
    caseRecord.acceptanceLease?.toolsSha256 !== toolManifestDigest(tools) ||
    !isDeepStrictEqual(caseRecord.featureAssertions, expectedAssertions) ||
    calls.length !== 1 ||
    results.length !== 1 ||
    !calls[0].toolCallId ||
    calls[0].toolCallId !== results[0].toolCallId ||
    results[0].data?.isError !== false ||
    !isDeepStrictEqual(input, expectedInput)
  )
    invalid("Fixed history lesson lacks its exact group A lease and result assertions");

  const historyEvents = events.filter(
    (event) => event?.runId === runId && event.type === "history_retrieval",
  );
  if (
    historyEvents.length !== 1 ||
    historyEvents[0].query !== token ||
    !isDeepStrictEqual(historyEvents[0].groups, [groupId])
  )
    invalid("Complete history Trace does not match its fixed nonce and group A");
}

function traceEventsForLesson(report, lesson, evidence, capture) {
  let trace;
  try {
    trace = readTraceEvents(evidence.checkout, evidence.dataDirectory, evidence.runId, capture, [
      "tool_call",
      "tool_result",
    ]);
  } catch {
    invalid("gbxtrace could not verify Run evidence");
  }
  if (trace.runId !== evidence.runId || !Array.isArray(trace.events))
    invalid("gbxtrace returned evidence for a different Run");
  const events = trace.events.map((row) => row.event);
  const caseRecord = report.cases.find((item) => item.id === lesson.case);
  const accepted = report.productAcceptance.cases.find((item) => item.caseId === lesson.case);
  const config = {
    runtime: {
      connectionId: evidence.scope.connectionId,
      threadId: evidence.scope.threadId ?? null,
    },
    bot: { qq: evidence.scope.botId },
    driver: { qq: evidence.scope.senderId },
  };
  try {
    verifyProductTraceEvidence(events, caseRecord, config, accepted.delivery);
  } catch {
    invalid("gbxtrace did not confirm the report's matching input and sent delivery");
  }
  return events;
}

function verifyTracePromptHash(caseRecord, accepted, events) {
  const promptHash =
    typeof caseRecord?.prompt === "string" ? digest(Buffer.from(caseRecord.prompt, "utf8")) : "";
  const inputEvents = events.filter(
    (event) =>
      event.type === "message_received" &&
      String(event.externalId) === String(caseRecord.inputBinding?.botMessageId),
  );
  if (
    !promptHash ||
    caseRecord.inputBinding?.textSha256 !== promptHash ||
    accepted.messageBinding?.input?.textSha256 !== promptHash ||
    inputEvents.length !== 1 ||
    inputEvents[0].textSha256 !== promptHash
  )
    invalid("Raw Trace input hash does not match the report's bound prompt");
}

export function validateLiveReport(report, lesson, reportPath, expectedHash) {
  if (
    !report ||
    report.schemaVersion !== 1 ||
    report.toolVersion !== "0.1.0" ||
    report.mode !== "run" ||
    report.status !== "PASS" ||
    !/^[a-f0-9]{64}$/i.test(report.suiteSha256 ?? "") ||
    !identifier(report.runId) ||
    !report.startedAt ||
    !report.finishedAt ||
    resolve(report.reportDirectory ?? "") !== dirname(resolve(reportPath))
  )
    invalid("QQ live report is missing the expected successful run fields");

  const runtime = report.runtime;
  const acceptedRuntime = report.productAcceptance?.runtime;
  if (
    report.workspace?.commit !== lesson.commit ||
    report.workspace?.dirty !== false ||
    runtime?.commit !== lesson.commit ||
    acceptedRuntime?.commit !== lesson.commit ||
    !runtime?.checkout ||
    resolve(runtime.checkout) !== REPO_ROOT ||
    resolve(acceptedRuntime.checkout ?? "") !== REPO_ROOT ||
    !runtime.dataDirectory ||
    resolve(runtime.dataDirectory) !== resolve(acceptedRuntime.dataDirectory ?? "") ||
    runtime.pid !== acceptedRuntime.pid
  )
    invalid("QQ live report does not prove the exact clean commit and runtime");

  if (report.productAcceptance?.status !== "PASS")
    invalid("QQ live report productAcceptance is not PASS");
  const cases = report.cases?.filter((item) => item?.id === lesson.case) ?? [];
  const acceptedCases =
    report.productAcceptance.cases?.filter((item) => item?.caseId === lesson.case) ?? [];
  if (cases.length !== 1 || acceptedCases.length !== 1)
    invalid("QQ live report does not contain exactly one matching case");
  const result = cases[0];
  const accepted = acceptedCases[0];
  if (
    result.status !== "PASS" ||
    accepted.runId !== lesson.evidence.runId ||
    accepted.traceVerified !== true ||
    !Array.isArray(accepted.decisions) ||
    accepted.decisions.length === 0 ||
    accepted.decisions.some((item) => item?.decision !== "ALLOW") ||
    accepted.delivery?.status !== "sent" ||
    !identifier(accepted.delivery.id) ||
    !/^-?\d{1,20}$/.test(String(accepted.delivery.external_id ?? "")) ||
    !accepted.scope ||
    accepted.scope.connectionId !== runtime.connectionId ||
    !["private", "group"].includes(accepted.scope.chatType) ||
    ["connectionId", "botId", "chatId", "senderId"].some(
      (key) => typeof accepted.scope[key] !== "string" || !accepted.scope[key],
    ) ||
    !passingBinding(accepted.messageBinding?.input) ||
    !passingBinding(accepted.messageBinding?.reply) ||
    String(result.inputBinding?.botMessageId ?? "") === ""
  )
    invalid("QQ live report lacks passing authorization, delivery, and message evidence");

  return {
    reportSha256: expectedHash.toLowerCase(),
    runId: lesson.evidence.runId,
    checkout: resolve(runtime.checkout),
    dataDirectory: resolve(runtime.dataDirectory),
    inputMessageId: String(result.inputBinding.botMessageId),
    scope: accepted.scope,
    deliveryId: accepted.delivery.id,
    deliveryExternalId: String(accepted.delivery.external_id),
  };
}

export function verifyFeatureReport(report, lesson, evidence, capture = execFileSync) {
  const caseRecord = report.cases.find((item) => item.id === lesson.case);
  const accepted = report.productAcceptance.cases.find((item) => item.caseId === lesson.case);
  if (
    !Array.isArray(caseRecord.featureAssertions) ||
    !caseRecord.featureAssertions.length ||
    caseRecord.leaseRevoked !== true ||
    (caseRecord.cleanup?.required && caseRecord.cleanup.restored !== true) ||
    report.safetyStopCreated === true ||
    report.cases.some(
      (item) =>
        (item.cleanup?.required && item.cleanup.restored !== true) ||
        (item.leaseRegistrationAttempted && item.leaseRevoked !== true),
    )
  )
    invalid("Feature report has missing assertions or unconfirmed cleanup");

  let assertions;
  try {
    assertions = validateFeatureAssertions(caseRecord.featureAssertions);
  } catch {
    invalid("Feature report contains unsupported assertions");
  }
  const featureTypes = assertions.filter((item) => item.kind === "trace").map((item) => item.type);
  featureTypes.push("tool_call", "tool_result");
  if (COMPLETE_HISTORY_CASES.has(caseRecord.id) || HISTORY_RESULT_CASES.has(caseRecord.id))
    featureTypes.push("history_retrieval");
  let trace;
  try {
    trace = readTraceEvents(
      evidence.checkout,
      evidence.dataDirectory,
      evidence.runId,
      capture,
      featureTypes,
    );
  } catch {
    invalid("gbxtrace could not read feature Run evidence");
  }
  if (trace.runId !== evidence.runId || !Array.isArray(trace.events))
    invalid("gbxtrace returned evidence for a different Run");
  const events = trace.events.map((row) => row.event);
  if (
    caseRecord.id === "history-seed-recall" ||
    assertions.some((a) => a.kind === "history_seed_result") ||
    events.some(
      (e) =>
        e?.runId === evidence.runId &&
        e.type === "tool_call" &&
        e.data?.name === "owner_history_search" &&
        /^[a-f0-9]{32}$/.test(e.data?.input?.query ?? "") &&
        e.data?.input?.until !== undefined,
    )
  )
    invalid("Historical seed-family verification is unavailable for lessons; record a hypothesis.");
  const config = {
    runtime: {
      connectionId: evidence.scope.connectionId,
      threadId: evidence.scope.threadId ?? null,
    },
    bot: { qq: evidence.scope.botId },
    driver: { qq: evidence.scope.senderId },
  };
  try {
    verifyProductTraceEvidence(events, caseRecord, config, accepted.delivery);
    verifyLeaseTraceEvidence(events, caseRecord, evidence.runId);
    verifyCompleteHistoryCase(caseRecord, accepted, events, evidence.runId);
  } catch {
    invalid("Feature Run lease, scope, or Trace evidence did not verify");
  }

  const needsDatabase = assertions.some(
    (item) => item.kind === "state" || item.kind === "history_result",
  );
  let db;
  try {
    if (needsDatabase)
      db = new DatabaseSync(join(evidence.dataDirectory, "glassbox.db"), { readOnly: true });
    const observed = observeFeature(assertions, { db, events, runId: evidence.runId });
    if (
      observed.status !== "PASS" ||
      !accepted.feature ||
      accepted.feature.status !== "PASS" ||
      !isDeepStrictEqual(accepted.feature, observed)
    )
      invalid("Feature assertions did not match read-only Run observations");
  } catch {
    invalid("Feature trace or read-only state assertions did not verify");
  } finally {
    db?.close();
  }
  return events;
}

export function verifyMemoryLifecycleReport(report, lesson, evidence, capture = execFileSync) {
  const lifecycle = report.memoryLifecycle;
  const handles = lifecycle?.handles;
  const stages = [
    { stage: "feedback", caseId: "memory-feedback", runId: handles?.creationRunId },
    { stage: "promote", caseId: "memory-promote", runId: handles?.promoteRunId },
    { stage: "expire", caseId: "memory-expire", runId: handles?.cleanupRunId },
  ];
  const hasExactKeys = (value, keys) =>
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    isDeepStrictEqual(
      Object.keys(value).sort((a, b) => a.localeCompare(b)),
      [...keys].sort((a, b) => a.localeCompare(b)),
    );
  const handleKeys = [
    "fixtureNonce",
    "projectId",
    "stepRunId",
    "principalId",
    "creationRunId",
    "candidateId",
    "promoteRunId",
    "memoryId",
    "cleanupRunId",
    "cleanupStatus",
  ];
  if (
    !hasExactKeys(lifecycle, [
      "status",
      "stage",
      "handles",
      "steps",
      "requiresReconciliation",
      "cleanup",
    ]) ||
    lifecycle.status !== "PASS" ||
    lifecycle.stage !== "expire" ||
    lifecycle.requiresReconciliation !== false ||
    !hasExactKeys(lifecycle.cleanup, ["status", "runId"]) ||
    lifecycle.cleanup.status !== "expired" ||
    !hasExactKeys(handles, handleKeys) ||
    !/^[a-f0-9]{32}$/.test(handles.fixtureNonce ?? "") ||
    handles.projectId !== `qqtest-${handles.fixtureNonce}` ||
    !identifier(handles.principalId) ||
    !/^candidate_[a-f0-9]{32}$/.test(handles.candidateId ?? "") ||
    !/^memory_[a-f0-9]{32}$/.test(handles.memoryId ?? "") ||
    !stages.every((item) => identifier(item.runId)) ||
    new Set(stages.map((item) => item.runId)).size !== 3 ||
    handles.stepRunId !== handles.cleanupRunId ||
    handles.cleanupStatus !== "expired" ||
    lifecycle.cleanup.runId !== handles.cleanupRunId ||
    lesson.case !== "memory-expire" ||
    lesson.evidence.runId !== handles.cleanupRunId ||
    report.plannedCaseCount !== 3 ||
    report.executedCaseCount !== 3 ||
    !Array.isArray(lifecycle.steps) ||
    lifecycle.steps.length !== 3 ||
    !Array.isArray(report.cases) ||
    report.cases.length !== 3 ||
    !Array.isArray(report.productAcceptance?.cases) ||
    report.productAcceptance.cases.length !== 3
  )
    invalid("Verified lesson lacks a complete Memory lifecycle report");

  const databasePath = join(evidence.dataDirectory, "glassbox.db");
  let db;
  try {
    db = new DatabaseSync(databasePath, { readOnly: true });
    const principal = db.prepare("SELECT kind FROM principals WHERE id=?").get(handles.principalId);
    if (principal?.kind !== "owner") invalid("Memory lifecycle Owner evidence did not verify");
    const creation = discoverFeedbackCandidate(db, {
      runId: handles.creationRunId,
      principalId: handles.principalId,
      projectId: handles.projectId,
    });
    const cleanup = verifyMemoryCleanup(db, {
      candidateId: handles.candidateId,
      memoryId: handles.memoryId,
      creationRunId: handles.creationRunId,
      cleanupRunId: handles.cleanupRunId,
      principalId: handles.principalId,
      projectId: handles.projectId,
    });
    if (
      creation.candidateId !== handles.candidateId ||
      creation.principalId !== handles.principalId ||
      creation.projectId !== handles.projectId ||
      creation.creationRunId !== handles.creationRunId ||
      cleanup.status !== "expired" ||
      cleanup.candidateId !== handles.candidateId ||
      cleanup.memoryId !== handles.memoryId ||
      cleanup.principalId !== handles.principalId ||
      cleanup.projectId !== handles.projectId ||
      cleanup.creationRunId !== handles.creationRunId ||
      cleanup.promoteRunId !== handles.promoteRunId ||
      cleanup.cleanupRunId !== handles.cleanupRunId
    )
      invalid("Memory lifecycle database handles did not verify");
  } catch (error) {
    if (error.message.startsWith("Memory lifecycle")) throw error;
    invalid("Read-only Memory lifecycle database evidence did not verify");
  } finally {
    db?.close();
  }

  const acceptedScope = evidence.scope;
  for (const [index, expected] of stages.entries()) {
    const step = lifecycle.steps[index];
    const caseRecords = report.cases.filter((item) => item?.id === expected.caseId);
    const acceptedRecords = report.productAcceptance.cases.filter(
      (item) => item?.caseId === expected.caseId,
    );
    const caseRecord = caseRecords[0];
    const accepted = acceptedRecords[0];
    let spec;
    try {
      spec = memoryFixtureStep(expected.stage, {
        nonce: handles.fixtureNonce,
        candidateId: handles.candidateId,
        memoryId: handles.memoryId,
      });
    } catch {
      invalid("Memory lifecycle step does not match the fixed acceptance scenario");
    }
    const expectedNames = spec.leaseTools.map((tool) => tool.name);
    const expectedPrompt = `GLASSBOX_ACCEPTANCE_V1 ${caseRecord?.token ?? ""}\n${spec.prompt.replaceAll("{{nonce}}", caseRecord?.token ?? "").trim()}`;
    const expectedAssertions = JSON.parse(
      JSON.stringify(spec.featureAssertions).replaceAll("{{nonce}}", caseRecord?.token ?? ""),
    );
    const expectedToolInput = spec.leaseTools[0].operations[0].inputConstraint;
    if (
      !hasExactKeys(step, ["stage", "currentRunId", "runId", "productAcceptance"]) ||
      step.stage !== expected.stage ||
      step.currentRunId !== expected.runId ||
      step.runId !== expected.runId ||
      !hasExactKeys(step.productAcceptance, [
        "status",
        "runtime",
        "caseId",
        "traceVerified",
        "featureStatus",
      ]) ||
      step.productAcceptance.status !== "PASS" ||
      !isDeepStrictEqual(step.productAcceptance.runtime, report.runtime) ||
      step.productAcceptance.caseId !== expected.caseId ||
      step.productAcceptance.traceVerified !== true ||
      step.productAcceptance.featureStatus !== "PASS" ||
      caseRecords.length !== 1 ||
      acceptedRecords.length !== 1 ||
      caseRecord.status !== "PASS" ||
      caseRecord.route !== "private" ||
      caseRecord.leaseRegistrationAttempted !== true ||
      caseRecord.leaseRevoked !== true ||
      !isDeepStrictEqual(caseRecord.featureAssertions, expectedAssertions) ||
      !isDeepStrictEqual(caseRecord.leasedToolNames, expectedNames) ||
      new Set(caseRecord.leasedToolNames ?? []).size !== expectedNames.length ||
      caseRecord.acceptanceLease?.toolsSha256 !== toolManifestDigest(spec.leaseTools) ||
      !identifier(caseRecord.inputBinding?.botMessageId) ||
      !identifier(caseRecord.inputBinding?.driverMessageId) ||
      String(caseRecord.inputBinding.driverMessageId) !== String(caseRecord.sentMessageId) ||
      accepted.runId !== expected.runId ||
      accepted.scope?.chatType !== "private" ||
      accepted.traceVerified !== true ||
      accepted.feature?.status !== "PASS" ||
      accepted.feature?.runId !== expected.runId ||
      !Array.isArray(accepted.decisions) ||
      accepted.decisions.length === 0 ||
      accepted.decisions.some((item) => item?.decision !== "ALLOW") ||
      accepted.delivery?.status !== "sent" ||
      !identifier(accepted.delivery.id) ||
      !/^-?\d{1,20}$/.test(String(accepted.delivery.external_id ?? "")) ||
      !isDeepStrictEqual(accepted.scope, acceptedScope) ||
      typeof caseRecord.prompt !== "string" ||
      caseRecord.prompt !== expectedPrompt ||
      !passingBinding(caseRecord.inputBinding) ||
      !passingBinding(accepted.messageBinding?.input) ||
      !passingBinding(accepted.messageBinding?.reply) ||
      digest(Buffer.from(caseRecord.prompt, "utf8")) !== caseRecord.inputBinding.textSha256 ||
      caseRecord.inputBinding.textSha256 !== accepted.messageBinding.input.textSha256 ||
      caseRecord.inputBinding.realSequence !== accepted.messageBinding.input.realSequence ||
      caseRecord.inputBinding.time !== accepted.messageBinding.input.time ||
      caseRecord.inputBinding.textSha256 !== accepted.messageBinding.input.textSha256
    )
      invalid("Memory lifecycle step evidence does not match its Run and scope");

    const events = verifyFeatureReport(
      report,
      { ...lesson, case: expected.caseId, evidence: { ...lesson.evidence, runId: expected.runId } },
      { ...evidence, runId: expected.runId, scope: accepted.scope },
      capture,
    );
    verifyTracePromptHash(caseRecord, accepted, events);
    const calls = events.filter(
      (event) => event.runId === expected.runId && event.type === "tool_call",
    );
    const sessions = events.filter(
      (event) => event.runId === expected.runId && event.type === "session_start",
    );
    if (
      calls.length !== 1 ||
      calls[0].data?.name !== "owner_memory_admin" ||
      !isDeepStrictEqual(calls[0].data?.input, expectedToolInput) ||
      !sessions.length ||
      sessions.some((event) => {
        const lease = event.data?.acceptanceLease;
        return (
          lease?.toolsSha256 !== toolManifestDigest(spec.leaseTools) ||
          !isDeepStrictEqual(lease?.narrowedTools, expectedNames) ||
          !isDeepStrictEqual(event.data?.authorizedTools, expectedNames)
        );
      })
    )
      invalid("Memory lifecycle Trace does not match the exact leased operation and input");
  }
}

export async function verifyMemoryRejectReport(report, lesson, evidence, capture = execFileSync) {
  if (
    lesson.case !== "memory-reject" ||
    report?.memoryFamily?.caseId !== MEMORY_REJECT_FAMILY_ID ||
    lesson.evidence.runId !== report.memoryLifecycle?.handles?.cleanupRunId
  )
    invalid("Verified reject lessons must select the final memory-reject Run");

  try {
    await verifyMemoryFamilyReport(report, {
      verifyProduct: async (source) => {
        const cases = [];
        for (const caseRecord of source.cases) {
          const accepted = source.productAcceptance?.cases?.find(
            (item) => item.caseId === caseRecord.id,
          );
          if (
            !accepted ||
            caseRecord.leaseRegistrationAttempted !== true ||
            !Array.isArray(accepted.decisions) ||
            accepted.decisions.length === 0 ||
            accepted.decisions.some((item) => item?.decision !== "ALLOW")
          )
            invalid("Reject-family product or authorization evidence is incomplete");
          const stageEvidence = {
            ...evidence,
            runId: accepted.runId,
            scope: accepted.scope,
          };
          const events = verifyFeatureReport(
            source,
            {
              ...lesson,
              case: caseRecord.id,
              evidence: { ...lesson.evidence, runId: accepted.runId },
            },
            stageEvidence,
            capture,
          );
          verifyTracePromptHash(caseRecord, accepted, events);
          const spec = memoryFixtureStep(caseRecord.id.slice("memory-".length), {
            nonce: source.memoryLifecycle.handles.fixtureNonce,
            candidateId: source.memoryLifecycle.handles.candidateId,
          });
          const expectedTools = spec.leaseTools.map((tool) => tool.name);
          const calls = events.filter(
            (event) => event.runId === accepted.runId && event.type === "tool_call",
          );
          const sessions = events.filter(
            (event) => event.runId === accepted.runId && event.type === "session_start",
          );
          if (
            calls.length !== 1 ||
            calls[0].data?.name !== "owner_memory_admin" ||
            !isDeepStrictEqual(
              calls[0].data?.input,
              spec.leaseTools[0].operations[0].inputConstraint,
            ) ||
            sessions.length === 0 ||
            sessions.some((event) => {
              const lease = event.data?.acceptanceLease;
              return (
                lease?.toolsSha256 !== toolManifestDigest(spec.leaseTools) ||
                !isDeepStrictEqual(lease?.narrowedTools, expectedTools) ||
                !isDeepStrictEqual(event.data?.authorizedTools, expectedTools)
              );
            })
          )
            invalid("Reject-family Trace does not match the exact leased operation and input");
          cases.push({
            caseId: caseRecord.id,
            runId: accepted.runId,
            scope: accepted.scope,
            delivery: accepted.delivery,
            traceVerified: accepted.traceVerified,
            messageBinding: accepted.messageBinding,
            feature: accepted.feature,
          });
        }
        return { status: source.productAcceptance?.status, runtime: source.runtime, cases };
      },
      readCleanup: async (input) => {
        let db;
        try {
          db = new DatabaseSync(join(evidence.dataDirectory, "glassbox.db"), { readOnly: true });
          const principal = db
            .prepare("SELECT kind FROM principals WHERE id=?")
            .get(input.principalId);
          if (principal?.kind !== "owner") invalid("Reject-family source Principal is not Owner");
          return {
            ...verifyMemoryCleanup(db, input),
            principalKind: principal.kind,
          };
        } finally {
          db?.close();
        }
      },
    });
  } catch (error) {
    if (
      error.message.startsWith("Verified reject lessons") ||
      error.message.startsWith("Reject-family")
    )
      throw error;
    invalid("Read-only reject-family historical evidence did not verify");
  }
}

export function verifyStandardReport(report, lesson, evidence, capture = execFileSync) {
  const events = traceEventsForLesson(report, lesson, evidence, capture);
  const caseRecord = report.cases.find((item) => item.id === lesson.case);
  const accepted = report.productAcceptance.cases.find((item) => item.caseId === lesson.case);
  verifyTracePromptHash(caseRecord, accepted, events);
  const config = {
    runtime: {
      connectionId: evidence.scope.connectionId,
      threadId: evidence.scope.threadId ?? null,
    },
    bot: { qq: evidence.scope.botId },
    driver: { qq: evidence.scope.senderId },
  };
  try {
    verifyProductTraceEvidence(events, caseRecord, config, accepted.delivery);
  } catch {
    invalid("gbxtrace did not confirm the report's matching input and sent delivery");
  }
}

export async function appendLesson(
  input,
  path = join(dirname(SCRIPT_DIR), "references", "lessons.jsonl"),
  { capture, historyBindings } = {},
) {
  const validated = validateLesson(input);
  const lesson = validated.lesson;
  if (lesson.status === "verified") {
    const reportPath = resolve(validated.verification.reportPath);
    let bytes;
    let report;
    try {
      bytes = await readFile(reportPath);
      if (digest(bytes) !== validated.verification.reportSha256.toLowerCase())
        invalid("QQ live report hash does not match");
      report = JSON.parse(bytes.toString("utf8"));
    } catch (error) {
      if (error.message.startsWith("QQ live report")) throw error;
      invalid("QQ live report is unreadable or invalid JSON");
    }
    const evidence = validateLiveReport(report, lesson, reportPath, digest(bytes));
    const traceEvents = traceEventsForLesson(report, lesson, evidence, capture ?? execFileSync);
    const archivedHistory = await verifyArchivedHistoryLesson(
      report,
      lesson,
      evidence,
      capture ?? execFileSync,
      { historyBindings },
    );
    const selectedCase = report.cases.find((item) => item.id === lesson.case);
    const selectedAccepted = report.productAcceptance.cases.find(
      (item) => item.caseId === lesson.case,
    );
    if (
      !archivedHistory &&
      requiresIndependentMemberCountVerification(
        selectedCase,
        selectedAccepted,
        traceEvents,
        evidence.runId,
      )
    )
      invalid("Independent group member count evidence is unavailable for verified lessons");
    if (!archivedHistory) {
      if (requiresMemoryLifecycleVerification(report, traceEvents, evidence.runId)) {
        if (report.memoryFamily?.caseId === MEMORY_REJECT_FAMILY_ID)
          await verifyMemoryRejectReport(report, lesson, evidence, capture);
        else {
          if (
            Object.hasOwn(report, "memoryFamily") &&
            report.memoryFamily?.caseId !== MEMORY_FAMILY_ID
          )
            invalid("Unknown Memory family cannot produce a verified lesson");
          verifyMemoryLifecycleReport(report, lesson, evidence, capture);
        }
      } else {
        const caseRecord = report.cases.find((item) => item.id === lesson.case);
        const accepted = report.productAcceptance.cases.find((item) => item.caseId === lesson.case);
        verifyTracePromptHash(caseRecord, accepted, traceEvents);
        if (caseRecord.featureAssertions?.length)
          verifyFeatureReport(report, lesson, evidence, capture);
        else verifyStandardReport(report, lesson, evidence, capture);
      }
    }
    lesson.evidence.reportSha256 = evidence.reportSha256;
  }
  await appendFile(path, `${JSON.stringify(lesson)}\n`, { encoding: "utf8", flag: "a" });
  return lesson;
}

export function parseLessonArguments(args) {
  if (
    !Array.isArray(args) ||
    ![2, 4].includes(args.length) ||
    args[0] !== "--input" ||
    typeof args[1] !== "string" ||
    !args[1].trim() ||
    args[1].includes("\0") ||
    (args.length === 4 &&
      (args[2] !== "--config" ||
        typeof args[3] !== "string" ||
        !args[3].trim() ||
        args[3].includes("\0")))
  )
    invalid("Usage: node record-lesson.mjs --input <json-file> [--config <qq-live-config>]");
  return { input: args[1], ...(args.length === 4 ? { config: args[3] } : {}) };
}

export async function runLessonCli(args) {
  const options = parseLessonArguments(args);
  let input;
  try {
    input = JSON.parse(await readFile(resolve(options.input), "utf8"));
  } catch {
    invalid("Input file is unreadable or is not valid JSON");
  }
  let reader;
  if (options.config) {
    let raw;
    try {
      raw = JSON.parse(await readFile(resolve(options.config), "utf8"));
    } catch {
      invalid("QQ live configuration is unreadable or invalid JSON");
    }
    reader = createHistoryLessonReader(validateConfig(raw));
  }
  try {
    const historyBindings = reader
      ? (caseRecord, config, delivery) => reader.readBindings(caseRecord, config, delivery)
      : undefined;
    const lesson = await appendLesson(input, undefined, { historyBindings });
    process.stdout.write(
      `Recorded ${lesson.status} lesson for ${lesson.case} at ${lesson.commit}\n`,
    );
  } finally {
    reader?.close();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    await runLessonCli(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
