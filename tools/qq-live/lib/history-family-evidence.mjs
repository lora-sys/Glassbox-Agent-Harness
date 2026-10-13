import { fail, digest, toolManifestDigest } from "./core.mjs";
import {
  messageReplyTimesFollowInput,
  messageTimeBindingKeys,
  messageTimesMatch,
  validMessageTimeBinding,
} from "./message-binding.mjs";
import { historySeedSpec, historyRecallSpec } from "./history-scenario.mjs";

export const HISTORY_FAMILY_ID = "history-group-seed-private-recall";

const RUN_ID = /^[A-Za-z0-9_-]{1,128}$/;
const MARKER = /^[a-f0-9]{32}$/;
const HASH = /^[a-f0-9]{64}$/;
const COMMIT = /^[a-f0-9]{40}$/;
const MESSAGE_ID = /^-?\d{1,20}$/;
const LEASE_ID = /^[a-f0-9-]{36}$/i;

function invalid(message = "History family evidence is incomplete or inconsistent.") {
  fail("HISTORY_FAMILY_EVIDENCE", message, "INCONCLUSIVE");
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
    COMMIT.test(runtime.commit ?? "") &&
    Number.isSafeInteger(runtime.pid) &&
    runtime.pid > 0 &&
    typeof runtime.connectionId === "string" &&
    runtime.connectionId.length > 0 &&
    (runtime.threadId === null ||
      runtime.threadId === undefined ||
      (typeof runtime.threadId === "string" && runtime.threadId.length > 0))
  );
}

function expectedCase(spec, token, route) {
  if (!MARKER.test(token ?? "")) invalid("History case marker is invalid.");
  const replace = (value) => JSON.parse(JSON.stringify(value).replaceAll("{{nonce}}", token));
  const leaseTools = replace(spec.leaseTools);
  return {
    prompt: `GLASSBOX_ACCEPTANCE_V1 ${token}\n${spec.prompt.replaceAll("{{nonce}}", token).trim()}`,
    expected: replace(spec.expectContains),
    featureAssertions: replace(spec.featureAssertions),
    leaseTools,
    toolNames: leaseTools.map((tool) => tool.name),
    toolsSha256: toolManifestDigest(leaseTools),
    route,
  };
}

function validateTransportCase(c, spec, route) {
  const expected = expectedCase(spec, c?.token, route);
  const binding = c?.inputBinding;
  const lease = c?.acceptanceLease;
  const replies = c?.replies;
  if (
    c?.id !== spec.id ||
    c.status !== "PASS" ||
    c.route !== route ||
    c.prompt !== expected.prompt ||
    !same(c.expected, expected.expected) ||
    !same(c.featureAssertions, expected.featureAssertions) ||
    !same(c.leasedToolNames, expected.toolNames) ||
    c.leaseRevoked !== true ||
    !exactKeys(lease, ["leaseId", "expiresAt", "toolsSha256"]) ||
    !LEASE_ID.test(lease.leaseId ?? "") ||
    !Number.isSafeInteger(lease.expiresAt) ||
    !Number.isFinite(Date.parse(c.startedAt)) ||
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
    binding.textSha256 !== digest(expected.prompt) ||
    !Array.isArray(replies) ||
    replies.length !== 1 ||
    replies[0]?.route !== route ||
    replies[0]?.matches !== true ||
    !HASH.test(replies[0]?.textSha256 ?? "") ||
    !Number.isSafeInteger(replies[0]?.textBytes) ||
    replies[0].textBytes <= 0 ||
    typeof replies[0]?.receivedAt !== "string" ||
    !Number.isFinite(Date.parse(replies[0].receivedAt)) ||
    new Date(replies[0].receivedAt).toISOString() !== replies[0].receivedAt ||
    Date.parse(replies[0].receivedAt) < Date.parse(c.startedAt) ||
    !Array.isArray(c.anomalies) ||
    c.anomalies.length !== 0
  )
    invalid(`History case ${spec.id} transport, lease, or input binding is invalid.`);
  return { expected, binding, reply: replies[0] };
}

function expectedObservations(assertions) {
  return assertions.map((assertion) => {
    if (assertion.kind === "trace")
      return { kind: "trace", type: assertion.type, count: assertion.count };
    if (assertion.kind === "history_coverage")
      return { kind: "history_coverage", coverage: "complete", returned: 1, sourceComplete: true };
    if (assertion.kind === "history_result")
      return {
        kind: "history_result",
        result: "hit",
        returned: 1,
        sourceVerified: true,
        toolOutputVerified: true,
      };
    if (assertion.kind === "history_seed_result")
      return {
        kind: "history_seed_result",
        result: "hit",
        returned: 1,
        sourceVerified: true,
        toolOutputVerified: true,
        distinctEarlierInput: true,
      };
    invalid("History case contains an unsupported feature assertion.");
  });
}

function scopeFor(scope, runtime, config, stage, groupId) {
  const driverId = String(config?.driver?.qq ?? "");
  const botId = String(config?.bot?.qq ?? "");
  if (
    !exactKeys(scope, ["connectionId", "botId", "chatType", "chatId", "senderId", "threadId"]) ||
    scope.connectionId !== runtime.connectionId ||
    scope.botId !== botId ||
    scope.senderId !== driverId ||
    (scope.threadId ?? null) !== (runtime.threadId ?? null) ||
    (stage === "seed"
      ? scope.chatType !== "group" || scope.chatId !== groupId
      : scope.chatType !== "private" || scope.chatId !== driverId)
  )
    invalid(`Fresh ${stage} product evidence does not match the configured QQ scope.`);
  return scope;
}

function validateFreshCase(evidence, c, spec, transport, runtime, config, stage, groupId) {
  const expectedScope = scopeFor(evidence?.scope, runtime, config, stage, groupId);
  const runId = evidence?.runId;
  const scopeKey = JSON.stringify([
    expectedScope.connectionId,
    expectedScope.botId,
    expectedScope.chatType,
    expectedScope.chatId,
    expectedScope.senderId,
    expectedScope.threadId ?? null,
  ]);
  const feature = evidence?.feature;
  const expected = expectedObservations(transport.expected.featureAssertions);
  const delivery = evidence?.delivery;
  const binding = evidence?.messageBinding;
  const input = binding?.input;
  const reply = binding?.reply;
  if (
    evidence.caseId !== spec.id ||
    !RUN_ID.test(runId ?? "") ||
    evidence.traceVerified !== true ||
    feature?.status !== "PASS" ||
    feature.runId !== runId ||
    !same(feature.observations, expected) ||
    !delivery ||
    delivery.status !== "sent" ||
    delivery.destination_scope_key !== scopeKey ||
    !MESSAGE_ID.test(String(delivery.external_id ?? "")) ||
    String(delivery.external_id) !== String(reply?.botMessageId) ||
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
    reply.time < input.time ||
    reply.time <= 0 ||
    reply.textSha256 !== transport.reply.textSha256
  )
    invalid(`Fresh product evidence for ${spec.id} does not match its fixed transport case.`);
  return { runId, scope: expectedScope };
}

/** Independently verify the fixed group-seed and private-recall acceptance report. */
export async function verifyHistoryFamilyReport(report, { config, verifyProduct } = {}) {
  if (typeof verifyProduct !== "function")
    invalid("History family requires fresh product verification.");
  if (
    !record(report) ||
    !record(config) ||
    !Array.isArray(report.cases) ||
    report.cases.length !== 2 ||
    !exactKeys(report.historyFamily, ["caseId"]) ||
    !same(report.historyFamily, { caseId: HISTORY_FAMILY_ID }) ||
    !exactKeys(report.historySeedWorkflow, ["status", "familyId", "stageRunIds", "cleanup"]) ||
    report.historySeedWorkflow.status !== "PASS" ||
    report.historySeedWorkflow.familyId !== HISTORY_FAMILY_ID ||
    !Array.isArray(report.historySeedWorkflow.stageRunIds) ||
    report.historySeedWorkflow.stageRunIds.length !== 2 ||
    !exactKeys(report.historySeedWorkflow.cleanup, ["required", "leaseRevoked"]) ||
    report.historySeedWorkflow.cleanup.required !== false ||
    report.historySeedWorkflow.cleanup.leaseRevoked !== true ||
    report.status !== "PASS" ||
    report.mode !== "run"
  )
    invalid("Report does not contain exactly the fixed history family.");

  const [seedCase, recallCase] = report.cases;
  if (seedCase?.id !== "history-current-group-hit" || recallCase?.id !== "history-seed-recall")
    invalid("History family cases are missing, reordered, or unexpected.");
  if (!validRuntime(report.runtime)) invalid("Report runtime identity is invalid.");

  let groupId;
  let seedSpec;
  try {
    seedSpec = historySeedSpec(config);
    groupId = config.groups.find((group) => group.alias === "A").id;
  } catch {
    invalid("Configured history group A is invalid.");
  }
  const seedTransport = validateTransportCase(seedCase, seedSpec, groupId);
  const seedRunId = report.historySeedWorkflow.stageRunIds[0];
  if (!RUN_ID.test(seedRunId ?? "")) invalid("Seed Run identity is invalid.");
  let recallSpec;
  try {
    recallSpec = historyRecallSpec({
      config,
      groupId,
      seedInputTime: seedTransport.binding.time,
      seedMarker: seedCase.token,
      seedRunId,
    });
  } catch {
    invalid("Recall specification cannot be derived from the seed input binding.");
  }
  const recallTransport = validateTransportCase(recallCase, recallSpec, "private");
  const recallRunId = report.historySeedWorkflow.stageRunIds[1];
  if (
    !RUN_ID.test(recallRunId ?? "") ||
    seedRunId === recallRunId ||
    seedCase.token === recallCase.token ||
    recallTransport.binding.time <= seedTransport.binding.time
  )
    invalid("History seed and recall must be distinct Runs, markers, and ordered inputs.");

  let fresh;
  try {
    fresh = await verifyProduct(report);
  } catch {
    invalid("Fresh product verification failed for the history family.");
  }
  if (
    !record(fresh) ||
    fresh.status !== "PASS" ||
    !validRuntime(fresh.runtime) ||
    !same(fresh.runtime, report.runtime) ||
    !Array.isArray(fresh.cases) ||
    fresh.cases.length !== 2
  )
    invalid("Fresh product verification did not pass the exact two history cases.");

  const seedEvidence = validateFreshCase(
    fresh.cases[0],
    seedCase,
    seedSpec,
    seedTransport,
    fresh.runtime,
    config,
    "seed",
    groupId,
  );
  const recallEvidence = validateFreshCase(
    fresh.cases[1],
    recallCase,
    recallSpec,
    recallTransport,
    fresh.runtime,
    config,
    "recall",
    groupId,
  );
  if (
    seedEvidence.runId !== seedRunId ||
    recallEvidence.runId !== recallRunId ||
    seedEvidence.scope.connectionId !== recallEvidence.scope.connectionId ||
    seedEvidence.scope.botId !== recallEvidence.scope.botId ||
    seedEvidence.scope.senderId !== recallEvidence.scope.senderId
  )
    invalid("Fresh product evidence does not match the recorded seed and recall Runs.");

  return {
    status: "PASS",
    caseId: HISTORY_FAMILY_ID,
    runtime: fresh.runtime,
    stageRunIds: [seedRunId, recallRunId],
    cleanup: { required: false, leaseRevoked: true },
  };
}
