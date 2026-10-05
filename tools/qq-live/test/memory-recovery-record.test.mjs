import test from "node:test";
import { recoveryCheckpointState } from "../lib/memory-recovery-cli.mjs";
import assert from "node:assert/strict";
import { posix } from "node:path";
import { digest, toolManifestDigest } from "../lib/core.mjs";
import { memoryFixtureProject, memoryFixtureStep } from "../lib/memory-scenario.mjs";
import { readMemoryRecoveryRecord } from "../lib/memory-recovery-record.mjs";

const DRIVER = "123456789";
const NONCE = "a".repeat(32);
const MARKER = "b".repeat(32);
const CANDIDATE = `candidate_${"c".repeat(32)}`;
const MEMORY = `memory_${"d".repeat(32)}`;
const RUN_ID = "2026-10-06T10-00-00.000Z_abcdef12";
const REPORT_DIRECTORY = `/tmp/qq-live-report/${RUN_ID}`;
const RUNTIME = {
  checkout: "/srv/glassbox",
  dataDirectory: "/var/lib/glassbox",
  commit: "e".repeat(40),
  pid: 781,
  connectionId: "qq-onebot-main",
  threadId: null,
};
const ORIGIN = {
  runtime: { ...RUNTIME, pid: 772 },
  process: {
    pid: 901,
    bootId:
      "f".repeat(8) +
      "-" +
      "1".repeat(4) +
      "-" +
      "2".repeat(4) +
      "-" +
      "3".repeat(4) +
      "-" +
      "4".repeat(12),
    startTicks: "987654321",
  },
  scope: {
    connectionId: "qq-onebot-main",
    botId: "987654321",
    chatType: "private",
    chatId: DRIVER,
    senderId: DRIVER,
    threadId: null,
  },
  driverSha256: digest(DRIVER),
  suiteSha256: "9".repeat(64),
  startedAt: "2026-10-06T10:00:00.000Z",
};
const SCOPE = { ...ORIGIN.scope };

function fixtureHandles(stage, phase) {
  const handles = { fixtureNonce: NONCE, projectId: memoryFixtureProject(NONCE) };
  if (stage !== "feedback")
    Object.assign(handles, {
      principalId: "principal-owner",
      creationRunId: "run-create-0001",
      candidateId: CANDIDATE,
      stepRunId: "run-create-0001",
    });
  if (stage === "expire" || (stage === "promote" && phase === "observed"))
    Object.assign(handles, {
      memoryId: MEMORY,
      promoteRunId: "run-promote-0002",
      stepRunId: "run-promote-0002",
    });
  if (stage === "feedback" && phase === "observed")
    Object.assign(handles, {
      principalId: "principal-owner",
      creationRunId: "run-create-0001",
      candidateId: CANDIDATE,
      stepRunId: "run-create-0001",
    });
  if (stage === "promote" && phase === "observed")
    Object.assign(handles, {
      promoteRunId: "run-promote-0002",
      stepRunId: "run-promote-0002",
    });
  if (stage === "expire" && phase === "observed")
    Object.assign(handles, {
      cleanupRunId: "run-expire-0003",
      cleanupStatus: "expired",
      stepRunId: "run-expire-0003",
    });
  return handles;
}

function acceptedStep(stage, currentRunId) {
  return {
    stage,
    currentRunId,
    runId: currentRunId,
    productAcceptance: {
      status: "PASS",
      runtime: { ...ORIGIN.runtime },
      caseId: `memory-${stage}`,
      traceVerified: true,
      featureStatus: "PASS",
    },
  };
}

function earlierSteps(stage, phase) {
  const index = ["feedback", "promote", "expire"].indexOf(stage);
  const count = index + (phase === "observed" ? 1 : 0);
  return ["feedback", "promote", "expire"]
    .slice(0, count)
    .map((step, i) =>
      acceptedStep(step, ["run-create-0001", "run-promote-0002", "run-expire-0003"][i]),
    );
}

function promptHash(stage, marker = MARKER, handles = fixtureHandles(stage, "before_send")) {
  const spec = memoryFixtureStep(stage, {
    nonce: NONCE,
    candidateId: handles.candidateId,
    memoryId: handles.memoryId,
  });
  return digest(
    `GLASSBOX_ACCEPTANCE_V1 ${marker}\n${spec.prompt.trim().replaceAll("{{nonce}}", marker)}`,
  );
}

function originalPrepared(stage, phase, handles) {
  if (!["lease_intent", "prepared", "sent"].includes(phase)) return {};
  const base = {
    caseId: `memory-${stage}`,
    marker: MARKER,
    textSha256: promptHash(stage, MARKER, handles),
    startedAt: "2026-10-06T10:01:00.000Z",
    route: "private",
  };
  if (phase === "lease_intent") return { preparedCase: base };
  const spec = memoryFixtureStep(stage, {
    nonce: NONCE,
    candidateId: handles.candidateId,
    memoryId: handles.memoryId,
  });
  return {
    preparedCase: {
      ...base,
      leaseId: "12345678-1234-1234-1234-123456789abc",
      expiresAt: Date.parse(base.startedAt) + 600_000,
      toolsSha256: toolManifestDigest(spec.leaseTools),
    },
  };
}

function recoveryPrepared(stage, phase, handles, marker = "9".repeat(32)) {
  if (!["lease_intent", "prepared", "sent"].includes(phase)) return {};
  const spec = memoryFixtureStep(stage, {
    nonce: NONCE,
    candidateId: handles.candidateId,
    memoryId: handles.memoryId,
  });
  const base = {
    caseId: `memory-${stage}`,
    marker,
    textSha256: promptHash(stage, marker, handles),
    startedAt: "2026-10-06T10:02:00.000Z",
    route: "private",
  };
  if (phase === "lease_intent") return { preparedCase: base };
  return {
    preparedCase: {
      ...base,
      leaseId: "abcdef12-1234-1234-1234-123456789abc",
      expiresAt: Date.parse(base.startedAt) + 600_000,
      toolsSha256: toolManifestDigest(spec.leaseTools),
    },
  };
}

function rowAt(
  sequence,
  phase = "before_send",
  stage = "feedback",
  previousSha256 = null,
  patch = {},
) {
  const handles = fixtureHandles(stage, phase);
  const row = {
    schemaVersion: 2,
    origin: structuredClone(ORIGIN),
    sequence,
    previousSha256,
    phase,
    stage,
    handles,
    steps: earlierSteps(stage, phase),
    ...originalPrepared(stage, phase, handles),
    ...(phase === "sent"
      ? {
          sentCase: {
            caseId: `memory-${stage}`,
            driverMessageId: "9000001",
            startedAt: "2026-10-06T10:01:00.000Z",
          },
        }
      : {}),
    at: new Date(Date.parse(ORIGIN.startedAt) + sequence * 1000).toISOString(),
    runId: RUN_ID,
    reportDirectory: REPORT_DIRECTORY,
    ...patch,
  };
  row.checkpointSha256 = digest(JSON.stringify(row));
  return row;
}

function journalOf(rows) {
  return rows.map((row) => JSON.stringify(row)).join("\n") + "\n";
}

function sourceFor(pending, rows, { pendingText, journalText } = {}) {
  const files = new Map([
    ["/locks/driver.memory-pending.json", pendingText ?? journalOf([pending])],
    [joinReport(REPORT_DIRECTORY), journalText ?? journalOf(rows)],
  ]);
  const reads = [];
  return {
    reads,
    read: async (path, maxBytes) => {
      reads.push({ path, maxBytes });
      if (!files.has(path)) throw new Error("not found");
      return Buffer.from(files.get(path), "utf8");
    },
  };
}

function joinReport(directory) {
  return posix.join(directory, "memory-fixture.jsonl");
}

async function loadRecord(pending, rows, options = {}) {
  const source = sourceFor(pending, rows, options);
  const result = await readMemoryRecoveryRecord({
    pendingPath: "/locks/driver.memory-pending.json",
    driverQQ: DRIVER,
    scope: SCOPE,
    runtime: RUNTIME,
    read: source.read,
  });
  return { result, source };
}

function validFeedbackRows() {
  const rows = [];
  for (const phase of ["before_send", "lease_intent", "prepared", "sent", "observed"])
    rows.push(rowAt(rows.length + 1, phase, "feedback", rows.at(-1)?.checkpointSha256 ?? null));
  return rows;
}

function attachHash(row) {
  const { checkpointSha256: _old, ...unsigned } = row;
  const next = { ...unsigned };
  next.checkpointSha256 = digest(JSON.stringify(next));
  return next;
}

test("reads a valid prepared guard and accepts a service PID change", async () => {
  const rows = validFeedbackRows();
  const pending = rows[2];
  const { result, source } = await loadRecord(pending, rows.slice(0, 3));
  assert.equal(result.confirmedSequence, 3);
  assert.equal(result.pending.phase, "prepared");
  assert.equal(result.pending.preparedCase.marker, MARKER);
  assert.equal(result.origin.runtime.pid, 772);
  assert.equal(result.runId, RUN_ID);
  assert.deepEqual(
    source.reads.map((entry) => entry.maxBytes),
    [1024 * 1024 + 1, 40 * (1024 * 1024 + 1)],
  );
});

test("returns a validated journal tail beyond the pending guard without dropping its marker", async () => {
  const rows = validFeedbackRows().slice(0, 3);
  const pending = rows[1];
  const tail = rowAt(4, "sent", "feedback", rows[2].checkpointSha256);
  const { result } = await loadRecord(pending, [...rows, tail]);
  assert.equal(result.confirmedSequence, 2);
  assert.equal(result.rows.length, 4);
  assert.equal(result.rows[3].preparedCase.marker, MARKER);
  assert.equal(result.pending.sequence, 2);
});

test("rejects legacy, torn, tampered hash, and broken chain records", async (t) => {
  await t.test("legacy schema", async () => {
    const row = attachHash({ ...rowAt(1), schemaVersion: 1 });
    await assert.rejects(loadRecord(row, [row]));
  });
  await t.test("torn JSON", async () => {
    const row = rowAt(1);
    await assert.rejects(loadRecord(row, [row], { journalText: JSON.stringify(row) }));
  });
  await t.test("content hash", async () => {
    const row = rowAt(1);
    row.stage = "expire";
    await assert.rejects(loadRecord(row, [row]));
  });
  await t.test("previous hash", async () => {
    const rows = validFeedbackRows().slice(0, 2);
    rows[1].previousSha256 = "0".repeat(64);
    rows[1] = attachHash(rows[1]);
    await assert.rejects(loadRecord(rows[1], rows));
  });
});

test("rejects wrong scope, Driver hash, Runtime commit, process identity, and report path", async (t) => {
  const mutate = [
    (row) => {
      row.origin.scope.chatId = "111111111";
    },
    (row) => {
      row.origin.driverSha256 = "0".repeat(64);
    },
    (row) => {
      row.origin.runtime.commit = "0".repeat(40);
    },
    (row) => {
      delete row.origin.process.startTicks;
    },
    (row) => {
      row.reportDirectory = "/tmp/other-run";
    },
  ];
  for (const [index, change] of mutate.entries()) {
    await t.test(`invalid identity ${index + 1}`, async () => {
      const row = rowAt(1);
      change(row);
      const tampered = attachHash(row);
      await assert.rejects(loadRecord(tampered, [tampered]));
    });
  }
});

test("rejects cross-project, invalid resource IDs, duplicate sequence, and extra payload fields", async (t) => {
  await t.test("wrong project", async () => {
    const row = rowAt(1);
    row.handles.projectId = memoryFixtureProject("b".repeat(32));
    const changed = attachHash(row);
    await assert.rejects(loadRecord(changed, [changed]));
  });
  await t.test("bad candidate ID", async () => {
    const row = rowAt(5, "observed");
    row.handles = {
      ...row.handles,
      principalId: "principal-owner",
      candidateId: "candidate_old-format",
      creationRunId: "run-create-0001",
      stepRunId: "run-create-0001",
    };
    row.steps = earlierSteps("feedback", "observed");
    const changed = attachHash(row);
    await assert.rejects(loadRecord(changed, [changed]));
  });
  await t.test("duplicate sequence", async () => {
    const first = rowAt(1);
    const second = rowAt(1, "lease_intent", "feedback", first.checkpointSha256);
    await assert.rejects(loadRecord(second, [first, second]));
  });
  await t.test("extra payload rejected", async () => {
    const row = rowAt(1, "before_send", "feedback", null, { prompt: "private body" });
    const changed = attachHash(row);
    await assert.rejects(loadRecord(changed, [changed]));
  });
});

test("rejects checkpoint and journal size limits", async (t) => {
  await t.test("oversized row", async () => {
    const row = rowAt(1, "before_send", "feedback", null, {
      reportDirectory: `/${"x".repeat(1024 * 1024)}/${RUN_ID}`,
    });
    const changed = attachHash(row);
    await assert.rejects(loadRecord(changed, [changed]));
  });
  await t.test("too many rows", async () => {
    const rows = Array.from({ length: 41 }, (_, index) => rowAt(index + 1));
    await assert.rejects(loadRecord(rows.at(-1), rows));
  });
});

test("rejects invalid lease manifest, prepared marker, and sent receipt", async (t) => {
  await t.test("marker hash mismatch", async () => {
    const row = rowAt(1, "prepared");
    row.preparedCase.textSha256 = "0".repeat(64);
    const changed = attachHash(row);
    await assert.rejects(loadRecord(changed, [changed]));
  });
  await t.test("tools hash mismatch", async () => {
    const row = rowAt(1, "prepared");
    row.preparedCase.toolsSha256 = "0".repeat(64);
    const changed = attachHash(row);
    await assert.rejects(loadRecord(changed, [changed]));
  });
  await t.test("invalid sent receipt", async () => {
    const row = rowAt(1, "sent");
    row.sentCase.driverMessageId = "not-an-id";
    const changed = attachHash(row);
    await assert.rejects(loadRecord(changed, [changed]));
  });
});

function recoveryAttempt(phase, patch = {}, stage = "reject", handles = recoveryHandles("reject")) {
  return {
    attemptId: "8".repeat(32),
    process: {
      pid: 944,
      bootId: ORIGIN.process.bootId,
      startTicks: "1234567890",
    },
    currentRuntime: { ...RUNTIME },
    stage,
    phase,
    handles,
    ...recoveryPrepared(stage, phase, handles),
    ...(phase === "sent"
      ? {
          sentCase: {
            caseId: `memory-${stage}`,
            driverMessageId: "9000002",
            startedAt: "2026-10-06T10:02:00.000Z",
          },
        }
      : {}),
    ...(phase === "observed" ? { cleanupRunId: "run-reject-0004" } : {}),
    ...patch,
  };
}

function recoveryHandles(stage) {
  return {
    fixtureNonce: NONCE,
    projectId: memoryFixtureProject(NONCE),
    principalId: "principal-owner",
    candidateId: CANDIDATE,
    creationRunId: "run-create-0001",
    ...(stage === "expire" ? { promoteRunId: "run-promote-0002", memoryId: MEMORY } : {}),
  };
}

function recoveryRows(
  attemptPatches = [],
  { rows = validFeedbackRows(), stage = "reject", handles } = {},
) {
  const phases = ["before_send", "lease_intent", "prepared", "sent", "observed"];
  for (let index = 0; index < attemptPatches.length; index++) {
    const attempt = recoveryAttempt(phases[index], attemptPatches[index], stage, handles);
    const previous = rows.at(-1);
    rows.push(
      attachHash({
        ...previous,
        sequence: rows.length + 1,
        previousSha256: previous.checkpointSha256,
        at: new Date(Date.parse(ORIGIN.startedAt) + (rows.length + 1) * 1000).toISOString(),
        recoveryAttempt: attempt,
      }),
    );
  }
  return rows;
}

test("validates recovery attempt identity and fixed reject message through observed cleanup", async () => {
  const rows = recoveryRows([{}, {}, {}, {}, {}]);
  const { result } = await loadRecord(rows.at(-1), rows);
  assert.equal(result.pending.recoveryAttempt.phase, "observed");
  assert.equal(result.pending.recoveryAttempt.cleanupRunId, "run-reject-0004");
  assert.equal(result.pending.recoveryAttempt.stage, "reject");
});

test("CLI checkpoint projection remains readable after coordinator adds cleanup evidence", async () => {
  const handles = recoveryHandles("reject");
  const start = recoveryCheckpointState({
    phase: "recovery_prepared",
    stage: "reject",
    handles,
    plan: { privateMetadata: true },
    spec: { prompt: "not checkpoint metadata" },
  });
  const finish = recoveryCheckpointState({
    phase: "recovery_cleaned",
    stage: "reject",
    handles: { ...handles, cleanupRunId: "run-reject-0004", stepRunId: "run-create-0001" },
    cleanupRunId: "run-reject-0004",
    cleanup: { status: "rejected" },
  });
  const rows = recoveryRows([start, {}, {}, {}, finish]);
  const { result } = await loadRecord(rows.at(-1), rows);
  assert.equal(result.pending.recoveryAttempt.cleanupRunId, "run-reject-0004");
  assert.deepEqual(result.pending.recoveryAttempt.handles, handles);
  assert.throws(() => recoveryCheckpointState({ phase: "unknown" }), {
    code: "RECOVERY_CHECKPOINT",
  });
});

test("recovery handles complete an interrupted feedback send with no candidate handles", async () => {
  const rows = [
    rowAt(1, "before_send", "feedback"),
    rowAt(2, "lease_intent", "feedback", undefined, {}),
  ];
  rows[1].previousSha256 = rows[0].checkpointSha256;
  rows[1] = attachHash(rows[1]);
  const prepared = rowAt(3, "prepared", "feedback", rows[1].checkpointSha256);
  const sent = rowAt(4, "sent", "feedback", prepared.checkpointSha256);
  rows.push(prepared, sent);
  const recovered = recoveryRows([{}, {}, {}, {}, {}], {
    rows,
    stage: "reject",
    handles: recoveryHandles("reject"),
  });
  assert.equal(recovered[3].handles.candidateId, undefined);
  assert.equal(recovered.at(-1).recoveryAttempt.handles.candidateId, CANDIDATE);
  const { result } = await loadRecord(recovered.at(-1), recovered);
  assert.equal(result.pending.recoveryAttempt.handles.creationRunId, "run-create-0001");
});

test("recovery handles complete a sent promotion whose Memory ID was not checkpointed", async () => {
  const rows = validFeedbackRows();
  let previousSha = rows.at(-1).checkpointSha256;
  for (const phase of ["before_send", "lease_intent", "prepared", "sent"]) {
    const row = rowAt(rows.length + 1, phase, "promote", previousSha);
    rows.push(row);
    previousSha = row.checkpointSha256;
  }
  const recovered = recoveryRows([{}, {}, {}, {}, {}], {
    rows,
    stage: "expire",
    handles: recoveryHandles("expire"),
  });
  assert.equal(recovered[rows.length - 1].handles.memoryId, undefined);
  assert.equal(recovered.at(-1).recoveryAttempt.handles.memoryId, MEMORY);
  const { result } = await loadRecord(recovered.at(-1), recovered);
  assert.equal(result.pending.recoveryAttempt.handles.promoteRunId, "run-promote-0002");
});

test("rejects recovery message, attempt identity, or phase-chain forgeries", async (t) => {
  await t.test("recovery marker hash mismatch", async () => {
    const preparedCase = recoveryPrepared(
      "reject",
      "prepared",
      fixtureHandles("feedback", "observed"),
    ).preparedCase;
    const rows = recoveryRows([
      {},
      {},
      { preparedCase: { ...preparedCase, textSha256: "0".repeat(64) } },
    ]);
    rows[rows.length - 1] = attachHash(rows.at(-1));
    await assert.rejects(loadRecord(rows.at(-1), rows));
  });
  await t.test("attempt process changes", async () => {
    const rows = recoveryRows([
      {},
      { process: { ...recoveryAttempt("before_send").process, pid: 945 } },
    ]);
    await assert.rejects(loadRecord(rows.at(-1), rows));
  });
  await t.test("attempt disappears before observed", async () => {
    const rows = recoveryRows([{}, {}, {}]);
    rows.push(rowAt(rows.length + 1, "observed", "feedback", rows.at(-1).checkpointSha256));
    rows[rows.length - 1] = attachHash(rows.at(-1));
    await assert.rejects(loadRecord(rows.at(-1), rows));
  });
});
