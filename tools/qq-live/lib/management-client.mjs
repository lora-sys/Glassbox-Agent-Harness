import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fail, digest, toolManifestDigest } from "./core.mjs";

export async function acceptanceManagement(runtime, { read = readFile, request = fetch } = {}) {
  if (!runtime?.dataDirectory) fail("ACCEPTANCE_MANAGEMENT", "测试许可需要已验证的数据目录。");
  let token, launch;
  try {
    token = (await read(join(runtime.dataDirectory, "management-token"), "utf8")).trim();
    launch = JSON.parse(await read(join(runtime.dataDirectory, "service-launch.json"), "utf8"));
  } catch {
    fail("ACCEPTANCE_MANAGEMENT", "本机管理认证或服务配置不可读。");
  }
  const port = Number(launch.glassbox?.env?.PORT);
  if (!token || !Number.isInteger(port) || port < 1 || port > 65535)
    fail("ACCEPTANCE_MANAGEMENT", "本机管理认证或端口配置无效。");
  async function call(method, path, body) {
    let response;
    try {
      response = await request(`http://127.0.0.1:${port}/manage/qq-live/leases${path}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(10000),
      });
    } catch {
      fail("ACCEPTANCE_MANAGEMENT", "本机测试许可请求失败，未自动重试。", "INCONCLUSIVE");
    }
    if (!response.ok) fail("ACCEPTANCE_MANAGEMENT", "服务拒绝本机测试许可请求。");
    try {
      return await response.json();
    } catch {
      fail("ACCEPTANCE_MANAGEMENT", "服务未返回有效测试许可回执。", "INCONCLUSIVE");
    }
  }
  return {
    async register(config, c, tools) {
      const marker = /^[a-f0-9]{32}$/.test(c.token) ? c.token : null;
      if (!marker || !c.prompt.startsWith(`GLASSBOX_ACCEPTANCE_V1 ${marker}\n`))
        fail("ACCEPTANCE_MARKER", "功能测试消息必须包含完整许可标记。");
      const ttlMs = Math.min(30 * 60 * 1000, config.timeoutMs + 30000);
      const expiresAt = Date.now() + ttlMs;
      const toolsSha256 = toolManifestDigest(tools);
      const result = await call("POST", "", {
        scope: {
          connectionId: runtime.connectionId,
          botId: config.bot.qq,
          chatType: c.route === "private" ? "private" : "group",
          chatId: c.route === "private" ? config.driver.qq : c.route,
          senderId: config.driver.qq,
          ...(runtime.threadId ? { threadId: runtime.threadId } : {}),
        },
        marker,
        textSha256: digest(c.prompt.replace(/\r\n?/g, "\n")),
        ttlMs,
        expiresAt,
        tools,
      });
      const lease = result.lease ?? result;
      if (
        typeof lease.leaseId !== "string" ||
        !/^[a-f0-9-]{36}$/.test(lease.leaseId) ||
        lease.marker !== marker ||
        !Number.isSafeInteger(lease.expiresAt) ||
        lease.expiresAt <= Date.now() ||
        lease.expiresAt > expiresAt ||
        lease.toolsSha256 !== toolsSha256
      )
        fail("ACCEPTANCE_LEASE_RECEIPT", "服务测试许可回执无效。", "INCONCLUSIVE");
      return { leaseId: lease.leaseId, expiresAt: lease.expiresAt, toolsSha256 };
    },
    async revoke(leaseId) {
      if (!/^[a-f0-9-]{36}$/.test(leaseId ?? "")) fail("ACCEPTANCE_LEASE", "测试许可 ID 无效。");
      const result = await call("DELETE", `/${leaseId}`);
      if (result.active !== false || typeof result.revoked !== "boolean")
        fail("ACCEPTANCE_REVOKE_RECEIPT", "未确认测试许可已经失效。", "INCONCLUSIVE");
      return result;
    },
    async revokeMarker(marker) {
      if (!/^[a-f0-9]{32}$/.test(marker ?? "")) fail("ACCEPTANCE_MARKER", "测试许可标记无效。");
      const result = await call("DELETE", `/by-marker/${marker}`);
      if (result.active !== false || typeof result.revoked !== "boolean")
        fail("ACCEPTANCE_REVOKE_RECEIPT", "未确认测试许可已经失效。", "INCONCLUSIVE");
      return result;
    },
  };
}
