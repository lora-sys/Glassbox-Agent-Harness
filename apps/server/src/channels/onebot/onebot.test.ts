import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { WebSocketServer, type WebSocket } from "ws";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { OneBotAdapter, type OneBotAdapterOptions, type OneBotState } from "./adapter.ts";
import { parseOneBotConfig } from "./config.ts";
import { normalizeOneBotMessage, type OneBotIncomingMessage } from "./normalize.ts";

const base = {
  connectionId: "napcat-test",
  label: "Test QQ",
  endpoint: "ws://127.0.0.1:6700/",
  botId: "10001",
  ownerId: "10002",
  groupIds: ["10003"],
  credentialSlot: "qq-token",
  allowRemote: false,
};
const config = parseOneBotConfig(base);
const groupScope = {
  connectionId: base.connectionId,
  botId: base.botId,
  chatType: "group" as const,
  chatId: "10003",
  senderId: base.ownerId,
};
function inbound(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    time: 1,
    post_type: "message",
    message_type: "group",
    sub_type: "normal",
    self_id: 10001,
    user_id: 10002,
    group_id: 10003,
    message_id: -7,
    anonymous: null,
    message: [
      { type: "at", data: { qq: "10001" } },
      { type: "text", data: { text: " 检查任务 " } },
    ],
    ...overrides,
  };
}

class Queue<T> {
  #items: T[] = [];
  #waiters: Array<{ predicate: (item: T) => boolean; resolve: (item: T) => void }> = [];
  push(item: T): void {
    const index = this.#waiters.findIndex((waiter) => waiter.predicate(item));
    if (index >= 0) this.#waiters.splice(index, 1)[0].resolve(item);
    else this.#items.push(item);
  }
  next(predicate: (item: T) => boolean = () => true): Promise<T> {
    const index = this.#items.findIndex(predicate);
    if (index >= 0) return Promise.resolve(this.#items.splice(index, 1)[0]);
    return new Promise<T>((resolve) => {
      this.#waiters.push({ predicate, resolve });
    });
  }
}

interface Action {
  action: string;
  params: Record<string, unknown>;
  echo: string;
}
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.reverse()) await close();
  cleanup.length = 0;
});

async function server(
  options: {
    token?: string;
    loginId?: number;
    onAction?: (action: Action, socket: WebSocket) => boolean;
  } = {},
) {
  const connections = new Queue<WebSocket>();
  const actions = new Queue<Action>();
  const history: Action[] = [];
  const auth: string[] = [];
  const wss = new WebSocketServer({
    host: "127.0.0.1",
    port: 0,
    verifyClient(info, done) {
      auth.push(info.req.headers.authorization ?? "");
      done(
        info.req.headers.authorization === `Bearer ${options.token ?? "explicit-test-token"}`,
        401,
        "Unauthorized",
      );
    },
  });
  cleanup.push(async () => {
    for (const socket of wss.clients) socket.terminate();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
  });
  wss.on("connection", (socket) => {
    connections.push(socket);
    socket.on("message", (data) => {
      const bytes = Array.isArray(data)
        ? Buffer.concat(data)
        : data instanceof ArrayBuffer
          ? Buffer.from(data)
          : data;
      const action = JSON.parse(bytes.toString("utf8")) as Action;
      history.push(action);
      actions.push(action);
      if (options.onAction?.(action, socket)) return;
      socket.send(
        JSON.stringify({
          status: "ok",
          retcode: 0,
          data:
            action.action === "get_login_info"
              ? { user_id: options.loginId ?? 10001, nickname: "Fixture bot" }
              : { message_id: 321 },
          echo: action.echo,
        }),
      );
    });
  });
  await once(wss, "listening");
  return {
    endpoint: `ws://127.0.0.1:${(wss.address() as AddressInfo).port}/`,
    connections,
    actions,
    auth,
    history,
  };
}

function client(endpoint: string, options: Partial<OneBotAdapterOptions> = {}) {
  const incoming = new Queue<OneBotIncomingMessage>();
  const states = new Queue<OneBotState>();
  const errors = new Queue<Parameters<NonNullable<OneBotAdapterOptions["onIngressError"]>>[0]>();
  const adapter = new OneBotAdapter({
    config: parseOneBotConfig({ ...base, endpoint }),
    token: "explicit-test-token",
    requestTimeoutMs: 500,
    reconnectDelayMs: 20,
    onIncoming: (message) => {
      incoming.push(message);
    },
    onState: (state) => {
      states.push(state);
    },
    onIngressError: (error) => {
      errors.push(error);
    },
    ...options,
  });
  cleanup.push(() => adapter.stop());
  return { adapter, incoming, states, errors };
}

describe("OneBot normalization", () => {
  it("uses configured connection/account and isolates a group sender", () => {
    const result = normalizeOneBotMessage(
      inbound({
        connectionId: "evil",
        botId: "evil",
        thread_id: "evil",
        session_key_override: "owner-private",
      }),
      config,
    );
    expect(result).toMatchObject({
      kind: "message",
      message: { channel: "qq-onebot", scope: groupScope, messageId: "-7", text: "检查任务" },
    });
    if (result.kind === "message") expect(result.message.scope).not.toHaveProperty("threadId");
  });
  it.each([
    { message: [{ type: "text", data: { text: "@10001 please run" } }] },
    {
      message: [
        { type: "at", data: { qq: "all" } },
        { type: "text", data: { text: "please run" } },
      ],
    },
    { user_id: 10099 },
    { user_id: 10001 },
    { self_id: 20001 },
    { group_id: 90000 },
    { sub_type: "anonymous" },
    { anonymous: { id: 123 } },
    { post_type: "message_sent" },
    { message_type: "private", sub_type: "group" },
    { message_type: "private", sub_type: "other" },
  ])("ignores disallowed ingress %j", (override) => {
    expect(normalizeOneBotMessage(inbound(override), config)).toEqual({ kind: "ignored" });
  });
  it("routes an Owner friend DM independently of an untrusted group field", () => {
    expect(
      normalizeOneBotMessage(
        inbound({
          message_type: "private",
          sub_type: "friend",
          message: "私密内容",
          group_id: "10003",
        }),
        config,
      ),
    ).toMatchObject({
      kind: "message",
      message: { scope: { ...groupScope, chatType: "private", chatId: "10002" }, text: "私密内容" },
    });
  });
  it("parses CQ @ and preserves escaped CQ text as text", () => {
    expect(
      normalizeOneBotMessage(
        inbound({ message: "[CQ:at,qq=10001] 检查 &#91;内容&#93; &amp; ", raw_message: "ignored" }),
        config,
      ),
    ).toMatchObject({ kind: "message", message: { text: "检查 [内容] &" } });
    expect(
      normalizeOneBotMessage(inbound({ message: "&#91;CQ:at,qq=10001&#93; please run" }), config),
    ).toEqual({ kind: "ignored" });
  });
  it("does not fetch quoted messages and rejects media or oversized input", () => {
    expect(
      normalizeOneBotMessage(
        inbound({
          message: [
            { type: "reply", data: { id: -13 } },
            { type: "at", data: { qq: "10001" } },
            { type: "text", data: { text: "引用任务" } },
          ],
        }),
        config,
      ),
    ).toMatchObject({ kind: "message", message: { replyTo: "-13" } });
    expect(
      normalizeOneBotMessage(
        inbound({ message: "[CQ:at,qq=10001] image [CQ:image,file=https://private.test]" }),
        config,
      ),
    ).toMatchObject({ kind: "rejected", code: "unsupported_message" });
    expect(normalizeOneBotMessage(inbound({ message: "x".repeat(16_001) }), config)).toMatchObject({
      kind: "rejected",
      code: "invalid_message",
    });
  });
});

describe("OneBot configuration", () => {
  it("requires token references and explicit secure remote opt-in", () => {
    expect(() => parseOneBotConfig({ ...base, endpoint: "ws://remote.example/ws" })).toThrow();
    expect(() =>
      parseOneBotConfig({ ...base, endpoint: "ws://remote.example/ws", allowRemote: true }),
    ).toThrow();
    expect(() => parseOneBotConfig({ ...base, endpoint: "wss://remote.example/ws" })).toThrow();
    expect(
      parseOneBotConfig({ ...base, endpoint: "wss://remote.example/ws", allowRemote: true })
        .allowRemote,
    ).toBe(true);
    expect(() =>
      parseOneBotConfig({ ...base, endpoint: "ws://127.0.0.1/?access_token=SECRET" }),
    ).toThrow();
    expect(() => parseOneBotConfig({ ...base, endpoint: "ws://127.0.0.1/api" })).toThrow();
    expect(() => parseOneBotConfig({ ...base, ownerId: "9007199254740993" })).toThrow();
    expect(() => parseOneBotConfig({ ...base, credentialSlot: "" })).toThrow();
  });
});

describe("OneBot forward WebSocket", () => {
  it("authenticates, verifies login and delivers Owner group @ plus DM", async () => {
    const fake = await server();
    const { adapter, incoming } = client(fake.endpoint);
    await adapter.start();
    expect(adapter.state.status).toBe("ready");
    expect(fake.auth).toEqual(["Bearer explicit-test-token"]);
    expect(fake.history[0]).toMatchObject({ action: "get_login_info", params: {} });
    const socket = await fake.connections.next();
    socket.send(JSON.stringify(inbound()));
    expect((await incoming.next()).scope).toEqual(groupScope);
    socket.send(
      JSON.stringify(
        inbound({
          message_type: "private",
          sub_type: "friend",
          message: "你好 私聊",
          message_id: 8,
        }),
      ),
    );
    expect(await incoming.next()).toMatchObject({
      text: "你好 私聊",
      scope: { chatType: "private", chatId: "10002" },
    });
  });
  it("fails token authentication without exposing the token or retrying", async () => {
    const fake = await server({ token: "different-token" });
    const { adapter } = client(fake.endpoint);
    await expect(adapter.start()).rejects.toMatchObject({ code: "authentication_failed" });
    expect(adapter.state).toEqual({ status: "faulted", reason: "authentication_failed" });
    expect(JSON.stringify(adapter.state)).not.toContain("explicit-test-token");
    expect(fake.auth).toHaveLength(1);
  });
  it("rejects a different logged-in bot before dispatching messages", async () => {
    const fake = await server({
      loginId: 90000,
      onAction(action, socket) {
        if (action.action === "get_login_info") socket.send(JSON.stringify(inbound()));
        return false;
      },
    });
    let calls = 0;
    const { adapter } = client(fake.endpoint, {
      onIncoming: () => {
        calls++;
      },
    });
    await expect(adapter.start()).rejects.toMatchObject({ code: "identity_mismatch" });
    expect(adapter.state.status).toBe("faulted");
    expect(calls).toBe(0);
  });
  it("holds startup messages until get_login_info verifies the bot", async () => {
    const fake = await server({
      onAction(action, socket) {
        if (action.action === "get_login_info") socket.send(JSON.stringify(inbound()));
        return false;
      },
    });
    const { adapter, incoming } = client(fake.endpoint);
    await adapter.start();
    expect((await incoming.next()).scope).toEqual(groupScope);
  });
  it("confirms a platform message ID and keeps text CQ literals inert", async () => {
    const fake = await server();
    const { adapter } = client(fake.endpoint);
    await adapter.start();
    const result = await adapter.send({
      deliveryId: "delivery-1",
      target: groupScope,
      text: "中文 [CQ:at,qq=all]",
      replyTo: "-7",
    });
    expect(result).toEqual({ status: "confirmed", messageId: "321" });
    const sent = await fake.actions.next((action) => action.action === "send_group_msg");
    expect(sent.params).toEqual({
      group_id: 10003,
      message: [
        { type: "reply", data: { id: "-7" } },
        { type: "text", data: { text: "中文 [CQ:at,qq=all]" } },
      ],
    });
  });
  it("rejects mismatched connections, bots, callers and destinations before sending", async () => {
    const fake = await server();
    const { adapter } = client(fake.endpoint);
    await adapter.start();
    for (const changed of [
      { connectionId: "other" },
      { botId: "other" },
      { senderId: "other" },
      { chatId: "other" },
      { threadId: "private" },
      { chatType: "private" as const },
    ]) {
      expect(
        await adapter.send({
          deliveryId: "delivery-1",
          target: { ...groupScope, ...changed },
          text: "secret",
        }),
      ).toEqual({ status: "failed", code: "invalid_target" });
    }
    expect(fake.history).toHaveLength(1);
  });
  it("sends an Owner DM only through the configured private destination", async () => {
    const fake = await server();
    const { adapter } = client(fake.endpoint);
    await adapter.start();
    expect(
      await adapter.send({
        deliveryId: "dm",
        target: { ...groupScope, chatType: "private", chatId: base.ownerId },
        text: "私聊结果",
      }),
    ).toEqual({ status: "confirmed", messageId: "321" });
    expect(
      (await fake.actions.next((action) => action.action === "send_private_msg")).params,
    ).toMatchObject({ user_id: 10002 });
  });
  it("correlates concurrent responses by echo even when responses are reversed", async () => {
    const fake = await server({ onAction: (action) => action.action !== "get_login_info" });
    const { adapter } = client(fake.endpoint);
    await adapter.start();
    const first = adapter.send({ deliveryId: "d1", target: groupScope, text: "first" });
    const second = adapter.send({ deliveryId: "d2", target: groupScope, text: "second" });
    const firstAction = await fake.actions.next((action) => action.action === "send_group_msg");
    const secondAction = await fake.actions.next((action) => action.action === "send_group_msg");
    const socket = await fake.connections.next();
    socket.send(
      JSON.stringify({
        status: "ok",
        retcode: 0,
        data: { message_id: 2 },
        echo: secondAction.echo,
      }),
    );
    socket.send(
      JSON.stringify({ status: "ok", retcode: 0, data: { message_id: 1 }, echo: firstAction.echo }),
    );
    expect(await first).toEqual({ status: "confirmed", messageId: "1" });
    expect(await second).toEqual({ status: "confirmed", messageId: "2" });
  });
  it("classifies platform rejection and malformed success without exposing diagnostics", async () => {
    let response = {
      status: "failed",
      retcode: 100,
      data: null as unknown,
      message: "SECRET_FROM_PLATFORM",
    };
    const fake = await server({
      onAction(action, socket) {
        if (action.action === "get_login_info") return false;
        socket.send(JSON.stringify({ ...response, echo: action.echo }));
        return true;
      },
    });
    const { adapter } = client(fake.endpoint);
    await adapter.start();
    expect(await adapter.send({ deliveryId: "d1", target: groupScope, text: "hello" })).toEqual({
      status: "failed",
      code: "api_rejected",
      retcode: 100,
    });
    response = { status: "ok", retcode: 0, data: {}, message: "SECRET_FROM_PLATFORM" };
    expect(await adapter.send({ deliveryId: "d2", target: groupScope, text: "hello" })).toEqual({
      status: "unknown",
      code: "invalid_response",
    });
    response = { status: "async", retcode: 1, data: null, message: "SECRET_FROM_PLATFORM" };
    expect(await adapter.send({ deliveryId: "d3", target: groupScope, text: "hello" })).toEqual({
      status: "unknown",
      code: "async_response",
    });
  });
  it("returns timeout unknown, ignores a late echo and never resends", async () => {
    const fake = await server({ onAction: (action) => action.action !== "get_login_info" });
    const { adapter } = client(fake.endpoint, { requestTimeoutMs: 30 });
    await adapter.start();
    const pending = adapter.send({ deliveryId: "d1", target: groupScope, text: "hello" });
    const action = await fake.actions.next((item) => item.action === "send_group_msg");
    expect(await pending).toEqual({ status: "unknown", code: "timeout" });
    const socket = await fake.connections.next();
    socket.send(
      JSON.stringify({ status: "ok", retcode: 0, data: { message_id: 999 }, echo: action.echo }),
    );
    expect(fake.history.filter((item) => item.action === "send_group_msg")).toHaveLength(1);
  });
  it("marks an in-flight disconnect unknown and re-verifies identity on reconnect", async () => {
    const fake = await server({
      onAction(action, socket) {
        if (action.action === "send_group_msg") {
          socket.terminate();
          return true;
        }
        return false;
      },
    });
    const { adapter, states, incoming } = client(fake.endpoint);
    await adapter.start();
    await states.next((state) => state.status === "ready");
    await fake.connections.next();
    expect(await adapter.send({ deliveryId: "d1", target: groupScope, text: "hello" })).toEqual({
      status: "unknown",
      code: "disconnected",
    });
    await states.next((state) => state.status === "reconnecting");
    await states.next((state) => state.status === "ready");
    const second = await fake.connections.next();
    second.send(JSON.stringify(inbound()));
    expect((await incoming.next()).messageId).toBe("-7");
    expect(fake.history.filter((action) => action.action === "get_login_info")).toHaveLength(2);
    expect(fake.history.filter((action) => action.action === "send_group_msg")).toHaveLength(1);
  });
  it("passes duplicate IDs to durable acceptance and reports callback failures safely", async () => {
    const fake = await server();
    const received: string[] = [];
    const { adapter, errors } = client(fake.endpoint, {
      onIncoming: async (message) => {
        received.push(message.messageId);
        throw new Error("PRIVATE_CALLBACK_ERROR");
      },
    });
    await adapter.start();
    const socket = await fake.connections.next();
    socket.send(JSON.stringify(inbound()));
    socket.send(JSON.stringify(inbound()));
    expect(await errors.next()).toEqual({ code: "acceptance_failed", messageId: "-7" });
    expect(await errors.next()).toEqual({ code: "acceptance_failed", messageId: "-7" });
    expect(received).toEqual(["-7", "-7"]);
  });
  it("closes malformed frames and stop settles an in-flight delivery", async () => {
    const fake = await server({ onAction: (action) => action.action !== "get_login_info" });
    const { adapter, states } = client(fake.endpoint);
    await adapter.start();
    const pending = adapter.send({ deliveryId: "d1", target: groupScope, text: "hello" });
    await fake.actions.next((action) => action.action === "send_group_msg");
    await adapter.stop();
    expect(await pending).toEqual({ status: "unknown", code: "disconnected" });
    expect(adapter.state).toEqual({ status: "stopped" });
    await adapter.start();
    await fake.connections.next();
    const second = await fake.connections.next();
    second.send("{malformed SECRET");
    expect(await states.next((state) => state.reason === "invalid_frame")).toEqual({
      status: "reconnecting",
      reason: "invalid_frame",
    });
  });
  it("bounds the acceptance queue and aborts active acceptance when stopped", async () => {
    const fake = await server();
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let acceptanceAborted = false;
    const { adapter, errors } = client(fake.endpoint, {
      maxPendingIncoming: 1,
      onIncoming: async (_message, signal) => {
        entered();
        await new Promise<void>((resolve) =>
          signal.addEventListener(
            "abort",
            () => {
              acceptanceAborted = true;
              resolve();
            },
            { once: true },
          ),
        );
      },
    });
    await adapter.start();
    const socket = await fake.connections.next();
    socket.send(JSON.stringify(inbound()));
    await started;
    socket.send(JSON.stringify(inbound({ message_id: 8 })));
    expect(await errors.next()).toEqual({ code: "ingress_overflow", messageId: "8" });
    await adapter.stop();
    expect(acceptanceAborted).toBe(true);
  });
  it("disconnects oversized WebSocket payloads before accepting messages", async () => {
    const fake = await server();
    let calls = 0;
    const { adapter, states } = client(fake.endpoint, {
      onIncoming: () => {
        calls++;
      },
    });
    await adapter.start();
    const socket = await fake.connections.next();
    socket.send(JSON.stringify(inbound({ message: "x".repeat(513 * 1024) })));
    await states.next((state) => state.status === "reconnecting");
    expect(calls).toBe(0);
  });
});
