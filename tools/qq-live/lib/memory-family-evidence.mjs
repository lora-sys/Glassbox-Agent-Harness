import { fail, digest, toolManifestDigest } from "./core.mjs";
import {
  messageReplyTimesFollowInput,
  messageTimeBindingKeys,
  messageTimesMatch,
  validMessageTimeBinding,
} from "./message-binding.mjs";
import { memoryFixtureStep } from "./memory-scenario.mjs";
import { MEMORY_FAMILY_ID, MEMORY_REJECT_FAMILY_ID, memoryWorkflow } from "./memory-workflow.mjs";

export const MEMORY_FAMILY_CASE_ID = MEMORY_FAMILY_ID;
export const MEMORY_REJECT_FAMILY_CASE_ID = MEMORY_REJECT_FAMILY_ID;

const RUN_ID = /^[A-Za-z0-9_-]{1,128}$/;
const NONCE = /^[a-f0-9]{32}$/;
const HASH = /^[a-f0-9]{64}$/;
const CANDIDATE_ID = /^candidate_[a-f0-9]{32}$/;
const MEMORY_ID = /^memory_[a-f0-9]{32}$/;
const MESSAGE_ID = /^-?\d{1,20}$/;
const LEASE_ID = /^[a-f0-9-]{36}$/i;

function invalid(message) {
  fail("MEMORY_FAMILY_EVIDENCE", message, "INCONCLUSIVE");
}

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (record(value))
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

function same(a, b) {
  return canonical(a) === canonical(b);
}

function exactKeys(value, expected) {
  const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  return record(value) && same(Object.keys(value).sort(compare), [...expected].sort(compare));
}

function validRuntime(runtime) {
  return (
    exactKeys(runtime, [
      "checkout",
      "dataDirectory",
      "commit",
      "pid",
      "connectionId",
      "threadId",
    ]) &&
    typeof runtime.checkout === "string" &&
    runtime.checkout.length > 0 &&
    typeof runtime.dataDirectory === "string" &&
    runtime.dataDirectory.length > 0 &&
    /^[a-f0-9]{40}$/.test(runtime.commit ?? "") &&
    Number.isSafeInteger(runtime.pid) &&
    runtime.pid > 0 &&
    typeof runtime.connectionId === "string" &&
    runtime.connectionId.length > 0 &&
    (runtime.threadId === null ||
      runtime.threadId === undefined ||
      (typeof runtime.threadId === "string" && runtime.threadId.length > 0))
  );
}

function markerSpec(stage, nonce, candidateId, memoryId, token) {
  const spec = memoryFixtureStep(stage, { nonce, candidateId, memoryId });
  const replace = (value) => JSON.parse(JSON.stringify(value).replaceAll("{{nonce}}", token));
  const expectedPrompt = `GLASSBOX_ACCEPTANCE_V1 ${token}\n${spec.prompt.replaceAll("{{nonce}}", token).trim()}`;
  const leaseTools = replace(spec.leaseTools);
  return {
    spec,
    expectedPrompt,
    expected: replace(spec.expectContains),
    featureAssertions: replace(spec.featureAssertions),
    toolNames: leaseTools.map((tool) => tool.name),
    toolsSha256: toolManifestDigest(leaseTools),
    expectedObservations: spec.featureAssertions.map((assertion) => ({
      kind: "trace",
      type: assertion.type,
      count: assertion.count,
    })),
  };
}

function validateTransportCase(c, stage, nonce, handles) {
  const token = c?.token;
  if (!NONCE.test(token ?? "")) invalid("Memory family case lacks its unique marker.");
  const expected = markerSpec(stage, nonce, handles.candidateId, handles.memoryId, token);
  const binding = c.inputBinding;
  const reply = c.replies;
  const lease = c.acceptanceLease;
  if (
    c.id !== expected.spec.id ||
    c.status !== "PASS" ||
    c.route !== "private" ||
    c.prompt !== expected.expectedPrompt ||
    !same(c.expected, expected.expected) ||
    !same(c.featureAssertions, expected.featureAssertions) ||
    !same(c.leasedToolNames, expected.toolNames) ||
    c.leaseRevoked !== true ||
    !exactKeys(lease, ["leaseId", "expiresAt", "toolsSha256"]) ||
    !LEASE_ID.test(lease.leaseId ?? "") ||
    !Number.isSafeInteger(lease.expiresAt) ||
    lease.expiresAt <= Date.parse(c.startedAt) ||
    lease.toolsSha256 !== expected.toolsSha256 ||
    !exactKeys(
      binding,
      messageTimeBindingKeys(binding, [
        "driverMessageId",
        "botMessageId",
        "realSequence",
        "time",
        "textSha256",
      ]),
    ) ||
    !MESSAGE_ID.test(String(binding.driverMessageId ?? "")) ||
    !MESSAGE_ID.test(String(binding.botMessageId ?? "")) ||
    String(c.sentMessageId) !== String(binding.driverMessageId) ||
    typeof binding.realSequence !== "string" ||
    !/^\d{1,30}$/.test(binding.realSequence) ||
    !validMessageTimeBinding(binding) ||
    binding.textSha256 !== digest(expected.expectedPrompt) ||
    !Array.isArray(reply) ||
    reply.length !== 1 ||
    reply[0]?.route !== "private" ||
    reply[0]?.matches !== true ||
    !HASH.test(reply[0]?.textSha256 ?? "") ||
    !Array.isArray(c.anomalies) ||
    c.anomalies.length !== 0
  )
    invalid(`Memory family ${stage} transport or fixed Tool evidence is invalid.`);
  return { expected, binding, reply: reply[0] };
}

function validateScope(scope, runtime) {
  if (
    !exactKeys(scope, ["connectionId", "botId", "chatType", "chatId", "senderId", "threadId"]) ||
    scope.connectionId !== runtime.connectionId ||
    scope.chatType !== "private" ||
    typeof scope.botId !== "string" ||
    !scope.botId ||
    typeof scope.chatId !== "string" ||
    !scope.chatId ||
    typeof scope.senderId !== "string" ||
    !scope.senderId ||
    (scope.threadId ?? null) !== (runtime.threadId ?? null)
  )
    invalid("Fresh product evidence is outside the private runtime scope.");
  return {
    connectionId: scope.connectionId,
    botId: scope.botId,
    chatType: scope.chatType,
    chatId: scope.chatId,
    senderId: scope.senderId,
    threadId: scope.threadId ?? null,
  };
}

function validateFreshCase(evidence, c, stage, transport, runtime, previousScope) {
  const runId = evidence?.runId;
  const scope = validateScope(evidence?.scope, runtime);
  const delivery = evidence?.delivery;
  const messageBinding = evidence?.messageBinding;
  const input = messageBinding?.input;
  const reply = messageBinding?.reply;
  const scopeKey = JSON.stringify([
    scope.connectionId,
    scope.botId,
    scope.chatType,
    scope.chatId,
    scope.senderId,
    scope.threadId,
  ]);
  if (
    evidence.caseId !== c.id ||
    !RUN_ID.test(runId ?? "") ||
    evidence.traceVerified !== true ||
    evidence.feature?.runId !== runId ||
    evidence.feature?.status !== "PASS" ||
    !same(evidence.feature.observations, transport.expected.expectedObservations) ||
    !delivery ||
    !RUN_ID.test(delivery.id ?? "") ||
    delivery.status !== "sent" ||
    delivery.destination_scope_key !== scopeKey ||
    !MESSAGE_ID.test(String(delivery.external_id ?? "")) ||
    !input ||
    !exactKeys(input, messageTimeBindingKeys(input, ["realSequence", "time", "textSha256"])) ||
    !validMessageTimeBinding(input) ||
    String(input.realSequence) !== String(transport.binding.realSequence) ||
    !messageTimesMatch(transport.binding, input) ||
    input.textSha256 !== transport.binding.textSha256 ||
    !reply ||
    !MESSAGE_ID.test(String(reply.botMessageId ?? "")) ||
    String(reply.botMessageId) !== String(delivery.external_id) ||
    !MESSAGE_ID.test(String(reply.driverMessageId ?? "")) ||
    String(reply.driverMessageId) !== String(transport.reply.messageId) ||
    !exactKeys(
      reply,
      messageTimeBindingKeys(reply, [
        "botMessageId",
        "driverMessageId",
        "realSequence",
        "time",
        "textSha256",
      ]),
    ) ||
    !validMessageTimeBinding(reply) ||
    !Object.hasOwn(reply, "driverTime") ||
    !/^\d{1,30}$/.test(String(reply.realSequence ?? "")) ||
    !Number.isSafeInteger(reply.time) ||
    !messageReplyTimesFollowInput(input, reply) ||
    reply.textSha256 !== transport.reply.textSha256 ||
    (previousScope && !same(scope, previousScope))
  )
    invalid(`Fresh product evidence for ${c.id} does not match its private input and delivery.`);
  return { runId, scope };
}

function validateLifecycle(report, cases, freshCases, runtime, workflow) {
  const lifecycle = report.memoryLifecycle;
  const handles = lifecycle?.handles;
  const nonce = handles?.fixtureNonce;
  const stages = workflow.stages;
  const finalStage = stages.at(-1);
  const promoted = stages.includes("promote");
  if (
    !record(lifecycle) ||
    !record(handles) ||
    report.mode !== "run" ||
    report.cleanupOnly === true ||
    report.status !== "PASS" ||
    report.productAcceptance?.status !== "PASS" ||
    !record(report.memoryFamily) ||
    !same(report.memoryFamily, { caseId: workflow.id }) ||
    lifecycle?.status !== "PASS" ||
    lifecycle.requiresReconciliation !== false ||
    lifecycle.stage !== finalStage ||
    lifecycle.cleanup?.status !== workflow.cleanupStatus ||
    !NONCE.test(nonce ?? "") ||
    handles.projectId !== `qqtest-${nonce}` ||
    !RUN_ID.test(handles.principalId ?? "") ||
    !CANDIDATE_ID.test(handles.candidateId ?? "") ||
    !RUN_ID.test(handles.creationRunId ?? "") ||
    !RUN_ID.test(handles.cleanupRunId ?? "") ||
    handles.cleanupStatus !== workflow.cleanupStatus ||
    handles.stepRunId !== handles.cleanupRunId ||
    lifecycle.cleanup.runId !== handles.cleanupRunId ||
    !Array.isArray(lifecycle.steps) ||
    lifecycle.steps.length !== stages.length ||
    (promoted
      ? !MEMORY_ID.test(handles.memoryId ?? "") || !RUN_ID.test(handles.promoteRunId ?? "")
      : Object.hasOwn(handles, "memoryId") || Object.hasOwn(handles, "promoteRunId")) ||
    !validRuntime(report.runtime) ||
    !same(report.runtime, runtime)
  )
    invalid("Report does not contain a complete fixed Memory lifecycle.");

  const stageRunIds = [];
  for (let index = 0; index < stages.length; index++) {
    const stage = stages[index];
    const step = lifecycle.steps[index];
    const evidence = freshCases[index];
    if (
      step?.stage !== stage ||
      step.currentRunId !== evidence.runId ||
      step.runId !== evidence.runId ||
      !same(step.productAcceptance, {
        status: "PASS",
        runtime,
        caseId: cases[index].id,
        traceVerified: true,
        featureStatus: "PASS",
      })
    )
      invalid(`Memory lifecycle ${stage} snapshot does not match fresh product evidence.`);
    stageRunIds.push(evidence.runId);
  }
  if (new Set(stageRunIds).size !== stages.length)
    invalid("Memory family lifecycle stages must use distinct Runs.");

  if (
    handles.creationRunId !== stageRunIds[0] ||
    handles.promoteRunId !== (promoted ? stageRunIds[stages.indexOf("promote")] : undefined) ||
    handles.cleanupRunId !== stageRunIds.at(-1)
  )
    invalid("Lifecycle resource handles do not match the verified stage Runs.");
  return { handles, nonce, stageRunIds, workflow };
}

/** Independently verify the fixed Memory family against fresh product evidence and SQL state. */
export async function verifyMemoryFamilyReport(report, { verifyProduct, readCleanup } = {}) {
  if (typeof verifyProduct !== "function" || typeof readCleanup !== "function")
    invalid("Memory family requires trusted fresh product and read-only cleanup verifiers.");
  let workflow;
  try {
    workflow = memoryWorkflow(report?.memoryFamily?.caseId);
  } catch {
    invalid("Report does not identify a supported fixed Memory workflow.");
  }
  if (
    !record(report) ||
    !Array.isArray(report.cases) ||
    report.cases.length !== workflow.stages.length ||
    report.cases.some((c, index) => c?.id !== `memory-${workflow.stages[index]}`)
  )
    invalid("Memory family requires exactly its fixed workflow cases.");

  const lifecycle = report.memoryLifecycle;
  const handles = lifecycle?.handles;
  const nonce = handles?.fixtureNonce;
  if (
    !record(lifecycle) ||
    !record(handles) ||
    !NONCE.test(nonce ?? "") ||
    handles.projectId !== `qqtest-${nonce}` ||
    !CANDIDATE_ID.test(handles.candidateId ?? "") ||
    (workflow.stages.includes("promote")
      ? !MEMORY_ID.test(handles.memoryId ?? "")
      : Object.hasOwn(handles, "memoryId") || Object.hasOwn(handles, "promoteRunId"))
  )
    invalid("Memory family fixture handles are invalid.");

  const transport = report.cases.map((c, index) =>
    validateTransportCase(c, workflow.stages[index], nonce, handles),
  );
  const product = await verifyProduct(report);
  if (
    product?.status !== "PASS" ||
    !validRuntime(product.runtime) ||
    !Array.isArray(product.cases) ||
    product.cases.length !== workflow.stages.length
  )
    invalid("Fresh product verification did not pass every fixed Memory stage.");

  const freshCases = [];
  let previousScope;
  for (let index = 0; index < workflow.stages.length; index++) {
    const verified = validateFreshCase(
      product.cases[index],
      report.cases[index],
      workflow.stages[index],
      transport[index],
      product.runtime,
      previousScope,
    );
    freshCases.push({ ...product.cases[index], runId: verified.runId });
    previousScope ??= verified.scope;
  }

  const { handles: verifiedHandles, stageRunIds } = validateLifecycle(
    report,
    report.cases,
    freshCases,
    product.runtime,
    workflow,
  );
  const cleanupInput = {
    projectId: verifiedHandles.projectId,
    principalId: verifiedHandles.principalId,
    candidateId: verifiedHandles.candidateId,
    creationRunId: verifiedHandles.creationRunId,
    cleanupRunId: verifiedHandles.cleanupRunId,
    ...(workflow.stages.includes("promote")
      ? {
          memoryId: verifiedHandles.memoryId,
          promoteRunId: verifiedHandles.promoteRunId,
        }
      : {}),
  };
  const cleanup = await readCleanup({ ...cleanupInput });
  if (
    !record(cleanup) ||
    cleanup.principalKind !== "owner" ||
    cleanup.status !== workflow.cleanupStatus ||
    (!workflow.stages.includes("promote") &&
      (Object.hasOwn(cleanup, "memoryId") || Object.hasOwn(cleanup, "promoteRunId"))) ||
    Object.entries(cleanupInput).some(([key, value]) => cleanup[key] !== value)
  )
    invalid("Read-only cleanup evidence does not match the exact Owner fixture lineage.");

  return {
    status: "PASS",
    caseId: workflow.id,
    runtime: product.runtime,
    handles: { fixtureNonce: nonce, ...cleanupInput },
    stageRunIds,
    cleanup: {
      principalKind: cleanup.principalKind,
      status: workflow.cleanupStatus,
      ...cleanupInput,
    },
  };
}
