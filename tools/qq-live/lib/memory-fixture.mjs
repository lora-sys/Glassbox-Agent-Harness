import { fail } from "./core.mjs";

const FIXTURE_PROJECT = /^qqtest-[a-f0-9]{32}$/;
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const CANDIDATE_ID = /^candidate_[a-f0-9]{32}$/i;
const MEMORY_ID = /^memory_[a-f0-9]{32}$/i;

const FEEDBACK_CANDIDATE_SQL = `
SELECT f.id AS feedback_id, f.candidate_id AS candidate_id,
       c.status AS candidate_status, c.created_at AS candidate_created_at,
       f.created_at AS feedback_created_at
FROM feedback_events f
JOIN runs r ON r.id = f.run_id AND r.principal_id = f.principal_id
JOIN memory_candidates c ON c.id = f.candidate_id
JOIN memory_audit_events a
  ON a.target_id = f.id AND a.action = 'write'
 AND a.run_id = f.run_id AND a.principal_id = f.principal_id
WHERE f.run_id = ? AND f.principal_id = ?
  AND f.signal_type = 'explicit_positive'
  AND json_extract(f.scope_json, '$.type') = 'project'
  AND json_extract(f.scope_json, '$.projectId') = ?
  AND json_extract(c.scope_json, '$.type') = 'project'
  AND json_extract(c.scope_json, '$.projectId') = ?
  AND json_extract(c.subject_json, '$.kind') = 'user'
  AND json_extract(c.subject_json, '$.id') = f.principal_id
  AND c.proposed_type = 'preference'
  AND json_array_length(a.lineage_json) = 2
  AND json_extract(a.lineage_json, '$[0]') = c.id
  AND json_extract(a.lineage_json, '$[1]') = 'run:' || f.run_id`;

const FIRST_CANDIDATE_WRITE_SQL = `
SELECT e.sequence AS origin_sequence, e.run_id AS origin_run_id,
       e.principal_id AS origin_principal_id
FROM memory_audit_events e
WHERE e.action = 'write'
  AND (e.target_id = ? OR EXISTS (
    SELECT 1 FROM json_each(e.lineage_json) lineage WHERE lineage.value = ?
  ))
ORDER BY e.sequence ASC
LIMIT 1`;

const PROMOTED_MEMORY_SQL = `
SELECT c.id AS candidate_id, m.id AS memory_id, a.run_id AS promote_run_id,
       a.sequence AS promote_sequence,
       c.status AS candidate_status, m.lifecycle_state AS lifecycle_state
FROM runs r
JOIN memory_audit_events a
  ON a.run_id = r.id AND a.principal_id = r.principal_id AND a.action = 'promote'
JOIN memories m ON m.id = a.target_id
JOIN memory_candidates c ON c.id = ?
WHERE r.id = ? AND r.principal_id = ?
  AND c.status = 'promoted' AND c.promoted_memory_id = m.id
  AND m.lifecycle_state = 'active'
  AND json_extract(c.scope_json, '$.type') = 'project'
  AND json_extract(c.scope_json, '$.projectId') = ?
  AND json_extract(c.subject_json, '$.kind') = 'user'
  AND json_extract(c.subject_json, '$.id') = r.principal_id
  AND json_extract(m.scope_json, '$.type') = 'project'
  AND json_extract(m.scope_json, '$.projectId') = ?
  AND json_extract(m.subject_json, '$.kind') = 'user'
  AND json_extract(m.subject_json, '$.id') = r.principal_id
  AND json_array_length(a.lineage_json) = 2
  AND json_extract(a.lineage_json, '$[0]') = c.id
  AND json_extract(a.lineage_json, '$[1]') = 'run:' || a.run_id
  AND EXISTS (
    SELECT 1 FROM json_each(m.derived_from_json) derived WHERE derived.value = c.id
  )`;

const REJECTED_CANDIDATE_SQL = `
SELECT c.id AS candidate_id, a.run_id AS cleanup_run_id,
       a.sequence AS cleanup_sequence
FROM runs r
JOIN memory_audit_events a
  ON a.run_id = r.id AND a.principal_id = r.principal_id
 AND a.action = 'reject' AND a.target_id = ?
JOIN memory_candidates c ON c.id = a.target_id
WHERE r.id = ? AND r.principal_id = ?
  AND c.status = 'rejected' AND c.promoted_memory_id IS NULL
  AND json_extract(c.scope_json, '$.type') = 'project'
  AND json_extract(c.scope_json, '$.projectId') = ?
  AND json_extract(c.subject_json, '$.kind') = 'user'
  AND json_extract(c.subject_json, '$.id') = r.principal_id
  AND NOT EXISTS (
    SELECT 1 FROM memories linked
    JOIN json_each(linked.derived_from_json) derived
    WHERE linked.lifecycle_state = 'active' AND derived.value = c.id
  )
  AND NOT EXISTS (
    SELECT 1 FROM memories active
    WHERE active.lifecycle_state = 'active'
      AND json_extract(active.scope_json, '$.type') = 'project'
      AND json_extract(active.scope_json, '$.projectId') = ?
      AND json_extract(active.subject_json, '$.kind') = 'user'
      AND json_extract(active.subject_json, '$.id') = r.principal_id
  )
  AND NOT EXISTS (
    SELECT 1 FROM memory_candidates pending
    WHERE pending.status = 'pending'
      AND json_extract(pending.scope_json, '$.type') = 'project'
      AND json_extract(pending.scope_json, '$.projectId') = ?
      AND json_extract(pending.subject_json, '$.kind') = 'user'
      AND json_extract(pending.subject_json, '$.id') = r.principal_id
  )`;

const EXPIRED_MEMORY_SQL = `
WITH promote_audit AS (
  SELECT promoted.sequence, promoted.run_id, promoted.target_id,
         promoted.principal_id
  FROM memory_audit_events promoted
  JOIN runs promotion_run ON promotion_run.id = promoted.run_id
    AND promotion_run.principal_id = promoted.principal_id
  WHERE promoted.action = 'promote'
    AND json_array_length(promoted.lineage_json) = 2
    AND json_extract(promoted.lineage_json, '$[0]') = ?
    AND json_extract(promoted.lineage_json, '$[1]') = 'run:' || promoted.run_id
)
SELECT c.id AS candidate_id, m.id AS memory_id, a.run_id AS cleanup_run_id,
       promote_audit.run_id AS promote_run_id,
       a.sequence AS cleanup_sequence
FROM runs r
JOIN memory_audit_events a
  ON a.run_id = r.id AND a.principal_id = r.principal_id
 AND a.action = 'expire' AND a.target_id = ?
JOIN memories m ON m.id = a.target_id
JOIN memory_candidates c ON c.id = ? AND c.promoted_memory_id = m.id
JOIN promote_audit ON promote_audit.target_id = m.id
  AND promote_audit.principal_id = r.principal_id
WHERE r.id = ? AND r.principal_id = ?
  AND c.status = 'promoted' AND m.lifecycle_state = 'expired'
  AND json_extract(c.scope_json, '$.type') = 'project'
  AND json_extract(c.scope_json, '$.projectId') = ?
  AND json_extract(c.subject_json, '$.kind') = 'user'
  AND json_extract(c.subject_json, '$.id') = r.principal_id
  AND json_extract(m.scope_json, '$.type') = 'project'
  AND json_extract(m.scope_json, '$.projectId') = ?
  AND json_extract(m.subject_json, '$.kind') = 'user'
  AND json_extract(m.subject_json, '$.id') = r.principal_id
  AND NOT EXISTS (
    SELECT 1 FROM memories active
    WHERE active.lifecycle_state = 'active'
      AND json_extract(active.scope_json, '$.type') = 'project'
      AND json_extract(active.scope_json, '$.projectId') = ?
      AND json_extract(active.subject_json, '$.kind') = 'user'
      AND json_extract(active.subject_json, '$.id') = r.principal_id
  )
  AND NOT EXISTS (
    SELECT 1 FROM memory_candidates pending
    WHERE pending.status = 'pending'
      AND json_extract(pending.scope_json, '$.type') = 'project'
      AND json_extract(pending.scope_json, '$.projectId') = ?
      AND json_extract(pending.subject_json, '$.kind') = 'user'
      AND json_extract(pending.subject_json, '$.id') = r.principal_id
  )
  AND EXISTS (
    SELECT 1 FROM json_each(m.derived_from_json) derived WHERE derived.value = c.id
  )
  AND a.sequence > promote_audit.sequence`;

function requireInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input))
    fail("MEMORY_FIXTURE_INPUT", "Memory fixture 定位参数无效。", "INCONCLUSIVE");
  for (const key of ["runId", "principalId", "projectId"]) {
    if (typeof input[key] !== "string" || !SAFE_ID.test(input[key]))
      fail("MEMORY_FIXTURE_INPUT", "Memory fixture 定位参数无效。", "INCONCLUSIVE");
  }
  if (!FIXTURE_PROJECT.test(input.projectId))
    fail("MEMORY_FIXTURE_SCOPE", "Memory fixture 只能使用专用 qqtest 项目范围。", "INCONCLUSIVE");
}

function exactOne(rows, code, message) {
  if (rows.length !== 1) fail(code, message, rows.length ? "INCONCLUSIVE" : "FAIL");
  return rows[0];
}

function firstWriteOrigin(db, candidateId) {
  return db.prepare(FIRST_CANDIDATE_WRITE_SQL).get(candidateId, candidateId);
}

function verifyCreationOrigin(db, candidateId, principalId, creationRunId) {
  const origin = firstWriteOrigin(db, candidateId);
  if (origin?.origin_run_id !== creationRunId || origin?.origin_principal_id !== principalId)
    fail("MEMORY_FIXTURE_ORIGIN", "候选的首条写入审计不属于本轮 Owner 创建 Run。", "INCONCLUSIVE");
  return origin;
}

export function discoverFeedbackCandidate(db, input) {
  requireInput(input);
  const rows = db
    .prepare(FEEDBACK_CANDIDATE_SQL)
    .all(input.runId, input.principalId, input.projectId, input.projectId);
  const row = exactOne(rows, "MEMORY_FIXTURE_FEEDBACK", "本轮没有唯一的 Owner 项目反馈候选。");
  if (!CANDIDATE_ID.test(row.candidate_id))
    fail("MEMORY_FIXTURE_ID", "反馈候选 ID 无效。", "INCONCLUSIVE");
  verifyCreationOrigin(db, row.candidate_id, input.principalId, input.runId);
  return {
    feedbackId: row.feedback_id,
    candidateId: row.candidate_id,
    principalId: input.principalId,
    projectId: input.projectId,
    creationRunId: input.runId,
    candidateStatus: row.candidate_status,
    candidateCreatedAt: row.candidate_created_at,
  };
}

export function discoverPromotedMemory(db, input) {
  requireInput(input);
  for (const key of ["candidateId", "creationRunId"]) {
    if (typeof input[key] !== "string" || !SAFE_ID.test(input[key]))
      fail("MEMORY_FIXTURE_INPUT", "Memory fixture 定位参数无效。", "INCONCLUSIVE");
  }
  if (!CANDIDATE_ID.test(input.candidateId))
    fail("MEMORY_FIXTURE_ID", "候选 ID 无效。", "INCONCLUSIVE");
  if (input.runId === input.creationRunId)
    fail("MEMORY_FIXTURE_RUN", "创建和 Promote 必须来自不同 Run。", "INCONCLUSIVE");
  const creation = discoverFeedbackCandidate(db, {
    runId: input.creationRunId,
    principalId: input.principalId,
    projectId: input.projectId,
  });
  if (creation.candidateId !== input.candidateId)
    fail("MEMORY_FIXTURE_CANDIDATE", "Promote Run 使用的候选与创建 Run 不一致。", "INCONCLUSIVE");
  const origin = firstWriteOrigin(db, input.candidateId);
  const rows = db
    .prepare(PROMOTED_MEMORY_SQL)
    .all(input.candidateId, input.runId, input.principalId, input.projectId, input.projectId);
  const row = exactOne(
    rows,
    "MEMORY_FIXTURE_PROMOTE",
    "本轮没有唯一且来源匹配的 Memory Promote 审计。",
  );
  if (!MEMORY_ID.test(row.memory_id))
    fail("MEMORY_FIXTURE_ID", "Promoted Memory ID 无效。", "INCONCLUSIVE");
  if (row.promote_sequence <= origin.origin_sequence)
    fail("MEMORY_FIXTURE_ORDER", "Promote 审计早于候选首次写入。", "INCONCLUSIVE");
  return {
    candidateId: row.candidate_id,
    memoryId: row.memory_id,
    principalId: input.principalId,
    projectId: input.projectId,
    creationRunId: input.creationRunId,
    promoteRunId: row.promote_run_id,
    lifecycleState: row.lifecycle_state,
  };
}

export function verifyMemoryCleanup(db, input) {
  requireInput({ ...input, runId: input?.cleanupRunId });
  for (const key of ["candidateId", "creationRunId"]) {
    if (typeof input[key] !== "string" || !SAFE_ID.test(input[key]))
      fail("MEMORY_FIXTURE_INPUT", "Memory fixture 清理参数无效。", "INCONCLUSIVE");
  }
  if (!CANDIDATE_ID.test(input.candidateId))
    fail("MEMORY_FIXTURE_ID", "候选 ID 无效。", "INCONCLUSIVE");
  if (input.cleanupRunId === input.creationRunId)
    fail("MEMORY_FIXTURE_RUN", "创建和清理必须来自不同 Run。", "INCONCLUSIVE");
  const creation = discoverFeedbackCandidate(db, {
    runId: input.creationRunId,
    principalId: input.principalId,
    projectId: input.projectId,
  });
  if (creation.candidateId !== input.candidateId)
    fail("MEMORY_FIXTURE_CANDIDATE", "清理目标与创建 Run 的候选不一致。", "INCONCLUSIVE");

  if (input.memoryId === undefined || input.memoryId === null) {
    const origin = firstWriteOrigin(db, input.candidateId);
    const rows = db
      .prepare(REJECTED_CANDIDATE_SQL)
      .all(
        input.candidateId,
        input.cleanupRunId,
        input.principalId,
        input.projectId,
        input.projectId,
        input.projectId,
      );
    const row = exactOne(rows, "MEMORY_FIXTURE_REJECT", "没有本轮拒绝该候选的治理审计。");
    if (row.cleanup_sequence <= origin.origin_sequence)
      fail("MEMORY_FIXTURE_ORDER", "拒绝审计早于候选首次写入。", "INCONCLUSIVE");
    return {
      status: "rejected",
      candidateId: input.candidateId,
      principalId: input.principalId,
      projectId: input.projectId,
      creationRunId: input.creationRunId,
      cleanupRunId: input.cleanupRunId,
    };
  }

  if (typeof input.memoryId !== "string" || !MEMORY_ID.test(input.memoryId))
    fail("MEMORY_FIXTURE_ID", "清理 Memory ID 无效。", "INCONCLUSIVE");
  const rows = db
    .prepare(EXPIRED_MEMORY_SQL)
    .all(
      input.candidateId,
      input.memoryId,
      input.candidateId,
      input.cleanupRunId,
      input.principalId,
      input.projectId,
      input.projectId,
      input.projectId,
      input.projectId,
    );
  const row = exactOne(rows, "MEMORY_FIXTURE_EXPIRE", "没有本轮过期该 Memory 的治理审计。");
  if (
    row.promote_run_id === input.creationRunId ||
    row.promote_run_id === input.cleanupRunId ||
    input.cleanupRunId === input.creationRunId
  )
    fail("MEMORY_FIXTURE_RUN", "创建、Promote 和清理必须来自不同 Run。", "INCONCLUSIVE");
  return {
    status: "expired",
    candidateId: input.candidateId,
    memoryId: input.memoryId,
    principalId: input.principalId,
    projectId: input.projectId,
    creationRunId: input.creationRunId,
    promoteRunId: row.promote_run_id,
    cleanupRunId: input.cleanupRunId,
  };
}
