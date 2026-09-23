import { afterEach, describe, expect, it } from "vite-plus/test";
import { createApplicationFixtureScope } from "./application-test-helpers.js";
import { QQ_CAPABILITY_CATEGORIES } from "../channels/onebot/capabilities.js";
import { DEFAULT_OWNER_GROUP_CATEGORIES, DEFAULT_OWNER_GROUP_POLICY } from "./application.js";
import {
  admin,
  MUTATION_CATEGORIES,
  groupActions,
  type OwnerContext,
  type CapabilitySearchResult,
} from "./application-test-helpers.js";

const { fixture, afterEachCleanup } = createApplicationFixtureScope();
afterEach(afterEachCleanup);

describe("per-Owner managed group assignment", () => {
  const CO_OWNER = "10006";
  const GROUP = "10005";
  const OTHER_GROUP = "10007";

  /** Opens a fixture with a second Owner and returns one Owner-private context per Owner. */
  async function owners(options: { persistentDatabase?: boolean; groupName?: string } = {}) {
    const f = await fixture(
      async (input) => ({ status: "succeeded", text: `answer:${input.text}` }),
      {
        coOwnerId: CO_OWNER,
        ...(options.persistentDatabase === undefined
          ? {}
          : { persistentDatabase: options.persistentDatabase }),
        ...(options.groupName === undefined ? {} : { groupName: options.groupName }),
      },
    );
    f.send(1, "owner-a", true, 10002);
    const ownerA = await f.started.take();
    await f.reply("answer:owner-a");
    f.send(2, "owner-b", true, Number(CO_OWNER));
    const ownerB = await f.started.take();
    await f.reply("answer:owner-b");
    return {
      f,
      application: admin(f.app),
      a: { caller: ownerA.caller, conversationId: ownerA.conversation.id, runId: ownerA.run.id },
      b: { caller: ownerB.caller, conversationId: ownerB.conversation.id, runId: ownerB.run.id },
    };
  }

  it("wires candidate extraction into the real Owner-private runtime Tool surface", async () => {
    const { f, application, a } = await owners();
    expect(await application.resolveRunToolNames(a)).toContain("owner_memory_admin");
    const tool = application
      .createRuntimeTools(() => a)
      .find((entry) => entry.name === "owner_memory_admin");
    if (!tool) throw new Error("missing owner_memory_admin");
    const result = await tool.execute("extract", {
      action: "extract",
      type: "episodic_event",
      scopeType: "project",
      projectId: "glassbox",
      statement: "An Owner-private test run occurred.",
    });
    expect(result.details).toMatchObject([{ status: "pending" }]);
    expect(await f.app.store.learning.listMemories({ caller: a.caller })).toEqual([]);
  });

  const groupIds = async (
    application: ReturnType<typeof admin>,
    context: OwnerContext,
  ): Promise<string[]> =>
    (await application.projectManagedGroups(context)).groups.map((group) => group.groupId);

  it("assigns a managed group independently for each Owner", async () => {
    const { application, a, b } = await owners();
    expect(a.caller.principalId).toBe("owner");
    expect(b.caller.principalId).toBe(`owner-${CO_OWNER}`);

    await application.setGroupAccess(a, { groupId: GROUP, enabled: true });

    // Owner A's assignment is Owner A's alone: Owner B manages nothing yet.
    expect(await groupIds(application, a)).toEqual([GROUP]);
    expect(await groupIds(application, b)).toEqual([]);

    // Owner B may independently enable the very same group.
    await application.setGroupAccess(b, { groupId: GROUP, enabled: true });
    expect(await groupIds(application, a)).toEqual([GROUP]);
    expect(await groupIds(application, b)).toEqual([GROUP]);
  });

  it("does not expose a group's stored settings after this Owner is unassigned", async () => {
    const { application, a, b } = await owners();
    await application.setGroupAccess(a, { groupId: GROUP, enabled: true });
    await application.setGroupHistory(a, { groupId: GROUP, enabled: true });
    await expect(application.manageGroup(b, { action: "get", groupId: GROUP })).rejects.toThrow(
      "group_not_enabled",
    );
    await application.setGroupAccess(a, { groupId: GROUP, enabled: false });
    await expect(application.manageGroup(a, { action: "get", groupId: GROUP })).rejects.toThrow(
      "group_not_enabled",
    );
  });

  it("keeps a sibling Owner's assignment and the transport group when one Owner revokes", async () => {
    const { f, application, a, b } = await owners();
    await application.setGroupAccess(a, { groupId: GROUP, enabled: true });
    await application.setGroupAccess(b, { groupId: GROUP, enabled: true });

    const history = (context: OwnerContext) =>
      f.app.store.authorization.check({
        caller: context.caller,
        resourceId: `group:${GROUP}`,
        action: "history:read",
      });

    await application.setGroupAccess(a, { groupId: GROUP, enabled: false });

    // Owner A is unassigned; Owner B keeps their own assignment and its authority.
    expect(await groupIds(application, a)).toEqual([]);
    expect(await groupIds(application, b)).toEqual([GROUP]);
    expect((await history(b)).decision).toBe("ALLOW");
    // The connection-wide transport group stays enabled while an Owner remains assigned.
    expect(f.app.listChannels()[0]?.groupIds).toContain(GROUP);

    // The last assigned Owner's revocation tears the shared group down.
    await application.setGroupAccess(b, { groupId: GROUP, enabled: false });
    expect(f.app.listChannels()[0]?.groupIds).not.toContain(GROUP);
    expect((await history(b)).decision).toBe("DENY");
    expect((await history(a)).decision).toBe("DENY");
  });

  it("does not revoke another connection's grant for the same group number", async () => {
    const { f, application, a } = await owners();
    await application.setGroupAccess(a, { groupId: GROUP, enabled: true });
    const otherScope = { ...a.caller.scope, connectionId: "another-qq-connection" };
    await f.app.store.authorization.grant({
      principalId: a.caller.principalId,
      resourceId: `group:${GROUP}`,
      action: "group:read",
      scope: otherScope,
      effect: "allow",
    });

    await application.setGroupAccess(a, { groupId: GROUP, enabled: false });

    expect(
      await f.app.store.authorization.hasActiveGrant({
        principalId: a.caller.principalId,
        resourceId: `group:${GROUP}`,
        action: "group:read",
        scope: otherScope,
      }),
    ).toBe(true);
  });

  it("persists each Owner's assignment and the fixed policy across a restart", async () => {
    const { f, application, a, b } = await owners({ persistentDatabase: true });
    await application.setGroupAccess(a, { groupId: GROUP, enabled: true });
    await application.setGroupAccess(b, { groupId: OTHER_GROUP, enabled: true });

    const restartedApp = await f.reopen();
    const restarted = admin(restartedApp);

    expect(await groupIds(restarted, a)).toEqual([GROUP]);
    expect(await groupIds(restarted, b)).toEqual([OTHER_GROUP]);
    expect((await restarted.projectManagedGroups(a)).groups[0]?.categories).toEqual(
      DEFAULT_OWNER_GROUP_POLICY.categories,
    );
    expect(restartedApp.listChannels()[0]?.groupIds).toEqual(
      expect.arrayContaining([GROUP, OTHER_GROUP]),
    );
  });

  it("persists the fixed default bundle and never enables a mutation category", async () => {
    const { f, application, a, b } = await owners();
    await application.setGroupAccess(a, { groupId: GROUP, enabled: true });

    const stored = await f.app.store.capabilities.read("fixture", GROUP);
    expect(stored?.policy).toEqual(DEFAULT_OWNER_GROUP_POLICY);
    expect(stored?.version).toBe(1);
    for (const category of DEFAULT_OWNER_GROUP_CATEGORIES)
      expect(stored?.policy.categories[category]).toBe(true);
    for (const category of MUTATION_CATEGORIES)
      expect(stored?.policy.categories[category]).toBeUndefined();

    // Owner A holds exactly the bundle's group Actions on the group Resource.
    const decision = (context: OwnerContext, action: string) =>
      f.app.store.authorization.check({
        caller: context.caller,
        resourceId: `group:${GROUP}`,
        action,
      });
    for (const action of groupActions(DEFAULT_OWNER_GROUP_CATEGORIES))
      expect((await decision(a, action)).decision).toBe("ALLOW");
    // `group.history` carries `history:read`, which is what the cross-group search needs.
    expect((await decision(a, "history:read")).decision).toBe("ALLOW");
    // No mutation Action is granted, so a moderation attempt cannot pass authorization.
    for (const action of groupActions(MUTATION_CATEGORIES))
      expect((await decision(a, action)).decision).toBe("DENY");

    // A second Owner joining the same group grants themselves independently and never
    // rewrites the policy the first Owner persisted.
    await application.setGroupAccess(b, { groupId: GROUP, enabled: true });
    const afterJoin = await f.app.store.capabilities.read("fixture", GROUP);
    expect(afterJoin?.policy).toEqual(DEFAULT_OWNER_GROUP_POLICY);
    expect(afterJoin?.version).toBe(1);
    expect(afterJoin?.updatedByPrincipalId).toBe("owner");
    for (const action of groupActions(DEFAULT_OWNER_GROUP_CATEGORIES))
      expect((await decision(b, action)).decision).toBe("ALLOW");
    for (const action of groupActions(MUTATION_CATEGORIES))
      expect((await decision(b, action)).decision).toBe("DENY");
  });

  /**
   * The managed-group inventory and the registry search are the two Owner-private read
   * surfaces over the same durable per-Owner assignment, so they are exercised together.
   */
  const searchTool = (application: ReturnType<typeof admin>, context: OwnerContext) => {
    const tool = application
      .createRuntimeTools(() => context)
      .find((candidate) => candidate.name === "qq_capability_search");
    if (!tool) throw new Error("missing qq_capability_search");
    return tool;
  };
  const capabilitySearch = async (
    application: ReturnType<typeof admin>,
    context: OwnerContext,
    params: Record<string, unknown> = {},
  ): Promise<CapabilitySearchResult> =>
    (await searchTool(application, context).execute("call", params))
      .details as CapabilitySearchResult;

  /** The group-scoped registry Tools the fixed default bundle makes usable in a group. */
  const DEFAULT_GROUP_TOOLS = [
    "qq_groups",
    "qq_group_members",
    "qq_group_history",
    "qq_group_content",
    "qq_group_files",
  ];

  it("projects each Owner's own managed inventory with every required field", async () => {
    const { application, a, b } = await owners({ groupName: "Fixture Group" });
    await application.setGroupAccess(a, { groupId: GROUP, enabled: true });
    await application.setGroupAccess(b, { groupId: OTHER_GROUP, enabled: true });
    // The same group managed by both Owners is shared, and each Owner sees it independently.
    await application.setGroupAccess(b, { groupId: GROUP, enabled: true });

    const inventory = await application.projectManagedGroups(a);
    expect(inventory.connectionId).toBe("fixture");
    // Owner A sees exactly the group they manage, never Owner B's other group.
    expect(inventory.groups.map((group) => group.groupId)).toEqual([GROUP]);
    expect(await groupIds(application, b)).toEqual([GROUP, OTHER_GROUP]);

    const group = inventory.groups[0]!;
    // Every required fact is present: the live observation (name, reachability and Bot
    // membership), durable policy, this Owner's own access and assignment, and the durable
    // Skill whitelist with its version.
    expect(group.name).toBe("Fixture Group");
    expect(group.reachable).toBe(true);
    expect(group.botMembership).toBe(true);
    expect(group.version).toBe(1);
    expect(group.categories).toEqual(DEFAULT_OWNER_GROUP_POLICY.categories);
    expect(group.memorySources).toEqual(DEFAULT_OWNER_GROUP_POLICY.memorySources);
    expect(group.access.assigned).toBe(true);
    expect(group.access.grantedCategories).toEqual(
      DEFAULT_OWNER_GROUP_CATEGORIES.filter((category) => groupActions([category]).length > 0),
    );
    expect(group.access.historyRead).toBe(true);
    expect(group.skills).toEqual({ enabledSkills: ["unslop"], version: 0 });

    // Owner B's own projection states Owner B's own assignment, never Owner A's: the group
    // they share is `assigned` for both, and the group only B manages appears only for B.
    const otherOwner = await application.projectManagedGroups(b);
    expect(otherOwner.groups.map((entry) => entry.groupId)).toEqual([GROUP, OTHER_GROUP]);
    expect(otherOwner.groups.every((entry) => entry.access.assigned)).toBe(true);
  });

  it("keeps the durable inventory and reports live facts unknown when the provider cannot answer", async () => {
    // A disconnected provider: the durable group and its policy survive, but nothing live is
    // claimed — not `false`, and not an empty name.
    const offline = await owners();
    await offline.application.setGroupAccess(offline.a, { groupId: GROUP, enabled: true });
    await offline.f.app.disconnectChannel("fixture");
    const disconnected = (await offline.application.projectManagedGroups(offline.a)).groups[0]!;
    expect(disconnected.groupId).toBe(GROUP);
    expect(disconnected.name).toBeNull();
    expect(disconnected.reachable).toBeNull();
    // Unobserved membership is unknown, never a claim that the Bot is not in the group.
    expect(disconnected.botMembership).toBeNull();
    expect(disconnected.version).toBe(1);
    expect(disconnected.categories).toEqual(DEFAULT_OWNER_GROUP_POLICY.categories);
    expect(disconnected.access.assigned).toBe(true);
    expect(disconnected.access.grantedCategories).toContain("group.read");

    // A connected provider that rejects `get_group_info` is the same "unknown" — including for
    // membership, since a rejection is not proof of non-membership — and it does not fail the
    // whole projection or erase the durable facts for the group.
    const failing = await owners();
    await failing.application.setGroupAccess(failing.a, { groupId: GROUP, enabled: true });
    // Only now does the peer begin rejecting `get_group_info`: the durable assignment is already
    // in place, so the failure can affect the live observation alone.
    failing.f.setGroupInfoFails(true);
    const errored = (await failing.application.projectManagedGroups(failing.a)).groups;
    expect(errored).toHaveLength(1);
    expect(errored[0]).toMatchObject({
      groupId: GROUP,
      name: null,
      reachable: null,
      botMembership: null,
    });
    expect(errored[0]!.access).toMatchObject({ assigned: true, historyRead: true });
    expect(errored[0]!.skills).toEqual({ enabledSkills: ["unslop"], version: 0 });
    // The peer was asked and answered; the answer simply was not evidence.
    expect(failing.f.groupInfoRequests()).toBeGreaterThan(0);
  });

  it("applies a history revoke to the very next inventory projection", async () => {
    const { application, a } = await owners({ groupName: "Fixture Group" });
    await application.setGroupAccess(a, { groupId: GROUP, enabled: true });
    const before = (await application.projectManagedGroups(a)).groups[0]!;
    expect(before.categories["group.history"]).toBe(true);
    expect(before.access.grantedCategories).toContain("group.history");
    expect(before.access.historyRead).toBe(true);

    await application.setGroupHistory(a, { groupId: GROUP, enabled: false });

    // Both the durable policy and the live authorization decision change, and the next
    // projection reads them fresh rather than from a cached bundle.
    const after = (await application.projectManagedGroups(a)).groups[0]!;
    expect(after.categories["group.history"]).toBe(false);
    expect(after.access.grantedCategories).not.toContain("group.history");
    expect(after.access.historyRead).toBe(false);
    // The assignment itself is untouched: only the one category changed.
    expect(after.groupId).toBe(GROUP);
  });

  it("records the projection's per-group decisions against the current Conversation and Run", async () => {
    const { f, application, a } = await owners({ groupName: "Fixture Group" });
    await application.setGroupAccess(a, { groupId: GROUP, enabled: true });

    await application.projectManagedGroups(a);

    // The projection re-authorizes every protected group fact through the real decision path,
    // so the durable evidence names this Principal, this concrete group Resource and this Run.
    const records = (await f.app.store.evidence.listDecisions(a.caller, "personal", { limit: 100 }))
      .items;
    const decided = records.filter(
      (record) => record.resourceId === `group:${GROUP}` && record.runId === a.runId,
    );

    // Every group-scoped Action the registry declares was decided for this group in this Run:
    // the whole read bundle and every mutation category, not just the ones that are granted.
    expect(new Set(decided.map((record) => record.action))).toEqual(
      new Set([
        ...groupActions(DEFAULT_OWNER_GROUP_CATEGORIES),
        ...groupActions(MUTATION_CATEGORIES),
      ]),
    );
    // Each decision is linked to the Run that asked, so the evidence can be reconstructed.
    for (const record of decided) expect(record.conversationId).toBe(a.conversationId);

    const decisionFor = (action: string) => decided.find((record) => record.action === action);
    // The evidence agrees with the projection: the read bundle is ALLOW, no mutation is.
    expect(decisionFor("group:read")?.decision).toBe("ALLOW");
    expect(decisionFor("history:read")?.decision).toBe("ALLOW");
    expect(decisionFor("group:moderate")?.decision).toBe("DENY");
  });

  it("denies the group and reads no provider fact once the read grant is revoked", async () => {
    const { f, application, a } = await owners({ groupName: "Fixture Group" });
    await application.setGroupAccess(a, { groupId: GROUP, enabled: true });
    // A connected peer that answers: the only reason a projection can report nothing live is
    // that the projection decided not to ask.
    expect((await application.projectManagedGroups(a)).groups[0]?.name).toBe("Fixture Group");

    const before = f.groupInfoRequests();
    // Revoke the one category whose Action gates the live read. The Owner's own `group:manage`
    // assignment — and therefore the inventory entry — stays in place.
    await application.setGroupCategory(a, {
      groupId: GROUP,
      category: "group.read",
      enabled: false,
    });

    const inventory = await application.projectManagedGroups(a);
    // The group is still this Owner's managed group, and says so...
    expect(inventory.groups.map((group) => group.groupId)).toEqual([GROUP]);
    const group = inventory.groups[0]!;
    expect(group.access.assigned).toBe(true);
    // ...but `group:read` is no longer granted, so no live fact is claimed and the peer is
    // never asked — a denied group causes no provider read at all.
    expect(group.access.grantedCategories).not.toContain("group.read");
    expect(group.name).toBeNull();
    expect(group.reachable).toBeNull();
    expect(group.botMembership).toBeNull();
    expect(f.groupInfoRequests()).toBe(before);

    // The denial is durable evidence carrying this Run, not a silently missing observation.
    // Both projections decided `group:read` for this Run — the first allowed it, the second
    // denied it — so the revoke is visible as a new denial rather than as absent evidence.
    const records = (await f.app.store.evidence.listDecisions(a.caller, "personal", { limit: 100 }))
      .items;
    const groupRead = records.filter(
      (record) =>
        record.resourceId === `group:${GROUP}` &&
        record.action === "group:read" &&
        record.runId === a.runId,
    );
    expect(groupRead.map((record) => record.decision).sort()).toEqual(["ALLOW", "DENY"]);
    for (const record of groupRead) expect(record.conversationId).toBe(a.conversationId);
  });

  it("keeps the durable Skill whitelist and its version in the projection across a restart", async () => {
    const { f, application, a } = await owners({ persistentDatabase: true });
    await application.setGroupAccess(a, { groupId: GROUP, enabled: true });
    await application.setGroupSkill(a, {
      groupId: GROUP,
      skillName: "github-gem-seeker",
      enabled: true,
    });

    const before = (await application.projectManagedGroups(a)).groups[0]!;
    expect([...before.skills.enabledSkills].sort()).toEqual(["github-gem-seeker", "unslop"]);
    expect(before.skills.version).toBe(1);

    // The whitelist is read from the durable group runtime, so it survives a reopen rather
    // than depending on any live Pi session.
    const restarted = admin(await f.reopen());
    const after = (await restarted.projectManagedGroups(a)).groups[0]!;
    expect(after.skills).toEqual(before.skills);
    expect(after.groupId).toBe(GROUP);
    expect(after.version).toBe(before.version);
  });

  it("returns only matching, policy-enabled and authorized entries with their groups", async () => {
    const { application, a } = await owners();
    await application.setGroupAccess(a, { groupId: GROUP, enabled: true });

    // No query is the whole authorized set: the account-scoped entries plus every group-scoped
    // entry the default bundle enables in the one managed group.
    const all = await capabilitySearch(application, a);
    expect(all.query).toBeNull();
    expect(all.groups).toEqual([GROUP]);
    expect(all.capabilities.map((entry) => entry.tool).sort()).toEqual(
      ["qq_account_status", "qq_capability_search", ...DEFAULT_GROUP_TOOLS].sort(),
    );
    for (const entry of all.capabilities) {
      // Every record carries the required stable metadata.
      expect(typeof entry.tool).toBe("string");
      expect(entry.description.length).toBeGreaterThan(0);
      expect(QQ_CAPABILITY_CATEGORIES).toContain(entry.category);
      expect(typeof entry.readOnly).toBe("boolean");
      // A group-scoped entry says where it is usable; an account entry is not group-bound.
      expect(entry.groupIds).toEqual(DEFAULT_GROUP_TOOLS.includes(entry.tool) ? [GROUP] : []);
    }
    expect(all.capabilities.find((entry) => entry.tool === "qq_group_history")?.readOnly).toBe(
      true,
    );

    // A query matches on the registry metadata and returns only what matched.
    const history = await capabilitySearch(application, a, { query: "history" });
    expect(history.query).toBe("history");
    expect(history.capabilities).toEqual([
      {
        tool: "qq_group_history",
        description: "Read a managed group's live message history page.",
        category: "group.history",
        readOnly: true,
        groupIds: [GROUP],
      },
    ]);

    // The group filter narrows the caller's own assignment; it never widens it.
    const elsewhere = await capabilitySearch(application, a, {
      query: "history",
      groupIds: [OTHER_GROUP],
    });
    expect(elsewhere.groups).toEqual([]);
    expect(elsewhere.capabilities).toEqual([]);
  });

  it("contributes no result for a disabled category, another Owner's group or a revoked grant", async () => {
    const { application, a, b } = await owners();
    await application.setGroupAccess(a, { groupId: GROUP, enabled: true });
    await application.setGroupAccess(b, { groupId: OTHER_GROUP, enabled: true });
    expect(
      (await capabilitySearch(application, a, { query: "history" })).capabilities,
    ).toHaveLength(1);

    // A disabled category removes its entry even though the registry still declares it.
    await application.setGroupHistory(a, { groupId: GROUP, enabled: false });
    expect((await capabilitySearch(application, a, { query: "history" })).capabilities).toEqual([]);
    await application.setGroupHistory(a, { groupId: GROUP, enabled: true });

    // Another Owner's group is outside this Owner's assignment: naming it as a filter yields no
    // group at all, and a query only that group's entries could satisfy returns nothing.
    const foreign = await capabilitySearch(application, a, {
      query: "history",
      groupIds: [OTHER_GROUP],
    });
    expect(foreign.groups).toEqual([]);
    expect(foreign.capabilities).toEqual([]);

    // Revoking the assignment revokes every group-scoped entry: only the Agent's own
    // account-scoped capabilities remain.
    await application.setGroupAccess(a, { groupId: GROUP, enabled: false });
    const revoked = await capabilitySearch(application, a);
    expect(revoked.groups).toEqual([]);
    expect(revoked.capabilities.map((entry) => entry.tool).sort()).toEqual([
      "qq_account_status",
      "qq_capability_search",
    ]);
  });

  it("never surfaces a server-only, deferred or raw provider primitive", async () => {
    const { application, a } = await owners();
    await application.setGroupAccess(a, { groupId: GROUP, enabled: true });
    const tools = (await capabilitySearch(application, a)).capabilities.map((entry) => entry.tool);

    for (const forbidden of [
      "upload_group_file",
      "send_group_msg",
      "send_private_msg",
      "get_csrf_token",
      "get_cookies",
      "get_rkey",
      "send_packet",
      "bot_exit",
      "set_restart",
      "clean_cache",
    ]) {
      expect(tools).not.toContain(forbidden);
      // Nor can a query reach one: the search surface is the Glassbox registry, not the
      // provider's action namespace.
      expect((await capabilitySearch(application, a, { query: forbidden })).capabilities).toEqual(
        [],
      );
    }

    // `upload_group_file` is a real group file mutation, but its `file` parameter is a local
    // server path, so even the group-files Tool may not issue it.
    expect(tools).toContain("qq_group_files");
    expect(tools).not.toContain("qq_group_file_ops");
  });

  it("never discovers the registry search outside an Owner-private Run", async () => {
    const { f, application, a } = await owners();
    await application.setGroupAccess(a, { groupId: GROUP, enabled: true });
    // The Owner-private Run is the only scope that discovers it.
    expect(await application.resolveRunToolNames(a)).toContain("qq_capability_search");

    // A group Run in the Owner's own managed group does not...
    f.send(2, "group-run", false, 10002, Number(GROUP));
    const groupRunStarted = await f.started.take();
    await f.reply("answer:group-run");
    const inGroup: OwnerContext = {
      caller: groupRunStarted.caller,
      conversationId: groupRunStarted.conversation.id,
      runId: groupRunStarted.run.id,
    };
    expect(inGroup.caller.scope).toMatchObject({ chatType: "group", chatId: GROUP });
    expect(await application.resolveRunToolNames(inGroup)).not.toContain("qq_capability_search");
    // ...and a direct call is denied on a Resource that was never registered, rather than
    // merely hidden from the surface.
    await expect(searchTool(application, inGroup).execute("call", {})).rejects.toThrow(
      "Permission denied: resource_missing",
    );

    // A Visitor-private Run holds no capability surface at all.
    f.send(3, "visitor-private", true, 10004);
    const visitorStarted = await f.started.take();
    await f.reply("answer:visitor-private");
    const visitor: OwnerContext = {
      caller: visitorStarted.caller,
      conversationId: visitorStarted.conversation.id,
      runId: visitorStarted.run.id,
    };
    expect(visitor.caller.principalId).toBe("qq-visitor-10004");
    expect(await application.resolveRunToolNames(visitor)).not.toContain("qq_capability_search");
    await expect(searchTool(application, visitor).execute("call", {})).rejects.toThrow(
      "Permission denied: no_grant",
    );
  });
});
