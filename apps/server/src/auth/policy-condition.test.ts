import { expect, it, vi } from "vite-plus/test";
import { openDomainStore, type CallerContext } from "../persistence/index.js";

const caller: CallerContext = {
  principalId: "owner",
  scope: {
    connectionId: "qq",
    botId: "bot",
    chatType: "private",
    chatId: "owner",
    senderId: "owner",
  },
};
const category = {
  version: 1,
  kind: "qq_category",
  connectionId: "qq",
  groupId: "100",
  category: "group.history",
} as const;
const source = {
  version: 1,
  kind: "qq_memory_source",
  connectionId: "qq",
  groupId: "100",
  sourceClass: "history",
} as const;

async function fixture() {
  const store = await openDomainStore({ databasePath: ":memory:" });
  await store.identities.bindOwner("owner", caller.scope);
  await store.authorization.registerResource({
    id: "group:100",
    kind: "qq_group",
    visibility: "public",
  });
  await store.authorization.grant({
    principalId: caller.principalId,
    scope: caller.scope,
    resourceId: "group:100",
    action: "history:read",
    effect: "allow",
  });
  return store;
}

it("checks the exact source policy in addition to a grant and preserves category/source independence", async () => {
  const store = await fixture();
  try {
    for (const [categoryEnabled, sourceEnabled] of [
      [true, true],
      [false, true],
      [true, false],
      [false, false],
    ]) {
      await store.capabilities.write({
        connectionId: "qq",
        groupId: "100",
        principalId: "owner",
        policy: {
          categories: { "group.history": categoryEnabled },
          memorySources: { history: sourceEnabled },
        },
      });
      for (const [policyCondition, enabled] of [
        [category, categoryEnabled],
        [source, sourceEnabled],
      ] as const) {
        const request = {
          caller,
          resourceId: "group:100",
          action: "history:read",
          policyCondition,
        };
        expect((await store.authorization.check(request)).decision).toBe(
          enabled ? "ALLOW" : "DENY",
        );
      }
    }
  } finally {
    await store.close();
  }
});

it("fails closed on missing policy, mismatched provenance, and legacy unknown QQ sources", async () => {
  const store = await fixture();
  try {
    for (const policyCondition of [
      category,
      source,
      null,
      { ...category, category: "group.read" as const },
      { ...category, connectionId: "other" },
    ]) {
      const request = { caller, resourceId: "group:100", action: "history:read", policyCondition };
      expect((await store.authorization.check(request)).decision).toBe("DENY");
    }
    await store.capabilities.write({
      connectionId: "qq",
      groupId: "100",
      principalId: "owner",
      policy: { categories: { "group.history": true }, memorySources: {} },
    });
    await store.authorization.revokeScope({
      principalId: "owner",
      resourceId: "group:100",
      scope: caller.scope,
    });
    expect(
      (
        await store.authorization.check({
          caller,
          resourceId: "group:100",
          action: "history:read",
          policyCondition: category,
        })
      ).decision,
    ).toBe("DENY");
  } finally {
    await store.close();
  }
});

it("keeps unrelated Agent and non-QQ legacy reads outside category policy", async () => {
  const store = await fixture();
  try {
    for (const [resourceId, kind, action] of [
      ["agent:personal", "agent", "group:read"],
      ["workspace:fixture", "workspace", "read"],
      ["group:unrelated", "document", "history:read"],
    ]) {
      await store.authorization.registerResource({
        id: resourceId!,
        kind: kind!,
        visibility: "public",
      });
      await store.authorization.grant({
        principalId: "owner",
        resourceId: resourceId!,
        action: action!,
        scope: caller.scope,
        effect: "allow",
      });
      expect(
        (
          await store.authorization.check({
            caller,
            resourceId: resourceId!,
            action: action!,
            policyCondition: null,
          })
        ).decision,
      ).toBe("ALLOW");
    }
  } finally {
    await store.close();
  }
});

it("does not consume an approval when the source policy denies access", async () => {
  const store = await fixture();
  try {
    await store.authorization.revokeScope({
      principalId: "owner",
      resourceId: "group:100",
      scope: caller.scope,
    });
    const grantId = await store.authorization.grant({
      principalId: "owner",
      resourceId: "group:100",
      action: "history:read",
      scope: caller.scope,
      effect: "approval",
    });
    const approvalId = await store.authorization.approve({
      grantId,
      approverId: "owner",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    const request = {
      caller,
      resourceId: "group:100",
      action: "history:read",
      policyCondition: category,
      approvalId,
    };
    expect((await store.authorization.check(request)).reason).toBe("source_policy_denied");
    await store.capabilities.write({
      connectionId: "qq",
      groupId: "100",
      principalId: "owner",
      policy: { categories: { "group.history": true }, memorySources: {} },
    });
    const approved = await store.authorization.check(request);
    expect(approved.reason).toBe("approved");
    const released = await store.authorization.authorizeReadResults([
      { request, decisionId: approved.id, source: "content_source" },
    ]);
    expect(released[0]!.reason).toBe("approved");
    // Completion uses the original receipt, while a new read cannot consume it again.
    expect((await store.authorization.check(request)).reason).toBe("approval_invalid");
    await expect(
      store.authorization.authorizeReadResults([
        {
          request: { ...request, action: "group:read" },
          decisionId: approved.id,
          source: "content_source",
        },
      ]),
    ).rejects.toMatchObject({ decision: { reason: "source_read_unverified" } });
  } finally {
    await store.close();
  }
});

it("authorizes a completed multi-source read as one transaction and marks none on a denial", async () => {
  const store = await fixture();
  try {
    await store.capabilities.write({
      connectionId: "qq",
      groupId: "100",
      principalId: "owner",
      policy: { categories: { "group.history": true }, memorySources: { history: true } },
    });
    const reads = [];
    for (const policyCondition of [category, source]) {
      const request = { caller, resourceId: "group:100", action: "history:read", policyCondition };
      const decision = await store.authorization.check(request);
      reads.push({ request, decisionId: decision.id, source: "content_source" as const });
    }
    await store.capabilities.write({
      connectionId: "qq",
      groupId: "100",
      principalId: "owner",
      policy: { categories: { "group.history": true }, memorySources: {} },
    });
    await expect(store.authorization.authorizeReadResults(reads)).rejects.toMatchObject({
      decision: { reason: "source_policy_denied" },
    });
    expect(
      (
        await store.db.transaction((tx) =>
          tx.execute("SELECT id FROM authorization_decisions WHERE delivery_source IS NOT NULL"),
        )
      ).rows,
    ).toEqual([]);
  } finally {
    await store.close();
  }
});

it.each([
  [false, true],
  [true, false],
  [true, true],
])(
  "completes source reads and authorizes a following action atomically (%s/%s)",
  async (readEnabled, actionEnabled) => {
    const store = await fixture();
    try {
      const policy = (read: boolean, action: boolean) =>
        store.capabilities.write({
          connectionId: "qq",
          groupId: "100",
          principalId: "owner",
          policy: {
            categories: { "group.history": read, "group.moderate": action },
            memorySources: {},
          },
        });
      await policy(true, true);
      const request = {
        caller,
        resourceId: "group:100",
        action: "history:read",
        policyCondition: category,
      };
      const initial = await store.authorization.check(request);
      const grantId = await store.authorization.grant({
        principalId: "owner",
        scope: caller.scope,
        resourceId: "group:100",
        action: "group:moderate",
        effect: "approval",
      });
      const approvalId = await store.authorization.approve({
        grantId,
        approverId: "owner",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      });
      const mutation = {
        caller,
        resourceId: "group:100",
        action: "group:moderate",
        approvalId,
        policyCondition: { ...category, category: "group.moderate" as const },
      };
      await policy(readEnabled!, actionEnabled!);
      await expect(
        store.authorization.authorizeReadResultsAndAction(
          [{ request, decisionId: initial.id, source: "content_source" }],
          {
            ...mutation,
            caller: { ...caller, scope: { ...caller.scope, chatId: "another-chat" } },
          },
        ),
      ).rejects.toMatchObject({ decision: { reason: "source_read_unverified" } });
      const spy = vi.spyOn(store.db, "transaction");
      try {
        const completed = store.authorization.authorizeReadResultsAndAction(
          [{ request, decisionId: initial.id, source: "content_source" }],
          mutation,
        );
        if (readEnabled && actionEnabled)
          await expect(completed).resolves.toMatchObject({ decision: "ALLOW", reason: "approved" });
        else
          await expect(completed).rejects.toMatchObject({
            decision: { reason: "source_policy_denied" },
          });
        expect(spy).toHaveBeenCalledTimes(1);
      } finally {
        spy.mockRestore();
      }
      const state = await store.db.transaction(async (tx) => ({
        sources: (
          await tx.execute(
            "SELECT id FROM authorization_decisions WHERE delivery_source IS NOT NULL",
          )
        ).rows,
        approval: (
          await tx.execute({
            sql: "SELECT consumed_at FROM approvals WHERE id = ?",
            args: [approvalId],
          })
        ).rows[0],
      }));
      expect(state.sources).toHaveLength(readEnabled && actionEnabled ? 1 : 0);
      if (readEnabled && actionEnabled) expect(state.approval?.consumed_at).not.toBeNull();
      else expect(state.approval?.consumed_at).toBeNull();
    } finally {
      await store.close();
    }
  },
);
