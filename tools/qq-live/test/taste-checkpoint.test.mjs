import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rename, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { digest } from "../lib/core.mjs";
import { readTasteCheckpointRecord, writeTasteCheckpoint } from "../lib/taste-checkpoint.mjs";
import { TASTE_FAMILY_ID } from "../lib/taste-scenario.mjs";
import { tasteRecoveryPlan } from "../lib/taste-recovery.mjs";

async function createCheckpointFixture(root) {
  const outDirectory = join(root, "reports");
  const reportDirectory = join(outDirectory, "run-1");
  const lockDirectory = join(root, "locks");
  await mkdir(reportDirectory, { recursive: true });
  await mkdir(lockDirectory, { recursive: true });
  return {
    outDirectory,
    reportDirectory,
    pendingPath: join(lockDirectory, "taste-pending.json"),
    journalPath: join(reportDirectory, "taste-fixture.jsonl"),
    runtime: {
      checkout: "/checkout",
      dataDirectory: "/data",
      commit: "a".repeat(40),
      pid: 123,
      connectionId: "connection",
      threadId: null,
    },
    scope: {
      connectionId: "connection",
      botId: "bot-1",
      chatType: "private",
      chatId: "driver-1",
      senderId: "driver-1",
      threadId: null,
    },
    driverQQ: "driver-1",
  };
}

function seal(row) {
  row.checkpointSha256 = digest(JSON.stringify(row));
  return row;
}

function nextRow(fixture, previous, phase, overrides = {}) {
  return seal({
    schemaVersion: 1,
    familyId: TASTE_FAMILY_ID,
    sequence: previous ? previous.sequence + 1 : 1,
    previousSha256: previous?.checkpointSha256 ?? null,
    phase,
    stage: previous?.stage ?? "feedback",
    steps: previous?.steps ?? [],
    handles: previous?.handles ?? {
      fixtureNonce: "1".repeat(32),
      projectId: `qqtest-${"1".repeat(32)}`,
    },
    origin: previous?.origin ?? {
      familyId: TASTE_FAMILY_ID,
      runtime: fixture.runtime,
      scope: fixture.scope,
      driverSha256: digest(fixture.driverQQ),
      suiteSha256: "b".repeat(64),
      startedAt: new Date().toISOString(),
    },
    runId: "run-1",
    reportDirectory: fixture.reportDirectory,
    ...overrides,
  });
}

async function appendCheckpoint(fixture, previous, phase, overrides = {}, io) {
  const row = nextRow(fixture, previous, phase, overrides);
  await writeTasteCheckpoint({
    pendingPath: fixture.pendingPath,
    journalPath: fixture.journalPath,
    row,
    first: !previous,
    ...(io ? { io } : {}),
  });
  return row;
}

const testIO = { syncDirectory: async () => {} };

test("Taste checkpoint reader requires canonical pending bytes to match the journal tip", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "taste-checkpoint-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const outDirectory = join(root, "reports");
  const reportDirectory = join(outDirectory, "run-1");
  const lockDirectory = join(root, "locks");
  await mkdir(reportDirectory, { recursive: true });
  await mkdir(lockDirectory, { recursive: true });
  const runtime = {
    checkout: "/checkout",
    dataDirectory: "/data",
    commit: "a".repeat(40),
    pid: 123,
    connectionId: "connection",
    threadId: null,
  };
  const scope = {
    connectionId: "connection",
    botId: "bot-1",
    chatType: "private",
    chatId: "driver-1",
    senderId: "driver-1",
    threadId: null,
  };
  const driverQQ = "driver-1";
  const origin = {
    familyId: TASTE_FAMILY_ID,
    runtime,
    scope,
    driverSha256: digest(driverQQ),
    suiteSha256: "b".repeat(64),
    startedAt: new Date().toISOString(),
  };
  const row = seal({
    schemaVersion: 1,
    familyId: TASTE_FAMILY_ID,
    sequence: 1,
    previousSha256: null,
    phase: "before_send",
    stage: "feedback",
    steps: [],
    handles: {
      fixtureNonce: "1".repeat(32),
      projectId: `qqtest-${"1".repeat(32)}`,
    },
    origin,
    runId: "run-1",
    reportDirectory,
  });
  const pendingPath = join(lockDirectory, "taste-pending.json");
  const journalPath = join(reportDirectory, "taste-fixture.jsonl");
  const serialized = `${JSON.stringify(row)}\n`;
  await writeFile(pendingPath, serialized);
  await writeFile(journalPath, serialized);

  const record = await readTasteCheckpointRecord({
    pendingPath,
    outDirectory,
    runtime,
    scope,
    driverQQ,
  });
  assert.equal(record.pending.checkpointSha256, row.checkpointSha256);

  const pending = JSON.parse(await readFile(pendingPath, "utf8"));
  await writeFile(pendingPath, `${JSON.stringify(pending)} \n`);
  await assert.rejects(
    readTasteCheckpointRecord({
      pendingPath,
      outDirectory,
      runtime,
      scope,
      driverQQ,
    }),
    { code: "TASTE_CHECKPOINT_JSON" },
  );
});

test("Taste checkpoint reader recovers one journal append after pending replacement fails", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "taste-checkpoint-crash-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fixture = await createCheckpointFixture(root);
  const before = await appendCheckpoint(fixture, null, "before_send", {}, testIO);
  const intent = await appendCheckpoint(fixture, before, "lease_intent", {}, testIO);
  const prepared = await appendCheckpoint(
    fixture,
    intent,
    "prepared",
    {
      preparedCase: {
        caseId: "taste-feedback",
        marker: "2".repeat(32),
        textSha256: "c".repeat(64),
        route: "private",
      },
    },
    testIO,
  );
  const sent = await appendCheckpoint(
    fixture,
    prepared,
    "sent",
    {
      sentCase: { caseId: "taste-feedback", driverMessageId: "9001" },
    },
    testIO,
  );
  const pendingBefore = await readFile(fixture.pendingPath, "utf8");
  let failPendingRename = true;
  const io = {
    ...testIO,
    rename: async (source, target) => {
      if (failPendingRename && target === fixture.pendingPath) {
        failPendingRename = false;
        throw new Error("simulated pending publish interruption");
      }
      return rename(source, target);
    },
  };
  const observedRow = nextRow(fixture, sent, "observed", {
    steps: [{ stage: "feedback", runId: "glassbox-run-1" }],
    handles: {
      ...sent.handles,
      principalId: "owner-1",
      candidateId: `candidate_${"3".repeat(32)}`,
      creationRunId: "glassbox-run-1",
      stepRunId: "glassbox-run-1",
    },
  });
  const observed = await writeTasteCheckpoint({
    pendingPath: fixture.pendingPath,
    journalPath: fixture.journalPath,
    row: observedRow,
    first: false,
    io,
  }).catch((error) => error);

  assert.equal(observed.code, "MEMORY_CHECKPOINT_IO");
  assert.equal(observed.operation, "pending_replace_rename");
  assert.equal(observedRow.phase, "observed");
  assert.equal(await readFile(fixture.pendingPath, "utf8"), pendingBefore);

  const record = await readTasteCheckpointRecord(fixture);
  assert.equal(record.pending.checkpointSha256, observedRow.checkpointSha256);
  assert.equal(record.pending.phase, "observed");
  assert.equal(record.pendingLag, 1);
  assert.equal(record.pendingFileRow.checkpointSha256, sent.checkpointSha256);
  assert.equal(await readFile(fixture.pendingPath, "utf8"), pendingBefore);
  const runtime = { ...fixture.runtime };
  const recovery = tasteRecoveryPlan(
    record,
    {
      status: "NEEDS_CLEANUP",
      stage: "feedback",
      handles: record.pending.handles,
      recoveryActions: ["reject-candidate"],
    },
    runtime,
  );
  assert.deepEqual(recovery?.plan.actions, ["reject-candidate"]);

  const tooOldPending = JSON.stringify(before) + "\n";
  await writeFile(fixture.pendingPath, tooOldPending);
  await assert.rejects(readTasteCheckpointRecord(fixture), {
    code: "TASTE_CHECKPOINT_PENDING",
  });
});

test("Taste checkpoint reader accepts one-behind prepared tip without making it recoverable", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "taste-checkpoint-unknown-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fixture = await createCheckpointFixture(root);
  const before = await appendCheckpoint(fixture, null, "before_send", {}, testIO);
  const intent = await appendCheckpoint(fixture, before, "lease_intent", {}, testIO);
  const pendingBefore = await readFile(fixture.pendingPath, "utf8");
  let failPendingRename = true;
  const row = nextRow(fixture, intent, "prepared", {
    preparedCase: {
      caseId: "taste-feedback",
      marker: "4".repeat(32),
      textSha256: "d".repeat(64),
      route: "private",
    },
  });
  await assert.rejects(
    writeTasteCheckpoint({
      pendingPath: fixture.pendingPath,
      journalPath: fixture.journalPath,
      row,
      first: false,
      io: {
        ...testIO,
        rename: async (source, target) => {
          if (failPendingRename && target === fixture.pendingPath) {
            failPendingRename = false;
            throw new Error("simulated pending publish interruption");
          }
          return rename(source, target);
        },
      },
    }),
    { code: "MEMORY_CHECKPOINT_IO" },
  );
  const record = await readTasteCheckpointRecord(fixture);
  assert.equal(record.pending.checkpointSha256, row.checkpointSha256);
  assert.equal(record.pending.phase, "prepared");
  assert.equal(record.pendingLag, 1);
  assert.equal(await readFile(fixture.pendingPath, "utf8"), pendingBefore);
  assert.equal(
    tasteRecoveryPlan(
      record,
      {
        status: "NEEDS_CLEANUP",
        stage: "feedback",
        handles: record.pending.handles,
      },
      fixture.runtime,
    ),
    null,
  );
});

test("Taste checkpoint reader rejects observed rows without a preceding sent phase", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "taste-checkpoint-transition-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fixture = await createCheckpointFixture(root);
  const before = await appendCheckpoint(fixture, null, "before_send", {}, testIO);
  await appendCheckpoint(
    fixture,
    before,
    "observed",
    { steps: [{ stage: "feedback", runId: "glassbox-run-1" }] },
    testIO,
  );
  await assert.rejects(readTasteCheckpointRecord(fixture), {
    code: "TASTE_CHECKPOINT_TRANSITION",
  });
});
