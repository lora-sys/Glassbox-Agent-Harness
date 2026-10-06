import { fail, digest, toolManifestDigest } from "./core.mjs";
import {
  messageReplyTimesFollowInput,
  messageTimeBindingKeys,
  messageTimesMatch,
  validMessageTimeBinding,
} from "./message-binding.mjs";
import { tasteFixtureStep, TASTE_FAMILY_ID } from "./taste-scenario.mjs";

const STAGES = ["feedback", "promote", "negative-feedback", "retire"];
const NONCE = /^[a-f0-9]{32}$/;
const RUN = /^[A-Za-z0-9_-]{1,128}$/;
const HASH = /^[a-f0-9]{64}$/;
const CANDIDATE = /^candidate_[a-f0-9]{32}$/;
const MEMORY = /^memory_[a-f0-9]{32}$/;

function invalid(message) {
  fail("TASTE_FAMILY_EVIDENCE", message, "INCONCLUSIVE");
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

function same(left, right) {
  return canonical(left) === canonical(right);
}

function exactKeys(value, expected) {
  return (
    record(value) &&
    same(
      Object.keys(value).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
      [...expected].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
    )
  );
}

function fixedCase(stage, handles, c) {
  if (!NONCE.test(c?.token ?? "")) invalid("Taste case marker is invalid.");
  const spec = tasteFixtureStep(stage, {
    nonce: handles.fixtureNonce,
    candidateId: handles.candidateId,
    memoryId: handles.memoryId,
    correctionCandidateId: handles.correctionCandidateId,
  });
  const replace = (value) => JSON.parse(JSON.stringify(value).replaceAll("{{nonce}}", c.token));
  const leaseTools = replace(spec.leaseTools);
  const expectedPrompt = `GLASSBOX_ACCEPTANCE_V1 ${c.token}\n${spec.prompt
    .replaceAll("{{nonce}}", c.token)
    .trim()}`;
  const binding = c.inputBinding;
  const lease = c.acceptanceLease;
  const replies = c.replies;
  if (
    c.id !== spec.id ||
    c.status !== "PASS" ||
    c.route !== "private" ||
    c.inputObserved !== true ||
    String(c.sentMessageId) !== String(binding?.driverMessageId) ||
    String(c.botInputMessageId) !== String(binding?.botMessageId) ||
    c.prompt !== expectedPrompt ||
    !same(c.expected, replace(spec.expectContains)) ||
    !same(c.featureAssertions, replace(spec.featureAssertions)) ||
    !same(
      c.leasedToolNames,
      leaseTools.map((tool) => tool.name),
    ) ||
    c.leaseRevoked !== true ||
    !exactKeys(lease, ["leaseId", "expiresAt", "toolsSha256"]) ||
    !/^[a-f0-9-]{36}$/i.test(lease.leaseId ?? "") ||
    !Number.isSafeInteger(lease.expiresAt) ||
    !Number.isFinite(Date.parse(c.startedAt)) ||
    lease.expiresAt <= Date.parse(c.startedAt) ||
    !HASH.test(lease.toolsSha256 ?? "") ||
    lease.toolsSha256 !== toolManifestDigest(leaseTools) ||
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
    !/^-?\d{1,20}$/.test(String(binding.driverMessageId ?? "")) ||
    !/^-?\d{1,20}$/.test(String(binding.botMessageId ?? "")) ||
    !/^\d{1,30}$/.test(String(binding.realSequence ?? "")) ||
    !validMessageTimeBinding(binding) ||
    binding.textSha256 !== digest(expectedPrompt) ||
    !Array.isArray(replies) ||
    replies.length !== 1 ||
    replies[0]?.route !== "private" ||
    replies[0]?.matches !== true ||
    !/^-?\d{1,20}$/.test(String(replies[0]?.messageId ?? "")) ||
    !HASH.test(replies[0]?.textSha256 ?? "") ||
    !Array.isArray(c.anomalies) ||
    c.anomalies.length !== 0
  )
    invalid(`Taste case ${stage} does not match its fixed input and lease contract.`);
  return { binding, reply: replies[0], expectedPrompt };
}

function validateRuntime(runtime) {
  if (
    !record(runtime) ||
    typeof runtime.checkout !== "string" ||
    !runtime.checkout ||
    typeof runtime.dataDirectory !== "string" ||
    !runtime.dataDirectory ||
    !/^[a-f0-9]{40}$/.test(runtime.commit ?? "") ||
    !Number.isSafeInteger(runtime.pid) ||
    runtime.pid <= 0 ||
    typeof runtime.connectionId !== "string" ||
    !runtime.connectionId
  )
    invalid("Taste family Runtime identity is incomplete.");
}

/** Recheck every stage's product proof and independently reread the full final fixture. */
export async function verifyTasteFamilyReport(
  report,
  { config, verifyProduct, readFixture, readRuntime } = {},
) {
  if (
    !config?.runtime ||
    typeof config.driver?.qq !== "string" ||
    !config.driver.qq ||
    typeof config.bot?.qq !== "string" ||
    !config.bot.qq ||
    typeof verifyProduct !== "function" ||
    typeof readFixture !== "function" ||
    typeof readRuntime !== "function"
  )
    invalid("Taste family requires account-bound product and independent database verifiers.");
  const lifecycle = report?.tasteLifecycle;
  const handles = lifecycle?.handles;
  const nonce = handles?.fixtureNonce;
  if (
    report?.mode !== "run" ||
    report.status !== "PASS" ||
    report.cleanupOnly === true ||
    report?.productAcceptance?.status !== "PASS" ||
    !same(report.tasteFamily, { familyId: TASTE_FAMILY_ID }) ||
    lifecycle?.status !== "PASS" ||
    lifecycle.requiresReconciliation !== false ||
    !record(handles) ||
    !NONCE.test(nonce ?? "") ||
    handles.projectId !== `qqtest-${nonce}` ||
    !RUN.test(handles.principalId ?? "") ||
    !CANDIDATE.test(handles.candidateId ?? "") ||
    !MEMORY.test(handles.memoryId ?? "") ||
    !CANDIDATE.test(handles.correctionCandidateId ?? "") ||
    !RUN.test(handles.creationRunId ?? "") ||
    !RUN.test(handles.promotionRunId ?? "") ||
    !RUN.test(handles.negativeRunId ?? "") ||
    !RUN.test(handles.cleanupRunId ?? "") ||
    handles.stepRunId !== handles.cleanupRunId ||
    !Array.isArray(report.cases) ||
    report.cases.length !== STAGES.length ||
    !Array.isArray(lifecycle.steps) ||
    lifecycle.steps.length !== STAGES.length
  )
    invalid("Report does not describe the complete fixed Taste lifecycle.");

  validateRuntime(report.runtime);
  if (!same(await readRuntime(), report.runtime))
    invalid("Taste family Runtime changed before final verification.");
  const stageRuns = [];
  let stableScope;
  for (let index = 0; index < STAGES.length; index++) {
    const stage = STAGES[index];
    const transport = report.cases[index];
    const step = lifecycle.steps[index];
    const fixed = fixedCase(stage, handles, transport);
    if (
      step?.stage !== stage ||
      !RUN.test(step.runId ?? "") ||
      !same(step.transportCase, transport) ||
      step.productAcceptance?.status !== "PASS" ||
      !same(step.productAcceptance.runtime, report.runtime) ||
      step.productAcceptance.cases?.length !== 1 ||
      step.productAcceptance.cases[0]?.caseId !== transport.id ||
      step.productAcceptance.cases[0]?.runId !== step.runId ||
      step.productAcceptance.cases[0]?.traceVerified !== true ||
      step.productAcceptance.cases[0]?.feature?.status !== "PASS" ||
      step.productAcceptance.cases[0]?.cleanupVerified !== true
    )
      invalid(`Taste lifecycle stage ${stage} does not bind its transport Run.`);

    const fresh = await verifyProduct({
      mode: "run",
      status: "PASS",
      runtime: report.runtime,
      cases: [transport],
    });
    const evidence = fresh?.cases?.length === 1 ? fresh.cases[0] : undefined;
    const scope = evidence?.scope;
    const message = evidence?.messageBinding;
    if (
      fresh?.status !== "PASS" ||
      !same(fresh.runtime, report.runtime) ||
      evidence?.caseId !== transport.id ||
      evidence?.runId !== step.runId ||
      evidence?.traceVerified !== true ||
      evidence?.feature?.status !== "PASS" ||
      evidence?.feature?.runId !== evidence.runId ||
      evidence?.cleanupVerified !== true ||
      scope?.chatType !== "private" ||
      scope.connectionId !== report.runtime.connectionId ||
      scope.botId !== config.bot.qq ||
      scope.chatId !== config.driver.qq ||
      scope.senderId !== config.driver.qq ||
      (scope.threadId ?? null) !== (report.runtime.threadId ?? null) ||
      !message?.input ||
      !exactKeys(
        message.input,
        messageTimeBindingKeys(message.input, ["realSequence", "time", "textSha256"]),
      ) ||
      !Object.hasOwn(message.input, "driverTime") ||
      !validMessageTimeBinding(message.input) ||
      message.input.realSequence !== fixed.binding.realSequence ||
      !messageTimesMatch(fixed.binding, message.input) ||
      message.input.textSha256 !== fixed.binding.textSha256 ||
      !message?.reply ||
      !exactKeys(
        message.reply,
        messageTimeBindingKeys(message.reply, [
          "botMessageId",
          "driverMessageId",
          "realSequence",
          "time",
          "textSha256",
        ]),
      ) ||
      !Object.hasOwn(message.reply, "driverTime") ||
      !validMessageTimeBinding(message.reply) ||
      !messageReplyTimesFollowInput(message.input, message.reply) ||
      String(message.reply.botMessageId) !== String(evidence.delivery?.external_id) ||
      String(message.reply.driverMessageId) !== String(fixed.reply.messageId) ||
      !/^\d{1,30}$/.test(String(message.reply.realSequence ?? "")) ||
      !Number.isSafeInteger(message.reply.time) ||
      message.reply.time < fixed.binding.time ||
      message.reply.time <= 0 ||
      message.reply.textSha256 !== fixed.reply.textSha256 ||
      evidence?.delivery?.status !== "sent" ||
      evidence.delivery.destination_scope_key !==
        JSON.stringify([
          scope.connectionId,
          scope.botId,
          scope.chatType,
          scope.chatId,
          scope.senderId,
          scope.threadId ?? null,
        ])
    )
      invalid(`Fresh Taste product proof for ${stage} does not match its QQ input and reply.`);
    const scopeIdentity = JSON.stringify([
      scope.connectionId,
      scope.botId,
      scope.chatType,
      scope.chatId,
      scope.senderId,
      scope.threadId ?? null,
    ]);
    if (stableScope !== undefined && stableScope !== scopeIdentity)
      invalid("Taste family stages changed private account scope.");
    stableScope ??= scopeIdentity;
    stageRuns.push(evidence.runId);
  }

  if (
    new Set(stageRuns).size !== STAGES.length ||
    handles.creationRunId !== stageRuns[0] ||
    handles.promotionRunId !== stageRuns[1] ||
    handles.negativeRunId !== stageRuns[2] ||
    handles.cleanupRunId !== stageRuns[3]
  )
    invalid("Taste fixture handles do not match four distinct verified Runs.");

  const finalState = await readFixture({
    stage: "retire",
    fixtureNonce: nonce,
    principalId: handles.principalId,
    creationRunId: handles.creationRunId,
    promotionRunId: handles.promotionRunId,
    negativeRunId: handles.negativeRunId,
    stepRunId: handles.cleanupRunId,
    candidateId: handles.candidateId,
    memoryId: handles.memoryId,
    correctionCandidateId: handles.correctionCandidateId,
  });
  const expectedFinal = lifecycle.steps.at(-1)?.observation;
  if (
    !record(finalState) ||
    finalState.principalKind !== "owner" ||
    finalState.principalId !== handles.principalId ||
    finalState.projectId !== handles.projectId ||
    finalState.stepRunId !== handles.cleanupRunId ||
    finalState.creationRunId !== handles.creationRunId ||
    finalState.promotionRunId !== handles.promotionRunId ||
    finalState.memoryId !== handles.memoryId ||
    finalState.negativeRunId !== handles.negativeRunId ||
    finalState.candidateId !== handles.candidateId ||
    finalState.correctionCandidateId !== handles.correctionCandidateId ||
    finalState.cleanupRunId !== handles.cleanupRunId ||
    finalState.lifecycleState !== "retired" ||
    finalState.correctionStatus !== "promoted" ||
    finalState.activeCount !== 0 ||
    finalState.pendingCount !== 0 ||
    !same(finalState, expectedFinal)
  )
    invalid("Independent final Taste database state does not match the full fixture lifecycle.");
  if (!same(await readRuntime(), report.runtime))
    invalid("Taste family Runtime changed during final database verification.");

  return {
    status: "PASS",
    familyId: TASTE_FAMILY_ID,
    runtime: report.runtime,
    scope: { chatType: "private" },
    stageRunIds: stageRuns,
    fixture: {
      projectId: handles.projectId,
      principalId: handles.principalId,
      candidateId: handles.candidateId,
      memoryId: handles.memoryId,
      correctionCandidateId: handles.correctionCandidateId,
      lifecycleState: finalState.lifecycleState,
      activeCount: finalState.activeCount,
      pendingCount: finalState.pendingCount,
    },
  };
}
