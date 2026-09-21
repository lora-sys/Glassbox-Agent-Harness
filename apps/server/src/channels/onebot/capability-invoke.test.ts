import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { WebSocketServer, type WebSocket } from "ws";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { OneBotAdapter, type OneBotAdapterOptions } from "./adapter.ts";
import { parseOneBotConfig } from "./config.ts";

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

async function server(payload: unknown = { group_id: 10003, group_name: "Fixture" }) {
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
      socket.send(
        JSON.stringify({
          status: "ok",
          retcode: 0,
          data: action.action === "get_login_info" ? { user_id: 10001 } : payload,
          echo: action.echo,
        }),
      );
    });
  });
  await once(wss, "listening");
  return { endpoint: `ws://127.0.0.1:${(wss.address() as AddressInfo).port}/`, actions };
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

describe("OneBot allowlisted capability dispatch", () => {
  it("forwards one registry-allowlisted action and returns its data", async () => {
    const fixture = await server();
    const adapter = client(fixture.endpoint);
    await adapter.start();

    const result = await adapter.invokeCapability({
      action: "get_group_info",
      params: { group_id: 10003, no_cache: true },
    });
    expect(result).toEqual({ status: "ok", data: { group_id: 10003, group_name: "Fixture" } });
    const request = fixture.actions.find((a) => a.action === "get_group_info");
    expect(request?.params).toEqual({ group_id: 10003, no_cache: true });
  });

  it("refuses a raw-send or generic RPC primitive without any provider call", async () => {
    const fixture = await server();
    const adapter = client(fixture.endpoint);
    await adapter.start();

    for (const action of ["send_group_msg", "send_private_msg", "call_action", "send_packet"]) {
      expect(await adapter.invokeCapability({ action, params: { group_id: 10003 } })).toEqual({
        status: "rejected",
        code: "action_not_allowlisted",
      });
    }
    // Nothing reached the socket: the allowlist is checked before the request is built.
    expect(fixture.actions.filter((a) => a.action !== "get_login_info")).toEqual([]);
  });

  it("refuses a group action outside the configured allowlist without any provider call", async () => {
    const fixture = await server();
    const adapter = client(fixture.endpoint);
    await adapter.start();

    expect(
      await adapter.invokeCapability({ action: "get_group_info", params: { group_id: 99999 } }),
    ).toEqual({ status: "rejected", code: "group_not_configured" });
    expect(fixture.actions.filter((a) => a.action !== "get_login_info")).toEqual([]);
  });

  it("refuses a group action that names no group at all", async () => {
    const fixture = await server();
    const adapter = client(fixture.endpoint);
    await adapter.start();

    expect(await adapter.invokeCapability({ action: "get_group_info", params: {} })).toEqual({
      status: "rejected",
      code: "group_not_configured",
    });
  });

  it("refuses capability dispatch when the connection is not ready", async () => {
    const adapter = client("ws://127.0.0.1:1/");
    expect(
      await adapter.invokeCapability({ action: "get_group_info", params: { group_id: 10003 } }),
    ).toEqual({ status: "failed", code: "not_connected" });
  });

  it("dispatches an account-scoped action that names no group", async () => {
    const fixture = await server({ user_id: 10001, nickname: "Fixture bot" });
    const adapter = client(fixture.endpoint);
    await adapter.start();

    const result = await adapter.invokeCapability({ action: "get_status", params: {} });
    expect(result).toEqual({ status: "ok", data: { user_id: 10001, nickname: "Fixture bot" } });
  });
});
