import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { baseConfig } from "./fixture.mjs";
import { digest } from "../lib/core.mjs";
import {
  createAcceptanceMemoryNoIngressReceipt,
  verifyAcceptanceMemoryNoIngressReceipt,
} from "../lib/acceptance-memory-attempt-reconciliation.mjs";

const TOKEN = "a".repeat(32);
const LEASE = "11111111-1111-4111-8111-111111111111";
const TOOL_HASH = "b".repeat(64);
const ORIGIN = {
  reportSha256: "c".repeat(64),
  guardSha256: "d".repeat(64),
  sourceAuditSha256: "e".repeat(64),
};
const INVENTORY = { schemaVersion: 1, candidates: [] };
const PLAN_HASH = "f".repeat(64);

function scopeHash(config) {
  return digest(
    JSON.stringify([
      config.runtime.connectionId,
      config.bot.qq,
      "private",
      config.driver.qq,
      config.driver.qq,
      config.runtime.threadId ?? null,
    ]),
  );
}
function fixedPlan() {
  return {
    plan: {
      principalId: "owner",
      toolsSha256: TOOL_HASH,
      prompt: "清理固定候选 {{nonce}}",
    },
    sha256: PLAN_HASH,
  };
}
async function fixture(t, overrides = {}) {
  const root = await mkdtemp(join(tmpdir(), "memory-no-ingress-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await chmod(root, 0o700);
  const out = join(root, "out");
  const reportDirectory = join(out, "acceptance-memory-cleanup_old");
  const dataDirectory = join(root, "data");
  await (await import("node:fs/promises")).mkdir(reportDirectory, { recursive: true, mode: 0o700 });
  await (await import("node:fs/promises")).mkdir(dataDirectory, { recursive: true, mode: 0o700 });
  const config = baseConfig();
  config.runtime = { connectionId: "qq-live", threadId: null };
  const runtime = {
    checkout: "/workspace",
    dataDirectory,
    commit: "1".repeat(40),
    pid: 1234,
    connectionId: "qq-live",
    threadId: null,
  };
  const started = Date.now() - 5000;
  const finished = started + 1000;
  const startedAt = new Date(started).toISOString();
  const finishedAt = new Date(finished).toISOString();
  const registeredAt = new Date(started + 100).toISOString();
  const revokedAt = new Date(started + 500).toISOString();
  const expiresAt = Date.now() + 60000;
  const registration = {
    at: registeredAt,
    event: "lease_registered",
    expiresAt,
    leaseId: LEASE,
    marker: TOKEN,
    principalId: "owner",
    scopeSha256: scopeHash(config),
    toolsSha256: TOOL_HASH,
  };
  const revocation = {
    at: revokedAt,
    event: "lease_revoked",
    leaseId: LEASE,
    principalId: "owner",
  };
  const auditPath = join(dataDirectory, "qq-live-acceptance-audit.jsonl");
  const rows = overrides.rows ?? [registration, revocation];
  await writeFile(auditPath, rows.map((row) => JSON.stringify(row)).join("\n") + "\n", {
    mode: 0o600,
  });
  const db = new DatabaseSync(join(dataDirectory, "glassbox.db"));
  db.exec(
    "CREATE TABLE messages(id TEXT PRIMARY KEY, text TEXT NOT NULL); CREATE TABLE runs(id TEXT PRIMARY KEY, message_id TEXT NOT NULL);",
  );
  db.close();
  const stopPath = join(out, "STOP");
  await writeFile(stopPath, "INCONCLUSIVE\n", { mode: 0o600 });
  const reportPath = join(reportDirectory, "failure.json");
  const report = {
    schemaVersion: 1,
    kind: "acceptance-memory-cleanup",
    status: "INCONCLUSIVE",
    cleanupOnly: true,
    featurePass: false,
    planSha256: PLAN_HASH,
    origin: ORIGIN,
    runtime,
    startedAt,
    errorCode: "CLEANUP_REPLY_UNCONFIRMED",
    finishedAt,
    case: {
      id: "acceptance-memory-cleanup",
      status: "BLOCKED",
      code: "API_REJECTED",
      sendAttempted: true,
      inputObserved: false,
      leaseRevoked: true,
    },
  };
  await writeFile(reportPath, JSON.stringify(report) + "\n", { mode: 0o600 });
  const manifestPath = join(root, "input.json");
  const loaded = {
    origin: ORIGIN,
    inventory: INVENTORY,
    inventorySha256: "2".repeat(64),
    sourceAuditRows: [],
    manifestSha256: "3".repeat(64),
    inventoryFileSha256: "4".repeat(64),
    sourceAuditSha256: "5".repeat(64),
  };
  const deps = {
    runtimeSnapshot: async () => structuredClone(runtime),
    loadInputs: async () => structuredClone(loaded),
    readCurrentInventory: (_runtime, inventory) => ({
      inventory: structuredClone(inventory),
      inventorySha256: loaded.inventorySha256,
      db: new DatabaseSync(join(dataDirectory, "glassbox.db"), { readOnly: true }),
    }),
    buildPlan: () => fixedPlan(),
    openDb: (path) => new DatabaseSync(path, { readOnly: true }),
  };
  if (overrides.intent) {
    await writeFile(
      join(reportDirectory, "send-intent.json"),
      JSON.stringify(overrides.intent) + "\\n",
      { mode: 0o600 },
    );
  }
  return {
    root,
    out,
    reportDirectory,
    reportPath,
    manifestPath,
    dataDirectory,
    auditPath,
    stopPath,
    config,
    runtime,
    deps,
    report,
    registration,
    revocation,
  };
}
const options = (f) => ({
  reportPath: f.reportPath,
  reportDirectory: f.reportDirectory,
  manifestPath: f.manifestPath,
  config: f.config,
  out: f.out,
  deps: f.deps,
});

test("legacy API rejection gets a receipt only after current DB, unique lease and source plan agree", async (t) => {
  const f = await fixture(t);
  const result = await createAcceptanceMemoryNoIngressReceipt(options(f));
  assert.equal(result.status, "NO_INGRESS_VERIFIED");
  assert.equal(result.retryPermitted, true);
  const receipt = JSON.parse(await readFile(result.receiptPath, "utf8"));
  assert.equal(receipt.featurePass, false);
  assert.equal(receipt.marker, TOKEN);
  assert.equal(receipt.lease.leaseId, LEASE);
  assert.deepEqual(receipt.ingress, { matchingMessageCount: 0, matchingRunCount: 0 });
  assert.equal(
    await verifyAcceptanceMemoryNoIngressReceipt({
      ...options(f),
      receiptPath: result.receiptPath,
    }),
    true,
  );
});

test("a later matching message, Run, runtime or STOP change invalidates the receipt", async (t) => {
  const f = await fixture(t);
  const result = await createAcceptanceMemoryNoIngressReceipt(options(f));
  const db = new DatabaseSync(join(f.dataDirectory, "glassbox.db"));
  db.prepare("INSERT INTO messages(id,text) VALUES(?,?)").run(
    "inbound",
    "GLASSBOX_ACCEPTANCE_V1 " + TOKEN,
  );
  db.prepare("INSERT INTO runs(id,message_id) VALUES(?,?)").run("run-1", "inbound");
  db.close();
  assert.equal(
    await verifyAcceptanceMemoryNoIngressReceipt({
      ...options(f),
      receiptPath: result.receiptPath,
    }),
    false,
  );
});

test("receipt permits only canonical append-only audit rows unrelated to the old marker and lease", async (t) => {
  const f = await fixture(t);
  const result = await createAcceptanceMemoryNoIngressReceipt(options(f));
  const original = await readFile(f.auditPath);
  const nextRegistration = {
    ...f.registration,
    at: new Date(Date.parse(f.report.finishedAt) + 10000).toISOString(),
    expiresAt: Date.now() + 120000,
    leaseId: "22222222-2222-4222-8222-222222222222",
    marker: "b".repeat(32),
  };
  await writeFile(
    f.auditPath,
    Buffer.concat([original, Buffer.from(JSON.stringify(nextRegistration) + "\n")]),
  );
  assert.equal(
    await verifyAcceptanceMemoryNoIngressReceipt({
      ...options(f),
      receiptPath: result.receiptPath,
    }),
    true,
  );
  const reused = {
    ...nextRegistration,
    leaseId: LEASE,
    marker: TOKEN,
  };
  await writeFile(
    f.auditPath,
    Buffer.concat([await readFile(f.auditPath), Buffer.from(JSON.stringify(reused) + "\n")]),
  );
  assert.equal(
    await verifyAcceptanceMemoryNoIngressReceipt({
      ...options(f),
      receiptPath: result.receiptPath,
    }),
    false,
  );
});

test("receipt rejects audit truncation or prefix rewrite", async (t) => {
  const f = await fixture(t);
  const result = await createAcceptanceMemoryNoIngressReceipt(options(f));
  const bytes = await readFile(f.auditPath);
  await writeFile(f.auditPath, bytes.subarray(0, bytes.length - 1));
  assert.equal(
    await verifyAcceptanceMemoryNoIngressReceipt({
      ...options(f),
      receiptPath: result.receiptPath,
    }),
    false,
  );
  await writeFile(f.auditPath, Buffer.concat([Buffer.from(" "), bytes]));
  assert.equal(
    await verifyAcceptanceMemoryNoIngressReceipt({
      ...options(f),
      receiptPath: result.receiptPath,
    }),
    false,
  );
});

test("requires one paired lease and refuses run binding, duplicate registration, wrong actor and incomplete revocation", async (t) => {
  const f = await fixture(t);
  const variants = [
    [f.registration],
    [
      f.registration,
      f.revocation,
      { ...f.registration, leaseId: "22222222-2222-4222-8222-222222222222" },
    ],
    [f.registration, { ...f.revocation, principalId: "other" }],
    [
      f.registration,
      f.revocation,
      {
        at: new Date(Date.now()).toISOString(),
        event: "run_bound",
        leaseId: LEASE,
        marker: TOKEN,
        principalId: "owner",
        runId: "run-1",
      },
    ],
  ];
  for (const rows of variants) {
    const g = await fixture(t, { rows });
    await assert.rejects(createAcceptanceMemoryNoIngressReceipt(options(g)));
  }
});

test("a send-intent must bind the derived unique marker and lease exactly", async (t) => {
  const f = await fixture(t);
  await writeFile(
    join(f.reportDirectory, "send-intent.json"),
    JSON.stringify({
      schemaVersion: 1,
      kind: "acceptance-memory-cleanup-send-intent",
      status: "SEND_MAY_HAVE_STARTED",
      planSha256: PLAN_HASH,
      token: "9".repeat(32),
      route: "private",
      startedAt: f.report.startedAt,
      promptSha256: "a".repeat(64),
      leaseRegistrationAttempted: true,
      acceptanceLease: {
        leaseId: LEASE,
        expiresAt: f.registration.expiresAt,
        toolsSha256: TOOL_HASH,
      },
    }) + "\n",
    { mode: 0o600 },
  );
  await assert.rejects(createAcceptanceMemoryNoIngressReceipt(options(f)));
});
