import { fail, digest, toolManifestDigest } from "./core.mjs";
import { memoryFixtureStep } from "./memory-scenario.mjs";
import {
  discoverFeedbackCandidate,
  discoverPromotedMemory,
  verifyMemoryCleanup,
} from "./memory-fixture.mjs";

const ID = /^[A-Za-z0-9_-]{1,128}$/;
const MARKER = /^[a-f0-9]{32}$/;
const HASH = /^[a-f0-9]{64}$/;
const PROJECT = /^qqtest-([a-f0-9]{32})$/;
const TERMINAL = new Set(["succeeded", "failed", "interrupted", "cancelled"]);
const STAGES = new Set(["feedback", "promote", "expire", "reject"]);

function inconclusive(code, handles = {}) {
  return { status: "INCONCLUSIVE", code, handles: safeHandles(handles) };
}

function safeHandles(handles = {}) {
  const result = {};
  for (const key of [
    "projectId",
    "principalId",
    "candidateId",
    "memoryId",
    "creationRunId",
    "promoteRunId",
    "cleanupRunId",
    "stepRunId",
  ])
    if (typeof handles?.[key] === "string" && ID.test(handles[key])) result[key] = handles[key];
  return result;
}

function plainRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parsedJson(value) {
  if (typeof value !== "string") return null;
  try {
    const parsed = JSON.parse(value);
    return plainRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function equalJson(a, b) {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b))
    return a.length === b.length && a.every((value, index) => equalJson(value, b[index]));
  if (!plainRecord(a) || !plainRecord(b)) return false;
  const ak = Object.keys(a).sort();
  const bk = Object.keys(b).sort();
  return (
    ak.length === bk.length &&
    ak.every((key, index) => key === bk[index] && equalJson(a[key], b[key]))
  );
}

function scopeHash(scope) {
  return digest(
    JSON.stringify([
      scope.connectionId,
      scope.botId,
      scope.chatType,
      scope.chatId,
      scope.senderId,
      scope.threadId ?? null,
    ]),
  );
}

function checkpointRows(record) {
  if (!plainRecord(record) || !Array.isArray(record.rows) || !plainRecord(record.pending))
    fail("MEMORY_RECOVERY_RECORD", "Recovery checkpoint record is incomplete.", "INCONCLUSIVE");
  if (!Number.isSafeInteger(record.confirmedSequence) || record.confirmedSequence < 1)
    fail("MEMORY_RECOVERY_RECORD", "Recovery checkpoint sequence is invalid.", "INCONCLUSIVE");
  const rows = record.rows.filter(
    (row) =>
      plainRecord(row) &&
      Number.isSafeInteger(row.sequence) &&
      row.sequence <= record.confirmedSequence,
  );
  const pending = record.pending;
  if (
    pending.runId !== record.runId ||
    pending.reportDirectory !== record.reportDirectory ||
    !equalJson(pending.origin, record.origin) ||
    rows.some(
      (row) =>
        row.runId !== record.runId ||
        row.reportDirectory !== record.reportDirectory ||
        !equalJson(row.origin, record.origin),
    ) ||
    pending.schemaVersion !== 2 ||
    !Number.isSafeInteger(pending.sequence) ||
    pending.sequence > record.confirmedSequence ||
    !HASH.test(pending.checkpointSha256 ?? "") ||
    !rows.some(
      (row) =>
        row.sequence === pending.sequence && row.checkpointSha256 === pending.checkpointSha256,
    )
  )
    fail(
      "MEMORY_RECOVERY_RECORD",
      "Pending guard is not present in the confirmed journal.",
      "INCONCLUSIVE",
    );
  return { rows, pending };
}

function fixtureContext(record, rows) {
  const origin = record.origin;
  const scope = origin?.scope;
  const scopeFields = ["connectionId", "botId", "chatId", "senderId"];
  if (
    !plainRecord(origin) ||
    !plainRecord(scope) ||
    scopeFields.some((key) => typeof scope[key] !== "string" || !ID.test(scope[key])) ||
    scope.chatType !== "private" ||
    (scope.threadId !== null && scope.threadId !== undefined && !ID.test(scope.threadId)) ||
    origin.driverSha256 !== digest(scope.chatId) ||
    !/^[a-f0-9]{40}$/.test(origin.runtime?.commit ?? "")
  )
    fail(
      "MEMORY_RECOVERY_ORIGIN",
      "Recovery origin is not a fixed private Owner fixture.",
      "INCONCLUSIVE",
    );
  const projects = new Set();
  for (const row of rows) {
    const projectId = row.handles?.projectId;
    if (typeof projectId === "string") projects.add(projectId);
  }
  const match = [...projects].map((projectId) => PROJECT.exec(projectId)).filter(Boolean);
  if (projects.size !== 1 || match.length !== 1)
    fail(
      "MEMORY_RECOVERY_PROJECT",
      "Recovery project cannot be uniquely bound to its fixture.",
      "INCONCLUSIVE",
    );
  return { scope, projectId: [...projects][0], fixtureNonce: match[0][1] };
}

function checkpointAttempts(rows, fixtureNonce) {
  const attempts = new Map();
  const add = (key, stage, phase, preparedCase, sentCase, handles, attemptId) => {
    if (!STAGES.has(stage) || !["lease_intent", "prepared", "sent"].includes(phase)) return;
    if (!plainRecord(preparedCase) || !MARKER.test(preparedCase.marker ?? ""))
      fail("MEMORY_RECOVERY_MARKER", "Checkpoint marker is missing or malformed.", "INCONCLUSIVE");
    const spec = memoryFixtureStep(stage, {
      nonce: fixtureNonce,
      candidateId: handles?.candidateId,
      memoryId: handles?.memoryId,
    });
    const marker = preparedCase.marker;
    const prompt = `GLASSBOX_ACCEPTANCE_V1 ${marker}\n${spec.prompt.replaceAll("{{nonce}}", marker)}`;
    const tools = JSON.parse(JSON.stringify(spec.leaseTools).replaceAll("{{nonce}}", marker));
    if (
      ["prepared", "sent"].includes(phase) &&
      (!ID.test(preparedCase.leaseId ?? "") ||
        !HASH.test(preparedCase.toolsSha256 ?? "") ||
        !Number.isSafeInteger(preparedCase.expiresAt))
    )
      fail("MEMORY_RECOVERY_CHECKPOINT", "Prepared lease metadata is incomplete.", "INCONCLUSIVE");
    if (
      phase === "sent" &&
      (!plainRecord(sentCase) || !/^\d{1,20}$/.test(String(sentCase.driverMessageId ?? "")))
    )
      fail(
        "MEMORY_RECOVERY_CHECKPOINT",
        "Sent checkpoint lacks the driver message receipt.",
        "INCONCLUSIVE",
      );
    const expected = {
      stage,
      attemptId,
      marker,
      caseId: spec.id,
      textSha256: digest(prompt),
      expectedToolsSha256: toolManifestDigest(tools),
      toolsSha256: toolManifestDigest(tools),
      sentMessageId: sentCase?.driverMessageId,
      leaseId: phase === "lease_intent" ? undefined : (sentCase?.leaseId ?? handles?.leaseId),
      tools,
      toolNames: tools.map((tool) => tool.name),
      projectId: `qqtest-${fixtureNonce}`,
      handles: safeHandles(handles),
    };
    if (
      preparedCase.caseId !== expected.caseId ||
      preparedCase.route !== "private" ||
      preparedCase.textSha256 !== expected.textSha256 ||
      (preparedCase.toolsSha256 !== undefined &&
        preparedCase.toolsSha256 !== expected.expectedToolsSha256)
    )
      fail(
        "MEMORY_RECOVERY_BUILDER",
        "Checkpoint does not match the fixed Memory scenario builder.",
        "INCONCLUSIVE",
      );
    const current = attempts.get(key);
    if (current && (current.marker !== marker || current.textSha256 !== expected.textSha256))
      fail(
        "MEMORY_RECOVERY_MARKER",
        "A lifecycle stage contains conflicting message markers.",
        "INCONCLUSIVE",
      );
    const item = current ?? expected;
    if (
      current &&
      (current.stage !== stage ||
        (current.leaseId && preparedCase.leaseId && current.leaseId !== preparedCase.leaseId) ||
        (current.toolsSha256 &&
          preparedCase.toolsSha256 &&
          current.toolsSha256 !== preparedCase.toolsSha256) ||
        (current.sentMessageId &&
          sentCase?.driverMessageId &&
          current.sentMessageId !== sentCase.driverMessageId))
    )
      fail(
        "MEMORY_RECOVERY_CHECKPOINT",
        "Checkpoint rows conflict on stage, lease or receipt.",
        "INCONCLUSIVE",
      );
    if (current) {
      for (const handle of [
        "principalId",
        "candidateId",
        "memoryId",
        "creationRunId",
        "promoteRunId",
      ]) {
        if (
          current.handles?.[handle] !== undefined &&
          expected.handles?.[handle] !== undefined &&
          current.handles[handle] !== expected.handles[handle]
        )
          fail(
            "MEMORY_RECOVERY_HANDLES",
            "Checkpoint attempt rows conflict on a resource handle.",
            "INCONCLUSIVE",
          );
      }
    }
    item.phases ??= new Set();
    item.phases.add(phase);
    if (phase === "prepared") {
      item.leaseId = sentCase?.leaseId ?? handles?.leaseId ?? preparedCase.leaseId;
      item.toolsSha256 = preparedCase.toolsSha256;
    }
    if (phase === "sent") {
      item.leaseId = sentCase?.leaseId ?? item.leaseId;
      item.toolsSha256 = preparedCase.toolsSha256 ?? item.toolsSha256;
      item.sentMessageId = sentCase?.driverMessageId;
    }
    item.handles = { ...current?.handles, ...expected.handles };
    attempts.set(key, item);
  };
  for (const row of rows) {
    add(
      `main:${row.stage}`,
      row.stage,
      row.phase,
      row.preparedCase,
      row.sentCase,
      row.handles,
      undefined,
    );
    const recovery = row.recoveryAttempt;
    if (plainRecord(recovery)) {
      const recoveryHandles = validatedRecoveryHandles(
        recovery.stage,
        row.handles,
        recovery.handles,
        fixtureNonce,
      );
      add(
        `recovery:${recovery.attemptId}`,
        recovery.stage,
        recovery.phase,
        recovery.preparedCase,
        recovery.sentCase,
        recoveryHandles,
        recovery.attemptId,
      );
    }
  }
  if (!attempts.size)
    fail(
      "MEMORY_RECOVERY_NO_ATTEMPT",
      "No lease intent or sent Memory step is recorded.",
      "INCONCLUSIVE",
    );
  return [...attempts.values()];
}

function validatedRecoveryHandles(stage, sourceHandles, recoveryHandles, fixtureNonce) {
  const keys = [
    "fixtureNonce",
    "projectId",
    "principalId",
    "candidateId",
    "creationRunId",
    "promoteRunId",
    "memoryId",
  ];
  if (
    !plainRecord(recoveryHandles) ||
    Object.keys(recoveryHandles).some((key) => !keys.includes(key)) ||
    !MARKER.test(recoveryHandles.fixtureNonce ?? "") ||
    recoveryHandles.fixtureNonce !== fixtureNonce ||
    !PROJECT.test(recoveryHandles.projectId ?? "") ||
    recoveryHandles.fixtureNonce !== recoveryHandles.projectId.slice("qqtest-".length) ||
    !ID.test(recoveryHandles.principalId ?? "") ||
    !/^candidate_[a-f0-9]{32}$/.test(recoveryHandles.candidateId ?? "") ||
    !ID.test(recoveryHandles.creationRunId ?? "") ||
    (stage === "reject"
      ? recoveryHandles.memoryId !== undefined || recoveryHandles.promoteRunId !== undefined
      : stage !== "expire" ||
        !/^memory_[a-f0-9]{32}$/.test(recoveryHandles.memoryId ?? "") ||
        !ID.test(recoveryHandles.promoteRunId ?? ""))
  )
    fail(
      "MEMORY_RECOVERY_HANDLES",
      "Recovery attempt target handles are incomplete or invalid.",
      "INCONCLUSIVE",
    );
  for (const key of keys) {
    if (sourceHandles?.[key] !== undefined && sourceHandles[key] !== recoveryHandles[key])
      fail(
        "MEMORY_RECOVERY_HANDLES",
        "Recovery attempt target conflicts with known source handles.",
        "INCONCLUSIVE",
      );
  }
  return safeHandles(recoveryHandles);
}

function eventList(eventsByRun, runId) {
  const value = eventsByRun instanceof Map ? eventsByRun.get(runId) : eventsByRun?.[runId];
  if (!Array.isArray(value))
    fail("MEMORY_RECOVERY_TRACE", "A bound Run has no supplied Raw Trace events.", "INCONCLUSIVE");
  return value.map((row) => (plainRecord(row?.event) ? row.event : row));
}

function expectedToolInput(attempt) {
  const operation = attempt.tools[0]?.operations?.[0];
  return operation?.inputConstraint;
}

function verifyTrace(runId, runRow, trace, binding, attempt, expectedScope) {
  const own = trace.filter((event) => event?.runId === runId);
  const received = own.filter((event) => event.type === "message_received");
  if (
    received.length !== 1 ||
    String(received[0].externalId) !== String(binding.messageId) ||
    received[0].textSha256 !== attempt.textSha256 ||
    received[0].connectionId !== expectedScope.connectionId ||
    received[0].botId !== expectedScope.botId ||
    received[0].chatType !== "private" ||
    received[0].chatId !== expectedScope.chatId ||
    received[0].senderId !== expectedScope.senderId ||
    (received[0].threadId ?? null) !== (expectedScope.threadId ?? null)
  )
    fail(
      "MEMORY_RECOVERY_TRACE",
      "Run trace does not bind to the exact private fixture input.",
      "INCONCLUSIVE",
    );
  const finished = own.filter((event) => event.type === "run_finished");
  if (finished.length !== 1 || finished[0].status !== runRow.status || !TERMINAL.has(runRow.status))
    fail(
      "MEMORY_RECOVERY_TERMINAL",
      "The bound Run is not terminal in both state and Raw Trace.",
      "INCONCLUSIVE",
    );
  const calls = own.filter((event) => event.type === "tool_call");
  const results = own.filter((event) => event.type === "tool_result");
  if (!calls.length && !results.length) return { hadToolCall: false };
  const sessions = own.filter((event) => event.type === "session_start");
  if (calls.length !== 1 || results.length !== 1 || sessions.length !== 1)
    fail(
      "MEMORY_RECOVERY_TOOLS",
      "Run trace contains missing, multiple, or unknown tool calls.",
      "INCONCLUSIVE",
    );
  const call = calls[0];
  const result = results[0];
  const sessionLease = sessions[0].data?.acceptanceLease;
  const names = attempt.toolNames;
  if (
    names.length !== 1 ||
    names[0] !== "owner_memory_admin" ||
    call.data?.name !== names[0] ||
    result.data?.name !== names[0] ||
    !call.toolCallId ||
    call.toolCallId !== result.toolCallId ||
    call.data?.toolCallId !== call.toolCallId ||
    result.data?.toolCallId !== result.toolCallId ||
    !equalJson(call.data?.input, expectedToolInput(attempt)) ||
    sessionLease?.marker !== attempt.marker ||
    sessionLease?.leaseId !== binding.leaseId ||
    sessionLease?.toolsSha256 !== attempt.toolsSha256 ||
    !equalJson(sessionLease?.narrowedTools, names) ||
    !equalJson(sessions[0].data?.authorizedTools, names)
  )
    fail(
      "MEMORY_RECOVERY_TOOLS",
      "Run tool evidence does not match the fixed leased operation.",
      "INCONCLUSIVE",
    );
  return { hadToolCall: true };
}

function getRun(db, runId) {
  return db
    .prepare(
      `SELECT r.id AS runId, r.principal_id AS principalId, p.kind AS principalKind,
              r.status AS status, r.scope_json AS scopeJson, r.message_id AS messageId,
              m.external_id AS externalId, m.scope_key AS scopeKey
       FROM runs r JOIN principals p ON p.id=r.principal_id
       JOIN messages m ON m.id=r.message_id WHERE r.id=?`,
    )
    .get(runId);
}

function scopedInventory(db, principalId, projectId) {
  const candidates = db
    .prepare(
      `SELECT id, status, scope_json AS scopeJson, subject_json AS subjectJson,
              proposed_type AS proposedType, promoted_memory_id AS promotedMemoryId
       FROM memory_candidates
       WHERE json_extract(scope_json,'$.type')='project'
         AND json_extract(scope_json,'$.projectId')=?
         AND json_extract(subject_json,'$.kind')='user'
         AND json_extract(subject_json,'$.id')=?`,
    )
    .all(projectId, principalId);
  const memories = db
    .prepare(
      `SELECT id, lifecycle_state AS lifecycleState, scope_json AS scopeJson,
              subject_json AS subjectJson, derived_from_json AS derivedFromJson
       FROM memories
       WHERE json_extract(scope_json,'$.type')='project'
         AND json_extract(scope_json,'$.projectId')=?
         AND json_extract(subject_json,'$.kind')='user'
         AND json_extract(subject_json,'$.id')=?`,
    )
    .all(projectId, principalId);
  return { candidates, memories };
}

function validateInventory(rows, projectId, principalId) {
  for (const row of rows) {
    const scope = parsedJson(row.scopeJson);
    const subject = parsedJson(row.subjectJson);
    if (
      scope?.type !== "project" ||
      scope.projectId !== projectId ||
      subject?.kind !== "user" ||
      subject.id !== principalId
    )
      fail(
        "MEMORY_RECOVERY_SCOPE",
        "A Memory row has malformed or cross-scope metadata.",
        "INCONCLUSIVE",
      );
  }
}

function runReferences(rows, pending) {
  const refs = new Set();
  const collect = (row) => {
    for (const step of row.steps ?? []) {
      const id = step?.runId ?? step?.currentRunId;
      if (typeof id === "string") refs.add(id);
    }
    for (const key of ["stepRunId", "creationRunId", "promoteRunId", "cleanupRunId"])
      if (typeof row.handles?.[key] === "string") refs.add(row.handles[key]);
    if (typeof row.recoveryAttempt?.cleanupRunId === "string")
      refs.add(row.recoveryAttempt.cleanupRunId);
  };
  for (const row of rows) collect(row);
  collect(pending);
  return refs;
}

function latestHandles(rows, pending) {
  const result = {};
  for (const row of rows) Object.assign(result, row.handles ?? {});
  Object.assign(result, pending.handles ?? {});
  return safeHandles(result);
}

function proofForRun(db, eventsByRun, expectedScope, attempt, binding) {
  if (!ID.test(binding.runId ?? "") || !ID.test(binding.principalId ?? ""))
    fail("MEMORY_RECOVERY_BINDING", "run_bound audit lacks canonical IDs.", "INCONCLUSIVE");
  const run = getRun(db, binding.runId);
  const scope = parsedJson(run?.scopeJson);
  if (
    !run ||
    run.principalId !== binding.principalId ||
    run.principalKind !== "owner" ||
    run.status === "queued" ||
    run.status === "running" ||
    run.status === "cancelling" ||
    !TERMINAL.has(run.status) ||
    !scope ||
    scope.connectionId !== expectedScope.connectionId ||
    scope.botId !== expectedScope.botId ||
    scope.chatType !== "private" ||
    scope.chatId !== expectedScope.chatId ||
    scope.senderId !== expectedScope.senderId ||
    (scope.threadId ?? null) !== (expectedScope.threadId ?? null) ||
    run.scopeKey !==
      JSON.stringify([
        expectedScope.connectionId,
        expectedScope.botId,
        "private",
        expectedScope.chatId,
        expectedScope.senderId,
        expectedScope.threadId ?? null,
      ]) ||
    run.externalId !== binding.messageId
  )
    fail(
      "MEMORY_RECOVERY_RUN",
      "A bound Run is nonterminal or outside the private Owner scope.",
      "INCONCLUSIVE",
    );
  const trace = eventList(eventsByRun, binding.runId);
  const toolEvidence = verifyTrace(binding.runId, run, trace, binding, attempt, expectedScope);
  return { run, trace, toolEvidence };
}

function verifyCheckpointRunRefs(refs, verifiedRuns) {
  for (const runId of refs) {
    if (!verifiedRuns.has(runId))
      fail(
        "MEMORY_RECOVERY_RUN",
        "A checkpointed Run is not linked to a verified lease marker.",
        "INCONCLUSIVE",
      );
  }
}

function verifyHandleStages(rows, pending, verifiedRuns) {
  const stepStages = new Map();
  for (const row of rows) {
    for (const step of row.steps ?? []) {
      const runId = step?.runId ?? step?.currentRunId;
      if (typeof runId !== "string") continue;
      const stage = step.stage;
      if (stepStages.has(runId) && stepStages.get(runId) !== stage)
        fail(
          "MEMORY_RECOVERY_RUN",
          "A recorded Run has conflicting lifecycle stages.",
          "INCONCLUSIVE",
        );
      stepStages.set(runId, stage);
      if (verifiedRuns.get(runId)?.stage !== stage)
        fail(
          "MEMORY_RECOVERY_RUN",
          "A lifecycle step is linked to a different marker stage.",
          "INCONCLUSIVE",
        );
    }
  }
  for (const row of [...rows, pending]) {
    const handles = row.handles ?? {};
    for (const [key, expectedStage] of [
      ["creationRunId", "feedback"],
      ["promoteRunId", "promote"],
    ]) {
      const runId = handles[key];
      if (typeof runId === "string" && verifiedRuns.get(runId)?.stage !== expectedStage)
        fail(
          "MEMORY_RECOVERY_RUN",
          `Checkpoint ${key} does not match its marker stage.`,
          "INCONCLUSIVE",
        );
    }
    if (typeof handles.cleanupRunId === "string") {
      const expectedStage = handles.cleanupStatus === "rejected" ? "reject" : "expire";
      if (verifiedRuns.get(handles.cleanupRunId)?.stage !== expectedStage)
        fail(
          "MEMORY_RECOVERY_RUN",
          "Checkpoint cleanup Run does not match its cleanup stage.",
          "INCONCLUSIVE",
        );
    }
    if (
      typeof handles.stepRunId === "string" &&
      stepStages.get(handles.stepRunId) !== verifiedRuns.get(handles.stepRunId)?.stage
    )
      fail(
        "MEMORY_RECOVERY_RUN",
        "Checkpoint stepRunId lacks a matching observed lifecycle step.",
        "INCONCLUSIVE",
      );
    const recovery = row.recoveryAttempt;
    if (
      typeof recovery?.cleanupRunId === "string" &&
      verifiedRuns.get(recovery.cleanupRunId)?.stage !== recovery.stage
    )
      fail(
        "MEMORY_RECOVERY_RUN",
        "Recovery cleanup Run does not match its recovery stage.",
        "INCONCLUSIVE",
      );
  }
}

function assertRecoveryTarget(attempts, expected) {
  for (const attempt of attempts) {
    for (const [key, value] of Object.entries(expected)) {
      if (attempt.handles?.[key] !== undefined && attempt.handles[key] !== value)
        fail(
          "MEMORY_RECOVERY_HANDLES",
          "Recovery target does not match the Owner-scoped database lineage.",
          "INCONCLUSIVE",
        );
    }
  }
}

/** Observe a prior fixed Memory fixture using database metadata, acceptance audits and Raw Trace only. */
export function observeMemoryRecovery(db, { record, auditEvents, eventsByRun } = {}) {
  let handles = {};
  try {
    if (!db || typeof db.prepare !== "function" || !Array.isArray(auditEvents))
      fail("MEMORY_RECOVERY_INPUT", "Recovery observer input is incomplete.", "INCONCLUSIVE");
    const { rows, pending } = checkpointRows(record);
    const context = fixtureContext(record, rows);
    handles = latestHandles(rows, pending);
    handles.projectId = context.projectId;
    const attempts = checkpointAttempts(rows, context.fixtureNonce);
    const boundRuns = new Map();
    const verifiedRuns = new Map();
    for (const attempt of attempts) {
      const sameMarker = auditEvents.filter((event) => event?.marker === attempt.marker);
      const registered = sameMarker.filter((event) => event.event === "lease_registered");
      const bound = sameMarker.filter((event) => event.event === "run_bound");
      const expectedScopeSha256 = scopeHash(context.scope);
      if (registered.length > 1 || bound.length > 1)
        fail(
          "MEMORY_RECOVERY_AUDIT",
          "A fixture marker has duplicate lease or Run audit rows.",
          "INCONCLUSIVE",
        );
      if (registered.length === 1) {
        const lease = registered[0];
        if (
          !ID.test(lease.leaseId ?? "") ||
          !ID.test(lease.principalId ?? "") ||
          lease.scopeSha256 !== expectedScopeSha256 ||
          lease.toolsSha256 !== attempt.expectedToolsSha256 ||
          lease.marker !== attempt.marker
        )
          fail(
            "MEMORY_RECOVERY_AUDIT",
            "Lease registration does not match the fixed Owner scope.",
            "INCONCLUSIVE",
          );
        if (attempt.leaseId && attempt.leaseId !== lease.leaseId)
          fail(
            "MEMORY_RECOVERY_AUDIT",
            "Checkpoint lease ID differs from registration evidence.",
            "INCONCLUSIVE",
          );
        attempt.leaseId = lease.leaseId;
        attempt.toolsSha256 = lease.toolsSha256;
      }
      if (bound.length === 1) {
        const binding = bound[0];
        if (
          !registered.length ||
          binding.leaseId !== registered[0].leaseId ||
          binding.principalId !== registered[0].principalId ||
          binding.scopeSha256 !== expectedScopeSha256 ||
          binding.marker !== attempt.marker ||
          binding.toolsSha256 !== attempt.expectedToolsSha256 ||
          binding.textSha256 !== attempt.textSha256 ||
          !/^\d{1,20}$/.test(String(binding.messageId ?? "")) ||
          (attempt.sentMessageId && String(binding.messageId) !== String(attempt.sentMessageId))
        )
          fail(
            "MEMORY_RECOVERY_AUDIT",
            "Run binding does not match the exact sent fixture message.",
            "INCONCLUSIVE",
          );
        attempt.leaseId = binding.leaseId;
        attempt.principalId = binding.principalId;
        attempt.binding = binding;
        if (boundRuns.has(binding.runId))
          fail(
            "MEMORY_RECOVERY_AUDIT",
            "One Run is bound to multiple fixture markers.",
            "INCONCLUSIVE",
          );
        boundRuns.set(binding.runId, attempt);
      } else if (attempt.phases.has("sent")) {
        fail(
          "MEMORY_RECOVERY_AUDIT",
          "Sent checkpoint has no matching run_bound audit.",
          "INCONCLUSIVE",
        );
      }
    }

    if (attempts.some((attempt) => !attempt.binding || !attempt.leaseId))
      fail(
        "MEMORY_RECOVERY_AUDIT",
        "A checkpointed lease has no fully bound terminal Run.",
        "INCONCLUSIVE",
      );
    if (!boundRuns.size)
      fail(
        "MEMORY_RECOVERY_NO_RUN",
        "No terminal Run is yet bound to a sent fixture marker.",
        "INCONCLUSIVE",
      );
    const principalIds = new Set();
    for (const [runId, attempt] of boundRuns) {
      const proof = proofForRun(db, eventsByRun, context.scope, attempt, attempt.binding);
      attempt.runId = runId;
      attempt.runStatus = proof.run.status;
      attempt.hadToolCall = proof.toolEvidence.hadToolCall;
      principalIds.add(attempt.principalId);
      verifiedRuns.set(runId, proof);
    }
    const principalId = [...principalIds][0];
    if (principalIds.size !== 1 || (handles.principalId && handles.principalId !== principalId))
      fail(
        "MEMORY_RECOVERY_OWNER",
        "Fixture marker Runs do not share one Owner principal.",
        "INCONCLUSIVE",
      );
    handles.principalId = principalId;
    assertRecoveryTarget(attempts, { principalId });
    const refs = runReferences(rows, pending);
    verifyCheckpointRunRefs(refs, verifiedRuns);
    verifyHandleStages(rows, pending, boundRuns);

    const inventory = scopedInventory(db, principalId, context.projectId);
    validateInventory(inventory.candidates, context.projectId, principalId);
    validateInventory(inventory.memories, context.projectId, principalId);
    if (inventory.candidates.length > 1)
      fail(
        "MEMORY_RECOVERY_EXTRA_FIXTURE",
        "Fixture project contains extra candidate resources.",
        "INCONCLUSIVE",
      );
    const knownCandidateId = handles.candidateId ?? inventory.candidates[0]?.id;
    if (!knownCandidateId || !inventory.candidates.some((row) => row.id === knownCandidateId))
      fail(
        "MEMORY_RECOVERY_NO_EFFECT_EVIDENCE",
        "No candidate row proves the fixture effect.",
        "INCONCLUSIVE",
      );
    if (inventory.candidates[0].id !== knownCandidateId)
      fail(
        "MEMORY_RECOVERY_CANDIDATE",
        "Candidate metadata does not match the recorded fixture handle.",
        "INCONCLUSIVE",
      );
    handles.candidateId = knownCandidateId;
    assertRecoveryTarget(attempts, { candidateId: knownCandidateId });

    const creationAttempts = [...boundRuns.values()].filter(
      (attempt) => attempt.stage === "feedback",
    );
    const creationIds = new Set(creationAttempts.map((attempt) => attempt.runId));
    const creationRunId = handles.creationRunId ?? [...creationIds][0];
    if (!creationRunId || creationIds.size > 1 || !creationIds.has(creationRunId))
      fail(
        "MEMORY_RECOVERY_CREATION",
        "Candidate creation Run is not uniquely bound to this fixture.",
        "INCONCLUSIVE",
      );
    const creation = discoverFeedbackCandidate(db, {
      runId: creationRunId,
      principalId,
      projectId: context.projectId,
    });
    if (creation.candidateId !== knownCandidateId)
      fail(
        "MEMORY_RECOVERY_CREATION",
        "Feedback candidate differs from the fixed fixture.",
        "INCONCLUSIVE",
      );
    if (!boundRuns.get(creationRunId)?.hadToolCall)
      fail(
        "MEMORY_RECOVERY_TOOLS",
        "Candidate effect has no uniquely verified Owner memory tool call.",
        "INCONCLUSIVE",
      );
    handles.creationRunId = creationRunId;
    assertRecoveryTarget(attempts, { creationRunId });

    const candidate = inventory.candidates[0];
    const pendingCount = inventory.candidates.filter((row) => row.status === "pending").length;
    const activeMemories = inventory.memories.filter((row) => row.lifecycleState === "active");
    const memoryIds = inventory.memories.map((memory) => memory.id);
    const auditTargets = [knownCandidateId, ...memoryIds];
    const targetPlaceholders = auditTargets.map(() => "?").join(",");
    const pendingAudit = db
      .prepare(
        `SELECT sequence, id, action, target_id AS targetId, run_id AS runId,
                principal_id AS principalId, lineage_json AS lineageJson
         FROM memory_audit_events
         WHERE target_id IN (${targetPlaceholders}) OR EXISTS (
           SELECT 1 FROM json_each(memory_audit_events.lineage_json) lineage
           WHERE lineage.value=?
         ) ORDER BY sequence`,
      )
      .all(...auditTargets, knownCandidateId);
    const fixtureAudit = pendingAudit;
    for (const row of fixtureAudit) {
      if (row.principalId !== principalId)
        fail(
          "MEMORY_RECOVERY_LINEAGE",
          "Fixture audit lineage includes another principal.",
          "INCONCLUSIVE",
        );
      if (
        [
          "write",
          "promote",
          "reject",
          "expire",
          "update",
          "supersede",
          "revoke",
          "retire",
        ].includes(row.action)
      ) {
        const expectedStage =
          row.action === "write" ? "feedback" : row.action === "promote" ? "promote" : row.action;
        if (!row.runId || boundRuns.get(row.runId)?.stage !== expectedStage)
          fail(
            "MEMORY_RECOVERY_LINEAGE",
            "Fixture mutation audit has no matching marker stage.",
            "INCONCLUSIVE",
          );
      } else if (row.action !== "read") {
        fail(
          "MEMORY_RECOVERY_LINEAGE",
          "Fixture audit contains an unknown action.",
          "INCONCLUSIVE",
        );
      }
    }

    if (candidate.status === "pending" && pendingCount === 1 && activeMemories.length === 0) {
      if (
        [...boundRuns.values()].some(
          (attempt) => !["feedback", "promote", "reject"].includes(attempt.stage),
        )
      )
        fail(
          "MEMORY_RECOVERY_LINEAGE",
          "Pending candidate has an unrelated later fixture operation.",
          "INCONCLUSIVE",
        );
      return {
        status: "NEEDS_CLEANUP",
        cleanupStage: "reject",
        handles: safeHandles(handles),
      };
    }

    if (candidate.status === "promoted" && activeMemories.length === 1) {
      if (pendingCount !== 0)
        fail(
          "MEMORY_RECOVERY_EXTRA_FIXTURE",
          "Active Memory coexists with pending candidates.",
          "INCONCLUSIVE",
        );
      const memoryId = activeMemories[0].id;
      if (candidate.promotedMemoryId !== memoryId)
        fail(
          "MEMORY_RECOVERY_PROMOTION",
          "Active Memory is not linked to the fixture candidate.",
          "INCONCLUSIVE",
        );
      const promoteAttempts = [...boundRuns.values()].filter(
        (attempt) => attempt.stage === "promote",
      );
      const promoteRunIds = new Set(promoteAttempts.map((attempt) => attempt.runId));
      const promoteRunId = handles.promoteRunId ?? [...promoteRunIds][0];
      if (!promoteRunId || promoteRunIds.size > 1 || !promoteRunIds.has(promoteRunId))
        fail(
          "MEMORY_RECOVERY_PROMOTION",
          "Active Memory has no unique verified Promote Run.",
          "INCONCLUSIVE",
        );
      if (!boundRuns.get(promoteRunId)?.hadToolCall)
        fail(
          "MEMORY_RECOVERY_TOOLS",
          "Active Memory has no verified Promote tool call.",
          "INCONCLUSIVE",
        );
      const promotion = discoverPromotedMemory(db, {
        candidateId: knownCandidateId,
        creationRunId,
        runId: promoteRunId,
        principalId,
        projectId: context.projectId,
      });
      if (promotion.memoryId !== memoryId)
        fail(
          "MEMORY_RECOVERY_PROMOTION",
          "Promote evidence points to another Memory.",
          "INCONCLUSIVE",
        );
      assertRecoveryTarget(attempts, { memoryId, promoteRunId });
      handles.memoryId = memoryId;
      handles.promoteRunId = promoteRunId;
      return { status: "NEEDS_CLEANUP", cleanupStage: "expire", handles: safeHandles(handles) };
    }

    if (candidate.status === "rejected" && !inventory.memories.length && pendingCount === 0) {
      const cleanupRunId = exactCleanupRun(fixtureAudit, "reject", knownCandidateId, boundRuns);
      if (!boundRuns.get(cleanupRunId)?.hadToolCall)
        fail(
          "MEMORY_RECOVERY_TOOLS",
          "Rejected candidate has no verified reject tool call.",
          "INCONCLUSIVE",
        );
      const cleanup = verifyMemoryCleanup(db, {
        candidateId: knownCandidateId,
        creationRunId,
        cleanupRunId,
        principalId,
        projectId: context.projectId,
        memoryId: null,
      });
      handles.cleanupRunId = cleanupRunId;
      return {
        status: "CLEANED",
        cleanupStage: "reject",
        cleanupRunId,
        handles: safeHandles(handles),
      };
    }

    if (candidate.status === "promoted" && inventory.memories.length === 1 && pendingCount === 0) {
      const memory = inventory.memories[0];
      if (candidate.promotedMemoryId !== memory.id || memory.lifecycleState !== "expired")
        fail(
          "MEMORY_RECOVERY_STATE",
          "Memory lifecycle is not in a verified terminal cleanup state.",
          "INCONCLUSIVE",
        );
      const promoteRunId = exactCleanupRun(fixtureAudit, "promote", memory.id, boundRuns);
      const cleanupRunId = exactCleanupRun(fixtureAudit, "expire", memory.id, boundRuns);
      if (!boundRuns.get(promoteRunId)?.hadToolCall || !boundRuns.get(cleanupRunId)?.hadToolCall)
        fail(
          "MEMORY_RECOVERY_TOOLS",
          "Memory cleanup lineage has a missing Owner memory tool call.",
          "INCONCLUSIVE",
        );
      const cleanup = verifyMemoryCleanup(db, {
        candidateId: knownCandidateId,
        creationRunId,
        cleanupRunId,
        principalId,
        projectId: context.projectId,
        memoryId: memory.id,
      });
      if (cleanup.promoteRunId !== promoteRunId || cleanup.status !== "expired")
        fail("MEMORY_RECOVERY_CLEANUP", "Memory cleanup lineage is not complete.", "INCONCLUSIVE");
      assertRecoveryTarget(attempts, { memoryId: memory.id, promoteRunId, cleanupRunId });
      handles.memoryId = memory.id;
      handles.promoteRunId = promoteRunId;
      handles.cleanupRunId = cleanupRunId;
      return {
        status: "CLEANED",
        cleanupStage: "expire",
        cleanupRunId,
        handles: safeHandles(handles),
      };
    }
    fail(
      "MEMORY_RECOVERY_STATE",
      "Fixture state is not a proven pending, active, or cleaned state.",
      "INCONCLUSIVE",
    );
  } catch (error) {
    return inconclusive(error?.code ?? "MEMORY_RECOVERY_INVALID", handles);
  }
}

function exactCleanupRun(auditRows, action, targetId, boundRuns) {
  const rows = auditRows.filter((row) => row.action === action && row.targetId === targetId);
  const runIds = new Set(rows.map((row) => row.runId).filter(Boolean));
  if (rows.length !== 1 || runIds.size !== 1) {
    fail(
      "MEMORY_RECOVERY_LINEAGE",
      "Cleanup audit is not unique for the fixture resource.",
      "INCONCLUSIVE",
    );
  }
  const runId = [...runIds][0];
  const stage = action === "promote" ? "promote" : action === "expire" ? "expire" : "reject";
  if (boundRuns.get(runId)?.stage !== stage)
    fail(
      "MEMORY_RECOVERY_LINEAGE",
      "Cleanup audit Run has no matching verified marker stage.",
      "INCONCLUSIVE",
    );
  return runId;
}
