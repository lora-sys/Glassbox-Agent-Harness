import { expect, it, vi } from "vite-plus/test";
import { openDomainStore } from "../../persistence/index.js";
import { ChannelArchiveStore } from "../../retrieval/channel-archive.js";
import { groupResourceId } from "../../retrieval/source-resolver.js";
import { createHistoryTools, availableHistoryToolNames } from "./history-tools.js";
import {
  GROUP_HISTORY_SEARCH_TOOL,
  OWNER_HISTORY_ACTION,
  OWNER_HISTORY_RESOURCE,
  OWNER_HISTORY_SEARCH_TOOL,
  type HistoryRetrievalEvidence,
} from "./history-tools.js";

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
/** A second Owner principal on the same connection, with its own private scope. */
const coOwnerPrivate = {
  connectionId,
  botId,
  chatType: "private" as const,
  chatId: "co-owner",
  senderId: "co-owner",
};

async function fixture() {
  const store = await openDomainStore({ databasePath: ":memory:" });
  await store.conversations.createAgent("personal");
  await store.identities.bindOwner("owner", ownerPrivate);
  await store.identities.bindPrincipal("owner", group100);
  await store.identities.bindPrincipal("owner", group200);
  await store.identities.createPrincipal("owner-co", "owner");
  await store.identities.bindPrincipal("owner-co", coOwnerPrivate);
  await store.authorization.registerResource({
    id: "agent:personal",
    kind: "agent",
    visibility: "public",
    ifAbsent: true,
  });
  for (const scope of [ownerPrivate, group100, group200, coOwnerPrivate]) {
    await store.authorization.grant({
      principalId: scope === coOwnerPrivate ? "owner-co" : "owner",
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
  // The Owner cross-group Tool is gated on the Owner's own search capability.
  await store.authorization.registerResource({
    id: OWNER_HISTORY_RESOURCE,
    kind: "owner-history",
    visibility: "private",
    ownerId: "owner",
    ifAbsent: true,
  });
  for (const principalId of ["owner", "owner-co"])
    await store.authorization.grant({
      principalId,
      resourceId: OWNER_HISTORY_RESOURCE,
      action: OWNER_HISTORY_ACTION,
      scope: principalId === "owner" ? ownerPrivate : coOwnerPrivate,
      effect: "allow",
    });
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

type Store = Awaited<ReturnType<typeof fixture>>["store"];
type PrivateScope = typeof ownerPrivate | typeof coOwnerPrivate;

/** Records one Principal's assignment of one managed group. Assignment is not authority. */
const assign = (
  store: Store,
  groupId: string,
  scope: PrivateScope = ownerPrivate,
  principalId = "owner",
) =>
  store.authorization.grant({
    principalId,
    resourceId: groupResourceId(groupId),
    action: "group:manage",
    scope,
    effect: "allow",
  });

/** Grants the authority to read one group's history from a private scope. */
const authorizeHistory = (
  store: Store,
  groupId: string,
  scope: PrivateScope = ownerPrivate,
  principalId = "owner",
) =>
  store.authorization.grant({
    principalId,
    resourceId: groupResourceId(groupId),
    action: "history:read",
    scope,
    effect: "allow",
  });

async function accept(
  store: Store,
  scope: typeof group100 | typeof ownerPrivate | typeof coOwnerPrivate,
  principalId = "owner",
) {
  const accepted = await store.conversations.acceptIncoming({
    agentId: "personal",
    scope,
    messageId: `m-${scope.chatType}-${scope.chatId}`,
    text: "search history",
    executionRef: "pi:test",
  });
  void principalId;
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
    const details = result.details as { groups: string[]; items: Array<{ sourceId: string }> };
    expect(details.groups).toEqual(["100"]);
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

it("searches several authorized groups in one Owner-private call", async () => {
  const { store, archive } = await fixture();
  try {
    for (const gid of ["100", "200"]) {
      await assign(store, gid);
      await authorizeHistory(store, gid);
    }
    const accepted = await accept(store, ownerPrivate);
    const synced: string[] = [];
    const tools = createHistoryTools({
      store,
      archive,
      getContext: () => ({
        caller: { principalId: "owner", scope: ownerPrivate },
        runId: accepted.run.id,
        conversationId: accepted.conversation.id,
      }),
      syncGroup: async (groupId) => {
        synced.push(groupId);
      },
    });

    const result = await call(toolByName(tools, OWNER_HISTORY_SEARCH_TOOL), {
      query: "deploy rollback",
    });
    const details = result.details as {
      groups: string[];
      items: Array<{ sourceId: string; resourceId: string; rank: number; matchedTerms: string[] }>;
    };
    expect(details.groups).toEqual(["100", "200"]);
    expect(details.items.map((item) => item.sourceId).sort()).toEqual(["100", "200"]);
    expect(details.items.map((item) => item.resourceId).sort()).toEqual(["group:100", "group:200"]);
    expect(details.items.map((item) => item.rank).sort((a, b) => a - b)).toEqual([1, 2]);
    expect(details.items.every((item) => item.matchedTerms.includes("deploy"))).toBe(true);
    expect(synced.sort()).toEqual(["100", "200"]);
  } finally {
    await store.close();
  }
});

it("intersects requested filters with the authorized set before loading text", async () => {
  const { store, archive } = await fixture();
  try {
    for (const gid of ["100", "200"]) {
      await assign(store, gid);
      await authorizeHistory(store, gid);
    }
    const accepted = await accept(store, ownerPrivate);
    const synced: string[] = [];
    const tools = createHistoryTools({
      store,
      archive,
      getContext: () => ({
        caller: { principalId: "owner", scope: ownerPrivate },
        runId: accepted.run.id,
        conversationId: accepted.conversation.id,
      }),
      syncGroup: async (groupId) => {
        synced.push(groupId);
      },
    });

    const result = await call(toolByName(tools, OWNER_HISTORY_SEARCH_TOOL), {
      groupIds: ["100"],
      query: "deploy rollback",
    });
    const details = result.details as { groups: string[]; items: Array<{ sourceId: string }> };
    expect(details.groups).toEqual(["100"]);
    expect(details.items.map((item) => item.sourceId)).toEqual(["100"]);
    expect(synced).toEqual(["100"]);
  } finally {
    await store.close();
  }
});

it("fetches nothing and returns no candidate for an unauthorized group", async () => {
  const { store, archive } = await fixture();
  try {
    await assign(store, "100");
    await authorizeHistory(store, "100");
    const accepted = await accept(store, ownerPrivate);
    const synced: string[] = [];
    const tools = createHistoryTools({
      store,
      archive,
      getContext: () => ({
        caller: { principalId: "owner", scope: ownerPrivate },
        runId: accepted.run.id,
        conversationId: accepted.conversation.id,
      }),
      syncGroup: async (groupId) => {
        synced.push(groupId);
      },
    });

    // Group 200 is neither assigned nor granted: zero fetch, zero candidates, no throw.
    const result = await call(toolByName(tools, OWNER_HISTORY_SEARCH_TOOL), {
      groupIds: ["200"],
      query: "deploy rollback",
    });
    const details = result.details as { groups: string[]; items: unknown[] };
    expect(details.groups).toEqual([]);
    expect(details.items).toEqual([]);
    expect(synced).toEqual([]);
  } finally {
    await store.close();
  }
});

it("stops searching a group once its grant is revoked", async () => {
  const { store, archive } = await fixture();
  try {
    for (const gid of ["100", "200"]) {
      await assign(store, gid);
      await authorizeHistory(store, gid);
    }
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

    const before = await call(ownerTool, { query: "deploy rollback" });
    expect((before.details as { groups: string[] }).groups).toEqual(["100", "200"]);

    await store.authorization.revokeScope({
      principalId: "owner",
      resourceId: groupResourceId("200"),
      scope: ownerPrivate,
    });
    const after = await call(ownerTool, { query: "deploy rollback" });
    const details = after.details as { groups: string[]; items: Array<{ sourceId: string }> };
    expect(details.groups).toEqual(["100"]);
    expect(details.items.every((item) => item.sourceId === "100")).toBe(true);
  } finally {
    await store.close();
  }
});

it("keeps one Owner's assigned group set out of another Owner's search", async () => {
  const { store, archive } = await fixture();
  try {
    await assign(store, "100", ownerPrivate, "owner");
    await authorizeHistory(store, "100", ownerPrivate, "owner");
    await assign(store, "200", coOwnerPrivate, "owner-co");
    await authorizeHistory(store, "200", coOwnerPrivate, "owner-co");
    const accepted = await accept(store, coOwnerPrivate);

    const tools = createHistoryTools({
      store,
      archive,
      getContext: () => ({
        caller: { principalId: "owner-co", scope: coOwnerPrivate },
        runId: accepted.run.id,
        conversationId: accepted.conversation.id,
      }),
    });
    const result = await call(toolByName(tools, OWNER_HISTORY_SEARCH_TOOL), {
      query: "deploy rollback",
    });
    const details = result.details as { groups: string[]; items: Array<{ sourceId: string }> };
    expect(details.groups).toEqual(["200"]);
    expect(details.items.map((item) => item.sourceId)).toEqual(["200"]);
  } finally {
    await store.close();
  }
});

it("records safe retrieval evidence without protected message text", async () => {
  const { store, archive } = await fixture();
  try {
    for (const gid of ["100", "200"]) {
      await assign(store, gid);
      await authorizeHistory(store, gid);
    }
    const accepted = await accept(store, ownerPrivate);
    const evidence = vi.fn(async (_value: HistoryRetrievalEvidence) => {});
    const tools = createHistoryTools({
      store,
      archive,
      getContext: () => ({
        caller: { principalId: "owner", scope: ownerPrivate },
        runId: accepted.run.id,
        conversationId: accepted.conversation.id,
      }),
      recordEvidence: evidence,
    });

    await call(toolByName(tools, OWNER_HISTORY_SEARCH_TOOL), { query: "deploy rollback" });
    expect(evidence).toHaveBeenCalledTimes(1);
    const value = evidence.mock.calls[0]![0];
    expect(value).toMatchObject({
      type: "history_retrieval",
      runId: accepted.run.id,
      principalId: "owner",
      conversationId: accepted.conversation.id,
      sourceKind: "channel_message",
      retrievalMode: "lexical",
    });
    expect(value.resources.sort()).toEqual(["group:100", "group:200"]);
    expect(value.items).toHaveLength(2);
    for (const item of value.items) {
      expect(item.resourceId.startsWith("group:")).toBe(true);
      expect(item.rank).toBeGreaterThan(0);
      expect(item.score).toBeGreaterThan(0);
      expect(item.matchedTerms).toContain("deploy");
      expect(item.returnMode).toBe("raw");
    }
    // Evidence carries identifiers, scores and terms — never the message text itself.
    expect(JSON.stringify(value)).not.toContain("plan alpha");
    expect(JSON.stringify(value)).not.toContain("plan beta");
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
