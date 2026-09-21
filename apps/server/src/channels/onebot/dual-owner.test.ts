import { describe, expect, it } from "vite-plus/test";
import { parseOneBotConfig, OneBotConfigurationError } from "./config.js";
import { normalizeOneBotMessage } from "./normalize.js";
import { DomainDatabase } from "../../persistence/database.js";
import { IdentityService } from "../../identity/service.js";
import { AuthorizationService } from "../../auth/service.js";
import { ConversationStore } from "../../conversation/store.js";
import { scopeKey } from "../../identity/scope.js";

describe("Dual Owner support", () => {
  it("parses configuration with coOwnerId correctly and validates uniqueness", () => {
    const valid = parseOneBotConfig({
      connectionId: "test-conn",
      label: "Dual Owner Bot",
      endpoint: "ws://127.0.0.1:6700/",
      botId: "10001",
      ownerId: "10002",
      coOwnerId: "10005",
      visitorIds: ["10004"],
      groupIds: ["10003"],
      credentialSlot: "test-slot",
    });
    expect(valid.ownerId).toBe("10002");
    expect(valid.coOwnerId).toBe("10005");

    // Rejects coOwnerId equal to botId
    expect(() =>
      parseOneBotConfig({
        ...valid,
        coOwnerId: "10001",
      }),
    ).toThrow(OneBotConfigurationError);

    // Rejects coOwnerId equal to ownerId
    expect(() =>
      parseOneBotConfig({
        ...valid,
        coOwnerId: "10002",
      }),
    ).toThrow(OneBotConfigurationError);

    // Rejects if visitorIds contains coOwnerId
    expect(() =>
      parseOneBotConfig({
        ...valid,
        visitorIds: ["10005"],
      }),
    ).toThrow(OneBotConfigurationError);
  });

  it("normalizes messages from both primary Owner and Co-Owner", () => {
    const config = parseOneBotConfig({
      connectionId: "test-conn",
      label: "Dual Owner Bot",
      endpoint: "ws://127.0.0.1:6700/",
      botId: "10001",
      ownerId: "10002",
      coOwnerId: "10005",
      visitorIds: ["10004"],
      groupIds: ["10003"],
      credentialSlot: "test-slot",
    });

    // Primary Owner message
    const msgOwner1 = normalizeOneBotMessage(
      {
        post_type: "message",
        message_type: "group",
        sub_type: "normal",
        self_id: 10001,
        user_id: 10002,
        group_id: 10003,
        message_id: 101,
        message: [
          { type: "at", data: { qq: "10001" } },
          { type: "text", data: { text: "owner 1" } },
        ],
      },
      config,
    );
    expect(msgOwner1.kind).toBe("message");

    // Co-Owner message
    const msgOwner2 = normalizeOneBotMessage(
      {
        post_type: "message",
        message_type: "group",
        sub_type: "normal",
        self_id: 10001,
        user_id: 10005,
        group_id: 10003,
        message_id: 102,
        message: [
          { type: "at", data: { qq: "10001" } },
          { type: "text", data: { text: "owner 2" } },
        ],
      },
      config,
    );
    expect(msgOwner2.kind).toBe("message");

    // Unknown sender ignored
    const msgUnknown = normalizeOneBotMessage(
      {
        post_type: "message",
        message_type: "group",
        sub_type: "normal",
        self_id: 10001,
        user_id: 99999,
        group_id: 10003,
        message_id: 103,
        message: [{ type: "text", data: { text: "intruder" } }],
      },
      config,
    );
    expect(msgUnknown.kind).toBe("ignored");
  });

  it("allows binding multiple owners in database and separates their private conversations", async () => {
    const db = await DomainDatabase.open(":memory:");
    const identities = new IdentityService(db);
    const auth = new AuthorizationService(db);
    const conversations = new ConversationStore(db);

    await conversations.createAgent("personal");

    const owner1Identity = { connectionId: "test-conn", botId: "10001", senderId: "10002" };
    const owner2Identity = { connectionId: "test-conn", botId: "10001", senderId: "10005" };

    // Both can be bound as owners without unique constraint error
    await identities.bindOwner("owner-primary", owner1Identity);
    await identities.bindOwner("owner-secondary", owner2Identity);

    const scope1 = { ...owner1Identity, chatType: "private" as const, chatId: "10002" };
    const scope2 = { ...owner2Identity, chatType: "private" as const, chatId: "10005" };

    expect(await identities.resolve(scope1)).toEqual({
      principalId: "owner-primary",
      scope: scope1,
    });
    expect(await identities.resolve(scope2)).toEqual({
      principalId: "owner-secondary",
      scope: scope2,
    });

    // Grant run:create to both owners
    await auth.grant({
      principalId: "owner-primary",
      resourceId: "agent:personal",
      action: "run:create",
      scope: scope1,
      effect: "allow",
    });
    await auth.grant({
      principalId: "owner-secondary",
      resourceId: "agent:personal",
      action: "run:create",
      scope: scope2,
      effect: "allow",
    });

    // Both create their private conversations
    const conv1 = await conversations.acceptIncoming({
      agentId: "personal",
      scope: scope1,
      messageId: "m1",
      text: "hello from owner 1",
      executionRef: "exec-1",
    });

    const conv2 = await conversations.acceptIncoming({
      agentId: "personal",
      scope: scope2,
      messageId: "m2",
      text: "hello from owner 2",
      executionRef: "exec-2",
    });

    expect(conv1.conversation.id).not.toBe(conv2.conversation.id);
    expect(conv1.conversation.principalId).toBe("owner-primary");
    expect(conv2.conversation.principalId).toBe("owner-secondary");
    expect(scopeKey(scope1)).not.toBe(scopeKey(scope2));
  });

  it("does not infer Owner authority from a principal identifier prefix", async () => {
    const db = await DomainDatabase.open(":memory:");
    const identities = new IdentityService(db);
    await identities.createPrincipal("owner-impostor", "visitor");
    expect(await identities.isOwner("owner-impostor")).toBe(false);
    await identities.bindOwner("actual-owner", {
      connectionId: "test-conn",
      botId: "10001",
      senderId: "10002",
    });
    expect(await identities.isOwner("actual-owner")).toBe(true);
    await db.close();
  });

  it("verifies live production configuration with real QQ numbers", () => {
    const liveConfig = parseOneBotConfig({
      connectionId: "p3-qq",
      label: "P3 QQ acceptance",
      endpoint: "ws://127.0.0.1:6700/",
      botId: "3394947361",
      ownerId: "3526039967",
      coOwnerId: "3067670134",
      visitorIds: ["3654774349"],
      groupIds: ["1126022432"],
      credentialSlot: "channel-cbfc5efd-9513-4ba0-ae0d-93cf918a9774",
    });

    expect(liveConfig.botId).toBe("3394947361");
    expect(liveConfig.ownerId).toBe("3526039967");
    expect(liveConfig.coOwnerId).toBe("3067670134");
    expect(liveConfig.visitorIds).toEqual(["3654774349"]);
    expect(liveConfig.groupIds).toEqual(["1126022432"]);

    // Owner 1 (3526039967) private message
    const o1Private = normalizeOneBotMessage(
      {
        post_type: "message",
        message_type: "private",
        sub_type: "friend",
        self_id: 3394947361,
        user_id: 3526039967,
        message_id: 201,
        message: "hello from owner 1 private",
      },
      liveConfig,
    );
    expect(o1Private.kind).toBe("message");

    // Owner 2 (3067670134) private message
    const o2Private = normalizeOneBotMessage(
      {
        post_type: "message",
        message_type: "private",
        sub_type: "friend",
        self_id: 3394947361,
        user_id: 3067670134,
        message_id: 202,
        message: "hello from owner 2 private",
      },
      liveConfig,
    );
    expect(o2Private.kind).toBe("message");

    // Owner 1 (3526039967) group message
    const o1Group = normalizeOneBotMessage(
      {
        post_type: "message",
        message_type: "group",
        sub_type: "normal",
        self_id: 3394947361,
        user_id: 3526039967,
        group_id: 1126022432,
        message_id: 203,
        message: [
          { type: "at", data: { qq: "3394947361" } },
          { type: "text", data: { text: "owner 1 in group" } },
        ],
      },
      liveConfig,
    );
    expect(o1Group.kind).toBe("message");

    // Owner 2 (3067670134) group message
    const o2Group = normalizeOneBotMessage(
      {
        post_type: "message",
        message_type: "group",
        sub_type: "normal",
        self_id: 3394947361,
        user_id: 3067670134,
        group_id: 1126022432,
        message_id: 204,
        message: [
          { type: "at", data: { qq: "3394947361" } },
          { type: "text", data: { text: "owner 2 in group" } },
        ],
      },
      liveConfig,
    );
    expect(o2Group.kind).toBe("message");

    // Visitor (3654774349) group message
    const visitorGroup = normalizeOneBotMessage(
      {
        post_type: "message",
        message_type: "group",
        sub_type: "normal",
        self_id: 3394947361,
        user_id: 3654774349,
        group_id: 1126022432,
        message_id: 205,
        message: [
          { type: "at", data: { qq: "3394947361" } },
          { type: "text", data: { text: "visitor in group" } },
        ],
      },
      liveConfig,
    );
    expect(visitorGroup.kind).toBe("message");

    // Any real member may explicitly address the bot in an enabled group. The application
    // resolves this sender to a group-scoped Visitor before authorization.
    const unknownGroup = normalizeOneBotMessage(
      {
        post_type: "message",
        message_type: "group",
        sub_type: "normal",
        self_id: 3394947361,
        user_id: 99999999,
        group_id: 1126022432,
        message_id: 206,
        message: [
          { type: "at", data: { qq: "3394947361" } },
          { type: "text", data: { text: "stranger" } },
        ],
      },
      liveConfig,
    );
    expect(unknownGroup).toMatchObject({
      kind: "message",
      message: {
        scope: { chatType: "group", chatId: "1126022432", senderId: "99999999" },
        text: "stranger",
      },
    });
  });
});
