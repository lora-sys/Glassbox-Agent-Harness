import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { Worker } from "node:worker_threads";
import { verifyFailedReadReport } from "../lib/product-evidence.mjs";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const token = "a1b2c3d4e5f60718293a4b5c6d7e8f90";
const inputPrompt = `GLASSBOX_ACCEPTANCE_V1 ${token}\n帮我检查一下机器人当前是否在线。只告诉我在线状态，不用提供账号号码或其他账号资料。回复时带上测试编号 ${token}。`;
const refusal = "抱歉，暂时无法确认当前在线状态。";

async function fixture(t, overrides = {}) {
  const directory = await mkdtemp(join(tmpdir(), "failed-read-proof-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const db = new DatabaseSync(join(directory, "glassbox.db"));
  t.after(() => db.close());
  db.exec(`
    CREATE TABLE messages(id TEXT, conversation_id TEXT, scope_key TEXT, external_id TEXT, text TEXT, created_at TEXT);
    CREATE TABLE runs(id TEXT, conversation_id TEXT, message_id TEXT, principal_id TEXT, scope_json TEXT, status TEXT, failure_code TEXT, result_text TEXT, created_at TEXT);
    CREATE TABLE deliveries(id TEXT, run_id TEXT, status TEXT, external_id TEXT, destination_scope_key TEXT, payload_text TEXT, payload_kind TEXT);
    CREATE TABLE authorization_decisions_all(id TEXT, run_id TEXT, principal_id TEXT, resource_id TEXT, action TEXT, decision TEXT);
  `);
  const now = Date.now();
  const startedAt = new Date(now - 10_000).toISOString();
  const inputTime = Math.floor(now / 1000) - 7;
  const replyTime = Math.floor(now / 1000) - 4;
  const connectionId = "p3-qq";
  const config = {
    bot: { qq: "3394947361" },
    driver: { qq: "3526039967" },
    runtime: { connectionId, threadId: null },
  };
  const scope = {
    connectionId,
    botId: config.bot.qq,
    chatType: "private",
    chatId: config.driver.qq,
    senderId: config.driver.qq,
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
  const runtime = {
    checkout: process.cwd(),
    dataDirectory: directory,
    commit: "c".repeat(40),
    pid: 123,
    connectionId,
    threadId: null,
  };
  const runId = randomUUID();
  const inputBotId = "1673552177";
  const inputDriverId = "1698441062";
  const replyBotId = "411498907";
  const replyDriverId = "1756595698";
  const deliveryId = randomUUID();
  const leaseId = randomUUID();
  const expiresAt = now + 60_000;
  const inputHash = hash(inputPrompt);
  const refusalHash = hash(refusal);
  const c = {
    id: "qq-account-status-read",
    status: "FAIL",
    code: "REPLY_ASSERTION_FAILED",
    route: "private",
    token,
    prompt: inputPrompt,
    expected: [token],
    startedAt,
    sendAttempted: true,
    sentMessageId: inputDriverId,
    inputObserved: true,
    leaseRegistrationAttempted: true,
    leaseRevoked: true,
    leasedToolNames: ["qq_account_status"],
    acceptanceLease: {
      leaseId,
      expiresAt,
      toolsSha256: "8841b49f26c9bdf13ba87f0f46a2b788bb10d77ab4ad894431de4e6ce3dd3d47",
    },
    featureAssertions: [
      {
        kind: "trace",
        type: "tool_result",
        where: { name: "qq_account_status", isError: false },
        count: 1,
      },
    ],
    inputBinding: {
      driverMessageId: inputDriverId,
      botMessageId: inputBotId,
      realSequence: "620",
      time: inputTime,
      driverTime: inputTime,
      textSha256: inputHash,
    },
    botInputMessageId: inputBotId,
    botInputMessageIds: [inputBotId],
    botInputCandidates: [{ messageId: inputBotId, textSha256: inputHash }],
    replies: [
      {
        route: "private",
        messageId: replyDriverId,
        textSha256: refusalHash,
        textBytes: Buffer.byteLength(refusal),
        matches: false,
        receivedAt: new Date(replyTime * 1000).toISOString(),
      },
    ],
  };
  Object.assign(c, overrides.case ?? {});
  const report = {
    mode: "run",
    status: "INCONCLUSIVE",
    runtime,
    suiteSha256: hash(
      await readFile(new URL("../examples/feature-read.example.json", import.meta.url)),
    ),
    productAcceptance: {
      status: "INCONCLUSIVE",
      code: "RUN_EVIDENCE",
      cleanupRequired: true,
      cleanupVerified: false,
      cases: [],
    },
    cases: [c],
  };
  const dbScope = JSON.stringify(scope);
  db.prepare("INSERT INTO messages VALUES (?,?,?,?,?,?)").run(
    "m-input",
    "conv",
    scopeKey,
    inputBotId,
    inputPrompt,
    startedAt,
  );
  db.prepare("INSERT INTO runs VALUES (?,?,?,?,?,?,?,?,?)").run(
    runId,
    "conv",
    "m-input",
    "owner",
    dbScope,
    "failed",
    "required_evidence_missing",
    refusal,
    startedAt,
  );
  db.prepare("INSERT INTO deliveries VALUES (?,?,?,?,?,?,?)").run(
    deliveryId,
    runId,
    "sent",
    replyBotId,
    scopeKey,
    refusal,
    "result",
  );
  db.prepare("INSERT INTO authorization_decisions_all VALUES (?,?,?,?,?,?)").run(
    "auth-status",
    runId,
    "owner",
    "agent:personal",
    "account:status:read",
    overrides.authorization ?? "ALLOW",
  );
  const audit = [
    {
      at: new Date(now - 8_000).toISOString(),
      event: "lease_registered",
      leaseId,
      principalId: "owner",
      marker: token,
      expiresAt,
      toolsSha256: c.acceptanceLease.toolsSha256,
      scopeSha256: hash(scopeKey),
    },
    {
      at: new Date(now - 7_000).toISOString(),
      event: "run_bound",
      leaseId,
      principalId: "owner",
      marker: token,
      runId,
      messageId: inputBotId,
      textSha256: inputHash,
      toolsSha256: c.acceptanceLease.toolsSha256,
      scopeSha256: hash(scopeKey),
    },
    {
      at: new Date(now - 6_000).toISOString(),
      event: "lease_revoked",
      leaseId,
      principalId: "owner",
      marker: token,
      scopeSha256: hash(scopeKey),
    },
  ];
  // The audit scope digest uses the producer's canonical tuple, not the DB scope key.
  audit.forEach((row) => {
    row.scopeSha256 = hash(
      JSON.stringify([
        connectionId,
        config.bot.qq,
        "private",
        config.driver.qq,
        config.driver.qq,
        null,
      ]),
    );
  });
  await writeFile(
    join(directory, "qq-live-acceptance-audit.jsonl"),
    `${audit.map((row) => JSON.stringify(row)).join("\n")}\n`,
  );

  const messages = (selfId, entries) => {
    const allowed = new Set();
    return {
      allowMessageRead(id) {
        allowed.add(String(id));
      },
      async call(action, params) {
        assert.equal(action, "get_msg");
        assert.ok(allowed.has(String(params.message_id)));
        const entry = entries.get(String(params.message_id));
        assert.ok(entry);
        return { self_id: selfId, ...entry };
      },
    };
  };
  const message = (id, senderId, text, sequence, time) => ({
    message_id: id,
    real_seq: sequence,
    time,
    message_type: "private",
    user_id: senderId,
    sender: { user_id: senderId },
    message: [{ type: "text", data: { text } }],
  });
  const bot = messages(
    config.bot.qq,
    new Map([
      [inputBotId, message(inputBotId, config.driver.qq, inputPrompt, "620", inputTime)],
      [replyBotId, message(replyBotId, config.bot.qq, refusal, "621", replyTime)],
    ]),
  );
  const driver = messages(
    config.driver.qq,
    new Map([
      [inputDriverId, message(inputDriverId, config.driver.qq, inputPrompt, "620", inputTime)],
      [replyDriverId, message(replyDriverId, config.bot.qq, refusal, "621", replyTime)],
    ]),
  );
  const toolCall = (id, input) => ({
    runId,
    type: "tool_call",
    principalId: "owner",
    data: {
      name: "qq_account_status",
      toolCallId: id,
      ...(input ? { input } : {}),
    },
  });
  const toolResult = (id, extra) => ({
    runId,
    type: "tool_result",
    principalId: "owner",
    data: {
      name: "qq_account_status",
      toolCallId: id,
      ...extra,
    },
  });
  const session = () => ({
    runId,
    type: "session_start",
    principalId: "owner",
    data: {
      authorizedTools: ["qq_account_status"],
      toolSurface: { selected: [{ name: "qq_account_status", provider: "qq-napcat" }] },
      acceptanceLease: {
        leaseId,
        marker: token,
        toolsSha256: c.acceptanceLease.toolsSha256,
        narrowedTools: ["qq_account_status"],
      },
    },
  });
  const events = [
    { type: "message_received", runId, externalId: inputBotId, textSha256: inputHash, ...scope },
    session(),
    toolCall("call-invalid"),
    toolResult("call-invalid", { isError: true, failureCode: "input_validation_failed" }),
    session(),
    toolCall("call-status", { operation: "get_status" }),
    toolResult("call-status", { isError: false }),
    toolCall("call-identity", { operation: "get_login_info" }),
    toolResult("call-identity", { isError: true, failureCode: "acceptance_lease_input_mismatch" }),
    { type: "delivery_changed", deliveryId, externalId: replyBotId, status: "sent", runId },
  ];
  if (overrides.traceExtra) events.push(overrides.traceExtra(runId));
  return {
    report,
    config,
    runtime,
    runId,
    c,
    db,
    events,
    clients: { bot, driver },
    readRuntime: async () => runtime,
    readTrace: async () => ({ events: events.map((event) => ({ event })) }),
  };
}

test("closed failed-read cleanup binds exact Owner input, failed Run, refusal, dual delivery and revoked lease", async (t) => {
  const f = await fixture(t);
  const result = await verifyFailedReadReport(f.report, f.config, {
    readRuntime: f.readRuntime,
    clients: f.clients,
    readTrace: f.readTrace,
  });
  assert.equal(result.status, "CLEANUP_RECONCILED");
  assert.equal(result.cases[0].featureStatus, "FAIL");
  assert.equal(result.cases[0].cleanupOnly, true);
  assert.equal(result.cases[0].actualQqDeliveryVerified, true);
  assert.equal(result.cases[0].productRunId, f.runId);
  assert.equal(result.cases[0].proof.safeRefusal.accountIdentityAbsent, true);
  assert.equal(result.cases[0].proof.trace.identityLeaseDenialCount, 1);
  assert.match(result.cases[0].proof.proofSha256, /^[a-f0-9]{64}$/u);
});

test("failed-read cleanup rejects prompt drift, changed reply, extra tool effects and lost authorization", async (t) => {
  const prompt = await fixture(t, { case: { prompt: inputPrompt.replace("不用提供", "提供") } });
  await assert.rejects(
    verifyFailedReadReport(prompt.report, prompt.config, {
      readRuntime: prompt.readRuntime,
      clients: prompt.clients,
      readTrace: prompt.readTrace,
    }),
    (error) => error.code === "FAILED_READ_CLEANUP_UNSUPPORTED",
  );

  const reply = await fixture(t);
  reply.report.cases[0].replies[0].textSha256 = "f".repeat(64);
  await assert.rejects(
    verifyFailedReadReport(reply.report, reply.config, {
      readRuntime: reply.readRuntime,
      clients: reply.clients,
      readTrace: reply.readTrace,
    }),
    (error) => ["FAILED_READ_DELIVERY", "MESSAGE_BINDING_MISMATCH"].includes(error.code),
  );

  const effects = await fixture(t, {
    traceExtra: (runId) => ({
      runId,
      type: "tool_call",
      principalId: "owner",
      data: {
        name: "qq_group_moderation",
        toolCallId: "unexpected-call",
        input: { operation: "kick" },
      },
    }),
  });
  await assert.rejects(
    verifyFailedReadReport(effects.report, effects.config, {
      readRuntime: effects.readRuntime,
      clients: effects.clients,
      readTrace: effects.readTrace,
    }),
    (error) => error.code === "FAILED_READ_TRACE",
  );

  const auth = await fixture(t, { authorization: "DENY" });
  await assert.rejects(
    verifyFailedReadReport(auth.report, auth.config, {
      readRuntime: auth.readRuntime,
      clients: auth.clients,
      readTrace: auth.readTrace,
    }),
    (error) => error.code === "FAILED_READ_AUTHORIZATION",
  );
});

test("failed-read verifier waits for a competing SQLite writer within the shared bounded timeout", async (t) => {
  const f = await fixture(t);
  const lockWorker = `
    const { parentPort, workerData } = require("node:worker_threads");
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(workerData.path);
    db.exec("BEGIN EXCLUSIVE");
    parentPort.postMessage("locked");
    setTimeout(() => {
      db.exec("COMMIT");
      db.close();
      parentPort.postMessage("released");
    }, 100);
  `;
  const worker = new Worker(lockWorker, {
    eval: true,
    workerData: { path: join(f.runtime.dataDirectory, "glassbox.db") },
  });
  t.after(async () => {
    if (worker.threadId !== -1) await worker.terminate();
  });
  const [locked] = await once(worker, "message");
  assert.equal(locked, "locked");
  const released = once(worker, "message");
  const result = await verifyFailedReadReport(f.report, f.config, {
    readRuntime: f.readRuntime,
    clients: f.clients,
    readTrace: f.readTrace,
  });
  assert.equal(result.status, "CLEANUP_RECONCILED");
  const [releasedMessage] = await released;
  assert.equal(releasedMessage, "released");
});
