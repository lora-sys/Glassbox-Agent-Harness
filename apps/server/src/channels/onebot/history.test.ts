import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { WebSocketServer, type WebSocket } from "ws";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { OneBotAdapter, type OneBotAdapterOptions } from "./adapter.ts";
import { parseOneBotConfig } from "./config.ts";
import { historyCursor } from "./history.ts";

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

/** Fixture server that answers get_group_msg_history with a deterministic page. */
async function server(history: Record<string, unknown>[] = []) {
  const actions: Action[] = [];
  const wss = new WebSocketServer({
    host: "127.0.0.1",
    port: 0,
    verifyClient(info, done) {
      done(info.req.headers.authorization === "Bearer explicit-test-token", 401, "Unauthorized");
    },
  });
  cleanup.push(async () => {
    for (const socket of wss.clients) socket.terminate();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
  });
  wss.on("connection", (socket: WebSocket) => {
    socket.on("message", (data) => {
      const bytes = Array.isArray(data)
        ? Buffer.concat(data)
        : data instanceof ArrayBuffer
          ? Buffer.from(data)
          : data;
      const action = JSON.parse(bytes.toString("utf8")) as Action;
      actions.push(action);
      if (action.action === "get_login_info") {
        socket.send(
          JSON.stringify({
            status: "ok",
            retcode: 0,
            data: { user_id: 10001, nickname: "Fixture bot" },
            echo: action.echo,
          }),
        );
        return;
      }
      if (action.action === "get_group_msg_history") {
        socket.send(
          JSON.stringify({
            status: "ok",
            retcode: 0,
            data: { messages: history },
            echo: action.echo,
          }),
        );
        return;
      }
      socket.send(JSON.stringify({ status: "ok", retcode: 0, data: {}, echo: action.echo }));
    });
  });
  await once(wss, "listening");
  return {
    endpoint: `ws://127.0.0.1:${(wss.address() as AddressInfo).port}/`,
    actions,
  };
}

function historyRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    message_id: 501,
    message_seq: 501,
    real_id: 501,
    time: 1_758_000_000,
    user_id: 10004,
    group_id: 10003,
    message_type: "group",
    sender: { user_id: 10004, nickname: "Visitor" },
    message: [{ type: "text", data: { text: " deploy 回滚 " } }],
    ...overrides,
  };
}

function client(endpoint: string, options: Partial<OneBotAdapterOptions> = {}) {
  const adapter = new OneBotAdapter({
    config: parseOneBotConfig({ ...base, endpoint }),
    token: "explicit-test-token",
    requestTimeoutMs: 500,
    reconnectDelayMs: 20,
    onIncoming: () => {},
    ...options,
  });
  cleanup.push(() => adapter.stop());
  return adapter;
}

describe("OneBot typed group history bridge", () => {
  it("normalizes a history page for an allowlisted group", async () => {
    const fixture = await server([historyRecord()]);
    const adapter = client(fixture.endpoint);
    await adapter.start();

    const result = await adapter.getGroupHistory({ groupId: "10003", count: 20 });
    expect(result).toEqual({
      status: "ok",
      messages: [
        {
          messageId: "501",
          groupId: "10003",
          senderId: "10004",
          senderName: "Visitor",
          mentionTargetIds: [],
          text: "deploy 回滚",
          occurredAt: new Date(1_758_000_000 * 1000).toISOString(),
        },
      ],
      nextCursor: "501",
    });

    const request = fixture.actions.find((a) => a.action === "get_group_msg_history");
    expect(request?.params).toMatchObject({ group_id: 10003, count: 20 });
    // The bridge never forwards a raw message_seq unless a cursor was supplied.
    expect(request?.params).not.toHaveProperty("message_seq");
  });

  it("preserves sender names and every structured mention target", async () => {
    const fixture = await server([
      historyRecord({
        sender: { user_id: 10004, nickname: "Fallback", card: "Ripped" },
        message: [
          { type: "at", data: { qq: "10001" } },
          { type: "text", data: { text: " 你是干啥的 " } },
          { type: "at", data: { qq: "10009" } },
        ],
      }),
    ]);
    const adapter = client(fixture.endpoint);
    await adapter.start();

    const result = await adapter.getGroupHistory({ groupId: "10003" });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.messages[0]).toMatchObject({
      senderName: "Ripped",
      mentionTargetIds: ["10001", "10009"],
      text: "@10001 你是干啥的 @10009",
    });
  });

  it("refuses a group outside the configured allowlist without any RPC", async () => {
    const fixture = await server([historyRecord()]);
    const adapter = client(fixture.endpoint);
    await adapter.start();

    const result = await adapter.getGroupHistory({ groupId: "99999" });
    expect(result).toEqual({ status: "failed", code: "invalid_group" });
    expect(fixture.actions.some((a) => a.action === "get_group_msg_history")).toBe(false);
  });

  it("refuses history when the connection is not ready", async () => {
    const adapter = client("ws://127.0.0.1:1/");
    const result = await adapter.getGroupHistory({ groupId: "10003" });
    expect(result).toEqual({ status: "failed", code: "not_connected" });
  });

  it("passes an explicit cursor through as message_seq and bounds the page size", async () => {
    const fixture = await server([historyRecord({ message_id: 480 })]);
    const adapter = client(fixture.endpoint);
    await adapter.start();

    const result = await adapter.getGroupHistory({ groupId: "10003", cursor: "501", count: 9999 });
    expect(result.status).toBe("ok");
    const request = fixture.actions.find((a) => a.action === "get_group_msg_history");
    expect(request?.params).toMatchObject({
      group_id: 10003,
      message_seq: 501,
      reverse_order: true,
    });
    expect(Number(request?.params.count)).toBeLessThanOrEqual(100);
  });

  it("drops records that do not belong to the requested group", async () => {
    const fixture = await server([
      historyRecord(),
      historyRecord({ message_id: 502, group_id: 10099 }),
      historyRecord({ message_id: 503, message: [{ type: "image", data: { file: "x.jpg" } }] }),
    ]);
    const adapter = client(fixture.endpoint);
    await adapter.start();

    const result = await adapter.getGroupHistory({ groupId: "10003" });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    // A foreign group and an attachment-only message never enter the archive candidate set.
    expect(result.messages.map((m) => m.messageId)).toEqual(["501"]);
  });

  it("derives nextCursor from the chronologically oldest short message id", async () => {
    const fixture = await server([
      historyRecord({ message_id: 901, message_seq: 901, real_seq: 501, time: 1_758_000_003 }),
      historyRecord({ message_id: 777, message_seq: 777, real_seq: 480, time: 1_758_000_001 }),
      historyRecord({ message_id: 103, message_seq: 103, real_seq: 495, time: 1_758_000_002 }),
    ]);
    const adapter = client(fixture.endpoint);
    await adapter.start();

    const result = await adapter.getGroupHistory({ groupId: "10003", count: 100 });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    // Short message ids are not ordered. The oldest timestamp selects id 777 even though
    // id 103 is numerically smaller and real_seq carries a different QQ sequence.
    expect(result.nextCursor).toBe("777");

    const next = await adapter.getGroupHistory({ groupId: "10003", cursor: "777" });
    expect(next.status).toBe("ok");
    const requests = fixture.actions.filter((a) => a.action === "get_group_msg_history");
    expect(requests.at(-1)?.params).toMatchObject({
      group_id: 10003,
      message_seq: 777,
      reverse_order: true,
    });
  });

  it("omits nextCursor when the page carries no provider sequence", async () => {
    const fixture = await server([historyRecord({ message_seq: undefined })]);
    const adapter = client(fixture.endpoint);
    await adapter.start();

    const result = await adapter.getGroupHistory({ groupId: "10003" });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    // Without the provider sequence Glassbox cannot prove the short id is a usable history
    // cursor, so paging stops rather than guessing from the message id alone.
    expect(result.nextCursor).toBeUndefined();
  });

  it("advances the cursor from raw records even when a page normalizes to no text", async () => {
    const fixture = await server([
      historyRecord({
        message_id: 502,
        time: 1_758_000_002,
        message: [{ type: "image", data: {} }],
      }),
      historyRecord({
        message_id: 480,
        time: 1_758_000_001,
        message: [{ type: "image", data: {} }],
      }),
    ]);
    const adapter = client(fixture.endpoint);
    await adapter.start();

    const result = await adapter.getGroupHistory({ groupId: "10003" });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.messages).toEqual([]);
    expect(result.nextCursor).toBe("480");
  });

  it("reports an unknown result when the runtime rejects the action", async () => {
    const wss = new WebSocketServer({
      host: "127.0.0.1",
      port: 0,
      verifyClient(info, done) {
        done(info.req.headers.authorization === "Bearer explicit-test-token", 401, "Unauthorized");
      },
    });
    cleanup.push(async () => {
      for (const socket of wss.clients) socket.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    });
    wss.on("connection", (socket) => {
      socket.on("message", (data) => {
        const bytes = Array.isArray(data)
          ? Buffer.concat(data)
          : data instanceof ArrayBuffer
            ? Buffer.from(data)
            : data;
        const action = JSON.parse(bytes.toString("utf8")) as Action;
        socket.send(
          JSON.stringify({
            status: action.action === "get_login_info" ? "ok" : "failed",
            retcode: action.action === "get_login_info" ? 0 : 1404,
            data: action.action === "get_login_info" ? { user_id: 10001 } : undefined,
            echo: action.echo,
          }),
        );
      });
    });
    await once(wss, "listening");
    const adapter = client(`ws://127.0.0.1:${(wss.address() as AddressInfo).port}/`);
    await adapter.start();

    const result = await adapter.getGroupHistory({ groupId: "10003" });
    expect(result).toEqual({ status: "failed", code: "api_rejected", retcode: 1404 });
  });
});

describe("OneBot history paging cursor", () => {
  it("reads a short message id paired with the provider timestamp", () => {
    const occurredAt = new Date(1_758_000_000 * 1000).toISOString();
    expect(historyCursor({ message_id: 501, message_seq: 501, time: 1_758_000_000 })).toEqual({
      id: "501",
      occurredAt,
    });
    expect(historyCursor({ message_seq: "480", time: 1_758_000_000 })).toEqual({
      id: "480",
      occurredAt,
    });
    expect(
      historyCursor({ message_id: 495, message_seq: 111, real_seq: 480, time: 1_758_000_000 }),
    ).toEqual({ id: "495", occurredAt });
  });

  it("refuses a cursor with a missing or invalid id or timestamp", () => {
    expect(historyCursor({})).toBeUndefined();
    expect(historyCursor({ message_id: 0, message_seq: 0, time: 1_758_000_000 })).toBeUndefined();
    expect(historyCursor({ message_id: -1, message_seq: -1, time: 1_758_000_000 })).toEqual({
      id: "-1",
      occurredAt: new Date(1_758_000_000 * 1000).toISOString(),
    });
    expect(
      historyCursor({ message_id: 1.5, message_seq: 1.5, time: 1_758_000_000 }),
    ).toBeUndefined();
    expect(
      historyCursor({ message_id: "abc", message_seq: "abc", time: 1_758_000_000 }),
    ).toBeUndefined();
    expect(historyCursor({ message_id: 501, message_seq: 501 })).toBeUndefined();
    expect(historyCursor(null)).toBeUndefined();
  });
});
