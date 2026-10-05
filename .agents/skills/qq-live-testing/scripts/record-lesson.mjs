import { appendFile, readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  observeFeature,
  validateFeatureAssertions,
} from "../../../../tools/qq-live/lib/feature-observer.mjs";
import {
  readTraceEvents,
  verifyLeaseTraceEvidence,
  verifyTraceEvidence as verifyProductTraceEvidence,
} from "../../../../tools/qq-live/lib/product-evidence.mjs";

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
  } catch {
    invalid("Feature Run lease, scope, or Trace evidence did not verify");
  }

  const needsDatabase = assertions.some((item) => item.kind === "state");
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
}

export function verifyStandardReport(report, lesson, evidence, capture = execFileSync) {
  let trace;
  try {
    trace = readTraceEvents(evidence.checkout, evidence.dataDirectory, evidence.runId, capture);
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
}

export async function appendLesson(
  input,
  path = join(dirname(SCRIPT_DIR), "references", "lessons.jsonl"),
  { capture } = {},
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
    if (report.cases.find((item) => item.id === lesson.case)?.featureAssertions?.length)
      verifyFeatureReport(report, lesson, evidence, capture);
    else verifyStandardReport(report, lesson, evidence, capture);
    lesson.evidence.reportSha256 = evidence.reportSha256;
  }
  await appendFile(path, `${JSON.stringify(lesson)}\n`, { encoding: "utf8", flag: "a" });
  return lesson;
}

async function main(args) {
  if (args.length !== 2 || args[0] !== "--input") {
    invalid("Usage: node record-lesson.mjs --input <json-file>");
  }
  let input;
  try {
    input = JSON.parse(await readFile(resolve(args[1]), "utf8"));
  } catch {
    invalid("Input file is unreadable or is not valid JSON");
  }
  const lesson = await appendLesson(input);
  process.stdout.write(`Recorded ${lesson.status} lesson for ${lesson.case} at ${lesson.commit}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
