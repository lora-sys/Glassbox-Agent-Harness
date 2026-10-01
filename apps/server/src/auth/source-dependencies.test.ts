import { AuthorizedOpsService } from "../ops/service.js";
import { FakeHerdrBridge } from "../ops/fake-herdr-bridge.js";
import { expect, it } from "vite-plus/test";
import { openDomainStore } from "../persistence/index.js";
import { archiveDecisionBatch } from "../persistence/decision-archive.js";
import {
  readPolicyCondition,
  qqCategoryCondition,
  qqMemorySourceCondition,
} from "./policy-condition.js";
import {
  readRunSourceRows,
  readTaskSourceRows,
  reauthorizeSourceRows,
} from "./source-dependencies.js";

async function fixture() {
  const store = await openDomainStore({ databasePath: ":memory:" });
  const scope = {
    connectionId: "qq",
    botId: "bot",
    chatType: "private" as const,
    chatId: "owner",
    senderId: "owner",
  };
  const caller = { principalId: "owner", scope };
  await store.conversations.createAgent("personal");
  await store.identities.bindOwner("owner", scope);
  await store.authorization.registerResource({
    id: "group:100",
    kind: "qq_group",
    visibility: "public",
  });
  for (const [resourceId, actions] of [
    ["agent:personal", ["run:create", "run:control", "conversation:read", "delivery:send"]],
    ["group:100", ["group:content:read", "delivery:send"]],
  ] as const)
    for (const action of actions)
      await store.authorization.grant({
        principalId: "owner",
        resourceId,
        action,
        scope,
        effect: "allow",
      });
  const accept = (messageId: string) =>
    store.conversations.acceptIncoming({
      agentId: "personal",
      scope,
      messageId,
      text: "fixture",
      executionRef: "fake",
    });
  const origin = await accept("origin");
  const target = await accept("target");
  const policy = (essence: boolean) =>
    store.capabilities.write({
      connectionId: "qq",
      groupId: "100",
      principalId: "owner",
      policy: { categories: { "group.content": true }, memorySources: { notice: true, essence } },
    });
  await policy(true);
  return { store, caller, origin, target, policy };
}

it("keeps category, notice, and essence dependencies distinct through archive and propagation", async () => {
  const { store, caller, origin, target, policy } = await fixture();
  try {
    const conditions = [
      qqCategoryCondition(caller, "100", "group.content"),
      qqMemorySourceCondition(caller, "qq", "100", "notice"),
      qqMemorySourceCondition(caller, "qq", "100", "essence"),
    ];
    for (const policyCondition of conditions) {
      const decision = await store.authorization.check({
        caller,
        resourceId: "group:100",
        action: "group:content:read",
        runId: origin.run.id,
        policyCondition,
      });
      await store.authorization.markDeliverySource(decision.id, "content_source");
    }
    const lease = await store.lifecycle.claimQueuedRun(caller, origin.run.id);
    await lease.settle("succeeded", "protected derived result");
    expect(await archiveDecisionBatch(store.db, "9999-01-01T00:00:00.000Z")).toBeGreaterThan(0);
    await store.db.transaction(async (tx) => {
      const rows = await readRunSourceRows(tx, [origin.run.id]);
      expect(rows).toHaveLength(3);
      expect(rows.map(readPolicyCondition)).toEqual(expect.arrayContaining(conditions));
      expect(
        await reauthorizeSourceRows(tx, caller, rows, {
          runId: target.run.id,
          conversationId: target.conversation.id,
        }),
      ).toEqual({ value: null });
      expect(await readRunSourceRows(tx, [target.run.id])).toHaveLength(3);
    });
    await policy(false);
    await expect(
      store.lifecycle.createDelivery(caller, {
        runId: target.run.id,
        dedupKey: "answer",
        destination: caller.scope,
        payloadKind: "result",
        payloadText: "derived",
      }),
    ).rejects.toMatchObject({ decision: { reason: "source_policy_denied" } });
  } finally {
    await store.close();
  }
});

it("never treats lost or malformed constrained provenance as an unconstrained source", async () => {
  const { store, caller, origin } = await fixture();
  try {
    const decision = await store.authorization.check({
      caller,
      resourceId: "group:100",
      action: "group:content:read",
      runId: origin.run.id,
      policyCondition: qqCategoryCondition(caller, "100", "group.content"),
    });
    await store.authorization.markDeliverySource(decision.id, "content_source");
    for (const raw of [null, "invalid", '{"version":1,"kind":"qq_category"}']) {
      await store.db.transaction((tx) =>
        tx.execute({
          sql: "UPDATE authorization_decisions SET policy_condition_json = ? WHERE id = ?",
          args: [raw, decision.id],
        }),
      );
      const delivery = store.lifecycle.createDelivery(caller, {
        runId: origin.run.id,
        dedupKey: "answer",
        destination: caller.scope,
        payloadKind: "result",
        payloadText: "derived",
      });
      if (raw === null)
        await expect(delivery).rejects.toMatchObject({
          decision: { reason: "source_policy_denied" },
        });
      else await expect(delivery).rejects.toThrow("Invalid source policy condition");
    }
  } finally {
    await store.close();
  }
});

it("checks a Task's bounded complete ancestry and rejects missing or cyclic lineage", async () => {
  const { store, caller, origin } = await fixture();
  try {
    const decision = await store.authorization.check({
      caller,
      resourceId: "group:100",
      action: "group:content:read",
      runId: origin.run.id,
      policyCondition: qqCategoryCondition(caller, "100", "group.content"),
    });
    await store.authorization.markDeliverySource(decision.id, "content_source");
    for (let i = 0; i < 6; i++) {
      await store.tasks.createTask({
        id: `task-${i}`,
        title: "fixture",
        creatorPrincipalId: "owner",
        runId: i === 0 ? origin.run.id : undefined,
      });
      await store.db.transaction((tx) =>
        tx.execute({
          sql: "INSERT INTO task_steps(id,task_id,kind,title,status,dependency_policy_json,max_attempts,required_capabilities_json,delegated_permissions_json,version,created_at,updated_at) VALUES (?,?,'child_task','fixture','pending','{}',1,'[]','[]',1,'now','now')",
          args: [`step-${i}`, `task-${i}`],
        }),
      );
      if (i > 0)
        await store.db.transaction((tx) =>
          tx.execute({
            sql: "INSERT INTO task_child_links(child_task_id,parent_task_id,parent_step_id,delegated_permissions_json,acceptance_criteria_json,cancel_policy,failure_policy,created_at) VALUES (?,?,?,'[]','[]','cancel_child','block_parent','now')",
            args: [`task-${i}`, `task-${i - 1}`, `step-${i - 1}`],
          }),
        );
    }
    expect(await store.db.transaction((tx) => readTaskSourceRows(tx, "task-4"))).toHaveLength(1);
    await expect(store.db.transaction((tx) => readTaskSourceRows(tx, "task-5"))).rejects.toThrow(
      "Invalid Task source lineage",
    );
    await expect(store.db.transaction((tx) => readTaskSourceRows(tx, "absent"))).rejects.toThrow(
      "Missing Task source lineage",
    );
    await store.db.transaction((tx) =>
      tx.execute(
        "INSERT INTO task_child_links(child_task_id,parent_task_id,parent_step_id,delegated_permissions_json,acceptance_criteria_json,cancel_policy,failure_policy,created_at) VALUES ('task-0','task-1','step-1','[]','[]','cancel_child','block_parent','now')",
      ),
    );
    await expect(store.db.transaction((tx) => readTaskSourceRows(tx, "task-1"))).rejects.toThrow(
      "Invalid Task source lineage",
    );
  } finally {
    await store.close();
  }
});

it("rechecks and propagates Task content dependencies across get, list, steps, and events", async () => {
  const { store, caller, origin, target, policy } = await fixture();
  try {
    const source = await store.authorization.check({
      caller,
      resourceId: "group:100",
      action: "group:content:read",
      runId: origin.run.id,
      policyCondition: qqMemorySourceCondition(caller, "qq", "100", "essence"),
    });
    await store.authorization.markDeliverySource(source.id, "content_source");
    const task = await store.tasks.createTask({
      id: "derived",
      title: "protected title",
      description: "protected description",
      creatorPrincipalId: "owner",
      runId: origin.run.id,
      authorizationScope: caller.scope,
    });
    await store.authorization.registerResource({
      id: "agent-operations",
      kind: "ops",
      visibility: "private",
    });
    for (const [resourceId, action] of [
      ["task-derived", "task:read"],
      ["agent-operations", "task:list"],
    ])
      await store.authorization.grant({
        principalId: "owner",
        resourceId: resourceId!,
        action: action!,
        scope: caller.scope,
        effect: "allow",
      });
    const service = new AuthorizedOpsService(store, new FakeHerdrBridge());
    const evidence = { runId: target.run.id, conversationId: target.conversation.id };
    expect(await service.get(caller, task.id, evidence)).toMatchObject({
      title: "protected title",
    });
    expect(await service.list(caller, evidence)).toHaveLength(1);
    expect(
      (await store.db.transaction((tx) => readRunSourceRows(tx, [target.run.id]))).map((row) => [
        row.resource_id,
        row.action,
      ]),
    ).toEqual(
      expect.arrayContaining([
        ["group:100", "group:content:read"],
        ["task-derived", "task:read"],
      ]),
    );
    await policy(false);
    await expect(service.get(caller, task.id, evidence)).rejects.toMatchObject({
      decision: { reason: "source_policy_denied" },
    });
    await expect(service.steps(caller, task.id, evidence)).rejects.toMatchObject({
      decision: { reason: "source_policy_denied" },
    });
    await expect(service.taskEvents(caller, task.id, 0, evidence)).rejects.toMatchObject({
      decision: { reason: "source_policy_denied" },
    });
    expect(await service.list(caller, evidence)).toEqual([]);
    expect(
      (await store.authorization.check({ caller, resourceId: "task-derived", action: "task:read" }))
        .decision,
    ).toBe("ALLOW");
  } finally {
    await store.close();
  }
});

it.each(["policy", "worker-grant"])(
  "withholds Worker output when %s changes during the bridge read",
  async (revocation) => {
    const { store, caller, origin, target, policy } = await fixture();
    let entered!: () => void;
    const waiting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: () => void;
    const output = new Promise<void>((resolve) => {
      release = resolve;
    });
    class PausedBridge extends FakeHerdrBridge {
      override async readAgent() {
        entered();
        await output;
        return { output: "protected derived Worker fixture", state: "working" as const };
      }
    }
    try {
      const source = await store.authorization.check({
        caller,
        resourceId: "group:100",
        action: "group:content:read",
        runId: origin.run.id,
        policyCondition: qqMemorySourceCondition(caller, "qq", "100", "essence"),
      });
      await store.authorization.markDeliverySource(source.id, "content_source");
      const task = await store.tasks.createTask({
        title: "derived",
        creatorPrincipalId: "owner",
        runId: origin.run.id,
        authorizationScope: caller.scope,
      });
      const attempt = await store.tasks.createAttempt({ taskId: task.id });
      const bridge = new PausedBridge();
      const worker = await bridge.startAgent({ workspaceId: "fixture", agentKind: "fake" });
      await store.tasks.bindWorker({
        taskAttemptId: attempt.id,
        herdrSession: "fixture",
        workspaceId: "fixture",
        paneId: worker.paneId,
        agentName: worker.agentName,
        agentKind: "fake",
      });
      const grantId = await store.authorization.grant({
        principalId: "owner",
        resourceId: `task-${task.id}`,
        action: "worker:read",
        scope: caller.scope,
        effect: "allow",
      });
      const result = new AuthorizedOpsService(store, bridge).readWorker(caller, task.id, {
        runId: target.run.id,
        conversationId: target.conversation.id,
      });
      await waiting;
      if (revocation === "policy") await policy(false);
      else await store.authorization.revoke(grantId);
      release();
      await expect(result).rejects.toMatchObject({
        decision: { reason: revocation === "policy" ? "source_policy_denied" : "no_grant" },
      });
    } finally {
      release?.();
      await store.close();
    }
  },
);

it.each(["workspace:write", "model:switch"])(
  "keeps a documented %s result readable through exact inherited receipts",
  async (action) => {
    const { sourcePolicyFixture } = await import("../learning/source-policy-test-fixture.js");
    const f = await sourcePolicyFixture();
    try {
      const workspace = action === "workspace:write";
      const resourceId = workspace ? "workspace:fixture" : "owner-control";
      await f.store.authorization.registerResource({
        id: resourceId,
        kind: workspace ? "workspace" : "owner-control",
        visibility: "private",
        ownerId: "owner",
      });
      const grantId = await f.store.authorization.grant({
        principalId: "owner",
        scope: f.scope,
        resourceId,
        action,
        effect: "allow",
      });
      const request = { ...f.context, resourceId, action };
      const source = await f.store.authorization.check(request);
      // An ordinary unmarked write authorization is never a completed content receipt.
      await expect(
        f.store.authorization.authorizeReadResults([
          { request, decisionId: source.id, source: "content_source" },
        ]),
      ).rejects.toMatchObject({ decision: { reason: "source_read_unverified" } });
      await f.store.authorization.markDeliverySource(source.id, "content_source");
      const task = await f.store.tasks.createTask({
        title: "Documented protected result",
        creatorPrincipalId: "owner",
        runId: f.accepted.run.id,
        authorizationScope: f.scope,
      });
      await f.store.authorization.grant({
        principalId: "owner",
        scope: f.scope,
        resourceId: `task-${task.id}`,
        action: "task:read",
        effect: "allow",
      });
      const service = new AuthorizedOpsService(f.store, new FakeHerdrBridge());
      expect(await service.get(f.caller, task.id)).toMatchObject({
        title: "Documented protected result",
      });
      await f.store.authorization.revoke(grantId);
      await expect(service.get(f.caller, task.id)).rejects.toMatchObject({
        decision: { reason: "no_grant" },
      });
    } finally {
      await f.store.close();
    }
  },
);

it("does not treat an arbitrary marked write as a documented content-result receipt", async () => {
  const { store, caller, origin } = await fixture();
  try {
    await store.authorization.grant({
      principalId: "owner",
      scope: caller.scope,
      resourceId: "group:100",
      action: "group:moderate",
      effect: "allow",
    });
    const request = {
      caller,
      runId: origin.run.id,
      conversationId: origin.conversation.id,
      resourceId: "group:100",
      action: "group:moderate",
    };
    const source = await store.authorization.check(request);
    await store.authorization.markDeliverySource(source.id, "content_source");
    await expect(
      store.authorization.authorizeReadResults([
        { request, decisionId: source.id, source: "content_source" },
      ]),
    ).rejects.toMatchObject({ decision: { reason: "source_read_unverified" } });
  } finally {
    await store.close();
  }
});
