import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { digest, toolManifestDigest } from "../lib/core.mjs";
import { resolveReadFeatureSpecs } from "../lib/feature-specs.mjs";
import { runtimeSnapshot, verifyFailedCaseCleanup } from "../lib/product-evidence.mjs";
import { baseConfig } from "./fixture.mjs";

const TOKEN = "a".repeat(32);
const LEASE_ID = "11111111-1111-4111-8111-111111111111";
const OWNER_ID = "owner-fixture";

function runtimeCapture(runtime) {
  return (command, args) => {
    if (command === "git") {
      if (args[0] === "rev-parse") return runtime.expectedCommit;
      if (args[0] === "status") return "";
    }
    if (args?.at(-1) === "status")
      return JSON.stringify({
        dataDirectory: runtime.dataDirectory,
        glassboxReady: true,
        onebotReady: true,
        processes: [
          {
            name: "glassbox",
            running: true,
            status: "running",
            pid: 12345,
            checkout: runtime.checkout,
            launchCommit: runtime.expectedCommit,
            launchClean: true,
          },
        ],
      });
    throw new Error("Unexpected runtime probe");
  };
}

async function makeFixture(t, { markedMessage = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), "pre-run-cleanup-dispatch-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await chmod(root, 0o700);
  const dataDirectory = join(root, "data");
  await (await import("node:fs/promises")).mkdir(dataDirectory, { mode: 0o700 });
  const config = baseConfig();
  config.runtime = {
    checkout: root,
    dataDirectory,
    expectedCommit: "a".repeat(40),
    connectionId: "qq-live",
    threadId: null,
  };
  const specDocument = JSON.parse(
    await readFile(new URL("../examples/feature-read.example.json", import.meta.url), "utf8"),
  );
  const spec = resolveReadFeatureSpecs(
    {
      schemaVersion: 2,
      cases: specDocument.cases.filter((item) => item.id === "qq-group-a-root-files-read"),
    },
    config,
  )[0];
  const started = Date.now() - 2_000;
  const finished = Date.now() - 1_000;
  const startedAt = new Date(started).toISOString();
  const finishedAt = new Date(finished).toISOString();
  const prompt =
    `GLASSBOX_ACCEPTANCE_V1 ${TOKEN}\n` + spec.prompt.trim().replaceAll("{{nonce}}", TOKEN);
  const leaseTools = JSON.parse(JSON.stringify(spec.leaseTools).replaceAll("{{nonce}}", TOKEN));
  const featureAssertions = JSON.parse(
    JSON.stringify(spec.featureAssertions).replaceAll("{{nonce}}", TOKEN),
  );
  const expiresAt = Date.now() + 60_000;
  const scope = {
    connectionId: config.runtime.connectionId,
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
      scope.threadId,
    ]),
  );
  const auditRows = [
    {
      at: new Date(started + 100).toISOString(),
      event: "lease_registered",
      expiresAt,
      leaseId: LEASE_ID,
      marker: TOKEN,
      principalId: OWNER_ID,
      scopeSha256,
      toolsSha256: toolManifestDigest(leaseTools),
      textSha256: digest(prompt),
    },
    {
      at: new Date(started + 500).toISOString(),
      event: "lease_revoked",
      leaseId: LEASE_ID,
      principalId: OWNER_ID,
      marker: TOKEN,
      scopeSha256,
    },
  ];
  await writeFile(
    join(dataDirectory, "qq-live-acceptance-audit.jsonl"),
    auditRows.map((row) => JSON.stringify(row)).join("\n") + "\n",
    { mode: 0o600 },
  );
  const db = new DatabaseSync(join(dataDirectory, "glassbox.db"));
  db.exec(`
    CREATE TABLE principals (id TEXT PRIMARY KEY, kind TEXT NOT NULL);
    CREATE TABLE channel_identities (identity_key TEXT PRIMARY KEY, principal_id TEXT NOT NULL);
    CREATE TABLE messages (id TEXT PRIMARY KEY, text TEXT NOT NULL);
    CREATE TABLE runs (id TEXT PRIMARY KEY, message_id TEXT NOT NULL);
  `);
  db.prepare("INSERT INTO principals VALUES (?, 'owner')").run(OWNER_ID);
  db.prepare("INSERT INTO channel_identities VALUES (?, ?)").run(
    JSON.stringify([config.runtime.connectionId, config.bot.qq, config.driver.qq]),
    OWNER_ID,
  );
  if (markedMessage) {
    db.prepare("INSERT INTO messages VALUES (?, ?)").run("unexpected-message", prompt);
    db.prepare("INSERT INTO runs VALUES (?, ?)").run("unexpected-run", "unexpected-message");
  }
  db.close();
  const caseRecord = {
    id: spec.id,
    status: "BLOCKED",
    code: "API_REJECTED",
    route: "private",
    prompt,
    expected: [TOKEN],
    sendAttempted: true,
    inputObserved: false,
    leaseRegistrationAttempted: true,
    leaseRevoked: true,
    token: TOKEN,
    startedAt,
    finishedAt,
    acceptanceLease: {
      leaseId: LEASE_ID,
      expiresAt,
      toolsSha256: toolManifestDigest(leaseTools),
    },
    leaseTools,
    leasedToolNames: leaseTools.map((tool) => tool.name),
    featureAssertions,
    botInputMessageIds: [],
    botInputCandidates: [],
    replies: [],
    anomalies: [],
  };
  return { config, caseRecord, capture: runtimeCapture(config.runtime) };
}

test("failed cleanup dispatcher verifies fixed API_REJECTED pre-Run case against SQLite and lease audit", async (t) => {
  const { config, caseRecord, capture } = await makeFixture(t);
  const result = await verifyFailedCaseCleanup(
    {
      mode: "run",
      status: "BLOCKED",
      runtime: runtimeSnapshot(config.runtime, capture),
      cases: [caseRecord],
    },
    config,
    capture,
  );
  assert.equal(result.status, "CLEANUP_VERIFIED");
  assert.equal(result.cases[0].caseId, caseRecord.id);
  assert.equal(result.cases[0].cleanupOnly, true);
  assert.equal(result.cases[0].actualQqDeliveryVerified, false);
  assert.equal(result.cases[0].featureStatus, "INCONCLUSIVE");
  assert.equal(result.cases[0].zeroMarkedMessages, true);
  assert.equal(result.cases[0].zeroMarkedRuns, true);
});

test("pre-Run cleanup dispatch rejects marker rows in the real SQLite fixture", async (t) => {
  const { config, caseRecord, capture } = await makeFixture(t, {
    markedMessage: true,
  });
  const report = {
    mode: "run",
    status: "BLOCKED",
    runtime: runtimeSnapshot(config.runtime, capture),
    cases: [caseRecord],
  };
  await assert.rejects(verifyFailedCaseCleanup(report, config, capture), {
    code: "PRE_RUN_CLEANUP_EVIDENCE",
    cleanupVerified: false,
  });
});
