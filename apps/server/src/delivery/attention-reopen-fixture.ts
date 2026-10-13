import assert from "node:assert/strict";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { openDomainStore, agentResourceId } from "../persistence/index.js";
import { RunService } from "../execution/run-service/index.js";

/** Inert static import keeps subprocess coverage in the test dependency graph. */
export const deliveryAttentionFixtureScript = new URL(import.meta.url);
async function runFixture() {
  const [directory, stage, runId] = process.argv.slice(2);
  assert.ok(directory && ["write", "read", "ack", "read-ack"].includes(stage!));
  const store = await openDomainStore({ databasePath: join(directory, "attention.db") });
  const scope = {
    connectionId: "fixture",
    botId: "bot",
    chatType: "private" as const,
    chatId: "owner",
    senderId: "owner",
  };
  const caller = { principalId: "owner", scope };
  let sends = 0;
  let executions = 0;
  const service = new RunService({
    store,
    resolveExecution: () => ({
      supportsGroup: true,
      execute: async () => {
        executions++;
        return { status: "succeeded", text: "private-output-canary" };
      },
    }),
    transport: {
      send: async () => {
        sends++;
        return { status: "unknown", reason: "timeout" };
      },
    },
  });
  try {
    if (stage === "write") {
      await store.conversations.createAgent("personal");
      await store.identities.bindOwner("owner", scope);
      for (const action of ["run:create", "run:control", "conversation:read", "delivery:send"])
        await store.authorization.grant({
          principalId: "owner",
          resourceId: agentResourceId("personal"),
          action,
          scope,
          effect: "allow",
        });
      await service.start();
      const accepted = await service.receive({
        agentId: "personal",
        scope,
        messageId: "original",
        text: "request",
        executionRef: "fixture",
      });
      await service.drain();
      assert.equal(sends, 1);
      assert.equal(executions, 1);
      const attention = await store.tasks.listAttentionItems();
      assert.equal(attention.length, 1);
      assert.ok(attention[0]!.summary.includes("timeout"));
      assert.ok(!JSON.stringify(attention).includes("private-output-canary"));
      console.log(JSON.stringify({ runId: accepted.run.id }));
    } else {
      assert.ok(runId);
      await service.start({ recover: true });
      await service.drain();
      assert.equal(sends, 0);
      assert.equal(executions, 0);
      assert.equal((await service.getRun(caller, runId)).status, "succeeded");
      const delivery = (await store.lifecycle.listDeliveries(caller, runId)).items[0]!;
      assert.equal(delivery.status, "unknown");
      await assert.rejects(service.retryDelivery(caller, runId, delivery.id));
      const all = await store.tasks.listAttentionItems(false);
      assert.equal(all.length, 1);
      assert.ok(all[0]!.summary.includes("timeout"));
      assert.equal((await store.tasks.listAttentionItems()).length, stage === "read-ack" ? 0 : 1);
      if (stage === "ack") await store.tasks.resolveAttentionItem(all[0]!.id);
      console.log(JSON.stringify({ passed: true }));
    }
  } finally {
    await service.stop({ wait: true });
    await store.close();
  }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) await runFixture();
