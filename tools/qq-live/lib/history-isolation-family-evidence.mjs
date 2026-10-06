import { fail, digest, toolManifestDigest } from "./core.mjs";
import {
  messageReplyTimesFollowInput,
  messageTimeBindingKeys,
  messageTimesMatch,
  validMessageTimeBinding,
} from "./message-binding.mjs";
import { historyExclusionSpec, historyIsolationSeedSpec } from "./history-isolation-scenario.mjs";

export const HISTORY_ISOLATION_FAMILY_ID = "history-cross-group-isolation";

const RUN_ID = /^[A-Za-z0-9_-]{1,128}$/;
const MARKER = /^[a-f0-9]{32}$/;
const HASH = /^[a-f0-9]{64}$/;
const COMMIT = /^[a-f0-9]{40}$/;
const MESSAGE_ID = /^-?\d{1,20}$/;
const LEASE_ID = /^[a-f0-9-]{36}$/i;
const SENTINEL = /^qq-isolation-secret-[a-f0-9]{32}$/;

function invalid(message = "History isolation family evidence is incomplete or inconsistent.") {
  fail("HISTORY_ISOLATION_FAMILY_EVIDENCE", message, "INCONCLUSIVE");
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
  if (!MARKER.test(token ?? "")) invalid("History isolation marker is invalid.");
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
    !MESSAGE_ID.test(String(replies[0]?.messageId ?? "")) ||
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
    invalid(`History isolation case ${spec.id} transport, lease, or QQ binding is invalid.`);
  return { expected, binding, reply: replies[0] };
}

function expectedObservations(assertions, stage) {
  return assertions.map((assertion) => {
    if (assertion.kind === "trace")
      return { kind: "trace", type: assertion.type, count: assertion.count };
    if (assertion.kind === "history_coverage")
      return {
        kind: "history_coverage",
        coverage: "complete",
        returned: stage === "seed" ? 1 : 0,
        sourceComplete: true,
      };
    if (assertion.kind === "history_result")
      return {
        kind: "history_result",
        result: "hit",
        returned: 1,
        sourceVerified: true,
        toolOutputVerified: true,
      };
    if (assertion.kind === "history_exclusion_result")
      return {
        kind: "history_exclusion_result",
        result: "no_match",
        returned: 0,
        sourceVerified: true,
        exclusionVerified: true,
        toolOutputVerified: true,
      };
    invalid("History isolation case contains an unsupported feature assertion.");
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
  const scope = scopeFor(evidence?.scope, runtime, config, stage, groupId);
  const runId = evidence?.runId;
  const scopeKey = JSON.stringify([
    scope.connectionId,
    scope.botId,
    scope.chatType,
    scope.chatId,
    scope.senderId,
    scope.threadId ?? null,
  ]);
  const feature = evidence?.feature;
  const expected = expectedObservations(transport.expected.featureAssertions, stage);
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
    !exactKeys(input, messageTimeBindingKeys(input, ["realSequence", "time", "textSha256"])) ||
    !validMessageTimeBinding(input) ||
    String(input.realSequence) !== String(transport.binding.realSequence) ||
    !messageTimesMatch(transport.binding, input) ||
    input.textSha256 !== transport.binding.textSha256 ||
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
    !MESSAGE_ID.test(String(reply.botMessageId ?? "")) ||
    String(reply.botMessageId) !== String(delivery.external_id) ||
    !MESSAGE_ID.test(String(reply.driverMessageId ?? "")) ||
    String(reply.driverMessageId) !== String(transport.reply.messageId) ||
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
  return { runId, scope };
}

/** Independently verify the fixed B-seed and Owner-private A-exclusion acceptance report. */
export async function verifyHistoryIsolationFamilyReport(report, { config, verifyProduct } = {}) {
  if (typeof verifyProduct !== "function")
    invalid("History isolation family requires fresh product verification.");
  if (
    !record(report) ||
    !record(config) ||
    !Array.isArray(report.cases) ||
    report.cases.length !== 2 ||
    !exactKeys(report.historyFamily, ["caseId"]) ||
    !same(report.historyFamily, { caseId: HISTORY_ISOLATION_FAMILY_ID }) ||
    !exactKeys(report.historyIsolationWorkflow, ["status", "familyId", "stageRunIds", "cleanup"]) ||
    report.historyIsolationWorkflow.status !== "PASS" ||
    report.historyIsolationWorkflow.familyId !== HISTORY_ISOLATION_FAMILY_ID ||
    !Array.isArray(report.historyIsolationWorkflow.stageRunIds) ||
    report.historyIsolationWorkflow.stageRunIds.length !== 2 ||
    !exactKeys(report.historyIsolationWorkflow.cleanup, ["required", "leaseRevoked"]) ||
    report.historyIsolationWorkflow.cleanup.required !== false ||
    report.historyIsolationWorkflow.cleanup.leaseRevoked !== true ||
    report.status !== "PASS" ||
    report.mode !== "run"
  )
    invalid("Report does not contain exactly the fixed cross-group isolation family.");

  const [seedCase, exclusionCase] = report.cases;
  if (
    seedCase?.id !== "history-cross-group-seed" ||
    exclusionCase?.id !== "history-cross-group-private-exclusion"
  )
    invalid("History isolation cases are missing, reordered, or unexpected.");
  if (!validRuntime(report.runtime)) invalid("Report runtime identity is invalid.");
  if (
    report.runtime.commit !== config.runtime?.expectedCommit ||
    report.runtime.connectionId !== config.runtime?.connectionId ||
    report.runtime.threadId !== (config.runtime?.threadId ?? null)
  )
    invalid("Report runtime does not match the configured clean acceptance checkout.");

  const matches = seedCase.prompt?.match(/qq-isolation-secret-[a-f0-9]{32}/g) ?? [];
  if (matches.length !== 1 || !SENTINEL.test(matches[0]))
    invalid("Seed prompt must contain exactly one fixed isolation sentinel.");
  const sentinel = matches[0];
  const seedRunId = report.historyIsolationWorkflow.stageRunIds[0];
  const exclusionRunId = report.historyIsolationWorkflow.stageRunIds[1];
  if (
    !RUN_ID.test(seedRunId ?? "") ||
    !RUN_ID.test(exclusionRunId ?? "") ||
    seedRunId === exclusionRunId
  )
    invalid("History isolation Run identities are invalid or duplicated.");

  let seedSpec;
  let exclusionSpec;
  let groupB;
  try {
    seedSpec = historyIsolationSeedSpec({ config, sentinel });
    groupB = config.groups.find((group) => group.alias === "B").id;
    exclusionSpec = historyExclusionSpec({
      config,
      sourceGroupId: groupB,
      seedMarker: seedCase.token,
      sentinel,
      sourceRunId: seedRunId,
      seedInputTime: seedCase.inputBinding?.time,
    });
  } catch {
    invalid("History isolation specs cannot be derived from the seed input evidence.");
  }
  const seedTransport = validateTransportCase(seedCase, seedSpec, groupB);
  const exclusionTransport = validateTransportCase(exclusionCase, exclusionSpec, "private");
  if (
    seedCase.token === exclusionCase.token ||
    seedCase.token === sentinel.slice("qq-isolation-secret-".length) ||
    exclusionTransport.binding.time <= seedTransport.binding.time
  )
    invalid("History isolation markers and QQ input times must be distinct and ordered.");

  let fresh;
  try {
    fresh = await verifyProduct(report);
  } catch {
    invalid("Fresh product verification failed for the history isolation family.");
  }
  if (
    !record(fresh) ||
    fresh.status !== "PASS" ||
    !validRuntime(fresh.runtime) ||
    !same(fresh.runtime, report.runtime) ||
    !Array.isArray(fresh.cases) ||
    fresh.cases.length !== 2
  )
    invalid("Fresh product verification did not pass the exact two isolation cases.");

  const seedEvidence = validateFreshCase(
    fresh.cases[0],
    seedCase,
    seedSpec,
    seedTransport,
    fresh.runtime,
    config,
    "seed",
    groupB,
  );
  const exclusionEvidence = validateFreshCase(
    fresh.cases[1],
    exclusionCase,
    exclusionSpec,
    exclusionTransport,
    fresh.runtime,
    config,
    "exclusion",
    groupB,
  );
  if (
    seedEvidence.runId !== seedRunId ||
    exclusionEvidence.runId !== exclusionRunId ||
    seedEvidence.scope.connectionId !== exclusionEvidence.scope.connectionId ||
    seedEvidence.scope.botId !== exclusionEvidence.scope.botId ||
    seedEvidence.scope.senderId !== exclusionEvidence.scope.senderId
  )
    invalid("Fresh product evidence does not match the recorded B seed and A exclusion Runs.");

  return {
    status: "PASS",
    caseId: HISTORY_ISOLATION_FAMILY_ID,
    runtime: fresh.runtime,
    stageRunIds: [seedRunId, exclusionRunId],
    cleanup: { required: false, leaseRevoked: true },
  };
}
