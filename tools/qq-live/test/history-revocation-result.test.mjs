import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { historyInputDigest } from "../lib/history-input-evidence.mjs";
import { captureGroupPolicyState } from "../lib/group-policy-state.mjs";
import { observeHistoryRevocationResult } from "../lib/history-revocation-result.mjs";
import { verifyGroupPolicyHistoryStep } from "../lib/group-policy-step-verifier.mjs";
import { groupPolicyStep } from "../lib/group-policy-scenario.mjs";
import { toolManifestDigest } from "../lib/core.mjs";

const config = {
  bot: { qq: "10001" },
  driver: { qq: "20002" },
  groups: [
    { alias: "A", id: "30003" },
    { alias: "B", id: "40004" },
  ],
  runtime: { connectionId: "fixture-connection", threadId: null },
};
const scopeKey = JSON.stringify(["fixture-connection", "10001", "private", "20002", "20002", null]);
const principalId = "owner-fixture";
const runId = "owner-history-revocation";
const query = "a1b2c3d4e5f60718293a4b5c6d7e8f90";
const actualQuery = `gbxhistory1-${query}`;
const at = (seconds) => new Date(seconds * 1000).toISOString();
const policy = {
  categories: { "group.history": true, "group.read": true },
  memorySources: { history: true, notice: true },
  webCapabilities: {},
};

function fixture(t) {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  db.exec(`
    CREATE TABLE principals(id TEXT PRIMARY KEY,kind TEXT NOT NULL);
    CREATE TABLE channel_identities(identity_key TEXT,principal_id TEXT);
    CREATE TABLE resources(id TEXT PRIMARY KEY);
    CREATE TABLE grants(id TEXT PRIMARY KEY,principal_id TEXT,resource_id TEXT,action TEXT,scope_key TEXT,effect TEXT,revoked_at TEXT,created_at TEXT);
    CREATE TABLE group_capability_policies(connection_id TEXT,group_id TEXT,policy_json TEXT,version INTEGER,updated_by_principal_id TEXT,updated_at TEXT);
    CREATE TABLE runs(id TEXT PRIMARY KEY,principal_id TEXT,conversation_id TEXT,scope_json TEXT,status TEXT);
    CREATE TABLE authorization_decisions(id TEXT PRIMARY KEY,principal_id TEXT,resource_id TEXT,action TEXT,scope_key TEXT,decision TEXT,run_id TEXT);
    CREATE TABLE authorization_decisions_archive(id TEXT PRIMARY KEY,principal_id TEXT,resource_id TEXT,action TEXT,scope_key TEXT,decision TEXT,run_id TEXT);
    CREATE VIEW authorization_decisions_all AS SELECT * FROM authorization_decisions UNION ALL SELECT * FROM authorization_decisions_archive;
  `);
  db.prepare("INSERT INTO principals VALUES (?, 'owner')").run(principalId);
  db.prepare("INSERT INTO channel_identities VALUES (?,?)").run(
    JSON.stringify([config.runtime.connectionId, config.bot.qq, config.driver.qq]),
    principalId,
  );
  for (const resource of ["owner-control", "group:30003", "group:40004"]) {
    db.prepare("INSERT INTO resources VALUES (?)").run(resource);
    db.prepare("INSERT INTO grants VALUES (?,?,?,'group:manage',?,'allow',NULL,?)").run(
      `manage-${resource}`,
      principalId,
      resource,
      scopeKey,
      "2026-10-07T00:00:00.000Z",
    );
  }
  for (const groupId of ["30003", "40004"]) {
    db.prepare("INSERT INTO group_capability_policies VALUES (?,?,?,?,?,?)").run(
      config.runtime.connectionId,
      groupId,
      JSON.stringify(policy),
      1,
      principalId,
      "2026-10-07T00:00:00.000Z",
    );
  }
  db.prepare("INSERT INTO grants VALUES ('history-B',?,?, 'history:read',?,'allow',NULL,?)").run(
    principalId,
    "group:40004",
    scopeKey,
    "2026-10-07T00:00:00.000Z",
  );
  const before = captureGroupPolicyState(db, config);
  const disabledPolicy = structuredClone(policy);
  disabledPolicy.categories["group.history"] = false;
  disabledPolicy.memorySources.history = false;
  db.prepare(
    "UPDATE group_capability_policies SET policy_json=?,version=2,updated_at=? WHERE group_id='40004'",
  ).run(JSON.stringify(disabledPolicy), "2026-10-07T00:00:02.000Z");
  db.prepare("UPDATE grants SET revoked_at=? WHERE id='history-B'").run("2026-10-07T00:00:02.000Z");
  const disabled = captureGroupPolicyState(db, config, { originalHistoryGrantId: "history-B" });

  db.prepare("INSERT INTO runs VALUES (?,?,?,?,?)").run(
    runId,
    principalId,
    "conversation-owner",
    JSON.stringify({
      connectionId: config.runtime.connectionId,
      botId: config.bot.qq,
      chatType: "private",
      chatId: config.driver.qq,
      senderId: config.driver.qq,
      threadId: null,
    }),
    "succeeded",
  );
  db.prepare("INSERT INTO authorization_decisions VALUES (?,?,?,?,?,'ALLOW',?)").run(
    "decision-history-search",
    principalId,
    "owner-history",
    "history:search",
    scopeKey,
    runId,
  );

  const output = JSON.stringify({ content: [{ type: "text", text: "omitted" }], details: {} });
  const outputSha256 = createHash("sha256").update(output, "utf8").digest("hex");
  const outputBytes = Buffer.byteLength(output, "utf8");
  const events = [
    {
      type: "tool_call",
      sessionId: "session-1",
      timestamp: at(1_800_000_001),
      runId,
      principalId,
      toolCallId: "call-history-1",
      data: {
        runId,
        principalId,
        toolCallId: "call-history-1",
        name: "owner_history_search",
        ...historyInputDigest({ query: actualQuery, groupIds: ["40004"], limit: 1 }),
      },
    },
    {
      type: "history_retrieval",
      runId,
      principalId,
      conversationId: "conversation-owner",
      query: actualQuery,
      groups: [],
      resources: [],
      sourceKind: "channel_message",
      retrievalMode: "lexical",
      resultStatus: "no_matches_in_searched_window",
      toolOutput: { sha256: outputSha256, bytes: outputBytes },
      considered: 0,
      truncated: false,
      coverage: {
        requestedLimit: 1,
        returned: 0,
        considered: 0,
        truncated: false,
        truncationReasons: [],
        perSourceCap: null,
        exactTerms: [actualQuery],
        droppedByExactTerm: 0,
        coverage: "unknown",
        groupsSearched: 0,
        sourceLimits: [],
        sourceCoverage: [],
        observedAt: at(1_800_000_002),
      },
      items: [],
    },
    {
      type: "tool_result",
      sessionId: "session-1",
      timestamp: at(1_800_000_003),
      runId,
      principalId,
      toolCallId: "call-history-1",
      data: {
        runId,
        principalId,
        toolCallId: "call-history-1",
        name: "owner_history_search",
        isError: false,
        outputBytes,
        outputSha256,
      },
    },
  ];
  return { db, before, disabled, events };
}

const assertion = { kind: "history_revocation_result", groupId: "40004", query };
function observe(f, input = assertion) {
  return observeHistoryRevocationResult(input, {
    db: f.db,
    config,
    before: f.before,
    disabled: f.disabled,
    events: f.events,
    runId,
  });
}
function rejects(f, input = assertion) {
  assert.throws(
    () => observe(f, input),
    (error) => error.code === "HISTORY_REVOCATION_RESULT" && error.status === "INCONCLUSIVE",
  );
}

test("proves only a zero-source Owner-private search after captured Group B disable", (t) => {
  const f = fixture(t);
  assert.deepEqual(observe(f), {
    kind: "history_revocation_result",
    status: "PASS",
    requestedGroupExcluded: true,
    sourcesSearched: 0,
    coverage: "unknown",
    resultWindow: "no_sources_searched",
    resultStatus: "no_matches_in_searched_window",
    toolOutputVerified: true,
    sourceEvidenceVerified: true,
    absenceVerified: false,
    actualQqDeliveryVerified: false,
  });
});

test("rejects malformed assertion, wrong configured group, active B grant or policy drift", (t) => {
  const f = fixture(t);
  rejects(f, { ...assertion, query: query.toUpperCase() });
  rejects(f, { ...assertion, groupId: "30003" });
  const rawNonceQuery = fixture(t);
  rawNonceQuery.events[1].query = query;
  rejects(rawNonceQuery);
  const activeGrant = fixture(t);
  activeGrant.db
    .prepare("INSERT INTO grants VALUES ('history-B-again',?,?, 'history:read',?,'allow',NULL,?)")
    .run(principalId, "group:40004", scopeKey, "2026-10-07T00:00:04.000Z");
  rejects(activeGrant);
  const policyDrift = fixture(t);
  policyDrift.db
    .prepare("UPDATE group_capability_policies SET policy_json=? WHERE group_id='40004'")
    .run(JSON.stringify(policy));
  rejects(policyDrift);
});

test("rejects imported snapshots and an invalid transition", (t) => {
  const f = fixture(t);
  f.before = JSON.parse(JSON.stringify(f.before));
  rejects(f);
  const g = fixture(t);
  g.disabled.B.version++;
  rejects(g);
});

test("rejects wrong actual input digest and raw arguments", (t) => {
  for (const mutate of [
    (f) => (f.events[0].data.inputSha256 = "f".repeat(64)),
    (f) => (f.events[0].data.inputBytes += 1),
    (f) => (f.events[0].data.input = { query }),
    (f) => (f.events[0].data.name = "group_history_search"),
  ]) {
    const f = fixture(t);
    mutate(f);
    rejects(f);
  }
});

test("rejects mismatched Run, Principal, ToolCall, ordering, and leaked event fields", (t) => {
  for (const mutate of [
    (f) => (f.events[1].runId = "other-run"),
    (f) => (f.events[0].principalId = "other-owner"),
    (f) => (f.events[2].data.toolCallId = "other-call"),
    (f) => f.events.reverse(),
    (f) => (f.events[1].payload = "protected content"),
    (f) => (f.events[2].data.outputHead = "protected output"),
  ]) {
    const f = fixture(t);
    mutate(f);
    rejects(f);
  }
});

test("returns only a redacted FAIL for bound nonempty or searched-source results", (t) => {
  for (const mutate of [
    (f) => (f.events[1].groups = ["40004"]),
    (f) => (f.events[1].resources = ["group:40004"]),
    (f) => (f.events[1].items = [{ text: "protected" }]),
    (f) => (f.events[1].coverage.coverage = "complete"),
    (f) => (f.events[1].coverage.coverage = "partial"),
    (f) => (f.events[1].coverage.groupsSearched = 1),
    (f) => (f.events[1].coverage.sourceLimits = ["end_of_source"]),
    (f) => (f.events[1].coverage.sourceCoverage = [{ groupId: "40004" }]),
    (f) => (f.events[1].resultStatus = "matches_found"),
  ]) {
    const f = fixture(t);
    mutate(f);
    const result = observe(f);
    assert.equal(result.status, "FAIL");
    assert.equal(result.absenceVerified, false);
    assert.equal(result.actualQqDeliveryVerified, false);
    assert.equal(JSON.stringify(result).includes("protected"), false);
    assert.equal(JSON.stringify(result).includes(actualQuery), false);
  }
});

test("rejects output mismatches and noncanonical chronology", (t) => {
  for (const mutate of [
    (f) => (f.events[2].data.outputSha256 = "d".repeat(64)),
    (f) => (f.events[2].data.outputBytes += 1),
    (f) => (f.events[1].toolOutput.sha256 = "e".repeat(64)),
    (f) => (f.events[1].coverage.observedAt = "2026-10-07T00:00:02Z"),
    (f) => (f.events[0].timestamp = at(1_800_000_004)),
    (f) => (f.events[2].timestamp = at(1_800_000_001)),
  ]) {
    const f = fixture(t);
    mutate(f);
    rejects(f);
  }
});

test("returns no source absence claim and no protected output bytes or hashes", (t) => {
  const f = fixture(t);
  const evidence = observe(f);
  assert.equal(Object.hasOwn(evidence, "outputSha256"), false);
  assert.equal(Object.hasOwn(evidence, "outputBytes"), false);
  assert.equal(evidence.absenceVerified, false);
  assert.equal(evidence.actualQqDeliveryVerified, false);
});

test("step verifier binds actual private delivery, lease cleanup, disabled snapshot, and result", async (t) => {
  const f = fixture(t);
  const spec = groupPolicyStep("history-check", "40004");
  const token = query;
  const leasedTools = JSON.parse(JSON.stringify(spec.leaseTools).replaceAll("{{nonce}}", token));
  const transportCase = {
    id: spec.id,
    token,
    route: "private",
    status: "PASS",
    code: "REAL_REPLY_RECEIVED",
    prompt: `GLASSBOX_ACCEPTANCE_V1 ${token}\n${spec.prompt.replaceAll("{{nonce}}", token).trim()}`,
    expected: spec.expectContains.map((value) => value.replaceAll("{{nonce}}", token)),
    featureAssertions: JSON.parse(
      JSON.stringify(spec.featureAssertions).replaceAll("{{nonce}}", token),
    ),
    leasedToolNames: spec.leaseTools.map((tool) => tool.name),
    acceptanceLease: {
      leaseId: "12345678-1234-4234-9234-123456789abc",
      expiresAt: Date.parse("2026-10-07T00:05:00.000Z"),
      toolsSha256: toolManifestDigest(leasedTools),
    },
    startedAt: "2026-10-07T00:00:00.000Z",
    sendAttempted: true,
    inputObserved: true,
    leaseRegistrationAttempted: true,
    leaseRevoked: true,
    sentMessageId: "101",
    replies: [{ route: "private", matches: true, messageId: "102" }],
    anomalies: [],
  };
  const expectedRuntime = {
    checkout: "/fixture/checkout",
    dataDirectory: "/fixture/data",
    commit: "a".repeat(40),
    pid: 123,
    connectionId: config.runtime.connectionId,
  };
  const readOnlyDb = {
    prepare: (...args) => f.db.prepare(...args),
    exec: (...args) => f.db.exec(...args),
    close: () => {},
  };
  const proof = await verifyGroupPolicyHistoryStep(
    {
      config,
      clients: { driver: {}, bot: {} },
      expectedRuntime,
      stage: "history-check",
      spec,
      result: { transportCase },
      before: f.before,
      disabled: f.disabled,
      after: f.disabled,
    },
    {
      runtimeSnapshot: async () => expectedRuntime,
      openReadOnlyDatabase: () => readOnlyDb,
      verifyCaseWithLeaseCleanup: async (_db, _directory, _case, _config, verify) => ({
        cleanupVerified: true,
        result: await verify({ runId, delivery: { id: "delivery-1" } }),
      }),
      verifyMessageBindings: async () => ({ inputMessageId: "100", replyMessageId: "102" }),
      readGroupPolicyTraceEvents: () => ({ events: f.events.map((event) => ({ event })) }),
      verifyTraceEvidence: () => {},
      verifyLeaseTraceEvidence: () => {},
      captureGroupPolicyState: (_db, cfg, options) => captureGroupPolicyState(f.db, cfg, options),
    },
  );
  assert.equal(proof.status, "HISTORY_REVOCATION_RESULT_VERIFIED");
  assert.equal(proof.stage, "history-check");
  assert.equal(proof.cleanupVerified, true);
  assert.equal(proof.actualQqDeliveryVerified, true);
  assert.equal(proof.absenceVerified, false);
  assert.equal(proof.stateProof.originalPolicyRestored, false);
});
