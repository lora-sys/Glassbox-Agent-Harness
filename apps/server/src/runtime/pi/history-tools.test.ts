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
  type HistorySyncOutcome,
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

it("returns every match a single-group search asked for, not a per-source-capped three", async () => {
  const { store, archive } = await fixture();
  try {
    for (let index = 0; index < 7; index++) {
      await archive.ingest({
        channel: "qq",
        connectionId,
        groupId: "100",
        externalMessageId: `g100-extra-${index}`,
        senderId: "member-a",
        normalizedText: `deploy rollback step ${index}`,
        occurredAt: `2026-09-20T12:0${index}:00Z`,
      });
    }
    const tools = await groupRunTools(store, archive);
    const { text } = await callModelVisible(toolByName(tools, GROUP_HISTORY_SEARCH_TOOL), {
      query: "deploy rollback",
      limit: 8,
    });
    const view = JSON.parse(text) as {
      results: unknown[];
      coverage: {
        returned: number;
        considered: number;
        requestedLimit: number;
        truncated: boolean;
        coverage: string;
      };
    };

    // The fixture holds eight matching messages in one group. A per-source cap meant for
    // cross-group diversity used to cut this to three and report a bare `truncated: true`,
    // which answers a smaller question than the one the Run asked.
    expect(view.results).toHaveLength(8);
    expect(view.coverage).toMatchObject({
      returned: 8,
      considered: 8,
      requestedLimit: 8,
      truncated: false,
      coverage: "complete",
    });
  } finally {
    await store.close();
  }
});

it("keeps the per-source cap across groups and names it in the coverage", async () => {
  const { store, archive } = await fixture();
  try {
    for (let index = 0; index < 5; index++) {
      await archive.ingest({
        channel: "qq",
        connectionId,
        groupId: "100",
        externalMessageId: `g100-multi-${index}`,
        senderId: "member-a",
        normalizedText: `deploy rollback step ${index}`,
        occurredAt: `2026-09-20T12:0${index}:00Z`,
      });
    }
    for (const gid of ["100", "200"]) {
      await assign(store, gid);
      await authorizeHistory(store, gid);
    }
    const accepted = await accept(store, ownerPrivate);
    const tools = createHistoryTools({
      store,
      archive,
      isHistoryEnabled: historyEnabled,
      syncGroup: sourceExhausted,
      getContext: () => ({
        caller: { principalId: "owner", scope: ownerPrivate },
        runId: accepted.run.id,
        conversationId: accepted.conversation.id,
      }),
    });
    const { text } = await callModelVisible(toolByName(tools, OWNER_HISTORY_SEARCH_TOOL), {
      query: "deploy rollback",
      limit: 8,
    });
    const view = JSON.parse(text) as {
      coverage: {
        considered: number;
        perSourceCap: number | null;
        truncated: boolean;
        truncationReasons: string[];
        coverage: string;
        sourceLimits: string[];
        sourceCoverage: Array<{
          groupId: string;
          returned: number;
          considered: number;
          capped: boolean;
          sync: HistorySyncOutcome | "unreported";
        }>;
        continuation?: { cappedGroups?: string[] };
      };
    };

    // A cross-group answer still diversifies, and now says that it did and why.
    expect(view.coverage).toMatchObject({
      considered: 7,
      perSourceCap: 3,
      truncated: true,
      truncationReasons: ["per_source_cap_reached"],
      coverage: "partial",
      // Both walks reached the end of their source, so the only thing this search did not
      // see is the candidate the cap cut — the source window is not the reason here.
      sourceLimits: [],
      continuation: { cappedGroups: ["100"] },
    });
    expect(view.coverage.sourceCoverage).toEqual([
      {
        groupId: "100",
        returned: 3,
        considered: 6,
        capped: true,
        sync: { pagesWalked: 1, stop: "end_of_source" },
      },
      {
        groupId: "200",
        returned: 1,
        considered: 1,
        capped: false,
        sync: { pagesWalked: 1, stop: "end_of_source" },
      },
    ]);
  } finally {
    await store.close();
  }
});

it("reports the hits that reached the model, not the candidates the retriever kept", async () => {
  // `returned` and the per-source `returned` answer the same question, so they have to be the
  // same number. The retriever's own count is taken before the bounded Context runs: it kept
  // seven candidates and the per-source cap left four. A coverage record that reported seven
  // described a result list the model never received, and the sum of the per-source returns —
  // which is the same fact — contradicted it in the same object.
  const { store, archive } = await fixture();
  try {
    for (let index = 0; index < 5; index++) {
      await archive.ingest({
        channel: "qq",
        connectionId,
        groupId: "100",
        externalMessageId: `g100-reach-${index}`,
        senderId: "member-a",
        normalizedText: `deploy rollback step ${index}`,
        occurredAt: `2026-09-20T12:0${index}:00Z`,
      });
    }
    for (const gid of ["100", "200"]) {
      await assign(store, gid);
      await authorizeHistory(store, gid);
    }
    const accepted = await accept(store, ownerPrivate);
    const tools = createHistoryTools({
      store,
      archive,
      isHistoryEnabled: historyEnabled,
      syncGroup: sourceExhausted,
      getContext: () => ({
        caller: { principalId: "owner", scope: ownerPrivate },
        runId: accepted.run.id,
        conversationId: accepted.conversation.id,
      }),
    });
    const { text } = await callModelVisible(toolByName(tools, OWNER_HISTORY_SEARCH_TOOL), {
      query: "deploy rollback",
      limit: 8,
    });
    const view = JSON.parse(text) as {
      results: unknown[];
      coverage: {
        returned: number;
        considered: number;
        sourceCoverage: Array<{ returned: number }>;
      };
    };

    expect(view.results).toHaveLength(4);
    expect(view.coverage.considered).toBe(7);
    expect(view.coverage.returned).toBe(view.results.length);
    expect(view.coverage.sourceCoverage.reduce((sum, source) => sum + source.returned, 0)).toBe(
      view.coverage.returned,
    );
  } finally {
    await store.close();
  }
});

it("reads the window's truncation the same way in every field that reports it", async () => {
  // `truncated` and `coverage.truncated` describe one window, so they cannot disagree. The
  // top-level flag counted only what the bounded Context dropped, while the coverage counted
  // every bound including the limit the retriever applied. A search that asked for three of
  // eight matches therefore reported `truncated: false` beside `truncationReasons:
  // ["top_k_reached"]`, and a reader taking the flag alone would read a cut window as an
  // exhausted one.
  const { store, archive } = await fixture();
  try {
    for (let index = 0; index < 7; index++) {
      await archive.ingest({
        channel: "qq",
        connectionId,
        groupId: "100",
        externalMessageId: `g100-agree-${index}`,
        senderId: "member-a",
        normalizedText: `deploy rollback step ${index}`,
        occurredAt: `2026-09-20T12:0${index}:00Z`,
      });
    }
    const tools = await groupRunTools(store, archive);
    const { text } = await callModelVisible(toolByName(tools, GROUP_HISTORY_SEARCH_TOOL), {
      query: "deploy rollback",
      limit: 3,
    });
    const view = JSON.parse(text) as {
      truncated: boolean;
      coverage: { truncated: boolean; truncationReasons: string[] };
    };

    expect(view.coverage.truncationReasons).toEqual(["top_k_reached"]);
    expect(view.coverage.truncated).toBe(true);
    expect(view.truncated).toBe(view.coverage.truncated);
  } finally {
    await store.close();
  }
});

it("never offers a continuation that reaches no more than the search already did", async () => {
  // The suggested limit is what the reader raises the bound to. When the candidate set is
  // larger than the Tool's own maximum no larger limit exists, and the field said to raise the
  // limit to the limit that had just been used: a next step that changes nothing, reading as
  // though more of the window were reachable from here.
  const { store, archive } = await fixture();
  try {
    for (let index = 0; index < 60; index++) {
      await archive.ingest({
        channel: "qq",
        connectionId,
        groupId: "100",
        externalMessageId: `g100-max-${index}`,
        senderId: "member-a",
        // A term the fixture's own messages do not carry, so the candidate set is exactly the
        // messages this test ingested.
        normalizedText: `zoetrope marker ${index}`,
        occurredAt: `2026-09-20T12:${String(index).padStart(2, "0")}:00Z`,
      });
    }
    const tools = await groupRunTools(store, archive);
    const { text } = await callModelVisible(toolByName(tools, GROUP_HISTORY_SEARCH_TOOL), {
      query: "zoetrope",
      limit: 50,
    });
    const view = JSON.parse(text) as {
      results: unknown[];
      coverage: {
        requestedLimit: number;
        considered: number;
        truncationReasons: string[];
        continuation?: { suggestedLimit?: number };
      };
    };

    expect(view.results).toHaveLength(50);
    expect(view.coverage.considered).toBe(60);
    expect(view.coverage.truncationReasons).toEqual(["top_k_reached"]);
    expect(view.coverage.continuation?.suggestedLimit).toBeUndefined();
  } finally {
    await store.close();
  }
});

it("says the window is unknown rather than empty when no group was searched", async () => {
  const { store, archive } = await fixture();
  try {
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
    const { text } = await callModelVisible(toolByName(tools, OWNER_HISTORY_SEARCH_TOOL), {
      query: "deploy rollback",
    });
    const view = JSON.parse(text) as {
      groups: string[];
      resultStatus: string;
      coverage: { coverage: string; considered: number; groupsSearched: number };
    };

    // Zero authorized groups is not an exhausted window: nothing was looked at, so nothing
    // about the world was learned.
    expect(view.groups).toEqual([]);
    expect(view.resultStatus).toBe("no_matches_in_searched_window");
    expect(view.coverage).toMatchObject({
      coverage: "unknown",
      considered: 0,
      groupsSearched: 0,
    });
  } finally {
    await store.close();
  }
});

it("says only part of the source was searched when the walk stopped short of its end", async () => {
  const { store, archive } = await fixture();
  try {
    const tools = await groupRunTools(store, archive, async () => ({
      pagesWalked: 5,
      stop: "page_bound_reached",
    }));
    const { text } = await callModelVisible(toolByName(tools, GROUP_HISTORY_SEARCH_TOOL), {
      query: "deploy rollback",
    });
    const view = JSON.parse(text) as {
      results: unknown[];
      coverage: { coverage: string; truncated: boolean; sourceLimits: string[] };
      guidance: string;
    };

    // The archive answered completely — nothing was cut — but the archive had itself only
    // been read up to the sync's page bound. A group whose history continues past that bound
    // is a group this search never looked at, so "no match" here is a statement about the
    // part that was read and nothing more. This is the window that a bare `truncated: false`
    // used to hide: the search read everything it had, from a source it had not finished.
    expect(view.results).toHaveLength(1);
    expect(view.coverage.truncated).toBe(false);
    expect(view.coverage).toMatchObject({
      coverage: "partial",
      sourceLimits: ["page_bound_reached"],
    });
    expect(view.guidance).toContain("Only part of the source was searched");
    expect(view.guidance).toContain("does not prove");
  } finally {
    await store.close();
  }
});

it("does not claim the source was exhausted when no walk reported on it", async () => {
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
    // A surface that wires no sync at all, or one whose sync returns nothing, has not told
    // this search how much of the source it holds. Silence is not the end of the source.
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
    const { text } = await callModelVisible(toolByName(tools, GROUP_HISTORY_SEARCH_TOOL), {
      query: "deploy rollback",
    });
    const view = JSON.parse(text) as {
      coverage: {
        coverage: string;
        truncated: boolean;
        sourceLimits: string[];
        sourceCoverage: Array<{ groupId: string; sync: HistorySyncOutcome | "unreported" }>;
      };
      guidance: string;
    };

    expect(view.coverage.truncated).toBe(false);
    expect(view.coverage).toMatchObject({
      coverage: "partial",
      sourceLimits: ["sync_unreported"],
      sourceCoverage: [{ groupId: "100", sync: "unreported" }],
    });
    expect(view.guidance).toContain("Only part of the source was searched");
  } finally {
    await store.close();
  }
});

it("offers a continuation that actually reaches the matches it left out", async () => {
  const { store, archive } = await fixture();
  try {
    for (let index = 0; index < 7; index++) {
      await archive.ingest({
        channel: "qq",
        connectionId,
        groupId: "100",
        externalMessageId: `g100-page-${index}`,
        senderId: "member-a",
        normalizedText: `deploy rollback step ${index}`,
        occurredAt: `2026-09-20T12:0${index}:00Z`,
      });
    }
    const tools = await groupRunTools(store, archive);
    const tool = toolByName(tools, GROUP_HISTORY_SEARCH_TOOL);
    const first = JSON.parse(
      (await callModelVisible(tool, { query: "deploy rollback", limit: 3 })).text,
    ) as {
      results: unknown[];
      coverage: {
        coverage: string;
        considered: number;
        returned: number;
        truncationReasons: string[];
        continuation?: { suggestedLimit?: number };
      };
    };

    // Three hits were asked for and eight existed. A time cursor would be a lie here: the
    // retriever ranks by score, so "older than the oldest hit" can skip newer matches. The
    // honest continuation is the limit that reaches the candidate set the search already saw.
    expect(first.results).toHaveLength(3);
    expect(first.coverage).toMatchObject({
      coverage: "partial",
      considered: 8,
      returned: 3,
      truncationReasons: ["top_k_reached"],
      continuation: { suggestedLimit: 8 },
    });

    const second = JSON.parse(
      (
        await callModelVisible(tool, {
          query: "deploy rollback",
          limit: first.coverage.continuation!.suggestedLimit!,
        })
      ).text,
    ) as { results: unknown[]; coverage: { coverage: string; truncated: boolean } };
    expect(second.results).toHaveLength(8);
    expect(second.coverage).toMatchObject({ coverage: "complete", truncated: false });
  } finally {
    await store.close();
  }
});

it("records the coverage it reported in the retrieval evidence", async () => {
  const { store, archive } = await fixture();
  try {
    const accepted = await accept(store, group100);
    await store.authorization.grant({
      principalId: "owner",
      resourceId: groupResourceId("100"),
      action: "history:read",
      scope: group100,
      effect: "allow",
    });
    const evidence = vi.fn(async (_value: HistoryRetrievalEvidence) => {});
    const tools = createHistoryTools({
      store,
      archive,
      isHistoryEnabled: historyEnabled,
      recordEvidence: evidence,
      syncGroup: sourceExhausted,
      getContext: () => ({
        caller: { principalId: "owner", scope: group100 },
        runId: accepted.run.id,
        conversationId: accepted.conversation.id,
      }),
    });

    await call(toolByName(tools, GROUP_HISTORY_SEARCH_TOOL), { query: "deploy rollback" });
    const value = evidence.mock.calls[0]![0];
    // Trace must be able to answer "did this Run see the whole window?" without the model's
    // answer being the only record of it.
    expect(value.coverage).toMatchObject({
      returned: 1,
      considered: 1,
      requestedLimit: 8,
      coverage: "complete",
    });
    expect(value.coverage.observedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/u);
  } finally {
    await store.close();
  }
});

it("restates the coverage in the evidence rather than recording the window a second way", async () => {
  // `considered` and `truncated` sit beside `coverage` in the same Trace record, so they are the
  // same fact stated twice. A narrower reading of `truncated` — only what the bounded Context
  // dropped — put `false` beside a coverage naming a cut, and Trace then held two answers to one
  // question about whether the window was read, leaving the model's own answer to decide which
  // one is believed.
  const { store, archive } = await fixture();
  try {
    for (let index = 0; index < 7; index++) {
      await archive.ingest({
        channel: "qq",
        connectionId,
        groupId: "100",
        externalMessageId: `g100-evidence-${index}`,
        senderId: "member-a",
        // A term the fixture's own messages do not carry, so the candidate set is exactly the
        // messages this test ingested.
        normalizedText: `zoetrope evidence ${index}`,
        occurredAt: `2026-09-20T12:0${index}:00Z`,
      });
    }
    await store.authorization.grant({
      principalId: "owner",
      resourceId: groupResourceId("100"),
      action: "history:read",
      scope: group100,
      effect: "allow",
    });
    const accepted = await accept(store, group100);
    const evidence = vi.fn(async (_value: HistoryRetrievalEvidence) => {});
    const tools = createHistoryTools({
      store,
      archive,
      isHistoryEnabled: historyEnabled,
      recordEvidence: evidence,
      syncGroup: sourceExhausted,
      getContext: () => ({
        caller: { principalId: "owner", scope: group100 },
        runId: accepted.run.id,
        conversationId: accepted.conversation.id,
      }),
    });

    await call(toolByName(tools, GROUP_HISTORY_SEARCH_TOOL), { query: "zoetrope", limit: 3 });
    const value = evidence.mock.calls[0]![0];

    expect(value.coverage.truncationReasons).toEqual(["top_k_reached"]);
    expect(value.coverage.truncated).toBe(true);
    expect(value.truncated).toBe(value.coverage.truncated);
    expect(value.considered).toBe(value.coverage.considered);
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

/**
 * One group Run that may read its own group's history.
 *
 * The sync reports a walk that reached the end of the source, because that is what production
 * wires: the Tool's own coverage now depends on how much of the source the walk reached, so a
 * fixture that stayed silent would report every search as partial for a reason the test is not
 * about. `syncGroup` overrides it for the tests that are about the source window.
 */
async function groupRunTools(
  store: Store,
  archive: Awaited<ReturnType<typeof fixture>>["archive"],
  syncGroup: (groupId: string) => Promise<HistorySyncOutcome | undefined> = async () => ({
    pagesWalked: 1,
    stop: "end_of_source",
  }),
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
    syncGroup,
    getContext: () => ({
      caller: { principalId: "owner", scope: group100 },
      runId: accepted.run.id,
      conversationId: accepted.conversation.id,
    }),
  });
}

/** The sync a fully-read source reports, for the tests whose subject is something else. */
const sourceExhausted = async (): Promise<HistorySyncOutcome> => ({
  pagesWalked: 1,
  stop: "end_of_source",
});

it("gives the model the authorized sender and the original text of a hit", async () => {
  const { store, archive } = await fixture();
  try {
    const tools = await groupRunTools(store, archive);
    const { text } = await callModelVisible(toolByName(tools, GROUP_HISTORY_SEARCH_TOOL), {
      query: "deploy rollback",
    });
    const view = JSON.parse(text) as {
      groups: string[];
      results: Array<{ groupId: string; sender?: string; text: string; rank: number }>;
    };
    // The real request asked for 发送者和原文; both must be answerable from the Tool result.
    expect(view.results).toHaveLength(1);
    expect(view.results[0]).toMatchObject({ groupId: "100", sender: "member-a", rank: 1 });
    expect(view.results[0]?.text).toContain("plan alpha");
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
      text: "deploy rollback plan alpha",
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

/**
 * The exact identifier the regression fixture searches for.
 *
 * Deliberately not a real production message: the deterministic suite owns its own canary,
 * and the real acceptance run uses a temporary one in a dedicated test group.
 */
const EXACT_IDENTIFIER = "P4B-A-1349";

/** Messages that share a token with the identifier without carrying it. */
async function ingestNearMisses(
  archive: Awaited<ReturnType<typeof fixture>>["archive"],
): Promise<void> {
  await archive.ingest({
    channel: "qq",
    connectionId,
    groupId: "100",
    externalMessageId: "g100-near-1",
    senderId: "member-c",
    senderName: "Near",
    normalizedText: "编号 1349 已经修好了",
    occurredAt: "2026-09-21T09:00:00Z",
  });
  await archive.ingest({
    channel: "qq",
    connectionId,
    groupId: "100",
    externalMessageId: "g100-near-2",
    senderId: "member-d",
    senderName: "AlsoNear",
    normalizedText: "P4B 这个流还没开始",
    occurredAt: "2026-09-21T09:30:00Z",
  });
}

it("answers an exact identifier from the message that carries it and nothing else", async () => {
  const { store, archive } = await fixture();
  try {
    await ingestNearMisses(archive);
    await archive.ingest({
      channel: "qq",
      connectionId,
      groupId: "100",
      externalMessageId: "g100-exact",
      senderId: "member-e",
      senderName: "Carrier",
      normalizedText: `已合并 ${EXACT_IDENTIFIER} 到 main`,
      occurredAt: "2026-09-18T09:00:00Z",
    });
    const tools = await groupRunTools(store, archive);
    const { text } = await callModelVisible(toolByName(tools, GROUP_HISTORY_SEARCH_TOOL), {
      query: EXACT_IDENTIFIER,
    });
    const view = JSON.parse(text) as {
      results: Array<{ sender?: string; occurredAt?: string; text: string; groupId: string }>;
      resultStatus: string;
      coverage: { exactTerms: string[]; droppedByExactTerm: number; coverage: string };
    };

    // Sender, time and original text come only from the record the Tool returned. The
    // near misses are absent even though they outrank nothing here — they simply are not
    // messages about this identifier.
    expect(view.resultStatus).toBe("matches_found");
    expect(view.results).toHaveLength(1);
    expect(view.results[0]).toMatchObject({
      groupId: "100",
      sender: "member-e",
      occurredAt: "2026-09-18T09:00:00Z",
      text: `已合并 ${EXACT_IDENTIFIER} 到 main`,
    });
    expect(view.coverage.exactTerms).toEqual([EXACT_IDENTIFIER.toLowerCase()]);
    expect(view.coverage.droppedByExactTerm).toBe(2);
    expect(view.coverage.coverage).toBe("complete");
  } finally {
    await store.close();
  }
});

it("keeps an exact identifier in the model-visible text even when it appears after the snippet head", async () => {
  const { store, archive } = await fixture();
  try {
    const prefix = "前置信息".repeat(80);
    await archive.ingest({
      channel: "qq",
      connectionId,
      groupId: "100",
      externalMessageId: "g100-late-exact",
      senderId: "member-e",
      senderName: "Carrier",
      normalizedText: `${prefix} ${EXACT_IDENTIFIER} 到这里才出现`,
      occurredAt: "2026-09-18T09:00:00Z",
    });
    const tools = await groupRunTools(store, archive);
    const { text } = await callModelVisible(toolByName(tools, GROUP_HISTORY_SEARCH_TOOL), {
      query: EXACT_IDENTIFIER,
    });
    const view = JSON.parse(text) as { results: Array<{ text: string }> };

    expect(view.results).toHaveLength(1);
    expect(view.results[0]?.text).toContain(EXACT_IDENTIFIER);
    expect(view.results[0]?.text.length).toBeLessThanOrEqual(242);
  } finally {
    await store.close();
  }
});

it("never lets a near miss stand in for an identifier the history does not contain", async () => {
  const { store, archive } = await fixture();
  try {
    await ingestNearMisses(archive);
    const tools = await groupRunTools(store, archive);
    const { text } = await callModelVisible(toolByName(tools, GROUP_HISTORY_SEARCH_TOOL), {
      query: EXACT_IDENTIFIER,
    });
    const view = JSON.parse(text) as {
      results: unknown[];
      resultStatus: string;
      guidance: string;
      coverage: { exactTerms: string[]; droppedByExactTerm: number };
    };

    // The incident's mechanism, closed at the Tool result: the model is handed neither a
    // near miss nor any field of one, so the identifier cannot be answered from the query
    // string plus a plausible-looking record.
    expect(view.results).toEqual([]);
    expect(view.resultStatus).toBe("no_matches_in_searched_window");
    // The evidence spells the term in one case so two queries that differ only in case
    // produce identical records; the guidance still names the identifier that was asked for.
    expect(view.guidance.toLowerCase()).toContain(EXACT_IDENTIFIER.toLowerCase());
    expect(view.guidance).toContain("verbatim");
    expect(view.coverage.droppedByExactTerm).toBe(2);
    expect(text).not.toContain("1349 已经修好了");
    expect(text).not.toContain("member-c");
    expect(text).not.toContain("Near");
  } finally {
    await store.close();
  }
});

it("says why a short result is short instead of leaving it to be inferred", async () => {
  const { store, archive } = await fixture();
  try {
    await ingestNearMisses(archive);
    const tools = await groupRunTools(store, archive);
    const { text } = await callModelVisible(toolByName(tools, GROUP_HISTORY_SEARCH_TOOL), {
      query: EXACT_IDENTIFIER,
    });
    const view = JSON.parse(text) as {
      considered: number;
      truncated: boolean;
      coverage: {
        considered: number;
        returned: number;
        droppedByExactTerm: number;
        truncationReasons: string[];
        coverage: string;
        groupsSearched: number;
      };
    };

    // `considered` counts what was read; the reason the answer is short is named rather
    // than left as a gap. Nothing was cut, so the window still reads `complete` — calling
    // this truncation would invite "search again" for a question that was answered.
    expect(view.considered).toBe(2);
    expect(view.coverage).toMatchObject({
      considered: 2,
      returned: 0,
      droppedByExactTerm: 2,
      truncationReasons: [],
      coverage: "complete",
      groupsSearched: 1,
    });
    expect(view.truncated).toBe(false);
  } finally {
    await store.close();
  }
});

it("records the exact terms it required in the retrieval evidence", async () => {
  const { store, archive } = await fixture();
  try {
    await ingestNearMisses(archive);
    await store.authorization.grant({
      principalId: "owner",
      resourceId: groupResourceId("100"),
      action: "history:read",
      scope: group100,
      effect: "allow",
    });
    const accepted = await accept(store, group100);
    const evidence: HistoryRetrievalEvidence[] = [];
    const tools = createHistoryTools({
      store,
      archive,
      isHistoryEnabled: historyEnabled,
      syncGroup: sourceExhausted,
      getContext: () => ({
        caller: { principalId: "owner", scope: group100 },
        runId: accepted.run.id,
        conversationId: accepted.conversation.id,
      }),
      recordEvidence: async (value) => {
        evidence.push(value);
      },
    });

    await call(toolByName(tools, GROUP_HISTORY_SEARCH_TOOL), { query: EXACT_IDENTIFIER });

    // Trace must be able to answer "why did this search return nothing" without the model's
    // own answer being the only record of it.
    expect(evidence).toHaveLength(1);
    expect(evidence[0]!.coverage).toMatchObject({
      exactTerms: [EXACT_IDENTIFIER.toLowerCase()],
      droppedByExactTerm: 2,
      coverage: "complete",
    });
  } finally {
    await store.close();
  }
});
