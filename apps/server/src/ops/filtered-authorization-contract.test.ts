import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vite-plus/test";
import {
  agentResourceId,
  openDomainStore,
  type CallerContext,
  type DomainStore,
} from "../persistence/index.js";
import { conversationScopeKey, scopeKey } from "../identity/scope.js";
import { taskPolicyResourceId } from "../auth/task-policy.js";
import { qqCategoryCondition } from "../auth/policy-condition.js";

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

type CaseEvidenceInput = {
  id: string;
  route: string;
  startedAt: string;
  sentMessageId: string;
  inputBinding: {
    botMessageId: string;
    driverMessageId: string;
    realSequence: string;
    time: number;
    textSha256: string;
  };
};
type CaseEvidenceResult = {
  runId: string;
  decisions: Array<{ id: string; action: string; decision: string }>;
  filteredDecisions: Array<{ decisionId: string; eventId: string; projection: string }>;
};
const {
  caseEvidence,
}: {
  caseEvidence: (
    db: DatabaseSync,
    c: CaseEvidenceInput,
    productConfig: typeof config,
  ) => CaseEvidenceResult;
} = createRequire(import.meta.url)("../../../../tools/qq-live/lib/product-evidence.mjs");

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
    await store.authorization.grant({
      principalId: caller.principalId,
      resourceId: taskPolicyResourceId(caller),
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

    await store.tasks.listTasks({
      caller,
      runId: "current-run",
      conversationId: "filtered-contract-conversation",
    });
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
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

it("passes actual group history exclusion evidence for a policy-protected group:read source", async () => {
  const directory = await mkdtemp(join(tmpdir(), "qq-group-history-contract-"));
  const databasePath = join(directory, "glassbox.db");
  const groupScope = {
    connectionId: config.runtime.connectionId,
    botId: config.bot.qq,
    chatType: "group" as const,
    chatId: "20001",
    senderId: config.driver.qq,
  };
  const groupCaller: CallerContext = { principalId: "owner", scope: groupScope };
  let store: DomainStore | undefined;
  try {
    store = await openDomainStore({ databasePath });
    await store.conversations.createAgent("personal");
    await store.identities.bindOwner(groupCaller.principalId, groupScope);
    await store.authorization.registerResource({
      id: "group:20001",
      kind: "qq_group",
      visibility: "public",
    });
    for (const action of ["run:create", "run:control", "conversation:read", "trace:write"])
      await store.authorization.grant({
        principalId: groupCaller.principalId,
        resourceId: agentResourceId("personal"),
        action,
        scope: groupScope,
        effect: "allow",
      });
    await store.authorization.grant({
      principalId: groupCaller.principalId,
      resourceId: "group:20001",
      action: "group:read",
      scope: groupScope,
      effect: "allow",
    });
    await store.capabilities.write({
      connectionId: groupScope.connectionId,
      groupId: groupScope.chatId,
      principalId: groupCaller.principalId,
      policy: { categories: { "group.read": true }, memorySources: {} },
    });

    const source = await store.conversations.acceptIncoming({
      agentId: "personal",
      scope: groupScope,
      messageId: "12345678901001",
      text: "GROUP_HISTORY_INPUT_CANARY",
      executionRef: "pi:test",
    });
    const sourceDecision = await store.authorization.check({
      caller: groupCaller,
      resourceId: "group:20001",
      action: "group:read",
      policyCondition: qqCategoryCondition(groupCaller, "20001", "group.read"),
      runId: source.run.id,
      conversationId: source.conversation.id,
    });
    expect(sourceDecision.decision).toBe("ALLOW");
    await store.authorization.markDeliverySource(sourceDecision.id, "content_source");
    const sourceLease = await store.lifecycle.claimQueuedRun(groupCaller, source.run.id);
    await sourceLease.settle("succeeded", "GROUP_HISTORY_RESULT_CANARY");

    await store.capabilities.write({
      connectionId: groupScope.connectionId,
      groupId: groupScope.chatId,
      principalId: groupCaller.principalId,
      policy: { categories: { "group.read": false }, memorySources: {} },
    });
    const current = await store.conversations.acceptIncoming({
      agentId: "personal",
      scope: groupScope,
      messageId: "12345678901999",
      text: "current group question",
      executionRef: "pi:test",
    });
    const input = await store.conversations.loadRunInput(groupCaller, current.run.id);
    expect(JSON.stringify(input.history)).not.toContain("GROUP_HISTORY_INPUT_CANARY");
    expect(JSON.stringify(input.history)).not.toContain("GROUP_HISTORY_RESULT_CANARY");
    expect(input.history).toEqual([]);

    const currentLease = await store.lifecycle.claimQueuedRun(groupCaller, current.run.id);
    await currentLease.settle("succeeded", "current group response");
    const sentMessageId = "10987654321999";
    const now = new Date().toISOString();
    await store.db.transaction((tx) =>
      tx
        .execute({
          sql: `INSERT INTO deliveries(
          id,run_id,dedup_key,destination_scope_key,payload_text,payload_kind,status,external_id,created_at,updated_at
        ) VALUES ('group-current-delivery',?,'group-history-contract',?, 'current group response', 'text', 'sent', ?, ?, ?)`,
          args: [current.run.id, scopeKey(groupScope), sentMessageId, now, now],
        })
        .then(() => undefined),
    );

    await store.close();
    store = undefined;
    const c: CaseEvidenceInput = {
      ...makeCase(),
      route: groupScope.chatId,
      startedAt: new Date(Date.parse(current.run.createdAt) - 500).toISOString(),
      sentMessageId,
      inputBinding: {
        ...makeCase().inputBinding,
        botMessageId: "12345678901999",
        driverMessageId: sentMessageId,
      },
    };
    const readDatabase = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const evidence = caseEvidence(readDatabase, c, config);
      expect(evidence.runId).toBe(current.run.id);
      expect(
        evidence.decisions.find(
          (decision) => decision.action === "group:read" && decision.decision === "DENY",
        ),
      ).toBeDefined();
      expect(evidence.filteredDecisions).toHaveLength(1);
      expect(evidence.filteredDecisions[0]).toMatchObject({
        projection: "conversation-history",
      });
    } finally {
      readDatabase.close();
    }

    store = await openDomainStore({ databasePath });
    const removed = await store.db.transaction((tx) =>
      tx.execute({
        sql: "DELETE FROM ops_trace_events WHERE run_id=? AND type='authorization.filtered'",
        args: [current.run.id],
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
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});
