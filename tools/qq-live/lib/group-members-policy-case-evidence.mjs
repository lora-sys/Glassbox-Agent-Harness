import { isDeepStrictEqual } from "node:util";
import { digest, fail, toolManifestDigest } from "./core.mjs";
import { messageTimeBindingKeys, validMessageTimeBinding } from "./message-binding.mjs";
import { verifyCaseLeaseCleanupEvidence } from "./product-evidence.mjs";
import { groupMembersPolicyStep } from "./group-members-policy-scenario.mjs";

const REFUSAL = "未能从 QQ 获取该信息，因此无法确认。";
const TOKEN = /^[a-f0-9]{32}$/u;
const MESSAGE_ID = /^-?\d{1,20}$/u;
const HASH = /^[a-f0-9]{64}$/u;

function invalid() {
  fail(
    "GROUP_MEMBERS_POLICY_CASE_EVIDENCE",
    "群成员权限失败 Run、投递或许可清理证据缺失或不一致。",
    "INCONCLUSIVE",
  );
}
function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function exactKeys(value, keys) {
  return (
    record(value) &&
    isDeepStrictEqual(
      Object.keys(value).sort((a, b) => a.localeCompare(b)),
      [...keys].sort((a, b) => a.localeCompare(b)),
    )
  );
}
function timestamp(value) {
  const millis = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(millis) && new Date(millis).toISOString() === value ? millis : NaN;
}
function expectedScope(caseRecord, config) {
  const runtime = config?.runtime;
  if (
    caseRecord.route !== "private" ||
    typeof runtime?.connectionId !== "string" ||
    !runtime.connectionId ||
    typeof config?.bot?.qq !== "string" ||
    !config.bot.qq ||
    typeof config?.driver?.qq !== "string" ||
    !config.driver.qq ||
    (runtime.threadId !== undefined &&
      runtime.threadId !== null &&
      (typeof runtime.threadId !== "string" || !runtime.threadId))
  )
    invalid();
  return {
    connectionId: runtime.connectionId,
    botId: config.bot.qq,
    chatType: "private",
    chatId: config.driver.qq,
    senderId: config.driver.qq,
    threadId: runtime.threadId ?? null,
  };
}
function keyFor(scope) {
  return JSON.stringify([
    scope.connectionId,
    scope.botId,
    scope.chatType,
    scope.chatId,
    scope.senderId,
    scope.threadId ?? null,
  ]);
}
function scopeMatches(actual, expected) {
  return (
    actual?.connectionId === expected.connectionId &&
    String(actual?.botId) === expected.botId &&
    actual?.chatType === expected.chatType &&
    String(actual?.chatId) === expected.chatId &&
    String(actual?.senderId) === expected.senderId &&
    (actual?.threadId ?? null) === expected.threadId
  );
}
function identifier(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 512 &&
    !Array.from(value).some((character) => character.charCodeAt(0) < 32)
  );
}
function validateFixedCase(caseRecord, config) {
  const groupRows = config.groups.filter((group) => group.alias === "B");
  if (groupRows.length !== 1) invalid();
  const spec = groupMembersPolicyStep("members-check", groupRows[0].id);
  const token = caseRecord?.token;
  const lease = caseRecord?.acceptanceLease;
  const binding = caseRecord?.inputBinding;
  const reply = caseRecord?.replies?.length === 1 ? caseRecord.replies[0] : undefined;
  const started = timestamp(caseRecord?.startedAt);
  if (
    !TOKEN.test(token ?? "") ||
    caseRecord.id !== spec.id ||
    caseRecord.status !== "PASS" ||
    caseRecord.code !== "REAL_REPLY_RECEIVED" ||
    caseRecord.route !== "private" ||
    caseRecord.prompt !==
      `GLASSBOX_ACCEPTANCE_V1 ${token}\n${spec.prompt.replaceAll("{{nonce}}", token).trim()}` ||
    !isDeepStrictEqual(caseRecord.expected, spec.expectContains) ||
    caseRecord.sendAttempted !== true ||
    caseRecord.inputObserved !== true ||
    caseRecord.leaseRegistrationAttempted !== true ||
    caseRecord.leaseRevoked !== true ||
    Object.hasOwn(caseRecord, "featureAssertions") ||
    !isDeepStrictEqual(caseRecord.leasedToolNames, ["qq_group_members"]) ||
    !identifier(caseRecord.sentMessageId) ||
    !lease ||
    !exactKeys(lease, ["expiresAt", "leaseId", "toolsSha256"]) ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[0-9a-f]{12}$/iu.test(
      lease.leaseId ?? "",
    ) ||
    !Number.isSafeInteger(lease.expiresAt) ||
    lease.expiresAt <= started ||
    lease.toolsSha256 !== toolManifestDigest(spec.leaseTools) ||
    !Number.isFinite(started) ||
    !binding ||
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
    String(binding.driverMessageId) !== String(caseRecord.sentMessageId) ||
    typeof binding.realSequence !== "string" ||
    !/^\d{1,30}$/u.test(binding.realSequence) ||
    !validMessageTimeBinding(binding) ||
    !HASH.test(binding.textSha256 ?? "") ||
    binding.textSha256 !== digest(caseRecord.prompt) ||
    !reply ||
    !exactKeys(reply, ["route", "messageId", "textSha256", "textBytes", "matches", "receivedAt"]) ||
    reply.route !== "private" ||
    !MESSAGE_ID.test(String(reply.messageId ?? "")) ||
    reply.matches !== true ||
    reply.textSha256 !== digest(REFUSAL) ||
    reply.textBytes !== Buffer.byteLength(REFUSAL, "utf8") ||
    !Number.isFinite(timestamp(reply.receivedAt)) ||
    !Array.isArray(caseRecord.anomalies) ||
    caseRecord.anomalies.length !== 0
  )
    invalid();
  return { spec, scope: expectedScope(caseRecord, config), started };
}

/**
 * Verify only the fixed Group B missing-evidence case. This separate path supports the
 * expected failed Run without changing caseEvidence's successful-Run contract.
 */
export async function verifyGroupMembersPolicyFailureWithLeaseCleanup(
  db,
  dataDirectory,
  caseRecord,
  config,
  verifyAfterCleanup,
) {
  let cleanupVerified = false;
  try {
    if (!db || typeof verifyAfterCleanup !== "function") invalid();
    const { scope, started } = validateFixedCase(caseRecord, config);
    const expectedScopeKey = keyFor(scope);
    const rows = db
      .prepare(
        "SELECT r.id,r.message_id,r.status,r.failure_code,r.result_text,r.scope_json,r.created_at,r.updated_at,r.principal_id,r.conversation_id,p.kind AS principal_kind,m.external_id,m.scope_key,m.text,m.created_at AS message_created_at FROM runs r JOIN messages m ON m.id=r.message_id JOIN principals p ON p.id=r.principal_id WHERE m.external_id=? AND m.scope_key=?",
      )
      .all(caseRecord.inputBinding.botMessageId, expectedScopeKey);
    const matches = rows.filter((row) => {
      try {
        return (
          scopeMatches(JSON.parse(row.scope_json), scope) &&
          Number.isFinite(timestamp(row.created_at)) &&
          timestamp(row.created_at) >= started - 2_000
        );
      } catch {
        return false;
      }
    });
    const sourceMessages = db
      .prepare(
        "SELECT id,external_id,scope_key,text,created_at FROM messages WHERE external_id=? AND scope_key=?",
      )
      .all(caseRecord.inputBinding.botMessageId, expectedScopeKey);
    if (
      matches.length !== 1 ||
      sourceMessages.length !== 1 ||
      sourceMessages[0].id !== matches[0].message_id ||
      sourceMessages[0].external_id !== caseRecord.inputBinding.botMessageId ||
      sourceMessages[0].scope_key !== expectedScopeKey ||
      sourceMessages[0].text !== caseRecord.prompt ||
      digest(sourceMessages[0].text) !== caseRecord.inputBinding.textSha256 ||
      !Number.isFinite(timestamp(sourceMessages[0].created_at)) ||
      timestamp(sourceMessages[0].created_at) < started - 2_000
    )
      invalid();
    const run = matches[0];
    if (
      !identifier(run.id) ||
      run.principal_kind !== "owner" ||
      !identifier(run.principal_id) ||
      run.status !== "failed" ||
      run.failure_code !== "required_evidence_missing" ||
      run.result_text !== REFUSAL ||
      run.external_id !== caseRecord.inputBinding.botMessageId ||
      run.scope_key !== expectedScopeKey ||
      run.text !== caseRecord.prompt ||
      !Number.isFinite(timestamp(run.updated_at)) ||
      timestamp(run.updated_at) < timestamp(run.created_at) ||
      !identifier(run.conversation_id ?? "")
    )
      invalid();

    const memberDecisions = db
      .prepare(
        "SELECT principal_id,resource_id,action,scope_key,decision,run_id,delivery_source FROM authorization_decisions_all WHERE run_id=? AND resource_id=? AND action='group:members:read'",
      )
      .all(run.id, `group:${config.groups.find((group) => group.alias === "B").id}`);
    if (
      memberDecisions.some(
        (decision) =>
          decision.principal_id !== run.principal_id ||
          decision.resource_id !==
            `group:${config.groups.find((group) => group.alias === "B").id}` ||
          decision.action !== "group:members:read" ||
          decision.scope_key !== expectedScopeKey ||
          decision.decision !== "DENY" ||
          decision.run_id !== run.id ||
          decision.delivery_source !== null,
      )
    )
      invalid();

    const deliveries = db
      .prepare("SELECT id,status,external_id,destination_scope_key FROM deliveries WHERE run_id=?")
      .all(run.id);
    const sent = deliveries.filter(
      (delivery) =>
        delivery.status === "sent" && delivery.destination_scope_key === expectedScopeKey,
    );
    if (
      deliveries.length !== 1 ||
      sent.length !== 1 ||
      !identifier(sent[0].id) ||
      !identifier(sent[0].external_id)
    )
      invalid();
    const evidence = {
      caseId: caseRecord.id,
      runId: run.id,
      principalId: run.principal_id,
      conversationId: run.conversation_id,
      runCreatedAt: run.created_at,
      scope,
      decisions: memberDecisions,
      deliveries,
      delivery: sent[0],
    };
    await verifyCaseLeaseCleanupEvidence(db, dataDirectory, caseRecord, evidence);
    cleanupVerified = true;
    const result = await verifyAfterCleanup(evidence);
    return { evidence, cleanupVerified, result };
  } catch (error) {
    if (error && typeof error === "object") error.cleanupVerified = cleanupVerified;
    throw error;
  }
}
