import { randomBytes } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { fail, digest, toolManifestDigest } from "./core.mjs";
import { historyExclusionSpec, historyIsolationSeedSpec } from "./history-isolation-scenario.mjs";

export const HISTORY_ISOLATION_FAMILY_ID = "history-cross-group-isolation";

const MARKER = /^[a-f0-9]{32}$/;
const RUN_ID = /^[A-Za-z0-9_-]{1,128}$/;
const MESSAGE_ID = /^-?\d{1,20}$/;
const LEASE_ID = /^[a-f0-9-]{36}$/i;
const HASH = /^[a-f0-9]{64}$/;

function invalid() {
  fail(
    "HISTORY_ISOLATION_WORKFLOW",
    "固定跨群隔离流程缺少两轮真实输入、来源或版本证据。",
    "INCONCLUSIVE",
  );
}

function exactKeys(value, keys) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    isDeepStrictEqual(
      Object.keys(value).sort(),
      [...keys].sort((a, b) => a.localeCompare(b)),
    )
  );
}

function observationsFor(assertions, chat) {
  return assertions.map((assertion) => {
    if (assertion.kind === "trace")
      return { kind: "trace", type: assertion.type, count: assertion.count };
    if (assertion.kind === "history_coverage")
      return {
        kind: "history_coverage",
        coverage: "complete",
        returned: chat === "B" ? 1 : 0,
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
    invalid();
  });
}

function validRuntime(runtime, config) {
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
    typeof runtime.commit === "string" &&
    /^[a-f0-9]{40}$/.test(runtime.commit) &&
    runtime.commit === config.runtime?.expectedCommit &&
    Number.isSafeInteger(runtime.pid) &&
    runtime.pid > 0 &&
    runtime.connectionId === config.runtime?.connectionId &&
    (runtime.threadId ?? null) === (config.runtime?.threadId ?? null)
  );
}

function verifyStep(result, spec, config, previous, sentinel) {
  const c = result?.transportCase;
  const product = result?.productAcceptance;
  const e = product?.cases?.[0];
  if (typeof c?.token !== "string" || !MARKER.test(c.token)) invalid();
  const resolved = (value) => JSON.parse(JSON.stringify(value).replaceAll("{{nonce}}", c.token));
  const prompt = `GLASSBOX_ACCEPTANCE_V1 ${c.token}\n${spec.prompt.replaceAll("{{nonce}}", c.token).trim()}`;
  const binding = c.inputBinding;
  const scope = e?.scope;
  const expectedRoute =
    spec.chat === "private"
      ? "private"
      : config.groups.find((group) => group.alias === spec.chat)?.id;
  const lease = c.acceptanceLease;
  const driverMessageId = binding?.driverMessageId;
  const botMessageId = binding?.botMessageId;
  const startedAt = typeof c.startedAt === "string" ? Date.parse(c.startedAt) : Number.NaN;
  if (
    c.id !== spec.id ||
    c.status !== "PASS" ||
    c.route !== expectedRoute ||
    c.prompt !== prompt ||
    !isDeepStrictEqual(c.expected, resolved(spec.expectContains)) ||
    !isDeepStrictEqual(c.featureAssertions, resolved(spec.featureAssertions)) ||
    !isDeepStrictEqual(
      c.leasedToolNames,
      spec.leaseTools.map((tool) => tool.name),
    ) ||
    c.leaseRevoked !== true ||
    !exactKeys(lease, ["leaseId", "expiresAt", "toolsSha256"]) ||
    typeof lease.leaseId !== "string" ||
    !LEASE_ID.test(lease.leaseId) ||
    !Number.isSafeInteger(lease.expiresAt) ||
    !Number.isFinite(startedAt) ||
    new Date(startedAt).toISOString() !== c.startedAt ||
    lease.expiresAt <= startedAt ||
    typeof lease.toolsSha256 !== "string" ||
    lease.toolsSha256 !== toolManifestDigest(resolved(spec.leaseTools)) ||
    !Array.isArray(c.anomalies) ||
    c.anomalies.length !== 0 ||
    !exactKeys(binding, [
      "driverMessageId",
      "botMessageId",
      "realSequence",
      "time",
      "textSha256",
    ]) ||
    typeof driverMessageId !== "string" ||
    !MESSAGE_ID.test(driverMessageId) ||
    typeof botMessageId !== "string" ||
    !MESSAGE_ID.test(botMessageId) ||
    typeof c.sentMessageId !== "string" ||
    c.sentMessageId !== driverMessageId ||
    typeof binding.realSequence !== "string" ||
    !/^\d{1,30}$/.test(binding.realSequence) ||
    !Number.isSafeInteger(binding.time) ||
    binding.time <= 0 ||
    typeof binding.textSha256 !== "string" ||
    binding.textSha256 !== digest(prompt) ||
    (spec.chat === "B" && !prompt.includes(sentinel)) ||
    (spec.chat === "private" && prompt.includes(sentinel)) ||
    product?.status !== "PASS" ||
    !Array.isArray(product.cases) ||
    product.cases.length !== 1 ||
    !validRuntime(product.runtime, config) ||
    e?.caseId !== c.id ||
    typeof e.runId !== "string" ||
    !RUN_ID.test(e.runId) ||
    e.traceVerified !== true ||
    e.feature?.status !== "PASS" ||
    e.feature.runId !== e.runId ||
    !isDeepStrictEqual(e.feature.observations, observationsFor(c.featureAssertions, spec.chat)) ||
    !Array.isArray(c.replies) ||
    c.replies.length !== 1 ||
    c.replies[0]?.route !== expectedRoute ||
    c.replies[0]?.matches !== true ||
    typeof c.replies[0]?.messageId !== "string" ||
    !MESSAGE_ID.test(c.replies[0].messageId) ||
    typeof c.replies[0]?.textSha256 !== "string" ||
    !HASH.test(c.replies[0].textSha256) ||
    e.delivery?.status !== "sent" ||
    typeof e.delivery.external_id !== "string" ||
    !MESSAGE_ID.test(e.delivery.external_id) ||
    !exactKeys(e.messageBinding, ["input", "reply"]) ||
    !isDeepStrictEqual(e.messageBinding.input, {
      realSequence: binding.realSequence,
      time: binding.time,
      textSha256: binding.textSha256,
    }) ||
    !exactKeys(e.messageBinding.reply, [
      "botMessageId",
      "driverMessageId",
      "realSequence",
      "time",
      "textSha256",
    ]) ||
    typeof e.messageBinding.reply.botMessageId !== "string" ||
    !MESSAGE_ID.test(e.messageBinding.reply.botMessageId) ||
    typeof e.messageBinding.reply.driverMessageId !== "string" ||
    !MESSAGE_ID.test(e.messageBinding.reply.driverMessageId) ||
    typeof e.messageBinding.reply.realSequence !== "string" ||
    !/^\d{1,30}$/.test(e.messageBinding.reply.realSequence) ||
    !Number.isSafeInteger(e.messageBinding.reply.time) ||
    typeof e.messageBinding.reply.textSha256 !== "string" ||
    !HASH.test(e.messageBinding.reply.textSha256) ||
    e.messageBinding.reply.botMessageId !== String(e.delivery.external_id) ||
    e.messageBinding.reply.driverMessageId !== c.replies[0].messageId ||
    e.messageBinding.reply.textSha256 !== c.replies[0].textSha256 ||
    !exactKeys(scope, ["connectionId", "botId", "chatType", "chatId", "senderId", "threadId"]) ||
    scope.connectionId !== config.runtime?.connectionId ||
    scope.botId !== config.bot?.qq ||
    scope.senderId !== config.driver?.qq ||
    scope.chatType !== (spec.chat === "private" ? "private" : "group") ||
    scope.chatId !== (spec.chat === "private" ? config.driver.qq : expectedRoute) ||
    (scope.threadId ?? null) !== (config.runtime.threadId ?? null) ||
    (previous &&
      (previous.transportCase.token === c.token ||
        previous.productAcceptance.cases[0].runId === e.runId ||
        binding.time <= previous.transportCase.inputBinding.time ||
        !isDeepStrictEqual(previous.productAcceptance.runtime, product.runtime)))
  )
    invalid();
  return { transportCase: c, productAcceptance: product };
}

/** Execute B seed then Owner-private A exclusion. An uncertain stage is never replayed. */
export async function runHistoryIsolationWorkflow({ config, executeStep, checkpoint, signal }) {
  if (typeof executeStep !== "function" || typeof checkpoint !== "function") invalid();
  const groups = config?.groups;
  const groupA = Array.isArray(groups) ? groups.filter((group) => group?.alias === "A") : [];
  const groupB = Array.isArray(groups) ? groups.filter((group) => group?.alias === "B") : [];
  if (
    !Array.isArray(groups) ||
    groupA.length !== 1 ||
    groupB.length !== 1 ||
    typeof groupA[0]?.id !== "string" ||
    !/^[1-9]\d{0,15}$/.test(groupA[0].id) ||
    typeof groupB[0]?.id !== "string" ||
    !/^[1-9]\d{0,15}$/.test(groupB[0].id) ||
    groupA[0].id === groupB[0].id ||
    typeof config?.bot?.qq !== "string" ||
    !/^[1-9]\d{0,15}$/.test(config.bot.qq) ||
    typeof config?.driver?.qq !== "string" ||
    !/^[1-9]\d{0,15}$/.test(config.driver.qq) ||
    typeof config?.runtime?.expectedCommit !== "string" ||
    !/^[a-f0-9]{40}$/.test(config.runtime.expectedCommit) ||
    typeof config?.runtime?.connectionId !== "string" ||
    !config.runtime.connectionId ||
    (config.runtime.threadId !== undefined &&
      config.runtime.threadId !== null &&
      typeof config.runtime.threadId !== "string")
  )
    invalid();
  const sentinel = `qq-isolation-secret-${randomBytes(16).toString("hex")}`;
  const runStep = async (stage, spec, previous) => {
    if (signal?.aborted) fail("CANCELLED", "跨群隔离测试已停止。");
    if (
      (await checkpoint({ familyId: HISTORY_ISOLATION_FAMILY_ID, stage, phase: "intent" })) ===
      false
    )
      invalid();
    if (signal?.aborted) fail("CANCELLED", "跨群隔离测试已停止。");
    const result = await executeStep(stage, spec);
    if (signal?.aborted) fail("CANCELLED", "跨群隔离测试已停止。");
    const verified = verifyStep(result, spec, config, previous, sentinel);
    if (
      (await checkpoint({
        familyId: HISTORY_ISOLATION_FAMILY_ID,
        stage,
        phase: "verified",
        runId: verified.productAcceptance.cases[0].runId,
        inputBinding: verified.transportCase.inputBinding,
      })) === false
    )
      invalid();
    if (signal?.aborted) fail("CANCELLED", "跨群隔离测试已停止。");
    return verified;
  };

  const seedSpec = historyIsolationSeedSpec({ config, sentinel });
  const seed = await runStep("seed", seedSpec);
  const seedRunId = seed.productAcceptance.cases[0].runId;
  const exclusionSpec = historyExclusionSpec({
    config,
    sourceGroupId: config.groups.find((group) => group.alias === "B").id,
    seedMarker: seed.transportCase.token,
    sentinel,
    sourceRunId: seedRunId,
    seedInputTime: seed.transportCase.inputBinding.time,
  });
  const exclusion = await runStep("exclusion", exclusionSpec, seed);
  return {
    status: "PASS",
    familyId: HISTORY_ISOLATION_FAMILY_ID,
    stageRunIds: [seedRunId, exclusion.productAcceptance.cases[0].runId],
    cleanup: { required: false, leaseRevoked: true },
  };
}
