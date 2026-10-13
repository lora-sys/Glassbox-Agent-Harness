import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { digest, toolManifestDigest } from "../lib/core.mjs";
import { memoryFixtureStep } from "../lib/memory-scenario.mjs";
import { MEMORY_REJECT_FAMILY_ID } from "../lib/memory-workflow.mjs";
import { observeMemoryRecovery } from "../lib/memory-recovery-observer.mjs";

const nonce = "a".repeat(32);
const projectId = `qqtest-${nonce}`;
const principalId = "owner_fixture";
const candidateId = `candidate_${"b".repeat(32)}`;
const scope = {
  connectionId: "fixture-connection",
  botId: "10001",
  chatType: "private",
  chatId: "10002",
  senderId: "10002",
  threadId: null,
};
const scopeJson = JSON.stringify(scope);
const scopeKey = JSON.stringify([
  scope.connectionId,
  scope.botId,
  scope.chatType,
  scope.chatId,
  scope.senderId,
  scope.threadId,
]);
const marker = "d".repeat(32);
const leaseId = "12345678-1234-1234-1234-123456789abc";
const messageId = "123456";
const runId = "run_feedback_fixture";
const userSubject = JSON.stringify({ kind: "user", id: principalId });
const projectScope = JSON.stringify({ type: "project", projectId });

const schema = `
CREATE TABLE principals(id TEXT PRIMARY KEY, kind TEXT NOT NULL);
CREATE TABLE runs(id TEXT PRIMARY KEY, principal_id TEXT NOT NULL, status TEXT NOT NULL,
  scope_json TEXT NOT NULL, message_id TEXT NOT NULL);
CREATE TABLE messages(id TEXT PRIMARY KEY, external_id TEXT NOT NULL, scope_key TEXT NOT NULL);
CREATE TABLE memory_candidates(id TEXT PRIMARY KEY, status TEXT NOT NULL, scope_json TEXT NOT NULL,
  subject_json TEXT NOT NULL, proposed_type TEXT NOT NULL, promoted_memory_id TEXT, created_at TEXT);
CREATE TABLE memories(id TEXT PRIMARY KEY, lifecycle_state TEXT NOT NULL, scope_json TEXT NOT NULL,
  subject_json TEXT NOT NULL, derived_from_json TEXT NOT NULL);
CREATE TABLE feedback_events(id TEXT PRIMARY KEY, candidate_id TEXT NOT NULL, run_id TEXT NOT NULL,
  principal_id TEXT NOT NULL, signal_type TEXT NOT NULL, scope_json TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE memory_audit_events(sequence INTEGER PRIMARY KEY, id TEXT NOT NULL, action TEXT NOT NULL,
  target_id TEXT NOT NULL, run_id TEXT, principal_id TEXT NOT NULL, lineage_json TEXT NOT NULL);
`;

function fixture(t, { status = "failed", candidate = true } = {}) {
  const realDb = new DatabaseSync(":memory:");
  realDb.exec(schema);
  const sqlSeen = [];
  const db = {
    prepare(sql) {
      sqlSeen.push(sql);
      assert.match(sql, /^\s*(?:SELECT|WITH)\b/i, "observer issued only read queries");
      assert.doesNotMatch(
        sql,
        /\b(?:INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER)\b/i,
        "observer issued no mutating SQL",
      );
      assert.doesNotMatch(
        sql,
        /\b(statement|content_json|evidence_json|result_text|payload_text|messages\.text)\b/i,
        "observer did not select payload columns",
      );
      return realDb.prepare(sql);
    },
  };
  t.after(() => realDb.close());

  realDb.prepare("INSERT INTO principals VALUES (?, 'owner')").run(principalId);
  realDb.prepare("INSERT INTO messages VALUES ('message-storage', ?, ?)").run(messageId, scopeKey);
  realDb
    .prepare("INSERT INTO runs VALUES (?, ?, ?, ?, 'message-storage')")
    .run(runId, principalId, status, scopeJson);
  if (candidate) {
    realDb
      .prepare(
        "INSERT INTO memory_candidates VALUES (?, 'pending', ?, ?, 'preference', NULL, 'created')",
      )
      .run(candidateId, projectScope, userSubject);
    realDb
      .prepare(
        "INSERT INTO feedback_events VALUES ('feedback-1', ?, ?, ?, 'explicit_positive', ?, 'created')",
      )
      .run(candidateId, runId, principalId, projectScope);
    realDb
      .prepare("INSERT INTO memory_audit_events VALUES (1,'audit-write','write',? ,?,?,?)")
      .run("feedback-1", runId, principalId, JSON.stringify([candidateId, `run:${runId}`]));
  }

  const spec = memoryFixtureStep("feedback", { nonce });
  const prompt = `GLASSBOX_ACCEPTANCE_V1 ${marker}\n${spec.prompt.replaceAll("{{nonce}}", marker)}`;
  const tools = JSON.parse(JSON.stringify(spec.leaseTools).replaceAll("{{nonce}}", marker));
  const toolsSha256 = toolManifestDigest(tools);
  const startedAt = "2026-10-06T00:00:00.000Z";
  const preparedCase = {
    caseId: spec.id,
    marker,
    textSha256: digest(prompt),
    startedAt,
    route: "private",
    leaseId,
    expiresAt: Date.now() + 60_000,
    toolsSha256,
  };
  const origin = {
    scope,
    driverSha256: digest(scope.chatId),
    runtime: { commit: "c".repeat(40) },
  };
  const rows = [
    {
      schemaVersion: 2,
      sequence: 1,
      phase: "lease_intent",
      stage: "feedback",
      handles: { fixtureNonce: nonce, projectId },
      preparedCase,
    },
    {
      schemaVersion: 2,
      sequence: 2,
      phase: "prepared",
      stage: "feedback",
      handles: { fixtureNonce: nonce, projectId },
      preparedCase,
    },
    {
      schemaVersion: 2,
      sequence: 3,
      phase: "sent",
      stage: "feedback",
      handles: { fixtureNonce: nonce, projectId },
      preparedCase,
      sentCase: { caseId: spec.id, driverMessageId: messageId, startedAt },
    },
  ].map((row) => {
    const full = { ...row, origin, runId: "fixture-report-id", reportDirectory: "fixture-report" };
    return { ...full, checkpointSha256: digest(JSON.stringify(full)) };
  });
  const record = {
    origin,
    rows,
    pending: rows[2],
    confirmedSequence: 3,
    reportDirectory: "fixture-report",
    runId: "fixture-report-id",
  };

  const auditEvents = [
    {
      event: "lease_registered",
      marker,
      leaseId,
      principalId,
      scopeSha256: digest(
        JSON.stringify([
          scope.connectionId,
          scope.botId,
          scope.chatType,
          scope.chatId,
          scope.senderId,
          null,
        ]),
      ),
      toolsSha256,
    },
    {
      event: "run_bound",
      marker,
      leaseId,
      runId,
      principalId,
      scopeSha256: digest(
        JSON.stringify([
          scope.connectionId,
          scope.botId,
          scope.chatType,
          scope.chatId,
          scope.senderId,
          null,
        ]),
      ),
      toolsSha256,
      textSha256: digest(prompt),
      messageId,
    },
  ];
  const operation = spec.leaseTools[0].operations[0];
  const eventsByRun = {
    [runId]: [
      {
        runId,
        type: "message_received",
        externalId: messageId,
        textSha256: digest(prompt),
        connectionId: scope.connectionId,
        botId: scope.botId,
        chatType: "private",
        chatId: scope.chatId,
        senderId: scope.senderId,
      },
      {
        runId,
        type: "session_start",
        data: {
          authorizedTools: ["owner_memory_admin"],
          acceptanceLease: {
            leaseId,
            marker,
            narrowedTools: ["owner_memory_admin"],
            toolsSha256,
          },
        },
      },
      {
        runId,
        type: "tool_call",
        toolCallId: "call-1",
        data: {
          toolCallId: "call-1",
          name: "owner_memory_admin",
          input: operation.inputConstraint,
        },
      },
      {
        runId,
        type: "tool_result",
        toolCallId: "call-1",
        data: { toolCallId: "call-1", name: "owner_memory_admin", isError: false },
      },
      { runId, type: "run_finished", status },
    ],
  };
  return { db, realDb, sqlSeen, record, auditEvents, eventsByRun };
}

function addRejectRecovery(f) {
  const recoveryRunId = "run_reject_fixture";
  const recoveryMarker = "e".repeat(32);
  const recoveryLeaseId = "22345678-1234-1234-1234-123456789abc";
  const recoveryMessageId = "123457";
  const spec = memoryFixtureStep("reject", { nonce, candidateId });
  const prompt = `GLASSBOX_ACCEPTANCE_V1 ${recoveryMarker}\n${spec.prompt.replaceAll("{{nonce}}", recoveryMarker)}`;
  const tools = JSON.parse(JSON.stringify(spec.leaseTools).replaceAll("{{nonce}}", recoveryMarker));
  const toolsSha256 = toolManifestDigest(tools);
  const preparedCase = {
    caseId: spec.id,
    marker: recoveryMarker,
    textSha256: digest(prompt),
    startedAt: "2026-10-06T00:01:00.000Z",
    route: "private",
    leaseId: recoveryLeaseId,
    expiresAt: Date.now() + 60_000,
    toolsSha256,
  };
  f.realDb
    .prepare("INSERT INTO messages VALUES ('message-reject', ?, ?)")
    .run(recoveryMessageId, scopeKey);
  f.realDb
    .prepare("INSERT INTO runs VALUES (?, ?, 'failed', ?, 'message-reject')")
    .run(recoveryRunId, principalId, scopeJson);
  f.realDb.prepare("UPDATE memory_candidates SET status='rejected' WHERE id=?").run(candidateId);
  f.realDb
    .prepare("INSERT INTO memory_audit_events VALUES (2,'audit-reject','reject',? ,?,?,?)")
    .run(
      candidateId,
      recoveryRunId,
      principalId,
      JSON.stringify([candidateId, `run:${recoveryRunId}`]),
    );
  const recoveryHandles = {
    fixtureNonce: nonce,
    projectId,
    principalId,
    candidateId,
    creationRunId: runId,
  };
  for (const [sequence, phase] of ["lease_intent", "prepared", "sent", "observed"].entries()) {
    const recoveryPreparedCase =
      phase === "lease_intent"
        ? {
            caseId: spec.id,
            marker: recoveryMarker,
            textSha256: preparedCase.textSha256,
            startedAt: preparedCase.startedAt,
            route: "private",
          }
        : preparedCase;
    const row = {
      schemaVersion: 2,
      sequence: 4 + sequence,
      phase: "sent",
      stage: "feedback",
      handles: { fixtureNonce: nonce, projectId },
      preparedCase: f.record.rows[2].preparedCase,
      sentCase: f.record.rows[2].sentCase,
      recoveryAttempt: {
        attemptId: "d".repeat(32),
        stage: "reject",
        phase,
        handles: recoveryHandles,
        preparedCase: recoveryPreparedCase,
        ...(phase === "sent" || phase === "observed"
          ? {
              sentCase: {
                caseId: spec.id,
                driverMessageId: recoveryMessageId,
                startedAt: preparedCase.startedAt,
              },
            }
          : {}),
        ...(phase === "observed" ? { cleanupRunId: recoveryRunId } : {}),
      },
      origin: f.record.origin,
      runId: f.record.runId,
      reportDirectory: f.record.reportDirectory,
    };
    f.record.rows.push({ ...row, checkpointSha256: digest(JSON.stringify(row)) });
  }
  f.record.pending = f.record.rows.at(-1);
  f.record.confirmedSequence = 7;
  f.auditEvents.push(
    {
      event: "lease_registered",
      marker: recoveryMarker,
      leaseId: recoveryLeaseId,
      principalId,
      scopeSha256: f.auditEvents[0].scopeSha256,
      toolsSha256,
    },
    {
      event: "run_bound",
      marker: recoveryMarker,
      leaseId: recoveryLeaseId,
      runId: recoveryRunId,
      principalId,
      scopeSha256: f.auditEvents[0].scopeSha256,
      toolsSha256,
      textSha256: digest(prompt),
      messageId: recoveryMessageId,
    },
  );
  f.eventsByRun[recoveryRunId] = [
    {
      runId: recoveryRunId,
      type: "message_received",
      externalId: recoveryMessageId,
      textSha256: digest(prompt),
      connectionId: scope.connectionId,
      botId: scope.botId,
      chatType: "private",
      chatId: scope.chatId,
      senderId: scope.senderId,
    },
    {
      runId: recoveryRunId,
      type: "session_start",
      data: {
        authorizedTools: ["owner_memory_admin"],
        acceptanceLease: {
          leaseId: recoveryLeaseId,
          marker: recoveryMarker,
          narrowedTools: ["owner_memory_admin"],
          toolsSha256,
        },
      },
    },
    {
      runId: recoveryRunId,
      type: "tool_call",
      toolCallId: "call-reject",
      data: {
        toolCallId: "call-reject",
        name: "owner_memory_admin",
        input: spec.leaseTools[0].operations[0].inputConstraint,
      },
    },
    {
      runId: recoveryRunId,
      type: "tool_result",
      toolCallId: "call-reject",
      data: { toolCallId: "call-reject", name: "owner_memory_admin", isError: false },
    },
    { runId: recoveryRunId, type: "run_finished", status: "failed" },
  ];
}

function addPromoteRecovery(f) {
  const recoveryRunId = "run_promote_fixture";
  const memoryId = `memory_${"c".repeat(32)}`;
  const recoveryMarker = "f".repeat(32);
  const recoveryLeaseId = "32345678-1234-1234-1234-123456789abc";
  const recoveryMessageId = "123458";
  const spec = memoryFixtureStep("promote", { nonce, candidateId });
  const prompt = `GLASSBOX_ACCEPTANCE_V1 ${recoveryMarker}\n${spec.prompt.replaceAll("{{nonce}}", recoveryMarker)}`;
  const tools = JSON.parse(JSON.stringify(spec.leaseTools).replaceAll("{{nonce}}", recoveryMarker));
  const toolsSha256 = toolManifestDigest(tools);
  const startedAt = "2026-10-06T00:02:00.000Z";
  const preparedCase = {
    caseId: spec.id,
    marker: recoveryMarker,
    textSha256: digest(prompt),
    startedAt,
    route: "private",
    leaseId: recoveryLeaseId,
    expiresAt: Date.now() + 60_000,
    toolsSha256,
  };
  f.realDb
    .prepare("INSERT INTO messages VALUES ('message-promote', ?, ?)")
    .run(recoveryMessageId, scopeKey);
  f.realDb
    .prepare("INSERT INTO runs VALUES (?, ?, 'failed', ?, 'message-promote')")
    .run(recoveryRunId, principalId, scopeJson);
  f.realDb
    .prepare("UPDATE memory_candidates SET status='promoted', promoted_memory_id=? WHERE id=?")
    .run(memoryId, candidateId);
  f.realDb
    .prepare("INSERT INTO memories VALUES (?, 'active', ?, ?, ?)")
    .run(memoryId, projectScope, userSubject, JSON.stringify([candidateId]));
  f.realDb
    .prepare("INSERT INTO memory_audit_events VALUES (2,'audit-promote','promote',? ,?,?,?)")
    .run(
      memoryId,
      recoveryRunId,
      principalId,
      JSON.stringify([candidateId, `run:${recoveryRunId}`]),
    );
  for (const [index, phase] of ["lease_intent", "prepared", "sent"].entries()) {
    const row = {
      schemaVersion: 2,
      sequence: 4 + index,
      phase,
      stage: "promote",
      handles: {
        fixtureNonce: nonce,
        projectId,
        principalId,
        candidateId,
        creationRunId: runId,
        stepRunId: runId,
      },
      steps: [{ stage: "feedback", currentRunId: runId, runId }],
      preparedCase,
      ...(phase === "sent"
        ? { sentCase: { caseId: spec.id, driverMessageId: recoveryMessageId, startedAt } }
        : {}),
      origin: f.record.origin,
      runId: f.record.runId,
      reportDirectory: f.record.reportDirectory,
    };
    f.record.rows.push({ ...row, checkpointSha256: digest(JSON.stringify(row)) });
  }
  f.record.pending = f.record.rows.at(-1);
  f.record.confirmedSequence = f.record.pending.sequence;
  f.auditEvents.push(
    {
      event: "lease_registered",
      marker: recoveryMarker,
      leaseId: recoveryLeaseId,
      principalId,
      scopeSha256: f.auditEvents[0].scopeSha256,
      toolsSha256,
    },
    {
      event: "run_bound",
      marker: recoveryMarker,
      leaseId: recoveryLeaseId,
      runId: recoveryRunId,
      principalId,
      scopeSha256: f.auditEvents[0].scopeSha256,
      toolsSha256,
      textSha256: digest(prompt),
      messageId: recoveryMessageId,
    },
  );
  f.eventsByRun[recoveryRunId] = [
    {
      runId: recoveryRunId,
      type: "message_received",
      externalId: recoveryMessageId,
      textSha256: digest(prompt),
      connectionId: scope.connectionId,
      botId: scope.botId,
      chatType: "private",
      chatId: scope.chatId,
      senderId: scope.senderId,
    },
    {
      runId: recoveryRunId,
      type: "session_start",
      data: {
        authorizedTools: ["owner_memory_admin"],
        acceptanceLease: {
          leaseId: recoveryLeaseId,
          marker: recoveryMarker,
          narrowedTools: ["owner_memory_admin"],
          toolsSha256,
        },
      },
    },
    {
      runId: recoveryRunId,
      type: "tool_call",
      toolCallId: "call-promote",
      data: {
        toolCallId: "call-promote",
        name: "owner_memory_admin",
        input: spec.leaseTools[0].operations[0].inputConstraint,
      },
    },
    {
      runId: recoveryRunId,
      type: "tool_result",
      toolCallId: "call-promote",
      data: { toolCallId: "call-promote", name: "owner_memory_admin", isError: false },
    },
    { runId: recoveryRunId, type: "run_finished", status: "failed" },
  ];
  return memoryId;
}

function addExpireRecovery(f) {
  const memoryId = addPromoteRecovery(f);
  const recoveryRunId = "run_expire_fixture";
  const recoveryMarker = "7".repeat(32);
  const recoveryLeaseId = "42345678-1234-1234-1234-123456789abc";
  const recoveryMessageId = "123459";
  const spec = memoryFixtureStep("expire", { nonce, candidateId, memoryId });
  const prompt = `GLASSBOX_ACCEPTANCE_V1 ${recoveryMarker}\n${spec.prompt.replaceAll("{{nonce}}", recoveryMarker)}`;
  const tools = JSON.parse(JSON.stringify(spec.leaseTools).replaceAll("{{nonce}}", recoveryMarker));
  const toolsSha256 = toolManifestDigest(tools);
  const startedAt = "2026-10-06T00:03:00.000Z";
  const preparedCase = {
    caseId: spec.id,
    marker: recoveryMarker,
    textSha256: digest(prompt),
    startedAt,
    route: "private",
    leaseId: recoveryLeaseId,
    expiresAt: Date.now() + 60_000,
    toolsSha256,
  };
  const recoveryHandles = {
    fixtureNonce: nonce,
    projectId,
    principalId,
    candidateId,
    creationRunId: runId,
    promoteRunId: "run_promote_fixture",
    memoryId,
  };
  f.realDb
    .prepare("INSERT INTO messages VALUES ('message-expire', ?, ?)")
    .run(recoveryMessageId, scopeKey);
  f.realDb
    .prepare("INSERT INTO runs VALUES (?, ?, 'failed', ?, 'message-expire')")
    .run(recoveryRunId, principalId, scopeJson);
  f.realDb.prepare("UPDATE memories SET lifecycle_state='expired' WHERE id=?").run(memoryId);
  f.realDb
    .prepare("INSERT INTO memory_audit_events VALUES (3,'audit-expire','expire',? ,?,?,?)")
    .run(
      memoryId,
      recoveryRunId,
      principalId,
      JSON.stringify([candidateId, `run:${recoveryRunId}`]),
    );
  const sourceRow = f.record.pending;
  for (const [index, phase] of ["lease_intent", "prepared", "sent", "observed"].entries()) {
    const recoveryPreparedCase =
      phase === "lease_intent"
        ? {
            caseId: spec.id,
            marker: recoveryMarker,
            textSha256: preparedCase.textSha256,
            startedAt,
            route: "private",
          }
        : preparedCase;
    const row = {
      ...sourceRow,
      sequence: sourceRow.sequence + index + 1,
      recoveryAttempt: {
        attemptId: "8".repeat(32),
        stage: "expire",
        phase,
        handles: recoveryHandles,
        preparedCase: recoveryPreparedCase,
        ...(phase === "sent" || phase === "observed"
          ? { sentCase: { caseId: spec.id, driverMessageId: recoveryMessageId, startedAt } }
          : {}),
        ...(phase === "observed" ? { cleanupRunId: recoveryRunId } : {}),
      },
    };
    delete row.checkpointSha256;
    row.checkpointSha256 = digest(JSON.stringify(row));
    f.record.rows.push(row);
  }
  f.record.pending = f.record.rows.at(-1);
  f.record.confirmedSequence = f.record.pending.sequence;
  f.auditEvents.push(
    {
      event: "lease_registered",
      marker: recoveryMarker,
      leaseId: recoveryLeaseId,
      principalId,
      scopeSha256: f.auditEvents[0].scopeSha256,
      toolsSha256,
    },
    {
      event: "run_bound",
      marker: recoveryMarker,
      leaseId: recoveryLeaseId,
      runId: recoveryRunId,
      principalId,
      scopeSha256: f.auditEvents[0].scopeSha256,
      toolsSha256,
      textSha256: digest(prompt),
      messageId: recoveryMessageId,
    },
  );
  f.eventsByRun[recoveryRunId] = [
    {
      runId: recoveryRunId,
      type: "message_received",
      externalId: recoveryMessageId,
      textSha256: digest(prompt),
      connectionId: scope.connectionId,
      botId: scope.botId,
      chatType: "private",
      chatId: scope.chatId,
      senderId: scope.senderId,
    },
    {
      runId: recoveryRunId,
      type: "session_start",
      data: {
        authorizedTools: ["owner_memory_admin"],
        acceptanceLease: {
          leaseId: recoveryLeaseId,
          marker: recoveryMarker,
          narrowedTools: ["owner_memory_admin"],
          toolsSha256,
        },
      },
    },
    {
      runId: recoveryRunId,
      type: "tool_call",
      toolCallId: "call-expire",
      data: {
        toolCallId: "call-expire",
        name: "owner_memory_admin",
        input: spec.leaseTools[0].operations[0].inputConstraint,
      },
    },
    {
      runId: recoveryRunId,
      type: "tool_result",
      toolCallId: "call-expire",
      data: { toolCallId: "call-expire", name: "owner_memory_admin", isError: false },
    },
    { runId: recoveryRunId, type: "run_finished", status: "failed" },
  ];
  return memoryId;
}

test("failed terminal Run with trace and SQL effect needs candidate cleanup", (t) => {
  const f = fixture(t);
  const result = observeMemoryRecovery(f.db, {
    record: f.record,
    auditEvents: f.auditEvents,
    eventsByRun: f.eventsByRun,
  });
  assert.deepEqual(result, {
    status: "NEEDS_CLEANUP",
    cleanupStage: "reject",
    handles: {
      projectId,
      principalId,
      candidateId,
      creationRunId: runId,
    },
  });
  assert.ok(f.sqlSeen.length > 0);
  const serialized = JSON.stringify(result);
  assert.doesNotMatch(serialized, /explicit_positive|qqtest-[a-f0-9]{32} explicit_positive/);
});

test("reconcile accepts the fixed schema 3 reject-family guard without changing the SQL target", (t) => {
  const f = fixture(t);
  const origin = { ...f.record.origin, familyId: MEMORY_REJECT_FAMILY_ID };
  const rows = f.record.rows.map((row) => ({ ...row, schemaVersion: 3, origin }));
  f.record = {
    ...f.record,
    origin,
    rows,
    pending: rows.at(-1),
  };
  const result = observeMemoryRecovery(f.db, {
    record: f.record,
    auditEvents: f.auditEvents,
    eventsByRun: f.eventsByRun,
  });
  assert.equal(result.status, "NEEDS_CLEANUP");
  assert.equal(result.cleanupStage, "reject");
  assert.equal(result.handles.candidateId, candidateId);
  assert.equal(result.handles.creationRunId, runId);
  assert.ok(f.sqlSeen.length > 0);
});

test("reconcile rejects a schema 3 guard with an unsupported family", (t) => {
  const f = fixture(t);
  const origin = { ...f.record.origin, familyId: "memory-project-arbitrary" };
  const rows = f.record.rows.map((row) => ({ ...row, schemaVersion: 3, origin }));
  f.record = { ...f.record, origin, rows, pending: rows.at(-1) };
  const result = observeMemoryRecovery(f.db, {
    record: f.record,
    auditEvents: f.auditEvents,
    eventsByRun: f.eventsByRun,
  });
  assert.equal(result.status, "INCONCLUSIVE");
});

test("reconcile rejects altered pending projections and schema 2 family metadata", (t) => {
  const f = fixture(t);
  f.record.pending = { ...f.record.pending, stage: "reject" };
  let result = observeMemoryRecovery(f.db, {
    record: f.record,
    auditEvents: f.auditEvents,
    eventsByRun: f.eventsByRun,
  });
  assert.equal(result.status, "INCONCLUSIVE");

  const second = fixture(t);
  second.record.origin.familyId = MEMORY_REJECT_FAMILY_ID;
  for (const row of second.record.rows) row.origin = second.record.origin;
  second.record.pending = second.record.rows.at(-1);
  result = observeMemoryRecovery(second.db, {
    record: second.record,
    auditEvents: second.auditEvents,
    eventsByRun: second.eventsByRun,
  });
  assert.equal(result.status, "INCONCLUSIVE");
});

test("missing fixture effect evidence never becomes CLEANED", (t) => {
  const f = fixture(t, { candidate: false });
  const result = observeMemoryRecovery(f.db, {
    record: f.record,
    auditEvents: f.auditEvents,
    eventsByRun: f.eventsByRun,
  });
  assert.equal(result.status, "INCONCLUSIVE");
  assert.notEqual(result.status, "CLEANED");
});

test("running and unknown Runs are never treated as terminal", (t) => {
  for (const status of ["running", "unknown"]) {
    const f = fixture(t);
    f.realDb.prepare("UPDATE runs SET status=? WHERE id=?").run(status, runId);
    f.eventsByRun[runId].at(-1).status = status;
    const result = observeMemoryRecovery(f.db, {
      record: f.record,
      auditEvents: f.auditEvents,
      eventsByRun: f.eventsByRun,
    });
    assert.equal(result.status, "INCONCLUSIVE", `${status} Run must not be terminal evidence`);
  }
});

test("a terminal database Run without run_finished trace is inconclusive", (t) => {
  const f = fixture(t);
  f.eventsByRun[runId] = f.eventsByRun[runId].filter((event) => event.type !== "run_finished");
  const result = observeMemoryRecovery(f.db, {
    record: f.record,
    auditEvents: f.auditEvents,
    eventsByRun: f.eventsByRun,
  });
  assert.equal(result.status, "INCONCLUSIVE");
});

test("terminal fixed recovery Run proves rejected candidate cleanup", (t) => {
  const f = fixture(t);
  addRejectRecovery(f);
  const result = observeMemoryRecovery(f.db, {
    record: f.record,
    auditEvents: f.auditEvents,
    eventsByRun: f.eventsByRun,
  });
  assert.deepEqual(result, {
    status: "CLEANED",
    cleanupStage: "reject",
    cleanupRunId: "run_reject_fixture",
    handles: {
      projectId,
      principalId,
      candidateId,
      creationRunId: runId,
      cleanupRunId: "run_reject_fixture",
    },
  });
});

test("recovery target candidate fills unknown feedback source handles and proves cleanup", (t) => {
  const f = fixture(t);
  addRejectRecovery(f);
  assert.equal(f.record.rows[2].handles.candidateId, undefined);
  assert.equal(f.record.pending.handles.candidateId, undefined);
  assert.equal(f.record.pending.recoveryAttempt.handles.candidateId, candidateId);
  const result = observeMemoryRecovery(f.db, {
    record: f.record,
    auditEvents: f.auditEvents,
    eventsByRun: f.eventsByRun,
  });
  assert.equal(result.status, "CLEANED");
  assert.equal(result.cleanupStage, "reject");
  assert.equal(result.cleanupRunId, "run_reject_fixture");
  assert.equal(result.handles.candidateId, candidateId);
});

test("cleanup Run with an extra tool call cannot prove CLEANED", (t) => {
  const f = fixture(t);
  addRejectRecovery(f);
  f.eventsByRun.run_reject_fixture.push({
    runId: "run_reject_fixture",
    type: "tool_call",
    toolCallId: "call-extra",
    data: {
      toolCallId: "call-extra",
      name: "owner_memory_admin",
      input: { action: "reject", id: candidateId },
    },
  });
  const result = observeMemoryRecovery(f.db, {
    record: f.record,
    auditEvents: f.auditEvents,
    eventsByRun: f.eventsByRun,
  });
  assert.equal(result.status, "INCONCLUSIVE");
});

test("cleanup Run with an unpaired tool result cannot prove CLEANED", (t) => {
  const f = fixture(t);
  addRejectRecovery(f);
  f.eventsByRun.run_reject_fixture = f.eventsByRun.run_reject_fixture.filter(
    (event) => event.type !== "tool_call",
  );
  const result = observeMemoryRecovery(f.db, {
    record: f.record,
    auditEvents: f.auditEvents,
    eventsByRun: f.eventsByRun,
  });
  assert.equal(result.status, "INCONCLUSIVE");
});

test("active Memory is classified for fixed expire cleanup after a failed Run", (t) => {
  const f = fixture(t);
  const memoryId = addPromoteRecovery(f);
  const result = observeMemoryRecovery(f.db, {
    record: f.record,
    auditEvents: f.auditEvents,
    eventsByRun: f.eventsByRun,
  });
  assert.deepEqual(result, {
    status: "NEEDS_CLEANUP",
    cleanupStage: "expire",
    handles: {
      projectId,
      principalId,
      candidateId,
      creationRunId: runId,
      memoryId,
      promoteRunId: "run_promote_fixture",
      stepRunId: runId,
    },
  });
});

test("recovery target Memory fills unknown Promote source handles and proves cleanup", (t) => {
  const f = fixture(t);
  const memoryId = addExpireRecovery(f);
  assert.equal(f.record.pending.handles.memoryId, undefined);
  assert.equal(f.record.pending.handles.promoteRunId, undefined);
  assert.equal(f.record.pending.recoveryAttempt.handles.memoryId, memoryId);
  const result = observeMemoryRecovery(f.db, {
    record: f.record,
    auditEvents: f.auditEvents,
    eventsByRun: f.eventsByRun,
  });
  assert.equal(result.status, "CLEANED", JSON.stringify(result));
  assert.equal(result.cleanupStage, "expire");
  assert.equal(result.cleanupRunId, "run_expire_fixture");
  assert.equal(result.handles.memoryId, memoryId);
  assert.equal(result.handles.promoteRunId, "run_promote_fixture");
});

test("known source target conflicts with recovery handles fail closed", (t) => {
  const f = fixture(t);
  addRejectRecovery(f);
  const conflictingCandidateId = `candidate_${"9".repeat(32)}`;
  for (const row of f.record.rows.slice(3)) {
    row.handles = { ...row.handles, candidateId: conflictingCandidateId };
    delete row.checkpointSha256;
    row.checkpointSha256 = digest(JSON.stringify(row));
  }
  f.record.pending = f.record.rows.at(-1);
  const result = observeMemoryRecovery(f.db, {
    record: f.record,
    auditEvents: f.auditEvents,
    eventsByRun: f.eventsByRun,
  });
  assert.equal(result.status, "INCONCLUSIVE");
});

test("cross-Owner Run binding is rejected", (t) => {
  const f = fixture(t);
  const wrongPrincipal = "other_owner";
  f.realDb.prepare("INSERT INTO principals VALUES (?, 'owner')").run(wrongPrincipal);
  f.realDb.prepare("UPDATE runs SET principal_id=? WHERE id=?").run(wrongPrincipal, runId);
  const result = observeMemoryRecovery(f.db, {
    record: f.record,
    auditEvents: f.auditEvents,
    eventsByRun: f.eventsByRun,
  });
  assert.equal(result.status, "INCONCLUSIVE");
});

test("extra tool call makes effect lineage inconclusive", (t) => {
  const f = fixture(t);
  f.eventsByRun[runId].push({
    runId,
    type: "tool_call",
    toolCallId: "call-2",
    data: {
      toolCallId: "call-2",
      name: "owner_memory_admin",
      input: { action: "reject", id: candidateId },
    },
  });
  const result = observeMemoryRecovery(f.db, {
    record: f.record,
    auditEvents: f.auditEvents,
    eventsByRun: f.eventsByRun,
  });
  assert.equal(result.status, "INCONCLUSIVE");
});
