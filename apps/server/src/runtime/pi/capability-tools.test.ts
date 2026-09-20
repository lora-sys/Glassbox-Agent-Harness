import { expect, it } from "vite-plus/test";
import { agentResourceId, openDomainStore } from "../../persistence/index.js";
import type { CallerContext, TrustedChannelScope } from "../../persistence/index.js";
import { groupResourceId } from "../../retrieval/source-resolver.js";
import { availableCapabilityToolNames, createCapabilityTools } from "./capability-tools.js";

const connectionId = "qq";
const botId = "bot";

const ownerPrivateScope: TrustedChannelScope = {
  connectionId,
  botId,
  chatType: "private",
  chatId: "owner",
  senderId: "owner",
};
const ownerGroupScope: TrustedChannelScope = {
  ...ownerPrivateScope,
  chatType: "group",
  chatId: "100",
};
const ownerPrivate: CallerContext = { principalId: "owner", scope: ownerPrivateScope };

async function fixture() {
  const store = await openDomainStore({ databasePath: ":memory:" });
  await store.conversations.createAgent("personal");
  await store.identities.bindOwner("owner", ownerPrivateScope);
  await store.identities.bindPrincipal("owner", ownerGroupScope);
  await store.authorization.registerResource({
    id: agentResourceId("personal"),
    kind: "agent",
    visibility: "public",
    ifAbsent: true,
  });
  await store.authorization.registerResource({
    id: groupResourceId("100"),
    kind: "qq_group",
    visibility: "public",
    ifAbsent: true,
  });
  for (const scope of [ownerPrivateScope, ownerGroupScope]) {
    for (const action of ["run:create", "qq:capability:read"]) {
      await store.authorization.grant({
        principalId: "owner",
        resourceId: agentResourceId("personal"),
        action,
        scope,
        effect: "allow",
      });
    }
  }
  const accepted = await store.conversations.acceptIncoming({
    agentId: "personal",
    scope: ownerPrivateScope,
    messageId: "capability-run",
    text: "manage my group",
    executionRef: "pi:test",
  });
  return { store, accepted };
}

/** Enables one category for one group in the durable policy. */
async function enableCategory(
  store: Awaited<ReturnType<typeof fixture>>["store"],
  category: string,
  groupId = "100",
) {
  await store.capabilities.write({
    connectionId,
    groupId,
    principalId: "owner",
    policy: { categories: { [category]: true }, memorySources: {} },
  });
}

/** Grants one protected Action on one group Resource in the Owner's private scope. */
async function grantGroupAction(
  store: Awaited<ReturnType<typeof fixture>>["store"],
  action: string,
  groupId = "100",
) {
  await store.authorization.registerResource({
    id: groupResourceId(groupId),
    kind: "qq_group",
    visibility: "public",
    ifAbsent: true,
  });
  await store.authorization.grant({
    principalId: "owner",
    resourceId: groupResourceId(groupId),
    action,
    scope: ownerPrivateScope,
    effect: "allow",
  });
}

type Store = Awaited<ReturnType<typeof fixture>>["store"];

function tools(
  store: Store,
  accepted: { run: { id: string }; conversation: { id: string } },
  calls: Array<{ action: string; params: Record<string, unknown> }>,
  /** The required-Tool context the Run carries, derived from the current user message. */
  required?: { name: string; input: Record<string, unknown> },
) {
  return createCapabilityTools({
    store,
    getContext: () => ({
      caller: ownerPrivate,
      runId: accepted.run.id,
      conversationId: accepted.conversation.id,
      ...(required === undefined
        ? {}
        : { requiredToolName: required.name, requiredToolInput: required.input }),
    }),
    isCategoryEnabled: async (conn, groupId, category) => {
      const stored = await store.capabilities.read(conn, groupId);
      return stored?.policy.categories[category] === true;
    },
    invoke: async (input) => {
      calls.push({ action: input.action, params: input.params });
      return { ok: true, action: input.action };
    },
    project: async () => ({ groups: [{ groupId: "100" }] }),
  });
}

function toolByName(created: ReturnType<typeof tools>, name: string) {
  const tool = created.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`missing tool ${name}`);
  return tool;
}

function call(tool: { execute: (...args: never[]) => unknown }, params: Record<string, unknown>) {
  return (
    tool.execute as unknown as (
      id: string,
      p: unknown,
      s?: AbortSignal,
      u?: unknown,
      c?: unknown,
    ) => Promise<{ details?: unknown }>
  )("call", params, undefined, undefined, {} as never);
}

it("exposes the capability surface only to an Owner-private Run", async () => {
  const enabled = ["group.members", "group.read"] as const;
  expect(
    availableCapabilityToolNames({
      isOwner: true,
      chatType: "private",
      enabledCategories: enabled,
    }),
  ).toEqual(
    expect.arrayContaining([
      "qq_capability_search",
      "qq_account_status",
      "qq_groups",
      "qq_group_members",
    ]),
  );
  // A category the Owner never enabled for any managed group stays hidden.
  expect(
    availableCapabilityToolNames({
      isOwner: true,
      chatType: "private",
      enabledCategories: enabled,
    }),
  ).not.toContain("qq_group_moderation");
  // A group Run sees only the read-only capabilities its own group's policy enables.
  expect(
    availableCapabilityToolNames({ isOwner: true, chatType: "group", enabledCategories: enabled }),
  ).toEqual(["qq_groups", "qq_group_members"]);
  expect(
    availableCapabilityToolNames({
      isOwner: false,
      chatType: "private",
      enabledCategories: enabled,
    }),
  ).toEqual([]);
});

it("hides a group Run's read-only Tool once its category is disabled, and never exposes mutation", () => {
  // A disabled category is absent from the surface on the next Run.
  expect(
    availableCapabilityToolNames({
      isOwner: false,
      chatType: "group",
      enabledCategories: ["group.read"],
    }),
  ).toEqual(["qq_groups"]);
  // A mutating category is Owner-private: enabling it for the group changes nothing here.
  expect(
    availableCapabilityToolNames({
      isOwner: false,
      chatType: "group",
      enabledCategories: ["group.read", "group.moderate", "group.settings", "message.manage"],
    }),
  ).toEqual(["qq_groups"]);
  // A Visitor-private Run sees no capability at all.
  expect(
    availableCapabilityToolNames({
      isOwner: false,
      chatType: "private",
      enabledCategories: ["group.read", "group.moderate"],
    }),
  ).toEqual([]);
});

it("binds a group Run to its own group and refuses a model-supplied one", async () => {
  const { store, accepted } = await fixture();
  try {
    await enableCategory(store, "group.members");
    await store.authorization.grant({
      principalId: "owner",
      resourceId: groupResourceId("100"),
      action: "group:members:read",
      scope: ownerGroupScope,
      effect: "allow",
    });
    const calls: Array<{ action: string; params: Record<string, unknown> }> = [];
    const created = createCapabilityTools({
      store,
      getContext: () => ({
        caller: { principalId: "owner", scope: ownerGroupScope },
        runId: accepted.run.id,
        conversationId: accepted.conversation.id,
      }),
      isCategoryEnabled: async (conn, groupId, category) => {
        const stored = await store.capabilities.read(conn, groupId);
        return stored?.policy.categories[category] === true;
      },
      invoke: async (input) => {
        calls.push({ action: input.action, params: input.params });
        return { ok: true, action: input.action };
      },
      project: async () => ({ groups: [] }),
    });
    const members = toolByName(created, "qq_group_members");
    // Naming a group inside a group Run is refused rather than silently overwritten.
    await expect(
      call(members, { groupId: "100", operation: "get_group_member_list" }),
    ).rejects.toThrow("invalid_capability_group");
    // The group is derived from the trusted Run scope, so the call reaches the group it is in.
    const result = await call(members, { operation: "get_group_member_list" });
    expect(calls).toEqual([{ action: "get_group_member_list", params: { group_id: 100 } }]);
    expect(result.details).toMatchObject({ action: "get_group_member_list" });
  } finally {
    await store.close();
  }
});

it("defaults to DENY without an explicit grant on the group Resource", async () => {
  const { store, accepted } = await fixture();
  try {
    await enableCategory(store, "group.members");
    const calls: Array<{ action: string; params: Record<string, unknown> }> = [];
    const created = tools(store, accepted, calls);
    await expect(
      call(toolByName(created, "qq_group_members"), {
        groupId: "100",
        operation: "get_group_member_list",
      }),
    ).rejects.toThrow("Permission denied: no_grant");
    expect(calls).toEqual([]);
  } finally {
    await store.close();
  }
});

it("refuses a category the Owner has not enabled even when the grant exists", async () => {
  const { store, accepted } = await fixture();
  try {
    await store.authorization.grant({
      principalId: "owner",
      resourceId: groupResourceId("100"),
      action: "group:members:read",
      scope: ownerPrivateScope,
      effect: "allow",
    });
    const calls: Array<{ action: string; params: Record<string, unknown> }> = [];
    const created = tools(store, accepted, calls);
    await expect(
      call(toolByName(created, "qq_group_members"), {
        groupId: "100",
        operation: "get_group_member_list",
      }),
    ).rejects.toThrow("capability_category_disabled");
    expect(calls).toEqual([]);
  } finally {
    await store.close();
  }
});

it("reaches the provider only when policy and grant agree, binding group_id server-side", async () => {
  const { store, accepted } = await fixture();
  try {
    await enableCategory(store, "group.members");
    await store.authorization.grant({
      principalId: "owner",
      resourceId: groupResourceId("100"),
      action: "group:members:read",
      scope: ownerPrivateScope,
      effect: "allow",
    });
    const calls: Array<{ action: string; params: Record<string, unknown> }> = [];
    const created = tools(store, accepted, calls);
    const result = await call(toolByName(created, "qq_group_members"), {
      groupId: "100",
      operation: "get_group_member_list",
    });
    expect(calls).toEqual([{ action: "get_group_member_list", params: { group_id: 100 } }]);
    expect(result.details).toMatchObject({ action: "get_group_member_list" });
  } finally {
    await store.close();
  }
});

it("refuses a model-supplied group_id, a foreign action and an undeclared parameter", async () => {
  const { store, accepted } = await fixture();
  try {
    await enableCategory(store, "group.members");
    await store.authorization.grant({
      principalId: "owner",
      resourceId: groupResourceId("100"),
      action: "group:members:read",
      scope: ownerPrivateScope,
      effect: "allow",
    });
    const calls: Array<{ action: string; params: Record<string, unknown> }> = [];
    const created = tools(store, accepted, calls);
    const members = toolByName(created, "qq_group_members");
    // The group is named once, at the top level, and never inside the provider params.
    await expect(
      call(members, {
        groupId: "100",
        operation: "get_group_member_list",
        params: { group_id: 999 },
      }),
    ).rejects.toThrow("invalid_capability_params");
    // An action outside this capability is unreachable.
    await expect(call(members, { groupId: "100", operation: "set_group_kick" })).rejects.toThrow(
      "invalid_capability_operation",
    );
    // A server-only primitive is unreachable.
    await expect(call(members, { groupId: "100", operation: "send_group_msg" })).rejects.toThrow(
      "invalid_capability_operation",
    );
    // An undeclared parameter is refused rather than forwarded.
    await expect(
      call(members, {
        groupId: "100",
        operation: "get_group_member_list",
        params: { user_id: 5 },
      }),
    ).rejects.toThrow("invalid_capability_params");
    expect(calls).toEqual([]);
  } finally {
    await store.close();
  }
});

it("re-authorizes at execution time so a revocation between discovery and call denies", async () => {
  const { store, accepted } = await fixture();
  try {
    await enableCategory(store, "group.members");
    const grantId = await store.authorization.grant({
      principalId: "owner",
      resourceId: groupResourceId("100"),
      action: "group:members:read",
      scope: ownerPrivateScope,
      effect: "allow",
    });
    const calls: Array<{ action: string; params: Record<string, unknown> }> = [];
    const created = tools(store, accepted, calls);
    expect(
      availableCapabilityToolNames({
        isOwner: true,
        chatType: "private",
        enabledCategories: ["group.members"],
      }),
    ).toContain("qq_group_members");
    await store.authorization.revoke(grantId);
    await expect(
      call(toolByName(created, "qq_group_members"), {
        groupId: "100",
        operation: "get_group_member_list",
      }),
    ).rejects.toThrow("Permission denied: no_grant");
    expect(calls).toEqual([]);
  } finally {
    await store.close();
  }
});

it("serves the managed-group projection without a provider call", async () => {
  const { store, accepted } = await fixture();
  try {
    const calls: Array<{ action: string; params: Record<string, unknown> }> = [];
    const created = tools(store, accepted, calls);
    const result = await call(toolByName(created, "qq_capability_search"), {});
    expect(result.details).toEqual({ groups: [{ groupId: "100" }] });
    expect(calls).toEqual([]);
  } finally {
    await store.close();
  }
});

it("refuses a moderation call that retrieved text asked for, even with policy and grant", async () => {
  const { store, accepted } = await fixture();
  try {
    await enableCategory(store, "group.moderate");
    await grantGroupAction(store, "group:moderate");
    const calls: Array<{ action: string; params: Record<string, unknown> }> = [];
    // The Run carries no required mutation Tool: the instruction came from retrieved text,
    // which is never the current user message.
    const created = tools(store, accepted, calls);
    await expect(
      call(toolByName(created, "qq_group_moderation"), {
        groupId: "100",
        operation: "set_group_ban",
        params: { user_id: 10004, duration: 60 },
      }),
    ).rejects.toThrow("mutation_not_requested");
    expect(calls).toEqual([]);
  } finally {
    await store.close();
  }
});

it("never lets a read-only required Tool authorize a mutation", async () => {
  const { store, accepted } = await fixture();
  try {
    await enableCategory(store, "group.moderate");
    await grantGroupAction(store, "group:moderate");
    const calls: Array<{ action: string; params: Record<string, unknown> }> = [];
    // The current message asked only for a read, so its required Tool is the read Tool.
    const created = tools(store, accepted, calls, {
      name: "qq_group_members",
      input: { groupId: "100", operation: "get_group_member_list" },
    });
    await expect(
      call(toolByName(created, "qq_group_moderation"), {
        groupId: "100",
        operation: "set_group_ban",
        params: { user_id: 10004, duration: 60 },
      }),
    ).rejects.toThrow("mutation_not_requested");
    expect(calls).toEqual([]);
  } finally {
    await store.close();
  }
});

it("executes an explicit Owner mutation only for the group the message named", async () => {
  const { store, accepted } = await fixture();
  try {
    for (const groupId of ["100", "200"]) {
      await enableCategory(store, "group.moderate", groupId);
      await grantGroupAction(store, "group:moderate", groupId);
    }
    const calls: Array<{ action: string; params: Record<string, unknown> }> = [];
    const created = tools(store, accepted, calls, {
      name: "qq_group_moderation",
      input: { groupId: "100", operation: "set_group_ban" },
    });
    const moderation = toolByName(created, "qq_group_moderation");
    // Another group is refused: the message named group 100 only.
    await expect(
      call(moderation, {
        groupId: "200",
        operation: "set_group_ban",
        params: { user_id: 10004, duration: 60 },
      }),
    ).rejects.toThrow("mutation_not_requested");
    expect(calls).toEqual([]);
    // The named group and operation execute, with group_id bound server-side.
    const result = await call(moderation, {
      groupId: "100",
      operation: "set_group_ban",
      params: { user_id: 10004, duration: 60 },
    });
    expect(calls).toEqual([
      { action: "set_group_ban", params: { user_id: 10004, duration: 60, group_id: 100 } },
    ]);
    expect(result.details).toMatchObject({ action: "set_group_ban" });
  } finally {
    await store.close();
  }
});
