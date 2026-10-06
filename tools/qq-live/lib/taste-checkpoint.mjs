import { readFile, open, rm } from "node:fs/promises";
import { dirname, resolve, relative, isAbsolute, sep } from "node:path";
import { digest, fail, toolManifestDigest } from "./core.mjs";
import { writeMemoryCheckpoint } from "./memory-checkpoint.mjs";
import { TASTE_FAMILY_ID, tasteFixtureProject, tasteFixtureStep } from "./taste-scenario.mjs";

const MAX_ROWS = 40;
const MAX_BYTES = 1024 * 1024;
const NONCE = /^[a-f0-9]{32}$/;
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const CANDIDATE = /^candidate_[a-f0-9]{32}$/;
const MEMORY = /^memory_[a-f0-9]{32}$/;
const HASH = /^[a-f0-9]{64}$/;
const PHASES = new Set([
  "before_send",
  "lease_intent",
  "prepared",
  "sent",
  "observed",
  "cleanup_confirmed",
  "recovery_prepared",
  "recovery_observed",
]);
const STAGES = new Set(["feedback", "promote", "negative-feedback", "retire"]);
const STAGE_ORDER = ["feedback", "promote", "negative-feedback", "retire"];
const RECOVERY_SEQUENCES = {
  feedback: [["reject-candidate"]],
  promote: [["reject-candidate"], ["expire-original"]],
  "negative-feedback": [["expire-original"], ["reject-correction", "expire-original"]],
  retire: [[], ["reject-correction", "expire-original"]],
};

function invalid(code, message) {
  fail(code, message, "INCONCLUSIVE");
}

function jsonRecord(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    invalid("TASTE_CHECKPOINT_SHAPE", `${label} is invalid.`);
  return value;
}

function validateHandles(handles) {
  jsonRecord(handles, "Taste checkpoint handles");
  if (
    !NONCE.test(handles.fixtureNonce ?? "") ||
    handles.projectId !== tasteFixtureProject(handles.fixtureNonce) ||
    (Object.hasOwn(handles, "principalId") && !ID.test(handles.principalId ?? "")) ||
    (Object.hasOwn(handles, "creationRunId") && !ID.test(handles.creationRunId ?? "")) ||
    (Object.hasOwn(handles, "candidateId") && !CANDIDATE.test(handles.candidateId ?? "")) ||
    (Object.hasOwn(handles, "promotionRunId") && !ID.test(handles.promotionRunId ?? "")) ||
    (Object.hasOwn(handles, "memoryId") && !MEMORY.test(handles.memoryId ?? "")) ||
    (Object.hasOwn(handles, "negativeRunId") && !ID.test(handles.negativeRunId ?? "")) ||
    (Object.hasOwn(handles, "correctionCandidateId") &&
      !CANDIDATE.test(handles.correctionCandidateId ?? "")) ||
    (Object.hasOwn(handles, "cleanupRunId") && !ID.test(handles.cleanupRunId ?? ""))
  )
    invalid("TASTE_CHECKPOINT_HANDLES", "Taste checkpoint fixture handles are invalid.");
}

function validateOrigin(origin, { runtime, scope, driverQQ }) {
  jsonRecord(origin, "Taste checkpoint origin");
  if (
    origin.familyId !== TASTE_FAMILY_ID ||
    JSON.stringify(origin.runtime) !== JSON.stringify(runtime) ||
    JSON.stringify(origin.scope) !== JSON.stringify(scope) ||
    origin.driverSha256 !== digest(driverQQ) ||
    !HASH.test(origin.suiteSha256 ?? "") ||
    !Number.isFinite(Date.parse(origin.startedAt))
  )
    invalid("TASTE_CHECKPOINT_ORIGIN", "Taste checkpoint belongs to another runtime or account.");
}

function validateRow(row, index, previousHash, origin, input) {
  jsonRecord(row, "Taste checkpoint row");
  if (
    row.schemaVersion !== 1 ||
    row.familyId !== TASTE_FAMILY_ID ||
    row.sequence !== index + 1 ||
    row.previousSha256 !== previousHash ||
    !HASH.test(row.checkpointSha256 ?? "") ||
    !PHASES.has(row.phase) ||
    !STAGES.has(row.stage) ||
    !Array.isArray(row.steps) ||
    row.steps.length > 4 ||
    typeof row.runId !== "string" ||
    !ID.test(row.runId) ||
    typeof row.reportDirectory !== "string" ||
    !isAbsolute(row.reportDirectory)
  )
    invalid("TASTE_CHECKPOINT_ROW", "Taste checkpoint sequence or stage is invalid.");
  const { checkpointSha256, ...unsigned } = row;
  if (digest(JSON.stringify(unsigned)) !== checkpointSha256)
    invalid("TASTE_CHECKPOINT_HASH", "Taste checkpoint hash does not match its contents.");
  validateOrigin(row.origin, input);
  if (JSON.stringify(row.origin) !== JSON.stringify(origin))
    invalid("TASTE_CHECKPOINT_ORIGIN", "Taste checkpoint origin changed within its journal.");
  validateHandles(row.handles);
  if (row.preparedCase !== undefined) {
    jsonRecord(row.preparedCase, "Prepared Taste case");
    if (
      typeof row.preparedCase.caseId !== "string" ||
      !row.preparedCase.caseId.startsWith("taste-") ||
      !HASH.test(row.preparedCase.textSha256 ?? "") ||
      !/^[a-f0-9]{32}$/.test(row.preparedCase.marker ?? "") ||
      (row.preparedCase.route !== undefined && row.preparedCase.route !== "private")
    )
      invalid("TASTE_CHECKPOINT_CASE", "Prepared Taste case is invalid.");
  }
  if (row.sentCase !== undefined) {
    jsonRecord(row.sentCase, "Sent Taste case");
    if (
      typeof row.sentCase.caseId !== "string" ||
      !row.sentCase.caseId.startsWith("taste-") ||
      typeof row.sentCase.driverMessageId !== "string" ||
      !/^-?\d{1,20}$/.test(row.sentCase.driverMessageId)
    )
      invalid("TASTE_CHECKPOINT_CASE", "Sent Taste case is invalid.");
  }
  if (row.phase.startsWith("recovery_")) {
    jsonRecord(row.recoveryAttempt, "Taste recovery attempt");
    if (
      !["reject-candidate", "reject-correction", "expire-original"].includes(
        row.recoveryAttempt.action,
      ) ||
      !HASH.test(row.recoveryAttempt.planSha256 ?? "") ||
      (row.phase === "recovery_observed" &&
        (!ID.test(row.recoveryAttempt.cleanupRunId ?? "") ||
          row.recoveryAttempt.cleanupRunId !== row.handles.cleanupRunId))
    )
      invalid("TASTE_CHECKPOINT_RECOVERY", "Taste recovery checkpoint is invalid.");
  }
  if (row.phase === "cleanup_confirmed") {
    const failure = row.knownFailure;
    const source = failure?.sourceCase;
    const proof = failure?.terminalProof;
    const failureCode = failure?.failureCode;
    let expectedSpec;
    try {
      expectedSpec = tasteFixtureStep(row.stage, {
        nonce: row.handles.fixtureNonce,
        candidateId: row.handles.candidateId,
        memoryId: row.handles.memoryId,
        correctionCandidateId: row.handles.correctionCandidateId,
      });
    } catch {
      invalid("TASTE_CHECKPOINT_FAILURE", "Taste terminal failure is outside the fixed family.");
    }
    const expectedPrompt = `GLASSBOX_ACCEPTANCE_V1 ${source?.token}\n${expectedSpec.prompt
      .replaceAll("{{nonce}}", source?.token ?? "")
      .trim()}`;
    const expectedTools = JSON.parse(
      JSON.stringify(expectedSpec.leaseTools).replaceAll("{{nonce}}", source?.token ?? ""),
    );
    if (
      !source ||
      ![
        "REPLY_ASSERTION_FAILED",
        "TASTE_FEEDBACK",
        "TASTE_PROMOTE",
        "TASTE_NEGATIVE",
        "TASTE_MEMORY",
        "TASTE_RETIRE",
        "TASTE_FIXTURE_FEEDBACK",
        "TASTE_FIXTURE_PROMOTE",
        "TASTE_FIXTURE_NEGATIVE",
        "TASTE_FIXTURE_CLEANUP",
      ].includes(failureCode) ||
      !/^[a-f0-9]{32}$/.test(source.token ?? "") ||
      (failureCode === "REPLY_ASSERTION_FAILED"
        ? source.status !== "FAIL" || source.code !== "REPLY_ASSERTION_FAILED"
        : source.status !== "PASS" || source.code !== "REAL_REPLY_RECEIVED") ||
      source.sendAttempted !== true ||
      source.inputObserved !== true ||
      source.leaseRegistrationAttempted !== true ||
      source.leaseRevoked !== true ||
      source.acceptanceLease?.toolsSha256 !== toolManifestDigest(expectedTools) ||
      source.prompt !== expectedPrompt ||
      JSON.stringify(source.expected) !==
        JSON.stringify(
          expectedSpec.expectContains.map((value) => value.replaceAll("{{nonce}}", source.token)),
        ) ||
      JSON.stringify(source.featureAssertions) !==
        JSON.stringify(
          expectedSpec.featureAssertions.map((value) =>
            JSON.parse(JSON.stringify(value).replaceAll("{{nonce}}", source.token)),
          ),
        ) ||
      JSON.stringify(source.leasedToolNames) !==
        JSON.stringify(expectedTools.map((tool) => tool.name)) ||
      source.route !== "private" ||
      !source.inputBinding ||
      !/^-?\d{1,20}$/.test(String(source.inputBinding.driverMessageId ?? "")) ||
      !/^-?\d{1,20}$/.test(String(source.inputBinding.botMessageId ?? "")) ||
      !/^\d{1,30}$/.test(String(source.inputBinding.realSequence ?? "")) ||
      !Number.isSafeInteger(source.inputBinding.time) ||
      !HASH.test(source.inputBinding.textSha256 ?? "") ||
      !Array.isArray(source.replies) ||
      source.replies.length !== 1 ||
      source.replies[0]?.route !== "private" ||
      source.replies[0]?.matches !== (failureCode !== "REPLY_ASSERTION_FAILED") ||
      !/^-?\d{1,20}$/.test(String(source.replies[0]?.messageId ?? "")) ||
      !HASH.test(source.replies[0]?.textSha256 ?? "") ||
      !Number.isSafeInteger(source.replies[0]?.textBytes) ||
      !Number.isFinite(Date.parse(source.replies[0]?.receivedAt ?? "")) ||
      proof?.cleanupVerified !== true ||
      proof.failureCode !== failureCode ||
      proof.caseId !== source.id ||
      !ID.test(proof.runId ?? "") ||
      !HASH.test(proof.toolOutputSha256 ?? "") ||
      proof.toolName !== "owner_memory_admin" ||
      typeof proof.toolCallId !== "string" ||
      !proof.toolCallId ||
      !HASH.test(proof.toolsSha256 ?? "") ||
      proof.toolsSha256 !== source.acceptanceLease.toolsSha256 ||
      !HASH.test(proof.promptSha256 ?? "") ||
      proof.promptSha256 !== digest(source.prompt) ||
      JSON.stringify(proof.inputBinding) !== JSON.stringify(source.inputBinding) ||
      JSON.stringify(proof.reply) !== JSON.stringify(source.replies[0]) ||
      !proof.messageBinding ||
      !proof.messageBinding.input ||
      !proof.messageBinding.reply ||
      String(proof.messageBinding.input.realSequence) !==
        String(source.inputBinding.realSequence) ||
      proof.messageBinding.input.time !== source.inputBinding.time ||
      proof.messageBinding.input.textSha256 !== source.inputBinding.textSha256 ||
      String(proof.messageBinding.reply.driverMessageId) !== String(source.replies[0].messageId) ||
      !/^-?\d{1,20}$/.test(String(proof.messageBinding.reply.botMessageId ?? "")) ||
      !/^-?\d{1,20}$/.test(String(proof.messageBinding.reply.driverMessageId ?? "")) ||
      !/^\d{1,30}$/.test(String(proof.messageBinding.reply.realSequence ?? "")) ||
      !Number.isSafeInteger(proof.messageBinding.reply.time) ||
      !HASH.test(proof.messageBinding.reply.textSha256 ?? "") ||
      proof.messageBinding.reply.textSha256 !== source.replies[0].textSha256
    )
      invalid("TASTE_CHECKPOINT_FAILURE", "Taste terminal failure proof is incomplete.");
  }
}

function parseCanonicalLines(text, label) {
  if (Buffer.byteLength(text, "utf8") > MAX_ROWS * MAX_BYTES || !text.endsWith("\n"))
    invalid("TASTE_CHECKPOINT_READ", `${label} is incomplete or too large.`);
  const lines = text.slice(0, -1).split("\n");
  if (
    !lines.length ||
    lines.length > MAX_ROWS ||
    lines.some((line) => !line || Buffer.byteLength(line) > MAX_BYTES)
  )
    invalid("TASTE_CHECKPOINT_READ", `${label} has an invalid row count or row size.`);
  return lines.map((line) => {
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      invalid("TASTE_CHECKPOINT_JSON", `${label} contains invalid JSON.`);
    }
    if (JSON.stringify(row) !== line)
      invalid("TASTE_CHECKPOINT_JSON", `${label} is not canonical JSON.`);
    return row;
  });
}

function same(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function validateTransitions(rows) {
  const first = rows[0];
  if (first.phase !== "before_send" || first.stage !== "feedback" || first.steps.length !== 0)
    invalid("TASTE_CHECKPOINT_TRANSITION", "Taste journal does not begin at the fixed first step.");

  for (let index = 1; index < rows.length; index += 1) {
    const previous = rows[index - 1];
    const current = rows[index];
    if (
      current.runId !== first.runId ||
      current.reportDirectory !== first.reportDirectory ||
      current.steps.length > 4
    )
      invalid("TASTE_CHECKPOINT_ORIGIN", "Taste journal changed its source report identity.");

    const sameStage = current.stage === previous.stage;
    const noStepChange = current.steps.length === previous.steps.length;
    let allowed = false;
    if (previous.phase === "before_send")
      allowed = sameStage && current.phase === "lease_intent" && noStepChange;
    else if (previous.phase === "lease_intent")
      allowed = sameStage && current.phase === "prepared" && noStepChange;
    else if (previous.phase === "prepared")
      allowed = sameStage && current.phase === "sent" && noStepChange;
    else if (previous.phase === "sent")
      allowed =
        sameStage && noStepChange && ["observed", "cleanup_confirmed"].includes(current.phase);
    else if (previous.phase === "observed") {
      const stageIndex = STAGE_ORDER.indexOf(previous.stage);
      allowed =
        (current.phase === "before_send" &&
          STAGE_ORDER[stageIndex + 1] === current.stage &&
          current.steps.length === previous.steps.length) ||
        (sameStage && current.phase === "recovery_prepared" && noStepChange);
    } else if (previous.phase === "cleanup_confirmed")
      allowed = sameStage && current.phase === "recovery_prepared" && noStepChange;
    else if (previous.phase === "recovery_prepared")
      allowed =
        sameStage &&
        noStepChange &&
        ["recovery_prepared", "recovery_observed"].includes(current.phase);
    else if (previous.phase === "recovery_observed")
      allowed = sameStage && current.phase === "recovery_prepared" && noStepChange;

    if (current.phase === "observed") {
      const expectedSteps = previous.steps.length + 1;
      allowed = previous.phase === "sent" && sameStage && current.steps.length === expectedSteps;
      const observedStep = current.steps.at(-1);
      if (
        observedStep?.stage !== current.stage ||
        typeof observedStep?.runId !== "string" ||
        !ID.test(observedStep.runId)
      )
        allowed = false;
    }
    if (!allowed)
      invalid("TASTE_CHECKPOINT_TRANSITION", "Taste journal contains an invalid phase transition.");

    if (current.phase.startsWith("recovery_")) {
      const attempts = rows
        .slice(0, index + 1)
        .filter((row) => row.phase === "recovery_prepared" || row.phase === "recovery_observed")
        .map((row) => row.recoveryAttempt?.action)
        .filter(
          (action, actionIndex, actions) =>
            actionIndex === 0 || action !== actions[actionIndex - 1],
        );
      const sequences = RECOVERY_SEQUENCES[current.stage] ?? [];
      const prefixValid = sequences.some(
        (sequence) =>
          attempts.length <= sequence.length &&
          attempts.every((action, attemptIndex) => action === sequence[attemptIndex]),
      );
      if (!prefixValid)
        invalid(
          "TASTE_CHECKPOINT_TRANSITION",
          "Taste recovery actions are outside the fixed plan.",
        );
      if (
        previous.phase === "recovery_prepared" &&
        (current.recoveryAttempt?.action !== previous.recoveryAttempt?.action ||
          current.recoveryAttempt?.planSha256 !== previous.recoveryAttempt?.planSha256)
      )
        invalid(
          "TASTE_CHECKPOINT_TRANSITION",
          "Taste recovery preparation changed its approved action.",
        );
      if (
        previous.phase === "recovery_observed" &&
        current.recoveryAttempt?.planSha256 !== previous.recoveryAttempt?.planSha256
      )
        invalid("TASTE_CHECKPOINT_TRANSITION", "Taste recovery changed its approved plan.");
    }
  }
}

/** Use the fsync-backed checkpoint writer already used by the fixed Memory workflows. */
export async function writeTasteCheckpoint(input) {
  if (!input?.row || input.row.familyId !== TASTE_FAMILY_ID || input.row.schemaVersion !== 1)
    invalid("TASTE_CHECKPOINT_ROW", "Taste checkpoint writer received an invalid row.");
  return writeMemoryCheckpoint(input);
}

/** Read only one account's exact Taste chain, cross-checking pending against the journal tip. */
export async function readTasteCheckpointRecord({
  pendingPath,
  outDirectory,
  runtime,
  scope,
  driverQQ,
  read = readFile,
}) {
  let pendingText;
  try {
    pendingText = await read(pendingPath, "utf8");
  } catch {
    invalid("TASTE_CHECKPOINT_PENDING", "Taste pending checkpoint could not be read.");
  }
  if (Buffer.byteLength(pendingText, "utf8") > MAX_BYTES)
    invalid("TASTE_CHECKPOINT_PENDING", "Taste pending checkpoint exceeds its size limit.");
  let pending;
  try {
    pending = JSON.parse(pendingText);
  } catch {
    invalid("TASTE_CHECKPOINT_PENDING", "Taste pending checkpoint is invalid JSON.");
  }
  const reportDirectory = resolve(pending.reportDirectory ?? "");
  const relativeDirectory = relative(resolve(outDirectory), reportDirectory);
  if (
    !relativeDirectory ||
    relativeDirectory.startsWith(`..${sep}`) ||
    relativeDirectory === ".." ||
    isAbsolute(relativeDirectory)
  )
    invalid(
      "TASTE_CHECKPOINT_PATH",
      "Taste journal path is outside the configured report directory.",
    );
  const journalPath = `${reportDirectory}${sep}taste-fixture.jsonl`;
  let journalText;
  try {
    journalText = await read(journalPath, "utf8");
  } catch {
    invalid("TASTE_CHECKPOINT_JOURNAL", "Taste checkpoint journal could not be read.");
  }
  const rows = parseCanonicalLines(journalText, "Taste checkpoint journal");
  let previousHash = null;
  let origin;
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    validateRow(row, index, previousHash, origin ?? row.origin, {
      runtime,
      scope,
      driverQQ,
    });
    origin ??= row.origin;
    previousHash = row.checkpointSha256;
  }
  validateTransitions(rows);
  const pendingRows = parseCanonicalLines(pendingText, "Taste pending checkpoint");
  const pendingRow = pendingRows.length === 1 ? pendingRows[0] : undefined;
  const tip = rows.at(-1);
  const laggingOneRow = rows.length > 1 && same(pendingRow, rows.at(-2));
  const pendingLag = laggingOneRow ? 1 : 0;
  if (!same(pendingRow, tip) && pendingLag !== 1)
    invalid("TASTE_CHECKPOINT_PENDING", "Taste pending checkpoint does not match the journal tip.");
  return {
    origin,
    rows,
    pending: tip,
    pendingFileRow: pendingRow,
    pendingLag,
    reportDirectory,
  };
}

export async function clearTasteCheckpoint(pendingPath) {
  await rm(pendingPath);
  const directory = await open(dirname(resolve(pendingPath)), "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}
