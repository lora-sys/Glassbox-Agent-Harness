import { expect, it } from "vite-plus/test";
import { openDomainStore } from "../application/domain-store.js";

it.each(["revoked", "approval"])(
  "does not replace %s delivery policy during a reader backfill",
  async (policy) => {
    const store = await openDomainStore({ databasePath: ":memory:" });
    try {
      const scope = {
        connectionId: "test",
        botId: "bot",
        chatType: "private" as const,
        chatId: "owner",
        senderId: "owner",
      };
      await store.identities.bindOwner("owner", scope);
      await store.authorization.registerResource({
        id: "skills",
        kind: "skill-catalog",
        visibility: "public",
      });
      const base = { principalId: "owner", scope, resourceId: "skills" };
      await store.authorization.grant({ ...base, action: "skill:read", effect: "allow" });
      const delivery = await store.authorization.grant({
        ...base,
        action: "delivery:send",
        effect: "allow",
      });
      await store.authorization.revoke(delivery);
      if (policy === "approval")
        await store.authorization.grant({ ...base, action: "delivery:send", effect: "approval" });
      expect(
        await store.authorization.backfillDeliveryForReaders({
          resourceId: "skills",
          readAction: "skill:read",
        }),
      ).toBe(0);
      expect(
        (
          await store.authorization.check({
            caller: { principalId: "owner", scope },
            resourceId: "skills",
            action: "delivery:send",
          })
        ).decision,
      ).toBe(policy === "approval" ? "REQUIRES_APPROVAL" : "DENY");
    } finally {
      await store.close();
    }
  },
);

it("initializes each exact scope once and leaves explicit restoration to management", async () => {
  const store = await openDomainStore({ databasePath: ":memory:" });
  try {
    const scope = {
      connectionId: "test",
      botId: "bot",
      chatType: "private" as const,
      chatId: "owner",
      senderId: "owner",
    };
    await store.identities.bindOwner("owner", scope);
    await store.authorization.registerResource({
      id: "agent",
      kind: "agent",
      visibility: "public",
    });
    const grant = {
      principalId: "owner",
      scope,
      resourceId: "agent",
      action: "run:create",
      effect: "allow" as const,
    };
    const first = await store.authorization.grantInitial(grant);
    expect(first).toEqual(expect.any(String));
    expect(await store.authorization.grantInitial(grant)).toBeNull();
    await store.authorization.revoke(first!);
    expect(await store.authorization.grantInitial(grant)).toBeNull();
    const decide = () =>
      store.authorization.check({
        caller: { principalId: "owner", scope },
        resourceId: "agent",
        action: "run:create",
      });
    expect((await decide()).decision).toBe("DENY");
    // Same principal in another location is a new tuple, not permission to restore this one.
    expect(
      await store.authorization.grantInitial({
        ...grant,
        scope: { ...scope, chatType: "group", chatId: "another" },
      }),
    ).toEqual(expect.any(String));
    expect((await decide()).decision).toBe("DENY");
    await store.authorization.grant(grant);
    expect((await decide()).decision).toBe("ALLOW");
  } finally {
    await store.close();
  }
});
