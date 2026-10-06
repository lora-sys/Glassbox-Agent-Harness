import { digest, toolManifestDigest } from "./core.mjs";
import { tasteFixtureStep } from "./taste-scenario.mjs";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { caseEvidence } from "./product-evidence.mjs";
import { boundMessage, compareSameMessage } from "./message-binding.mjs";

const HASH = /^[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const MESSAGE_ID = /^-?\d{1,20}$/;

function invalid() {
  const error = new Error("Taste failed-case cleanup proof is incomplete.");
  error.code = "TASTE_FAILURE_CLEANUP";
  error.status = "INCONCLUSIVE";
  throw error;
}

/** Independently bind a replied Taste mismatch to its real Run, tool result, and lease audit. */
export async function verifyTasteKnownReplyFailure(
  caseRecord,
  { stage, handles, runtime, config, verifyCleanup, readTrace, clients, readRuntime },
) {
  if (
    !runtime ||
    typeof verifyCleanup !== "function" ||
    typeof readTrace !== "function" ||
    typeof readRuntime !== "function" ||
    !clients?.driver ||
    !clients?.bot
  )
    invalid();
  let spec;
  try {
    spec = tasteFixtureStep(stage, {
      nonce: handles?.fixtureNonce,
      candidateId: handles?.candidateId,
      memoryId: handles?.memoryId,
      correctionCandidateId: handles?.correctionCandidateId,
    });
  } catch {
    invalid();
  }
  const token = caseRecord?.token;
  const tools = JSON.parse(JSON.stringify(spec.leaseTools).replaceAll("{{nonce}}", token ?? ""));
  const expectedPrompt = `GLASSBOX_ACCEPTANCE_V1 ${token}\n${spec.prompt
    .replaceAll("{{nonce}}", token ?? "")
    .trim()}`;
  const binding = caseRecord?.inputBinding;
  const reply = caseRecord?.replies?.length === 1 ? caseRecord.replies[0] : undefined;
  if (
    caseRecord?.id !== spec.id ||
    caseRecord.status !== "FAIL" ||
    caseRecord.code !== "REPLY_ASSERTION_FAILED" ||
    caseRecord.route !== "private" ||
    caseRecord.sendAttempted !== true ||
    caseRecord.inputObserved !== true ||
    caseRecord.leaseRegistrationAttempted !== true ||
    caseRecord.leaseRevoked !== true ||
    !/^[a-f0-9]{32}$/.test(token ?? "") ||
    caseRecord.prompt !== expectedPrompt ||
    JSON.stringify(caseRecord.expected) !==
      JSON.stringify(spec.expectContains.map((value) => value.replaceAll("{{nonce}}", token))) ||
    JSON.stringify(caseRecord.featureAssertions) !== JSON.stringify(spec.featureAssertions) ||
    JSON.stringify(caseRecord.leasedToolNames) !== JSON.stringify(tools.map((tool) => tool.name)) ||
    caseRecord.acceptanceLease?.toolsSha256 !== toolManifestDigest(tools) ||
    !binding ||
    !MESSAGE_ID.test(String(binding.driverMessageId ?? "")) ||
    !MESSAGE_ID.test(String(binding.botMessageId ?? "")) ||
    String(binding.driverMessageId) !== String(caseRecord.sentMessageId) ||
    !/^\d{1,30}$/.test(String(binding.realSequence ?? "")) ||
    !Number.isSafeInteger(binding.time) ||
    !HASH.test(binding.textSha256 ?? "") ||
    reply?.route !== "private" ||
    reply.matches !== false ||
    !MESSAGE_ID.test(String(reply.messageId ?? "")) ||
    !HASH.test(reply.textSha256 ?? "") ||
    !Number.isSafeInteger(reply.textBytes) ||
    !Number.isFinite(Date.parse(reply.receivedAt ?? "")) ||
    caseRecord.anomalies?.includes("WRONG_DESTINATION")
  )
    invalid();

  const beforeRuntime = await readRuntime();
  if (JSON.stringify(beforeRuntime) !== JSON.stringify(runtime)) invalid();

  const cleanup = await verifyCleanup(
    { mode: "run", status: "FAIL", runtime, cases: [caseRecord] },
    config,
  );
  const receipt = cleanup?.cases?.length === 1 ? cleanup.cases[0] : undefined;
  if (
    cleanup?.status !== "CLEANUP_VERIFIED" ||
    JSON.stringify(cleanup.runtime) !== JSON.stringify(runtime) ||
    receipt?.caseId !== caseRecord.id ||
    receipt.cleanupVerified !== true ||
    !ID.test(receipt.runId ?? "")
  )
    invalid();
  const db = new DatabaseSync(join(runtime.dataDirectory, "glassbox.db"), { readOnly: true });
  let messageBinding;
  try {
    const evidence = caseEvidence(db, caseRecord, config);
    const message = await bindTasteMismatchMessages(caseRecord, config, clients, evidence.delivery);
    messageBinding = message;
  } finally {
    db.close();
  }
  const trace = await readTrace(receipt.runId);
  const events = trace?.events?.map((row) => row.event) ?? [];
  const calls = events.filter(
    (event) =>
      event.type === "tool_call" &&
      event.runId === receipt.runId &&
      event.data?.name === "owner_memory_admin",
  );
  const results = events.filter(
    (event) =>
      event.type === "tool_result" &&
      event.runId === receipt.runId &&
      event.data?.name === "owner_memory_admin",
  );
  const call = calls.length === 1 ? calls[0] : undefined;
  const result = results.length === 1 ? results[0] : undefined;
  if (
    !call?.toolCallId ||
    call.runId !== receipt.runId ||
    result?.toolCallId !== call.toolCallId ||
    result.data?.isError !== false ||
    !HASH.test(result.data?.outputSha256 ?? "") ||
    !Number.isSafeInteger(result.data?.outputBytes) ||
    result.data.outputBytes < 0
  )
    invalid();
  if (JSON.stringify(await readRuntime()) !== JSON.stringify(runtime)) invalid();
  return {
    cleanupVerified: true,
    failureCode: "REPLY_ASSERTION_FAILED",
    caseId: caseRecord.id,
    runId: receipt.runId,
    toolName: "owner_memory_admin",
    toolCallId: call.toolCallId,
    toolOutputSha256: result.data.outputSha256,
    toolsSha256: caseRecord.acceptanceLease.toolsSha256,
    promptSha256: digest(caseRecord.prompt),
    inputBinding: structuredClone(binding),
    reply: structuredClone(reply),
    messageBinding,
  };
}

async function bindTasteMismatchMessages(caseRecord, config, clients, delivery) {
  const input = caseRecord.inputBinding;
  const reply = caseRecord.replies[0];
  const ids = [input.botMessageId, input.driverMessageId, delivery.external_id, reply.messageId];
  if (new Set(ids.map(String)).size !== ids.length) invalid();
  for (const [client, messageId] of [
    [clients.bot, input.botMessageId],
    [clients.driver, input.driverMessageId],
    [clients.bot, String(delivery.external_id)],
    [clients.driver, reply.messageId],
  ])
    client.allowMessageRead(messageId);
  const shared = {
    messageType: "private",
    afterTime: caseRecord.startedAt,
  };
  const inputBot = await boundMessage(clients.bot, input.botMessageId, {
    ...shared,
    selfId: config.bot.qq,
    senderId: config.driver.qq,
    textSha256: input.textSha256,
  });
  const inputDriver = await boundMessage(clients.driver, input.driverMessageId, {
    ...shared,
    selfId: config.driver.qq,
    senderId: config.driver.qq,
    textSha256: input.textSha256,
  });
  const inputMatch = compareSameMessage(inputBot, inputDriver);
  const replyBot = await boundMessage(clients.bot, String(delivery.external_id), {
    ...shared,
    selfId: config.bot.qq,
    senderId: config.bot.qq,
    textSha256: reply.textSha256,
  });
  const replyDriver = await boundMessage(clients.driver, reply.messageId, {
    ...shared,
    selfId: config.driver.qq,
    senderId: config.bot.qq,
    textSha256: reply.textSha256,
  });
  const replyMatch = compareSameMessage(replyBot, replyDriver);
  if (
    String(delivery.external_id) !== String(replyBot.messageId) ||
    String(reply.messageId) !== String(replyDriver.messageId) ||
    inputMatch.textSha256 !== input.textSha256 ||
    replyMatch.textSha256 !== reply.textSha256
  )
    invalid();
  return {
    input: inputMatch,
    reply: {
      botMessageId: String(delivery.external_id),
      driverMessageId: reply.messageId,
      ...replyMatch,
    },
  };
}
