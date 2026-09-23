import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vite-plus/test";
import { openDomainStore } from "../persistence/index.js";
import {
  DEFAULT_GROUP_CAPABILITY_POLICY,
  enabledCategoriesFor,
  isCategoryEnabled,
  isMemorySourceEnabled,
  isWebCapabilityEnabled,
  type GroupCapabilityPolicy,
} from "./capability-policy.js";

const tempDirs: string[] = [];
afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true }).catch((error: NodeJS.ErrnoException) => {
      // libSQL can retain Windows file handles until the test process exits.
      if (process.platform !== "win32" || error.code !== "EBUSY") throw error;
    });
  }
});

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "glassbox-capability-policy-"));
  tempDirs.push(dir);
  const databasePath = join(dir, "agent.db");
  const store = await openDomainStore({ databasePath });
  await store.conversations.createAgent("personal");
  await store.identities.bindOwner("owner", {
    connectionId: "qq",
    botId: "bot",
    senderId: "owner",
  });
  return { store, databasePath };
}

/** Builds a policy object naming something Glassbox does not implement, so the store's
 * own validation is what rejects it rather than the type system. */
function unvalidatedPolicy(
  categories: Record<string, boolean>,
  memorySources: Record<string, boolean>,
) {
  return { categories, memorySources } as unknown as GroupCapabilityPolicy;
}

it("defaults to deny for a group with no stored policy", async () => {
  const { store } = await fixture();
  try {
    expect(await store.capabilities.read("qq", "100")).toBeUndefined();
    expect(isCategoryEnabled(DEFAULT_GROUP_CAPABILITY_POLICY, "group.members")).toBe(false);
    expect(isCategoryEnabled(DEFAULT_GROUP_CAPABILITY_POLICY, "group.history")).toBe(false);
    expect(isMemorySourceEnabled(DEFAULT_GROUP_CAPABILITY_POLICY, "history")).toBe(false);
    expect(
      isWebCapabilityEnabled(DEFAULT_GROUP_CAPABILITY_POLICY.webCapabilities, "web.search"),
    ).toBe(false);
  } finally {
    await store.close();
  }
});

it("stores a versioned per-group policy and attributes the change", async () => {
  const { store } = await fixture();
  try {
    const first = await store.capabilities.write({
      connectionId: "qq",
      groupId: "100",
      principalId: "owner",
      policy: {
        categories: { "group.members": true, "group.history": false },
        memorySources: { history: true },
      },
    });
    expect(first.version).toBe(1);
    const stored = await store.capabilities.read("qq", "100");
    expect(stored?.version).toBe(1);
    expect(stored?.updatedByPrincipalId).toBe("owner");
    expect(isCategoryEnabled(stored!.policy, "group.members")).toBe(true);
    expect(isCategoryEnabled(stored!.policy, "group.history")).toBe(false);
    expect(isMemorySourceEnabled(stored!.policy, "history")).toBe(true);
    expect(isMemorySourceEnabled(stored!.policy, "album")).toBe(false);

    // A later change bumps the version so the next Run can tell the policy moved.
    const second = await store.capabilities.write({
      connectionId: "qq",
      groupId: "100",
      principalId: "owner",
      policy: { categories: { "group.members": false }, memorySources: {} },
    });
    expect(second.version).toBe(2);
  } finally {
    await store.close();
  }
});

it("rejects a policy that names an unknown category or source class", async () => {
  const { store } = await fixture();
  try {
    await expect(
      store.capabilities.write({
        connectionId: "qq",
        groupId: "100",
        principalId: "owner",
        policy: unvalidatedPolicy({ "group.sudo": true }, {}),
      }),
    ).rejects.toThrow("invalid_capability_category");
    await expect(
      store.capabilities.write({
        connectionId: "qq",
        groupId: "100",
        principalId: "owner",
        policy: unvalidatedPolicy({}, { everything: true }),
      }),
    ).rejects.toThrow("invalid_memory_source_class");
  } finally {
    await store.close();
  }
});

it("changes one category without clobbering the group's other policy fields", async () => {
  const { store } = await fixture();
  try {
    await store.capabilities.write({
      connectionId: "qq",
      groupId: "100",
      principalId: "owner",
      policy: { categories: { "group.history": true }, memorySources: { history: true } },
    });
    const bumped = await store.capabilities.setCategory({
      connectionId: "qq",
      groupId: "100",
      principalId: "owner",
      category: "group.members",
      enabled: true,
    });
    expect(bumped.version).toBe(2);
    const stored = await store.capabilities.read("qq", "100");
    expect(isCategoryEnabled(stored!.policy, "group.members")).toBe(true);
    expect(isCategoryEnabled(stored!.policy, "group.history")).toBe(true);
    expect(isMemorySourceEnabled(stored!.policy, "history")).toBe(true);

    // Turning one class off leaves the rest of the policy intact.
    await store.capabilities.setMemorySource({
      connectionId: "qq",
      groupId: "100",
      principalId: "owner",
      sourceClass: "history",
      enabled: false,
    });
    const after = await store.capabilities.read("qq", "100");
    expect(isMemorySourceEnabled(after!.policy, "history")).toBe(false);
    expect(isCategoryEnabled(after!.policy, "group.members")).toBe(true);
    expect(after!.version).toBe(3);
  } finally {
    await store.close();
  }
});

it("refuses a single-field mutation that names an unimplemented category or source class", async () => {
  const { store } = await fixture();
  try {
    await expect(
      store.capabilities.setCategory({
        connectionId: "qq",
        groupId: "100",
        principalId: "owner",
        category: "group.sudo" as never,
        enabled: true,
      }),
    ).rejects.toThrow("invalid_capability_category");
    await expect(
      store.capabilities.setMemorySource({
        connectionId: "qq",
        groupId: "100",
        principalId: "owner",
        sourceClass: "everything" as never,
        enabled: true,
      }),
    ).rejects.toThrow("invalid_memory_source_class");
    // A refused mutation leaves no row behind.
    expect(await store.capabilities.read("qq", "100")).toBeUndefined();
  } finally {
    await store.close();
  }
});

it("stores web capabilities independently and reads pre-web policy records as disabled", async () => {
  const { store } = await fixture();
  try {
    await store.capabilities.write({
      connectionId: "qq",
      groupId: "100",
      principalId: "owner",
      policy: { categories: { "group.members": true }, memorySources: { history: true } },
    });
    const initial = await store.capabilities.read("qq", "100");
    for (const capability of [
      "web.search",
      "web.fetch",
      "browser.read",
      "browser.interact",
    ] as const)
      expect(isWebCapabilityEnabled(initial?.policy.webCapabilities, capability)).toBe(false);

    await store.capabilities.setWebCapability({
      connectionId: "qq",
      groupId: "100",
      principalId: "owner",
      capability: "web.search",
      enabled: true,
    });
    const updated = await store.capabilities.read("qq", "100");
    expect(updated?.version).toBe(2);
    expect(isWebCapabilityEnabled(updated?.policy.webCapabilities, "web.search")).toBe(true);
    expect(isCategoryEnabled(updated!.policy, "group.members")).toBe(true);
    expect(isMemorySourceEnabled(updated!.policy, "history")).toBe(true);

    await expect(
      store.capabilities.setWebCapability({
        connectionId: "qq",
        groupId: "100",
        principalId: "owner",
        capability: "web.shell" as never,
        enabled: true,
      }),
    ).rejects.toThrow("invalid_web_capability");
  } finally {
    await store.close();
  }
});

it("bootstraps a Run's capability bundle from the durable policy and reflects a later change", async () => {
  const { store } = await fixture();
  try {
    // Nothing enabled: the bundle is empty, so no group capability Tool is offered.
    expect(enabledCategoriesFor(await store.capabilities.list("qq"))).toEqual([]);

    await store.capabilities.setCategory({
      connectionId: "qq",
      groupId: "100",
      principalId: "owner",
      category: "group.members",
      enabled: true,
    });
    await store.capabilities.setCategory({
      connectionId: "qq",
      groupId: "200",
      principalId: "owner",
      category: "group.moderate",
      enabled: true,
    });
    expect(enabledCategoriesFor(await store.capabilities.list("qq")).sort()).toEqual([
      "group.members",
      "group.moderate",
    ]);

    // The next Run bootstraps from a fresh read, so an Owner change is visible immediately.
    await store.capabilities.setCategory({
      connectionId: "qq",
      groupId: "200",
      principalId: "owner",
      category: "group.moderate",
      enabled: false,
    });
    expect(enabledCategoriesFor(await store.capabilities.list("qq"))).toEqual(["group.members"]);
  } finally {
    await store.close();
  }
});

it("survives a database reopen and lists every managed group for a connection", async () => {
  const { store, databasePath } = await fixture();
  await store.capabilities.write({
    connectionId: "qq",
    groupId: "100",
    principalId: "owner",
    policy: { categories: { "group.history": true }, memorySources: {} },
  });
  await store.capabilities.write({
    connectionId: "qq",
    groupId: "200",
    principalId: "owner",
    policy: { categories: { "group.moderate": true }, memorySources: {} },
  });
  await store.close();

  const reopened = await openDomainStore({ databasePath });
  try {
    const policy = await reopened.capabilities.read("qq", "100");
    expect(isCategoryEnabled(policy!.policy, "group.history")).toBe(true);
    expect(policy!.version).toBe(1);
    const inventory = await reopened.capabilities.list("qq");
    expect(inventory.map((entry) => entry.groupId).sort()).toEqual(["100", "200"]);
  } finally {
    await reopened.close();
  }
});
