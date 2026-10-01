import { openDomainStore } from "../application/domain-store.js";

export async function memoryFixture(databasePath = ":memory:") {
  const store = await openDomainStore({ databasePath });
  const scope = {
    connectionId: "qq",
    botId: "bot",
    chatType: "private" as const,
    chatId: "owner",
    senderId: "owner",
  };
  const caller = { principalId: "owner", scope };
  const context = { caller };
  const groupContext = {
    caller: {
      principalId: "owner",
      scope: { ...scope, chatType: "group" as const, chatId: "100" },
    },
  };
  const groupScope = { type: "group" as const, connectionId: "qq", botId: "bot", groupId: "100" };
  await store.identities.bindOwner("owner", scope);
  await store.conversations.createAgent("personal");
  await store.authorization.grant({
    principalId: "owner",
    resourceId: "agent:personal",
    action: "run:create",
    scope,
    effect: "allow",
  });
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
  for (const action of ["memory:read", "memory:write", "memory:govern"])
    await store.authorization.grant({
      principalId: "owner",
      resourceId: "owner-memory",
      action,
      scope,
      effect: "allow",
    });
  await store.authorization.grant({
    principalId: "owner",
    resourceId: "group:100",
    action: "memory:read",
    scope: groupContext.caller.scope,
    effect: "allow",
  });
  const base = {
    subject: { kind: "user" as const, id: "owner" },
    scope: { type: "global" as const },
    type: "semantic_fact" as const,
  };
  return { store, caller, context, scope, groupContext, groupScope, base };
}
