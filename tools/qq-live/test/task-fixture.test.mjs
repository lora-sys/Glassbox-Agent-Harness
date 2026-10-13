import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { observeTaskFixture } from "../lib/task-fixture.mjs";
import { taskFixtureStep } from "../lib/task-scenario.mjs";

const nonce = "1".repeat(32);
const taskId = "123e4567-e89b-42d3-a456-426614174000";
const principalId = "owner-1";
const createRun = "run-create";
const inspectRun = "run-inspect";
const cancelRun = "run-cancel";
const scope = {
  connectionId: "qq-connection",
  botId: "bot-1",
  chatType: "private",
  chatId: "owner-qq",
  senderId: "owner-qq",
};
const scopeKey = JSON.stringify([
  scope.connectionId,
  scope.botId,
  scope.chatType,
  scope.chatId,
  scope.senderId,
  null,
]);

function makeDb() {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE runs (id TEXT PRIMARY KEY, principal_id TEXT NOT NULL, scope_json TEXT NOT NULL);
    CREATE TABLE principals (id TEXT PRIMARY KEY, kind TEXT NOT NULL);
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT, status TEXT NOT NULL,
      priority TEXT NOT NULL, creator_principal_id TEXT NOT NULL, conversation_id TEXT,
      run_id TEXT, active_attempt_id TEXT, acceptance_criteria_json TEXT,
      origin_scope_key TEXT, origin_scope_json TEXT, orchestration_mode TEXT NOT NULL,
      cancellation_state TEXT NOT NULL
    );
    CREATE TABLE ops_trace_events (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL UNIQUE,
      ts TEXT NOT NULL, type TEXT NOT NULL, task_id TEXT, task_attempt_id TEXT,
      run_id TEXT, principal_id TEXT, data_json TEXT NOT NULL
    );
    CREATE TABLE authorization_decisions (
      id TEXT PRIMARY KEY, principal_id TEXT, resource_id TEXT NOT NULL, action TEXT NOT NULL,
      scope_key TEXT NOT NULL, decision TEXT NOT NULL, reason TEXT NOT NULL,
      grant_id TEXT, approval_id TEXT, conversation_id TEXT, run_id TEXT,
      delivery_source TEXT, created_at TEXT NOT NULL
    );
    CREATE TABLE authorization_decisions_archive (
      id TEXT PRIMARY KEY, principal_id TEXT, resource_id TEXT NOT NULL, action TEXT NOT NULL,
      scope_key TEXT NOT NULL, decision TEXT NOT NULL, reason TEXT NOT NULL,
      grant_id TEXT, approval_id TEXT, conversation_id TEXT, run_id TEXT,
      delivery_source TEXT, created_at TEXT NOT NULL
    );
    CREATE VIEW authorization_decisions_all AS
      SELECT * FROM authorization_decisions UNION ALL SELECT * FROM authorization_decisions_archive;
    CREATE TABLE task_attempts (id TEXT PRIMARY KEY, task_id TEXT NOT NULL);
    CREATE TABLE task_steps (id TEXT PRIMARY KEY, task_id TEXT NOT NULL);
    CREATE TABLE task_workflow_bindings (task_id TEXT PRIMARY KEY);
    CREATE TABLE task_attempt_runs (attempt_id TEXT PRIMARY KEY, task_id TEXT NOT NULL);
    CREATE TABLE task_child_links (child_task_id TEXT PRIMARY KEY, parent_task_id TEXT NOT NULL);
    CREATE TABLE attention_items (id TEXT PRIMARY KEY, task_id TEXT, resolved_at TEXT);
    CREATE TABLE durable_continuation_schedules (id TEXT PRIMARY KEY, target_kind TEXT, target_id TEXT);
    CREATE TABLE durable_continuation_occurrences (id TEXT PRIMARY KEY, target_kind TEXT, target_id TEXT);
    CREATE TABLE durable_continuation_events (id TEXT PRIMARY KEY, target_kind TEXT, target_id TEXT);
  `);

  for (const runId of [createRun, inspectRun, cancelRun]) {
    db.prepare("INSERT INTO runs(id,principal_id,scope_json) VALUES (?,?,?)").run(
      runId,
      principalId,
      JSON.stringify(scope),
    );
  }
  db.prepare("INSERT INTO principals(id,kind) VALUES (?, 'owner')").run(principalId);
  const spec = taskFixtureStep("create", { nonce });
  const expected = spec.leaseTools[0].operations[0].inputConstraint;
  db.prepare(`INSERT INTO tasks(
    id,title,description,status,priority,creator_principal_id,conversation_id,run_id,
    active_attempt_id,acceptance_criteria_json,origin_scope_key,origin_scope_json,
    orchestration_mode,cancellation_state
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    taskId,
    expected.title,
    expected.description,
    "NEW",
    "normal",
    principalId,
    "conversation-1",
    createRun,
    null,
    JSON.stringify(expected.acceptanceCriteria),
    scopeKey,
    JSON.stringify(scope),
    "legacy",
    "none",
  );
  db.prepare(`INSERT INTO ops_trace_events(event_id,ts,type,task_id,run_id,principal_id,data_json)
    VALUES (?,?,?,?,?,?,?)`).run(
    "event-created",
    "2026-10-06T00:00:00.000Z",
    "task.created",
    taskId,
    createRun,
    principalId,
    JSON.stringify({
      title: expected.title,
      priority: "normal",
      status: "NEW",
      acceptanceCriteria: expected.acceptanceCriteria,
    }),
  );
  for (const [runId, resourceId, action] of [
    [createRun, "agent-operations", "task:create"],
    [inspectRun, `task-${taskId}`, "task:read"],
    [cancelRun, `task-${taskId}`, "task:cancel"],
  ]) {
    db.prepare(`INSERT INTO authorization_decisions(
      id,principal_id,resource_id,action,scope_key,decision,reason,run_id,created_at
    ) VALUES (?,?,?,?,?,'ALLOW','test',?,?)`).run(
      `decision-${action}`,
      principalId,
      resourceId,
      action,
      scopeKey,
      runId,
      "2026-10-06T00:00:00.000Z",
    );
  }
  return db;
}

function observe(db, stage, overrides = {}) {
  return observeTaskFixture(db, {
    stage,
    fixtureNonce: nonce,
    principalId,
    scope,
    creationRunId: createRun,
    inspectRunId: inspectRun,
    stepRunId: stage === "create" ? createRun : stage === "inspect" ? inspectRun : cancelRun,
    taskId,
    ...overrides,
  });
}

test("discovers one fixed NEW Task from its Owner-private creation Run", () => {
  const db = makeDb();
  try {
    const observed = observe(db, "create");
    assert.deepEqual(observed, {
      stage: "create",
      taskId,
      status: "NEW",
      principalId,
      creationRunId: createRun,
      stepRunId: createRun,
    });
    assert.equal(Object.hasOwn(observed, "description"), false);
  } finally {
    db.close();
  }
});

test("inspection confirms immutable origin and leaves the Task NEW", () => {
  const db = makeDb();
  try {
    assert.deepEqual(observe(db, "inspect"), {
      stage: "inspect",
      taskId,
      status: "NEW",
      principalId,
      creationRunId: createRun,
      stepRunId: inspectRun,
    });
  } finally {
    db.close();
  }
});

test("cancellation needs a distinct Owner Run, matching audit, and ALLOW decision", () => {
  const db = makeDb();
  try {
    db.prepare("UPDATE tasks SET status='CANCELED' WHERE id=?").run(taskId);
    db.prepare(`INSERT INTO ops_trace_events(event_id,ts,type,task_id,run_id,principal_id,data_json)
      VALUES (?,?,?,?,?,?,?)`).run(
      "event-canceled",
      "2026-10-06T00:01:00.000Z",
      "task.canceled",
      taskId,
      cancelRun,
      principalId,
      JSON.stringify({ reason: "fixture cleanup" }),
    );
    assert.deepEqual(observe(db, "cancel"), {
      stage: "cancel",
      taskId,
      status: "CANCELED",
      principalId,
      creationRunId: createRun,
      stepRunId: cancelRun,
    });
  } finally {
    db.close();
  }
});

test("rejects duplicate or mismatched task origin, audit, and authorization evidence", () => {
  const mutations = [
    (db) => db.prepare("UPDATE tasks SET creator_principal_id='other' WHERE id=?").run(taskId),
    (db) => db.prepare("UPDATE tasks SET run_id='run-inspect' WHERE id=?").run(taskId),
    (db) => db.prepare("UPDATE tasks SET origin_scope_key='elsewhere' WHERE id=?").run(taskId),
    (db) => db.prepare("UPDATE runs SET principal_id='other' WHERE id=?").run(createRun),
    (db) => db.prepare("UPDATE principals SET kind='user' WHERE id=?").run(principalId),
    (db) => db.prepare("UPDATE runs SET scope_json='{}' WHERE id=?").run(createRun),
    (db) => db.prepare("UPDATE tasks SET origin_scope_json='{}' WHERE id=?").run(taskId),
    (db) =>
      db
        .prepare("UPDATE ops_trace_events SET run_id='run-inspect' WHERE event_id='event-created'")
        .run(),
    (db) =>
      db
        .prepare("UPDATE authorization_decisions SET decision='DENY' WHERE action='task:create'")
        .run(),
    (db) => db.prepare("UPDATE tasks SET title='different' WHERE id=?").run(taskId),
    (db) => db.prepare("UPDATE tasks SET priority='high' WHERE id=?").run(taskId),
    (db) => db.prepare("UPDATE tasks SET acceptance_criteria_json='[]' WHERE id=?").run(taskId),
    (db) => db.prepare("UPDATE tasks SET orchestration_mode='durable' WHERE id=?").run(taskId),
    (db) => db.prepare("UPDATE tasks SET cancellation_state='requested' WHERE id=?").run(taskId),
    (db) =>
      db
        .prepare(
          "INSERT INTO tasks(id,title,status,priority,creator_principal_id,run_id,orchestration_mode,cancellation_state) VALUES('other-task','other','NEW','normal',?,?,'legacy','none')",
        )
        .run(principalId, createRun),
  ];
  for (const mutate of mutations) {
    const db = makeDb();
    try {
      mutate(db);
      assert.throws(() => observe(db, "create"), { code: "TASK_FIXTURE_EVIDENCE" });
    } finally {
      db.close();
    }
  }
});

test("rejects inspect drift and cancellation without all independent proofs", () => {
  const cases = [
    {
      stage: "inspect",
      mutate: (db) => db.prepare("UPDATE tasks SET status='QUEUED' WHERE id=?").run(taskId),
    },
    {
      stage: "inspect",
      mutate: (db) =>
        db
          .prepare("UPDATE authorization_decisions SET decision='DENY' WHERE action='task:read'")
          .run(),
    },
    {
      stage: "cancel",
      mutate: (db) => db.prepare("UPDATE tasks SET status='CANCELED' WHERE id=?").run(taskId),
    },
    {
      stage: "cancel",
      mutate: (db) => {
        db.prepare("UPDATE tasks SET status='CANCELED' WHERE id=?").run(taskId);
        db.prepare(`INSERT INTO ops_trace_events(event_id,ts,type,task_id,run_id,principal_id,data_json)
          VALUES ('event-canceled','2026-10-06T00:01:00.000Z','task.canceled',?,?,?, '{}')`).run(
          taskId,
          inspectRun,
          principalId,
        );
      },
    },
    {
      stage: "cancel",
      mutate: (db) => {
        db.prepare("UPDATE tasks SET status='CANCELED' WHERE id=?").run(taskId);
        db.prepare(`INSERT INTO ops_trace_events(event_id,ts,type,task_id,run_id,principal_id,data_json)
          VALUES ('event-canceled','2026-10-06T00:01:00.000Z','task.canceled',?,?,?, '{}')`).run(
          taskId,
          createRun,
          "other",
        );
      },
    },
    {
      stage: "cancel",
      mutate: (db) => {
        db.prepare("UPDATE tasks SET status='CANCELED' WHERE id=?").run(taskId);
        db.prepare(`INSERT INTO ops_trace_events(event_id,ts,type,task_id,run_id,principal_id,data_json)
          VALUES ('event-canceled','2026-10-06T00:01:00.000Z','task.canceled',?,?,?, '{}')`).run(
          taskId,
          cancelRun,
          principalId,
        );
        db.prepare(
          "UPDATE authorization_decisions SET decision='DENY' WHERE action='task:cancel'",
        ).run();
      },
    },
    {
      stage: "cancel",
      mutate: (db) => {
        db.prepare("UPDATE tasks SET status='CANCELED' WHERE id=?").run(taskId);
        db.prepare(`INSERT INTO ops_trace_events(event_id,ts,type,task_id,run_id,principal_id,data_json)
          VALUES ('event-canceled','2026-10-06T00:01:00.000Z','task.canceled',?,?,?, '{}')`).run(
          taskId,
          cancelRun,
          principalId,
        );
        db.prepare("INSERT INTO task_attempts(id,task_id) VALUES('attempt-1',?)").run(taskId);
      },
    },
    {
      stage: "cancel",
      mutate: (db) => {
        db.prepare("UPDATE tasks SET status='CANCELED' WHERE id=?").run(taskId);
        db.prepare(`INSERT INTO ops_trace_events(event_id,ts,type,task_id,run_id,principal_id,data_json)
          VALUES ('event-canceled','2026-10-06T00:01:00.000Z','task.canceled',?,?,?, '{}')`).run(
          taskId,
          cancelRun,
          principalId,
        );
        db.prepare(
          "INSERT INTO durable_continuation_schedules(id,target_kind,target_id) VALUES('schedule-1','task',?)",
        ).run(taskId);
      },
    },
    {
      stage: "cancel",
      mutate: (db) => {
        db.prepare("UPDATE tasks SET status='CANCELED' WHERE id=?").run(taskId);
        db.prepare(`INSERT INTO ops_trace_events(event_id,ts,type,task_id,run_id,principal_id,data_json)
          VALUES ('event-canceled','2026-10-06T00:01:00.000Z','task.canceled',?,?,?, '{}')`).run(
          taskId,
          cancelRun,
          principalId,
        );
        db.prepare(
          "INSERT INTO attention_items(id,task_id,resolved_at) VALUES('attention-1',?,NULL)",
        ).run(taskId);
      },
    },
  ];
  for (const { stage, mutate } of cases) {
    const db = makeDb();
    try {
      mutate(db);
      assert.throws(() => observe(db, stage), { code: "TASK_FIXTURE_EVIDENCE" });
    } finally {
      db.close();
    }
  }
});

test("does not accept an inspection or cancellation in the creation Run", () => {
  const db = makeDb();
  try {
    assert.throws(() => observe(db, "cancel", { stepRunId: createRun }), {
      code: "TASK_FIXTURE_EVIDENCE",
    });
  } finally {
    db.close();
  }
});

test("cancellation requires a third Owner-private Run after successful inspection", () => {
  const db = makeDb();
  try {
    db.prepare("UPDATE tasks SET status='CANCELED' WHERE id=?").run(taskId);
    db.prepare(`INSERT INTO ops_trace_events(event_id,ts,type,task_id,run_id,principal_id,data_json)
      VALUES (?,?,?,?,?,?,?)`).run(
      "event-canceled",
      "2026-10-06T00:01:00.000Z",
      "task.canceled",
      taskId,
      inspectRun,
      principalId,
      JSON.stringify({ reason: "fixture cleanup" }),
    );
    db.prepare(`INSERT INTO authorization_decisions(
      id,principal_id,resource_id,action,scope_key,decision,reason,run_id,created_at
    ) VALUES('decision-cancel-on-inspect',?,?, 'task:cancel',?,'ALLOW','test',?,'2026-10-06T00:00:00.000Z')`).run(
      principalId,
      `task-${taskId}`,
      scopeKey,
      inspectRun,
    );
    assert.throws(() => observe(db, "cancel", { stepRunId: inspectRun }), {
      code: "TASK_FIXTURE_EVIDENCE",
    });
    assert.throws(() => observe(db, "cancel", { inspectRunId: "missing-inspect-run" }), {
      code: "TASK_FIXTURE_EVIDENCE",
    });
  } finally {
    db.close();
  }
});

test("cancellation observer requires Owner-scoped successful task:read evidence", () => {
  for (const mutate of [
    (db) =>
      db
        .prepare("UPDATE authorization_decisions SET decision='DENY' WHERE action='task:read'")
        .run(),
    (db) => db.prepare("UPDATE runs SET principal_id='other' WHERE id=?").run(inspectRun),
    (db) => db.prepare("UPDATE runs SET scope_json='{}' WHERE id=?").run(inspectRun),
  ]) {
    const db = makeDb();
    try {
      db.prepare("UPDATE tasks SET status='CANCELED' WHERE id=?").run(taskId);
      db.prepare(`INSERT INTO ops_trace_events(event_id,ts,type,task_id,run_id,principal_id,data_json)
        VALUES ('event-canceled','2026-10-06T00:01:00.000Z','task.canceled',?,?,?, '{}')`).run(
        taskId,
        cancelRun,
        principalId,
      );
      mutate(db);
      assert.throws(() => observe(db, "cancel"), { code: "TASK_FIXTURE_EVIDENCE" });
    } finally {
      db.close();
    }
  }
});
