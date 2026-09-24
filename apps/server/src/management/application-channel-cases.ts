import { afterEach, describe, expect, it } from "vite-plus/test";
import { createApplicationFixtureScope } from "./application-test-helpers.js";
import { once } from "node:events";
import { mkdtemp } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocketServer } from "ws";
import { ModelProfileStore } from "../config/model-profiles.js";
import { ChannelProfileStore } from "../config/channel-profiles.js";
import type { ExecutionInput, ExecutionResult } from "../execution/run-service/types.js";
import type { TrustedChannelScope } from "../persistence/index.js";
import { ManagementApplication } from "./application.js";

const { fixture, afterEachCleanup, cleanup, removeDirectory } = createApplicationFixtureScope();
afterEach(afterEachCleanup);

describe("channel to durable run composition", () => {
  it("returns zeroed ingress diagnostics when a managed group has no Runs yet", async () => {
    const f = await fixture(async () => ({ status: "succeeded", text: "unused" }));
    const ownerScope: TrustedChannelScope = {
      connectionId: "fixture",
      botId: "10001",
      chatType: "private",
      chatId: "10002",
      senderId: "10002",
    };
    await f.app.store.authorization.grant({
      principalId: "owner",
      resourceId: "group:10003",
      action: "group:manage",
      scope: ownerScope,
      effect: "allow",
    });

    const result = await f.app.route({
      method: "GET",
      url: "/manage/group-role-audit?channelId=fixture&groupId=10003",
    } as never);

    expect(result?.status).toBe(200);
    expect(result?.body).toMatchObject({
      audits: [],
      ingressDiagnostics: {
        serviceStartedAt: expect.any(String),
        lastObservedAt: null,
        normalized: 0,
        ignoredNotAddressed: 0,
        ignoredEmptyMessage: 0,
        rejectedInvalidMessage: 0,
        rejectedUnsupportedMessage: 0,
        rejectedOverflow: 0,
        acceptanceFailed: 0,
      },
    });
  });

  it("exposes Tool-plane diagnostics only for the current Owner's Run", async () => {
    const f = await fixture(async () => ({ status: "succeeded", text: "private answer" }), {
      coOwnerId: "10005",
    });
    f.send(1, "owner-private", true);
    const ownerRun = await f.started.take();
    await f.app.runs.waitForRun(ownerRun.caller, ownerRun.run.id);

    const ownerResult = await f.app.route({
      method: "GET",
      url: `/manage/runs/${ownerRun.run.id}/tool-plane`,
    } as never);
    expect(ownerResult?.status).toBe(200);
    expect(ownerResult?.body).toMatchObject({
      runId: ownerRun.run.id,
      trace: { complete: true },
      surface: { observed: false, selectedCount: 0, tools: [] },
    });
    expect(JSON.stringify(ownerResult?.body)).not.toContain("private answer");

    f.send(2, "visitor-private", true, 10004);
    const visitorRun = await f.started.take();
    await f.app.runs.waitForRun(visitorRun.caller, visitorRun.run.id);
    await expect(
      f.app.route({
        method: "GET",
        url: `/manage/runs/${visitorRun.run.id}/tool-plane`,
      } as never),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    f.send(3, "another-owner-private", true, 10005);
    const foreignOwnerRun = await f.started.take();
    await f.app.runs.waitForRun(foreignOwnerRun.caller, foreignOwnerRun.run.id);
    await expect(
      f.app.route({
        method: "GET",
        url: `/manage/runs/${foreignOwnerRun.run.id}/tool-plane`,
      } as never),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("shows a payload-free role audit only for Visitor Runs in a group assigned to the Owner", async () => {
    const f = await fixture(async () => ({ status: "succeeded", text: "visitor reply" }));
    await expect(
      f.app.route({
        method: "GET",
        url: "/manage/group-role-audit?channelId=fixture&groupId=10003",
      } as never),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    const ownerScope: TrustedChannelScope = {
      connectionId: "fixture",
      botId: "10001",
      chatType: "private",
      chatId: "10002",
      senderId: "10002",
    };
    await f.app.store.authorization.grant({
      principalId: "owner",
      resourceId: "group:10003",
      action: "group:manage",
      scope: ownerScope,
      effect: "allow",
    });

    f.send(1, "禁言成员 10005 10秒", false, 10004, 10003, "admin");
    const visitorRun = await f.started.take();
    await f.app.runs.waitForRun(visitorRun.caller, visitorRun.run.id);
    await f.reply("visitor reply");

    const canary = "never-return-this-message-or-provider-payload";
    const events = [
      {
        type: "session_start",
        data: {
          toolSurface: {
            selected: [{ name: "qq_group_moderation", providerReadiness: "ready" }],
            excluded: [{ name: "qq_group_settings", reason: "scope_not_permitted" }],
          },
        },
      },
      { type: "message_chunk", data: { text: canary } },
      {
        type: "tool_call",
        data: {
          toolCallId: "call-audit-1",
          name: "qq_group_moderation",
          arguments: { user_id: 10005, duration: 10, raw: canary },
        },
      },
      {
        type: "native_group_role_verification",
        resourceId: "group:10003",
        groupId: "10003",
        senderId: "10004",
        observedRole: "qq_group_admin",
        verifiedRole: "qq_group_admin",
        verificationStatus: "verified",
        requestedTool: "qq_group_moderation",
        requestedOperation: "set_group_ban",
        authorizationDecision: "ALLOW",
      },
      {
        type: "tool_result",
        data: {
          toolCallId: "call-audit-1",
          name: "qq_group_moderation",
          isError: false,
          result: canary,
          providerError: canary,
        },
      },
    ];
    for (const event of events)
      await f.app.trace.append(visitorRun.run.id, event, "test-audit-fixture");

    await expect(
      f.app.route({
        method: "GET",
        url: "/manage/group-role-audit?channelId=fixture&groupId=10006",
      } as never),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    const result = await f.app.route({
      method: "GET",
      url: "/manage/group-role-audit?channelId=fixture&groupId=10003",
    } as never);
    expect(result?.status).toBe(200);
    expect(result?.body).toMatchObject({
      ingressDiagnostics: {
        normalized: 1,
        ignoredNotAddressed: 0,
        ignoredEmptyMessage: 0,
        rejectedInvalidMessage: 0,
        rejectedUnsupportedMessage: 0,
        rejectedOverflow: 0,
        acceptanceFailed: 0,
      },
      audits: [
        {
          runId: visitorRun.run.id,
          groupId: "10003",
          principalKind: "visitor",
          ingress: { role: "qq_group_admin", source: "onebot_message_sender" },
          verification: {
            observedRole: "qq_group_admin",
            verifiedRole: "qq_group_admin",
            status: "verified",
            tool: "qq_group_moderation",
            operation: "set_group_ban",
            authorizationDecision: "ALLOW",
          },
          toolCalls: [{ name: "qq_group_moderation", outcome: "success" }],
        },
      ],
    });
    expect(JSON.stringify(result?.body)).not.toContain(canary);
    expect(JSON.stringify(result?.body)).not.toContain("10004");
    expect(JSON.stringify(result?.body)).not.toContain("10005");
  });

  it("rechecks Owner group assignment after reading a Visitor Run Trace", async () => {
    const f = await fixture(async () => ({ status: "succeeded", text: "visitor reply" }));
    const ownerScope: TrustedChannelScope = {
      connectionId: "fixture",
      botId: "10001",
      chatType: "private",
      chatId: "10002",
      senderId: "10002",
    };
    await f.app.store.authorization.grant({
      principalId: "owner",
      resourceId: "group:10003",
      action: "group:manage",
      scope: ownerScope,
      effect: "allow",
    });
    f.send(1, "只读测试", false, 10004, 10003, "member");
    const visitorRun = await f.started.take();
    await f.app.runs.waitForRun(visitorRun.caller, visitorRun.run.id);
    await f.reply("visitor reply");

    const trace = f.app.trace;
    const readPage = trace.readPage.bind(trace);
    trace.readPage = async <T = unknown>(
      runId: string,
      options?: Parameters<typeof trace.readPage>[1],
    ) => {
      const page = await readPage<T>(runId, options);
      await f.app.store.authorization.revokeScopeAction({
        principalId: "owner",
        resourceId: "group:10003",
        action: "group:manage",
        scope: ownerScope,
      });
      return page;
    };

    await expect(
      f.app.route({
        method: "GET",
        url: "/manage/group-role-audit?channelId=fixture&groupId=10003",
      } as never),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("treats an unreported sender role as an ordinary member in the audit", async () => {
    const f = await fixture(async () => ({ status: "succeeded", text: "visitor reply" }));
    const ownerScope: TrustedChannelScope = {
      connectionId: "fixture",
      botId: "10001",
      chatType: "private",
      chatId: "10002",
      senderId: "10002",
    };
    await f.app.store.authorization.grant({
      principalId: "owner",
      resourceId: "group:10003",
      action: "group:manage",
      scope: ownerScope,
      effect: "allow",
    });
    f.send(1, "只读验收", false, 10004, 10003, null);
    const visitorRun = await f.started.take();
    await f.app.runs.waitForRun(visitorRun.caller, visitorRun.run.id);
    await f.reply("visitor reply");

    const result = await f.app.route({
      method: "GET",
      url: "/manage/group-role-audit?channelId=fixture&groupId=10003",
    } as never);
    expect(result?.body).toMatchObject({
      audits: [
        {
          runId: visitorRun.run.id,
          ingress: { role: "qq_group_member", source: "onebot_message_sender" },
          verification: null,
          toolCalls: [],
        },
      ],
    });
  });

  it("returns the newest Owner group Run in the Owner audit slot", async () => {
    const f = await fixture(async () => ({ status: "succeeded", text: "private audit canary" }));
    const ownerScope: TrustedChannelScope = {
      connectionId: "fixture",
      botId: "10001",
      chatType: "private",
      chatId: "10002",
      senderId: "10002",
    };
    await f.app.store.authorization.grant({
      principalId: "owner",
      resourceId: "group:10003",
      action: "group:manage",
      scope: ownerScope,
      effect: "allow",
    });
    f.send(1, "私有审计 canary", false, 10002, 10003);
    const ownerRun = await f.started.take();
    await f.app.runs.waitForRun(ownerRun.caller, ownerRun.run.id);
    await f.reply("private audit canary");

    const result = await f.app.route({
      method: "GET",
      url: "/manage/group-role-audit?channelId=fixture&groupId=10003",
    } as never);
    expect(result?.body).toMatchObject({
      audits: [{ runId: ownerRun.run.id, principalKind: "owner" }],
    });
    expect(JSON.stringify(result?.body)).not.toContain("private audit canary");
  });

  it("keeps an auto-connect channel retrying when OneBot becomes ready after server startup", async () => {
    const directory = await mkdtemp(join(tmpdir(), "glassbox-late-onebot-"));
    cleanup.push(() => removeDirectory(directory));
    const reservation = createNetServer();
    await new Promise<void>((resolve, reject) => {
      reservation.once("error", reject);
      reservation.listen(0, "127.0.0.1", resolve);
    });
    const port = (reservation.address() as AddressInfo).port;
    await new Promise<void>((resolve) => reservation.close(() => resolve()));

    const channels = await ChannelProfileStore.open(directory);
    await channels.save({
      id: "late",
      label: "Late OneBot",
      kind: "qq-onebot",
      endpoint: `ws://127.0.0.1:${port}/`,
      botId: "10001",
      ownerId: "10002",
      visitorIds: [],
      groupIds: [],
      token: "late-token",
      executionRef: "claude-code",
    });
    await channels.setAutoConnect("late", true);
    const models = await ModelProfileStore.open(directory);
    const app = await ManagementApplication.open({
      dataDirectory: directory,
      databasePath: ":memory:",
      models,
      executors: new Map([
        [
          "claude-code",
          { supportsGroup: true, execute: async () => ({ status: "succeeded", text: "unused" }) },
        ],
      ]),
    });
    cleanup.push(() => app.close());
    expect(app.listChannels()[0]?.connectionState).toBe("connecting");

    const peer = new WebSocketServer({ host: "127.0.0.1", port });
    cleanup.push(
      () =>
        new Promise<void>((resolve) => {
          for (const socket of peer.clients) socket.terminate();
          peer.close(() => resolve());
        }),
    );
    peer.on("connection", (socket) => {
      socket.on("message", (raw) => {
        const bytes = Array.isArray(raw)
          ? Buffer.concat(raw)
          : raw instanceof ArrayBuffer
            ? Buffer.from(raw)
            : raw;
        const request = JSON.parse(bytes.toString("utf8")) as { echo: string };
        socket.send(
          JSON.stringify({
            echo: request.echo,
            status: "ok",
            retcode: 0,
            data: { user_id: 10001 },
          }),
        );
      });
    });
    await once(peer, "listening");
    await expect
      .poll(() => app.listChannels()[0]?.connectionState, { timeout: 5_000 })
      .toBe("connected");
    const ownerScope = {
      connectionId: "late",
      botId: "10001",
      chatType: "private" as const,
      chatId: "10002",
      senderId: "10002",
    };
    expect(await app.store.identities.resolve(ownerScope)).toMatchObject({ principalId: "owner" });
    expect(
      (
        await app.store.authorization.check({
          caller: { principalId: "owner", scope: ownerScope },
          resourceId: "tool:owner_group_admin",
          action: "tool:discover",
        })
      ).decision,
    ).toBe("ALLOW");
  });

  it("routes a configured Visitor DM through its own identity and reply destination", async () => {
    const f = await fixture(async (input) => ({
      status: "succeeded",
      text: `answer:${input.text}`,
    }));
    f.send(1, "visitor-private", true, 10004);
    const visitor = await f.started.take();
    const reply = await f.reply("answer:visitor-private");
    expect(visitor.caller.principalId).toBe("qq-visitor-10004");
    expect(reply.action).toBe("send_private_msg");
    expect(reply.params.user_id).toBe(10004);
    const trace = await f.app.trace.readPage(visitor.run.id);
    expect(
      trace.records.some((record) => (record.event as { type: string }).type === "run_finished"),
    ).toBe(true);
    expect(await f.app.store.management.runCaller("owner", visitor.run.id)).toBeNull();
    f.send(2, "owner-private", true);
    const owner = await f.started.take();
    await f.reply("answer:owner-private");
    expect(owner.history).toEqual([]);
    expect(owner.conversation.id).not.toBe(visitor.conversation.id);
  });
  it("provisions an addressed group member as a group-scoped Visitor", async () => {
    const f = await fixture(
      async (input) => ({
        status: "succeeded",
        text: `answer:${input.text}`,
      }),
      { persistentDatabase: true },
    );
    f.send(1, "new-member", false, 10099);
    await expect.poll(() => f.calls.length, { timeout: 5_000 }).toBe(1);
    const visitor = await f.started.take();
    const completed = await f.app.runs.waitForRun(visitor.caller, visitor.run.id);
    expect(completed.status).toBe("succeeded");
    const reply = await f.reply("answer:new-member");

    expect(visitor.caller).toMatchObject({
      principalId: "qq-visitor-10099",
      scope: { chatType: "group", chatId: "10003", senderId: "10099" },
    });
    expect(reply.action).toBe("send_group_msg");
    expect(String(reply.params.group_id)).toBe("10003");
    expect(
      (
        await f.app.store.authorization.check({
          caller: visitor.caller,
          resourceId: "tool:owner_group_admin",
          action: "tool:discover",
        })
      ).decision,
    ).toBe("DENY");

    f.send(2, "private-must-stay-closed", true, 10099);
    await expect.poll(() => f.calls.length).toBe(1);

    const restarted = await f.reopen();
    const resolved = await restarted.store.identities.resolve(visitor.caller.scope);
    expect(resolved?.principalId).toBe("qq-visitor-10099");
    expect(
      (
        await restarted.store.authorization.check({
          caller: visitor.caller,
          resourceId: "agent:personal",
          action: "run:create",
        })
      ).decision,
    ).toBe("ALLOW");
  });
  it("runs a group mention once, isolates Owner DM history, and indexes actual trace records", async () => {
    const f = await fixture(async (input) => ({
      status: "succeeded",
      text: `answer:${input.text}`,
    }));
    f.send(1, "group-first");
    f.send(1, "duplicate-must-not-execute");
    const group = await f.started.take();
    const groupReply = await f.reply("answer:group-first");
    expect(groupReply.action).toBe("send_group_msg");
    expect(String(groupReply.params.group_id)).toBe("10003");
    f.send(1, "private-only", true);
    const privateRun = await f.started.take();
    await f.reply("answer:private-only");
    expect(privateRun.conversation.id).not.toBe(group.conversation.id);
    expect(privateRun.history).toEqual([]);
    f.send(2, "group-second");
    const second = await f.started.take();
    await f.reply("answer:group-second");
    expect(second.history).toEqual([
      { role: "user", text: "group-first" },
      { role: "assistant", text: "answer:group-first" },
    ]);
    expect(f.calls).toHaveLength(3);
    const indexed = await f.app.store.evidence.getTrace(group.caller, group.run.id);
    expect(indexed?.eventCount).toBeGreaterThan(3);
    const trace = await f.app.trace.readPage(group.run.id);
    expect(
      trace.records.some((record) => (record.event as { type: string }).type === "run_finished"),
    ).toBe(true);
    expect(JSON.stringify(trace)).not.toContain("private-only");
    const listed = await f.app.store.management.listRuns("owner");
    expect(listed.items).toHaveLength(3);
  });

  it("replies to cancellation while the executor is still shutting down", async () => {
    let finish!: (result: ExecutionResult) => void;
    const f = await fixture(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    f.send(1, "long-task");
    const input = await f.started.take();
    f.send(2, `/cancel ${input.run.id}`);
    await f.reply(`任务 ${input.run.id} 当前状态为 cancelling。`);
    expect(input.signal.aborted).toBe(true);
    expect((await f.app.runs.getRun(input.caller, input.run.id)).status).toBe("cancelling");
    finish({ status: "cancelled" });
    expect((await f.app.runs.waitForRun(input.caller, input.run.id)).status).toBe("cancelled");
  });

  it("blocks configuration changes while a channel is connected and redacts stored tokens", async () => {
    const f = await fixture(async () => ({ status: "succeeded", text: "okay" }));
    expect(f.app.listChannels()[0]).toMatchObject({
      connectionState: "connected",
      tokenConfigured: true,
    });
    expect(JSON.stringify(f.app.listChannels())).not.toContain("fixture-token");
    await expect(f.app.saveChannel({ id: "fixture" })).rejects.toMatchObject({
      code: "CHANNEL_ACTIVE",
    });
    await f.app.disconnectChannel("fixture");
    expect(f.app.listChannels()[0]).toMatchObject({
      connectionState: "disconnected",
      autoConnect: false,
    });
  });

  it("blocks a configured channel credential from QQ delivery without copying it into Trace", async () => {
    const f = await fixture(async () => ({ status: "succeeded", text: "fixture-token" }));
    f.send(1, "credential-output", true);
    const input = await f.started.take();
    await f.app.runs.waitForRun(input.caller, input.run.id);
    await f.app.runs.drain();
    expect((await f.app.store.lifecycle.listDeliveries(input.caller, input.run.id)).items).toEqual(
      [],
    );
    const trace = await f.app.trace.readPage(input.run.id);
    expect(JSON.stringify(trace)).not.toContain("fixture-token");
    expect(
      trace.records.some((record) => {
        const event = record.event as { type?: string; reasons?: string[] };
        return (
          event.type === "delivery_blocked" &&
          event.reasons?.some((reason) => reason.startsWith("protected:")) === true
        );
      }),
    ).toBe(true);
  });

  it("lets only an Owner-private action enable and revoke a new group for registered identities", async () => {
    const f = await fixture(async (input) => ({
      status: "succeeded",
      text: `answer:${input.text}`,
    }));
    f.send(1, "owner-control", true);
    const ownerRun = await f.started.take();
    await f.reply("answer:owner-control");
    const application = f.app as unknown as {
      setGroupAccess(
        context: { caller: ExecutionInput["caller"]; conversationId: string; runId: string },
        input: { groupId: string; enabled: boolean },
      ): Promise<{
        groupId: string;
        enabled: boolean;
        enabledSkills: string[];
        version: number;
      }>;
      setGroupSkill(
        context: { caller: ExecutionInput["caller"]; conversationId: string; runId: string },
        input: {
          action: "set_skill";
          groupId: string;
          skillName: string;
          enabled: boolean;
        },
      ): Promise<{
        groupId: string;
        skillName: string;
        enabled: boolean;
        enabledSkills: string[];
        version: number;
      }>;
    };
    const context = {
      caller: ownerRun.caller,
      conversationId: ownerRun.conversation.id,
      runId: ownerRun.run.id,
    };
    await expect(
      application.setGroupAccess(context, { groupId: "10005", enabled: true }),
    ).resolves.toEqual({
      groupId: "10005",
      enabled: true,
      enabledSkills: ["unslop"],
      version: 0,
    });
    expect(f.app.listChannels()[0]?.groupIds).toContain("10005");
    await expect(
      application.setGroupSkill(context, {
        action: "set_skill",
        groupId: "10005",
        skillName: "github-gem-seeker",
        enabled: true,
      }),
    ).resolves.toMatchObject({
      groupId: "10005",
      skillName: "github-gem-seeker",
      enabled: true,
      enabledSkills: ["github-gem-seeker", "unslop"],
      version: 1,
    });
    expect(f.app.groupRuntime.get("fixture", "10005")).toMatchObject({
      enabledSkills: ["github-gem-seeker", "unslop"],
      version: 1,
    });

    f.send(2, "new-group", false, 10099, 10005);
    const newGroupRun = await f.started.take();
    await f.reply("answer:new-group");
    expect(newGroupRun.caller.principalId).toBe("qq-visitor-10099");
    expect(newGroupRun.caller.scope.chatId).toBe("10005");

    await application.setGroupAccess(context, { groupId: "10005", enabled: false });
    expect(f.app.listChannels()[0]?.groupIds).not.toContain("10005");
    expect(
      (
        await f.app.store.authorization.check({
          caller: newGroupRun.caller,
          resourceId: "agent:personal",
          action: "run:create",
        })
      ).decision,
    ).toBe("DENY");
    f.send(3, "revoked-group", false, 10004, 10005);
    f.send(4, "queue-barrier", true);
    await f.started.take((input) => input.text === "queue-barrier");
    await f.reply("answer:queue-barrier");
    expect(f.calls.some((call) => call.text === "revoked-group")).toBe(false);
  });
});
