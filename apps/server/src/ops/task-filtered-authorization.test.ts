import { expect, it } from "vite-plus/test";
import { openDomainStore, type CallerContext, type DomainStore } from "../persistence/index.js";
import { conversationScopeKey, scopeKey } from "../identity/scope.js";
import { taskPolicyResourceId } from "../auth/task-policy.js";

const scope = {
  connectionId: "filtered-test",
  botId: "bot",
  chatType: "private" as const,
  chatId: "owner",
  senderId: "owner",
};
const caller: CallerContext = { principalId: "owner", scope };

async function addRun(store: DomainStore, runId: string) {
  const now = new Date().toISOString();
  await store.db.transaction(async (tx) => {
    await tx.execute({
      sql: "INSERT OR IGNORE INTO agents(id,created_at) VALUES ('personal',?)",
      args: [now],
    });
    await tx.execute({
      sql: "INSERT OR IGNORE INTO resources(id,kind,visibility,owner_id) VALUES ('conversation:filtered-test','conversation','private','owner')",
    });
    await tx.execute({
      sql: "INSERT OR IGNORE INTO conversations(id,agent_id,principal_id,scope_key,scope_json,resource_id,created_at) VALUES ('filtered-conversation','personal','owner',?,?,'conversation:filtered-test',?)",
      args: [conversationScopeKey(scope), JSON.stringify(scope), now],
    });
    const messageId = `${runId}-message`;
    await tx.execute({
      sql: "INSERT INTO messages(id,conversation_id,scope_key,external_id,text,created_at) VALUES (?, 'filtered-conversation', ?, ?, '', ?)",
      args: [messageId, scopeKey(scope), `${runId}-external`, now],
    });
    await tx.execute({
      sql: "INSERT INTO runs(id,conversation_id,message_id,principal_id,scope_json,execution_ref,status,source,created_at,updated_at) VALUES (?, 'filtered-conversation', ?, 'owner', ?, ?, 'succeeded', 'external', ?, ?)",
      args: [runId, messageId, JSON.stringify(scope), `pi:${runId}`, now, now],
    });
  });
}

it("records safe DENY witnesses when Task projections exclude revoked source rows", async () => {
  const store = await openDomainStore({ databasePath: ":memory:" });
  try {
    await store.identities.bindOwner(caller.principalId, scope);
    await store.authorization.registerResource({
      id: "private-source",
      kind: "document",
      visibility: "private",
      ownerId: caller.principalId,
    });
    await store.db.transaction((tx) =>
      tx
        .execute("INSERT INTO principals(id,kind,created_at) VALUES ('other-owner','owner','now')")
        .then(() => undefined),
    );
    await addRun(store, "origin-run");
    await addRun(store, "inspection-run");

    const sourceGrant = await store.authorization.grant({
      principalId: caller.principalId,
      resourceId: "private-source",
      action: "document:read",
      scope,
      effect: "allow",
    });
    const sourceDecision = await store.authorization.check({
      caller,
      resourceId: "private-source",
      action: "document:read",
      runId: "origin-run",
      conversationId: "filtered-conversation",
    });
    expect(sourceDecision.decision).toBe("ALLOW");
    await store.authorization.markDeliverySource(sourceDecision.id, "content_source");

    const protectedTask = await store.tasks.createTask({
      id: "filtered-secret-task",
      title: "PRIVATE_TASK_TITLE_CANARY",
      description: "PRIVATE_TASK_DESCRIPTION_CANARY",
      creatorPrincipalId: caller.principalId,
      authorizationScope: scope,
      conversationId: "filtered-conversation",
      runId: "origin-run",
    });
    const allowedTask = await store.tasks.createTask({
      id: "allowed-task",
      title: "Allowed task",
      creatorPrincipalId: caller.principalId,
      authorizationScope: scope,
    });
    await store.tasks.createTask({
      id: "unrelated-task",
      title: "UNRELATED_PRIVATE_CANARY",
      creatorPrincipalId: "other-owner",
      authorizationScope: {
        ...scope,
        chatId: "other-owner",
        senderId: "other-owner",
      },
    });
    await store.authorization.grant({
      principalId: caller.principalId,
      resourceId: taskPolicyResourceId(caller),
      action: "task:read",
      scope,
      effect: "allow",
    });
    await store.authorization.revoke(sourceGrant);

    const list = await store.tasks.listTasks({
      caller,
      runId: "inspection-run",
      conversationId: "filtered-conversation",
    });
    expect(list.map((task) => task.id)).toContain(allowedTask.id);
    expect(list.map((task) => task.id)).not.toContain(protectedTask.id);
    expect(JSON.stringify(list)).not.toContain("PRIVATE_TASK_");
    expect(JSON.stringify(list)).not.toContain("UNRELATED_PRIVATE_CANARY");
    await assertFilteredWitness(store, "task-list", 1);

    const health = await store.tasks.getOpsHealthRecords(caller, {
      runId: "inspection-run",
      conversationId: "filtered-conversation",
    });
    expect(health.tasks.map((task) => task.id)).toContain(allowedTask.id);
    expect(health.tasks.map((task) => task.id)).not.toContain(protectedTask.id);
    expect(JSON.stringify(health)).not.toContain("PRIVATE_TASK_");
    expect(JSON.stringify(health)).not.toContain("UNRELATED_PRIVATE_CANARY");
    await assertFilteredWitness(store, "ops-health-records", 2);
  } finally {
    await store.close();
  }
});

async function assertFilteredWitness(
  store: DomainStore,
  projection: "task-list" | "ops-health-records",
  expectedCount: number,
) {
  await store.db.transaction(async (tx) => {
    const decisions = await tx.execute({
      sql: "SELECT id FROM authorization_decisions WHERE run_id='inspection-run' AND resource_id='private-source' AND action='document:read' AND decision='DENY' ORDER BY rowid",
    });
    const events = await tx.execute({
      sql: "SELECT run_id,principal_id,data_json FROM ops_trace_events WHERE type='authorization.filtered' ORDER BY rowid",
    });
    expect(decisions.rows).toHaveLength(expectedCount);
    expect(events.rows).toHaveLength(expectedCount);
    const event = events.rows.at(-1);
    expect(event?.run_id).toBe("inspection-run");
    expect(event?.principal_id).toBe("owner");
    const rawData = event?.data_json;
    if (typeof rawData !== "string") throw new Error("expected serialized filtered-decision data");
    const parsed: unknown = JSON.parse(rawData);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      throw new Error("expected filtered-decision object");
    const data = parsed as Record<string, unknown>;
    expect(Object.keys(data).sort()).toEqual(["decisionId", "outcome", "projection"]);
    expect(data).toEqual({
      decisionId: decisions.rows.at(-1)?.id,
      projection,
      outcome: "excluded",
    });
    expect(JSON.stringify(data)).not.toContain("PRIVATE_TASK_");
    expect(JSON.stringify(data)).not.toContain("UNRELATED_PRIVATE_CANARY");
  });
}
