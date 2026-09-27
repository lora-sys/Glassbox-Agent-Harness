import { expect, it } from "vite-plus/test";
import { identityKey, scopeKey, type CallerContext } from "../identity/scope.js";
import { DomainDatabase } from "../persistence/database.js";
import { readLongWorkHealth } from "./long-work-health.js";

const caller: CallerContext = {
  principalId: "owner",
  scope: {
    connectionId: "health-test",
    botId: "health-bot",
    chatType: "private",
    chatId: "owner",
    senderId: "owner",
  },
};

it("returns exact zero counts while backend availability remains unknown without bindings", async () => {
  const db = await DomainDatabase.open(":memory:");
  try {
    expect(await readLongWorkHealth(db, [], caller)).toEqual({
      tasks: { active: 0, waiting: 0 },
      steps: { blocked: 0, ready: 0, running: 0, review: 0 },
      leases: { active: 0, quarantined: 0 },
      retries: 0,
      children: 0,
      durations: {
        retryDelay: { averageMs: null, samples: 0 },
        wait: { averageMs: null, samples: 0 },
        blocked: { averageMs: null, samples: 0 },
        reviewLatency: { averageMs: null, samples: 0 },
        taskCompletion: { averageMs: null, samples: 0 },
      },
      reworkCount: 0,
      workerReplacementCount: 0,
      historyTruncated: { tasks: false, waits: false, taskEvents: false },
      backend: { status: "unknown", unavailableBindings: null, observedBindings: 0 },
    });
  } finally {
    await db.close();
  }
});

it("aggregates durable work states without returning protected Task content", async () => {
  const db = await DomainDatabase.open(":memory:");
  try {
    await db.transaction(async (tx) => {
      await tx.execute("INSERT INTO principals(id,kind,created_at) VALUES ('owner','owner','now')");
      await tx.execute({
        sql: "INSERT INTO channel_identities(identity_key,principal_id,created_at) VALUES (?, 'owner','now')",
        args: [identityKey(caller.scope)],
      });
      for (const [id, status] of [
        ["active", "RUNNING"],
        ["waiting-input", "WAITING_INPUT"],
        ["waiting-review", "REVIEW"],
        ["child", "QUEUED"],
      ]) {
        await tx.execute({
          sql: "INSERT INTO tasks(id,title,description,status,priority,creator_principal_id,orchestration_mode,created_at,updated_at) VALUES (?, ?, ?, ?, 'normal','owner','durable','now','now')",
          args: [id, `private title ${id}`, "private description", status],
        });
      }
      for (const id of ["active", "waiting-input", "waiting-review", "child"]) {
        await tx.execute({
          sql: "INSERT INTO resources(id,kind,visibility,owner_id) VALUES (?, 'task','private','owner')",
          args: [`task-${id}`],
        });
        await tx.execute({
          sql: "INSERT INTO grants(id,principal_id,resource_id,action,scope_key,effect,created_at) VALUES (?, 'owner', ?, 'task:read', ?, 'allow','now')",
          args: [`read-${id}`, `task-${id}`, scopeKey(caller.scope)],
        });
      }
      await tx.execute(
        "INSERT INTO tasks(id,title,status,priority,creator_principal_id,created_at,updated_at) VALUES ('legacy','private legacy','RUNNING','normal','owner','now','now')",
      );
      for (const [id, taskId, status] of [
        ["blocked", "active", "blocked"],
        ["ready", "active", "ready"],
        ["running", "active", "running"],
        ["review", "active", "review"],
        ["parent-step", "active", "succeeded"],
      ]) {
        await tx.execute({
          sql: "INSERT INTO task_steps(id,task_id,kind,title,instructions,status,dependency_policy_json,max_attempts,required_capabilities_json,delegated_permissions_json,version,created_at,updated_at) VALUES (?, ?, 'model', ?, 'private instructions', ?, '{}', 3, '[]', '[]', 1, 'now','now')",
          args: [id, taskId, `private step ${id}`, status],
        });
      }
      await tx.execute({
        sql: "INSERT INTO task_step_leases(id,task_id,step_id,owner_instance_id,state,version,acquired_at,heartbeat_at,expires_at) VALUES ('active-lease','active','running','worker-a','active',1,'now','now','later')",
      });
      await tx.execute({
        sql: "INSERT INTO task_step_leases(id,task_id,step_id,owner_instance_id,state,version,acquired_at,heartbeat_at,expires_at) VALUES ('quarantined-lease','active','ready','worker-b','quarantined',1,'now','now','later')",
      });
      await tx.execute({
        sql: "INSERT INTO task_events(id,task_id,step_id,type,metadata_json,created_at) VALUES ('retry-event','active','running','RETRY_SCHEDULED','{}','now')",
      });
      await tx.execute({
        sql: "INSERT INTO task_child_links(child_task_id,parent_task_id,parent_step_id,delegated_permissions_json,acceptance_criteria_json,cancel_policy,failure_policy,created_at) VALUES ('child','active','parent-step','[]','[]','cancel_child','block_parent','now')",
      });
      await tx.execute({
        sql: "INSERT INTO task_workflow_bindings(task_id,workflow_id,backend,state,policy_revision,continuation,updated_at) VALUES ('active','workflow-active','temporal','running',1,0,'now')",
      });
      await tx.execute({
        sql: "INSERT INTO task_workflow_bindings(task_id,workflow_id,backend,state,policy_revision,continuation,updated_at) VALUES ('waiting-input','workflow-unavailable','temporal','unavailable',1,0,'now')",
      });
    });

    const snapshot = await readLongWorkHealth(
      db,
      ["active", "waiting-input", "waiting-review", "child"],
      caller,
    );
    expect(snapshot).toEqual({
      tasks: { active: 2, waiting: 2 },
      steps: { blocked: 1, ready: 1, running: 1, review: 1 },
      leases: { active: 1, quarantined: 1 },
      retries: 1,
      children: 1,
      durations: {
        retryDelay: { averageMs: null, samples: 0 },
        wait: { averageMs: null, samples: 0 },
        blocked: { averageMs: null, samples: 0 },
        reviewLatency: { averageMs: null, samples: 0 },
        taskCompletion: { averageMs: null, samples: 0 },
      },
      reworkCount: 0,
      workerReplacementCount: 0,
      historyTruncated: { tasks: false, waits: false, taskEvents: false },
      backend: { status: "unavailable", unavailableBindings: 1, observedBindings: 2 },
    });
    expect(JSON.stringify(snapshot)).not.toContain("private");
    expect((await readLongWorkHealth(db, [], caller)).tasks).toEqual({ active: 0, waiting: 0 });
    expect((await readLongWorkHealth(db, ["active"], caller)).tasks).toEqual({
      active: 1,
      waiting: 0,
    });
  } finally {
    await db.close();
  }
});

it("derives timestamp metrics only from task:read-authorized durable Tasks", async () => {
  const db = await DomainDatabase.open(":memory:");
  try {
    await db.transaction(async (tx) => {
      await tx.execute("INSERT INTO principals(id,kind,created_at) VALUES ('owner','owner','now')");
      await tx.execute({
        sql: "INSERT INTO channel_identities(identity_key,principal_id,created_at) VALUES (?, 'owner','now')",
        args: [identityKey(caller.scope)],
      });
      for (const id of ["visible", "denied"]) {
        await tx.execute({
          sql: `INSERT INTO tasks(id,title,status,priority,creator_principal_id,orchestration_mode,created_at,completed_at,updated_at)
            VALUES (?, 'private','DONE','normal','owner','durable','2026-01-01T00:00:00.000Z','2026-01-01T00:10:00.000Z','2026-01-01T00:10:00.000Z')`,
          args: [id],
        });
        await tx.execute({
          sql: "INSERT INTO task_steps(id,task_id,kind,title,status,dependency_policy_json,max_attempts,required_capabilities_json,delegated_permissions_json,version,created_at,updated_at) VALUES (?, ?, 'herdr_worker','private','blocked','{}',3,'[]','[]',1,'now','now')",
          args: [`step-${id}`, id],
        });
      }
      await tx.execute(
        "INSERT INTO resources(id,kind,visibility,owner_id) VALUES ('task-visible','task','private','owner')",
      );
      await tx.execute({
        sql: "INSERT INTO grants(id,principal_id,resource_id,action,scope_key,effect,created_at) VALUES ('read-visible','owner','task-visible','task:read',?,'allow','now')",
        args: [scopeKey(caller.scope)],
      });
      const events = [
        [
          "retry",
          "visible",
          "step-visible",
          "RETRY_SCHEDULED",
          "2026-01-01T00:01:00.000Z",
          JSON.stringify({ dueAt: "2026-01-01T00:01:05.000Z" }),
        ],
        ["blocked", "visible", "step-visible", "STEP_BLOCKED", "2026-01-01T00:02:00.000Z", "{}"],
        ["ready", "visible", "step-visible", "STEP_READY", "2026-01-01T00:02:10.000Z", "{}"],
        ["review-1", "visible", null, "TASK_REVIEW", "2026-01-01T00:03:00.000Z", "{}"],
        ["rework", "visible", null, "TASK_REWORK", "2026-01-01T00:03:20.000Z", "{}"],
        ["review-2", "visible", null, "TASK_REVIEW", "2026-01-01T00:04:00.000Z", "{}"],
        ["accepted", "visible", null, "TASK_ACCEPTED", "2026-01-01T00:04:30.000Z", "{}"],
        ["bound-1", "visible", "step-visible", "WORKER_BOUND", "2026-01-01T00:05:00.000Z", "{}"],
        ["bound-2", "visible", "step-visible", "WORKER_BOUND", "2026-01-01T00:05:10.000Z", "{}"],
        ["denied-rework", "denied", null, "TASK_REWORK", "2026-01-01T00:06:00.000Z", "{}"],
        ["denied-bound", "denied", "step-denied", "WORKER_BOUND", "2026-01-01T00:06:10.000Z", "{}"],
      ] as const;
      for (const [id, taskId, stepId, type, createdAt, metadata] of events) {
        await tx.execute({
          sql: "INSERT INTO task_events(id,task_id,step_id,type,metadata_json,created_at) VALUES (?,?,?,?,?,?)",
          args: [id, taskId, stepId, type, metadata, createdAt],
        });
      }
      await tx.execute({
        sql: "INSERT INTO task_waits(id,task_id,step_id,generation,kind,status,started_at,policy_json,updated_at) VALUES ('wait-visible','visible','step-visible',1,'signal','resumed','2026-01-01T00:06:00.000Z','{}','2026-01-01T00:06:15.000Z')",
      });
      await tx.execute({
        sql: "INSERT INTO task_waits(id,task_id,step_id,generation,kind,status,started_at,policy_json,updated_at) VALUES ('wait-denied','denied','step-denied',1,'signal','resumed','2026-01-01T00:06:00.000Z','{}','2026-01-01T00:07:00.000Z')",
      });
    });

    const snapshot = await readLongWorkHealth(db, ["visible", "denied"], caller);
    expect(snapshot.durations).toEqual({
      retryDelay: { averageMs: 5_000, samples: 1 },
      wait: { averageMs: 15_000, samples: 1 },
      blocked: { averageMs: 10_000, samples: 1 },
      reviewLatency: { averageMs: 25_000, samples: 2 },
      taskCompletion: { averageMs: 600_000, samples: 1 },
    });
    expect(snapshot.reworkCount).toBe(1);
    expect(snapshot.workerReplacementCount).toBe(1);
    expect(snapshot.historyTruncated).toEqual({ tasks: false, waits: false, taskEvents: false });
  } finally {
    await db.close();
  }
});

it("marks event-derived metrics unknown when the bounded event history is truncated", async () => {
  const db = await DomainDatabase.open(":memory:");
  try {
    await db.transaction(async (tx) => {
      await tx.execute("INSERT INTO principals(id,kind,created_at) VALUES ('owner','owner','now')");
      await tx.execute({
        sql: "INSERT INTO channel_identities(identity_key,principal_id,created_at) VALUES (?, 'owner','now')",
        args: [identityKey(caller.scope)],
      });
      await tx.execute(
        "INSERT INTO tasks(id,title,status,priority,creator_principal_id,orchestration_mode,created_at,completed_at,updated_at) VALUES ('bounded','private','DONE','normal','owner','durable','2026-01-01T00:00:00.000Z','2026-01-01T00:10:00.000Z','2026-01-01T00:10:00.000Z')",
      );
      await tx.execute(
        "INSERT INTO resources(id,kind,visibility,owner_id) VALUES ('task-bounded','task','private','owner')",
      );
      await tx.execute({
        sql: "INSERT INTO grants(id,principal_id,resource_id,action,scope_key,effect,created_at) VALUES ('read-bounded','owner','task-bounded','task:read',?,'allow','now')",
        args: [scopeKey(caller.scope)],
      });
      await tx.execute(`
        WITH RECURSIVE seq(value) AS (
          VALUES (1) UNION ALL SELECT value + 1 FROM seq WHERE value < 10001
        )
        INSERT INTO task_events(id,task_id,type,metadata_json,created_at)
        SELECT 'event-' || value, 'bounded',
          CASE WHEN value = 1 THEN 'RETRY_SCHEDULED' ELSE 'TASK_REWORK' END,
          CASE WHEN value = 1 THEN '{"dueAt":"2026-01-01T00:00:05.000Z"}' ELSE '{}' END,
          '2026-01-01T00:00:00.000Z'
        FROM seq
      `);
    });

    const snapshot = await readLongWorkHealth(db, ["bounded"], caller);
    expect(snapshot.tasks).toEqual({ active: 0, waiting: 0 });
    expect(snapshot.retries).toBe(1);
    expect(snapshot.historyTruncated).toEqual({ tasks: false, waits: false, taskEvents: true });
    expect(snapshot.durations.retryDelay).toEqual({ averageMs: null, samples: null });
    expect(snapshot.durations.blocked).toEqual({ averageMs: null, samples: null });
    expect(snapshot.durations.reviewLatency).toEqual({ averageMs: null, samples: null });
    expect(snapshot.reworkCount).toBeNull();
    expect(snapshot.workerReplacementCount).toBeNull();
    expect(snapshot.durations.taskCompletion).toEqual({ averageMs: 600_000, samples: 1 });
  } finally {
    await db.close();
  }
});

it("reports an evidenced zero unavailable bindings without claiming a live backend check", async () => {
  const db = await DomainDatabase.open(":memory:");
  try {
    await db.transaction(async (tx) => {
      await tx.execute("INSERT INTO principals(id,kind,created_at) VALUES ('owner','owner','now')");
      await tx.execute({
        sql: "INSERT INTO channel_identities(identity_key,principal_id,created_at) VALUES (?, 'owner','now')",
        args: [identityKey(caller.scope)],
      });
      await tx.execute(
        "INSERT INTO tasks(id,title,status,priority,creator_principal_id,orchestration_mode,created_at,updated_at) VALUES ('task','private','RUNNING','normal','owner','durable','now','now')",
      );
      await tx.execute(
        "INSERT INTO task_workflow_bindings(task_id,workflow_id,backend,state,policy_revision,continuation,updated_at) VALUES ('task','workflow','temporal','running',1,0,'now')",
      );
      await tx.execute(
        "INSERT INTO resources(id,kind,visibility,owner_id) VALUES ('task-task','task','private','owner')",
      );
      await tx.execute({
        sql: "INSERT INTO grants(id,principal_id,resource_id,action,scope_key,effect,created_at) VALUES ('read-task','owner','task-task','task:read',?,'allow','now')",
        args: [scopeKey(caller.scope)],
      });
    });

    expect((await readLongWorkHealth(db, ["task"], caller)).backend).toEqual({
      status: "not_marked_unavailable",
      unavailableBindings: 0,
      observedBindings: 1,
    });
  } finally {
    await db.close();
  }
});

it("rechecks task:read when candidate health IDs outlive a grant", async () => {
  const db = await DomainDatabase.open(":memory:");
  try {
    await db.transaction(async (tx) => {
      await tx.execute("INSERT INTO principals(id,kind,created_at) VALUES ('owner','owner','now')");
      await tx.execute({
        sql: "INSERT INTO channel_identities(identity_key,principal_id,created_at) VALUES (?, 'owner','now')",
        args: [identityKey(caller.scope)],
      });
      await tx.execute(
        "INSERT INTO tasks(id,title,status,priority,creator_principal_id,orchestration_mode,created_at,updated_at) VALUES ('private-task','private','RUNNING','normal','owner','durable','now','now')",
      );
      await tx.execute(
        "INSERT INTO task_steps(id,task_id,kind,title,instructions,status,dependency_policy_json,max_attempts,required_capabilities_json,delegated_permissions_json,version,created_at,updated_at) VALUES ('private-step','private-task','model','private step','private instructions','blocked','{}',3,'[]','[]',1,'now','now')",
      );
      await tx.execute(
        "INSERT INTO resources(id,kind,visibility,owner_id) VALUES ('task-private-task','task','private','owner')",
      );
      await tx.execute({
        sql: "INSERT INTO grants(id,principal_id,resource_id,action,scope_key,effect,created_at) VALUES ('private-read','owner','task-private-task','task:read',?,'allow','now')",
        args: [scopeKey(caller.scope)],
      });
    });

    expect((await readLongWorkHealth(db, ["private-task"], caller)).tasks.active).toBe(1);
    expect(
      (
        await readLongWorkHealth(db, ["private-task"], {
          ...caller,
          scope: { ...caller.scope, chatId: "other-chat" },
        })
      ).tasks.active,
    ).toBe(0);
    await db.transaction((tx) =>
      tx.execute("UPDATE grants SET revoked_at = 'now' WHERE id = 'private-read'"),
    );
    expect(await readLongWorkHealth(db, ["private-task"], caller)).toMatchObject({
      tasks: { active: 0, waiting: 0 },
      steps: { blocked: 0, ready: 0, running: 0, review: 0 },
    });
  } finally {
    await db.close();
  }
});
