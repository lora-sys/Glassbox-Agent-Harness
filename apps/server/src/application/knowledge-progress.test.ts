import { afterEach, describe, expect, it } from "vite-plus/test";
import type { CallerContext, TrustedChannelScope } from "../identity/scope.js";
import { conversationScopeKey, scopeKey } from "../identity/scope.js";
import type { ConversationRecord, RunRecord } from "../conversation/store.js";
import type { ExecutionInput } from "../execution/run-service/types.js";
import { openDomainStore, type DomainStore } from "./domain-store.js";
import { KnowledgeProgressContext } from "./knowledge-progress.js";
import { agentResourceId } from "../conversation/store.js";
import {
  LORA_SITE_ROOT,
  WEBSITE_KNOWLEDGE_DELIVERY_ACTION,
  WEBSITE_KNOWLEDGE_READ_ACTION,
  WEBSITE_KNOWLEDGE_RESOURCE,
  WEBSITE_KNOWLEDGE_SYNC_ACTION,
  type KnowledgeHttpResponse,
  type KnowledgeNetworkProvider,
} from "../knowledge/index.js";
import { learningProgressResourceId } from "../learning-progress/identity.js";

const ownerScope: TrustedChannelScope = {
  connectionId: "knowledge-test",
  botId: "knowledge-bot",
  chatType: "private",
  chatId: "owner-chat",
  senderId: "owner-sender",
};
const visitorScope: TrustedChannelScope = {
  ...ownerScope,
  chatId: "visitor-chat",
  senderId: "visitor-sender",
};
const owner: CallerContext = { principalId: "owner", scope: ownerScope };
const visitor: CallerContext = { principalId: "visitor", scope: visitorScope };
const articleUrl = `${LORA_SITE_ROOT}blog/rust-learning/`;
const articleHtml = `<html lang="en"><head><title>Learning Rust</title><link rel="canonical" href="${articleUrl}"></head><body><main><article><h1>Learning Rust</h1><p>Rust concurrency patterns and safe async systems.</p></article></main></body></html>`;

function knowledgeNetwork(requests: string[]) {
  let articlePresent = true;
  const network: KnowledgeNetworkProvider = {
    resolveHost: async () => ["8.8.8.8"],
    async request(url): Promise<KnowledgeHttpResponse> {
      requests.push(url);
      if (url === LORA_SITE_ROOT)
        return { status: 200, headers: {}, body: "<html><head></head></html>" };
      if (url === new URL("/robots.txt", LORA_SITE_ROOT).href)
        return { status: 200, headers: {}, body: `Sitemap: ${LORA_SITE_ROOT}sitemap.xml` };
      if (url === `${LORA_SITE_ROOT}sitemap.xml`)
        return {
          status: 200,
          headers: {},
          body: `<urlset>${articlePresent ? `<url><loc>${articleUrl}</loc></url>` : ""}</urlset>`,
        };
      if (url === articleUrl) return { status: 200, headers: {}, body: articleHtml };
      return { status: 404, headers: {}, body: "missing" };
    },
  };
  return {
    network,
    setArticlePresent: (present: boolean) => {
      articlePresent = present;
    },
  };
}

const stores: DomainStore[] = [];
let nextRun = 0;

async function fixture() {
  const requests: string[] = [];
  const source = knowledgeNetwork(requests);
  const store = await openDomainStore({
    databasePath: ":memory:",
    knowledgeNetwork: source.network,
  });
  stores.push(store);
  await store.conversations.createAgent("personal");
  await store.identities.createPrincipal("owner", "owner");
  await store.identities.createPrincipal("visitor", "visitor");
  await store.identities.bindPrincipal(owner.principalId, owner.scope);
  await store.identities.bindPrincipal(visitor.principalId, visitor.scope);

  for (const action of ["run:create", "conversation:read", "run:control", "delivery:send"])
    await store.authorization.grant({
      principalId: owner.principalId,
      resourceId: agentResourceId("personal"),
      action,
      scope: owner.scope,
      effect: "allow",
    });

  await store.authorization.registerResource({
    id: WEBSITE_KNOWLEDGE_RESOURCE,
    kind: "website-knowledge",
    visibility: "public",
  });
  for (const action of [
    WEBSITE_KNOWLEDGE_READ_ACTION,
    WEBSITE_KNOWLEDGE_SYNC_ACTION,
    WEBSITE_KNOWLEDGE_DELIVERY_ACTION,
  ])
    await store.authorization.grant({
      principalId: owner.principalId,
      resourceId: WEBSITE_KNOWLEDGE_RESOURCE,
      action,
      scope: owner.scope,
      effect: "allow",
    });
  for (const action of [WEBSITE_KNOWLEDGE_READ_ACTION, WEBSITE_KNOWLEDGE_DELIVERY_ACTION])
    await store.authorization.grant({
      principalId: visitor.principalId,
      resourceId: WEBSITE_KNOWLEDGE_RESOURCE,
      action,
      scope: visitor.scope,
      effect: "allow",
    });

  for (const caller of [owner, visitor]) {
    const resourceId = learningProgressResourceId(caller);
    await store.authorization.registerResource({
      id: resourceId,
      kind: "learning-progress",
      visibility: "public",
      ownerId: caller.principalId,
      ifAbsent: true,
    });
    for (const action of ["progress:read", "progress:write", "progress:manage", "delivery:send"])
      await store.authorization.grant({
        principalId: caller.principalId,
        resourceId,
        action,
        scope: caller.scope,
        effect: "allow",
      });
  }
  return { store, requests, setArticlePresent: source.setArticlePresent };
}

async function acceptedInput(
  store: DomainStore,
  caller: CallerContext,
  text: string,
): Promise<ExecutionInput> {
  const accepted = await store.conversations.acceptIncoming({
    agentId: "personal",
    scope: caller.scope,
    messageId: `knowledge-accepted-${++nextRun}`,
    text,
    executionRef: "test-executor",
  });
  const loaded = await store.conversations.loadRunInput(accepted.caller, accepted.run.id);
  return { ...loaded, caller: accepted.caller, signal: new AbortController().signal };
}

async function persistedInput(
  store: DomainStore,
  caller: CallerContext,
  text: string,
): Promise<ExecutionInput> {
  const suffix = String(++nextRun);
  const locationKey = conversationScopeKey(caller.scope);
  const conversationId = `knowledge-conversation-${Buffer.from(locationKey).toString("hex")}`;
  const messageId = `knowledge-message-${suffix}`;
  const runId = `knowledge-run-${suffix}`;
  const now = new Date().toISOString();
  const serializedScope = JSON.stringify(caller.scope);
  const resourceId = `conversation:${conversationId}`;
  await store.db.transaction(async (tx) => {
    const prior = await tx.execute({
      sql: "SELECT id FROM conversations WHERE agent_id = 'personal' AND scope_key = ?",
      args: [locationKey],
    });
    if (!prior.rows[0]) {
      await tx.execute({
        sql: "INSERT INTO resources(id,kind,visibility) VALUES (?,'conversation','private')",
        args: [resourceId],
      });
      await tx.execute({
        sql: `INSERT INTO conversations(id,agent_id,principal_id,scope_key,scope_json,resource_id,created_at)
              VALUES (?,'personal',?,?,?,?,?)`,
        args: [conversationId, caller.principalId, locationKey, serializedScope, resourceId, now],
      });
    }
    await tx.execute({
      sql: "INSERT INTO messages(id,conversation_id,scope_key,external_id,text,created_at) VALUES (?,?,?,?,?,?)",
      args: [messageId, conversationId, scopeKey(caller.scope), messageId, text, now],
    });
    await tx.execute({
      sql: `INSERT INTO runs(id,conversation_id,message_id,principal_id,scope_json,execution_ref,status,source,created_at,updated_at)
            VALUES (?,?,?,?,?,?,'queued','external',?,?)`,
      args: [
        runId,
        conversationId,
        messageId,
        caller.principalId,
        serializedScope,
        "test-executor",
        now,
        now,
      ],
    });
  });
  return {
    caller,
    conversation: { id: conversationId } as ConversationRecord,
    run: {
      id: runId,
      conversationId,
      messageId,
      principalId: caller.principalId,
      source: "external",
    } as RunRecord,
    text,
    history: [],
    providerSessionId: null,
    signal: new AbortController().signal,
  };
}

afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
});

describe("KnowledgeProgressContext integration", () => {
  it("accepts commands only when caller and text match the persisted current Run", async () => {
    const { store, requests } = await fixture();
    const input = await persistedInput(store, owner, "/knowledge sync");
    const context = new KnowledgeProgressContext(store, async () => undefined);

    const edited = await context.command({ ...input, text: "/knowledge status" });
    expect(edited).toMatchObject({
      status: "failed",
      failureCode: "gate_refused",
      runtimeAttempted: false,
    });
    const wrongIdentity = await context.command({ ...input, caller: visitor });
    expect(wrongIdentity).toMatchObject({
      status: "failed",
      failureCode: "gate_refused",
      runtimeAttempted: false,
    });
    expect(requests).toEqual([]);
  });

  it("denies a visitor's website sync command before making a network request", async () => {
    const { store, requests } = await fixture();
    const input = await persistedInput(store, visitor, "/knowledge sync");
    const context = new KnowledgeProgressContext(store, async () => undefined);

    await expect(context.command(input)).resolves.toMatchObject({
      status: "failed",
      failureCode: "gate_refused",
      runtimeAttempted: false,
    });
    expect(requests).toEqual([]);
    await expect(store.knowledge.currentArticleResources()).resolves.toEqual([]);
  });

  it("retrieves current website articles into authorized personal Context", async () => {
    const { store } = await fixture();
    await store.knowledge.syncSite({ caller: owner });
    const input = await persistedInput(store, owner, "Explain Rust concurrency patterns");
    const context = new KnowledgeProgressContext(store, async () => undefined);

    const loaded = await context.load(input);
    expect(loaded.items).toHaveLength(1);
    expect(loaded.items[0]).toMatchObject({ kind: "website" });
    expect(loaded.items[0]!.text).toContain(articleUrl);
    expect(loaded.items[0]!.text).toContain("Rust concurrency patterns");
    await expect(loaded.reauthorize()).resolves.toBeUndefined();
  });

  it("blocks a pending delivery when the indexed article source is removed", async () => {
    const { store, setArticlePresent } = await fixture();
    await store.knowledge.syncSite({ caller: owner });
    const input = await acceptedInput(store, owner, "Explain Rust concurrency patterns");
    const context = new KnowledgeProgressContext(store, async () => undefined);
    const loaded = await context.load(input);
    expect(loaded.items.some((item) => item.kind === "website")).toBe(true);

    const run = await store.lifecycle.claimQueuedRun(owner, input.run.id);
    await run.settle("succeeded", "The article explains Rust concurrency.");
    const deliveryId = await store.lifecycle.createDelivery(owner, {
      runId: input.run.id,
      dedupKey: "website-source-pending-delivery",
      destination: owner.scope,
      payloadText: "The article explains Rust concurrency.",
      payloadKind: "result",
    });

    setArticlePresent(false);
    await store.knowledge.syncSite({ caller: owner });
    await expect(
      store.lifecycle.claimDelivery(owner, input.run.id, deliveryId),
    ).rejects.toMatchObject({
      decision: { decision: "DENY" },
    });
  });

  it("rejects progress Context after its persisted source revision changes", async () => {
    const { store } = await fixture();
    const source = await persistedInput(store, owner, "I want to learn Rust concurrency");
    const record = await store.progress.captureCurrentRun({
      caller: owner,
      conversationId: source.conversation.id,
      runId: source.run.id,
    });
    expect(record?.statement).toBe("Rust concurrency");

    const query = await persistedInput(store, owner, "How can I use Rust concurrency?");
    const context = new KnowledgeProgressContext(store, async () => undefined);
    const loaded = await context.load(query);
    expect(loaded.items).toContainEqual(expect.objectContaining({ kind: "learning_progress" }));
    await expect(loaded.reauthorize()).resolves.toBeUndefined();

    const correction = await persistedInput(
      store,
      owner,
      `/progress correct ${record!.id} | I am learning Rust generics`,
    );
    await expect(
      store.progress.executeCommandFromCurrentRun({
        caller: owner,
        conversationId: correction.conversation.id,
        runId: correction.run.id,
      }),
    ).resolves.toMatchObject({ action: "correct" });
    await expect(loaded.reauthorize()).rejects.toMatchObject({ decision: { decision: "DENY" } });
  });
});
