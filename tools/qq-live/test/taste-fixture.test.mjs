import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { observeTasteFixture } from "../lib/taste-fixture.mjs";
import {
  tasteFixtureProject,
  tasteFixtureStatement,
  tasteFixtureStep,
} from "../lib/taste-scenario.mjs";

const nonce = "a".repeat(32);
const projectId = tasteFixtureProject(nonce);
const statement = tasteFixtureStatement(nonce);
const principalId = "owner-fixture";
const candidateId = `candidate_${"b".repeat(32)}`;
const memoryId = `memory_${"c".repeat(32)}`;
const correctionCandidateId = `candidate_${"d".repeat(32)}`;
const scope = JSON.stringify({ type: "project", projectId });
const subject = JSON.stringify({ kind: "user", id: principalId });

const SCHEMA = `
PRAGMA foreign_keys=OFF;
CREATE TABLE principals (id TEXT PRIMARY KEY, kind TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE runs (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
  conversation_id TEXT NOT NULL, message_id TEXT NOT NULL UNIQUE, principal_id TEXT NOT NULL,
  scope_json TEXT NOT NULL, execution_ref TEXT NOT NULL, status TEXT NOT NULL,
  result_text TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE memory_candidates (
  id TEXT PRIMARY KEY, candidate_kind TEXT NOT NULL, subject_json TEXT NOT NULL,
  scope_json TEXT NOT NULL, proposed_type TEXT NOT NULL, statement TEXT NOT NULL,
  content_json TEXT NOT NULL, source_json TEXT NOT NULL, evidence_json TEXT NOT NULL,
  confidence REAL, sensitivity TEXT, retention_policy TEXT, ttl_seconds INTEGER,
  merge_hint_json TEXT NOT NULL, extensions_json TEXT NOT NULL,
  status TEXT NOT NULL, created_at TEXT NOT NULL, reviewed_at TEXT, promoted_memory_id TEXT
);
CREATE TABLE memories (
  id TEXT PRIMARY KEY, subject_json TEXT NOT NULL, scope_json TEXT NOT NULL,
  type TEXT NOT NULL, statement TEXT NOT NULL, content_json TEXT NOT NULL,
  source_json TEXT NOT NULL, confidence REAL, sensitivity TEXT, retention_policy TEXT,
  ttl_seconds INTEGER, assertion_mode TEXT NOT NULL, asserted_by_json TEXT NOT NULL,
  confirmed_by_user INTEGER NOT NULL, evidence_json TEXT NOT NULL, derived_from_json TEXT NOT NULL,
  extensions_json TEXT NOT NULL, signature TEXT NOT NULL, lifecycle_state TEXT NOT NULL,
  expires_at TEXT, disabled_at TEXT, supersedes_json TEXT NOT NULL, use_count INTEGER NOT NULL,
  last_used_at TEXT, retention_factors_json TEXT NOT NULL, retention_value REAL NOT NULL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE feedback_events (
  id TEXT PRIMARY KEY, principal_id TEXT NOT NULL, scope_json TEXT NOT NULL,
  signal_type TEXT NOT NULL, statement TEXT NOT NULL, category TEXT, conversation_id TEXT,
  run_id TEXT, task_id TEXT, artifact_ref TEXT, evidence_json TEXT NOT NULL,
  candidate_id TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE memory_audit_events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
  request_id TEXT NOT NULL, principal_id TEXT NOT NULL, action TEXT NOT NULL,
  target_id TEXT NOT NULL, decision_id TEXT NOT NULL, conversation_id TEXT,
  run_id TEXT, lineage_json TEXT NOT NULL, created_at TEXT NOT NULL
);`;

function fixture(t, beforePositiveFeedback = () => {}) {
  const db = new DatabaseSync(":memory:");
  db.exec(SCHEMA);
  t.after(() => db.close());
  db.prepare("INSERT INTO principals VALUES (?, 'owner', 'now')").run(principalId);
  const addRun = (runId) =>
    db
      .prepare(
        `INSERT INTO runs(id,conversation_id,message_id,principal_id,scope_json,execution_ref,status,created_at,updated_at)
       VALUES(?,?,?,?,'{"chatType":"private"}','pi','succeeded','now','now')`,
      )
      .run(runId, `conversation-${runId}`, `message-${runId}`, principalId);
  const addCandidate = (id, kind, status, promotedMemoryId = null) =>
    db
      .prepare(
        `INSERT INTO memory_candidates
       (id,candidate_kind,subject_json,scope_json,proposed_type,statement,content_json,source_json,evidence_json,
        confidence,sensitivity,retention_policy,ttl_seconds,merge_hint_json,extensions_json,status,created_at,reviewed_at,promoted_memory_id)
       VALUES(?,?,?,?,?,?,'{}','{}',?,0.6,'confidential',NULL,NULL,?,?,?,'now',?,?)`,
      )
      .run(
        id,
        kind,
        subject,
        scope,
        "preference",
        statement,
        JSON.stringify([
          {
            kind: "user_confirmation",
            ref: `run:${status === "pending" && kind === "correction" ? "run-negative" : "run-feedback"}`,
            metadata: {
              signalType: kind === "correction" ? "explicit_negative" : "explicit_positive",
            },
          },
        ]),
        JSON.stringify({ dedupeKey: "sig" }),
        JSON.stringify({ "glassbox:taste": true }),
        status,
        status === "pending" ? null : "reviewed",
        promotedMemoryId,
      );
  const addFeedback = (runId, id, signalType, idForCandidate) => {
    const feedbackId = `feedback-${id}`;
    const evidence = JSON.stringify({
      kind: "user_confirmation",
      ref: `run:${runId}`,
      trustLevel: "high",
      metadata: { signalType },
    });
    db.prepare(
      `INSERT INTO feedback_events VALUES(?,?,?,?,?,'taste.fixture',?, ?,NULL,NULL,?,?, 'now')`,
    ).run(
      feedbackId,
      principalId,
      scope,
      signalType,
      statement,
      `conversation-${runId}`,
      runId,
      evidence,
      idForCandidate,
    );
    addAudit(db, runId, feedbackId, [idForCandidate, `run:${runId}`]);
    return feedbackId;
  };
  const addAudit = (database, runId, targetId, lineage, action = "write") =>
    database
      .prepare(
        `INSERT INTO memory_audit_events(id,request_id,principal_id,action,target_id,decision_id,conversation_id,run_id,lineage_json,created_at)
         VALUES(?,?,?,?,?,'decision-fixture',?,?,?,'now')`,
      )
      .run(
        `audit-${action}-${runId}-${targetId}`,
        runId,
        principalId,
        action,
        targetId,
        `conversation-${runId}`,
        runId,
        JSON.stringify(lineage),
      );

  addRun("run-feedback");
  addCandidate(candidateId, "assertion", "pending");
  addFeedback("run-feedback", candidateId, "explicit_positive", candidateId);
  beforePositiveFeedback(db);

  const positive = observeTasteFixture(db, {
    stage: "feedback",
    fixtureNonce: nonce,
    stepRunId: "run-feedback",
    principalId,
  });

  addRun("run-promote");
  db.prepare(
    "UPDATE memory_candidates SET status='promoted',reviewed_at='now',promoted_memory_id=? WHERE id=?",
  ).run(memoryId, candidateId);
  db.prepare(
    `INSERT INTO memories(id,subject_json,scope_json,type,statement,content_json,source_json,confidence,sensitivity,
      retention_policy,ttl_seconds,assertion_mode,asserted_by_json,confirmed_by_user,evidence_json,derived_from_json,
      extensions_json,signature,lifecycle_state,expires_at,disabled_at,supersedes_json,use_count,last_used_at,
      retention_factors_json,retention_value,created_at,updated_at)
     VALUES(?,?,?,'preference',?,'{}','{}',0.6,'confidential',NULL,NULL,'confirmed',?,1,'[]',?,?,'sig','active',NULL,NULL,'[]',0,NULL,'{}',0.5,'now','now')`,
  ).run(
    memoryId,
    subject,
    scope,
    statement,
    subject,
    JSON.stringify([candidateId]),
    JSON.stringify({ "glassbox:taste": true }),
  );
  addAudit(db, "run-promote", memoryId, [candidateId, "run:run-promote"], "promote");
  const promoted = observeTasteFixture(db, {
    stage: "promote",
    fixtureNonce: nonce,
    stepRunId: "run-promote",
    principalId,
    creationRunId: "run-feedback",
    candidateId,
    memoryId,
  });
  const promotedDiscovered = observeTasteFixture(db, {
    stage: "promote",
    fixtureNonce: nonce,
    stepRunId: "run-promote",
    principalId,
    creationRunId: "run-feedback",
    candidateId,
  });
  assert.equal(promotedDiscovered.memoryId, memoryId);
  assert.throws(
    () =>
      observeTasteFixture(db, {
        stage: "promote",
        fixtureNonce: nonce,
        stepRunId: "run-promote",
        principalId,
        creationRunId: "run-feedback",
        candidateId,
        memoryId: `memory_${"f".repeat(32)}`,
      }),
    { code: "TASTE_FIXTURE_PROMOTE" },
  );

  addRun("run-negative");
  addCandidate(correctionCandidateId, "correction", "pending");
  addFeedback("run-negative", correctionCandidateId, "explicit_negative", correctionCandidateId);
  const negative = observeTasteFixture(db, {
    stage: "negative-feedback",
    fixtureNonce: nonce,
    stepRunId: "run-negative",
    principalId,
    creationRunId: "run-feedback",
    candidateId,
    promotionRunId: "run-promote",
    memoryId,
  });

  addRun("run-retire");
  db.prepare(
    "UPDATE memory_candidates SET status='promoted',reviewed_at='now',promoted_memory_id=? WHERE id=?",
  ).run(memoryId, correctionCandidateId);
  db.prepare("UPDATE memories SET lifecycle_state='retired',disabled_at='now' WHERE id=?").run(
    memoryId,
  );
  addAudit(db, "run-retire", memoryId, [correctionCandidateId, "run:run-retire"], "promote");
  const retired = observeTasteFixture(db, {
    stage: "retire",
    fixtureNonce: nonce,
    stepRunId: "run-retire",
    principalId,
    creationRunId: "run-feedback",
    candidateId,
    promotionRunId: "run-promote",
    memoryId,
    negativeRunId: "run-negative",
    correctionCandidateId,
  });
  return { db, positive, promoted, promotedDiscovered, negative, retired };
}

test("fixed Taste steps bind exact nonce project, same statement, and promote correction to retire", () => {
  const feedback = tasteFixtureStep("feedback", { nonce });
  const promote = tasteFixtureStep("promote", { nonce, candidateId });
  const negative = tasteFixtureStep("negative-feedback", { nonce });
  const retire = tasteFixtureStep("retire", { nonce, correctionCandidateId, memoryId });

  assert.equal(feedback.chat, "private");
  assert.match(
    feedback.prompt,
    new RegExp(`^/memory feedback project:${projectId} explicit_positive`),
  );
  assert.match(
    negative.prompt,
    new RegExp(`^/memory feedback project:${projectId} explicit_negative`),
  );
  assert.equal(feedback.leaseTools[0].operations[0].inputConstraint.statement, statement);
  assert.equal(negative.leaseTools[0].operations[0].inputConstraint.statement, statement);
  assert.equal(promote.leaseTools[0].operations[0].inputConstraint.id, candidateId);
  assert.equal(retire.leaseTools[0].operations[0].inputConstraint.id, correctionCandidateId);
  assert.equal(retire.leaseTools[0].operations[0].action, "memory:govern");
  assert.throws(() => tasteFixtureProject("not-a-nonce"), { code: "TASTE_FIXTURE_NONCE" });
  assert.throws(() => tasteFixtureStep("expire", { nonce }), { code: "TASTE_FIXTURE_STAGE" });
  assert.throws(() => tasteFixtureStep("retire", { nonce, correctionCandidateId }), {
    code: "TASTE_FIXTURE_ID",
  });
});

test("independent observer proves positive candidate, promotion, negative correction, and retirement", (t) => {
  const f = fixture(t);
  assert.equal(f.promotedDiscovered.memoryId, memoryId);
  assert.deepEqual(
    { ...f.positive, feedbackId: undefined },
    {
      principalId,
      principalKind: "owner",
      projectId,
      stepRunId: "run-feedback",
      creationRunId: "run-feedback",
      candidateId,
      candidateStatus: "pending",
      feedbackId: undefined,
    },
  );
  assert.deepEqual(f.promoted, {
    principalId,
    principalKind: "owner",
    projectId,
    stepRunId: "run-promote",
    creationRunId: "run-feedback",
    candidateId,
    promotionRunId: "run-promote",
    memoryId,
    lifecycleState: "active",
  });
  assert.equal(f.negative.correctionCandidateId, correctionCandidateId);
  assert.equal(f.negative.correctionStatus, "pending");
  assert.equal(f.negative.lifecycleState, "active");
  assert.equal(f.retired.lifecycleState, "retired");
  assert.equal(f.retired.correctionStatus, "promoted");
  assert.equal(f.retired.cleanupRunId, "run-retire");
  assert.equal(f.retired.activeCount, 0);
  assert.equal(f.retired.pendingCount, 0);
  for (const output of [f.positive, f.promoted, f.negative, f.retired]) {
    assert.equal(Object.hasOwn(output, "statement"), false);
    assert.equal(Object.hasOwn(output, "feedbackId"), false);
    assert.equal(Object.hasOwn(output, "feedback_id"), false);
  }
});

test("observer fails closed on reused correction, early retirement, wrong Owner, and unfinished project state", (t) => {
  const base = {
    stage: "negative-feedback",
    fixtureNonce: nonce,
    stepRunId: "run-negative",
    principalId,
    creationRunId: "run-feedback",
    candidateId,
    promotionRunId: "run-promote",
    memoryId,
  };

  const reused = fixture(t);
  reused.db
    .prepare(
      "UPDATE memory_candidates SET candidate_kind='correction',status='pending',promoted_memory_id=NULL WHERE id=?",
    )
    .run(candidateId);
  reused.db
    .prepare(
      "UPDATE feedback_events SET signal_type='explicit_negative',candidate_id=? WHERE run_id='run-negative'",
    )
    .run(candidateId);
  reused.db
    .prepare(
      "UPDATE memory_audit_events SET target_id='feedback-candidate-reused',lineage_json=? WHERE run_id='run-negative'",
    )
    .run(JSON.stringify([candidateId, "run:run-negative"]));
  assert.throws(() => observeTasteFixture(reused.db, base), { code: "TASTE_FIXTURE_FEEDBACK" });

  assert.throws(
    () =>
      fixture(t, (db) => {
        db.prepare(
          `INSERT INTO memory_audit_events(sequence,id,request_id,principal_id,action,target_id,decision_id,
        conversation_id,run_id,lineage_json,created_at)
       VALUES(0,'foreign-origin','request','other-owner','write',?,'decision','conversation-run-feedback',
        'run-feedback',?,'earlier')`,
        ).run(candidateId, JSON.stringify([candidateId, "run:run-feedback"]));
      }),
    { code: "TASTE_FIXTURE_ORIGIN" },
  );

  const changedStatement = fixture(t);
  changedStatement.db
    .prepare("UPDATE memories SET statement='different preference' WHERE id=?")
    .run(memoryId);
  assert.throws(
    () =>
      observeTasteFixture(changedStatement.db, {
        stage: "promote",
        fixtureNonce: nonce,
        stepRunId: "run-promote",
        principalId,
        creationRunId: "run-feedback",
        candidateId,
      }),
    { code: "TASTE_FIXTURE_PROMOTE" },
  );

  const changedSignature = fixture(t);
  changedSignature.db
    .prepare("UPDATE memories SET signature='different-signature' WHERE id=?")
    .run(memoryId);
  assert.throws(
    () =>
      observeTasteFixture(changedSignature.db, {
        stage: "promote",
        fixtureNonce: nonce,
        stepRunId: "run-promote",
        principalId,
        creationRunId: "run-feedback",
        candidateId,
      }),
    { code: "TASTE_FIXTURE_PROMOTE" },
  );

  const wrongOwnerFixture = fixture(t);
  const wrongOwner = { ...base, principalId: "other-owner" };
  assert.throws(() => observeTasteFixture(wrongOwnerFixture.db, wrongOwner), {
    code: "TASTE_FIXTURE_RUN",
  });

  const earlyRetirement = fixture(t);
  earlyRetirement.db
    .prepare("UPDATE memory_candidates SET status='pending' WHERE id=?")
    .run(correctionCandidateId);
  earlyRetirement.db
    .prepare("UPDATE memories SET lifecycle_state='active',disabled_at=NULL WHERE id=?")
    .run(memoryId);
  assert.throws(
    () =>
      observeTasteFixture(earlyRetirement.db, {
        stage: "retire",
        fixtureNonce: nonce,
        stepRunId: "run-retire",
        principalId,
        creationRunId: "run-feedback",
        candidateId,
        promotionRunId: "run-promote",
        memoryId,
        negativeRunId: "run-negative",
        correctionCandidateId,
      }),
    { code: "TASTE_FIXTURE_PROMOTE" },
  );

  const unfinished = fixture(t);
  unfinished.db
    .prepare("UPDATE memory_candidates SET status='promoted',promoted_memory_id=? WHERE id=?")
    .run(memoryId, correctionCandidateId);
  unfinished.db
    .prepare("UPDATE memories SET lifecycle_state='retired',disabled_at='now' WHERE id=?")
    .run(memoryId);
  unfinished.db
    .prepare(
      `INSERT INTO memories(id,subject_json,scope_json,type,statement,content_json,source_json,confidence,sensitivity,
      assertion_mode,asserted_by_json,confirmed_by_user,evidence_json,derived_from_json,extensions_json,signature,
      lifecycle_state,supersedes_json,use_count,retention_factors_json,retention_value,created_at,updated_at)
     VALUES('memory_${"e".repeat(32)}',?,?,'semantic_fact','x','{}','{}',0.5,'confidential','asserted',?,0,'[]','[]','{}','other','active','[]',0,'{}',0.5,'now','now')`,
    )
    .run(subject, scope, subject);
  assert.throws(
    () =>
      observeTasteFixture(unfinished.db, {
        stage: "retire",
        fixtureNonce: nonce,
        stepRunId: "run-retire",
        principalId,
        creationRunId: "run-feedback",
        candidateId,
        promotionRunId: "run-promote",
        memoryId,
        negativeRunId: "run-negative",
        correctionCandidateId,
      }),
    { code: "TASTE_FIXTURE_CLEANUP" },
  );
});
