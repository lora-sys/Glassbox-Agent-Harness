import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { ModelProfileStore } from "../config/model-profiles.js";
import type { ExecutionInput, ExecutionResult } from "../execution/run-service/types.js";
import { ManagementApplication } from "./application.js";

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
  params: { group_id?: number; user_id?: number; message?: Array<{ data: { text: string } }> };
}
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of cleanup.reverse()) await close();
  cleanup.length = 0;
});

async function fixture(execute: (input: ExecutionInput) => Promise<ExecutionResult>) {
  const directory = await mkdtemp(join(tmpdir(), "glassbox-channel-loop-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
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
          data: action.action === "get_login_info" ? { user_id: 10001 } : { message_id: 20001 },
        }),
      );
    });
  });
  await once(server, "listening");
  const models = await ModelProfileStore.open(directory);
  const app = await ManagementApplication.open({
    dataDirectory: directory,
    databasePath: ":memory:",
    models,
    executors: new Map([
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
    ]),
  });
  cleanup.push(() => app.close());
  await app.saveChannel({
    id: "fixture",
    label: "Disposable QQ fixture",
    kind: "qq-onebot",
    endpoint: `ws://127.0.0.1:${(server.address() as AddressInfo).port}/`,
    botId: "10001",
    ownerId: "10002",
    visitorIds: ["10004"],
    groupIds: ["10003"],
    token: "fixture-token",
    executionRef: "claude-code",
  });
  await app.connectChannel("fixture");
  const socket = await sockets.take();
  const send = (id: number, text: string, privateChat = false, senderId = 10002) =>
    socket.send(
      JSON.stringify({
        post_type: "message",
        self_id: 10001,
        user_id: senderId,
        message_id: id,
        message_type: privateChat ? "private" : "group",
        sub_type: privateChat ? "friend" : "normal",
        group_id: 10003,
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
  return { app, calls, started, send, reply, actions };
}

describe("channel to durable run composition", () => {
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
});
