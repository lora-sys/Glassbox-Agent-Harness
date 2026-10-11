import { afterEach, describe, expect, it } from "vite-plus/test";
import { createApplicationFixtureScope } from "./application-test-helpers.js";
import type { ExecutionInput } from "../execution/run-service/types.js";
import { PiRunExecutionAdapter } from "../runtime/pi/run-adapter.js";
import { ProviderCallError } from "../runtime/pi/provider-outcome.js";
import { TOOL_DESCRIPTORS } from "../runtime/pi/tool-plane.js";
import type { PiRuntimeAdapter } from "../runtime/pi/types.js";
import type { PiRunContext } from "../runtime/pi/types.js";
import {
  groupRun,
  GROUP_RUN_READ_TOOLS,
  GROUP_RUN_FORBIDDEN_TOOLS,
  type OwnerContext,
  type Action,
} from "./application-test-helpers.js";

const { fixture, afterEachCleanup } = createApplicationFixtureScope();
afterEach(afterEachCleanup);

type BotRoleObservationBinding = {
  observation: NonNullable<PiRunContext["botGroupRoleObservation"]>;
  authorize: () => Promise<void>;
};

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
    botRole: "owner" | "admin" | "member" = "member",
    beforeActionReply?: (action: Action) => Promise<void>,
    memberMuteUntil?: (userId: string) => number,
    memberRoleForUser?: (userId: string) => "owner" | "admin" | "member",
  ) {
    const f = await fixture(
      async (input) => ({ status: "succeeded", text: `answer:${input.text}` }),
      {
        coOwnerId: CO_OWNER,
        memberRole,
        memberRoleForUser: (userId) =>
          userId === "10001" ? botRole : (memberRoleForUser?.(userId) ?? memberRole()),
        ...(beforeActionReply === undefined ? {} : { beforeActionReply }),
        ...(memberMuteUntil === undefined ? {} : { memberMuteUntil }),
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
    expect(context.caller.scope).toMatchObject({
      chatType: "group",
      chatId: GROUP,
    });
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
    const result = await groups.execute("call", {
      operation: "get_group_info",
    });
    expect(result.details).toMatchObject({
      status: "ok",
      data: { group_id: Number(GROUP) },
    });
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
      recordQqToolExecutionInput: async (
        record: Parameters<NonNullable<PiRunContext["recordQqToolExecutionInput"]>>[0],
      ) => {
        const cursor = await f.app.trace.append(
          context.runId,
          {
            type: "qq_tool_execution_input_verified",
            runId: context.runId,
            ...record,
          },
          "glassbox-tool-evidence",
        );
        await f.app.store.evidence.advanceTrace(context.caller, cursor);
      },
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
      .execute("call", {
        operation: "set_group_whole_ban",
        params: { enable: true },
      })
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
    ).rejects.toThrow("Permission denied: source_policy_denied");
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
    ).rejects.toThrow("Permission denied: source_policy_denied");
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
      getModelCapacity: () => ({
        contextWindowTokens: 32_768,
        outputReserveTokens: 4_096,
        thinkingReserveTokens: 0,
        safetyMarginTokens: 512,
      }),
      run: async (_binding, _run, _prompt, context) => {
        seen.push(context?.requiredToolName);
        return { status: "completed", text: "ok", toolCalls: [] };
      },
      abort: async () => {},
      cleanup: async () => {},
    };
    const executor = new PiRunExecutionAdapter(runtime, {
      isOwner: async () => false,
    });
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

  it("observes only the configured Bot role after an authorized group moderation requirement", async () => {
    const { application, a, context, f } = await configuredGroup(
      "admin",
      () => "admin",
      undefined,
      undefined,
      "admin",
    );
    await application.setGroupCategory(a, {
      groupId: GROUP,
      category: "group.moderate",
      enabled: true,
    });
    const runContext = context as PiRunContext;
    runContext.authorizedToolNames = await application.resolveRunToolNames(context);
    runContext.requiredToolName = "qq_group_moderation";
    runContext.requiredToolInput = {
      groupId: GROUP,
      operation: "set_group_ban",
      params: { user_id: 10004, duration: 60 },
    };
    runContext.recordQqToolExecutionInput = async (record) => {
      const cursor = await f.app.trace.append(
        runContext.runId!,
        {
          type: "qq_tool_execution_input_verified",
          runId: runContext.runId,
          ...record,
        },
        "glassbox-tool-evidence",
      );
      await f.app.store.evidence.advanceTrace(runContext.caller!, cursor);
    };
    const observe = (
      application as unknown as {
        observeBotGroupRoleForModeration(
          context: PiRunContext,
          groupId: string,
          toolInput: Readonly<Record<string, unknown>>,
        ): Promise<BotRoleObservationBinding | undefined>;
      }
    ).observeBotGroupRoleForModeration.bind(application);

    const result = await observe(runContext, GROUP, runContext.requiredToolInput);
    expect(result?.observation).toEqual({
      groupId: GROUP,
      role: "qq_group_admin",
    });
    await expect(result?.authorize()).resolves.toBeUndefined();
    const lookup = await f.actions.take(
      (action) =>
        action.action === "get_group_member_info" &&
        action.params.group_id === GROUP_ID &&
        action.params.user_id === 10001,
    );
    expect(lookup.params).toMatchObject({
      group_id: GROUP_ID,
      user_id: 10001,
      no_cache: true,
    });
    expect(
      f.actionLog.some(
        (action) => action.action === "get_group_member_info" && action.params.user_id === 10002,
      ),
    ).toBe(true);
    expect(
      f.actionLog.some(
        (action) => action.action === "get_group_member_info" && action.params.user_id === 10001,
      ),
    ).toBe(true);
    const trace = await f.app.trace.readPage(context.runId);
    expect(trace.records.map((record) => record.event)).toContainEqual(
      expect.objectContaining({
        type: "bot_native_group_role_observation",
        principalId: context.caller.principalId,
        resourceId: "group:" + GROUP,
        groupId: GROUP,
        observationStatus: "verified",
        observedRole: "qq_group_admin",
        roleSubject: "configured_bot_account",
      }),
    );
    expect(trace.records.map((record) => record.event)).not.toContainEqual(
      expect.objectContaining({ type: "native_group_role_verification" }),
    );
    await application.setGroupCategory(a, {
      groupId: GROUP,
      category: "group.moderate",
      enabled: false,
    });
    await expect(result?.authorize()).rejects.toThrow("bot_group_role_authority_changed");
  });

  it("does not read the Bot role for a group requester without moderation authority", async () => {
    const { application, a, context, f } = await configuredGroup("member");
    await application.setGroupCategory(a, {
      groupId: GROUP,
      category: "group.moderate",
      enabled: true,
    });
    const runContext = context as PiRunContext;
    runContext.authorizedToolNames = await application.resolveRunToolNames(context);
    runContext.requiredToolName = "qq_group_moderation";
    runContext.requiredToolInput = {
      groupId: GROUP,
      operation: "set_group_ban",
      params: { user_id: 10004, duration: 60 },
    };
    const observe = (
      application as unknown as {
        observeBotGroupRoleForModeration(
          context: PiRunContext,
          groupId: string,
          toolInput: Readonly<Record<string, unknown>>,
        ): Promise<BotRoleObservationBinding | undefined>;
      }
    ).observeBotGroupRoleForModeration.bind(application);

    await expect(observe(runContext, GROUP, runContext.requiredToolInput)).resolves.toBeUndefined();
    expect(f.actionLog.some((action) => action.action === "get_group_member_info")).toBe(false);
    expect(runContext.botGroupRoleObservation).toBeUndefined();
  });

  it("allows the Owner-private assigned-group path without checking the Owner's QQ role", async () => {
    const { application, a, f } = await configuredGroup(
      "member",
      () => "member",
      undefined,
      undefined,
      "admin",
    );
    await application.setGroupCategory(a, {
      groupId: GROUP,
      category: "group.moderate",
      enabled: true,
    });
    const runContext = a as PiRunContext;
    runContext.authorizedToolNames = await application.resolveRunToolNames(a);
    runContext.requiredToolName = "qq_group_moderation";
    runContext.requiredToolInput = {
      groupId: GROUP,
      operation: "set_group_ban",
      params: { user_id: 10004, duration: 60 },
    };
    expect(runContext.authorizedToolNames).toContain("qq_group_moderation");
    const observe = (
      application as unknown as {
        observeBotGroupRoleForModeration(
          context: PiRunContext,
          groupId: string,
          toolInput: Readonly<Record<string, unknown>>,
        ): Promise<BotRoleObservationBinding | undefined>;
      }
    ).observeBotGroupRoleForModeration.bind(application);

    const result = await observe(runContext, GROUP, runContext.requiredToolInput);
    expect(result?.observation).toEqual({
      groupId: GROUP,
      role: "qq_group_admin",
    });
    await expect(result?.authorize()).resolves.toBeUndefined();
    const lookup = await f.actions.take(
      (action) =>
        action.action === "get_group_member_info" &&
        action.params.group_id === GROUP_ID &&
        action.params.user_id === 10001,
    );
    expect(lookup.params.user_id).toBe(10001);
    expect(
      f.actionLog.some(
        (action) =>
          action.action === "get_group_member_info" && action.params.user_id === 3526039967,
      ),
    ).toBe(false);
  });

  it("drops the Bot role fact when category authority is revoked during its provider read", async () => {
    let releaseBotRead!: () => void;
    let signalBotRead!: () => void;
    const botReadStarted = new Promise<void>((resolve) => {
      signalBotRead = resolve;
    });
    const botReadGate = new Promise<void>((resolve) => {
      releaseBotRead = resolve;
    });
    const { application, a, context } = await configuredGroup(
      "admin",
      () => "admin",
      undefined,
      undefined,
      "admin",
      async (action) => {
        if (action.action === "get_group_member_info" && action.params.user_id === 10001) {
          signalBotRead();
          await botReadGate;
        }
      },
    );
    await application.setGroupCategory(a, {
      groupId: GROUP,
      category: "group.moderate",
      enabled: true,
    });
    const runContext = context as PiRunContext;
    runContext.authorizedToolNames = await application.resolveRunToolNames(context);
    runContext.requiredToolName = "qq_group_moderation";
    runContext.requiredToolInput = {
      groupId: GROUP,
      operation: "set_group_ban",
      params: { user_id: 10004, duration: 60 },
    };
    const observe = (
      application as unknown as {
        observeBotGroupRoleForModeration(
          context: PiRunContext,
          groupId: string,
          toolInput: Readonly<Record<string, unknown>>,
        ): Promise<BotRoleObservationBinding | undefined>;
      }
    ).observeBotGroupRoleForModeration.bind(application);
    const pending = observe(runContext, GROUP, runContext.requiredToolInput);
    await botReadStarted;
    await application.setGroupCategory(a, {
      groupId: GROUP,
      category: "group.moderate",
      enabled: false,
    });
    releaseBotRead();
    await expect(pending).resolves.toBeUndefined();
    expect(runContext.botGroupRoleObservation).toBeUndefined();
  });

  it("blocks the provider when category authority changes after Bot read and before context send", async () => {
    const { application, a, groupInput } = await configuredGroup(
      "admin",
      () => "admin",
      undefined,
      undefined,
      "admin",
    );
    await application.setGroupCategory(a, {
      groupId: GROUP,
      category: "group.moderate",
      enabled: true,
    });
    let providerRunCount = 0;
    let sessionContext: PiRunContext | undefined;
    const runtime: PiRuntimeAdapter = {
      initialize: async () => {},
      createOrRestoreSession: async (_conversation, _profile, runContext) => {
        sessionContext = runContext;
        if (runContext)
          runContext.authorizedToolNames = await application.resolveRunToolNames(
            runContext as unknown as OwnerContext,
          );
        return {
          conversationId: groupInput.conversation.id,
          runtimeSessionId: "bot-role-revoke-session",
          profileName: "qq-group",
          agentDir: "agent",
          createdAt: new Date(0).toISOString(),
          lastActiveAt: new Date(0).toISOString(),
        };
      },
      getModelCapacity: () => ({
        contextWindowTokens: 32_768,
        outputReserveTokens: 4_096,
        thinkingReserveTokens: 0,
        safetyMarginTokens: 512,
      }),
      run: async () => {
        providerRunCount += 1;
        return { status: "completed", text: "unused", toolCalls: [] };
      },
      abort: async () => {},
      cleanup: async () => {},
    };
    const observe = (
      application as unknown as {
        observeBotGroupRoleForModeration(
          context: PiRunContext,
          groupId: string,
          toolInput: Readonly<Record<string, unknown>>,
        ): Promise<
          | {
              observation: NonNullable<PiRunContext["botGroupRoleObservation"]>;
              authorize: () => Promise<void>;
            }
          | undefined
        >;
      }
    ).observeBotGroupRoleForModeration.bind(application);
    const executor = new PiRunExecutionAdapter(runtime, {
      isOwner: async () => false,
      observeBotGroupRole: async (input) => {
        const binding = await observe(input.context, input.groupId, input.toolInput);
        if (binding)
          await application.setGroupCategory(a, {
            groupId: GROUP,
            category: "group.moderate",
            enabled: false,
          });
        return binding;
      },
    });

    await expect(
      executor.execute({
        ...groupInput,
        text: "把群 10005 的成员 10004 禁言 30 秒",
      }),
    ).resolves.toMatchObject({
      status: "failed",
      failureCode: "gate_refused",
      runtimeAttempted: false,
    });
    expect(providerRunCount).toBe(0);
    expect(sessionContext?.botGroupRoleObservation).toBeUndefined();
  });

  it("reports an unknown Bot role without changing an authorized moderation surface", async () => {
    const f = await fixture(
      async (input) => ({ status: "succeeded", text: "answer:" + input.text }),
      {
        failActionWhen: (action) =>
          action.action === "get_group_member_info" && action.params.user_id === 10001,
        memberRoleForUser: () => "admin",
      },
    );
    f.send(1, "owner-a", true, 10002);
    const ownerRun = await f.started.take();
    await f.reply("answer:owner-a");
    const owner: OwnerContext = {
      caller: ownerRun.caller,
      conversationId: ownerRun.conversation.id,
      runId: ownerRun.run.id,
    };
    const application = groupRun(f.app);
    await application.setGroupAccess(owner, { groupId: GROUP, enabled: true });
    await application.setGroupCategory(owner, {
      groupId: GROUP,
      category: "group.moderate",
      enabled: true,
    });
    f.send(2, "group-admin", false, 10002, GROUP_ID, "admin");
    const groupRunInput = await f.started.take();
    await f.reply("answer:group-admin");
    const context = {
      caller: groupRunInput.caller,
      conversationId: groupRunInput.conversation.id,
      runId: groupRunInput.run.id,
    } as PiRunContext;
    context.authorizedToolNames = await application.resolveRunToolNames(
      context as unknown as OwnerContext,
    );
    context.requiredToolName = "qq_group_moderation";
    context.requiredToolInput = {
      groupId: GROUP,
      operation: "set_group_ban",
      params: { user_id: 10004, duration: 60 },
    };
    const observe = (
      f.app as unknown as {
        observeBotGroupRoleForModeration(
          context: PiRunContext,
          groupId: string,
          toolInput: Readonly<Record<string, unknown>>,
        ): Promise<BotRoleObservationBinding | undefined>;
      }
    ).observeBotGroupRoleForModeration.bind(f.app);

    const result = await observe(context, GROUP, context.requiredToolInput);
    expect(result?.observation).toEqual({ groupId: GROUP, role: "unknown" });
    await expect(result?.authorize()).resolves.toBeUndefined();
    expect(context.authorizedToolNames).toContain("qq_group_moderation");
    const trace = await f.app.trace.readPage(context.runId!);
    expect(trace.records.map((record) => record.event)).toContainEqual(
      expect.objectContaining({
        type: "bot_native_group_role_observation",
        observationStatus: "failed",
        observedRole: null,
        roleSubject: "configured_bot_account",
      }),
    );
  });
  it("verifies requested mute conditions from fresh QQ state before mutating", async () => {
    const { application, a, context, f } = await configuredGroup(
      "admin",
      () => "member",
      undefined,
      undefined,
      "admin",
      undefined,
      () => 0,
      (userId) => (userId === "10002" ? "admin" : "member"),
    );
    await application.setGroupCategory(a, {
      groupId: GROUP,
      category: "group.moderate",
      enabled: true,
    });
    const runtimeContext = Object.assign(context, {
      recordQqToolExecutionInput: async (
        record: Parameters<NonNullable<PiRunContext["recordQqToolExecutionInput"]>>[0],
      ) => {
        const cursor = await f.app.trace.append(
          context.runId,
          { type: "qq_tool_execution_input_verified", runId: context.runId, ...record },
          "glassbox-tool-evidence",
        );
        await f.app.store.evidence.advanceTrace(context.caller, cursor);
      },
      requiredToolName: "qq_group_moderation",
      requiredToolInput: {
        groupId: GROUP,
        operation: "set_group_ban",
        params: { user_id: 10004, duration: 5 },
      },
      requiredModerationPreconditions: {
        botMustBeAdmin: true,
        targetMustBeOrdinaryMember: true,
        targetMustNotBeMuted: true,
      },
    });
    const moderation = application
      .createRuntimeTools(() => runtimeContext)
      .find((tool) => tool.name === "qq_group_moderation");
    if (!moderation) throw new Error("missing moderation Tool");
    await expect(
      moderation.execute("conditional-mute", {
        operation: "set_group_ban",
        params: { user_id: 10004, duration: 5 },
      }),
    ).resolves.toMatchObject({
      details: {
        providerResult: { status: "ok" },
        verifiedModerationPreconditions: {
          botIsAdmin: true,
          targetIsOrdinaryMember: true,
          targetIsNotMuted: true,
        },
      },
    });
    const memberReadIndex = f.actionLog.findIndex(
      (action) => action.action === "get_group_member_info" && action.params.user_id === 10004,
    );
    const mutationIndex = f.actionLog.findIndex((action) => action.action === "set_group_ban");
    expect(memberReadIndex).toBeGreaterThanOrEqual(0);
    expect(mutationIndex).toBeGreaterThan(memberReadIndex);
    expect(f.actionLog[memberReadIndex]?.params.no_cache).toBe(true);
    const trace = await f.app.trace.readPage(context.runId);
    expect(trace.records.map((record) => record.event)).toContainEqual(
      expect.objectContaining({
        type: "qq_moderation_preconditions",
        targetUserId: "10004",
        verificationStatus: "verified",
        checks: {
          botIsAdmin: true,
          targetIsOrdinaryMember: true,
          targetIsNotMuted: true,
        },
      }),
    );
  });

  it.each([
    { botRole: "member" as const, targetRole: "member" as const, muteUntil: 0 },
    { botRole: "admin" as const, targetRole: "admin" as const, muteUntil: 0 },
    {
      botRole: "admin" as const,
      targetRole: "member" as const,
      muteUntil: () => Math.floor(Date.now() / 1000) + 60,
    },
  ])(
    "does not mute when a requested native precondition is false",
    async ({ botRole, targetRole, muteUntil }) => {
      const { application, a, context, f } = await configuredGroup(
        "admin",
        () => targetRole,
        undefined,
        undefined,
        botRole,
        undefined,
        typeof muteUntil === "function" ? muteUntil : () => muteUntil,
        (userId) => (userId === "10002" ? "admin" : targetRole),
      );
      await application.setGroupCategory(a, {
        groupId: GROUP,
        category: "group.moderate",
        enabled: true,
      });
      const runtimeContext = Object.assign(context, {
        recordQqToolExecutionInput: async (
          record: Parameters<NonNullable<PiRunContext["recordQqToolExecutionInput"]>>[0],
        ) => {
          const cursor = await f.app.trace.append(
            context.runId,
            { type: "qq_tool_execution_input_verified", runId: context.runId, ...record },
            "glassbox-tool-evidence",
          );
          await f.app.store.evidence.advanceTrace(context.caller, cursor);
        },
        requiredToolName: "qq_group_moderation",
        requiredToolInput: {
          groupId: GROUP,
          operation: "set_group_ban",
          params: { user_id: 10004, duration: 5 },
        },
        requiredModerationPreconditions: {
          botMustBeAdmin: true,
          targetMustBeOrdinaryMember: true,
          targetMustNotBeMuted: true,
        },
      });
      const moderation = application
        .createRuntimeTools(() => runtimeContext)
        .find((tool) => tool.name === "qq_group_moderation");
      if (!moderation) throw new Error("missing moderation Tool");
      await expect(
        moderation.execute("conditional-mute", {
          operation: "set_group_ban",
          params: { user_id: 10004, duration: 5 },
        }),
      ).rejects.toBeDefined();
      expect(f.actionLog.some((action) => action.action === "set_group_ban")).toBe(false);
    },
  );

  it.each(["mute", "unmute"] as const)(
    "checks the lease-bound native %s state before invoking the real capability",
    async (phase) => {
      const expected = phase === "mute" ? 0 : Math.floor(Date.now() / 1000) + 60;
      const { application, a, f } = await configuredGroup(
        "member",
        () => "member",
        undefined,
        undefined,
        "admin",
        undefined,
        () => expected,
      );
      await application.setGroupCategory(a, {
        groupId: GROUP,
        category: "group.moderate",
        enabled: true,
      });
      const input = {
        groupId: GROUP,
        operation: "set_group_ban",
        params: { user_id: 10004, duration: phase === "mute" ? 60 : 0 },
      };
      const context: PiRunContext & OwnerContext = {
        ...a,
        recordQqToolExecutionInput: async (record) => {
          const cursor = await f.app.trace.append(
            a.runId,
            {
              type: "qq_tool_execution_input_verified",
              runId: a.runId,
              ...record,
            },
            "glassbox-tool-evidence",
          );
          await f.app.store.evidence.advanceTrace(a.caller, cursor);
        },
        requiredToolName: "qq_group_moderation",
        requiredToolInput: input,
        acceptanceLease: {
          leaseId: "lease-native-state",
          marker: "a".repeat(32),
          toolsSha256: "b".repeat(64),
          assertActive: () => true,
          filterToolNames: (names) => [...names],
          getToolInputRestrictions: () => [
            {
              action: "group:moderate",
              resourceId: "group:" + GROUP,
              inputConstraint: input,
            },
          ],
          checkToolCall: () => true,
          getNativeMuteStatePrecondition: () => ({
            kind: "qq-member-mute-state",
            phase,
            expectedMuteUntil: expected,
          }),
        },
      };
      const tool = application
        .createRuntimeTools(() => context)
        .find((item) => item.name === "qq_group_moderation");
      if (!tool) throw new Error("missing moderation Tool");
      await expect(tool.execute("native-state", input)).resolves.toMatchObject({
        details: { status: "ok" },
      });
      const memberIndex = f.actionLog.findIndex(
        (item) => item.action === "get_group_member_info" && item.params.user_id === 10004,
      );
      const mutationIndex = f.actionLog.findIndex((item) => item.action === "set_group_ban");
      expect(memberIndex).toBeGreaterThanOrEqual(0);
      expect(mutationIndex).toBeGreaterThan(memberIndex);
      expect(f.actionLog[memberIndex]?.params.no_cache).toBe(true);
      const trace = await f.app.trace.readPage(a.runId);
      expect(trace.records.map((record) => record.event)).toContainEqual(
        expect.objectContaining({
          type: "native_mute_state_precondition_verified",
          phase,
          leaseId: "lease-native-state",
        }),
      );
    },
  );

  it.each(["changed", "expired", "lease-revoked"] as const)(
    "refuses %s unmute without calling set_group_ban",
    async (failure) => {
      let active = true;
      const expected = Math.floor(Date.now() / 1000) + (failure === "expired" ? -1 : 60);
      const observed = failure === "changed" ? expected + 60 : expected;
      const { application, a, f } = await configuredGroup(
        "member",
        () => "member",
        undefined,
        undefined,
        "admin",
        async (action) => {
          if (failure === "lease-revoked" && action.action === "get_group_member_info")
            active = false;
        },
        () => observed,
      );
      await application.setGroupCategory(a, {
        groupId: GROUP,
        category: "group.moderate",
        enabled: true,
      });
      const input = {
        groupId: GROUP,
        operation: "set_group_ban",
        params: { user_id: 10004, duration: 0 },
      };
      const context: PiRunContext & OwnerContext = {
        ...a,
        requiredToolName: "qq_group_moderation",
        requiredToolInput: input,
        acceptanceLease: {
          leaseId: "lease-native-denial",
          marker: "c".repeat(32),
          toolsSha256: "d".repeat(64),
          assertActive: () => active,
          filterToolNames: (names) => [...names],
          getToolInputRestrictions: () => [
            {
              action: "group:moderate",
              resourceId: "group:" + GROUP,
              inputConstraint: input,
            },
          ],
          checkToolCall: () => active,
          getNativeMuteStatePrecondition: () => ({
            kind: "qq-member-mute-state",
            phase: "unmute",
            expectedMuteUntil: expected,
          }),
        },
      };
      const tool = application
        .createRuntimeTools(() => context)
        .find((item) => item.name === "qq_group_moderation");
      if (!tool) throw new Error("missing moderation Tool");
      await expect(tool.execute("native-denial", input)).rejects.toThrow(
        failure === "lease-revoked"
          ? "acceptance_lease_denied"
          : "acceptance_mute_state_precondition_denied",
      );
      expect(f.actionLog.some((item) => item.action === "get_group_member_info")).toBe(true);
      expect(f.actionLog.some((item) => item.action === "set_group_ban")).toBe(false);
      const trace = await f.app.trace.readPage(a.runId);
      expect(trace.records.map((record) => record.event)).not.toContainEqual(
        expect.objectContaining({
          type: "native_mute_state_precondition_verified",
        }),
      );
    },
  );
});
