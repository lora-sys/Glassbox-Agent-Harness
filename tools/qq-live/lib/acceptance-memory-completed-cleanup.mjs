import { open, readFile, lstat, realpath, chmod } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { OneBot } from "./onebot.mjs";
import { digest, fail, validateConfig } from "./core.mjs";
import {
  loadAcceptanceMemoryCleanupInputs,
  readCurrentInventory,
  verifyAcceptanceMemoryCleanupOrigin,
} from "./acceptance-memory-cleanup-cli.mjs";
import {
  acceptanceMemoryCleanupExpectedOutput,
  acceptanceMemoryInventorySha256,
  buildAcceptanceMemoryCleanupPlan,
  verifyAcceptanceMemoryCleanup,
} from "./acceptance-memory-cleanup-plan.mjs";
import { compareSameMessage, boundMessage } from "./message-binding.mjs";
import {
  readTraceEvents,
  runtimeInspectionSnapshot,
  verifyProductEvidence,
} from "./product-evidence.mjs";

const HASH = /^[a-f0-9]{64}$/u;
const IDENTIFIER = /^[A-Za-z0-9_-]{1,128}$/u;
const MESSAGE_ID = /^-?\d{1,20}$/u;
const MAX_REPORT = 128 * 1024;
const MAX_AUDIT = 32 * 1024 * 1024;
const MAX_JOURNAL = 40 * (1024 * 1024 + 1);

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function blocked(code = "CLEANUP_RECONCILIATION_EVIDENCE") {
  fail(code, "清理 Run 缺少独立核验，保留停止标记和原始报告。", "INCONCLUSIVE");
}

function exactKeys(value, keys) {
  return record(value) && Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (record(value))
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  const text = JSON.stringify(value);
  if (text === undefined || (typeof value === "number" && !Number.isFinite(value))) blocked();
  return text;
}

function same(left, right) {
  return canonical(left) === canonical(right);
}

function cleanupScopeObject(config) {
  return {
    connectionId: config.runtime.connectionId,
    botId: config.bot.qq,
    chatType: "private",
    chatId: config.driver.qq,
    senderId: config.driver.qq,
    ...(config.runtime.threadId == null ? {} : { threadId: config.runtime.threadId }),
  };
}

function sha(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function readPrivate(path, limit) {
  if (typeof path !== "string" || !path.startsWith("/") || resolve(path) !== path)
    blocked("CLEANUP_RECONCILIATION_PATH");
  let before;
  try {
    before = await lstat(path);
  } catch {
    blocked("CLEANUP_RECONCILIATION_READ");
  }
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.size > limit ||
    (before.mode & 0o077) !== 0 ||
    (typeof process.getuid === "function" && before.uid !== process.getuid())
  )
    blocked("CLEANUP_RECONCILIATION_FILE");
  let bytes;
  try {
    if ((await realpath(path)) !== path) blocked("CLEANUP_RECONCILIATION_PATH");
    bytes = await readFile(path);
  } catch {
    blocked("CLEANUP_RECONCILIATION_READ");
  }
  const after = await lstat(path);
  if (
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.size !== after.size ||
    before.mtimeMs !== after.mtimeMs ||
    bytes.length !== before.size
  )
    blocked("CLEANUP_RECONCILIATION_CHANGED");
  return { bytes, sha256: sha(bytes) };
}

async function verifyInputSnapshotFiles(inputs, manifestPath, guardPath, expectedJournalSha256) {
  const manifest = await readPrivate(manifestPath, 4096);
  const inventory = await readPrivate(inputs.manifest.inventoryPath, 64 * 1024);
  const sourceAudit = await readPrivate(inputs.manifest.sourceAuditSnapshotPath, MAX_AUDIT);
  const sourceReport = await readPrivate(inputs.manifest.originalReportPath, MAX_REPORT);
  const journalPath = join(dirname(inputs.manifest.originalReportPath), "memory-fixture.jsonl");
  const journal = await readPrivate(journalPath, MAX_JOURNAL);
  const guard = await readPrivate(guardPath, 1024 * 1024);
  if (
    manifest.sha256 !== inputs.manifestSha256 ||
    inventory.sha256 !== inputs.inventoryFileSha256 ||
    sourceAudit.sha256 !== inputs.sourceAuditSha256 ||
    sourceReport.sha256 !== inputs.report.sha256 ||
    (expectedJournalSha256 !== undefined && journal.sha256 !== expectedJournalSha256) ||
    guard.sha256 !== inputs.guard.sha256
  )
    blocked("CLEANUP_RECONCILIATION_ORIGIN");
  return { guard, journalSha256: journal.sha256 };
}

async function verifyPrivateDirectory(path) {
  if (typeof path !== "string" || !path.startsWith("/") || resolve(path) !== path)
    blocked("CLEANUP_RECONCILIATION_PATH");
  const info = await lstat(path).catch(() => blocked("CLEANUP_RECONCILIATION_DIRECTORY"));
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    (info.mode & 0o077) !== 0 ||
    (typeof process.getuid === "function" && info.uid !== process.getuid()) ||
    (await realpath(path)) !== path
  )
    blocked("CLEANUP_RECONCILIATION_DIRECTORY");
}

function parseJson(bytes) {
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    blocked("CLEANUP_RECONCILIATION_JSON");
  }
}

function validTime(value) {
  return (
    typeof value === "string" &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}

function matchHistoryRows(
  history,
  { driverId, botId, inputSha256, inputBytes, replySha256, replyBytes },
) {
  if (
    !exactKeys(history, ["accountIdentity", "peerId", "messages"]) ||
    history.accountIdentity !== driverId ||
    history.peerId !== botId ||
    !Array.isArray(history.messages) ||
    history.messages.length > 20
  )
    blocked("CLEANUP_RECONCILIATION_HISTORY");
  const validMessage = (message) =>
    exactKeys(message, [
      "messageId",
      "selfId",
      "senderId",
      "userId",
      "messageType",
      "time",
      "realSequence",
      "textBytes",
      "textSha256",
      "segmentTypes",
    ]) &&
    MESSAGE_ID.test(String(message.messageId ?? "")) &&
    message.selfId === driverId &&
    message.messageType === "private" &&
    [driverId, botId].includes(message.senderId) &&
    [driverId, botId].includes(message.userId) &&
    Number.isSafeInteger(message.time) &&
    message.time > 0 &&
    /^\d{1,20}$/u.test(message.realSequence ?? "") &&
    Number.isSafeInteger(message.textBytes) &&
    message.textBytes > 0 &&
    HASH.test(message.textSha256 ?? "") &&
    Array.isArray(message.segmentTypes) &&
    message.segmentTypes.length > 0 &&
    message.segmentTypes.every((type) => type === "text");
  if (history.messages.some((message) => !validMessage(message)))
    blocked("CLEANUP_RECONCILIATION_HISTORY");
  const inputs = history.messages.filter(
    (message) =>
      message.senderId === driverId &&
      message.textSha256 === inputSha256 &&
      message.textBytes === inputBytes,
  );
  const replies = history.messages.filter(
    (message) =>
      message.senderId === botId &&
      message.textSha256 === replySha256 &&
      message.textBytes === replyBytes,
  );
  if (
    inputs.length !== 1 ||
    replies.length !== 1 ||
    String(inputs[0].messageId) === String(replies[0].messageId) ||
    replies[0].time < inputs[0].time
  )
    blocked("CLEANUP_RECONCILIATION_HISTORY");
  return { input: inputs[0], reply: replies[0] };
}

function verifyFailedAttempt(report, intent, planSha256) {
  const c = report?.case;
  if (
    !exactKeys(report, [
      "case",
      "cleanupOnly",
      "errorCode",
      "featurePass",
      "finishedAt",
      "kind",
      "origin",
      "planSha256",
      "principalId",
      "runtime",
      "schemaVersion",
      "startedAt",
      "status",
    ]) ||
    !exactKeys(c, [
      "acceptanceLease",
      "anomalies",
      "code",
      "id",
      "inputObserved",
      "leaseRegistrationAttempted",
      "leaseRevoked",
      "promptSha256",
      "route",
      "sendAttempted",
      "startedAt",
      "status",
      "token",
    ]) ||
    report?.schemaVersion !== 1 ||
    report.kind !== "acceptance-memory-cleanup" ||
    report.status !== "INCONCLUSIVE" ||
    report.cleanupOnly !== true ||
    report.featurePass !== false ||
    report.planSha256 !== planSha256 ||
    report.errorCode !== "CLEANUP_REPLY_UNCONFIRMED" ||
    !record(c) ||
    c.id !== "acceptance-memory-cleanup" ||
    c.status !== "INCONCLUSIVE" ||
    c.code !== "INPUT_NOT_OBSERVED" ||
    c.sendAttempted !== true ||
    c.inputObserved !== false ||
    c.leaseRegistrationAttempted !== true ||
    c.leaseRevoked !== true ||
    c.route !== "private" ||
    !/^[a-f0-9]{32}$/u.test(c.token ?? "") ||
    !HASH.test(c.promptSha256 ?? "") ||
    !exactKeys(c.acceptanceLease, ["leaseId", "expiresAt", "toolsSha256"]) ||
    !/^[a-f0-9-]{36}$/iu.test(c.acceptanceLease.leaseId ?? "") ||
    !Number.isSafeInteger(c.acceptanceLease.expiresAt) ||
    !HASH.test(c.acceptanceLease.toolsSha256 ?? "") ||
    !Array.isArray(c.anomalies) ||
    c.anomalies.length !== 0 ||
    !validTime(c.startedAt) ||
    !validTime(report.startedAt) ||
    !validTime(report.finishedAt) ||
    Date.parse(c.startedAt) < Date.parse(report.startedAt) ||
    Date.parse(c.startedAt) > Date.parse(report.finishedAt) ||
    !exactKeys(intent, [
      "acceptanceLease",
      "kind",
      "leaseRegistrationAttempted",
      "planSha256",
      "promptSha256",
      "route",
      "schemaVersion",
      "startedAt",
      "status",
      "token",
    ]) ||
    intent.schemaVersion !== 1 ||
    intent.kind !== "acceptance-memory-cleanup-send-intent" ||
    intent.status !== "SEND_MAY_HAVE_STARTED" ||
    intent.leaseRegistrationAttempted !== true ||
    intent.planSha256 !== planSha256 ||
    intent.token !== c.token ||
    intent.route !== "private" ||
    intent.promptSha256 !== c.promptSha256 ||
    intent.startedAt !== c.startedAt ||
    !same(intent.acceptanceLease, c.acceptanceLease)
  )
    blocked("CLEANUP_RECONCILIATION_ATTEMPT");
  return c;
}

function validateCleanupInputProjection(input) {
  if (!exactKeys(input, ["action"]) || input.action !== "reject")
    blocked("CLEANUP_RECONCILIATION_TOOL");
  return { action: "reject" };
}

function cleanupEvidence({
  db,
  trace,
  run,
  delivery,
  transportCase,
  plan,
  runtime,
  expectedScope,
}) {
  const runId = run.id;
  const principalId = run.principal_id;
  const calls = trace.events.filter(
    (row) =>
      row.event?.runId === runId &&
      row.event?.type === "tool_call" &&
      row.event?.data?.name === "owner_memory_admin",
  );
  const results = trace.events.filter(
    (row) =>
      row.event?.runId === runId &&
      row.event?.type === "tool_result" &&
      row.event?.data?.name === "owner_memory_admin",
  );
  // boundedToolInput intentionally omits array-valued arguments from Raw Trace. The exact
  // candidate set is independently bound by the complete owner-tool output digest and audit rows.
  const expectedInput = validateCleanupInputProjection(calls[0]?.event?.data?.input);
  const expectedOutput = acceptanceMemoryCleanupExpectedOutput(plan.candidateIds);
  const callSeq = Number(calls[0]?.seq);
  const resultSeq = Number(results[0]?.seq);
  if (
    calls.length !== 1 ||
    results.length !== 1 ||
    results[0].event.data?.isError !== false ||
    !Number.isSafeInteger(callSeq) ||
    !Number.isSafeInteger(resultSeq) ||
    resultSeq <= callSeq ||
    trace.events.indexOf(calls[0]) >= trace.events.indexOf(results[0]) ||
    calls[0].event.principalId !== principalId ||
    results[0].event.principalId !== principalId ||
    calls[0].event.data?.runId !== runId ||
    results[0].event.data?.runId !== runId ||
    calls[0].event.data?.principalId !== principalId ||
    results[0].event.data?.principalId !== principalId ||
    !same(calls[0].event.data?.input, expectedInput) ||
    calls[0].event.data?.toolCallId !== results[0].event.data?.toolCallId ||
    !IDENTIFIER.test(calls[0].event.data?.toolCallId ?? "") ||
    results[0].event.data?.outputBytes !== expectedOutput.outputBytes ||
    results[0].event.data?.outputSha256 !== expectedOutput.outputSha256 ||
    !validTime(calls[0].event.timestamp) ||
    !validTime(results[0].event.timestamp) ||
    Date.parse(calls[0].event.timestamp) < Date.parse(run.created_at) ||
    Date.parse(results[0].event.timestamp) > Date.parse(run.updated_at)
  )
    blocked("CLEANUP_RECONCILIATION_TOOL");
  const audits = plan.candidateIds.map((candidateId) => {
    const rows = db
      .prepare(
        "SELECT * FROM memory_audit_events WHERE action='reject' AND target_id=? AND run_id=? AND principal_id=?",
      )
      .all(candidateId, runId, principalId);
    if (rows.length !== 1) blocked("CLEANUP_RECONCILIATION_AUDIT");
    const row = rows[0];
    if (
      !validTime(row.created_at) ||
      Date.parse(row.created_at) < Date.parse(run.created_at) ||
      Date.parse(row.created_at) > Date.parse(run.updated_at)
    )
      blocked("CLEANUP_RECONCILIATION_AUDIT");
    const decisions = db
      .prepare(
        "SELECT id,action,resource_id,principal_id,decision,run_id FROM authorization_decisions_all WHERE id=? AND run_id=? AND principal_id=?",
      )
      .all(row.decision_id, runId, principalId);
    if (
      decisions.length !== 1 ||
      decisions[0].decision !== "ALLOW" ||
      decisions[0].action !== "memory:govern" ||
      decisions[0].resource_id !== "owner-memory"
    )
      blocked("CLEANUP_RECONCILIATION_AUTHORIZATION");
    return {
      id: row.id,
      sequence: row.sequence,
      action: row.action,
      targetId: row.target_id,
      runId: row.run_id,
      principalId: row.principal_id,
      decisionId: row.decision_id,
      rowSha256: sha(Buffer.from(canonical(row))),
      decision: decisions[0],
    };
  });
  const governanceDecisions = db
    .prepare(
      "SELECT id,action,resource_id,principal_id,decision,run_id,scope_key,delivery_source FROM authorization_decisions_all WHERE run_id=? AND principal_id=? AND action='memory:govern'",
    )
    .all(runId, principalId);
  if (
    !governanceDecisions.length ||
    governanceDecisions.some(
      (row) =>
        row.decision !== "ALLOW" ||
        row.resource_id !== "owner-memory" ||
        row.delivery_source !== null ||
        row.scope_key !== expectedScope,
    ) ||
    new Set(governanceDecisions.map((row) => row.id)).size !== governanceDecisions.length ||
    audits.some(
      (row) =>
        governanceDecisions.filter((decision) => decision.id === row.decisionId).length !== 1,
    )
  )
    blocked("CLEANUP_RECONCILIATION_AUTHORIZATION");
  const learningWrites = {
    runId,
    principalId,
    candidateWriteAuditCount: db
      .prepare(
        "SELECT COUNT(*) AS n FROM memory_audit_events WHERE run_id=? AND principal_id=? AND action='write'",
      )
      .get(runId, principalId).n,
    feedbackWriteCount: db
      .prepare("SELECT COUNT(*) AS n FROM feedback_events WHERE run_id=? AND principal_id=?")
      .get(runId, principalId).n,
    candidateSourceCount: db
      .prepare("SELECT COUNT(*) AS n FROM memory_candidates WHERE source_json LIKE ?")
      .get(`%${runId}%`).n,
  };
  if (
    audits.some(
      (row, index) => row.targetId !== plan.candidateIds[index] || row.action !== "reject",
    ) ||
    learningWrites.candidateWriteAuditCount !== 0 ||
    learningWrites.feedbackWriteCount !== 0 ||
    learningWrites.candidateSourceCount !== 0
  )
    blocked("CLEANUP_RECONCILIATION_SIDE_EFFECT");
  const auditIds = new Set(audits.map((row) => row.id));
  const everyReject = db
    .prepare(
      "SELECT id FROM memory_audit_events WHERE run_id=? AND principal_id=? AND action='reject'",
    )
    .all(runId, principalId);
  if (everyReject.length !== auditIds.size || everyReject.some((row) => !auditIds.has(row.id)))
    blocked("CLEANUP_RECONCILIATION_AUDIT");
  const message = db
    .prepare(
      "SELECT r.message_id,m.external_id,m.text FROM runs r JOIN messages m ON m.id=r.message_id WHERE r.id=? AND r.principal_id=?",
    )
    .get(runId, principalId);
  if (
    !message ||
    String(message.external_id) !== transportCase.inputBinding.botMessageId ||
    digest(String(message.text).replace(/\r\n?/gu, "\n")) !== transportCase.inputBinding.textSha256
  )
    blocked("CLEANUP_RECONCILIATION_MESSAGE");
  return {
    runId,
    principalId,
    token: transportCase.token,
    runtime,
    run: {
      runId,
      principalId,
      internalMessageId: message.message_id,
      externalMessageId: String(message.external_id),
    },
    binding: {
      internalMessageId: message.message_id,
      externalMessageId: String(message.external_id),
      runId,
      principalId,
      textSha256: transportCase.inputBinding.textSha256,
    },
    lease: {
      runId,
      principalId,
      registered: true,
      revoked: true,
      toolsSha256: transportCase.acceptanceLease.toolsSha256,
    },
    authorization: {
      runId,
      principalId,
      decisionId: audits[0].decisionId,
      decision: audits[0].decision.decision,
      action: audits[0].decision.action,
      resourceId: audits[0].decision.resource_id,
    },
    delivery: {
      runId,
      principalId,
      decisionId: delivery.id,
      decision: "ALLOW",
      route: "private",
      recipientPrincipalId: principalId,
      externalMessageId: String(delivery.external_id),
      delivered: delivery.status === "sent",
    },
    toolCall: {
      runId,
      principalId,
      toolCallId: calls[0].event.data.toolCallId,
      name: "owner_memory_admin",
      inputProjection: "array-values-omitted",
      inputSha256: digest(canonical(expectedInput)),
      sequence: callSeq,
    },
    toolResult: {
      runId,
      principalId,
      toolCallId: results[0].event.data.toolCallId,
      name: "owner_memory_admin",
      isError: false,
      sequence: resultSeq,
      results: expectedOutput.results,
      outputBytes: results[0].event.data.outputBytes,
      outputSha256: results[0].event.data.outputSha256,
    },
    rejectionAudits: audits.map(({ decision, ...row }) => row),
    learningWrites,
  };
}

/** Recover only the known recorder-subscriber failure from independent product and QQ evidence. */
export async function verifyAcceptanceMemoryCompletedCleanup({
  reportPath,
  reportDirectory,
  manifestPath,
  config,
  out,
  expectedRuntime,
  deps = {},
  writeReceipt = true,
}) {
  config = (deps.validateConfig ?? validateConfig)(config);
  const failureFile = await readPrivate(reportPath, MAX_REPORT);
  const report = parseJson(failureFile.bytes);
  const intentFile = await readPrivate(join(reportDirectory, "send-intent.json"), 16 * 1024);
  const intent = parseJson(intentFile.bytes);
  const currentRuntime = await (deps.runtimeSnapshot ?? runtimeInspectionSnapshot)(config.runtime);
  if (
    (expectedRuntime !== undefined && !same(currentRuntime, expectedRuntime)) ||
    !same(report.runtime, currentRuntime)
  )
    blocked("CLEANUP_RECONCILIATION_RUNTIME");
  const inputs =
    deps.inputsSnapshot ??
    (await (deps.loadInputs ?? loadAcceptanceMemoryCleanupInputs)(config, manifestPath));
  if (inputs.manifestPath !== manifestPath) blocked("CLEANUP_RECONCILIATION_ORIGIN");
  const guardPathCurrent = deps.guardArchivePath ?? inputs.manifest.pendingGuardPath;
  const sourceFilesAtStart = await verifyInputSnapshotFiles(
    inputs,
    manifestPath,
    guardPathCurrent,
    deps.expectedJournalSha256,
  );
  const originState = await (deps.verifyOrigin ?? verifyAcceptanceMemoryCleanupOrigin)(
    config,
    inputs,
  );
  if (
    !same(report.origin, inputs.origin) ||
    !same(originState.originalRuntime, inputs.originState?.originalRuntime)
  )
    blocked("CLEANUP_RECONCILIATION_ORIGIN");
  const observedValue = (deps.readCurrentInventory ?? readCurrentInventory)(
    currentRuntime,
    inputs.inventory,
    inputs.sourceAuditRows,
    config,
  );
  const initial = observedValue.inventory ? observedValue : await observedValue;
  let db = initial.db;
  let clients;
  try {
    const planRecord = buildAcceptanceMemoryCleanupPlan({
      inventory: inputs.inventory,
      inventorySha256: acceptanceMemoryInventorySha256(inputs.inventory),
      runtime: currentRuntime,
      origin: inputs.origin,
    });
    const failedCase = verifyFailedAttempt(report, intent, planRecord.sha256);
    if (report.principalId !== planRecord.plan.principalId || !same(report.runtime, currentRuntime))
      blocked("CLEANUP_RECONCILIATION_ATTEMPT");
    const token = failedCase.token;
    const prompt = `GLASSBOX_ACCEPTANCE_V1 ${token}\n${planRecord.plan.prompt.replaceAll("{{nonce}}", token).trim()}`;
    if (
      digest(prompt) !== failedCase.promptSha256 ||
      failedCase.acceptanceLease.toolsSha256 !== planRecord.plan.toolsSha256
    )
      blocked("CLEANUP_RECONCILIATION_PROMPT");
    const expectedScope = JSON.stringify([
      config.runtime.connectionId,
      config.bot.qq,
      "private",
      config.driver.qq,
      config.driver.qq,
      config.runtime.threadId ?? null,
    ]);
    const expectedScopeObject = cleanupScopeObject(config);
    const stopPath = join(out, "STOP");
    const stopAtStart = await readPrivate(stopPath, 16 * 1024);
    const guardAtStart = await readPrivate(guardPathCurrent, 1024 * 1024);
    if (guardAtStart.sha256 !== inputs.guard.sha256) blocked("CLEANUP_RECONCILIATION_GUARD");
    const runRows = db
      .prepare(
        "SELECT r.id,r.status,r.principal_id,r.scope_json,r.created_at,r.updated_at,m.id AS message_id,m.external_id,m.text FROM runs r JOIN messages m ON m.id=r.message_id WHERE m.text=? AND m.scope_key=?",
      )
      .all(prompt, expectedScope);
    if (
      runRows.length !== 1 ||
      runRows[0].status !== "succeeded" ||
      runRows[0].principal_id !== planRecord.plan.principalId ||
      !same(JSON.parse(runRows[0].scope_json), expectedScopeObject) ||
      Date.parse(runRows[0].created_at) < Date.parse(report.startedAt) - 2000 ||
      Date.parse(runRows[0].created_at) > Date.parse(report.finishedAt) + 120000
    )
      blocked("CLEANUP_RECONCILIATION_RUN");
    const run = runRows[0];
    const deliveries = db
      .prepare(
        "SELECT id,status,external_id,payload_text,destination_scope_key FROM deliveries WHERE run_id=?",
      )
      .all(run.id);
    if (
      deliveries.length !== 1 ||
      deliveries[0].status !== "sent" ||
      deliveries[0].destination_scope_key !== expectedScope ||
      !MESSAGE_ID.test(String(deliveries[0].external_id))
    )
      blocked("CLEANUP_RECONCILIATION_DELIVERY");
    const delivery = deliveries[0];
    const replySha = digest(String(delivery.payload_text));
    const replyBytes = Buffer.byteLength(String(delivery.payload_text));
    clients = deps.createClients
      ? await deps.createClients(config)
      : {
          driver: new OneBot(config, "driver"),
          bot: new OneBot(config, "bot"),
        };
    if (!deps.createClients) {
      await clients.driver.connect();
      await clients.bot.connect();
    }
    const history = await clients.driver.readOwnerBotPrivateHistory();
    const inputSha = digest(prompt);
    const inputBytes = Buffer.byteLength(prompt);
    const historyPair = matchHistoryRows(history, {
      driverId: config.driver.qq,
      botId: config.bot.qq,
      inputSha256: inputSha,
      inputBytes,
      replySha256: replySha,
      replyBytes,
    });
    if (
      historyPair.input.time < Math.floor(Date.parse(report.startedAt) / 1000) - 2 ||
      historyPair.reply.time < Math.floor(Date.parse(run.updated_at) / 1000)
    )
      blocked("CLEANUP_RECONCILIATION_HISTORY_TIME");
    const botInputId = String(run.external_id);
    const botReplyId = String(delivery.external_id);
    clients.bot.allowMessageRead(botInputId);
    clients.driver.allowMessageRead(historyPair.input.messageId);
    clients.bot.allowMessageRead(botReplyId);
    clients.driver.allowMessageRead(historyPair.reply.messageId);
    const inputBot = await boundMessage(clients.bot, botInputId, {
      selfId: config.bot.qq,
      senderId: config.driver.qq,
      messageType: "private",
      text: prompt,
      afterTime: failedCase.startedAt,
    });
    const inputDriver = await boundMessage(clients.driver, historyPair.input.messageId, {
      selfId: config.driver.qq,
      senderId: config.driver.qq,
      messageType: "private",
      text: prompt,
      afterTime: failedCase.startedAt,
    });
    const inputBinding = {
      botMessageId: botInputId,
      driverMessageId: historyPair.input.messageId,
      ...compareSameMessage(inputBot, inputDriver),
    };
    const replyBot = await boundMessage(clients.bot, botReplyId, {
      selfId: config.bot.qq,
      senderId: config.bot.qq,
      messageType: "private",
      textSha256: replySha,
      afterTime: failedCase.startedAt,
    });
    const replyDriver = await boundMessage(clients.driver, historyPair.reply.messageId, {
      selfId: config.driver.qq,
      senderId: config.bot.qq,
      messageType: "private",
      textSha256: replySha,
      afterTime: failedCase.startedAt,
    });
    const replyBinding = {
      botMessageId: botReplyId,
      driverMessageId: historyPair.reply.messageId,
      ...compareSameMessage(replyBot, replyDriver),
      textBytes: replyBytes,
    };
    if (replyBinding.time < inputBinding.time || replyBinding.driverTime < inputBinding.driverTime)
      blocked("CLEANUP_RECONCILIATION_CHRONOLOGY");
    const transportCase = {
      id: "acceptance-memory-cleanup",
      status: "PASS",
      code: "REAL_REPLY_RECEIVED",
      route: "private",
      token,
      prompt,
      promptSha256: failedCase.promptSha256,
      expected: [token],
      startedAt: failedCase.startedAt,
      sendAttempted: true,
      inputObserved: true,
      leaseRegistrationAttempted: true,
      leaseRevoked: true,
      anomalies: [],
      acceptanceLease: failedCase.acceptanceLease,
      leasedToolNames: planRecord.plan.leaseTools.map((item) => item.name),
      sentMessageId: inputBinding.driverMessageId,
      inputBinding,
      replies: [
        {
          route: "private",
          messageId: replyBinding.driverMessageId,
          textSha256: replyBinding.textSha256,
          textBytes: replyBinding.textBytes,
          matches: true,
        },
      ],
      featureAssertions: [
        {
          kind: "trace",
          type: "tool_result",
          where: { name: "owner_memory_admin", isError: false },
          count: 1,
        },
      ],
    };
    const product = await (deps.verifyProductEvidence ?? verifyProductEvidence)(
      { mode: "run", status: "PASS", runtime: currentRuntime, cases: [transportCase] },
      config,
      clients,
    );
    if (
      product.status !== "PASS" ||
      product.cases?.length !== 1 ||
      product.cases[0].runId !== run.id ||
      product.cases[0].traceVerified !== true ||
      product.cases[0].cleanupVerified !== true
    )
      blocked("CLEANUP_RECONCILIATION_PRODUCT");
    const trace = (deps.readTraceEvents ?? readTraceEvents)(
      currentRuntime.checkout,
      currentRuntime.dataDirectory,
      run.id,
      deps.captureTrace,
      [],
    );
    if (trace.runId !== run.id || !Array.isArray(trace.events))
      blocked("CLEANUP_RECONCILIATION_TRACE");
    const cleanup = cleanupEvidence({
      db,
      trace,
      run,
      delivery,
      transportCase,
      plan: planRecord.plan,
      runtime: currentRuntime,
      expectedScope,
    });
    const finalValue = (deps.readCurrentInventory ?? readCurrentInventory)(
      currentRuntime,
      inputs.inventory,
      inputs.sourceAuditRows,
      config,
    );
    const final = finalValue.inventory ? finalValue : await finalValue;
    try {
      const proof = verifyAcceptanceMemoryCleanup({
        plan: planRecord.plan,
        planSha256: planRecord.sha256,
        cleanup,
        finalInventory: final.inventory,
        finalInventorySha256: final.inventorySha256,
      });
      const freshInputs =
        deps.inputsSnapshot ??
        (await (deps.loadInputs ?? loadAcceptanceMemoryCleanupInputs)(config, manifestPath));
      const freshFailure = await readPrivate(reportPath, MAX_REPORT);
      const freshIntent = await readPrivate(join(reportDirectory, "send-intent.json"), 16 * 1024);
      if (
        freshInputs.manifestSha256 !== inputs.manifestSha256 ||
        freshInputs.inventoryFileSha256 !== inputs.inventoryFileSha256 ||
        freshInputs.report.sha256 !== inputs.report.sha256 ||
        freshInputs.guard.sha256 !== inputs.guard.sha256 ||
        freshInputs.sourceAuditSha256 !== inputs.sourceAuditSha256 ||
        freshFailure.sha256 !== failureFile.sha256 ||
        freshIntent.sha256 !== intentFile.sha256
      )
        blocked("CLEANUP_RECONCILIATION_ORIGIN");
      await (deps.verifyOrigin ?? verifyAcceptanceMemoryCleanupOrigin)(config, freshInputs);
      const freshSnapshot = await verifyInputSnapshotFiles(
        freshInputs,
        manifestPath,
        guardPathCurrent,
        deps.expectedJournalSha256,
      );
      if (freshSnapshot.journalSha256 !== sourceFilesAtStart.journalSha256)
        blocked("CLEANUP_RECONCILIATION_ORIGIN");
      const repeatValue = (deps.readCurrentInventory ?? readCurrentInventory)(
        currentRuntime,
        inputs.inventory,
        inputs.sourceAuditRows,
        config,
      );
      const repeat = repeatValue.inventory ? repeatValue : await repeatValue;
      try {
        if (
          !same(repeat.inventory, final.inventory) ||
          repeat.inventorySha256 !== final.inventorySha256
        )
          blocked("CLEANUP_RECONCILIATION_INVENTORY");
      } finally {
        repeat.db?.close();
      }
      const freshRuntime = await (deps.runtimeSnapshot ?? runtimeInspectionSnapshot)(
        config.runtime,
      );
      if (!same(freshRuntime, currentRuntime)) blocked("CLEANUP_RECONCILIATION_RUNTIME");
      const freshStop = await readPrivate(stopPath, 16 * 1024);
      const freshGuard = freshSnapshot.guard;
      if (
        freshGuard.sha256 !== inputs.guard.sha256 ||
        freshGuard.sha256 !== guardAtStart.sha256 ||
        freshStop.sha256 !== stopAtStart.sha256
      )
        blocked("CLEANUP_RECONCILIATION_GUARD");
      const receipt = {
        schemaVersion: 1,
        kind: "acceptance-memory-completed-cleanup",
        status: "CLEANUP_RECONCILED",
        cleanupOnly: true,
        featurePass: false,
        failedReportPath: reportPath,
        failedReportSha256: failureFile.sha256,
        sendIntentSha256: intentFile.sha256,
        manifestPath,
        manifestSha256: inputs.manifestSha256,
        planSha256: planRecord.sha256,
        origin: inputs.origin,
        runtime: currentRuntime,
        runId: run.id,
        principalId: run.principal_id,
        inputBinding: {
          driverMessageId: inputBinding.driverMessageId,
          botMessageId: inputBinding.botMessageId,
          realSequence: inputBinding.realSequence,
          time: inputBinding.time,
          driverTime: inputBinding.driverTime,
          textSha256: inputBinding.textSha256,
        },
        replyBinding: {
          driverMessageId: replyBinding.driverMessageId,
          botMessageId: replyBinding.botMessageId,
          realSequence: replyBinding.realSequence,
          time: replyBinding.time,
          driverTime: replyBinding.driverTime,
          textSha256: replyBinding.textSha256,
          textBytes: replyBinding.textBytes,
        },
        transportEvidence: {
          id: "acceptance-memory-cleanup",
          token,
          route: "private",
          startedAt: failedCase.startedAt,
          status: "PASS",
          code: "REAL_REPLY_RECEIVED",
          sendAttempted: true,
          inputObserved: true,
          leaseRegistrationAttempted: true,
          leaseRevoked: true,
          anomalies: [],
          promptSha256: digest(prompt),
          expectedSha256: digest(canonical([token])),
          acceptanceLease: failedCase.acceptanceLease,
          inputBinding,
          replies: [
            {
              route: "private",
              messageId: botReplyId,
              textSha256: replyBinding.textSha256,
              textBytes: replyBytes,
              matches: true,
            },
          ],
        },
        productEvidence: {
          runId: run.id,
          principalId: run.principal_id,
          traceVerified: true,
          cleanupVerified: true,
          inputBinding,
          messageBinding: {
            input: { messageId: botInputId, textSha256: inputBinding.textSha256 },
            reply: {
              botMessageId: botReplyId,
              driverMessageId: replyBinding.driverMessageId,
              textSha256: replyBinding.textSha256,
            },
          },
        },
        cleanupEvidence: cleanup,
        cleanupProof: proof,
        stopPath: join(out, "STOP"),
        stopSha256: freshStop.sha256,
        guardPath: inputs.manifest.pendingGuardPath,
        guardSha256: freshGuard.sha256,
        verifiedAt: new Date().toISOString(),
      };
      if (!writeReceipt) return receipt;
      const receiptPath = join(reportDirectory, "completed-cleanup-receipt.json");
      await verifyPrivateDirectory(reportDirectory);
      const handle = await open(receiptPath, "wx", 0o600);
      try {
        await handle.writeFile(JSON.stringify(receipt, null, 2) + "\n");
        await handle.sync();
      } catch {
        blocked("CLEANUP_RECONCILIATION_WRITE");
      } finally {
        await handle.close();
      }
      await chmod(receiptPath, 0o600);
      const directory = await open(reportDirectory, "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
      return { status: receipt.status, receiptPath, cleanupOnly: true, featurePass: false };
    } finally {
      final.db?.close();
    }
  } finally {
    initial.db?.close();
    clients?.driver?.close?.();
    clients?.bot?.close?.();
  }
}

export {
  matchHistoryRows as matchAcceptanceMemoryCleanupHistory,
  cleanupScopeObject as acceptanceMemoryCleanupScopeObject,
  verifyFailedAttempt as validateAcceptanceMemoryCleanupFailedAttempt,
  validateCleanupInputProjection as validateAcceptanceMemoryCleanupInputProjection,
};

/** Re-run all independent checks and compare them with a previously saved cleanup-only receipt. */
export async function verifyAcceptanceMemoryCompletedCleanupReceipt(args) {
  const file = await readPrivate(args.receiptPath, MAX_REPORT);
  const saved = parseJson(file.bytes);
  if (
    !exactKeys(saved, [
      "schemaVersion",
      "kind",
      "status",
      "cleanupOnly",
      "featurePass",
      "failedReportPath",
      "failedReportSha256",
      "sendIntentSha256",
      "manifestPath",
      "manifestSha256",
      "planSha256",
      "origin",
      "runtime",
      "runId",
      "principalId",
      "inputBinding",
      "replyBinding",
      "transportEvidence",
      "productEvidence",
      "cleanupEvidence",
      "cleanupProof",
      "stopPath",
      "stopSha256",
      "guardPath",
      "guardSha256",
      "verifiedAt",
    ]) ||
    saved.schemaVersion !== 1 ||
    saved.kind !== "acceptance-memory-completed-cleanup" ||
    saved.status !== "CLEANUP_RECONCILED" ||
    saved.cleanupOnly !== true ||
    saved.featurePass !== false ||
    !validTime(saved.verifiedAt)
  )
    return false;
  const current = await verifyAcceptanceMemoryCompletedCleanup({ ...args, writeReceipt: false });
  const stableSaved = { ...saved };
  const stableCurrent = { ...current };
  delete stableSaved.verifiedAt;
  delete stableCurrent.verifiedAt;
  return same(stableSaved, stableCurrent);
}
