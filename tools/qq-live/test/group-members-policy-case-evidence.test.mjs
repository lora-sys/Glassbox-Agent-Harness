import assert from "node:assert/strict";
import test from "node:test";
import { createHash, randomUUID } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { digest, toolManifestDigest } from "../lib/core.mjs";
import { groupMembersPolicyStep } from "../lib/group-members-policy-scenario.mjs";
import { verifyGroupMembersPolicyFailureWithLeaseCleanup } from "../lib/group-members-policy-case-evidence.mjs";

const config = {
  bot: { qq: "10001" },
  driver: { qq: "20002" },
  groups: [
    { alias: "A", id: "30003" },
    { alias: "B", id: "40004" },
  ],
  runtime: { connectionId: "members-case-fixture", threadId: null },
};
const REFUSAL = "未能从 QQ 获取该信息，因此无法确认。";
const principal = "owner-fixture";
const runId = "members-failed-run";
const scope = {
  connectionId: config.runtime.connectionId,
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
const sha = (value) => createHash("sha256").update(value, "utf8").digest("hex");

function fixture(t) {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  db.exec(`
    CREATE TABLE principals(id TEXT PRIMARY KEY,kind TEXT);
    CREATE TABLE messages(id TEXT PRIMARY KEY,external_id TEXT,scope_key TEXT,text TEXT,created_at TEXT);
    CREATE TABLE runs(id TEXT PRIMARY KEY,message_id TEXT,status TEXT,failure_code TEXT,result_text TEXT,scope_json TEXT,created_at TEXT,updated_at TEXT,principal_id TEXT,conversation_id TEXT);
    CREATE TABLE authorization_decisions(id TEXT PRIMARY KEY,principal_id TEXT,resource_id TEXT,action TEXT,scope_key TEXT,decision TEXT,run_id TEXT,delivery_source TEXT);
    CREATE TABLE authorization_decisions_archive(id TEXT PRIMARY KEY,principal_id TEXT,resource_id TEXT,action TEXT,scope_key TEXT,decision TEXT,run_id TEXT,delivery_source TEXT);
    CREATE VIEW authorization_decisions_all AS SELECT * FROM authorization_decisions UNION ALL SELECT * FROM authorization_decisions_archive;
    CREATE TABLE deliveries(id TEXT PRIMARY KEY,run_id TEXT,status TEXT,external_id TEXT,destination_scope_key TEXT);
  `);
  const now = Date.now();
  const startedAt = new Date(now - 12_000).toISOString();
  const registeredAt = new Date(now - 9_000).toISOString();
  const boundAt = new Date(now - 8_000).toISOString();
  const revokedAt = new Date(now - 7_000).toISOString();
  const runCreatedAt = new Date(now - 6_000).toISOString();
  const runUpdatedAt = new Date(now - 5_000).toISOString();
  const messageCreatedAt = runCreatedAt;
  const token = "a".repeat(32);
  const spec = groupMembersPolicyStep("members-check", "40004");
  const prompt = `GLASSBOX_ACCEPTANCE_V1 ${token}\n${spec.prompt.replaceAll("{{nonce}}", token).trim()}`;
  const leaseId = randomUUID();
  const toolsSha256 = toolManifestDigest(spec.leaseTools);
  const caseRecord = {
    id: spec.id,
    token,
    route: "private",
    prompt,
    expected: [REFUSAL],
    startedAt,
    startedMs: now - 12_000,
    status: "PASS",
    code: "REAL_REPLY_RECEIVED",
    sendAttempted: true,
    sentMessageId: "20001",
    inputObserved: true,
    inputBinding: {
      driverMessageId: "20001",
      botMessageId: "20002",
      realSequence: "9001",
      time: Math.floor((now - 11_000) / 1000),
      driverTime: Math.floor((now - 11_000) / 1000),
      textSha256: digest(prompt),
    },
    replies: [
      {
        route: "private",
        messageId: "30001",
        textSha256: digest(REFUSAL),
        textBytes: Buffer.byteLength(REFUSAL, "utf8"),
        matches: true,
        receivedAt: new Date(now - 4_000).toISOString(),
      },
    ],
    anomalies: [],
    leaseRegistrationAttempted: true,
    leaseRevoked: true,
    leasedToolNames: ["qq_group_members"],
    acceptanceLease: { leaseId, expiresAt: now + 60_000, toolsSha256 },
  };
  db.prepare("INSERT INTO principals VALUES (?,'owner')").run(principal);
  db.prepare("INSERT INTO messages VALUES (?,?,?,?,?)").run(
    "input-message",
    caseRecord.inputBinding.botMessageId,
    scopeKey,
    caseRecord.prompt,
    messageCreatedAt,
  );
  db.prepare("INSERT INTO runs VALUES (?,?,?,?,?,?,?,?,?,?)").run(
    runId,
    "input-message",
    "failed",
    "required_evidence_missing",
    REFUSAL,
    JSON.stringify(scope),
    runCreatedAt,
    runUpdatedAt,
    principal,
    "conversation-fixture",
  );
  db.prepare("INSERT INTO deliveries VALUES (?,?,?,?,?)").run(
    "delivery-fixture",
    runId,
    "sent",
    "30002",
    scopeKey,
  );
  const directory = join(tmpdir(), `qq-members-case-${randomUUID()}`);
  t.after(() => rm(directory, { recursive: true, force: true }));
  const scopeSha256 = sha(
    JSON.stringify([
      scope.connectionId,
      scope.botId,
      scope.chatType,
      scope.chatId,
      scope.senderId,
      scope.threadId,
    ]),
  );
  const audit = [
    {
      at: registeredAt,
      event: "lease_registered",
      leaseId,
      principalId: principal,
      marker: token,
      expiresAt: caseRecord.acceptanceLease.expiresAt,
      toolsSha256,
      scopeSha256,
    },
    {
      at: boundAt,
      event: "run_bound",
      leaseId,
      principalId: principal,
      marker: token,
      runId,
      messageId: caseRecord.inputBinding.botMessageId,
      textSha256: sha(prompt.replace(/\r\n?/gu, "\n")),
      toolsSha256,
      scopeSha256,
    },
    {
      at: revokedAt,
      event: "lease_revoked",
      leaseId,
      principalId: principal,
      marker: token,
      scopeSha256,
      runId,
    },
  ];
  return {
    db,
    directory,
    caseRecord,
    expectedDeliveryId: "delivery-fixture",
    async writeAudit() {
      await writeFile(
        join(directory, "qq-live-acceptance-audit.jsonl"),
        `${audit.map((row) => JSON.stringify(row)).join("\n")}\n`,
      );
    },
  };
}

test("dedicated failed-Run verifier binds exact Owner Run, single delivery, and lease cleanup", async (t) => {
  const f = fixture(t);
  const fs = await import("node:fs/promises");
  await fs.mkdir(f.directory, { recursive: true });
  await f.writeAudit();
  const result = await verifyGroupMembersPolicyFailureWithLeaseCleanup(
    f.db,
    f.directory,
    f.caseRecord,
    config,
    async (evidence) => {
      assert.equal(evidence.runId, runId);
      assert.equal(evidence.principalId, principal);
      assert.equal(evidence.delivery.id, f.expectedDeliveryId);
      assert.equal(evidence.delivery.external_id, "30002");
      assert.equal(evidence.delivery.destination_scope_key, scopeKey);
      return { checked: true };
    },
  );
  assert.equal(result.cleanupVerified, true);
  assert.deepEqual(result.result, { checked: true });
});

test("failed-Run verifier rejects success, wrong failure, changed result, and wrong delivery scope", async (t) => {
  for (const mutate of [
    (db) =>
      db.prepare("UPDATE runs SET status='succeeded',failure_code=NULL WHERE id=?").run(runId),
    (db) => db.prepare("UPDATE runs SET failure_code='provider_failed' WHERE id=?").run(runId),
    (db) => db.prepare("UPDATE runs SET result_text='不同回复' WHERE id=?").run(runId),
    (db) =>
      db.prepare("UPDATE deliveries SET destination_scope_key='other' WHERE run_id=?").run(runId),
  ]) {
    const f = fixture(t);
    const fs = await import("node:fs/promises");
    await fs.mkdir(f.directory, { recursive: true });
    await f.writeAudit();
    mutate(f.db);
    await assert.rejects(
      verifyGroupMembersPolicyFailureWithLeaseCleanup(
        f.db,
        f.directory,
        f.caseRecord,
        config,
        async () => ({ checked: true }),
      ),
      (error) => error.code === "GROUP_MEMBERS_POLICY_CASE_EVIDENCE",
    );
  }
});

test("failed-Run verifier rejects any ALLOW for Group B member read", async (t) => {
  const f = fixture(t);
  const fs = await import("node:fs/promises");
  await fs.mkdir(f.directory, { recursive: true });
  await f.writeAudit();
  f.db
    .prepare("INSERT INTO authorization_decisions VALUES ('decision-fixture',?,?,?,?,?,?,NULL)")
    .run(principal, "group:40004", "group:members:read", scopeKey, "ALLOW", runId);
  await assert.rejects(
    verifyGroupMembersPolicyFailureWithLeaseCleanup(
      f.db,
      f.directory,
      f.caseRecord,
      config,
      async () => ({ checked: true }),
    ),
    (error) => error.code === "GROUP_MEMBERS_POLICY_CASE_EVIDENCE",
  );
});
