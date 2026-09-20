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

/** Enables one category for group 100 in the durable policy. */
async function enableCategory(
  store: Awaited<ReturnType<typeof fixture>>["store"],
  category: string,
) {
  await store.capabilities.write({
    connectionId,
    groupId: "100",
    principalId: "owner",
    policy: { categories: { [category]: true }, memorySources: {} },
  });
}

type Store = Awaited<ReturnType<typeof fixture>>["store"];

function tools(
  store: Store,
  accepted: { run: { id: string }; conversation: { id: string } },
  calls: Array<{ action: string; params: Record<string, unknown> }>,
) {
  return createCapabilityTools({
    store,
    getContext: () => ({
      caller: ownerPrivate,
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
  expect(
    availableCapabilityToolNames({ isOwner: true, chatType: "group", enabledCategories: enabled }),
  ).toEqual([]);
  expect(
    availableCapabilityToolNames({
      isOwner: false,
      chatType: "private",
      enabledCategories: enabled,
    }),
  ).toEqual([]);
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
