import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { digest, toolManifestDigest } from "../lib/core.mjs";
import {
  acceptanceMemoryCleanupExpectedOutput,
  acceptanceMemoryInventorySha256,
  buildAcceptanceMemoryCleanupPlan,
} from "../lib/acceptance-memory-cleanup-plan.mjs";
import { createAcceptanceMemoryNoIngressReceipt } from "../lib/acceptance-memory-attempt-reconciliation.mjs";
import {
  runAcceptanceMemoryCleanupCli,
  verifyAcceptanceMemoryCleanupOrigin,
  validateAcceptanceMemorySourceAuditRows,
} from "../lib/acceptance-memory-cleanup-cli.mjs";
import { Recorder } from "../lib/runner.mjs";
import { memoryFixtureProject } from "../lib/memory-scenario.mjs";
import { baseConfig } from "./fixture.mjs";

const HASH = "a".repeat(64);
const TIME = "2026-10-07T08:00:00.000Z";
const PRINCIPAL = "owner-principal";
const RUN_ID = "cleanup-run-1";
const TOKEN = "9".repeat(32);
const RUNTIME = {
  checkout: "/workspace/glassbox",
  dataDirectory: "/data/glassbox",
  commit: "b".repeat(40),
  pid: 1234,
  connectionId: "qq-live",
  threadId: null,
};
const ORIGIN = {
  reportSha256: "c".repeat(64),
  guardSha256: "d".repeat(64),
  sourceAuditSha256: "e".repeat(64),
};

function candidate(index) {
  const candidateId = "candidate_" + String(index).padStart(32, "0");
  const sourceRunId = `source-run-${index}`;
  return {
    candidateId,
    status: "pending",
    promotedMemoryId: null,
    candidateKind: "assertion",
    createdAt: TIME,
    scopeSha256: HASH,
    subjectSha256: "1".repeat(64),
    statementSha256: "2".repeat(64),
    sourceSha256: "3".repeat(64),
    principalId: PRINCIPAL,
    sourceRunId,
    auditWrite: {
      id: `write-audit-${index}`,
      sequence: index,
      principalId: PRINCIPAL,
      action: "write",
      targetId: candidateId,
      runId: sourceRunId,
      lineage: [`run:${sourceRunId}`],
      createdAt: TIME,
      rowSha256: "f".repeat(64),
    },
    sourceFeedback: null,
  };
}

function inventory(status = "pending") {
  return {
    schemaVersion: 1,
    candidates: [candidate(1), candidate(2)].map((entry) => ({
      ...entry,
      status,
    })),
  };
}

function loadedInputs(sourceInventory = inventory()) {
  return {
    manifest: {
      schemaVersion: 1,
      inventoryPath: "/private/inventory.json",
      sourceAuditSnapshotPath: "/private/audit.jsonl",
      originalReportPath: "/private/original/report.json",
      pendingGuardPath: "/private/original/guard.jsonl",
    },
    manifestPath: "/private/manifest.json",
    manifestSha256: "1".repeat(64),
    inventory: structuredClone(sourceInventory),
    inventoryFileSha256: "2".repeat(64),
    sourceAuditRows: [],
    sourceAuditSha256: "3".repeat(64),
    report: { bytes: Buffer.from("{}\n"), sha256: "4".repeat(64) },
    guard: { bytes: Buffer.from("{}\n"), sha256: "5".repeat(64) },
    origin: structuredClone(ORIGIN),
    originState: {},
  };
}

function testDatabase({ rejected = false, newWriteCount = 0 } = {}) {
  let closed = false;
  return {
    get isClosed() {
      return closed;
    },
    close() {
      assert.equal(closed, false, "each read-only database is closed exactly once");
      closed = true;
    },
    prepare(sql) {
      return {
        get(...args) {
          if (sql.includes("SELECT principal_id FROM runs")) return { principal_id: PRINCIPAL };
          if (sql.includes("SELECT r.message_id,m.external_id"))
            return { message_id: "internal-message-1", external_id: "90001" };
          if (sql.includes("COUNT(*) AS n FROM messages WHERE instr(text, ?) > 0")) return { n: 0 };
          if (sql.includes("COUNT(*) AS n FROM runs r JOIN messages")) return { n: 0 };
          if (sql.includes("COUNT(*)") && sql.includes("action='write'"))
            return { n: newWriteCount };
          if (sql.includes("COUNT(*)") && sql.includes("feedback_events")) return { n: 0 };
          if (sql.includes("COUNT(*)") && sql.includes("memory_candidates")) return { n: 0 };
          return undefined;
        },
        all(...args) {
          if (sql.includes("authorization_decisions_all")) {
            const [decisionId, runId, principalId] = args;
            if (runId !== RUN_ID || principalId !== PRINCIPAL) return [];
            return [
              {
                id: decisionId,
                action: "memory:govern",
                resource_id: "owner-memory",
                principal_id: PRINCIPAL,
                decision: "ALLOW",
                run_id: RUN_ID,
              },
            ];
          }
          if (sql.includes("memory_audit_events WHERE action='reject'")) {
            const [candidateId, runId, principalId] = args;
            return rejected && candidateId && runId === RUN_ID && principalId === PRINCIPAL
              ? [
                  {
                    id: `reject-${candidateId}`,
                    sequence: 90 + Number(candidateId.slice(-2)),
                    action: "reject",
                    target_id: candidateId,
                    run_id: RUN_ID,
                    principal_id: PRINCIPAL,
                    decision_id: `decision-${candidateId.slice(-2)}`,
                    lineage_json: "[]",
                  },
                ]
              : [];
          }
          return [];
        },
      };
    },
  };
}

function harness({
  outcome = "success",
  newWriteCount = 0,
  badInput = false,
  badOutput = false,
  runtime = RUNTIME,
  appendLeaseAudit = false,
  realReplyEvents = false,
  missingInputEvent = false,
} = {}) {
  const config = baseConfig();
  config.runtime = { connectionId: runtime.connectionId, threadId: null };
  const source = loadedInputs();
  const dbs = [];
  let inventoryReads = 0;
  let sentCount = 0;
  let rejected = false;
  let released = false;
  let activeSubscriptions = 0;
  const subscribers = { driver: new Set(), bot: new Set() };
  const messageRows = { driver: new Map(), bot: new Map() };
  const allowedReads = { driver: new Set(), bot: new Set() };
  const emit = (role, event) => {
    for (const listener of subscribers[role]) listener(event);
  };
  const makeClient = (role) => ({
    token: `${role}-fixture`,
    subscribe(listener) {
      subscribers[role].add(listener);
      activeSubscriptions++;
      return () => {
        if (subscribers[role].delete(listener)) activeSubscriptions--;
      };
    },
    async connect() {},
    close() {},
    allowMessageRead(messageId) {
      allowedReads[role].add(String(messageId));
    },
    async call(action, params) {
      if (action === "send_private_msg" && realReplyEvents) {
        sentCount++;
        rejected = true;
        const prompt = params.message.map((part) => part.data?.text ?? "").join("");
        const marker = /^GLASSBOX_ACCEPTANCE_V1 ([a-f0-9]{32})\n/u.exec(prompt)?.[1];
        assert.ok(marker, "fixed cleanup prompt carries its per-run marker");
        const time = Math.floor(Date.now() / 1000);
        const incomingId = "90001";
        const outgoingId = "90002";
        messageRows.bot.set(incomingId, {
          message_id: Number(incomingId),
          self_id: Number(config.bot.qq),
          sender: { user_id: Number(config.driver.qq) },
          user_id: Number(config.driver.qq),
          message_type: "private",
          real_seq: "615",
          time,
          message: [{ type: "text", data: { text: prompt } }],
          raw_message: prompt,
        });
        messageRows.driver.set(outgoingId, {
          message_id: Number(outgoingId),
          self_id: Number(config.driver.qq),
          sender: { user_id: Number(config.driver.qq) },
          user_id: Number(config.driver.qq),
          message_type: "private",
          real_seq: "615",
          time,
          message: [{ type: "text", data: { text: prompt } }],
          raw_message: prompt,
        });
        if (!missingInputEvent) {
          emit("bot", {
            time,
            self_id: Number(config.bot.qq),
            post_type: "message",
            message_type: "private",
            user_id: Number(config.driver.qq),
            message_id: Number(incomingId),
            message: [{ type: "text", data: { text: prompt } }],
          });
        }
        emit("driver", {
          time,
          self_id: Number(config.driver.qq),
          post_type: "message",
          message_type: "private",
          user_id: Number(config.bot.qq),
          message_id: 90003,
          message: [{ type: "text", data: { text: `已完成 ${marker}` } }],
        });
        return { message_id: Number(outgoingId) };
      }
      if (action === "get_msg") {
        const key = String(params.message_id);
        if (role === "bot" && !allowedReads[role].has(key))
          throw Object.assign(new Error("read not allowed"), { code: "MESSAGE_READ_DENIED" });
        const row = messageRows[role].get(key);
        if (!row) throw Object.assign(new Error("missing local receipt"), { code: "API_REJECTED" });
        return row;
      }
      throw Object.assign(new Error("unexpected fake OneBot action"), { code: "ACTION_DENIED" });
    },
  });
  const readOnlyDb = (state = {}) => {
    const db = testDatabase(state);
    dbs.push(db);
    return db;
  };
  const deps = {
    loadInputs: async () => structuredClone(source),
    verifyOrigin: async () => ({ trusted: true }),
    runtimeInspectionSnapshot: async () => structuredClone(runtime),
    runtimeSnapshot: async () => structuredClone(runtime),
    readCurrentInventory: () => {
      inventoryReads++;
      const current = rejected ? inventory("rejected") : inventory();
      return {
        inventory: current,
        inventorySha256: acceptanceMemoryInventorySha256(current),
        db: readOnlyDb({ rejected, newWriteCount }),
      };
    },
    stopFingerprint: async () => "same-stop-fingerprint",
    captureProcess: async () => ({ pid: 1234 }),
    acquireAccountLock: async () => ({ fake: true }),
    releaseAccountLock: async () => {
      released = true;
    },
    createClients: async () => ({ driver: makeClient("driver"), bot: makeClient("bot") }),
    createRecorder: (candidateConfig, clients) =>
      new Recorder(candidateConfig, [clients.driver.token, clients.bot.token]),
    doctor: async () => ({ status: "ready" }),
    acceptanceManagement: async () => ({
      register: async (_candidateConfig, _prepared, tools) => ({
        leaseId: "11111111-1111-4111-8111-111111111111",
        expiresAt: Date.now() + 60_000,
        toolsSha256: toolManifestDigest(tools),
      }),
      revoke: async () => {},
      revokeMarker: async () => {},
    }),
    replyCase: async (_config, _clients, _recorder, spec, _signal, acceptance) => {
      sentCount++;
      await acceptance.beforeRegister();
      const activeLease = {
        leaseId: "22222222-2222-4222-8222-222222222222",
        expiresAt: Date.now() + 60_000,
        toolsSha256: toolManifestDigest(spec.leaseTools),
      };
      if (appendLeaseAudit) {
        const auditPath = join(runtime.dataDirectory, "qq-live-acceptance-audit.jsonl");
        const audit = JSON.parse(
          await readFile(auditPath, "utf8").then((text) => text.trimEnd().split("\n")[0]),
        );
        const next = {
          ...audit,
          at: new Date().toISOString(),
          expiresAt: activeLease.expiresAt,
          leaseId: activeLease.leaseId,
          marker: TOKEN,
        };
        await writeFile(
          auditPath,
          Buffer.concat([await readFile(auditPath), Buffer.from(JSON.stringify(next) + "\n")]),
        );
      }
      await acceptance.beforeSend(spec, activeLease);
      if (outcome === "known-api-reject")
        return {
          id: spec.id,
          status: "BLOCKED",
          code: "API_REJECTED",
          route: "private",
          token: TOKEN,
          startedAt: TIME,
          prompt:
            "GLASSBOX_ACCEPTANCE_V1 " +
            TOKEN +
            "\n" +
            spec.prompt.trim().replaceAll("{{nonce}}", TOKEN),
          sendAttempted: true,
          inputObserved: false,
          leaseRegistrationAttempted: true,
          leaseRevoked: true,
          anomalies: [],
          acceptanceLease: {
            leaseId: "11111111-1111-4111-8111-111111111111",
            expiresAt: Date.parse(TIME) + 60_000,
            toolsSha256: toolManifestDigest(spec.leaseTools),
          },
          transportFailure: {
            retcode: 1200,
            classification: "ACCOUNT_REAUTH_REQUIRED",
            providerResult: -10003,
          },
        };
      if (outcome === "unknown")
        return {
          id: spec.id,
          status: "INCONCLUSIVE",
          code: "REPLY_UNKNOWN",
          sendAttempted: true,
          inputObserved: false,
          leaseRevoked: true,
          anomalies: [],
        };
      rejected = outcome === "success";
      const prompt = `GLASSBOX_ACCEPTANCE_V1 ${TOKEN}\n${spec.prompt
        .trim()
        .replaceAll("{{nonce}}", TOKEN)}`;
      const replyTextSha256 = digest("已完成 " + TOKEN);
      const acceptanceLease = {
        leaseId: "11111111-1111-4111-8111-111111111111",
        expiresAt: Date.parse(TIME) + 60_000,
        toolsSha256: toolManifestDigest(spec.leaseTools),
      };
      await acceptance.afterSend({
        id: spec.id,
        token: TOKEN,
        route: "private",
        startedAt: TIME,
        prompt,
        sendAttempted: true,
        sentMessageId: "90002",
        acceptanceLease,
      });
      return {
        id: spec.id,
        route: "private",
        startedAt: TIME,
        status: "PASS",
        code: "REAL_REPLY_RECEIVED",
        sendAttempted: true,
        inputObserved: true,
        leaseRegistrationAttempted: true,
        leaseRevoked: true,
        expected: [TOKEN],
        anomalies: [],
        token: TOKEN,
        prompt,
        sentMessageId: "90002",
        inputBinding: {
          botMessageId: "90001",
          driverMessageId: "90002",
          textSha256: digest(prompt),
        },
        acceptanceLease,
        replies: [
          {
            route: "private",
            messageId: "90002",
            textSha256: replyTextSha256,
            textBytes: 12,
            matches: true,
            receivedAt: TIME,
          },
        ],
      };
    },
    verifyProductEvidence: async (productReport, _config, _clients) => {
      const sentCase = productReport.cases[0];
      const promptSha256 = digest(sentCase.prompt);
      const reply = sentCase.replies[0];
      const replyMessageId = realReplyEvents ? "90003" : "90002";
      return {
        status: "PASS",
        cases: [
          {
            runId: RUN_ID,
            principalId: PRINCIPAL,
            traceVerified: true,
            cleanupVerified: true,
            inputBinding: {
              botMessageId: "90001",
              driverMessageId: "90002",
              textSha256: promptSha256,
            },
            delivery: {
              id: "delivery-1",
              external_id: replyMessageId,
              status: "sent",
            },
            messageBinding: {
              input: { messageId: "90001", textSha256: promptSha256 },
              reply: {
                botMessageId: replyMessageId,
                driverMessageId: replyMessageId,
                textSha256: reply.textSha256,
              },
            },
          },
        ],
      };
    },
    readTraceEvents: (_checkout, _dataDirectory, runId) => {
      const candidateIds = source.inventory.candidates.map((entry) => entry.candidateId);
      const input = badInput
        ? { action: "reject", candidateIds: candidateIds.slice(0, 1) }
        : { action: "reject", candidateIds };
      const output = acceptanceMemoryCleanupExpectedOutput(candidateIds);
      return {
        runId,
        matched: 2,
        events: [
          {
            seq: 4,
            ts: TIME,
            event: {
              runId,
              type: "tool_call",
              data: {
                toolCallId: "tool-call-1",
                name: "owner_memory_admin",
                input,
              },
            },
            provenance: "test-fixture",
          },
          {
            seq: 5,
            ts: TIME,
            event: {
              runId,
              type: "tool_result",
              data: {
                toolCallId: "tool-call-1",
                name: "owner_memory_admin",
                isError: false,
                outputBytes: output.outputBytes,
                outputSha256: badOutput ? "0".repeat(64) : output.outputSha256,
              },
            },
            provenance: "test-fixture",
          },
        ],
      };
    },
    openReadOnlyDatabase: () => readOnlyDb({ rejected, newWriteCount }),
  };
  return {
    config,
    deps,
    dbs,
    get sentCount() {
      return sentCount;
    },
    get inventoryReads() {
      return inventoryReads;
    },
    get released() {
      return released;
    },
    get activeSubscriptions() {
      return activeSubscriptions;
    },
  };
}

test("plans from an independent inventory snapshot and never opens transport", async (t) => {
  const out = await mkdtemp(join(tmpdir(), "memory-cleanup-plan-"));
  t.after(() => rm(out, { recursive: true, force: true }));
  const h = harness();

  const result = await runAcceptanceMemoryCleanupCli(
    h.config,
    { input: "/private/manifest.json", live: false },
    out,
    h.deps,
  );

  assert.equal(result.status, "PLAN");
  assert.equal(result.cleanupOnly, true);
  assert.equal(result.featurePass, false);
  assert.equal(h.sentCount, 0);
  assert.equal(h.inventoryReads, 1);
  assert.ok(h.dbs[0].isClosed);
});

test("cleanup coordinator feeds real replyCase from both subscribed fake OneBot event streams and saves the sent ID", async (t) => {
  const out = await mkdtemp(join(tmpdir(), "memory-cleanup-recorder-integration-"));
  t.after(() => rm(out, { recursive: true, force: true }));
  const h = harness({ realReplyEvents: true });
  h.deps.replyCase = undefined;

  const plan = await runAcceptanceMemoryCleanupCli(
    h.config,
    { input: "/private/manifest.json" },
    out,
    h.deps,
  );
  let result;
  try {
    result = await runAcceptanceMemoryCleanupCli(
      h.config,
      { input: "/private/manifest.json", live: true, "approve-suite": plan.sha256 },
      out,
      h.deps,
    );
  } catch (error) {
    const directories = await (await import("node:fs/promises")).readdir(out);
    const failure = JSON.parse(await readFile(join(out, directories[0], "failure.json"), "utf8"));
    assert.fail(
      `${error.code}: ${JSON.stringify({ caseCode: failure.case?.code, inputObserved: failure.case?.inputObserved, sendAttempted: failure.case?.sendAttempted })}`,
    );
  }

  assert.equal(result.status, "CLEANUP_VERIFIED");
  assert.equal(h.sentCount, 1);
  assert.equal(h.activeSubscriptions, 0);
  assert.equal(h.released, true);
  const report = JSON.parse(await readFile(join(result.reportDirectory, "report.json"), "utf8"));
  assert.equal(report.transportEvidence.inputObserved, true);
  assert.equal(report.transportEvidence.sentMessageId, "90002");
  assert.equal(report.transportEvidence.replies.length, 1);
  assert.equal(report.transportEvidence.replies[0].messageId, "90003");
  const receipt = JSON.parse(
    await readFile(join(result.reportDirectory, "send-receipt.json"), "utf8"),
  );
  assert.equal(receipt.kind, "acceptance-memory-cleanup-send-receipt");
  assert.equal(receipt.sentMessageId, "90002");
  assert.equal(receipt.sendAttempted, true);
  assert.equal(receipt.promptSha256, report.transportEvidence.promptSha256);
  assert.ok(h.dbs.every((db) => db.isClosed));
});

test("failed cleanup report preserves the exact send receipt when the Bot input event is missing", async (t) => {
  const out = await mkdtemp(join(tmpdir(), "memory-cleanup-send-receipt-failure-"));
  t.after(() => rm(out, { recursive: true, force: true }));
  const h = harness({ realReplyEvents: true, missingInputEvent: true });
  h.deps.replyCase = undefined;
  const plan = await runAcceptanceMemoryCleanupCli(
    h.config,
    { input: "/private/manifest.json" },
    out,
    h.deps,
  );
  await assert.rejects(
    runAcceptanceMemoryCleanupCli(
      h.config,
      { input: "/private/manifest.json", live: true, "approve-suite": plan.sha256 },
      out,
      h.deps,
    ),
    { code: "CLEANUP_REPLY_UNCONFIRMED" },
  );

  assert.equal(h.sentCount, 1);
  assert.equal(h.activeSubscriptions, 0);
  const directories = await (await import("node:fs/promises")).readdir(out);
  const reportDirectory = join(
    out,
    directories.find((entry) => entry.startsWith("acceptance-memory-cleanup_")),
  );
  const failure = JSON.parse(await readFile(join(reportDirectory, "failure.json"), "utf8"));
  assert.equal(failure.case.sendAttempted, true);
  assert.equal(failure.case.inputObserved, false);
  assert.equal(failure.case.sentMessageId, "90002");
  assert.equal(failure.case.sendReceiptPath, "send-receipt.json");
  assert.match(failure.case.sendReceiptSha256, /^[a-f0-9]{64}$/);
  const receipt = JSON.parse(await readFile(join(reportDirectory, "send-receipt.json"), "utf8"));
  assert.equal(receipt.sentMessageId, "90002");
  assert.equal(receipt.sendAttempted, true);
});

test("validates real private guard and journal bytes without rewriting either file", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "memory-cleanup-origin-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = baseConfig();
  config.runtime = { connectionId: RUNTIME.connectionId, threadId: null };
  const reportDirectory = join(root, "reports", "run-record-1");
  const lockDirectory = join(root, "locks");
  await mkdir(reportDirectory, { recursive: true, mode: 0o700 });
  await mkdir(lockDirectory, { recursive: true, mode: 0o700 });
  const pendingPath = join(lockDirectory, "driver.memory-pending.json");
  const reportPath = join(reportDirectory, "report.json");
  const journalPath = join(reportDirectory, "memory-fixture.jsonl");
  const nonce = "8".repeat(32);
  const origin = {
    runtime: { ...RUNTIME, pid: 1200 },
    process: {
      pid: 1201,
      bootId: "12345678-1234-1234-1234-123456789abc",
      startTicks: "987654321",
    },
    scope: {
      connectionId: config.runtime.connectionId,
      botId: config.bot.qq,
      chatType: "private",
      chatId: config.driver.qq,
      senderId: config.driver.qq,
      threadId: null,
    },
    driverSha256: digest(config.driver.qq),
    suiteSha256: "a".repeat(64),
    startedAt: "2026-10-07T08:00:00.000Z",
  };
  const row = {
    schemaVersion: 2,
    origin,
    sequence: 1,
    previousSha256: null,
    phase: "before_send",
    stage: "feedback",
    handles: { fixtureNonce: nonce, projectId: memoryFixtureProject(nonce) },
    steps: [],
    at: "2026-10-07T08:00:01.000Z",
    runId: "run-record-1",
    reportDirectory,
  };
  row.checkpointSha256 = digest(JSON.stringify(row));
  const checkpointBytes = Buffer.from(JSON.stringify(row) + "\n");
  const reportBytes = Buffer.from(
    JSON.stringify({
      mode: "run",
      status: "INCONCLUSIVE",
      runtime: origin.runtime,
    }) + "\n",
  );
  await writeFile(pendingPath, checkpointBytes, { mode: 0o600 });
  await writeFile(journalPath, checkpointBytes, { mode: 0o600 });
  await writeFile(reportPath, reportBytes, { mode: 0o600 });
  await Promise.all([pendingPath, journalPath, reportPath].map((path) => chmod(path, 0o600)));
  const loaded = {
    manifest: { originalReportPath: reportPath, pendingGuardPath: pendingPath },
    report: { bytes: reportBytes },
    guard: { bytes: checkpointBytes },
  };
  const stopped = [];

  const verified = await verifyAcceptanceMemoryCleanupOrigin(config, loaded, {
    verifyProcessStopped: async (identity) => stopped.push(identity),
  });

  assert.equal(verified.record.runId, row.runId);
  assert.deepEqual(verified.record.origin.runtime, origin.runtime);
  assert.deepEqual(stopped, [origin.process]);
  assert.deepEqual(await readFile(pendingPath), checkpointBytes);
  assert.deepEqual(await readFile(journalPath), checkpointBytes);
});

test("verifies actual gbxtrace frame shape, exact protected input and full output wrapper", async (t) => {
  const out = await mkdtemp(join(tmpdir(), "memory-cleanup-success-"));
  t.after(() => rm(out, { recursive: true, force: true }));
  const h = harness();

  const result = await runAcceptanceMemoryCleanupCli(
    h.config,
    {
      input: "/private/manifest.json",
      live: true,
      "approve-suite": "placeholder",
    },
    out,
    h.deps,
  ).catch((error) => error);

  // The first plan hash is deterministic, so re-run with the exact plan approval.
  assert.equal(result.code, "APPROVAL_REQUIRED");
  assert.equal(h.sentCount, 0);
  const plan = await runAcceptanceMemoryCleanupCli(
    h.config,
    { input: "/private/manifest.json" },
    out,
    h.deps,
  );
  const approved = harness();
  const completed = await runAcceptanceMemoryCleanupCli(
    approved.config,
    {
      input: "/private/manifest.json",
      live: true,
      "approve-suite": plan.sha256,
    },
    out,
    approved.deps,
  );

  assert.equal(completed.status, "CLEANUP_VERIFIED");
  assert.equal(completed.featurePass, false);
  assert.equal(approved.sentCount, 1);
  assert.equal(approved.inventoryReads, 3);
  assert.equal(approved.released, true);
  assert.ok(approved.dbs.every((db) => db.isClosed));
  assert.equal(approved.dbs.length, 4);
  const candidateIds = completed.proof.candidateIds;
  const expectedOutput = acceptanceMemoryCleanupExpectedOutput(candidateIds);
  assert.ok(expectedOutput.outputBytes > 0);
  assert.match(expectedOutput.outputSha256, /^[a-f0-9]{64}$/u);
});

test("rejects altered batch input, wrapper output, or learning writes after one cleanup attempt", async (t) => {
  for (const variant of [
    { name: "input", options: { badInput: true }, code: "CLEANUP_TOOL_INPUT" },
    { name: "output", options: { badOutput: true } },
    {
      name: "learning write",
      options: { newWriteCount: 1 },
      code: "CLEANUP_NEW_LEARNING",
    },
  ]) {
    await t.test(variant.name, async (subtest) => {
      const out = await mkdtemp(
        join(tmpdir(), `memory-cleanup-${variant.name.replaceAll(" ", "-")}-`),
      );
      subtest.after(() => rm(out, { recursive: true, force: true }));
      const h = harness(variant.options);
      const plan = await runAcceptanceMemoryCleanupCli(
        h.config,
        { input: "/private/manifest.json" },
        out,
        h.deps,
      );
      const run = runAcceptanceMemoryCleanupCli(
        h.config,
        {
          input: "/private/manifest.json",
          live: true,
          "approve-suite": plan.sha256,
        },
        out,
        h.deps,
      );
      if (variant.code) await assert.rejects(run, { code: variant.code });
      else await assert.rejects(run);
      assert.equal(h.sentCount, 1);
      assert.equal(h.released, true);
      assert.ok(h.dbs.every((db) => db.isClosed));
    });
  }
});

test("cleanup coordinator rechecks a real no-ingress receipt against its runtime after a new lease audit append", async (t) => {
  const out = await mkdtemp(join(tmpdir(), "memory-cleanup-retry-"));
  t.after(() => rm(out, { recursive: true, force: true }));
  const dataDirectory = join(out, "data");
  await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
  const runtime = { ...RUNTIME, dataDirectory };
  const h = harness({ runtime, appendLeaseAudit: true });
  const reportDirectory = join(out, "acceptance-memory-cleanup_previous");
  await mkdir(reportDirectory, { mode: 0o700 });
  await writeFile(join(out, "STOP"), "INCONCLUSIVE\n", { mode: 0o600 });
  const startedAt = new Date(Date.now() - 60_000).toISOString();
  const finishedAt = new Date(Date.parse(startedAt) + 1000).toISOString();
  const registeredAt = new Date(Date.parse(startedAt) + 100).toISOString();
  const revokedAt = new Date(Date.parse(startedAt) + 500).toISOString();
  const principalId = "owner-principal";
  const scopeSha256 = digest(
    JSON.stringify([
      runtime.connectionId,
      h.config.bot.qq,
      "private",
      h.config.driver.qq,
      h.config.driver.qq,
      runtime.threadId,
    ]),
  );
  const inventoryValue = inventory();
  const planRecord = buildAcceptanceMemoryCleanupPlan({
    inventory: inventoryValue,
    inventorySha256: acceptanceMemoryInventorySha256(inventoryValue),
    runtime,
    origin: ORIGIN,
  });
  const previousMarker = "a".repeat(32);
  const leaseId = "11111111-1111-4111-8111-111111111111";
  const auditRows = [
    {
      at: registeredAt,
      event: "lease_registered",
      expiresAt: Date.now() + 60_000,
      leaseId,
      marker: previousMarker,
      principalId,
      scopeSha256,
      toolsSha256: planRecord.plan.toolsSha256,
    },
    { at: revokedAt, event: "lease_revoked", leaseId, principalId },
  ];
  await writeFile(
    join(dataDirectory, "qq-live-acceptance-audit.jsonl"),
    auditRows.map((row) => JSON.stringify(row)).join("\n") + "\n",
    { mode: 0o600 },
  );
  const failure = {
    schemaVersion: 1,
    kind: "acceptance-memory-cleanup",
    status: "INCONCLUSIVE",
    cleanupOnly: true,
    featurePass: false,
    planSha256: planRecord.sha256,
    origin: ORIGIN,
    runtime,
    startedAt,
    errorCode: "CLEANUP_REPLY_UNCONFIRMED",
    finishedAt,
    principalId,
    case: {
      id: "acceptance-memory-cleanup",
      status: "BLOCKED",
      code: "API_REJECTED",
      sendAttempted: true,
      inputObserved: false,
      leaseRevoked: true,
    },
  };
  const failurePath = join(reportDirectory, "failure.json");
  await writeFile(failurePath, JSON.stringify(failure) + "\n", { mode: 0o600 });
  const manifestPath = "/private/manifest.json";
  const receipt = await createAcceptanceMemoryNoIngressReceipt({
    reportPath: failurePath,
    reportDirectory,
    manifestPath,
    config: h.config,
    out,
    expectedRuntime: runtime,
    deps: h.deps,
  });
  assert.equal(receipt.status, "NO_INGRESS_VERIFIED");
  const planned = await runAcceptanceMemoryCleanupCli(
    h.config,
    { input: manifestPath },
    out,
    h.deps,
  );
  const completed = await runAcceptanceMemoryCleanupCli(
    h.config,
    { input: manifestPath, live: true, "approve-suite": planned.sha256 },
    out,
    h.deps,
  );
  assert.equal(completed.status, "CLEANUP_VERIFIED");
  assert.equal(h.sentCount, 1);
  assert.equal(h.released, true);
  assert.ok(h.dbs.every((db) => db.isClosed));
});

test("unknown send outcome stops after one attempt and leaves the STOP receipt untouched", async (t) => {
  const out = await mkdtemp(join(tmpdir(), "memory-cleanup-unknown-"));
  t.after(() => rm(out, { recursive: true, force: true }));
  const h = harness({ outcome: "unknown" });
  const plan = await runAcceptanceMemoryCleanupCli(
    h.config,
    { input: "/private/manifest.json" },
    out,
    h.deps,
  );
  await assert.rejects(
    runAcceptanceMemoryCleanupCli(
      h.config,
      {
        input: "/private/manifest.json",
        live: true,
        "approve-suite": plan.sha256,
      },
      out,
      h.deps,
    ),
    { code: "CLEANUP_REPLY_UNCONFIRMED" },
  );
  assert.equal(h.sentCount, 1);
  assert.equal(h.released, true);
  assert.ok(h.dbs.every((db) => db.isClosed));
  const entries = await (await import("node:fs/promises")).readdir(out);
  const reportPath = join(out, entries[0], "failure.json");
  const report = JSON.parse(await readFile(reportPath, "utf8"));
  assert.equal(report.status, "INCONCLUSIVE");
  assert.equal(report.case.sendAttempted, true);
  await assert.rejects(
    runAcceptanceMemoryCleanupCli(
      h.config,
      {
        input: "/private/manifest.json",
        live: true,
        "approve-suite": plan.sha256,
      },
      out,
      h.deps,
    ),
    { code: "CLEANUP_PRIOR_ATTEMPT" },
  );
  assert.equal(h.sentCount, 1);
});

test("failure report stores only bounded send rejection evidence and no request text", async (t) => {
  const out = await mkdtemp(join(tmpdir(), "memory-cleanup-api-reject-"));
  t.after(() => rm(out, { recursive: true, force: true }));
  const h = harness({ outcome: "known-api-reject" });
  const plan = await runAcceptanceMemoryCleanupCli(
    h.config,
    { input: "/private/manifest.json" },
    out,
    h.deps,
  );
  await assert.rejects(
    runAcceptanceMemoryCleanupCli(
      h.config,
      {
        input: "/private/manifest.json",
        live: true,
        "approve-suite": plan.sha256,
      },
      out,
      h.deps,
    ),
    { code: "CLEANUP_REPLY_UNCONFIRMED" },
  );
  assert.equal(h.sentCount, 1);
  const entries = await (await import("node:fs/promises")).readdir(out);
  const reportPath = join(out, entries[0], "failure.json");
  const report = JSON.parse(await readFile(reportPath, "utf8"));
  assert.equal(report.case.code, "API_REJECTED");
  assert.equal(report.case.sendAttempted, true);
  assert.equal(report.case.inputObserved, false);
  assert.equal(report.case.leaseRevoked, true);
  assert.match(report.case.token, /^[a-f0-9]{32}$/u);
  assert.match(report.case.promptSha256, /^[a-f0-9]{64}$/u);
  assert.deepEqual(report.case.transportFailure, {
    retcode: 1200,
    classification: "ACCOUNT_REAUTH_REQUIRED",
    providerResult: -10003,
  });
  assert.equal(JSON.stringify(report).includes("GLASSBOX_ACCEPTANCE_V1"), false);
});

test("accepts exact legacy four-field revocations only when uniquely ordered with registration and Run binding", () => {
  const config = baseConfig();
  config.runtime = { connectionId: "qq-live", threadId: null };
  const scope = {
    connectionId: "qq-live",
    botId: config.bot.qq,
    chatType: "private",
    chatId: config.driver.qq,
    senderId: config.driver.qq,
    threadId: null,
  };
  const scopeSha256 = digest(
    JSON.stringify([
      scope.connectionId,
      scope.botId,
      scope.chatType,
      scope.chatId,
      scope.senderId,
      null,
    ]),
  );
  const runText = "source text";
  const runId = "source-run";
  const leaseId = "legacy-lease";
  const marker = "a".repeat(32);
  const toolsSha256 = "b".repeat(64);
  const registration = {
    at: "2026-10-07T08:00:00.000Z",
    event: "lease_registered",
    expiresAt: Date.parse("2026-10-07T08:05:00.000Z"),
    leaseId,
    marker,
    principalId: "owner-principal",
    scopeSha256,
    toolsSha256,
  };
  const bound = {
    at: "2026-10-07T08:01:00.000Z",
    event: "run_bound",
    leaseId,
    marker,
    messageId: "90001",
    principalId: "owner-principal",
    runId,
    scopeSha256,
    textSha256: digest(runText),
    toolsSha256,
  };
  const legacyRevocation = {
    at: "2026-10-07T08:02:00.000Z",
    event: "lease_revoked",
    leaseId,
    principalId: "owner-principal",
  };
  const fullRegistration = {
    ...registration,
    leaseId: "full-lease",
    marker: "c".repeat(32),
  };
  const fullRevocation = {
    at: "2026-10-07T08:03:00.000Z",
    event: "lease_revoked",
    leaseId: fullRegistration.leaseId,
    marker: fullRegistration.marker,
    principalId: "owner-principal",
    scopeSha256,
  };
  const rows = [registration, bound, legacyRevocation, fullRegistration, fullRevocation];
  const db = {
    prepare(sql) {
      return {
        get(id) {
          if (sql.includes("FROM runs"))
            return {
              id,
              status: "succeeded",
              principal_id: "owner-principal",
              scope_json: JSON.stringify(scope),
              message_id: "internal-1",
              external_id: "90001",
              text: runText,
            };
          if (sql.includes("FROM principals")) return { kind: "owner" };
          return undefined;
        },
      };
    },
  };
  const accepted = validateAcceptanceMemorySourceAuditRows(rows, db, config);
  assert.equal(accepted.size, 1);
  assert.equal(accepted.get(runId).leaseId, leaseId);
  assert.equal(accepted.get(runId).marker, marker);

  for (const invalid of [
    [registration, { ...bound, at: "2026-10-07T08:03:00.000Z" }, legacyRevocation],
    [registration, bound, { ...legacyRevocation, principalId: "other-owner" }],
    [registration, bound, legacyRevocation, { ...legacyRevocation, extra: true }],
    [bound, legacyRevocation],
    [registration, bound, { ...legacyRevocation, at: "2026-10-07T07:59:00.000Z" }],
  ]) {
    assert.throws(() => validateAcceptanceMemorySourceAuditRows(invalid, db, config), {
      code: "CLEANUP_SOURCE_AUDIT",
    });
  }
});
