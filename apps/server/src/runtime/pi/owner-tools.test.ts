import { expect, it, vi } from "vite-plus/test";
import { openDomainStore } from "../../persistence/index.js";
import { createOwnerTools, OWNER_CONTROL_RESOURCE } from "./owner-tools.js";

it("exposes a provider-compatible group admin schema and validates each action", async () => {
  const store = await openDomainStore({ databasePath: ":memory:" });
  const caller = {
    principalId: "owner",
    scope: {
      connectionId: "qq",
      botId: "bot",
      chatType: "private" as const,
      chatId: "owner",
      senderId: "owner",
    },
  };
  try {
    await store.identities.bindOwner("owner", caller.scope);
    await store.conversations.createAgent("personal");
    await store.authorization.grant({
      principalId: "owner",
      resourceId: "agent:personal",
      action: "run:create",
      scope: caller.scope,
      effect: "allow",
    });
    const accepted = await store.conversations.acceptIncoming({
      agentId: "personal",
      scope: caller.scope,
      messageId: "message",
      text: "查看群技能",
      executionRef: "pi:test",
    });
    await store.authorization.registerResource({
      id: OWNER_CONTROL_RESOURCE,
      kind: "owner-control",
      visibility: "private",
      ownerId: "owner",
    });
    await store.authorization.grant({
      principalId: "owner",
      resourceId: OWNER_CONTROL_RESOURCE,
      action: "group:manage",
      scope: caller.scope,
      effect: "allow",
    });
    const manageGroup = vi.fn(async (_context, input) => input);
    const [tool] = createOwnerTools({
      store,
      getContext: () => ({
        caller,
        runId: accepted.run.id,
        conversationId: accepted.conversation.id,
      }),
      manageGroup,
    });

    expect(tool!.parameters).toMatchObject({
      type: "object",
      required: ["action", "groupId"],
      additionalProperties: false,
    });
    expect(tool!.parameters).not.toHaveProperty("anyOf");
    await tool!.execute(
      "get-call",
      { action: "get", groupId: "1126022432" },
      undefined,
      undefined,
      {} as never,
    );
    expect(manageGroup).toHaveBeenCalledWith(expect.objectContaining({ runId: accepted.run.id }), {
      action: "get",
      groupId: "1126022432",
    });
    await expect(
      tool!.execute(
        "invalid-call",
        { action: "set_skill", groupId: "1126022432", enabled: true },
        undefined,
        undefined,
        {} as never,
      ),
    ).rejects.toThrow("protected_tool_failed");
    expect(manageGroup).toHaveBeenCalledTimes(1);
  } finally {
    await store.close();
  }
});
