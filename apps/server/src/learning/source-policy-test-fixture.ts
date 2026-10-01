import { openDomainStore } from "../persistence/index.js";
import { ChannelArchiveStore } from "../retrieval/channel-archive.js";
import { createOwnerMemoryTools } from "../runtime/pi/owner-memory-tools.js";

export async function sourcePolicyFixture(
  databasePath = ":memory:",
  text = "Import orchard fixtures",
) {
  const store = await openDomainStore({ databasePath });
  const scope = {
    connectionId: "qq",
    botId: "bot",
    chatType: "private" as const,
    chatId: "owner",
    senderId: "owner",
  };
  const caller = { principalId: "owner", scope };
  await store.identities.bindOwner("owner", scope);
  await store.conversations.createAgent("personal");
  await store.authorization.registerResource({
    id: "owner-memory",
    kind: "owner-memory",
    visibility: "private",
    ownerId: "owner",
  });
  await store.authorization.registerResource({
    id: "group:100",
    kind: "qq_group",
    visibility: "public",
  });
  for (const [resourceId, actions] of [
    ["agent:personal", ["run:create", "run:control", "conversation:read", "delivery:send"]],
    ["owner-memory", ["memory:read", "memory:write", "memory:govern", "delivery:send"]],
    ["group:100", ["history:read", "group:content:read", "delivery:send"]],
  ] as const)
    for (const action of actions)
      await store.authorization.grant({
        principalId: "owner",
        resourceId,
        action,
        scope,
        effect: "allow",
      });
  const policy = (history: boolean, notice = true) =>
    store.capabilities.write({
      connectionId: "qq",
      groupId: "100",
      principalId: "owner",
      policy: { categories: {}, memorySources: { history, notice } },
    });
  await policy(true);
  const archive = new ChannelArchiveStore(store.db);
  for (const sourceClass of ["history", "notice"] as const)
    await archive.ingest({
      channel: "qq",
      connectionId: "qq",
      groupId: "100",
      externalMessageId: sourceClass,
      senderId: "fixture",
      normalizedText: `Protected orchard ${sourceClass} fact.`,
      sourceClass,
      occurredAt: "2026-09-20T10:00:00Z",
    });
  const accepted = await store.conversations.acceptIncoming({
    agentId: "personal",
    scope,
    messageId: "source",
    text,
    executionRef: "fake",
  });
  const context = { caller, conversationId: accepted.conversation.id, runId: accepted.run.id };
  const [tool] = createOwnerMemoryTools({ store, getContext: () => context });
  const importSource = async (sourceClass: "history" | "notice" = "history") => {
    const result = await tool!.execute(
      "source",
      { action: "source", sourceClass, groupId: "100", scopeType: "global", query: "orchard" },
      undefined,
      undefined,
      {} as never,
    );
    return (result.details as { candidates: Array<{ candidateId: string }> }).candidates[0]!
      .candidateId;
  };
  const base = {
    subject: { kind: "user" as const, id: "owner" },
    scope: { type: "global" as const },
    type: "semantic_fact" as const,
  };
  return { store, caller, scope, context, accepted, policy, importSource, base };
}
