import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, lstat, unlink, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { writeMemoryCheckpoint } from "./memory-checkpoint.mjs";
import { captureMemoryProcess } from "./memory-process.mjs";
import { fail } from "./core.mjs";

export const TASK_WORKER_CHECKPOINT_SCHEMA = 1;
export const TASK_WORKER_CHECKPOINT_STAGES = Object.freeze([
  "create",
  "delegate",
  "inspect",
  "accept",
]);

const FAMILY_ID = "task-worker-artifact-lifecycle";
const NONCE = /^[a-f0-9]{32}$/u;
const HASH = /^[a-f0-9]{64}$/u;
const RUN = /^[A-Za-z0-9_-]{1,128}$/u;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu;
const MAX_JOURNAL_BYTES = 1024 * 1024;
const MAX_LINE_BYTES = 32768;
const MAX_ROWS = 16;
const JOURNAL_NAME = "task-worker.checkpoint.jsonl";

function invalid(message = "Task Worker checkpoint evidence is invalid.") {
  fail("TASK_WORKER_CHECKPOINT", message, "INCONCLUSIVE");
}

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function compare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (record(value))
    return `{${Object.keys(value)
      .sort(compare)
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  const serialized = JSON.stringify(value);
  if (serialized === undefined) invalid("Checkpoint contains a non-JSON value.");
  return serialized;
}

function sortedJson(value) {
  if (Array.isArray(value)) return value.map(sortedJson);
  if (record(value))
    return Object.fromEntries(
      Object.keys(value)
        .sort(compare)
        .map((key) => [key, sortedJson(value[key])]),
    );
  if (typeof value === "number" && !Number.isFinite(value)) invalid();
  if (value === undefined || typeof value === "function" || typeof value === "symbol") invalid();
  return value;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function same(left, right) {
  return canonical(left) === canonical(right);
}

function exact(value, keys) {
  return record(value) && same(Object.keys(value).sort(compare), [...keys].sort(compare));
}

function validRuntime(runtime) {
  const baseKeys = ["checkout", "commit", "dataDirectory", "pid", "connectionId", "threadId"];
  const developmentKeys = [...baseKeys, "development", "sourceTreeSha256"];
  return (
    (exact(runtime, baseKeys) || exact(runtime, developmentKeys)) &&
    typeof runtime.checkout === "string" &&
    isAbsolute(runtime.checkout) &&
    typeof runtime.dataDirectory === "string" &&
    isAbsolute(runtime.dataDirectory) &&
    typeof runtime.commit === "string" &&
    /^[a-f0-9]{40}$/u.test(runtime.commit) &&
    Number.isSafeInteger(runtime.pid) &&
    runtime.pid > 0 &&
    typeof runtime.connectionId === "string" &&
    runtime.connectionId.length > 0 &&
    (runtime.threadId === null ||
      (typeof runtime.threadId === "string" && runtime.threadId.length > 0)) &&
    (Object.hasOwn(runtime, "development")
      ? runtime.development === true &&
        typeof runtime.sourceTreeSha256 === "string" &&
        HASH.test(runtime.sourceTreeSha256)
      : true)
  );
}

function validStartedAt(value) {
  return (
    typeof value === "string" &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}

function normalizeIdentity(value, pendingPath, reportDirectory) {
  if (
    !exact(value, [
      "pendingPath",
      "reportDirectory",
      "runtime",
      "suiteSha256",
      "fixtureNonce",
      "workerTarget",
      "startedAt",
    ]) ||
    typeof pendingPath !== "string" ||
    !isAbsolute(pendingPath) ||
    resolve(pendingPath) !== pendingPath ||
    typeof reportDirectory !== "string" ||
    !isAbsolute(reportDirectory) ||
    resolve(reportDirectory) !== reportDirectory ||
    value.pendingPath !== pendingPath ||
    value.reportDirectory !== reportDirectory ||
    !validRuntime(value.runtime) ||
    typeof value.suiteSha256 !== "string" ||
    !HASH.test(value.suiteSha256) ||
    typeof value.fixtureNonce !== "string" ||
    !NONCE.test(value.fixtureNonce) ||
    !exact(value.workerTarget, ["workspaceId", "herdrSession", "agentKind", "markerSha256"]) ||
    typeof value.workerTarget.workspaceId !== "string" ||
    !value.workerTarget.workspaceId ||
    typeof value.workerTarget.herdrSession !== "string" ||
    !value.workerTarget.herdrSession ||
    typeof value.workerTarget.agentKind !== "string" ||
    !value.workerTarget.agentKind ||
    typeof value.workerTarget.markerSha256 !== "string" ||
    !HASH.test(value.workerTarget.markerSha256) ||
    !validStartedAt(value.startedAt)
  )
    invalid("Task Worker checkpoint identity is incomplete or malformed.");
  return sortedJson(value);
}

function pathsFor(pendingPath, reportDirectory) {
  const pending = resolve(pendingPath);
  const report = resolve(reportDirectory);
  const pendingParent = dirname(pending);
  const pendingParentFromReport = relative(report, pendingParent);
  if (
    pending === join(report, JOURNAL_NAME) ||
    pendingParent === report ||
    (pendingParentFromReport !== ".." &&
      !pendingParentFromReport.startsWith(`..${sep}`) &&
      !isAbsolute(pendingParentFromReport))
  )
    invalid("Task Worker guard must live outside the report directory.");
  return { pendingPath: pending, journalPath: join(report, JOURNAL_NAME) };
}

function rowKeys() {
  return [
    "schemaVersion",
    "familyId",
    "sequence",
    "state",
    "stage",
    "identity",
    "originProcess",
    "previousSha256",
    "proof",
  ];
}

function sameFile(before, after, maxBytes) {
  return (
    after.isFile() &&
    !after.isSymbolicLink() &&
    after.nlink === 1 &&
    Number.isSafeInteger(after.size) &&
    after.size > 0 &&
    after.size <= maxBytes &&
    before.dev === after.dev &&
    before.ino === after.ino &&
    before.size === after.size &&
    before.mtimeMs === after.mtimeMs &&
    before.ctimeMs === after.ctimeMs
  );
}

async function readRegular(path, maxBytes) {
  const before = await lstat(path);
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.nlink !== 1 ||
    before.size <= 0 ||
    before.size > maxBytes
  )
    invalid("Checkpoint file is not a bounded regular file.");
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = await handle.stat();
    if (!sameFile(before, opened, maxBytes)) invalid();
    const bytes = await handle.readFile();
    const after = await handle.stat();
    const pathAfter = await lstat(path);
    if (
      bytes.length !== opened.size ||
      !sameFile(opened, after, maxBytes) ||
      !sameFile(opened, pathAfter, maxBytes)
    )
      invalid("Checkpoint file changed while being read.");
    return bytes;
  } finally {
    await handle.close();
  }
}

async function currentProcessIdentity() {
  try {
    return await captureMemoryProcess();
  } catch {
    invalid("Current Linux process identity could not be verified.");
  }
}

function sameOrigin(origin, current) {
  return (
    origin.pid === current.pid &&
    origin.bootId === current.bootId &&
    origin.startTicks === current.startTicks
  );
}

function validateOrigin(value) {
  if (
    !exact(value, ["pid", "bootId", "startTicks"]) ||
    !Number.isSafeInteger(value.pid) ||
    value.pid <= 0 ||
    typeof value.bootId !== "string" ||
    !UUID.test(value.bootId) ||
    typeof value.startTicks !== "string" ||
    !/^[1-9]\d{0,31}$/u.test(value.startTicks)
  )
    invalid("Checkpoint origin process identity is invalid.");
}

function validateProof(stage, proof, previous, identity) {
  const common = [
    "stage",
    "runId",
    "taskId",
    "principalId",
    "principalKind",
    "scope",
    "cleanupVerified",
    "creationRunId",
    "attemptId",
    "bindingId",
  ];
  const stageKeys = {
    create: ["taskStatus"],
    delegate: [
      "workspaceId",
      "herdrSession",
      "agentKind",
      "dispatchVerified",
      "taskStatus",
      "attemptStatus",
    ],
    inspect: ["taskStatus", "attemptStatus", "workerTerminalVerified", "artifact"],
    accept: [
      "acceptedRunId",
      "taskStatus",
      "attemptStatus",
      "workerLeaseReleased",
      "terminalVerified",
      "pendingAttentionCount",
    ],
  }[stage];
  if (!exact(proof, [...common, ...stageKeys]))
    invalid("Task Worker stage receipt has an invalid shape.");
  if (
    proof.stage !== stage ||
    typeof proof.runId !== "string" ||
    !RUN.test(proof.runId) ||
    typeof proof.taskId !== "string" ||
    !UUID.test(proof.taskId) ||
    typeof proof.principalId !== "string" ||
    !proof.principalId ||
    proof.principalKind !== "owner" ||
    proof.cleanupVerified !== true ||
    proof.creationRunId !== (previous.creationRunId ?? proof.runId) ||
    !record(proof.scope) ||
    ![
      "botId,chatId,chatType,connectionId,senderId",
      "botId,chatId,chatType,connectionId,senderId,threadId",
    ].includes(Object.keys(proof.scope).sort(compare).join(",")) ||
    proof.scope.chatType !== "private" ||
    typeof proof.scope.connectionId !== "string" ||
    !proof.scope.connectionId ||
    typeof proof.scope.botId !== "string" ||
    !proof.scope.botId ||
    typeof proof.scope.chatId !== "string" ||
    proof.scope.chatId !== proof.scope.senderId ||
    (proof.scope.threadId !== undefined &&
      proof.scope.threadId !== null &&
      typeof proof.scope.threadId !== "string")
  )
    invalid();

  if (stage === "create") {
    if (
      proof.taskStatus !== "NEW" ||
      proof.attemptId !== null ||
      proof.bindingId !== null ||
      proof.creationRunId !== proof.runId
    )
      invalid("Creation receipt must describe one new, unbound Task.");
  } else if (
    proof.taskId !== previous.taskId ||
    typeof proof.attemptId !== "string" ||
    !UUID.test(proof.attemptId) ||
    typeof proof.bindingId !== "string" ||
    !UUID.test(proof.bindingId) ||
    proof.attemptId !== (previous.attemptId ?? proof.attemptId) ||
    proof.bindingId !== (previous.bindingId ?? proof.bindingId) ||
    proof.principalId !== previous.principalId ||
    !same(proof.scope, previous.scope)
  )
    invalid("Task, Attempt, Binding, Owner or private scope changed between stages.");

  if (
    stage === "delegate" &&
    (proof.workspaceId !== identity.workerTarget.workspaceId ||
      proof.herdrSession !== identity.workerTarget.herdrSession ||
      proof.agentKind !== identity.workerTarget.agentKind ||
      proof.dispatchVerified !== true ||
      !["RUNNING", "REVIEW"].includes(proof.taskStatus) ||
      !["running", "review"].includes(proof.attemptStatus))
  )
    invalid("Worker dispatch did not match the trusted target.");

  if (stage === "inspect") {
    const artifact = proof.artifact;
    const expectedBytes = Buffer.from(`${identity.fixtureNonce}\n`, "utf8");
    if (
      proof.taskStatus !== "REVIEW" ||
      proof.attemptStatus !== "review" ||
      proof.workerTerminalVerified !== true ||
      !exact(artifact, [
        "filename",
        "sizeBytes",
        "sha256",
        "fullContentVerified",
        "markerSha256",
      ]) ||
      artifact.filename !== `qq-live-worker-${identity.fixtureNonce}.txt` ||
      artifact.sizeBytes !== expectedBytes.length ||
      artifact.sha256 !== sha256(expectedBytes) ||
      artifact.fullContentVerified !== true ||
      artifact.markerSha256 !== identity.workerTarget.markerSha256
    )
      invalid("Worker artifact receipt did not verify the fixed retained fixture file.");
  }
  if (
    stage === "accept" &&
    (proof.acceptedRunId !== proof.runId ||
      proof.taskStatus !== "DONE" ||
      proof.attemptStatus !== "succeeded" ||
      proof.workerLeaseReleased !== true ||
      proof.terminalVerified !== true ||
      proof.pendingAttentionCount !== 0)
  )
    invalid("Acceptance receipt does not prove terminal cleanup and zero pending attention.");
  return sortedJson(proof);
}

function validateDrainReceipt(value) {
  if (!exact(value, ["driver", "bot"]))
    invalid("A close-and-drain receipt is required before guard removal.");
  for (const side of ["driver", "bot"]) {
    if (
      !exact(value[side], ["closed", "pendingCount"]) ||
      value[side].closed !== true ||
      value[side].pendingCount !== 0
    )
      invalid("Both QQ clients must be closed and drained before guard removal.");
  }
  return sortedJson(value);
}

function validateCompletionReceipts(checked, receipts, drainReceipt) {
  if (!Array.isArray(receipts) || receipts.length !== TASK_WORKER_CHECKPOINT_STAGES.length)
    invalid("Completion requires all four independently verified stage receipts.");
  const verifiedRows = checked.rows.filter((row) => row.state === "verified");
  if (verifiedRows.length !== TASK_WORKER_CHECKPOINT_STAGES.length) invalid();
  const projected = receipts.map((receipt, index) =>
    validateProof(
      TASK_WORKER_CHECKPOINT_STAGES[index],
      receipt,
      index ? receipts[index - 1] : {},
      checked.first.identity,
    ),
  );
  if (
    !same(
      projected,
      verifiedRows.map((row) => row.proof),
    )
  )
    invalid("Completion receipts do not match the durable verified journal rows.");
  const ids = projected.map((item) => item.runId);
  if (new Set(ids).size !== ids.length) invalid("Completion receipts reused a Run.");
  const last = projected.at(-1);
  if (
    last.taskStatus !== "DONE" ||
    last.attemptStatus !== "succeeded" ||
    last.workerLeaseReleased !== true ||
    last.terminalVerified !== true ||
    last.pendingAttentionCount !== 0
  )
    invalid("Completion lacks a terminal Task acceptance and cleanup proof.");
  return sortedJson({
    receiptCount: projected.length,
    taskId: last.taskId,
    attemptId: last.attemptId,
    bindingId: last.bindingId,
    stageRunIds: ids,
    taskStatus: last.taskStatus,
    workerLeaseReleased: true,
    pendingAttentionCount: 0,
    drain: validateDrainReceipt(drainReceipt),
  });
}

function parseJournal(bytes) {
  const text = bytes.toString("utf8");
  if (!text.endsWith("\n")) invalid("Checkpoint journal has a truncated final row.");
  const lines = text.slice(0, -1).split("\n");
  if (
    !lines.length ||
    lines.length > MAX_ROWS ||
    lines.some((line) => Buffer.byteLength(line, "utf8") > MAX_LINE_BYTES)
  )
    invalid("Checkpoint journal exceeds its bounds.");
  return lines.map((line) => {
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      invalid("Checkpoint journal contains invalid JSON.");
    }
    if (canonical(parsed) !== line) invalid("Checkpoint journal contains noncanonical bytes.");
    return parsed;
  });
}

function expectedTransitions(rows) {
  if (!Array.isArray(rows) || rows.length < 1 || rows.length > MAX_ROWS) invalid();
  const first = rows[0];
  if (
    !exact(first, rowKeys()) ||
    first.schemaVersion !== TASK_WORKER_CHECKPOINT_SCHEMA ||
    first.familyId !== FAMILY_ID ||
    first.sequence !== 0 ||
    first.state !== "guarded" ||
    first.stage !== null ||
    first.proof !== null ||
    first.previousSha256 !== null ||
    !record(first.identity)
  )
    invalid("Checkpoint journal does not begin with a guarded intent.");
  const identity = normalizeIdentity(
    first.identity,
    first.identity.pendingPath,
    first.identity.reportDirectory,
  );
  validateOrigin(first.originProcess);

  const usedRuns = new Set();
  const verifiedProofs = [];
  let previousProof = {};
  let task;
  let lastHash = sha256(canonical(first));
  let current = first;
  for (let index = 1; index < rows.length; index += 1) {
    const row = rows[index];
    if (
      !exact(row, rowKeys()) ||
      row.schemaVersion !== TASK_WORKER_CHECKPOINT_SCHEMA ||
      row.familyId !== FAMILY_ID ||
      row.sequence !== index ||
      !same(row.identity, identity) ||
      !same(row.originProcess, first.originProcess) ||
      row.previousSha256 !== lastHash
    )
      invalid("Checkpoint journal chain or immutable process identity is broken.");

    if (current.state === "guarded") {
      if (row.state !== "prepared" || row.stage !== "create" || row.proof !== null) invalid();
    } else if (current.state === "prepared") {
      if (row.state !== "sent_unverified" || row.stage !== current.stage || row.proof !== null)
        invalid();
    } else if (current.state === "sent_unverified") {
      if (row.state !== "verified" || row.stage !== current.stage) invalid();
      const proof = validateProof(row.stage, row.proof, previousProof, identity);
      if (usedRuns.has(proof.runId)) invalid("Task Worker checkpoint reused a Run ID.");
      usedRuns.add(proof.runId);
      const stageIndex = TASK_WORKER_CHECKPOINT_STAGES.indexOf(row.stage);
      if (stageIndex < 0) invalid();
      if (stageIndex === 0) {
        task = { taskId: proof.taskId, creationRunId: proof.runId };
      } else if (
        proof.taskId !== task?.taskId ||
        proof.creationRunId !== task.creationRunId ||
        proof.attemptId !== (previousProof.attemptId ?? proof.attemptId) ||
        proof.bindingId !== (previousProof.bindingId ?? proof.bindingId)
      )
        invalid("Task, Attempt or Binding continuity is broken.");
      previousProof = proof;
      verifiedProofs.push(proof);
    } else if (current.state === "verified") {
      const nextStage =
        TASK_WORKER_CHECKPOINT_STAGES[TASK_WORKER_CHECKPOINT_STAGES.indexOf(current.stage) + 1];
      if (nextStage) {
        if (row.state !== "prepared" || row.stage !== nextStage || row.proof !== null) invalid();
      } else {
        if (row.state !== "completed" || row.stage !== "accept") invalid();
        const expectedSummary = completionSummary(verifiedProofs, row.proof?.drain);
        if (!same(row.proof, expectedSummary))
          invalid("Completion row does not match the verified stage receipts.");
      }
    } else invalid("Checkpoint journal extends a terminal completion row.");

    current = row;
    lastHash = sha256(canonical(row));
  }
  return { first, current, lastHash, rows, task, previousProof, verifiedProofs, identity };
}

function completionSummary(receipts, drainReceipt) {
  if (receipts.length !== TASK_WORKER_CHECKPOINT_STAGES.length) invalid();
  const last = receipts.at(-1);
  return sortedJson({
    receiptCount: receipts.length,
    taskId: last.taskId,
    attemptId: last.attemptId,
    bindingId: last.bindingId,
    stageRunIds: receipts.map((item) => item.runId),
    taskStatus: last.taskStatus,
    workerLeaseReleased: true,
    pendingAttentionCount: 0,
    drain: validateDrainReceipt(drainReceipt),
  });
}

async function verifyDirectories(pendingPath, reportDirectory) {
  if (process.platform !== "linux" || !constants.O_NOFOLLOW || !constants.O_DIRECTORY)
    invalid("Task Worker checkpoints require Linux no-follow filesystem support.");
  for (const directory of [dirname(pendingPath), reportDirectory]) {
    const resolvedDirectory = resolve(directory);
    let actual;
    try {
      actual = await realpath(resolvedDirectory);
    } catch {
      invalid("Checkpoint directory is unavailable.");
    }
    if (actual !== resolvedDirectory)
      invalid("Checkpoint directories must be canonical and symlink-free.");
  }
}

async function readCheckpointFiles(pendingPath, reportDirectory, expectedIdentity) {
  const paths = pathsFor(pendingPath, reportDirectory);
  await verifyDirectories(paths.pendingPath, resolve(reportDirectory));
  const [journalBytes, pendingBytes] = await Promise.all([
    readRegular(paths.journalPath, MAX_JOURNAL_BYTES),
    readRegular(paths.pendingPath, MAX_LINE_BYTES),
  ]);
  const checked = expectedTransitions(parseJournal(journalBytes));
  if (
    checked.identity.pendingPath !== paths.pendingPath ||
    checked.identity.reportDirectory !== resolve(reportDirectory)
  )
    invalid("Checkpoint files are bound to different directories.");
  if (expectedIdentity && !same(checked.identity, expectedIdentity))
    invalid("Checkpoint belongs to another identity.");
  if (pendingBytes.toString("utf8") !== `${canonical(checked.current)}\n`)
    invalid("Pending guard does not match the verified journal tip.");
  return { ...checked, ...paths };
}

function makeRow(identity, originProcess, sequence, state, stage, previousSha256, proof) {
  return sortedJson({
    schemaVersion: TASK_WORKER_CHECKPOINT_SCHEMA,
    familyId: FAMILY_ID,
    sequence,
    state,
    stage,
    identity,
    originProcess,
    previousSha256,
    proof,
  });
}

function safeSnapshot(checked, currentProcess) {
  return {
    status: checked.current.state === "completed" ? "COMPLETED" : "PENDING",
    identity: checked.identity,
    sequence: checked.current.sequence,
    stage: checked.current.stage,
    phase: checked.current.state,
    taskId: checked.task?.taskId ?? null,
    stageRunIds: checked.verifiedProofs.map((proof) => proof.runId),
    originProcessMatchesCurrent: sameOrigin(checked.first.originProcess, currentProcess),
  };
}

function validateCurrentProcess(checked, current) {
  if (!sameOrigin(checked.first.originProcess, current))
    invalid("Task Worker checkpoint belongs to another process; inspect it read only.");
}

/** Create the separate account guard before a Task Worker stage can send. */
export async function createTaskWorkerCheckpoint({ pendingPath, reportDirectory, identity } = {}) {
  if (typeof pendingPath !== "string" || typeof reportDirectory !== "string") invalid();
  if (resolve(pendingPath) !== pendingPath || resolve(reportDirectory) !== reportDirectory)
    invalid();
  const paths = pathsFor(pendingPath, reportDirectory);
  const stableIdentity = normalizeIdentity(
    { ...identity, pendingPath: paths.pendingPath, reportDirectory },
    paths.pendingPath,
    reportDirectory,
  );
  await verifyDirectories(paths.pendingPath, resolve(reportDirectory));
  for (const path of [paths.pendingPath, paths.journalPath]) {
    try {
      await lstat(path);
      invalid("Task Worker checkpoint files already exist; automatic resume is forbidden.");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  const originProcess = await currentProcessIdentity();
  const first = makeRow(stableIdentity, originProcess, 0, "guarded", null, null, null);
  await writeMemoryCheckpoint({
    pendingPath: paths.pendingPath,
    journalPath: paths.journalPath,
    row: first,
    first: true,
  });
  const checked = await readCheckpointFiles(
    paths.pendingPath,
    resolve(reportDirectory),
    stableIdentity,
  );
  if (!same(checked.current, first)) invalid("Initial Task Worker guard did not persist exactly.");
  return safeSnapshot(checked, originProcess);
}

/** Append one transition. A sent-but-unverified stage can never be replayed. */
export async function advanceTaskWorkerCheckpoint({
  pendingPath,
  reportDirectory,
  identity,
  stage,
  phase,
  proof,
} = {}) {
  if (
    typeof pendingPath !== "string" ||
    typeof reportDirectory !== "string" ||
    resolve(pendingPath) !== pendingPath ||
    resolve(reportDirectory) !== reportDirectory
  )
    invalid();
  const stableIdentity = normalizeIdentity(identity, pendingPath, reportDirectory);
  const currentProcess = await currentProcessIdentity();
  const checked = await readCheckpointFiles(pendingPath, reportDirectory, stableIdentity);
  validateCurrentProcess(checked, currentProcess);
  const current = checked.current;
  let state;
  let nextProof = null;
  if (phase === "intent") {
    const expectedStage =
      current.state === "guarded"
        ? "create"
        : current.state === "verified"
          ? TASK_WORKER_CHECKPOINT_STAGES[TASK_WORKER_CHECKPOINT_STAGES.indexOf(current.stage) + 1]
          : undefined;
    if (!expectedStage || stage !== expectedStage || proof !== undefined)
      invalid("Task Worker intent is out of order or repeated.");
    state = "prepared";
  } else if (
    phase === "sent_unverified" &&
    current.state === "prepared" &&
    current.stage === stage &&
    proof === undefined
  ) {
    state = "sent_unverified";
  } else if (
    phase === "verified" &&
    current.state === "sent_unverified" &&
    current.stage === stage
  ) {
    state = "verified";
    nextProof = validateProof(stage, proof, checked.previousProof, stableIdentity);
  } else invalid("Task Worker checkpoint phase is not the next allowed transition.");

  const row = makeRow(
    stableIdentity,
    checked.first.originProcess,
    current.sequence + 1,
    state,
    stage,
    checked.lastHash,
    nextProof,
  );
  await writeMemoryCheckpoint({
    pendingPath: checked.pendingPath,
    journalPath: checked.journalPath,
    row,
    first: false,
  });
  const updated = await readCheckpointFiles(pendingPath, reportDirectory, stableIdentity);
  if (!same(updated.current, row)) invalid("Task Worker checkpoint transition was not durable.");
  return safeSnapshot(updated, currentProcess);
}

/** Read and validate the journal without changing or removing the account guard. */
export async function readTaskWorkerCheckpoint({ pendingPath, reportDirectory, identity } = {}) {
  if (
    typeof pendingPath !== "string" ||
    typeof reportDirectory !== "string" ||
    !isAbsolute(pendingPath) ||
    !isAbsolute(reportDirectory)
  )
    invalid();
  const expected = identity
    ? normalizeIdentity(identity, resolve(pendingPath), resolve(reportDirectory))
    : undefined;
  try {
    const checked = await readCheckpointFiles(pendingPath, reportDirectory, expected);
    return safeSnapshot(checked, await currentProcessIdentity());
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    if (!expected)
      invalid("Checkpoint guard is missing; a matching identity is required for audit.");
    const paths = pathsFor(pendingPath, reportDirectory);
    await verifyDirectories(paths.pendingPath, resolve(reportDirectory));
    try {
      await lstat(paths.pendingPath);
      invalid("Completed checkpoint still has an unexpected pending guard.");
    } catch (pendingError) {
      if (pendingError?.code !== "ENOENT") throw pendingError;
    }
    const journalBytes = await readRegular(paths.journalPath, MAX_JOURNAL_BYTES);
    const checked = expectedTransitions(parseJournal(journalBytes));
    if (
      checked.identity.pendingPath !== paths.pendingPath ||
      checked.identity.reportDirectory !== resolve(reportDirectory) ||
      !same(checked.identity, expected) ||
      checked.current.state !== "completed"
    )
      invalid("Only an identity-matched completed journal can be read without its pending guard.");
    try {
      await lstat(paths.pendingPath);
      invalid("Pending guard appeared while reading completed checkpoint.");
    } catch (pendingError) {
      if (pendingError?.code !== "ENOENT") throw pendingError;
    }
    return { ...safeSnapshot(checked, await currentProcessIdentity()), pendingGuardPresent: false };
  }
}

/** Remove the guard only for its origin CLI process, after four proofs and a real close-and-drain receipt. */
export async function completeTaskWorkerCheckpoint({
  pendingPath,
  reportDirectory,
  identity,
  receipts,
  drainReceipt,
} = {}) {
  if (
    typeof pendingPath !== "string" ||
    typeof reportDirectory !== "string" ||
    resolve(pendingPath) !== pendingPath ||
    resolve(reportDirectory) !== reportDirectory
  )
    invalid();
  const stableIdentity = normalizeIdentity(identity, pendingPath, reportDirectory);
  const currentProcess = await currentProcessIdentity();
  const checked = await readCheckpointFiles(pendingPath, reportDirectory, stableIdentity);
  validateCurrentProcess(checked, currentProcess);
  if (
    checked.current.state !== "verified" ||
    checked.current.stage !== "accept" ||
    checked.verifiedProofs.length !== TASK_WORKER_CHECKPOINT_STAGES.length
  )
    invalid("Task Worker pending guard cannot be removed before all stages are verified.");
  const summary = validateCompletionReceipts(checked, receipts, drainReceipt);
  if (!same(summary, completionSummary(checked.verifiedProofs, drainReceipt)))
    invalid("Completion receipts do not match the durable verified journal rows.");
  const complete = makeRow(
    stableIdentity,
    checked.first.originProcess,
    checked.current.sequence + 1,
    "completed",
    "accept",
    checked.lastHash,
    summary,
  );
  await writeMemoryCheckpoint({
    pendingPath: checked.pendingPath,
    journalPath: checked.journalPath,
    row: complete,
    first: false,
  });
  const final = await readCheckpointFiles(pendingPath, reportDirectory, stableIdentity);
  if (!same(final.current, complete)) invalid("Completion checkpoint did not persist exactly.");
  validateCurrentProcess(final, await currentProcessIdentity());
  await unlink(final.pendingPath);
  const directory = await open(
    dirname(final.pendingPath),
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
  return {
    status: "COMPLETED",
    familyId: FAMILY_ID,
    taskId: summary.taskId,
    attemptId: summary.attemptId,
    bindingId: summary.bindingId,
    stageRunIds: summary.stageRunIds,
    terminalStatus: "DONE",
    workerLeaseReleased: true,
    pendingAttentionCount: 0,
    driverClosed: true,
    botClosed: true,
  };
}
