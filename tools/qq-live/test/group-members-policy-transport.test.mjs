import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { OneBot } from "../lib/onebot.mjs";
import { Recorder, replyCase } from "../lib/runner.mjs";
import { digest, toolManifestDigest } from "../lib/core.mjs";
import { groupMembersPolicyStep } from "../lib/group-members-policy-scenario.mjs";
import { verifyGroupMembersPolicyFailureWithLeaseCleanup } from "../lib/group-members-policy-case-evidence.mjs";
import { verifyMessageBindings, verifyTraceEvidence } from "../lib/product-evidence.mjs";
import { verifyGroupMembersPolicyStep } from "../lib/group-members-policy-step-verifier.mjs";
import { world } from "./fixture.mjs";

const env = { DRIVER_TOKEN: "fixture-token-only", BOT_TOKEN: "fixture-token-only" };
const REFUSAL = "未能从 QQ 获取该信息，因此无法确认。";

async function setup(t, options = {}) {
  const w = await world({ replyText: REFUSAL, ...options });
  const clients = {
    driver: new OneBot(w.config, "driver", { env }),
    bot: new OneBot(w.config, "bot", { env }),
  };
  t.after(async () => {
    clients.driver.close();
    clients.bot.close();
    await w.close();
  });
  await clients.driver.connect();
  await clients.bot.connect();
  const recorder = new Recorder(w.config, Object.values(env));
  for (const role of ["driver", "bot"])
    clients[role].subscribe((event) => recorder.ingest(role, event));
  return { ...w, clients, recorder };
}

async function runMembersCheck(w, beforeSend) {
  return replyCase(
    w.config,
    w.clients,
    w.recorder,
    groupMembersPolicyStep("members-check", "20002"),
    undefined,
    {
      register: async (_config, _case, tools) => ({
        leaseId: "12345678-1234-4234-8234-123456789abc",
        expiresAt: Date.now() + 10000,
        toolsSha256: toolManifestDigest(tools),
      }),
      revoke: async () => {},
      ...(beforeSend ? { beforeSend } : {}),
    },
  );
}

function replyEvent(messageId, time, text, route = "private") {
  return {
    time,
    self_id: 10001,
    post_type: "message",
    message_type: route === "private" ? "private" : "group",
    user_id: 10002,
    ...(route === "private" ? {} : { group_id: Number(route) }),
    message_id: messageId,
    message: [{ type: "text", data: { text } }],
  };
}

test("real OneBot subscription and replyCase capture the fixed nonce-free refusal", async (t) => {
  const w = await setup(t);
  const result = await runMembersCheck(w);
  assert.equal(result.status, "PASS", result.code);
  assert.equal(result.replies.length, 1);
  assert.equal(result.replies[0].matches, true);
  assert.equal(result.replies[0].textBytes, Buffer.byteLength(REFUSAL, "utf8"));
  assert.equal(result.replies[0].textSha256, digest(REFUSAL));
  assert.equal(result.inputObserved, true);
  assert.equal(result.leaseRevoked, true);
});

test("old identical private reply is ignored while the current fixed refusal remains observable", async (t) => {
  const w = await setup(t);
  const result = await runMembersCheck(w, async (prepared) => {
    w.driver.broadcast(replyEvent(99001, Math.floor((prepared.startedMs - 6000) / 1000), REFUSAL));
  });
  assert.equal(result.status, "PASS", result.code);
  assert.equal(result.replies.length, 1);
  assert.notEqual(result.replies[0].messageId, "99001");
});

test("cross-conversation refusal cannot satisfy the fixed private check", async (t) => {
  const w = await setup(t, { mode: "wrong" });
  const result = await runMembersCheck(w);
  assert.equal(result.status, "INCONCLUSIVE", result.code);
  assert.equal(result.code, "REPLY_TIMEOUT");
  assert.equal(result.replies.length, 0);
});

test("an unrelated fresh identical refusal makes the fixed check inconclusive", async (t) => {
  const w = await setup(t);
  const result = await runMembersCheck(w, async () => {
    w.driver.broadcast(replyEvent(99002, Math.floor(Date.now() / 1000), REFUSAL));
  });
  assert.equal(result.status, "PASS", result.code);
  assert.equal(result.replies.length, 2);
  await assert.rejects(
    verifyGroupMembersPolicyStep({
      config: w.config,
      clients: w.clients,
      expectedRuntime: {},
      stage: "members-check",
      spec: groupMembersPolicyStep("members-check", "20002"),
      result: { transportCase: result },
    }),
    (error) => error.code === "GROUP_MEMBERS_POLICY_STEP_EVIDENCE",
  );
});

test("fixed refusal binds the real fake-WS reply to its exact failed Run and sent delivery", async (t) => {
  const w = await setup(t, { captureReplyReads: true });
  w.config.runtime = { connectionId: "members-transport-fixture", threadId: null };
  const c = await runMembersCheck(w);
  assert.equal(c.status, "PASS");
  assert.equal(w.replyObservations.length, 1);

  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  db.exec(`
    CREATE TABLE principals(id TEXT PRIMARY KEY,kind TEXT);
    CREATE TABLE messages(id TEXT PRIMARY KEY,external_id TEXT,scope_key TEXT,text TEXT,created_at TEXT);
    CREATE TABLE runs(id TEXT PRIMARY KEY,message_id TEXT,status TEXT,failure_code TEXT,result_text TEXT,scope_json TEXT,created_at TEXT,updated_at TEXT,principal_id TEXT,conversation_id TEXT);
    CREATE TABLE authorization_decisions(id TEXT PRIMARY KEY,principal_id TEXT,resource_id TEXT,action TEXT,scope_key TEXT,decision TEXT,run_id TEXT,delivery_source TEXT);
    CREATE TABLE authorization_decisions_archive(id TEXT PRIMARY KEY,principal_id TEXT,resource_id TEXT,action TEXT,scope_key TEXT,decision TEXT,run_id TEXT,delivery_source TEXT);
    CREATE VIEW authorization_decisions_all AS SELECT * FROM authorization_decisions UNION ALL SELECT * FROM authorization_decisions_archive;
    CREATE TABLE deliveries(id TEXT PRIMARY KEY,run_id TEXT,status TEXT,external_id TEXT,destination_scope_key TEXT);
  `);
  const scope = {
    connectionId: w.config.runtime.connectionId,
    botId: w.config.bot.qq,
    chatType: "private",
    chatId: w.config.driver.qq,
    senderId: w.config.driver.qq,
    threadId: null,
  };
  const scopeKey = JSON.stringify([
    scope.connectionId,
    scope.botId,
    scope.chatType,
    scope.chatId,
    scope.senderId,
    scope.threadId,
  ]);
  const runId = "members-transport-run";
  const principalId = "owner-transport-fixture";
  const started = Date.parse(c.startedAt);
  const completed = Date.now();
  const registeredAt = new Date(started + 1).toISOString();
  const boundAt = new Date(started + 2).toISOString();
  const createdAt = new Date(started + 3).toISOString();
  const updatedAt = new Date(completed - 2).toISOString();
  const revokedAt = new Date(completed - 1).toISOString();
  db.prepare("INSERT INTO principals VALUES (?,'owner')").run(principalId);
  db.prepare("INSERT INTO messages VALUES (?,?,?,?,?)").run(
    "transport-input-message",
    c.inputBinding.botMessageId,
    scopeKey,
    c.prompt,
    new Date(c.inputBinding.time * 1000).toISOString(),
  );
  db.prepare("INSERT INTO runs VALUES (?,?,?,?,?,?,?,?,?,?)").run(
    runId,
    "transport-input-message",
    "failed",
    "required_evidence_missing",
    REFUSAL,
    JSON.stringify(scope),
    createdAt,
    updatedAt,
    principalId,
    "conversation-transport",
  );
  const botReply = w.replyObservations[0];
  db.prepare("INSERT INTO deliveries VALUES (?,?,?,?,?)").run(
    "delivery-transport",
    runId,
    "sent",
    botReply.botMessageId,
    scopeKey,
  );

  const leaseId = c.acceptanceLease.leaseId;
  const scopeSha256 = digest(
    JSON.stringify([
      scope.connectionId,
      scope.botId,
      scope.chatType,
      scope.chatId,
      scope.senderId,
      scope.threadId,
    ]),
  );
  const audit = [
    {
      at: registeredAt,
      event: "lease_registered",
      leaseId,
      principalId,
      marker: c.token,
      expiresAt: c.acceptanceLease.expiresAt,
      toolsSha256: c.acceptanceLease.toolsSha256,
      scopeSha256,
    },
    {
      at: boundAt,
      event: "run_bound",
      leaseId,
      principalId,
      marker: c.token,
      runId,
      messageId: c.inputBinding.botMessageId,
      textSha256: digest(c.prompt.replace(/\r\n?/gu, "\n")),
      toolsSha256: c.acceptanceLease.toolsSha256,
      scopeSha256,
    },
    {
      at: revokedAt,
      event: "lease_revoked",
      leaseId,
      principalId,
      marker: c.token,
      scopeSha256,
      runId,
    },
  ];
  const directory = await mkdtemp(join(tmpdir(), "qq-members-transport-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(
    join(directory, "qq-live-acceptance-audit.jsonl"),
    `${audit.map((row) => JSON.stringify(row)).join("\n")}\n`,
  );

  const evidence = await verifyGroupMembersPolicyFailureWithLeaseCleanup(
    db,
    directory,
    c,
    w.config,
    async (resolved) => {
      assert.equal(resolved.runId, runId);
      assert.equal(resolved.delivery.id, "delivery-transport");
      const messages = await verifyMessageBindings(c, w.config, w.clients, resolved.delivery);
      assert.equal(messages.reply.botMessageId, botReply.botMessageId);
      assert.equal(messages.reply.driverMessageId, botReply.driverMessageId);
      const events = [
        {
          runId,
          type: "message_received",
          externalId: c.inputBinding.botMessageId,
          ...scope,
        },
        {
          runId,
          type: "delivery_changed",
          deliveryId: resolved.delivery.id,
          status: "sent",
          externalId: resolved.delivery.external_id,
        },
      ];
      verifyTraceEvidence(events, c, w.config, resolved.delivery, [], runId, principalId);
      return { messages, deliveryId: resolved.delivery.id };
    },
  );
  assert.equal(evidence.cleanupVerified, true);
  assert.equal(evidence.result.deliveryId, "delivery-transport");
});
