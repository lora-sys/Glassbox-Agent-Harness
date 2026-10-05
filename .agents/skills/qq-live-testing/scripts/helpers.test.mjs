import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, cp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { verifyCore } from "./verify-core.mjs";
import { appendLesson, validateLesson } from "./record-lesson.mjs";
import { memoryFixtureStep } from "../../../../tools/qq-live/lib/memory-scenario.mjs";
import { toolManifestDigest } from "../../../../tools/qq-live/lib/core.mjs";
import { MEMORY_REJECT_FAMILY_ID } from "../../../../tools/qq-live/lib/memory-workflow.mjs";
import { historySnippet } from "../../../../tools/qq-live/lib/history-result.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const hypothesis = {
  case: "group-A.reply",
  commit: "a".repeat(40),
  status: "hypothesis",
  evidence: { type: "run", runId: "run_abc123" },
  symptom: "Reply did not arrive in the expected group.",
  lesson: "The service was running from a different checkout.",
  nextStep: "Verify the active checkout before correlating the Run.",
};

function hash(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function createPassingReport(t, overrides = {}) {
  const temp = await mkdtemp(join(tmpdir(), "qq-live-report-"));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const commit = hypothesis.commit;
  const runId = "run_abc123";
  const runtime = {
    checkout: resolve(here, "../../../.."),
    dataDirectory: join(temp, "data"),
    commit,
    pid: 4321,
    connectionId: "fixture-connection",
    threadId: null,
  };
  const reportDirectory = join(temp, "reports", "report-fixture");
  const scope = {
    connectionId: runtime.connectionId,
    botId: "10002",
    chatType: "group",
    chatId: "20001",
    senderId: "10001",
    threadId: null,
  };
  const reportPath = join(reportDirectory, "report.json");
  const prompt = "Ordinary fixture prompt with a unique marker.";
  const promptHash = hash(Buffer.from(prompt, "utf8"));
  const report = {
    schemaVersion: 1,
    toolVersion: "0.1.0",
    runId: "test_fixture_1",
    mode: "run",
    startedAt: "2026-10-05T00:00:00.000Z",
    finishedAt: "2026-10-05T00:00:01.000Z",
    reportDirectory,
    suiteSha256: "b".repeat(64),
    status: "PASS",
    workspace: { commit, dirty: false },
    runtime,
    cases: [
      {
        id: hypothesis.case,
        route: "20001",
        status: "PASS",
        prompt,
        sentMessageId: "driver-input-1",
        inputBinding: {
          botMessageId: "bot-input-1",
          driverMessageId: "driver-input-1",
          realSequence: "101",
          time: 1791158400000,
          textSha256: promptHash,
        },
      },
    ],
    productAcceptance: {
      status: "PASS",
      runtime: { ...runtime },
      cases: [
        {
          caseId: hypothesis.case,
          runId,
          scope,
          decisions: [{ decision: "ALLOW" }],
          delivery: { id: "delivery-1", status: "sent", external_id: "-12345" },
          traceVerified: true,
          messageBinding: {
            input: { realSequence: "101", time: 1791158400000, textSha256: promptHash },
            reply: { realSequence: "102", time: 1791158401000, textSha256: "d".repeat(64) },
          },
        },
      ],
    },
    ...overrides,
  };
  const tracePath = join(runtime.dataDirectory, "runs", runId, "trace.jsonl");
  await mkdir(dirname(tracePath), { recursive: true });
  await writeFile(
    tracePath,
    [
      JSON.stringify({
        seq: 1,
        event: {
          type: "message_received",
          externalId: "bot-input-1",
          textSha256: promptHash,
          ...scope,
        },
      }),
      JSON.stringify({
        seq: 2,
        event: {
          type: "delivery_changed",
          deliveryId: "delivery-1",
          status: "sent",
          externalId: "-12345",
        },
      }),
    ].join("\n") + "\n",
    "utf8",
  );
  await mkdir(reportDirectory, { recursive: true });
  const bytes = Buffer.from(JSON.stringify(report));
  await writeFile(reportPath, bytes);
  const input = {
    ...hypothesis,
    status: "verified",
    verification: { type: "qq_live_report", reportPath, reportSha256: hash(bytes) },
  };
  return { input, reportPath, bytes, temp };
}

async function createPassingOwnerPrivateOpsReport(t, { otherRunMemberTrace = false } = {}) {
  const fixture = await createPassingReport(t);
  const report = JSON.parse(fixture.bytes.toString("utf8"));
  const runId = fixture.input.evidence.runId;
  const caseRecord = report.cases[0];
  const accepted = report.productAcceptance.cases[0];
  const prompt = "Owner private Ops status check for the acceptance fixture.";
  const promptHash = hash(Buffer.from(prompt, "utf8"));
  caseRecord.id = "ops-status-read";
  caseRecord.route = "private";
  caseRecord.prompt = prompt;
  caseRecord.inputBinding.textSha256 = promptHash;
  accepted.caseId = caseRecord.id;
  accepted.scope.chatType = "private";
  accepted.scope.chatId = accepted.scope.senderId;
  accepted.messageBinding.input.textSha256 = promptHash;

  const tracePath = join(report.runtime.dataDirectory, "runs", runId, "trace.jsonl");
  const rows = (await readFile(tracePath, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const events = rows.map((row) => row.event);
  const input = events.find((event) => event.type === "message_received");
  Object.assign(input, accepted.scope, { textSha256: promptHash });
  events.push(
    {
      type: "session_start",
      runId,
      data: { authorizedTools: ["ops_status", "qq_group_members"] },
    },
    { type: "tool_call", runId, toolCallId: "ops-call", data: { name: "ops_status" } },
    {
      type: "tool_result",
      runId,
      toolCallId: "ops-call",
      data: { name: "ops_status", isError: false },
    },
  );
  if (otherRunMemberTrace) {
    const otherRunId = "run_other123";
    events.push(
      {
        type: "tool_call",
        runId: otherRunId,
        toolCallId: "other-member-call",
        data: { name: "qq_group_members" },
      },
      {
        type: "tool_result",
        runId: otherRunId,
        toolCallId: "other-member-call",
        data: { name: "qq_group_members", isError: false },
      },
    );
  }
  await writeFile(
    tracePath,
    events.map((event, seq) => JSON.stringify({ seq: seq + 1, event })).join("\n") + "\n",
    "utf8",
  );
  const bytes = Buffer.from(JSON.stringify(report));
  await writeFile(fixture.reportPath, bytes);
  return {
    ...fixture,
    bytes,
    input: {
      ...fixture.input,
      case: caseRecord.id,
      verification: { ...fixture.input.verification, reportSha256: hash(bytes) },
    },
  };
}

async function createPassingFeatureReport(t, update = () => {}) {
  const fixture = await createPassingReport(t);
  const report = JSON.parse(fixture.bytes.toString("utf8"));
  const runId = fixture.input.evidence.runId;
  const marker = "f".repeat(32);
  const lease = { leaseId: "lease-fixture", toolsSha256: "e".repeat(64) };
  const assertions = [
    { kind: "trace", type: "tool_result", where: { name: "ops_status", isError: false }, count: 1 },
    { kind: "state", resource: "task", id: "task_fixture", status: "NEW" },
  ];
  const caseRecord = report.cases[0];
  Object.assign(caseRecord, {
    route: "20001",
    token: marker,
    acceptanceLease: lease,
    leasedToolNames: ["ops_status"],
    leaseRegistrationAttempted: true,
    leaseRevoked: true,
    featureAssertions: assertions,
  });
  const accepted = report.productAcceptance.cases[0];
  accepted.feature = {
    status: "PASS",
    runId,
    observations: [
      { kind: "trace", type: "tool_result", count: 1 },
      { kind: "state", resource: "task", id: "task_fixture", status: "NEW" },
    ],
  };

  const dbPath = join(report.runtime.dataDirectory, "glassbox.db");
  await mkdir(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec("CREATE TABLE tasks(id TEXT, status TEXT, run_id TEXT)");
  db.prepare("INSERT INTO tasks VALUES (?,?,?)").run("task_fixture", "NEW", runId);
  db.close();

  const scope = accepted.scope;
  const events = [
    {
      type: "message_received",
      externalId: "bot-input-1",
      textSha256: caseRecord.inputBinding.textSha256,
      ...scope,
    },
    { type: "delivery_changed", deliveryId: "delivery-1", status: "sent", externalId: "-12345" },
    {
      type: "session_start",
      runId,
      data: {
        acceptanceLease: { ...lease, marker, narrowedTools: ["ops_status"] },
        authorizedTools: ["ops_status"],
      },
    },
    { type: "tool_call", runId, toolCallId: "call-fixture", data: { name: "ops_status" } },
    {
      type: "tool_result",
      runId,
      toolCallId: "call-fixture",
      data: { name: "ops_status", isError: false },
    },
  ];
  update(report, events);
  const tracePath = join(report.runtime.dataDirectory, "runs", runId, "trace.jsonl");
  await writeFile(
    tracePath,
    events.map((event, seq) => JSON.stringify({ seq: seq + 1, event })).join("\n") + "\n",
    "utf8",
  );
  const bytes = Buffer.from(JSON.stringify(report));
  await writeFile(fixture.reportPath, bytes);
  return {
    ...fixture,
    bytes,
    input: {
      ...fixture.input,
      verification: { ...fixture.input.verification, reportSha256: hash(bytes) },
    },
  };
}

async function createPassingCompleteHistoryReport(t, caseId) {
  const fixture = await createPassingFeatureReport(t);
  const report = JSON.parse(fixture.bytes.toString("utf8"));
  const runId = fixture.input.evidence.runId;
  const token = "a".repeat(32);
  const currentGroup = caseId === "history-current-group-complete";
  const toolName = currentGroup ? "group_history_search" : "owner_history_search";
  const groupId = "20001";
  const caseRecord = report.cases[0];
  const accepted = report.productAcceptance.cases[0];
  const prompt = `GLASSBOX_ACCEPTANCE_V1 ${token}\nSearch the fixed group history for the current test marker.`;
  const promptHash = hash(Buffer.from(prompt, "utf8"));
  const input = currentGroup
    ? { query: token, limit: 1 }
    : { query: token, groupIds: [groupId], limit: 1 };
  const tools = [
    {
      name: toolName,
      operations: [
        {
          action: currentGroup ? "history:read" : "history:search",
          resourceId: currentGroup ? `group:${groupId}` : "owner-history",
          inputConstraint: input,
        },
      ],
    },
  ];
  Object.assign(caseRecord, {
    id: caseId,
    route: currentGroup ? groupId : "private",
    token,
    prompt,
    expected: [token],
    inputBinding: { ...caseRecord.inputBinding, textSha256: promptHash },
    acceptanceLease: { leaseId: "lease-fixture", toolsSha256: toolManifestDigest(tools) },
    leasedToolNames: [toolName],
    leaseRegistrationAttempted: true,
    leaseRevoked: true,
  });
  caseRecord.featureAssertions = [
    { kind: "trace", type: "tool_result", where: { name: toolName, isError: false }, count: 1 },
    {
      kind: "trace",
      type: "history_retrieval",
      where: {
        query: token,
        groups: [groupId],
        resources: [`group:${groupId}`],
        sourceKind: "channel_message",
        retrievalMode: "lexical",
      },
      count: 1,
    },
    { kind: "history_coverage", query: token, groupId, count: 1 },
  ];
  accepted.caseId = caseId;
  accepted.scope.chatType = currentGroup ? "group" : "private";
  accepted.scope.chatId = currentGroup ? groupId : accepted.scope.senderId;
  accepted.feature = {
    status: "PASS",
    runId,
    observations: [
      { kind: "trace", type: "tool_result", count: 1 },
      { kind: "trace", type: "history_retrieval", count: 1 },
      { kind: "history_coverage", coverage: "complete", returned: 0, sourceComplete: true },
    ],
  };
  accepted.messageBinding.input.textSha256 = promptHash;

  const tracePath = join(report.runtime.dataDirectory, "runs", runId, "trace.jsonl");
  const events = [
    {
      type: "message_received",
      runId,
      externalId: caseRecord.inputBinding.botMessageId,
      textSha256: promptHash,
      ...accepted.scope,
    },
    {
      type: "delivery_changed",
      runId,
      deliveryId: accepted.delivery.id,
      status: "sent",
      externalId: accepted.delivery.external_id,
    },
    {
      type: "session_start",
      runId,
      data: {
        acceptanceLease: {
          leaseId: "lease-fixture",
          toolsSha256: toolManifestDigest(tools),
          marker: token,
          narrowedTools: [toolName],
        },
        authorizedTools: [toolName],
      },
    },
    { type: "tool_call", runId, toolCallId: "history-call", data: { name: toolName, input } },
    {
      type: "tool_result",
      runId,
      toolCallId: "history-call",
      data: { name: toolName, isError: false },
    },
    {
      type: "history_retrieval",
      runId,
      query: token,
      groups: [groupId],
      resources: [`group:${groupId}`],
      sourceKind: "channel_message",
      retrievalMode: "lexical",
      considered: 0,
      droppedByExactTerm: 0,
      truncated: false,
      items: [],
      coverage: {
        coverage: "complete",
        requestedLimit: 1,
        groupsSearched: 1,
        perSourceCap: null,
        truncated: false,
        truncationReasons: [],
        sourceLimits: [],
        returned: 0,
        considered: 0,
        droppedByExactTerm: 0,
        exactTerms: [token],
        sourceCoverage: [
          {
            groupId,
            capped: false,
            returned: 0,
            considered: 0,
            sync: { stop: "end_of_source", pagesWalked: 1 },
          },
        ],
        observedAt: "2026-10-05T00:00:00.000Z",
      },
    },
  ];
  await writeFile(
    tracePath,
    events.map((event, seq) => JSON.stringify({ seq: seq + 1, event })).join("\n") + "\n",
    "utf8",
  );
  const bytes = Buffer.from(JSON.stringify(report));
  await writeFile(fixture.reportPath, bytes);
  return {
    ...fixture,
    report,
    events,
    input: {
      ...fixture.input,
      case: caseId,
      verification: { ...fixture.input.verification, reportSha256: hash(bytes) },
    },
  };
}

async function createPassingHistoryResultReport(t, caseId) {
  const hit = caseId === "history-current-group-hit";
  const baseCaseId = hit ? "history-current-group-complete" : "history-owner-group-a-complete";
  const fixture = await createPassingCompleteHistoryReport(t, baseCaseId);
  const report = structuredClone(fixture.report);
  const caseRecord = report.cases[0];
  const accepted = report.productAcceptance.cases[0];
  const runId = accepted.runId;
  const token = caseRecord.token;
  const groupId = "20001";
  const toolName = hit ? "group_history_search" : "owner_history_search";
  const result = hit ? "hit" : "no_match";
  const history = fixture.events.find((event) => event.type === "history_retrieval");
  const call = fixture.events.find((event) => event.type === "tool_call");
  const toolResult = fixture.events.find((event) => event.type === "tool_result");
  const output = "fixed protected history output";
  const outputSha256 = hash(Buffer.from(output, "utf8"));
  const outputBytes = Buffer.byteLength(output, "utf8");

  caseRecord.id = caseId;
  accepted.caseId = caseId;
  caseRecord.featureAssertions.push({
    kind: "history_result",
    tool: toolName,
    query: token,
    groupId,
    result,
    count: 1,
  });
  accepted.feature.observations.find((item) => item.kind === "history_coverage").returned = hit
    ? 1
    : 0;
  accepted.feature.observations.push({
    kind: "history_result",
    result,
    returned: hit ? 1 : 0,
    sourceVerified: true,
    toolOutputVerified: true,
  });
  const input = hit ? { query: token, limit: 1 } : { query: token, groupIds: [groupId], limit: 1 };
  call.data.name = toolName;
  call.data.input = input;
  toolResult.data.name = toolName;
  toolResult.data.outputSha256 = outputSha256;
  toolResult.data.outputBytes = outputBytes;
  history.resultStatus = hit ? "matches_found" : "no_matches_in_searched_window";
  history.toolOutput = { sha256: outputSha256, bytes: outputBytes };
  history.principalId = "owner-fixture";
  history.conversationId = "conversation-fixture";
  history.coverage.returned = hit ? 1 : 0;
  history.coverage.considered = hit ? 1 : 0;
  history.coverage.sourceCoverage[0].returned = hit ? 1 : 0;
  history.coverage.sourceCoverage[0].considered = hit ? 1 : 0;
  history.considered = hit ? 1 : 0;
  history.items = [];

  const db = new DatabaseSync(join(report.runtime.dataDirectory, "glassbox.db"));
  db.exec(`
    CREATE TABLE principals (id TEXT, kind TEXT);
    CREATE TABLE messages (id TEXT, external_id TEXT, scope_key TEXT);
    CREATE TABLE runs (
      id TEXT, principal_id TEXT, conversation_id TEXT, scope_json TEXT,
      status TEXT, message_id TEXT
    );
    CREATE TABLE channel_messages (
      id TEXT, channel TEXT, connection_id TEXT, group_id TEXT, resource_id TEXT,
      source_class TEXT, external_message_id TEXT, sender_id TEXT, occurred_at TEXT,
      occurred_at_ms INTEGER, normalized_text TEXT
    );
  `);
  const scope = accepted.scope;
  const scopeKey = JSON.stringify([
    scope.connectionId,
    scope.botId,
    scope.chatType,
    scope.chatId,
    scope.senderId,
    scope.threadId ?? null,
  ]);
  const externalId = String(caseRecord.inputBinding.botMessageId);
  db.prepare("INSERT INTO principals VALUES ('owner-fixture','owner')").run();
  db.prepare("INSERT INTO messages VALUES ('history-input',?,?)").run(externalId, scopeKey);
  db.prepare("INSERT INTO runs VALUES (?,?,?,?,?,?)").run(
    runId,
    "owner-fixture",
    "conversation-fixture",
    JSON.stringify(scope),
    "succeeded",
    "history-input",
  );
  if (hit) {
    const recordId = "11111111-1111-4111-8111-111111111111";
    const occurredAt = "2026-10-05T00:00:00.000Z";
    const text = `test ${token} ${"x".repeat(300)}`;
    const snippet = historySnippet(text, token);
    db.prepare("INSERT INTO channel_messages VALUES (?,?,?,?,?,?,?,?,?,?,?)").run(
      recordId,
      "qq-onebot",
      scope.connectionId,
      groupId,
      `group:${groupId}`,
      "history",
      externalId,
      scope.senderId,
      occurredAt,
      Date.parse(occurredAt),
      text,
    );
    history.items = [
      {
        resourceId: `group:${groupId}`,
        sourceId: groupId,
        rank: 1,
        score: 1,
        matchedTerms: [token],
        returnMode: "raw",
        recordId,
        textSha256: hash(Buffer.from(snippet, "utf8")),
        textBytes: Buffer.byteLength(snippet, "utf8"),
        occurredAt,
        senderId: scope.senderId,
      },
    ];
  }
  db.close();

  const tracePath = join(report.runtime.dataDirectory, "runs", runId, "trace.jsonl");
  await writeFile(
    tracePath,
    fixture.events.map((event, seq) => JSON.stringify({ seq: seq + 1, event })).join("\n") + "\n",
    "utf8",
  );
  const bytes = Buffer.from(JSON.stringify(report));
  await writeFile(fixture.reportPath, bytes);
  return {
    ...fixture,
    report,
    input: {
      ...fixture.input,
      case: caseId,
      evidence: { type: "run", runId },
      verification: { ...fixture.input.verification, reportSha256: hash(bytes) },
    },
  };
}

async function createPassingGroupMemberReport(t, { aggregateAssertion = true } = {}) {
  const fixture = await createPassingFeatureReport(t);
  const report = JSON.parse(fixture.bytes.toString("utf8"));
  const runId = fixture.input.evidence.runId;
  const caseRecord = report.cases[0];
  const accepted = report.productAcceptance.cases[0];
  const prompt = "Read only the member count for test group A and report the number.";
  const promptHash = hash(Buffer.from(prompt, "utf8"));
  caseRecord.id = "qq-group-member-directory-read";
  caseRecord.prompt = prompt;
  caseRecord.inputBinding.textSha256 = promptHash;
  accepted.caseId = caseRecord.id;
  accepted.messageBinding.input.textSha256 = promptHash;
  caseRecord.leasedToolNames = ["qq_group_members"];
  caseRecord.featureAssertions = [
    {
      kind: "trace",
      type: "tool_result",
      where: { name: "qq_group_members", isError: false },
      count: 1,
    },
    ...(aggregateAssertion
      ? [{ kind: "aggregate_projection", tool: "qq_group_members", count: 1 }]
      : []),
  ];

  const tracePath = join(report.runtime.dataDirectory, "runs", runId, "trace.jsonl");
  const rows = (await readFile(tracePath, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const events = rows.map((row) => row.event);
  const session = events.find((event) => event.type === "session_start");
  session.data.acceptanceLease.narrowedTools = ["qq_group_members"];
  session.data.authorizedTools = ["qq_group_members"];
  const call = events.find((event) => event.type === "tool_call");
  call.data.name = "qq_group_members";
  const result = events.find((event) => event.type === "tool_result");
  result.data.name = "qq_group_members";
  const outputHead = JSON.stringify({
    content: [{ type: "text", text: '{"memberCount":0}' }],
    details: { memberCount: 0 },
  });
  Object.assign(result.data, {
    outputHead,
    outputBytes: Buffer.byteLength(outputHead, "utf8"),
    outputSha256: hash(Buffer.from(outputHead, "utf8")),
    outputTruncated: false,
  });
  events.find((event) => event.type === "message_received").textSha256 = promptHash;
  accepted.feature = {
    status: "PASS",
    runId,
    observations: [
      { kind: "trace", type: "tool_result", count: 1 },
      ...(aggregateAssertion
        ? [
            {
              kind: "aggregate_projection",
              tool: "qq_group_members",
              memberCount: 0,
              identifiersExposed: false,
            },
          ]
        : []),
    ],
  };
  await writeFile(tracePath, rows.map((row) => JSON.stringify(row)).join("\n") + "\n", "utf8");
  const bytes = Buffer.from(JSON.stringify(report));
  await writeFile(fixture.reportPath, bytes);
  return {
    ...fixture,
    report,
    bytes,
    input: {
      ...fixture.input,
      case: caseRecord.id,
      verification: { ...fixture.input.verification, reportSha256: hash(bytes) },
    },
  };
}

async function rewriteReport(fixture, report) {
  const bytes = Buffer.from(JSON.stringify(report));
  await writeFile(fixture.reportPath, bytes);
  return {
    ...fixture.input,
    verification: { ...fixture.input.verification, reportSha256: hash(bytes) },
  };
}

async function createPassingMemoryLifecycleReport(t) {
  const fixture = await createPassingReport(t);
  const report = JSON.parse(fixture.bytes.toString("utf8"));
  const fixtureNonce = "a".repeat(32);
  const projectId = `qqtest-${fixtureNonce}`;
  const principalId = "owner-fixture";
  const candidateId = `candidate_${"b".repeat(32)}`;
  const memoryId = `memory_${"c".repeat(32)}`;
  const runIds = ["run-feedback-1", "run-promote-2", "run-expire-3"];
  const caseIds = ["memory-feedback", "memory-promote", "memory-expire"];
  const scope = {
    connectionId: report.runtime.connectionId,
    botId: "10002",
    chatType: "private",
    chatId: "10001",
    senderId: "10001",
    threadId: null,
  };
  const dbPath = join(report.runtime.dataDirectory, "glassbox.db");
  await mkdir(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE principals (id TEXT PRIMARY KEY, kind TEXT NOT NULL);
    CREATE TABLE runs (
      id TEXT PRIMARY KEY, principal_id TEXT NOT NULL, scope_json TEXT NOT NULL,
      status TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE memory_candidates (
      id TEXT PRIMARY KEY, candidate_kind TEXT NOT NULL, subject_json TEXT NOT NULL,
      scope_json TEXT NOT NULL, proposed_type TEXT NOT NULL, status TEXT NOT NULL,
      created_at TEXT NOT NULL, promoted_memory_id TEXT
    );
    CREATE TABLE memories (
      id TEXT PRIMARY KEY, subject_json TEXT NOT NULL, scope_json TEXT NOT NULL,
      lifecycle_state TEXT NOT NULL, derived_from_json TEXT NOT NULL
    );
    CREATE TABLE feedback_events (
      id TEXT PRIMARY KEY, principal_id TEXT NOT NULL, scope_json TEXT NOT NULL,
      signal_type TEXT NOT NULL, run_id TEXT NOT NULL, candidate_id TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE memory_audit_events (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL,
      principal_id TEXT NOT NULL, action TEXT NOT NULL, target_id TEXT NOT NULL,
      run_id TEXT NOT NULL, lineage_json TEXT NOT NULL
    );
  `);
  const subject = JSON.stringify({ kind: "user", id: principalId });
  const memoryScope = JSON.stringify({ type: "project", projectId });
  db.prepare("INSERT INTO principals VALUES (?, 'owner')").run(principalId);
  for (const runId of runIds)
    db.prepare("INSERT INTO runs VALUES (?, ?, ?, 'succeeded', '2026-10-05T00:00:00.000Z')").run(
      runId,
      principalId,
      memoryScope,
    );
  db.prepare(
    "INSERT INTO memory_candidates VALUES (?, 'assertion', ?, ?, 'preference', 'promoted', 'created', ?)",
  ).run(candidateId, subject, memoryScope, memoryId);
  db.prepare("INSERT INTO memories VALUES (?, ?, ?, 'expired', ?)").run(
    memoryId,
    subject,
    memoryScope,
    JSON.stringify([candidateId]),
  );
  db.prepare(
    "INSERT INTO feedback_events VALUES (?, ?, ?, 'explicit_positive', ?, ?, 'created')",
  ).run("feedback-run-feedback-1", principalId, memoryScope, runIds[0], candidateId);
  const audits = db.prepare(
    "INSERT INTO memory_audit_events (id, principal_id, action, target_id, run_id, lineage_json) VALUES (?, ?, ?, ?, ?, ?)",
  );
  audits.run(
    "audit-feedback",
    principalId,
    "write",
    "feedback-run-feedback-1",
    runIds[0],
    JSON.stringify([candidateId, `run:${runIds[0]}`]),
  );
  audits.run(
    "audit-promote",
    principalId,
    "promote",
    memoryId,
    runIds[1],
    JSON.stringify([candidateId, `run:${runIds[1]}`]),
  );
  audits.run(
    "audit-expire",
    principalId,
    "expire",
    memoryId,
    runIds[2],
    JSON.stringify([candidateId, `run:${runIds[2]}`]),
  );
  db.close();

  const cases = [];
  const acceptedCases = [];
  for (const index of [0, 1, 2]) {
    const stage = ["feedback", "promote", "expire"][index];
    const runId = runIds[index];
    const caseId = caseIds[index];
    const marker = `${index + 1}`.repeat(32);
    const spec = memoryFixtureStep(stage, { nonce: fixtureNonce, candidateId, memoryId });
    const prompt = `GLASSBOX_ACCEPTANCE_V1 ${marker}\n${spec.prompt.replaceAll("{{nonce}}", marker).trim()}`;
    const tools = spec.leaseTools.map((tool) => tool.name);
    const toolsSha256 = toolManifestDigest(spec.leaseTools);
    const lease = { leaseId: `lease-${index + 1}`, toolsSha256 };
    const messageId = `bot-message-${index + 1}`;
    const delivery = {
      id: `delivery-${index + 1}`,
      status: "sent",
      external_id: `${9001 + index}`,
    };
    const binding = {
      driverMessageId: `driver-message-${index + 1}`,
      botMessageId: messageId,
      realSequence: `${101 + index}`,
      time: 1791158400000 + index * 1000,
      textSha256: hash(Buffer.from(prompt, "utf8")),
    };
    cases.push({
      id: caseId,
      route: "private",
      status: "PASS",
      prompt,
      sentMessageId: binding.driverMessageId,
      inputBinding: binding,
      token: marker,
      acceptanceLease: lease,
      leasedToolNames: tools,
      leaseRegistrationAttempted: true,
      leaseRevoked: true,
      featureAssertions: JSON.parse(
        JSON.stringify(spec.featureAssertions).replaceAll("{{nonce}}", marker),
      ),
    });
    acceptedCases.push({
      caseId,
      runId,
      scope,
      decisions: [{ decision: "ALLOW" }],
      delivery,
      traceVerified: true,
      messageBinding: {
        input: {
          realSequence: binding.realSequence,
          time: binding.time,
          textSha256: binding.textSha256,
        },
        reply: {
          realSequence: `${201 + index}`,
          time: binding.time + 1000,
          textSha256: "f".repeat(64),
        },
      },
      feature: {
        status: "PASS",
        runId,
        observations: [{ kind: "trace", type: "tool_result", count: 1 }],
      },
    });
    const traceEvents = [
      {
        type: "message_received",
        runId,
        externalId: messageId,
        textSha256: binding.textSha256,
        ...scope,
      },
      {
        type: "delivery_changed",
        runId,
        deliveryId: delivery.id,
        status: "sent",
        externalId: delivery.external_id,
      },
      {
        type: "session_start",
        runId,
        data: {
          acceptanceLease: { ...lease, marker, narrowedTools: tools },
          authorizedTools: tools,
        },
      },
      {
        type: "tool_call",
        runId,
        toolCallId: `call-${index + 1}`,
        data: { name: tools[0], input: spec.leaseTools[0].operations[0].inputConstraint },
      },
      {
        type: "tool_result",
        runId,
        toolCallId: `call-${index + 1}`,
        data: { name: tools[0], isError: false },
      },
    ];
    const tracePath = join(report.runtime.dataDirectory, "runs", runId, "trace.jsonl");
    await mkdir(dirname(tracePath), { recursive: true });
    await writeFile(
      tracePath,
      traceEvents.map((event, seq) => JSON.stringify({ seq: seq + 1, event })).join("\n") + "\n",
      "utf8",
    );
  }
  report.cases = cases;
  report.productAcceptance.cases = acceptedCases;
  report.productAcceptance.status = "PASS";
  report.productAcceptance.runtime = report.runtime;
  report.status = "PASS";
  report.plannedCaseCount = 3;
  report.executedCaseCount = 3;
  report.memoryLifecycle = {
    status: "PASS",
    stage: "expire",
    handles: {
      fixtureNonce,
      projectId,
      stepRunId: runIds[2],
      principalId,
      creationRunId: runIds[0],
      candidateId,
      promoteRunId: runIds[1],
      memoryId,
      cleanupRunId: runIds[2],
      cleanupStatus: "expired",
    },
    steps: ["feedback", "promote", "expire"].map((stage, index) => ({
      stage,
      currentRunId: runIds[index],
      runId: runIds[index],
      productAcceptance: {
        status: "PASS",
        runtime: report.runtime,
        caseId: caseIds[index],
        traceVerified: true,
        featureStatus: "PASS",
      },
    })),
    requiresReconciliation: false,
    cleanup: { status: "expired", runId: runIds[2] },
  };

  async function writeReport(nextReport) {
    const bytes = Buffer.from(JSON.stringify(nextReport));
    await writeFile(fixture.reportPath, bytes);
    return {
      ...fixture.input,
      case: "memory-expire",
      evidence: { type: "run", runId: runIds[2] },
      verification: { ...fixture.input.verification, reportSha256: hash(bytes) },
    };
  }
  const input = await writeReport(report);
  return { ...fixture, report, input, dbPath, writeReport, runIds, candidateId, memoryId };
}

async function createPassingMemoryRejectReport(t) {
  const fixture = await createPassingMemoryLifecycleReport(t);
  const report = structuredClone(fixture.report);
  const fixtureNonce = report.memoryLifecycle.handles.fixtureNonce;
  const projectId = report.memoryLifecycle.handles.projectId;
  const principalId = report.memoryLifecycle.handles.principalId;
  const candidateId = report.memoryLifecycle.handles.candidateId;
  const runIds = [fixture.runIds[0], fixture.runIds[2]];
  const stages = ["feedback", "reject"];
  const db = new DatabaseSync(fixture.dbPath);
  db.prepare("DELETE FROM memory_audit_events WHERE action IN ('promote', 'expire')").run();
  db.prepare("DELETE FROM memories").run();
  db.prepare(
    "UPDATE memory_candidates SET status='rejected', promoted_memory_id=NULL WHERE id=?",
  ).run(candidateId);
  db.prepare(
    "INSERT INTO memory_audit_events (id, principal_id, action, target_id, run_id, lineage_json) VALUES (?, ?, 'reject', ?, ?, ?)",
  ).run(
    "audit-reject",
    principalId,
    candidateId,
    runIds[1],
    JSON.stringify([candidateId, `run:${runIds[1]}`]),
  );
  db.close();

  const scope = {
    connectionId: report.runtime.connectionId,
    botId: "10002",
    chatType: "private",
    chatId: "10001",
    senderId: "10001",
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
  const cases = [];
  const acceptedCases = [];
  for (const [index, stage] of stages.entries()) {
    const runId = runIds[index];
    const caseId = `memory-${stage}`;
    const token = `${index + 1}`.repeat(32);
    const spec = memoryFixtureStep(stage, { nonce: fixtureNonce, candidateId });
    const replace = (value) => JSON.parse(JSON.stringify(value).replaceAll("{{nonce}}", token));
    const prompt = `GLASSBOX_ACCEPTANCE_V1 ${token}\n${spec.prompt.replaceAll("{{nonce}}", token).trim()}`;
    const tools = replace(spec.leaseTools);
    const binding = {
      driverMessageId: String(9101 + index),
      botMessageId: String(9201 + index),
      realSequence: String(9301 + index),
      time: 1791158400000 + index * 1000,
      textSha256: hash(Buffer.from(prompt, "utf8")),
    };
    const delivery = {
      id: `delivery-reject-${index + 1}`,
      status: "sent",
      external_id: String(9401 + index),
      destination_scope_key: scopeKey,
    };
    const replyHash = hash(Buffer.from(`reply ${token}`, "utf8"));
    cases.push({
      id: caseId,
      token,
      route: "private",
      prompt,
      expected: replace(spec.expectContains),
      startedAt: "2026-10-05T00:00:00.000Z",
      sentMessageId: binding.driverMessageId,
      status: "PASS",
      inputBinding: binding,
      replies: [
        {
          route: "private",
          messageId: String(9501 + index),
          textSha256: replyHash,
          textBytes: 12,
          matches: true,
          receivedAt: "2026-10-05T00:00:01.000Z",
        },
      ],
      anomalies: [],
      featureAssertions: replace(spec.featureAssertions),
      leasedToolNames: tools.map((tool) => tool.name),
      acceptanceLease: {
        leaseId: `12345678-1234-1234-1234-${String(index + 1).padStart(12, "0")}`,
        expiresAt: Date.parse("2026-10-05T00:01:00.000Z"),
        toolsSha256: toolManifestDigest(tools),
      },
      leaseRegistrationAttempted: true,
      leaseRevoked: true,
    });
    acceptedCases.push({
      caseId,
      runId,
      scope,
      decisions: [{ decision: "ALLOW" }],
      delivery,
      traceVerified: true,
      messageBinding: {
        input: {
          realSequence: binding.realSequence,
          time: binding.time,
          textSha256: binding.textSha256,
        },
        reply: {
          messageId: String(9501 + index),
          realSequence: String(9601 + index),
          time: binding.time + 1000,
          textSha256: replyHash,
        },
      },
      feature: {
        status: "PASS",
        runId,
        observations: spec.featureAssertions.map((assertion) => ({
          kind: "trace",
          type: assertion.type,
          count: assertion.count,
        })),
      },
    });
    const events = [
      {
        type: "message_received",
        runId,
        externalId: binding.botMessageId,
        textSha256: binding.textSha256,
        ...scope,
      },
      {
        type: "delivery_changed",
        runId,
        deliveryId: delivery.id,
        status: "sent",
        externalId: delivery.external_id,
      },
      {
        type: "session_start",
        runId,
        data: {
          acceptanceLease: {
            leaseId: `12345678-1234-1234-1234-${String(index + 1).padStart(12, "0")}`,
            toolsSha256: toolManifestDigest(tools),
            marker: token,
            narrowedTools: tools.map((tool) => tool.name),
          },
          authorizedTools: tools.map((tool) => tool.name),
        },
      },
      {
        type: "tool_call",
        runId,
        toolCallId: `reject-call-${index + 1}`,
        data: { name: "owner_memory_admin", input: tools[0].operations[0].inputConstraint },
      },
      {
        type: "tool_result",
        runId,
        toolCallId: `reject-call-${index + 1}`,
        data: { name: "owner_memory_admin", isError: false },
      },
    ];
    const tracePath = join(report.runtime.dataDirectory, "runs", runId, "trace.jsonl");
    await mkdir(dirname(tracePath), { recursive: true });
    await writeFile(
      tracePath,
      events.map((event, seq) => JSON.stringify({ seq: seq + 1, event })).join("\n") + "\n",
      "utf8",
    );
  }

  report.cases = cases;
  report.productAcceptance.cases = acceptedCases;
  report.productAcceptance.status = "PASS";
  report.productAcceptance.runtime = report.runtime;
  report.status = "PASS";
  report.plannedCaseCount = 2;
  report.executedCaseCount = 2;
  report.memoryFamily = { caseId: MEMORY_REJECT_FAMILY_ID };
  report.memoryLifecycle = {
    status: "PASS",
    stage: "reject",
    handles: {
      fixtureNonce,
      projectId,
      stepRunId: runIds[1],
      principalId,
      creationRunId: runIds[0],
      candidateId,
      cleanupRunId: runIds[1],
      cleanupStatus: "rejected",
    },
    steps: stages.map((stage, index) => ({
      stage,
      currentRunId: runIds[index],
      runId: runIds[index],
      productAcceptance: {
        status: "PASS",
        runtime: report.runtime,
        caseId: `memory-${stage}`,
        traceVerified: true,
        featureStatus: "PASS",
      },
    })),
    requiresReconciliation: false,
    cleanup: { status: "rejected", runId: runIds[1] },
  };

  async function writeReport(nextReport) {
    const bytes = Buffer.from(JSON.stringify(nextReport));
    await writeFile(fixture.reportPath, bytes);
    return {
      ...fixture.input,
      case: "memory-reject",
      evidence: { type: "run", runId: runIds[1] },
      verification: { ...fixture.input.verification, reportSha256: hash(bytes) },
    };
  }
  const input = await writeReport(report);
  return { ...fixture, report, input, writeReport, runIds, candidateId };
}

async function updateTrace(fixture, runId, update) {
  const report = fixture.report ?? JSON.parse(fixture.bytes.toString("utf8"));
  const tracePath = join(report.runtime.dataDirectory, "runs", runId, "trace.jsonl");
  const events = (await readFile(tracePath, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  update(events);
  await writeFile(tracePath, events.map((row) => JSON.stringify(row)).join("\n") + "\n");
}

test("core verifier accepts the locked rules and detects edits", async (t) => {
  const temp = await mkdtemp(join(tmpdir(), "qq-live-core-"));
  t.after(() => rm(temp, { recursive: true, force: true }));
  await cp(join(here, "..", "core-rules.md"), join(temp, "core-rules.md"));
  await cp(join(here, "..", "core-rules.sha256"), join(temp, "core-rules.sha256"));
  await cp(here, join(temp, "scripts"), { recursive: true });
  assert.match(await verifyCore(join(temp, "scripts")), /^[a-f0-9]{64}$/);
  await writeFile(join(temp, "core-rules.md"), "changed\n", "utf8");
  await assert.rejects(verifyCore(join(temp, "scripts")), /hash mismatch/);
});

test("unverified findings append only as hypotheses", async (t) => {
  const temp = await mkdtemp(join(tmpdir(), "qq-live-lessons-"));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const path = join(temp, "lessons.jsonl");
  const validated = validateLesson({
    ...hypothesis,
    evidence: { type: "preflight_error", errorCode: "SERVICE_NOT_READY" },
  });
  assert.equal(validated.lesson.status, "hypothesis");
  const recorded = await appendLesson(
    { ...hypothesis, evidence: { type: "preflight_error", errorCode: "SERVICE_NOT_READY" } },
    path,
  );
  assert.equal(recorded.status, "hypothesis");
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), recorded);
});

test("verified self-claims without report proof are rejected", () => {
  assert.throws(
    () => validateLesson({ ...hypothesis, status: "verified" }),
    /requires a QQ live report/,
  );
});

test("verified feature lesson checks lease, tool and state evidence via existing observers", async (t) => {
  const fixture = await createPassingFeatureReport(t);
  const lessonsPath = join(fixture.temp, "lessons.jsonl");
  const recorded = await appendLesson(fixture.input, lessonsPath);
  assert.equal(recorded.status, "verified");
  assert.equal(recorded.evidence.reportSha256, fixture.input.verification.reportSha256);
  assert.deepEqual(JSON.parse(await readFile(lessonsPath, "utf8")), recorded);
});

test("complete history lessons recheck the fixed nonce, group A lease and source window", async (t) => {
  for (const caseId of ["history-current-group-complete", "history-owner-group-a-complete"]) {
    const fixture = await createPassingCompleteHistoryReport(t, caseId);
    const lessonsPath = join(fixture.temp, `${caseId}.jsonl`);
    const recorded = await appendLesson(fixture.input, lessonsPath);
    assert.equal(recorded.status, "verified", caseId);
    assert.equal(recorded.case, caseId);
  }
});

test("complete history lessons cannot drop coverage assertion or trace observation", async (t) => {
  for (const caseId of ["history-current-group-complete", "history-owner-group-a-complete"]) {
    const fixture = await createPassingCompleteHistoryReport(t, caseId);
    const report = structuredClone(fixture.report);
    report.cases[0].featureAssertions = report.cases[0].featureAssertions.filter(
      (assertion) => assertion.kind !== "history_coverage",
    );
    report.productAcceptance.cases[0].feature.observations =
      report.productAcceptance.cases[0].feature.observations.filter(
        (observation) => observation.kind !== "history_coverage",
      );
    const input = await rewriteReport(fixture, report);
    const lessonsPath = join(fixture.temp, `${caseId}-coverage-removed.jsonl`);
    await assert.rejects(
      appendLesson(input, lessonsPath),
      /Feature Run lease, scope, or Trace evidence|exact group A lease and result assertions/,
      caseId,
    );
    await assert.rejects(readFile(lessonsPath, "utf8"), { code: "ENOENT" });
  }
});

test("verified member-count lesson cannot be downgraded by deleting report assertions and metadata", async (t) => {
  const fixture = await createPassingGroupMemberReport(t);
  const report = structuredClone(fixture.report);
  const caseRecord = report.cases[0];
  delete caseRecord.featureAssertions;
  delete caseRecord.leasedToolNames;
  delete caseRecord.acceptanceLease;
  delete caseRecord.leaseRegistrationAttempted;
  delete caseRecord.leaseRevoked;
  delete report.productAcceptance.cases[0].feature;
  const input = await rewriteReport(fixture, report);
  const lessonsPath = join(fixture.temp, "member-count-downgrade.jsonl");
  await assert.rejects(
    appendLesson(input, lessonsPath),
    /Independent group member count evidence is unavailable/,
  );
  await assert.rejects(readFile(lessonsPath, "utf8"), { code: "ENOENT" });
});

test("verified member-count aggregate signal requires independent count evidence", async (t) => {
  const fixture = await createPassingOwnerPrivateOpsReport(t);
  const report = JSON.parse(fixture.bytes.toString("utf8"));
  report.cases[0].featureAssertions = [
    { kind: "aggregate_projection", tool: "qq_group_members", count: 1 },
  ];
  report.productAcceptance.cases[0].feature = {
    status: "PASS",
    runId: fixture.input.evidence.runId,
    observations: [
      {
        kind: "aggregate_projection",
        tool: "qq_group_members",
        memberCount: 0,
        identifiersExposed: false,
      },
    ],
  };
  const input = await rewriteReport(fixture, report);
  const lessonsPath = join(fixture.temp, "member-count-no-witness.jsonl");
  await assert.rejects(
    appendLesson(input, lessonsPath),
    /Independent group member count evidence is unavailable/,
  );
  await assert.rejects(readFile(lessonsPath, "utf8"), { code: "ENOENT" });
});

test("member-count lessons without independent evidence remain recordable as hypotheses", async (t) => {
  const fixture = await createPassingGroupMemberReport(t, { aggregateAssertion: true });
  const input = { ...fixture.input, status: "hypothesis" };
  delete input.verification;
  const lessonsPath = join(fixture.temp, "member-count-hypothesis.jsonl");
  const recorded = await appendLesson(input, lessonsPath);
  assert.equal(recorded.status, "hypothesis");
  assert.equal(JSON.parse(await readFile(lessonsPath, "utf8")).status, "hypothesis");
});

test("Owner private Ops lesson is not blocked by an authorized but unused member Tool", async (t) => {
  const fixture = await createPassingOwnerPrivateOpsReport(t);
  const lessonsPath = join(fixture.temp, "ops-with-member-visibility.jsonl");
  const recorded = await appendLesson(fixture.input, lessonsPath);
  assert.equal(recorded.status, "verified");
});

test("member Tool Trace from another Run does not block the selected Ops lesson", async (t) => {
  const fixture = await createPassingOwnerPrivateOpsReport(t, { otherRunMemberTrace: true });
  const lessonsPath = join(fixture.temp, "ops-with-other-run-member-trace.jsonl");
  const recorded = await appendLesson(fixture.input, lessonsPath);
  assert.equal(recorded.status, "verified");
});

test("same-Run narrowed member Tool surface requires independent count evidence", async (t) => {
  const fixture = await createPassingOwnerPrivateOpsReport(t);
  await updateTrace(fixture, fixture.input.evidence.runId, (rows) => {
    const session = rows.find((row) => row.event.type === "session_start").event;
    session.data.acceptanceLease = { narrowedTools: ["qq_group_members"] };
  });
  const lessonsPath = join(fixture.temp, "ops-with-member-lease.jsonl");
  await assert.rejects(
    appendLesson(fixture.input, lessonsPath),
    /Independent group member count evidence is unavailable/,
  );
  await assert.rejects(readFile(lessonsPath, "utf8"), { code: "ENOENT" });
});

test("verified Memory lifecycle rechecks Owner state and all three fresh Run traces", async (t) => {
  const fixture = await createPassingMemoryLifecycleReport(t);
  const lessonsPath = join(fixture.temp, "memory-lifecycle-lessons.jsonl");
  const recorded = await appendLesson(fixture.input, lessonsPath);
  assert.equal(recorded.status, "verified");
  assert.equal(recorded.evidence.runId, fixture.runIds[2]);
  assert.deepEqual(JSON.parse(await readFile(lessonsPath, "utf8")), recorded);
});

test("verified feedback-reject lesson checks two historical Runs and rejected Owner cleanup", async (t) => {
  const fixture = await createPassingMemoryRejectReport(t);
  const lessonsPath = join(fixture.temp, "memory-reject-lessons.jsonl");
  const recorded = await appendLesson(fixture.input, lessonsPath);
  assert.equal(recorded.status, "verified");
  assert.equal(recorded.case, "memory-reject");
  assert.equal(recorded.evidence.runId, fixture.runIds[1]);
  assert.deepEqual(JSON.parse(await readFile(lessonsPath, "utf8")), recorded);
});

test("feedback-reject verified lessons reject missing metadata and a non-final selected Run", async (t) => {
  const missing = await createPassingMemoryRejectReport(t);
  const missingReport = structuredClone(missing.report);
  delete missingReport.memoryFamily;
  delete missingReport.memoryLifecycle;
  const missingInput = await missing.writeReport(missingReport);
  const missingPath = join(missing.temp, "memory-reject-missing-metadata.jsonl");
  await assert.rejects(appendLesson(missingInput, missingPath), /complete Memory lifecycle report/);
  await assert.rejects(readFile(missingPath, "utf8"), { code: "ENOENT" });

  const unknownFamily = await createPassingMemoryRejectReport(t);
  const unknownReport = structuredClone(unknownFamily.report);
  unknownReport.memoryFamily.caseId = "memory-unapproved-family";
  const unknownInput = await unknownFamily.writeReport(unknownReport);
  const unknownPath = join(unknownFamily.temp, "memory-reject-unknown-family.jsonl");
  await assert.rejects(appendLesson(unknownInput, unknownPath), /Unknown Memory family/);
  await assert.rejects(readFile(unknownPath, "utf8"), { code: "ENOENT" });

  const wrongRun = await createPassingMemoryRejectReport(t);
  const wrongPath = join(wrongRun.temp, "memory-reject-not-final-run.jsonl");
  const wrongInput = {
    ...wrongRun.input,
    evidence: { type: "run", runId: wrongRun.runIds[0] },
  };
  await assert.rejects(
    appendLesson(wrongInput, wrongPath),
    /lacks passing authorization, delivery, and message evidence/,
  );
  await assert.rejects(readFile(wrongPath, "utf8"), { code: "ENOENT" });
});

test("feedback-reject verified lessons require fixed reject Trace and no residual state", async (t) => {
  const changedOperation = await createPassingMemoryRejectReport(t);
  await updateTrace(changedOperation, changedOperation.runIds[1], (rows) => {
    rows.find((row) => row.event.type === "tool_call").event.data.input.action = "promote";
  });
  const operationPath = join(changedOperation.temp, "memory-reject-wrong-operation.jsonl");
  await assert.rejects(
    appendLesson(changedOperation.input, operationPath),
    /exact leased operation and input|historical evidence did not verify/,
  );
  await assert.rejects(readFile(operationPath, "utf8"), { code: "ENOENT" });

  const residual = await createPassingMemoryRejectReport(t);
  const residualDb = new DatabaseSync(residual.dbPath);
  residualDb
    .prepare("UPDATE memory_candidates SET status='pending' WHERE id=?")
    .run(residual.candidateId);
  residualDb.close();
  const residualPath = join(residual.temp, "memory-reject-residual-state.jsonl");
  await assert.rejects(
    appendLesson(residual.input, residualPath),
    /historical evidence did not verify/,
  );
  await assert.rejects(readFile(residualPath, "utf8"), { code: "ENOENT" });
});

test("verified Memory mutation prompts require lifecycle proof when its report marker is removed", async (t) => {
  const mutations = [
    {
      name: "deleted lifecycle field",
      update(report) {
        delete report.memoryLifecycle;
      },
    },
    {
      name: "null lifecycle field",
      update(report) {
        report.memoryLifecycle = null;
      },
    },
    {
      name: "renamed lifecycle cases with original prompts",
      update(report) {
        delete report.memoryLifecycle;
        for (const item of report.cases) item.id = `renamed-${item.id}`;
        for (const item of report.productAcceptance.cases) item.caseId = `renamed-${item.caseId}`;
      },
      lessonCase: "renamed-memory-expire",
    },
  ];
  for (const mutation of mutations) {
    const fixture = await createPassingMemoryLifecycleReport(t);
    const report = structuredClone(fixture.report);
    mutation.update(report);
    const input = await fixture.writeReport(report);
    if (mutation.lessonCase) input.case = mutation.lessonCase;
    const lessonsPath = join(fixture.temp, `${mutation.name.replaceAll(" ", "-")}.jsonl`);
    await assert.rejects(
      appendLesson(input, lessonsPath),
      /complete Memory lifecycle report/,
      mutation.name,
    );
    await assert.rejects(readFile(lessonsPath, "utf8"), { code: "ENOENT" });
  }
});

test("Raw Trace Memory mutations cannot be downgraded by rewriting report metadata", async (t) => {
  const fixture = await createPassingMemoryLifecycleReport(t);
  const report = structuredClone(fixture.report);
  delete report.memoryLifecycle;
  for (const [index, item] of report.cases.entries()) {
    item.id = `ordinary-case-${index}`;
    item.prompt = "An ordinary harmless prompt.";
    item.featureAssertions = [];
  }
  for (const [index, item] of report.productAcceptance.cases.entries())
    item.caseId = `ordinary-case-${index}`;
  const input = await fixture.writeReport(report);
  input.case = "ordinary-case-2";
  const lessonsPath = join(fixture.temp, "trace-mutation-downgrade.jsonl");
  await assert.rejects(appendLesson(input, lessonsPath), /complete Memory lifecycle report/);
  await assert.rejects(readFile(lessonsPath, "utf8"), { code: "ENOENT" });

  const unknownAction = await createPassingMemoryLifecycleReport(t);
  const disguised = structuredClone(unknownAction.report);
  delete disguised.memoryLifecycle;
  for (const [index, item] of disguised.cases.entries()) {
    item.id = `renamed-case-${index}`;
    item.prompt = "Harmless rewritten prompt.";
    item.featureAssertions = [];
  }
  for (const [index, item] of disguised.productAcceptance.cases.entries())
    item.caseId = `renamed-case-${index}`;
  await updateTrace(unknownAction, unknownAction.runIds[2], (rows) => {
    rows.find((row) => row.event.type === "tool_call").event.data.input.action = "future_action";
  });
  const unknownInput = await unknownAction.writeReport(disguised);
  unknownInput.case = "renamed-case-2";
  const unknownPath = join(unknownAction.temp, "unknown-memory-action.jsonl");
  await assert.rejects(appendLesson(unknownInput, unknownPath), /complete Memory lifecycle report/);
  await assert.rejects(readFile(unknownPath, "utf8"), { code: "ENOENT" });

  const missingAction = await createPassingMemoryLifecycleReport(t);
  const missingInputReport = structuredClone(missingAction.report);
  delete missingInputReport.memoryLifecycle;
  for (const [index, item] of missingInputReport.cases.entries()) {
    item.id = `missing-input-case-${index}`;
    item.prompt = "Harmless rewritten prompt.";
    item.featureAssertions = [];
  }
  for (const [index, item] of missingInputReport.productAcceptance.cases.entries())
    item.caseId = `missing-input-case-${index}`;
  await updateTrace(missingAction, missingAction.runIds[2], (rows) => {
    delete rows.find((row) => row.event.type === "tool_call").event.data.input;
  });
  const missingActionInput = await missingAction.writeReport(missingInputReport);
  missingActionInput.case = "missing-input-case-2";
  const missingActionPath = join(missingAction.temp, "missing-memory-action.jsonl");
  await assert.rejects(
    appendLesson(missingActionInput, missingActionPath),
    /complete Memory lifecycle report/,
  );
  await assert.rejects(readFile(missingActionPath, "utf8"), { code: "ENOENT" });
});

test("verified lessons require the selected Raw Trace input hash to match the bound prompt", async (t) => {
  const fixture = await createPassingReport(t);
  const runId = fixture.input.evidence.runId;
  await updateTrace(fixture, runId, (rows) => {
    rows.find((row) => row.event.type === "message_received").event.textSha256 = "0".repeat(64);
  });
  const lessonsPath = join(fixture.temp, "stale-input-hash.jsonl");
  await assert.rejects(appendLesson(fixture.input, lessonsPath), /Raw Trace input hash/);
  await assert.rejects(readFile(lessonsPath, "utf8"), { code: "ENOENT" });
});

test("Memory read results without input are paired by Run and toolCallId", async (t) => {
  const readOnly = await createPassingReport(t);
  await updateTrace(readOnly, readOnly.input.evidence.runId, (rows) => {
    const runId = readOnly.input.evidence.runId;
    rows.push(
      {
        seq: rows.length + 1,
        event: {
          type: "tool_call",
          runId,
          toolCallId: "memory-read-call",
          data: {
            name: "owner_memory_admin",
            toolCallId: "memory-read-call",
            input: { action: "list" },
          },
        },
      },
      {
        seq: rows.length + 2,
        event: {
          type: "tool_result",
          runId,
          toolCallId: "memory-read-call",
          data: { name: "owner_memory_admin", toolCallId: "memory-read-call", isError: false },
        },
      },
    );
  });
  const readPath = join(readOnly.temp, "readonly-memory-lesson.jsonl");
  assert.equal((await appendLesson(readOnly.input, readPath)).status, "verified");

  const unpaired = await createPassingReport(t);
  await updateTrace(unpaired, unpaired.input.evidence.runId, (rows) => {
    const runId = unpaired.input.evidence.runId;
    rows.push({
      seq: rows.length + 1,
      event: {
        type: "tool_result",
        runId,
        toolCallId: "orphan-memory-result",
        data: { name: "owner_memory_admin", toolCallId: "orphan-memory-result", isError: false },
      },
    });
  });
  const unpairedPath = join(unpaired.temp, "unpaired-memory-result.jsonl");
  await assert.rejects(
    appendLesson(unpaired.input, unpairedPath),
    /complete Memory lifecycle report/,
  );
  await assert.rejects(readFile(unpairedPath, "utf8"), { code: "ENOENT" });

  const duplicate = await createPassingReport(t);
  await updateTrace(duplicate, duplicate.input.evidence.runId, (rows) => {
    const runId = duplicate.input.evidence.runId;
    for (let index = 0; index < 2; index++)
      rows.push({
        seq: rows.length + 1,
        event: {
          type: "tool_call",
          runId,
          toolCallId: "duplicate-memory-call",
          data: {
            name: "owner_memory_admin",
            toolCallId: "duplicate-memory-call",
            input: { action: "list" },
          },
        },
      });
  });
  const duplicatePath = join(duplicate.temp, "duplicate-memory-call.jsonl");
  await assert.rejects(
    appendLesson(duplicate.input, duplicatePath),
    /complete Memory lifecycle report/,
  );
  await assert.rejects(readFile(duplicatePath, "utf8"), { code: "ENOENT" });
});

test("Memory lifecycle requires its fixed operation manifest, command input and private Owner scope", async (t) => {
  const widened = await createPassingMemoryLifecycleReport(t);
  const wideReport = structuredClone(widened.report);
  const wideCase = wideReport.cases[1];
  const extraTool = { name: "ops_status", operations: [] };
  const wideTools = [
    {
      name: "owner_memory_admin",
      operations: [
        {
          action: "memory:govern",
          resourceId: "owner-memory",
          inputConstraint: { action: "promote", id: widened.candidateId },
        },
      ],
    },
    extraTool,
  ];
  wideCase.leasedToolNames = ["owner_memory_admin", "ops_status"];
  wideCase.acceptanceLease.toolsSha256 = toolManifestDigest(wideTools);
  const wideInput = await widened.writeReport(wideReport);
  const widePath = join(widened.temp, "wide-memory-lease.jsonl");
  await assert.rejects(appendLesson(wideInput, widePath), /step evidence/);
  await assert.rejects(readFile(widePath, "utf8"), { code: "ENOENT" });

  const changedOperation = await createPassingMemoryLifecycleReport(t);
  await updateTrace(changedOperation, changedOperation.runIds[1], (rows) => {
    rows.find((row) => row.event.type === "tool_call").event.data.input.action = "list";
  });
  const operationPath = join(changedOperation.temp, "different-memory-operation.jsonl");
  await assert.rejects(
    appendLesson(changedOperation.input, operationPath),
    /exact leased operation and input/,
  );
  await assert.rejects(readFile(operationPath, "utf8"), { code: "ENOENT" });

  const changedInput = await createPassingMemoryLifecycleReport(t);
  await updateTrace(changedInput, changedInput.runIds[0], (rows) => {
    rows.find((row) => row.event.type === "tool_call").event.data.input.projectId = "qqtest-other";
  });
  const inputPath = join(changedInput.temp, "different-memory-input.jsonl");
  await assert.rejects(
    appendLesson(changedInput.input, inputPath),
    /exact leased operation and input/,
  );
  await assert.rejects(readFile(inputPath, "utf8"), { code: "ENOENT" });

  const wrongGroup = await createPassingMemoryLifecycleReport(t);
  const groupReport = structuredClone(wrongGroup.report);
  for (const item of groupReport.cases) item.route = "20002";
  for (const item of groupReport.productAcceptance.cases) {
    item.scope.chatType = "group";
    item.scope.chatId = "20002";
  }
  for (const runId of wrongGroup.runIds)
    await updateTrace(wrongGroup, runId, (rows) => {
      for (const row of rows)
        if (row.event.type === "message_received") {
          row.event.chatType = "group";
          row.event.chatId = "20002";
        }
    });
  const groupInput = await wrongGroup.writeReport(groupReport);
  const groupPath = join(wrongGroup.temp, "wrong-group-memory-lifecycle.jsonl");
  await assert.rejects(appendLesson(groupInput, groupPath), /step evidence/);
  await assert.rejects(readFile(groupPath, "utf8"), { code: "ENOENT" });
});

test("verified Memory lifecycle rejects residual state, cross-Run handles and missing fresh traces", async (t) => {
  const residual = await createPassingMemoryLifecycleReport(t);
  const residualDb = new DatabaseSync(residual.dbPath);
  residualDb
    .prepare("UPDATE memories SET lifecycle_state='active' WHERE id=?")
    .run(residual.memoryId);
  residualDb.close();
  const residualPath = join(residual.temp, "residual-lessons.jsonl");
  await assert.rejects(
    appendLesson(residual.input, residualPath),
    /database evidence did not verify/,
  );
  await assert.rejects(readFile(residualPath, "utf8"), { code: "ENOENT" });

  const crossRun = await createPassingMemoryLifecycleReport(t);
  const forged = structuredClone(crossRun.report);
  forged.memoryLifecycle.handles.promoteRunId = crossRun.runIds[2];
  forged.memoryLifecycle.steps[1].currentRunId = crossRun.runIds[2];
  forged.memoryLifecycle.steps[1].runId = crossRun.runIds[2];
  const forgedInput = await crossRun.writeReport(forged);
  const forgedPath = join(crossRun.temp, "cross-run-lessons.jsonl");
  await assert.rejects(appendLesson(forgedInput, forgedPath), /complete Memory lifecycle report/);
  await assert.rejects(readFile(forgedPath, "utf8"), { code: "ENOENT" });

  const payloadReport = await createPassingMemoryLifecycleReport(t);
  const reportWithPayload = structuredClone(payloadReport.report);
  reportWithPayload.memoryLifecycle.handles.privateMessage = "private payload sentinel";
  const payloadInput = await payloadReport.writeReport(reportWithPayload);
  const payloadPath = join(payloadReport.temp, "payload-lessons.jsonl");
  await assert.rejects(appendLesson(payloadInput, payloadPath), /complete Memory lifecycle report/);
  await assert.rejects(readFile(payloadPath, "utf8"), { code: "ENOENT" });

  const staleTrace = await createPassingMemoryLifecycleReport(t);
  const tracePath = join(
    staleTrace.report.runtime.dataDirectory,
    "runs",
    staleTrace.runIds[0],
    "trace.jsonl",
  );
  const traceEvents = (await readFile(tracePath, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
    .filter((row) => row.event.type !== "tool_result");
  await writeFile(
    tracePath,
    traceEvents.map((row) => JSON.stringify(row)).join("\n") + "\n",
    "utf8",
  );
  const staleTracePath = join(staleTrace.temp, "stale-trace-lessons.jsonl");
  await assert.rejects(
    appendLesson(staleTrace.input, staleTracePath),
    /Feature trace or read-only state assertions did not verify/,
  );
  await assert.rejects(readFile(staleTracePath, "utf8"), { code: "ENOENT" });
});

test("feature verification rejects forged tool results, lease hashes and unknown cleanup", async (t) => {
  const lessonsPath = join(tmpdir(), "qq-live-forged-feature-lessons.jsonl");
  await rm(lessonsPath, { force: true });
  t.after(() => rm(lessonsPath, { force: true }));

  const badTool = await createPassingFeatureReport(t, (_report, events) => {
    events[4].data.name = "different_tool";
  });
  await assert.rejects(
    appendLesson(badTool.input, lessonsPath),
    /Feature Run lease, scope, or Trace evidence/,
  );
  await assert.rejects(readFile(lessonsPath, "utf8"), { code: "ENOENT" });

  const badLease = await createPassingFeatureReport(t, (report) => {
    report.cases[0].acceptanceLease.toolsSha256 = "a".repeat(64);
  });
  await assert.rejects(
    appendLesson(badLease.input, lessonsPath),
    /Feature Run lease, scope, or Trace evidence/,
  );

  const unknownCleanup = await createPassingFeatureReport(t, (report) => {
    report.cases[0].leaseRevoked = false;
    report.cases[0].cleanup = { required: true, restored: false };
  });
  await assert.rejects(
    appendLesson(unknownCleanup.input, lessonsPath),
    /missing assertions or unconfirmed cleanup/,
  );
});

test("forged verified reports and stale report hashes are rejected without appending", async (t) => {
  const fixture = await createPassingReport(t, {
    workspace: { commit: "e".repeat(40), dirty: false },
  });
  const lessonsPath = join(fixture.temp, "forged-lessons.jsonl");
  await assert.rejects(appendLesson(fixture.input, lessonsPath), /exact clean commit and runtime/);
  await assert.rejects(readFile(lessonsPath, "utf8"), { code: "ENOENT" });

  const missingRun = await createPassingReport(t);
  const forgedReport = JSON.parse(missingRun.bytes.toString("utf8"));
  forgedReport.productAcceptance.cases[0].runId = "run_forged123";
  const forgedBytes = Buffer.from(JSON.stringify(forgedReport));
  await writeFile(missingRun.reportPath, forgedBytes);
  const forgedRunInput = {
    ...missingRun.input,
    evidence: { type: "run", runId: "run_forged123" },
    verification: {
      ...missingRun.input.verification,
      reportSha256: hash(forgedBytes),
    },
  };
  await assert.rejects(appendLesson(forgedRunInput, lessonsPath), /gbxtrace could not verify/);

  const valid = await createPassingReport(t);
  await writeFile(valid.reportPath, Buffer.concat([valid.bytes, Buffer.from(" ")]));
  await assert.rejects(appendLesson(valid.input, lessonsPath), /hash does not match/);
});
test("account-local receipt collision in another scope cannot verify a lesson", async (t) => {
  const fixture = await createPassingReport(t);
  const report = JSON.parse(fixture.bytes.toString("utf8"));
  const tracePath = join(
    report.runtime.dataDirectory,
    "runs",
    hypothesis.evidence.runId,
    "trace.jsonl",
  );
  await writeFile(
    tracePath,
    [
      JSON.stringify({
        seq: 1,
        event: {
          type: "message_received",
          externalId: "bot-input-1",
          ...report.productAcceptance.cases[0].scope,
          connectionId: "other-connection",
        },
      }),
      JSON.stringify({
        seq: 2,
        event: {
          type: "delivery_changed",
          deliveryId: "delivery-1",
          status: "sent",
          externalId: "-12345",
        },
      }),
    ].join("\n") + "\n",
  );
  await assert.rejects(
    appendLesson(fixture.input, join(fixture.temp, "lessons.jsonl")),
    /did not confirm/,
  );
});

test("lesson helper refuses missing evidence, secrets, personal messages, and raw message fields", () => {
  assert.throws(
    () => validateLesson({ ...hypothesis, evidence: undefined }),
    /evidence is required/,
  );
  assert.throws(
    () => validateLesson({ ...hypothesis, lesson: "token=abcd1234secret" }),
    /Sensitive content refused/,
  );
  assert.throws(
    () => validateLesson({ ...hypothesis, symptom: "QQ 123456789 received no reply" }),
    /Sensitive content refused/,
  );
  assert.throws(
    () => validateLesson({ ...hypothesis, symptom: "用户说：‘你好，麻烦帮我看一下。’" }),
    /Sensitive content refused/,
  );
  assert.throws(
    () => validateLesson({ ...hypothesis, message: "private conversation" }),
    /Unexpected field/,
  );
});

test("history result lessons independently recheck archive rows and reject assertion removal", async (t) => {
  for (const caseId of ["history-current-group-hit", "history-owner-group-a-no-match"]) {
    const fixture = await createPassingHistoryResultReport(t, caseId);
    const recorded = await appendLesson(fixture.input, join(fixture.temp, "valid-result.jsonl"));
    assert.equal(recorded.status, "verified");
    const report = structuredClone(fixture.report);
    report.cases[0].featureAssertions = report.cases[0].featureAssertions.filter(
      (item) => item.kind !== "history_result",
    );
    const input = await rewriteReport(fixture, report);
    await assert.rejects(
      appendLesson(input, join(fixture.temp, "removed-result.jsonl")),
      /Feature Run lease, scope, or Trace evidence/,
    );
    await writeFile(fixture.reportPath, JSON.stringify(fixture.report));
    const db = new DatabaseSync(join(fixture.report.runtime.dataDirectory, "glassbox.db"));
    if (caseId === "history-current-group-hit")
      db.exec("UPDATE channel_messages SET normalized_text = 'unrelated'");
    else
      db.prepare("INSERT INTO channel_messages VALUES (?,?,?,?,?,?,?,?,?,?,?)").run(
        "22222222-2222-4222-8222-222222222222",
        "qq-onebot",
        fixture.report.productAcceptance.cases[0].scope.connectionId,
        "20001",
        "group:20001",
        "history",
        "different-input",
        "10002",
        "2026-10-05T00:00:00.000Z",
        Date.parse("2026-10-05T00:00:00.000Z"),
        fixture.report.cases[0].token,
      );
    db.close();
    await assert.rejects(
      appendLesson(fixture.input, join(fixture.temp, "forged-source.jsonl")),
      /Feature trace or read-only state assertions did not verify/,
    );
  }
});
