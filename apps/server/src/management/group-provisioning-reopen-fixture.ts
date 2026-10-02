import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { openDomainStore, type DomainStore } from "../application/domain-store.js";
import type { TrustedChannelScope } from "../identity/scope.js";
import { ManagementApplication } from "./application.js";

export const groupProvisioningReopenFixtureScript = new URL(import.meta.url);

async function runFixture() {
  const [databasePath, kind] = process.argv.slice(2);
  assert.ok(databasePath);
  assert.ok(kind === "owner" || kind === "visitor");
  const scope: TrustedChannelScope = {
    connectionId: "fixture",
    botId: "bot",
    chatType: "group",
    chatId: "group",
    senderId: "member",
  };
  const application = (store: DomainStore) =>
    Object.assign(Object.create(ManagementApplication.prototype), { store }) as {
      grantScope(
        scope: TrustedChannelScope,
        principalId: string,
        initialOnly?: boolean,
      ): Promise<void>;
      groupRunActions(): string[];
    };
  const groupRows = (store: DomainStore) =>
    store.db.transaction(async (tx) => ({
      grants: (
        await tx.execute(
          "SELECT id, action, revoked_at FROM grants WHERE resource_id = 'group:group' ORDER BY id",
        )
      ).rows.map((row) => ({ id: row.id, action: row.action, revoked_at: row.revoked_at })),
      decisions: (
        await tx.execute(
          "SELECT action, decision FROM authorization_decisions WHERE resource_id = 'group:group' ORDER BY rowid",
        )
      ).rows.map((row) => ({ action: row.action, decision: row.decision })),
    }));
  async function provision(store: DomainStore, expectedCount: number) {
    const transaction = store.db.transaction.bind(store.db);
    let count = 0;
    store.db.transaction = (operation) => {
      count++;
      return transaction(operation);
    };
    try {
      await application(store).grantScope(scope, kind!);
      assert.equal(count, expectedCount);
    } finally {
      store.db.transaction = transaction;
    }
  }
  let store = await openDomainStore({ databasePath });
  try {
    await store.conversations.createAgent("personal");
    if (kind === "owner") await store.identities.bindOwner(kind, scope);
    else {
      await store.identities.createPrincipal(kind, kind);
      await store.identities.bindPrincipal(kind, scope);
    }
    const actions = application(store).groupRunActions();
    assert.equal(actions.length, 9);
    await provision(store, kind === "owner" ? 38 : 36);
    const first = await groupRows(store);
    assert.deepEqual(
      first.decisions,
      [...actions, "delivery:send"].map((action) => ({ action, decision: "DENY" })),
    );
    assert.equal(first.grants.length, actions.length + 1);
    await store.close();
    store = await openDomainStore({ databasePath });
    await provision(store, kind === "owner" ? 31 : 30);
    const second = await groupRows(store);
    assert.deepEqual(second.grants, first.grants);
    assert.deepEqual(
      second.decisions.slice(first.decisions.length),
      [...actions, "delivery:send"].map((action) => ({ action, decision: "ALLOW" })),
    );
  } finally {
    await store.close();
  }
  console.log(JSON.stringify({ completed: "group-provisioning-reopen", kind }));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await runFixture();
