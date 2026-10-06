import test from "node:test";
import assert from "node:assert/strict";
import { acceptanceManagement } from "../lib/management-client.mjs";
import { digest, toolManifestDigest } from "../lib/core.mjs";

const runtime = { dataDirectory: "fixture", connectionId: "connection-test" };
const read = async (path) =>
  path.endsWith("management-token")
    ? "fixture-auth"
    : JSON.stringify({ glassbox: { env: { PORT: "43031" } } });
const token = "a".repeat(32);
const c = { token, route: "private", prompt: `GLASSBOX_ACCEPTANCE_V1 ${token}\nfixture message` };
const config = { driver: { qq: "10001" }, bot: { qq: "10002" }, timeoutMs: 1000 };
test("local client registers exact scope and canonical hash then revokes", async () => {
  const requests = [];
  const leaseId = "12345678-1234-1234-1234-123456789abc";
  const client = await acceptanceManagement(runtime, {
    read,
    request: async (url, options) => {
      requests.push({ url, options });
      return {
        ok: true,
        json: async () =>
          options.method === "POST"
            ? {
                leaseId,
                marker: token,
                expiresAt: Date.now() + 10000,
                toolsSha256: toolManifestDigest(JSON.parse(options.body).tools),
              }
            : { revoked: true, active: false },
      };
    },
  });
  assert.equal((await client.register(config, c, [])).leaseId, leaseId);
  await client.revoke(leaseId);
  assert.equal(requests[0].url, "http://127.0.0.1:43031/manage/qq-live/leases");
  const body = JSON.parse(requests[0].options.body);
  assert.equal(body.textSha256, digest(c.prompt));
  assert.equal(body.scope.senderId, config.driver.qq);
  assert.equal(body.scope.chatId, config.driver.qq);
  assert.deepEqual(body.tools, []);
  assert.ok(Number.isSafeInteger(body.expiresAt));
  assert.ok(body.expiresAt > Date.now());
  assert.ok(body.expiresAt <= Date.now() + body.ttlMs);
  assert.equal(requests[1].options.method, "DELETE");
});
test("registration receipt cannot extend the fixed request deadline", async () => {
  const client = await acceptanceManagement(runtime, {
    read,
    request: async (_url, options) => ({
      ok: true,
      json: async () => ({
        leaseId: "12345678-1234-1234-1234-123456789abc",
        marker: token,
        expiresAt: JSON.parse(options.body).expiresAt + 1,
      }),
    }),
  });
  await assert.rejects(client.register(config, c, []), { code: "ACCEPTANCE_LEASE_RECEIPT" });
});
test("invalid local config and forged receipt fail without leaking authentication", async () => {
  await assert.rejects(acceptanceManagement(runtime, { read: async () => "bad" }), /管理认证/);
  const client = await acceptanceManagement(runtime, {
    read,
    request: async () => ({ ok: true, json: async () => ({ leaseId: "wrong" }) }),
  });
  await assert.rejects(client.register(config, c, []), /许可回执/);
  await assert.rejects(client.register(config, { ...c, prompt: "ordinary" }, []), /许可标记/);
  const offline = await acceptanceManagement(runtime, {
    read,
    request: async () => {
      throw Error("fixture-auth");
    },
  });
  await assert.rejects(
    offline.register(config, c, []),
    (error) => !error.message.includes("fixture-auth") && /许可请求失败/.test(error.message),
  );
});
