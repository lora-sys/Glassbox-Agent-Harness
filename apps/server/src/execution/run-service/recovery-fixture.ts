/** Disposable subprocess fixture. It is never imported by the server runtime. */
import { strict as assert } from "node:assert";
import {
  agentResourceId,
  openDomainStore,
  type TrustedChannelScope,
} from "../../persistence/index.js";
import { RunService } from "./index.js";

const [stage, databasePath, runId, deliveryId] = process.argv.slice(2);
if ((stage !== "write" && stage !== "reopen") || !databasePath)
  throw new Error("Invalid recovery fixture arguments");
const group: TrustedChannelScope = {
  connectionId: "test-connection",
  botId: "test-bot",
  chatType: "group",
  chatId: "test-group",
  senderId: "test-owner",
};
const caller = { principalId: "owner", scope: group };
const store = await openDomainStore({ databasePath });
let sends = 0;
let executions = 0;
const service = new RunService({
  store,
  resolveExecution: () => ({
    supportsGroup: true,
    execute: async () => {
      executions++;
      return { status: "succeeded", text: "result" };
    },
  }),
  transport: {
    send: async ({ delivery }) => {
      sends++;
      return delivery.payloadKind === "ack" ? { status: "sent" } : { status: "unknown" };
    },
  },
});

try {
  if (stage === "write") {
    await store.conversations.createAgent("personal");
    await store.identities.bindOwner("owner", group);
    for (const action of ["run:create", "run:control", "conversation:read"]) {
      await store.authorization.grant({
        principalId: "owner",
        resourceId: agentResourceId("personal"),
        action,
        scope: group,
        effect: "allow",
      });
    }
    await service.start();
    const accepted = await service.receive({
      agentId: "personal",
      scope: group,
      messageId: "unknown-send",
      text: "fixture",
      executionRef: "fake",
    });
    await service.drain();
    const delivery = (await store.lifecycle.listDeliveries(caller, accepted.run.id)).items.find(
      (item) => item.payloadKind === "result",
    );
    assert.ok(delivery);
    assert.equal(delivery.status, "unknown");
    await assert.rejects(() => service.retryDelivery(caller, accepted.run.id, delivery.id));
    assert.equal(sends, 2);
    assert.equal(executions, 1);
    process.stdout.write(JSON.stringify({ runId: accepted.run.id, deliveryId: delivery.id }));
  } else {
    assert.ok(runId && deliveryId);
    await service.start({ recover: true });
    await service.drain();
    assert.equal(sends, 0);
    assert.equal(executions, 0);
    assert.equal(
      (await store.lifecycle.listDeliveries(caller, runId)).items.find(
        (item) => item.id === deliveryId,
      )?.status,
      "unknown",
    );
  }
} finally {
  await service.stop({ wait: true });
  await store.close();
}
