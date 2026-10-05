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
        inputBinding: { botMessageId: "bot-input-1" },
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
            input: { realSequence: "101", time: 1791158400000, textSha256: "c".repeat(64) },
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
        event: { type: "message_received", externalId: "bot-input-1", ...scope },
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
    { type: "message_received", externalId: "bot-input-1", ...scope },
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
