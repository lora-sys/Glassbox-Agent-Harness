import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { WebSocketServer, type WebSocket } from "ws";
import { afterEach, describe, expect, it } from "vite-plus/test";
import {
  OneBotAdapter,
  type OneBotAdapterOptions,
  type OneBotIngressDiagnostic,
  type OneBotState,
} from "./adapter.ts";
import { parseOneBotConfig } from "./config.ts";
import { normalizeOneBotMessage, type OneBotIncomingMessage } from "./normalize.ts";

const base = {
  connectionId: "napcat-test",
  label: "Test QQ",
  endpoint: "ws://127.0.0.1:6700/",
  botId: "10001",
  ownerId: "10002",
  visitorIds: ["10004"],
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
  const diagnostics = new Queue<OneBotIngressDiagnostic>();
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
    onIngressDiagnostic: (diagnostic) => {
      diagnostics.push(diagnostic);
    },
    ...options,
  });
  cleanup.push(() => adapter.stop());
  return { adapter, incoming, states, errors, diagnostics };
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
    { user_id: 10001 },
    { self_id: 20001 },
    { group_id: 90000 },
    { sub_type: "anonymous" },
    { anonymous: { id: 123 } },
    { post_type: "message_sent" },
    { message_type: "private", sub_type: "group" },
    { message_type: "private", sub_type: "other" },
  ])("ignores disallowed ingress %j", (override) => {
    expect(normalizeOneBotMessage(inbound(override), config)).toMatchObject({ kind: "ignored" });
  });
  it("classifies a configured group message without retaining message or member data", () => {
    const result = normalizeOneBotMessage(
      inbound({ message: [{ type: "text", data: { text: "private-message-canary" } }] }),
      config,
    );
    expect(result).toEqual({
      kind: "ignored",
      diagnostic: { groupId: "10003", reason: "not_addressed" },
    });
    expect(JSON.stringify(result)).not.toContain("private-message-canary");
    expect(JSON.stringify(result)).not.toContain("10002");
  });
  it("accepts an addressed member of a configured group without making private chat public", () => {
    expect(normalizeOneBotMessage(inbound({ user_id: 10099 }), config)).toMatchObject({
      kind: "message",
      message: {
        scope: { chatType: "group", chatId: "10003", senderId: "10099" },
        text: "检查任务",
      },
    });
    expect(
      normalizeOneBotMessage(
        inbound({
          user_id: 10099,
          message_type: "private",
          sub_type: "friend",
          message: "private must stay closed",
        }),
        config,
      ),
    ).toEqual({ kind: "ignored" });
  });
  it.each([
    ["owner", "qq_group_owner"],
    ["admin", "qq_group_admin"],
    ["member", "qq_group_member"],
    ["administrator", "qq_group_member"],
    [undefined, "qq_group_member"],
  ])("keeps the trusted QQ sender role %s as %s for this Run", (providerRole, role) => {
    const result = normalizeOneBotMessage(
      inbound({ sender: providerRole === undefined ? {} : { role: providerRole } }),
      config,
      new Date("2026-09-22T01:02:03.000Z"),
    );
    expect(result).toMatchObject({
      kind: "message",
      message: {
        scope: {
          chatType: "group",
          chatId: "10003",
          senderId: "10002",
          nativeGroupRole: {
            role,
            source: "onebot_message_sender",
            observedAt: "2026-09-22T01:02:03.000Z",
          },
        },
      },
    });
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
  it("routes an allowlisted Visitor DM as a distinct channel identity", () => {
    expect(
      normalizeOneBotMessage(
        inbound({
          user_id: 10004,
          message_type: "private",
          sub_type: "friend",
          message: "访客问题",
        }),
        config,
      ),
    ).toMatchObject({
      kind: "message",
      message: {
        scope: { chatType: "private", chatId: "10004", senderId: "10004" },
        text: "访客问题",
      },
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
    ).toEqual({
      kind: "ignored",
      diagnostic: { groupId: "10003", reason: "not_addressed" },
    });
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
    expect((await incoming.next()).scope).toEqual({
      ...groupScope,
      nativeGroupRole: {
        role: "qq_group_member",
        source: "onebot_message_sender",
        observedAt: expect.any(String),
      },
    });
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
    expect((await incoming.next()).scope).toEqual({
      ...groupScope,
      nativeGroupRole: {
        role: "qq_group_member",
        source: "onebot_message_sender",
        observedAt: expect.any(String),
      },
    });
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
  it("sends a group reply for an addressed member without opening that member's DM", async () => {
    const fake = await server();
    const { adapter } = client(fake.endpoint);
    await adapter.start();
    const memberScope = { ...groupScope, senderId: "10099" };
    expect(
      await adapter.send({ deliveryId: "member-group", target: memberScope, text: "群回复" }),
    ).toEqual({ status: "confirmed", messageId: "321" });
    expect(
      await adapter.send({
        deliveryId: "member-private",
        target: { ...memberScope, chatType: "private", chatId: "10099" },
        text: "不可私聊",
      }),
    ).toEqual({ status: "failed", code: "invalid_target" });
  });
  it("re-verifies one configured member role without exposing the raw profile", async () => {
    const fake = await server({
      onAction(action, socket) {
        if (action.action !== "get_group_member_info") return false;
        socket.send(
          JSON.stringify({
            status: "ok",
            retcode: 0,
            data: {
              group_id: action.params.group_id,
              user_id: action.params.user_id,
              role: "admin",
              nickname: "must not leave adapter",
            },
            echo: action.echo,
          }),
        );
        return true;
      },
    });
    const { adapter } = client(fake.endpoint);
    await adapter.start();
    await expect(
      adapter.getGroupMemberRole({ groupId: "10003", userId: "10099" }),
    ).resolves.toEqual({
      status: "ok",
      groupId: "10003",
      userId: "10099",
      role: "qq_group_admin",
    });
    const action = await fake.actions.next((item) => item.action === "get_group_member_info");
    expect(action.params).toEqual({ group_id: 10003, user_id: 10099, no_cache: true });
    await expect(
      adapter.getGroupMemberRole({ groupId: "90000", userId: "10099" }),
    ).resolves.toEqual({ status: "failed", code: "invalid_group" });
    expect(fake.history.filter((item) => item.action === "get_group_member_info")).toHaveLength(1);
  });
  it("fails closed without a member-list fallback when fresh role detail is rejected", async () => {
    const fake = await server({
      onAction(action, socket) {
        if (action.action !== "get_group_member_info") return false;
        socket.send(
          JSON.stringify({
            status: "failed",
            retcode: 1200,
            data: null,
            message: "provider detail failure must not leave the adapter",
            echo: action.echo,
          }),
        );
        return true;
      },
    });
    const { adapter } = client(fake.endpoint);
    await adapter.start();
    await expect(
      adapter.getGroupMemberRole({ groupId: "10003", userId: "10099" }),
    ).resolves.toEqual({
      status: "failed",
      code: "api_rejected",
      retcode: 1200,
    });
    expect(fake.history.some((item) => item.action === "get_group_member_list")).toBe(false);
  });
  it("rejects mismatched fresh role evidence without consulting the member cache", async () => {
    const fake = await server({
      onAction(action, socket) {
        if (action.action !== "get_group_member_info") return false;
        socket.send(
          JSON.stringify({
            status: "ok",
            retcode: 0,
            data: { group_id: 10004, user_id: 10099, role: "admin" },
            echo: action.echo,
          }),
        );
        return true;
      },
    });
    const { adapter } = client(fake.endpoint);
    await adapter.start();
    await expect(
      adapter.getGroupMemberRole({ groupId: "10003", userId: "10099" }),
    ).resolves.toEqual({ status: "unknown", code: "invalid_response" });
    expect(fake.history.some((item) => item.action === "get_group_member_list")).toBe(false);
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
  it("sends validated PNG base64 image segments in direct group and private messages", async () => {
    const fake = await server();
    const { adapter } = client(fake.endpoint);
    await adapter.start();
    const pngBase64 =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADUlEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC";
    expect(
      await adapter.send({
        deliveryId: "group-image",
        target: groupScope,
        text: "截图 Artifact",
        image: { pngBase64 },
      }),
    ).toEqual({ status: "confirmed", messageId: "321" });
    const groupSend = await fake.actions.next((action) => action.action === "send_group_msg");
    expect(groupSend.params.message).toEqual([
      { type: "text", data: { text: "截图 Artifact" } },
      { type: "image", data: { file: `base64://${pngBase64}` } },
    ]);

    const privateTarget = { ...groupScope, chatType: "private" as const, chatId: base.ownerId };
    expect(
      await adapter.send({
        deliveryId: "private-image",
        target: privateTarget,
        text: "截图已生成",
        replyTo: "42",
        image: { pngBase64 },
      }),
    ).toEqual({ status: "confirmed", messageId: "321" });
    const privateSend = await fake.actions.next((action) => action.action === "send_private_msg");
    expect(privateSend.params.message).toEqual([
      { type: "reply", data: { id: "42" } },
      { type: "text", data: { text: "截图已生成" } },
      { type: "image", data: { file: `base64://${pngBase64}` } },
    ]);
  });
  it("rejects malformed, oversized, or merged-forward PNG image payloads before sending", async () => {
    const fake = await server();
    const { adapter } = client(fake.endpoint);
    await adapter.start();
    const oversizedBase64 = "A".repeat(Math.ceil((8 * 1024 * 1024) / 3) * 4 + 4);
    for (const pngBase64 of ["not-base64", oversizedBase64]) {
      expect(
        await adapter.send({
          deliveryId: "invalid-image",
          target: groupScope,
          text: "无效图片",
          image: { pngBase64 },
        }),
      ).toEqual({ status: "failed", code: "invalid_message" });
    }
    expect(
      await adapter.send({
        deliveryId: "long-image",
        target: groupScope,
        text: "长文本".repeat(1_200),
        image: {
          pngBase64:
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADUlEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
        },
      }),
    ).toEqual({ status: "failed", code: "invalid_message" });
    expect(
      fake.history.filter((action) => action.action.startsWith("send_")).map((a) => a.action),
    ).toEqual([]);
  });
  it("delivers a long result as one bounded merged-forward message without truncation", async () => {
    const fake = await server();
    const { adapter } = client(fake.endpoint);
    await adapter.start();
    const text = "调研结果。".repeat(1_200);
    expect(await adapter.send({ deliveryId: "long-result", target: groupScope, text })).toEqual({
      status: "confirmed",
      messageId: "forward:321",
    });
    const sent = await fake.actions.next((action) => action.action === "send_group_forward_msg");
    expect(sent.params.group_id).toBe(10003);
    const nodes = sent.params.messages as Array<{
      type: string;
      data: { user_id: number; nickname: string; content: Array<{ data: { text?: string } }> };
    }>;
    expect(nodes.length).toBeGreaterThan(1);
    expect(nodes.every((node) => node.type === "node" && node.data.user_id === 10001)).toBe(true);
    expect(
      nodes
        .flatMap((node) => node.data.content)
        .map((part) => part.data.text ?? "")
        .join(""),
    ).toBe(text);
    const privateTarget = { ...groupScope, chatType: "private" as const, chatId: base.ownerId };
    expect(
      await adapter.send({ deliveryId: "long-private-result", target: privateTarget, text }),
    ).toEqual({ status: "confirmed", messageId: "forward:321" });
    const privateSent = await fake.actions.next(
      (action) => action.action === "send_private_forward_msg",
    );
    expect(privateSent.params.user_id).toBe(10002);
    expect(privateSent.params).not.toHaveProperty("group_id");
  });
  it("replies privately to the Visitor and rejects cross-account private destinations", async () => {
    const fake = await server();
    const { adapter } = client(fake.endpoint);
    await adapter.start();
    const target = {
      ...groupScope,
      chatType: "private" as const,
      senderId: "10004",
      chatId: "10004",
    };
    expect(
      await adapter.send({ deliveryId: "visitor-dm", target, text: "Visitor result" }),
    ).toEqual({ status: "confirmed", messageId: "321" });
    expect(
      (await fake.actions.next((action) => action.action === "send_private_msg")).params,
    ).toMatchObject({ user_id: 10004 });
    for (const mismatched of [
      { ...target, chatId: base.ownerId },
      { ...target, senderId: base.ownerId },
    ]) {
      expect(
        await adapter.send({ deliveryId: "wrong-dm", target: mismatched, text: "secret" }),
      ).toEqual({ status: "failed", code: "invalid_target" });
    }
    expect(fake.history).toHaveLength(2);
  });
  it("rejects a Bot configured as a Visitor", () => {
    expect(() => parseOneBotConfig({ ...base, visitorIds: [base.botId] })).toThrow(
      "Invalid Visitor",
    );
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
    expect(await errors.next()).toEqual({
      code: "acceptance_failed",
      messageId: "-7",
      groupId: "10003",
    });
    expect(await errors.next()).toEqual({
      code: "acceptance_failed",
      messageId: "-7",
      groupId: "10003",
    });
    expect(received).toEqual(["-7", "-7"]);
  });
  it("reports only fixed metadata when a configured-group message is ignored", async () => {
    const fake = await server();
    const { adapter, diagnostics } = client(fake.endpoint);
    await adapter.start();
    const socket = await fake.connections.next();
    socket.send(
      JSON.stringify(
        inbound({ message: [{ type: "text", data: { text: "private-message-canary" } }] }),
      ),
    );
    const diagnostic = await diagnostics.next();
    expect(diagnostic).toEqual({
      groupId: "10003",
      stage: "ignored",
      reason: "not_addressed",
    });
    expect(JSON.stringify(diagnostic)).not.toContain("private-message-canary");
    expect(JSON.stringify(diagnostic)).not.toContain("10002");
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
    expect(await errors.next()).toEqual({
      code: "ingress_overflow",
      messageId: "8",
      groupId: "10003",
    });
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
