import { randomUUID, createHash } from "node:crypto";

export class LiveError extends Error {
  constructor(code, message, status = "BLOCKED") {
    super(message);
    this.name = "LiveError";
    this.code = code;
    this.status = status;
  }
}
export const fail = (code, message, status) => {
  throw new LiveError(code, message, status);
};
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export const nonce = () => `QQLIVE_${randomUUID().replaceAll("-", "").slice(0, 20)}`;
export const digest = (value) => createHash("sha256").update(value).digest("hex");
export function id(value) {
  if (typeof value === "number" && Number.isSafeInteger(value)) value = String(value);
  if (typeof value === "string" && /^[1-9]\d{4,15}$/.test(value)) return value;
  return "";
}
export function messageId(value) {
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
  if (typeof value === "string" && /^-?\d{1,20}$/.test(value)) return value;
  return "";
}
export function textOf(message) {
  if (typeof message === "string") return message.replace(/\[CQ:[^\]]*\]/g, "");
  if (!Array.isArray(message)) return "";
  return message
    .filter((s) => s?.type === "text" && typeof s?.data?.text === "string")
    .map((s) => s.data.text)
    .join("");
}
export function routeOf(event, botId, driverId) {
  if (event.message_type === "group") return id(event.group_id);
  if (event.message_type === "private" && [botId, driverId].includes(id(event.user_id)))
    return "private";
  return null;
}
export function endpoint(value, allowRemote = false) {
  let u;
  try {
    u = new URL(value);
  } catch {
    fail("CONFIG_URL", "OneBot 地址必须是完整的 WebSocket 地址。");
  }
  if (!["ws:", "wss:"].includes(u.protocol) || u.username || u.password || u.search || u.hash)
    fail("CONFIG_URL", "OneBot 地址只允许 ws 或 wss，不允许嵌入凭证、查询参数或片段。");
  const local = ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname);
  if (!local && (!allowRemote || u.protocol !== "wss:"))
    fail(
      "CONFIG_REMOTE",
      "默认只连接本机。远程端点必须显式允许且使用 wss。也可使用 SSH 本地转发。",
    );
  return u.href;
}
function integer(value, fallback, min, max, name) {
  value ??= fallback;
  if (!Number.isSafeInteger(value) || value < min || value > max)
    fail("CONFIG_LIMIT", `${name} 超出允许范围。`);
  return value;
}
export function validateConfig(raw, { live = false, now = Date.now() } = {}) {
  if (raw?.schemaVersion !== 1) fail("CONFIG_VERSION", "配置 schemaVersion 必须是 1。");
  const c = structuredClone(raw);
  for (const role of ["driver", "bot"]) {
    if (!c[role] || !id(c[role].qq)) fail("CONFIG_ID", `请填写 ${role}.qq。`);
    c[role].qq = id(c[role].qq);
    c[role].wsUrl = endpoint(c[role].wsUrl, c.allowRemote === true);
    if (!/^[A-Z][A-Z0-9_]{2,80}$/.test(c[role].tokenEnv ?? ""))
      fail("CONFIG_TOKEN_ENV", `请填写 ${role}.tokenEnv 环境变量名。`);
  }
  if (c.bot.qq === c.driver.qq || c.bot.wsUrl === c.driver.wsUrl)
    fail("CONFIG_IDENTITIES", "发起账号和 Bot 必须是两个账号、两个端点。");
  if (!Array.isArray(c.groups) || c.groups.length < 1 || c.groups.length > 2)
    fail("CONFIG_GROUPS", "请配置 1 至 2 个测试群。");
  const aliases = new Set(),
    ids = new Set();
  for (const g of c.groups) {
    if (
      !/^[A-Za-z][A-Za-z0-9_]{0,15}$/.test(g.alias ?? "") ||
      !id(g.id) ||
      aliases.has(g.alias) ||
      ids.has(id(g.id))
    )
      fail("CONFIG_GROUPS", "群别名和群号必须有效且互不重复。");
    g.id = id(g.id);
    aliases.add(g.alias);
    ids.add(g.id);
  }
  c.timeoutMs = integer(c.timeoutMs, 90000, 1000, 300000, "timeoutMs");
  c.apiTimeoutMs = integer(c.apiTimeoutMs, 10000, 500, 30000, "apiTimeoutMs");
  c.settleMs = integer(c.settleMs, 2000, 100, 10000, "settleMs");
  c.minGapMs = integer(c.minGapMs, 2000, 500, 30000, "minGapMs");
  c.maxMessages = integer(c.maxMessages, 12, 1, 30, "maxMessages");
  if (live) {
    if (c.safety?.acceptanceServiceConfirmed !== true || c.safety?.soleConsumerConfirmed !== true)
      fail(
        "ACCEPTANCE_SERVICE_REQUIRED",
        "先确认指定的真实验收服务及数据目录，并且本轮只有一个实例处理测试消息。",
      );
    const until = Date.parse(c.safety?.armedUntil ?? "");
    if (!Number.isFinite(until) || until <= now || until - now > 120 * 60000 + 1000)
      fail("NOT_ARMED", "测试授权窗口未开启或已过期。运行 arm --minutes 30 后再测试。");
  }
  return c;
}
export function validateModeration(c, now = Date.now()) {
  const m = c.moderation;
  if (m?.enabled !== true) fail("MODERATION_DISABLED", "禁言测试默认关闭，需要单独启用。");
  const group = c.groups.find((g) => g.alias === m.group);
  const target = id(m.target);
  if (!group || !target || [c.bot.qq, c.driver.qq].includes(target))
    fail(
      "MODERATION_TARGET",
      "需要指定测试群及同意配合的普通成员，不能使用 Bot 或发起账号作为目标。",
    );
  if (m.consentConfirmed !== true || !(Date.parse(m.consentUntil) > now))
    fail("CONSENT_REQUIRED", "必须确认成员同意，且 consentUntil 尚未过期。");
  const duration = integer(m.durationSeconds, 60, 30, 60, "durationSeconds");
  return { ...m, target, groupId: group.id, durationSeconds: duration };
}
export function statusOf(cases) {
  if (!cases.length) return "BLOCKED";
  for (const status of ["FAIL", "BLOCKED", "INCONCLUSIVE"])
    if (cases.some((c) => c.status === status)) return status;
  return cases.every((c) => c.status === "PASS") ? "PASS" : "INCONCLUSIVE";
}
export const exitCode = (status) =>
  ({ PASS: 0, FAIL: 1, BLOCKED: 2, INCONCLUSIVE: 3 })[status] ?? 2;
export function safeError(error) {
  if (error instanceof LiveError)
    return { code: error.code, status: error.status, message: error.message };
  // Untrusted provider/OS errors may contain URLs, tokens or message content.
  return {
    code: "INTERNAL_ERROR",
    status: "BLOCKED",
    message: "测试器内部异常。未输出原始错误，以避免泄露凭证。请运行本地自检。",
  };
}
export function safeText(value, secrets = []) {
  let s = "";
  for (const character of String(value ?? "")) {
    const code = character.codePointAt(0);
    if ((code >= 32 && code !== 127) || code === 9 || code === 10 || code === 13) s += character;
  }
  for (const secret of secrets.filter(Boolean)) s = s.split(secret).join("[REDACTED]");
  s = s
    .replace(/(?:Bearer\s+)[A-Za-z0-9._~+/-]+=*/gi, "Bearer [REDACTED]")
    .replace(/((?:access_token|api[_-]?key|token)\s*[=:]\s*)[^\s&"']+/gi, "$1[REDACTED]");
  return s.slice(0, 4000);
}
