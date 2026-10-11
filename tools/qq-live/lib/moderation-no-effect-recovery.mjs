import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, lstat, realpath, mkdir, rename, unlink } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { isDeepStrictEqual } from "node:util";
import { execFileSync } from "node:child_process";
import { fail, digest, toolManifestDigest } from "./core.mjs";
import {
  openProductEvidenceDatabase,
  runtimeSnapshot,
  verifyCaseLeaseCleanupEvidence,
} from "./product-evidence.mjs";
import {
  MODERATION_FAMILY_ID,
  MODERATION_GROUP_B_ID,
  moderationPlan,
  moderationStep,
} from "./moderation-scenario.mjs";
import { readModerationPolicyState } from "./moderation-state.mjs";
import { verifyModerationAuthorizationEvidence } from "./moderation-product-evidence.mjs";
import { verifyMemoryProcessStopped } from "./memory-process.mjs";
import { muteUntil } from "./moderation.mjs";
import { writeDurableReport } from "./durable-report.mjs";

const SOURCE_PIN = Object.freeze({
  commit: "40e279855b34962b08942038ae039eb28792a8ba",
  sourceTreeSha256: "780d9861d93bec86f6afc0c832f9272761964b617a96f455816d86fcb25b37c5",
  executionFiles: Object.freeze({
    "apps/server/src/runtime/pi/protected-tools.ts":
      "16c29c45197407c46f3138543c88301c8acac97d1a9240725beb8cd4ec643fcd",
    "apps/server/src/runtime/pi/capability-tools.ts":
      "e74a55c6ff047cb21defeeedddbc6d67fed7392ad49720d9e08a3fc830b42680",
  }),
});
const STOP_TEXT =
  "CLEANUP_UNCONFIRMED\n请先检查 Bot 的延迟任务、目标状态和本轮报告，再人工删除此文件。\n";
const MAX = { report: 1024 * 1024, checkpoint: 1024 * 1024, pending: 64 * 1024, stop: 1024 };
const HASH = /^[a-f0-9]{64}$/u;
const ID = /^[1-9]\d{4,15}$/u;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu;
const PROCESS_KEYS = ["pid", "bootId", "startTicks"];
const EXPECTED_MUTATION_REFUSAL = Object.freeze({
  sha256: "cc9d6513a73879d148abd7f426af3dbbc628d1fb2f3b1225fb47047be3498342",
  bytes: 74,
});

function invalid(code = "MODERATION_NO_EFFECT_RECOVERY") {
  fail(code, "禁言失败记录不能证明已知无效果。", "INCONCLUSIVE");
}
function sha(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
function exact(value, keys) {
  return (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    isDeepStrictEqual(
      Object.keys(value).sort((a, b) => a.localeCompare(b)),
      [...keys].sort((a, b) => a.localeCompare(b)),
    )
  );
}
function time(value) {
  if (typeof value !== "string") return false;
  const ms = Date.parse(value);
  return Number.isFinite(ms) && new Date(ms).toISOString() === value;
}
function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stable(value[k])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
function same(a, b) {
  return stable(a) === stable(b);
}

async function privateFile(path, limit) {
  if (typeof path !== "string" || !path.startsWith("/") || resolve(path) !== path)
    invalid("MODERATION_RECOVERY_PATH");
  let handle;
  try {
    const before = await lstat(path);
    if (
      !before.isFile() ||
      before.isSymbolicLink() ||
      before.nlink !== 1 ||
      before.size > limit ||
      (before.mode & 0o077) !== 0 ||
      (typeof process.getuid === "function" && before.uid !== process.getuid())
    )
      invalid("MODERATION_RECOVERY_FILE");
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const opened = await handle.stat();
    const bytes = await handle.readFile();
    const after = await handle.stat();
    const named = await lstat(path);
    if (
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      bytes.length !== before.size ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs ||
      named.dev !== before.dev ||
      named.ino !== before.ino ||
      named.size !== before.size ||
      named.mtimeMs !== before.mtimeMs ||
      named.ctimeMs !== before.ctimeMs ||
      (await realpath(path)) !== path
    )
      invalid("MODERATION_RECOVERY_CHANGED");
    return {
      bytes,
      sha256: sha(bytes),
      fingerprint: {
        dev: before.dev,
        ino: before.ino,
        mode: before.mode,
        nlink: before.nlink,
        size: before.size,
        mtimeMs: before.mtimeMs,
        ctimeMs: before.ctimeMs,
      },
    };
  } catch (error) {
    if (String(error?.code).startsWith("MODERATION_")) throw error;
    invalid("MODERATION_RECOVERY_READ");
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function privateDirectory(path) {
  const info = await lstat(path);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    (info.mode & 0o077) !== 0 ||
    (typeof process.getuid === "function" && info.uid !== process.getuid()) ||
    (await realpath(path)) !== path
  )
    invalid("MODERATION_RECOVERY_DIRECTORY");
  return info;
}
function json(bytes) {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    invalid("MODERATION_RECOVERY_JSON");
  }
}
export function moderationRecoveryRunId(reportPath) {
  const report = resolve(reportPath);
  const reportDirectory = dirname(report);
  const runId = basename(reportDirectory);
  if (
    report !== reportPath ||
    basename(report) !== "report.json" ||
    !/^\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d\.\d{3}Z_[a-f0-9]{8}$/u.test(runId)
  )
    invalid("MODERATION_RECOVERY_PATH");
  return runId;
}

export function verifyModerationRecoveryStop(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.toString("utf8") !== STOP_TEXT)
    invalid("MODERATION_RECOVERY_STOP");
}

function pathsFor(reportPath, config, locksDirectory) {
  const report = resolve(reportPath);
  const reportDirectory = dirname(report);
  const runId = moderationRecoveryRunId(reportPath);
  const account = createHash("sha256")
    .update(config?.driver?.qq ?? "")
    .digest("hex")
    .slice(0, 24);
  if (!ID.test(config?.driver?.qq ?? "")) invalid("MODERATION_RECOVERY_IDENTITY");
  const lockPath = join(locksDirectory, `${account}.lock`);
  return {
    reportPath: report,
    reportDirectory,
    runId,
    out: dirname(reportDirectory),
    stopPath: join(dirname(reportDirectory), "STOP"),
    checkpointPath: join(reportDirectory, "moderation.checkpoint.jsonl"),
    attemptPath: join(reportDirectory, "attempt.json"),
    lockPath,
    pendingPath: join(locksDirectory, `${account}.moderation-pending.json`),
    otherGuards: [
      "memory",
      "taste",
      "media",
      "task-worker",
      "group-policy",
      "group-members-policy",
    ].map((name) => join(locksDirectory, `${account}.${name}-pending.json`)),
    archiveDirectory: join(dirname(reportDirectory), "moderation-no-effect-recovery", runId),
  };
}
async function absent(paths) {
  for (const path of paths) {
    try {
      await lstat(path);
      invalid("MODERATION_RECOVERY_ACTIVE_GUARD");
    } catch (error) {
      if (String(error?.code).startsWith("MODERATION_")) throw error;
      if (error?.code !== "ENOENT") invalid("MODERATION_RECOVERY_ACTIVE_GUARD");
    }
  }
}
async function sourcePin(runtime, configuredCheckout) {
  if (
    typeof runtime?.checkout !== "string" ||
    resolve(runtime.checkout) !== runtime.checkout ||
    runtime.checkout !== resolve(configuredCheckout ?? "") ||
    runtime.commit !== SOURCE_PIN.commit ||
    runtime.sourceTreeSha256 !== SOURCE_PIN.sourceTreeSha256
  )
    invalid("MODERATION_RECOVERY_SOURCE");
  const files = {};
  for (const [relative, expectedSha256] of Object.entries(SOURCE_PIN.executionFiles)) {
    const path = join(runtime.checkout, relative);
    let handle;
    try {
      const before = await lstat(path);
      if (
        !before.isFile() ||
        before.isSymbolicLink() ||
        before.size > 5 * 1024 * 1024 ||
        (await realpath(path)) !== path
      )
        invalid("MODERATION_RECOVERY_SOURCE_FILE");
      handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const opened = await handle.stat();
      const bytes = await handle.readFile();
      const after = await handle.stat();
      const named = await lstat(path);
      const actual = sha(bytes);
      if (
        opened.dev !== before.dev ||
        opened.ino !== before.ino ||
        bytes.length !== before.size ||
        after.size !== before.size ||
        after.mtimeMs !== before.mtimeMs ||
        after.ctimeMs !== before.ctimeMs ||
        named.dev !== before.dev ||
        named.ino !== before.ino ||
        named.mtimeMs !== before.mtimeMs ||
        named.ctimeMs !== before.ctimeMs ||
        actual !== expectedSha256
      )
        invalid("MODERATION_RECOVERY_SOURCE_FILE");
      files[relative] = actual;
    } catch (error) {
      if (String(error?.code).startsWith("MODERATION_")) throw error;
      invalid("MODERATION_RECOVERY_SOURCE_FILE");
    } finally {
      await handle?.close().catch(() => {});
    }
  }
  return {
    checkout: runtime.checkout,
    commit: SOURCE_PIN.commit,
    sourceTreeSha256: SOURCE_PIN.sourceTreeSha256,
    executionFiles: files,
  };
}
function scopeFor(config) {
  return {
    connectionId: config.runtime.connectionId,
    botId: config.bot.qq,
    chatType: "private",
    chatId: config.driver.qq,
    senderId: config.driver.qq,
    ...(config.runtime.threadId ? { threadId: config.runtime.threadId } : {}),
  };
}
function scopeKey(scope) {
  return JSON.stringify([
    scope.connectionId,
    scope.botId,
    scope.chatType,
    scope.chatId,
    scope.senderId,
    scope.threadId,
  ]);
}

export function verifyModerationAttempt(attempt, report, runId) {
  if (
    !exact(attempt, ["runId", "mode", "startedAt", "status"]) ||
    attempt.runId !== runId ||
    attempt.mode !== "run" ||
    attempt.startedAt !== report?.startedAt ||
    attempt.status !== "STARTED"
  )
    invalid("MODERATION_RECOVERY_ATTEMPT");
  return {
    runId: attempt.runId,
    mode: attempt.mode,
    startedAt: attempt.startedAt,
    status: attempt.status,
  };
}

function verifyReport(report, paths, pending, config, baselineUntil) {
  if (
    report?.schemaVersion !== 1 ||
    report.mode !== "run" ||
    report.runId !== paths.runId ||
    report.reportDirectory !== paths.reportDirectory ||
    report.status !== "INCONCLUSIVE" ||
    report.safetyStopCreated !== true ||
    !time(report.startedAt) ||
    !time(report.finishedAt) ||
    Date.parse(report.finishedAt) < Date.parse(report.startedAt) ||
    report.suiteSha256 !== pending.identity.suiteSha256 ||
    !same(report.runtime, pending.identity.runtime) ||
    report.productAcceptance?.status !== "INCONCLUSIVE" ||
    report.productAcceptance.cleanupRequired !== true ||
    report.productAcceptance.cleanupVerified !== false ||
    !same(report.productAcceptance.runtime, pending.identity.runtime) ||
    !Array.isArray(report.productAcceptance.cases) ||
    report.productAcceptance.cases.length !== 0 ||
    !Array.isArray(report.cases) ||
    report.cases.length !== 1
  )
    invalid("MODERATION_RECOVERY_REPORT");
  const c = report.cases[0];
  if (
    c?.id !== "moderation-mute" ||
    c.status !== "FAIL" ||
    c.code !== "REPLY_ASSERTION_FAILED" ||
    c.route !== "private" ||
    c.moderation !== true ||
    c.moderationStage !== "mute" ||
    c.moderationGroupId !== MODERATION_GROUP_B_ID ||
    c.leaseRegistrationAttempted !== true ||
    c.leaseRevoked !== true ||
    c.sendAttempted !== true ||
    c.inputObserved !== true ||
    c.moderationAuthorizationBasis !== "group-owner-request" ||
    !Array.isArray(c.replies) ||
    c.replies.length !== 1 ||
    c.replies[0]?.route !== "private" ||
    c.replies[0]?.matches !== false ||
    !HASH.test(c.replies[0]?.textSha256 ?? "") ||
    !Number.isSafeInteger(c.replies[0]?.textBytes) ||
    c.replies[0].textBytes <= 0 ||
    !Array.isArray(c.notices) ||
    c.notices.length !== 0 ||
    c.productRunId !== undefined ||
    !UUID.test(c.acceptanceLease?.leaseId ?? "") ||
    !HASH.test(c.acceptanceLease?.toolsSha256 ?? "") ||
    !Number.isSafeInteger(c.acceptanceLease?.expiresAt) ||
    c.moderationTarget !== config.moderation?.target ||
    !ID.test(c.moderationTarget ?? "") ||
    c.sentMessageId !== c.inputBinding?.driverMessageId ||
    !ID.test(c.inputBinding?.driverMessageId ?? "") ||
    !ID.test(c.inputBinding?.botMessageId ?? "") ||
    !HASH.test(c.inputBinding?.textSha256 ?? "") ||
    c.inputBinding.textSha256 !== digest(c.prompt ?? "") ||
    !time(c.startedAt) ||
    !time(c.finishedAt) ||
    Date.parse(c.startedAt) < Date.parse(report.startedAt) ||
    Date.parse(c.finishedAt) > Date.parse(report.finishedAt)
  )
    invalid("MODERATION_RECOVERY_CASE");
  const fixedAtStart = moderationPlan(config, Date.parse(c.startedAt));
  const fixed = fixedAtStart.fixed;
  let stage;
  try {
    stage = moderationStep("mute", { ...fixed, expectedMuteUntil: baselineUntil });
  } catch {
    invalid("MODERATION_RECOVERY_BASELINE");
  }
  const expectedPrompt = `GLASSBOX_ACCEPTANCE_V1 ${c.token}\n${stage.prompt.replaceAll("{{nonce}}", c.token)}`;
  const expectedTools = JSON.parse(
    JSON.stringify(stage.leaseTools).replaceAll("{{nonce}}", c.token),
  );
  if (
    fixedAtStart.suiteSha256 !== report.suiteSha256 ||
    fixed.authorizationBasis !== "group-owner-request" ||
    fixed.groupId !== MODERATION_GROUP_B_ID ||
    fixed.target !== c.moderationTarget ||
    fixed.durationSeconds < 30 ||
    fixed.durationSeconds > 60 ||
    !/^[a-f0-9]{32}$/u.test(c.token ?? "") ||
    c.prompt !== expectedPrompt ||
    c.moderationExpectedMuteUntil !== baselineUntil ||
    c.acceptanceLease.toolsSha256 !== toolManifestDigest(expectedTools) ||
    !isDeepStrictEqual(c.leasedToolNames, ["qq_group_moderation"]) ||
    c.moderationOwnerAuthorization?.ownerId !== config.driver.qq ||
    c.moderationOwnerAuthorization?.confirmed !== true ||
    c.moderationOwnerAuthorization?.authorizedAt !== fixed.ownerAuthorizationAt ||
    c.moderationOwnerAuthorization?.validUntil !== fixed.ownerAuthorizationUntil
  )
    invalid("MODERATION_RECOVERY_SUITE");
  return { caseRecord: c, fixed, fixedAtStart, baselineUntil };
}

export function verifyModerationCheckpointChain(bytes, pending, report, paths) {
  let rows;
  try {
    rows = bytes
      .toString("utf8")
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line));
  } catch {
    invalid("MODERATION_RECOVERY_CHECKPOINT");
  }
  const phases = ["intent", "lease_intent", "prepared", "sent"];
  if (
    rows.length !== phases.length ||
    rows.some(
      (row, i) =>
        row?.schemaVersion !== 1 ||
        row.sequence !== i + 1 ||
        row.previousSha256 !== (i ? digest(JSON.stringify(rows[i - 1])) : null) ||
        !time(row.recordedAt) ||
        !same(row.identity, pending.identity) ||
        row.observation?.familyId !== MODERATION_FAMILY_ID ||
        row.observation?.stage !== "mute" ||
        row.observation?.phase !== phases[i] ||
        !same(row.observation?.runtime, pending.identity.runtime) ||
        !Array.isArray(row.observation?.steps) ||
        row.observation.steps.length !== 0 ||
        Object.hasOwn(row, "completion"),
    ) ||
    !same(pending, rows.at(-1))
  )
    invalid("MODERATION_RECOVERY_CHECKPOINT");
  const c = report.cases[0];
  const first = rows[0].observation;
  const prep = {
    caseId: c.id,
    marker: c.token,
    promptSha256: digest(c.prompt),
    expectedMuteUntil: c.moderationExpectedMuteUntil,
  };
  if (
    first.mutationPrecondition?.kind !== "qq-member-mute-state" ||
    first.mutationPrecondition?.phase !== "mute" ||
    first.mutationPrecondition?.expectedMuteUntil !== c.moderationExpectedMuteUntil ||
    !same(
      rows.slice(1).map((row) => row.observation.baseline),
      [first.baseline, first.baseline, first.baseline],
    ) ||
    !same(rows[1].observation.prepared, prep) ||
    !same(rows[2].observation.prepared, {
      ...prep,
      expiresAt: c.acceptanceLease.expiresAt,
      leaseId: c.acceptanceLease.leaseId,
      toolsSha256: c.acceptanceLease.toolsSha256,
    }) ||
    !same(rows[3].observation.sent, {
      caseId: c.id,
      marker: c.token,
      driverMessageId: c.sentMessageId,
    }) ||
    pending.identity.familyId !== MODERATION_FAMILY_ID ||
    pending.identity.reportDirectory !== paths.reportDirectory ||
    pending.identity.suiteSha256 !== report.suiteSha256 ||
    !HASH.test(pending.identity.driverSha256 ?? "") ||
    !exact(pending.identity.processIdentity, PROCESS_KEYS) ||
    !isDeepStrictEqual(pending.identity.runtime, report.runtime)
  )
    invalid("MODERATION_RECOVERY_CHECKPOINT");
  return {
    rows,
    baseline: first.baseline,
    expectedMuteUntil: first.mutationPrecondition.expectedMuteUntil,
  };
}

export function verifyModerationNoEffectTrace(trace, evidence, c) {
  const rows = trace?.events;
  if (!Array.isArray(rows) || trace.runId !== evidence.runId) invalid("MODERATION_RECOVERY_TRACE");
  const belongsToRun = (event) => {
    if (event?.runId !== undefined) return event.runId === evidence.runId;
    if (typeof evidence.executionRef !== "string" || !evidence.executionRef) return false;
    if (event?.type === "runtime_health_observation")
      return (
        event.schema === "glassbox.runtime-health-observation.v1" &&
        event.executionRef === evidence.executionRef
      );
    if (event?.type === "routing_eval_evidence")
      return (
        event.schema === "glassbox.routing-eval-evidence.v1" &&
        event.actualExecutionRef === evidence.executionRef &&
        event.decisionExecutionRef === evidence.executionRef
      );
    return false;
  };
  if (
    !rows.length ||
    rows.some(
      (row, index) =>
        !Number.isSafeInteger(row?.seq) ||
        row.seq !== index + 1 ||
        !time(row?.ts) ||
        (index > 0 && Date.parse(row.ts) < Date.parse(rows[index - 1].ts)) ||
        !belongsToRun(row.event),
    )
  )
    invalid("MODERATION_RECOVERY_TRACE_GAP");
  const events = rows.map((row) => row?.event);
  const run = events.filter((event) => event?.runId === evidence.runId);
  const received = run.filter((event) => event.type === "message_received");
  const finished = run.filter((event) => event.type === "run_finished");
  const sessions = run.filter((event) => event.type === "session_start");
  const calls = run.filter((event) => event.type === "tool_call");
  const results = run.filter((event) => event.type === "tool_result");
  const inputs = run.filter((event) => event.type === "qq_tool_execution_input_verified");
  const preconditions = run.filter(
    (event) => event.type === "native_mute_state_precondition_verified",
  );
  if (
    received.length !== 1 ||
    finished.length !== 1 ||
    sessions.length < 1 ||
    calls.length !== 1 ||
    results.length !== 1 ||
    inputs.length !== 0 ||
    preconditions.length !== 0
  )
    invalid("MODERATION_RECOVERY_TRACE");
  const receivedEvent = received[0];
  const finishedEvent = finished[0];
  const terminalRow = rows.find((row) => row.event === finishedEvent);
  if (
    receivedEvent.externalId !== c.inputBinding.botMessageId ||
    receivedEvent.textSha256 !== c.inputBinding.textSha256 ||
    receivedEvent.textBytes !== Buffer.byteLength(c.prompt, "utf8") ||
    receivedEvent.conversationId !== evidence.conversationId ||
    finishedEvent.status !== "failed" ||
    finishedEvent.failureCode !== "required_action_not_completed" ||
    terminalRow.seq >= rows.at(-1).seq
  )
    invalid("MODERATION_RECOVERY_TRACE_TERMINAL");
  const call = calls[0];
  const result = results[0];
  const callRow = rows.find((row) => row.event === call);
  const resultRow = rows.find((row) => row.event === result);
  const input = call.data?.input;
  const output = result.data?.outputHead;
  const inputJson = input && typeof input === "object" ? stable(input) : "";
  const inputBytes = Buffer.byteLength(inputJson, "utf8");
  const callAt = Date.parse(callRow?.ts ?? "");
  const resultAt = Date.parse(resultRow?.ts ?? "");
  if (
    typeof call.toolCallId !== "string" ||
    !call.toolCallId ||
    call.principalId !== evidence.principalId ||
    call.data?.runId !== evidence.runId ||
    call.data?.principalId !== evidence.principalId ||
    call.data?.toolCallId !== call.toolCallId ||
    call.data?.name !== "qq_group_moderation" ||
    !exact(input, ["groupId", "operation"]) ||
    input.groupId !== MODERATION_GROUP_B_ID ||
    input.operation !== "set_group_ban" ||
    result.principalId !== evidence.principalId ||
    result.toolCallId !== call.toolCallId ||
    result.data?.runId !== evidence.runId ||
    result.data?.principalId !== evidence.principalId ||
    result.data?.toolCallId !== call.toolCallId ||
    result.data?.name !== "qq_group_moderation" ||
    result.data?.isError !== true ||
    result.data?.failureCode !== "tool_execution_failed" ||
    result.data?.outputTruncated !== false ||
    typeof output !== "string" ||
    !output.includes("mutation_not_requested") ||
    result.data.outputBytes !== EXPECTED_MUTATION_REFUSAL.bytes ||
    result.data.outputSha256 !== EXPECTED_MUTATION_REFUSAL.sha256 ||
    result.data.outputBytes !== Buffer.byteLength(output, "utf8") ||
    sha(Buffer.from(output, "utf8")) !== result.data.outputSha256 ||
    !time(callRow?.ts) ||
    !time(resultRow?.ts) ||
    !(callAt < resultAt) ||
    !Number.isSafeInteger(callRow?.seq) ||
    !Number.isSafeInteger(resultRow?.seq) ||
    !(callRow.seq < resultRow.seq) ||
    sessions.some((event) => {
      const lease = event.data?.acceptanceLease;
      return (
        event.principalId !== evidence.principalId ||
        event.data?.runId !== evidence.runId ||
        event.data?.principalId !== evidence.principalId ||
        event.data?.conversationId !== evidence.conversationId ||
        lease?.leaseId !== c.acceptanceLease.leaseId ||
        lease?.marker !== c.token ||
        lease?.toolsSha256 !== c.acceptanceLease.toolsSha256 ||
        !isDeepStrictEqual(lease?.narrowedTools, ["qq_group_moderation"]) ||
        !isDeepStrictEqual(event.data?.authorizedTools, ["qq_group_moderation"])
      );
    })
  )
    invalid("MODERATION_RECOVERY_TRACE");
  const sent = run.filter((event) => event.type === "delivery_changed" && event.status === "sent");
  if (
    sent.length !== 1 ||
    sent[0].deliveryId !== evidence.delivery.id ||
    String(sent[0].externalId) !== String(evidence.delivery.external_id)
  )
    invalid("MODERATION_RECOVERY_DELIVERY");
  return {
    runId: evidence.runId,
    principalId: evidence.principalId,
    conversationId: evidence.conversationId,
    toolCallId: call.toolCallId,
    toolName: "qq_group_moderation",
    recordedInput: { groupId: input.groupId, operation: input.operation },
    recordedInputSha256: digest(Buffer.from(inputJson, "utf8")),
    recordedInputBytes: inputBytes,
    receivedMessageId: receivedEvent.externalId,
    terminalTraceSequence: terminalRow.seq,
    traceEventCount: rows.length,
    traceFirstSequence: rows[0].seq,
    traceLastSequence: rows.at(-1).seq,
    traceComplete: true,
    calledParamsUnrecorded: true,
    resultFailureCode: "tool_execution_failed",
    mutationFailureCodeObserved: "mutation_not_requested",
    resultOutputSha256: result.data.outputSha256,
    resultOutputBytes: result.data.outputBytes,
    callTraceSequence: callRow.seq,
    resultTraceSequence: resultRow.seq,
    executeProviderCallEntered: true,
    mutationIntentRejectedBeforeOptionsInvoke: true,
    optionsInvokeReached: false,
    inputWitnessCount: 0,
    nativePreconditionCount: 0,
  };
}

async function readCurrentNative(config, clients) {
  const groupId = MODERATION_GROUP_B_ID;
  const targetId = config.moderation.target;
  const params = { group_id: Number(groupId), user_id: Number(targetId), no_cache: true };
  const [bot, driver] = await Promise.all([
    clients?.bot?.call("get_group_member_info", params),
    clients?.driver?.call("get_group_member_info", params),
  ]);
  const normalize = (row, account) => {
    if (
      String(row?.group_id) !== groupId ||
      String(row?.user_id) !== targetId ||
      row?.role !== "member"
    )
      invalid("MODERATION_RECOVERY_NATIVE_STATE");
    let mute;
    try {
      mute = muteUntil(row);
    } catch {
      invalid("MODERATION_RECOVERY_NATIVE_STATE");
    }
    return { account, groupId, targetId, role: row.role, muteUntil: mute };
  };
  return { bot: normalize(bot, "bot"), driver: normalize(driver, "driver") };
}

async function readFailedRun(db, c, config, baseline) {
  const scope = scopeFor(config);
  const key = scopeKey(scope);
  const matches = db
    .prepare(
      "SELECT r.id,r.conversation_id,r.message_id,r.principal_id,r.scope_json,r.execution_ref,r.status,r.failure_code,r.created_at,m.external_id,m.scope_key,m.text,m.created_at AS message_created_at FROM runs r JOIN messages m ON m.id=r.message_id WHERE m.external_id=? AND m.scope_key=?",
    )
    .all(c.inputBinding.botMessageId, key);
  const sourceMessages = db
    .prepare(
      "SELECT id,external_id,scope_key,text,created_at FROM messages WHERE external_id=? AND scope_key=?",
    )
    .all(c.inputBinding.botMessageId, key);
  if (
    matches.length !== 1 ||
    sourceMessages.length !== 1 ||
    matches[0].status !== "failed" ||
    matches[0].failure_code !== "required_action_not_completed" ||
    matches[0].external_id !== c.inputBinding.botMessageId ||
    matches[0].message_id !== sourceMessages[0].id ||
    matches[0].scope_key !== key ||
    matches[0].text !== c.prompt ||
    digest(matches[0].text) !== c.inputBinding.textSha256 ||
    matches[0].principal_id !== baseline.principalId ||
    !UUID.test(matches[0].id ?? "") ||
    !UUID.test(matches[0].conversation_id ?? "") ||
    !time(matches[0].created_at) ||
    Date.parse(matches[0].created_at) < Date.parse(c.startedAt) - 2000 ||
    !time(matches[0].message_created_at) ||
    !same(JSON.parse(matches[0].scope_json), scope)
  )
    invalid("MODERATION_RECOVERY_RUN");
  const decisions = db
    .prepare(
      "SELECT id,principal_id,resource_id,action,scope_key,decision,reason,grant_id FROM authorization_decisions_all WHERE run_id=? AND action='group:moderate' ORDER BY id",
    )
    .all(matches[0].id);
  if (
    decisions.length !== 2 ||
    decisions.some(
      (row) =>
        row.principal_id !== matches[0].principal_id ||
        row.resource_id !== `group:${MODERATION_GROUP_B_ID}` ||
        row.action !== "group:moderate" ||
        row.scope_key !== key ||
        row.decision !== "ALLOW" ||
        row.reason !== "explicit_grant" ||
        row.grant_id !== baseline.grantId,
    )
  )
    invalid("MODERATION_RECOVERY_AUTHORIZATION");
  const deliveries = db
    .prepare(
      "SELECT id,status,external_id,destination_scope_key,payload_text,payload_kind,created_at,updated_at FROM deliveries WHERE run_id=? ORDER BY id",
    )
    .all(matches[0].id);
  if (
    deliveries.length !== 1 ||
    deliveries[0].status !== "sent" ||
    !ID.test(String(deliveries[0].external_id)) ||
    deliveries[0].destination_scope_key !== key
  )
    invalid("MODERATION_RECOVERY_DELIVERY");
  const reply = c.replies[0];
  const delivery = deliveries[0];
  // Outgoing replies live in deliveries; messages stores incoming channel events.
  // Account-local OneBot message IDs also differ between Bot and Owner.
  if (
    delivery.payload_kind !== "result" ||
    typeof delivery.payload_text !== "string" ||
    digest(delivery.payload_text) !== reply.textSha256 ||
    Buffer.byteLength(delivery.payload_text, "utf8") !== reply.textBytes ||
    !time(delivery.created_at) ||
    !time(delivery.updated_at) ||
    !time(reply.receivedAt) ||
    Date.parse(delivery.created_at) < Date.parse(c.startedAt) ||
    Date.parse(delivery.updated_at) < Date.parse(delivery.created_at) ||
    Date.parse(delivery.updated_at) > Date.parse(c.finishedAt) ||
    Date.parse(reply.receivedAt) < Date.parse(delivery.created_at) ||
    Date.parse(reply.receivedAt) > Date.parse(c.finishedAt)
  )
    invalid("MODERATION_RECOVERY_DELIVERY");
  return {
    runId: matches[0].id,
    principalId: matches[0].principal_id,
    conversationId: matches[0].conversation_id,
    scope,
    scopeKey: key,
    status: matches[0].status,
    executionRef: matches[0].execution_ref,
    failureCode: matches[0].failure_code,
    delivery: {
      id: delivery.id,
      status: delivery.status,
      external_id: delivery.external_id,
      destination_scope_key: delivery.destination_scope_key,
      payloadKind: delivery.payload_kind,
      textSha256: digest(delivery.payload_text),
      textBytes: Buffer.byteLength(delivery.payload_text, "utf8"),
      createdAt: delivery.created_at,
      updatedAt: delivery.updated_at,
      observedReplyMessageId: reply.messageId,
      observedReplyReceivedAt: reply.receivedAt,
    },
    authorizationDecisionIds: decisions.map((row) => row.id).sort(),
  };
}

async function verifyStoppedIdentity(identity, verifyStopped) {
  if (!exact(identity, PROCESS_KEYS)) invalid("MODERATION_RECOVERY_PROCESS");
  const result = await verifyStopped(identity);
  if (result?.stopped !== true || !same(result.identity, identity))
    invalid("MODERATION_RECOVERY_PROCESS");
  return { ...identity, stopped: true };
}

async function collectProof({
  reportPath,
  config,
  clients,
  locksDirectory,
  readRuntime,
  readTrace,
  readNativeState,
  verifyStopped,
  pendingSourcePath,
  stopSourcePath,
  lockHeld = false,
}) {
  const p = pathsFor(reportPath, config, locksDirectory);
  await privateDirectory(p.out);
  await privateDirectory(p.reportDirectory);
  await privateDirectory(locksDirectory);
  if (!lockHeld) await absent([p.lockPath, ...p.otherGuards]);
  else await absent(p.otherGuards);
  const [reportFile, stopFile, pendingFile, checkpointFile, attemptFile] = await Promise.all([
    privateFile(p.reportPath, MAX.report),
    privateFile(stopSourcePath ?? p.stopPath, MAX.stop),
    privateFile(pendingSourcePath ?? p.pendingPath, MAX.pending),
    privateFile(p.checkpointPath, MAX.checkpoint),
    privateFile(p.attemptPath, 4096),
  ]);
  verifyModerationRecoveryStop(stopFile.bytes);
  const report = json(reportFile.bytes);
  const pending = json(pendingFile.bytes);
  const attempt = json(attemptFile.bytes);
  verifyModerationAttempt(attempt, report, p.runId);
  if (
    pending.sequence !== 4 ||
    pending.observation?.phase !== "sent" ||
    pending.observation?.stage !== "mute" ||
    !same(pending.identity?.runtime, report.productAcceptance?.runtime) ||
    pending.identity?.reportDirectory !== p.reportDirectory
  )
    invalid("MODERATION_RECOVERY_PENDING");
  const checkpoint = verifyModerationCheckpointChain(checkpointFile.bytes, pending, report, p);
  const reportProof = verifyReport(report, p, pending, config, checkpoint.expectedMuteUntil);
  if (!same(checkpoint.baseline, readModerationPolicyState(config)))
    invalid("MODERATION_RECOVERY_POLICY");
  const runtime = await readRuntime(config.runtime);
  const source = await sourcePin(runtime, config.runtime?.checkout);
  if (
    !same(runtime, report.runtime) ||
    !same(runtime, pending.identity.runtime) ||
    report.suiteSha256 !== pending.identity.suiteSha256 ||
    pending.identity.driverSha256 !== createHash("sha256").update(config.driver.qq).digest("hex")
  )
    invalid("MODERATION_RECOVERY_RUNTIME");
  const process = await verifyStoppedIdentity(pending.identity.processIdentity, verifyStopped);
  let db;
  let evidence;
  try {
    db = openProductEvidenceDatabase(join(runtime.dataDirectory, "glassbox.db"));
    evidence = await readFailedRun(db, reportProof.caseRecord, config, checkpoint.baseline);
    const lease = await verifyCaseLeaseCleanupEvidence(
      db,
      runtime.dataDirectory,
      reportProof.caseRecord,
      evidence,
    );
    if (
      lease?.status !== "PASS" ||
      lease.leaseId !== reportProof.caseRecord.acceptanceLease.leaseId ||
      lease.runId !== evidence.runId ||
      lease.revoked !== true
    )
      invalid("MODERATION_RECOVERY_LEASE");
  } finally {
    db?.close();
  }
  const ownerAuthorization = await verifyModerationAuthorizationEvidence({
    caseRecord: reportProof.caseRecord,
    config,
    clients,
    fixed: reportProof.fixed,
  });
  if (
    ownerAuthorization?.authorizationProof?.basis !== "group-owner-request" ||
    ownerAuthorization.authorizationProof.ownerId !== config.driver.qq ||
    ownerAuthorization.roleProof?.status !== "NATIVE_GROUP_OWNER_VERIFIED"
  )
    invalid("MODERATION_RECOVERY_OWNER_AUTHORIZATION");
  const traceProof = verifyModerationNoEffectTrace(
    await readTrace(runtime, evidence.runId),
    evidence,
    reportProof.caseRecord,
  );
  const native = await readNativeState(config, clients);
  const baselineUntil = checkpoint.expectedMuteUntil;
  if (
    native?.bot?.muteUntil !== baselineUntil ||
    native?.driver?.muteUntil !== baselineUntil ||
    native?.bot?.role !== "member" ||
    native?.driver?.role !== "member" ||
    baselineUntil > Date.now() / 1000 ||
    !same(native.bot, {
      account: "bot",
      groupId: MODERATION_GROUP_B_ID,
      targetId: reportProof.fixed.target,
      role: "member",
      muteUntil: baselineUntil,
    }) ||
    !same(native.driver, {
      account: "driver",
      groupId: MODERATION_GROUP_B_ID,
      targetId: reportProof.fixed.target,
      role: "member",
      muteUntil: baselineUntil,
    })
  )
    invalid("MODERATION_RECOVERY_NATIVE_STATE");
  const proof = {
    source: {
      ...source,
      boundary: "consumeMutationIntent-before-options.invoke",
    },
    inputBinding: {
      driverMessageId: reportProof.caseRecord.inputBinding.driverMessageId,
      botMessageId: reportProof.caseRecord.inputBinding.botMessageId,
      textSha256: reportProof.caseRecord.inputBinding.textSha256,
    },
    run: {
      runId: evidence.runId,
      principalId: evidence.principalId,
      conversationId: evidence.conversationId,
      status: evidence.status,
      failureCode: evidence.failureCode,
      scopeKey: evidence.scopeKey,
    },
    call: traceProof,
    lease: {
      leaseId: reportProof.caseRecord.acceptanceLease.leaseId,
      marker: reportProof.caseRecord.token,
      toolsSha256: reportProof.caseRecord.acceptanceLease.toolsSha256,
      revoked: true,
    },
    delivery: {
      status: evidence.delivery.status,
      botMessageId: String(evidence.delivery.external_id),
      ownerReplyMessageId: reportProof.caseRecord.replies[0].messageId,
      replySha256: reportProof.caseRecord.replies[0].textSha256,
      replyBytes: reportProof.caseRecord.replies[0].textBytes,
    },
    baseline: {
      groupId: MODERATION_GROUP_B_ID,
      targetId: reportProof.fixed.target,
      muteUntil: baselineUntil,
      policyVersion: checkpoint.baseline.policyVersion,
      grantId: checkpoint.baseline.grantId,
    },
    nativeCurrent: native,
    process,
    authorizationDecisionIds: evidence.authorizationDecisionIds,
  };
  return {
    paths: p,
    report,
    pending,
    checkpoint,
    runtime,
    proof,
    files: {
      report: reportFile,
      stop: stopFile,
      pending: pendingFile,
      checkpoint: checkpointFile,
      attempt: attemptFile,
    },
  };
}

function buildPlan(v) {
  const p = v.paths;
  return {
    schemaVersion: 1,
    kind: "qq-live-moderation-known-no-effect-recovery",
    proofKind: "fixed-moderation-known-no-effect-v1",
    reportPath: p.reportPath,
    reportSha256: v.files.report.sha256,
    reportFingerprint: v.files.report.fingerprint,
    attemptSha256: v.files.attempt.sha256,
    checkpointPath: p.checkpointPath,
    checkpointSha256: v.files.checkpoint.sha256,
    checkpointFingerprint: v.files.checkpoint.fingerprint,
    pendingPath: p.pendingPath,
    pendingSha256: v.files.pending.sha256,
    pendingFingerprint: v.files.pending.fingerprint,
    stopPath: p.stopPath,
    stopSha256: v.files.stop.sha256,
    stopFingerprint: v.files.stop.fingerprint,
    locksDirectory: dirname(p.lockPath),
    lockPath: p.lockPath,
    archiveDirectory: p.archiveDirectory,
    archivedPendingPath: join(p.archiveDirectory, "moderation-pending.json"),
    archivedStopPath: join(p.archiveDirectory, "STOP"),
    runId: p.runId,
    suiteSha256: v.report.suiteSha256,
    driverSha256: v.pending.identity.driverSha256,
    runtime: v.runtime,
    processIdentity: v.pending.identity.processIdentity,
    caseId: "moderation-mute",
    caseOutcome: "FAIL",
    caseCode: "REPLY_ASSERTION_FAILED",
    productRunId: v.proof.run.runId,
    productRunStatus: "failed",
    productRunFailureCode: "required_action_not_completed",
    leaseId: v.proof.lease.leaseId,
    marker: v.proof.lease.marker,
    toolsSha256: v.proof.lease.toolsSha256,
    proof: v.proof,
    proofSha256: digest(stable(v.proof)),
    cleanupOnly: true,
    featurePass: false,
    featureStatus: "INCONCLUSIVE",
  };
}

function depsFor(deps) {
  return {
    readRuntime: deps.readRuntime ?? runtimeSnapshot,
    readTrace:
      deps.readTrace ??
      ((runtime, runId) =>
        JSON.parse(
          (deps.capture ?? execFileSync)(
            process.execPath,
            [
              join(runtime.checkout, ".agents/skills/glassbox-ops/scripts/gbxtrace.mjs"),
              "events",
              runId,
              "--json",
              "--data-dir",
              join(runtime.dataDirectory, "runs"),
            ],
            {
              encoding: "utf8",
              timeout: 10000,
              maxBuffer: 4 * 1024 * 1024,
              stdio: ["ignore", "pipe", "pipe"],
            },
          ),
        )),
    readNativeState: deps.readNativeState ?? readCurrentNative,
    verifyStopped: deps.verifyStopped ?? verifyMemoryProcessStopped,
  };
}

export async function planModerationKnownNoEffectRecovery(
  { reportPath, config, clients, locksDirectory = join(homedir(), ".glassbox-qq-live-locks") } = {},
  dependencies = {},
) {
  const deps = depsFor(dependencies);
  const v = await collectProof({
    reportPath,
    config,
    clients,
    locksDirectory: resolve(locksDirectory),
    ...deps,
  });
  try {
    await lstat(v.paths.archiveDirectory);
    invalid("MODERATION_RECOVERY_ARCHIVE_EXISTS");
  } catch (error) {
    if (String(error?.code).startsWith("MODERATION_")) throw error;
    if (error?.code !== "ENOENT") throw error;
  }
  const plan = buildPlan(v);
  return {
    status: "MODERATION_KNOWN_NO_EFFECT_RECOVERY_PLANNED",
    plan,
    planSha256: digest(JSON.stringify(plan)),
  };
}

function validatePlan(plan, planSha256, approvedPlanSha256, locksDirectory) {
  if (
    !plan ||
    plan.kind !== "qq-live-moderation-known-no-effect-recovery" ||
    plan.proofKind !== "fixed-moderation-known-no-effect-v1" ||
    digest(JSON.stringify(plan)) !== planSha256 ||
    approvedPlanSha256 !== planSha256 ||
    resolve(locksDirectory) !== plan.locksDirectory ||
    plan.caseId !== "moderation-mute" ||
    plan.caseOutcome !== "FAIL" ||
    plan.caseCode !== "REPLY_ASSERTION_FAILED" ||
    plan.productRunStatus !== "failed" ||
    plan.productRunFailureCode !== "required_action_not_completed" ||
    !UUID.test(plan.productRunId ?? "") ||
    plan.cleanupOnly !== true ||
    plan.featurePass !== false ||
    plan.featureStatus !== "INCONCLUSIVE" ||
    plan.proof?.call?.calledParamsUnrecorded !== true ||
    plan.proof?.call?.executeProviderCallEntered !== true ||
    plan.proof?.call?.optionsInvokeReached !== false ||
    plan.proof?.call?.mutationIntentRejectedBeforeOptionsInvoke !== true ||
    plan.proofSha256 !== digest(stable(plan.proof))
  )
    invalid("MODERATION_RECOVERY_APPROVAL");
}
async function syncDirectory(path) {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
async function acquireLock(path) {
  let handle;
  try {
    handle = await open(path, "wx", 0o600);
  } catch {
    invalid("MODERATION_RECOVERY_LOCKED");
  }
  await handle.writeFile(
    JSON.stringify({
      pid: process.pid,
      startedAt: new Date().toISOString(),
      action: "moderation-known-no-effect-archive",
    }),
  );
  await handle.sync();
  return handle;
}

function sameArchivedPlan(observed, original) {
  // Renaming the two verified files may advance ctime. All other file identity,
  // content and product proof fields must still match the approved plan.
  const normalized = { ...observed };
  for (const field of ["pendingFingerprint", "stopFingerprint"]) {
    const before = original[field];
    const after = observed[field];
    if (!Number.isFinite(after?.ctimeMs) || after.ctimeMs < before.ctimeMs) return false;
    normalized[field] = { ...after, ctimeMs: before.ctimeMs };
  }
  return same(normalized, original);
}

/** Archive only the pinned moderation guard and STOP after a second independent proof. */
export async function archiveModerationKnownNoEffectRecovery(
  { plan, planSha256 },
  {
    config,
    clients,
    approvedPlanSha256,
    locksDirectory = join(homedir(), ".glassbox-qq-live-locks"),
  } = {},
  dependencies = {},
) {
  validatePlan(plan, planSha256, approvedPlanSha256, locksDirectory);
  const deps = depsFor(dependencies);
  const lockRoot = resolve(locksDirectory);
  const first = await collectProof({
    reportPath: plan.reportPath,
    config,
    clients,
    locksDirectory: lockRoot,
    ...deps,
  });
  if (!same(buildPlan(first), plan)) invalid("MODERATION_RECOVERY_PLAN_CHANGED");
  await absent([plan.lockPath, ...first.paths.otherGuards]);
  try {
    await lstat(plan.archiveDirectory);
    invalid("MODERATION_RECOVERY_ARCHIVE_EXISTS");
  } catch (error) {
    if (String(error?.code).startsWith("MODERATION_")) throw error;
    if (error?.code !== "ENOENT") throw error;
  }
  await privateDirectory(lockRoot);
  const lock = await acquireLock(plan.lockPath);
  let moved = 0;
  let success = false;
  try {
    await syncDirectory(lockRoot);
    const lockedProof = await collectProof({
      reportPath: plan.reportPath,
      config,
      clients,
      locksDirectory: lockRoot,
      ...deps,
      lockHeld: true,
    });
    if (!same(buildPlan(lockedProof), plan)) invalid("MODERATION_RECOVERY_PLAN_CHANGED");
    const archiveRoot = dirname(plan.archiveDirectory);
    try {
      await privateDirectory(archiveRoot);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      await mkdir(archiveRoot, { mode: 0o700 });
      await syncDirectory(dirname(archiveRoot));
    }
    await privateDirectory(archiveRoot);
    await mkdir(plan.archiveDirectory, { mode: 0o700 });
    await syncDirectory(archiveRoot);
    await writeDurableReport(join(plan.archiveDirectory, "intent.json"), {
      schemaVersion: 1,
      kind: "qq-live-moderation-known-no-effect-recovery-intent",
      status: "ARCHIVE_INTENT",
      plan,
      planSha256,
    });
    const pendingNow = await privateFile(plan.pendingPath, MAX.pending);
    if (
      pendingNow.sha256 !== plan.pendingSha256 ||
      !same(pendingNow.fingerprint, plan.pendingFingerprint)
    )
      invalid("MODERATION_RECOVERY_CHANGED");
    await rename(plan.pendingPath, plan.archivedPendingPath);
    moved += 1;
    await syncDirectory(lockRoot);
    await syncDirectory(plan.archiveDirectory);
    const stopNow = await privateFile(plan.stopPath, MAX.stop);
    if (stopNow.sha256 !== plan.stopSha256 || !same(stopNow.fingerprint, plan.stopFingerprint))
      invalid("MODERATION_RECOVERY_CHANGED");
    await rename(plan.stopPath, plan.archivedStopPath);
    moved += 1;
    await syncDirectory(dirname(plan.stopPath));
    await syncDirectory(plan.archiveDirectory);

    const archivedProof = await collectProof({
      reportPath: plan.reportPath,
      config,
      clients,
      locksDirectory: lockRoot,
      ...deps,
      pendingSourcePath: plan.archivedPendingPath,
      stopSourcePath: plan.archivedStopPath,
      lockHeld: true,
    });
    if (!sameArchivedPlan(buildPlan(archivedProof), plan))
      invalid("MODERATION_RECOVERY_FINAL_RECHECK");
    await absent([plan.pendingPath, plan.stopPath]);
    const receipt = {
      schemaVersion: 1,
      kind: "qq-live-moderation-known-no-effect-recovery-receipt",
      status: "MODERATION_KNOWN_NO_EFFECT_ARCHIVE_VERIFIED",
      proofKind: plan.proofKind,
      plan,
      planSha256,
      archivedPendingSha256: plan.pendingSha256,
      archivedStopSha256: plan.stopSha256,
      cleanupVerified: true,
      cleanupOnly: true,
      featurePass: false,
      featureStatus: "INCONCLUSIVE",
      caseOutcome: "FAIL",
      productRunObserved: true,
      productRunId: plan.productRunId,
      productRunStatus: "failed",
      productRunFailureCode: "required_action_not_completed",
      calledParamsUnrecorded: true,
      noModerationEffectVerified: true,
      proof: plan.proof,
      proofSha256: plan.proofSha256,
    };
    const receiptPath = join(plan.archiveDirectory, "receipt.json");
    await writeDurableReport(receiptPath, receipt);
    const saved = await privateFile(receiptPath, MAX.report);
    if (saved.sha256 !== sha(Buffer.from(JSON.stringify(receipt, null, 2) + "\n", "utf8")))
      invalid("MODERATION_RECOVERY_RECEIPT");
    await lock.close();
    await unlink(plan.lockPath);
    await syncDirectory(lockRoot);
    success = true;
    return receipt;
  } catch (error) {
    if (moved > 0) success = false;
    throw error;
  } finally {
    if (!lock.closed) await lock.close().catch(() => {});
    if (moved === 0 || success) await unlink(plan.lockPath).catch(() => {});
  }
}
