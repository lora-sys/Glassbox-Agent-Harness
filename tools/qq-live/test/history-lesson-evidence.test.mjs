import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { historyRecallSpec, historySeedSpec } from "../lib/history-scenario.mjs";
import {
  historyExclusionSpec,
  historyIsolationSeedSpec,
} from "../lib/history-isolation-scenario.mjs";
import { HISTORY_FAMILY_ID } from "../lib/history-family-evidence.mjs";
import { HISTORY_ISOLATION_FAMILY_ID } from "../lib/history-isolation-family-evidence.mjs";
import { historySnippet } from "../lib/history-result.mjs";
import { toolManifestDigest } from "../lib/core.mjs";
import { appendLesson } from "../../../.agents/skills/qq-live-testing/scripts/record-lesson.mjs";
import { createHistoryLessonReader } from "../lib/history-lesson-reader.mjs";

const commit = "a".repeat(40);
const ownerId = "owner-fixture";

function hash(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function scopeKey(scope) {
  return JSON.stringify([
    scope.connectionId,
    scope.botId,
    scope.chatType,
    scope.chatId,
    scope.senderId,
    scope.threadId ?? null,
  ]);
}

function resolved(value, token) {
  return JSON.parse(JSON.stringify(value).replaceAll("{{nonce}}", token));
}

function expectedObservations(assertions, returned) {
  return assertions.map((assertion) => {
    if (assertion.kind === "trace")
      return { kind: "trace", type: assertion.type, count: assertion.count };
    if (assertion.kind === "history_coverage")
      return {
        kind: "history_coverage",
        coverage: "complete",
        returned,
        sourceComplete: true,
      };
    if (assertion.kind === "history_result")
      return {
        kind: "history_result",
        result: "hit",
        returned: 1,
        sourceVerified: true,
        toolOutputVerified: true,
      };
    if (assertion.kind === "history_seed_result")
      return {
        kind: "history_seed_result",
        result: "hit",
        returned: 1,
        sourceVerified: true,
        toolOutputVerified: true,
        distinctEarlierInput: true,
      };
    if (assertion.kind === "history_exclusion_result")
      return {
        kind: "history_exclusion_result",
        result: "no_match",
        returned: 0,
        sourceVerified: true,
        exclusionVerified: true,
        toolOutputVerified: true,
      };
    throw new Error(`unexpected assertion ${assertion.kind}`);
  });
}

async function archivedFixture(t, family) {
  const temp = await mkdtemp(join(tmpdir(), "qq-history-lesson-"));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const dataDirectory = join(temp, "data");
  await mkdir(dataDirectory, { recursive: true });
  const reportDirectory = join(temp, "reports");
  const checkout = resolve(".");
  const runtime = {
    checkout,
    dataDirectory,
    commit,
    pid: 4321,
    connectionId: "fixture-connection",
    threadId: null,
  };
  const config = {
    runtime: {
      expectedCommit: commit,
      connectionId: runtime.connectionId,
      threadId: null,
    },
    bot: { qq: "10002" },
    driver: { qq: "10001" },
    groups: [
      { alias: "A", id: "20001" },
      { alias: "B", id: "20002" },
    ],
  };
  const nowSec = Math.floor(Date.now() / 1000) - 10;
  const markerA = "a".repeat(32);
  const markerB = "b".repeat(32);
  const sentinel = "qq-isolation-secret-" + "c".repeat(32);
  const runIds = ["run_seed_fixture", "run_final_fixture"];
  const specs =
    family === "seed"
      ? [
          historySeedSpec(config),
          historyRecallSpec({
            config,
            groupId: "20001",
            seedInputTime: nowSec,
            seedMarker: markerA,
            seedRunId: runIds[0],
          }),
        ]
      : [
          historyIsolationSeedSpec({ config, sentinel }),
          historyExclusionSpec({
            config,
            sourceGroupId: "20002",
            seedMarker: markerB,
            sentinel,
            sourceRunId: runIds[0],
            seedInputTime: nowSec,
          }),
        ];
  const tokens = family === "seed" ? [markerA, markerB] : [markerB, markerA];
  const cases = [];
  const acceptedCases = [];
  const traces = [];
  const leaseAudit = [];
  const db = new DatabaseSync(join(dataDirectory, "glassbox.db"));
  db.exec(`
    CREATE TABLE principals (id TEXT PRIMARY KEY, kind TEXT NOT NULL);
    CREATE TABLE conversations (id TEXT PRIMARY KEY, principal_id TEXT NOT NULL, scope_key TEXT NOT NULL);
    CREATE TABLE messages (id TEXT PRIMARY KEY, external_id TEXT NOT NULL, scope_key TEXT NOT NULL, text TEXT NOT NULL);
    CREATE TABLE runs (id TEXT PRIMARY KEY, principal_id TEXT NOT NULL, conversation_id TEXT NOT NULL, scope_json TEXT NOT NULL, status TEXT NOT NULL, message_id TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE authorization_decisions_all (id TEXT PRIMARY KEY, action TEXT NOT NULL, decision TEXT NOT NULL, run_id TEXT NOT NULL);
    CREATE TABLE deliveries (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, dedup_key TEXT NOT NULL, destination_scope_key TEXT NOT NULL, payload_text TEXT NOT NULL, payload_kind TEXT NOT NULL, status TEXT NOT NULL, external_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE channel_messages (id TEXT PRIMARY KEY, channel TEXT NOT NULL, connection_id TEXT NOT NULL, group_id TEXT NOT NULL, resource_id TEXT NOT NULL, source_class TEXT NOT NULL, external_message_id TEXT NOT NULL, sender_id TEXT NOT NULL, occurred_at TEXT NOT NULL, occurred_at_ms INTEGER NOT NULL, normalized_text TEXT NOT NULL);
  `);
  db.prepare("INSERT INTO principals VALUES (?, 'owner')").run(ownerId);

  const sourceGroup = family === "seed" ? "20001" : "20002";
  const sourceMarker = tokens[0];
  const sourceText =
    family === "seed"
      ? `seed ${sourceMarker} ${"x".repeat(60)}`
      : `seed ${sourceMarker} ${sentinel} ${"x".repeat(60)}`;
  const until = new Date(nowSec * 1000).toISOString();
  const recordId = "11111111-1111-4111-8111-111111111111";
  const seedToken = tokens[0];

  for (let index = 0; index < 2; index++) {
    const spec = specs[index];
    const token = tokens[index];
    const route =
      spec.chat === "private" ? "private" : config.groups.find((g) => g.alias === spec.chat).id;
    const prompt = `GLASSBOX_ACCEPTANCE_V1 ${token}\n${spec.prompt.replaceAll("{{nonce}}", token).trim()}`;
    const leaseTools = resolved(spec.leaseTools, token);
    const assertions = resolved(spec.featureAssertions, token);
    const runId = runIds[index];
    const chatType = route === "private" ? "private" : "group";
    const chatId = route === "private" ? config.driver.qq : route;
    const scope = {
      connectionId: runtime.connectionId,
      botId: config.bot.qq,
      chatType,
      chatId,
      senderId: config.driver.qq,
      threadId: null,
    };
    const key = scopeKey(scope);
    const time = nowSec + index * 3;
    const inputId = String(500 + index);
    const driverInputId = String(600 + index);
    const messageRowId = `message-${index}`;
    const conversationId = `conversation-${index}`;
    const deliveryId = `delivery-${index}`;
    const replyExternalId = String(700 + index);
    const driverReplyId = String(800 + index);
    const replyText = `${token} verified reply`;
    const replyHash = hash(replyText);
    const startedAt = new Date(time * 1000 - 5000).toISOString();
    const expiresAt = time * 1000 + 60 * 60 * 1000;
    const leaseId = `00000000-0000-4000-8000-00000000000${index + 1}`;
    const toolsSha256 = toolManifestDigest(leaseTools);
    const scopeSha256 = hash(key);
    const seedGroupId = family === "seed" ? "20001" : "20002";
    const searchedGroupId = index === 0 ? seedGroupId : "20001";
    const query = index === 0 ? token : seedToken;
    const toolName =
      assertions.find(
        (a) =>
          a.kind === "history_result" ||
          a.kind === "history_seed_result" ||
          a.kind === "history_exclusion_result",
      )?.tool ?? (route === "private" ? "owner_history_search" : "group_history_search");
    const toolInput =
      toolName === "group_history_search"
        ? { query, limit: 1 }
        : {
            query,
            groupIds: [searchedGroupId],
            limit: 1,
            ...((index === 1 && family === "seed") || (index === 1 && family === "isolation")
              ? { until }
              : {}),
          };
    const returned = index === 0 ? 1 : family === "isolation" ? 0 : 1;
    const output = returned ? `found ${query}` : "no matches";
    const outputHash = hash(output);
    const occurredAt = until;
    const startedReply = new Date((time + 1) * 1000).toISOString();
    const messageBinding = {
      input: {
        realSequence: String(100 + index),
        time,
        driverTime: time,
        textSha256: hash(prompt),
      },
      reply: {
        botMessageId: replyExternalId,
        driverMessageId: driverReplyId,
        realSequence: String(200 + index),
        time: time + 1,
        driverTime: time + 1,
        textSha256: replyHash,
      },
    };
    const caseRecord = {
      id: spec.id,
      status: "PASS",
      route,
      token,
      prompt,
      expected: resolved(spec.expectContains, token),
      sentMessageId: driverInputId,
      inputBinding: {
        botMessageId: inputId,
        driverMessageId: driverInputId,
        realSequence: String(100 + index),
        time,
        driverTime: time,
        textSha256: hash(prompt),
      },
      featureAssertions: assertions,
      leasedToolNames: leaseTools.map((item) => item.name),
      acceptanceLease: { leaseId, expiresAt, toolsSha256 },
      leaseRevoked: true,
      leaseRegistrationAttempted: true,
      startedAt,
      replies: [
        {
          route,
          matches: true,
          messageId: driverReplyId,
          textSha256: replyHash,
          textBytes: Buffer.byteLength(replyText, "utf8"),
          receivedAt: startedReply,
        },
      ],
      anomalies: [],
    };
    const actualFeature = {
      status: "PASS",
      runId,
      observations: expectedObservations(assertions, returned),
    };
    const delivery = {
      id: deliveryId,
      status: "sent",
      external_id: replyExternalId,
      destination_scope_key: key,
    };
    cases.push(caseRecord);
    acceptedCases.push({
      caseId: caseRecord.id,
      runId,
      scope,
      decisions: [
        {
          id: `auth-${index}`,
          action: leaseTools[0].operations[0].action,
          decision: "ALLOW",
        },
      ],
      delivery,
      traceVerified: true,
      feature: actualFeature,
      messageBinding,
    });

    db.prepare("INSERT INTO conversations VALUES (?, ?, ?)").run(conversationId, ownerId, key);
    db.prepare("INSERT INTO messages VALUES (?, ?, ?, ?)").run(messageRowId, inputId, key, prompt);
    db.prepare("INSERT INTO runs VALUES (?, ?, ?, ?, 'succeeded', ?, ?)").run(
      runId,
      ownerId,
      conversationId,
      JSON.stringify(scope),
      messageRowId,
      new Date(time * 1000).toISOString(),
    );
    db.prepare("INSERT INTO authorization_decisions_all VALUES (?, ?, 'ALLOW', ?)").run(
      `auth-${index}`,
      leaseTools[0].operations[0].action,
      runId,
    );
    db.prepare(
      "INSERT INTO deliveries VALUES (?, ?, 'fixture', ?, ?, 'text', 'sent', ?, ?, ?)",
    ).run(deliveryId, runId, key, replyText, replyExternalId, startedReply, startedReply);

    const historyItems = [];
    if (returned) {
      const snippet = historySnippet(sourceText, query);
      historyItems.push({
        resourceId: `group:${searchedGroupId}`,
        sourceId: searchedGroupId,
        rank: 1,
        score: 1,
        matchedTerms: [query],
        returnMode: "raw",
        recordId,
        textSha256: hash(snippet),
        textBytes: Buffer.byteLength(snippet, "utf8"),
        occurredAt,
        senderId: config.driver.qq,
      });
    }
    if (index === 0) {
      db.prepare(
        "INSERT INTO channel_messages VALUES (?, 'qq-onebot', ?, ?, ?, 'history', ?, ?, ?, ?, ?)",
      ).run(
        recordId,
        runtime.connectionId,
        sourceGroup,
        `group:${sourceGroup}`,
        inputId,
        config.driver.qq,
        occurredAt,
        Date.parse(occurredAt),
        sourceText,
      );
    }

    const historyEvent = {
      type: "history_retrieval",
      runId,
      query,
      groups: [searchedGroupId],
      resources: [`group:${searchedGroupId}`],
      sourceKind: "channel_message",
      retrievalMode: "lexical",
      considered: returned,
      droppedByExactTerm: 0,
      truncated: false,
      resultStatus: returned ? "matches_found" : "no_matches_in_searched_window",
      principalId: ownerId,
      conversationId,
      items: historyItems,
      toolOutput: {
        sha256: outputHash,
        bytes: Buffer.byteLength(output, "utf8"),
      },
      coverage: {
        coverage: "complete",
        requestedLimit: 1,
        groupsSearched: 1,
        perSourceCap: null,
        truncated: false,
        truncationReasons: [],
        sourceLimits: [],
        returned,
        considered: returned,
        droppedByExactTerm: 0,
        exactTerms: [query],
        sourceCoverage: [
          {
            groupId: searchedGroupId,
            capped: false,
            returned,
            considered: returned,
            sync: { stop: "end_of_source", pagesWalked: 1 },
          },
        ],
        observedAt: occurredAt,
      },
    };
    const events = [
      {
        type: "message_received",
        runId,
        conversationId,
        messageId: messageRowId,
        externalId: inputId,
        textBytes: Buffer.byteLength(prompt, "utf8"),
        textSha256: hash(prompt),
        ...scope,
      },
      { type: "delivery_changed", runId, deliveryId, status: "sending" },
      {
        type: "delivery_changed",
        runId,
        deliveryId,
        status: "sent",
        externalId: replyExternalId,
      },
      {
        type: "session_start",
        runId,
        data: {
          acceptanceLease: {
            leaseId,
            toolsSha256,
            marker: token,
            narrowedTools: leaseTools.map((item) => item.name),
          },
          authorizedTools: leaseTools.map((item) => item.name),
        },
      },
      {
        type: "tool_call",
        runId,
        toolCallId: `call-${index}`,
        data: { name: toolName, input: toolInput },
      },
      {
        type: "tool_result",
        runId,
        toolCallId: `call-${index}`,
        data: {
          name: toolName,
          isError: false,
          outputBytes: Buffer.byteLength(output, "utf8"),
          outputSha256: outputHash,
        },
      },
      historyEvent,
    ];
    traces.push({ runId, events });
    const atRegistered = new Date(time * 1000 - 3000).toISOString();
    const atBound = new Date(time * 1000 - 2000).toISOString();
    const atRevoked = new Date(time * 1000 - 1000).toISOString();
    leaseAudit.push(
      {
        event: "lease_registered",
        at: atRegistered,
        leaseId,
        principalId: ownerId,
        marker: token,
        expiresAt,
        toolsSha256,
        scopeSha256,
      },
      {
        event: "run_bound",
        at: atBound,
        leaseId,
        principalId: ownerId,
        marker: token,
        runId,
        messageId: inputId,
        textSha256: hash(prompt),
        toolsSha256,
        scopeSha256,
      },
      {
        event: "lease_revoked",
        at: atRevoked,
        leaseId,
        principalId: ownerId,
        marker: token,
        runId,
        scopeSha256,
      },
    );
  }
  db.close();
  await mkdir(join(dataDirectory, "runs"), { recursive: true });
  await writeFile(
    join(dataDirectory, "qq-live-acceptance-audit.jsonl"),
    leaseAudit.map((row) => JSON.stringify(row)).join("\n") + "\n",
  );
  for (const trace of traces) {
    const traceDir = join(dataDirectory, "runs", trace.runId);
    await mkdir(traceDir, { recursive: true });
    await writeFile(
      join(traceDir, "trace.jsonl"),
      trace.events.map((event, index) => JSON.stringify({ seq: index + 1, event })).join("\n") +
        "\n",
    );
  }
  const familyId = family === "seed" ? HISTORY_FAMILY_ID : HISTORY_ISOLATION_FAMILY_ID;
  const workflowKey = family === "seed" ? "historySeedWorkflow" : "historyIsolationWorkflow";
  const report = {
    schemaVersion: 1,
    toolVersion: "0.1.0",
    runId: "report-fixture-1",
    mode: "run",
    startedAt: new Date(nowSec * 1000).toISOString(),
    finishedAt: new Date((nowSec + 8) * 1000).toISOString(),
    reportDirectory,
    suiteSha256: "b".repeat(64),
    status: "PASS",
    workspace: { commit, dirty: false },
    runtime,
    cases,
    productAcceptance: { status: "PASS", runtime, cases: acceptedCases },
    historyFamily: { caseId: familyId },
    [workflowKey]: {
      status: "PASS",
      familyId,
      stageRunIds: runIds,
      cleanup: { required: false, leaseRevoked: true },
    },
  };
  report.historyFamilyAcceptance = {
    status: "PASS",
    caseId: familyId,
    runtime,
    stageRunIds: runIds,
    cleanup: { required: false, leaseRevoked: true },
  };
  const messageRecords = new Map();
  const putMessage = (role, messageId, selfId, senderId, route, time, sequence, text) => {
    messageRecords.set(`${role}:${messageId}`, {
      message_id: String(messageId),
      self_id: selfId,
      sender: { user_id: senderId },
      message_type: route === "private" ? "private" : "group",
      ...(route === "private" ? {} : { group_id: route }),
      real_seq: String(sequence),
      time,
      message: [{ type: "text", data: { text } }],
    });
  };
  for (let index = 0; index < cases.length; index++) {
    const item = cases[index];
    const accepted = acceptedCases[index];
    const input = item.inputBinding;
    const reply = accepted.messageBinding.reply;
    const payload = `${item.token} verified reply`;
    putMessage(
      "bot",
      input.botMessageId,
      config.bot.qq,
      config.driver.qq,
      item.route,
      input.time,
      input.realSequence,
      item.prompt,
    );
    putMessage(
      "driver",
      input.driverMessageId,
      config.driver.qq,
      config.driver.qq,
      item.route,
      input.time,
      input.realSequence,
      item.prompt,
    );
    putMessage(
      "bot",
      reply.botMessageId,
      config.bot.qq,
      config.bot.qq,
      item.route,
      reply.time,
      reply.realSequence,
      payload,
    );
    putMessage(
      "driver",
      reply.driverMessageId,
      config.driver.qq,
      config.bot.qq,
      item.route,
      reply.time,
      reply.realSequence,
      payload,
    );
  }
  class FixtureOneBot {
    constructor(_config, role) {
      this.role = role;
      this.allowed = new Set();
    }
    async connect() {}
    close() {}
    allowMessageRead(messageId) {
      this.allowed.add(String(messageId));
    }
    async call(action, parameters) {
      assert.equal(action, "get_msg");
      const messageId = String(parameters.message_id);
      assert.equal(this.allowed.has(messageId), true);
      const result = messageRecords.get(`${this.role}:${messageId}`);
      assert.ok(result, `missing ${this.role} get_msg fixture ${messageId}`);
      return result;
    }
  }
  const readerConfig = {
    ...config,
    runtime: { ...config.runtime, checkout, dataDirectory },
  };
  const reader = createHistoryLessonReader(readerConfig, {
    OneBotClass: FixtureOneBot,
  });
  t.after(() => reader.close());
  const historyBindings = (caseRecord, derivedConfig, delivery) =>
    reader.readBindings(caseRecord, derivedConfig, delivery);
  const finalCase = cases[1];
  const evidence = {
    checkout,
    dataDirectory,
    runId: runIds[1],
    scope: acceptedCases[1].scope,
  };
  const lesson = { case: finalCase.id, evidence: { runId: runIds[1] } };
  const runtimeStatus = {
    checkout,
    dataDirectory,
    headCommit: commit,
    dirty: false,
    launchCommit: commit,
    statusPids: [runtime.pid, runtime.pid],
    statusReads: 0,
  };
  const capture = (command, args, options) => {
    if (command === "git" && args[0] === "rev-parse") return `${runtimeStatus.headCommit}\n`;
    if (command === "git" && args[0] === "status")
      return runtimeStatus.dirty ? " M dirty-file\n" : "\n";
    if (args?.some((arg) => String(arg).includes("agent-service.mts"))) {
      const statusIndex = runtimeStatus.statusReads++;
      return JSON.stringify({
        dataDirectory: runtimeStatus.dataDirectory,
        glassboxReady: true,
        onebotReady: false,
        processes: [
          {
            name: "glassbox",
            running: true,
            status: "running",
            pid: runtimeStatus.statusPids[
              Math.min(statusIndex, runtimeStatus.statusPids.length - 1)
            ],
            checkout: runtimeStatus.checkout,
            launchCommit: runtimeStatus.launchCommit,
            launchClean: !runtimeStatus.dirty,
          },
        ],
      });
    }
    return execFileSync(command, args, options);
  };
  const reportPath = join(reportDirectory, "report.json");
  await mkdir(reportDirectory, { recursive: true });
  const reportBytes = Buffer.from(JSON.stringify(report));
  await writeFile(reportPath, reportBytes);
  const lessonInput = {
    case: finalCase.id,
    commit,
    status: "verified",
    evidence: { type: "run", runId: runIds[1] },
    symptom: "The archived Owner history stages need verification.",
    lesson: "Both historical stages matched their stored evidence.",
    nextStep: "Recheck both Runs before recording another history lesson.",
    verification: {
      type: "qq_live_report",
      reportPath,
      reportSha256: hash(reportBytes.toString("utf8")),
    },
  };
  return {
    report,
    lesson,
    lessonInput,
    evidence,
    capture,
    reportPath,
    runtimeStatus,
    historyBindings,
    lessonsPath: join(temp, "lessons.jsonl"),
    dbPath: join(dataDirectory, "glassbox.db"),
  };
}

for (const family of ["seed", "isolation"]) {
  test(`archived ${family} family verifies both SQLite/Trace stages without QQ replay`, async (t) => {
    const fixture = await archivedFixture(t, family);
    const saved = await appendLesson(fixture.lessonInput, fixture.lessonsPath, {
      capture: fixture.capture,
      historyBindings: fixture.historyBindings,
    });
    assert.equal(saved.status, "verified");
    assert.equal(saved.evidence.runId, fixture.lesson.evidence.runId);
    assert.match(saved.evidence.reportSha256, /^[a-f0-9]{64}$/);
    const stored = await readFile(fixture.lessonsPath, "utf8");
    assert.equal(stored.includes("qq-isolation-secret-"), false);
    assert.equal(stored.includes("seed "), false);
  });
}

test("archived isolation rejects missing family assertions, stale run, false payload hash, sentinel leakage, and unknown delivery", async (t) => {
  const passing = async () => {
    const fixture = await archivedFixture(t, "isolation");
    const lesson = await appendLesson(fixture.lessonInput, fixture.lessonsPath, {
      capture: fixture.capture,
      historyBindings: fixture.historyBindings,
    });
    assert.equal(lesson.status, "verified");
    return fixture;
  };
  const persistReport = async (fixture) => {
    const bytes = Buffer.from(JSON.stringify(fixture.report));
    await writeFile(fixture.reportPath, bytes);
    fixture.lessonInput.verification.reportSha256 = hash(bytes.toString("utf8"));
  };
  const reject = async (fixture, label) => {
    await assert.rejects(
      appendLesson(fixture.lessonInput, join(fixture.evidence.dataDirectory, `${label}.jsonl`), {
        capture: fixture.capture,
        historyBindings: fixture.historyBindings,
      }),
    );
  };

  let fixture = await passing();
  delete fixture.report.historyIsolationWorkflow;
  await persistReport(fixture);
  await reject(fixture, "missing-workflow");

  fixture = await passing();
  fixture.report.historyIsolationWorkflow.stageRunIds[0] = "missing_source_run";
  await persistReport(fixture);
  await reject(fixture, "wrong-source-run");

  fixture = await passing();
  fixture.report.cases[1].featureAssertions = fixture.report.cases[1].featureAssertions.filter(
    (assertion) => assertion.kind !== "history_exclusion_result",
  );
  await persistReport(fixture);
  await reject(fixture, "missing-exclusion-assertion");

  fixture = await passing();
  const forgedDb = new DatabaseSync(fixture.dbPath);
  forgedDb.prepare("UPDATE deliveries SET payload_text='forged reply' WHERE id='delivery-1'").run();
  forgedDb.close();
  await reject(fixture, "forged-reply-hash");

  fixture = await passing();
  const forgedReply = "forged archived reply";
  const forgedReplyHash = hash(forgedReply);
  fixture.report.cases[1].replies[0].textSha256 = forgedReplyHash;
  fixture.report.cases[1].replies[0].textBytes = Buffer.byteLength(forgedReply, "utf8");
  fixture.report.productAcceptance.cases[1].messageBinding.reply.textSha256 = forgedReplyHash;
  const forgedBindingDb = new DatabaseSync(fixture.dbPath);
  forgedBindingDb
    .prepare("UPDATE deliveries SET payload_text=? WHERE id='delivery-1'")
    .run(forgedReply);
  forgedBindingDb.close();
  await persistReport(fixture);
  await reject(fixture, "forged-message-binding");

  fixture = await passing();
  const sentinel = fixture.report.cases[0].prompt.match(/qq-isolation-secret-[a-f0-9]{32}/)[0];
  const leakingText = `leaked ${sentinel.toUpperCase()}`;
  const leakingHash = hash(leakingText);
  const finalCase = fixture.report.cases[1];
  finalCase.replies[0].textSha256 = leakingHash;
  finalCase.replies[0].textBytes = Buffer.byteLength(leakingText, "utf8");
  fixture.report.productAcceptance.cases[1].messageBinding.reply.textSha256 = leakingHash;
  const leakDb = new DatabaseSync(fixture.dbPath);
  leakDb.prepare("UPDATE deliveries SET payload_text=? WHERE id='delivery-1'").run(leakingText);
  leakDb.close();
  await persistReport(fixture);
  await reject(fixture, "casefold-sentinel-leak");

  fixture = await passing();
  const unknownDb = new DatabaseSync(fixture.dbPath);
  unknownDb
    .prepare(
      "INSERT INTO deliveries VALUES ('delivery-extra','run_final_fixture','extra',?,'extra','text','unknown','unknown-reply',?,?)",
    )
    .run(
      JSON.stringify(["fixture-connection", "10002", "private", "10001", "10001", null]),
      new Date().toISOString(),
      new Date().toISOString(),
    );
  unknownDb.close();
  await reject(fixture, "unknown-delivery");

  fixture = await passing();
  const sourceDb = new DatabaseSync(fixture.dbPath);
  sourceDb.prepare("DELETE FROM channel_messages").run();
  sourceDb.close();
  await reject(fixture, "missing-source-row");

  fixture = await passing();
  const sourceRunDb = new DatabaseSync(fixture.dbPath);
  sourceRunDb.prepare("DELETE FROM runs WHERE id='run_seed_fixture'").run();
  sourceRunDb.close();
  await reject(fixture, "missing-source-run");

  fixture = await passing();
  const auditPath = join(fixture.evidence.dataDirectory, "qq-live-acceptance-audit.jsonl");
  const finalLeaseId = fixture.report.cases[1].acceptanceLease.leaseId;
  const auditRows =
    (await readFile(auditPath, "utf8"))
      .split("\n")
      .filter(
        (line) =>
          line &&
          !(
            JSON.parse(line).event === "lease_revoked" && JSON.parse(line).leaseId === finalLeaseId
          ),
      )
      .join("\n") + "\n";
  await writeFile(auditPath, auditRows);
  await reject(fixture, "missing-revocation-audit");

  fixture = await passing();
  fixture.runtimeStatus.statusPids = [9999, 9999];
  await reject(fixture, "runtime-pid-mismatch");

  fixture = await passing();
  fixture.runtimeStatus.dirty = true;
  await reject(fixture, "runtime-dirty-checkout");

  fixture = await passing();
  fixture.runtimeStatus.launchCommit = "d".repeat(40);
  await reject(fixture, "runtime-launch-commit-mismatch");

  fixture = await passing();
  fixture.runtimeStatus.statusPids = [fixture.report.runtime.pid, fixture.report.runtime.pid + 1];
  await reject(fixture, "runtime-changed-during-archive-read");
});
