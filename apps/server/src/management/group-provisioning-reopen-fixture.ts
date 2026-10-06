import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { openDomainStore, type DomainStore } from "../application/domain-store.js";
import type { TrustedChannelScope } from "../identity/scope.js";
import { WEBSITE_KNOWLEDGE_RESOURCE } from "../knowledge/index.js";
import { learningProgressResourceId } from "../learning-progress/identity.js";
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
  const progressResourceId = learningProgressResourceId({ principalId: kind!, scope });
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
  const personalRows = (store: DomainStore) =>
    store.db.transaction(async (tx) => ({
      grants: (
        await tx.execute({
          sql: `SELECT resource_id, action FROM grants
                WHERE resource_id IN (?, ?) ORDER BY resource_id, action`,
          args: [WEBSITE_KNOWLEDGE_RESOURCE, progressResourceId],
        })
      ).rows.map((row) => ({ resource_id: row.resource_id, action: row.action })),
      decisions: (
        await tx.execute({
          sql: `SELECT resource_id, action, decision FROM authorization_decisions
                WHERE resource_id IN (?, ?) ORDER BY rowid`,
          args: [WEBSITE_KNOWLEDGE_RESOURCE, progressResourceId],
        })
      ).rows.map((row) => ({
        resource_id: row.resource_id,
        action: row.action,
        decision: row.decision,
      })),
    }));
  const expectedPersonalEntries = [
    { resource_id: WEBSITE_KNOWLEDGE_RESOURCE, action: "knowledge:read" },
    { resource_id: WEBSITE_KNOWLEDGE_RESOURCE, action: "delivery:send" },
    { resource_id: progressResourceId, action: "progress:read" },
    { resource_id: progressResourceId, action: "progress:write" },
    { resource_id: progressResourceId, action: "progress:manage" },
    { resource_id: progressResourceId, action: "delivery:send" },
  ];
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
    await provision(store, kind === "owner" ? 39 : 37);
    const first = await groupRows(store);
    const firstPersonal = await personalRows(store);
    assert.deepEqual(
      first.decisions,
      [...actions, "delivery:send"].map((action) => ({ action, decision: "DENY" })),
    );
    assert.equal(first.grants.length, actions.length + 1);
    assert.deepEqual(
      firstPersonal.grants,
      [...expectedPersonalEntries].sort((a, b) =>
        `${a.resource_id}:${a.action}`.localeCompare(`${b.resource_id}:${b.action}`),
      ),
    );
    assert.deepEqual(
      firstPersonal.decisions,
      expectedPersonalEntries.map((entry) => ({ ...entry, decision: "DENY" })),
    );
    assert.equal(
      firstPersonal.decisions.some((decision) => decision.action === "knowledge:sync"),
      false,
    );
    await store.close();
    store = await openDomainStore({ databasePath });
    await provision(store, kind === "owner" ? 32 : 31);
    const second = await groupRows(store);
    const secondPersonal = await personalRows(store);
    assert.deepEqual(second.grants, first.grants);
    assert.deepEqual(
      second.decisions.slice(first.decisions.length),
      [...actions, "delivery:send"].map((action) => ({ action, decision: "ALLOW" })),
    );
    assert.deepEqual(secondPersonal.grants, firstPersonal.grants);
    assert.deepEqual(
      secondPersonal.decisions.slice(firstPersonal.decisions.length),
      expectedPersonalEntries.map((entry) => ({ ...entry, decision: "ALLOW" })),
    );
  } finally {
    await store.close();
  }
  console.log(JSON.stringify({ completed: "group-provisioning-reopen", kind }));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await runFixture();
