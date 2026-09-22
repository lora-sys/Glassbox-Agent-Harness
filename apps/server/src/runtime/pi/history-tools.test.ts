import { expect, it, vi } from "vite-plus/test";
import { createQqDeliveryPolicy } from "../../delivery/content-policy.js";
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
    senderName: "Ripped",
    mentionTargetIds: [botId],
    normalizedText: "@bot deploy rollback plan alpha",
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

/** The Owner's durable policy for the group's history class, as the app reads it per call. */
const historyEnabled = async () => true;

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
      isHistoryEnabled: historyEnabled,
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
      isHistoryEnabled: historyEnabled,
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
      isHistoryEnabled: historyEnabled,
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
      isHistoryEnabled: historyEnabled,
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
      isHistoryEnabled: historyEnabled,
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
      isHistoryEnabled: historyEnabled,
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
      isHistoryEnabled: historyEnabled,
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
      isHistoryEnabled: historyEnabled,
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
  // Tool exposure is decided by scope and the group's own policy, not by the model. A group
  // Run only ever sees the current-group tool, and only while its policy enables history.
  expect(
    availableHistoryToolNames({
      isOwner: true,
      chatType: "group",
      enabledCategories: ["group.history"],
    }),
  ).toEqual([GROUP_HISTORY_SEARCH_TOOL]);
  expect(
    availableHistoryToolNames({
      isOwner: false,
      chatType: "group",
      enabledCategories: ["group.history", "group.members"],
    }),
  ).toEqual([GROUP_HISTORY_SEARCH_TOOL]);
  // The group's own policy decides: history disabled means no group history Tool, even
  // though the scope's discovery grant is unchanged.
  expect(
    availableHistoryToolNames({
      isOwner: true,
      chatType: "group",
      enabledCategories: ["group.members", "group.read"],
    }),
  ).toEqual([]);
  expect(
    availableHistoryToolNames({ isOwner: true, chatType: "private", enabledCategories: [] }),
  ).toEqual([OWNER_HISTORY_SEARCH_TOOL]);
  expect(
    availableHistoryToolNames({ isOwner: false, chatType: "private", enabledCategories: [] }),
  ).toEqual([]);
  expect(OWNER_HISTORY_SEARCH_TOOL).not.toBe(GROUP_HISTORY_SEARCH_TOOL);
});

it("refuses the current-group tool when the Owner disabled history", async () => {
  const { store, archive } = await fixture();
  try {
    // The grant is deliberately left in place — only the Owner's policy changed — so this
    // proves the refusal comes from policy rather than from a missing authority.
    await store.authorization.grant({
      principalId: "owner",
      resourceId: groupResourceId("100"),
      action: "history:read",
      scope: group100,
      effect: "allow",
    });
    const accepted = await accept(store, group100);
    const tools = createHistoryTools({
      store,
      archive,
      isHistoryEnabled: async () => false,
      getContext: () => ({
        caller: { principalId: "owner", scope: group100 },
        runId: accepted.run.id,
        conversationId: accepted.conversation.id,
      }),
    });

    await expect(
      call(toolByName(tools, GROUP_HISTORY_SEARCH_TOOL), { query: "deploy" }),
    ).rejects.toThrow("history_category_disabled");
  } finally {
    await store.close();
  }
});

it("re-reads the Owner's policy so a Run cannot read after history is disabled", async () => {
  const { store, archive } = await fixture();
  try {
    await store.authorization.grant({
      principalId: "owner",
      resourceId: groupResourceId("100"),
      action: "history:read",
      scope: group100,
      effect: "allow",
    });
    const accepted = await accept(store, group100);
    let enabled = true;
    const tools = createHistoryTools({
      store,
      archive,
      isHistoryEnabled: async () => enabled,
      getContext: () => ({
        caller: { principalId: "owner", scope: group100 },
        runId: accepted.run.id,
        conversationId: accepted.conversation.id,
      }),
    });
    const tool = toolByName(tools, GROUP_HISTORY_SEARCH_TOOL);

    const before = await call(tool, { query: "deploy rollback" });
    expect((before.details as { groups: string[] }).groups).toEqual(["100"]);

    enabled = false;
    await expect(call(tool, { query: "deploy rollback" })).rejects.toThrow(
      "history_category_disabled",
    );
  } finally {
    await store.close();
  }
});

const UUID_PATTERN =
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/iu;

/** The text the model actually receives, which is what a Tool result is judged on. */
async function callModelVisible(
  tool: { execute: (...args: never[]) => unknown },
  params: Record<string, unknown>,
): Promise<{ text: string; details: unknown }> {
  const result = (await (
    tool.execute as unknown as (
      id: string,
      p: unknown,
      s?: AbortSignal,
      u?: unknown,
      c?: unknown,
    ) => Promise<{ content: Array<{ type: string; text: string }>; details?: unknown }>
  )("call", params, undefined, undefined, {} as never)) as {
    content: Array<{ type: string; text: string }>;
    details?: unknown;
  };
  return {
    text: result.content.map((part) => part.text).join(""),
    details: result.details,
  };
}

/** One group Run that may read its own group's history. */
async function groupRunTools(
  store: Store,
  archive: Awaited<ReturnType<typeof fixture>>["archive"],
) {
  await store.authorization.grant({
    principalId: "owner",
    resourceId: groupResourceId("100"),
    action: "history:read",
    scope: group100,
    effect: "allow",
  });
  const accepted = await accept(store, group100);
  return createHistoryTools({
    store,
    archive,
    isHistoryEnabled: historyEnabled,
    botIdForConnection: () => botId,
    getContext: () => ({
      caller: { principalId: "owner", scope: group100 },
      runId: accepted.run.id,
      conversationId: accepted.conversation.id,
    }),
  });
}

it("gives the model the authorized sender and bot-safe text of a hit", async () => {
  const { store, archive } = await fixture();
  try {
    const tools = await groupRunTools(store, archive);
    const { text } = await callModelVisible(toolByName(tools, GROUP_HISTORY_SEARCH_TOOL), {
      query: "deploy rollback",
    });
    const view = JSON.parse(text) as {
      groups: string[];
      currentBot?: { id: string; mentionLabel: string };
      results: Array<{
        groupId: string;
        sender?: string;
        mentionedMe?: boolean;
        text: string;
        rank: number;
      }>;
    };
    // Preserve the message content while replacing the current Bot's numeric id with a stable label.
    expect(view.results).toHaveLength(1);
    expect(view.results[0]).toMatchObject({
      groupId: "100",
      sender: "member-a",
      mentionedMe: true,
      rank: 1,
    });
    expect(view.results[0]?.text).toBe("@current_bot deploy rollback plan alpha");
    expect(view.currentBot).toEqual({ id: botId, mentionLabel: "@current_bot" });
    expect(view.groups).toEqual(["100"]);
  } finally {
    await store.close();
  }
});

it("supports general sender and mention filters without keyword patches", async () => {
  const { store, archive } = await fixture();
  try {
    const tools = await groupRunTools(store, archive);
    const tool = toolByName(tools, GROUP_HISTORY_SEARCH_TOOL);

    const byNickname = await callModelVisible(tool, { query: "Ripped" });
    const nicknameView = JSON.parse(byNickname.text) as {
      resultStatus: string;
      results: Array<{ senderName?: string; text: string }>;
    };
    expect(nicknameView).toMatchObject({ resultStatus: "matches_found" });
    expect(nicknameView.results[0]).toMatchObject({
      senderName: "Ripped",
      text: "@current_bot deploy rollback plan alpha",
    });

    const byMention = await callModelVisible(tool, { mentionsMe: true });
    const mentionView = JSON.parse(byMention.text) as {
      resultStatus: string;
      results: Array<{ senderName?: string }>;
    };
    expect(mentionView).toMatchObject({ resultStatus: "matches_found" });
    expect(mentionView.results[0]).toMatchObject({ senderName: "Ripped" });
  } finally {
    await store.close();
  }
});

it("returns the requested number from one group and reports a real result limit", async () => {
  const { store, archive } = await fixture();
  try {
    for (let index = 2; index <= 6; index++) {
      await archive.ingest({
        channel: "qq",
        connectionId,
        groupId: "100",
        externalMessageId: `g100-${index}`,
        senderId: "member-a",
        senderName: "Ripped",
        normalizedText: `distinct group message ${index}`,
        occurredAt: `2026-09-20T10:0${index}:00Z`,
      });
    }

    const tools = await groupRunTools(store, archive);
    const { text } = await callModelVisible(toolByName(tools, GROUP_HISTORY_SEARCH_TOOL), {
      sender: "member-a",
      limit: 5,
    });
    const view = JSON.parse(text) as {
      considered: number;
      returned: number;
      truncated: boolean;
      guidance: string;
      results: unknown[];
    };

    expect(view.results).toHaveLength(5);
    expect(view).toMatchObject({ considered: 6, returned: 5, truncated: true });
    expect(view.guidance).toContain("Partial results only");
    expect(view.guidance).toContain("Do not claim a complete list");
  } finally {
    await store.close();
  }
});

it("labels an empty result as window-limited rather than proving absence", async () => {
  const { store, archive } = await fixture();
  try {
    const tools = await groupRunTools(store, archive);
    const { text } = await callModelVisible(toolByName(tools, GROUP_HISTORY_SEARCH_TOOL), {
      query: "definitely-missing",
    });
    expect(JSON.parse(text)).toMatchObject({
      resultStatus: "no_matches_in_searched_window",
      guidance: expect.stringContaining("does not prove"),
      results: [],
    });
  } finally {
    await store.close();
  }
});

it("keeps internal identifiers out of the model-visible retrieval result", async () => {
  const { store, archive } = await fixture();
  try {
    const records = await archive.searchMessages({ allowedGroupIds: ["100"] });
    const archiveRecordId = records[0]!.id;
    const tools = await groupRunTools(store, archive);
    const { text, details } = await callModelVisible(toolByName(tools, GROUP_HISTORY_SEARCH_TOOL), {
      query: "deploy rollback",
    });

    // The archive record id and the Run id are implementation identifiers: the model has no
    // use for them, and a model that copies one into an answer produces output the Delivery
    // Gate must refuse. Neither may reach model-visible text.
    expect(text).not.toContain(archiveRecordId);
    expect(text).not.toMatch(UUID_PATTERN);
    expect(text).not.toContain("resourceId");
    expect(text).not.toContain("group:");
    expect(text).not.toContain("runId");
    // The structured detail keeps the identifiers for logs and UI; it is not model-visible.
    expect(JSON.stringify(details)).toContain(archiveRecordId);
  } finally {
    await store.close();
  }
});

it("produces a result the QQ Delivery Gate accepts, where the raw detail is refused", async () => {
  const { store, archive } = await fixture();
  try {
    const tools = await groupRunTools(store, archive);
    const { text, details } = await callModelVisible(toolByName(tools, GROUP_HISTORY_SEARCH_TOOL), {
      query: "deploy rollback",
    });
    const policy = createQqDeliveryPolicy();
    const view = JSON.parse(text) as {
      results: Array<{ sender?: string; text: string }>;
    };
    const hit = view.results[0]!;
    const answer = `这条消息的发送者是 ${hit.sender}，原文是「${hit.text}」。`;

    expect(policy.prepare(answer)).toMatchObject({ allowed: true, reasons: [] });
    // The same answer built from the unprojected detail is exactly what the real Run hit:
    // the internal record id trips the gate.
    const fromDetail = `消息 ID 是 ${(details as { items: Array<{ id: string }> }).items[0]!.id}。`;
    expect(policy.prepare(fromDetail)).toMatchObject({
      allowed: false,
      reasons: ["internal-uuid"],
    });
  } finally {
    await store.close();
  }
});

it("never carries another group's sender into the current group's result", async () => {
  const { store, archive } = await fixture();
  try {
    const tools = await groupRunTools(store, archive);
    const { text } = await callModelVisible(toolByName(tools, GROUP_HISTORY_SEARCH_TOOL), {
      query: "deploy rollback",
    });
    // Group 200 holds a matching message from member-b, and the caller even holds a grant for
    // it. A group Run reads its own group only.
    expect(text).not.toContain("member-b");
    expect(text).not.toContain("plan beta");
    expect(text).not.toContain("200");
  } finally {
    await store.close();
  }
});

it("drops the hit and its sender once the group's grant is revoked", async () => {
  const { store, archive } = await fixture();
  try {
    const tools = await groupRunTools(store, archive);
    const tool = toolByName(tools, GROUP_HISTORY_SEARCH_TOOL);
    const before = await callModelVisible(tool, { query: "deploy rollback" });
    expect(before.text).toContain("member-a");

    await store.authorization.revokeScope({
      principalId: "owner",
      resourceId: groupResourceId("100"),
      scope: group100,
    });
    await expect(call(tool, { query: "deploy rollback" })).rejects.toThrow(
      "Permission denied: no_grant",
    );
  } finally {
    await store.close();
  }
});

it("records no evidence for a denied search", async () => {
  const { store, archive } = await fixture();
  try {
    const accepted = await accept(store, group100);
    const evidence = vi.fn(async (_value: HistoryRetrievalEvidence) => {});
    const tools = createHistoryTools({
      store,
      archive,
      isHistoryEnabled: historyEnabled,
      recordEvidence: evidence,
      getContext: () => ({
        caller: { principalId: "owner", scope: group100 },
        runId: accepted.run.id,
        conversationId: accepted.conversation.id,
      }),
    });

    await expect(
      call(toolByName(tools, GROUP_HISTORY_SEARCH_TOOL), { query: "deploy rollback" }),
    ).rejects.toThrow("Permission denied: no_grant");
    expect(evidence).not.toHaveBeenCalled();
  } finally {
    await store.close();
  }
});

it("withholds the sender of an item whose content is withheld", async () => {
  const { store } = await fixture();
  try {
    // A source that withholds content must not disclose who said it either: provenance
    // follows the content it belongs to.
    const withheld = {
      searchCandidates: async () => [
        {
          id: "record-1",
          sourceId: "100",
          sourceKind: "channel_message",
          text: "SECRET BODY",
          timestamp: "2026-09-20T10:00:00Z",
          returnMode: "metadata_only" as const,
          metadata: { senderId: "member-a" },
        },
      ],
    };
    await store.authorization.grant({
      principalId: "owner",
      resourceId: groupResourceId("100"),
      action: "history:read",
      scope: group100,
      effect: "allow",
    });
    const accepted = await accept(store, group100);
    const tools = createHistoryTools({
      store,
      archive: withheld as unknown as ChannelArchiveStore,
      isHistoryEnabled: historyEnabled,
      getContext: () => ({
        caller: { principalId: "owner", scope: group100 },
        runId: accepted.run.id,
        conversationId: accepted.conversation.id,
      }),
    });

    const { text } = await callModelVisible(toolByName(tools, GROUP_HISTORY_SEARCH_TOOL), {
      query: "secret",
    });
    expect(text).not.toContain("SECRET BODY");
    expect(text).not.toContain("member-a");
  } finally {
    await store.close();
  }
});
