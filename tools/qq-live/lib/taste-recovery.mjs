import { digest } from "./core.mjs";
import { observeTasteFixture, pendingCounts } from "./taste-fixture.mjs";
import {
  tasteFixtureProject,
  tasteFixtureStatement,
  tasteFixtureStep,
  TASTE_FAMILY_ID,
} from "./taste-scenario.mjs";

const NONCE = /^[a-f0-9]{32}$/;
const RUN = /^[A-Za-z0-9_-]{1,128}$/;
const CANDIDATE = /^candidate_[a-f0-9]{32}$/;
const MEMORY = /^memory_[a-f0-9]{32}$/;
const HASH = /^[a-f0-9]{64}$/;

function stopped(code, status = "INCONCLUSIVE") {
  return {
    status,
    cleanupOnly: true,
    requiresReconciliation: true,
    error: { code },
  };
}

function actionsFor(record) {
  const row = record?.pending;
  if (
    !row ||
    row.familyId !== TASTE_FAMILY_ID ||
    !["feedback", "promote", "negative-feedback", "retire"].includes(row.stage)
  )
    return null;
  if (row.phase === "cleanup_confirmed") {
    const proof = row.knownFailure?.terminalProof;
    const failureCode = row.knownFailure?.failureCode;
    if (
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
      (failureCode === "REPLY_ASSERTION_FAILED"
        ? row.knownFailure?.sourceCase?.status !== "FAIL" ||
          row.knownFailure.sourceCase.code !== failureCode
        : row.knownFailure?.sourceCase?.status !== "PASS" ||
          row.knownFailure.sourceCase.code !== "REAL_REPLY_RECEIVED") ||
      proof?.cleanupVerified !== true ||
      proof.failureCode !== failureCode ||
      !RUN.test(proof.runId ?? "") ||
      !HASH.test(proof.toolOutputSha256 ?? "")
    )
      return null;
    return "known_failure";
  }
  if (row.phase === "recovery_prepared") return null;
  if (row.phase === "recovery_observed") {
    const recovery = row.recoveryAttempt;
    if (
      !recovery ||
      !HASH.test(recovery.planSha256 ?? "") ||
      !RUN.test(recovery.cleanupRunId ?? "") ||
      !["reject-candidate", "reject-correction", "expire-original"].includes(recovery.action)
    )
      return null;
    if (recovery.action === "reject-correction") return ["expire-original"];
    return [];
  }
  if (row.phase !== "observed") return null;
  if (row.stage === "feedback") return ["reject-candidate"];
  if (row.stage === "promote") return ["expire-original"];
  if (row.stage === "negative-feedback") return ["reject-correction", "expire-original"];
  return [];
}

function validHandles(handles, allowUndiscovered = false) {
  return (
    handles &&
    NONCE.test(handles.fixtureNonce ?? "") &&
    handles.projectId === `qqtest-${handles.fixtureNonce}` &&
    RUN.test(handles.principalId ?? "") &&
    (allowUndiscovered || CANDIDATE.test(handles.candidateId ?? "")) &&
    (allowUndiscovered || RUN.test(handles.creationRunId ?? "")) &&
    (handles.promotionRunId === undefined || RUN.test(handles.promotionRunId)) &&
    (handles.memoryId === undefined || MEMORY.test(handles.memoryId)) &&
    (handles.negativeRunId === undefined || RUN.test(handles.negativeRunId)) &&
    (handles.correctionCandidateId === undefined || CANDIDATE.test(handles.correctionCandidateId))
  );
}

function validRuntime(runtime) {
  return (
    runtime &&
    typeof runtime.checkout === "string" &&
    typeof runtime.dataDirectory === "string" &&
    /^[a-f0-9]{40}$/.test(runtime.commit ?? "") &&
    Number.isSafeInteger(runtime.pid) &&
    runtime.pid > 0 &&
    typeof runtime.connectionId === "string"
  );
}

/** Build the only permitted cleanup plan from the last independently observed checkpoint. */
export function tasteRecoveryPlan(record, observation, runtime) {
  const actionKind = actionsFor(record);
  const actions = actionKind === "known_failure" ? observation?.recoveryActions : actionKind;
  const handles = observation?.handles ?? record?.pending?.handles;
  if (
    !Array.isArray(record?.rows) ||
    !record.rows.length ||
    !HASH.test(record.pending?.checkpointSha256 ?? "") ||
    record.rows.at(-1)?.checkpointSha256 !== record.pending.checkpointSha256 ||
    !validHandles(handles, actionKind === "known_failure") ||
    !validRuntime(runtime) ||
    !Array.isArray(actions) ||
    actions.some(
      (action) => !["reject-candidate", "reject-correction", "expire-original"].includes(action),
    ) ||
    (actionKind === "known_failure" && !validKnownFailureActions(record.pending.stage, actions)) ||
    observation?.status !== (actions.length ? "NEEDS_CLEANUP" : "CLEANED") ||
    observation?.stage !== record.pending.stage
  )
    return null;
  const plan = {
    schemaVersion: 1,
    familyId: TASTE_FAMILY_ID,
    checkpointSha256: record.pending.checkpointSha256,
    runtime: structuredClone(runtime),
    stage: record.pending.stage,
    handles: structuredClone(handles),
    actions,
  };
  return { plan, sha256: digest(JSON.stringify(plan)) };
}

function same(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function validKnownFailureActions(stage, actions) {
  const allowed = {
    feedback: [[], ["reject-candidate"]],
    promote: [["reject-candidate"], ["expire-original"]],
    "negative-feedback": [["expire-original"], ["reject-correction", "expire-original"]],
    retire: [[], ["reject-correction", "expire-original"]],
  }[stage];
  return allowed?.some((candidate) => same(candidate, actions)) === true;
}

function recoverySpec(action, handles) {
  return tasteFixtureStep(action, {
    nonce: handles.fixtureNonce,
    candidateId: handles.candidateId,
    memoryId: handles.memoryId,
    correctionCandidateId: handles.correctionCandidateId,
  });
}

function fixtureState(db, handles) {
  return db
    .prepare(
      `SELECT
         (SELECT status FROM memory_candidates WHERE id = ?) AS candidate_status,
         (SELECT promoted_memory_id FROM memory_candidates WHERE id = ?) AS promoted_memory_id,
         (SELECT lifecycle_state FROM memories WHERE id = ?) AS memory_state,
         (SELECT status FROM memory_candidates WHERE id = ?) AS correction_status,
         (SELECT COUNT(*) FROM memories WHERE lifecycle_state = 'active'
           AND json_extract(scope_json, '$.type') = 'project'
           AND json_extract(scope_json, '$.projectId') = ?
           AND json_extract(subject_json, '$.kind') = 'user'
           AND json_extract(subject_json, '$.id') = ?) AS active_count,
         (SELECT COUNT(*) FROM memory_candidates WHERE status = 'pending'
           AND json_extract(scope_json, '$.type') = 'project'
           AND json_extract(scope_json, '$.projectId') = ?
           AND json_extract(subject_json, '$.kind') = 'user'
           AND json_extract(subject_json, '$.id') = ?) AS pending_count`,
    )
    .get(
      handles.candidateId,
      handles.candidateId,
      handles.memoryId ?? "",
      handles.correctionCandidateId ?? "",
      handles.projectId,
      handles.principalId,
      handles.projectId,
      handles.principalId,
    );
}

function observeKnownTasteFailure(db, record) {
  const row = record.pending;
  const failure = row.knownFailure;
  const runId = failure?.terminalProof?.runId;
  const sourceCase = failure?.sourceCase;
  const failureCode = failure?.failureCode;
  const sourceValid =
    failureCode === "REPLY_ASSERTION_FAILED"
      ? sourceCase?.status === "FAIL" && sourceCase.code === failureCode
      : [
          "TASTE_FEEDBACK",
          "TASTE_PROMOTE",
          "TASTE_NEGATIVE",
          "TASTE_MEMORY",
          "TASTE_RETIRE",
          "TASTE_FIXTURE_FEEDBACK",
          "TASTE_FIXTURE_PROMOTE",
          "TASTE_FIXTURE_NEGATIVE",
          "TASTE_FIXTURE_CLEANUP",
        ].includes(failureCode) &&
        sourceCase?.status === "PASS" &&
        sourceCase.code === "REAL_REPLY_RECEIVED";
  if (
    !sourceValid ||
    failure?.terminalProof?.cleanupVerified !== true ||
    failure.terminalProof.failureCode !== failureCode ||
    !RUN.test(runId ?? "")
  )
    return { status: "INCONCLUSIVE" };
  const actor = db
    .prepare(
      `SELECT r.principal_id, p.kind, json_extract(r.scope_json, '$.chatType') AS chat_type
       FROM runs r JOIN principals p ON p.id = r.principal_id WHERE r.id = ?`,
    )
    .get(runId);
  if (!actor || actor.kind !== "owner" || actor.chat_type !== "private")
    return { status: "INCONCLUSIVE" };
  const principalId = row.handles.principalId ?? actor.principal_id;
  if (principalId !== actor.principal_id) return { status: "INCONCLUSIVE" };
  const handles = {
    ...row.handles,
    principalId,
    fixtureNonce: row.handles.fixtureNonce,
    projectId: tasteFixtureProject(row.handles.fixtureNonce),
  };
  const candidates = db
    .prepare(
      `SELECT id, status, promoted_memory_id, candidate_kind, proposed_type, statement,
              json_extract(extensions_json, '$."glassbox:taste"') AS taste,
              json_extract(scope_json, '$.type') AS scope_type,
              json_extract(scope_json, '$.projectId') AS project_id,
              json_extract(subject_json, '$.kind') AS subject_kind,
              json_extract(subject_json, '$.id') AS subject_id
       FROM memory_candidates
       WHERE statement = ? AND json_extract(scope_json, '$.type') = 'project'
         AND json_extract(scope_json, '$.projectId') = ?
         AND json_extract(subject_json, '$.kind') = 'user'
         AND json_extract(subject_json, '$.id') = ?
         AND proposed_type = 'preference'
         AND json_extract(extensions_json, '$."glassbox:taste"') = 1`,
    )
    .all(tasteFixtureStatement(handles.fixtureNonce), handles.projectId, principalId);
  if (candidates.length > 2) return { status: "INCONCLUSIVE" };
  const positives = candidates.filter((candidate) => candidate.candidate_kind === "assertion");
  const corrections = candidates.filter((candidate) => candidate.candidate_kind === "correction");
  if (positives.length > 1 || corrections.length > 1) return { status: "INCONCLUSIVE" };

  const counts = pendingCounts(db, principalId, handles.projectId);
  const countCurrentFeedback = (signalType) =>
    db
      .prepare(
        `SELECT COUNT(*) AS count FROM feedback_events
         WHERE run_id = ? AND principal_id = ? AND signal_type = ? AND statement = ?
           AND json_extract(scope_json, '$.type') = 'project'
           AND json_extract(scope_json, '$.projectId') = ?`,
      )
      .get(
        runId,
        principalId,
        signalType,
        tasteFixtureStatement(handles.fixtureNonce),
        handles.projectId,
      ).count;
  const countCurrentPromotion = (targetId) =>
    db
      .prepare(
        `SELECT COUNT(*) AS count FROM memory_audit_events
         WHERE run_id = ? AND principal_id = ? AND action = 'promote' AND target_id = ?`,
      )
      .get(runId, principalId, targetId).count;
  const sourceStage = row.stage;
  const sameSource = (candidateId) => candidates.find((candidate) => candidate.id === candidateId);
  const recheckPrior = (stage) => {
    const prior = record.rows
      .slice(0, -1)
      .find((entry) => entry.stage === stage && entry.phase === "observed");
    if (!prior) return null;
    return observeTasteFixture(db, {
      ...prior.handles,
      fixtureNonce: handles.fixtureNonce,
      stage,
      stepRunId: prior.handles.stepRunId,
      principalId,
    });
  };
  const clean = (nextHandles = handles) => ({
    status: "CLEANED",
    stage: sourceStage,
    handles: nextHandles,
    recoveryActions: [],
    activeCount: counts.activeCount,
    pendingCount: counts.pendingCount,
  });
  const needs = (recoveryActions, nextHandles) => ({
    status: "NEEDS_CLEANUP",
    stage: sourceStage,
    handles: nextHandles,
    recoveryActions,
  });

  if (sourceStage === "feedback") {
    if (!positives.length)
      return countCurrentFeedback("explicit_positive") === 0 &&
        counts.activeCount === 0 &&
        counts.pendingCount === 0
        ? clean()
        : { status: "INCONCLUSIVE" };
    const positive = positives[0];
    if (positive.status !== "pending" || positive.promoted_memory_id !== null)
      return { status: "INCONCLUSIVE" };
    try {
      const observation = observeTasteFixture(db, {
        fixtureNonce: handles.fixtureNonce,
        stage: "feedback",
        stepRunId: runId,
        principalId,
      });
      if (observation.candidateId !== positive.id) return { status: "INCONCLUSIVE" };
      Object.assign(handles, { candidateId: positive.id, creationRunId: runId });
      return needs(["reject-candidate"], handles);
    } catch {
      return { status: "INCONCLUSIVE" };
    }
  }

  const candidate = sameSource(handles.candidateId);
  if (!candidate || !handles.creationRunId) return { status: "INCONCLUSIVE" };
  if (sourceStage === "promote") {
    const priorFeedback = recheckPrior("feedback");
    if (
      priorFeedback?.candidateId !== handles.candidateId ||
      priorFeedback.creationRunId !== handles.creationRunId
    )
      return { status: "INCONCLUSIVE" };
    if (candidate.status === "pending" && candidate.promoted_memory_id === null) {
      if (
        counts.activeCount !== 0 ||
        counts.pendingCount !== 1 ||
        countCurrentPromotion(candidate.id) !== 0
      )
        return { status: "INCONCLUSIVE" };
      return needs(["reject-candidate"], handles);
    }
    if (candidate.status !== "promoted" || !MEMORY.test(candidate.promoted_memory_id ?? ""))
      return { status: "INCONCLUSIVE" };
    try {
      const observation = observeTasteFixture(db, {
        ...handles,
        fixtureNonce: handles.fixtureNonce,
        stage: "promote",
        stepRunId: runId,
        principalId,
      });
      const nextHandles = { ...handles, memoryId: observation.memoryId, promotionRunId: runId };
      return needs(["expire-original"], nextHandles);
    } catch {
      return { status: "INCONCLUSIVE" };
    }
  }

  if (!MEMORY.test(handles.memoryId ?? "") || !handles.promotionRunId)
    return { status: "INCONCLUSIVE" };
  const priorPromotion = recheckPrior("promote");
  if (
    priorPromotion?.candidateId !== handles.candidateId ||
    priorPromotion.memoryId !== handles.memoryId ||
    priorPromotion.promotionRunId !== handles.promotionRunId
  )
    return { status: "INCONCLUSIVE" };
  if (sourceStage === "negative-feedback") {
    if (!corrections.length) {
      const state = db
        .prepare("SELECT lifecycle_state FROM memories WHERE id=?")
        .get(handles.memoryId);
      if (
        countCurrentFeedback("explicit_negative") !== 0 ||
        state?.lifecycle_state !== "active" ||
        counts.activeCount !== 1 ||
        counts.pendingCount !== 0
      )
        return { status: "INCONCLUSIVE" };
      return needs(["expire-original"], handles);
    }
    const correction = corrections[0];
    if (correction.status !== "pending" || correction.promoted_memory_id !== null)
      return { status: "INCONCLUSIVE" };
    try {
      const observation = observeTasteFixture(db, {
        ...handles,
        fixtureNonce: handles.fixtureNonce,
        stage: "negative-feedback",
        stepRunId: runId,
        principalId,
      });
      const nextHandles = {
        ...handles,
        negativeRunId: runId,
        correctionCandidateId: observation.correctionCandidateId,
      };
      return needs(["reject-correction", "expire-original"], nextHandles);
    } catch {
      return { status: "INCONCLUSIVE" };
    }
  }

  if (sourceStage === "retire") {
    const priorNegative = recheckPrior("negative-feedback");
    if (
      priorNegative?.candidateId !== handles.candidateId ||
      priorNegative.memoryId !== handles.memoryId ||
      priorNegative.negativeRunId !== handles.negativeRunId ||
      priorNegative.correctionCandidateId !== handles.correctionCandidateId
    )
      return { status: "INCONCLUSIVE" };
    const correction = sameSource(handles.correctionCandidateId);
    if (!correction) return { status: "INCONCLUSIVE" };
    if (correction.status === "promoted" && MEMORY.test(correction.promoted_memory_id ?? "")) {
      try {
        observeTasteFixture(db, {
          ...handles,
          fixtureNonce: handles.fixtureNonce,
          stage: "retire",
          stepRunId: runId,
          principalId,
        });
        return clean({ ...handles, cleanupRunId: runId });
      } catch {
        return { status: "INCONCLUSIVE" };
      }
    }
    if (
      correction.status !== "pending" ||
      correction.promoted_memory_id !== null ||
      countCurrentPromotion(correction.id) !== 0
    )
      return { status: "INCONCLUSIVE" };
    const state = db
      .prepare("SELECT lifecycle_state FROM memories WHERE id=?")
      .get(handles.memoryId);
    if (
      state?.lifecycle_state !== "active" ||
      counts.activeCount !== 1 ||
      counts.pendingCount !== 1
    )
      return { status: "INCONCLUSIVE" };
    return needs(["reject-correction", "expire-original"], handles);
  }
  return { status: "INCONCLUSIVE" };
}

/** Independently inspect the last completed stage or a completed recovery action. */
export function observeTasteRecoveryFixture(db, record) {
  if (!db || typeof db.prepare !== "function" || !record?.pending)
    return { status: "INCONCLUSIVE" };
  const row = record.pending;
  const handles = row.handles;
  if (row.phase === "cleanup_confirmed") {
    try {
      return observeKnownTasteFailure(db, record);
    } catch {
      return { status: "INCONCLUSIVE" };
    }
  }
  if (!validHandles(handles)) return { status: "INCONCLUSIVE" };
  if (row.phase === "observed") {
    try {
      const observation = observeTasteFixture(db, {
        ...handles,
        stage: row.stage,
        fixtureNonce: handles.fixtureNonce,
        stepRunId: handles.stepRunId,
        principalId: handles.principalId,
      });
      return {
        status: row.stage === "retire" ? "CLEANED" : "NEEDS_CLEANUP",
        stage: row.stage,
        handles,
        observation,
        ...(row.stage === "retire" ? { activeCount: 0, pendingCount: 0 } : {}),
      };
    } catch {
      return { status: "INCONCLUSIVE" };
    }
  }
  if (row.phase !== "recovery_observed") return { status: "INCONCLUSIVE" };
  const recovery = row.recoveryAttempt;
  if (
    !recovery ||
    !HASH.test(recovery.planSha256 ?? "") ||
    !RUN.test(recovery.cleanupRunId ?? "") ||
    !["reject-candidate", "reject-correction", "expire-original"].includes(recovery.action)
  )
    return { status: "INCONCLUSIVE" };
  const actionRow = db
    .prepare(
      `SELECT a.action, a.target_id, a.run_id, a.principal_id
       FROM memory_audit_events a JOIN runs r ON r.id = a.run_id AND r.principal_id = a.principal_id
       WHERE a.run_id = ? AND a.principal_id = ? AND a.action = ?`,
    )
    .all(
      recovery.cleanupRunId,
      handles.principalId,
      recovery.action === "expire-original" ? "expire" : "reject",
    );
  const targetId =
    recovery.action === "reject-correction"
      ? handles.correctionCandidateId
      : recovery.action === "expire-original"
        ? handles.memoryId
        : handles.candidateId;
  if (actionRow.length !== 1 || actionRow[0].target_id !== targetId)
    return { status: "INCONCLUSIVE" };
  const state = fixtureState(db, handles);
  if (recovery.action === "reject-correction") {
    if (
      state.candidate_status !== "promoted" ||
      state.promoted_memory_id !== handles.memoryId ||
      state.memory_state !== "active" ||
      state.correction_status !== "rejected" ||
      state.active_count !== 1 ||
      state.pending_count !== 0
    )
      return { status: "INCONCLUSIVE" };
    return { status: "NEEDS_CLEANUP", stage: "negative-feedback", handles };
  }
  if (recovery.action === "reject-candidate") {
    if (
      state.candidate_status !== "rejected" ||
      state.promoted_memory_id !== null ||
      state.active_count !== 0 ||
      state.pending_count !== 0
    )
      return { status: "INCONCLUSIVE" };
    return { status: "CLEANED", stage: row.stage, handles, activeCount: 0, pendingCount: 0 };
  }
  if (
    state.candidate_status !== "promoted" ||
    state.promoted_memory_id !== handles.memoryId ||
    state.memory_state !== "expired" ||
    (["negative-feedback", "retire"].includes(row.stage) &&
      state.correction_status !== "rejected") ||
    state.active_count !== 0 ||
    state.pending_count !== 0
  )
    return { status: "INCONCLUSIVE" };
  return { status: "CLEANED", stage: row.stage, handles, activeCount: 0, pendingCount: 0 };
}

/** Execute only the plan's fixed cleanup actions after the source CLI has stopped. */
export async function reconcileTasteFixture({
  record,
  observation,
  runtime,
  approvedPlanSha256,
  verifyStopped,
  revokeMarker,
  checkpoint,
  executeCleanup,
  verifyCleanup,
  readRuntime,
  signal,
}) {
  if (
    !record ||
    !observation ||
    !validRuntime(runtime) ||
    ![verifyStopped, revokeMarker, checkpoint, executeCleanup, verifyCleanup, readRuntime].every(
      (callback) => typeof callback === "function",
    )
  )
    return stopped("TASTE_RECOVERY_INPUT");
  if (signal?.aborted) return stopped("TASTE_RECOVERY_CANCELLED");
  try {
    const result = await verifyStopped(record);
    if (result?.stopped !== true) return stopped("TASTE_RECOVERY_PROCESS_RUNNING", "BLOCKED");
  } catch {
    return stopped("TASTE_RECOVERY_PROCESS_UNKNOWN");
  }
  const plan = tasteRecoveryPlan(record, observation, runtime);
  if (!plan) return stopped("TASTE_RECOVERY_PLAN_INVALID");
  if (plan.plan.actions.length === 0)
    return {
      status: "CLEANED",
      cleanupOnly: true,
      requiresReconciliation: false,
      handles: plan.plan.handles,
      planSha256: plan.sha256,
      cleanupRunIds: [],
    };
  if (approvedPlanSha256 !== plan.sha256)
    return {
      ...stopped("TASTE_RECOVERY_APPROVAL_REQUIRED", "BLOCKED"),
      plan: plan.plan,
      planSha256: plan.sha256,
    };

  const markers = new Set();
  for (const row of record.rows) {
    for (const value of [row.preparedCase?.marker, row.recoveryAttempt?.preparedCase?.marker])
      if (typeof value === "string") markers.add(value);
  }
  for (const marker of markers) {
    if (signal?.aborted) return stopped("TASTE_RECOVERY_CANCELLED");
    try {
      const receipt = await revokeMarker(marker);
      if (receipt?.active !== false) return stopped("TASTE_RECOVERY_REVOKE_UNKNOWN");
    } catch {
      return stopped("TASTE_RECOVERY_REVOKE_UNKNOWN");
    }
  }

  const cleanupRunIds = [];
  let handles = structuredClone(plan.plan.handles);
  for (const action of plan.plan.actions) {
    if (signal?.aborted) return stopped("TASTE_RECOVERY_CANCELLED");
    if (!same(await readRuntime(), runtime)) return stopped("TASTE_RECOVERY_RUNTIME_CHANGED");
    const spec = recoverySpec(action, handles);
    try {
      const receipt = await checkpoint({
        phase: "recovery_prepared",
        familyId: TASTE_FAMILY_ID,
        planSha256: plan.sha256,
        action,
        handles: structuredClone(handles),
        spec: structuredClone(spec),
      });
      if (receipt?.confirmed !== true) return stopped("TASTE_RECOVERY_CHECKPOINT_UNKNOWN");
    } catch {
      return stopped("TASTE_RECOVERY_CHECKPOINT_UNKNOWN");
    }
    let execution;
    try {
      execution = await executeCleanup(action, structuredClone(spec), structuredClone(handles));
    } catch {
      return stopped("TASTE_RECOVERY_SEND_UNKNOWN");
    }
    const evidence = await verifyCleanup(action, execution, handles);
    if (
      evidence?.status !== "PASS" ||
      !RUN.test(evidence.runId ?? "") ||
      cleanupRunIds.includes(evidence.runId)
    )
      return stopped("TASTE_RECOVERY_EVIDENCE_UNKNOWN");
    cleanupRunIds.push(evidence.runId);
    handles = { ...handles, cleanupRunId: evidence.runId };
    try {
      const receipt = await checkpoint({
        phase: "recovery_observed",
        familyId: TASTE_FAMILY_ID,
        planSha256: plan.sha256,
        action,
        handles: structuredClone(handles),
        cleanup: structuredClone(evidence),
      });
      if (receipt?.confirmed !== true) return stopped("TASTE_RECOVERY_CHECKPOINT_UNKNOWN");
    } catch {
      return stopped("TASTE_RECOVERY_CHECKPOINT_UNKNOWN");
    }
  }
  if (!same(await readRuntime(), runtime)) return stopped("TASTE_RECOVERY_RUNTIME_CHANGED");
  const final = await verifyCleanup("final", null, handles);
  if (final?.status !== "CLEANED" || final.activeCount !== 0 || final.pendingCount !== 0)
    return stopped("TASTE_RECOVERY_FINAL_STATE_UNKNOWN");
  return {
    status: "CLEANED",
    cleanupOnly: true,
    requiresReconciliation: false,
    handles,
    cleanupRunIds,
    planSha256: plan.sha256,
  };
}
