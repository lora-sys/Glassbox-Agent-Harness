import { expect, it } from "vite-plus/test";
import { taskPolicyResourceId } from "../auth/task-policy.js";
import { identityKey, scopeKey, type CallerContext } from "../identity/scope.js";
import { DomainDatabase } from "../persistence/database.js";
import { TaskStore } from "./task-store.js";

it("projects more than 1000 authorized tasks without per-task decisions or bind parameters", async () => {
  const db = await DomainDatabase.open(":memory:");
  const caller: CallerContext = {
    principalId: "owner",
    scope: {
      connectionId: "connection",
      botId: "bot",
      chatType: "private",
      chatId: "owner",
      senderId: "owner",
    },
  };
  const key = scopeKey(caller.scope);
  const policy = taskPolicyResourceId(caller);
  try {
    await db.transaction(async (tx) => {
      await tx.execute(
        "INSERT INTO principals(id, kind, created_at) VALUES ('owner', 'owner', 'now')",
      );
      await tx.execute({
        sql: "INSERT INTO channel_identities(identity_key, principal_id, created_at) VALUES (?, 'owner', 'now')",
        args: [identityKey(caller.scope)],
      });
      await tx.execute({
        sql: "INSERT INTO resources(id, kind, visibility) VALUES (?, 'task-policy', 'public')",
        args: [policy],
      });
      await tx.execute({
        sql: "INSERT INTO grants(id, principal_id, resource_id, action, scope_key, effect, created_at) VALUES ('policy-grant', 'owner', ?, 'task:read', ?, 'allow', 'now')",
        args: [policy, key],
      });
      await tx.execute({
        sql: `WITH RECURSIVE nums(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM nums WHERE n < 1100)
          INSERT INTO tasks(id, title, status, priority, creator_principal_id, origin_scope_key, created_at, updated_at)
          SELECT 'task-' || n, 'Task', 'NEW', 'normal', 'owner', ?, 'now', 'now' FROM nums`,
        args: [key],
      });
      await tx.execute(`WITH RECURSIVE nums(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM nums WHERE n < 1100)
        INSERT INTO resources(id, kind, visibility) SELECT 'task-task-' || n, 'task', 'public' FROM nums`);
    });
    const tasks = new TaskStore(db);
    expect(await tasks.listTasks({ caller })).toHaveLength(1100);
    expect((await tasks.getOpsHealthRecords(caller)).tasks).toHaveLength(1100);
    expect((await tasks.getOpsSnapshot(caller)).tasks.open).toBe(1100);
    await db.transaction(async (tx) => {
      expect(
        (await tx.execute("SELECT COUNT(*) AS count FROM authorization_decisions")).rows[0]?.count,
      ).toBe(0);
      await tx.execute({
        sql: "INSERT INTO grants(id, principal_id, resource_id, action, scope_key, effect, created_at) VALUES ('approval', 'owner', 'task-task-1', 'task:read', ?, 'approval', 'now')",
        args: [key],
      });
    });
    expect(await tasks.listTasks({ caller })).toHaveLength(1099);
    await db.transaction((tx) =>
      tx.execute({
        sql: "INSERT INTO grants(id, principal_id, resource_id, action, scope_key, effect, created_at) VALUES ('explicit-allow', 'owner', 'task-task-1', 'task:read', ?, 'allow', 'now')",
        args: [key],
      }),
    );
    expect(await tasks.listTasks({ caller })).toHaveLength(1100);
  } finally {
    await db.close();
  }
});
