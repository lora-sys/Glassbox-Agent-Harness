import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { DomainDatabase } from "../persistence/database.js";
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
      expect(Number((await tx.execute("PRAGMA user_version")).rows[0]?.user_version)).toBe(13);
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
});
