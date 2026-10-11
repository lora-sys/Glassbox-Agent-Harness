import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  caseEvidence,
  openProductEvidenceDatabase,
  readTraceEvents,
  runtimeSnapshot,
  runtimeInspectionSnapshot,
  verifyMessageBindings,
  verifyTraceEvidence,
  verifyAuthorizationProjectionTrace,
  verifyLeaseTraceEvidence,
  verifyGroupMemberCountEvidence,
  verifyCaseWithLeaseCleanup,
  verifyFailedCaseCleanupInDatabase,
  verifyFailedCaseCleanup,
  filteredAuthorizationEvidence,
} from "../lib/product-evidence.mjs";
import { observeFeature } from "../lib/feature-observer.mjs";
import { serviceSourceTreeSha256 } from "../../../scripts/service-source-identity.mjs";

function git(cwd, ...args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

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

test("development runtime binds expected, current and launch source tree without weakening clean mode", (t) => {
  const checkout = mkdtempSync(join(tmpdir(), "qq-runtime-source-"));
  t.after(() => rmSync(checkout, { recursive: true, force: true }));
  git(checkout, "init", "-q", "-b", "main");
  git(checkout, "config", "user.name", "Fixture");
  git(checkout, "config", "user.email", "fixture@example.invalid");
  writeFileSync(join(checkout, "app.mjs"), "export const value = 1;\n");
  git(checkout, "add", "--all");
  git(checkout, "commit", "-q", "-m", "fixture");
  const expectedCommit = git(checkout, "rev-parse", "HEAD");
  const expectedSourceTreeSha256 = serviceSourceTreeSha256(checkout);
  const dataDirectory = join(checkout, "data");
  const runtime = {
    checkout,
    dataDirectory,
    expectedCommit,
    expectedSourceTreeSha256,
    connectionId: "qq-live",
  };
  let launchSourceTreeSha256 = expectedSourceTreeSha256;
  const status = {
    dataDirectory,
    processes: [
      {
        name: "glassbox",
        running: true,
        status: "running",
        pid: 123,
        checkout,
        launchCommit: expectedCommit,
        launchClean: false,
        get launchSourceTreeSha256() {
          return launchSourceTreeSha256;
        },
      },
    ],
    glassboxReady: true,
    onebotReady: true,
  };
  const capture = (command, args, options) => {
    if (command === "git") {
      if (args[0] === "ls-files")
        return execFileSync(command, args, { ...options, encoding: null });
      return execFileSync(command, args, options);
    }
    if (command === process.execPath) return JSON.stringify(status);
    throw new Error("Unexpected runtime probe.");
  };

  const snapshot = runtimeSnapshot(runtime, capture);
  assert.equal(snapshot.development, true);
  assert.equal(snapshot.sourceTreeSha256, expectedSourceTreeSha256);
  assert.equal(snapshot.commit, expectedCommit);
  assert.throws(
    () => runtimeSnapshot({ ...runtime, expectedSourceTreeSha256: "z".repeat(64) }, capture),
    { code: "RUNTIME_CONFIG" },
  );
  launchSourceTreeSha256 = "b".repeat(64);
  assert.throws(() => runtimeSnapshot(runtime, capture), { code: "RUNTIME_SOURCE_TREE" });
  launchSourceTreeSha256 = expectedSourceTreeSha256;

  writeFileSync(join(checkout, "app.mjs"), "export const value = 2;\n");
  assert.throws(() => runtimeSnapshot(runtime, capture), { code: "RUNTIME_SOURCE_TREE" });
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
    assert.equal(args.filter((value) => value === "authorization_projection_receipt").length, 1);
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

function filteredSourceFixture() {
  const fixture = evidenceFixture();
  const { db, scopeKey } = fixture;
  db.exec(`
    ALTER TABLE authorization_decisions_all ADD COLUMN principal_id TEXT;
    ALTER TABLE authorization_decisions_all ADD COLUMN scope_key TEXT;
    ALTER TABLE authorization_decisions_all ADD COLUMN delivery_source TEXT;
    ALTER TABLE authorization_decisions_all ADD COLUMN created_at TEXT;
    ALTER TABLE authorization_decisions_all ADD COLUMN resource_id TEXT;
    CREATE TABLE resources(id TEXT, kind TEXT);
    INSERT INTO resources VALUES ('filtered-resource','qq_group');
    CREATE TABLE ops_trace_events(event_id TEXT, ts TEXT, type TEXT, run_id TEXT, principal_id TEXT, data_json TEXT);
  `);
  const at = db.prepare("SELECT created_at FROM runs WHERE id='r'").get().created_at;
  db.prepare("INSERT INTO authorization_decisions_all VALUES (?,?,?,?,?,?,?,?,?)").run(
    "filtered-read",
    "r",
    "history:read",
    "DENY",
    "principal-owner-1",
    scopeKey,
    null,
    at,
    "filtered-resource",
  );
  const witness = {
    decisionId: "filtered-read",
    projection: "conversation-history",
    outcome: "excluded",
  };
  const insertWitness = (data = witness, principal = "principal-owner-1", run = "r", ts = at) =>
    db
      .prepare("INSERT INTO ops_trace_events VALUES (?,?,?,?,?,?)")
      .run("filter-event", ts, "authorization.filtered", run, principal, JSON.stringify(data));
  return { ...fixture, witness, insertWitness, at };
}

function projectionReceiptFixture() {
  const fixture = evidenceFixture();
  const { db, scopeKey } = fixture;
  db.exec(
    [
      "ALTER TABLE authorization_decisions_all ADD COLUMN principal_id TEXT",
      "ALTER TABLE authorization_decisions_all ADD COLUMN scope_key TEXT",
      "ALTER TABLE authorization_decisions_all ADD COLUMN delivery_source TEXT",
      "ALTER TABLE authorization_decisions_all ADD COLUMN created_at TEXT",
      "ALTER TABLE authorization_decisions_all ADD COLUMN resource_id TEXT",
      "ALTER TABLE authorization_decisions_all ADD COLUMN reason TEXT",
      "ALTER TABLE authorization_decisions_all ADD COLUMN conversation_id TEXT",
      "CREATE TABLE resources(id TEXT, kind TEXT)",
      "INSERT INTO resources VALUES ('group:20001','qq_group')",
      "CREATE TABLE ops_trace_events(event_id TEXT, ts TEXT, type TEXT, run_id TEXT, principal_id TEXT, data_json TEXT)",
    ].join("; "),
  );
  const at = db.prepare("SELECT created_at FROM runs WHERE id='r'").get().created_at;
  db.prepare("INSERT INTO authorization_decisions_all VALUES (?,?,?,?,?,?,?,?,?,?,?)").run(
    "projection-deny",
    "r",
    "group:files:write",
    "DENY",
    "principal-owner-1",
    scopeKey,
    null,
    at,
    "group:20001",
    "no_grant",
    "conversation-r",
  );
  const receiptId = "projection-receipt-1";
  const inputSha256 = createHash("sha256").update("{}", "utf8").digest("hex");
  const receipt = {
    schema: "glassbox.authorization-projection-receipt.v1",
    receiptId,
    kind: "managed_group_inventory",
    purpose: "managed_group_category_availability",
    conversationId: "conversation-r",
    scopeKey,
    toolName: "qq_groups",
    toolCallId: "inventory-call",
    inputSha256,
    inputBytes: 2,
    outputSha256: "c".repeat(64),
    outputBytes: 42,
    decisions: [
      {
        decisionId: "projection-deny",
        action: "group:files:write",
        resourceId: "group:20001",
        purpose: "managed_group_category_availability",
      },
    ],
  };
  const insertReceipt = (data = receipt, run = "r", principal = "principal-owner-1", ts = at) =>
    db
      .prepare("INSERT INTO ops_trace_events VALUES (?,?,?,?,?,?)")
      .run(
        randomUUID(),
        ts,
        "authorization.projection_receipt",
        run,
        principal,
        JSON.stringify(data),
      );
  insertReceipt();
  return { ...fixture, receipt, insertReceipt };
}

function projectionTrace(receipt, overrides = {}) {
  const common = { runId: "r", principalId: "principal-owner-1", toolCallId: receipt.toolCallId };
  return [
    {
      ...common,
      type: "tool_call",
      timestamp: "2026-10-07T00:00:00.000Z",
      data: {
        ...common,
        name: receipt.toolName,
        projectionInputSha256: receipt.inputSha256,
        projectionInputBytes: receipt.inputBytes,
        ...overrides.call,
      },
    },
    {
      ...common,
      type: "authorization_projection_receipt",
      timestamp: "2026-10-07T00:00:01.000Z",
      receiptEventId: receipt.receiptId,
      schema: receipt.schema,
      receiptId: receipt.receiptId,
      kind: receipt.kind,
      purpose: receipt.purpose,
      conversationId: receipt.conversationId,
      scopeKey: receipt.scopeKey,
      toolName: receipt.toolName,
      toolCallId: receipt.toolCallId,
      inputSha256: receipt.inputSha256,
      inputBytes: receipt.inputBytes,
      outputSha256: receipt.outputSha256,
      outputBytes: receipt.outputBytes,
      decisions: receipt.decisions,
      ...overrides.receipt,
    },
    {
      ...common,
      type: "tool_result",
      timestamp: "2026-10-07T00:00:02.000Z",
      data: {
        ...common,
        name: receipt.toolName,
        isError: false,
        outputSha256: receipt.outputSha256,
        outputBytes: receipt.outputBytes,
        ...overrides.result,
      },
    },
  ];
}

test("category availability DENY stays recorded and requires the exact paired projection receipt", (t) => {
  const f = projectionReceiptFixture();
  t.after(() => f.db.close());
  const evidence = caseEvidence(f.db, f.c, f.config);
  assert.equal(
    evidence.decisions.find((decision) => decision.id === "projection-deny").decision,
    "DENY",
  );
  assert.deepEqual(evidence.filteredDecisions, []);
  assert.equal(evidence.authorizationProjectionReceipts.length, 1);
  verifyAuthorizationProjectionTrace(
    projectionTrace(evidence.authorizationProjectionReceipts[0]),
    evidence.runId,
    evidence.principalId,
    evidence.authorizationProjectionReceipts,
  );
});

test("projection receipt chronology uses gbxtrace row time and sequence when the event omits timestamp", (t) => {
  const f = projectionReceiptFixture();
  t.after(() => f.db.close());
  const evidence = caseEvidence(f.db, f.c, f.config);
  const rows = projectionTrace(evidence.authorizationProjectionReceipts[0]).map((event, index) => {
    const row = {
      ...event,
      traceSequence: index + 10,
      traceTimestamp: event.timestamp,
    };
    if (event.type === "authorization_projection_receipt") delete row.timestamp;
    return row;
  });
  verifyAuthorizationProjectionTrace(
    rows,
    evidence.runId,
    evidence.principalId,
    evidence.authorizationProjectionReceipts,
  );
  const outOfOrder = rows.map((event) => ({ ...event }));
  outOfOrder[1].traceSequence = outOfOrder[2].traceSequence + 1;
  assert.throws(
    () =>
      verifyAuthorizationProjectionTrace(
        outOfOrder,
        evidence.runId,
        evidence.principalId,
        evidence.authorizationProjectionReceipts,
      ),
    { code: "AUTHORIZATION_EVIDENCE" },
  );
});

test("projection receipts fail closed for revocation, scope drift, reuse, wrong purpose and changed output", (t) => {
  const cases = [
    (f) =>
      f.db.exec(
        "UPDATE authorization_decisions_all SET decision='ALLOW' WHERE id='projection-deny'",
      ),
    (f) => f.db.exec("DELETE FROM ops_trace_events WHERE type='authorization.projection_receipt'"),
    (f) =>
      f.db.exec(
        "UPDATE authorization_decisions_all SET scope_key='other-scope' WHERE id='projection-deny'",
      ),
    (f) => {
      const at = f.db.prepare("SELECT created_at FROM runs WHERE id='r'").get().created_at;
      f.db
        .prepare("INSERT INTO authorization_decisions_all VALUES (?,?,?,?,?,?,?,?,?,?,?)")
        .run(
          "projection-deny-partial",
          "r",
          "group:moderate",
          "DENY",
          "principal-owner-1",
          f.scopeKey,
          null,
          at,
          "group:20001",
          "no_grant",
          "conversation-r",
        );
    },
    (f) => f.insertReceipt({ ...f.receipt, scopeKey: "other-scope" }),
    (f) =>
      f.insertReceipt({
        ...f.receipt,
        decisions: [{ ...f.receipt.decisions[0], action: "delivery:send" }],
      }),
    (f) => f.insertReceipt({ ...f.receipt, receiptId: "projection-receipt-2" }),
    (f) =>
      f.db.exec(
        "UPDATE authorization_decisions_all SET reason='unknown_reason' WHERE id='projection-deny'",
      ),
  ];
  for (const change of cases) {
    const f = projectionReceiptFixture();
    t.after(() => f.db.close());
    change(f);
    assert.throws(() => caseEvidence(f.db, f.c, f.config), { code: "AUTHORIZATION_EVIDENCE" });
  }
  const f = projectionReceiptFixture();
  t.after(() => f.db.close());
  const evidence = caseEvidence(f.db, f.c, f.config);
  const receipts = evidence.authorizationProjectionReceipts;
  const mutatedInput = JSON.stringify({ query: "changed" });
  const mutatedInputEvidence = {
    projectionInputSha256: createHash("sha256").update(mutatedInput, "utf8").digest("hex"),
    projectionInputBytes: Buffer.byteLength(mutatedInput, "utf8"),
  };
  for (const call of [
    { projectionInputSha256: "d".repeat(64) },
    mutatedInputEvidence,
    { projectionInputBytes: receipts[0].inputBytes + 1 },
    { projectionInputSha256: undefined, projectionInputBytes: undefined },
  ]) {
    assert.throws(
      () =>
        verifyAuthorizationProjectionTrace(
          projectionTrace(receipts[0], { call }),
          evidence.runId,
          evidence.principalId,
          receipts,
        ),
      { code: "AUTHORIZATION_EVIDENCE" },
    );
  }
  assert.throws(
    () =>
      verifyAuthorizationProjectionTrace(
        projectionTrace(receipts[0], {
          result: { outputSha256: "d".repeat(64) },
        }),
        evidence.runId,
        evidence.principalId,
        receipts,
      ),
    { code: "AUTHORIZATION_EVIDENCE" },
  );
  const wrongPrincipalTrace = projectionTrace(receipts[0]);
  wrongPrincipalTrace[1].principalId = "another-principal";
  assert.throws(
    () =>
      verifyAuthorizationProjectionTrace(
        wrongPrincipalTrace,
        evidence.runId,
        evidence.principalId,
        receipts,
      ),
    { code: "AUTHORIZATION_EVIDENCE" },
  );
});

test("source denial remains a DENY and passes only with an exact durable exclusion witness", (t) => {
  const { db, c, config, insertWitness } = filteredSourceFixture();
  t.after(() => db.close());
  assert.throws(() => caseEvidence(db, c, config), { code: "AUTHORIZATION_EVIDENCE" });
  insertWitness();
  const result = caseEvidence(db, c, config);
  assert.equal(
    result.decisions.find((decision) => decision.id === "filtered-read").decision,
    "DENY",
  );
  assert.deepEqual(result.filteredDecisions, [
    {
      decisionId: "filtered-read",
      eventId: "filter-event",
      projection: "conversation-history",
    },
  ]);
  db.exec("INSERT INTO ops_trace_events SELECT * FROM ops_trace_events");
  assert.throws(() => caseEvidence(db, c, config), { code: "AUTHORIZATION_EVIDENCE" });
});

function mixedProjectionAndHistoryFixture() {
  const f = projectionReceiptFixture();
  const { db, scopeKey, receipt } = f;
  const at = db.prepare("SELECT created_at FROM runs WHERE id='r'").get().created_at;
  const categories = [
    { id: "projection-deny-2", action: "group:moderate", resourceId: "group:20002" },
    { id: "projection-deny-3", action: "group:settings:write", resourceId: "group:20003" },
    { id: "projection-deny-4", action: "group:files:write", resourceId: "group:20004" },
  ];
  for (const category of categories) {
    db.prepare("INSERT INTO resources VALUES (?, 'qq_group')").run(category.resourceId);
    db.prepare("INSERT INTO authorization_decisions_all VALUES (?,?,?,?,?,?,?,?,?,?,?)").run(
      category.id,
      "r",
      category.action,
      "DENY",
      "principal-owner-1",
      scopeKey,
      null,
      at,
      category.resourceId,
      "no_grant",
      "conversation-r",
    );
  }
  const categoryEntries = [
    ...receipt.decisions,
    ...categories.map(({ id, action, resourceId }) => ({
      decisionId: id,
      action,
      resourceId,
      purpose: "managed_group_category_availability",
    })),
  ];
  const combinedReceipt = { ...receipt, decisions: categoryEntries };
  db.prepare(
    "UPDATE ops_trace_events SET data_json=? WHERE type='authorization.projection_receipt'",
  ).run(JSON.stringify(combinedReceipt));
  for (let index = 0; index < 27; index += 1) {
    const id = `history-deny-${index}`;
    db.prepare("INSERT INTO authorization_decisions_all VALUES (?,?,?,?,?,?,?,?,?,?,?)").run(
      id,
      "r",
      "history:read",
      "DENY",
      "principal-owner-1",
      scopeKey,
      null,
      at,
      "group:20001",
      "source_policy_denied",
      "conversation-r",
    );
    db.prepare("INSERT INTO ops_trace_events VALUES (?,?,?,?,?,?)").run(
      `history-exclusion-${index}`,
      at,
      "authorization.filtered",
      "r",
      "principal-owner-1",
      JSON.stringify({
        decisionId: id,
        projection: "conversation-history",
        outcome: "excluded",
      }),
    );
  }
  const decisions = db
    .prepare("SELECT id, decision, action FROM authorization_decisions_all WHERE run_id='r'")
    .all();
  return { ...f, decisions };
}

test("mixed managed-group projection receipts and history exclusions cover only their own DENYs", (t) => {
  const f = mixedProjectionAndHistoryFixture();
  t.after(() => f.db.close());
  const result = filteredAuthorizationEvidence(
    f.db,
    { id: "r", principal_id: "principal-owner-1" },
    f.scopeKey,
    f.decisions,
  );
  assert.equal(result.length, 27);
  assert.equal(new Set(result.map((item) => item.decisionId)).size, 27);
  assert.ok(result.every((item) => item.projection === "conversation-history"));
});

test("mixed denial coverage rejects a missing history exclusion or invalid projection receipt", (t) => {
  for (const mutate of [
    (f) => f.db.prepare("DELETE FROM ops_trace_events WHERE event_id='history-exclusion-13'").run(),
    (f) => {
      const invalid = { ...f.receipt, unexpected: true };
      const data = {
        ...invalid,
        decisions: [
          ...f.receipt.decisions,
          {
            decisionId: "projection-deny-2",
            action: "group:moderate",
            resourceId: "group:20002",
            purpose: "managed_group_category_availability",
          },
          {
            decisionId: "projection-deny-3",
            action: "group:settings:write",
            resourceId: "group:20003",
            purpose: "managed_group_category_availability",
          },
          {
            decisionId: "projection-deny-4",
            action: "group:files:write",
            resourceId: "group:20004",
            purpose: "managed_group_category_availability",
          },
        ],
      };
      f.db
        .prepare(
          "UPDATE ops_trace_events SET data_json=? WHERE type='authorization.projection_receipt'",
        )
        .run(JSON.stringify(data));
    },
  ]) {
    const f = mixedProjectionAndHistoryFixture();
    t.after(() => f.db.close());
    mutate(f);
    assert.throws(
      () =>
        filteredAuthorizationEvidence(
          f.db,
          { id: "r", principal_id: "principal-owner-1" },
          f.scopeKey,
          f.decisions,
        ),
      { code: "AUTHORIZATION_EVIDENCE" },
    );
  }
});

test("document source exclusions use the same strict pairing contract as history sources", (t) => {
  const { db, c, config, witness, insertWitness } = filteredSourceFixture();
  t.after(() => db.close());
  db.exec("UPDATE authorization_decisions_all SET action='document:read' WHERE id='filtered-read'");
  assert.throws(() => caseEvidence(db, c, config), { code: "AUTHORIZATION_EVIDENCE" });
  insertWitness({ ...witness, projection: "task-list" });
  assert.equal(caseEvidence(db, c, config).filteredDecisions[0].projection, "task-list");
});

test("all protected source classifications require exact exclusion evidence", (t) => {
  const cases = [
    ["read", "qq_group", "filtered-resource"],
    ["context:read", "qq_group", "filtered-resource"],
    ["qq:capability:read", "qq_group", "filtered-resource"],
    ["group:read", "qq_group", "filtered-resource"],
    ["group:members:read", "qq_group", "filtered-resource"],
    ["group:content:read", "qq_group", "filtered-resource"],
    ["group:files:read", "qq_group", "filtered-resource"],
    ["account:status:read", "qq_group", "filtered-resource"],
    ["worker:status", "worker", "filtered-resource"],
    ["task:list", "task", "filtered-resource"],
    ["history:search", "owner-history", "filtered-resource"],
    ["workspace:write", "workspace", "workspace:test"],
    ["model:switch", "owner-control", "owner-control"],
  ];
  for (const [action, kind, resourceId] of cases) {
    const f = filteredSourceFixture();
    t.after(() => f.db.close());
    f.db.prepare("UPDATE resources SET id=?, kind=?").run(resourceId, kind);
    f.db
      .prepare(
        "UPDATE authorization_decisions_all SET action=?, resource_id=? WHERE id='filtered-read'",
      )
      .run(action, resourceId);
    assert.throws(() => caseEvidence(f.db, f.c, f.config), { code: "AUTHORIZATION_EVIDENCE" });
    f.insertWitness();
    assert.equal(caseEvidence(f.db, f.c, f.config).filteredDecisions.length, 1, action);
  }
});

test("exclusion cannot excuse execution denial or approval, or mismatch Run, actor, scope and outcome", (t) => {
  const cases = [
    (f) => {
      f.insertWitness();
      f.db.exec("UPDATE resources SET kind='web-public'");
    },
    (f) => {
      f.insertWitness();
      f.db.exec("DELETE FROM resources");
    },
    (f) => {
      f.insertWitness();
      f.db.exec(
        "UPDATE authorization_decisions_all SET action='workspace:write' WHERE id='filtered-read'",
      );
    },
    (f) => {
      f.insertWitness();
      f.db.exec(
        "UPDATE authorization_decisions_all SET action='model:switch' WHERE id='filtered-read'",
      );
    },
    (f) => {
      f.insertWitness();
      f.db.exec(
        "UPDATE authorization_decisions_all SET action='delivery:send' WHERE id='filtered-read'",
      );
    },
    (f) => {
      f.insertWitness();
      f.db.exec(
        "UPDATE authorization_decisions_all SET decision='REQUIRES_APPROVAL' WHERE id='filtered-read'",
      );
    },
    (f) => f.insertWitness(f.witness, "another-principal"),
    (f) => f.insertWitness(f.witness, "principal-owner-1", "another-run"),
    (f) => {
      f.insertWitness();
      f.db.exec(
        "UPDATE authorization_decisions_all SET scope_key='other-scope' WHERE id='filtered-read'",
      );
    },
    (f) => f.insertWitness({ ...f.witness, outcome: "included" }),
    (f) => f.insertWitness({ ...f.witness, projection: "tool-execution" }),
    (f) => f.insertWitness({ ...f.witness, decisionId: "another-decision" }),
    (f) => f.insertWitness({ ...f.witness, extra: true }),
    (f) => f.insertWitness(f.witness, "principal-owner-1", "r", "2000-01-01T00:00:00.000Z"),
    (f) => {
      f.insertWitness();
      f.db.exec(
        "UPDATE authorization_decisions_all SET delivery_source='content_source' WHERE id='filtered-read'",
      );
    },
  ];
  for (const change of cases) {
    const f = filteredSourceFixture();
    t.after(() => f.db.close());
    change(f);
    assert.throws(() => caseEvidence(f.db, f.c, f.config), { code: "AUTHORIZATION_EVIDENCE" });
  }
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

function boundMessageFixture({
  driverReplyRealSequence = "555",
  driverReplyText,
  botTimeOffset = 0,
  driverTimeOffset = 0,
  botReplyTimeOffset = botTimeOffset,
  driverReplyTimeOffset = driverTimeOffset,
} = {}) {
  const inputText = "private test prompt with hidden input text";
  const replyText = driverReplyText ?? "reply with nonce-expected and 42";
  const time = Math.floor(Date.now() / 1000);
  const common = (messageId, senderId, text, realSequence, timeOffset) => ({
    message_id: messageId,
    real_seq: realSequence,
    time: time + timeOffset,
    message_type: "group",
    group_id: "20001",
    user_id: senderId,
    sender: { user_id: senderId },
    message: [{ type: "text", data: { text } }],
  });
  const botMessages = new Map([
    ["447318472", common("447318472", "10001", inputText, "554", botTimeOffset)],
    ["2300000001", common("2300000001", "10002", replyText, "555", botReplyTimeOffset)],
  ]);
  const driverMessages = new Map([
    ["2102070094", common("2102070094", "10001", inputText, "554", driverTimeOffset)],
    [
      "2300000002",
      common("2300000002", "10002", replyText, driverReplyRealSequence, driverReplyTimeOffset),
    ],
  ]);
  const c = {
    sentMessageId: "2102070094",
    prompt: inputText,
    inputBinding: {
      driverMessageId: "2102070094",
      botMessageId: "447318472",
      realSequence: "554",
      time: time + botTimeOffset,
      driverTime: time + driverTimeOffset,
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

test("two account-local ID pairs preserve distinct actual times without retaining text", async () => {
  const fixture = boundMessageFixture({ botTimeOffset: 1, driverTimeOffset: 0 });
  const evidence = await verifyMessageBindings(
    fixture.c,
    fixture.config,
    fixture.clients,
    fixture.delivery,
  );
  assert.deepEqual(evidence.input, {
    realSequence: "554",
    time: fixture.c.inputBinding.time,
    driverTime: fixture.c.inputBinding.driverTime,
    textSha256: fixture.c.inputBinding.textSha256,
  });
  assert.equal(evidence.reply.realSequence, "555");
  assert.equal(evidence.reply.driverTime, fixture.c.inputBinding.driverTime);
  assert.equal(evidence.reply.botMessageId, String(fixture.delivery.external_id));
  assert.equal(evidence.reply.driverMessageId, fixture.c.replies[0].messageId);
  assert.equal(JSON.stringify(evidence).includes(fixture.inputText), false);
  assert.equal(JSON.stringify(evidence).includes(fixture.replyText), false);
});

test("legacy single-time binding survives only equal independently read account times", async () => {
  const equal = boundMessageFixture();
  delete equal.c.inputBinding.driverTime;
  const evidence = await verifyMessageBindings(
    equal.c,
    equal.config,
    equal.clients,
    equal.delivery,
  );
  assert.equal(evidence.input.driverTime, equal.c.inputBinding.time);

  const unequal = boundMessageFixture({ botTimeOffset: 1, driverTimeOffset: 0 });
  delete unequal.c.inputBinding.driverTime;
  await assert.rejects(
    verifyMessageBindings(unequal.c, unequal.config, unequal.clients, unequal.delivery),
    { code: "MESSAGE_BINDING_MISMATCH" },
  );
});

test("either account time change breaks its exact input binding", async () => {
  for (const [role, messageId] of [
    ["bot", "447318472"],
    ["driver", "2102070094"],
  ]) {
    const fixture = boundMessageFixture({ botTimeOffset: 1, driverTimeOffset: 0 });
    const message = fixture.clients[role];
    const call = message.call.bind(message);
    message.call = async (action, params) => {
      const result = await call(action, params);
      if (params.message_id === messageId) result.time += 1;
      return result;
    };
    await assert.rejects(
      verifyMessageBindings(fixture.c, fixture.config, fixture.clients, fixture.delivery),
      { code: "MESSAGE_BINDING_MISMATCH" },
    );
  }
});

test("reply time must follow input time on each same account independently", async () => {
  for (const offsets of [
    { botTimeOffset: 0, driverTimeOffset: 2, botReplyTimeOffset: 1, driverReplyTimeOffset: 1 },
    { botTimeOffset: 2, driverTimeOffset: 0, botReplyTimeOffset: 1, driverReplyTimeOffset: 1 },
  ]) {
    const fixture = boundMessageFixture(offsets);
    await assert.rejects(
      verifyMessageBindings(fixture.c, fixture.config, fixture.clients, fixture.delivery),
      { code: "MESSAGE_BINDING_MISMATCH" },
    );
  }
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

function lockedDatabaseWorker(databasePath, releaseAfterReadMs) {
  const source = `
    const { parentPort, workerData } = require("node:worker_threads");
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(workerData.databasePath);
    db.exec("BEGIN EXCLUSIVE");
    parentPort.postMessage("locked");
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      db.exec("ROLLBACK");
      db.close();
      parentPort.postMessage("released");
    };
    parentPort.on("message", (message) => {
      if (message === "release") release();
      if (message === "start-read" && workerData.releaseAfterReadMs !== null)
        setTimeout(release, workerData.releaseAfterReadMs);
    });
  `;
  return new Worker(source, {
    eval: true,
    workerData: { databasePath, releaseAfterReadMs },
  });
}

function workerMessage(worker, expected) {
  return new Promise((resolveMessage, reject) => {
    const onMessage = (message) => {
      if (message !== expected) return;
      worker.off("message", onMessage);
      worker.off("error", onError);
      resolveMessage();
    };
    const onError = (error) => {
      worker.off("message", onMessage);
      reject(error);
    };
    worker.on("message", onMessage);
    worker.once("error", onError);
  });
}

function lockedDbFixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "qq-evidence-readonly-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const databasePath = join(directory, "glassbox.db");
  const db = new DatabaseSync(databasePath);
  db.exec("PRAGMA journal_mode=DELETE; PRAGMA user_version=29");
  db.close();
  return databasePath;
}

test("product evidence readonly database waits for a transient exclusive SQLite lock", async (t) => {
  const databasePath = lockedDbFixture(t);
  const worker = lockedDatabaseWorker(databasePath, 250);
  t.after(async () => worker.terminate());
  await workerMessage(worker, "locked");
  const released = workerMessage(worker, "released");
  const originalPrepare = DatabaseSync.prototype.prepare;
  DatabaseSync.prototype.prepare = function (sql, ...args) {
    if (sql === "PRAGMA user_version") worker.postMessage("start-read");
    return originalPrepare.call(this, sql, ...args);
  };
  const startedAt = Date.now();
  let db;
  let elapsedMs;
  try {
    db = openProductEvidenceDatabase(databasePath);
    assert.equal(db.prepare("PRAGMA user_version").get().user_version, 29);
    elapsedMs = Date.now() - startedAt;
  } finally {
    DatabaseSync.prototype.prepare = originalPrepare;
    db?.close();
  }
  await released;
  assert.ok(elapsedMs >= 100, `SQLite read returned before lock release (${elapsedMs}ms)`);
});

test("product evidence readonly database fails closed after its bounded busy timeout", async (t) => {
  const databasePath = lockedDbFixture(t);
  const worker = lockedDatabaseWorker(databasePath, null);
  let releasedByTest = false;
  t.after(async () => {
    if (!releasedByTest) worker.postMessage("release");
    await worker.terminate();
  });
  await workerMessage(worker, "locked");
  const released = workerMessage(worker, "released");
  const originalPrepare = DatabaseSync.prototype.prepare;
  DatabaseSync.prototype.prepare = function (sql, ...args) {
    if (sql === "PRAGMA user_version") worker.postMessage("start-read");
    return originalPrepare.call(this, sql, ...args);
  };
  const startedAt = Date.now();
  try {
    const db = openProductEvidenceDatabase(databasePath);
    assert.throws(
      () => db.prepare("PRAGMA user_version").get(),
      (error) => error?.code === "ERR_SQLITE_ERROR" && /locked/u.test(error.message),
    );
    db.close();
  } finally {
    DatabaseSync.prototype.prepare = originalPrepare;
  }
  const elapsedMs = Date.now() - startedAt;
  assert.ok(
    elapsedMs >= 4500,
    `SQLite read failed before the 5000 ms busy timeout (${elapsedMs}ms)`,
  );
  worker.postMessage("release");
  await released;
  releasedByTest = true;
});

test("product evidence database helper opens readonly and does not change the database", (t) => {
  const databasePath = lockedDbFixture(t);
  const db = openProductEvidenceDatabase(databasePath);
  assert.equal(db.prepare("PRAGMA user_version").get().user_version, 29);
  assert.throws(
    () => db.exec("PRAGMA user_version = 30"),
    (error) => error?.code === "ERR_SQLITE_ERROR" && /readonly/u.test(error.message),
  );
  db.close();
  const verification = new DatabaseSync(databasePath, { readOnly: true });
  assert.equal(verification.prepare("PRAGMA user_version").get().user_version, 29);
  verification.close();
});

test("capability discovery receipts use the production tool-definition resource kind", (t) => {
  const f = projectionReceiptFixture();
  t.after(() => f.db.close());
  f.db.exec(
    "UPDATE resources SET id='tool:qq_group_local_settings',kind='tool-definition'; UPDATE authorization_decisions_all SET action='tool:discover',resource_id='tool:qq_group_local_settings' WHERE id='projection-deny'; DELETE FROM ops_trace_events",
  );
  const receipt = {
    ...f.receipt,
    kind: "capability_search",
    purpose: "capability_search_availability",
    toolName: "qq_capability_search",
    decisions: [
      {
        decisionId: "projection-deny",
        action: "tool:discover",
        resourceId: "tool:qq_group_local_settings",
        purpose: "capability_tool_discovery_availability",
      },
    ],
  };
  f.insertReceipt(receipt);
  const evidence = caseEvidence(f.db, f.c, f.config);
  assert.equal(evidence.authorizationProjectionReceipts.length, 1);
  assert.equal(evidence.decisions.find((row) => row.id === "projection-deny").decision, "DENY");
  verifyAuthorizationProjectionTrace(
    projectionTrace(evidence.authorizationProjectionReceipts[0]),
    evidence.runId,
    evidence.principalId,
    evidence.authorizationProjectionReceipts,
  );
  for (const kind of ["tool", "qq_group", "memory"]) {
    f.db.prepare("UPDATE resources SET kind=?").run(kind);
    assert.throws(() => caseEvidence(f.db, f.c, f.config), { code: "AUTHORIZATION_EVIDENCE" });
  }
});
