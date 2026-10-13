import { expect, it } from "vite-plus/test";
import {
  agentResourceId,
  openDomainStore,
  type CallerContext,
  type DomainStore,
} from "../persistence/index.js";
import { qqCategoryCondition } from "../auth/policy-condition.js";

const scope = {
  connectionId: "filtered-history-test",
  botId: "bot",
  chatType: "private" as const,
  chatId: "owner-qq",
  senderId: "owner-qq",
};
const caller: CallerContext = { principalId: "owner", scope };

async function fixture(input: { policyEnabled: boolean; legacyNullCondition?: boolean }) {
  const store = await openDomainStore({ databasePath: ":memory:" });
  await store.conversations.createAgent("personal");
  await store.identities.bindOwner(caller.principalId, scope);
  await store.authorization.registerResource({
    id: "group:fixture-group",
    kind: "qq_group",
    visibility: "public",
  });
  for (const action of ["run:create", "run:control", "conversation:read", "trace:write"])
    await store.authorization.grant({
      principalId: caller.principalId,
      resourceId: agentResourceId("personal"),
      action,
      scope,
      effect: "allow",
    });
  await store.authorization.grant({
    principalId: caller.principalId,
    resourceId: "group:fixture-group",
    action: "history:read",
    scope,
    effect: "allow",
  });
  await store.capabilities.write({
    connectionId: scope.connectionId,
    groupId: "fixture-group",
    principalId: caller.principalId,
    policy: {
      categories: { "group.history": true },
      memorySources: {},
    },
  });

  const origin = await store.conversations.acceptIncoming({
    agentId: "personal",
    scope,
    messageId: "protected-history-origin",
    text: "PRIVATE_HISTORY_INPUT_CANARY",
    executionRef: "pi:test",
  });
  const decision = await store.authorization.check({
    caller,
    resourceId: "group:fixture-group",
    action: "history:read",
    policyCondition: input.legacyNullCondition
      ? { version: 1, kind: "none" }
      : qqCategoryCondition(caller, "fixture-group", "group.history"),
    runId: origin.run.id,
    conversationId: origin.conversation.id,
  });
  expect(decision.decision).toBe("ALLOW");
  await store.authorization.markDeliverySource(decision.id, "content_source");
  if (input.legacyNullCondition) {
    await store.db.transaction((tx) =>
      tx.execute({
        sql: "UPDATE authorization_decisions SET policy_condition_json = NULL WHERE id = ?",
        args: [decision.id],
      }),
    );
  }
  const originLease = await store.lifecycle.claimQueuedRun(caller, origin.run.id);
  await originLease.settle("succeeded", "PRIVATE_HISTORY_RESULT_CANARY");
  if (!input.policyEnabled && !input.legacyNullCondition) {
    await store.capabilities.write({
      connectionId: scope.connectionId,
      groupId: "fixture-group",
      principalId: caller.principalId,
      policy: { categories: { "group.history": false }, memorySources: {} },
    });
  }

  const current = await store.conversations.acceptIncoming({
    agentId: "personal",
    scope,
    messageId: "protected-history-current",
    text: "current question",
    executionRef: "pi:test",
  });
  return {
    store,
    originRunId: origin.run.id,
    currentRunId: current.run.id,
    sourceDecisionId: decision.id,
  };
}

it.each([
  ["disabled source policy", false, false],
  ["legacy null source condition", true, true],
] as const)(
  "excludes prior protected history and records its exact DENY for %s",
  async (_label, policyEnabled, legacyNullCondition) => {
    const { store, originRunId, currentRunId, sourceDecisionId } = await fixture({
      policyEnabled,
      legacyNullCondition,
    });
    try {
      const input = await store.conversations.loadRunInput(caller, currentRunId);
      expect(JSON.stringify(input.history)).not.toContain("PRIVATE_HISTORY_INPUT_CANARY");
      expect(JSON.stringify(input.history)).not.toContain("PRIVATE_HISTORY_RESULT_CANARY");

      const evidence = await readFilteredEvidence(store, currentRunId);
      expect(evidence.decisions).toHaveLength(1);
      expect(evidence.decisions[0]).toMatchObject({
        decision: "DENY",
        reason: "source_policy_denied",
        resource_id: "group:fixture-group",
        action: "history:read",
      });
      expect(evidence.event).toMatchObject({
        run_id: currentRunId,
        principal_id: caller.principalId,
      });
      const eventData = evidence.event?.data_json;
      expect(typeof eventData).toBe("string");
      expect(JSON.parse(typeof eventData === "string" ? eventData : "")).toEqual({
        decisionId: evidence.decisions[0]?.id,
        projection: "conversation-history",
        outcome: "excluded",
      });
      expect(evidence.decisions[0]?.id).not.toBe(sourceDecisionId);
      expect(originRunId).not.toBe(currentRunId);
    } finally {
      await store.close();
    }
  },
);

it("includes prior history under ALLOW and records no filtered event", async () => {
  const { store, currentRunId } = await fixture({ policyEnabled: true });
  try {
    const input = await store.conversations.loadRunInput(caller, currentRunId);
    expect(input.history).toEqual([
      { role: "user", text: "PRIVATE_HISTORY_INPUT_CANARY" },
      { role: "assistant", text: "PRIVATE_HISTORY_RESULT_CANARY" },
    ]);
    const evidence = await readFilteredEvidence(store, currentRunId);
    expect(evidence.decisions).toHaveLength(1);
    expect(evidence.decisions[0]).toMatchObject({ decision: "ALLOW", action: "history:read" });
    expect(evidence.event).toBeUndefined();
  } finally {
    await store.close();
  }
});

async function readFilteredEvidence(store: DomainStore, runId: string) {
  return store.db.transaction(async (tx) => {
    const decisions = await tx.execute({
      sql: "SELECT id,decision,reason,resource_id,action FROM authorization_decisions WHERE run_id = ? AND action = 'history:read' ORDER BY rowid",
      args: [runId],
    });
    const events = await tx.execute({
      sql: "SELECT run_id,principal_id,data_json FROM ops_trace_events WHERE run_id = ? AND type = 'authorization.filtered' ORDER BY rowid",
      args: [runId],
    });
    return { decisions: decisions.rows, event: events.rows[0] };
  });
}
