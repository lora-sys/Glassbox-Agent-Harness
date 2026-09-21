import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  openDomainStore,
  type CallerContext,
  type DomainStore,
  type TrustedChannelScope,
} from "../persistence/index.js";
import { ChannelArchiveStore, type IngestChannelMessageInput } from "./channel-archive.js";
import { resolveAuthorizedHistorySources, groupResourceId } from "./source-resolver.js";
import { MemoryRetriever } from "./retriever.js";

const connectionId = "napcat-1";
const botId = "bot-qq";

const groupScopeA: TrustedChannelScope = {
  connectionId,
  botId,
  chatType: "group",
  chatId: "100",
  senderId: "owner-a-qq",
};

const groupScopeB: TrustedChannelScope = {
  connectionId,
  botId,
  chatType: "group",
  chatId: "200",
  senderId: "owner-b-qq",
};

const groupScopeShared: TrustedChannelScope = {
  connectionId,
  botId,
  chatType: "group",
  chatId: "300",
  senderId: "owner-a-qq",
};

const ownerAPrivateScope: TrustedChannelScope = {
  connectionId,
  botId,
  chatType: "private",
  chatId: "owner-a-qq",
  senderId: "owner-a-qq",
};

const ownerBPrivateScope: TrustedChannelScope = {
  connectionId,
  botId,
  chatType: "private",
  chatId: "owner-b-qq",
  senderId: "owner-b-qq",
};

const ownerA_Private: CallerContext = {
  principalId: "owner-a",
  scope: ownerAPrivateScope,
};

const ownerB_Private: CallerContext = {
  principalId: "owner-b",
  scope: ownerBPrivateScope,
};

const ownerA_Group100: CallerContext = {
  principalId: "owner-a",
  scope: groupScopeA,
};

const stores: DomainStore[] = [];
const tempDirs: string[] = [];

async function setupStore(databasePath = ":memory:") {
  const store = await openDomainStore({ databasePath });
  stores.push(store);

  // Setup identities
  await store.conversations.createAgent("personal");
  await store.identities.bindOwner("owner-a", ownerAPrivateScope);
  await store.identities.bindOwner("owner-b", ownerBPrivateScope);
  await store.identities.bindPrincipal("owner-a", groupScopeA);
  await store.identities.bindPrincipal("owner-b", groupScopeB);
  await store.identities.bindPrincipal("owner-a", groupScopeShared);

  // Register group resources
  for (const gid of ["100", "200", "300", "400"]) {
    await store.authorization.registerResource({
      id: groupResourceId(gid),
      kind: "qq_group",
      visibility: "public",
      ifAbsent: true,
    });
  }

  return store;
}

afterEach(async () => {
  for (const s of stores.splice(0)) {
    await s.close();
  }
  for (const d of tempDirs.splice(0)) {
    await rm(d, { recursive: true, force: true }).catch((error: NodeJS.ErrnoException) => {
      // libSQL can retain Windows file handles until the test process exits.
      if (process.platform !== "win32" || error.code !== "EBUSY") throw error;
    });
  }
});

describe("P4B history:read authorization and source resolution", () => {
  it("defaults to DENY for history:read without an explicit grant", async () => {
    const store = await setupStore();

    // Check history:read on group 100 without grant
    const decision = await store.authorization.check({
      caller: ownerA_Private,
      resourceId: groupResourceId("100"),
      action: "history:read",
    });

    expect(decision.decision).toBe("DENY");
    expect(decision.reason).toBe("no_grant");

    // Conversation:read grant does NOT grant history:read
    await store.authorization.grant({
      principalId: "owner-a",
      resourceId: groupResourceId("100"),
      action: "conversation:read",
      scope: ownerAPrivateScope,
      effect: "allow",
    });

    const decisionAfterConv = await store.authorization.check({
      caller: ownerA_Private,
      resourceId: groupResourceId("100"),
      action: "history:read",
    });
    expect(decisionAfterConv.decision).toBe("DENY");
  });

  it("maintains dual Owner source sets and supports shared groups", async () => {
    const store = await setupStore();

    // Grant Owner A: group 100 and shared group 300
    await store.authorization.grant({
      principalId: "owner-a",
      resourceId: groupResourceId("100"),
      action: "history:read",
      scope: ownerAPrivateScope,
      effect: "allow",
    });
    await store.authorization.grant({
      principalId: "owner-a",
      resourceId: groupResourceId("300"),
      action: "history:read",
      scope: ownerAPrivateScope,
      effect: "allow",
    });

    // Grant Owner B: group 200 and shared group 300
    await store.authorization.grant({
      principalId: "owner-b",
      resourceId: groupResourceId("200"),
      action: "history:read",
      scope: ownerBPrivateScope,
      effect: "allow",
    });
    await store.authorization.grant({
      principalId: "owner-b",
      resourceId: groupResourceId("300"),
      action: "history:read",
      scope: ownerBPrivateScope,
      effect: "allow",
    });

    // Resolve sources for Owner A
    const sourcesA = await resolveAuthorizedHistorySources(store, ownerA_Private);
    expect(new Set(sourcesA)).toEqual(new Set(["100", "300"]));

    // Resolve sources for Owner B
    const sourcesB = await resolveAuthorizedHistorySources(store, ownerB_Private);
    expect(new Set(sourcesB)).toEqual(new Set(["200", "300"]));

    // Owner A cannot read group 200
    const checkAon200 = await store.authorization.check({
      caller: ownerA_Private,
      resourceId: groupResourceId("200"),
      action: "history:read",
    });
    expect(checkAon200.decision).toBe("DENY");

    // Owner B cannot read group 100
    const checkBon100 = await store.authorization.check({
      caller: ownerB_Private,
      resourceId: groupResourceId("100"),
      action: "history:read",
    });
    expect(checkBon100.decision).toBe("DENY");
  });

  it("applies revocation on the very next query without affecting other owners", async () => {
    const store = await setupStore();

    // Grant both to shared group 300
    const grantA = await store.authorization.grant({
      principalId: "owner-a",
      resourceId: groupResourceId("300"),
      action: "history:read",
      scope: ownerAPrivateScope,
      effect: "allow",
    });
    await store.authorization.grant({
      principalId: "owner-b",
      resourceId: groupResourceId("300"),
      action: "history:read",
      scope: ownerBPrivateScope,
      effect: "allow",
    });

    expect(await resolveAuthorizedHistorySources(store, ownerA_Private)).toContain("300");
    expect(await resolveAuthorizedHistorySources(store, ownerB_Private)).toContain("300");

    // Revoke Owner A
    await store.authorization.revoke(grantA);

    // Next query: Owner A no longer has 300, but Owner B still does
    expect(await resolveAuthorizedHistorySources(store, ownerA_Private)).not.toContain("300");
    expect(await resolveAuthorizedHistorySources(store, ownerB_Private)).toContain("300");
  });

  it("restricts group Run scope strictly to the current group", async () => {
    const store = await setupStore();

    // Owner A has private grants on 100 and 200
    await store.authorization.grant({
      principalId: "owner-a",
      resourceId: groupResourceId("100"),
      action: "history:read",
      scope: ownerAPrivateScope,
      effect: "allow",
    });
    await store.authorization.grant({
      principalId: "owner-a",
      resourceId: groupResourceId("200"),
      action: "history:read",
      scope: ownerAPrivateScope,
      effect: "allow",
    });

    // In group 100, grant history:read for group 100 scope
    await store.authorization.grant({
      principalId: "owner-a",
      resourceId: groupResourceId("100"),
      action: "history:read",
      scope: groupScopeA,
      effect: "allow",
    });

    // In group 100 run: only group 100 can be resolved, never group 200
    const groupSources = await resolveAuthorizedHistorySources(store, ownerA_Group100);
    expect(groupSources).toEqual(["100"]);
  });
});

describe("P4B channel_messages persistence, dedupe, and no fake runs", () => {
  it("ingests into channel_messages with dedupe and without creating fake runs", async () => {
    const store = await setupStore();
    const archive = new ChannelArchiveStore(store.db);

    const message1: IngestChannelMessageInput = {
      channel: "qq",
      connectionId: "napcat-1",
      groupId: "100",
      externalMessageId: "msg-001",
      senderId: "user-1",
      normalizedText: "hello world in group 100",
      occurredAt: "2026-09-20T10:00:00Z",
    };

    // First ingest
    const id1 = await archive.ingest(message1);
    expect(id1).toBeDefined();

    // Duplicate ingest with same external message ID and group
    const id2 = await archive.ingest(message1);
    expect(id2).toBe(id1); // Deduped, returns existing id

    // Verify it is in channel_messages
    const messages = await archive.searchMessages({
      allowedGroupIds: ["100"],
      query: "hello",
    });
    expect(messages).toHaveLength(1);
    expect(messages[0]?.normalizedText).toBe("hello world in group 100");

    // Verify NO fake runs or messages were created in agent conversation tables
    const runsCount = await store.db.transaction(async (tx) => {
      const res = await tx.execute("SELECT COUNT(*) as count FROM runs");
      return Number(res.rows[0]?.count ?? 0);
    });
    expect(runsCount).toBe(0);

    const msgsCount = await store.db.transaction(async (tx) => {
      const res = await tx.execute("SELECT COUNT(*) as count FROM messages");
      return Number(res.rows[0]?.count ?? 0);
    });
    expect(msgsCount).toBe(0);
  });

  it("persists channel_messages across database restart / reopen", async () => {
    const dir = await mkdtemp(join(tmpdir(), "p4b-archive-test-"));
    tempDirs.push(dir);
    const dbPath = join(dir, "agent.db");

    // Open store and ingest message
    const store1 = await openDomainStore({ databasePath: dbPath });
    stores.push(store1);
    const archive1 = new ChannelArchiveStore(store1.db);

    // Archiving requires the group to be a registered Resource: bot membership alone
    // is not a configured source. The channel_messages FK enforces this.
    await store1.authorization.registerResource({
      id: groupResourceId("100"),
      kind: "qq_group",
      visibility: "public",
      ifAbsent: true,
    });

    await archive1.ingest({
      channel: "qq",
      connectionId: "napcat-1",
      groupId: "100",
      externalMessageId: "msg-restart-001",
      senderId: "user-1",
      normalizedText: "persisted message across restart",
      occurredAt: "2026-09-20T11:00:00Z",
    });

    // Close store 1
    await store1.close();
    stores.splice(stores.indexOf(store1), 1);

    // Reopen store 2 on the same database path
    const store2 = await openDomainStore({ databasePath: dbPath });
    stores.push(store2);
    const archive2 = new ChannelArchiveStore(store2.db);

    const loaded = await archive2.searchMessages({
      allowedGroupIds: ["100"],
      query: "persisted",
    });
    expect(loaded).toHaveLength(1);
    expect(loaded[0]?.normalizedText).toBe("persisted message across restart");
    expect(loaded[0]?.externalMessageId).toBe("msg-restart-001");
  });
});

describe("P4B channel archive authorization and lexical search", () => {
  it("keeps unauthorized group text out of the candidate pool entirely", async () => {
    const store = await setupStore();
    const archive = new ChannelArchiveStore(store.db);

    // Identical matching text lives in an authorized and an unauthorized group.
    await archive.ingest({
      channel: "qq",
      connectionId,
      groupId: "100",
      externalMessageId: "auth-1",
      senderId: "user-1",
      normalizedText: "deployment rollback plan alpha",
      occurredAt: "2026-09-20T10:00:00Z",
    });
    await archive.ingest({
      channel: "qq",
      connectionId,
      groupId: "200",
      externalMessageId: "denied-1",
      senderId: "user-2",
      normalizedText: "deployment rollback plan alpha",
      occurredAt: "2026-09-20T10:00:00Z",
    });

    const scoped = await archive.searchMessages({
      allowedGroupIds: ["100"],
      query: "deployment rollback",
    });
    expect(scoped).toHaveLength(1);
    expect(scoped[0]?.groupId).toBe("100");

    // The retriever candidate pool is bounded by the same authorized source set.
    const retriever = new MemoryRetriever({ store: archive });
    const results = await retriever.search("deployment rollback", { allowedSourceIds: ["100"] });
    expect(results).toHaveLength(1);
    expect(results[0]?.memory.sourceId).toBe("100");

    // No authorized source means no query at all.
    const empty = await retriever.search("deployment rollback", { allowedSourceIds: [] });
    expect(empty).toEqual([]);
  });

  it("lexically matches CJK history through the FTS5 index", async () => {
    const store = await setupStore();
    const archive = new ChannelArchiveStore(store.db);

    await archive.ingest({
      channel: "qq",
      connectionId,
      groupId: "100",
      externalMessageId: "cjk-1",
      senderId: "user-1",
      normalizedText: "我们下周三讨论部署回滚方案",
      occurredAt: "2026-09-20T10:00:00Z",
    });
    await archive.ingest({
      channel: "qq",
      connectionId,
      groupId: "100",
      externalMessageId: "cjk-2",
      senderId: "user-1",
      normalizedText: "今天午餐吃什么",
      occurredAt: "2026-09-20T11:00:00Z",
    });

    const hits = await archive.searchMessages({ allowedGroupIds: ["100"], query: "部署回滚" });
    expect(hits.map((h) => h.externalMessageId)).toEqual(["cjk-1"]);
  });

  it("falls back to store-level lexical hits when minScore filters everything out", async () => {
    const store = await setupStore();
    const archive = new ChannelArchiveStore(store.db);

    await archive.ingest({
      channel: "qq",
      connectionId,
      groupId: "100",
      externalMessageId: "relaxed-1",
      senderId: "user-1",
      normalizedText: "quarterly budget review notes",
      occurredAt: "2026-09-20T10:00:00Z",
    });

    // An impossible minScore would drop every FTS hit; the relaxed fallback keeps
    // the store-level match rather than reporting a false empty result.
    const relaxed = await archive.searchMessages({
      allowedGroupIds: ["100"],
      query: "budget review",
      minScore: 99,
    });
    expect(relaxed.map((h) => h.externalMessageId)).toEqual(["relaxed-1"]);
  });

  it("searches structured sender and mention metadata and enriches deduplicated rows", async () => {
    const store = await setupStore();
    const archive = new ChannelArchiveStore(store.db);
    const base = {
      channel: "qq",
      connectionId,
      groupId: "100",
      externalMessageId: "structured-1",
      senderId: "3251349264",
      normalizedText: "你是干啥的",
      occurredAt: "2026-09-20T05:16:04Z",
    };
    const id = await archive.ingest(base);

    await archive.ingest({
      ...base,
      senderName: "Ripped",
      mentionTargetIds: ["3889000000"],
    });

    const byNickname = await archive.searchMessages({
      allowedGroupIds: ["100"],
      query: "Ripped",
    });
    const bySender = await archive.searchMessages({
      allowedGroupIds: ["100"],
      senderQuery: "Ripped",
    });
    const byMention = await archive.searchMessages({
      allowedGroupIds: ["100"],
      mentionedUserId: "3889000000",
    });

    for (const result of [byNickname, bySender, byMention]) {
      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        id,
        senderId: "3251349264",
        senderName: "Ripped",
        mentionTargetIds: ["3889000000"],
      });
    }
  });
});
