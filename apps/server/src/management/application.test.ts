import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { ModelProfileStore } from "../config/model-profiles.js";
import { ChannelProfileStore } from "../config/channel-profiles.js";
import type {
  ExecutionInput,
  ExecutionResult,
  RunExecutionAdapter,
} from "../execution/run-service/types.js";
import {
  QQ_CAPABILITY_CATEGORIES,
  qqCapabilitiesForCategory,
  type QqCapabilityCategory,
} from "../channels/onebot/capabilities.js";
import {
  DEFAULT_OWNER_GROUP_CATEGORIES,
  DEFAULT_OWNER_GROUP_POLICY,
  ManagementApplication,
} from "./application.js";
import { PiRunExecutionAdapter } from "../runtime/pi/run-adapter.js";
import type { HistorySyncOutcome } from "../runtime/pi/history-tools.js";
import type { ToolDescriptor, ToolExclusionReason } from "../runtime/pi/tool-plane.js";
import { TOOL_DESCRIPTORS } from "../runtime/pi/tool-plane.js";
import type { PiRuntimeAdapter } from "../runtime/pi/types.js";
import {
  AccessDeniedError,
  type CallerContext,
  type TrustedChannelScope,
} from "../persistence/index.js";

class Inbox<T> {
  private items: T[] = [];
  private waiters: Array<{ match: (value: T) => boolean; resolve: (value: T) => void }> = [];
  put(item: T) {
    const index = this.waiters.findIndex((waiter) => waiter.match(item));
    if (index < 0) this.items.push(item);
    else this.waiters.splice(index, 1)[0]!.resolve(item);
  }
  take(match: (value: T) => boolean = () => true): Promise<T> {
    const index = this.items.findIndex(match);
    if (index >= 0) return Promise.resolve(this.items.splice(index, 1)[0]!);
    return new Promise((resolve) => this.waiters.push({ match, resolve }));
  }
}
interface Action {
  action: string;
  echo: string;
  params: {
    group_id?: number;
    user_id?: number;
    message_seq?: number;
    message?: Array<{ data: { text: string } }>;
  };
}
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of cleanup.reverse()) await close();
  cleanup.length = 0;
});

/** libSQL can retain Windows file handles until the test process exits. */
const removeDirectory = (directory: string) =>
  rm(directory, { recursive: true, force: true }).catch((error: NodeJS.ErrnoException) => {
    if (process.platform !== "win32" || error.code !== "EBUSY") throw error;
  });

async function fixture(
  execute: (input: ExecutionInput) => Promise<ExecutionResult>,
  options: {
    /** Deterministic `get_group_msg_history` responder, paged by the requested `message_seq`. */
    history?: (params: { group_id?: number; message_seq?: number }) => Record<string, unknown>[];
    /** The `group_name` the peer reports for `get_group_info`; absent means "unreported". */
    groupName?: string;
    /** Second Owner identity, resolved to its own `owner-<id>` Principal. */
    coOwnerId?: string;
    /** File-backed database so a test can close and reopen the same durable state. */
    persistentDatabase?: boolean;
  } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), "glassbox-channel-loop-"));
  cleanup.push(() => removeDirectory(directory));
  const actions = new Inbox<Action>();
  const sockets = new Inbox<WebSocket>();
  const calls: ExecutionInput[] = [];
  const started = new Inbox<ExecutionInput>();
  // How many `get_group_info` reads the peer has actually been asked for. Counted rather than
  // inferred from the reply, so a test can prove a projection issued *no* provider call.
  let groupInfoRequests = 0;
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  cleanup.push(async () => {
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  // Flippable at runtime: enabling a managed group asks the peer for its metadata, so a test
  // that wants a *later* observation to fail must first let the earlier one succeed.
  let groupInfoFails = false;
  server.on("connection", (socket) => {
    sockets.put(socket);
    socket.on("message", (raw) => {
      const bytes = Array.isArray(raw)
        ? Buffer.concat(raw)
        : raw instanceof ArrayBuffer
          ? Buffer.from(raw)
          : raw;
      const action = JSON.parse(bytes.toString("utf8")) as Action;
      actions.put(action);
      if (action.action === "get_group_info") groupInfoRequests += 1;
      // A rejected `get_group_info` is the peer's own failure reply: `status: "failed"` with a
      // non-zero `retcode`, which the adapter maps to a provider error rather than to data.
      const groupInfoFailed = action.action === "get_group_info" && groupInfoFails;
      socket.send(
        JSON.stringify({
          echo: action.echo,
          status: groupInfoFailed ? "failed" : "ok",
          retcode: groupInfoFailed ? 100 : 0,
          data: groupInfoFailed
            ? null
            : action.action === "get_login_info"
              ? { user_id: 10001 }
              : action.action === "get_group_info"
                ? {
                    group_id: action.params.group_id,
                    ...(options.groupName === undefined ? {} : { group_name: options.groupName }),
                  }
                : action.action === "get_group_msg_history"
                  ? { messages: options.history?.(action.params) ?? [] }
                  : { message_id: 20001 },
        }),
      );
    });
  });
  await once(server, "listening");
  const models = await ModelProfileStore.open(directory);
  const executors = new Map<string, RunExecutionAdapter>([
    [
      "claude-code",
      {
        supportsGroup: true,
        execute: async (input) => {
          calls.push(input);
          started.put(input);
          return execute(input);
        },
      },
    ],
  ]);
  const open = () =>
    ManagementApplication.open({
      dataDirectory: directory,
      databasePath: options.persistentDatabase ? join(directory, "glassbox.db") : ":memory:",
      kitPath: fileURLToPath(new URL("../runtime/pi/fixtures/lora-pi-kit", import.meta.url)),
      models,
      executors,
    });
  let app = await open();
  cleanup.push(() => app.close());
  const reopen = async () => {
    await app.close();
    app = await open();
    return app;
  };
  await app.saveChannel({
    id: "fixture",
    label: "Disposable QQ fixture",
    kind: "qq-onebot",
    endpoint: `ws://127.0.0.1:${(server.address() as AddressInfo).port}/`,
    botId: "10001",
    ownerId: "10002",
    ...(options.coOwnerId !== undefined ? { coOwnerId: options.coOwnerId } : {}),
    visitorIds: ["10004"],
    groupIds: ["10003"],
    token: "fixture-token",
    executionRef: "claude-code",
  });
  await app.connectChannel("fixture");
  const socket = await sockets.take();
  const send = (id: number, text: string, privateChat = false, senderId = 10002, groupId = 10003) =>
    socket.send(
      JSON.stringify({
        post_type: "message",
        self_id: 10001,
        user_id: senderId,
        message_id: id,
        message_type: privateChat ? "private" : "group",
        sub_type: privateChat ? "friend" : "normal",
        group_id: groupId,
        anonymous: null,
        message: [
          ...(privateChat ? [] : [{ type: "at", data: { qq: "10001" } }]),
          { type: "text", data: { text } },
        ],
      }),
    );
  const reply = (text: string) =>
    actions.take(
      (action) => action.params.message?.some((part) => part.data.text === text) === true,
    );
  const setGroupInfoFails = (value: boolean) => {
    groupInfoFails = value;
  };
  return {
    app,
    calls,
    started,
    send,
    reply,
    actions,
    reopen,
    setGroupInfoFails,
    groupInfoRequests: () => groupInfoRequests,
  };
}

describe("channel to durable run composition", () => {
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

describe("bounded authorized history synchronization", () => {
  const PAGE = 3;
  const TOTAL = 12;
  const message = (seq: number) => ({
    message_id: seq,
    message_seq: seq,
    real_id: seq,
    time: 1_758_000_000 + seq,
    user_id: 10004,
    group_id: 10003,
    message_type: "group",
    sender: { user_id: 10004, nickname: "Visitor" },
    message: [{ type: "text", data: { text: `msg-${seq}` } }],
  });
  /** Pages backwards from the requested sequence, three records at a time. */
  const paged =
    (total = TOTAL) =>
    (params: { message_seq?: number }) => {
      const top = params.message_seq ?? total + 1;
      const records: Record<string, unknown>[] = [];
      for (let seq = top - 1; seq > 0 && records.length < PAGE; seq -= 1)
        records.push(message(seq));
      return records;
    };
  const sync = (app: ManagementApplication) =>
    app as unknown as {
      syncGroupHistory(
        connectionId: string,
        groupId: string,
        options?: { maxPages?: number; since?: string },
      ): Promise<HistorySyncOutcome>;
    };
  const storedIds = async (app: ManagementApplication) =>
    (await app.archive.searchMessages({ allowedGroupIds: ["10003"], limit: 50 }))
      .map((row) => row.externalMessageId)
      .sort();

  it("walks older pages up to the configured bound instead of only the newest page", async () => {
    const f = await fixture(async () => ({ status: "succeeded", text: "ok" }), {
      history: paged(),
    });
    await sync(f.app).syncGroupHistory("fixture", "10003", { maxPages: 2 });
    expect(await storedIds(f.app)).toEqual(["10", "11", "12", "7", "8", "9"]);
  });

  it("reaches older authorized history beyond the first page", async () => {
    const f = await fixture(async () => ({ status: "succeeded", text: "ok" }), {
      history: paged(),
    });
    await sync(f.app).syncGroupHistory("fixture", "10003", { maxPages: 10 });
    expect(await storedIds(f.app)).toHaveLength(TOTAL);
    expect(await storedIds(f.app)).toContain("1");
  });

  it("dedupes a repeated sync and stops without looping on a cursor that cannot advance", async () => {
    const f = await fixture(async () => ({ status: "succeeded", text: "ok" }), {
      history: paged(),
    });
    await sync(f.app).syncGroupHistory("fixture", "10003", { maxPages: 10 });
    await sync(f.app).syncGroupHistory("fixture", "10003", { maxPages: 10 });
    expect(await storedIds(f.app)).toHaveLength(TOTAL);

    // A provider that keeps returning the same cursor must not be walked forever.
    const stuck = await fixture(async () => ({ status: "succeeded", text: "ok" }), {
      history: () => [message(5), message(5)],
    });
    await sync(stuck.app).syncGroupHistory("fixture", "10003", { maxPages: 10 });
    expect(await storedIds(stuck.app)).toEqual(["5"]);
  });

  it("stops at the requested time bound", async () => {
    const f = await fixture(async () => ({ status: "succeeded", text: "ok" }), {
      history: paged(),
    });
    await sync(f.app).syncGroupHistory("fixture", "10003", {
      maxPages: 10,
      since: new Date((1_758_000_000 + 9) * 1000).toISOString(),
    });
    expect(await storedIds(f.app)).toEqual(["10", "11", "12", "9"]);
  });

  it("reports how much of the source the walk reached", async () => {
    const f = await fixture(async () => ({ status: "succeeded", text: "ok" }), {
      history: paged(),
    });

    // Twelve records at three per page. Two pages is the bound, so older history exists that
    // this sync never read. Reporting that walk as an exhausted source is what let a search
    // call a partial window "the whole history" and answer a question the messages it never
    // reached were the answer to.
    expect(await sync(f.app).syncGroupHistory("fixture", "10003", { maxPages: 2 })).toEqual({
      pagesWalked: 2,
      stop: "page_bound_reached",
    });

    // More pages than the fixture holds, so the walk ends because the provider said there is
    // no older page. This is the one case in which the archive really is the source.
    expect(await sync(f.app).syncGroupHistory("fixture", "10003", { maxPages: 10 })).toEqual({
      pagesWalked: 5,
      stop: "end_of_source",
    });
  });

  it("names the bound a walk stopped on instead of calling it the end of the source", async () => {
    const f = await fixture(async () => ({ status: "succeeded", text: "ok" }), {
      history: paged(),
    });
    // The caller asked for everything from sequence 9 onwards, and the walk passed that bound.
    // The archived window is the whole range the question is about, which is a different
    // statement from "the group has no older history" — and the one that is true here.
    expect(
      await sync(f.app).syncGroupHistory("fixture", "10003", {
        maxPages: 10,
        since: new Date((1_758_000_000 + 9) * 1000).toISOString(),
      }),
    ).toEqual({ pagesWalked: 2, stop: "since_bound_reached" });

    // A provider that keeps returning the same cursor has not said there is no older page,
    // so what follows it stays unknown rather than becoming the end of the source.
    const stuck = await fixture(async () => ({ status: "succeeded", text: "ok" }), {
      history: () => [message(5), message(5)],
    });
    expect(await sync(stuck.app).syncGroupHistory("fixture", "10003", { maxPages: 10 })).toEqual({
      pagesWalked: 2,
      stop: "cursor_stuck",
    });
  });

  it("does not call a page it cannot page past the end of the source", async () => {
    // Records without a usable provider sequence cannot supply a backwards-page cursor.
    // That is not the provider saying it has nothing older, so what follows stays unknown
    // instead of becoming the end of the source.
    const unsequenced = () => [
      {
        message_id: 7,
        real_id: 7,
        time: 1_758_000_000 + 7,
        user_id: 10004,
        group_id: 10003,
        message_type: "group",
        sender: { user_id: 10004, nickname: "Visitor" },
        message: [{ type: "text", data: { text: "msg-7" } }],
      },
    ];
    const f = await fixture(async () => ({ status: "succeeded", text: "ok" }), {
      history: unsequenced,
    });
    expect(await sync(f.app).syncGroupHistory("fixture", "10003", { maxPages: 10 })).toEqual({
      pagesWalked: 1,
      stop: "provider_unknown",
    });

    // And the caller's own bound does not get to name this page either: the provider is the
    // one that left the walk's reach unknown, and a stop that reads as the caller's choice
    // would hide a stalled walk behind a deliberate one.
    expect(
      await sync(f.app).syncGroupHistory("fixture", "10003", {
        maxPages: 10,
        since: new Date((1_758_000_000 + 10) * 1000).toISOString(),
      }),
    ).toEqual({ pagesWalked: 1, stop: "provider_unknown" });
  });
});

type OwnerContext = {
  caller: ExecutionInput["caller"];
  conversationId: string;
  runId: string;
};
interface ManagedGroupProjection {
  connectionId: string;
  groups: Array<{
    groupId: string;
    /** The live provider name, or `null` when it was not observed. */
    name: string | null;
    /** The live provider reachability, or `null` when it was not observed. */
    reachable: boolean | null;
    /**
     * `true` when the provider proved the Bot is in this exact group; `null` when it did not.
     * Never `false`: this read path cannot prove absence of membership.
     */
    botMembership: boolean | null;
    access: {
      /** The acting Owner's own assignment of this group. Always `true` in the inventory. */
      assigned: boolean;
      grantedCategories: QqCapabilityCategory[];
      historyRead: boolean;
    };
    categories: Record<string, boolean>;
    memorySources: Record<string, boolean>;
    skills: { enabledSkills: string[]; version: number };
    version: number;
  }>;
}

/** One entry of the registry search, as `qq_capability_search` returns it. */
interface CapabilitySearchEntry {
  tool: string;
  description: string;
  category: QqCapabilityCategory;
  readOnly: boolean;
  groupIds: string[];
}
interface CapabilitySearchResult {
  query: string | null;
  groups: string[];
  capabilities: CapabilitySearchEntry[];
}

/**
 * The Owner-private management surface as the Owner Tools call it.
 *
 * The Tools themselves are covered by `owner-tools.test.ts`; these tests drive the durable
 * per-Owner behavior through the real `ManagementApplication` path.
 */
const admin = (app: ManagementApplication) =>
  app as unknown as {
    setGroupAccess(
      context: OwnerContext,
      input: { groupId: string; enabled: boolean },
    ): Promise<{ groupId: string; enabled: boolean; enabledSkills: string[]; version: number }>;
    setGroupHistory(
      context: OwnerContext,
      input: { groupId: string; enabled: boolean },
    ): Promise<unknown>;
    setGroupCategory(
      context: OwnerContext,
      input: { groupId: string; category: QqCapabilityCategory; enabled: boolean },
    ): Promise<unknown>;
    setGroupSkill(
      context: OwnerContext,
      input: { groupId: string; skillName: string; enabled: boolean },
    ): Promise<unknown>;
    projectManagedGroups(context: OwnerContext): Promise<ManagedGroupProjection>;
    resolveRunToolNames(context: OwnerContext): Promise<string[]>;
    resolveRunToolCandidates(
      context: OwnerContext,
      registered?: readonly ToolDescriptor[],
    ): Promise<{ name: string; exclusion: ToolExclusionReason | null }[]>;
    createRuntimeTools(getContext: () => OwnerContext | undefined): Array<{
      name: string;
      execute(id: string, params: unknown, signal?: AbortSignal): Promise<{ details?: unknown }>;
    }>;
  };

/** The mutation categories the fixed default bundle must never enable. */
const MUTATION_CATEGORIES: readonly QqCapabilityCategory[] = [
  "group.files.write",
  "group.moderate",
  "group.settings",
  "message.manage",
];

/** The group-scoped Actions a set of categories confers on a group Resource. */
const groupActions = (categories: readonly QqCapabilityCategory[]): string[] => [
  ...new Set(
    categories.flatMap((category) =>
      qqCapabilitiesForCategory(category)
        .filter((capability) => capability.resource === "group")
        .map((capability) => capability.action),
    ),
  ),
];

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

/**
 * The group-Run surface as the real application computes and builds it.
 *
 * These tests drive `ManagementApplication` itself rather than the pure helpers, so they
 * prove the provisioning grants, the discovery candidate list and a real protected Tool call
 * all agree — which is the product path a helper-only test cannot cover.
 */
const groupRun = (app: ManagementApplication) =>
  app as unknown as {
    setGroupAccess(
      context: OwnerContext,
      input: { groupId: string; enabled: boolean },
    ): Promise<unknown>;
    setGroupCategory(
      context: OwnerContext,
      input: { groupId: string; category: QqCapabilityCategory; enabled: boolean },
    ): Promise<unknown>;
    setGroupHistory(
      context: OwnerContext,
      input: { groupId: string; enabled: boolean },
    ): Promise<unknown>;
    resolveRunToolNames(context: OwnerContext): Promise<string[]>;
    resolveRunToolCandidates(
      context: OwnerContext,
      registered?: readonly ToolDescriptor[],
    ): Promise<{ name: string; exclusion: ToolExclusionReason | null }[]>;
    createRuntimeTools(getContext: () => OwnerContext | undefined): Array<{
      name: string;
      execute(id: string, params: unknown, signal?: AbortSignal): Promise<{ details?: unknown }>;
    }>;
  };

/** The read-only capability Tools a configured group Run may use, and the ones it never may. */
const GROUP_RUN_READ_TOOLS = [
  "group_history_search",
  "qq_groups",
  "qq_group_members",
  "qq_group_history",
  "qq_group_content",
  "qq_group_files",
] as const;
const GROUP_RUN_FORBIDDEN_TOOLS = [
  "qq_group_moderation",
  "qq_group_settings",
  "qq_group_file_ops",
  "qq_capability_search",
  "qq_account_status",
] as const;

describe("configured group Run capability authority", () => {
  const CO_OWNER = "10006";
  /** The group's numeric provider id, and the canonical string id Glassbox resources use. */
  const GROUP_ID = 10005;
  const GROUP = String(GROUP_ID);

  /**
   * Enables a group for the primary Owner and then runs a real group message in it, so the
   * caller scope under test is the one the transport produced rather than one the test made up.
   */
  async function configuredGroup() {
    const f = await fixture(
      async (input) => ({ status: "succeeded", text: `answer:${input.text}` }),
      { coOwnerId: CO_OWNER },
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
    f.send(2, "group-run", false, 10002, GROUP_ID);
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
    // The Kit profile's host Tools were removed by the host, and that is named as such.
    expect(reason("read")).toBe("disabled_by_host");
    expect(reason("bash")).toBe("disabled_by_host");
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

  it("discovers only the read-only capabilities for a group Run and calls one for real", async () => {
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

  it("denies a group Run mutation even if the Tool is called directly", async () => {
    const { application, context } = await configuredGroup();
    const tools = application.createRuntimeTools(() => context);
    const moderation = tools.find((tool) => tool.name === "qq_group_moderation");
    if (!moderation) throw new Error("missing qq_group_moderation");

    // The mutating Tool is never part of the group Run's discovered surface...
    expect(await application.resolveRunToolNames(context)).not.toContain("qq_group_moderation");
    // ...and calling it anyway is denied on the group Resource, not merely hidden.
    await expect(
      moderation.execute("call", {
        operation: "set_group_whole_ban",
        params: { enable: true },
      }),
    ).rejects.toThrow("Permission denied: no_grant");
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
  const decisionsFor = async (f: Awaited<ReturnType<typeof fixture>>, caller: CallerContext) => {
    const items: Array<{
      resourceId: string;
      action: string;
      decision: string;
      reason: string;
      runId: string | null;
      conversationId: string | null;
    }> = [];
    let cursor: string | undefined;
    do {
      const page = await f.app.store.evidence.listDecisions(caller, "personal", {
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
