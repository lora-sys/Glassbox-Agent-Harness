// Test-only, local RFC 6455 fixture. This is NOT a QQ server or a production transport.
import { createServer } from "node:http";
import { createHash } from "node:crypto";
export async function socketFixture(handler, token = "fixture-token-only") {
  const peers = new Set();
  let authCount = 0;
  const server = createServer();
  server.on("upgrade", (req, socket) => {
    if (req.headers.authorization !== `Bearer ${token}`) {
      socket.end("HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    authCount++;
    const key = createHash("sha1")
      .update(req.headers["sec-websocket-key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
      .digest("base64");
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${key}\r\n\r\n`,
    );
    const send = (obj) => {
      const b = Buffer.from(JSON.stringify(obj)),
        h = Buffer.alloc(b.length < 126 ? 2 : 4);
      h[0] = 0x81;
      if (b.length < 126) h[1] = b.length;
      else {
        h[1] = 126;
        h.writeUInt16BE(b.length, 2);
      }
      if (!socket.destroyed) socket.write(Buffer.concat([h, b]));
    };
    const peer = { send, socket };
    peers.add(peer);
    let buf = Buffer.alloc(0);
    socket.on("close", () => peers.delete(peer));
    socket.on("error", () => {});
    socket.on("data", (data) => {
      buf = Buffer.concat([buf, data]);
      while (buf.length >= 2) {
        const opcode = buf[0] & 15,
          masked = !!(buf[1] & 128);
        let n = buf[1] & 127,
          offset = 2;
        if (n === 126) {
          if (buf.length < 4) return;
          n = buf.readUInt16BE(2);
          offset = 4;
        }
        if (n === 127) {
          socket.destroy();
          return;
        }
        if (buf.length < offset + (masked ? 4 : 0) + n) return;
        const mask = masked ? buf.subarray(offset, offset + 4) : null;
        offset += masked ? 4 : 0;
        const body = Buffer.from(buf.subarray(offset, offset + n));
        buf = buf.subarray(offset + n);
        if (mask) for (let i = 0; i < body.length; i++) body[i] ^= mask[i % 4];
        if (opcode === 8) {
          socket.end(Buffer.from([0x88, 0]));
          return;
        }
        if (opcode === 9) {
          socket.write(Buffer.concat([Buffer.from([0x8a, body.length]), body]));
          continue;
        }
        if (opcode === 1) {
          try {
            handler(JSON.parse(body.toString()), send, peer);
          } catch {
            socket.destroy();
          }
        }
      }
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `ws://127.0.0.1:${server.address().port}/`,
    get authCount() {
      return authCount;
    },
    broadcast(obj) {
      for (const p of peers) p.send(obj);
    },
    async close() {
      for (const p of peers) p.socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
export const baseConfig = () => ({
  schemaVersion: 1,
  driver: { qq: "10001", wsUrl: "ws://127.0.0.1:16701/", tokenEnv: "DRIVER_TOKEN" },
  bot: { qq: "10002", wsUrl: "ws://127.0.0.1:16700/", tokenEnv: "BOT_TOKEN" },
  groups: [
    { alias: "A", id: "20001" },
    { alias: "B", id: "20002" },
  ],
  timeoutMs: 1000,
  apiTimeoutMs: 1000,
  settleMs: 100,
  minGapMs: 500,
  maxMessages: 12,
  safety: {
    acceptanceServiceConfirmed: true,
    soleConsumerConfirmed: true,
    armedUntil: new Date(Date.now() + 3600000).toISOString(),
  },
  moderation: {
    enabled: true,
    group: "A",
    target: "10003",
    consentConfirmed: true,
    consentUntil: new Date(Date.now() + 86400000).toISOString(),
    durationSeconds: 60,
    emergencyCleanupViaDriver: false,
  },
});
export async function world({
  mode = "ok",
  ack = "ok",
  online = true,
  initialMute = 0,
  stateField = true,
  delayReply = 0,
} = {}) {
  let driver, bot;
  let mid = 0,
    mute = initialMute;
  const actions = [];
  const messageReads = { driver: new Map(), bot: new Map() };
  const event = (self, from, route, text, messageId = ++mid) => ({
    time: Math.floor(Date.now() / 1000),
    self_id: Number(self),
    post_type: "message",
    message_type: route === "private" ? "private" : "group",
    user_id: Number(from),
    ...(route === "private" ? {} : { group_id: Number(route) }),
    message_id: messageId,
    message: [{ type: "text", data: { text } }],
  });
  const handle = (role) => (req, send) => {
    actions.push({ role, action: req.action, params: req.params });
    const response = (data) => send({ status: "ok", retcode: 0, data, echo: req.echo });
    const me = role === "driver" ? "10001" : "10002";
    if (req.action === "get_login_info") return response({ user_id: Number(me) });
    if (req.action === "get_status") return response({ online, good: true });
    if (req.action === "get_version_info")
      return response({ app_name: "local-test-fixture", app_version: "1" });
    if (req.action === "get_group_member_info")
      return response({
        user_id: Number(req.params.user_id),
        group_id: Number(req.params.group_id),
        role: String(req.params.user_id) === "10003" ? "member" : "admin",
        ...(stateField ? { shut_up_timestamp: mute } : {}),
      });
    if (req.action === "get_msg") {
      const message = messageReads[role].get(String(req.params.message_id));
      if (!message) return send({ status: "failed", retcode: 404, data: null, echo: req.echo });
      return response({
        ...message,
        ...(mode === "wrong-read-id" && role === "driver"
          ? { message_id: Number(message.message_id) + 1 }
          : {}),
        ...(mode === "binding-sequence-mismatch" && role === "bot"
          ? { real_seq: String(Number(message.real_seq) + 1) }
          : {}),
        ...(mode === "binding-text-mismatch" && role === "bot"
          ? {
              message: [
                { type: "text", data: { text: `${message.message[0].data.text} changed` } },
              ],
            }
          : {}),
      });
    }
    if (req.action === "set_group_ban") {
      mute = 0;
      return response(null);
    }
    if (req.action.startsWith("send_")) {
      if (ack === "reject") {
        send({ status: "failed", retcode: 100, data: { message_id: 99 }, echo: req.echo });
        return;
      }
      if (ack === "timeout") return;
      const route = req.action === "send_private_msg" ? "private" : String(req.params.group_id);
      const text = req.params.message
        .filter((s) => s.type === "text")
        .map((s) => s.data.text)
        .join("");
      const outgoingId = ++mid;
      const incomingId = ++mid;
      const time = Math.floor(Date.now() / 1000);
      const realSequence = String(500 + Math.floor(mid / 2));
      const common = {
        user_id: 10001,
        sender: { user_id: 10001 },
        message_type: route === "private" ? "private" : "group",
        ...(route === "private" ? {} : { group_id: Number(route) }),
        time,
        real_seq: realSequence,
        message: [{ type: "text", data: { text } }],
      };
      messageReads.driver.set(String(outgoingId), {
        ...common,
        self_id: 10001,
        message_id: outgoingId,
      });
      messageReads.bot.set(String(incomingId), {
        ...common,
        self_id: 10002,
        message_id: incomingId,
      });
      // Deliberately emit the actual input before the API response to test races.
      bot.broadcast(event("10002", "10001", route, text, incomingId));
      if (mode === "duplicate-input") {
        const duplicateId = ++mid;
        messageReads.bot.set(String(duplicateId), {
          ...common,
          self_id: 10002,
          message_id: duplicateId,
        });
        bot.broadcast(event("10002", "10001", route, text, duplicateId));
      }
      response({ message_id: outgoingId });
      if (mode === "silent") return;
      const marker = text.match(/QQLIVE_[A-Za-z0-9_]+/)?.[0] ?? "";
      const replyRoute = mode === "wrong" ? (route === "20002" ? "20001" : "20002") : route;
      const reply = event(
        "10001",
        "10002",
        replyRoute,
        mode === "mismatch" ? marker + " wrong" : marker + " result: 42",
      );
      const sendReply = () => {
        driver.broadcast(reply);
        if (mode === "replay") driver.broadcast(reply);
        if (mode === "duplicate") driver.broadcast({ ...reply, message_id: ++mid });
      };
      if (delayReply) setTimeout(sendReply, delayReply);
      else sendReply();
      if (text.includes("禁言") && mode !== "pretend") {
        const lift = text.includes("解除");
        mute = lift ? 0 : Math.floor(Date.now() / 1000) + 60;
        const n = {
          time: Math.floor(Date.now() / 1000),
          self_id: 10001,
          post_type: "notice",
          notice_type: "group_ban",
          group_id: Number(route),
          user_id: 10003,
          operator_id: 10002,
          sub_type: lift ? "lift_ban" : "ban",
          duration: lift ? 0 : 60,
        };
        driver.broadcast(n);
      }
      return;
    }
    response(null);
  };
  driver = await socketFixture(handle("driver"));
  bot = await socketFixture(handle("bot"));
  const config = baseConfig();
  config.driver.wsUrl = driver.url;
  config.bot.wsUrl = bot.url;
  return {
    config,
    actions,
    driver,
    bot,
    close: async () => {
      await driver.close();
      await bot.close();
    },
  };
}
