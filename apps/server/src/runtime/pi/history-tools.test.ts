import { expect, it } from "vite-plus/test";
import { openDomainStore } from "../../persistence/index.js";
import { ChannelArchiveStore } from "../../retrieval/channel-archive.js";
import { groupResourceId } from "../../retrieval/source-resolver.js";
import { createHistoryTools, availableHistoryToolNames } from "./history-tools.js";
import { GROUP_HISTORY_SEARCH_TOOL, OWNER_HISTORY_SEARCH_TOOL } from "./history-tools.js";

const connectionId = "qq";
const botId = "bot";

const group100 = {
  connectionId,
  botId,
  chatType: "group" as const,
  chatId: "100",
  senderId: "owner",
};
const group200 = {
  connectionId,
  botId,
  chatType: "group" as const,
  chatId: "200",
  senderId: "owner",
};
const ownerPrivate = {
  connectionId,
  botId,
  chatType: "private" as const,
  chatId: "owner",
  senderId: "owner",
};

async function fixture() {
  const store = await openDomainStore({ databasePath: ":memory:" });
  await store.conversations.createAgent("personal");
  await store.identities.bindOwner("owner", ownerPrivate);
  await store.identities.bindPrincipal("owner", group100);
  await store.identities.bindPrincipal("owner", group200);
  await store.authorization.registerResource({
    id: "agent:personal",
    kind: "agent",
    visibility: "public",
    ifAbsent: true,
  });
  for (const scope of [ownerPrivate, group100, group200]) {
    await store.authorization.grant({
      principalId: "owner",
      resourceId: "agent:personal",
      action: "run:create",
      scope,
      effect: "allow",
    });
  }
  for (const gid of ["100", "200"]) {
    await store.authorization.registerResource({
      id: groupResourceId(gid),
      kind: "qq_group",
      visibility: "public",
      ifAbsent: true,
    });
  }
  const archive = new ChannelArchiveStore(store.db);
  await archive.ingest({
    channel: "qq",
    connectionId,
    groupId: "100",
    externalMessageId: "g100-1",
    senderId: "member-a",
    normalizedText: "deploy rollback plan alpha",
    occurredAt: "2026-09-20T10:00:00Z",
  });
  await archive.ingest({
    channel: "qq",
    connectionId,
    groupId: "200",
    externalMessageId: "g200-1",
    senderId: "member-b",
    normalizedText: "deploy rollback plan beta",
    occurredAt: "2026-09-20T11:00:00Z",
  });
  return { store, archive };
}

async function accept(
  store: Awaited<ReturnType<typeof openDomainStore>>,
  scope: typeof group100 | typeof ownerPrivate,
) {
  const accepted = await store.conversations.acceptIncoming({
    agentId: "personal",
    scope,
    messageId: `m-${scope.chatType}-${scope.chatId}`,
    text: "search history",
    executionRef: "pi:test",
  });
  return accepted;
}

function toolByName(tools: ReturnType<typeof createHistoryTools>, name: string) {
  const tool = tools.find((t) => t.name === name);
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

it("restricts the current-group tool to the group the Run is in", async () => {
  const { store, archive } = await fixture();
  try {
    // The caller holds a grant for group 200 as well, but the group Run must not reach it.
    for (const gid of ["100", "200"]) {
      await store.authorization.grant({
        principalId: "owner",
        resourceId: groupResourceId(gid),
        action: "history:read",
        scope: group100,
        effect: "allow",
      });
    }
    const accepted = await accept(store, group100);
    const tools = createHistoryTools({
      store,
      archive,
      getContext: () => ({
        caller: { principalId: "owner", scope: group100 },
        runId: accepted.run.id,
        conversationId: accepted.conversation.id,
      }),
    });

    const result = await call(toolByName(tools, GROUP_HISTORY_SEARCH_TOOL), {
      query: "deploy rollback",
    });
    const details = result.details as { groupId: string; items: Array<{ sourceId: string }> };
    expect(details.groupId).toBe("100");
    expect(details.items.every((item) => item.sourceId === "100")).toBe(true);
    expect(details.items).toHaveLength(1);
  } finally {
    await store.close();
  }
});

it("defaults to DENY for the current group without a history:read grant", async () => {
  const { store, archive } = await fixture();
  try {
    const accepted = await accept(store, group100);
    const tools = createHistoryTools({
      store,
      archive,
      getContext: () => ({
        caller: { principalId: "owner", scope: group100 },
        runId: accepted.run.id,
        conversationId: accepted.conversation.id,
      }),
    });

    await expect(
      call(toolByName(tools, GROUP_HISTORY_SEARCH_TOOL), { query: "deploy" }),
    ).rejects.toThrow("Permission denied: no_grant");
  } finally {
    await store.close();
  }
});

it("lets an Owner-private Run search a named authorized group but not an unauthorized one", async () => {
  const { store, archive } = await fixture();
  try {
    await store.authorization.grant({
      principalId: "owner",
      resourceId: groupResourceId("200"),
      action: "history:read",
      scope: ownerPrivate,
      effect: "allow",
    });
    const accepted = await accept(store, ownerPrivate);
    const tools = createHistoryTools({
      store,
      archive,
      getContext: () => ({
        caller: { principalId: "owner", scope: ownerPrivate },
        runId: accepted.run.id,
        conversationId: accepted.conversation.id,
      }),
    });
    const ownerTool = toolByName(tools, OWNER_HISTORY_SEARCH_TOOL);

    const allowed = await call(ownerTool, { groupId: "200", query: "deploy rollback" });
    const details = allowed.details as { items: Array<{ sourceId: string }> };
    expect(details.items.map((item) => item.sourceId)).toEqual(["200"]);

    // Group 100 was never granted: the Owner role itself does not bypass the Resource grant.
    await expect(call(ownerTool, { groupId: "100", query: "deploy" })).rejects.toThrow(
      "Permission denied: no_grant",
    );
  } finally {
    await store.close();
  }
});

it("keeps the Owner cross-group tool out of the group surface", async () => {
  // Tool exposure is decided by scope, not by the model. A group Run only ever sees
  // the current-group tool; only Owner-private sees the cross-group tool.
  expect(availableHistoryToolNames({ isOwner: true, chatType: "group" })).toEqual([
    GROUP_HISTORY_SEARCH_TOOL,
  ]);
  expect(availableHistoryToolNames({ isOwner: false, chatType: "group" })).toEqual([
    GROUP_HISTORY_SEARCH_TOOL,
  ]);
  expect(availableHistoryToolNames({ isOwner: true, chatType: "private" })).toEqual([
    OWNER_HISTORY_SEARCH_TOOL,
  ]);
  expect(availableHistoryToolNames({ isOwner: false, chatType: "private" })).toEqual([]);
  expect(OWNER_HISTORY_SEARCH_TOOL).not.toBe(GROUP_HISTORY_SEARCH_TOOL);
});
