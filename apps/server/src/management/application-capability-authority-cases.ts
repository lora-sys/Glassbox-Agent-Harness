import { afterEach, describe, expect, it } from "vite-plus/test";
import { createApplicationFixtureScope } from "./application-test-helpers.js";
import type { ExecutionInput } from "../execution/run-service/types.js";
import { PiRunExecutionAdapter } from "../runtime/pi/run-adapter.js";
import { ProviderCallError } from "../runtime/pi/provider-outcome.js";
import { TOOL_DESCRIPTORS } from "../runtime/pi/tool-plane.js";
import type { PiRuntimeAdapter } from "../runtime/pi/types.js";
import {
  groupRun,
  GROUP_RUN_READ_TOOLS,
  GROUP_RUN_FORBIDDEN_TOOLS,
  type OwnerContext,
  type Action,
} from "./application-test-helpers.js";

const { fixture, afterEachCleanup } = createApplicationFixtureScope();
afterEach(afterEachCleanup);

describe("configured group Run capability authority", () => {
  const CO_OWNER = "10006";
  /** The group's numeric provider id, and the canonical string id Glassbox resources use. */
  const GROUP_ID = 10005;
  const GROUP = String(GROUP_ID);
  const OTHER_GROUP_ID = 10007;
  const OTHER_GROUP = String(OTHER_GROUP_ID);

  /**
   * Enables a group for the primary Owner and then runs a real group message in it, so the
   * caller scope under test is the one the transport produced rather than one the test made up.
   */
  async function configuredGroup(
    role: "owner" | "admin" | "member" = "member",
    memberRole: () => "owner" | "admin" | "member" = () => role,
    failAction?: string,
    onAction?: (action: Action) => void,
  ) {
    const f = await fixture(
      async (input) => ({ status: "succeeded", text: `answer:${input.text}` }),
      {
        coOwnerId: CO_OWNER,
        memberRole,
        ...(failAction === undefined ? {} : { failAction }),
        ...(onAction === undefined ? {} : { onAction }),
      },
    );
    f.send(1, "owner-a", true, 10002);
    const ownerA = await f.started.take();
    await f.reply("answer:owner-a");
    const a: OwnerContext = {
      caller: ownerA.caller,
      conversationId: ownerA.conversation.id,
      runId: ownerA.run.id,
    };
    const application = groupRun(f.app);
    await application.setGroupAccess(a, { groupId: GROUP, enabled: true });
    f.send(2, "group-run", false, 10002, GROUP_ID, role);
    const run = await f.started.take();
    await f.reply("answer:group-run");
    const context: OwnerContext = {
      caller: run.caller,
      conversationId: run.conversation.id,
      runId: run.run.id,
    };
    expect(context.caller.scope).toMatchObject({ chatType: "group", chatId: GROUP });
    return { f, a, application, context, groupInput: run };
  }

  it("names why each Tool is off a group Run's surface instead of only that it is", async () => {
    const { application, context } = await configuredGroup();

    const candidates = await application.resolveRunToolCandidates(context);
    const reason = (name: string) => candidates.find((entry) => entry.name === name)?.exclusion;

    // A group Run cannot reach the mutating categories at all: that is a scope boundary, not
    // an Owner policy choice, and the surface has to say which one it was.
    expect(reason("qq_group_moderation")).toBe("scope_not_permitted");
    expect(reason("qq_account_status")).toBe("scope_not_permitted");
    // `qq_capability_search` is Owner-private, so a group Run is out of scope for it.
    expect(reason("qq_capability_search")).toBe("scope_not_permitted");
    // The Agent Ops and Owner-control surface is Owner-private too.
    expect(reason("owner_group_admin")).toBe("scope_not_permitted");
    expect(reason("ops_status")).toBe("scope_not_permitted");
    // Isolated file and Shell Tools are still outside every group Run's scope.
    expect(reason("read")).toBe("scope_not_permitted");
    expect(reason("bash")).toBe("scope_not_permitted");
    // The eligible read-only Tools are the selected set, and agree with the name projection.
    const selected = candidates
      .filter((entry) => entry.exclusion === null)
      .map((entry) => entry.name);
    expect([...selected].sort()).toEqual([...GROUP_RUN_READ_TOOLS].sort());
    expect([...(await application.resolveRunToolNames(context))].sort()).toEqual(
      [...selected].sort(),
    );
  });

  it("classifies every registered Tool, so a Tool with unwired discovery cannot slip through", async () => {
    const { application, context } = await configuredGroup();

    const candidates = await application.resolveRunToolCandidates(context);
    // `unclassified` means Glassbox registers a Tool that no discovery rule reached. It is
    // never a legitimate outcome: it is a Tool that would either be offered by accident or
    // silently vanish. Asserting it never appears is what makes adding a Tool without wiring
    // its discovery fail here rather than in production.
    expect(candidates.filter((entry) => entry.exclusion === "unclassified")).toEqual([]);
    expect(candidates.length).toBe(TOOL_DESCRIPTORS.length);
    expect(new Set(candidates.map((entry) => entry.name)).size).toBe(TOOL_DESCRIPTORS.length);
  });

  it("withholds a registered Tool that no discovery rule classified", async () => {
    const { application, context } = await configuredGroup();

    // The registry is the universe of Tools that *exist*. Discovery is a separate decision about
    // which of them a Run may see. A Tool in the first and in no rule of the second is the
    // wiring bug §9/§10 exist to catch: the real table happens to have every Tool wired, so no
    // Run over it can reproduce the gap. Injecting one descriptor is what makes the guard
    // testable — delete the `unclassified` branch and this Tool is offered to the model.
    const unwired = {
      ...TOOL_DESCRIPTORS[0]!,
      name: "qq_never_wired",
    };
    const candidates = await application.resolveRunToolCandidates(context, [
      ...TOOL_DESCRIPTORS,
      unwired,
    ]);

    const found = candidates.find((entry) => entry.name === unwired.name);
    expect(found?.exclusion).toBe("unclassified");
    expect(
      candidates.filter((entry) => entry.exclusion === null).map((entry) => entry.name),
    ).toEqual(expect.not.arrayContaining([unwired.name]));
    // It is still classified — the answer to "why is this off the surface" must name it rather
    // than let it vanish from the report, which is the other half of the same bug.
    expect(candidates.length).toBe(TOOL_DESCRIPTORS.length + 1);
  });

  it("discovers only reads for an ordinary group member and calls one for real", async () => {
    const { application, context } = await configuredGroup();

    const names = await application.resolveRunToolNames(context);
    expect([...names].sort()).toEqual([...GROUP_RUN_READ_TOOLS].sort());
    for (const name of GROUP_RUN_FORBIDDEN_TOOLS) expect(names).not.toContain(name);

    // The discovered Tool is not just discoverable: a real call reaches the OneBot peer and
    // returns the group the Run is bound to, with `group_id` derived server-side.
    const tools = application.createRuntimeTools(() => context);
    const groups = tools.find((tool) => tool.name === "qq_groups");
    if (!groups) throw new Error("missing qq_groups");
    const result = await groups.execute("call", { operation: "get_group_info" });
    expect(result.details).toMatchObject({ status: "ok", data: { group_id: Number(GROUP) } });
  });

  it("gives a QQ admin only current-group moderation and re-verifies before execution", async () => {
    const { application, a, context, f } = await configuredGroup("admin");
    await application.setGroupCategory(a, {
      groupId: GROUP,
      category: "group.moderate",
      enabled: true,
    });
    expect(context.caller.scope.nativeGroupRole?.role).toBe("qq_group_admin");
    expect(
      (await application.resolveRunToolCandidates(context)).find(
        (entry) => entry.name === "qq_group_moderation",
      )?.exclusion,
    ).toBeNull();
    const names = await application.resolveRunToolNames(context);
    expect(names).toContain("qq_group_moderation");
    expect(names).not.toContain("qq_group_local_settings");
    expect(names).not.toContain("qq_group_settings");
    expect(names).not.toContain("owner_group_admin");
    const runtimeContext = Object.assign(context, {
      requiredToolName: "qq_group_moderation",
      requiredToolInput: {
        groupId: GROUP,
        operation: "set_group_ban",
        params: { user_id: 10004, duration: 60 },
      },
    });
    const moderation = application
      .createRuntimeTools(() => runtimeContext)
      .find((tool) => tool.name === "qq_group_moderation");
    if (!moderation) throw new Error("missing qq_group_moderation");
    await expect(
      moderation.execute("call", {
        operation: "set_group_ban",
        params: { user_id: 10004, duration: 60 },
      }),
    ).resolves.toMatchObject({ details: { status: "ok" } });
    const trace = await f.app.trace.readPage(context.runId);
    expect(
      trace.records
        .map((record) => record.event)
        .filter((event) => {
          const value = event as { type?: string };
          return value.type === "native_group_role_observed";
        }),
    ).toEqual([
      expect.objectContaining({
        principalId: context.caller.principalId,
        resourceId: `group:${GROUP}`,
        groupId: GROUP,
        senderId: "10002",
        observedRole: "qq_group_admin",
        roleSource: "onebot_message_sender",
      }),
    ]);
    expect(
      trace.records
        .map((record) => record.event)
        .filter((event) => {
          const value = event as { type?: string };
          return value.type === "native_group_role_verification";
        }),
    ).toEqual([
      expect.objectContaining({
        observedRole: "qq_group_admin",
        verifiedRole: "qq_group_admin",
        verificationStatus: "verified",
        requestedTool: "qq_group_moderation",
        requestedOperation: "set_group_ban",
        authorizationDecision: "ALLOW",
      }),
    ]);
  });

  it("denies a mutation before provider action when QQ demotes the observed admin", async () => {
    let currentRole: "admin" | "member" = "admin";
    const { application, a, context, f } = await configuredGroup("admin", () => currentRole);
    await application.setGroupCategory(a, {
      groupId: GROUP,
      category: "group.moderate",
      enabled: true,
    });
    const runtimeContext = Object.assign(context, {
      requiredToolName: "qq_group_moderation",
      requiredToolInput: {
        groupId: GROUP,
        operation: "set_group_whole_ban",
        params: { enable: true },
      },
    });
    const moderation = application
      .createRuntimeTools(() => runtimeContext)
      .find((tool) => tool.name === "qq_group_moderation");
    if (!moderation) throw new Error("missing qq_group_moderation");
    currentRole = "member";
    await expect(
      moderation.execute("call", {
        operation: "set_group_whole_ban",
        params: { enable: true },
      }),
    ).rejects.toThrow("native_group_role_denied");
    const verified = await f.actions.take((action) => action.action === "get_group_member_info");
    expect(verified.params).toMatchObject({
      group_id: GROUP_ID,
      user_id: 10002,
      no_cache: true,
    });
    expect(f.actionLog.some((action) => action.action === "set_group_whole_ban")).toBe(false);
    const trace = await f.app.trace.readPage(context.runId);
    expect(
      trace.records
        .map((record) => record.event)
        .filter((event) => {
          const value = event as { type?: string };
          return value.type === "native_group_role_verification";
        }),
    ).toContainEqual(
      expect.objectContaining({
        observedRole: "qq_group_admin",
        verifiedRole: "qq_group_member",
        verificationStatus: "mismatch",
        authorizationDecision: "DENY",
      }),
    );
  });

  it("fails a provider-acknowledged admin mutation whose fresh role did not change", async () => {
    const { application, a, f } = await configuredGroup();
    await application.setGroupCategory(a, {
      groupId: GROUP,
      category: "group.settings",
      enabled: true,
    });
    const context = Object.assign(a, {
      requiredToolName: "qq_group_settings",
      requiredToolInput: {
        groupId: GROUP,
        operation: "set_group_admin",
        params: { user_id: 10004, enable: true },
      },
    });
    const settings = application
      .createRuntimeTools(() => context)
      .find((tool) => tool.name === "qq_group_settings");
    if (!settings) throw new Error("missing qq_group_settings");

    await expect(
      settings.execute("call", {
        groupId: GROUP,
        operation: "set_group_admin",
        params: { user_id: 10004, enable: true },
      }),
    ).rejects.toThrow("provider_postcondition_failed");
    expect(f.actionLog.map((action) => action.action)).toContain("set_group_admin");
    expect(f.actionLog).toContainEqual(
      expect.objectContaining({
        action: "get_group_member_info",
        params: expect.objectContaining({
          group_id: GROUP_ID,
          user_id: 10004,
          no_cache: true,
        }),
      }),
    );
    const trace = await f.app.trace.readPage(context.runId);
    expect(trace.records.map((record) => record.event)).toContainEqual(
      expect.objectContaining({
        type: "provider_mutation_verification",
        requestedOperation: "set_group_admin",
        targetUserId: "10004",
        expectedRole: "qq_group_admin",
        observedRole: "qq_group_member",
        verificationStatus: "mismatch",
      }),
    );
  });

  it("accepts set_group_admin only after a fresh provider read proves the new role", async () => {
    let currentRole: "admin" | "member" = "member";
    const { application, a, f } = await configuredGroup(
      "member",
      () => currentRole,
      undefined,
      (action) => {
        const params = action.params as Record<string, unknown>;
        if (action.action === "set_group_admin" && typeof params.enable === "boolean")
          currentRole = params.enable ? "admin" : "member";
      },
    );
    await application.setGroupCategory(a, {
      groupId: GROUP,
      category: "group.settings",
      enabled: true,
    });
    const context = Object.assign(a, {
      requiredToolName: "qq_group_settings",
      requiredToolInput: {
        groupId: GROUP,
        operation: "set_group_admin",
        params: { user_id: 10004, enable: true },
      },
    });
    const settings = application
      .createRuntimeTools(() => context)
      .find((tool) => tool.name === "qq_group_settings");
    if (!settings) throw new Error("missing qq_group_settings");

    await expect(
      settings.execute("call", {
        groupId: GROUP,
        operation: "set_group_admin",
        params: { user_id: 10004, enable: true },
      }),
    ).resolves.toMatchObject({ details: { status: "ok" } });
    context.requiredToolInput = {
      groupId: GROUP,
      operation: "set_group_admin",
      params: { user_id: 10004, enable: false },
    };
    await expect(
      settings.execute("call", {
        groupId: GROUP,
        operation: "set_group_admin",
        params: { user_id: 10004, enable: false },
      }),
    ).resolves.toMatchObject({ details: { status: "ok" } });
    const trace = await f.app.trace.readPage(context.runId);
    expect(trace.records.map((record) => record.event)).toContainEqual(
      expect.objectContaining({
        type: "provider_mutation_verification",
        expectedRole: "qq_group_admin",
        observedRole: "qq_group_admin",
        verificationStatus: "verified",
      }),
    );
    expect(trace.records.map((record) => record.event)).toContainEqual(
      expect.objectContaining({
        type: "provider_mutation_verification",
        expectedRole: "qq_group_member",
        observedRole: "qq_group_member",
        verificationStatus: "verified",
      }),
    );
  });

  it("uses each new message's role observation without promoting the Principal", async () => {
    const { application, a, context, f } = await configuredGroup("admin");
    await application.setGroupCategory(a, {
      groupId: GROUP,
      category: "group.moderate",
      enabled: true,
    });
    expect(await application.resolveRunToolNames(context)).toContain("qq_group_moderation");

    f.send(3, "next-run", false, 10002, GROUP_ID, "member");
    const next = await f.started.take();
    await f.reply("answer:next-run");
    const nextContext: OwnerContext = {
      caller: next.caller,
      conversationId: next.conversation.id,
      runId: next.run.id,
    };
    expect(nextContext.caller.principalId).toBe(context.caller.principalId);
    expect(nextContext.caller.scope.nativeGroupRole?.role).toBe("qq_group_member");
    expect(await application.resolveRunToolNames(nextContext)).not.toContain("qq_group_moderation");
  });

  it("scopes one Principal's QQ role independently in two managed groups", async () => {
    const { application, a, f } = await configuredGroup();
    for (const groupId of [GROUP, OTHER_GROUP]) {
      await application.setGroupAccess(a, { groupId, enabled: true });
      await application.setGroupCategory(a, {
        groupId,
        category: "group.moderate",
        enabled: true,
      });
    }

    f.send(3, "group-a", false, 10004, GROUP_ID, "admin");
    const groupA = await f.started.take();
    await f.reply("answer:group-a");
    f.send(4, "group-b", false, 10004, OTHER_GROUP_ID, "member");
    const groupB = await f.started.take();
    await f.reply("answer:group-b");
    const contextA: OwnerContext = {
      caller: groupA.caller,
      conversationId: groupA.conversation.id,
      runId: groupA.run.id,
    };
    const contextB: OwnerContext = {
      caller: groupB.caller,
      conversationId: groupB.conversation.id,
      runId: groupB.run.id,
    };
    expect(contextA.caller.principalId).toBe(contextB.caller.principalId);
    expect(contextA.caller.scope.chatId).toBe(GROUP);
    expect(contextB.caller.scope.chatId).toBe(OTHER_GROUP);
    expect(await application.resolveRunToolNames(contextA)).toContain("qq_group_moderation");
    expect(await application.resolveRunToolNames(contextB)).not.toContain("qq_group_moderation");
  });

  it("reports Bot authority loss as provider failure after caller authorization passes", async () => {
    const { application, a, context, f } = await configuredGroup(
      "admin",
      () => "admin",
      "set_group_whole_ban",
    );
    await application.setGroupCategory(a, {
      groupId: GROUP,
      category: "group.moderate",
      enabled: true,
    });
    const runtimeContext = Object.assign(context, {
      requiredToolName: "qq_group_moderation",
      requiredToolInput: {
        groupId: GROUP,
        operation: "set_group_whole_ban",
        params: { enable: true },
      },
    });
    const moderation = application
      .createRuntimeTools(() => runtimeContext)
      .find((tool) => tool.name === "qq_group_moderation");
    if (!moderation) throw new Error("missing qq_group_moderation");
    const failure = await moderation
      .execute("call", { operation: "set_group_whole_ban", params: { enable: true } })
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    expect(failure).toBeInstanceOf(ProviderCallError);
    expect((failure as ProviderCallError).outcome).toBe("provider_failed");
    expect(f.actionLog.map((action) => action.action)).toEqual(
      expect.arrayContaining(["get_group_member_info", "set_group_whole_ban"]),
    );
  });

  it("denies a group Run mutation even if the Tool is called directly", async () => {
    const { application, context } = await configuredGroup();
    const tools = application.createRuntimeTools(() => context);
    const moderation = tools.find((tool) => tool.name === "qq_group_moderation");
    if (!moderation) throw new Error("missing qq_group_moderation");

    // The mutating Tool is never part of the group Run's discovered surface...
    expect(await application.resolveRunToolNames(context)).not.toContain("qq_group_moderation");
    // Calling it anyway still fails. The group has a scoped action grant so a future verified
    // admin can use it, but current policy remains an independent gate and is disabled here.
    await expect(
      moderation.execute("call", {
        operation: "set_group_whole_ban",
        params: { enable: true },
      }),
    ).rejects.toThrow("capability_category_disabled");
  });

  it("hides and refuses group history on the next Run after the Owner disables it", async () => {
    const { application, a, context } = await configuredGroup();
    expect(await application.resolveRunToolNames(context)).toContain("group_history_search");
    // A Run that starts while history is enabled still holds the Tool.
    const tools = application.createRuntimeTools(() => context);

    await application.setGroupHistory(a, { groupId: GROUP, enabled: false });

    // The next Run's surface no longer offers either history Tool.
    const after = await application.resolveRunToolNames(context);
    expect(after).not.toContain("group_history_search");
    expect(after).not.toContain("qq_group_history");

    // The earlier Run cannot keep reading: the grant is untouched, so the refusal is the
    // Owner's policy rather than a missing authority.
    const historyTool = tools.find((tool) => tool.name === "group_history_search");
    if (!historyTool) throw new Error("missing group_history_search");
    await expect(historyTool.execute("call", { query: "anything" })).rejects.toThrow(
      "history_category_disabled",
    );
    const domainHistory = tools.find((tool) => tool.name === "qq_group_history");
    if (!domainHistory) throw new Error("missing qq_group_history");
    await expect(
      domainHistory.execute("call", { operation: "get_group_msg_history" }),
    ).rejects.toThrow("capability_category_disabled");
  });

  it("keeps set_history and set_capability(group.history) coherent for the group Run", async () => {
    const { application, a, context } = await configuredGroup();
    const surfaces = async () => application.resolveRunToolNames(context);
    expect(await surfaces()).toContain("group_history_search");

    // Disabling through the capability entry point alone is enough to hide both Tools.
    await application.setGroupCategory(a, {
      groupId: GROUP,
      category: "group.history",
      enabled: false,
    });
    expect(await surfaces()).not.toContain("group_history_search");
    expect(await surfaces()).not.toContain("qq_group_history");

    // Re-enabling through the history entry point restores the same surface.
    await application.setGroupHistory(a, { groupId: GROUP, enabled: true });
    expect(await surfaces()).toContain("group_history_search");
    expect(await surfaces()).toContain("qq_group_history");

    // And the two entry points agree in the other direction too.
    await application.setGroupCategory(a, {
      groupId: GROUP,
      category: "group.history",
      enabled: false,
    });
    expect(await surfaces()).not.toContain("group_history_search");
    await application.setGroupCategory(a, {
      groupId: GROUP,
      category: "group.history",
      enabled: true,
    });
    expect(await surfaces()).toContain("group_history_search");
  });

  it("revokes the group Run's capability discovery with the last Owner's assignment", async () => {
    const { application, a, context } = await configuredGroup();
    expect(await application.resolveRunToolNames(context)).toContain("qq_groups");

    await application.setGroupAccess(a, { groupId: GROUP, enabled: false });

    // The group-scope grants go with the last assignment, so nothing is discoverable even
    // though the durable policy row is still there.
    expect(await application.resolveRunToolNames(context)).not.toContain("qq_groups");
    expect(await application.resolveRunToolNames(context)).not.toContain("group_history_search");
  });

  /**
   * The real execution adapter over a runtime that resolves the real Run surface.
   *
   * This is the production wiring: the runtime writes the Tool names it discovered onto the
   * Run context, and the execution adapter decides the required Tool from the current message
   * while reading that surface to decide whether the Run can satisfy it. A test that stubbed
   * either half would not catch the two disagreeing.
   */
  function piGroupRun(
    application: ReturnType<typeof groupRun>,
    input: ExecutionInput,
  ): (text: string) => Promise<string | undefined> {
    const seen: Array<string | undefined> = [];
    const runtime: PiRuntimeAdapter = {
      initialize: async () => {},
      createOrRestoreSession: async (_conversation, _profile, context) => {
        if (context)
          context.authorizedToolNames = await application.resolveRunToolNames(
            context as unknown as OwnerContext,
          );
        return {
          conversationId: input.conversation.id,
          runtimeSessionId: "session-1",
          profileName: "main-agent",
          agentDir: "agent",
          createdAt: new Date(0).toISOString(),
          lastActiveAt: new Date(0).toISOString(),
        };
      },
      run: async (_binding, _run, _prompt, context) => {
        seen.push(context?.requiredToolName);
        return { status: "completed", text: "ok", toolCalls: [] };
      },
      abort: async () => {},
      cleanup: async () => {},
    };
    const executor = new PiRunExecutionAdapter(runtime, { isOwner: async () => false });
    return async (text: string) => {
      await executor.execute({ ...input, text });
      return seen.at(-1);
    };
  }

  it("requires the group history Tool whether or not the real surface offers it", async () => {
    const { application, a, context, groupInput } = await configuredGroup();
    const requiredFor = piGroupRun(application, groupInput);
    const ask = "请搜索本群历史，找到 P4B-A-1349，并回复发送者和原文";

    expect(await application.resolveRunToolNames(context)).toContain("group_history_search");
    expect(await requiredFor(ask)).toBe("group_history_search");

    await application.setGroupHistory(a, { groupId: GROUP, enabled: false });

    // The Tool is off the surface now, and the requirement is not. The Run cannot satisfy it,
    // so the adapter fails closed below the model instead of letting it answer a search that
    // never ran — "本群历史检索已关闭" is exactly the composed answer this check exists to catch.
    // A requirement that left with the Tool would make the group's own setting the only thing
    // between the user and a fabricated result.
    expect(await application.resolveRunToolNames(context)).not.toContain("group_history_search");
    expect(await requiredFor(ask)).toBe("group_history_search");
  });

  it("never requires a cross-group Tool for a group Run", async () => {
    const { application, groupInput } = await configuredGroup();
    const requiredFor = piGroupRun(application, groupInput);
    expect(await requiredFor("请搜索本群历史，找到 P4B-A-1349")).toBe("group_history_search");
    // The Owner cross-group Tool is not on a group Run's surface at all.
    expect(
      await application.resolveRunToolNames({
        caller: groupInput.caller,
        conversationId: groupInput.conversation.id,
        runId: groupInput.run.id,
      }),
    ).not.toContain("owner_history_search");
  });
});
