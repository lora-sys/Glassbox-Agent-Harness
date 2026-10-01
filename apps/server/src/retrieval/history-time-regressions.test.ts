import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vite-plus/test";
import { openDomainStore } from "../persistence/index.js";
import { createHistoryTools, GROUP_HISTORY_SEARCH_TOOL } from "../runtime/pi/history-tools.js";
import { ChannelArchiveStore } from "./channel-archive.js";
import { AuthorizedQQSourceReader } from "./qq-source-reader.js";
import { MemoryRetriever } from "./retriever.js";
import { runFixtureProcess } from "../persistence/test-fixture-process.js";
import { historyReopenFixtureScript } from "./history-reopen-fixture.js";

const scope = {
  connectionId: "qq",
  botId: "bot",
  chatType: "group" as const,
  chatId: "100",
  senderId: "owner",
};
const caller = { principalId: "owner", scope };
const instant = "2026-10-01T00:30:00.123Z";
const equivalents = [instant, "2026-10-01T08:30:00.123+08:00", "2026-09-30T17:30:00.123-07:00"];

async function fixture() {
  const store = await openDomainStore({ databasePath: ":memory:" });
  await store.identities.bindOwner("owner", scope);
  await store.conversations.createAgent("personal");
  await store.authorization.registerResource({
    id: "group:100",
    kind: "qq_group",
    visibility: "public",
  });
  for (const [resourceId, action] of [
    ["agent:personal", "run:create"],
    ["group:100", "history:read"],
  ])
    await store.authorization.grant({
      principalId: "owner",
      resourceId: resourceId!,
      action: action!,
      scope,
      effect: "allow",
    });
  await store.capabilities.write({
    connectionId: "qq",
    groupId: "100",
    principalId: "owner",
    policy: { categories: { "group.history": true }, memorySources: { history: true } },
  });
  const accepted = await store.conversations.acceptIncoming({
    agentId: "personal",
    scope,
    messageId: "time-query",
    text: "Find deployment history",
    executionRef: "pi:fixture",
  });
  const archive = new ChannelArchiveStore(store.db);
  const ids: string[] = [];
  for (const [i, occurredAt] of [
    "2026-10-01T00:30:00.122Z",
    equivalents[1]!,
    "2026-10-01T00:30:00.124Z",
  ].entries())
    ids.push(
      await archive.ingest({
        channel: "qq",
        connectionId: "qq",
        groupId: "100",
        externalMessageId: String(i),
        senderId: "author",
        normalizedText: `Deployment completed item ${i}`,
        occurredAt,
      }),
    );
  const tool = createHistoryTools({
    store,
    archive,
    isHistoryEnabled: async () => true,
    getContext: () => ({
      caller,
      runId: accepted.run.id,
      conversationId: accepted.conversation.id,
    }),
  }).find((t) => t.name === GROUP_HISTORY_SEARCH_TOOL)!;
  const call = (params: Record<string, unknown>) =>
    tool.execute("time-call", params, undefined, undefined, {} as never);
  const reader = new AuthorizedQQSourceReader({ store, caller, archive });
  return { store, archive, ids, call, reader };
}

it("uses equivalent inclusive millisecond bounds through the real history Tool and source reader", async () => {
  const { store, ids, call, reader } = await fixture();
  try {
    for (const since of equivalents) {
      for (const until of equivalents) {
        const result = await call({ query: "Deployment", since, until, limit: 1 });
        expect((result.details as { items: { id: string }[] }).items.map((x) => x.id)).toEqual([
          ids[1],
        ]);
        expect(
          (
            await reader.readCandidates({
              connectionId: "qq",
              groupId: "100",
              sourceClass: "history",
              query: "Deployment",
              since,
              until,
              limit: 1,
            })
          ).map((x) => x.id),
        ).toEqual([ids[1]]);
      }
    }
  } finally {
    await store.close();
  }
});

it("applies one-sided time filters before the result limit", async () => {
  const { store, archive, ids, call } = await fixture();
  try {
    for (const bound of equivalents) {
      const after = await call({ query: "Deployment", since: bound, limit: 10 });
      const before = await call({ query: "Deployment", until: bound, limit: 10 });
      expect((after.details as { items: { id: string }[] }).items.map((x) => x.id).sort()).toEqual(
        [ids[1], ids[2]].sort(),
      );
      expect((before.details as { items: { id: string }[] }).items.map((x) => x.id).sort()).toEqual(
        [ids[0], ids[1]].sort(),
      );
      expect(
        (await archive.searchMessages({ allowedGroupIds: ["100"], since: bound, limit: 1 })).map(
          (x) => x.id,
        ),
      ).toEqual([ids[2]]);
    }
    for (const [id, occurredAt] of [
      ["epoch-before", "1969-12-31T23:59:59.999Z"],
      ["epoch", "1970-01-01T08:00:00+08:00"],
      ["epoch-after", "1970-01-01T00:00:00.001Z"],
    ])
      await archive.ingest({
        channel: "qq",
        connectionId: "qq",
        groupId: "100",
        externalMessageId: id!,
        senderId: "author",
        normalizedText: `Epoch ${id}`,
        occurredAt: occurredAt!,
      });
    expect(
      (
        await archive.searchMessages({
          allowedGroupIds: ["100"],
          since: "1970-01-01T00:00:00Z",
          until: "1970-01-01T00:00:00Z",
        })
      ).map((x) => x.externalMessageId),
    ).toEqual(["epoch"]);
  } finally {
    await store.close();
  }
});

it("canonicalizes newly stored timestamps and keeps the epoch index current on deduplicated ingestion", async () => {
  const { store, archive, ids } = await fixture();
  try {
    const read = () =>
      store.db.transaction(
        async (tx) =>
          (
            await tx.execute({
              sql: "SELECT occurred_at, occurred_at_ms FROM channel_messages WHERE id = ?",
              args: [ids[1]!],
            })
          ).rows[0],
      );
    expect(await read()).toMatchObject({
      occurred_at: instant,
      occurred_at_ms: Date.parse(instant),
    });
    await archive.ingest({
      channel: "qq",
      connectionId: "qq",
      groupId: "100",
      externalMessageId: "1",
      senderId: "author",
      normalizedText: "Deployment enriched",
      occurredAt: "2026-10-01T08:30:00.124+08:00",
    });
    expect(await read()).toMatchObject({
      occurred_at: "2026-10-01T00:30:00.124Z",
      occurred_at_ms: Date.parse(instant) + 1,
    });
    await expect(
      archive.ingest({
        channel: "qq",
        connectionId: "qq",
        groupId: "100",
        externalMessageId: "bad",
        senderId: "author",
        normalizedText: "Invalid",
        occurredAt: "not a timestamp",
      }),
    ).rejects.toThrow("invalid_history_timestamp");
  } finally {
    await store.close();
  }
});

it.each([
  { since: "not a timestamp" },
  { until: "" },
  { since: "2026-10-02", until: "2026-10-01" },
  { limit: 0 },
  { limit: -1 },
  { limit: 1.5 },
  { limit: Number.NaN },
  { limit: Infinity },
  { limit: 201 },
])("rejects invalid history windows or limits before reading: %j", async (params) => {
  const { store, archive, call, reader } = await fixture();
  try {
    await expect(call({ query: "Deployment", ...params })).rejects.toThrow(/invalid_history/);
    await expect(
      archive.searchMessages({ allowedGroupIds: ["100"], query: "Deployment", ...params }),
    ).rejects.toThrow(/invalid_history/);
    await expect(
      reader.readCandidates({
        connectionId: "qq",
        groupId: "100",
        sourceClass: "history",
        query: "Deployment",
        ...params,
      }),
    ).rejects.toThrow(/invalid_history/);
  } finally {
    await store.close();
  }
});

it("filters custom retriever candidates by instants before duplicate suppression", async () => {
  const retriever = new MemoryRetriever({
    store: {
      searchCandidates: async () => [
        {
          id: "before",
          sourceId: "100",
          sourceKind: "channel_message",
          text: "Deployment completed",
          timestamp: "2026-10-01T08:30:00.122+08:00",
        },
        {
          id: "hit",
          sourceId: "100",
          sourceKind: "channel_message",
          text: "Deployment completed",
          timestamp: equivalents[2]!,
        },
        {
          id: "after",
          sourceId: "100",
          sourceKind: "channel_message",
          text: "Deployment after",
          timestamp: "2026-10-01T00:30:00.124Z",
        },
        {
          id: "invalid",
          sourceId: "100",
          sourceKind: "channel_message",
          text: "Deployment invalid",
          timestamp: "bad",
        },
      ],
    },
  });
  const result = await retriever.search("Deployment", {
    allowedSourceIds: ["100"],
    since: instant,
    until: instant,
  });
  expect(result.map((x) => x.memory.id)).toEqual(["hit"]);
  await expect(
    retriever.search("Deployment", {
      allowedSourceIds: ["100"],
      since: "2026-10-02",
      until: "2026-10-01",
    }),
  ).rejects.toThrow("invalid_history_time_range");
});

it("migrates legacy Date.parse formats to integer milliseconds without rewriting source timestamps", async ({
  signal,
}) => {
  const dir = await mkdtemp(join(tmpdir(), "glassbox-history-time-"));
  try {
    const output = await runFixtureProcess(
      historyReopenFixtureScript,
      [join(dir, "legacy.db")],
      signal,
    );
    expect(output).toContain('"completed":"history-reopen"');
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});
