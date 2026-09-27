import { expect, it } from "vite-plus/test";
import { DomainDatabase } from "../persistence/database.js";
import { readLongWorkHealth } from "./long-work-health.js";

it("returns exact zero counts while backend availability remains unknown without bindings", async () => {
  const db = await DomainDatabase.open(":memory:");
  try {
    expect(await readLongWorkHealth(db, [])).toEqual({
      tasks: { active: 0, waiting: 0 },
      steps: { blocked: 0, ready: 0, running: 0, review: 0 },
      leases: { active: 0, quarantined: 0 },
      retries: 0,
      children: 0,
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

    const snapshot = await readLongWorkHealth(db, [
      "active",
      "waiting-input",
      "waiting-review",
      "child",
    ]);
    expect(snapshot).toEqual({
      tasks: { active: 2, waiting: 2 },
      steps: { blocked: 1, ready: 1, running: 1, review: 1 },
      leases: { active: 1, quarantined: 1 },
      retries: 1,
      children: 1,
      backend: { status: "unavailable", unavailableBindings: 1, observedBindings: 2 },
    });
    expect(JSON.stringify(snapshot)).not.toContain("private");
    expect((await readLongWorkHealth(db, [])).tasks).toEqual({ active: 0, waiting: 0 });
    expect((await readLongWorkHealth(db, ["active"])).tasks).toEqual({
      active: 1,
      waiting: 0,
    });
  } finally {
    await db.close();
  }
});

it("reports an evidenced zero unavailable bindings without claiming a live backend check", async () => {
  const db = await DomainDatabase.open(":memory:");
  try {
    await db.transaction(async (tx) => {
      await tx.execute("INSERT INTO principals(id,kind,created_at) VALUES ('owner','owner','now')");
      await tx.execute(
        "INSERT INTO tasks(id,title,status,priority,creator_principal_id,orchestration_mode,created_at,updated_at) VALUES ('task','private','RUNNING','normal','owner','durable','now','now')",
      );
      await tx.execute(
        "INSERT INTO task_workflow_bindings(task_id,workflow_id,backend,state,policy_revision,continuation,updated_at) VALUES ('task','workflow','temporal','running',1,0,'now')",
      );
    });

    expect((await readLongWorkHealth(db, ["task"])).backend).toEqual({
      status: "not_marked_unavailable",
      unavailableBindings: 0,
      observedBindings: 1,
    });
  } finally {
    await db.close();
  }
});
