import { afterEach, expect, it } from "vite-plus/test";
import {
  agentResourceId,
  openDomainStore,
  type CallerContext,
  type DomainStore,
} from "../persistence/index.js";
import { TaskNotificationStore } from "./task-notification-store.js";

const scope = {
  connectionId: "notify-test",
  botId: "bot",
  chatType: "private" as const,
  chatId: "owner",
  senderId: "owner",
};
const caller: CallerContext = { principalId: "owner", scope };
const stores: DomainStore[] = [];

async function fixture() {
  const domain = await openDomainStore({ databasePath: ":memory:" });
  stores.push(domain);
  await domain.conversations.createAgent("personal");
  await domain.identities.bindOwner(caller.principalId, scope);
  for (const action of ["run:create", "conversation:read", "delivery:send"])
    await domain.authorization.grant({
      principalId: caller.principalId,
      resourceId: agentResourceId("personal"),
      action,
      scope,
      effect: "allow",
    });
  const incoming = await domain.conversations.acceptIncoming({
    agentId: "personal",
    scope,
    messageId: "notification-message",
    text: "Create durable Task",
    executionRef: "test-runner",
  });
  const task = await domain.tasks.createTask({
    id: "notification-task",
    title: "Private task title must not be copied",
    creatorPrincipalId: caller.principalId,
    conversationId: incoming.conversation.id,
    runId: incoming.run.id,
    authorizationScope: scope,
  });
  await domain.authorization.grant({
    principalId: caller.principalId,
    resourceId: `task-${task.id}`,
    action: "task:read",
    scope,
    effect: "allow",
  });
  const notifications = new TaskNotificationStore(domain.db);
  return { domain, incoming, task, notifications };
}

async function appendEvent(
  domain: DomainStore,
  taskId: string,
  type: string,
  stepId: string | null = null,
): Promise<number> {
  return domain.db.transaction(async (tx) => {
    if (stepId) {
      const stepStatus =
        type === "STEP_BLOCKED" ? "blocked" : type === "STEP_REVIEW" ? "review" : "failed";
      await tx.execute({
        sql: `INSERT OR IGNORE INTO task_steps(
                id,task_id,kind,title,status,dependency_policy_json,max_attempts,
                required_capabilities_json,delegated_permissions_json,version,created_at,updated_at
              ) VALUES (?,?, 'model', ?, ?, '{}', 1, '[]', '[]', 1, ?, ?)`,
        args: [
          stepId,
          taskId,
          stepId,
          stepStatus,
          new Date().toISOString(),
          new Date().toISOString(),
        ],
      });
    }
    const result = await tx.execute({
      sql: "INSERT INTO task_events(id,task_id,step_id,type,metadata_json,created_at) VALUES (?,?,?,?,?,?) RETURNING sequence",
      args: [`event-${type}-${Date.now()}`, taskId, stepId, type, "{}", new Date().toISOString()],
    });
    return Number(result.rows[0]!.sequence);
  });
}

afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
});

it("enqueues immutable fixed content once for an exact external Run and Task event", async () => {
  const { domain, task, notifications } = await fixture();
  const sequence = await appendEvent(domain, task.id, "TASK_REVIEW");
  const first = await domain.db.transaction((tx) => notifications.enqueueTx(tx, sequence));
  const duplicate = await domain.db.transaction((tx) => notifications.enqueueTx(tx, sequence));
  expect(first).toMatchObject({
    taskId: task.id,
    eventSequence: sequence,
    eventType: "TASK_REVIEW",
    runId: expect.any(String),
    payloadKind: "text",
    payloadText: `任务 ${task.id} 等待审核。`,
    status: "pending",
  });
  expect(duplicate?.id).toBe(first?.id);
  expect(first?.payloadText).not.toContain("Private task title");
  await expect(
    domain.db.transaction((tx) =>
      tx.execute({
        sql: "UPDATE task_notifications SET payload_text = 'changed' WHERE id = ?",
        args: [first!.id],
      }),
    ),
  ).rejects.toThrow("immutable");
});

it("keeps a Task event when persisted notification routing data is invalid", async () => {
  const { domain, task, notifications } = await fixture();
  await domain.db.transaction((tx) =>
    tx.execute({
      sql: "UPDATE tasks SET origin_scope_json = ? WHERE id = ?",
      args: ["{invalid", task.id],
    }),
  );

  const sequence = await domain.db.transaction(async (tx) => {
    const event = await tx.execute({
      sql: "INSERT INTO task_events(id,task_id,type,metadata_json,created_at) VALUES (?,?,?,?,?) RETURNING sequence",
      args: ["invalid-route-review", task.id, "TASK_REVIEW", "{}", new Date().toISOString()],
    });
    const sequence = Number(event.rows[0]!.sequence);
    expect(await notifications.enqueueTx(tx, sequence)).toBeNull();
    return sequence;
  });

  const persisted = await domain.db.transaction(async (tx) => ({
    event: await tx.execute({
      sql: "SELECT sequence FROM task_events WHERE sequence = ?",
      args: [sequence],
    }),
    notifications: await tx.execute({
      sql: "SELECT id FROM task_notifications WHERE event_sequence = ?",
      args: [sequence],
    }),
  }));
  expect(persisted.event.rows).toHaveLength(1);
  expect(persisted.notifications.rows).toHaveLength(0);
});

it("suppresses a pending notification after delivery permission is revoked", async () => {
  const { domain, task, notifications } = await fixture();
  const sequence = await appendEvent(domain, task.id, "TASK_ACCEPTED");
  const notification = await domain.db.transaction((tx) => notifications.enqueueTx(tx, sequence));
  await domain.authorization.revokeScopeAction({
    principalId: caller.principalId,
    resourceId: agentResourceId("personal"),
    action: "delivery:send",
    scope,
  });

  expect(await notifications.claim(caller, notification!.id)).toBeNull();
  const state = await domain.db.transaction(async (tx) => ({
    notification: await tx.execute({
      sql: "SELECT status FROM task_notifications WHERE id = ?",
      args: [notification!.id],
    }),
    denial: await tx.execute({
      sql: "SELECT decision,action FROM authorization_decisions WHERE run_id = ? AND action = 'delivery:send' ORDER BY created_at DESC LIMIT 1",
      args: [notification!.runId],
    }),
  }));
  expect(state.notification.rows[0]?.status).toBe("suppressed");
  expect(state.denial.rows[0]).toMatchObject({ decision: "DENY", action: "delivery:send" });
  expect(await notifications.listUndelivered()).toEqual([]);
});

it("suppresses a notification claimed for a different audience", async () => {
  const { domain, task, notifications } = await fixture();
  const sequence = await appendEvent(domain, task.id, "STEP_BLOCKED", "step-1");
  const notification = await domain.db.transaction((tx) => notifications.enqueueTx(tx, sequence));
  const otherCaller: CallerContext = {
    principalId: "other",
    scope: { ...scope, chatId: "other", senderId: "other" },
  };

  expect(await notifications.claim(otherCaller, notification!.id)).toBeNull();
  const status = await domain.db.transaction(async (tx) =>
    tx.execute({
      sql: "SELECT status FROM task_notifications WHERE id = ?",
      args: [notification!.id],
    }),
  );
  expect(status.rows[0]?.status).toBe("suppressed");
});

it("suppresses old review notices after a rework and a later review", async () => {
  const { domain, task, notifications } = await fixture();
  const oldTaskReview = await appendEvent(domain, task.id, "TASK_REVIEW");
  const oldTaskNotification = await domain.db.transaction((tx) =>
    notifications.enqueueTx(tx, oldTaskReview),
  );
  await appendEvent(domain, task.id, "TASK_REWORK");
  await domain.db.transaction(async (tx) => {
    await tx.execute({ sql: "UPDATE tasks SET status = 'RUNNING' WHERE id = ?", args: [task.id] });
    await tx.execute({ sql: "UPDATE tasks SET status = 'REVIEW' WHERE id = ?", args: [task.id] });
  });
  const currentTaskReview = await appendEvent(domain, task.id, "TASK_REVIEW");
  const currentTaskNotification = await domain.db.transaction((tx) =>
    notifications.enqueueTx(tx, currentTaskReview),
  );
  expect(await notifications.claim(caller, oldTaskNotification!.id)).toBeNull();
  const currentTaskLease = await notifications.claim(caller, currentTaskNotification!.id);
  expect(currentTaskLease?.notification.status).toBe("sending");
  await currentTaskLease!.settle("sent");

  const oldStepReview = await appendEvent(domain, task.id, "STEP_REVIEW", "review-step");
  const oldStepNotification = await domain.db.transaction((tx) =>
    notifications.enqueueTx(tx, oldStepReview),
  );
  await appendEvent(domain, task.id, "TASK_REWORK", "review-step");
  await domain.db.transaction((tx) =>
    tx.execute("UPDATE task_steps SET status = 'ready' WHERE id = 'review-step'"),
  );
  await domain.db.transaction((tx) =>
    tx.execute("UPDATE task_steps SET status = 'review' WHERE id = 'review-step'"),
  );
  const currentStepReview = await appendEvent(domain, task.id, "STEP_REVIEW", "review-step");
  const currentStepNotification = await domain.db.transaction((tx) =>
    notifications.enqueueTx(tx, currentStepReview),
  );
  expect(await notifications.claim(caller, oldStepNotification!.id)).toBeNull();
  const currentStepLease = await notifications.claim(caller, currentStepNotification!.id);
  expect(currentStepLease?.notification.status).toBe("sending");
  await currentStepLease!.settle("sent");
});

it("suppresses a Worker loss notice after recovery is recorded", async () => {
  const { domain, task, notifications } = await fixture();
  const lostSequence = await appendEvent(domain, task.id, "WORKER_LOST", "worker-step");
  const lost = await domain.db.transaction((tx) => notifications.enqueueTx(tx, lostSequence));
  await appendEvent(domain, task.id, "WORKER_RECOVERED", "worker-step");

  expect(await notifications.claim(caller, lost!.id)).toBeNull();
  const row = await domain.db.transaction((tx) =>
    tx.execute({ sql: "SELECT status FROM task_notifications WHERE id = ?", args: [lost!.id] }),
  );
  expect(row.rows[0]?.status).toBe("suppressed");
});

it("recovers sending notifications as terminal unknown without retry", async () => {
  const { domain, task, notifications } = await fixture();
  const sequence = await appendEvent(domain, task.id, "WORKER_LOST", "step-2");
  const notification = await domain.db.transaction((tx) => notifications.enqueueTx(tx, sequence));
  const lease = await notifications.claim(caller, notification!.id);
  expect(lease?.notification.status).toBe("sending");

  expect(await notifications.recover()).toEqual([notification!.id]);
  expect(await notifications.listUndelivered()).toEqual([]);
  expect(await notifications.claim(caller, notification!.id)).toBeNull();
  const status = await domain.db.transaction(async (tx) =>
    tx.execute({
      sql: "SELECT status FROM task_notifications WHERE id = ?",
      args: [notification!.id],
    }),
  );
  expect(status.rows[0]?.status).toBe("unknown");
});
