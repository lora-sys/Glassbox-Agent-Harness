import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vite-plus/test";
import { openDomainStore, type DomainStore } from "../application/domain-store.js";
import type { TrustedChannelScope } from "../identity/scope.js";
import { ManagementApplication } from "./application.js";
import { runFixtureProcess } from "../persistence/test-fixture-process.js";
import { groupProvisioningReopenFixtureScript } from "./group-provisioning-reopen-fixture.js";
import { stringColumn } from "../persistence/database.js";

const scope: TrustedChannelScope = {
  connectionId: "fixture",
  botId: "bot",
  chatType: "group",
  chatId: "group",
  senderId: "member",
};
const resourceId = "group:group";
function application(store: DomainStore) {
  return Object.assign(Object.create(ManagementApplication.prototype), { store }) as {
    grantScope(
      scope: TrustedChannelScope,
      principalId: string,
      initialOnly?: boolean,
    ): Promise<void>;
    groupRunActions(): string[];
  };
}
async function prepare(store: DomainStore, kind: "owner" | "visitor") {
  await store.conversations.createAgent("personal");
  if (kind === "owner") await store.identities.bindOwner(kind, scope);
  else {
    await store.identities.createPrincipal(kind, kind);
    await store.identities.bindPrincipal(kind, scope);
  }
}
const groupRows = (store: DomainStore) =>
  store.db.transaction(async (tx) => ({
    grants: (
      await tx.execute({
        sql: "SELECT id, action, revoked_at FROM grants WHERE resource_id = ? ORDER BY id",
        args: [resourceId],
      })
    ).rows,
    decisions: (
      await tx.execute({
        sql: "SELECT action,decision FROM authorization_decisions WHERE resource_id = ? ORDER BY rowid",
        args: [resourceId],
      })
    ).rows,
  }));

it.for(["owner", "visitor"] as const)(
  "batches fresh and restarted %s group authority without losing decision order",
  async (kind, { signal }) => {
    const directory = await mkdtemp(join(tmpdir(), "glassbox-group-provisioning-"));
    try {
      await runFixtureProcess(
        groupProvisioningReopenFixtureScript,
        [join(directory, "state.db"), kind],
        signal,
      );
    } finally {
      // Child close is the native-handle release boundary, including failed assertions.
      await rm(directory, { recursive: true, force: true });
    }
  },
);

it.each(["owner", "visitor"] as const)(
  "keeps revoked and approval-only %s policy until explicit restoration",
  async (kind) => {
    const store = await openDomainStore({ databasePath: ":memory:" });
    try {
      await prepare(store, kind);
      const app = application(store);
      await app.grantScope(scope, kind);
      const before = await groupRows(store);
      const revoked = before.grants.find((row) => row.action === "group:read")!;
      const approval = before.grants.find((row) => row.action === "group:moderate")!;
      await store.authorization.revoke(stringColumn(revoked, "id"));
      await store.authorization.revoke(stringColumn(approval, "id"));
      await store.authorization.grant({
        principalId: kind,
        scope,
        resourceId,
        action: "group:moderate",
        effect: "approval",
      });
      const check = (action: string) =>
        store.authorization.check({ caller: { principalId: kind, scope }, resourceId, action });
      await app.grantScope(scope, kind);
      expect((await check("group:read")).decision).toBe("DENY");
      expect((await check("group:moderate")).decision).toBe("REQUIRES_APPROVAL");
      expect((await groupRows(store)).grants).toHaveLength(before.grants.length + 1);
      await app.grantScope(scope, kind, false);
      expect((await check("group:read")).decision).toBe("ALLOW");
      expect((await check("group:moderate")).decision).toBe("ALLOW");
      const restored = await groupRows(store);
      expect(restored.grants.find((row) => row.id === revoked.id)?.revoked_at).toEqual(
        expect.any(String),
      );
      expect(restored.grants.find((row) => row.id === approval.id)?.revoked_at).toEqual(
        expect.any(String),
      );
    } finally {
      await store.close();
    }
  },
);

it("rolls back the group batch if a later decision cannot be recorded", async () => {
  const store = await openDomainStore({ databasePath: ":memory:" });
  try {
    await prepare(store, "visitor");
    await store.db.transaction((tx) =>
      tx.execute(
        "CREATE TRIGGER fail_group_decision BEFORE INSERT ON authorization_decisions WHEN NEW.resource_id = 'group:group' AND NEW.action = 'group:files:read' BEGIN SELECT RAISE(ABORT, 'fixture_decision_failure'); END",
      ),
    );
    await expect(application(store).grantScope(scope, "visitor")).rejects.toThrow(
      "fixture_decision_failure",
    );
    expect(await groupRows(store)).toEqual({ grants: [], decisions: [] });
    expect(
      (
        await store.db.transaction((tx) =>
          tx.execute({ sql: "SELECT id FROM resources WHERE id = ?", args: [resourceId] }),
        )
      ).rows,
    ).toEqual([]);
  } finally {
    await store.close();
  }
});

it.each([
  { kind: "other-kind", visibility: "public" as const },
  { kind: "qq_group", visibility: "private" as const },
  { kind: "qq_group", visibility: "public" as const, ownerId: "visitor" },
])("preserves conflicting group resource metadata %#", async (metadata) => {
  const store = await openDomainStore({ databasePath: ":memory:" });
  try {
    await prepare(store, "visitor");
    await store.authorization.registerResource({ id: resourceId, ...metadata });
    await expect(application(store).grantScope(scope, "visitor")).rejects.toThrow(
      "Resource metadata conflict",
    );
    expect(await groupRows(store)).toEqual({ grants: [], decisions: [] });
    const rows = await store.db.transaction((tx) =>
      tx.execute({
        sql: "SELECT kind,visibility,owner_id FROM resources WHERE id = ?",
        args: [resourceId],
      }),
    );
    expect(rows.rows).toEqual([
      { kind: metadata.kind, visibility: metadata.visibility, owner_id: metadata.ownerId ?? null },
    ]);
  } finally {
    await store.close();
  }
});
