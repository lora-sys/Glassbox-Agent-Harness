import { afterEach, describe, expect, it } from "vite-plus/test";
import { createApplicationFixtureScope } from "./application-test-helpers.js";
import type { ExecutionInput } from "../execution/run-service/types.js";
import {
  AccessDeniedError,
  type CallerContext,
  type TrustedChannelScope,
} from "../persistence/index.js";
import { classifyProtectedReadAction } from "../auth/service.js";
import { createCapabilityTools } from "../runtime/pi/capability-tools.js";
import { createProtectedTool } from "../runtime/pi/protected-tools.js";
import { Type } from "typebox";
import { OWNER_CONTROL_RESOURCE, OWNER_GROUP_ADMIN_TOOL } from "../runtime/pi/owner-tools.js";
import { admin, type OwnerContext } from "./application-test-helpers.js";

const { fixture, afterEachCleanup } = createApplicationFixtureScope();
afterEach(afterEachCleanup);

/**
 * Delivery of a history-derived answer is a separate authorization decision from the read
 * that produced it.
 *
 * These tests drive the real path end to end rather than the Gate in isolation: the group is
 * enabled through the real Owner action, the real history Tool reads it inside a real Run and
 * records its `history:read` decision against that Run, and the Delivery Gate re-decides the
 * answer's exact source at delivery time. Nothing is stubbed, so a missing explicit
 * `delivery:send` grant is a real denial. This is the defect two real Runs hit, where
 * `history:read` was ALLOW for `group:<id>` and `delivery:send` was `DENY no_grant` on that
 * same Resource.
 */
describe("group history delivery authority", () => {
  const CO_OWNER = "10006";
  const GROUP_ID = 10005;
  const GROUP = String(GROUP_ID);
  const OTHER_GROUP_ID = 10007;
  const OTHER_GROUP = String(OTHER_GROUP_ID);
  /** The protected group text a history answer is derived from. */
  const GROUP_MESSAGE = "P4B-A-1349 is the ticket";
  /** Only a Run whose text asks for it searches history, so each test names the Run that reads. */
  const SEARCH = "search:";

  /** A peer that answers every group with the same archived messages. */
  const answeredHistory =
    (texts: readonly string[] = [GROUP_MESSAGE]) =>
    (params: { group_id?: number }) =>
      texts.map((text, index) => ({
        message_id: index + 1,
        message_seq: index + 1,
        real_id: index + 1,
        time: 1_758_000_000 + index,
        user_id: 10004,
        group_id: params.group_id,
        message_type: "group",
        sender: { user_id: 10004, nickname: "Visitor" },
        message: [{ type: "text", data: { text } }],
      }));

  const scopeFor = (chatType: "group" | "private", chatId: string, senderId: string) =>
    ({
      connectionId: "fixture",
      botId: "10001",
      chatType,
      chatId,
      senderId,
    }) as TrustedChannelScope;
  const coOwnerPrivate = scopeFor("private", CO_OWNER, CO_OWNER);
  const ownerContext = (input: ExecutionInput): OwnerContext => ({
    caller: input.caller,
    conversationId: input.conversation.id,
    runId: input.run.id,
  });

  /**
   * The real Tool surface for one Run, built the way the Runtime builds it: from the Run's own
   * caller, Conversation and Run id. A Tool call therefore records its decisions against the
   * Run that made it.
   */
  const callHistoryTool = async (
    application: ReturnType<typeof admin>,
    input: ExecutionInput,
    params: Record<string, unknown>,
  ) => {
    const name =
      input.caller.scope.chatType === "private" ? "owner_history_search" : "group_history_search";
    const tool = application
      .createRuntimeTools(() => ownerContext(input))
      .find((candidate) => candidate.name === name);
    if (!tool) throw new Error(`missing ${name}`);
    return (await tool.execute("call", params)).details as { groups: string[] };
  };

  /**
   * A fixture whose executor searches history before answering, exactly as the real Run did.
   *
   * `searches` records the authorized source set of every Run that searched, so a test can
   * prove both what was readable and what was not.
   */
  async function historyFixture(options: { persistentDatabase?: boolean } = {}) {
    const searches: string[][] = [];
    let application!: ReturnType<typeof admin>;
    const f = await fixture(
      async (input) => {
        if (input.text.startsWith(SEARCH))
          searches.push(
            (await callHistoryTool(application, input, { query: "P4B-A-1349" })).groups,
          );
        return { status: "succeeded", text: `answer:${input.text}` };
      },
      {
        coOwnerId: CO_OWNER,
        history: answeredHistory(),
        ...(options.persistentDatabase === undefined
          ? {}
          : { persistentDatabase: options.persistentDatabase }),
      },
    );
    application = admin(f.app);
    return { f, application, searches };
  }

  /** Opens a fixture and returns one real Owner-private Run context per Owner. */
  async function twoOwners(options: { persistentDatabase?: boolean } = {}) {
    const fixtureState = await historyFixture(options);
    const { f } = fixtureState;
    f.send(1, "owner-a", true, 10002);
    const ownerA = await f.started.take();
    await f.reply("answer:owner-a");
    f.send(2, "owner-b", true, Number(CO_OWNER));
    const ownerB = await f.started.take();
    await f.reply("answer:owner-b");
    return {
      ...fixtureState,
      a: ownerContext(ownerA),
      b: ownerContext(ownerB),
    };
  }

  /** Every decision this Principal holds in this exact scope, across pages. */
  type FixtureResult = Awaited<ReturnType<typeof fixture>>;
  type RawApplication = Awaited<ReturnType<FixtureResult["reopen"]>>;

  const decisionsFor = async (
    f: Awaited<ReturnType<typeof fixture>>,
    caller: CallerContext,
    app: RawApplication = f.app,
  ) => {
    const items: Array<{
      resourceId: string;
      action: string;
      decision: string;
      reason: string;
      deliverySource: string | null;
      runId: string | null;
      conversationId: string | null;
    }> = [];
    let cursor: string | undefined;
    do {
      const page = await app.store.evidence.listDecisions(caller, "personal", {
        limit: 100,
        ...(cursor === undefined ? {} : { cursor }),
      });
      items.push(...page.items);
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    return items;
  };

  const deliveryDecision = (
    f: Awaited<ReturnType<typeof fixture>>,
    caller: CallerContext,
    resourceId: string,
  ) => f.app.store.authorization.check({ caller, resourceId, action: "delivery:send" });

  it("classifies content reads, protected search gates and write Actions", () => {
    for (const action of [
      "read",
      "context:read",
      "qq:capability:read",
      "group:read",
      "group:members:read",
      "group:content:read",
      "group:files:read",
      "history:read",
      "account:status:read",
      "task:list",
      "worker:status",
    ])
      expect(classifyProtectedReadAction(action, "qq_group"), action).toBe("content_source");

    expect(classifyProtectedReadAction("history:search", "owner-history")).toBe("access_gate");
    expect(classifyProtectedReadAction("history:search", undefined)).toBe("access_gate");
    expect(classifyProtectedReadAction("web:search", "web-public")).toBeUndefined();
    expect(classifyProtectedReadAction("web:fetch", "web-public")).toBeUndefined();

    for (const action of [
      "run:create",
      "delivery:send",
      "group:settings:write",
      "group:moderate",
      "task:delegate",
      "worker:prompt",
    ])
      expect(classifyProtectedReadAction(action, "qq_group"), action).toBeUndefined();
  });

  it("delivers a group Run's own history answer back into that same group", async () => {
    const { f, application, searches } = await historyFixture();
    f.send(1, "owner-a", true, 10002);
    const ownerA = await f.started.take();
    await f.reply("answer:owner-a");
    await application.setGroupAccess(ownerContext(ownerA), { groupId: GROUP, enabled: true });

    f.send(2, `${SEARCH}本群历史里的 P4B-A-1349`, false, 10002, GROUP_ID);
    const run = await f.started.take();
    await f.app.runs.waitForRun(run.caller, run.run.id);
    await f.app.runs.drain();

    // The Run really read this group's protected history, and the answer really reached the
    // group: reading was not delivering, and the separate decision let it out.
    expect(searches.at(-1)).toEqual([GROUP]);
    const deliveries = await f.app.store.lifecycle.listDeliveries(run.caller, run.run.id);
    expect(deliveries.items.map((delivery) => delivery.payloadText)).toEqual([
      `answer:${SEARCH}本群历史里的 P4B-A-1349`,
    ]);
    expect(deliveries.items[0]!.status).toBe("sent");

    // The Trace records the sent outcome, and carries no protected message text.
    const trace = await f.app.trace.readPage(run.run.id);
    expect(
      trace.records.some((record) => {
        const event = record.event as { type?: string; status?: string };
        return event.type === "delivery_changed" && event.status === "sent";
      }),
    ).toBe(true);
    expect(JSON.stringify(trace)).not.toContain(GROUP_MESSAGE);
  });

  it("lets an Owner receive an assigned group's history answer in that Owner's private chat", async () => {
    const { f, application, searches } = await historyFixture();
    f.send(1, "owner-a", true, 10002);
    const ownerA = await f.started.take();
    await f.reply("answer:owner-a");
    const a = ownerContext(ownerA);
    await application.setGroupAccess(a, { groupId: GROUP, enabled: true });

    f.send(2, `${SEARCH}已授权群里的 P4B-A-1349`, true, 10002);
    const run = await f.started.take();
    await f.app.runs.waitForRun(run.caller, run.run.id);
    await f.app.runs.drain();

    // The cross-group answer stays Owner-private, and it is delivered only because this Owner
    // holds the explicit delivery authority on the group that was read.
    expect(searches.at(-1)).toEqual([GROUP]);
    const deliveries = await f.app.store.lifecycle.listDeliveries(run.caller, run.run.id);
    expect(deliveries.items.map((delivery) => delivery.payloadText)).toEqual([
      `answer:${SEARCH}已授权群里的 P4B-A-1349`,
    ]);
    expect(deliveries.items[0]!.status).toBe("sent");

    // Keep delivery permission in place while revoking only the history source. The same Run
    // cannot reuse its earlier read decision for a later answer or retry.
    await f.app.store.authorization.revokeScopeAction({
      principalId: a.caller.principalId,
      resourceId: `group:${GROUP}`,
      action: "history:read",
      scope: a.caller.scope,
    });
    await expect(
      f.app.store.lifecycle.createDelivery(run.caller, {
        runId: run.run.id,
        dedupKey: "history-source-revoked",
        destination: run.caller.scope,
        payloadText: `answer:${SEARCH}已授权群里的 P4B-A-1349`,
        payloadKind: "result",
      }),
    ).rejects.toBeInstanceOf(AccessDeniedError);
    const records = (await decisionsFor(f, run.caller)).filter(
      (record) =>
        record.runId === run.run.id &&
        record.resourceId === `group:${GROUP}` &&
        record.action === "history:read",
    );
    expect(records.some((record) => record.decision === "ALLOW")).toBe(true);
    expect(records.some((record) => record.decision === "DENY")).toBe(true);
  });

  it("rechecks a protected history search gate without requiring delivery on its gate Resource", async () => {
    const { f, application, searches } = await historyFixture({ persistentDatabase: true });
    f.send(1, "owner-a", true, 10002);
    const ownerA = await f.started.take();
    await f.reply("answer:owner-a");
    const a = ownerContext(ownerA);
    await application.setGroupAccess(a, { groupId: GROUP, enabled: true });

    f.send(2, `${SEARCH}已授权群里的 P4B-A-1349`, true, 10002);
    const run = await f.started.take();
    await f.app.runs.waitForRun(run.caller, run.run.id);
    await f.app.runs.drain();
    expect(searches.at(-1)).toEqual([GROUP]);
    expect((await deliveryDecision(f, run.caller, "owner-history")).decision).toBe("DENY");
    const groupReads = (await decisionsFor(f, run.caller)).filter(
      (record) =>
        record.runId === run.run.id &&
        record.resourceId === `group:${GROUP}` &&
        record.action === "history:read",
    );
    expect(groupReads.some((record) => record.decision === "ALLOW")).toBe(true);
    expect(
      groupReads.some(
        (record) => record.decision === "ALLOW" && record.deliverySource === "content_source",
      ),
    ).toBe(true);
    const searchGateDecisions = (await decisionsFor(f, run.caller)).filter(
      (record) =>
        record.runId === run.run.id &&
        record.resourceId === "owner-history" &&
        record.action === "history:search",
    );
    expect(searchGateDecisions.some((record) => record.decision === "ALLOW")).toBe(true);
    expect(
      searchGateDecisions.some(
        (record) => record.decision === "ALLOW" && record.deliverySource === "access_gate",
      ),
    ).toBe(true);

    const deliveryId = await f.app.store.lifecycle.createDelivery(run.caller, {
      runId: run.run.id,
      dedupKey: "history-search-retry",
      destination: run.caller.scope,
      payloadText: "history-derived-retry-payload",
      payloadKind: "result",
    });
    const lease = await f.app.store.lifecycle.claimDelivery(run.caller, run.run.id, deliveryId);
    if (!lease) throw new Error("missing delivery lease");
    await lease.settle("failed");

    const reopened = await f.reopen();
    await reopened.store.authorization.revokeScopeAction({
      principalId: a.caller.principalId,
      resourceId: "owner-history",
      action: "history:search",
      scope: a.caller.scope,
    });
    await expect(
      reopened.store.lifecycle.transitionDelivery(
        run.caller,
        run.run.id,
        deliveryId,
        "failed",
        "pending",
      ),
    ).rejects.toBeInstanceOf(AccessDeniedError);

    const records = (await decisionsFor(f, run.caller, reopened)).filter(
      (record) =>
        record.runId === run.run.id &&
        record.resourceId === "owner-history" &&
        record.action === "history:search",
    );
    expect(records.some((record) => record.decision === "ALLOW")).toBe(true);
    expect(
      records.some(
        (record) => record.decision === "ALLOW" && record.deliverySource === "access_gate",
      ),
    ).toBe(true);
    expect(records.some((record) => record.decision === "DENY")).toBe(true);
    expect(JSON.stringify(records)).not.toContain("history-derived-retry-payload");
  });

  it("rechecks an ordinary read source before retrying a failed delivery", async () => {
    const { f, application } = await historyFixture();
    f.send(1, "owner-a", true, 10002);
    const owner = await f.started.take();
    await f.reply("answer:owner-a");
    const context = ownerContext(owner);
    await application.setGroupAccess(context, { groupId: GROUP, enabled: true });

    // Use the ordinary `read` Action on a protected Resource, as generic protected Tools do.
    await f.app.store.authorization.grant({
      principalId: context.caller.principalId,
      resourceId: `group:${GROUP}`,
      action: "read",
      scope: context.caller.scope,
      effect: "allow",
    });
    const tool = createProtectedTool({
      name: "ordinary_protected_read",
      description: "Read protected group content.",
      parameters: Type.Object({}, { additionalProperties: false }),
      action: "read",
      deliverySource: "content_source",
      resourceId: `group:${GROUP}`,
      authService: f.app.store.authorization,
      getContext: () => context,
      execute: async () => "ordinary protected content",
    });
    const source = await tool.execute("ordinary-read", {}, undefined, undefined, {} as never);
    expect(source.details).toBe("ordinary protected content");

    const deliveryId = await f.app.store.lifecycle.createDelivery(context.caller, {
      runId: context.runId,
      dedupKey: "ordinary-read-retry",
      destination: context.caller.scope,
      payloadText: "ordinary-read-answer",
      payloadKind: "result",
    });
    const lease = await f.app.store.lifecycle.claimDelivery(
      context.caller,
      context.runId,
      deliveryId,
    );
    if (!lease) throw new Error("missing delivery lease");
    await lease.settle("failed");

    await f.app.store.authorization.revokeScopeAction({
      principalId: context.caller.principalId,
      resourceId: `group:${GROUP}`,
      action: "read",
      scope: context.caller.scope,
    });
    await expect(
      f.app.store.lifecycle.transitionDelivery(
        context.caller,
        context.runId,
        deliveryId,
        "failed",
        "pending",
      ),
    ).rejects.toBeInstanceOf(AccessDeniedError);

    const records = (await decisionsFor(f, context.caller)).filter(
      (record) =>
        record.runId === context.runId &&
        record.resourceId === `group:${GROUP}` &&
        record.action === "read",
    );
    expect(records.some((record) => record.decision === "ALLOW")).toBe(true);
    expect(
      records.some(
        (record) => record.decision === "ALLOW" && record.deliverySource === "content_source",
      ),
    ).toBe(true);
    expect(records.some((record) => record.decision === "DENY")).toBe(true);
  });

  it("rechecks a QQ group:members:read decision before creating a delivery", async () => {
    const { f, application } = await historyFixture();
    f.send(1, "owner-a", true, 10002);
    const owner = await f.started.take();
    await f.reply("answer:owner-a");
    const context = ownerContext(owner);
    const configuredGroup = "10003";
    await application.setGroupAccess(context, { groupId: configuredGroup, enabled: true });
    await application.setGroupCategory(context, {
      groupId: configuredGroup,
      category: "group.members",
      enabled: true,
    });

    const tools = createCapabilityTools({
      store: f.app.store,
      getContext: () => context,
      isCategoryEnabled: async () => true,
      invoke: async ({ params }) => ({
        group_id: params.group_id,
        user_id: params.user_id,
        role: "member",
      }),
      search: async () => [],
      projectManagedGroups: async () => [],
    });
    const members = tools.find((tool) => tool.name === "qq_group_members");
    if (!members) throw new Error("missing qq_group_members");
    const result = await members.execute(
      "member-read",
      {
        groupId: configuredGroup,
        operation: "get_group_member_info",
        params: { user_id: "10004" },
      },
      undefined,
      undefined,
      {} as never,
    );
    expect(result.details).toEqual({ role: "qq_group_member" });

    await application.setGroupCategory(context, {
      groupId: configuredGroup,
      category: "group.members",
      enabled: false,
    });
    expect((await deliveryDecision(f, context.caller, `group:${configuredGroup}`)).decision).toBe(
      "ALLOW",
    );
    await expect(
      f.app.store.lifecycle.createDelivery(context.caller, {
        runId: context.runId,
        dedupKey: "member-source-revoked",
        destination: context.caller.scope,
        payloadText: "member-derived-answer",
        payloadKind: "result",
      }),
    ).rejects.toBeInstanceOf(AccessDeniedError);

    const records = (await decisionsFor(f, context.caller)).filter(
      (record) =>
        record.runId === context.runId &&
        record.resourceId === `group:${configuredGroup}` &&
        record.action === "group:members:read",
    );
    expect(records.some((record) => record.decision === "ALLOW")).toBe(true);
    expect(
      records.some(
        (record) => record.decision === "ALLOW" && record.deliverySource === "content_source",
      ),
    ).toBe(true);
    expect(records.some((record) => record.decision === "DENY")).toBe(true);
  });

  it("allows Owner-private control reads to be delivered without granting them to group visitors", async () => {
    const { f, application } = await historyFixture();
    f.send(1, "owner-control-read", true, 10002);
    const ownerRun = await f.started.take();
    await f.reply("answer:owner-control-read");
    const owner = ownerContext(ownerRun);
    await application.setGroupAccess(owner, { groupId: GROUP, enabled: true });

    const groupAdmin = application
      .createRuntimeTools(() => owner)
      .find((tool) => tool.name === OWNER_GROUP_ADMIN_TOOL);
    if (!groupAdmin) throw new Error("missing owner group admin tool");
    const read = await groupAdmin.execute("owner-group-read", { action: "get", groupId: GROUP });
    expect(read.details).toBeDefined();
    const ownerDelivery = await f.app.store.lifecycle.createDelivery(owner.caller, {
      runId: owner.runId,
      dedupKey: "owner-control-read-delivery",
      destination: owner.caller.scope,
      payloadText: "owner-control-result",
      payloadKind: "result",
    });
    expect(ownerDelivery).toBeTruthy();

    f.send(2, "visitor-control-read", false, 10004, GROUP_ID);
    const visitorRun = await f.started.take();
    const visitorDelivery = await f.app.store.authorization.check({
      caller: visitorRun.caller,
      resourceId: OWNER_CONTROL_RESOURCE,
      action: "delivery:send",
    });
    expect(visitorDelivery.decision).toBe("DENY");
  });

  it("holds delivery authority for one assigned group in one scope, never for another", async () => {
    const { f, application, a, b } = await twoOwners();
    await application.setGroupAccess(a, { groupId: GROUP, enabled: true });
    await application.setGroupAccess(b, { groupId: OTHER_GROUP, enabled: true });

    // Each Owner's private chat may receive only the group that Owner assigned.
    expect((await deliveryDecision(f, a.caller, `group:${GROUP}`)).decision).toBe("ALLOW");
    expect((await deliveryDecision(f, a.caller, `group:${OTHER_GROUP}`)).decision).toBe("DENY");
    expect((await deliveryDecision(f, b.caller, `group:${OTHER_GROUP}`)).decision).toBe("ALLOW");
    // Sibling Owners keep independent private authority: one Owner's assignment never carries
    // the other Owner's chat.
    expect((await deliveryDecision(f, b.caller, `group:${GROUP}`)).decision).toBe("DENY");

    // A Run inside group G may answer into G. Another group's audience is never a
    // destination for G's derived content.
    expect(
      (
        await deliveryDecision(
          f,
          { principalId: "owner", scope: scopeFor("group", GROUP, "10002") },
          `group:${GROUP}`,
        )
      ).decision,
    ).toBe("ALLOW");
    expect(
      (
        await deliveryDecision(
          f,
          { principalId: "owner", scope: scopeFor("group", OTHER_GROUP, "10002") },
          `group:${GROUP}`,
        )
      ).decision,
    ).toBe("DENY");
  });

  it("grants no delivery authority from bot membership or a configured transport group alone", async () => {
    const { f } = await historyFixture();
    f.send(1, "owner-a", true, 10002);
    const ownerA = await f.started.take();
    await f.reply("answer:owner-a");
    const a = ownerContext(ownerA);

    // Group 10003 is in this connection's configured transport list and the Bot is in it, but
    // no Owner assigned it: the Resource exists and still carries no authority at all.
    const decided = (resourceId: string, action: string) =>
      f.app.store.authorization.check({ caller: a.caller, resourceId, action });
    expect((await decided("group:10003", "group:manage")).decision).toBe("DENY");
    expect((await decided("group:10003", "history:read")).decision).toBe("DENY");
    expect((await decided("group:10003", "delivery:send")).decision).toBe("DENY");

    // A group the Bot happens to be in that Glassbox never configured is not even a Resource,
    // so it can never become a delivery destination.
    expect((await decided(`group:${GROUP}`, "delivery:send")).decision).toBe("DENY");
  });

  it("gives a Visitor private chat no authority over an assigned group", async () => {
    const { f, application } = await historyFixture();
    f.send(1, "owner-a", true, 10002);
    const ownerA = await f.started.take();
    await f.reply("answer:owner-a");
    await application.setGroupAccess(ownerContext(ownerA), { groupId: GROUP, enabled: true });

    f.send(2, "visitor-private", true, 10004);
    const visitor = await f.started.take();
    await f.app.runs.waitForRun(visitor.caller, visitor.run.id);
    await f.app.runs.drain();
    expect(visitor.caller.principalId).toBe("qq-visitor-10004");

    // A Visitor is not an Owner: no assignment, no read, no delivery authority.
    const decided = (action: string) =>
      f.app.store.authorization.check({
        caller: visitor.caller,
        resourceId: `group:${GROUP}`,
        action,
      });
    expect((await decided("group:manage")).decision).toBe("DENY");
    expect((await decided("history:read")).decision).toBe("DENY");
    expect((await decided("delivery:send")).decision).toBe("DENY");
  });

  it("records a separate delivery:send denial for the exact Run that read the group", async () => {
    const { f, application, searches } = await historyFixture();
    f.send(1, "owner-a", true, 10002);
    const ownerA = await f.started.take();
    await f.reply("answer:owner-a");
    const a = ownerContext(ownerA);
    await application.setGroupAccess(a, { groupId: GROUP, enabled: true });

    f.send(2, `${SEARCH}已授权群里的 P4B-A-1349`, true, 10002);
    const run = await f.started.take();
    await f.app.runs.waitForRun(run.caller, run.run.id);
    await f.app.runs.drain();
    expect(searches.at(-1)).toEqual([GROUP]);

    // The state the real Runs hit: the Run's read of this group is authorized, and delivery
    // authority on that same Resource is not. Reading it is not a licence to send it.
    await f.app.store.authorization.revokeScopeAction({
      principalId: "owner",
      resourceId: `group:${GROUP}`,
      action: "delivery:send",
      scope: a.caller.scope,
    });
    await expect(
      f.app.store.lifecycle.createDelivery(run.caller, {
        runId: run.run.id,
        dedupKey: "after-revoke",
        destination: run.caller.scope,
        payloadText: `answer:${SEARCH}已授权群里的 P4B-A-1349`,
        payloadKind: "result",
      }),
    ).rejects.toBeInstanceOf(AccessDeniedError);

    // The denial is durable evidence about this exact Run in this exact Conversation, and it
    // explains itself without copying the payload the Run was trying to send.
    const decided = (await decisionsFor(f, run.caller)).filter(
      (record) => record.runId === run.run.id && record.resourceId === `group:${GROUP}`,
    );
    expect(decided.find((record) => record.action === "history:read")?.decision).toBe("ALLOW");
    const refused = decided.find(
      (record) => record.action === "delivery:send" && record.decision === "DENY",
    );
    expect(refused?.reason).toBe("no_grant");
    expect(refused?.conversationId).toBe(run.conversation.id);
    expect(JSON.stringify(decided)).not.toContain(GROUP_MESSAGE);
  });

  it("traces a blocked delivery outcome without copying the answer", async () => {
    const { f, application } = await historyFixture();
    f.send(1, "owner-a", true, 10002);
    const ownerA = await f.started.take();
    await f.reply("answer:owner-a");
    const a = ownerContext(ownerA);
    await application.setGroupAccess(a, { groupId: GROUP, enabled: true });
    // Delivery authority is withdrawn before the Run that reads the group, so the Run itself is
    // the one whose answer is refused.
    await f.app.store.authorization.revokeScopeAction({
      principalId: "owner",
      resourceId: `group:${GROUP}`,
      action: "delivery:send",
      scope: a.caller.scope,
    });

    f.send(2, `${SEARCH}已授权群里的 P4B-A-1349`, true, 10002);
    const run = await f.started.take();
    await f.app.runs.waitForRun(run.caller, run.run.id);
    await f.app.runs.drain();

    // Nothing was sent, and the refusal is inspectable: which Run, which Conversation, which
    // decision and why, never the text that could not be delivered.
    expect((await f.app.store.lifecycle.listDeliveries(run.caller, run.run.id)).items).toEqual([]);
    const trace = await f.app.trace.readPage(run.run.id);
    const blocked = trace.records.find(
      (record) => (record.event as { type?: string }).type === "delivery_denied",
    );
    expect(blocked?.event).toMatchObject({
      runId: run.run.id,
      conversationId: run.conversation.id,
      decision: "DENY",
      reason: "no_grant",
    });
    expect(JSON.stringify(trace)).not.toContain(GROUP_MESSAGE);
    // A result that could not reach its audience must not silently become Conversation
    // history for a later Run. A second exclusion returns false because publication already
    // recorded the append-only context exclusion.
    expect(await f.app.store.conversations.excludeRunFromContext(run.caller, run.run.id)).toBe(
      false,
    );
  });

  it("removes delivery authority with the assignment, before the next Run", async () => {
    const { f, application, searches } = await historyFixture();
    f.send(1, "owner-a", true, 10002);
    const ownerA = await f.started.take();
    await f.reply("answer:owner-a");
    const a = ownerContext(ownerA);
    await application.setGroupAccess(a, { groupId: GROUP, enabled: true });

    f.send(2, `${SEARCH}已授权群里的 P4B-A-1349`, true, 10002);
    const authorized = await f.started.take();
    await f.app.runs.waitForRun(authorized.caller, authorized.run.id);
    await f.app.runs.drain();
    expect(searches.at(-1)).toEqual([GROUP]);
    expect(
      (await f.app.store.lifecycle.listDeliveries(authorized.caller, authorized.run.id)).items,
    ).toHaveLength(1);

    await application.setGroupAccess(a, { groupId: GROUP, enabled: false });
    expect((await deliveryDecision(f, a.caller, `group:${GROUP}`)).decision).toBe("DENY");

    // The Run that already read this group can no longer answer with it: the source and the
    // delivery authority are both re-decided at delivery time rather than remembered.
    await expect(
      f.app.store.lifecycle.createDelivery(authorized.caller, {
        runId: authorized.run.id,
        dedupKey: "after-revoke",
        destination: authorized.caller.scope,
        payloadText: `answer:${SEARCH}已授权群里的 P4B-A-1349`,
        payloadKind: "result",
      }),
    ).rejects.toBeInstanceOf(AccessDeniedError);

    // And the next Run cannot even read it: the source set is resolved before any load.
    f.send(3, `${SEARCH}已撤销群里的 P4B-A-1349`, true, 10002);
    const afterRevoke = await f.started.take();
    await f.app.runs.waitForRun(afterRevoke.caller, afterRevoke.run.id);
    await f.app.runs.drain();
    expect(searches.at(-1)).toEqual([]);
  });

  it("backfills the explicit delivery grant for a persisted assignment across a restart", async () => {
    const { f, application, a } = await twoOwners({ persistentDatabase: true });
    await application.setGroupAccess(a, { groupId: GROUP, enabled: true });

    // The database the previous version left behind: the assignment and its read authority
    // persisted, the explicit delivery grant never written.
    await f.app.store.authorization.revokeScopeAction({
      principalId: "owner",
      resourceId: `group:${GROUP}`,
      action: "delivery:send",
      scope: a.caller.scope,
    });
    expect((await deliveryDecision(f, a.caller, `group:${GROUP}`)).decision).toBe("DENY");

    // Restart: the Channel reconnects and the backfill restores the persisted assignment's
    // delivery authority, so the Owner never has to remove and re-add the group.
    const restartedApp = await f.reopen();
    admin(restartedApp);
    expect(
      (
        await restartedApp.store.authorization.check({
          caller: a.caller,
          resourceId: `group:${GROUP}`,
          action: "delivery:send",
        })
      ).decision,
    ).toBe("ALLOW");
    expect(
      (
        await restartedApp.store.authorization.check({
          caller: a.caller,
          resourceId: `group:${GROUP}`,
          action: "history:read",
        })
      ).decision,
    ).toBe("ALLOW");

    // The backfill restores assignments; it never manufactures one. The sibling Owner assigned
    // nothing, so the restart leaves them with no assignment and no delivery authority.
    expect(
      await restartedApp.store.authorization.hasActiveGrant({
        principalId: `owner-${CO_OWNER}`,
        resourceId: `group:${GROUP}`,
        action: "group:manage",
        scope: coOwnerPrivate,
      }),
    ).toBe(false);
    expect(
      await restartedApp.store.authorization.hasActiveGrant({
        principalId: `owner-${CO_OWNER}`,
        resourceId: `group:${GROUP}`,
        action: "delivery:send",
        scope: coOwnerPrivate,
      }),
    ).toBe(false);
  });

  it("backfills the explicit delivery grant for a persisted assignment on reconnect", async () => {
    const { f, application, a } = await twoOwners();
    await application.setGroupAccess(a, { groupId: GROUP, enabled: true });
    await f.app.store.authorization.revokeScopeAction({
      principalId: "owner",
      resourceId: `group:${GROUP}`,
      action: "delivery:send",
      scope: a.caller.scope,
    });
    expect((await deliveryDecision(f, a.caller, `group:${GROUP}`)).decision).toBe("DENY");

    // A reconnect runs the same provisioning as a restart, against the same durable state.
    await f.app.disconnectChannel("fixture");
    await f.app.connectChannel("fixture");

    expect((await deliveryDecision(f, a.caller, `group:${GROUP}`)).decision).toBe("ALLOW");
    // The Owner's own assignment is untouched, and still the only one.
    expect(await application.projectManagedGroups(a)).toMatchObject({
      groups: [{ groupId: GROUP, access: { assigned: true } }],
    });
    expect(
      await f.app.store.authorization.hasActiveGrant({
        principalId: `owner-${CO_OWNER}`,
        resourceId: `group:${GROUP}`,
        action: "delivery:send",
        scope: coOwnerPrivate,
      }),
    ).toBe(false);
  });
});
