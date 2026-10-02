import { afterEach, expect, it, vi } from "vite-plus/test";
import { openDomainStore, type DomainStore } from "../application/domain-store.js";
const stores: DomainStore[] = [];
const scope = {
  connectionId: "fixture",
  botId: "bot",
  chatType: "group" as const,
  chatId: "group",
  senderId: "owner",
};
const caller = { principalId: "owner", scope };
const entry = (id: string) => ({
  resource: { id, kind: "tool-definition", visibility: "public" as const, ifAbsent: true },
  action: "tool:discover",
});
async function fixture() {
  const store = await openDomainStore({ databasePath: ":memory:" });
  stores.push(store);
  await store.identities.bindOwner("owner", scope);
  return store;
}
afterEach(async () => {
  vi.restoreAllMocks();
  for (const store of stores.splice(0)) await store.close();
});

it("commits an ordered batch once, preserves decision order and reuses existing grants", async () => {
  const store = await fixture();
  const input = {
    caller,
    initialOnly: true,
    entries: [entry("tool:a"), entry("tool:b"), entry("tool:a")],
  };
  const transaction = vi.spyOn(store.db, "transaction");
  await store.authorization.provisionResources(input);
  expect(transaction).toHaveBeenCalledTimes(1);
  transaction.mockRestore();
  const read = () =>
    store.db.transaction(async (tx) => ({
      grants: (await tx.execute("SELECT id FROM grants ORDER BY id")).rows,
      decisions: (
        await tx.execute(
          "SELECT resource_id, decision, reason FROM authorization_decisions ORDER BY rowid",
        )
      ).rows,
    }));
  const first = await read();
  expect(first.grants).toHaveLength(2);
  expect(first.decisions).toEqual([
    { resource_id: "tool:a", decision: "DENY", reason: "no_grant" },
    { resource_id: "tool:b", decision: "DENY", reason: "no_grant" },
    { resource_id: "tool:a", decision: "ALLOW", reason: "explicit_grant" },
  ]);
  await store.authorization.provisionResources(input);
  const second = await read();
  expect(second.grants).toEqual(first.grants);
  expect(second.decisions.slice(3).every((row) => row.decision === "ALLOW")).toBe(true);
});

it.each(["revoked", "approval"])(
  "retains %s policy during initial batches and permits explicit restoration",
  async (policy) => {
    const store = await fixture();
    await store.authorization.registerResource(entry("tool:a").resource);
    const grant = {
      principalId: caller.principalId,
      scope,
      resourceId: "tool:a",
      action: "tool:discover",
      effect: "allow" as const,
    };
    const id = await store.authorization.grant(grant);
    await store.authorization.revoke(id);
    if (policy === "approval") await store.authorization.grant({ ...grant, effect: "approval" });
    const input = { caller, initialOnly: true, entries: [entry("tool:a")] };
    await store.authorization.provisionResources(input);
    const check = () =>
      store.authorization.check({ caller, resourceId: "tool:a", action: "tool:discover" });
    expect((await check()).decision).toBe(policy === "revoked" ? "DENY" : "REQUIRES_APPROVAL");
    await store.authorization.provisionResources({ ...input, initialOnly: false });
    expect((await check()).decision).toBe("ALLOW");
    const original = await store.db.transaction(
      async (tx) =>
        (await tx.execute({ sql: "SELECT revoked_at FROM grants WHERE id = ?", args: [id] }))
          .rows[0],
    );
    expect(original?.revoked_at).toEqual(expect.any(String));
  },
);

it("rolls back earlier metadata, decisions and grants when a later resource conflicts", async () => {
  const store = await fixture();
  await store.authorization.registerResource({ ...entry("tool:b").resource, kind: "existing" });
  await expect(
    store.authorization.provisionResources({
      caller,
      initialOnly: true,
      entries: [entry("tool:a"), entry("tool:b")],
    }),
  ).rejects.toThrow("Resource metadata conflict");
  const rows = await store.db.transaction(async (tx) => ({
    resources: (await tx.execute("SELECT id, kind FROM resources ORDER BY id")).rows,
    grants: (await tx.execute("SELECT id FROM grants")).rows,
    decisions: (await tx.execute("SELECT id FROM authorization_decisions")).rows,
  }));
  expect(rows).toEqual({
    resources: [{ id: "tool:b", kind: "existing" }],
    grants: [],
    decisions: [],
  });
});

it("rejects oversized batches before beginning a transaction", async () => {
  const store = await fixture();
  const transaction = vi.spyOn(store.db, "transaction");
  await expect(
    store.authorization.provisionResources({
      caller,
      initialOnly: true,
      entries: Array.from({ length: 129 }, (_, i) => entry(`tool:${i}`)),
    }),
  ).rejects.toThrow("Invalid provisioning batch size");
  expect(transaction).not.toHaveBeenCalled();
});
