import { isDeepStrictEqual } from "node:util";
import { digest, toolManifestDigest } from "./core.mjs";
import {
  messageReplyTimesFollowInput,
  messageTimeBindingKeys,
  messageTimesMatch,
  validMessageTimeBinding,
} from "./message-binding.mjs";
import { memoryFixtureStep } from "./memory-scenario.mjs";

const NONCE = /^[a-f0-9]{32}$/;
const CANDIDATE = /^candidate_[a-f0-9]{32}$/;
const MEMORY = /^memory_[a-f0-9]{32}$/;
const RUN = /^[A-Za-z0-9_-]{1,128}$/;
const MARKER = /^[a-f0-9]{32}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const MESSAGE_ID = /^-?\d{1,20}$/;
const CLEANUP_STAGES = new Set(["reject", "expire"]);

function stopped(status, code, plan, extra = {}) {
  return {
    status,
    cleanupOnly: true,
    requiresReconciliation: true,
    ...(plan ? { plan: plan.plan, planSha256: plan.sha256 } : {}),
    error: { code },
    ...extra,
  };
}

function validRuntime(runtime) {
  return (
    runtime &&
    typeof runtime === "object" &&
    typeof runtime.checkout === "string" &&
    runtime.checkout.length > 0 &&
    typeof runtime.dataDirectory === "string" &&
    runtime.dataDirectory.length > 0 &&
    /^[a-f0-9]{40}$/.test(runtime.commit ?? "") &&
    Number.isSafeInteger(runtime.pid) &&
    runtime.pid > 0 &&
    typeof runtime.connectionId === "string" &&
    runtime.connectionId.length > 0 &&
    (runtime.threadId === null || typeof runtime.threadId === "string")
  );
}

function validateRecordForPlan(record, runtime) {
  const recordedRuntime = record?.origin?.runtime;
  const sameRuntimeIdentity =
    recordedRuntime &&
    runtime &&
    ["checkout", "dataDirectory", "commit", "connectionId", "threadId"].every(
      (key) => recordedRuntime[key] === runtime[key],
    );
  if (
    !record ||
    !Array.isArray(record.rows) ||
    record.rows.length === 0 ||
    !record.pending ||
    !SHA256.test(record.pending.checkpointSha256 ?? "") ||
    !SHA256.test(record.rows.at(-1)?.checkpointSha256 ?? "") ||
    !validRuntime(runtime) ||
    !sameRuntimeIdentity
  )
    throw new TypeError("Memory recovery record or Runtime is invalid");
}

function normalizeObservation(record, observation) {
  const nonces = new Set(record.rows.map((row) => row.handles?.fixtureNonce));
  const projects = new Set(record.rows.map((row) => row.handles?.projectId));
  if (nonces.size !== 1 || projects.size !== 1) return null;
  const [fixtureNonce] = nonces;
  const [projectId] = projects;
  if (!NONCE.test(fixtureNonce ?? "") || projectId !== `qqtest-${fixtureNonce}`) return null;
  const handles = observation?.handles;
  if (
    !handles ||
    (handles.fixtureNonce !== undefined && handles.fixtureNonce !== fixtureNonce) ||
    (handles.projectId !== undefined && handles.projectId !== projectId)
  )
    return null;
  return {
    ...observation,
    cleanupRunId: observation.cleanupRunId ?? handles.cleanupRunId,
    handles: { ...handles, fixtureNonce, projectId },
  };
}

function validateHandles(stage, handles) {
  if (
    !handles ||
    typeof handles !== "object" ||
    !NONCE.test(handles.fixtureNonce ?? "") ||
    handles.projectId !== `qqtest-${handles.fixtureNonce}` ||
    typeof handles.principalId !== "string" ||
    !RUN.test(handles.principalId) ||
    !CANDIDATE.test(handles.candidateId ?? "") ||
    !RUN.test(handles.creationRunId ?? "")
  )
    return false;
  if (stage === "reject")
    return handles.memoryId === undefined && handles.promoteRunId === undefined;
  return (
    MEMORY.test(handles.memoryId ?? "") &&
    RUN.test(handles.promoteRunId ?? "") &&
    handles.promoteRunId !== handles.creationRunId
  );
}

function handlesMatchRecord(record, stage, handles) {
  const known = ["principalId", "creationRunId", "candidateId", "promoteRunId", "memoryId"];
  for (const key of known) {
    const recorded = record.rows
      .map((row) => row.handles?.[key])
      .filter((value) => value !== undefined);
    if (recorded.some((value) => value !== handles[key])) return false;
  }
  if (
    record.rows.some(
      (row) =>
        row.handles?.fixtureNonce !== handles.fixtureNonce ||
        row.handles?.projectId !== handles.projectId,
    )
  )
    return false;
  if (stage === "reject")
    return !record.rows.some(
      (row) => row.handles?.promoteRunId !== undefined || row.handles?.memoryId !== undefined,
    );
  return record.rows.some(
    (row) => row.handles?.promoteRunId !== undefined && row.handles?.memoryId !== undefined,
  );
}

function markersInRecord(record) {
  const markers = [];
  for (const row of record.rows) {
    if (row?.preparedCase !== undefined) markers.push(row.preparedCase?.marker);
    if (row?.recoveryAttempt?.preparedCase !== undefined)
      markers.push(row.recoveryAttempt.preparedCase?.marker);
  }
  if (record.pending?.preparedCase !== undefined) markers.push(record.pending.preparedCase?.marker);
  if (record.pending?.recoveryAttempt?.preparedCase !== undefined)
    markers.push(record.pending.recoveryAttempt.preparedCase?.marker);
  if (record.recoveryAttempt?.preparedCase !== undefined)
    markers.push(record.recoveryAttempt.preparedCase?.marker);
  if (markers.some((marker) => !MARKER.test(marker ?? ""))) return null;
  return [...new Set(markers)];
}

function observeShape(observation) {
  return (
    observation &&
    typeof observation === "object" &&
    ["NEEDS_CLEANUP", "CLEANED", "INCONCLUSIVE"].includes(observation.status)
  );
}

export function memoryRecoveryPlan(record, observation, runtime) {
  validateRecordForPlan(record, runtime);
  observation = normalizeObservation(record, observation);
  if (
    observation?.status !== "NEEDS_CLEANUP" ||
    !CLEANUP_STAGES.has(observation.cleanupStage) ||
    !validateHandles(observation.cleanupStage, observation.handles) ||
    !handlesMatchRecord(record, observation.cleanupStage, observation.handles)
  )
    throw new TypeError("Memory cleanup observation is invalid");
  const plan = {
    schemaVersion: 1,
    pendingCheckpointSha256: record.pending.checkpointSha256,
    latestJournalSha256: record.rows.at(-1).checkpointSha256,
    runtime: structuredClone(runtime),
    cleanupStage: observation.cleanupStage,
    handles: structuredClone(observation.handles),
  };
  return { plan, sha256: digest(JSON.stringify(plan)) };
}

function validCleanupAcceptance(result, stage, spec, handles, record, runtime) {
  const transport = result?.transportCase;
  const acceptance = result?.productAcceptance;
  const evidence = acceptance?.cases?.[0];
  const binding = transport?.inputBinding;
  const runId = result?.successfulRun;
  const sourceRunIds = new Set(
    record.rows.flatMap((row) =>
      [
        row.handles?.stepRunId,
        row.handles?.creationRunId,
        row.handles?.promoteRunId,
        row.handles?.cleanupRunId,
      ].filter((value) => typeof value === "string"),
    ),
  );
  const expectedPrompt =
    typeof transport?.token === "string" && MARKER.test(transport.token)
      ? `GLASSBOX_ACCEPTANCE_V1 ${transport.token}\n${spec.prompt.replaceAll("{{nonce}}", transport.token).trim()}`
      : "";
  if (
    !RUN.test(runId ?? "") ||
    spec.id !== `memory-${stage}` ||
    transport?.id !== spec.id ||
    transport?.status !== "PASS" ||
    transport?.route !== "private" ||
    transport?.leaseRevoked !== true ||
    transport.sentMessageId !== binding?.driverMessageId ||
    transport.prompt !== expectedPrompt ||
    !binding ||
    !exactKeys(
      binding,
      messageTimeBindingKeys(binding, [
        "driverMessageId",
        "botMessageId",
        "realSequence",
        "time",
        "textSha256",
      ]),
    ) ||
    !MESSAGE_ID.test(String(binding.driverMessageId ?? "")) ||
    !MESSAGE_ID.test(String(binding.botMessageId ?? "")) ||
    !/^\d{1,30}$/.test(String(binding.realSequence ?? "")) ||
    !validMessageTimeBinding(binding) ||
    !SHA256.test(binding.textSha256 ?? "") ||
    binding.textSha256 !== digest(expectedPrompt) ||
    acceptance?.status !== "PASS" ||
    !isDeepStrictEqual(acceptance.runtime, runtime) ||
    acceptance.cases?.length !== 1 ||
    evidence?.caseId !== spec.id ||
    evidence.runId !== runId ||
    evidence.traceVerified !== true ||
    evidence.feature?.status !== "PASS" ||
    evidence.feature?.runId !== runId ||
    evidence.scope?.chatType !== "private" ||
    !isDeepStrictEqual(evidence.scope, record.origin.scope) ||
    evidence.delivery?.status !== "sent" ||
    !evidence.messageBinding?.input ||
    !evidence.messageBinding?.reply ||
    !exactKeys(
      evidence.messageBinding.input,
      messageTimeBindingKeys(evidence.messageBinding.input, ["realSequence", "time", "textSha256"]),
    ) ||
    !Object.hasOwn(evidence.messageBinding.input, "driverTime") ||
    !exactKeys(
      evidence.messageBinding.reply,
      messageTimeBindingKeys(evidence.messageBinding.reply, [
        "botMessageId",
        "driverMessageId",
        "realSequence",
        "time",
        "textSha256",
      ]),
    ) ||
    !Object.hasOwn(evidence.messageBinding.reply, "driverTime") ||
    !validMessageTimeBinding(evidence.messageBinding.input) ||
    !validMessageTimeBinding(evidence.messageBinding.reply) ||
    !/^\d{1,30}$/.test(String(evidence.messageBinding.reply.realSequence ?? "")) ||
    !SHA256.test(evidence.messageBinding.reply.textSha256 ?? "") ||
    !messageReplyTimesFollowInput(evidence.messageBinding.input, evidence.messageBinding.reply) ||
    evidence.messageBinding?.input?.realSequence !== binding.realSequence ||
    !messageTimesMatch(binding, evidence.messageBinding.input) ||
    evidence.messageBinding.input.textSha256 !== binding.textSha256 ||
    sourceRunIds.has(runId) ||
    [handles.creationRunId, handles.promoteRunId, handles.cleanupRunId].includes(runId)
  )
    return false;
  return { runId, binding };
}

function exactKeys(value, expected) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    isDeepStrictEqual(Object.keys(value).sort(), [...expected].sort())
  );
}

function cleanupMatches(observed, expected, stage, cleanupRunId) {
  if (
    observed?.status !== (stage === "reject" ? "rejected" : "expired") ||
    observed.principalKind !== "owner" ||
    observed.candidateId !== expected.candidateId ||
    observed.principalId !== expected.principalId ||
    observed.projectId !== expected.projectId ||
    observed.creationRunId !== expected.creationRunId ||
    observed.cleanupRunId !== cleanupRunId
  )
    return false;
  if (stage === "reject")
    return observed.memoryId === undefined && observed.promoteRunId === undefined;
  return (
    observed.memoryId === expected.memoryId &&
    observed.promoteRunId === expected.promoteRunId &&
    cleanupRunId !== expected.promoteRunId
  );
}

function checkpointConfirmed(result) {
  return result === true || result?.confirmed === true || result?.published === true;
}

/** Reconcile one already-stopped Memory fixture with at most one fixed cleanup action. */
export async function reconcileMemoryFixture({
  record,
  verifyStopped,
  revokeMarker,
  observe,
  executeCleanup,
  verifyCleanup,
  checkpoint,
  signal,
  approvedPlanSha256,
  runtime,
}) {
  if (
    !record ||
    !Array.isArray(record.rows) ||
    !record.rows.length ||
    typeof verifyStopped !== "function" ||
    typeof revokeMarker !== "function" ||
    typeof observe !== "function" ||
    typeof executeCleanup !== "function" ||
    typeof verifyCleanup !== "function" ||
    typeof checkpoint !== "function" ||
    !validRuntime(runtime) ||
    !["checkout", "dataDirectory", "commit", "connectionId", "threadId"].every(
      (key) => record.origin?.runtime?.[key] === runtime[key],
    )
  )
    return stopped("INCONCLUSIVE", "MEMORY_RECOVERY_INPUT");
  try {
    validateRecordForPlan(record, runtime);
  } catch {
    return stopped("INCONCLUSIVE", "MEMORY_RECOVERY_INPUT");
  }
  if (signal?.aborted) return stopped("INCONCLUSIVE", "MEMORY_RECOVERY_CANCELLED");

  try {
    const result = await verifyStopped(record);
    if (result?.stopped !== true) return stopped("BLOCKED", "MEMORY_RECOVERY_PROCESS_RUNNING");
  } catch {
    return stopped("INCONCLUSIVE", "MEMORY_RECOVERY_PROCESS_UNKNOWN");
  }

  const markers = markersInRecord(record);
  if (!markers) return stopped("INCONCLUSIVE", "MEMORY_RECOVERY_MARKER_INVALID");
  for (const marker of markers) {
    if (signal?.aborted) return stopped("INCONCLUSIVE", "MEMORY_RECOVERY_CANCELLED");
    try {
      const receipt = await revokeMarker(marker);
      if (receipt?.active !== false)
        return stopped("INCONCLUSIVE", "MEMORY_RECOVERY_REVOKE_UNCONFIRMED");
    } catch {
      return stopped("INCONCLUSIVE", "MEMORY_RECOVERY_REVOKE_UNCONFIRMED");
    }
  }

  let observation;
  try {
    observation = normalizeObservation(record, await observe(record));
  } catch {
    return stopped("INCONCLUSIVE", "MEMORY_RECOVERY_OBSERVATION_FAILED");
  }
  if (!observeShape(observation))
    return stopped("INCONCLUSIVE", "MEMORY_RECOVERY_OBSERVATION_INVALID");
  if (observation.status === "CLEANED") {
    if (
      !CLEANUP_STAGES.has(observation.cleanupStage) ||
      !validateHandles(observation.cleanupStage, observation.handles) ||
      !handlesMatchRecord(record, observation.cleanupStage, observation.handles) ||
      !RUN.test(observation.cleanupRunId ?? "")
    )
      return stopped("INCONCLUSIVE", "MEMORY_RECOVERY_CLEANED_EVIDENCE");
    return {
      status: "CLEANED",
      cleanupOnly: true,
      requiresReconciliation: false,
      handles: structuredClone(observation.handles),
      cleanupRunId: observation.cleanupRunId,
    };
  }
  if (observation.status === "INCONCLUSIVE")
    return stopped("INCONCLUSIVE", "MEMORY_RECOVERY_OBSERVATION_INCONCLUSIVE");
  if (!CLEANUP_STAGES.has(observation.cleanupStage))
    return stopped("INCONCLUSIVE", "MEMORY_RECOVERY_CLEANUP_STAGE");
  if (
    !validateHandles(observation.cleanupStage, observation.handles) ||
    !handlesMatchRecord(record, observation.cleanupStage, observation.handles)
  )
    return stopped("INCONCLUSIVE", "MEMORY_RECOVERY_HANDLES");
  if (signal?.aborted) return stopped("INCONCLUSIVE", "MEMORY_RECOVERY_CANCELLED");

  let plan;
  try {
    plan = memoryRecoveryPlan(record, observation, runtime);
  } catch {
    return stopped("INCONCLUSIVE", "MEMORY_RECOVERY_PLAN_INVALID");
  }
  if (approvedPlanSha256 !== plan.sha256)
    return stopped("BLOCKED", "MEMORY_RECOVERY_APPROVAL_REQUIRED", plan);

  let spec;
  try {
    spec = memoryFixtureStep(observation.cleanupStage, {
      nonce: observation.handles.fixtureNonce,
      candidateId: observation.handles.candidateId,
      memoryId: observation.handles.memoryId,
    });
    if (toolManifestDigest(spec.leaseTools).length !== 64)
      return stopped("INCONCLUSIVE", "MEMORY_RECOVERY_SPEC_INVALID", plan);
  } catch {
    return stopped("INCONCLUSIVE", "MEMORY_RECOVERY_SPEC_INVALID", plan);
  }

  if (signal?.aborted) return stopped("INCONCLUSIVE", "MEMORY_RECOVERY_CANCELLED", plan);
  try {
    const receipt = await checkpoint({
      phase: "recovery_prepared",
      plan: plan.plan,
      planSha256: plan.sha256,
      cleanupStage: observation.cleanupStage,
      handles: structuredClone(observation.handles),
      spec: structuredClone(spec),
      stage: observation.cleanupStage,
    });
    if (!checkpointConfirmed(receipt))
      return stopped("INCONCLUSIVE", "MEMORY_RECOVERY_CHECKPOINT_UNCONFIRMED", plan);
  } catch {
    return stopped("INCONCLUSIVE", "MEMORY_RECOVERY_CHECKPOINT_UNCONFIRMED", plan);
  }
  if (signal?.aborted) return stopped("INCONCLUSIVE", "MEMORY_RECOVERY_CANCELLED", plan);

  let execution;
  try {
    execution = await executeCleanup(observation.cleanupStage, structuredClone(spec), {
      ...structuredClone(observation.handles),
      recoveryPlanSha256: plan.sha256,
    });
  } catch {
    return stopped("INCONCLUSIVE", "MEMORY_RECOVERY_CLEANUP_FAILED", plan);
  }
  const acceptance = validCleanupAcceptance(
    execution,
    observation.cleanupStage,
    spec,
    observation.handles,
    record,
    runtime,
  );
  if (!acceptance) return stopped("INCONCLUSIVE", "MEMORY_RECOVERY_CLEANUP_EVIDENCE", plan);

  const cleanupHandles = {
    ...structuredClone(observation.handles),
    cleanupRunId: acceptance.runId,
  };
  let cleanup;
  try {
    cleanup = await verifyCleanup(cleanupHandles);
  } catch {
    return stopped("INCONCLUSIVE", "MEMORY_RECOVERY_SQL_VERIFICATION", plan, {
      cleanupRunId: acceptance.runId,
    });
  }
  if (!cleanupMatches(cleanup, cleanupHandles, observation.cleanupStage, acceptance.runId))
    return stopped("INCONCLUSIVE", "MEMORY_RECOVERY_SQL_MISMATCH", plan, {
      cleanupRunId: acceptance.runId,
    });

  try {
    const receipt = await checkpoint({
      phase: "recovery_cleaned",
      planSha256: plan.sha256,
      cleanupStage: observation.cleanupStage,
      handles: cleanupHandles,
      cleanupRunId: acceptance.runId,
      cleanup: structuredClone(cleanup),
      stage: observation.cleanupStage,
    });
    if (!checkpointConfirmed(receipt))
      return stopped("INCONCLUSIVE", "MEMORY_RECOVERY_FINAL_CHECKPOINT_UNCONFIRMED", plan, {
        cleanupRunId: acceptance.runId,
      });
  } catch {
    return stopped("INCONCLUSIVE", "MEMORY_RECOVERY_FINAL_CHECKPOINT_UNCONFIRMED", plan, {
      cleanupRunId: acceptance.runId,
    });
  }

  return {
    status: "CLEANED",
    cleanupOnly: true,
    handles: cleanupHandles,
    cleanupRunId: acceptance.runId,
    requiresReconciliation: false,
    planSha256: plan.sha256,
  };
}
