import { isDeepStrictEqual } from "node:util";
import { fail, digest, toolManifestDigest } from "./core.mjs";
import {
  messageReplyTimesFollowInput,
  messageTimeBindingKeys,
  messageTimesMatch,
  validMessageTimeBinding,
} from "./message-binding.mjs";
import { historySeedSpec, historyRecallSpec } from "./history-scenario.mjs";

export const HISTORY_SEED_FAMILY_ID = "history-group-seed-private-recall";
const marker = /^[a-f0-9]{32}$/;
const identifier = /^[A-Za-z0-9_-]{1,128}$/;
const messageId = /^-?\d{1,20}$/;
function exactKeys(value, expected) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    isDeepStrictEqual(Object.keys(value).sort(), [...expected].sort())
  );
}
function invalid() {
  fail("HISTORY_SEED_WORKFLOW", "固定历史流程缺少两轮真实输入、来源或版本证据。", "INCONCLUSIVE");
}

function verifyStep(result, spec, config, previous) {
  const c = result?.transportCase,
    product = result?.productAcceptance,
    e = product?.cases?.[0];
  if (!marker.test(c?.token ?? "")) invalid();
  const resolve = (value) => JSON.parse(JSON.stringify(value).replaceAll("{{nonce}}", c.token));
  const prompt = `GLASSBOX_ACCEPTANCE_V1 ${c.token}\n${spec.prompt.replaceAll("{{nonce}}", c.token).trim()}`;
  const binding = c.inputBinding,
    scope = e?.scope;
  const expectedRoute =
    spec.chat === "private" ? "private" : config.groups.find((g) => g.alias === spec.chat)?.id;
  if (
    c.id !== spec.id ||
    c.status !== "PASS" ||
    c.route !== expectedRoute ||
    c.prompt !== prompt ||
    !isDeepStrictEqual(c.expected, resolve(spec.expectContains)) ||
    !isDeepStrictEqual(c.featureAssertions, resolve(spec.featureAssertions)) ||
    !isDeepStrictEqual(
      c.leasedToolNames,
      spec.leaseTools.map((t) => t.name),
    ) ||
    c.leaseRevoked !== true ||
    c.acceptanceLease?.toolsSha256 !== toolManifestDigest(resolve(spec.leaseTools)) ||
    !messageId.test(String(binding?.botMessageId ?? "")) ||
    !messageId.test(String(binding?.driverMessageId ?? "")) ||
    !exactKeys(
      binding,
      messageTimeBindingKeys(binding, [
        "botMessageId",
        "driverMessageId",
        "realSequence",
        "time",
        "textSha256",
      ]),
    ) ||
    String(c.sentMessageId) !== String(binding.driverMessageId) ||
    !/^\d{1,30}$/.test(binding.realSequence ?? "") ||
    !validMessageTimeBinding(binding) ||
    binding.textSha256 !== digest(prompt) ||
    product?.status !== "PASS" ||
    product.cases.length !== 1 ||
    e?.caseId !== c.id ||
    !identifier.test(e?.runId ?? "") ||
    e.traceVerified !== true ||
    e.feature?.status !== "PASS" ||
    e.feature.runId !== e.runId ||
    !exactKeys(e.messageBinding, ["input", "reply"]) ||
    !exactKeys(
      e.messageBinding?.input,
      messageTimeBindingKeys(e.messageBinding?.input, ["realSequence", "time", "textSha256"]),
    ) ||
    !validMessageTimeBinding(e.messageBinding?.input) ||
    !Object.hasOwn(e.messageBinding.input, "driverTime") ||
    String(e.messageBinding.input.realSequence) !== String(binding.realSequence) ||
    !messageTimesMatch(binding, e.messageBinding.input) ||
    e.messageBinding.input.textSha256 !== binding.textSha256 ||
    !exactKeys(
      e.messageBinding.reply,
      messageTimeBindingKeys(e.messageBinding.reply, [
        "botMessageId",
        "driverMessageId",
        "realSequence",
        "time",
        "textSha256",
      ]),
    ) ||
    !Object.hasOwn(e.messageBinding.reply, "driverTime") ||
    !messageId.test(String(e.messageBinding.reply.botMessageId ?? "")) ||
    !messageId.test(String(e.messageBinding.reply.driverMessageId ?? "")) ||
    !/^\d{1,30}$/.test(String(e.messageBinding.reply.realSequence ?? "")) ||
    !validMessageTimeBinding(e.messageBinding.reply) ||
    e.messageBinding.reply.time < e.messageBinding.input.time ||
    !/^[a-f0-9]{64}$/.test(e.messageBinding.reply.textSha256 ?? "") ||
    !messageReplyTimesFollowInput(e.messageBinding.input, e.messageBinding.reply) ||
    scope?.connectionId !== config.runtime?.connectionId ||
    scope.botId !== config.bot?.qq ||
    scope.senderId !== config.driver?.qq ||
    scope.chatType !== (spec.chat === "private" ? "private" : "group") ||
    scope.chatId !== (spec.chat === "private" ? config.driver.qq : expectedRoute) ||
    (scope.threadId ?? null) !== (config.runtime.threadId ?? null) ||
    product.runtime?.commit !== config.runtime.expectedCommit ||
    (previous &&
      (previous.transportCase.token === c.token ||
        previous.productAcceptance.cases[0].runId === e.runId ||
        binding.time <= previous.transportCase.inputBinding.time ||
        !isDeepStrictEqual(previous.productAcceptance.runtime, product.runtime)))
  )
    invalid();
  return { transportCase: c, productAcceptance: product };
}

/** Execute each fixed stage once. Any uncertain stage stops the family without replay. */
export async function runHistorySeedWorkflow({ config, executeStep, checkpoint, signal }) {
  if (typeof executeStep !== "function" || typeof checkpoint !== "function") invalid();
  const runStep = async (stage, spec, previous) => {
    if (signal?.aborted) fail("CANCELLED", "历史测试已停止。");
    if ((await checkpoint({ familyId: HISTORY_SEED_FAMILY_ID, stage, phase: "intent" })) === false)
      invalid();
    if (signal?.aborted) fail("CANCELLED", "历史测试已停止。");
    const verified = verifyStep(await executeStep(stage, spec), spec, config, previous);
    if (
      (await checkpoint({
        familyId: HISTORY_SEED_FAMILY_ID,
        stage,
        phase: "verified",
        runId: verified.productAcceptance.cases[0].runId,
        inputBinding: verified.transportCase.inputBinding,
      })) === false
    )
      invalid();
    return verified;
  };
  const seed = await runStep("seed", historySeedSpec(config));
  const groupId = config.groups.find((g) => g.alias === "A").id;
  const recallSpec = historyRecallSpec({
    config,
    groupId,
    seedMarker: seed.transportCase.token,
    seedRunId: seed.productAcceptance.cases[0].runId,
    seedInputTime: seed.transportCase.inputBinding.time,
  });
  const recall = await runStep("recall", recallSpec, seed);
  return {
    status: "PASS",
    familyId: HISTORY_SEED_FAMILY_ID,
    stageRunIds: [seed.productAcceptance.cases[0].runId, recall.productAcceptance.cases[0].runId],
    cleanup: { required: false, leaseRevoked: true },
  };
}
