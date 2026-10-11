import { randomUUID, createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { resolve, relative, isAbsolute } from "node:path";
import { projectOneBotSendDiagnostic } from "./onebot-send-diagnostic.mjs";

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
export function toolManifestDigest(tools) {
  const sort = (value) =>
    Array.isArray(value)
      ? value.map(sort)
      : value && typeof value === "object"
        ? Object.fromEntries(
            Object.keys(value)
              .sort()
              .map((key) => [key, sort(value[key])]),
          )
        : value;
  return digest(JSON.stringify(sort(JSON.parse(JSON.stringify(tools)))));
}
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
  if (c.mediaFixtures !== undefined) {
    if (
      !c.mediaFixtures ||
      Array.isArray(c.mediaFixtures) ||
      Object.keys(c.mediaFixtures).sort().join(",") !== "enabled,retainAssetsConfirmed,timeoutMs" ||
      typeof c.mediaFixtures.enabled !== "boolean" ||
      typeof c.mediaFixtures.retainAssetsConfirmed !== "boolean"
    )
      fail("CONFIG_MEDIA_FIXTURE", "媒体测试配置必须明确启用和保留测试文件。");
    c.mediaFixtures.timeoutMs = integer(
      c.mediaFixtures.timeoutMs,
      600000,
      1000,
      900000,
      "mediaFixtures.timeoutMs",
    );
  }
  if (
    c.runtime?.expectedSourceTreeSha256 !== undefined &&
    !/^[a-f0-9]{64}$/.test(c.runtime.expectedSourceTreeSha256)
  )
    fail("CONFIG_RUNTIME", "开发验收源代码树哈希必须是 SHA256。");
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
export function validateModeration(c, now = Date.now(), { allowOwnerRequest = false } = {}) {
  const m = c?.moderation;
  if (m?.enabled !== true) fail("MODERATION_DISABLED", "禁言测试默认关闭，需要单独启用。");
  const group = c?.groups?.find((g) => g.alias === m.group);
  const target = id(m.target);
  const authorizationBasis = m.authorizationBasis ?? "member-consent";
  if (m.group !== "B" || !group || !target || [c?.bot?.qq, c?.driver?.qq].includes(target))
    fail("MODERATION_TARGET", "固定禁言只允许群 B 的明确普通成员目标，不能使用 Bot 或发起账号。");
  const duration = integer(m.durationSeconds, 60, 30, 60, "durationSeconds");
  if (authorizationBasis === "member-consent") {
    const confirmedAt = Date.parse(m.consentConfirmedAt ?? "");
    const consentUntil = Date.parse(m.consentUntil ?? "");
    if (
      m.consentConfirmed !== true ||
      !Number.isFinite(confirmedAt) ||
      new Date(confirmedAt).toISOString() !== m.consentConfirmedAt ||
      confirmedAt > now ||
      now - confirmedAt > 15 * 60_000 ||
      !Number.isFinite(consentUntil) ||
      new Date(consentUntil).toISOString() !== m.consentUntil ||
      consentUntil <= now + 2 * c.timeoutMs + duration * 1000
    )
      fail("CONSENT_REQUIRED", "必须记录本轮成员明确同意，并覆盖完整禁言和恢复时段。");
  } else if (authorizationBasis === "group-owner-request" && allowOwnerRequest) {
    const authorizedAt = Date.parse(m.ownerAuthorizationAt ?? "");
    const validUntil = Date.parse(m.ownerAuthorizationUntil ?? "");
    if (
      c?.driver?.qq !== "3526039967" ||
      group.id !== "1126022432" ||
      m.emergencyCleanupViaDriver === true ||
      m.ownerAuthorizationConfirmed !== true ||
      duration !== 30 ||
      m.consentConfirmed === true ||
      (m.consentConfirmedAt !== undefined && m.consentConfirmedAt !== "") ||
      (m.consentUntil !== undefined && m.consentUntil !== "") ||
      !Number.isFinite(authorizedAt) ||
      new Date(authorizedAt).toISOString() !== m.ownerAuthorizationAt ||
      authorizedAt > now ||
      now - authorizedAt > 15 * 60_000 ||
      !Number.isFinite(validUntil) ||
      new Date(validUntil).toISOString() !== m.ownerAuthorizationUntil ||
      !Number.isSafeInteger(c.timeoutMs) ||
      validUntil <= now + 2 * c.timeoutMs + duration * 1000
    )
      fail(
        "OWNER_AUTHORIZATION_REQUIRED",
        "群主请求必须明确确认，并覆盖两个 Run、等待时间和 30 秒禁言。",
      );
  } else {
    fail("CONSENT_REQUIRED", "该禁言授权依据未被当前流程支持。");
  }
  return { ...m, authorizationBasis, target, groupId: group.id, durationSeconds: duration };
}
export function statusOf(cases) {
  if (!cases.length) return "BLOCKED";
  for (const status of ["FAIL", "BLOCKED", "INCONCLUSIVE"])
    if (cases.some((c) => c.status === status)) return status;
  return cases.every((c) => c.status === "PASS") ? "PASS" : "INCONCLUSIVE";
}
export const exitCode = (status) =>
  ({ PASS: 0, FAIL: 1, BLOCKED: 2, INCONCLUSIVE: 3 })[status] ?? 2;
function internalErrorDiagnostic(error) {
  try {
    const types = [
      Error,
      TypeError,
      RangeError,
      SyntaxError,
      ReferenceError,
      EvalError,
      URIError,
      AggregateError,
    ];
    const type = types.find((candidate) => Object.getPrototypeOf(error) === candidate.prototype);
    if (!type) return undefined;
    const root = fileURLToPath(new URL("../../../", import.meta.url));
    let stack;
    try {
      stack = error.stack;
    } catch {
      stack = undefined;
    }
    const frames = [];
    if (typeof stack === "string") {
      // Ignore the first line, which includes the untrusted error message.
      for (const line of stack.split("\n").slice(1)) {
        const match = line.match(
          /^\s+at (?:.*?\()?((?:file:\/\/\/|\/|[A-Za-z]:[\\/]).*\.mjs):(\d{1,8}):(\d{1,8})\)?$/,
        );
        if (!match) continue;
        const absolute = match[1].startsWith("file:") ? fileURLToPath(match[1]) : resolve(match[1]);
        const path = relative(root, absolute).replaceAll("\\", "/");
        if (isAbsolute(path) || !/^tools\/qq-live\/(?:lib\/|test\/)?[a-z0-9-]+\.mjs$/.test(path))
          continue;
        frames.push({ path, line: Number(match[2]), column: Number(match[3]) });
        if (frames.length === 4) break;
      }
    }
    const code = Object.getOwnPropertyDescriptor(error, "code")?.value;
    const sqliteCode = Object.getOwnPropertyDescriptor(error, "errcode")?.value;
    return {
      type: type.name,
      frames,
      ...(code === "ERR_SQLITE_ERROR" &&
      Number.isSafeInteger(sqliteCode) &&
      sqliteCode >= 0 &&
      sqliteCode <= 65535
        ? { sqliteCode }
        : {}),
    };
  } catch {
    return undefined;
  }
}
function safeOneBotSendFailure(error) {
  const failure = Object.getOwnPropertyDescriptor(error, "transportFailure")?.value;
  if (!failure || typeof failure !== "object" || Array.isArray(failure)) return undefined;
  const keys = Object.keys(failure).sort().join(",");
  const retcode = failure.retcode;
  if (!Number.isSafeInteger(retcode) || retcode < 0 || retcode > 2147483647) return undefined;
  if (keys === "retcode") return { retcode };
  if (
    keys === "classification,providerResult,retcode" &&
    failure.classification === "ACCOUNT_REAUTH_REQUIRED" &&
    failure.providerResult === -10003 &&
    retcode === 1200
  )
    return {
      retcode,
      classification: "ACCOUNT_REAUTH_REQUIRED",
      providerResult: -10003,
    };
  return undefined;
}
export function safeError(error) {
  if (error instanceof LiveError) {
    const result = {
      code: error.code,
      status: error.status,
      message: error.message,
    };
    const transportFailure = safeOneBotSendFailure(error);
    if (transportFailure) result.transportFailure = transportFailure;
    const transportDiagnostic = projectOneBotSendDiagnostic(
      Object.getOwnPropertyDescriptor(error, "transportDiagnostic")?.value,
    );
    if (transportDiagnostic) result.transportDiagnostic = transportDiagnostic;
    return result;
  }
  // Untrusted provider/OS errors may contain URLs, tokens or message content.
  const diagnostic = internalErrorDiagnostic(error);
  return {
    code: "INTERNAL_ERROR",
    status: "BLOCKED",
    message: "测试器内部异常。未输出原始错误，以避免泄露凭证。请运行本地自检。",
    ...(diagnostic ? { diagnostic } : {}),
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
