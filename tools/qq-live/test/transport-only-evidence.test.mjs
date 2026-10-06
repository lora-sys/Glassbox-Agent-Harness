import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { digest, toolManifestDigest } from "../lib/core.mjs";
import {
  verifyTransportOnlyCaseEvidence,
  verifyTransportOnlyEvidence,
  verifyFailedCaseCleanup,
} from "../lib/product-evidence.mjs";
import { transportSmokeSpecs, transportSuiteHash } from "../lib/transport-suite.mjs";

function hash(text) {
  return createHash("sha256").update(text).digest("hex");
}

function emptyEffectiveToolSurface() {
  return {
    profileName: "main-agent",
    profileTools: ["qq_group_history"],
    profileVersion: "test-profile-version",
    policyVersion: "tool-surface-policy-v1",
    selected: [],
    excluded: [],
    disabledByHost: [],
    undescribed: [],
    generatedAt: new Date().toISOString(),
  };
}

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "qq-transport-evidence-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const config = {
    bot: { qq: "10002" },
    driver: { qq: "10001" },
    groups: [
      { alias: "A", id: "20001" },
      { alias: "B", id: "20002" },
    ],
    runtime: {
      checkout: process.cwd(),
      dataDirectory: directory,
      expectedCommit: "a".repeat(40),
      connectionId: "qq-live",
      threadId: null,
    },
  };
  const expectedRuntime = {
    checkout: resolve(config.runtime.checkout),
    dataDirectory: resolve(directory),
    commit: config.runtime.expectedCommit,
    pid: 321,
    connectionId: config.runtime.connectionId,
    threadId: null,
  };
  const db = new DatabaseSync(":memory:");
  db.exec(
    "CREATE TABLE messages(id TEXT, external_id TEXT, scope_key TEXT); CREATE TABLE runs(id TEXT, message_id TEXT, status TEXT, scope_json TEXT, created_at TEXT, principal_id TEXT); CREATE TABLE authorization_decisions_all(id TEXT, run_id TEXT, action TEXT, decision TEXT); CREATE TABLE deliveries(id TEXT, run_id TEXT, status TEXT, external_id TEXT, destination_scope_key TEXT);",
  );

  const specs = transportSmokeSpecs(config);
  const now = Date.now();
  const principalId = "principal-owner-transport";
  const cases = [];
  const traces = new Map();
  const botMessages = new Map();
  const driverMessages = new Map();
  const audit = [];

  for (const [index, spec] of specs.entries()) {
    const token = (index + 1).toString(16).padStart(32, "0");
    const route = spec.chat === "private" ? "private" : config.groups[index - 1].id;
    const messageType = route === "private" ? "private" : "group";
    const chatId = route === "private" ? config.driver.qq : route;
    const scope = {
      connectionId: config.runtime.connectionId,
      botId: config.bot.qq,
      chatType: messageType,
      chatId,
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
    const startedAt = new Date(now - 15_000 + index * 100).toISOString();
    const prompt = `GLASSBOX_ACCEPTANCE_V1 ${token}\n${spec.prompt.replaceAll("{{nonce}}", token)}`;
    const inputTime = Math.floor((now - 10_000 + index * 100) / 1000);
    const replyTime = inputTime + 1;
    const inputSequence = String(500 + index * 2);
    const replySequence = String(501 + index * 2);
    const sentMessageId = String(81001 + index * 10);
    const botInputId = String(82001 + index * 10);
    const botReplyId = String(83001 + index * 10);
    const driverReplyId = String(84001 + index * 10);
    const replyText = token;
    const leaseId = randomUUID();
    const expiresAt = now + 5 * 60_000;
    const runId = `transport-${index + 1}`;
    const deliveryId = `delivery-${index + 1}`;
    const toolsSha256 = toolManifestDigest([]);
    const c = {
      id: spec.id,
      transportOnly: true,
      route,
      prompt,
      expected: [token],
      token,
      startedAt,
      status: "PASS",
      code: "REAL_REPLY_RECEIVED",
      sendAttempted: true,
      sentMessageId,
      leaseRegistrationAttempted: true,
      leaseRevoked: true,
      leasedToolNames: [],
      acceptanceLease: { leaseId, expiresAt, toolsSha256 },
      inputBinding: {
        driverMessageId: sentMessageId,
        botMessageId: botInputId,
        realSequence: inputSequence,
        time: inputTime,
        textSha256: hash(prompt),
      },
      replies: [
        {
          route,
          messageId: driverReplyId,
          textSha256: hash(replyText),
          textBytes: Buffer.byteLength(replyText),
          receivedAt: new Date(replyTime * 1000).toISOString(),
          matches: true,
        },
      ],
    };
    cases.push(c);

    const message = (messageId, selfId, senderId, realSequence, time, text) => ({
      message_id: messageId,
      self_id: selfId,
      user_id: senderId,
      sender: { user_id: senderId },
      message_type: messageType,
      ...(messageType === "group" ? { group_id: route } : {}),
      real_seq: realSequence,
      time,
      message: text,
    });
    driverMessages.set(
      sentMessageId,
      message(sentMessageId, config.driver.qq, config.driver.qq, inputSequence, inputTime, prompt),
    );
    botMessages.set(
      botInputId,
      message(botInputId, config.bot.qq, config.driver.qq, inputSequence, inputTime, prompt),
    );
    botMessages.set(
      botReplyId,
      message(botReplyId, config.bot.qq, config.bot.qq, replySequence, replyTime, replyText),
    );
    driverMessages.set(
      driverReplyId,
      message(driverReplyId, config.driver.qq, config.bot.qq, replySequence, replyTime, replyText),
    );

    const scopeJson = JSON.stringify(scope);
    db.prepare("INSERT INTO messages VALUES (?,?,?)").run(`message-${index}`, botInputId, scopeKey);
    db.prepare("INSERT INTO runs VALUES (?,?,?,?,?,?)").run(
      runId,
      `message-${index}`,
      "succeeded",
      scopeJson,
      new Date(now - 8_000 + index * 100).toISOString(),
      principalId,
    );
    db.prepare("INSERT INTO authorization_decisions_all VALUES (?,?,?,?)").run(
      `authorization-${index}`,
      runId,
      "run:execute",
      "ALLOW",
    );
    db.prepare("INSERT INTO deliveries VALUES (?,?,?,?,?)").run(
      deliveryId,
      runId,
      "sent",
      botReplyId,
      scopeKey,
    );

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
    audit.push(
      {
        at: new Date(now - 7_000 + index * 100).toISOString(),
        event: "lease_registered",
        principalId,
        leaseId,
        marker: token,
        expiresAt,
        toolsSha256,
        scopeSha256,
      },
      {
        at: new Date(now - 6_000 + index * 100).toISOString(),
        event: "run_bound",
        principalId,
        leaseId,
        marker: token,
        runId,
        messageId: botInputId,
        textSha256: hash(prompt),
        toolsSha256,
        scopeSha256,
      },
      {
        at: new Date(now - 5_000 + index * 100).toISOString(),
        event: "lease_revoked",
        principalId,
        leaseId,
        marker: token,
        scopeSha256,
      },
    );
    traces.set(runId, [
      {
        runId,
        type: "message_received",
        externalId: botInputId,
        ...scope,
      },
      {
        runId,
        type: "delivery_changed",
        deliveryId,
        status: "sent",
        externalId: botReplyId,
      },
      {
        runId,
        type: "session_start",
        data: {
          authorizedTools: [],
          toolSurface: emptyEffectiveToolSurface(),
          acceptanceLease: {
            leaseId,
            marker: token,
            narrowedTools: [],
            toolsSha256,
          },
        },
      },
    ]);
  }
  const dbPath = join(directory, "glassbox.db");
  db.exec(`VACUUM INTO '${dbPath.replaceAll("'", "''")}'`);
  db.close();
  const auditPath = join(directory, "qq-live-acceptance-audit.jsonl");
  await writeFile(auditPath, `${audit.map((row) => JSON.stringify(row)).join("\n")}\n`);

  const makeClient = (userId, messages) => ({
    allowMessageRead() {},
    async call(action, params) {
      if (action !== "get_msg") throw new Error("Unexpected OneBot action");
      const found = messages.get(String(params.message_id));
      if (!found) throw new Error("Missing fixture message");
      return found;
    },
  });
  const clients = {
    bot: makeClient(config.bot.qq, botMessages),
    driver: makeClient(config.driver.qq, driverMessages),
  };
  let finalPid = expectedRuntime.pid;
  const runtimePids = [];
  const capture = (command, args) => {
    if (command === "git") return args[0] === "rev-parse" ? config.runtime.expectedCommit : "";
    if (command !== process.execPath) throw new Error("Unexpected evidence command");
    if (args[0] === "--import") {
      const pid = runtimePids.length ? runtimePids.shift() : finalPid;
      return JSON.stringify({
        dataDirectory: directory,
        processes: [
          {
            name: "glassbox",
            running: true,
            status: "running",
            pid,
            checkout: process.cwd(),
            launchCommit: config.runtime.expectedCommit,
            launchClean: true,
          },
        ],
        glassboxReady: true,
        onebotReady: true,
      });
    }
    const runId = args[2];
    return JSON.stringify({ events: (traces.get(runId) ?? []).map((event) => ({ event })) });
  };
  const report = {
    mode: "run",
    status: "PASS",
    transportOnly: true,
    suiteSha256: transportSuiteHash(config),
    runtime: expectedRuntime,
    cases,
  };
  return {
    config,
    directory,
    auditPath,
    cases,
    clients,
    capture,
    expectedRuntime,
    report,
    traces,
    setRuntimePids: (values) => runtimePids.push(...values),
  };
}

test("fixed transport-only suite independently verifies Run, dual-account reply, empty lease and cleanup", async (t) => {
  const f = await fixture(t);
  const result = await verifyTransportOnlyEvidence(
    f.report,
    f.config,
    f.clients,
    f.expectedRuntime,
    f.capture,
  );
  assert.equal(result.status, "PASS");
  assert.equal(result.acceptanceKind, "TRANSPORT_ONLY");
  assert.equal(result.cases.length, 3);
  assert.deepEqual(
    result.cases.map((row) => row.caseId),
    ["transport-private", "transport-group-A", "transport-group-B"],
  );
  for (const row of result.cases) {
    assert.equal(row.cleanupVerified, true);
    assert.equal(row.traceVerified, true);
    assert.equal(Object.hasOwn(row, "feature"), false);
    assert.equal(Object.hasOwn(row, "observations"), false);
  }
});

test("transport evidence rejects an altered prompt and an unleased old report", async (t) => {
  const f = await fixture(t);
  f.cases[0].prompt += " changed";
  await assert.rejects(
    verifyTransportOnlyCaseEvidence(f.cases[0], f.config, f.clients, f.expectedRuntime, f.capture),
    (error) => error.code === "TRANSPORT_CASE_BINDING" && error.cleanupVerified === false,
  );

  const legacy = structuredClone(f.report);
  delete legacy.transportOnly;
  await assert.rejects(
    verifyTransportOnlyEvidence(legacy, f.config, f.clients, f.expectedRuntime, f.capture),
    (error) => error.code === "TRANSPORT_SUITE_BINDING" && error.cleanupVerified === false,
  );
});

test("transport evidence refuses any visible or called Tool and preserves cleanup proof", async (t) => {
  const f = await fixture(t);
  const session = f.traces.get("transport-1").find((event) => event.type === "session_start");
  session.data.authorizedTools = ["ops_status"];
  session.data.acceptanceLease.narrowedTools = ["ops_status"];
  await assert.rejects(
    verifyTransportOnlyCaseEvidence(f.cases[0], f.config, f.clients, f.expectedRuntime, f.capture),
    (error) => error.code === "TRANSPORT_TOOL_SURFACE" && error.cleanupVerified === true,
  );

  session.data.authorizedTools = [];
  session.data.acceptanceLease.narrowedTools = [];
  f.traces.get("transport-1").push({
    runId: "transport-1",
    type: "tool_call",
    data: { name: "ops_status" },
  });
  await assert.rejects(
    verifyTransportOnlyCaseEvidence(f.cases[0], f.config, f.clients, f.expectedRuntime, f.capture),
    (error) => error.code === "TRANSPORT_TOOL_CALL" && error.cleanupVerified === true,
  );
});

test("transport evidence requires an actual empty selected array when toolSurface is present", async (t) => {
  const f = await fixture(t);
  const session = f.traces.get("transport-1").find((event) => event.type === "session_start");
  const emptySurface = session.data.toolSurface;
  session.data.toolSurface = {
    ...emptySurface,
    selected: [{ name: "ops_status" }],
    selectedCount: 0,
  };
  await assert.rejects(
    verifyTransportOnlyCaseEvidence(f.cases[0], f.config, f.clients, f.expectedRuntime, f.capture),
    (error) => error.code === "TRANSPORT_TOOL_SURFACE" && error.cleanupVerified === true,
  );

  session.data.toolSurface = { ...emptySurface };
  delete session.data.toolSurface.selected;
  await assert.rejects(
    verifyTransportOnlyCaseEvidence(f.cases[0], f.config, f.clients, f.expectedRuntime, f.capture),
    (error) => error.code === "TRANSPORT_TOOL_SURFACE" && error.cleanupVerified === true,
  );

  session.data.toolSurface = { ...emptySurface, selected: "ops_status" };
  await assert.rejects(
    verifyTransportOnlyCaseEvidence(f.cases[0], f.config, f.clients, f.expectedRuntime, f.capture),
    (error) => error.code === "TRANSPORT_TOOL_SURFACE" && error.cleanupVerified === true,
  );

  delete session.data.toolSurface;
  const result = await verifyTransportOnlyCaseEvidence(
    f.cases[0],
    f.config,
    f.clients,
    f.expectedRuntime,
    f.capture,
  );
  assert.equal(result.runId, "transport-1");
});

test("transport cleanup fails closed when its persistent lease audit is missing", async (t) => {
  const f = await fixture(t);
  await writeFile(f.auditPath, "\n");
  await assert.rejects(
    verifyTransportOnlyCaseEvidence(f.cases[0], f.config, f.clients, f.expectedRuntime, f.capture),
    (error) => error.code === "LEASE_CLEANUP_EVIDENCE" && error.cleanupVerified === false,
  );
});

test("a runtime change after transport cleanup invalidates the cleanup receipt", async (t) => {
  const f = await fixture(t);
  f.setRuntimePids([321, 322]);
  await assert.rejects(
    verifyTransportOnlyCaseEvidence(f.cases[0], f.config, f.clients, f.expectedRuntime, f.capture),
    (error) => error.code === "RUNTIME_CHANGED" && error.cleanupVerified === false,
  );
});

test("known transport reply mismatch can prove only cleanup, never transport acceptance", async (t) => {
  const f = await fixture(t);
  const failed = structuredClone(f.cases[2]);
  failed.status = "FAIL";
  failed.code = "REPLY_ASSERTION_FAILED";
  failed.replies[0].matches = false;
  failed.replies[0].textSha256 = hash("wrong reply");
  failed.replies[0].textBytes = Buffer.byteLength("wrong reply");
  const cleanup = await verifyFailedCaseCleanup(
    {
      mode: "run",
      status: "FAIL",
      runtime: f.expectedRuntime,
      cases: [failed],
    },
    { ...f.config, maxMessages: 3 },
    f.capture,
  );
  assert.equal(cleanup.status, "CLEANUP_VERIFIED");
  assert.deepEqual(
    cleanup.cases.map((row) => row.caseId),
    ["transport-group-B"],
  );
  assert.equal(Object.hasOwn(cleanup, "feature"), false);
});
