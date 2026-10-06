import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  caseEvidence,
  readTraceEvents,
  runtimeSnapshot,
  runtimeInspectionSnapshot,
  verifyMessageBindings,
  verifyTraceEvidence,
  verifyLeaseTraceEvidence,
  verifyGroupMemberCountEvidence,
  verifyCaseWithLeaseCleanup,
  verifyFailedCaseCleanupInDatabase,
  verifyFailedCaseCleanup,
} from "../lib/product-evidence.mjs";
import { observeFeature } from "../lib/feature-observer.mjs";

function memberCountTrace(
  input = { groupId: "20001", operation: "get_group_member_list", params: {} },
) {
  return [
    {
      runId: "run-fixture",
      type: "tool_call",
      toolCallId: "member-call",
      data: { name: "qq_group_members", toolCallId: "member-call", input },
    },
    {
      runId: "run-fixture",
      type: "tool_result",
      toolCallId: "member-call",
      data: { name: "qq_group_members", toolCallId: "member-call", isError: false },
    },
  ];
}

test("offline QQ permits only read-only recovery inspection with the same service identity checks", () => {
  const runtime = {
    checkout: process.cwd(),
    dataDirectory: process.cwd(),
    expectedCommit: "a".repeat(40),
    connectionId: "qq-live",
  };
  const status = {
    dataDirectory: runtime.dataDirectory,
    processes: [
      {
        name: "glassbox",
        running: true,
        status: "running",
        pid: 123,
        checkout: runtime.checkout,
        launchCommit: runtime.expectedCommit,
        launchClean: true,
      },
    ],
    glassboxReady: true,
    onebotReady: false,
  };
  const capture = (command, args) =>
    command === "git"
      ? args[0] === "rev-parse"
        ? runtime.expectedCommit
        : ""
      : JSON.stringify(status);
  assert.equal(runtimeInspectionSnapshot(runtime, capture).pid, 123);
  assert.throws(() => runtimeSnapshot(runtime, capture), { code: "RUNTIME_UNVERIFIED" });
  for (const change of [
    () => {
      status.glassboxReady = false;
    },
    () => {
      status.glassboxReady = true;
      status.processes[0].running = false;
    },
  ]) {
    change();
    assert.throws(() => runtimeInspectionSnapshot(runtime, capture), {
      code: "RUNTIME_UNVERIFIED",
    });
  }
});

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
    assert.equal(args.filter((value) => value === "tool_call").length, 1);
    assert.equal(args.filter((value) => value === "tool_result").length, 1);
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
    "CREATE TABLE messages(id TEXT, external_id TEXT, scope_key TEXT); CREATE TABLE runs(id TEXT, message_id TEXT, status TEXT, scope_json TEXT, created_at TEXT, principal_id TEXT); CREATE TABLE authorization_decisions_all(id TEXT, run_id TEXT, action TEXT, decision TEXT); CREATE TABLE deliveries(id TEXT, run_id TEXT, status TEXT, external_id TEXT, destination_scope_key TEXT);",
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
  db.prepare("INSERT INTO runs VALUES (?,?,?,?,?,?)").run(
    "r",
    "m",
    "succeeded",
    JSON.stringify(scope),
    now,
    "principal-owner-1",
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
  const earlierReport = { ...c, startedAt: new Date(Date.parse(c.startedAt) - 1000).toISOString() };
  const created = caseEvidence(db, earlierReport, config).runCreatedAt;
  assert.equal(created, db.prepare("SELECT created_at FROM runs WHERE id='r'").get().created_at);
  assert.notEqual(created, earlierReport.startedAt);
  db.exec("UPDATE authorization_decisions_all SET decision='DENY'");
  assert.throws(() => caseEvidence(db, c, config), {
    code: "AUTHORIZATION_EVIDENCE",
  });
  assert.throws(() => caseEvidence(db, { ...c, route: "20002" }, config), {
    code: "RUN_EVIDENCE",
  });
});

test("feature lease cleanup is independently verified before a failing feature assertion", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "qq-product-cleanup-order-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { db, c, config } = evidenceFixture();
  t.after(() => db.close());
  const now = Date.now();
  const leaseId = randomUUID();
  const token = "0123456789abcdef0123456789abcdef";
  const prompt = `GLASSBOX_ACCEPTANCE_V1 ${token}\nRead a fixed group summary`;
  const toolsSha256 = messageDigest("tools");
  c.startedAt = new Date(now - 10_000).toISOString();
  c.prompt = prompt;
  c.token = token;
  c.leaseRevoked = true;
  c.status = "FAIL";
  c.code = "REPLY_ASSERTION_FAILED";
  c.sendAttempted = true;
  c.leaseRegistrationAttempted = true;
  c.replies = [
    {
      route: c.route,
      messageId: "90002",
      textSha256: messageDigest("reply without nonce"),
      textBytes: 18,
      matches: false,
      receivedAt: new Date(now - 2_000).toISOString(),
    },
  ];
  c.inputBinding.botMessageId = "90001";
  c.featureAssertions = [
    { kind: "trace", type: "tool_result", where: { name: "fixture" }, count: 1 },
  ];
  db.prepare("UPDATE messages SET external_id=? WHERE id='m'").run(c.inputBinding.botMessageId);
  c.acceptanceLease = { leaseId, expiresAt: now + 600_000, toolsSha256 };
  const evidence = caseEvidence(db, c, config);
  const { runId } = evidence;
  const scopeSha256 = messageDigest(
    JSON.stringify([
      evidence.scope.connectionId,
      evidence.scope.botId,
      evidence.scope.chatType,
      evidence.scope.chatId,
      evidence.scope.senderId,
      evidence.scope.threadId,
    ]),
  );
  const principalId = "principal-owner-1";
  const rows = [
    {
      at: new Date(now - 9_000).toISOString(),
      event: "lease_registered",
      leaseId,
      principalId,
      marker: token,
      expiresAt: c.acceptanceLease.expiresAt,
      toolsSha256,
      scopeSha256,
    },
    {
      at: new Date(now - 8_000).toISOString(),
      event: "run_bound",
      leaseId,
      principalId,
      marker: token,
      runId,
      messageId: c.inputBinding.botMessageId,
      textSha256: messageDigest(prompt),
      toolsSha256,
      scopeSha256,
    },
    {
      at: new Date(now - 7_000).toISOString(),
      event: "lease_revoked",
      leaseId,
      principalId,
      marker: token,
      scopeSha256,
    },
  ];
  const auditPath = join(directory, "qq-live-acceptance-audit.jsonl");
  await writeFile(auditPath, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);

  const cleanup = await verifyCaseWithLeaseCleanup(db, directory, c, config, async (resolved) => ({
    runId: resolved.runId,
  }));
  assert.equal(cleanup.cleanupVerified, true);
  assert.equal(cleanup.evidence.runId, runId);

  const cleanupOnly = await verifyFailedCaseCleanupInDatabase(db, directory, c, config);
  assert.deepEqual(cleanupOnly, { caseId: c.id, runId, cleanupVerified: true });
  assert.equal(Object.hasOwn(cleanupOnly, "status"), false);

  const dbPath = join(directory, "glassbox.db");
  db.exec(`VACUUM INTO '${dbPath.replaceAll("'", "''")}'`);
  const expectedCommit = "c".repeat(40);
  const runtimeConfig = {
    checkout: process.cwd(),
    dataDirectory: directory,
    expectedCommit,
    connectionId: "qq-live",
  };
  const expectedRuntime = {
    checkout: resolve(runtimeConfig.checkout),
    dataDirectory: resolve(directory),
    commit: expectedCommit,
    pid: 123,
    connectionId: "qq-live",
    threadId: null,
  };
  const failedReport = {
    mode: "run",
    status: "FAIL",
    runtime: expectedRuntime,
    cases: [c],
  };
  const runtimeCapture = (finalPid) => {
    let statusCalls = 0;
    return (command, args) => {
      if (command === "git") return args[0] === "rev-parse" ? expectedCommit : "";
      if (command === process.execPath) {
        statusCalls += 1;
        const pid = statusCalls === 1 ? 123 : finalPid;
        return JSON.stringify({
          dataDirectory: directory,
          processes: [
            {
              name: "glassbox",
              running: true,
              status: "running",
              pid,
              checkout: process.cwd(),
              launchCommit: expectedCommit,
              launchClean: true,
            },
          ],
          glassboxReady: true,
          onebotReady: true,
        });
      }
      throw new Error("Unexpected runtime probe.");
    };
  };
  await assert.rejects(
    verifyFailedCaseCleanup(
      failedReport,
      { ...config, runtime: runtimeConfig },
      runtimeCapture(124),
    ),
    (error) => error.code === "RUNTIME_CHANGED" && error.cleanupVerified === false,
    "a changed final runtime snapshot must not retain cleanup proof",
  );
  const wrapperCleanup = await verifyFailedCaseCleanup(
    failedReport,
    { ...config, runtime: runtimeConfig },
    runtimeCapture(123),
  );
  assert.equal(wrapperCleanup.status, "CLEANUP_VERIFIED");
  assert.equal(wrapperCleanup.cases[0].cleanupVerified, true);

  await assert.rejects(
    verifyCaseWithLeaseCleanup(db, directory, c, config, async (resolved) => {
      observeFeature(
        [{ kind: "trace", type: "tool_result", where: { name: "missing_tool" }, count: 1 }],
        { db, events: [], runId: resolved.runId },
      );
    }),
    (error) =>
      error.code === "FEATURE_TRACE" && error.status === "FAIL" && error.cleanupVerified === true,
    "production case pipeline must finish independent cleanup proof before feature assertions",
  );

  await assert.rejects(
    verifyCaseWithLeaseCleanup(db, directory, { ...c, route: "20002" }, config, async () => null),
    (error) => error.code === "RUN_EVIDENCE" && error.cleanupVerified === false,
    "a previous verified case must not mark a later case cleanup as verified",
  );

  await writeFile(auditPath, `${JSON.stringify(rows[0])}\n`);
  await assert.rejects(
    verifyFailedCaseCleanupInDatabase(db, directory, c, config),
    (error) =>
      error.code === "LEASE_CLEANUP_EVIDENCE" &&
      error.status === "INCONCLUSIVE" &&
      error.cleanupVerified === false,
    "incomplete independent audit remains fail closed",
  );
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
  assert.equal(evidence.reply.botMessageId, String(fixture.delivery.external_id));
  assert.equal(evidence.reply.driverMessageId, fixture.c.replies[0].messageId);
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

test("group files witness comes from both actual private reply reads and rejects hidden media", async () => {
  const nonce = "a".repeat(32);
  const replyText = `QQGROUPFILES ${nonce} files=1 folders=2`;
  const fixture = boundMessageFixture();
  fixture.c.route = "private";
  fixture.c.token = nonce;
  fixture.c.expected = [nonce];
  fixture.c.featureAssertions = [
    { kind: "group_files", tool: "qq_group_files", groupId: "20001", count: 1 },
  ];
  fixture.c.replies[0].route = "private";
  fixture.c.replies[0].textSha256 = messageDigest(replyText);
  let hideMedia = false;
  for (const [role, client] of Object.entries(fixture.clients)) {
    const call = client.call.bind(client);
    client.call = async (action, params) => {
      const result = await call(action, params);
      result.message_type = "private";
      delete result.group_id;
      if (["2300000001", "2300000002"].includes(params.message_id)) {
        result.message = [{ type: "text", data: { text: replyText } }];
        if (hideMedia && role === "driver")
          result.message.push({ type: "image", data: { file: "fixture-private-file" } });
      }
      return result;
    };
  }
  const verified = await verifyMessageBindings(
    fixture.c,
    fixture.config,
    fixture.clients,
    fixture.delivery,
  );
  assert.deepEqual(verified.reply.groupFiles, { fileCount: 1, folderCount: 2 });
  assert.equal(JSON.stringify(verified).includes(replyText), false);
  hideMedia = true;
  await assert.rejects(
    verifyMessageBindings(fixture.c, fixture.config, fixture.clients, fixture.delivery),
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

test("member count projection must match an independent Bot read in private scope", async () => {
  const c = {
    route: "private",
    featureAssertions: [{ kind: "aggregate_projection", tool: "qq_group_members", count: 1 }],
  };
  const feature = {
    observations: [{ kind: "aggregate_projection", tool: "qq_group_members", memberCount: 3 }],
  };
  const config = { groups: [{ alias: "A", id: "20001" }] };
  const events = memberCountTrace();
  let reads = 0;
  await verifyGroupMemberCountEvidence(
    c,
    feature,
    config,
    {
      bot: {
        async readGroupMemberCount() {
          reads++;
          return 3;
        },
      },
    },
    events,
    "run-fixture",
  );
  assert.equal(reads, 1);
  await verifyGroupMemberCountEvidence(
    c,
    feature,
    config,
    {
      bot: {
        async readGroupMemberCount() {
          return 3;
        },
      },
    },
    memberCountTrace({ groupId: "20001", operation: "get_group_member_list" }),
    "run-fixture",
  );
  await assert.rejects(
    verifyGroupMemberCountEvidence(
      c,
      feature,
      config,
      {
        bot: {
          async readGroupMemberCount() {
            return 2;
          },
        },
      },
      events,
      "run-fixture",
    ),
    { code: "MEMBER_COUNT_CHANGED", status: "INCONCLUSIVE" },
  );
});

test("member count projection rejects missing read, observation, or private scope", async () => {
  const c = {
    route: "private",
    featureAssertions: [{ kind: "aggregate_projection", tool: "qq_group_members", count: 1 }],
  };
  const config = { groups: [{ alias: "A", id: "20001" }] };
  const feature = {
    observations: [{ kind: "aggregate_projection", tool: "qq_group_members", memberCount: 0 }],
  };
  const events = memberCountTrace();
  await assert.rejects(
    verifyGroupMemberCountEvidence(c, feature, config, { bot: {} }, events, "run-fixture"),
    { code: "MEMBER_COUNT_UNAVAILABLE", status: "INCONCLUSIVE" },
  );
  await assert.rejects(
    verifyGroupMemberCountEvidence(
      c,
      { observations: [] },
      config,
      {
        bot: {
          async readGroupMemberCount() {
            return 0;
          },
        },
      },
      events,
      "run-fixture",
    ),
    { code: "MEMBER_COUNT_EVIDENCE", status: "INCONCLUSIVE" },
  );
  await assert.rejects(
    verifyGroupMemberCountEvidence(
      { ...c, route: "20001" },
      feature,
      config,
      {
        bot: {
          async readGroupMemberCount() {
            return 0;
          },
        },
      },
      events,
      "run-fixture",
    ),
    { code: "MEMBER_COUNT_SCOPE", status: "INCONCLUSIVE" },
  );
});

test("raw member-tool Trace cannot downgrade to a transport-only product report", async () => {
  const config = { groups: [{ alias: "A", id: "20001" }] };
  const events = [
    {
      runId: "run-fixture",
      type: "tool_call",
      data: { name: "qq_group_members" },
    },
    {
      runId: "run-fixture",
      type: "tool_result",
      data: { name: "qq_group_members" },
    },
  ];
  let reads = 0;
  const clients = {
    bot: {
      async readGroupMemberCount() {
        reads++;
        return 3;
      },
    },
  };
  for (const c of [
    { route: "private" },
    {
      route: "private",
      featureAssertions: [
        {
          kind: "trace",
          type: "tool_result",
          where: { name: "qq_group_members", isError: false },
          count: 1,
        },
      ],
    },
  ])
    await assert.rejects(
      verifyGroupMemberCountEvidence(c, undefined, config, clients, events, "run-fixture"),
      { code: "MEMBER_COUNT_ASSERTION_MISSING", status: "INCONCLUSIVE" },
    );
  assert.equal(reads, 0);
  await verifyGroupMemberCountEvidence(
    { route: "private" },
    undefined,
    config,
    clients,
    [{ ...events[0], runId: "another-run" }],
    "run-fixture",
  );
});

test("member count requires one successful call-result pair scoped to group A", async () => {
  const c = {
    route: "private",
    featureAssertions: [{ kind: "aggregate_projection", tool: "qq_group_members", count: 1 }],
  };
  const feature = {
    observations: [{ kind: "aggregate_projection", tool: "qq_group_members", memberCount: 3 }],
  };
  const config = { groups: [{ alias: "A", id: "20001" }] };
  const valid = memberCountTrace();
  const wrongGroup = memberCountTrace({ groupId: "20002", operation: "get_group_member_list" });
  const wrongOperation = memberCountTrace({ groupId: "20001", operation: "get_group_member_info" });
  const extraInput = memberCountTrace({
    groupId: "20001",
    operation: "get_group_member_list",
    unrestricted: true,
  });
  const nonemptyParams = memberCountTrace({
    groupId: "20001",
    operation: "get_group_member_list",
    params: { group_id: "20002" },
  });
  const missingInput = memberCountTrace();
  delete missingInput[0].data.input;
  const multipleCalls = [...valid, { ...valid[0], toolCallId: "another-call" }];
  const multipleResults = [...valid, { ...valid[1], toolCallId: "another-call" }];
  const mismatchedCallId = memberCountTrace();
  mismatchedCallId[1].toolCallId = "another-call";
  mismatchedCallId[1].data.toolCallId = "another-call";
  const failedResult = memberCountTrace();
  failedResult[1].data.isError = true;

  for (const events of [
    wrongGroup,
    wrongOperation,
    extraInput,
    nonemptyParams,
    missingInput,
    multipleCalls,
    multipleResults,
    mismatchedCallId,
    failedResult,
  ])
    await assert.rejects(
      verifyGroupMemberCountEvidence(
        c,
        feature,
        config,
        {
          bot: {
            async readGroupMemberCount() {
              return 3;
            },
          },
        },
        events,
        "run-fixture",
      ),
      { code: "MEMBER_COUNT_TRACE", status: "INCONCLUSIVE" },
    );
});

test("isolation reply proof checks actual QQ content even when report hash and nonce match", async () => {
  const sentinel = `qq-isolation-secret-${"b".repeat(32)}`;
  const assertion = {
    kind: "history_exclusion_result",
    tool: "owner_history_search",
    result: "no_match",
    count: 1,
    query: "a".repeat(32),
    groupId: "20001",
    sourceGroupId: "20002",
    sourceRunId: "seed-run",
    until: "2026-10-06T00:00:00.000Z",
    sentinelSha256: messageDigest(sentinel),
  };
  const clean = boundMessageFixture();
  clean.c.featureAssertions = [assertion];
  await verifyMessageBindings(clean.c, clean.config, clean.clients, clean.delivery);
  const leaked = boundMessageFixture({
    driverReplyText: `reply with nonce-expected and 42 ${sentinel}`,
  });
  leaked.c.featureAssertions = [assertion];
  leaked.c.replies[0].textSha256 = messageDigest(leaked.replyText);
  await assert.rejects(
    verifyMessageBindings(leaked.c, leaked.config, leaked.clients, leaked.delivery),
    { code: "MESSAGE_BINDING_MISMATCH" },
  );
  const duplicate = boundMessageFixture();
  duplicate.c.featureAssertions = [assertion, assertion];
  await assert.rejects(
    verifyMessageBindings(duplicate.c, duplicate.config, duplicate.clients, duplicate.delivery),
    { code: "MESSAGE_BINDING" },
  );
});
