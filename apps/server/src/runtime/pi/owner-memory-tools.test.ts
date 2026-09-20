import { expect, it } from "vite-plus/test";
import {
  MEMORY_GOVERN_ACTION,
  MEMORY_READ_ACTION,
  MEMORY_WRITE_ACTION,
  OWNER_MEMORY_RESOURCE,
} from "../../learning/store.js";
import { openDomainStore } from "../../persistence/index.js";
import { createOwnerMemoryTools, OWNER_MEMORY_ADMIN_TOOL } from "./owner-memory-tools.js";

it("exposes Owner-only governed Memory operations and rechecks revoked write authority", async () => {
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
      text: "记住这个项目事实",
      executionRef: "pi:test",
    });
    await store.authorization.registerResource({
      id: OWNER_MEMORY_RESOURCE,
      kind: "owner-memory",
      visibility: "private",
      ownerId: "owner",
    });
    let writeGrant = "";
    for (const action of [MEMORY_READ_ACTION, MEMORY_WRITE_ACTION, MEMORY_GOVERN_ACTION]) {
      const grantId = await store.authorization.grant({
        principalId: "owner",
        resourceId: OWNER_MEMORY_RESOURCE,
        action,
        scope: caller.scope,
        effect: "allow",
      });
      if (action === MEMORY_WRITE_ACTION) writeGrant = grantId;
    }
    const [tool] = createOwnerMemoryTools({
      store,
      getContext: () => ({
        caller,
        runId: accepted.run.id,
        conversationId: accepted.conversation.id,
      }),
    });
    expect(tool?.name).toBe(OWNER_MEMORY_ADMIN_TOOL);
    expect(tool?.parameters).toMatchObject({ type: "object", required: ["action"] });
    const written = await tool!.execute(
      "write",
      {
        action: "write",
        type: "semantic_fact",
        statement: "The deployment target is Linux.",
        scopeType: "project",
        projectId: "glassbox",
      },
      undefined,
      undefined,
      {} as never,
    );
    expect(written.details).toMatchObject({
      type: "semantic_fact",
      lifecycleState: "active",
      scope: { type: "project", projectId: "glassbox" },
    });
    const listed = await tool!.execute(
      "list",
      { action: "list", scopeType: "project", projectId: "glassbox" },
      undefined,
      undefined,
      {} as never,
    );
    expect(listed.details).toHaveLength(1);

    await store.authorization.revoke(writeGrant);
    await expect(
      tool!.execute(
        "revoked-write",
        { action: "write", type: "semantic_fact", statement: "Must not persist." },
        undefined,
        undefined,
        {} as never,
      ),
    ).rejects.toThrow("protected_tool_failed");
    expect(await store.learning.listMemories({ caller })).toHaveLength(1);
  } finally {
    await store.close();
  }
});

it("rejects the private Memory tool from a group context before loading content", async () => {
  const store = await openDomainStore({ databasePath: ":memory:" });
  const caller = {
    principalId: "owner",
    scope: {
      connectionId: "qq",
      botId: "bot",
      chatType: "group" as const,
      chatId: "123",
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
      messageId: "group-message",
      text: "list memory",
      executionRef: "pi:test",
    });
    await store.authorization.registerResource({
      id: OWNER_MEMORY_RESOURCE,
      kind: "owner-memory",
      visibility: "private",
      ownerId: "owner",
    });
    await store.authorization.grant({
      principalId: "owner",
      resourceId: OWNER_MEMORY_RESOURCE,
      action: MEMORY_GOVERN_ACTION,
      scope: caller.scope,
      effect: "allow",
    });
    const [tool] = createOwnerMemoryTools({
      store,
      getContext: () => ({
        caller,
        runId: accepted.run.id,
        conversationId: accepted.conversation.id,
      }),
    });
    await expect(
      tool!.execute("group-list", { action: "list" }, undefined, undefined, {} as never),
    ).rejects.toThrow("private_group_context");
  } finally {
    await store.close();
  }
});
