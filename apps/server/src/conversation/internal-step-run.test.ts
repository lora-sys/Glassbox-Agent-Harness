import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { DomainDatabase } from "../persistence/database.js";
import { evaluate } from "../auth/service.js";
import { ConversationStore } from "./store.js";
import {
  identityKey,
  scopeKey,
  type CallerContext,
  type TrustedChannelScope,
} from "../identity/scope.js";

const scope: TrustedChannelScope = {
  connectionId: "local",
  botId: "bot",
  chatType: "group",
  chatId: "group-1",
  senderId: "owner-qq",
};
const caller: CallerContext = { principalId: "owner", scope };
const time = new Date().toISOString();
const leaseExpiry = new Date(Date.now() + 5 * 60_000).toISOString();
const stores: DomainDatabase[] = [];
const directories: string[] = [];

afterEach(async () => {
  for (const db of stores.splice(0)) await db.close();
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }).catch(
      (error: NodeJS.ErrnoException) => {
        if (process.platform !== "win32" || error.code !== "EBUSY") throw error;
      },
    );
});

async function fixture(path = ":memory:") {
  const db = await DomainDatabase.open(path);
  stores.push(db);
  const conversations = new ConversationStore(db);
  const convId = "conversation-1";
  await db.transaction(async (tx) => {
    await tx.execute({
      sql: "INSERT INTO agents(id,created_at) VALUES ('personal',?)",
      args: [time],
    });
    await tx.execute({
      sql: "INSERT INTO principals(id,kind,created_at) VALUES ('owner','owner',?)",
      args: [time],
    });
    await tx.execute({
      sql: "INSERT INTO channel_identities(identity_key,principal_id,created_at) VALUES (?,?,?)",
      args: [identityKey(scope), "owner", time],
    });
    await tx.execute(
      "INSERT INTO resources(id,kind,visibility) VALUES ('agent:personal','agent','public')",
    );
    await tx.execute(
      "INSERT INTO resources(id,kind,visibility,owner_id) VALUES ('conversation:1','conversation','public','owner')",
    );
    await tx.execute(
      "INSERT INTO resources(id,kind,visibility,owner_id) VALUES ('task-task-1','task','public','owner')",
    );
    for (const [id, resource, action] of [
      ["grant-run", "agent:personal", "run:create"],
      ["grant-conversation", "agent:personal", "conversation:read"],
      ["grant-control", "agent:personal", "run:control"],
      ["grant-task-continue", "task-task-1", "task:continue"],
      ["grant-task", "task-task-1", "task:read"],
    ]) {
      await tx.execute({
        sql: "INSERT INTO grants(id,principal_id,resource_id,action,scope_key,effect,created_at) VALUES (?,'owner',?,?,?,'allow',?)",
        args: [id, resource, action, scopeKey(scope), time],
      });
    }
    await tx.execute({
      sql: "INSERT INTO conversations(id,agent_id,principal_id,scope_key,scope_json,resource_id,created_at) VALUES (?,?,?,?,?,?,?)",
      args: [
        convId,
        "personal",
        "owner",
        JSON.stringify([scope.connectionId, scope.botId, scope.chatType, scope.chatId, null]),
        JSON.stringify(scope),
        "conversation:1",
        time,
      ],
    });
    await tx.execute({
      sql: "INSERT INTO conversation_locations(agent_id,location_key,conversation_id,created_at) VALUES (?,?,?,?)",
      args: [
        "personal",
        JSON.stringify([scope.connectionId, scope.botId, scope.chatType, scope.chatId, null]),
        convId,
        time,
      ],
    });
    await tx.execute({
      sql: "INSERT INTO tasks(id,title,status,priority,creator_principal_id,conversation_id,created_at,updated_at,orchestration_mode,origin_scope_key) VALUES ('task-1','Task','RUNNING','normal','owner',?,?,?,'durable',?)",
      args: [convId, time, time, scopeKey(scope)],
    });
    await tx.execute({
      sql: "INSERT INTO task_steps(id,task_id,kind,title,instructions,status,dependency_policy_json,max_attempts,required_capabilities_json,delegated_permissions_json,version,created_at,updated_at) VALUES ('step-1','task-1','model','Model step','Use these instructions','running','{}',1,'[]','[]',1,?,?)",
      args: [time, time],
    });
    await tx.execute({
      sql: "INSERT INTO task_attempts(id,task_id,attempt_number,status,started_at,step_id) VALUES ('attempt-1','task-1',1,'running',?,'step-1')",
      args: [time],
    });
    await tx.execute({
      sql: "INSERT INTO task_step_leases(id,task_id,step_id,attempt_id,owner_instance_id,state,version,acquired_at,heartbeat_at,expires_at) VALUES ('lease-1','task-1','step-1','attempt-1','worker-1','active',1,?,?,?)",
      args: [time, time, leaseExpiry],
    });
  });
  return { db, conversations };
}

describe("internal Task Step Runs", () => {
  it("creates an idempotent linked Run using Step instructions and survives database reopen", async () => {
    const directory = await mkdtemp(join(tmpdir(), "glassbox-internal-run-"));
    directories.push(directory);
    const path = join(directory, "agent.db");
    const { db, conversations } = await fixture(path);
    const first = await conversations.createInternalStepRun({
      caller,
      taskId: "task-1",
      stepId: "step-1",
      attemptId: "attempt-1",
      executionRef: "pi:default",
    });
    const second = await conversations.createInternalStepRun({
      caller,
      taskId: "task-1",
      stepId: "step-1",
      attemptId: "attempt-1",
      executionRef: "pi:default",
    });
    expect(first.source).toBe("task_step");
    expect(second.id).toBe(first.id);
    const input = await conversations.loadRunInput(caller, first.id);
    expect(input.text).toBe("Use these instructions");
    expect(input.history).toEqual([]);
    expect(input.taskStepBinding).toEqual({
      taskId: "task-1",
      stepId: "step-1",
      attemptId: "attempt-1",
    });
    expect((await conversations.listMessages(caller, first.conversationId)).items).toEqual([]);
    expect((await conversations.listRuns(caller, first.conversationId)).items).toEqual([]);
    await db.transaction(async (tx) => {
      const actions = await tx.execute({
        sql: "SELECT action FROM authorization_decisions WHERE run_id = ? AND decision = 'ALLOW'",
        args: [first.id],
      });
      expect(actions.rows.map((row) => row.action)).toEqual(
        expect.arrayContaining([
          "task:read",
          "task:continue",
          "run:create",
          "conversation:read",
          "run:control",
        ]),
      );
    });
    await db.close();
    stores.splice(stores.indexOf(db), 1);

    const reopened = await DomainDatabase.open(path);
    stores.push(reopened);
    const reopenedConversations = new ConversationStore(reopened);
    expect(await reopenedConversations.getInternalStepRun(caller, "attempt-1")).toMatchObject({
      id: first.id,
      source: "task_step",
    });
    await reopened.transaction(async (tx) => {
      expect(Number((await tx.execute("PRAGMA user_version")).rows[0]?.user_version)).toBe(15);
      expect(
        (await tx.execute("SELECT attempt_id,run_id,task_id,step_id FROM task_attempt_runs"))
          .rows[0],
      ).toMatchObject({
        attempt_id: "attempt-1",
        run_id: first.id,
        task_id: "task-1",
        step_id: "step-1",
      });
      expect(
        (await tx.execute({ sql: "SELECT source FROM runs WHERE id = ?", args: [first.id] }))
          .rows[0]?.source,
      ).toBe("task_step");
    });
  });

  it("requires current Task read permission to load an internal Run", async () => {
    const { db, conversations } = await fixture();
    const run = await conversations.createInternalStepRun({
      caller,
      taskId: "task-1",
      stepId: "step-1",
      attemptId: "attempt-1",
      executionRef: "pi:default",
    });
    await db.transaction((tx) =>
      tx.execute({ sql: "UPDATE grants SET revoked_at = ? WHERE id = 'grant-task'", args: [time] }),
    );
    await expect(conversations.getRun(caller, run.id)).rejects.toMatchObject({
      decision: { reason: "no_grant" },
    });
    await expect(conversations.loadRunInput(caller, run.id)).rejects.toMatchObject({
      decision: { reason: "no_grant" },
    });
  });

  it("creates a linked task_get Tool Run without loading Step instructions or conversation history", async () => {
    const { db, conversations } = await fixture();
    await db.transaction((tx) =>
      tx.execute({
        sql: "UPDATE task_steps SET kind = 'tool', spec_ref = 'tool:task_get:task-1', instructions = 'Do not load this text' WHERE id = 'step-1'",
      }),
    );
    const request = {
      caller,
      taskId: "task-1",
      stepId: "step-1",
      attemptId: "attempt-1",
      executionRef: "tool:task_get:task-1",
    };
    const first = await conversations.createInternalStepRun(request);
    expect((await conversations.createInternalStepRun(request)).id).toBe(first.id);
    expect(first).toMatchObject({ source: "task_step", status: "queued" });
    const input = await conversations.loadRunInput(caller, first.id);
    expect(input.text).toBe("");
    expect(input.history).toEqual([]);
    expect(input.taskStepBinding).toEqual({
      taskId: "task-1",
      stepId: "step-1",
      attemptId: "attempt-1",
    });
    expect((await conversations.listMessages(caller, first.conversationId)).items).toEqual([]);
    await db.transaction((tx) =>
      tx.execute({
        sql: "UPDATE task_steps SET kind = 'model', instructions = 'Changed instructions' WHERE id = 'step-1'",
      }),
    );
    await expect(conversations.loadRunInput(caller, first.id)).rejects.toMatchObject({
      decision: { reason: "scope_mismatch" },
    });
  });

  it("loads a bounded accepted Model dependency through current Run authorization", async () => {
    const { db, conversations } = await fixture();
    const sourceRun = await conversations.createInternalStepRun({
      caller,
      taskId: "task-1",
      stepId: "step-1",
      attemptId: "attempt-1",
      executionRef: "pi:default",
    });
    await db.transaction(async (tx) => {
      await tx.execute({
        sql: "UPDATE runs SET status = 'succeeded', result_text = ? WHERE id = ?",
        args: ["A".repeat(2_200), sourceRun.id],
      });
      await tx.execute({
        sql: "UPDATE task_steps SET status = 'succeeded', output_ref = ? WHERE id = 'step-1'",
        args: [`run:${sourceRun.id}`],
      });
      await tx.execute({
        sql: "INSERT INTO task_steps(id,task_id,kind,title,instructions,status,dependency_policy_json,max_attempts,required_capabilities_json,delegated_permissions_json,version,created_at,updated_at) VALUES ('step-2','task-1','model','Follow-up','Use the accepted result','running','{}',1,'[]','[]',1,?,?)",
        args: [time, time],
      });
      await tx.execute(
        "INSERT INTO task_step_dependencies(task_id,step_id,dependency_id) VALUES ('task-1','step-2','step-1')",
      );
      await tx.execute({
        sql: "INSERT INTO task_attempts(id,task_id,attempt_number,status,started_at,step_id) VALUES ('attempt-2','task-1',2,'running',?,'step-2')",
        args: [time],
      });
      await tx.execute({
        sql: "INSERT INTO task_step_leases(id,task_id,step_id,attempt_id,owner_instance_id,state,version,acquired_at,heartbeat_at,expires_at) VALUES ('lease-2','task-1','step-2','attempt-2','worker-1','active',1,?,?,?)",
        args: [time, time, leaseExpiry],
      });
    });
    const followUp = await conversations.createInternalStepRun({
      caller,
      taskId: "task-1",
      stepId: "step-2",
      attemptId: "attempt-2",
      executionRef: "pi:default",
    });
    const input = await conversations.loadRunInput(caller, followUp.id);
    expect(input.text).toBe("Use the accepted result");
    expect(input.stepResults).toEqual([
      { stepId: "step-1", runId: sourceRun.id, text: "A".repeat(2_048), truncated: true },
    ]);
    await db.transaction(async (tx) => {
      const decisions = await tx.execute({
        sql: "SELECT resource_id, action, delivery_source FROM authorization_decisions WHERE run_id = ? AND delivery_source = 'content_source'",
        args: [followUp.id],
      });
      expect(decisions.rows).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ resource_id: "task-task-1", action: "task:read" }),
        ]),
      );
      await tx.execute({
        sql: "UPDATE grants SET revoked_at = ? WHERE id = 'grant-task'",
        args: [time],
      });
    });
    await expect(conversations.loadRunInput(caller, followUp.id)).rejects.toMatchObject({
      decision: { reason: "no_grant" },
    });
  });

  it("loads an accepted task_get result only while the target Task grant remains current", async () => {
    const { db, conversations } = await fixture();
    await db.transaction(async (tx) => {
      await tx.execute(
        "INSERT INTO resources(id,kind,visibility,owner_id) VALUES ('task-task-2','task','public','owner')",
      );
      await tx.execute({
        sql: "INSERT INTO grants(id,principal_id,resource_id,action,scope_key,effect,created_at) VALUES ('grant-target','owner','task-task-2','task:read',?,'allow',?)",
        args: [scopeKey(scope), time],
      });
      await tx.execute({
        sql: "INSERT INTO tasks(id,title,status,priority,creator_principal_id,created_at,updated_at) VALUES ('task-2','Target','DONE','normal','owner',?,?)",
        args: [time, time],
      });
      await tx.execute(
        "UPDATE task_steps SET kind = 'tool', spec_ref = 'tool:task_get:task-2', instructions = NULL WHERE id = 'step-1'",
      );
    });
    const sourceRun = await conversations.createInternalStepRun({
      caller,
      taskId: "task-1",
      stepId: "step-1",
      attemptId: "attempt-1",
      executionRef: "tool:task_get:task-2",
    });
    const resultText = JSON.stringify({ id: "task-2", title: "Target", status: "DONE" });
    await db.transaction(async (tx) => {
      await tx.execute({
        sql: "UPDATE runs SET status = 'succeeded', result_text = ? WHERE id = ?",
        args: [resultText, sourceRun.id],
      });
      await tx.execute({
        sql: "UPDATE task_steps SET status = 'succeeded', output_ref = ? WHERE id = 'step-1'",
        args: [`run:${sourceRun.id}`],
      });
      await tx.execute({
        sql: "INSERT INTO task_steps(id,task_id,kind,title,instructions,status,dependency_policy_json,max_attempts,required_capabilities_json,delegated_permissions_json,version,created_at,updated_at) VALUES ('step-2','task-1','model','Follow-up','Use the target result','running','{}',1,'[]','[]',1,?,?)",
        args: [time, time],
      });
      await tx.execute(
        "INSERT INTO task_step_dependencies(task_id,step_id,dependency_id) VALUES ('task-1','step-2','step-1')",
      );
      await tx.execute({
        sql: "INSERT INTO task_attempts(id,task_id,attempt_number,status,started_at,step_id) VALUES ('attempt-2','task-1',2,'running',?,'step-2')",
        args: [time],
      });
      await tx.execute({
        sql: "INSERT INTO task_step_leases(id,task_id,step_id,attempt_id,owner_instance_id,state,version,acquired_at,heartbeat_at,expires_at) VALUES ('lease-2','task-1','step-2','attempt-2','worker-1','active',1,?,?,?)",
        args: [time, time, leaseExpiry],
      });
    });
    const followUp = await conversations.createInternalStepRun({
      caller,
      taskId: "task-1",
      stepId: "step-2",
      attemptId: "attempt-2",
      executionRef: "pi:default",
    });
    const input = await conversations.loadRunInput(caller, followUp.id);
    expect(input.stepResults).toEqual([
      { stepId: "step-1", runId: sourceRun.id, text: resultText, truncated: false },
    ]);
    await db.transaction(async (tx) => {
      const source = await tx.execute({
        sql: "SELECT resource_id, action FROM authorization_decisions WHERE run_id = ? AND delivery_source = 'content_source'",
        args: [followUp.id],
      });
      expect(source.rows).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ resource_id: "task-task-2", action: "task:read" }),
        ]),
      );
      await tx.execute({
        sql: "UPDATE grants SET revoked_at = ? WHERE id = 'grant-target'",
        args: [time],
      });
    });
    await expect(conversations.loadRunInput(caller, followUp.id)).rejects.toMatchObject({
      decision: { reason: "no_grant" },
    });
  });

  it("hands an accepted child Model result to its parent with source grants rechecked", async () => {
    const { db, conversations } = await fixture();
    await db.transaction(async (tx) => {
      for (const [id, kind] of [
        ["task-child-1", "task"],
        ["task-task-3", "task"],
      ])
        await tx.execute({
          sql: "INSERT INTO resources(id,kind,visibility,owner_id) VALUES (?,?,'public','owner')",
          args: [id, kind],
        });
      for (const [id, resource, action] of [
        ["grant-child-read", "task-child-1", "task:read"],
        ["grant-child-continue", "task-child-1", "task:continue"],
        ["grant-source", "task-task-3", "task:read"],
      ])
        await tx.execute({
          sql: "INSERT INTO grants(id,principal_id,resource_id,action,scope_key,effect,created_at) VALUES (?,'owner',?,?,?,'allow',?)",
          args: [id, resource, action, scopeKey(scope), time],
        });
      await tx.execute({
        sql: "INSERT INTO tasks(id,title,status,priority,creator_principal_id,conversation_id,created_at,updated_at,orchestration_mode,origin_scope_key,root_step_id) VALUES ('child-1','Child','RUNNING','normal','owner','conversation-1',?,?,'durable',?,'child-root')",
        args: [time, time, scopeKey(scope)],
      });
      await tx.execute({
        sql: "INSERT INTO task_steps(id,task_id,kind,title,instructions,status,dependency_policy_json,max_attempts,required_capabilities_json,delegated_permissions_json,version,created_at,updated_at) VALUES ('child-root','child-1','model','Child root','Summarize the result','running','{}',1,'[]','[]',1,?,?)",
        args: [time, time],
      });
      await tx.execute({
        sql: "INSERT INTO task_attempts(id,task_id,attempt_number,status,started_at,step_id) VALUES ('child-attempt','child-1',1,'running',?,'child-root')",
        args: [time],
      });
      await tx.execute({
        sql: "INSERT INTO task_step_leases(id,task_id,step_id,attempt_id,owner_instance_id,state,version,acquired_at,heartbeat_at,expires_at) VALUES ('child-lease','child-1','child-root','child-attempt','worker-1','active',1,?,?,?)",
        args: [time, time, leaseExpiry],
      });
      await tx.execute({
        sql: "UPDATE task_steps SET kind = 'child_task', instructions = NULL, status = 'succeeded', output_ref = 'task:child-1' WHERE id = 'step-1'",
      });
      await tx.execute({
        sql: "UPDATE task_attempts SET status = 'succeeded' WHERE id = 'attempt-1'",
      });
      await tx.execute({
        sql: "UPDATE task_step_leases SET state = 'released' WHERE id = 'lease-1'",
      });
      await tx.execute({
        sql: "INSERT INTO task_child_links(child_task_id,parent_task_id,parent_step_id,delegated_permissions_json,acceptance_criteria_json,cancel_policy,failure_policy,result_ref,created_at) VALUES ('child-1','task-1','step-1',?,'[\"Child result reviewed\"]','keep_child','block_parent','task:child-1',?)",
        args: [JSON.stringify([{ resourceId: "task-task-3", action: "task:read" }]), time],
      });
    });
    const childRun = await conversations.createInternalStepRun({
      caller,
      taskId: "child-1",
      stepId: "child-root",
      attemptId: "child-attempt",
      executionRef: "pi:default",
    });
    await db.transaction(async (tx) => {
      const decision = await evaluate(tx, {
        caller,
        resourceId: "task-task-3",
        action: "task:read",
        runId: childRun.id,
        conversationId: childRun.conversationId,
      });
      expect(decision.decision).toBe("ALLOW");
      await tx.execute({
        sql: "UPDATE authorization_decisions SET delivery_source = 'content_source' WHERE id = ?",
        args: [decision.id],
      });
      await tx.execute({
        sql: "UPDATE runs SET status = 'succeeded', result_text = 'Verified child finding' WHERE id = ?",
        args: [childRun.id],
      });
      await tx.execute({
        sql: "UPDATE task_steps SET status = 'succeeded', output_ref = ? WHERE id = 'child-root'",
        args: [`run:${childRun.id}`],
      });
      await tx.execute("UPDATE tasks SET status = 'DONE' WHERE id = 'child-1'");
      await tx.execute({
        sql: "INSERT INTO task_steps(id,task_id,kind,title,instructions,status,dependency_policy_json,max_attempts,required_capabilities_json,delegated_permissions_json,version,created_at,updated_at) VALUES ('step-2','task-1','model','Parent follow-up','Use the child result','running','{}',1,'[]','[]',1,?,?)",
        args: [time, time],
      });
      await tx.execute(
        "INSERT INTO task_step_dependencies(task_id,step_id,dependency_id) VALUES ('task-1','step-2','step-1')",
      );
      await tx.execute({
        sql: "INSERT INTO task_attempts(id,task_id,attempt_number,status,started_at,step_id) VALUES ('attempt-2','task-1',2,'running',?,'step-2')",
        args: [time],
      });
      await tx.execute({
        sql: "INSERT INTO task_step_leases(id,task_id,step_id,attempt_id,owner_instance_id,state,version,acquired_at,heartbeat_at,expires_at) VALUES ('lease-2','task-1','step-2','attempt-2','worker-1','active',1,?,?,?)",
        args: [time, time, leaseExpiry],
      });
    });
    const parentRun = await conversations.createInternalStepRun({
      caller,
      taskId: "task-1",
      stepId: "step-2",
      attemptId: "attempt-2",
      executionRef: "pi:default",
    });
    expect((await conversations.loadRunInput(caller, parentRun.id)).stepResults).toBeUndefined();
    await db.transaction((tx) =>
      tx.execute({
        sql: "INSERT INTO task_events(id,task_id,type,metadata_json,created_at) VALUES ('child-accepted','child-1','TASK_ACCEPTED','{}',?)",
        args: [time],
      }),
    );
    expect((await conversations.loadRunInput(caller, parentRun.id)).stepResults).toEqual([
      {
        stepId: "step-1",
        runId: childRun.id,
        text: "Verified child finding",
        truncated: false,
      },
    ]);
    await db.transaction(async (tx) => {
      const sources = await tx.execute({
        sql: "SELECT resource_id FROM authorization_decisions WHERE run_id = ? AND delivery_source = 'content_source'",
        args: [parentRun.id],
      });
      expect(sources.rows.map((row) => row.resource_id)).toEqual(
        expect.arrayContaining(["task-child-1", "task-task-3"]),
      );
      await tx.execute({
        sql: "UPDATE grants SET revoked_at = ? WHERE id = 'grant-source'",
        args: [time],
      });
    });
    await expect(conversations.loadRunInput(caller, parentRun.id)).rejects.toMatchObject({
      decision: { reason: "no_grant" },
    });
    await db.transaction(async (tx) => {
      await tx.execute("UPDATE grants SET revoked_at = NULL WHERE id = 'grant-source'");
      await tx.execute({
        sql: "UPDATE grants SET revoked_at = ? WHERE id = 'grant-child-read'",
        args: [time],
      });
    });
    await expect(conversations.loadRunInput(caller, parentRun.id)).rejects.toMatchObject({
      decision: { reason: "no_grant" },
    });
  });

  it("requires the persisted Tool Step kind, exact spec, and active Attempt lease", async () => {
    const { db, conversations } = await fixture();
    const request = {
      caller,
      taskId: "task-1",
      stepId: "step-1",
      attemptId: "attempt-1",
      executionRef: "tool:task_get:task-1",
    };
    await expect(conversations.createInternalStepRun(request)).rejects.toMatchObject({
      decision: { reason: "scope_mismatch" },
    });
    await db.transaction((tx) =>
      tx.execute({
        sql: "UPDATE task_steps SET kind = 'tool', spec_ref = 'tool:task_get:other-task' WHERE id = 'step-1'",
      }),
    );
    await expect(conversations.createInternalStepRun(request)).rejects.toMatchObject({
      decision: { reason: "scope_mismatch" },
    });
    await db.transaction((tx) =>
      tx.execute({
        sql: "UPDATE task_steps SET spec_ref = 'tool:task_get:task-1' WHERE id = 'step-1'",
      }),
    );
    await db.transaction((tx) =>
      tx.execute({ sql: "UPDATE task_step_leases SET state = 'released' WHERE id = 'lease-1'" }),
    );
    await expect(conversations.createInternalStepRun(request)).rejects.toMatchObject({
      decision: { reason: "scope_mismatch" },
    });
  });

  it("requires current Task continuation permission before creating a Run", async () => {
    const { db, conversations } = await fixture();
    await db.transaction((tx) =>
      tx.execute({
        sql: "UPDATE grants SET revoked_at = ? WHERE id = 'grant-task-continue'",
        args: [time],
      }),
    );
    await expect(
      conversations.createInternalStepRun({
        caller,
        taskId: "task-1",
        stepId: "step-1",
        attemptId: "attempt-1",
        executionRef: "pi:default",
      }),
    ).rejects.toMatchObject({ decision: { reason: "no_grant" } });
  });

  it("checks the child delegation boundary before admitting an internal Run", async () => {
    const { db, conversations } = await fixture();
    await db.transaction(async (tx) => {
      await tx.execute({
        sql: "INSERT INTO tasks(id,title,status,priority,creator_principal_id,conversation_id,created_at,updated_at,orchestration_mode,origin_scope_key) VALUES ('parent','Parent','RUNNING','normal','owner','conversation-1',?,?,'durable',?)",
        args: [time, time, scopeKey(scope)],
      });
      await tx.execute({
        sql: "INSERT INTO task_steps(id,task_id,kind,title,status,dependency_policy_json,max_attempts,required_capabilities_json,delegated_permissions_json,version,created_at,updated_at) VALUES ('parent-step','parent','child_task','Child','running','{}',1,'[]','[]',1,?,?)",
        args: [time, time],
      });
      await tx.execute(
        "INSERT INTO task_child_links(child_task_id,parent_task_id,parent_step_id,delegated_permissions_json,acceptance_criteria_json,cancel_policy,failure_policy,created_at) VALUES ('task-1','parent','parent-step','invalid','[]','keep_child','block_parent','now')",
      );
    });
    const input = {
      caller,
      taskId: "task-1",
      stepId: "step-1",
      attemptId: "attempt-1",
      executionRef: "pi:default",
    };
    await expect(conversations.createInternalStepRun(input)).rejects.toMatchObject({
      decision: { reason: "delegation_scope_denied" },
    });
    await db.transaction((tx) =>
      tx.execute(
        "UPDATE task_child_links SET delegated_permissions_json = '[]' WHERE child_task_id = 'task-1'",
      ),
    );
    expect((await conversations.createInternalStepRun(input)).source).toBe("task_step");
  });
});
