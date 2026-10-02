import { expect, it } from "vite-plus/test";
import { openDomainStore } from "../../persistence/index.js";
import { QQ_CAPABILITIES } from "../../channels/onebot/capabilities.js";
import { createCapabilityTools } from "./capability-tools.js";

const cases = [
  ["qq_groups", "get_group_info"],
  ["qq_group_members", "get_group_member_list"],
  ["qq_group_history", "get_group_msg_history"],
  ["qq_group_content", "_get_group_notice"],
  ["qq_group_files", "get_group_root_files"],
] as const;

it.each(cases)(
  "revokes %s content at new read, delivery creation, claim, retry, and history reuse",
  async (name, operation) => {
    const store = await openDomainStore({ databasePath: ":memory:" });
    const scope = {
      connectionId: "qq",
      botId: "bot",
      chatType: "group" as const,
      chatId: "100",
      senderId: "owner",
    };
    const caller = { principalId: "owner", scope };
    const capability = QQ_CAPABILITIES.find((item) => item.tool === name)!;
    try {
      await store.conversations.createAgent("personal");
      await store.identities.bindOwner("owner", scope);
      await store.authorization.registerResource({
        id: "group:100",
        kind: "qq_group",
        visibility: "public",
      });
      const grant = (resourceId: string, action: string) =>
        store.authorization.grant({
          principalId: "owner",
          resourceId,
          action,
          scope,
          effect: "allow",
        });
      for (const action of [
        "run:create",
        "run:control",
        "conversation:read",
        "delivery:send",
        "trace:write",
      ])
        await grant("agent:personal", action);
      await grant("group:100", capability.action);
      await grant("group:100", "delivery:send");
      const policy = (enabled: boolean) =>
        store.capabilities.write({
          connectionId: "qq",
          groupId: "100",
          principalId: "owner",
          policy: { categories: { [capability.category]: enabled }, memorySources: {} },
        });
      await policy(true);
      const accepted = await store.conversations.acceptIncoming({
        agentId: "personal",
        scope,
        messageId: "first",
        text: "read the fixture",
        executionRef: "fake",
      });
      const context = { caller, runId: accepted.run.id, conversationId: accepted.conversation.id };
      let calls = 0;
      const tool = createCapabilityTools({
        store,
        getContext: () => context,
        isCategoryEnabled: async (connectionId, groupId, category) =>
          (await store.capabilities.read(connectionId, groupId))?.policy.categories[category] ===
          true,
        search: async () => ({}),
        projectManagedGroups: async () => ({}),
        invoke: async () => {
          calls++;
          return name === "qq_group_members"
            ? [{ user_id: 123 }]
            : { fixture: "protected-policy-content" };
        },
      }).find((item) => item.name === name)!;
      await tool.execute("first", { operation }, undefined, undefined, {} as never);
      expect(calls).toBe(1);
      const lease = await store.lifecycle.claimQueuedRun(caller, accepted.run.id);
      await lease.settle("succeeded", "protected-policy-content");
      const create = (dedupKey: string) =>
        store.lifecycle.createDelivery(caller, {
          runId: accepted.run.id,
          destination: scope,
          dedupKey,
          payloadText: "protected-policy-content",
          payloadKind: "result",
        });
      const pending = await create("pending");
      const failed = await create("failed");
      const failedLease = await store.lifecycle.claimDelivery(caller, accepted.run.id, failed);
      await failedLease!.settle("failed");
      // A permitted later turn inherits the exact same dependency before revocation.
      const next = await store.conversations.acceptIncoming({
        agentId: "personal",
        scope,
        messageId: "next",
        text: "repeat",
        executionRef: "fake",
      });
      const before = await store.conversations.loadRunInput(caller, next.run.id);
      expect(JSON.stringify(before.history)).toContain("protected-policy-content");
      const nextLease = await store.lifecycle.claimQueuedRun(caller, next.run.id);
      await nextLease.settle("succeeded", "protected-policy-content");
      await policy(false);
      await expect(
        tool.execute("revoked", { operation }, undefined, undefined, {} as never),
      ).rejects.toThrow("source_policy_denied");
      expect(calls).toBe(1);
      for (const attempt of [
        () => create("late"),
        () => store.lifecycle.claimDelivery(caller, accepted.run.id, pending),
        () =>
          store.lifecycle.transitionDelivery(caller, accepted.run.id, failed, "failed", "pending"),
      ]) {
        await expect(attempt()).rejects.toMatchObject({
          decision: { reason: "source_policy_denied" },
        });
      }
      const last = await store.conversations.acceptIncoming({
        agentId: "personal",
        scope,
        messageId: "last",
        text: "repeat again",
        executionRef: "fake",
      });
      expect(
        JSON.stringify((await store.conversations.loadRunInput(caller, last.run.id)).history),
      ).not.toContain("protected-policy-content");
      const denied = await store.db.transaction((tx) =>
        tx.execute({
          sql: "SELECT reason FROM authorization_decisions WHERE run_id = ? AND reason = 'source_policy_denied'",
          args: [next.run.id],
        }),
      );
      // The history chain is checked on its consuming turn, without changing old evidence.
      expect(denied.rows).toHaveLength(0);
    } finally {
      await store.close();
    }
  },
);

it.each(["policy", "grant"])(
  "withholds a provider read when %s is revoked while awaiting its result",
  async (revocation) => {
    const store = await openDomainStore({ databasePath: ":memory:" });
    const scope = {
      connectionId: "qq",
      botId: "bot",
      chatType: "group" as const,
      chatId: "100",
      senderId: "owner",
    };
    const caller = { principalId: "owner", scope };
    let entered!: () => void;
    const waiting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: () => void;
    const provider = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      await store.conversations.createAgent("personal");
      await store.identities.bindOwner("owner", scope);
      await store.authorization.registerResource({
        id: "group:100",
        kind: "qq_group",
        visibility: "public",
      });
      await store.authorization.grant({
        principalId: "owner",
        resourceId: "agent:personal",
        action: "run:create",
        scope,
        effect: "allow",
      });
      const grantId = await store.authorization.grant({
        principalId: "owner",
        resourceId: "group:100",
        action: "group:read",
        scope,
        effect: "allow",
      });
      await store.capabilities.write({
        connectionId: "qq",
        groupId: "100",
        principalId: "owner",
        policy: { categories: { "group.read": true }, memorySources: {} },
      });
      const accepted = await store.conversations.acceptIncoming({
        agentId: "personal",
        scope,
        messageId: "window",
        text: "read",
        executionRef: "fake",
      });
      const tool = createCapabilityTools({
        store,
        getContext: () => ({
          caller,
          runId: accepted.run.id,
          conversationId: accepted.conversation.id,
        }),
        isCategoryEnabled: async () => true,
        search: async () => ({}),
        projectManagedGroups: async () => ({}),
        invoke: async () => {
          entered();
          await provider;
          return { group_name: "awaited protected fixture" };
        },
      }).find((entry) => entry.name === "qq_groups")!;
      const result = tool.execute(
        "window",
        { operation: "get_group_info" },
        undefined,
        undefined,
        {} as never,
      );
      await waiting;
      if (revocation === "policy")
        await store.capabilities.write({
          connectionId: "qq",
          groupId: "100",
          principalId: "owner",
          policy: { categories: {}, memorySources: {} },
        });
      else await store.authorization.revoke(grantId);
      release();
      await expect(result).rejects.toThrow("protected_read_revoked");
      const evidence = await store.db.transaction((tx) =>
        tx.execute({
          sql: "SELECT decision,delivery_source FROM authorization_decisions WHERE run_id = ? AND resource_id = 'group:100'",
          args: [accepted.run.id],
        }),
      );
      expect(evidence.rows.some((row) => row.decision === "ALLOW")).toBe(true);
      expect(evidence.rows.some((row) => row.decision === "DENY")).toBe(true);
      expect(evidence.rows.every((row) => row.delivery_source === null)).toBe(true);
    } finally {
      release?.();
      await store.close();
    }
  },
);
