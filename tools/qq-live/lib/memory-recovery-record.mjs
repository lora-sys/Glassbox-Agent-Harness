import { open } from "node:fs/promises";
import { posix } from "node:path";
import { digest, fail, toolManifestDigest } from "./core.mjs";
import { memoryFixtureProject, memoryFixtureStep } from "./memory-scenario.mjs";

const MAX_ROWS = 40;
const MAX_ROW_BYTES = 1024 * 1024;
const SAFE_RUN_ID = /^[A-Za-z0-9._-]{1,128}$/;
const NONCE = /^[a-f0-9]{32}$/;
const CANDIDATE_ID = /^candidate_[a-f0-9]{32}$/;
const MEMORY_ID = /^memory_[a-f0-9]{32}$/;
const MARKER = /^[a-f0-9]{32}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const MESSAGE_ID = /^-?\d{1,20}$/;
const PROCESS_TICKS = /^[1-9]\d{0,31}$/;
const BOOT_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const PHASES = new Set(["before_send", "lease_intent", "prepared", "sent", "observed"]);
const STAGES = new Set(["feedback", "promote", "expire"]);
const SCOPE_KEYS = ["connectionId", "botId", "chatType", "chatId", "senderId", "threadId"];
const RUNTIME_KEYS = ["checkout", "dataDirectory", "commit", "pid", "connectionId", "threadId"];
const PROCESS_KEYS = ["pid", "bootId", "startTicks"];
const ROW_KEYS = [
  "schemaVersion",
  "origin",
  "sequence",
  "previousSha256",
  "phase",
  "stage",
  "handles",
  "steps",
  "at",
  "runId",
  "reportDirectory",
  "checkpointSha256",
];
const ROW_OPTIONAL_KEYS = ["preparedCase", "sentCase", "recoveryAttempt"];
const HANDLE_KEYS = [
  "fixtureNonce",
  "projectId",
  "principalId",
  "creationRunId",
  "candidateId",
  "promoteRunId",
  "memoryId",
  "stepRunId",
  "cleanupRunId",
  "cleanupStatus",
];
const STEP_KEYS = ["stage", "currentRunId", "runId", "productAcceptance"];
const ACCEPTANCE_KEYS = ["status", "runtime", "caseId", "traceVerified", "featureStatus"];
const CASE_KEYS = ["caseId", "marker", "textSha256", "startedAt", "route"];
const LEASE_CASE_KEYS = [...CASE_KEYS, "leaseId", "expiresAt", "toolsSha256"];
const SENT_KEYS = ["caseId", "driverMessageId", "startedAt"];
const RECOVERY_KEYS = ["attemptId", "process", "currentRuntime", "stage", "phase", "handles"];
const RECOVERY_OPTIONAL_KEYS = ["preparedCase", "sentCase", "cleanupRunId"];
const RECOVERY_HANDLE_KEYS = [
  "fixtureNonce",
  "projectId",
  "principalId",
  "candidateId",
  "creationRunId",
  "promoteRunId",
  "memoryId",
];

function reject(code, message) {
  fail(code, message, "INCONCLUSIVE");
}

function exactKeys(value, keys) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

function sameJson(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function sameScope(a, b) {
  return SCOPE_KEYS.every((key) => a[key] === b[key]);
}

function sameRuntime(a, b) {
  return (
    exactKeys(a, RUNTIME_KEYS) &&
    exactKeys(b, RUNTIME_KEYS) &&
    RUNTIME_KEYS.every((key) => a[key] === b[key])
  );
}

function decodeUtf8(bytes, label) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    reject("MEMORY_RECORD_UTF8", `${label} is not valid UTF-8.`);
  }
}

async function readBoundedFile(path, maxBytes, read) {
  let bytes;
  try {
    bytes = await read(path, maxBytes);
  } catch {
    reject("MEMORY_RECORD_READ", "A required Memory recovery record could not be read.");
  }
  if (typeof bytes === "string") bytes = Buffer.from(bytes, "utf8");
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > maxBytes)
    reject("MEMORY_RECORD_SIZE", "A Memory recovery record exceeds its read limit.");
  return decodeUtf8(bytes, "Memory recovery record");
}

async function defaultBoundedRead(path, maxBytes) {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(maxBytes + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > maxBytes)
      reject("MEMORY_RECORD_SIZE", "A Memory recovery record exceeds its read limit.");
    return buffer.subarray(0, offset);
  } finally {
    await handle.close();
  }
}

function parseLines(text, label) {
  if (!text.endsWith("\n")) reject("MEMORY_RECORD_TORN", `${label} ends with an incomplete row.`);
  const lines = text.slice(0, -1).split("\n");
  if (lines.length < 1 || lines.length > MAX_ROWS || lines.some((line) => !line))
    reject("MEMORY_RECORD_ROWS", `${label} has an invalid number of rows.`);
  for (const line of lines) {
    if (Buffer.byteLength(line, "utf8") > MAX_ROW_BYTES)
      reject("MEMORY_RECORD_SIZE", `${label} contains a row above the byte limit.`);
  }
  return lines.map((line) => {
    try {
      const row = JSON.parse(line);
      if (!row || typeof row !== "object" || Array.isArray(row) || JSON.stringify(row) !== line)
        reject("MEMORY_RECORD_JSON", `${label} contains a noncanonical row.`);
      return row;
    } catch (error) {
      if (error?.code === "MEMORY_RECORD_JSON") throw error;
      reject("MEMORY_RECORD_JSON", `${label} contains invalid JSON.`);
    }
  });
}

function validateRuntime(originRuntime, runtime) {
  if (!exactKeys(originRuntime, RUNTIME_KEYS) || !runtime || typeof runtime !== "object")
    reject("MEMORY_RECORD_RUNTIME", "The saved Runtime identity is incomplete.");
  if (
    originRuntime.checkout !== runtime.checkout ||
    originRuntime.dataDirectory !== runtime.dataDirectory ||
    originRuntime.commit !== runtime.commit ||
    originRuntime.connectionId !== runtime.connectionId ||
    originRuntime.threadId !== (runtime.threadId ?? null) ||
    !posix.isAbsolute(originRuntime.checkout) ||
    !posix.isAbsolute(originRuntime.dataDirectory) ||
    !/^[a-f0-9]{40}$/.test(originRuntime.commit ?? "") ||
    !Number.isSafeInteger(originRuntime.pid) ||
    originRuntime.pid < 1 ||
    typeof originRuntime.connectionId !== "string" ||
    !originRuntime.connectionId ||
    !(originRuntime.threadId === null || typeof originRuntime.threadId === "string")
  )
    reject("MEMORY_RECORD_RUNTIME", "The saved Runtime does not match the current Runtime.");
}

function validateOrigin(origin, { driverQQ, scope, runtime }) {
  const originKeys = ["runtime", "process", "scope", "driverSha256", "suiteSha256", "startedAt"];
  if (!exactKeys(origin, originKeys))
    reject("MEMORY_RECORD_ORIGIN", "The saved acceptance origin is incomplete.");
  validateRuntime(origin.runtime, runtime);
  if (
    !exactKeys(origin.process, PROCESS_KEYS) ||
    !Number.isSafeInteger(origin.process.pid) ||
    origin.process.pid < 1 ||
    !BOOT_ID.test(origin.process.bootId ?? "") ||
    !PROCESS_TICKS.test(origin.process.startTicks ?? "")
  )
    reject("MEMORY_RECORD_PROCESS", "The saved Linux process identity is incomplete.");
  if (
    !exactKeys(origin.scope, SCOPE_KEYS) ||
    !exactKeys(scope, SCOPE_KEYS) ||
    origin.scope.chatType !== "private" ||
    origin.scope.chatId !== driverQQ ||
    origin.scope.senderId !== driverQQ ||
    typeof origin.scope.connectionId !== "string" ||
    !origin.scope.connectionId ||
    typeof origin.scope.botId !== "string" ||
    !origin.scope.botId ||
    !(origin.scope.threadId === null || typeof origin.scope.threadId === "string") ||
    !sameScope(origin.scope, scope)
  )
    reject("MEMORY_RECORD_SCOPE", "The saved private scope does not match this Driver.");
  if (
    typeof driverQQ !== "string" ||
    !/^[1-9]\d{4,15}$/.test(driverQQ) ||
    origin.driverSha256 !== digest(driverQQ) ||
    !SHA256.test(origin.suiteSha256 ?? "") ||
    !Number.isFinite(Date.parse(origin.startedAt))
  )
    reject("MEMORY_RECORD_ORIGIN", "The saved Driver or suite identity is invalid.");
}

function validateRow(row, index, previousHash, originState, input) {
  if (
    !exactKeys(row, [...ROW_KEYS, ...ROW_OPTIONAL_KEYS.filter((key) => Object.hasOwn(row, key))]) ||
    row.schemaVersion !== 2 ||
    row.sequence !== index + 1 ||
    row.previousSha256 !== previousHash ||
    !SHA256.test(row.checkpointSha256 ?? "")
  )
    reject("MEMORY_RECORD_CHAIN", "Memory checkpoint sequence or hash chain is invalid.");
  const { checkpointSha256, ...unsigned } = row;
  if (digest(JSON.stringify(unsigned)) !== checkpointSha256)
    reject("MEMORY_RECORD_HASH", "A Memory checkpoint hash does not match its contents.");

  validateOrigin(row.origin, input);
  if (!originState.value) originState.value = row.origin;
  else if (!sameJson(originState.value, row.origin))
    reject("MEMORY_RECORD_ORIGIN", "Memory checkpoint origin changed within the journal.");

  if (
    !SAFE_RUN_ID.test(row.runId ?? "") ||
    !posix.isAbsolute(row.reportDirectory ?? "") ||
    posix.basename(row.reportDirectory) !== row.runId ||
    (originState.runId && originState.runId !== row.runId) ||
    (originState.reportDirectory &&
      posix.resolve(originState.reportDirectory) !== posix.resolve(row.reportDirectory)) ||
    !Number.isFinite(Date.parse(row.at)) ||
    !PHASES.has(row.phase) ||
    !STAGES.has(row.stage)
  )
    reject(
      "MEMORY_RECORD_BINDING",
      "Memory checkpoint run, directory, phase, or stage is invalid.",
    );
  originState.runId ??= row.runId;
  originState.reportDirectory ??= row.reportDirectory;

  const nonce = row.handles?.fixtureNonce;
  if (
    !NONCE.test(nonce ?? "") ||
    row.handles?.projectId !== memoryFixtureProject(nonce) ||
    (row.handles.candidateId !== undefined && !CANDIDATE_ID.test(row.handles.candidateId)) ||
    (row.handles.memoryId !== undefined && !MEMORY_ID.test(row.handles.memoryId))
  )
    reject("MEMORY_RECORD_FIXTURE", "Memory checkpoint fixture scope or resource ID is invalid.");
  if (
    (originState.fixtureNonce && originState.fixtureNonce !== nonce) ||
    (originState.projectId && originState.projectId !== row.handles.projectId) ||
    (originState.principalId &&
      row.handles.principalId &&
      originState.principalId !== row.handles.principalId)
  )
    reject("MEMORY_RECORD_FIXTURE", "Memory checkpoint changed Owner or project fixture identity.");
  originState.fixtureNonce ??= nonce;
  originState.projectId ??= row.handles.projectId;
  if (row.handles.principalId) originState.principalId ??= row.handles.principalId;
  if (Object.keys(row.handles).some((key) => !HANDLE_KEYS.includes(key)))
    reject("MEMORY_RECORD_FIXTURE", "Memory checkpoint contains an unsupported handle.");

  validateSteps(row, originState.value);
  validateStageHandles(row);
  validatePreparedCase(row);
  validateSentCase(row);
  validateRecoveryAttempt(row, originState, input);
}

function validateSteps(row, origin) {
  const stageIndex = ["feedback", "promote", "expire"].indexOf(row.stage);
  const expectedLength = stageIndex + (row.phase === "observed" ? 1 : 0);
  if (!Array.isArray(row.steps) || row.steps.length !== expectedLength)
    reject("MEMORY_RECORD_STEPS", "Checkpoint progress does not match its stage and phase.");
  for (let index = 0; index < row.steps.length; index++) {
    const step = row.steps[index];
    const stage = ["feedback", "promote", "expire"][index];
    const acceptance = step?.productAcceptance;
    if (
      !exactKeys(step, STEP_KEYS) ||
      step.stage !== stage ||
      !SAFE_RUN_ID.test(step.currentRunId ?? "") ||
      step.runId !== step.currentRunId ||
      !exactKeys(acceptance, ACCEPTANCE_KEYS) ||
      acceptance.status !== "PASS" ||
      acceptance.caseId !== `memory-${stage}` ||
      acceptance.traceVerified !== true ||
      acceptance.featureStatus !== "PASS" ||
      !exactKeys(acceptance.runtime, RUNTIME_KEYS) ||
      !sameJson(acceptance.runtime, origin.runtime)
    )
      reject("MEMORY_RECORD_STEPS", "A completed Memory step lacks its exact PASS evidence.");
  }
  if (row.phase === "observed") {
    const current = row.steps.at(-1);
    if (row.handles.stepRunId !== current.currentRunId)
      reject("MEMORY_RECORD_RUN", "Observed handles do not match the completed product Run.");
    if (row.stage === "feedback" && row.handles.creationRunId !== current.currentRunId)
      reject("MEMORY_RECORD_RUN", "Feedback candidate is not bound to its creation Run.");
    if (row.stage === "promote" && row.handles.promoteRunId !== current.currentRunId)
      reject("MEMORY_RECORD_RUN", "Promoted Memory is not bound to its governance Run.");
    if (row.stage === "expire" && row.handles.cleanupRunId !== current.currentRunId)
      reject("MEMORY_RECORD_RUN", "Expired Memory is not bound to its cleanup Run.");
  }
}

function validateStageHandles(row) {
  const { stage, phase, handles } = row;
  if (!handles || typeof handles !== "object" || Array.isArray(handles))
    reject("MEMORY_RECORD_FIXTURE", "Memory checkpoint handles are missing.");
  if (stage === "feedback") {
    const observed = phase === "observed";
    if (
      observed !== Boolean(handles.candidateId && handles.creationRunId && handles.principalId) ||
      handles.memoryId !== undefined ||
      handles.promoteRunId !== undefined
    )
      reject("MEMORY_RECORD_FIXTURE", "Feedback checkpoint has inconsistent resource handles.");
  } else if (stage === "promote") {
    if (
      !CANDIDATE_ID.test(handles.candidateId ?? "") ||
      !SAFE_RUN_ID.test(handles.creationRunId ?? "") ||
      !SAFE_RUN_ID.test(handles.principalId ?? "") ||
      (phase === "observed"
        ? !MEMORY_ID.test(handles.memoryId ?? "") || !SAFE_RUN_ID.test(handles.promoteRunId ?? "")
        : handles.memoryId !== undefined || handles.promoteRunId !== undefined)
    )
      reject("MEMORY_RECORD_FIXTURE", "Promote checkpoint has inconsistent resource handles.");
  } else if (
    !CANDIDATE_ID.test(handles.candidateId ?? "") ||
    !MEMORY_ID.test(handles.memoryId ?? "") ||
    !SAFE_RUN_ID.test(handles.creationRunId ?? "") ||
    !SAFE_RUN_ID.test(handles.promoteRunId ?? "") ||
    !SAFE_RUN_ID.test(handles.principalId ?? "") ||
    (phase === "observed"
      ? !SAFE_RUN_ID.test(handles.cleanupRunId ?? "") || handles.cleanupStatus !== "expired"
      : handles.cleanupRunId !== undefined || handles.cleanupStatus !== undefined)
  )
    reject("MEMORY_RECORD_FIXTURE", "Expire checkpoint has inconsistent resource handles.");

  if (phase === "observed") {
    if (!SAFE_RUN_ID.test(handles.stepRunId ?? ""))
      reject("MEMORY_RECORD_RUN", "Observed checkpoint lacks its exact product Run.");
  }
  if (handles.creationRunId && !SAFE_RUN_ID.test(handles.creationRunId))
    reject("MEMORY_RECORD_RUN", "Candidate creation Run identifier is invalid.");
  if (handles.promoteRunId && handles.promoteRunId === handles.creationRunId)
    reject("MEMORY_RECORD_RUN", "Candidate creation and promote must use distinct Runs.");
  if (
    handles.cleanupRunId &&
    [handles.creationRunId, handles.promoteRunId].includes(handles.cleanupRunId)
  )
    reject("MEMORY_RECORD_RUN", "Memory cleanup must use its own Run.");
}

function validatePreparedCase(row) {
  const { phase, stage, handles, preparedCase } = row;
  const requiresPrepared = ["lease_intent", "prepared", "sent"].includes(phase);
  if (!requiresPrepared) {
    if (preparedCase !== undefined)
      reject(
        "MEMORY_RECORD_PREPARED",
        "Unexpected prepared-case identity in this checkpoint phase.",
      );
    return;
  }
  if (
    !exactKeys(preparedCase, phase === "lease_intent" ? CASE_KEYS : LEASE_CASE_KEYS) ||
    !preparedCase ||
    preparedCase.caseId !== `memory-${stage}` ||
    !MARKER.test(preparedCase.marker ?? "") ||
    !SHA256.test(preparedCase.textSha256 ?? "") ||
    !Number.isFinite(Date.parse(preparedCase.startedAt)) ||
    preparedCase.route !== "private"
  )
    reject("MEMORY_RECORD_PREPARED", "Prepared Memory message identity is invalid.");

  let spec;
  try {
    spec = memoryFixtureStep(stage, {
      nonce: handles.fixtureNonce,
      candidateId: handles.candidateId,
      memoryId: handles.memoryId,
    });
  } catch {
    reject("MEMORY_RECORD_FIXTURE", "The saved Memory step cannot be reconstructed.");
  }
  const prompt = `GLASSBOX_ACCEPTANCE_V1 ${preparedCase.marker}\n${spec.prompt.trim().replaceAll("{{nonce}}", preparedCase.marker)}`;
  if (digest(prompt) !== preparedCase.textSha256)
    reject("MEMORY_RECORD_PREPARED", "Prepared message hash does not match the fixed Memory step.");

  if (phase === "lease_intent") {
    if (["leaseId", "expiresAt", "toolsSha256"].some((key) => Object.hasOwn(preparedCase, key)))
      reject("MEMORY_RECORD_PREPARED", "Lease intent must precede its registration receipt.");
  } else if (
    !UUID.test(preparedCase.leaseId ?? "") ||
    !Number.isSafeInteger(preparedCase.expiresAt) ||
    preparedCase.expiresAt <= Date.parse(preparedCase.startedAt) ||
    !SHA256.test(preparedCase.toolsSha256 ?? "") ||
    toolManifestDigest(spec.leaseTools) !== preparedCase.toolsSha256
  )
    reject("MEMORY_RECORD_LEASE", "Prepared lease receipt does not match the fixed Tool manifest.");
}

function validateSentCase(row) {
  const { phase, stage, sentCase, preparedCase } = row;
  if (phase !== "sent") {
    if (sentCase !== undefined)
      reject("MEMORY_RECORD_SENT", "Unexpected sent-case data in this checkpoint phase.");
    return;
  }
  if (
    !exactKeys(sentCase, SENT_KEYS) ||
    !sentCase ||
    sentCase.caseId !== `memory-${stage}` ||
    !MESSAGE_ID.test(String(sentCase.driverMessageId ?? "")) ||
    sentCase.startedAt !== preparedCase.startedAt
  )
    reject("MEMORY_RECORD_SENT", "Sent message receipt is invalid or mismatched.");
}

function validateProcess(process) {
  if (
    !exactKeys(process, PROCESS_KEYS) ||
    !Number.isSafeInteger(process.pid) ||
    process.pid < 1 ||
    !BOOT_ID.test(process.bootId ?? "") ||
    !PROCESS_TICKS.test(process.startTicks ?? "")
  )
    reject("MEMORY_RECORD_PROCESS", "The saved Linux process identity is incomplete.");
}

function validateRecoveryAttempt(row, originState, input) {
  const attempt = row.recoveryAttempt;
  if (attempt === undefined) {
    if (
      originState.activeRecovery &&
      originState.recoveryAttempts.get(originState.activeRecovery)?.phase !== "observed"
    )
      reject("MEMORY_RECORD_RECOVERY", "Recovery attempt identity disappeared from the journal.");
    return;
  }
  const allowedKeys = [
    ...RECOVERY_KEYS,
    ...RECOVERY_OPTIONAL_KEYS.filter((key) => Object.hasOwn(attempt, key)),
  ];
  if (
    !exactKeys(attempt, allowedKeys) ||
    !NONCE.test(attempt.attemptId ?? "") ||
    !["reject", "expire"].includes(attempt.stage) ||
    !["before_send", "lease_intent", "prepared", "sent", "observed"].includes(attempt.phase)
  )
    reject("MEMORY_RECORD_RECOVERY", "Recovery attempt identity is invalid.");
  validateProcess(attempt.process);
  validateRuntime(attempt.currentRuntime, input.runtime);
  if (!sameRuntime(attempt.currentRuntime, input.runtime))
    reject("MEMORY_RECORD_RUNTIME", "Recovery attempt Runtime does not match the current service.");

  const sourceHandles = row.handles;
  if (!validateRecoveryHandles(attempt.stage, attempt.handles, sourceHandles, originState))
    reject("MEMORY_RECORD_RECOVERY", "Recovery handles do not bind one verified fixture target.");

  const state = originState.recoveryAttempts.get(attempt.attemptId);
  const identity = {
    process: attempt.process,
    currentRuntime: attempt.currentRuntime,
    stage: attempt.stage,
    handles: attempt.handles,
  };
  if (state && !sameJson(state.identity, identity))
    reject("MEMORY_RECORD_RECOVERY", "Recovery attempt identity changed within the journal.");
  const phases = ["before_send", "lease_intent", "prepared", "sent", "observed"];
  const expectedPhase = state ? phases[phases.indexOf(state.phase) + 1] : "before_send";
  if (!expectedPhase || attempt.phase !== expectedPhase)
    reject("MEMORY_RECORD_RECOVERY", "Recovery attempt phase sequence is invalid.");
  validateRecoveryMessage(row, attempt);
  if (attempt.phase === "observed") {
    if (!SAFE_RUN_ID.test(attempt.cleanupRunId ?? ""))
      reject("MEMORY_RECORD_RECOVERY", "Observed recovery lacks its cleanup Run.");
    if (
      [
        sourceHandles.creationRunId,
        sourceHandles.promoteRunId,
        attempt.handles.creationRunId,
        attempt.handles.promoteRunId,
      ].includes(attempt.cleanupRunId)
    )
      reject("MEMORY_RECORD_RUN", "Recovery cleanup must use a new Run.");
  } else if (attempt.cleanupRunId !== undefined)
    reject("MEMORY_RECORD_RECOVERY", "Cleanup Run may only appear after observed recovery.");

  if (!originState.activeRecovery || originState.activeRecovery !== attempt.attemptId) {
    if (
      originState.activeRecovery &&
      originState.recoveryAttempts.get(originState.activeRecovery)?.phase !== "observed"
    )
      reject(
        "MEMORY_RECORD_RECOVERY",
        "A new recovery attempt started before the prior attempt completed.",
      );
    originState.activeRecovery = attempt.attemptId;
  }
  originState.recoveryAttempts.set(attempt.attemptId, { identity, phase: attempt.phase });
}

function validateRecoveryHandles(stage, handles, sourceHandles, originState) {
  const allowedKeys = RECOVERY_HANDLE_KEYS.filter((key) => Object.hasOwn(handles ?? {}, key));
  if (
    !exactKeys(handles, allowedKeys) ||
    !NONCE.test(handles.fixtureNonce ?? "") ||
    handles.projectId !== memoryFixtureProject(handles.fixtureNonce) ||
    !SAFE_RUN_ID.test(handles.principalId ?? "") ||
    !CANDIDATE_ID.test(handles.candidateId ?? "") ||
    !SAFE_RUN_ID.test(handles.creationRunId ?? "")
  )
    return false;
  originState.principalId ??= handles.principalId;
  if (stage === "reject") {
    if (handles.memoryId !== undefined || handles.promoteRunId !== undefined) return false;
  } else if (
    !MEMORY_ID.test(handles.memoryId ?? "") ||
    !SAFE_RUN_ID.test(handles.promoteRunId ?? "") ||
    handles.promoteRunId === handles.creationRunId
  )
    return false;

  if (
    handles.fixtureNonce !== sourceHandles.fixtureNonce ||
    handles.projectId !== sourceHandles.projectId ||
    (originState.principalId && handles.principalId !== originState.principalId)
  )
    return false;
  for (const key of ["principalId", "candidateId", "creationRunId", "promoteRunId", "memoryId"]) {
    if (sourceHandles[key] !== undefined && handles[key] !== sourceHandles[key]) return false;
  }
  return true;
}

function validateRecoveryMessage(row, attempt) {
  const hasPrepared = attempt.preparedCase !== undefined;
  const hasSent = attempt.sentCase !== undefined;
  const preparedRequired = ["lease_intent", "prepared", "sent"].includes(attempt.phase);
  const sentRequired = attempt.phase === "sent";
  if ((!hasPrepared && preparedRequired) || (!hasSent && sentRequired) || (hasSent && !hasPrepared))
    reject("MEMORY_RECORD_RECOVERY", "Recovery phase lacks its required message identity.");
  if (!hasPrepared) return;

  const leaseReceipt = Object.hasOwn(attempt.preparedCase, "leaseId");
  if (attempt.phase === "lease_intent" && leaseReceipt)
    reject(
      "MEMORY_RECORD_RECOVERY",
      "Recovery lease intent must precede its registration receipt.",
    );
  if (["prepared", "sent"].includes(attempt.phase) && !leaseReceipt)
    reject("MEMORY_RECORD_RECOVERY", "Recovery prepared message lacks its lease receipt.");
  const expectedPreparedKeys = leaseReceipt ? LEASE_CASE_KEYS : CASE_KEYS;
  const prepared = attempt.preparedCase;
  if (
    !exactKeys(prepared, expectedPreparedKeys) ||
    prepared.caseId !== `memory-${attempt.stage}` ||
    !MARKER.test(prepared.marker ?? "") ||
    !SHA256.test(prepared.textSha256 ?? "") ||
    !Number.isFinite(Date.parse(prepared.startedAt)) ||
    prepared.route !== "private"
  )
    reject("MEMORY_RECORD_RECOVERY", "Recovery prepared message identity is invalid.");
  let spec;
  try {
    spec = memoryFixtureStep(attempt.stage, {
      nonce: attempt.handles.fixtureNonce,
      candidateId: attempt.handles.candidateId,
      memoryId: attempt.handles.memoryId,
    });
  } catch {
    reject(
      "MEMORY_RECORD_RECOVERY",
      "Recovery Memory step cannot be reconstructed from original handles.",
    );
  }
  const prompt = `GLASSBOX_ACCEPTANCE_V1 ${prepared.marker}\n${spec.prompt.trim().replaceAll("{{nonce}}", prepared.marker)}`;
  if (digest(prompt) !== prepared.textSha256)
    reject(
      "MEMORY_RECORD_RECOVERY",
      "Recovery message hash does not match its fixed Memory command.",
    );
  if (!leaseReceipt) {
    if (["leaseId", "expiresAt", "toolsSha256"].some((key) => Object.hasOwn(prepared, key)))
      reject("MEMORY_RECORD_RECOVERY", "Recovery lease intent has an unexpected receipt.");
  } else if (
    !UUID.test(prepared.leaseId ?? "") ||
    !Number.isSafeInteger(prepared.expiresAt) ||
    prepared.expiresAt <= Date.parse(prepared.startedAt) ||
    !SHA256.test(prepared.toolsSha256 ?? "") ||
    toolManifestDigest(spec.leaseTools) !== prepared.toolsSha256
  )
    reject(
      "MEMORY_RECORD_RECOVERY",
      "Recovery lease receipt does not match the fixed Tool manifest.",
    );

  if (hasSent) {
    const sent = attempt.sentCase;
    if (
      !exactKeys(sent, SENT_KEYS) ||
      sent.caseId !== `memory-${attempt.stage}` ||
      !MESSAGE_ID.test(String(sent.driverMessageId ?? "")) ||
      sent.startedAt !== prepared.startedAt
    )
      reject("MEMORY_RECORD_RECOVERY", "Recovery send receipt is invalid.");
  } else if (sentRequired) reject("MEMORY_RECORD_RECOVERY", "Recovery send receipt is missing.");
}

/** Read and authenticate the bounded local checkpoint pair without modifying either file. */
export async function readMemoryRecoveryRecord({
  pendingPath,
  driverQQ,
  scope,
  runtime,
  read = defaultBoundedRead,
}) {
  if (typeof pendingPath !== "string" || !pendingPath || typeof read !== "function")
    reject("MEMORY_RECORD_INPUT", "Memory recovery record input is invalid.");
  const pendingText = await readBoundedFile(pendingPath, MAX_ROW_BYTES + 1, read);
  const pendingRows = parseLines(pendingText, "pending guard");
  if (pendingRows.length !== 1)
    reject("MEMORY_RECORD_PENDING", "Pending guard must contain exactly one row.");
  const pending = pendingRows[0];
  const reportDirectory = pending.reportDirectory;
  const runId = pending.runId;
  if (!posix.isAbsolute(reportDirectory ?? "") || posix.basename(reportDirectory) !== runId)
    reject("MEMORY_RECORD_BINDING", "Pending guard report path does not match its Run id.");

  const journalPath = posix.join(reportDirectory, "memory-fixture.jsonl");
  const journalLimit = MAX_ROWS * (MAX_ROW_BYTES + 1);
  const journalText = await readBoundedFile(journalPath, journalLimit, read);
  const rows = parseLines(journalText, "Memory journal");
  const originState = {
    value: null,
    runId: null,
    reportDirectory: null,
    fixtureNonce: null,
    projectId: null,
    principalId: null,
    recoveryAttempts: new Map(),
    activeRecovery: null,
  };
  let previousHash = null;
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index];
    validateRow(row, index, previousHash, originState, { driverQQ, scope, runtime });
    previousHash = row.checkpointSha256;
  }

  if (
    pending.sequence > rows.length ||
    !sameJson(pending, rows[pending.sequence - 1]) ||
    pending.runId !== runId ||
    posix.resolve(pending.reportDirectory) !== posix.resolve(reportDirectory)
  )
    reject("MEMORY_RECORD_PENDING", "Pending guard does not match its confirmed journal row.");

  return {
    origin: originState.value,
    rows,
    pending,
    confirmedSequence: pending.sequence,
    reportDirectory,
    runId,
  };
}
