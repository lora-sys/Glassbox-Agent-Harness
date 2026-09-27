import { expect, it } from "vite-plus/test";
import { AccessDeniedError, agentResourceId, openDomainStore } from "../persistence/index.js";
import type { CallerContext, TrustedChannelScope } from "../persistence/index.js";
import { groupResourceId } from "./source-resolver.js";

const connectionId = "qq";
const botId = "bot";

const group100Scope: TrustedChannelScope = {
  connectionId,
  botId,
  chatType: "group",
  chatId: "100",
  senderId: "owner",
};
const group200Scope: TrustedChannelScope = {
  ...group100Scope,
  chatId: "200",
};

const group100: CallerContext = { principalId: "owner", scope: group100Scope };

const runActions = [
  "run:create",
  "conversation:read",
  "run:control",
  "delivery:send",
  "trace:write",
];

async function fixture() {
  const store = await openDomainStore({ databasePath: ":memory:" });
  await store.conversations.createAgent("personal");
  await store.identities.bindOwner("owner", group100Scope);
  await store.identities.bindPrincipal("owner", group200Scope);
  await store.authorization.registerResource({
    id: agentResourceId("personal"),
    kind: "agent",
    visibility: "public",
    ifAbsent: true,
  });
  for (const scope of [group100Scope, group200Scope]) {
    for (const action of runActions) {
      await store.authorization.grant({
        principalId: "owner",
        resourceId: agentResourceId("personal"),
        action,
        scope,
        effect: "allow",
      });
    }
  }
  for (const gid of ["100", "200"]) {
    await store.authorization.registerResource({
      id: groupResourceId(gid),
      kind: "qq_group",
      visibility: "public",
      ifAbsent: true,
    });
  }
  return store;
}

/** One group Run that read its own group's history through `history:read`. */
async function runThatReadHistory(store: Awaited<ReturnType<typeof fixture>>) {
  const accepted = await store.conversations.acceptIncoming({
    agentId: "personal",
    scope: group100Scope,
    messageId: "history-question",
    text: "what did we decide?",
    executionRef: "pi:test",
  });
  await store.authorization.grant({
    principalId: "owner",
    resourceId: groupResourceId("100"),
    action: "history:read",
    scope: group100Scope,
    effect: "allow",
  });
  // Record both the allowed decision and the successful protected read, as the Tool does.
  const decision = await store.authorization.check({
    caller: group100,
    resourceId: groupResourceId("100"),
    action: "history:read",
    runId: accepted.run.id,
  });
  expect(decision.decision).toBe("ALLOW");
  await store.authorization.markDeliverySource(decision.id, "content_source");
  const lease = await store.lifecycle.claimQueuedRun(group100, accepted.run.id);
  await lease.settle("succeeded", "DERIVED_FROM_GROUP_100_HISTORY");
  return accepted.run.id;
}

it("blocks delivering a history-derived answer to another group's audience", async () => {
  const store = await fixture();
  try {
    const runId = await runThatReadHistory(store);
    // Reading group 100's history never authorizes answering into group 200.
    await expect(
      store.lifecycle.createDelivery(group100, {
        runId,
        dedupKey: "answer-200",
        destination: group200Scope,
        payloadText: "DERIVED_FROM_GROUP_100_HISTORY",
        payloadKind: "result",
      }),
    ).rejects.toThrow("Delivery must use the authorized ingress destination");
  } finally {
    await store.close();
  }
});

it("requires delivery:send on the history source separately from history:read", async () => {
  const store = await fixture();
  try {
    const runId = await runThatReadHistory(store);
    // `history:read` alone does not imply delivery: the source dependency is rechecked
    // against `delivery:send` on the same Resource at delivery time.
    await expect(
      store.lifecycle.createDelivery(group100, {
        runId,
        dedupKey: "answer-100",
        destination: group100Scope,
        payloadText: "DERIVED_FROM_GROUP_100_HISTORY",
        payloadKind: "result",
      }),
    ).rejects.toBeInstanceOf(AccessDeniedError);

    await store.authorization.grant({
      principalId: "owner",
      resourceId: groupResourceId("100"),
      action: "delivery:send",
      scope: group100Scope,
      effect: "allow",
    });
    const deliveryId = await store.lifecycle.createDelivery(group100, {
      runId,
      dedupKey: "answer-100",
      destination: group100Scope,
      payloadText: "DERIVED_FROM_GROUP_100_HISTORY",
      payloadKind: "result",
    });
    expect(deliveryId).toBeTruthy();
  } finally {
    await store.close();
  }
});

it("stops a revoked history source from authorizing delivery", async () => {
  const store = await fixture();
  try {
    const runId = await runThatReadHistory(store);
    await store.authorization.grant({
      principalId: "owner",
      resourceId: groupResourceId("100"),
      action: "delivery:send",
      scope: group100Scope,
      effect: "allow",
    });
    await store.authorization.revokeResource(groupResourceId("100"));
    // The source stopped being authorized after the Run read it: no stale authority
    // may carry the derived answer out.
    await expect(
      store.lifecycle.createDelivery(group100, {
        runId,
        dedupKey: "answer-100",
        destination: group100Scope,
        payloadText: "DERIVED_FROM_GROUP_100_HISTORY",
        payloadKind: "result",
      }),
    ).rejects.toBeInstanceOf(AccessDeniedError);
  } finally {
    await store.close();
  }
});
