import { randomUUID } from "node:crypto";
import { LiveError, fail, id, messageId as parseMessageId, digest } from "./core.mjs";
import { projectGroupInfo } from "./group-info-evidence.mjs";
import { projectGroupMemberRole } from "./group-member-role-evidence.mjs";
import { projectGroupFiles } from "./group-files-evidence.mjs";
import { classifyOneBotSendFailure } from "./onebot-send-failure.mjs";
import { diagnoseOneBotSendFailure } from "./onebot-send-diagnostic.mjs";

const MEMBER_COUNT_READ = Symbol("fixed-group-member-count-read");
const BOT_GROUP_ROLE_READ = Symbol("fixed-bot-group-role-read");
const GROUP_INFO_READ = Symbol("fixed-group-info-read");
const GROUP_FILES_READ = Symbol("fixed-group-root-files-read");
const OWNER_BOT_HISTORY_READ = Symbol("fixed-owner-bot-private-history-read");
const BOT_OWNER_HISTORY_READ = Symbol("fixed-bot-owner-private-history-read");
const OWNER_BOT_MEDIA_HISTORY_READ = Symbol("fixed-owner-bot-private-media-history-read");
const BOT_OWNER_MEDIA_HISTORY_READ = Symbol("fixed-bot-owner-private-media-history-read");
const OWNER_BOT_HISTORY_LIMIT = 20;
const SHA256 = /^[a-f0-9]{64}$/u;

function projectPrivateMediaHistory(result, client, peerId, expected) {
  if (
    !result ||
    typeof result !== "object" ||
    Array.isArray(result) ||
    Object.keys(result).length !== 1 ||
    !Array.isArray(result.messages) ||
    result.messages.length > OWNER_BOT_HISTORY_LIMIT
  )
    fail("PRIVATE_MEDIA_HISTORY_INVALID", "固定私聊媒体历史响应无效。", "INCONCLUSIVE");
  const matches = [];
  for (const row of result.messages) {
    if (
      !row ||
      typeof row !== "object" ||
      Array.isArray(row) ||
      id(row.self_id) !== client.account.qq ||
      row.message_type !== "private" ||
      !parseMessageId(row.message_id) ||
      !id(row.sender?.user_id) ||
      ![client.config.driver.qq, client.config.bot.qq].includes(id(row.sender.user_id)) ||
      !id(row.user_id) ||
      ![client.config.driver.qq, client.config.bot.qq].includes(id(row.user_id)) ||
      !Number.isSafeInteger(row.time) ||
      row.time <= 0 ||
      typeof row.real_seq !== "string" ||
      !/^\d{1,20}$/u.test(row.real_seq) ||
      !Array.isArray(row.message) ||
      row.message.length === 0
    )
      fail("PRIVATE_MEDIA_HISTORY_INVALID", "固定私聊媒体历史响应无效。", "INCONCLUSIVE");

    const textSegments = row.message.filter((segment) => segment?.type === "text");
    const mediaSegments = row.message.filter((segment) =>
      ["image", "video"].includes(segment?.type),
    );
    if (textSegments.length === row.message.length) {
      if (textSegments.some((segment) => typeof segment.data?.text !== "string"))
        fail("PRIVATE_MEDIA_HISTORY_INVALID", "固定私聊媒体历史响应无效。", "INCONCLUSIVE");
      continue;
    }
    if (
      textSegments.length !== 1 ||
      mediaSegments.length !== 1 ||
      row.message.length !== 2 ||
      textSegments.some((segment) => typeof segment.data?.text !== "string")
    )
      fail("PRIVATE_MEDIA_HISTORY_INVALID", "固定私聊媒体历史响应无效。", "INCONCLUSIVE");
    const data = mediaSegments[0].data;
    const locatorPresent =
      data &&
      typeof data === "object" &&
      !Array.isArray(data) &&
      [data.file, data.url, data.file_id].some(
        (value) => typeof value === "string" && value.length > 0 && value.length <= 4096,
      );
    if (!locatorPresent)
      fail("PRIVATE_MEDIA_HISTORY_INVALID", "固定私聊媒体历史响应无效。", "INCONCLUSIVE");
    const caption = textSegments[0].data.text;
    const captionSha256 = digest(caption);
    if (
      id(row.sender.user_id) !== id(peerId) ||
      mediaSegments[0].type !== expected.mediaType ||
      captionSha256 !== expected.captionSha256 ||
      row.time < expected.afterTime - 1 ||
      row.time > Math.floor(Date.now() / 1000) + 5
    )
      continue;
    matches.push({
      messageId: parseMessageId(row.message_id),
      selfId: id(row.self_id),
      senderId: id(row.sender.user_id),
      userId: id(row.user_id),
      messageType: row.message_type,
      time: row.time,
      realSequence: row.real_seq,
      textBytes: Buffer.byteLength(caption),
      textSha256: captionSha256,
      mediaType: mediaSegments[0].type,
      mediaLocatorPresent: true,
      segmentCount: row.message.length,
      segmentTypes: row.message.map((segment) => segment.type),
    });
  }
  return matches;
}

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
    this.knownMessageReads = new Set();
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
        const knownFailure = classifyOneBotSendFailure(item.action, obj);
        const error = new LiveError(
          "API_REJECTED",
          `OneBot ${item.action} 未确认成功，retcode=${Number.isSafeInteger(obj.retcode) ? obj.retcode : "unknown"}。${knownFailure?.message ?? ""}`,
        );
        if (
          ["send_private_msg", "send_group_msg"].includes(item.action) &&
          Number.isSafeInteger(obj.retcode) &&
          obj.retcode >= 0 &&
          obj.retcode <= 2147483647
        ) {
          error.transportFailure = {
            retcode: obj.retcode,
            ...(knownFailure
              ? {
                  classification: knownFailure.kind,
                  providerResult: knownFailure.providerResult,
                }
              : {}),
          };
        }
        const diagnostic = diagnoseOneBotSendFailure(item.action, obj);
        if (diagnostic) error.transportDiagnostic = diagnostic;
        item.reject(error);
      } else {
        if (item.action === "send_private_msg" || item.action === "send_group_msg") {
          const sentId = parseMessageId(obj.data?.message_id);
          if (sentId) this.allowMessageRead(sentId);
        }
        item.resolve(obj.data);
      }
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
  allowMessageRead(messageId) {
    const key = parseMessageId(messageId);
    if (!key) fail("MESSAGE_READ_DENIED", "消息查询标识无效。");
    if (this.knownMessageReads.size >= 64 && !this.knownMessageReads.has(key))
      fail("MESSAGE_READ_LIMIT", "本轮消息查询达到上限。");
    this.knownMessageReads.add(key);
  }
  async readOwnerBotPrivateHistory() {
    if (this.role !== "driver" || !id(this.config.bot?.qq))
      fail("PRIVATE_HISTORY_DENIED", "仅发起账号可读取与配置 Bot 的固定私聊记录。", "INCONCLUSIVE");
    let result;
    try {
      result = await this.#call(
        "get_friend_msg_history",
        {
          user_id: this.config.bot.qq,
          count: OWNER_BOT_HISTORY_LIMIT,
          reverse_order: true,
          disable_get_url: true,
          parse_mult_msg: false,
        },
        false,
        OWNER_BOT_HISTORY_READ,
      );
    } catch {
      fail("PRIVATE_HISTORY_UNAVAILABLE", "无法读取配置 Bot 的固定私聊历史。", "INCONCLUSIVE");
    }
    if (
      !result ||
      typeof result !== "object" ||
      Array.isArray(result) ||
      Object.keys(result).length !== 1 ||
      !Array.isArray(result.messages) ||
      result.messages.length === 0 ||
      result.messages.length > OWNER_BOT_HISTORY_LIMIT
    )
      fail("PRIVATE_HISTORY_INVALID", "固定私聊历史响应格式无效。", "INCONCLUSIVE");

    const messages = result.messages.map((row) => {
      if (
        !row ||
        typeof row !== "object" ||
        Array.isArray(row) ||
        id(row.self_id) !== this.account.qq ||
        row.message_type !== "private" ||
        !parseMessageId(row.message_id) ||
        !id(row.sender?.user_id) ||
        ![this.config.driver.qq, this.config.bot.qq].includes(id(row.sender.user_id)) ||
        !id(row.user_id) ||
        ![this.config.driver.qq, this.config.bot.qq].includes(id(row.user_id)) ||
        !Number.isSafeInteger(row.time) ||
        row.time <= 0 ||
        typeof row.real_seq !== "string" ||
        !/^\d{1,20}$/.test(row.real_seq) ||
        !Array.isArray(row.message) ||
        row.message.length === 0 ||
        row.message.some(
          (segment) => segment?.type !== "text" || typeof segment.data?.text !== "string",
        )
      )
        fail("PRIVATE_HISTORY_INVALID", "固定私聊历史响应格式无效。", "INCONCLUSIVE");
      const text = row.message.map((segment) => segment.data.text).join("");
      return {
        messageId: parseMessageId(row.message_id),
        selfId: id(row.self_id),
        senderId: id(row.sender.user_id),
        userId: id(row.user_id),
        messageType: row.message_type,
        time: row.time,
        realSequence: row.real_seq,
        textBytes: Buffer.byteLength(text),
        textSha256: digest(text),
        segmentTypes: row.message.map((segment) => segment.type),
      };
    });
    return {
      accountIdentity: this.account.qq,
      peerId: this.config.bot.qq,
      messages,
    };
  }
  async readBotOwnerPrivateHistory() {
    if (this.role !== "bot" || !id(this.config.driver?.qq))
      fail(
        "PRIVATE_HISTORY_DENIED",
        "仅配置 Bot 可读取与配置 Owner 的固定私聊记录。",
        "INCONCLUSIVE",
      );
    let result;
    try {
      result = await this.#call(
        "get_friend_msg_history",
        {
          user_id: this.config.driver.qq,
          count: OWNER_BOT_HISTORY_LIMIT,
          reverse_order: true,
          disable_get_url: true,
          parse_mult_msg: false,
        },
        false,
        BOT_OWNER_HISTORY_READ,
      );
    } catch {
      fail("PRIVATE_HISTORY_UNAVAILABLE", "无法读取配置 Owner 的固定私聊历史。", "INCONCLUSIVE");
    }
    if (
      !result ||
      typeof result !== "object" ||
      Array.isArray(result) ||
      Object.keys(result).length !== 1 ||
      !Array.isArray(result.messages) ||
      result.messages.length === 0 ||
      result.messages.length > OWNER_BOT_HISTORY_LIMIT
    )
      fail("PRIVATE_HISTORY_INVALID", "固定私聊历史响应格式无效。", "INCONCLUSIVE");

    const messages = result.messages.map((row) => {
      if (
        !row ||
        typeof row !== "object" ||
        Array.isArray(row) ||
        id(row.self_id) !== this.account.qq ||
        row.message_type !== "private" ||
        !parseMessageId(row.message_id) ||
        !id(row.sender?.user_id) ||
        ![this.config.driver.qq, this.config.bot.qq].includes(id(row.sender.user_id)) ||
        !id(row.user_id) ||
        ![this.config.driver.qq, this.config.bot.qq].includes(id(row.user_id)) ||
        !Number.isSafeInteger(row.time) ||
        row.time <= 0 ||
        typeof row.real_seq !== "string" ||
        !/^\d{1,20}$/.test(row.real_seq) ||
        !Array.isArray(row.message) ||
        row.message.length === 0 ||
        row.message.some(
          (segment) => segment?.type !== "text" || typeof segment.data?.text !== "string",
        )
      )
        fail("PRIVATE_HISTORY_INVALID", "固定私聊历史响应格式无效。", "INCONCLUSIVE");
      const text = row.message.map((segment) => segment.data.text).join("");
      return {
        messageId: parseMessageId(row.message_id),
        selfId: id(row.self_id),
        senderId: id(row.sender.user_id),
        userId: id(row.user_id),
        messageType: row.message_type,
        time: row.time,
        realSequence: row.real_seq,
        textBytes: Buffer.byteLength(text),
        textSha256: digest(text),
        segmentTypes: row.message.map((segment) => segment.type),
      };
    });
    return {
      accountIdentity: this.account.qq,
      peerId: this.config.driver.qq,
      messages,
    };
  }
  async readOwnerBotPrivateMediaHistory(expected) {
    if (this.role !== "driver" || !id(this.config.bot?.qq))
      fail(
        "PRIVATE_MEDIA_HISTORY_DENIED",
        "仅发起账号可检查配置 Bot 的固定私聊媒体。",
        "INCONCLUSIVE",
      );
    if (
      !expected ||
      typeof expected !== "object" ||
      Array.isArray(expected) ||
      Object.keys(expected).sort().join(",") !== "afterTime,captionSha256,mediaType" ||
      !["image", "video"].includes(expected.mediaType) ||
      !SHA256.test(expected.captionSha256 ?? "") ||
      !Number.isFinite(Date.parse(expected.afterTime))
    )
      fail("PRIVATE_MEDIA_HISTORY_INVALID", "固定私聊媒体筛选条件无效。", "INCONCLUSIVE");
    let result;
    try {
      result = await this.#call(
        "get_friend_msg_history",
        {
          user_id: this.config.bot.qq,
          count: OWNER_BOT_HISTORY_LIMIT,
          reverse_order: true,
          disable_get_url: true,
          parse_mult_msg: false,
        },
        false,
        OWNER_BOT_MEDIA_HISTORY_READ,
      );
    } catch {
      fail(
        "PRIVATE_MEDIA_HISTORY_UNAVAILABLE",
        "无法读取配置 Bot 的固定私聊媒体记录。",
        "INCONCLUSIVE",
      );
    }
    const messages = projectPrivateMediaHistory(result, this, this.config.bot.qq, {
      mediaType: expected.mediaType,
      captionSha256: expected.captionSha256,
      afterTime: Math.floor(Date.parse(expected.afterTime) / 1000),
    });
    return {
      accountIdentity: this.account.qq,
      peerId: this.config.bot.qq,
      messages,
    };
  }
  async readBotOwnerPrivateMediaHistory(expected) {
    if (this.role !== "bot" || !id(this.config.driver?.qq))
      fail(
        "PRIVATE_MEDIA_HISTORY_DENIED",
        "仅配置 Bot 可检查与配置 Owner 的固定私聊媒体。",
        "INCONCLUSIVE",
      );
    if (
      !expected ||
      typeof expected !== "object" ||
      Array.isArray(expected) ||
      Object.keys(expected).sort().join(",") !== "afterTime,captionSha256,mediaType" ||
      !["image", "video"].includes(expected.mediaType) ||
      !SHA256.test(expected.captionSha256 ?? "") ||
      !Number.isFinite(Date.parse(expected.afterTime))
    )
      fail("PRIVATE_MEDIA_HISTORY_INVALID", "固定私聊媒体筛选条件无效。", "INCONCLUSIVE");
    let result;
    try {
      result = await this.#call(
        "get_friend_msg_history",
        {
          user_id: this.config.driver.qq,
          count: OWNER_BOT_HISTORY_LIMIT,
          reverse_order: true,
          disable_get_url: true,
          parse_mult_msg: false,
        },
        false,
        BOT_OWNER_MEDIA_HISTORY_READ,
      );
    } catch {
      fail(
        "PRIVATE_MEDIA_HISTORY_UNAVAILABLE",
        "无法读取配置 Owner 的固定私聊媒体记录。",
        "INCONCLUSIVE",
      );
    }
    const messages = projectPrivateMediaHistory(result, this, this.config.bot.qq, {
      mediaType: expected.mediaType,
      captionSha256: expected.captionSha256,
      afterTime: Math.floor(Date.parse(expected.afterTime) / 1000),
    });
    return {
      accountIdentity: this.account.qq,
      peerId: this.config.driver.qq,
      messages,
    };
  }
  async readGroupMemberCount() {
    if (this.role !== "bot")
      fail("MEMBER_COUNT_DENIED", "仅 Bot 可读取固定测试群成员数量。", "INCONCLUSIVE");
    const groups = this.config.groups?.filter((group) => group.alias === "A") ?? [];
    const groupId = groups.length === 1 ? id(groups[0].id) : "";
    if (!groupId) fail("MEMBER_COUNT_DENIED", "固定测试群配置无效。", "INCONCLUSIVE");
    let rows;
    try {
      rows = await this.#call(
        "get_group_member_list",
        { group_id: groupId },
        false,
        MEMBER_COUNT_READ,
      );
    } catch {
      fail("MEMBER_COUNT_UNAVAILABLE", "无法确认固定测试群成员数量。", "INCONCLUSIVE");
    }
    if (!Array.isArray(rows))
      fail("MEMBER_COUNT_INVALID", "固定测试群成员响应格式无效。", "INCONCLUSIVE");
    const seen = new Set();
    for (const member of rows) {
      if (
        !member ||
        typeof member !== "object" ||
        Array.isArray(member) ||
        id(member.group_id) !== groupId ||
        !id(member.user_id) ||
        seen.has(id(member.user_id))
      )
        fail("MEMBER_COUNT_INVALID", "固定测试群成员响应格式无效。", "INCONCLUSIVE");
      seen.add(id(member.user_id));
    }
    if (!seen.has(id(this.config.bot.qq)) || !seen.has(id(this.config.driver.qq)))
      fail("MEMBER_COUNT_INVALID", "固定测试群成员响应格式无效。", "INCONCLUSIVE");
    return seen.size;
  }
  async readGroupInfo() {
    const groups = this.config.groups?.filter((group) => group.alias === "A") ?? [];
    const groupId = groups.length === 1 ? id(groups[0].id) : "";
    if (this.role !== "bot" || !groupId)
      fail("GROUP_INFO_DENIED", "仅 Bot 可读取固定测试群 A 的群信息。", "INCONCLUSIVE");
    try {
      const result = await this.#call(
        "get_group_info",
        { group_id: groupId },
        false,
        GROUP_INFO_READ,
      );
      return projectGroupInfo(result, groupId);
    } catch {
      fail("GROUP_INFO_UNAVAILABLE", "无法独立确认固定测试群信息。", "INCONCLUSIVE");
    }
  }
  async readBotGroupMemberRole() {
    const groups = this.config.groups?.filter((group) => group.alias === "B") ?? [];
    const groupId = groups.length === 1 ? id(groups[0].id) : "";
    const botId = id(this.config.bot?.qq);
    if (this.role !== "bot" || !groupId || !botId)
      fail(
        "GROUP_MEMBER_ROLE_DENIED",
        "仅 Bot 可读取配置测试群 B 中 Bot 自身的角色。",
        "INCONCLUSIVE",
      );
    try {
      const result = await this.#call(
        "get_group_member_info",
        { group_id: groupId, user_id: botId, no_cache: true },
        false,
        BOT_GROUP_ROLE_READ,
      );
      return projectGroupMemberRole(result, groupId, botId);
    } catch {
      fail(
        "GROUP_MEMBER_ROLE_UNAVAILABLE",
        "无法独立确认 Bot 在固定测试群中的角色。",
        "INCONCLUSIVE",
      );
    }
  }
  authorize(action, p, cleanup = false, capability) {
    const groups = this.config.groups.map((g) => g.id);
    if (["get_login_info", "get_status", "get_version_info"].includes(action)) return;
    if (
      capability === GROUP_FILES_READ &&
      this.role === "bot" &&
      action === "get_group_root_files" &&
      this.config.groups.filter((group) => group.alias === "A").length === 1 &&
      id(p.group_id) === id(this.config.groups.find((group) => group.alias === "A")?.id) &&
      Object.keys(p).join(",") === "group_id"
    )
      return;
    if (
      capability === GROUP_INFO_READ &&
      this.role === "bot" &&
      action === "get_group_info" &&
      this.config.groups.filter((group) => group.alias === "A").length === 1 &&
      id(p.group_id) === id(this.config.groups.find((group) => group.alias === "A")?.id) &&
      Object.keys(p).join(",") === "group_id"
    )
      return;
    if (
      capability === BOT_GROUP_ROLE_READ &&
      this.role === "bot" &&
      action === "get_group_member_info" &&
      this.config.groups.filter((group) => group.alias === "B").length === 1 &&
      id(p.group_id) === id(this.config.groups.find((group) => group.alias === "B")?.id) &&
      id(p.user_id) === id(this.config.bot.qq) &&
      p.no_cache === true &&
      Object.keys(p).sort().join(",") === "group_id,no_cache,user_id"
    )
      return;
    if (
      capability === MEMBER_COUNT_READ &&
      this.role === "bot" &&
      action === "get_group_member_list" &&
      this.config.groups.filter((group) => group.alias === "A").length === 1 &&
      groups.includes(id(this.config.groups.find((group) => group.alias === "A")?.id)) &&
      id(p.group_id) === id(this.config.groups.find((group) => group.alias === "A")?.id) &&
      Object.keys(p).join(",") === "group_id"
    )
      return;
    if (
      capability === OWNER_BOT_HISTORY_READ &&
      this.role === "driver" &&
      action === "get_friend_msg_history" &&
      id(this.config.bot?.qq) &&
      p.user_id === this.config.bot.qq &&
      p.count === OWNER_BOT_HISTORY_LIMIT &&
      p.reverse_order === true &&
      p.disable_get_url === true &&
      p.parse_mult_msg === false &&
      Object.keys(p).sort().join(",") ===
        "count,disable_get_url,parse_mult_msg,reverse_order,user_id"
    )
      return;
    if (
      capability === BOT_OWNER_HISTORY_READ &&
      this.role === "bot" &&
      action === "get_friend_msg_history" &&
      id(this.config.driver?.qq) &&
      p.user_id === this.config.driver.qq &&
      p.count === OWNER_BOT_HISTORY_LIMIT &&
      p.reverse_order === true &&
      p.disable_get_url === true &&
      p.parse_mult_msg === false &&
      Object.keys(p).sort().join(",") ===
        "count,disable_get_url,parse_mult_msg,reverse_order,user_id"
    )
      return;
    if (
      capability === OWNER_BOT_MEDIA_HISTORY_READ &&
      this.role === "driver" &&
      action === "get_friend_msg_history" &&
      id(this.config.bot?.qq) &&
      p.user_id === this.config.bot.qq &&
      p.count === OWNER_BOT_HISTORY_LIMIT &&
      p.reverse_order === true &&
      p.disable_get_url === true &&
      p.parse_mult_msg === false &&
      Object.keys(p).sort().join(",") ===
        "count,disable_get_url,parse_mult_msg,reverse_order,user_id"
    )
      return;
    if (
      capability === BOT_OWNER_MEDIA_HISTORY_READ &&
      this.role === "bot" &&
      action === "get_friend_msg_history" &&
      id(this.config.driver?.qq) &&
      p.user_id === this.config.driver.qq &&
      p.count === OWNER_BOT_HISTORY_LIMIT &&
      p.reverse_order === true &&
      p.disable_get_url === true &&
      p.parse_mult_msg === false &&
      Object.keys(p).sort().join(",") ===
        "count,disable_get_url,parse_mult_msg,reverse_order,user_id"
    )
      return;
    if (action === "get_msg" && this.knownMessageReads.has(parseMessageId(p.message_id))) return;
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
    return this.#call(action, params, cleanup);
  }
  async readGroupRootFiles() {
    const groups = this.config.groups?.filter((group) => group.alias === "A") ?? [];
    const groupId = groups.length === 1 ? id(groups[0].id) : "";
    if (this.role !== "bot" || !groupId)
      fail("GROUP_FILES_DENIED", "仅 Bot 可读取固定测试群 A 的根目录第一页。", "INCONCLUSIVE");
    try {
      const result = await this.#call(
        "get_group_root_files",
        { group_id: groupId },
        false,
        GROUP_FILES_READ,
      );
      return projectGroupFiles(result, groupId);
    } catch {
      fail("GROUP_FILES_UNAVAILABLE", "无法独立确认固定测试群文件读取结果。", "INCONCLUSIVE");
    }
  }
  async #call(action, params = {}, cleanup = false, capability) {
    this.authorize(action, params, cleanup, capability);
    if (action === "get_msg") this.knownMessageReads.delete(parseMessageId(params.message_id));
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
  async closeAndDrain() {
    const socket = this.ws;
    if (this.problem) {
      this.close();
      throw this.problem;
    }
    if (!socket || socket.readyState === 3) {
      this.close();
      return;
    }
    await new Promise((resolve, reject) => {
      const finish = (error) => {
        clearTimeout(timer);
        socket.removeEventListener("close", onClose);
        if (error) reject(error);
        else resolve();
      };
      const onClose = (event) => {
        if (![1000, 1005].includes(event.code))
          finish(new LiveError("WS_CLOSE_UNCONFIRMED", "OneBot 关闭未获正常确认。"));
        else finish();
      };
      const timer = setTimeout(
        () => finish(new LiveError("WS_CLOSE_TIMEOUT", "OneBot 关闭确认超时。")),
        this.config.apiTimeoutMs,
      );
      socket.addEventListener("close", onClose, { once: true });
      this.close();
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
