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
    expect(
      (tool!.parameters as { properties: { category: { enum: string[] } } }).properties.category
        .enum,
    ).toContain("web.search");
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

/** Fixture that reaches the mutation path, optionally holding the Owner grant. */
async function mutationFixture(grantOwnerControl: boolean) {
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
    text: "配置群能力",
    executionRef: "pi:test",
  });
  await store.authorization.registerResource({
    id: OWNER_CONTROL_RESOURCE,
    kind: "owner-control",
    visibility: "private",
    ownerId: "owner",
  });
  if (grantOwnerControl)
    await store.authorization.grant({
      principalId: "owner",
      resourceId: OWNER_CONTROL_RESOURCE,
      action: "group:manage",
      scope: caller.scope,
      effect: "allow",
    });
  const manageGroup = vi.fn(async (_context, input) => input);
  let required: { name: string; input: Record<string, unknown> } | undefined;
  const [tool] = createOwnerTools({
    store,
    getContext: () => ({
      caller,
      runId: accepted.run.id,
      conversationId: accepted.conversation.id,
      ...(required === undefined
        ? {}
        : { requiredToolName: required.name, requiredToolInput: required.input }),
    }),
    manageGroup,
  });
  return {
    store,
    tool: tool!,
    manageGroup,
    /** Records the mutation the current user message asks for, as the Run context would. */
    require: (name: string, input: Record<string, unknown>) => {
      required = { name, input };
    },
  };
}

it("accepts each explicit Owner capability mutation and parses it before mutation", async () => {
  const { store, tool, manageGroup, require: requireMutation } = await mutationFixture(true);
  try {
    const calls: Array<[string, unknown]> = [
      [
        "set_capability",
        {
          action: "set_capability",
          groupId: "1126022432",
          category: "group.members",
          enabled: true,
        },
      ],
      [
        "set_capability",
        {
          action: "set_capability",
          groupId: "1126022432",
          category: "browser.interact",
          enabled: true,
        },
      ],
      ["set_history", { action: "set_history", groupId: "1126022432", enabled: true }],
      [
        "set_memory_source",
        {
          action: "set_memory_source",
          groupId: "1126022432",
          sourceClass: "notice",
          enabled: true,
        },
      ],
    ];
    for (const [id, params] of calls) {
      requireMutation("owner_group_admin", params as Record<string, unknown>);
      await tool.execute(id, params, undefined, undefined, {} as never);
    }
    expect(manageGroup.mock.calls.map((call) => call[1])).toEqual(
      calls.map(([, params]) => params),
    );
  } finally {
    await store.close();
  }
});

it("refuses a mutation the current user message did not ask for", async () => {
  const { store, tool, manageGroup, require: requireMutation } = await mutationFixture(true);
  try {
    const capability = {
      action: "set_capability",
      groupId: "1126022432",
      category: "group.moderate",
      enabled: true,
    };
    // No intent at all: an instruction that arrived in retrieved text has no required-Tool
    // context, so a mutating Tool refuses rather than executing.
    await expect(
      tool.execute("none", capability, undefined, undefined, {} as never),
    ).rejects.toThrow("mutation_not_requested");
    // Intent for a *different* mutation does not authorize this one.
    requireMutation("owner_group_admin", {
      action: "set_history",
      groupId: "1126022432",
      enabled: true,
    });
    await expect(
      tool.execute("other", capability, undefined, undefined, {} as never),
    ).rejects.toThrow("mutation_not_requested");
    // Intent for a different *group* does not authorize this group.
    requireMutation("owner_group_admin", { ...capability, groupId: "999" });
    await expect(
      tool.execute("group", capability, undefined, undefined, {} as never),
    ).rejects.toThrow("mutation_not_requested");
    expect(manageGroup).not.toHaveBeenCalled();
  } finally {
    await store.close();
  }
});

it("refuses a category or source class invented by the model", async () => {
  const { store, tool, manageGroup, require: requireMutation } = await mutationFixture(true);
  try {
    requireMutation("owner_group_admin", {
      action: "set_capability",
      groupId: "1126022432",
      enabled: true,
    });
    await expect(
      tool.execute(
        "extra-category",
        {
          action: "set_capability",
          groupId: "1126022432",
          enabled: true,
          category: "group.moderate",
        },
        undefined,
        undefined,
        {} as never,
      ),
    ).rejects.toThrow("mutation_not_requested");
    requireMutation("owner_group_admin", {
      action: "set_memory_source",
      groupId: "1126022432",
      enabled: true,
    });
    await expect(
      tool.execute(
        "extra-source",
        {
          action: "set_memory_source",
          groupId: "1126022432",
          enabled: true,
          sourceClass: "history",
        },
        undefined,
        undefined,
        {} as never,
      ),
    ).rejects.toThrow("mutation_not_requested");
    expect(manageGroup).not.toHaveBeenCalled();
  } finally {
    await store.close();
  }
});

it("attempts one requested Owner mutation at most once in a Run", async () => {
  const { store, tool, manageGroup, require: requireMutation } = await mutationFixture(true);
  try {
    const capability = {
      action: "set_capability" as const,
      groupId: "1126022432",
      category: "group.moderate",
      enabled: true,
    };
    requireMutation("owner_group_admin", capability);
    manageGroup.mockRejectedValueOnce(new Error("write_failed"));

    await expect(
      tool.execute("first", capability, undefined, undefined, {} as never),
    ).rejects.toThrow("protected_tool_failed");
    await expect(
      tool.execute("retry", capability, undefined, undefined, {} as never),
    ).rejects.toThrow("mutation_already_attempted");
    expect(manageGroup).toHaveBeenCalledTimes(1);
  } finally {
    await store.close();
  }
});

it("reads the inventory without a required-Tool context", async () => {
  const { store, tool, manageGroup } = await mutationFixture(true);
  try {
    await tool.execute(
      "get",
      { action: "get", groupId: "1126022432" },
      undefined,
      undefined,
      {} as never,
    );
    expect(manageGroup).toHaveBeenCalledTimes(1);
  } finally {
    await store.close();
  }
});

it("refuses a capability mutation naming an unimplemented category or source class", async () => {
  const { store, tool, manageGroup } = await mutationFixture(true);
  try {
    for (const params of [
      { action: "set_capability", groupId: "1126022432", category: "group.sudo", enabled: true },
      {
        action: "set_memory_source",
        groupId: "1126022432",
        sourceClass: "everything",
        enabled: true,
      },
      { action: "set_capability", groupId: "1126022432", category: "group.members" },
    ])
      await expect(tool.execute("bad", params, undefined, undefined, {} as never)).rejects.toThrow(
        "protected_tool_failed",
      );
    // Nothing reached durable state: an unimplemented name can never widen the surface.
    expect(manageGroup).not.toHaveBeenCalled();
  } finally {
    await store.close();
  }
});

it("denies a capability mutation when the caller holds no Owner-control grant", async () => {
  const { store, tool, manageGroup } = await mutationFixture(false);
  try {
    await expect(
      tool.execute(
        "denied",
        {
          action: "set_capability",
          groupId: "1126022432",
          category: "group.moderate",
          enabled: true,
        },
        undefined,
        undefined,
        {} as never,
      ),
    ).rejects.toThrow("Permission denied: no_grant");
    expect(manageGroup).not.toHaveBeenCalled();
  } finally {
    await store.close();
  }
});
