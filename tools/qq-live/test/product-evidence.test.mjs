import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import {
  caseEvidence,
  readTraceEvents,
  runtimeSnapshot,
  verifyMessageBindings,
  verifyTraceEvidence,
  verifyLeaseTraceEvidence,
} from "../lib/product-evidence.mjs";

test("feature evidence requires server lease identity and the narrowed Tool surface", () => {
  const c = {
    token: "a".repeat(32),
    acceptanceLease: { leaseId: "lease-fixture", toolsSha256: "b".repeat(64) },
    leasedToolNames: ["ops_status"],
    featureAssertions: [{ kind: "trace" }],
  };
  const session = {
    runId: "run-fixture",
    type: "session_start",
    data: {
      authorizedTools: ["ops_status"],
      acceptanceLease: {
        leaseId: "lease-fixture",
        toolsSha256: "b".repeat(64),
        marker: c.token,
        narrowedTools: ["ops_status"],
      },
    },
  };
  const tool = { runId: "run-fixture", type: "tool_call", data: { name: "ops_status" } };
  assert.doesNotThrow(() => verifyLeaseTraceEvidence([session, tool], c, "run-fixture"));
  for (const events of [
    [tool],
    [{ ...session, runId: "old-run" }, tool],
    [
      {
        ...session,
        data: { acceptanceLease: { ...session.data.acceptanceLease, leaseId: "other" } },
      },
      tool,
    ],
    [
      {
        ...session,
        data: {
          acceptanceLease: { ...session.data.acceptanceLease, narrowedTools: ["task_cancel"] },
        },
      },
      tool,
    ],
    [session, { ...tool, data: { name: "task_cancel" } }],
    [{ ...session, data: { ...session.data, authorizedTools: ["task_cancel"] } }, tool],
    [session, { ...tool, type: "tool_result", data: { name: "task_cancel" } }],
    [
      {
        ...session,
        data: {
          ...session.data,
          acceptanceLease: { ...session.data.acceptanceLease, toolsSha256: "c".repeat(64) },
        },
      },
      tool,
    ],
  ])
    assert.throws(() => verifyLeaseTraceEvidence(events, c, "run-fixture"), {
      code: "FEATURE_LEASE_TRACE",
    });
});
test("reported prompt cannot substitute for a different bound QQ input", async () => {
  await assert.rejects(
    verifyMessageBindings(
      { prompt: "approved", inputBinding: { textSha256: messageDigest("different") } },
      {},
      {},
      {},
    ),
    { code: "MESSAGE_BINDING" },
  );
});

test("Trace reader passes the runs directory to gbxtrace", () => {
  const checkout = join(process.cwd(), "candidate");
  const dataDirectory = join(process.cwd(), "data");
  const trace = readTraceEvents(checkout, dataDirectory, "run-123", (command, args, options) => {
    assert.equal(command, process.execPath);
    assert.ok(
      args[0].endsWith(join(".agents", "skills", "glassbox-ops", "scripts", "gbxtrace.mjs")),
    );
    assert.equal(args[1], "events");
    assert.equal(args[2], "run-123");
    assert.equal(args.at(-2), "--data-dir");
    assert.equal(args.at(-1), join(dataDirectory, "runs"));
    assert.equal(options.encoding, "utf8");
    return JSON.stringify({
      events: [{ event: { type: "message_received" } }],
    });
  });
  assert.equal(trace.events[0].event.type, "message_received");
});

test("runtime verification rejects a stopped process and wrong commit", () => {
  const runtime = {
    checkout: process.cwd(),
    dataDirectory: process.cwd(),
    expectedCommit: "a".repeat(40),
    connectionId: "qq-live",
  };
  const capture = (command, args) =>
    command === "git"
      ? args[0] === "rev-parse"
        ? runtime.expectedCommit
        : ""
      : JSON.stringify({
          dataDirectory: runtime.dataDirectory,
          processes: [{ name: "glassbox", running: false }],
          glassboxReady: true,
          onebotReady: true,
        });
  assert.throws(() => runtimeSnapshot(runtime, capture), {
    code: "RUNTIME_UNVERIFIED",
  });
  assert.throws(() => runtimeSnapshot(runtime, () => "b".repeat(40)), {
    code: "RUNTIME_VERSION",
  });
});
test("matching current checkout cannot substitute for launch commit evidence", () => {
  const runtime = {
    checkout: process.cwd(),
    dataDirectory: process.cwd(),
    expectedCommit: "a".repeat(40),
    connectionId: "qq-live",
  };
  const capture = (command, args) =>
    command === "git"
      ? args[0] === "rev-parse"
        ? runtime.expectedCommit
        : ""
      : JSON.stringify({
          dataDirectory: runtime.dataDirectory,
          processes: [
            {
              name: "glassbox",
              running: true,
              status: "running",
              pid: 123,
              checkout: runtime.checkout,
              launchCommit: "b".repeat(40),
              launchClean: true,
            },
          ],
          glassboxReady: true,
          onebotReady: true,
        });
  assert.throws(() => runtimeSnapshot(runtime, capture), {
    code: "RUNTIME_LAUNCH_VERSION",
  });
});
test("runtime evidence requires the expected connection ID", () => {
  const runtime = {
    checkout: process.cwd(),
    dataDirectory: process.cwd(),
    expectedCommit: "a".repeat(40),
  };
  assert.throws(() => runtimeSnapshot(runtime, () => ""), {
    code: "RUNTIME_CONFIG",
  });
});

function evidenceFixture({ connectionId = "qq-live", threadId = null } = {}) {
  const db = new DatabaseSync(":memory:");
  db.exec(
    "CREATE TABLE messages(id TEXT, external_id TEXT, scope_key TEXT); CREATE TABLE runs(id TEXT, message_id TEXT, status TEXT, scope_json TEXT, created_at TEXT); CREATE TABLE authorization_decisions_all(id TEXT, run_id TEXT, action TEXT, decision TEXT); CREATE TABLE deliveries(id TEXT, run_id TEXT, status TEXT, external_id TEXT, destination_scope_key TEXT);",
  );
  const now = new Date().toISOString();
  const scope = {
    connectionId,
    botId: "10002",
    chatType: "group",
    chatId: "20001",
    senderId: "10001",
    threadId,
  };
  const scopeKey = JSON.stringify([
    scope.connectionId,
    scope.botId,
    scope.chatType,
    scope.chatId,
    scope.senderId,
    scope.threadId,
  ]);
  db.prepare("INSERT INTO messages VALUES (?,?,?)").run("m", "bot-local-10", scopeKey);
  db.prepare("INSERT INTO runs VALUES (?,?,?,?,?)").run(
    "r",
    "m",
    "succeeded",
    JSON.stringify(scope),
    now,
  );
  db.prepare("INSERT INTO authorization_decisions_all VALUES (?,?,?,?)").run(
    "a",
    "r",
    "run:execute",
    "ALLOW",
  );
  db.prepare("INSERT INTO deliveries VALUES (?,?,?,?,?)").run("d", "r", "sent", "20", scopeKey);
  const c = {
    id: "group-A",
    sentMessageId: "driver-local-10",
    inputBinding: {
      driverMessageId: "driver-local-10",
      botMessageId: "bot-local-10",
      realSequence: "554",
      time: 1791203355,
      textSha256: "a".repeat(64),
    },
    route: "20001",
    startedAt: now,
    expected: ["case-nonce"],
    replies: [
      {
        route: "20001",
        messageId: "driver-reply-30",
        textSha256: "b".repeat(64),
        matches: true,
      },
    ],
  };
  const config = {
    bot: { qq: "10002" },
    driver: { qq: "10001" },
    runtime: { connectionId, threadId },
  };
  return { db, c, config, scopeKey };
}

test("acceptance binds scoped input, successful Run, authorization and received delivery", (t) => {
  const { db, c, config } = evidenceFixture();
  t.after(() => db.close());
  assert.equal(caseEvidence(db, c, config).runId, "r");
  db.exec("UPDATE authorization_decisions_all SET decision='DENY'");
  assert.throws(() => caseEvidence(db, c, config), {
    code: "AUTHORIZATION_EVIDENCE",
  });
  assert.throws(() => caseEvidence(db, { ...c, route: "20002" }, config), {
    code: "RUN_EVIDENCE",
  });
});

test("driver and bot local message IDs may differ while Run and delivery remain scoped", (t) => {
  const { db, c, config } = evidenceFixture();
  t.after(() => db.close());
  const evidence = caseEvidence(db, c, config);
  assert.equal(c.inputBinding.driverMessageId, "driver-local-10");
  assert.equal(c.inputBinding.botMessageId, "bot-local-10");
  assert.equal(evidence.runId, "r");
  assert.equal(evidence.delivery.external_id, "20");
  assert.equal(c.replies[0].messageId, "driver-reply-30");
});

function messageDigest(text) {
  return createHash("sha256").update(text).digest("hex");
}

function bindingClient(selfId, messages) {
  const allowed = new Set();
  return {
    allowMessageRead(messageId) {
      allowed.add(String(messageId));
    },
    async call(action, params) {
      assert.equal(action, "get_msg");
      assert.ok(allowed.has(String(params.message_id)), "get_msg ID must be registered first");
      const message = messages.get(String(params.message_id));
      assert.ok(message, `unexpected message ID ${params.message_id}`);
      return { self_id: selfId, ...message };
    },
  };
}

function boundMessageFixture({ driverReplyRealSequence = "555", driverReplyText } = {}) {
  const inputText = "private test prompt with hidden input text";
  const replyText = driverReplyText ?? "reply with nonce-expected and 42";
  const time = Math.floor(Date.now() / 1000);
  const common = (messageId, senderId, text, realSequence) => ({
    message_id: messageId,
    real_seq: realSequence,
    time,
    message_type: "group",
    group_id: "20001",
    user_id: senderId,
    sender: { user_id: senderId },
    message: [{ type: "text", data: { text } }],
  });
  const botMessages = new Map([
    ["447318472", common("447318472", "10001", inputText, "554")],
    ["2300000001", common("2300000001", "10002", replyText, "555")],
  ]);
  const driverMessages = new Map([
    ["2102070094", common("2102070094", "10001", inputText, "554")],
    ["2300000002", common("2300000002", "10002", replyText, driverReplyRealSequence)],
  ]);
  const c = {
    sentMessageId: "2102070094",
    prompt: inputText,
    inputBinding: {
      driverMessageId: "2102070094",
      botMessageId: "447318472",
      realSequence: "554",
      time,
      textSha256: messageDigest(inputText),
    },
    route: "20001",
    startedAt: new Date((time - 1) * 1000).toISOString(),
    expected: ["nonce-expected", "42"],
    replies: [
      {
        route: "20001",
        messageId: "2300000002",
        matches: true,
        textSha256: messageDigest("reply with nonce-expected and 42"),
      },
    ],
  };
  return {
    c,
    config: { bot: { qq: "10002" }, driver: { qq: "10001" } },
    clients: {
      bot: bindingClient("10002", botMessages),
      driver: bindingClient("10001", driverMessages),
    },
    delivery: { external_id: "2300000001" },
    inputText,
    replyText,
  };
}

test("two account-local ID pairs bind to one real input and reply without retaining text", async () => {
  const fixture = boundMessageFixture();
  const evidence = await verifyMessageBindings(
    fixture.c,
    fixture.config,
    fixture.clients,
    fixture.delivery,
  );
  assert.deepEqual(evidence.input, {
    realSequence: "554",
    time: fixture.c.inputBinding.time,
    textSha256: fixture.c.inputBinding.textSha256,
  });
  assert.equal(evidence.reply.realSequence, "555");
  assert.equal(JSON.stringify(evidence).includes(fixture.inputText), false);
  assert.equal(JSON.stringify(evidence).includes(fixture.replyText), false);
});

test("cross-account reply sequence or full-text hash mismatch is inconclusive", async () => {
  const sequenceMismatch = boundMessageFixture({
    driverReplyRealSequence: "556",
  });
  await assert.rejects(
    verifyMessageBindings(
      sequenceMismatch.c,
      sequenceMismatch.config,
      sequenceMismatch.clients,
      sequenceMismatch.delivery,
    ),
    { code: "MESSAGE_BINDING_MISMATCH" },
  );

  const hashMismatch = boundMessageFixture({
    driverReplyText: "reply with nonce-expected",
  });
  await assert.rejects(
    verifyMessageBindings(
      hashMismatch.c,
      hashMismatch.config,
      hashMismatch.clients,
      hashMismatch.delivery,
    ),
    { code: "MESSAGE_BINDING_MISMATCH" },
  );
});

test("a new matching reply during asynchronous message reads invalidates the evidence", async () => {
  const fixture = boundMessageFixture();
  const originalCall = fixture.clients.driver.call.bind(fixture.clients.driver);
  fixture.clients.driver.call = async (action, params) => {
    const result = await originalCall(action, params);
    if (action === "get_msg" && params.message_id === "2300000002")
      fixture.c.replies.push({
        ...fixture.c.replies[0],
        messageId: "2300000003",
      });
    return result;
  };
  await assert.rejects(
    verifyMessageBindings(fixture.c, fixture.config, fixture.clients, fixture.delivery),
    { code: "OBSERVATION_CHANGED" },
  );
});

test("same external message ID from another connection is not a Run match", (t) => {
  const { db, c, config, scopeKey } = evidenceFixture({
    connectionId: "other-connection",
  });
  t.after(() => db.close());
  const expectedScopeKey = JSON.stringify(["qq-live", "10002", "group", "20001", "10001", null]);
  assert.notEqual(scopeKey, expectedScopeKey);
  assert.throws(() => caseEvidence(db, c, { ...config, runtime: { connectionId: "qq-live" } }), {
    code: "RUN_EVIDENCE",
  });
});

test("delivery to a different destination scope cannot satisfy acceptance", (t) => {
  const { db, c, config } = evidenceFixture();
  t.after(() => db.close());
  db.prepare("UPDATE deliveries SET destination_scope_key=? WHERE id='d'").run(
    JSON.stringify(["qq-live", "10002", "group", "other-group", "10001", null]),
  );
  assert.throws(() => caseEvidence(db, c, config), {
    code: "DELIVERY_EVIDENCE",
  });
});

test("trace delivery must reference the verified delivery ID", () => {
  const { c, config } = evidenceFixture();
  const events = [
    {
      type: "message_received",
      externalId: "bot-local-10",
      connectionId: "qq-live",
      botId: "10002",
      senderId: "10001",
      chatType: "group",
      chatId: "20001",
    },
    {
      type: "delivery_changed",
      deliveryId: "wrong-delivery",
      status: "sent",
      externalId: "20",
    },
  ];
  assert.throws(() => verifyTraceEvidence(events, c, config, { id: "d", external_id: "20" }), {
    code: "TRACE_EVIDENCE",
  });
  events[1].deliveryId = "d";
  assert.doesNotThrow(() => verifyTraceEvidence(events, c, config, { id: "d", external_id: "20" }));
});

test("trace message from another connection or thread cannot satisfy acceptance", () => {
  const { c, config } = evidenceFixture({ threadId: "thread-a" });
  const events = [
    {
      type: "message_received",
      externalId: "bot-local-10",
      connectionId: "other-connection",
      botId: "10002",
      senderId: "10001",
      chatType: "group",
      chatId: "20001",
      threadId: "thread-a",
    },
    {
      type: "delivery_changed",
      deliveryId: "d",
      status: "sent",
      externalId: "20",
    },
  ];
  assert.throws(() => verifyTraceEvidence(events, c, config, { id: "d", external_id: "20" }), {
    code: "TRACE_EVIDENCE",
  });
  events[0].connectionId = "qq-live";
  events[0].threadId = "other-thread";
  assert.throws(() => verifyTraceEvidence(events, c, config, { id: "d", external_id: "20" }), {
    code: "TRACE_EVIDENCE",
  });
});
