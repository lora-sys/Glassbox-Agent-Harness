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
  qqCapabilitiesForCategory,
  type QqCapabilityCategory,
} from "../channels/onebot/capabilities.js";
import {
  DEFAULT_OWNER_GROUP_CATEGORIES,
  DEFAULT_OWNER_GROUP_POLICY,
  ManagementApplication,
} from "./application.js";

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
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  cleanup.push(async () => {
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
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
      socket.send(
        JSON.stringify({
          echo: action.echo,
          status: "ok",
          retcode: 0,
          data:
            action.action === "get_login_info"
              ? { user_id: 10001 }
              : action.action === "get_group_info"
                ? { group_id: action.params.group_id }
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
  return { app, calls, started, send, reply, actions, reopen };
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

    f.send(2, "new-group", false, 10004, 10005);
    const newGroupRun = await f.started.take();
    await f.reply("answer:new-group");
    expect(newGroupRun.caller.principalId).toBe("qq-visitor-10004");
    expect(newGroupRun.caller.scope.chatId).toBe("10005");

    await application.setGroupAccess(context, { groupId: "10005", enabled: false });
    expect(f.app.listChannels()[0]?.groupIds).not.toContain("10005");
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
      ): Promise<void>;
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
    categories: Record<string, boolean>;
    memorySources: Record<string, boolean>;
    version: number;
  }>;
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
    projectManagedGroups(context: OwnerContext): Promise<ManagedGroupProjection>;
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
  async function owners(persistentDatabase = false) {
    const f = await fixture(
      async (input) => ({ status: "succeeded", text: `answer:${input.text}` }),
      { coOwnerId: CO_OWNER, persistentDatabase },
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
    const { f, application, a, b } = await owners(true);
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
    return { f, a, application, context };
  }

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
});
