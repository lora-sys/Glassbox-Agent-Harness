import { digest, fail, toolManifestDigest } from "./core.mjs";
import {
  messageReplyTimesFollowInput,
  messageTimeBindingKeys,
  messageTimesMatch,
  validMessageTimeBinding,
} from "./message-binding.mjs";
import { TASK_WORKER_FAMILY_ID, taskWorkerFixtureStep } from "./task-worker-scenario.mjs";

const STAGES = ["create", "delegate", "inspect", "accept"];
const NONCE = /^[a-f0-9]{32}$/u;
const RUN = /^[A-Za-z0-9_-]{1,128}$/u;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu;
const HASH = /^[a-f0-9]{64}$/u;
const MESSAGE_ID = /^[1-9]\d{0,19}$/u;

function inconclusive(message) {
  fail("TASK_WORKER_FAMILY_EVIDENCE", message, "INCONCLUSIVE");
}

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (record(value))
    return `{${Object.keys(value)
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

function same(left, right) {
  return canonical(left) === canonical(right);
}

function exact(value, keys) {
  const compare = (left, right) => (left < right ? -1 : left > right ? 1 : 0);
  return record(value) && same(Object.keys(value).sort(compare), [...keys].sort(compare));
}

function runtimeValid(value) {
  return (
    record(value) &&
    typeof value.checkout === "string" &&
    value.checkout.length > 0 &&
    typeof value.dataDirectory === "string" &&
    value.dataDirectory.length > 0 &&
    /^[a-f0-9]{40}$/u.test(value.commit ?? "") &&
    Number.isSafeInteger(value.pid) &&
    value.pid > 0 &&
    typeof value.connectionId === "string" &&
    value.connectionId.length > 0
  );
}

function taskUuid(value) {
  return typeof value === "string" && UUID.test(value);
}

function verifyTransport(stage, spec, result, state) {
  const c = result?.transportCase;
  const token = c?.token;
  if (!record(c) || typeof token !== "string" || !NONCE.test(token) || token === state.fixtureNonce)
    inconclusive(`${stage} transport case has an invalid per-step token.`);
  if (state.tokens.has(token)) inconclusive("Task Worker stages reused a transport token.");
  const expectedPrompt = `GLASSBOX_ACCEPTANCE_V1 ${token}\n${spec.prompt.replaceAll("{{nonce}}", token).trim()}`;
  const expectedTools = spec.leaseTools;
  const lease = c.acceptanceLease;
  const startedAt = typeof c.startedAt === "string" ? Date.parse(c.startedAt) : NaN;
  if (
    c.id !== spec.id ||
    c.status !== "PASS" ||
    c.route !== "private" ||
    c.inputObserved !== true ||
    c.sendAttempted !== true ||
    typeof c.prompt !== "string" ||
    c.prompt !== expectedPrompt ||
    !same(
      c.expected,
      spec.expectContains.map((item) => item.replaceAll("{{nonce}}", token)),
    ) ||
    !same(c.featureAssertions, spec.featureAssertions) ||
    !same(
      c.leasedToolNames,
      expectedTools.map((item) => item.name),
    ) ||
    c.leaseRevoked !== true ||
    !exact(lease, ["leaseId", "expiresAt", "toolsSha256"]) ||
    typeof lease.leaseId !== "string" ||
    !UUID.test(lease.leaseId) ||
    state.leaseIds.has(lease.leaseId) ||
    !Number.isFinite(startedAt) ||
    !Number.isSafeInteger(lease.expiresAt) ||
    lease.expiresAt <= startedAt ||
    typeof lease.toolsSha256 !== "string" ||
    !HASH.test(lease.toolsSha256) ||
    lease.toolsSha256 !== toolManifestDigest(expectedTools) ||
    typeof c.sentMessageId !== "string" ||
    !MESSAGE_ID.test(c.sentMessageId) ||
    !record(c.inputBinding) ||
    typeof c.inputBinding.botMessageId !== "string" ||
    !MESSAGE_ID.test(c.inputBinding.botMessageId) ||
    c.inputBinding.driverMessageId !== c.sentMessageId ||
    !Array.isArray(c.replies) ||
    c.replies.length !== 1 ||
    c.replies[0]?.route !== "private" ||
    c.replies[0]?.matches !== true ||
    typeof c.replies[0]?.messageId !== "string" ||
    !MESSAGE_ID.test(c.replies[0].messageId) ||
    !Array.isArray(c.anomalies) ||
    c.anomalies.length !== 0
  )
    inconclusive(`${stage} transport case does not match its fixed private input and lease.`);
  state.tokens.add(token);
  state.leaseIds.add(lease.leaseId);
  return { token, runId: result?.runId, leaseId: lease.leaseId, transportCase: c };
}

function verifyProduct(stage, result, transport, runtime) {
  const product = result?.productAcceptance;
  const evidence = product?.cases?.length === 1 ? product.cases[0] : undefined;
  const binding = evidence?.messageBinding;
  const input = binding?.input;
  const reply = binding?.reply;
  const sent = evidence?.delivery;
  const c = transport.transportCase;
  if (
    product?.status !== "PASS" ||
    !same(product.runtime, runtime) ||
    !evidence ||
    evidence.caseId !== transport.transportCase.id ||
    evidence.runId !== transport.runId ||
    evidence.traceVerified !== true ||
    evidence.cleanupVerified !== true ||
    evidence.feature?.status !== "PASS" ||
    evidence.feature?.runId !== transport.runId ||
    !same(evidence.scope, transport.receiptScope) ||
    !exact(input, messageTimeBindingKeys(input, ["realSequence", "time", "textSha256"])) ||
    !Object.hasOwn(input, "driverTime") ||
    !validMessageTimeBinding(input) ||
    input.realSequence !== c.inputBinding.realSequence ||
    !messageTimesMatch(c.inputBinding, input) ||
    input.textSha256 !== digest(c.prompt) ||
    !exact(
      reply,
      messageTimeBindingKeys(reply, [
        "botMessageId",
        "driverMessageId",
        "realSequence",
        "time",
        "textSha256",
      ]),
    ) ||
    !Object.hasOwn(reply, "driverTime") ||
    !validMessageTimeBinding(reply) ||
    !messageReplyTimesFollowInput(input, reply) ||
    typeof sent?.external_id !== "string" ||
    reply.botMessageId !== sent.external_id ||
    reply.driverMessageId !== c.replies?.[0]?.messageId ||
    !/^[a-f0-9]{64}$/u.test(reply.textSha256 ?? "") ||
    sent.status !== "sent"
  )
    inconclusive(`${stage} product evidence is not bound to its independently verified Run.`);
  return evidence;
}

function verifyReceipt(stage, receipt, ctx) {
  const common = [
    "stage",
    "runId",
    "taskId",
    "principalId",
    "principalKind",
    "scope",
    "cleanupVerified",
  ];
  const extras = {
    create: ["creationRunId", "taskStatus", "attemptId", "bindingId"],
    delegate: [
      "creationRunId",
      "attemptId",
      "bindingId",
      "workspaceId",
      "herdrSession",
      "agentKind",
      "dispatchVerified",
      "taskStatus",
      "attemptStatus",
    ],
    inspect: [
      "creationRunId",
      "attemptId",
      "bindingId",
      "taskStatus",
      "attemptStatus",
      "workerTerminalVerified",
      "artifact",
    ],
    accept: [
      "creationRunId",
      "attemptId",
      "bindingId",
      "acceptedRunId",
      "taskStatus",
      "attemptStatus",
      "workerLeaseReleased",
      "terminalVerified",
      "pendingAttentionCount",
    ],
  }[stage];
  if (!exact(receipt, [...common, ...extras]))
    inconclusive(`${stage} independent receipt has an invalid shape.`);
  if (
    receipt.stage !== stage ||
    receipt.runId !== ctx.runId ||
    !RUN.test(receipt.runId ?? "") ||
    receipt.principalKind !== "owner" ||
    typeof receipt.principalId !== "string" ||
    !receipt.principalId ||
    receipt.cleanupVerified !== true ||
    !record(receipt.scope) ||
    receipt.scope.chatType !== "private" ||
    typeof receipt.scope.connectionId !== "string" ||
    typeof receipt.scope.botId !== "string" ||
    typeof receipt.scope.chatId !== "string" ||
    typeof receipt.scope.senderId !== "string" ||
    receipt.scope.chatId !== receipt.scope.senderId
  )
    inconclusive(`${stage} receipt does not prove a cleaned Owner-private Run.`);

  if (ctx.scope && !same(receipt.scope, ctx.scope))
    inconclusive("Task Worker stages changed their private scope.");
  if (ctx.principalId && receipt.principalId !== ctx.principalId)
    inconclusive("Task Worker stages changed Owner Principal.");
  if (receipt.creationRunId !== ctx.creationRunId)
    inconclusive(`${stage} receipt is not bound to the Task creation Run.`);
  if (stage === "create") {
    if (
      receipt.creationRunId !== receipt.runId ||
      !taskUuid(receipt.taskId) ||
      receipt.taskStatus !== "NEW" ||
      receipt.attemptId !== null ||
      receipt.bindingId !== null
    )
      inconclusive("Task creation did not produce one new, unbound fixture Task.");
    return;
  }
  if (
    receipt.taskId !== ctx.taskId ||
    !UUID.test(receipt.attemptId ?? "") ||
    !UUID.test(receipt.bindingId ?? "")
  )
    inconclusive(`${stage} receipt changed Task, Attempt, or WorkerBinding identity.`);
  if (ctx.attemptId && receipt.attemptId !== ctx.attemptId)
    inconclusive(`${stage} receipt changed TaskAttempt identity.`);
  if (ctx.bindingId && receipt.bindingId !== ctx.bindingId)
    inconclusive(`${stage} receipt changed WorkerBinding identity.`);
  if (stage === "delegate") {
    const target = ctx.expectedWorkerTarget;
    if (
      receipt.workspaceId !== target.workspaceId ||
      receipt.herdrSession !== target.herdrSession ||
      receipt.agentKind !== target.agentKind ||
      receipt.dispatchVerified !== true ||
      !["RUNNING", "REVIEW"].includes(receipt.taskStatus) ||
      !["running", "review"].includes(receipt.attemptStatus)
    )
      inconclusive("Worker dispatch does not match the fixed server-owned target.");
    return;
  }
  if (stage === "inspect") {
    const artifact = receipt.artifact;
    if (
      receipt.taskStatus !== "REVIEW" ||
      receipt.attemptStatus !== "review" ||
      receipt.workerTerminalVerified !== true ||
      !exact(artifact, [
        "filename",
        "sizeBytes",
        "sha256",
        "fullContentVerified",
        "markerSha256",
      ]) ||
      artifact.filename !== `qq-live-worker-${ctx.fixtureNonce}.txt` ||
      artifact.sizeBytes !== Buffer.byteLength(`${ctx.fixtureNonce}\n`, "utf8") ||
      !HASH.test(artifact.sha256 ?? "") ||
      artifact.sha256 !== digest(Buffer.from(`${ctx.fixtureNonce}\n`, "utf8")) ||
      artifact.fullContentVerified !== true ||
      artifact.markerSha256 !== ctx.expectedWorkerTarget.markerSha256
    )
      inconclusive("Worker review does not prove the fixed retained artifact.");
    return;
  }
  if (
    receipt.acceptedRunId !== receipt.runId ||
    receipt.taskStatus !== "DONE" ||
    receipt.attemptStatus !== "succeeded" ||
    receipt.workerLeaseReleased !== true ||
    receipt.terminalVerified !== true ||
    receipt.pendingAttentionCount !== 0
  )
    inconclusive("Task acceptance did not prove terminal cleanup and zero pending attention.");
}

/** Execute and independently verify the fixed Task Worker lifecycle without retries. */
export async function runTaskWorkerFamily({
  fixtureNonce,
  expectedWorkerTarget,
  executeStep,
  verifyStep,
  checkpoint,
  readRuntime,
  signal,
} = {}) {
  if (
    typeof fixtureNonce !== "string" ||
    !NONCE.test(fixtureNonce) ||
    !exact(expectedWorkerTarget, ["workspaceId", "herdrSession", "agentKind", "markerSha256"]) ||
    typeof expectedWorkerTarget.workspaceId !== "string" ||
    !expectedWorkerTarget.workspaceId ||
    typeof expectedWorkerTarget.herdrSession !== "string" ||
    !expectedWorkerTarget.herdrSession ||
    typeof expectedWorkerTarget.agentKind !== "string" ||
    !expectedWorkerTarget.agentKind ||
    !HASH.test(expectedWorkerTarget.markerSha256 ?? "") ||
    typeof executeStep !== "function" ||
    typeof verifyStep !== "function" ||
    typeof checkpoint !== "function" ||
    typeof readRuntime !== "function"
  )
    inconclusive(
      "Task Worker family requires fixed fixture, trusted target, and independent verifiers.",
    );

  const initialRuntime = await readRuntime();
  if (!runtimeValid(initialRuntime)) inconclusive("Task Worker runtime identity is incomplete.");
  const state = {
    fixtureNonce,
    expectedWorkerTarget,
    tokens: new Set(),
    leaseIds: new Set(),
    runIds: new Set(),
  };
  const receipts = [];
  let creationRunId;
  let taskId;
  let attemptId;
  let bindingId;
  let scope;
  let principalId;

  for (const stage of STAGES) {
    if (signal?.aborted) inconclusive("Task Worker family was aborted before the next stage.");
    if (!same(await readRuntime(), initialRuntime))
      inconclusive("Task Worker runtime changed before a stage.");
    const spec = taskWorkerFixtureStep(stage, { fixtureNonce, taskId });
    if (
      (await checkpoint({ familyId: TASK_WORKER_FAMILY_ID, stage, phase: "intent", taskId })) !==
      true
    )
      inconclusive(`${stage} intent checkpoint was not persisted.`);
    if (!same(await readRuntime(), initialRuntime))
      inconclusive("Task Worker runtime changed after the stage checkpoint.");

    const executed = await executeStep(stage, spec);
    if (
      (await checkpoint({
        familyId: TASK_WORKER_FAMILY_ID,
        stage,
        phase: "sent_unverified",
        taskId,
      })) !== true
    )
      inconclusive(
        `${stage} post-send checkpoint was not persisted; the stage will not be retried.`,
      );
    if (!same(await readRuntime(), initialRuntime))
      inconclusive("Task Worker runtime changed after a stage send.");

    const transport = verifyTransport(stage, spec, executed, state);
    if (
      typeof transport.runId !== "string" ||
      !RUN.test(transport.runId) ||
      state.runIds.has(transport.runId)
    )
      inconclusive("Task Worker stages must use distinct verified Runs.");
    state.runIds.add(transport.runId);
    const context = {
      fixtureNonce,
      expectedWorkerTarget,
      runId: transport.runId,
      creationRunId: creationRunId ?? (stage === "create" ? transport.runId : undefined),
      taskId,
      attemptId,
      bindingId,
      principalId,
      scope,
      priorReceipts: receipts,
      spec,
      transportCase: transport.transportCase,
      productAcceptance: executed.productAcceptance,
      runtime: initialRuntime,
    };
    const receipt = await verifyStep(stage, context);
    verifyReceipt(stage, receipt, context);
    verifyProduct(stage, executed, { ...transport, receiptScope: receipt.scope }, initialRuntime);
    if (scope && !same(receipt.scope, scope))
      inconclusive("Task Worker scope changed between stages.");
    scope ??= receipt.scope;
    principalId ??= receipt.principalId;
    if (stage === "create") {
      creationRunId = receipt.runId;
      taskId = receipt.taskId;
    } else if (stage === "delegate") {
      attemptId = receipt.attemptId;
      bindingId = receipt.bindingId;
    }
    receipts.push(receipt);
    if (
      (await checkpoint({
        familyId: TASK_WORKER_FAMILY_ID,
        stage,
        phase: "verified",
        taskId,
        runId: transport.runId,
      })) !== true
    )
      inconclusive(`${stage} verification checkpoint was not persisted.`);
    if (!same(await readRuntime(), initialRuntime))
      inconclusive("Task Worker runtime changed after independent verification.");
  }

  return {
    status: "PASS",
    familyId: TASK_WORKER_FAMILY_ID,
    taskId,
    creationRunId,
    stageRunIds: receipts.map((receipt) => receipt.runId),
    attemptId,
    bindingId,
    artifact: receipts[2].artifact,
    terminalStatus: receipts[3].taskStatus,
    cleanup: {
      acceptanceLeasesRevoked: true,
      workerLeaseReleased: receipts[3].workerLeaseReleased,
      pendingAttentionCount: receipts[3].pendingAttentionCount,
    },
  };
}
