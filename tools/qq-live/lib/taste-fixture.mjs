import { fail } from "./core.mjs";
import { tasteFixtureProject, tasteFixtureStatement } from "./taste-scenario.mjs";

const RUN_ID = /^[A-Za-z0-9_-]{1,128}$/;
const CANDIDATE_ID = /^candidate_[a-f0-9]{32}$/;
const MEMORY_ID = /^memory_[a-f0-9]{32}$/;

function inconclusive(code, message) {
  fail(code, message, "INCONCLUSIVE");
}

function exactOne(rows, code, message) {
  if (rows.length !== 1) fail(code, message, rows.length ? "INCONCLUSIVE" : "FAIL");
  return rows[0];
}

function requireId(value, pattern, code) {
  if (typeof value !== "string" || !pattern.test(value))
    inconclusive(code, "偏好测试状态标识无效。");
  return value;
}

function requireRun(db, runId, principalId) {
  const row = db
    .prepare(
      `SELECT r.principal_id, json_extract(r.scope_json, '$.chatType') AS chat_type, p.kind AS principal_kind
       FROM runs r JOIN principals p ON p.id = r.principal_id WHERE r.id = ?`,
    )
    .get(runId);
  if (
    !row ||
    row.principal_id !== principalId ||
    row.principal_kind !== "owner" ||
    row.chat_type !== "private"
  )
    inconclusive("TASTE_FIXTURE_RUN", "偏好测试 Run 未能绑定同一 Owner 私聊。 ");
  return row;
}

function firstCandidateWrite(db, candidateId, runId, principalId) {
  const row = db
    .prepare(
      `SELECT sequence, run_id, principal_id
       FROM memory_audit_events
       WHERE action = 'write'
         AND (target_id = ? OR EXISTS (
           SELECT 1 FROM json_each(lineage_json) lineage WHERE lineage.value = ?
         ))
       ORDER BY sequence ASC LIMIT 1`,
    )
    .get(candidateId, candidateId);
  if (!row || row.run_id !== runId || row.principal_id !== principalId)
    inconclusive("TASTE_FIXTURE_ORIGIN", "偏好候选的首次写入不属于本轮 Owner Run。");
  return row;
}

function feedbackRow(db, { runId, principalId, projectId, signalType, expectedStatus }) {
  const rows = db
    .prepare(
      `SELECT f.id AS feedback_id, f.candidate_id, f.created_at AS feedback_created_at,
              c.status AS candidate_status, c.candidate_kind, c.proposed_type,
              c.sensitivity, c.created_at AS candidate_created_at,
              json_extract(c.extensions_json, '$."glassbox:taste"') AS candidate_taste,
              json_array_length(c.evidence_json) AS candidate_evidence_count,
              json_extract(c.evidence_json, '$[0].kind') AS candidate_evidence_kind,
              json_extract(c.evidence_json, '$[0].ref') AS candidate_evidence_ref,
              json_extract(c.evidence_json, '$[0].metadata.signalType') AS candidate_evidence_signal,
              json_extract(f.evidence_json, '$.kind') AS feedback_evidence_kind,
              json_extract(f.evidence_json, '$.ref') AS feedback_evidence_ref,
              json_extract(f.evidence_json, '$.trustLevel') AS feedback_trust,
              json_extract(f.evidence_json, '$.metadata.signalType') AS feedback_evidence_signal,
              a.sequence AS feedback_audit_sequence,
              json_array_length(a.lineage_json) AS audit_lineage_count,
              json_extract(a.lineage_json, '$[0]') AS audit_candidate_id,
              json_extract(a.lineage_json, '$[1]') AS audit_run_ref
       FROM feedback_events f
       JOIN runs r ON r.id = f.run_id AND r.principal_id = f.principal_id
       JOIN memory_candidates c ON c.id = f.candidate_id
       JOIN memory_audit_events a
         ON a.target_id = f.id AND a.action = 'write'
        AND a.run_id = f.run_id AND a.principal_id = f.principal_id
       WHERE f.run_id = ? AND f.principal_id = ? AND f.signal_type = ?
         AND f.statement = ?
         AND json_extract(f.scope_json, '$.type') = 'project'
         AND json_extract(f.scope_json, '$.projectId') = ?
         AND json_extract(c.scope_json, '$.type') = 'project'
         AND json_extract(c.scope_json, '$.projectId') = ?
         AND json_extract(c.subject_json, '$.kind') = 'user'
         AND json_extract(c.subject_json, '$.id') = f.principal_id
         AND c.proposed_type = 'preference' AND c.statement = ?`,
    )
    .all(
      runId,
      principalId,
      signalType,
      tasteFixtureStatementFromProject(projectId),
      projectId,
      projectId,
      tasteFixtureStatementFromProject(projectId),
    );
  const row = exactOne(rows, "TASTE_FIXTURE_FEEDBACK", "本轮没有唯一的项目偏好反馈候选。");
  const candidateId = requireId(row.candidate_id, CANDIDATE_ID, "TASTE_FIXTURE_ID");
  const expectedKind = signalType === "explicit_negative" ? "correction" : "assertion";
  if (
    row.candidate_status !== expectedStatus ||
    row.candidate_kind !== expectedKind ||
    row.candidate_taste !== 1 ||
    row.sensitivity !== "confidential" ||
    row.candidate_evidence_count !== 1 ||
    row.candidate_evidence_kind !== "user_confirmation" ||
    row.candidate_evidence_ref !== `run:${runId}` ||
    row.candidate_evidence_signal !== signalType ||
    row.feedback_evidence_kind !== "user_confirmation" ||
    row.feedback_evidence_ref !== `run:${runId}` ||
    row.feedback_trust !== "high" ||
    row.feedback_evidence_signal !== signalType ||
    row.audit_lineage_count !== 2 ||
    row.audit_candidate_id !== candidateId ||
    row.audit_run_ref !== `run:${runId}`
  )
    inconclusive("TASTE_FIXTURE_FEEDBACK", "偏好反馈、候选证据或写入审计与固定流程不符。");
  const origin = firstCandidateWrite(db, candidateId, runId, principalId);
  return {
    feedbackId: row.feedback_id,
    candidateId,
    candidateStatus: row.candidate_status,
    originSequence: origin.sequence,
  };
}

function tasteFixtureStatementFromProject(projectId) {
  const nonce = /^qqtest-([a-f0-9]{32})$/.exec(projectId)?.[1];
  if (!nonce) inconclusive("TASTE_FIXTURE_SCOPE", "偏好测试项目范围无效。");
  return tasteFixtureStatement(nonce);
}

function promotionRow(
  db,
  {
    runId,
    principalId,
    projectId,
    candidateId,
    memoryId,
    expectedLifecycle,
    expectedCandidateKind = "assertion",
  },
) {
  const rows = db
    .prepare(
      `SELECT c.status AS candidate_status, c.promoted_memory_id,
              c.candidate_kind, c.proposed_type, c.statement AS candidate_statement,
              json_extract(c.merge_hint_json, '$.dedupeKey') AS candidate_dedupe_key,
              m.signature AS memory_signature, m.statement AS memory_statement,
              json_extract(c.extensions_json, '$."glassbox:taste"') AS candidate_taste,
              m.lifecycle_state, m.type AS memory_type,
              json_extract(m.extensions_json, '$."glassbox:taste"') AS memory_taste,
              json_array_length(a.lineage_json) AS audit_lineage_count,
              json_extract(a.lineage_json, '$[0]') AS audit_candidate_id,
              json_extract(a.lineage_json, '$[1]') AS audit_run_ref,
              a.sequence AS promotion_sequence,
              EXISTS (SELECT 1 FROM json_each(m.derived_from_json) d WHERE d.value = c.id) AS candidate_derived,
              m.disabled_at
       FROM runs r
       JOIN memory_audit_events a ON a.run_id = r.id AND a.principal_id = r.principal_id
         AND a.action = 'promote'
       JOIN memories m ON m.id = a.target_id
       JOIN memory_candidates c ON c.id = ?
       WHERE r.id = ? AND r.principal_id = ? AND c.status = 'promoted'
         AND c.promoted_memory_id = m.id
         AND c.proposed_type = 'preference' AND m.type = 'preference'
         AND json_extract(c.extensions_json, '$."glassbox:taste"') = 1
         AND json_extract(m.extensions_json, '$."glassbox:taste"') = 1
         AND json_extract(c.scope_json, '$.type') = 'project'
         AND json_extract(c.scope_json, '$.projectId') = ?
         AND json_extract(c.subject_json, '$.kind') = 'user'
         AND json_extract(c.subject_json, '$.id') = r.principal_id
         AND json_extract(m.scope_json, '$.type') = 'project'
         AND json_extract(m.scope_json, '$.projectId') = ?
         AND json_extract(m.subject_json, '$.kind') = 'user'
         AND json_extract(m.subject_json, '$.id') = r.principal_id
         AND m.lifecycle_state = ?`,
    )
    .all(candidateId, runId, principalId, projectId, projectId, expectedLifecycle);
  const row = exactOne(rows, "TASTE_FIXTURE_PROMOTE", "本轮没有唯一且来源匹配的偏好治理审计。");
  if (
    (memoryId !== undefined && row.promoted_memory_id !== memoryId) ||
    row.candidate_kind !== expectedCandidateKind ||
    row.candidate_statement !== tasteFixtureStatementFromProject(projectId) ||
    row.memory_statement !== tasteFixtureStatementFromProject(projectId) ||
    row.candidate_dedupe_key !== row.memory_signature ||
    row.audit_lineage_count !== 2 ||
    row.audit_candidate_id !== candidateId ||
    row.audit_run_ref !== `run:${runId}` ||
    (expectedCandidateKind === "assertion" && row.candidate_derived !== 1) ||
    (expectedLifecycle === "retired"
      ? typeof row.disabled_at !== "string"
      : row.disabled_at !== null)
  )
    inconclusive("TASTE_FIXTURE_PROMOTE", "偏好治理审计或生命周期状态与固定流程不符。");
  return {
    memoryId: row.promoted_memory_id,
    promotionSequence: row.promotion_sequence,
    lifecycleState: row.lifecycle_state,
  };
}

function pendingCounts(db, principalId, projectId) {
  const rows = db
    .prepare(
      `SELECT
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
    .get(projectId, principalId, projectId, principalId);
  return { activeCount: rows.active_count, pendingCount: rows.pending_count };
}

/** Read only sanitized Owner/project/Run handles and Taste lifecycle states from SQLite. */
export function observeTasteFixture(db, input) {
  if (!db || typeof db.prepare !== "function" || !input || typeof input !== "object")
    inconclusive("TASTE_FIXTURE_INPUT", "只读偏好观察需要 SQLite 和固定阶段参数。");
  const projectId = tasteFixtureProject(input.fixtureNonce);
  const stage = input.stage;
  const stepRunId = requireId(input.stepRunId, RUN_ID, "TASTE_FIXTURE_RUN");
  requireId(input.principalId, RUN_ID, "TASTE_FIXTURE_OWNER");
  requireRun(db, stepRunId, input.principalId);
  const base = {
    principalId: input.principalId,
    principalKind: "owner",
    projectId,
    stepRunId,
  };

  if (stage === "feedback") {
    const feedback = feedbackRow(db, {
      runId: stepRunId,
      principalId: input.principalId,
      projectId,
      signalType: "explicit_positive",
      expectedStatus: "pending",
    });
    return {
      ...base,
      creationRunId: stepRunId,
      candidateId: feedback.candidateId,
      candidateStatus: feedback.candidateStatus,
    };
  }

  const creationRunId = requireId(input.creationRunId, RUN_ID, "TASTE_FIXTURE_RUN");
  const candidateId = requireId(input.candidateId, CANDIDATE_ID, "TASTE_FIXTURE_ID");
  requireRun(db, creationRunId, input.principalId);
  const positive = feedbackRow(db, {
    runId: creationRunId,
    principalId: input.principalId,
    projectId,
    signalType: "explicit_positive",
    expectedStatus: "promoted",
  });
  if (positive.candidateId !== candidateId)
    inconclusive("TASTE_FIXTURE_ORIGIN", "正反馈来源与本轮候选不一致。");

  if (stage === "promote") {
    const expectedMemoryId =
      input.memoryId === undefined
        ? undefined
        : requireId(input.memoryId, MEMORY_ID, "TASTE_FIXTURE_ID");
    const promotion = promotionRow(db, {
      runId: stepRunId,
      principalId: input.principalId,
      projectId,
      candidateId,
      memoryId: expectedMemoryId,
      expectedLifecycle: "active",
    });
    if (stepRunId === creationRunId || promotion.promotionSequence <= positive.originSequence)
      inconclusive("TASTE_FIXTURE_ORDER", "偏好创建和确认必须来自有序的不同 Run。");
    return {
      ...base,
      creationRunId,
      candidateId,
      promotionRunId: stepRunId,
      memoryId: promotion.memoryId,
      lifecycleState: "active",
    };
  }

  const promotionRunId = requireId(input.promotionRunId, RUN_ID, "TASTE_FIXTURE_RUN");
  const memoryId = requireId(input.memoryId, MEMORY_ID, "TASTE_FIXTURE_ID");
  requireRun(db, promotionRunId, input.principalId);
  const originalPromotion = promotionRow(db, {
    runId: promotionRunId,
    principalId: input.principalId,
    projectId,
    candidateId,
    memoryId,
    expectedLifecycle: stage === "retire" ? "retired" : "active",
  });
  if (
    promotionRunId === creationRunId ||
    originalPromotion.promotionSequence <= positive.originSequence
  )
    inconclusive("TASTE_FIXTURE_ORDER", "偏好确认必须晚于本轮正反馈。");

  if (stage === "negative-feedback") {
    const negative = feedbackRow(db, {
      runId: stepRunId,
      principalId: input.principalId,
      projectId,
      signalType: "explicit_negative",
      expectedStatus: "pending",
    });
    if (
      negative.candidateId === candidateId ||
      stepRunId === creationRunId ||
      stepRunId === promotionRunId ||
      negative.originSequence <= originalPromotion.promotionSequence
    )
      inconclusive("TASTE_FIXTURE_NEGATIVE", "负反馈必须创建独立修正候选且晚于正向确认。");
    const original = db
      .prepare(
        `SELECT lifecycle_state, type, signature,
                json_extract(extensions_json, '$."glassbox:taste"') AS taste
         FROM memories WHERE id = ? AND json_extract(scope_json, '$.type') = 'project'
           AND json_extract(scope_json, '$.projectId') = ?
           AND json_extract(subject_json, '$.kind') = 'user'
           AND json_extract(subject_json, '$.id') = ?`,
      )
      .get(memoryId, projectId, input.principalId);
    if (
      !original ||
      original.lifecycle_state !== "active" ||
      original.type !== "preference" ||
      original.taste !== 1 ||
      negativeCandidateDedupKey(db, negative.candidateId) !== original.signature
    )
      inconclusive("TASTE_FIXTURE_NEGATIVE", "负反馈后原偏好必须仍为本轮活动记录。");
    return {
      ...base,
      creationRunId,
      candidateId,
      promotionRunId,
      memoryId,
      negativeRunId: stepRunId,
      correctionCandidateId: negative.candidateId,
      correctionStatus: negative.candidateStatus,
      lifecycleState: "active",
    };
  }

  if (stage === "retire") {
    const negativeRunId = requireId(input.negativeRunId, RUN_ID, "TASTE_FIXTURE_RUN");
    const correctionCandidateId = requireId(
      input.correctionCandidateId,
      CANDIDATE_ID,
      "TASTE_FIXTURE_ID",
    );
    requireRun(db, negativeRunId, input.principalId);
    const negative = feedbackRow(db, {
      runId: negativeRunId,
      principalId: input.principalId,
      projectId,
      signalType: "explicit_negative",
      expectedStatus: "promoted",
    });
    if (
      negative.candidateId !== correctionCandidateId ||
      correctionCandidateId === candidateId ||
      negativeRunId === creationRunId ||
      negativeRunId === promotionRunId ||
      stepRunId === creationRunId ||
      stepRunId === negativeRunId ||
      stepRunId === promotionRunId ||
      negative.originSequence <= originalPromotion.promotionSequence
    )
      inconclusive("TASTE_FIXTURE_NEGATIVE", "修正候选必须来自独立的本轮负反馈 Run。");
    const retirement = promotionRow(db, {
      runId: stepRunId,
      principalId: input.principalId,
      projectId,
      candidateId: correctionCandidateId,
      memoryId,
      expectedLifecycle: "retired",
      expectedCandidateKind: "correction",
    });
    const counts = pendingCounts(db, input.principalId, projectId);
    if (
      retirement.promotionSequence <= negative.originSequence ||
      retirement.promotionSequence <= originalPromotion.promotionSequence ||
      counts.activeCount !== 0 ||
      counts.pendingCount !== 0
    )
      inconclusive("TASTE_FIXTURE_CLEANUP", "测试偏好退役后仍有活动或待审 fixture 状态。");
    return {
      ...base,
      creationRunId,
      candidateId,
      promotionRunId,
      memoryId,
      negativeRunId,
      correctionCandidateId,
      correctionStatus: negative.candidateStatus,
      lifecycleState: "retired",
      cleanupRunId: stepRunId,
      ...counts,
    };
  }

  inconclusive("TASTE_FIXTURE_STAGE", "偏好观察阶段未实现。");
}

function negativeCandidateDedupKey(db, candidateId) {
  const row = db
    .prepare(
      "SELECT json_extract(merge_hint_json, '$.dedupeKey') AS dedupe_key FROM memory_candidates WHERE id = ?",
    )
    .get(candidateId);
  return row?.dedupe_key;
}
