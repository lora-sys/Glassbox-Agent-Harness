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
});
