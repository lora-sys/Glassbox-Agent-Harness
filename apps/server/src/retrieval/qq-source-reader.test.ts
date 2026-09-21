import { expect, it } from "vite-plus/test";
import { agentResourceId, openDomainStore } from "../persistence/index.js";
import type { CallerContext, TrustedChannelScope } from "../persistence/index.js";
import { ChannelArchiveStore } from "./channel-archive.js";
import { AuthorizedQQSourceReader } from "./qq-source-reader.js";
import { groupResourceId } from "./source-resolver.js";

const connectionId = "qq";
const botId = "bot";
const groupId = "100";

const ownerPrivateScope: TrustedChannelScope = {
  connectionId,
  botId,
  chatType: "private",
  chatId: "owner",
  senderId: "owner",
};
const ownerPrivate: CallerContext = { principalId: "owner", scope: ownerPrivateScope };

async function fixture() {
  const store = await openDomainStore({ databasePath: ":memory:" });
  await store.conversations.createAgent("personal");
  await store.identities.bindOwner("owner", ownerPrivateScope);
  await store.authorization.registerResource({
    id: agentResourceId("personal"),
    kind: "agent",
    visibility: "public",
    ifAbsent: true,
  });
  await store.authorization.registerResource({
    id: groupResourceId(groupId),
    kind: "qq_group",
    visibility: "public",
    ifAbsent: true,
  });
  const archive = new ChannelArchiveStore(store.db);
  await archive.ingest({
    channel: "qq",
    connectionId,
    groupId,
    externalMessageId: "m-1",
    senderId: "member-a",
    normalizedText: "history alpha decision",
    occurredAt: "2026-09-20T10:00:00Z",
  });
  await archive.ingest({
    channel: "qq",
    connectionId,
    groupId,
    externalMessageId: "n-1",
    senderId: "member-b",
    normalizedText: "history alpha notice",
    occurredAt: "2026-09-20T11:00:00Z",
    sourceClass: "notice",
  });
  return { store, archive };
}

/** Enables one memory source class in the durable policy. */
async function enableSource(
  store: Awaited<ReturnType<typeof fixture>>["store"],
  sourceClass: "history" | "notice",
) {
  await store.capabilities.write({
    connectionId,
    groupId,
    principalId: "owner",
    policy: { categories: {}, memorySources: { [sourceClass]: true } },
  });
}

function reader(
  store: Awaited<ReturnType<typeof fixture>>["store"],
  archive: ChannelArchiveStore,
  caller: CallerContext = ownerPrivate,
) {
  return new AuthorizedQQSourceReader({ store, caller, archive });
}

it("treats policy enablement as intent, never as authority", async () => {
  const { store, archive } = await fixture();
  try {
    await enableSource(store, "history");
    // The policy says "history", but no Principal holds history:read on the group.
    expect(await reader(store, archive).enabledSourceClasses(connectionId, groupId)).toEqual([]);
  } finally {
    await store.close();
  }
});

it("treats a grant as insufficient without the Owner's enablement", async () => {
  const { store, archive } = await fixture();
  try {
    await store.authorization.grant({
      principalId: "owner",
      resourceId: groupResourceId(groupId),
      action: "history:read",
      scope: ownerPrivateScope,
      effect: "allow",
    });
    // Authority alone does not make a class a Memory source; the Owner must enable it.
    expect(await reader(store, archive).enabledSourceClasses(connectionId, groupId)).toEqual([]);
    await enableSource(store, "history");
    expect(await reader(store, archive).enabledSourceClasses(connectionId, groupId)).toEqual([
      "history",
    ]);
  } finally {
    await store.close();
  }
});

it("returns candidates for the requested enabled class only", async () => {
  const { store, archive } = await fixture();
  try {
    await enableSource(store, "history");
    await store.authorization.grant({
      principalId: "owner",
      resourceId: groupResourceId(groupId),
      action: "history:read",
      scope: ownerPrivateScope,
      effect: "allow",
    });
    const candidates = await reader(store, archive).readCandidates({
      connectionId,
      groupId,
      sourceClass: "history",
      query: "alpha",
    });
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      sourceId: groupResourceId(groupId),
      sourceClass: "history",
      text: "history alpha decision",
      returnMode: "raw",
    });
    expect(candidates[0]?.id).toBeTruthy();
  } finally {
    await store.close();
  }
});

it("never loads a class the Owner has not enabled, even when rows exist", async () => {
  const { store, archive } = await fixture();
  try {
    await enableSource(store, "history");
    await store.authorization.grant({
      principalId: "owner",
      resourceId: groupResourceId(groupId),
      action: "history:read",
      scope: ownerPrivateScope,
      effect: "allow",
    });
    const sourceReader = reader(store, archive);
    // Notice rows exist in the archive but `notice` is neither enabled nor granted.
    expect(
      await sourceReader.readCandidates({
        connectionId,
        groupId,
        sourceClass: "notice",
        query: "alpha",
      }),
    ).toEqual([]);
  } finally {
    await store.close();
  }
});

it("drops a source class on the next read after revocation", async () => {
  const { store, archive } = await fixture();
  try {
    await enableSource(store, "history");
    const grantId = await store.authorization.grant({
      principalId: "owner",
      resourceId: groupResourceId(groupId),
      action: "history:read",
      scope: ownerPrivateScope,
      effect: "allow",
    });
    const sourceReader = reader(store, archive);
    expect(await sourceReader.enabledSourceClasses(connectionId, groupId)).toEqual(["history"]);
    await store.authorization.revoke(grantId);
    // No cached enablement survives a revocation.
    expect(await sourceReader.enabledSourceClasses(connectionId, groupId)).toEqual([]);
    expect(
      await sourceReader.readCandidates({
        connectionId,
        groupId,
        sourceClass: "history",
        query: "alpha",
      }),
    ).toEqual([]);
  } finally {
    await store.close();
  }
});

it("generates candidates without creating a Run, message or Memory record", async () => {
  const { store, archive } = await fixture();
  try {
    await enableSource(store, "history");
    await store.authorization.grant({
      principalId: "owner",
      resourceId: groupResourceId(groupId),
      action: "history:read",
      scope: ownerPrivateScope,
      effect: "allow",
    });
    await reader(store, archive).readCandidates({
      connectionId,
      groupId,
      sourceClass: "history",
      query: "alpha",
    });
    const runs = await store.db.transaction((tx) => tx.execute("SELECT id FROM runs"));
    const messages = await store.db.transaction((tx) => tx.execute("SELECT id FROM messages"));
    expect(runs.rows).toHaveLength(0);
    expect(messages.rows).toHaveLength(0);
  } finally {
    await store.close();
  }
});
