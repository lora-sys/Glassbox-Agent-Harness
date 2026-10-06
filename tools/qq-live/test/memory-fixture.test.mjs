import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  discoverFeedbackCandidate,
  discoverPromotedMemory,
  verifyMemoryCleanup,
} from "../lib/memory-fixture.mjs";

const principalId = "owner-fixture";
const projectId = `qqtest-${"a".repeat(32)}`;
const candidateId = `candidate_${"b".repeat(32)}`;
const memoryId = `memory_${"c".repeat(32)}`;
const scope = JSON.stringify({ type: "project", projectId });
const subject = JSON.stringify({ kind: "user", id: principalId });

// These table fragments mirror the production baseSchema and learningSchema columns used by
// the observer. Text and evidence columns contain sentinels but are never selected by it.
const SCHEMA = `
PRAGMA foreign_keys=OFF;
CREATE TABLE principals (id TEXT PRIMARY KEY, kind TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE runs (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
  conversation_id TEXT NOT NULL, message_id TEXT NOT NULL UNIQUE,
  principal_id TEXT NOT NULL, scope_json TEXT NOT NULL, execution_ref TEXT NOT NULL,
  status TEXT NOT NULL, result_text TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE memory_candidates (
  id TEXT PRIMARY KEY, candidate_kind TEXT NOT NULL, subject_json TEXT NOT NULL,
  scope_json TEXT NOT NULL, proposed_type TEXT NOT NULL, statement TEXT NOT NULL,
  content_json TEXT NOT NULL, source_json TEXT NOT NULL, evidence_json TEXT NOT NULL,
  confidence REAL, sensitivity TEXT, retention_policy TEXT, ttl_seconds INTEGER,
  merge_hint_json TEXT NOT NULL, extensions_json TEXT NOT NULL,
  status TEXT NOT NULL, created_at TEXT NOT NULL, reviewed_at TEXT, promoted_memory_id TEXT,
  source_dependencies_json TEXT
);
CREATE TABLE memories (
  id TEXT PRIMARY KEY, subject_json TEXT NOT NULL, scope_json TEXT NOT NULL,
  type TEXT NOT NULL, statement TEXT NOT NULL, content_json TEXT NOT NULL,
  source_json TEXT NOT NULL, confidence REAL, sensitivity TEXT, retention_policy TEXT,
  ttl_seconds INTEGER, assertion_mode TEXT NOT NULL, asserted_by_json TEXT NOT NULL,
  confirmed_by_user INTEGER NOT NULL, evidence_json TEXT NOT NULL,
  derived_from_json TEXT NOT NULL, extensions_json TEXT NOT NULL, signature TEXT NOT NULL,
  lifecycle_state TEXT NOT NULL, expires_at TEXT, disabled_at TEXT,
  supersedes_json TEXT NOT NULL, use_count INTEGER NOT NULL DEFAULT 0,
  last_used_at TEXT, retention_factors_json TEXT NOT NULL, retention_value REAL NOT NULL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, source_dependencies_json TEXT
);
CREATE TABLE feedback_events (
  id TEXT PRIMARY KEY, principal_id TEXT NOT NULL, scope_json TEXT NOT NULL,
  signal_type TEXT NOT NULL, statement TEXT NOT NULL, category TEXT,
  conversation_id TEXT, run_id TEXT, task_id TEXT, artifact_ref TEXT,
  evidence_json TEXT NOT NULL, candidate_id TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE memory_audit_events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
  request_id TEXT NOT NULL, principal_id TEXT NOT NULL, action TEXT NOT NULL,
  target_id TEXT NOT NULL, decision_id TEXT NOT NULL, conversation_id TEXT,
  run_id TEXT, lineage_json TEXT NOT NULL, created_at TEXT NOT NULL
);
`;

function dbFixture(t) {
  const db = new DatabaseSync(":memory:");
  db.exec(SCHEMA);
  t.after(() => db.close());
  const guardedDb = {
    prepare(sql) {
      assert.doesNotMatch(sql, /\bstatement\b|evidence_json|messages\.text/i);
      return db.prepare(sql);
    },
  };
  return { db, guardedDb };
}

function addRun(db, runId, principal = principalId) {
  db.prepare(
    `INSERT INTO runs(id,conversation_id,message_id,principal_id,scope_json,execution_ref,status,created_at,updated_at)
     VALUES(?,?,?,?,?,'pi','succeeded','now','now')`,
  ).run(runId, `conversation-${runId}`, `message-${runId}`, principal, scope);
}

function addCandidate(db, options = {}) {
  const id = options.id ?? candidateId;
  const candidateSubject = options.subject ?? subject;
  const candidateScope = options.scope ?? scope;
  db.prepare(
    `INSERT INTO memory_candidates
      (id,candidate_kind,subject_json,scope_json,proposed_type,statement,content_json,
       source_json,evidence_json,confidence,sensitivity,retention_policy,ttl_seconds,
       merge_hint_json,extensions_json,status,created_at,reviewed_at,promoted_memory_id,source_dependencies_json)
     VALUES(?,?,?,?,?,'DO NOT READ','{}','{}','DO NOT READ',0.6,'confidential',NULL,NULL,
       '{}','{}',?,?,?,?,'{}')`,
  ).run(
    id,
    "assertion",
    candidateSubject,
    candidateScope,
    "preference",
    options.status ?? "pending",
    options.createdAt ?? "created",
    options.reviewedAt ?? null,
    options.promotedMemoryId ?? null,
  );
  return id;
}

function addMemory(db, options = {}) {
  const id = options.id ?? memoryId;
  db.prepare(
    `INSERT INTO memories
      (id,subject_json,scope_json,type,statement,content_json,source_json,confidence,
       sensitivity,retention_policy,ttl_seconds,assertion_mode,asserted_by_json,
       confirmed_by_user,evidence_json,derived_from_json,extensions_json,signature,
       lifecycle_state,expires_at,disabled_at,supersedes_json,use_count,last_used_at,
       retention_factors_json,retention_value,created_at,updated_at,source_dependencies_json)
     VALUES(?,?,?,'preference','DO NOT READ','{}','{}',0.6,'confidential',NULL,NULL,
       'confirmed',?,1,'DO NOT READ',?,'{}','signature',?,NULL,?, '[]',0,NULL,'{}',0.6,
       'created','updated','{}')`,
  ).run(
    id,
    options.subject ?? subject,
    options.scope ?? scope,
    subject,
    JSON.stringify(options.derivedFrom ?? [candidateId]),
    options.lifecycleState ?? "active",
    "disabled",
  );
  return id;
}

function addFeedback(db, options = {}) {
  const runId = options.runId ?? "run-create";
  const id = options.id ?? `feedback-${runId}`;
  const candidate = options.candidateId ?? candidateId;
  db.prepare(
    `INSERT INTO feedback_events
      (id,principal_id,scope_json,signal_type,statement,category,conversation_id,run_id,
       task_id,artifact_ref,evidence_json,candidate_id,created_at)
     VALUES(?,?,?,'explicit_positive','DO NOT READ',NULL,?, ?,NULL,NULL,'DO NOT READ',?,'created')`,
  ).run(
    id,
    options.principalId ?? principalId,
    options.scope ?? scope,
    `conversation-${runId}`,
    runId,
    candidate,
  );
  return { id, runId, candidateId: candidate };
}

function addAudit(db, options) {
  db.prepare(
    `INSERT INTO memory_audit_events
      (id,request_id,principal_id,action,target_id,decision_id,conversation_id,run_id,lineage_json,created_at)
     VALUES(?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    options.id ?? `audit-${options.action}-${options.targetId}-${options.runId}`,
    options.runId,
    options.principalId ?? principalId,
    options.action,
    options.targetId,
    "decision-fixture",
    `conversation-${options.runId}`,
    options.runId,
    JSON.stringify(options.lineage ?? []),
    "now",
  );
}

function addFeedbackFixture(db, options = {}) {
  const runId = options.runId ?? "run-create";
  addRun(db, runId, options.runPrincipal ?? principalId);
  const id = addCandidate(db, options.candidate ?? {});
  const feedback = addFeedback(db, {
    runId,
    candidateId: options.feedbackCandidateId ?? id,
    ...(options.feedback ?? {}),
  });
  addAudit(db, {
    action: "write",
    targetId: feedback.id,
    runId,
    principalId: options.auditPrincipal ?? principalId,
    lineage: [feedback.candidateId, `run:${runId}`],
  });
  return { runId, candidateId: id, feedback };
}

test("discovers the unique feedback candidate from its exact Run, Owner, scope and first write audit", (t) => {
  const { db, guardedDb } = dbFixture(t);
  const fixture = addFeedbackFixture(db);
  const found = discoverFeedbackCandidate(guardedDb, {
    runId: fixture.runId,
    principalId,
    projectId,
  });
  assert.deepEqual(found, {
    feedbackId: fixture.feedback.id,
    candidateId,
    principalId,
    projectId,
    creationRunId: "run-create",
    candidateStatus: "pending",
    candidateCreatedAt: "created",
  });
});

test("locates promoted Memory only through its exact governance Run and fixture candidate", (t) => {
  const { db, guardedDb } = dbFixture(t);
  addFeedbackFixture(db);
  addRun(db, "run-promote");
  db.prepare("UPDATE memory_candidates SET status='promoted', promoted_memory_id=? WHERE id=?").run(
    memoryId,
    candidateId,
  );
  addMemory(db);
  addAudit(db, {
    action: "promote",
    targetId: memoryId,
    runId: "run-promote",
    lineage: [candidateId, "run:run-promote"],
  });

  assert.deepEqual(
    discoverPromotedMemory(guardedDb, {
      runId: "run-promote",
      principalId,
      projectId,
      candidateId,
      creationRunId: "run-create",
    }),
    {
      candidateId,
      memoryId,
      principalId,
      projectId,
      creationRunId: "run-create",
      promoteRunId: "run-promote",
      lifecycleState: "active",
    },
  );
});

test("verifies rejected-candidate cleanup by exact Owner governance Run", (t) => {
  const { db, guardedDb } = dbFixture(t);
  addFeedbackFixture(db);
  addRun(db, "run-cleanup");
  db.prepare("UPDATE memory_candidates SET status='rejected' WHERE id=?").run(candidateId);
  addAudit(db, { action: "reject", targetId: candidateId, runId: "run-cleanup" });
  assert.deepEqual(
    verifyMemoryCleanup(guardedDb, {
      principalId,
      projectId,
      candidateId,
      creationRunId: "run-create",
      cleanupRunId: "run-cleanup",
    }),
    {
      status: "rejected",
      candidateId,
      principalId,
      projectId,
      creationRunId: "run-create",
      cleanupRunId: "run-cleanup",
    },
  );
});

test("verifies expired-Memory cleanup through the candidate and promote lineage", (t) => {
  const { db, guardedDb } = dbFixture(t);
  addFeedbackFixture(db);
  addRun(db, "run-promote");
  addRun(db, "run-cleanup");
  db.prepare("UPDATE memory_candidates SET status='promoted', promoted_memory_id=? WHERE id=?").run(
    memoryId,
    candidateId,
  );
  addMemory(db, { lifecycleState: "expired" });
  addAudit(db, {
    action: "promote",
    targetId: memoryId,
    runId: "run-promote",
    lineage: [candidateId, "run:run-promote"],
  });
  addAudit(db, { action: "expire", targetId: memoryId, runId: "run-cleanup" });
  assert.deepEqual(
    verifyMemoryCleanup(guardedDb, {
      principalId,
      projectId,
      candidateId,
      memoryId,
      creationRunId: "run-create",
      cleanupRunId: "run-cleanup",
    }),
    {
      status: "expired",
      candidateId,
      memoryId,
      principalId,
      projectId,
      creationRunId: "run-create",
      promoteRunId: "run-promote",
      cleanupRunId: "run-cleanup",
    },
  );
});

test("rejects ambiguous, cross-Owner, cross-scope, old-origin and mismatched fixture rows", (t) => {
  const cases = [
    {
      name: "multiple feedback candidates",
      seed(db) {
        addFeedbackFixture(db);
        const other = addCandidate(db, { id: `candidate_${"d".repeat(32)}` });
        const feedback = addFeedback(db, { id: "feedback-second", candidateId: other });
        addAudit(db, {
          action: "write",
          targetId: feedback.id,
          runId: "run-create",
          lineage: [other, "run:run-create"],
        });
      },
    },
    {
      name: "candidate belongs to another Owner",
      seed(db) {
        addFeedbackFixture(db, {
          candidate: { subject: JSON.stringify({ kind: "user", id: "other" }) },
        });
      },
    },
    {
      name: "candidate belongs to another project",
      seed(db) {
        addFeedbackFixture(db, {
          candidate: {
            scope: JSON.stringify({ type: "project", projectId: `qqtest-${"e".repeat(32)}` }),
          },
        });
      },
    },
    {
      name: "first write origin is an older Run",
      seed(db) {
        addFeedbackFixture(db);
        addRun(db, "run-old");
        addAudit(db, {
          id: "audit-old-origin",
          action: "write",
          targetId: candidateId,
          runId: "run-old",
        });
        // Put the forged older event before the valid feedback audit.
        db.prepare("UPDATE memory_audit_events SET sequence=0 WHERE id='audit-old-origin'").run();
      },
    },
    {
      name: "feedback points at another candidate",
      seed(db) {
        addFeedbackFixture(db, { feedbackCandidateId: `candidate_${"f".repeat(32)}` });
      },
    },
  ];

  for (const item of cases) {
    const { db, guardedDb } = dbFixture(t);
    item.seed(db);
    assert.throws(
      () => discoverFeedbackCandidate(guardedDb, { runId: "run-create", principalId, projectId }),
      (error) => /^MEMORY_FIXTURE/.test(error.code),
      item.name,
    );
  }
});

test("rejects promotion and cleanup audit forgeries from another Run, Owner or target", (t) => {
  const cases = [
    { name: "promotion audit is from another Run", promoteRun: "run-old", target: memoryId },
    {
      name: "promotion audit targets another Memory",
      promoteRun: "run-promote",
      target: `memory_${"d".repeat(32)}`,
    },
  ];
  for (const item of cases) {
    const { db, guardedDb } = dbFixture(t);
    addFeedbackFixture(db);
    addRun(db, "run-promote");
    addRun(db, "run-old");
    db.prepare(
      "UPDATE memory_candidates SET status='promoted', promoted_memory_id=? WHERE id=?",
    ).run(memoryId, candidateId);
    addMemory(db);
    addAudit(db, {
      action: "promote",
      targetId: item.target,
      runId: item.promoteRun,
      lineage: [candidateId, `run:${item.promoteRun}`],
    });
    assert.throws(
      () =>
        discoverPromotedMemory(guardedDb, {
          runId: "run-promote",
          principalId,
          projectId,
          candidateId,
          creationRunId: "run-create",
        }),
      (error) => /^MEMORY_FIXTURE/.test(error.code),
      item.name,
    );
  }

  const { db, guardedDb } = dbFixture(t);
  addFeedbackFixture(db);
  addRun(db, "run-cleanup");
  db.prepare("UPDATE memory_candidates SET status='rejected' WHERE id=?").run(candidateId);
  addAudit(db, {
    action: "reject",
    targetId: candidateId,
    runId: "run-cleanup",
    principalId: "other-owner",
  });
  assert.throws(
    () =>
      verifyMemoryCleanup(guardedDb, {
        principalId,
        projectId,
        candidateId,
        creationRunId: "run-create",
        cleanupRunId: "run-cleanup",
      }),
    (error) => /^MEMORY_FIXTURE/.test(error.code),
  );
});

test("does not accept rejected-candidate cleanup while a Memory remains linked and active", (t) => {
  const { db, guardedDb } = dbFixture(t);
  addFeedbackFixture(db);
  addRun(db, "run-cleanup");
  db.prepare("UPDATE memory_candidates SET status='rejected', promoted_memory_id=? WHERE id=?").run(
    memoryId,
    candidateId,
  );
  addMemory(db, { lifecycleState: "active" });
  addAudit(db, { action: "reject", targetId: candidateId, runId: "run-cleanup" });
  assert.throws(
    () =>
      verifyMemoryCleanup(guardedDb, {
        principalId,
        projectId,
        candidateId,
        creationRunId: "run-create",
        cleanupRunId: "run-cleanup",
      }),
    (error) => error.code === "MEMORY_FIXTURE_REJECT",
  );
});

test("requires reject cleanup to clear every active Memory and pending candidate in the fixture scope", (t) => {
  for (const extra of ["active-memory", "pending-candidate"]) {
    const { db, guardedDb } = dbFixture(t);
    addFeedbackFixture(db);
    addRun(db, "run-cleanup");
    db.prepare("UPDATE memory_candidates SET status='rejected' WHERE id=?").run(candidateId);
    addAudit(db, { action: "reject", targetId: candidateId, runId: "run-cleanup" });
    if (extra === "active-memory")
      addMemory(db, {
        id: `memory_${"d".repeat(32)}`,
        derivedFrom: [],
        lifecycleState: "active",
      });
    else addCandidate(db, { id: `candidate_${"d".repeat(32)}`, status: "pending" });

    assert.throws(
      () =>
        verifyMemoryCleanup(guardedDb, {
          principalId,
          projectId,
          candidateId,
          creationRunId: "run-create",
          cleanupRunId: "run-cleanup",
        }),
      (error) => error.code === "MEMORY_FIXTURE_REJECT",
      extra,
    );
  }
});

test("requires expire cleanup to clear every active Memory and pending candidate in the fixture scope", (t) => {
  for (const extra of ["active-memory", "pending-candidate"]) {
    const { db, guardedDb } = dbFixture(t);
    addFeedbackFixture(db);
    addRun(db, "run-promote");
    addRun(db, "run-cleanup");
    db.prepare(
      "UPDATE memory_candidates SET status='promoted', promoted_memory_id=? WHERE id=?",
    ).run(memoryId, candidateId);
    addMemory(db, { lifecycleState: "expired" });
    addAudit(db, {
      action: "promote",
      targetId: memoryId,
      runId: "run-promote",
      lineage: [candidateId, "run:run-promote"],
    });
    addAudit(db, { action: "expire", targetId: memoryId, runId: "run-cleanup" });
    if (extra === "active-memory")
      addMemory(db, {
        id: `memory_${"d".repeat(32)}`,
        derivedFrom: [],
        lifecycleState: "active",
      });
    else addCandidate(db, { id: `candidate_${"d".repeat(32)}`, status: "pending" });

    assert.throws(
      () =>
        verifyMemoryCleanup(guardedDb, {
          principalId,
          projectId,
          candidateId,
          memoryId,
          creationRunId: "run-create",
          cleanupRunId: "run-cleanup",
        }),
      (error) => error.code === "MEMORY_FIXTURE_EXPIRE",
      extra,
    );
  }
});

test("rejects cleanup audit that predates creation and expire audit that predates promotion", (t) => {
  {
    const { db, guardedDb } = dbFixture(t);
    addFeedbackFixture(db);
    addRun(db, "run-cleanup");
    db.prepare("UPDATE memory_candidates SET status='rejected' WHERE id=?").run(candidateId);
    addAudit(db, { action: "reject", targetId: candidateId, runId: "run-cleanup" });
    db.prepare("UPDATE memory_audit_events SET sequence=0 WHERE action='reject'").run();
    assert.throws(
      () =>
        verifyMemoryCleanup(guardedDb, {
          principalId,
          projectId,
          candidateId,
          creationRunId: "run-create",
          cleanupRunId: "run-cleanup",
        }),
      (error) => error.code === "MEMORY_FIXTURE_ORDER",
    );
  }
  {
    const { db, guardedDb } = dbFixture(t);
    addFeedbackFixture(db);
    addRun(db, "run-promote");
    addRun(db, "run-cleanup");
    db.prepare(
      "UPDATE memory_candidates SET status='promoted', promoted_memory_id=? WHERE id=?",
    ).run(memoryId, candidateId);
    addMemory(db, { lifecycleState: "expired" });
    addAudit(db, { action: "expire", targetId: memoryId, runId: "run-cleanup" });
    addAudit(db, {
      action: "promote",
      targetId: memoryId,
      runId: "run-promote",
      lineage: [candidateId, "run:run-promote"],
    });
    assert.throws(
      () =>
        verifyMemoryCleanup(guardedDb, {
          principalId,
          projectId,
          candidateId,
          memoryId,
          creationRunId: "run-create",
          cleanupRunId: "run-cleanup",
        }),
      (error) => error.code === "MEMORY_FIXTURE_EXPIRE",
    );
  }
});

test("requires a dedicated qqtest project id and never reads payload columns", (t) => {
  const { db, guardedDb } = dbFixture(t);
  addFeedbackFixture(db);
  assert.throws(
    () =>
      discoverFeedbackCandidate(guardedDb, {
        runId: "run-create",
        principalId,
        projectId: "glassbox",
      }),
    /qqtest 项目范围/,
  );
  assert.doesNotThrow(() =>
    discoverFeedbackCandidate(guardedDb, { runId: "run-create", principalId, projectId }),
  );
  assert.throws(
    () =>
      discoverPromotedMemory(guardedDb, {
        runId: "run-promote",
        principalId,
        projectId,
        candidateId: `candidate_legacy_${"b".repeat(32)}`,
        creationRunId: "run-create",
      }),
    (error) => error.code === "MEMORY_FIXTURE_ID",
  );
});
