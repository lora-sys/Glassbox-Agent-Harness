import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vite-plus/test";
import { caseEvidence } from "../../../../tools/qq-live/lib/product-evidence.mjs";
import { openDomainStore, type CallerContext, type DomainStore } from "../persistence/index.js";
import { conversationScopeKey, scopeKey } from "../identity/scope.js";

const config = {
  bot: { qq: "12345678901" },
  driver: { qq: "10987654321" },
  runtime: { connectionId: "qq-live", threadId: null },
};
const scope = {
  connectionId: config.runtime.connectionId,
  botId: config.bot.qq,
  chatType: "private" as const,
  chatId: config.driver.qq,
  senderId: config.driver.qq,
};
const caller: CallerContext = { principalId: "owner", scope };

async function seedRun(store: DomainStore, runId: string, externalId: string) {
  const now = new Date().toISOString();
  await store.db.transaction(async (tx) => {
    await tx.execute({
      sql: "INSERT OR IGNORE INTO agents(id,created_at) VALUES ('personal',?)",
      args: [now],
    });
    await tx.execute({
      sql: "INSERT OR IGNORE INTO resources(id,kind,visibility,owner_id) VALUES ('conversation:filtered-contract','conversation','private','owner')",
    });
    await tx.execute({
      sql: "INSERT OR IGNORE INTO conversations(id,agent_id,principal_id,scope_key,scope_json,resource_id,created_at) VALUES ('filtered-contract-conversation','personal','owner',?,?,'conversation:filtered-contract',?)",
      args: [conversationScopeKey(scope), JSON.stringify(scope), now],
    });
    const messageId = `${runId}-message`;
    await tx.execute({
      sql: "INSERT INTO messages(id,conversation_id,scope_key,external_id,text,created_at) VALUES (?, 'filtered-contract-conversation', ?, ?, '', ?)",
      args: [messageId, scopeKey(scope), externalId, now],
    });
    await tx.execute({
      sql: "INSERT INTO runs(id,conversation_id,message_id,principal_id,scope_json,execution_ref,status,source,created_at,updated_at) VALUES (?, 'filtered-contract-conversation', ?, 'owner', ?, ?, 'succeeded', 'external', ?, ?)",
      args: [runId, messageId, JSON.stringify(scope), `pi:${runId}`, now, now],
    });
  });
}

function makeCase() {
  const now = Date.now();
  const sentMessageId = "10987654321999";
  return {
    id: "filtered-contract-case",
    route: "private",
    startedAt: new Date(now - 1_000).toISOString(),
    sentMessageId,
    inputBinding: {
      botMessageId: "12345678901999",
      driverMessageId: sentMessageId,
      realSequence: "1",
      time: now - 500,
      textSha256: "a".repeat(64),
    },
  };
}

it("passes the actual TaskStore DENY and exclusion witness through caseEvidence", async () => {
  const directory = await mkdtemp(join(tmpdir(), "qq-filtered-auth-contract-"));
  const databasePath = join(directory, "glassbox.db");
  let store: DomainStore | undefined;
  try {
    store = await openDomainStore({ databasePath });
    await store.identities.bindOwner(caller.principalId, scope);
    await store.authorization.registerResource({
      id: "document:revoked-source",
      kind: "document",
      visibility: "private",
      ownerId: caller.principalId,
    });
    await store.authorization.registerResource({
      id: "document:current-allow",
      kind: "document",
      visibility: "private",
      ownerId: caller.principalId,
    });
    await seedRun(store, "source-run", "12345678901001");
    await seedRun(store, "current-run", "12345678901999");

    const sourceGrant = await store.authorization.grant({
      principalId: caller.principalId,
      resourceId: "document:revoked-source",
      action: "document:read",
      scope,
      effect: "allow",
    });
    const sourceDecision = await store.authorization.check({
      caller,
      resourceId: "document:revoked-source",
      action: "document:read",
      runId: "source-run",
      conversationId: "filtered-contract-conversation",
    });
    expect(sourceDecision.decision).toBe("ALLOW");
    await store.authorization.markDeliverySource(sourceDecision.id, "content_source");
    await store.tasks.createTask({
      id: "source-task",
      title: "Disposable source fixture",
      creatorPrincipalId: caller.principalId,
      authorizationScope: scope,
      conversationId: "filtered-contract-conversation",
      runId: "source-run",
    });
    // Reach source reauthorization through a permitted Task projection.
    await store.authorization.grant({
      principalId: caller.principalId,
      resourceId: "task-source-task",
      action: "task:read",
      scope,
      effect: "allow",
    });
    await store.authorization.grant({
      principalId: caller.principalId,
      resourceId: "document:current-allow",
      action: "document:read",
      scope,
      effect: "allow",
    });
    const currentAllow = await store.authorization.check({
      caller,
      resourceId: "document:current-allow",
      action: "document:read",
      runId: "current-run",
      conversationId: "filtered-contract-conversation",
    });
    expect(currentAllow.decision).toBe("ALLOW");
    await store.authorization.revoke(sourceGrant);

    const visibleTasks = await store.tasks.listTasks({
      caller,
      runId: "current-run",
      conversationId: "filtered-contract-conversation",
    });
    expect(visibleTasks).toEqual([]);
    const now = new Date().toISOString();
    await store.db.transaction((tx) =>
      tx
        .execute({
          sql: `INSERT INTO deliveries(
          id,run_id,dedup_key,destination_scope_key,payload_text,payload_kind,status,external_id,created_at,updated_at
        ) VALUES ('current-delivery','current-run','filtered-contract',?, 'reply', 'text', 'sent', ?, ?, ?)`,
          args: [scopeKey(scope), makeCase().sentMessageId, now, now],
        })
        .then(() => undefined),
    );

    await store.close();
    store = undefined;
    const c = makeCase();
    const readDatabase = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const evidence = caseEvidence(readDatabase, c, config);
      expect(evidence.runId).toBe("current-run");
      expect(
        evidence.decisions.find(
          (decision) => decision.action === "document:read" && decision.decision === "DENY",
        ),
      ).toBeDefined();
      expect(evidence.filteredDecisions).toHaveLength(1);
      expect(evidence.filteredDecisions[0]).toMatchObject({
        projection: "task-list",
      });
    } finally {
      readDatabase.close();
    }

    store = await openDomainStore({ databasePath });
    const removed = await store.db.transaction((tx) =>
      tx.execute({
        sql: "DELETE FROM ops_trace_events WHERE run_id='current-run' AND type='authorization.filtered'",
      }),
    );
    expect(removed.rowsAffected).toBe(1);
    await store.close();
    store = undefined;

    const withoutWitness = new DatabaseSync(databasePath, { readOnly: true });
    try {
      expect(() => caseEvidence(withoutWitness, c, config)).toThrowError(
        expect.objectContaining({ code: "AUTHORIZATION_EVIDENCE" }),
      );
    } finally {
      withoutWitness.close();
    }
  } finally {
    await store?.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 });
  }
});
