import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { createClient } from "@libsql/client";
import {
  AccessDeniedError,
  agentResourceId,
  conversationScopeKey,
  identityKey,
  openDomainStore,
  scopeKey,
  type CallerContext,
  type DomainStore,
  type TrustedChannelScope,
} from "../persistence/index.js";
import { localDatabaseUrl } from "../persistence/database.js";

const groupBase: TrustedChannelScope = {
  connectionId: "napcat-local",
  botId: "bot-1",
  chatType: "group",
  chatId: "shared-group",
  senderId: "owner-qq",
};

const ownerGroup: CallerContext = {
  principalId: "owner",
  scope: groupBase,
};

const visitorGroup: CallerContext = {
  principalId: "visitor",
  scope: { ...groupBase, senderId: "visitor-qq" },
};

const ownerPrivate: CallerContext = {
  principalId: "owner",
  scope: { ...groupBase, chatType: "private", chatId: "owner-qq", senderId: "owner-qq" },
};

const visitorPrivate: CallerContext = {
  principalId: "visitor",
  scope: { ...groupBase, chatType: "private", chatId: "visitor-qq", senderId: "visitor-qq" },
};

const otherGroup: CallerContext = {
  principalId: "owner",
  scope: { ...groupBase, chatId: "other-group", senderId: "owner-qq" },
};

const actions = [
  "run:create",
  "conversation:read",
  "run:control",
  "delivery:send",
  "trace:write",
  "eval:write",
];

const stores: DomainStore[] = [];
const tempDirectories: string[] = [];

async function openStore(databasePath = ":memory:"): Promise<DomainStore> {
  const store = await openDomainStore({ databasePath });
  stores.push(store);
  return store;
}

async function grantAll(store: DomainStore, caller: CallerContext): Promise<void> {
  for (const action of actions) {
    await store.authorization.grant({
      principalId: caller.principalId,
      resourceId: agentResourceId("personal"),
      action,
      scope: caller.scope,
      effect: "allow",
    });
  }
}

async function setupStore(databasePath = ":memory:"): Promise<DomainStore> {
  const store = await openStore(databasePath);
  await store.conversations.createAgent("personal");
  await store.identities.bindOwner("owner", ownerGroup.scope);
  await store.identities.createPrincipal("visitor", "visitor");
  await store.identities.bindPrincipal("visitor", visitorGroup.scope);
  await store.identities.bindPrincipal("visitor", visitorPrivate.scope);
  await grantAll(store, ownerGroup);
  await grantAll(store, visitorGroup);
  await grantAll(store, ownerPrivate);
  await grantAll(store, visitorPrivate);
  await grantAll(store, otherGroup);
  return store;
}

afterEach(async () => {
  for (const store of stores.splice(0)) {
    await store.close();
  }
  for (const directory of tempDirectories.splice(0)) {
    try {
      await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch {
      // ignore cleanup errors on locked files in Windows
    }
  }
});

describe("shared group conversation and durable actor routing", () => {
  it("excludes unsafe exchanges from future context without rewriting results, including after reopen", async () => {
    const directory = await mkdtemp(join(tmpdir(), "glassbox-context-exclusion-"));
    tempDirectories.push(directory);
    const databasePath = join(directory, "state.db");
    const store = await setupStore(databasePath);
    const first = await store.conversations.acceptIncoming({
      agentId: "personal",
      scope: ownerPrivate.scope,
      messageId: "unsafe-1",
      text: "Old input",
      executionRef: "pi:test",
    });
    const lease = await store.lifecycle.claimQueuedRun(ownerPrivate, first.run.id);
    await lease.settle("succeeded", "HOST_METADATA_CANARY");
    const next = await store.conversations.acceptIncoming({
      agentId: "personal",
      scope: ownerPrivate.scope,
      messageId: "unsafe-2",
      text: "Next input",
      executionRef: "pi:test",
    });
    expect(
      (await store.conversations.loadRunInput(ownerPrivate, next.run.id)).history,
    ).toHaveLength(2);
    await expect(
      store.conversations.excludeRunFromContext(visitorPrivate, first.run.id),
    ).rejects.toBeInstanceOf(AccessDeniedError);
    await expect(
      store.management.excludeUnsafeRunContexts("visitor", [first.run.id]),
    ).rejects.toThrow("Owner management authority required");
    await store.conversations.excludeRunFromContext(ownerPrivate, first.run.id);
    await store.management.excludeUnsafeRunContexts("owner", [first.run.id]);
    await store.conversations.excludeRunFromContext(ownerPrivate, first.run.id);
    expect((await store.conversations.loadRunInput(ownerPrivate, next.run.id)).history).toEqual([]);
    await store.close();
    stores.splice(stores.indexOf(store), 1);
    const reopened = await openStore(databasePath);
    expect((await reopened.conversations.loadRunInput(ownerPrivate, next.run.id)).history).toEqual(
      [],
    );
    const db = createClient({ url: localDatabaseUrl(databasePath) });
    try {
      expect(
        (
          await db.execute({
            sql: "SELECT result_text FROM runs WHERE id = ?",
            args: [first.run.id],
          })
        ).rows[0]?.result_text,
      ).toBe("HOST_METADATA_CANARY");
      expect(
        (
          await db.execute(
            "SELECT COUNT(*) AS n FROM ops_trace_events WHERE type = 'context.excluded'",
          )
        ).rows[0]?.n,
      ).toBe(1);
    } finally {
      db.close();
    }
  });
  it("does not reuse an Owner source in Visitor context merely because its answer was sent to the group", async () => {
    const store = await setupStore();
    const first = await store.conversations.acceptIncoming({
      agentId: "personal",
      scope: ownerGroup.scope,
      messageId: "group-source-1",
      text: "Read",
      executionRef: "pi:test",
    });
    await store.authorization.registerResource({
      id: "group-source",
      kind: "document",
      visibility: "public",
      ownerId: "owner",
    });
    for (const action of ["read", "delivery:send"])
      await store.authorization.grant({
        principalId: "owner",
        resourceId: "group-source",
        action,
        scope: ownerGroup.scope,
        effect: "allow",
      });
    await store.authorization.check({
      caller: ownerGroup,
      resourceId: "group-source",
      action: "read",
      runId: first.run.id,
    });
    const lease = await store.lifecycle.claimQueuedRun(ownerGroup, first.run.id);
    await lease.settle("succeeded", "SOURCE_DEPENDENT_ANSWER");
    const delivery = await store.lifecycle.createDelivery(ownerGroup, {
      runId: first.run.id,
      dedupKey: "answer",
      destination: ownerGroup.scope,
      payloadText: "SOURCE_DEPENDENT_ANSWER",
      payloadKind: "result",
    });
    const send = await store.lifecycle.claimDelivery(ownerGroup, first.run.id, delivery);
    await send!.settle("sent", "external-message");
    const second = await store.conversations.acceptIncoming({
      agentId: "personal",
      scope: visitorGroup.scope,
      messageId: "group-source-2",
      text: "Repeat",
      executionRef: "pi:test",
    });
    expect((await store.conversations.loadRunInput(visitorGroup, second.run.id)).history).toEqual(
      [],
    );
  });
  it("carries protected history dependencies into the next Run delivery gate", async () => {
    const store = await setupStore();
    const first = await store.conversations.acceptIncoming({
      agentId: "personal",
      scope: ownerPrivate.scope,
      messageId: "history-source-1",
      text: "Read",
      executionRef: "pi:test",
    });
    await store.authorization.registerResource({
      id: "history-notes",
      kind: "document",
      visibility: "private",
      ownerId: "owner",
    });
    await store.authorization.grant({
      principalId: "owner",
      resourceId: "history-notes",
      action: "read",
      scope: ownerPrivate.scope,
      effect: "allow",
    });
    await store.authorization.check({
      caller: ownerPrivate,
      resourceId: "history-notes",
      action: "read",
      runId: first.run.id,
    });
    const lease = await store.lifecycle.claimQueuedRun(ownerPrivate, first.run.id);
    await lease.settle("succeeded", "PROTECTED_HISTORY");
    const second = await store.conversations.acceptIncoming({
      agentId: "personal",
      scope: ownerPrivate.scope,
      messageId: "history-source-2",
      text: "Summarize",
      executionRef: "pi:test",
    });
    const input = await store.conversations.loadRunInput(ownerPrivate, second.run.id);
    expect(input.history).toContainEqual({ role: "assistant", text: "PROTECTED_HISTORY" });
    await expect(
      store.lifecycle.createDelivery(ownerPrivate, {
        runId: second.run.id,
        dedupKey: "summary",
        destination: ownerPrivate.scope,
        payloadText: "Derived summary",
        payloadKind: "result",
      }),
    ).rejects.toBeInstanceOf(AccessDeniedError);
  });
  it.each(["read", "worker:file:read"])(
    "requires source delivery authority for %s separately and rechecks it at send reservation",
    async (readAction) => {
      const store = await setupStore();
      const accepted = await store.conversations.acceptIncoming({
        agentId: "personal",
        scope: ownerPrivate.scope,
        messageId: "protected-source",
        text: "Read notes",
        executionRef: "pi:test",
      });
      await store.authorization.registerResource({
        id: "private-notes",
        kind: "document",
        visibility: "private",
        ownerId: "owner",
      });
      await store.authorization.grant({
        principalId: "owner",
        resourceId: "private-notes",
        action: readAction,
        scope: ownerPrivate.scope,
        effect: "allow",
      });
      expect(
        (
          await store.authorization.check({
            caller: ownerPrivate,
            resourceId: "private-notes",
            action: readAction,
            runId: accepted.run.id,
          })
        ).decision,
      ).toBe("ALLOW");
      const input = {
        runId: accepted.run.id,
        dedupKey: "answer",
        destination: ownerPrivate.scope,
        payloadText: "Derived from private notes",
        payloadKind: "result" as const,
      };
      await expect(store.lifecycle.createDelivery(ownerPrivate, input)).rejects.toBeInstanceOf(
        AccessDeniedError,
      );
      const grant = await store.authorization.grant({
        principalId: "owner",
        resourceId: "private-notes",
        action: "delivery:send",
        scope: ownerPrivate.scope,
        effect: "allow",
      });
      const delivery = await store.lifecycle.createDelivery(ownerPrivate, input);
      await store.authorization.revoke(grant);
      await expect(
        store.lifecycle.claimDelivery(ownerPrivate, accepted.run.id, delivery),
      ).rejects.toBeInstanceOf(AccessDeniedError);
      expect(
        (await store.lifecycle.findDelivery(ownerPrivate, accepted.run.id, "answer"))?.status,
      ).toBe("pending");
    },
  );
  it("requires a separate live delivery grant even when read and run control remain allowed", async () => {
    const store = await setupStore();
    const accepted = await store.conversations.acceptIncoming({
      agentId: "personal",
      scope: visitorGroup.scope,
      messageId: "delivery-revoke",
      text: "hello",
      executionRef: "executor-main",
    });
    const input = {
      runId: accepted.run.id,
      dedupKey: "reply",
      destination: visitorGroup.scope,
      payloadText: "response",
      payloadKind: "text" as const,
    };
    const deliveryId = await store.lifecycle.createDelivery(visitorGroup, input);
    const grantId = await store.authorization.grant({
      principalId: "visitor",
      resourceId: agentResourceId("personal"),
      action: "delivery:send",
      scope: visitorGroup.scope,
      effect: "allow",
    });
    await store.authorization.revoke(grantId);
    await expect(
      store.lifecycle.claimDelivery(visitorGroup, accepted.run.id, deliveryId),
    ).rejects.toBeInstanceOf(AccessDeniedError);
    await expect(
      store.lifecycle.createDelivery(visitorGroup, { ...input, dedupKey: "new-reply" }),
    ).rejects.toBeInstanceOf(AccessDeniedError);
    expect(
      (await store.lifecycle.findDelivery(visitorGroup, accepted.run.id, "reply"))?.status,
    ).toBe("pending");
  });
  it("Owner + Visitor in the same QQ group share a Conversation but have distinct Run Principal and durable routing", async () => {
    const store = await setupStore();

    const ownerRes = await store.conversations.acceptIncoming({
      agentId: "personal",
      scope: ownerGroup.scope,
      messageId: "msg-owner-1",
      text: "hello from owner",
      executionRef: "executor-main",
    });

    const visitorRes = await store.conversations.acceptIncoming({
      agentId: "personal",
      scope: visitorGroup.scope,
      messageId: "msg-visitor-1",
      text: "hello from visitor",
      executionRef: "executor-main",
    });

    // 1. Same group shares Conversation
    expect(ownerRes.conversation.id).toBe(visitorRes.conversation.id);
    expect(ownerRes.run.id).not.toBe(visitorRes.run.id);

    // 2. Distinct Run Principal
    expect(ownerRes.run.principalId).toBe("owner");
    expect(visitorRes.run.principalId).toBe("visitor");
    expect(ownerRes.caller.principalId).toBe("owner");
    expect(visitorRes.caller.principalId).toBe("visitor");
    expect(await store.lifecycle.traceCaller(visitorRes.run.id, "visitor")).toEqual(visitorGroup);
    await expect(store.lifecycle.traceCaller(visitorRes.run.id, "owner")).rejects.toThrow(
      "actor mismatch",
    );

    // 3. Distinct delivery routing per actor
    const ownerDeliveryId = await store.lifecycle.createDelivery(ownerGroup, {
      runId: ownerRes.run.id,
      dedupKey: "ack",
      destination: ownerGroup.scope,
      payloadText: "Ack to owner",
      payloadKind: "ack",
    });

    const visitorDeliveryId = await store.lifecycle.createDelivery(visitorGroup, {
      runId: visitorRes.run.id,
      dedupKey: "ack",
      destination: visitorGroup.scope,
      payloadText: "Ack to visitor",
      payloadKind: "ack",
    });

    const ownerDelivery = await store.lifecycle.findDelivery(ownerGroup, ownerRes.run.id, "ack");
    const visitorDelivery = await store.lifecycle.findDelivery(
      visitorGroup,
      visitorRes.run.id,
      "ack",
    );

    expect(ownerDelivery?.destinationScopeKey).toBe(scopeKey(ownerGroup.scope));
    expect(visitorDelivery?.destinationScopeKey).toBe(scopeKey(visitorGroup.scope));
    expect(ownerDelivery?.destinationScopeKey).not.toBe(visitorDelivery?.destinationScopeKey);
    expect(ownerDeliveryId).not.toBe(visitorDeliveryId);
  });

  it("enforces complete isolation between private DMs, group chats, and across different groups", async () => {
    const store = await setupStore();

    const groupRun = await store.conversations.acceptIncoming({
      agentId: "personal",
      scope: ownerGroup.scope,
      messageId: "msg-group",
      text: "group text",
      executionRef: "executor-main",
    });

    const otherGroupRun = await store.conversations.acceptIncoming({
      agentId: "personal",
      scope: otherGroup.scope,
      messageId: "msg-other-group",
      text: "other group text",
      executionRef: "executor-main",
    });

    const ownerPrivRun = await store.conversations.acceptIncoming({
      agentId: "personal",
      scope: ownerPrivate.scope,
      messageId: "msg-owner-priv",
      text: "owner private text",
      executionRef: "executor-main",
    });

    const visitorPrivRun = await store.conversations.acceptIncoming({
      agentId: "personal",
      scope: visitorPrivate.scope,
      messageId: "msg-visitor-priv",
      text: "visitor private text",
      executionRef: "executor-main",
    });

    const convIds = [
      groupRun.conversation.id,
      otherGroupRun.conversation.id,
      ownerPrivRun.conversation.id,
      visitorPrivRun.conversation.id,
    ];
    expect(new Set(convIds).size).toBe(4);

    // Cross-scope read is denied
    await expect(
      store.conversations.getRun(visitorGroup, ownerPrivRun.run.id),
    ).rejects.toBeInstanceOf(AccessDeniedError);
    await expect(
      store.conversations.listMessages(visitorGroup, ownerPrivRun.conversation.id),
    ).rejects.toBeInstanceOf(AccessDeniedError);
    await expect(
      store.conversations.getRun(ownerGroup, otherGroupRun.run.id),
    ).rejects.toBeInstanceOf(AccessDeniedError);
    await expect(
      store.conversations.getRun(visitorPrivate, ownerPrivRun.run.id),
    ).rejects.toBeInstanceOf(AccessDeniedError);
  });

  it("denies forged actor and unbound identity", async () => {
    const store = await setupStore();

    // Unbound identity
    const unboundScope: TrustedChannelScope = { ...groupBase, senderId: "unbound-stranger" };
    await expect(
      store.conversations.acceptIncoming({
        agentId: "personal",
        scope: unboundScope,
        messageId: "msg-unbound",
        text: "who am i",
        executionRef: "executor-main",
      }),
    ).rejects.toMatchObject({ decision: { reason: "identity_unbound" } });

    // Forged caller claiming owner principal on visitor scope
    const groupRun = await store.conversations.acceptIncoming({
      agentId: "personal",
      scope: visitorGroup.scope,
      messageId: "msg-visitor-real",
      text: "real visitor msg",
      executionRef: "executor-main",
    });

    const forgedCaller: CallerContext = {
      principalId: "owner",
      scope: visitorGroup.scope,
    };
    await expect(store.conversations.getRun(forgedCaller, groupRun.run.id)).rejects.toMatchObject({
      decision: { reason: "scope_mismatch" },
    });

    // Rebound identity causes identity_mismatch
    const ownerRun = await store.conversations.acceptIncoming({
      agentId: "personal",
      scope: ownerGroup.scope,
      messageId: "msg-owner-rebound",
      text: "owner msg",
      executionRef: "executor-main",
    });
    await store.identities.bindPrincipal("visitor", ownerGroup.scope);
    await expect(store.conversations.getRun(ownerGroup, ownerRun.run.id)).rejects.toMatchObject({
      decision: { reason: "identity_mismatch" },
    });
  });

  it("denies cross-actor run control and result access in shared group", async () => {
    const store = await setupStore();

    const ownerRes = await store.conversations.acceptIncoming({
      agentId: "personal",
      scope: ownerGroup.scope,
      messageId: "msg-owner-control",
      text: "owner work",
      executionRef: "executor-main",
    });

    // 1. Visitor cannot transition or cancel Owner's run
    await expect(
      store.lifecycle.transitionRun(visitorGroup, ownerRes.run.id, "queued", "cancelled"),
    ).rejects.toBeInstanceOf(AccessDeniedError);

    // 2. Visitor cannot claim delivery for Owner's run
    await store.lifecycle.createDelivery(ownerGroup, {
      runId: ownerRes.run.id,
      dedupKey: "result",
      destination: ownerGroup.scope,
      payloadText: "secret result",
      payloadKind: "result",
    });
    const deliveries = await store.lifecycle.listDeliveries(ownerGroup, ownerRes.run.id);
    const deliveryId = deliveries.items[0]!.id;

    await expect(
      store.lifecycle.claimDelivery(visitorGroup, ownerRes.run.id, deliveryId),
    ).rejects.toBeInstanceOf(AccessDeniedError);

    // 3. Visitor cannot read Owner's run directly
    await expect(store.conversations.getRun(visitorGroup, ownerRes.run.id)).rejects.toBeInstanceOf(
      AccessDeniedError,
    );

    // 4. Visitor cannot read Owner's run input / exchanges
    await expect(
      store.conversations.loadRunInput(visitorGroup, ownerRes.run.id),
    ).rejects.toBeInstanceOf(AccessDeniedError);

    // 5. Visitor cannot write trace on Owner's run
    await expect(
      store.evidence.advanceTrace(visitorGroup, {
        runId: ownerRes.run.id,
        traceRef: "trace-hijack",
        byteOffset: 10,
        eventCount: 1,
      }),
    ).rejects.toBeInstanceOf(AccessDeniedError);
  });

  it("returns duplicate without running twice on message replay", async () => {
    const store = await setupStore();

    const first = await store.conversations.acceptIncoming({
      agentId: "personal",
      scope: ownerGroup.scope,
      messageId: "replay-msg-1",
      text: "original message",
      executionRef: "executor-main",
    });
    expect(first.duplicate).toBe(false);

    const second = await store.conversations.acceptIncoming({
      agentId: "personal",
      scope: ownerGroup.scope,
      messageId: "replay-msg-1",
      text: "original message",
      executionRef: "executor-main",
    });
    expect(second.duplicate).toBe(true);
    expect(second.run.id).toBe(first.run.id);

    // Messages and runs in conversation are not duplicated
    const messages = await store.conversations.listMessages(ownerGroup, first.conversation.id);
    expect(messages.items.filter((m) => m.text === "original message")).toHaveLength(1);

    const runs = await store.conversations.listRuns(ownerGroup, first.conversation.id);
    expect(runs.items).toHaveLength(1);
  });

  it("persists each actor identity on runs across server restart (listRunRoutes recovers each run actor)", async () => {
    const directory = await mkdtemp(join(tmpdir(), "glassbox-shared-group-"));
    tempDirectories.push(directory);
    const databasePath = join(directory, "shared-group.db");

    const store = await setupStore(databasePath);

    const ownerRes = await store.conversations.acceptIncoming({
      agentId: "personal",
      scope: ownerGroup.scope,
      messageId: "persist-owner",
      text: "owner run",
      executionRef: "executor-main",
    });

    const visitorRes = await store.conversations.acceptIncoming({
      agentId: "personal",
      scope: visitorGroup.scope,
      messageId: "persist-visitor",
      text: "visitor run",
      executionRef: "executor-main",
    });

    expect(ownerRes.conversation.id).toBe(visitorRes.conversation.id);

    // Close and reopen database
    await store.close();
    stores.splice(stores.indexOf(store), 1);

    const reopened = await openDomainStore({ databasePath });
    stores.push(reopened);

    const routes = await reopened.lifecycle.listRunRoutes(["queued"]);
    const ownerRoute = routes.find((r) => r.runId === ownerRes.run.id);
    const visitorRoute = routes.find((r) => r.runId === visitorRes.run.id);

    expect(ownerRoute).toBeDefined();
    expect(visitorRoute).toBeDefined();

    expect(ownerRoute!.caller.principalId).toBe("owner");
    expect(ownerRoute!.caller.scope.senderId).toBe("owner-qq");

    expect(visitorRoute!.caller.principalId).toBe("visitor");
    expect(visitorRoute!.caller.scope.senderId).toBe("visitor-qq");

    // Both routes point to the same shared conversation
    expect(ownerRoute!.conversationId).toBe(visitorRoute!.conversationId);
  });

  it("maintains independent revoke and approval mechanisms in shared group context", async () => {
    const store = await openStore();
    await store.conversations.createAgent("personal");
    await store.identities.bindOwner("owner", ownerGroup.scope);
    await store.identities.createPrincipal("visitor", "visitor");
    await store.identities.bindPrincipal("visitor", visitorGroup.scope);

    // Owner has allow grant
    await store.authorization.grant({
      principalId: "owner",
      resourceId: agentResourceId("personal"),
      action: "run:create",
      scope: ownerGroup.scope,
      effect: "allow",
    });

    // Visitor has approval grant
    const visitorGrantId = await store.authorization.grant({
      principalId: "visitor",
      resourceId: agentResourceId("personal"),
      action: "run:create",
      scope: visitorGroup.scope,
      effect: "approval",
    });

    // 1. Visitor without approval is rejected
    await expect(
      store.conversations.acceptIncoming({
        agentId: "personal",
        scope: visitorGroup.scope,
        messageId: "approval-test-1",
        text: "visitor need approval",
        executionRef: "executor-main",
      }),
    ).rejects.toMatchObject({ decision: { reason: "approval_required" } });

    // 2. Owner approves
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    const approvalId = await store.authorization.approve({
      grantId: visitorGrantId,
      approverId: "owner",
      expiresAt,
    });

    // 3. Visitor with approval succeeds
    const visitorRun = await store.conversations.acceptIncoming({
      agentId: "personal",
      scope: visitorGroup.scope,
      messageId: "approval-test-1",
      text: "visitor need approval",
      executionRef: "executor-main",
      approvalId,
    });
    expect(visitorRun.run.status).toBe("queued");

    // 4. Revoking visitor grant does not affect Owner grant
    await store.authorization.revoke(visitorGrantId);

    // Re-grant read so list works
    await store.authorization.grant({
      principalId: "owner",
      resourceId: agentResourceId("personal"),
      action: "conversation:read",
      scope: ownerGroup.scope,
      effect: "allow",
    });

    // Owner can still create runs
    const ownerRun = await store.conversations.acceptIncoming({
      agentId: "personal",
      scope: ownerGroup.scope,
      messageId: "owner-after-revoke",
      text: "owner still works",
      executionRef: "executor-main",
    });
    expect(ownerRun.run.status).toBe("queued");

    // Visitor cannot create runs anymore
    await expect(
      store.conversations.acceptIncoming({
        agentId: "personal",
        scope: visitorGroup.scope,
        messageId: "visitor-blocked",
        text: "blocked visitor",
        executionRef: "executor-main",
      }),
    ).rejects.toMatchObject({ decision: { reason: "no_grant" } });
  });

  it("safely migrates from V1/V2/V3 to V4 preserving legacy split conversations and resolving duplicate active grants", async () => {
    const directory = await mkdtemp(join(tmpdir(), "glassbox-migration-"));
    tempDirectories.push(directory);
    const databasePath = join(directory, "legacy-migration.db");

    // Create database manually with V1 schema
    const rawClient = createClient({ url: localDatabaseUrl(databasePath) });
    await rawClient.execute("PRAGMA foreign_keys = ON");

    // Schema V1 DDL
    const v1Schema = [
      `CREATE TABLE agents (id TEXT PRIMARY KEY, created_at TEXT NOT NULL)`,
      `CREATE TABLE principals (id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('owner','visitor')), created_at TEXT NOT NULL)`,
      `CREATE UNIQUE INDEX one_owner ON principals(kind) WHERE kind = 'owner'`,
      `CREATE TABLE channel_identities (identity_key TEXT PRIMARY KEY, principal_id TEXT NOT NULL REFERENCES principals(id), created_at TEXT NOT NULL)`,
      `CREATE TABLE resources (id TEXT PRIMARY KEY, kind TEXT NOT NULL, visibility TEXT NOT NULL CHECK(visibility IN ('public','private')), owner_id TEXT REFERENCES principals(id))`,
      `CREATE TABLE grants (id TEXT PRIMARY KEY, principal_id TEXT NOT NULL REFERENCES principals(id), resource_id TEXT NOT NULL REFERENCES resources(id), action TEXT NOT NULL, scope_key TEXT NOT NULL, effect TEXT NOT NULL CHECK(effect IN ('allow','approval')), revoked_at TEXT, created_at TEXT NOT NULL)`,
      `CREATE INDEX grant_lookup ON grants(principal_id, resource_id, action, scope_key) WHERE revoked_at IS NULL`,
      `CREATE TABLE approvals (id TEXT PRIMARY KEY, grant_id TEXT NOT NULL REFERENCES grants(id), approver_id TEXT NOT NULL REFERENCES principals(id), principal_id TEXT NOT NULL REFERENCES principals(id), resource_id TEXT NOT NULL REFERENCES resources(id), action TEXT NOT NULL, scope_key TEXT NOT NULL, expires_at TEXT NOT NULL, consumed_at TEXT, created_at TEXT NOT NULL)`,
      `CREATE TABLE conversations (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES agents(id), principal_id TEXT NOT NULL REFERENCES principals(id), scope_key TEXT NOT NULL, scope_json TEXT NOT NULL, resource_id TEXT NOT NULL UNIQUE REFERENCES resources(id), provider_kind TEXT, provider_session_id TEXT, created_at TEXT NOT NULL, UNIQUE(agent_id, scope_key), UNIQUE(provider_kind, provider_session_id))`,
      `CREATE TABLE messages (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id), scope_key TEXT NOT NULL, external_id TEXT NOT NULL, text TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(scope_key, external_id))`,
      `CREATE TABLE runs (sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, conversation_id TEXT NOT NULL REFERENCES conversations(id), message_id TEXT NOT NULL UNIQUE REFERENCES messages(id), execution_ref TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('queued','running','cancelling','cancelled','succeeded','failed','interrupted','unknown')), result_text TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
      `CREATE UNIQUE INDEX one_active_run_per_conversation ON runs(conversation_id) WHERE status IN ('running','cancelling')`,
      `CREATE INDEX runs_page ON runs(conversation_id, created_at, id)`,
      `CREATE INDEX conversations_page ON conversations(principal_id, scope_key, created_at, id)`,
      `CREATE TABLE deliveries (id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), dedup_key TEXT NOT NULL, destination_scope_key TEXT NOT NULL, payload_text TEXT NOT NULL, payload_kind TEXT NOT NULL CHECK(payload_kind IN ('text','result','ack')), status TEXT NOT NULL CHECK(status IN ('pending','sending','sent','failed','unknown')), external_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(run_id, dedup_key))`,
      `CREATE TABLE authorization_decisions (id TEXT PRIMARY KEY, principal_id TEXT, resource_id TEXT NOT NULL, action TEXT NOT NULL, scope_key TEXT NOT NULL, decision TEXT NOT NULL CHECK(decision IN ('ALLOW','DENY','REQUIRES_APPROVAL')), reason TEXT NOT NULL, grant_id TEXT, approval_id TEXT, conversation_id TEXT REFERENCES conversations(id), run_id TEXT REFERENCES runs(id), created_at TEXT NOT NULL)`,
      `CREATE INDEX decisions_page ON authorization_decisions(principal_id, scope_key, created_at, id)`,
      `CREATE TABLE trace_cursors (run_id TEXT PRIMARY KEY REFERENCES runs(id), trace_ref TEXT NOT NULL, byte_offset INTEGER NOT NULL CHECK(byte_offset >= 0), event_count INTEGER NOT NULL CHECK(event_count >= 0), updated_at TEXT NOT NULL)`,
      `CREATE TABLE eval_results (id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), sample_id TEXT NOT NULL, scorer_version TEXT NOT NULL, trace_ref TEXT NOT NULL, trace_start INTEGER NOT NULL CHECK(trace_start >= 0), trace_end INTEGER NOT NULL CHECK(trace_end >= trace_start), expected TEXT NOT NULL, observed TEXT NOT NULL, passed INTEGER NOT NULL CHECK(passed IN (0,1)), input_tokens INTEGER CHECK(input_tokens >= 0), output_tokens INTEGER CHECK(output_tokens >= 0), duration_ms INTEGER CHECK(duration_ms >= 0), created_at TEXT NOT NULL)`,
      `CREATE TABLE tasks (id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT, status TEXT NOT NULL CHECK(status IN ('NEW','QUEUED','ASSIGNED','RUNNING','WAITING_INPUT','REVIEW','ACCEPTED','DONE','FAILED','CANCELED')), priority TEXT NOT NULL CHECK(priority IN ('low','normal','high','urgent')), creator_principal_id TEXT NOT NULL REFERENCES principals(id), conversation_id TEXT REFERENCES conversations(id), run_id TEXT REFERENCES runs(id), active_attempt_id TEXT, acceptance_criteria_json TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
      `CREATE INDEX tasks_status ON tasks(status, created_at)`,
      `CREATE TABLE task_attempts (id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), attempt_number INTEGER NOT NULL, status TEXT NOT NULL CHECK(status IN ('pending','running','waiting_input','review','succeeded','failed','canceled')), rework_reason TEXT, started_at TEXT NOT NULL, completed_at TEXT, result_summary TEXT, UNIQUE(task_id, attempt_number))`,
      `CREATE TABLE worker_bindings (id TEXT PRIMARY KEY, task_attempt_id TEXT NOT NULL UNIQUE REFERENCES task_attempts(id), herdr_session TEXT NOT NULL, workspace_id TEXT NOT NULL, pane_id TEXT NOT NULL, tab_id TEXT, worktree_path TEXT, branch TEXT, agent_name TEXT, agent_kind TEXT NOT NULL, last_observed_agent_state TEXT NOT NULL CHECK(last_observed_agent_state IN ('starting','working','blocked','idle','done','unknown')), updated_at TEXT NOT NULL)`,
      `CREATE TABLE attention_items (id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('unanswered_message','worker_blocked','approval_required','task_review','task_failed','delivery_failed','ops_connection_problem')), summary TEXT NOT NULL, principal_id TEXT REFERENCES principals(id), conversation_id TEXT REFERENCES conversations(id), task_id TEXT REFERENCES tasks(id), task_attempt_id TEXT REFERENCES task_attempts(id), created_at TEXT NOT NULL, resolved_at TEXT)`,
      `CREATE INDEX attention_items_kind ON attention_items(kind, resolved_at)`,
    ];
    await rawClient.batch(v1Schema);
    await rawClient.execute("PRAGMA user_version = 1");

    // Populate legacy data
    const now = new Date().toISOString();
    await rawClient.execute({
      sql: "INSERT INTO agents(id, created_at) VALUES ('personal', ?)",
      args: [now],
    });
    await rawClient.execute({
      sql: "INSERT INTO principals(id, kind, created_at) VALUES ('owner', 'owner', ?)",
      args: [now],
    });
    await rawClient.execute({
      sql: "INSERT INTO principals(id, kind, created_at) VALUES ('visitor', 'visitor', ?)",
      args: [now],
    });
    await rawClient.execute({
      sql: "INSERT INTO resources(id, kind, visibility) VALUES ('agent:personal', 'agent', 'public')",
      args: [],
    });

    // Insert channel identity for owner
    await rawClient.execute({
      sql: "INSERT INTO channel_identities(identity_key, principal_id, created_at) VALUES (?, 'owner', ?)",
      args: [identityKey(ownerGroup.scope), now],
    });

    // Insert duplicate active grants with effect 'approval'
    const grantKey = scopeKey(ownerGroup.scope);
    await rawClient.execute({
      sql: "INSERT INTO grants(id, principal_id, resource_id, action, scope_key, effect, created_at) VALUES ('g1', 'owner', 'agent:personal', 'run:create', ?, 'approval', '2026-09-01T00:00:00.000Z')",
      args: [grantKey],
    });
    await rawClient.execute({
      sql: "INSERT INTO grants(id, principal_id, resource_id, action, scope_key, effect, created_at) VALUES ('g2', 'owner', 'agent:personal', 'run:create', ?, 'approval', '2026-09-01T01:00:00.000Z')",
      args: [grantKey],
    });

    // Insert an approval bound explicitly to duplicate grant g2
    await rawClient.execute({
      sql: "INSERT INTO approvals(id, grant_id, approver_id, principal_id, resource_id, action, scope_key, expires_at, created_at) VALUES ('app-g2', 'g2', 'owner', 'owner', 'agent:personal', 'run:create', ?, '2099-01-01T00:00:00.000Z', '2026-09-01T01:05:00.000Z')",
      args: [grantKey],
    });

    // Insert legacy split group conversations (Owner conversation + Visitor conversation in the SAME group)
    const ownerConvScope = ownerGroup.scope;
    const visitorConvScope = visitorGroup.scope;
    const ownerConvKey = scopeKey(ownerConvScope);
    const visitorConvKey = scopeKey(visitorConvScope);

    await rawClient.execute({
      sql: "INSERT INTO resources(id, kind, visibility, owner_id) VALUES ('conversation:c-owner', 'conversation', 'public', 'owner')",
      args: [],
    });
    await rawClient.execute({
      sql: "INSERT INTO resources(id, kind, visibility, owner_id) VALUES ('conversation:c-visitor', 'conversation', 'public', 'visitor')",
      args: [],
    });

    await rawClient.execute({
      sql: "INSERT INTO conversations(id, agent_id, principal_id, scope_key, scope_json, resource_id, provider_kind, provider_session_id, created_at) VALUES ('c-owner', 'personal', 'owner', ?, ?, 'conversation:c-owner', 'exec-1', 'session-legacy-1', '2026-09-01T00:00:00.000Z')",
      args: [ownerConvKey, JSON.stringify(ownerConvScope)],
    });
    await rawClient.execute({
      sql: "INSERT INTO conversations(id, agent_id, principal_id, scope_key, scope_json, resource_id, created_at) VALUES ('c-visitor', 'personal', 'visitor', ?, ?, 'conversation:c-visitor', '2026-09-01T02:00:00.000Z')",
      args: [visitorConvKey, JSON.stringify(visitorConvScope)],
    });

    // Insert legacy messages and runs (without principal_id or scope_json columns)
    await rawClient.execute({
      sql: "INSERT INTO messages(id, conversation_id, scope_key, external_id, text, created_at) VALUES ('m-owner', 'c-owner', ?, 'ext-1', 'hello owner', '2026-09-01T00:01:00.000Z')",
      args: [ownerConvKey],
    });
    await rawClient.execute({
      sql: "INSERT INTO runs(id, conversation_id, message_id, execution_ref, status, created_at, updated_at) VALUES ('r-owner', 'c-owner', 'm-owner', 'exec-1', 'succeeded', '2026-09-01T00:01:00.000Z', '2026-09-01T00:01:05.000Z')",
      args: [],
    });

    await rawClient.execute({
      sql: "INSERT INTO messages(id, conversation_id, scope_key, external_id, text, created_at) VALUES ('m-visitor', 'c-visitor', ?, 'ext-2', 'hello visitor', '2026-09-01T02:01:00.000Z')",
      args: [visitorConvKey],
    });
    await rawClient.execute({
      sql: "INSERT INTO runs(id, conversation_id, message_id, execution_ref, status, created_at, updated_at) VALUES ('r-visitor', 'c-visitor', 'm-visitor', 'exec-1', 'succeeded', '2026-09-01T02:01:00.000Z', '2026-09-01T02:01:05.000Z')",
      args: [],
    });

    rawClient.close();

    // Now open using DomainDatabase.open which will run V2, V3, and V4 migrations
    const store = await openStore(databasePath);

    // 1. Verify V3/V4 duplicate active grants remain exact rows unchanged (revoked_at IS NULL)
    const rawCheck = createClient({ url: localDatabaseUrl(databasePath) });
    const gRows = await rawCheck.execute("SELECT id, revoked_at FROM grants ORDER BY id");
    expect(gRows.rows).toHaveLength(2);
    expect(gRows.rows[0]?.id).toBe("g1");
    expect(gRows.rows[0]?.revoked_at).toBeNull();
    expect(gRows.rows[1]?.id).toBe("g2");
    expect(gRows.rows[1]?.revoked_at).toBeNull();

    // 2. Verify non-unique index exists and one_active_grant unique index was dropped
    const idxRows = await rawCheck.execute("SELECT name FROM sqlite_master WHERE type = 'index'");
    const idxNames = new Set(idxRows.rows.map((r) => r.name));
    expect(idxNames.has("grant_lookup_active")).toBe(true);
    expect(idxNames.has("one_active_grant")).toBe(false);

    // 3. Verify approval referencing duplicate grant g2 works and is consumed
    const accepted = await store.conversations.acceptIncoming({
      agentId: "personal",
      scope: ownerGroup.scope,
      messageId: "msg-post-migration",
      text: "testing approval on g2",
      executionRef: "exec-1",
      approvalId: "app-g2",
    });
    expect(accepted.run.status).toBe("queued");
    const appCheck = await rawCheck.execute(
      "SELECT consumed_at FROM approvals WHERE id = 'app-g2'",
    );
    expect(appCheck.rows[0]?.consumed_at).not.toBeNull();

    // 4. Verify idempotent grant() returns existing grant without creating extra rows
    const returnedGrantId = await store.authorization.grant({
      principalId: "owner",
      resourceId: "agent:personal",
      action: "run:create",
      scope: ownerGroup.scope,
      effect: "approval",
    });
    expect(["g1", "g2"]).toContain(returnedGrantId);
    const countGrants = await rawCheck.execute("SELECT COUNT(*) as count FROM grants");
    expect(Number(countGrants.rows[0]?.count)).toBe(2);

    // 5. Verify provider_session_principal_id was backfilled
    const cOwnerRow = await rawCheck.execute(
      "SELECT provider_session_principal_id FROM conversations WHERE id = 'c-owner'",
    );
    expect(cOwnerRow.rows[0]?.provider_session_principal_id).toBe("owner");

    // 6. Verify both legacy conversations are preserved
    const convRows = await rawCheck.execute("SELECT id FROM conversations ORDER BY id");
    expect(convRows.rows.map((r) => r.id)).toEqual(["c-owner", "c-visitor"]);

    // 7. Verify conversation_locations maps canonical group location to earliest conversation
    const locRows = await rawCheck.execute(
      "SELECT location_key, conversation_id FROM conversation_locations",
    );
    const groupLocKey = conversationScopeKey(ownerGroup.scope);
    expect(locRows.rows.find((r) => r.location_key === groupLocKey)?.conversation_id).toBe(
      "c-owner",
    );

    // 8. Verify runs were backfilled with principal_id and scope_json
    const runRows = await rawCheck.execute(
      "SELECT id, principal_id, scope_json FROM runs ORDER BY id",
    );
    const rOwner = runRows.rows.find((r) => r.id === "r-owner");
    const rVisitor = runRows.rows.find((r) => r.id === "r-visitor");
    expect(rOwner?.principal_id).toBe("owner");
    expect(rOwner?.scope_json).toBe(JSON.stringify(ownerConvScope));
    expect(rVisitor?.principal_id).toBe("visitor");
    expect(rVisitor?.scope_json).toBe(JSON.stringify(visitorConvScope));

    // 9. Verify zero foreign key violations
    const fkViolations = await rawCheck.execute("PRAGMA foreign_key_check");
    expect(fkViolations.rows).toHaveLength(0);

    // 10. Verify all current migrations completed. V7 adds the P4B channel history
    // archive (channel_messages + FTS index) and group capability policies.
    const ver = await rawCheck.execute("PRAGMA user_version");
    expect(Number(ver.rows[0]?.user_version)).toBe(8);

    rawCheck.close();
  });

  it("isolates history and runtime provider session across actors in shared group, withholding undelivered or withheld results from Visitor context", async () => {
    const store = await setupStore();

    // 1. Owner runs a turn with confidential canary in result_text
    const ownerRes = await store.conversations.acceptIncoming({
      agentId: "personal",
      scope: ownerGroup.scope,
      messageId: "msg-owner-canary",
      text: "tell me confidential canary",
      executionRef: "executor-main",
    });

    const canaryText = "CANARY_SECRET_DATA_XYZ_999";
    const runLease1 = await store.lifecycle.claimQueuedRun(ownerGroup, ownerRes.run.id);
    await runLease1.settle("succeeded", canaryText);

    // Set provider session for the conversation as Owner
    await store.conversations.setProviderSession(
      ownerGroup,
      ownerRes.conversation.id,
      "executor-main",
      "session-owner-private",
    );

    // Case A: Delivery is unattempted.
    // Visitor sends incoming message and loads run input
    const visitorRes1 = await store.conversations.acceptIncoming({
      agentId: "personal",
      scope: visitorGroup.scope,
      messageId: "msg-visitor-unattempted",
      text: "hello assistant from visitor",
      executionRef: "executor-main",
    });

    const visitorInput1 = await store.conversations.loadRunInput(visitorGroup, visitorRes1.run.id);

    // Visitor must NOT receive Owner's provider session
    expect(visitorInput1.providerSessionId).toBeNull();
    expect(visitorInput1.conversation.providerSessionId).toBeNull();

    // Visitor must NOT receive Owner's unattempted run in history
    expect(visitorInput1.history).toHaveLength(0);
    expect(JSON.stringify(visitorInput1)).not.toContain(canaryText);

    // Case B: Delivery was attempted but not sent (e.g. pending / failed)
    await store.lifecycle.createDelivery(ownerGroup, {
      runId: ownerRes.run.id,
      dedupKey: "delivery-pending",
      destination: ownerGroup.scope,
      payloadText: canaryText,
      payloadKind: "result",
    });
    const visitorInput1b = await store.conversations.loadRunInput(visitorGroup, visitorRes1.run.id);
    expect(visitorInput1b.history).toHaveLength(0);
    expect(JSON.stringify(visitorInput1b)).not.toContain(canaryText);

    // Settle visitor run 1 so queue progresses
    const visLease1 = await store.lifecycle.claimQueuedRun(visitorGroup, visitorRes1.run.id);
    await visLease1.settle("succeeded", "visitor answer 1");

    // Case C: Legitimate allowed shared history
    // Owner completes a public turn and delivery is confirmed sent to the shared group
    const ownerRes2 = await store.conversations.acceptIncoming({
      agentId: "personal",
      scope: ownerGroup.scope,
      messageId: "msg-owner-public",
      text: "public question for group",
      executionRef: "executor-main",
    });
    const publicAnswer = "PUBLIC_SHARED_ANSWER_ABC";
    const runLease2 = await store.lifecycle.claimQueuedRun(ownerGroup, ownerRes2.run.id);
    await runLease2.settle("succeeded", publicAnswer);

    const deliveryId2 = await store.lifecycle.createDelivery(ownerGroup, {
      runId: ownerRes2.run.id,
      dedupKey: "result-public",
      destination: ownerGroup.scope,
      payloadText: publicAnswer,
      payloadKind: "result",
    });
    const lease = await store.lifecycle.claimDelivery(ownerGroup, ownerRes2.run.id, deliveryId2);
    expect(lease).not.toBeNull();
    await lease!.settle("sent", "ext-sent-2");

    // Visitor sends another incoming message
    const visitorRes2 = await store.conversations.acceptIncoming({
      agentId: "personal",
      scope: visitorGroup.scope,
      messageId: "msg-visitor-turn2",
      text: "visitor question 2",
      executionRef: "executor-main",
    });

    const visitorInput2 = await store.conversations.loadRunInput(visitorGroup, visitorRes2.run.id);

    // Legitimate public answer IS present in visitor history alongside visitor's own past turn
    expect(visitorInput2.history).toEqual([
      { role: "user", text: "hello assistant from visitor" },
      { role: "assistant", text: "visitor answer 1" },
      { role: "user", text: "public question for group" },
      { role: "assistant", text: publicAnswer },
    ]);
    // Confidential canary is STILL omitted from visitor history
    expect(JSON.stringify(visitorInput2)).not.toContain(canaryText);
    // Provider session is still isolated
    expect(visitorInput2.providerSessionId).toBeNull();

    // Owner loading their own run input sees their own history and resumes session
    const ownerInput2 = await store.conversations.loadRunInput(ownerGroup, ownerRes2.run.id);
    expect(ownerInput2.providerSessionId).toBe("session-owner-private");

    // Case D: Revoked authority prevents loading run input
    // Revoke visitor's conversation:read grant
    const visitorReadGrantId = await store.authorization.grant({
      principalId: "visitor",
      resourceId: agentResourceId("personal"),
      action: "conversation:read",
      scope: visitorGroup.scope,
      effect: "allow",
    });
    await store.authorization.revoke(visitorReadGrantId);

    await expect(
      store.conversations.loadRunInput(visitorGroup, visitorRes2.run.id),
    ).rejects.toBeInstanceOf(AccessDeniedError);
  });

  it("withholds confidential run result_text from Visitor history when delivered payload is redacted/summarized", async () => {
    const store = await setupStore();

    // Owner runs a turn where the raw result contains confidential canary + public summary
    const ownerRes = await store.conversations.acceptIncoming({
      agentId: "personal",
      scope: ownerGroup.scope,
      messageId: "msg-owner-secret-raw",
      text: "run task with confidential internals",
      executionRef: "executor-main",
    });

    const canarySecret = "SECRET_CANARY_RAW_DATA_987654";
    const publicSummary = "Public summary only: task completed successfully.";
    const rawResult = `${canarySecret} plus ${publicSummary}`;

    const ownerLease = await store.lifecycle.claimQueuedRun(ownerGroup, ownerRes.run.id);
    await ownerLease.settle("succeeded", rawResult);

    // Delivery to the shared group contains ONLY the sanitized public summary
    const deliveryId = await store.lifecycle.createDelivery(ownerGroup, {
      runId: ownerRes.run.id,
      dedupKey: "result-summary",
      destination: ownerGroup.scope,
      payloadText: publicSummary,
      payloadKind: "result",
    });

    const delLease = await store.lifecycle.claimDelivery(ownerGroup, ownerRes.run.id, deliveryId);
    expect(delLease).not.toBeNull();
    await delLease!.settle("sent", "ext-del-1");

    // Visitor triggers next turn in the shared group
    const visitorRes = await store.conversations.acceptIncoming({
      agentId: "personal",
      scope: visitorGroup.scope,
      messageId: "msg-visitor-read-history",
      text: "what was the result?",
      executionRef: "executor-main",
    });

    const visitorInput = await store.conversations.loadRunInput(visitorGroup, visitorRes.run.id);

    // Visitor's history MUST contain ONLY the delivered payloadText, NEVER the raw result_text
    expect(visitorInput.history).toEqual([
      { role: "user", text: "run task with confidential internals" },
      { role: "assistant", text: publicSummary },
    ]);
    expect(JSON.stringify(visitorInput)).not.toContain(canarySecret);
  });

  it("excludes same-principal prior run from history if the grant authorizing that prior run was revoked", async () => {
    const store = await openStore();
    await store.conversations.createAgent("personal");
    await store.identities.bindOwner("owner", ownerGroup.scope);

    // Owner initially has grant1 for run:create and conversation:read
    const grantRunCreate1 = await store.authorization.grant({
      principalId: "owner",
      resourceId: agentResourceId("personal"),
      action: "run:create",
      scope: ownerGroup.scope,
      effect: "allow",
    });
    await store.authorization.grant({
      principalId: "owner",
      resourceId: agentResourceId("personal"),
      action: "conversation:read",
      scope: ownerGroup.scope,
      effect: "allow",
    });
    await store.authorization.grant({
      principalId: "owner",
      resourceId: agentResourceId("personal"),
      action: "run:control",
      scope: ownerGroup.scope,
      effect: "allow",
    });

    // Run 1 is created under grantRunCreate1
    const run1Res = await store.conversations.acceptIncoming({
      agentId: "personal",
      scope: ownerGroup.scope,
      messageId: "msg-owner-run1",
      text: "turn 1 under grant1",
      executionRef: "executor-main",
    });
    const lease1 = await store.lifecycle.claimQueuedRun(ownerGroup, run1Res.run.id);
    await lease1.settle("succeeded", "turn 1 confidential answer");

    // Revoke the grant that authorized Run 1
    await store.authorization.revoke(grantRunCreate1);

    // Owner is granted a NEW grant for run:create
    await store.authorization.grant({
      principalId: "owner",
      resourceId: agentResourceId("personal"),
      action: "run:create",
      scope: ownerGroup.scope,
      effect: "allow",
    });

    // Run 2 is created under the new grant
    const run2Res = await store.conversations.acceptIncoming({
      agentId: "personal",
      scope: ownerGroup.scope,
      messageId: "msg-owner-run2",
      text: "turn 2 under grant2",
      executionRef: "executor-main",
    });

    // Load run input for Run 2
    const input2 = await store.conversations.loadRunInput(ownerGroup, run2Res.run.id);

    // Prior run 1 authorized by revoked grant MUST be excluded from history
    expect(input2.history).toHaveLength(0);
    expect(JSON.stringify(input2)).not.toContain("turn 1 confidential answer");
  });

  it("excludes cross-actor prior run from history if the grant authorizing that prior run was revoked", async () => {
    const store = await openStore();
    await store.conversations.createAgent("personal");
    await store.identities.bindOwner("owner", ownerGroup.scope);
    await store.identities.createPrincipal("visitor", "visitor");
    await store.identities.bindPrincipal("visitor", visitorGroup.scope);

    // 1. Initial grants for Owner
    const ownerRunGrant = await store.authorization.grant({
      principalId: "owner",
      resourceId: agentResourceId("personal"),
      action: "run:create",
      scope: ownerGroup.scope,
      effect: "allow",
    });
    await store.authorization.grant({
      principalId: "owner",
      resourceId: agentResourceId("personal"),
      action: "conversation:read",
      scope: ownerGroup.scope,
      effect: "allow",
    });
    await store.authorization.grant({
      principalId: "owner",
      resourceId: agentResourceId("personal"),
      action: "run:control",
      scope: ownerGroup.scope,
      effect: "allow",
    });

    // Grants for Visitor
    await store.authorization.grant({
      principalId: "visitor",
      resourceId: agentResourceId("personal"),
      action: "run:create",
      scope: visitorGroup.scope,
      effect: "allow",
    });
    await store.authorization.grant({
      principalId: "visitor",
      resourceId: agentResourceId("personal"),
      action: "conversation:read",
      scope: visitorGroup.scope,
      effect: "allow",
    });
    await store.authorization.grant({
      principalId: "visitor",
      resourceId: agentResourceId("personal"),
      action: "run:control",
      scope: visitorGroup.scope,
      effect: "allow",
    });

    // 2. Owner runs a turn in the shared group and delivers payload
    await store.authorization.grant({
      principalId: "owner",
      resourceId: agentResourceId("personal"),
      action: "delivery:send",
      scope: ownerGroup.scope,
      effect: "allow",
    });
    const ownerRes = await store.conversations.acceptIncoming({
      agentId: "personal",
      scope: ownerGroup.scope,
      messageId: "msg-owner-to-revoke",
      text: "owner confidential turn",
      executionRef: "executor-main",
    });

    const ownerLease = await store.lifecycle.claimQueuedRun(ownerGroup, ownerRes.run.id);
    await ownerLease.settle("succeeded", "confidential answer from owner");

    const deliveryId = await store.lifecycle.createDelivery(ownerGroup, {
      runId: ownerRes.run.id,
      dedupKey: "del-owner-1",
      destination: ownerGroup.scope,
      payloadText: "delivered text from owner",
      payloadKind: "result",
    });
    const delLease = await store.lifecycle.claimDelivery(ownerGroup, ownerRes.run.id, deliveryId);
    expect(delLease).not.toBeNull();
    await delLease!.settle("sent", "ext-owner-del-1");

    // 3. Revoke Owner's grant
    await store.authorization.revoke(ownerRunGrant);

    // 4. Visitor triggers next turn in the shared group
    const visitorRes = await store.conversations.acceptIncoming({
      agentId: "personal",
      scope: visitorGroup.scope,
      messageId: "msg-visitor-turn-after-revoke",
      text: "visitor asks something",
      executionRef: "executor-main",
    });

    const visitorInput = await store.conversations.loadRunInput(visitorGroup, visitorRes.run.id);

    // Cross-actor delivered payload MUST be excluded from Visitor's history because the prior run's grant was revoked
    expect(visitorInput.history).toHaveLength(0);
    expect(JSON.stringify(visitorInput)).not.toContain("delivered text from owner");
    expect(JSON.stringify(visitorInput)).not.toContain("confidential answer from owner");
  });

  it("fails closed and excludes unproven prior runs (with 0 valid grant decisions) from history", async () => {
    const store = await setupStore();

    // 1. Owner creates legitimate Run 1
    const ownerRes1 = await store.conversations.acceptIncoming({
      agentId: "personal",
      scope: ownerGroup.scope,
      messageId: "msg-legit-1",
      text: "legit turn 1",
      executionRef: "executor-main",
    });
    const lease1 = await store.lifecycle.claimQueuedRun(ownerGroup, ownerRes1.run.id);
    await lease1.settle("succeeded", "legit answer 1");

    // 2. Simulate unproven Run: insert directly into runs/messages with no authorization_decisions row
    const unprovenRunId = "run-unproven-fake";
    const unprovenMsgId = "msg-unproven-fake";
    const now = new Date().toISOString();
    await (store.conversations as any).db.transaction(async (tx: any) => {
      await tx.execute({
        sql: "INSERT INTO messages(id, conversation_id, scope_key, external_id, text, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        args: [
          unprovenMsgId,
          ownerRes1.conversation.id,
          scopeKey(ownerGroup.scope),
          "ext-unproven",
          "injected unproven prompt",
          now,
        ],
      });
      await tx.execute({
        sql: "INSERT INTO runs(id, conversation_id, message_id, principal_id, scope_json, execution_ref, status, result_text, created_at, updated_at) VALUES (?, ?, ?, 'owner', ?, 'executor-main', 'succeeded', 'injected unproven result', ?, ?)",
        args: [
          unprovenRunId,
          ownerRes1.conversation.id,
          unprovenMsgId,
          JSON.stringify(ownerGroup.scope),
          now,
          now,
        ],
      });
      await tx.execute({
        sql: "INSERT INTO deliveries(id, run_id, dedup_key, destination_scope_key, payload_text, payload_kind, status, created_at, updated_at) VALUES ('del-unproven', ?, 'del-1', ?, 'injected unproven delivery', 'result', 'sent', ?, ?)",
        args: [unprovenRunId, scopeKey(ownerGroup.scope), now, now],
      });
    });

    // 3. Owner creates Run 2
    const ownerRes2 = await store.conversations.acceptIncoming({
      agentId: "personal",
      scope: ownerGroup.scope,
      messageId: "msg-legit-2",
      text: "legit turn 2",
      executionRef: "executor-main",
    });

    // Load run input for Owner: unproven run must NOT appear
    const ownerInput2 = await store.conversations.loadRunInput(ownerGroup, ownerRes2.run.id);
    expect(ownerInput2.history).toEqual([
      { role: "user", text: "legit turn 1" },
      { role: "assistant", text: "legit answer 1" },
    ]);
    expect(JSON.stringify(ownerInput2)).not.toContain("injected unproven");

    // 4. Visitor creates a turn: unproven run must NOT appear for Visitor either
    const visitorRes = await store.conversations.acceptIncoming({
      agentId: "personal",
      scope: visitorGroup.scope,
      messageId: "msg-visitor-check-unproven",
      text: "visitor question",
      executionRef: "executor-main",
    });
    const visitorInput = await store.conversations.loadRunInput(visitorGroup, visitorRes.run.id);
    // Legit 1 wasn't delivered to group so visitor sees neither; but specifically unproven is not present
    expect(JSON.stringify(visitorInput)).not.toContain("injected unproven");
  });
});
