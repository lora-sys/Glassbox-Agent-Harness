import { randomUUID } from "node:crypto";
import { LiveError, fail, id } from "./core.mjs";

/** OneBot forward WebSocket. Native Node WebSocket, no npm dependencies. */
export class OneBot {
  constructor(config, role, { env = process.env, WebSocketClass = globalThis.WebSocket } = {}) {
    this.config = config;
    this.role = role;
    this.account = config[role];
    this.token = env[this.account.tokenEnv];
    this.WebSocketClass = WebSocketClass;
    this.pending = new Map();
    this.listeners = new Set();
    this.closed = false;
    this.problem = null;
    this.mutatingMessages = 0;
  }
  async connect() {
    if (typeof this.token !== "string" || this.token.length < 8 || /[\r\n]/.test(this.token))
      fail("MISSING_TOKEN", `请在本地设置 ${this.account.tokenEnv}，至少 8 个字符。`);
    if (typeof this.WebSocketClass !== "function")
      fail("NODE_VERSION", "需要 Node.js 24.12 或更新版本。");
    const ws = (this.ws = new this.WebSocketClass(this.account.wsUrl, {
      headers: { Authorization: `Bearer ${this.token}` },
    }));
    ws.binaryType = "arraybuffer";
    ws.addEventListener("message", (e) => this.onFrame(e.data));
    ws.addEventListener("error", () =>
      this.break("WS_ERROR", "OneBot 连接错误，请检查登录、端口和 Token。"),
    );
    ws.addEventListener("close", () =>
      this.break("WS_CLOSED", "OneBot 连接中断，本轮不会自动重发消息。"),
    );
    await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => finish(new LiveError("CONNECT_TIMEOUT", "OneBot 连接超时。")),
        this.config.apiTimeoutMs,
      );
      const onOpen = () => finish();
      const onError = () =>
        finish(new LiveError("CONNECT_FAILED", "无法连接 OneBot，请核对正向 WS 端口和 Token。"));
      const finish = (error) => {
        clearTimeout(timer);
        ws.removeEventListener("open", onOpen);
        ws.removeEventListener("error", onError);
        ws.removeEventListener("close", onError);
        if (error) {
          this.close();
          reject(error);
        } else resolve();
      };
      ws.addEventListener("open", onOpen, { once: true });
      ws.addEventListener("error", onError, { once: true });
      ws.addEventListener("close", onError, { once: true });
    });
  }
  break(code, message) {
    if (!this.closed) this.problem ??= new LiveError(code, message);
    for (const item of this.pending.values()) {
      clearTimeout(item.timer);
      item.reject(new LiveError(code, message));
    }
    this.pending.clear();
  }
  onFrame(raw) {
    let text;
    if (typeof raw === "string") text = raw;
    else if (raw instanceof ArrayBuffer) text = Buffer.from(raw).toString("utf8");
    else return this.break("PROTOCOL_FRAME", "OneBot 返回了不支持的消息帧。");
    if (Buffer.byteLength(text) > 1024 * 1024) {
      this.break("PROTOCOL_LIMIT", "OneBot 单帧超过 1 MiB，本轮停止。");
      this.close();
      return;
    }
    let obj;
    try {
      obj = JSON.parse(text);
    } catch {
      this.break("PROTOCOL_JSON", "OneBot 返回无效 JSON。");
      return;
    }
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
      this.break("PROTOCOL_SHAPE", "OneBot 返回格式不正确。");
      return;
    }
    if (typeof obj.echo === "string" && this.pending.has(obj.echo)) {
      const item = this.pending.get(obj.echo);
      this.pending.delete(obj.echo);
      clearTimeout(item.timer);
      if (obj.status !== "ok" || obj.retcode !== 0) {
        item.reject(
          new LiveError(
            "API_REJECTED",
            `OneBot ${item.action} 未确认成功，retcode=${Number.isSafeInteger(obj.retcode) ? obj.retcode : "unknown"}。`,
          ),
        );
      } else item.resolve(obj.data);
      return;
    }
    if (!obj.post_type) return;
    if (id(obj.self_id) !== this.account.qq) {
      this.break("EVENT_IDENTITY", "OneBot 事件账号与配置不符。");
      return;
    }
    if (
      obj.post_type === "meta_event" &&
      obj.meta_event_type === "heartbeat" &&
      obj.status?.online === false
    )
      this.break("ACCOUNT_OFFLINE", "QQ 账号掉线。");
    for (const listener of this.listeners) {
      try {
        listener(obj);
      } catch {
        this.break("OBSERVER_ERROR", "事件观察器出错，本轮停止。");
      }
    }
  }
  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  authorize(action, p, cleanup = false) {
    const groups = this.config.groups.map((g) => g.id);
    if (["get_login_info", "get_status", "get_version_info"].includes(action)) return;
    if (
      action === "get_group_member_info" &&
      groups.includes(id(p.group_id)) &&
      [this.config.bot.qq, this.config.driver.qq, id(this.config.moderation?.target)].includes(
        id(p.user_id),
      ) &&
      id(p.user_id)
    )
      return;
    if (this.role === "driver" && ["send_private_msg", "send_group_msg"].includes(action)) {
      if (action === "send_private_msg" && id(p.user_id) !== this.config.bot.qq)
        fail("TARGET_DENIED", "私聊对象不在允许范围内。");
      if (action === "send_group_msg" && !groups.includes(id(p.group_id)))
        fail("TARGET_DENIED", "群聊对象不在允许范围内。");
      if (
        !Array.isArray(p.message) ||
        p.message.length > 4 ||
        p.message.some(
          (s) =>
            !(
              s?.type === "text" &&
              typeof s.data?.text === "string" &&
              s.data.text.length <= 6000
            ) && !(s?.type === "at" && id(s.data?.qq) === this.config.bot.qq),
        )
      )
        fail("MESSAGE_DENIED", "只允许测试文本和 @ Bot 消息段。");
      if (++this.mutatingMessages > this.config.maxMessages)
        fail("MESSAGE_BUDGET", "本轮消息数量达到上限。");
      return;
    }
    const m = this.config.moderation;
    if (
      cleanup &&
      this.role === "driver" &&
      action === "set_group_ban" &&
      p.duration === 0 &&
      m?.emergencyCleanupViaDriver === true &&
      id(p.user_id) === id(m.target) &&
      id(p.group_id) === this.config.groups.find((g) => g.alias === m.group)?.id
    )
      return;
    fail("ACTION_DENIED", `测试器不允许直接调用 ${action}。`);
  }
  async call(action, params = {}, { cleanup = false } = {}) {
    this.authorize(action, params, cleanup);
    if (this.problem) throw this.problem;
    if (this.closed || this.ws?.readyState !== 1) fail("WS_NOT_READY", "OneBot 连接尚未就绪。");
    const echo = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(echo);
        reject(
          new LiveError(
            "API_TIMEOUT",
            `OneBot ${action} 响应超时。结果未知，不会自动重发。`,
            "INCONCLUSIVE",
          ),
        );
      }, this.config.apiTimeoutMs);
      this.pending.set(echo, { resolve, reject, timer, action });
      try {
        this.ws.send(JSON.stringify({ action, params, echo }));
      } catch {
        this.pending.delete(echo);
        clearTimeout(timer);
        reject(new LiveError("WS_SEND", "OneBot 发送失败，结果未知。", "INCONCLUSIVE"));
      }
    });
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.break("WS_CLOSED", "连接已关闭。");
    try {
      this.ws?.close();
    } catch {
      /* already closed */
    }
  }
}
