import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { sanitizedGitEnvironment } from "../../../scripts/git-environment.mjs";
import { createHash } from "node:crypto";
import { lstat, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { digest, toolManifestDigest } from "../lib/core.mjs";
import {
  moderationRecoveryRunId,
  verifyModerationRecoveryStop,
  verifyModerationAttempt,
  verifyModerationCheckpointChain,
  verifyModerationNoEffectTrace,
  planModerationKnownNoEffectRecovery,
  archiveModerationKnownNoEffectRecovery,
} from "../lib/moderation-no-effect-recovery.mjs";
import {
  MODERATION_FAMILY_ID,
  MODERATION_GROUP_B_ID,
  moderationPlan,
  moderationStep,
} from "../lib/moderation-scenario.mjs";
import { baseConfig } from "./fixture.mjs";

const runId = "46382058-a4b6-4b80-807d-54c21538487e";
const principalId = "owner";
const conversationId = "123e4567-e89b-42d3-a456-426614174000";
const messageId = "578511045";
const deliveryId = "116ce65f-0a16-4125-b76b-b2667b8140ff";
const leaseId = "123e4567-e89b-42d3-a456-426614174001";
const marker = "1234567890abcdef1234567890abcdef";
const toolsSha256 = "a".repeat(64);
const output = '{"content":[{"type":"text","text":"mutation_not_requested"}],"details":{}}';
const outputSha256 = createHash("sha256").update(output).digest("hex");
const prompt = "GLASSBOX_ACCEPTANCE_V1 1234567890abcdef1234567890abcdef\n请按要求检查。";
const textSha256 = createHash("sha256").update(prompt).digest("hex");

function fixture({
  startedAt = new Date(Date.now() - 20_000).toISOString(),
  promptText = prompt,
  inputMessageId = messageId,
  runConversationId = conversationId,
  deliveryExternalId = "578511046",
  tracePrincipalId = principalId,
  traceLeaseId = leaseId,
  traceMarker = marker,
  traceToolsSha256 = toolsSha256,
} = {}) {
  const events = [
    {
      type: "message_received",
      runId,
      externalId: inputMessageId,
      conversationId: runConversationId,
      textSha256: digest(promptText),
      textBytes: Buffer.byteLength(promptText),
      connectionId: "qq-main",
      botId: "3394947361",
      chatType: "private",
      chatId: "3526039967",
      senderId: "3526039967",
    },
    { type: "run_started", runId, conversationId: runConversationId },
    {
      type: "session_start",
      runId,
      principalId: tracePrincipalId,
      data: {
        runId,
        principalId: tracePrincipalId,
        conversationId: runConversationId,
        authorizedTools: ["qq_group_moderation"],
        acceptanceLease: {
          leaseId: traceLeaseId,
          marker: traceMarker,
          toolsSha256: traceToolsSha256,
          narrowedTools: ["qq_group_moderation"],
        },
      },
    },
    { type: "turn_start", runId },
    {
      type: "tool_call",
      runId,
      principalId: tracePrincipalId,
      toolCallId: "call-1",
      data: {
        runId,
        principalId: tracePrincipalId,
        toolCallId: "call-1",
        name: "qq_group_moderation",
        input: { groupId: MODERATION_GROUP_B_ID, operation: "set_group_ban" },
      },
    },
    {
      type: "tool_result",
      runId,
      principalId: tracePrincipalId,
      toolCallId: "call-1",
      data: {
        runId,
        principalId: tracePrincipalId,
        toolCallId: "call-1",
        name: "qq_group_moderation",
        isError: true,
        failureCode: "tool_execution_failed",
        outputHead: output,
        outputBytes: 74,
        outputSha256,
        outputTruncated: false,
      },
    },
    { type: "run_finished", runId, status: "failed", failureCode: "required_action_not_completed" },
    { type: "delivery_changed", runId, deliveryId, status: "sending" },
    { type: "delivery_changed", runId, deliveryId, status: "sent", externalId: deliveryExternalId },
  ];
  const startMs = Date.parse(startedAt);
  return {
    runId,
    events: events.map((event, index) => ({
      seq: index + 1,
      ts: new Date(startMs + (index + 1) * 1000).toISOString(),
      event,
    })),
  };
}
const evidence = {
  runId,
  executionRef: "fixture",
  principalId,
  conversationId,
  delivery: { id: deliveryId, external_id: "578511046" },
};
const caseRecord = {
  inputBinding: { botMessageId: messageId, textSha256 },
  prompt,
  acceptanceLease: { leaseId, toolsSha256 },
  token: marker,
};

test("accepts a complete, contiguous trace with the exact fixed refusal", () => {
  const proof = verifyModerationNoEffectTrace(fixture(), evidence, caseRecord);
  assert.equal(proof.traceComplete, true);
  assert.equal(proof.traceEventCount, 9);
  assert.equal(proof.callTraceSequence, 5);
  assert.equal(proof.resultTraceSequence, 6);
  assert.equal(proof.terminalTraceSequence, 7);
  assert.equal(proof.calledParamsUnrecorded, true);
  assert.equal(proof.optionsInvokeReached, false);
});

test("rejects sequence gaps, even when call and result still match", () => {
  const trace = fixture();
  trace.events[4].seq = 50;
  assert.throws(
    () => verifyModerationNoEffectTrace(trace, evidence, caseRecord),
    (error) => error?.code === "MODERATION_RECOVERY_TRACE_GAP",
  );
});

test("rejects an incomplete trace without run_finished", () => {
  const trace = fixture();
  trace.events.splice(6, 1);
  trace.events.forEach((row, index) => {
    row.seq = index + 1;
  });
  assert.throws(
    () => verifyModerationNoEffectTrace(trace, evidence, caseRecord),
    (error) => error?.code === "MODERATION_RECOVERY_TRACE",
  );
});

test("rejects a different error payload with the same refusal phrase", () => {
  const trace = fixture();
  const result = trace.events[5].event;
  result.data.outputHead = output + " ";
  result.data.outputBytes = Buffer.byteLength(result.data.outputHead);
  result.data.outputSha256 = createHash("sha256").update(result.data.outputHead).digest("hex");
  assert.throws(
    () => verifyModerationNoEffectTrace(trace, evidence, caseRecord),
    (error) => error?.code === "MODERATION_RECOVERY_TRACE",
  );
});

test("rejects a changed target scope, mismatched tool identity, or delivery", () => {
  const trace = fixture();
  trace.events[4].event.data.input.groupId = "1121579672";
  assert.throws(() => verifyModerationNoEffectTrace(trace, evidence, caseRecord));

  const mismatched = fixture();
  mismatched.events[5].event.toolCallId = "other-call";
  assert.throws(() => verifyModerationNoEffectTrace(mismatched, evidence, caseRecord));

  const wrongDelivery = fixture();
  wrongDelivery.events[8].event.externalId = "578511099";
  assert.throws(() => verifyModerationNoEffectTrace(wrongDelivery, evidence, caseRecord));
});

test("accepts the actual report ID grammar and exact STOP file bytes", () => {
  assert.equal(
    moderationRecoveryRunId(
      "/home/yanbingzhao/.glassbox/qq-live-evidence/2026-10-08T04-23-21.385Z_451e95f5/report.json",
    ),
    "2026-10-08T04-23-21.385Z_451e95f5",
  );
  const stop = Buffer.from(
    "CLEANUP_UNCONFIRMED\n请先检查 Bot 的延迟任务、目标状态和本轮报告，再人工删除此文件。\n",
    "utf8",
  );
  assert.doesNotThrow(() => verifyModerationRecoveryStop(stop));
  assert.throws(() =>
    verifyModerationRecoveryStop(
      Buffer.from(
        "CLEANUP_UNCONFIRMED\\n请先检查 Bot 的延迟任务、目标状态和本轮报告，再人工删除此文件。\\n",
        "utf8",
      ),
    ),
  );
  assert.equal(
    moderationRecoveryRunId("/tmp/2026-10-08T04-23-21.385Z_451e95f5/report.json"),
    "2026-10-08T04-23-21.385Z_451e95f5",
  );
  assert.throws(() => moderationRecoveryRunId("/tmp/not-a-report-id/report.json"));
});

function checkpointFixture() {
  const reportDirectory = "/tmp/2026-10-08T04-23-21.385Z_451e95f5";
  const runtime = {
    checkout: "/tmp/source",
    commit: "a".repeat(40),
    sourceTreeSha256: "b".repeat(64),
  };
  const identity = {
    familyId: MODERATION_FAMILY_ID,
    reportDirectory,
    suiteSha256: "c".repeat(64),
    driverSha256: "d".repeat(64),
    runtime,
    processIdentity: {
      pid: 123,
      bootId: "123e4567-e89b-42d3-a456-426614174000",
      startTicks: "456",
    },
  };
  const baseline = {
    connectionId: "qq-main",
    grantId: "grant-b",
    policyVersion: 4,
    moderationEnabled: true,
    groupId: MODERATION_GROUP_B_ID,
    principalId: "owner",
    scopeKey: "fixed-private-scope",
    grantCreatedAt: "2026-10-01T00:00:00.000Z",
    policyUpdatedAt: "2026-10-01T00:00:00.000Z",
  };
  const c = {
    id: "moderation-mute",
    token: marker,
    prompt,
    moderationExpectedMuteUntil: 1790165178,
    sentMessageId: messageId,
    acceptanceLease: { leaseId, toolsSha256, expiresAt: 1790160000 },
  };
  const prep = {
    caseId: c.id,
    marker,
    promptSha256: createHash("sha256").update(prompt).digest("hex"),
    expectedMuteUntil: 1790165178,
  };
  const observations = [
    {
      phase: "intent",
      baseline,
      mutationPrecondition: {
        kind: "qq-member-mute-state",
        phase: "mute",
        expectedMuteUntil: 1790165178,
      },
    },
    { phase: "lease_intent", baseline, prepared: prep },
    {
      phase: "prepared",
      baseline,
      prepared: { ...prep, expiresAt: 1790160000, leaseId, toolsSha256 },
    },
    { phase: "sent", baseline, sent: { caseId: c.id, marker, driverMessageId: messageId } },
  ].map((row, index) => ({
    schemaVersion: 1,
    sequence: index + 1,
    recordedAt: "2026-10-08T04:23:21.000Z",
    previousSha256: null,
    identity,
    observation: { familyId: MODERATION_FAMILY_ID, stage: "mute", runtime, steps: [], ...row },
  }));
  for (let i = 1; i < observations.length; i++)
    observations[i].previousSha256 = digest(JSON.stringify(observations[i - 1]));
  const pending = observations.at(-1);
  const report = { suiteSha256: identity.suiteSha256, runtime, cases: [c] };
  return { reportDirectory, runtime, identity, baseline, observations, pending, report };
}

test("validates the real four-phase checkpoint shape without copying intent into sent", () => {
  const f = checkpointFixture();
  const bytes = Buffer.from(`${f.observations.map((row) => JSON.stringify(row)).join("\n")}\n`);
  const result = verifyModerationCheckpointChain(bytes, f.pending, f.report, {
    reportDirectory: f.reportDirectory,
  });
  assert.equal(result.expectedMuteUntil, 1790165178);
  assert.equal(Object.hasOwn(f.pending.observation, "mutationPrecondition"), false);
});

test("rejects altered prepared lease evidence in the four-phase checkpoint", () => {
  const f = checkpointFixture();
  f.observations[2].observation.prepared.leaseId = "123e4567-e89b-42d3-a456-426614174099";
  f.observations[2].previousSha256 = digest(JSON.stringify(f.observations[1]));
  f.observations[3].previousSha256 = digest(JSON.stringify(f.observations[2]));
  f.pending = f.observations.at(-1);
  const bytes = Buffer.from(`${f.observations.map((row) => JSON.stringify(row)).join("\n")}\n`);
  assert.throws(() =>
    verifyModerationCheckpointChain(bytes, f.pending, f.report, {
      reportDirectory: f.reportDirectory,
    }),
  );
});

test("binds the producer STARTED attempt shape to the failed report", () => {
  const report = { startedAt: "2026-10-08T04:23:21.000Z" };
  const attempt = {
    runId: "2026-10-08T04-23-21.385Z_451e95f5",
    mode: "run",
    startedAt: report.startedAt,
    status: "STARTED",
  };
  assert.deepEqual(verifyModerationAttempt(attempt, report, attempt.runId), attempt);
  assert.throws(() =>
    verifyModerationAttempt({ ...attempt, processIdentity: {} }, report, attempt.runId),
  );
  assert.throws(() =>
    verifyModerationAttempt({ ...attempt, status: "DONE" }, report, attempt.runId),
  );
  assert.throws(() => verifyModerationAttempt(attempt, report, "different-run"));
});

const v9Commit = "7ad1f9e8481ee540bacc2117af12569e39e61315";
const v9Tree = "05cf20f195badd1b1c34e11b74c365c1a7ebeb87dc946289033353ca7ee1f99e";

async function planEntryFixture(t, { attemptStatus = "STARTED" } = {}) {
  const root = await mkdtemp(join(tmpdir(), "moderation-recovery-entry-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const out = join(root, "out");
  const locksDirectory = join(root, "locks");
  const dataDirectory = join(root, "data");
  const v9Checkout = join(root, "source");
  await Promise.all([
    mkdir(out, { mode: 0o700 }),
    mkdir(locksDirectory, { mode: 0o700 }),
    mkdir(dataDirectory, { mode: 0o700 }),
    mkdir(v9Checkout, { mode: 0o700 }),
  ]);
  for (const relative of [
    "apps/server/src/runtime/pi/protected-tools.ts",
    "apps/server/src/runtime/pi/capability-tools.ts",
  ]) {
    const destination = join(v9Checkout, relative);
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    const pinnedSource = execFileSync("git", ["show", `${v9Commit}:${relative}`], {
      cwd: process.cwd(),
      maxBuffer: 5 * 1024 * 1024,
      env: sanitizedGitEnvironment(),
    });
    await writeFile(destination, pinnedSource, { mode: 0o600 });
  }

  const startMs = Date.now() - 20_000;
  const startedAt = new Date(startMs).toISOString();
  const finishedAt = new Date(startMs + 15_000).toISOString();
  const runId = `${startedAt.replaceAll(":", "-").replace(".000Z", ".000Z")}_${createHash("sha256").update(root).digest("hex").slice(0, 8)}`;
  const reportDirectory = join(out, runId);
  await mkdir(reportDirectory, { mode: 0o700 });

  const config = baseConfig();
  config.driver.qq = "3526039967";
  config.bot.qq = "3394947361";
  config.groups[1].id = MODERATION_GROUP_B_ID;
  config.moderation.group = "B";
  config.moderation.target = "3526000001";
  config.moderation.authorizationBasis = "group-owner-request";
  config.moderation.ownerAuthorizationConfirmed = true;
  config.moderation.ownerAuthorizationAt = new Date(startMs - 1000).toISOString();
  config.moderation.ownerAuthorizationUntil = new Date(startMs + 3_600_000).toISOString();
  config.moderation.consentConfirmed = false;
  config.moderation.consentConfirmedAt = "";
  config.moderation.consentUntil = "";
  config.moderation.durationSeconds = 30;
  config.runtime = {
    checkout: v9Checkout,
    dataDirectory,
    expectedCommit: v9Commit,
    expectedSourceTreeSha256: v9Tree,
    connectionId: "qq-main",
    threadId: null,
  };

  const originalMuteUntil = 0;
  const fixed = moderationPlan(config, startMs).fixed;
  const step = moderationStep("mute", { ...fixed, expectedMuteUntil: originalMuteUntil });
  const expectedPrompt = `GLASSBOX_ACCEPTANCE_V1 ${marker}\n${step.prompt.replaceAll("{{nonce}}", marker)}`;
  const expectedTools = JSON.parse(JSON.stringify(step.leaseTools).replaceAll("{{nonce}}", marker));
  const leaseExpiry = Date.now() + 600_000;
  const replyText = "固定只读测试回复";
  const replyId = "578511046";
  const outboundId = "578511047";
  const suiteSha256 = moderationPlan(config, startMs).suiteSha256;
  const toolsDigest = toolManifestDigest(expectedTools);
  const report = {
    schemaVersion: 1,
    mode: "run",
    runId,
    reportDirectory,
    status: "INCONCLUSIVE",
    startedAt,
    finishedAt,
    safetyStopCreated: true,
    suiteSha256,
    runtime: {
      checkout: v9Checkout,
      dataDirectory,
      commit: v9Commit,
      pid: 1234,
      connectionId: "qq-main",
      threadId: null,
      development: true,
      sourceTreeSha256: v9Tree,
    },
    productAcceptance: {
      status: "INCONCLUSIVE",
      cleanupRequired: true,
      cleanupVerified: false,
      runtime: {
        checkout: v9Checkout,
        dataDirectory,
        commit: v9Commit,
        pid: 1234,
        connectionId: "qq-main",
        threadId: null,
        development: true,
        sourceTreeSha256: v9Tree,
      },
      cases: [],
    },
    cases: [
      {
        id: "moderation-mute",
        status: "FAIL",
        code: "REPLY_ASSERTION_FAILED",
        route: "private",
        moderation: true,
        moderationStage: "mute",
        moderationGroupId: MODERATION_GROUP_B_ID,
        leaseRegistrationAttempted: true,
        leaseRevoked: true,
        sendAttempted: true,
        inputObserved: true,
        moderationAuthorizationBasis: "group-owner-request",
        replies: [
          {
            route: "private",
            matches: false,
            messageId: replyId,
            textSha256: digest(replyText),
            textBytes: Buffer.byteLength(replyText),
            receivedAt: finishedAt,
          },
        ],
        notices: [],
        acceptanceLease: { leaseId, toolsSha256: toolsDigest, expiresAt: leaseExpiry },
        moderationTarget: config.moderation.target,
        moderationExpectedMuteUntil: originalMuteUntil,
        moderationOwnerAuthorization: {
          ownerId: config.driver.qq,
          confirmed: true,
          authorizedAt: config.moderation.ownerAuthorizationAt,
          validUntil: config.moderation.ownerAuthorizationUntil,
        },
        leasedToolNames: ["qq_group_moderation"],
        prompt: expectedPrompt,
        token: marker,
        inputBinding: {
          driverMessageId: messageId,
          botMessageId: "578511045",
          textSha256: digest(expectedPrompt),
        },
        sentMessageId: messageId,
        startedAt,
        finishedAt,
      },
    ],
  };
  const account = createHash("sha256").update(config.driver.qq).digest("hex").slice(0, 24);
  const identity = {
    familyId: MODERATION_FAMILY_ID,
    reportDirectory,
    suiteSha256,
    driverSha256: createHash("sha256").update(config.driver.qq).digest("hex"),
    runtime: report.runtime,
    processIdentity: {
      pid: 4321,
      bootId: "123e4567-e89b-42d3-a456-426614174000",
      startTicks: "56789",
    },
  };
  const scope = {
    connectionId: "qq-main",
    botId: config.bot.qq,
    chatType: "private",
    chatId: config.driver.qq,
    senderId: config.driver.qq,
  };
  const scopeKey = JSON.stringify([
    scope.connectionId,
    scope.botId,
    scope.chatType,
    scope.chatId,
    scope.senderId,
    null,
  ]);
  const baseline = {
    connectionId: "qq-main",
    groupId: MODERATION_GROUP_B_ID,
    principalId: "owner-principal",
    scopeKey,
    policyVersion: 9,
    policyUpdatedAt: new Date(startMs - 60_000).toISOString(),
    moderationEnabled: true,
    grantId: "group-moderate-grant",
    grantCreatedAt: new Date(startMs - 60_000).toISOString(),
  };
  const prep = {
    caseId: "moderation-mute",
    marker,
    promptSha256: digest(expectedPrompt),
    expectedMuteUntil: originalMuteUntil,
  };
  const observations = [
    {
      phase: "intent",
      baseline,
      mutationPrecondition: {
        kind: "qq-member-mute-state",
        phase: "mute",
        expectedMuteUntil: originalMuteUntil,
      },
    },
    { phase: "lease_intent", baseline, prepared: prep },
    {
      phase: "prepared",
      baseline,
      prepared: { ...prep, expiresAt: leaseExpiry, leaseId, toolsSha256: toolsDigest },
    },
    {
      phase: "sent",
      baseline,
      sent: { caseId: "moderation-mute", marker, driverMessageId: messageId },
    },
  ].map((row, index) => ({
    schemaVersion: 1,
    sequence: index + 1,
    recordedAt: new Date(startMs + index * 1000).toISOString(),
    previousSha256: null,
    identity,
    observation: {
      familyId: MODERATION_FAMILY_ID,
      stage: "mute",
      runtime: report.runtime,
      steps: [],
      ...row,
    },
  }));
  for (let index = 1; index < observations.length; index++)
    observations[index].previousSha256 = digest(JSON.stringify(observations[index - 1]));
  const pending = observations.at(-1);
  await writeFile(join(reportDirectory, "report.json"), JSON.stringify(report), { mode: 0o600 });
  await writeFile(
    join(reportDirectory, "attempt.json"),
    JSON.stringify({
      runId,
      mode: "run",
      startedAt,
      status: attemptStatus,
    }),
    { mode: 0o600 },
  );
  await writeFile(
    join(reportDirectory, "moderation.checkpoint.jsonl"),
    `${observations.map((row) => JSON.stringify(row)).join("\n")}\n`,
    { mode: 0o600 },
  );
  await writeFile(
    join(out, "STOP"),
    "CLEANUP_UNCONFIRMED\n请先检查 Bot 的延迟任务、目标状态和本轮报告，再人工删除此文件。\n",
    { mode: 0o600 },
  );
  await writeFile(
    join(locksDirectory, `${account}.moderation-pending.json`),
    JSON.stringify(pending),
    { mode: 0o600 },
  );

  const db = new DatabaseSync(join(dataDirectory, "glassbox.db"));
  db.exec("PRAGMA journal_mode=DELETE; PRAGMA user_version=29;");
  db.exec(`
    CREATE TABLE principals(id TEXT PRIMARY KEY,kind TEXT);
    CREATE TABLE channel_identities(identity_key TEXT,principal_id TEXT);
    CREATE TABLE grants(id TEXT PRIMARY KEY,principal_id TEXT,resource_id TEXT,action TEXT,scope_key TEXT,effect TEXT,revoked_at TEXT,created_at TEXT);
    CREATE TABLE group_capability_policies(connection_id TEXT,group_id TEXT,policy_json TEXT,version INTEGER,updated_by_principal_id TEXT,updated_at TEXT);
    CREATE TABLE messages(id TEXT PRIMARY KEY,conversation_id TEXT,scope_key TEXT,external_id TEXT,text TEXT,created_at TEXT);
    CREATE TABLE runs(id TEXT PRIMARY KEY,conversation_id TEXT,message_id TEXT,principal_id TEXT,scope_json TEXT,execution_ref TEXT,status TEXT,failure_code TEXT,result_text TEXT,created_at TEXT,updated_at TEXT);
    CREATE TABLE authorization_decisions(id TEXT PRIMARY KEY,principal_id TEXT,resource_id TEXT,action TEXT,scope_key TEXT,decision TEXT,reason TEXT,grant_id TEXT,approval_id TEXT,conversation_id TEXT,run_id TEXT,delivery_source TEXT,created_at TEXT);
    CREATE TABLE authorization_decisions_archive(id TEXT PRIMARY KEY,principal_id TEXT,resource_id TEXT,action TEXT,scope_key TEXT,decision TEXT,reason TEXT,grant_id TEXT,approval_id TEXT,conversation_id TEXT,run_id TEXT,delivery_source TEXT,created_at TEXT);
    CREATE VIEW authorization_decisions_all AS SELECT * FROM authorization_decisions UNION ALL SELECT * FROM authorization_decisions_archive;
    CREATE TABLE deliveries(id TEXT PRIMARY KEY,run_id TEXT,status TEXT,external_id TEXT,destination_scope_key TEXT,payload_text TEXT NOT NULL,payload_kind TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
  `);
  db.prepare("INSERT INTO principals VALUES ('owner-principal','owner')").run();
  db.prepare("INSERT INTO channel_identities VALUES (?, 'owner-principal')").run(
    JSON.stringify(["qq-main", config.bot.qq, config.driver.qq]),
  );
  db.prepare(
    "INSERT INTO grants VALUES ('group-moderate-grant','owner-principal',?,'group:moderate',?,'allow',NULL,?)",
  ).run(`group:${MODERATION_GROUP_B_ID}`, scopeKey, baseline.grantCreatedAt);
  db.prepare(
    "INSERT INTO group_capability_policies VALUES ('qq-main',?,?,9,'owner-principal',?)",
  ).run(
    MODERATION_GROUP_B_ID,
    JSON.stringify({ categories: { "group.moderate": true } }),
    baseline.policyUpdatedAt,
  );
  const productRunId = "46382058-a4b6-4b80-807d-54c21538487e";
  const productConversationId = conversationId;
  db.prepare("INSERT INTO messages VALUES ('input-message',?,?,?, ?,?)").run(
    productConversationId,
    scopeKey,
    "578511045",
    expectedPrompt,
    startedAt,
  );
  db.prepare(
    "INSERT INTO runs VALUES (?,?,?,?,?,'fixture','failed','required_action_not_completed',NULL,?,?)",
  ).run(
    productRunId,
    productConversationId,
    "input-message",
    "owner-principal",
    JSON.stringify(scope),
    new Date(startMs + 1000).toISOString(),
    finishedAt,
  );
  for (const id of ["decision-select", "decision-execute"])
    db.prepare(
      "INSERT INTO authorization_decisions VALUES (?,?,?,?,?,'ALLOW','explicit_grant','group-moderate-grant',NULL,?,?,NULL,?)",
    ).run(
      id,
      "owner-principal",
      `group:${MODERATION_GROUP_B_ID}`,
      "group:moderate",
      scopeKey,
      productConversationId,
      productRunId,
      new Date(startMs + 1000).toISOString(),
    );
  db.prepare("INSERT INTO deliveries VALUES (?,?, 'sent', ?,?,?,'result',?,?)").run(
    deliveryId,
    productRunId,
    outboundId,
    scopeKey,
    replyText,
    startedAt,
    finishedAt,
  );
  db.close();

  const scopeHash = createHash("sha256")
    .update(
      JSON.stringify([
        scope.connectionId,
        scope.botId,
        scope.chatType,
        scope.chatId,
        scope.senderId,
        null,
      ]),
    )
    .digest("hex");
  const audit = [
    {
      event: "lease_registered",
      leaseId,
      principalId: "owner-principal",
      marker,
      expiresAt: leaseExpiry,
      toolsSha256: toolsDigest,
      scopeSha256: scopeHash,
      at: startedAt,
    },
    {
      event: "run_bound",
      leaseId,
      principalId: "owner-principal",
      marker,
      runId: productRunId,
      messageId: messageId,
      textSha256: digest(expectedPrompt),
      toolsSha256: toolsDigest,
      scopeSha256: scopeHash,
      at: new Date(startMs + 1000).toISOString(),
    },
    {
      event: "lease_revoked",
      leaseId,
      principalId: "owner-principal",
      marker,
      runId: productRunId,
      scopeSha256: scopeHash,
      at: new Date(startMs + 3000).toISOString(),
    },
  ];
  await writeFile(
    join(dataDirectory, "qq-live-acceptance-audit.jsonl"),
    `${audit.map((row) => JSON.stringify(row)).join("\n")}\n`,
    { mode: 0o600 },
  );

  const runtime = { ...report.runtime };
  const readNativeState = async () => ({
    bot: {
      account: "bot",
      groupId: MODERATION_GROUP_B_ID,
      targetId: config.moderation.target,
      role: "member",
      muteUntil: originalMuteUntil,
    },
    driver: {
      account: "driver",
      groupId: MODERATION_GROUP_B_ID,
      targetId: config.moderation.target,
      role: "member",
      muteUntil: originalMuteUntil,
    },
  });
  const clients = {
    bot: {
      async call(action, params) {
        assert.equal(action, "get_group_member_info");
        assert.equal(String(params.group_id), MODERATION_GROUP_B_ID);
        assert.equal(String(params.user_id), config.driver.qq);
        return {
          group_id: Number(MODERATION_GROUP_B_ID),
          user_id: Number(config.driver.qq),
          role: "owner",
        };
      },
    },
  };
  const dependencies = {
    readRuntime: async () => runtime,
    readTrace: async (_runtime, id) => {
      assert.equal(id, productRunId);
      return fixture({
        startedAt,
        promptText: report.cases[0].prompt,
        inputMessageId: report.cases[0].inputBinding.botMessageId,
        runConversationId: conversationId,
        deliveryExternalId: outboundId,
        tracePrincipalId: "owner-principal",
        traceLeaseId: leaseId,
        traceMarker: marker,
        traceToolsSha256: toolsDigest,
      });
    },
    readNativeState,
    verifyStopped: async (processIdentity) => ({ stopped: true, identity: processIdentity }),
  };
  return {
    reportPath: join(reportDirectory, "report.json"),
    out,
    config,
    clients,
    locksDirectory,
    dependencies,
    report,
    runtime,
    observations,
    startedAt,
  };
}

test("plan entrypoint binds outgoing delivery without inventing incoming reply rows", async (t) => {
  const f = await planEntryFixture(t);
  const planned = await planModerationKnownNoEffectRecovery(
    {
      reportPath: f.reportPath,
      config: f.config,
      clients: f.clients,
      locksDirectory: f.locksDirectory,
    },
    f.dependencies,
  );
  assert.equal(planned.status, "MODERATION_KNOWN_NO_EFFECT_RECOVERY_PLANNED");
  assert.equal(planned.plan.cleanupOnly, true);
  assert.equal(planned.plan.featurePass, false);
  assert.equal(planned.plan.featureStatus, "INCONCLUSIVE");
  assert.equal(planned.plan.caseOutcome, "FAIL");
  assert.equal(planned.plan.proof.call.calledParamsUnrecorded, true);
  assert.equal(planned.plan.proof.call.traceComplete, true);
});

test("plan entrypoint rejects a terminalized attempt.json because the producer keeps STARTED", async (t) => {
  const f = await planEntryFixture(t, { attemptStatus: "FAILED" });
  await assert.rejects(
    planModerationKnownNoEffectRecovery(
      {
        reportPath: f.reportPath,
        config: f.config,
        clients: f.clients,
        locksDirectory: f.locksDirectory,
      },
      f.dependencies,
    ),
    (error) => error?.code === "MODERATION_RECOVERY_ATTEMPT",
  );
});

test("archive entrypoint rechecks proof, renames only pinned guards, and writes cleanup-only receipt", async (t) => {
  const f = await planEntryFixture(t);
  const reportBefore = await readFile(f.reportPath);
  const account = createHash("sha256").update(f.config.driver.qq).digest("hex").slice(0, 24);
  const pendingPath = join(f.locksDirectory, `${account}.moderation-pending.json`);
  const pendingBefore = await readFile(pendingPath);
  const stopBefore = await readFile(join(f.out, "STOP"));
  const planned = await planModerationKnownNoEffectRecovery(
    {
      reportPath: f.reportPath,
      config: f.config,
      clients: f.clients,
      locksDirectory: f.locksDirectory,
    },
    f.dependencies,
  );
  const receipt = await archiveModerationKnownNoEffectRecovery(
    { plan: planned.plan, planSha256: planned.planSha256 },
    {
      config: f.config,
      clients: f.clients,
      approvedPlanSha256: planned.planSha256,
      locksDirectory: f.locksDirectory,
    },
    f.dependencies,
  );

  assert.equal(receipt.status, "MODERATION_KNOWN_NO_EFFECT_ARCHIVE_VERIFIED");
  assert.equal(receipt.cleanupVerified, true);
  assert.equal(receipt.cleanupOnly, true);
  assert.equal(receipt.featurePass, false);
  assert.equal(receipt.featureStatus, "INCONCLUSIVE");
  assert.equal(receipt.caseOutcome, "FAIL");
  assert.equal(receipt.productRunId, "46382058-a4b6-4b80-807d-54c21538487e");
  assert.equal(receipt.calledParamsUnrecorded, true);
  assert.equal(receipt.noModerationEffectVerified, true);
  assert.deepEqual(await readFile(f.reportPath), reportBefore);
  await assert.rejects(lstat(pendingPath), { code: "ENOENT" });
  await assert.rejects(lstat(join(f.out, "STOP")), { code: "ENOENT" });
  assert.deepEqual(await readFile(planned.plan.archivedPendingPath), pendingBefore);
  assert.deepEqual(await readFile(planned.plan.archivedStopPath), stopBefore);
  const savedReceipt = JSON.parse(
    await readFile(join(planned.plan.archiveDirectory, "receipt.json"), "utf8"),
  );
  assert.equal(savedReceipt.status, "MODERATION_KNOWN_NO_EFFECT_ARCHIVE_VERIFIED");
  assert.equal(savedReceipt.planSha256, planned.planSha256);
  await assert.rejects(lstat(planned.plan.lockPath), { code: "ENOENT" });
});

test("archive entrypoint rejects a changed proof before moving guards", async (t) => {
  const f = await planEntryFixture(t);
  const planned = await planModerationKnownNoEffectRecovery(
    {
      reportPath: f.reportPath,
      config: f.config,
      clients: f.clients,
      locksDirectory: f.locksDirectory,
    },
    f.dependencies,
  );
  const changed = structuredClone(planned.plan);
  changed.proof.call.traceEventCount += 1;
  await assert.rejects(
    archiveModerationKnownNoEffectRecovery(
      { plan: changed, planSha256: planned.planSha256 },
      {
        config: f.config,
        clients: f.clients,
        approvedPlanSha256: planned.planSha256,
        locksDirectory: f.locksDirectory,
      },
      f.dependencies,
    ),
    (error) => error?.code === "MODERATION_RECOVERY_APPROVAL",
  );
  await lstat(
    join(
      f.locksDirectory,
      `${createHash("sha256").update(f.config.driver.qq).digest("hex").slice(0, 24)}.moderation-pending.json`,
    ),
  );
  await lstat(join(f.out, "STOP"));
  await assert.rejects(
    lstat(join(f.out, planned.plan.runId, "moderation-known-no-effect-recovery")),
    { code: "ENOENT" },
  );
  await assert.rejects(lstat(planned.plan.lockPath), { code: "ENOENT" });
});

test("plan rejects changed delivery content, kind, recipient, and chronology", async (t) => {
  for (const [column, value] of [
    ["payload_text", "different reply"],
    ["payload_kind", "ack"],
    ["destination_scope_key", "different recipient"],
    ["created_at", "2000-01-01T00:00:00.000Z"],
    ["updated_at", "2099-01-01T00:00:00.000Z"],
  ]) {
    await t.test(column, async (st) => {
      const f = await planEntryFixture(st);
      const db = new DatabaseSync(join(f.runtime.dataDirectory, "glassbox.db"));
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM messages").get().n, 1);
      db.prepare(`UPDATE deliveries SET ${column}=?`).run(value);
      db.close();
      await assert.rejects(
        planModerationKnownNoEffectRecovery(
          {
            reportPath: f.reportPath,
            config: f.config,
            clients: f.clients,
            locksDirectory: f.locksDirectory,
          },
          f.dependencies,
        ),
        (error) => error?.code === "MODERATION_RECOVERY_DELIVERY",
      );
    });
  }
});

test("trace binds documented runtime telemetry through its owning Run stream and execution ref", () => {
  const trace = fixture();
  const extra = [
    {
      type: "runtime_health_observation",
      schema: "glassbox.runtime-health-observation.v1",
      executionRef: "fixture",
    },
    {
      type: "routing_eval_evidence",
      schema: "glassbox.routing-eval-evidence.v1",
      decisionExecutionRef: "fixture",
      actualExecutionRef: "fixture",
    },
  ];
  trace.events.splice(6, 0, ...extra.map((event) => ({ ts: trace.events[5].ts, event })));
  trace.events.forEach((row, i) => {
    row.seq = i + 1;
  });
  assert.equal(verifyModerationNoEffectTrace(trace, evidence, caseRecord).traceEventCount, 11);
  for (const alteration of [
    (value) => {
      value.runId = "another-run";
    },
    (value) => {
      value.events[6].event.type = "unknown_unbound_event";
    },
    (value) => {
      value.events[6].event.executionRef = "another-runtime";
    },
    (value) => {
      value.events[7].event.actualExecutionRef = "another-runtime";
    },
    (value) => {
      value.events[6].event.runId = "another-run";
    },
    (value) => {
      value.events[6].event.schema = "unsupported-schema";
    },
  ]) {
    const changed = structuredClone(trace);
    alteration(changed);
    assert.throws(() => verifyModerationNoEffectTrace(changed, evidence, caseRecord));
  }
});
