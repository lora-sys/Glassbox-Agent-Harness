import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { digest, fail, toolManifestDigest, validateModeration } from "./core.mjs";
import {
  caseEvidence,
  readTraceEvents,
  runtimeSnapshot,
  verifyCaseLeaseCleanupEvidence,
  verifyLeaseTraceEvidence,
  verifyMessageBindings,
  verifyTraceEvidence,
} from "./product-evidence.mjs";
import { moderationStep, MODERATION_FAMILY_ID } from "./moderation-scenario.mjs";
import { readModerationPolicyState } from "./moderation-state.mjs";

function invalid(code = "MODERATION_PRODUCT_EVIDENCE") {
  fail(code, "禁言 Run 缺少固定操作、授权、许可或独立结果证据。", "INCONCLUSIVE");
}

function verifiedInputDigest(input) {
  const canonical = JSON.stringify(
    Object.fromEntries(Object.entries(input).sort(([left], [right]) => left.localeCompare(right))),
  );
  return {
    inputSha256: digest(Buffer.from(canonical, "utf8")),
    inputBytes: Buffer.byteLength(canonical, "utf8"),
  };
}

export async function verifyModerationAuthorizationEvidence({
  caseRecord,
  config,
  clients,
  fixed,
} = {}) {
  const startedAt = Date.parse(caseRecord?.startedAt ?? "");
  if (!Number.isFinite(startedAt) || new Date(startedAt).toISOString() !== caseRecord.startedAt)
    invalid("MODERATION_AUTHORIZATION_BINDING");
  let authorization;
  try {
    authorization = validateModeration(config, startedAt, {
      allowOwnerRequest: true,
    });
  } catch {
    invalid("MODERATION_AUTHORIZATION_BINDING");
  }
  if (
    authorization.groupId !== fixed.groupId ||
    authorization.target !== fixed.target ||
    authorization.durationSeconds !== fixed.durationSeconds ||
    caseRecord.moderationTarget !== fixed.target ||
    caseRecord.moderationGroupId !== fixed.groupId
  )
    invalid("MODERATION_AUTHORIZATION_BINDING");
  if (authorization.authorizationBasis !== "group-owner-request") {
    if (
      Object.hasOwn(caseRecord, "moderationAuthorizationBasis") ||
      Object.hasOwn(caseRecord, "moderationOwnerAuthorization")
    )
      invalid("MODERATION_AUTHORIZATION_BINDING");
    return undefined;
  }
  const expectedOwnerAuthorization = {
    ownerId: config.driver.qq,
    confirmed: true,
    authorizedAt: authorization.ownerAuthorizationAt,
    validUntil: authorization.ownerAuthorizationUntil,
  };
  if (
    caseRecord.moderationAuthorizationBasis !== "group-owner-request" ||
    !isDeepStrictEqual(caseRecord.moderationOwnerAuthorization, expectedOwnerAuthorization)
  )
    invalid("MODERATION_AUTHORIZATION_BINDING");
  let owner;
  try {
    owner = await clients?.bot?.call("get_group_member_info", {
      group_id: fixed.groupId,
      user_id: Number(config.driver.qq),
      no_cache: true,
    });
  } catch {
    invalid("MODERATION_OWNER_ROLE_EVIDENCE");
  }
  if (
    String(owner?.group_id) !== fixed.groupId ||
    String(owner?.user_id) !== config.driver.qq ||
    owner?.role !== "owner"
  )
    invalid("MODERATION_OWNER_ROLE_EVIDENCE");
  return {
    authorizationProof: {
      basis: "group-owner-request",
      ownerId: config.driver.qq,
      authorizedAt: authorization.ownerAuthorizationAt,
      validUntil: authorization.ownerAuthorizationUntil,
      targetSha256: digest(fixed.target),
    },
    roleProof: { status: "NATIVE_GROUP_OWNER_VERIFIED", role: "owner" },
  };
}

export function verifyModerationTraceRun(events, caseRecord, fixed, evidence, stage, traceEntries) {
  const runEvents = events.filter((event) => event.runId === evidence.runId);
  const sessions = runEvents.filter((event) => event.type === "session_start");
  const calls = runEvents.filter((event) => event.type === "tool_call");
  const results = runEvents.filter((event) => event.type === "tool_result");
  const preconditions = runEvents.filter(
    (event) => event.type === "native_mute_state_precondition_verified",
  );
  const inputWitnesses = runEvents.filter(
    (event) => event.type === "qq_tool_execution_input_verified",
  );
  const precondition = preconditions.length === 1 ? preconditions[0] : null;
  const preconditionEntry = traceEntries?.find((entry) => entry.event === precondition);
  const preconditionAt = Date.parse(preconditionEntry?.ts ?? "");
  const expectedMuteUntil = caseRecord.moderationExpectedMuteUntil;
  const startedAt = Date.parse(caseRecord.startedAt);
  if (
    !Number.isSafeInteger(expectedMuteUntil) ||
    expectedMuteUntil < 0 ||
    !Number.isFinite(startedAt) ||
    preconditions.length !== 1 ||
    !Number.isFinite(preconditionAt) ||
    new Date(preconditionAt).toISOString() !== preconditionEntry?.ts ||
    (stage === "mute" && expectedMuteUntil > startedAt / 1000) ||
    (stage === "unmute" && expectedMuteUntil <= startedAt / 1000) ||
    (stage === "mute" && expectedMuteUntil > preconditionAt / 1000) ||
    (stage === "unmute" && expectedMuteUntil <= preconditionAt / 1000)
  )
    invalid("MODERATION_PRECONDITION_WITNESS");
  const expectedSpec = moderationStep(stage, {
    ...fixed,
    expectedMuteUntil,
  });
  const expectedToolsSha256 = toolManifestDigest(
    expectedSpec.leaseTools.map((tool) =>
      JSON.parse(JSON.stringify(tool).replaceAll("{{nonce}}", caseRecord.token)),
    ),
  );
  const expectedInput = {
    groupId: fixed.groupId,
    operation: "set_group_ban",
  };
  const expectedProviderInput = {
    group_id: Number(fixed.groupId),
    user_id: Number(fixed.target),
    duration: stage === "mute" ? fixed.durationSeconds : 0,
  };
  const expectedInputDigest = verifiedInputDigest(expectedProviderInput);
  const toolCallId = calls.length === 1 ? calls[0].data?.toolCallId : null;
  const result = results.length === 1 ? results[0] : null;
  const inputWitness = inputWitnesses.length === 1 ? inputWitnesses[0] : null;
  if (
    sessions.length < 1 ||
    calls.length !== 1 ||
    results.length !== 1 ||
    !toolCallId ||
    calls[0].principalId !== evidence.principalId ||
    calls[0].toolCallId !== toolCallId ||
    calls[0].data?.runId !== evidence.runId ||
    calls[0].data?.principalId !== evidence.principalId ||
    calls[0].data?.name !== "qq_group_moderation" ||
    !isDeepStrictEqual(calls[0].data?.input, expectedInput) ||
    result?.principalId !== evidence.principalId ||
    result?.toolCallId !== toolCallId ||
    result?.data?.runId !== evidence.runId ||
    result?.data?.principalId !== evidence.principalId ||
    result?.data?.name !== "qq_group_moderation" ||
    result?.data?.toolCallId !== toolCallId ||
    result?.data?.isError !== false ||
    runEvents.indexOf(calls[0]) >= runEvents.indexOf(result)
  )
    invalid("MODERATION_TOOL_TRACE");
  if (
    runEvents.indexOf(calls[0]) >= runEvents.indexOf(precondition) ||
    runEvents.indexOf(precondition) >= runEvents.indexOf(result) ||
    inputWitnesses.length !== 1 ||
    runEvents.indexOf(precondition) >= runEvents.indexOf(inputWitness) ||
    runEvents.indexOf(inputWitness) >= runEvents.indexOf(result) ||
    !isDeepStrictEqual(Object.keys(inputWitness ?? {}).sort(), [
      "action",
      "conversationId",
      "inputBytes",
      "inputSha256",
      "leaseId",
      "principalId",
      "resourceId",
      "runId",
      "toolCallId",
      "toolName",
      "type",
    ]) ||
    inputWitness?.type !== "qq_tool_execution_input_verified" ||
    inputWitness?.runId !== evidence.runId ||
    inputWitness?.conversationId !== evidence.conversationId ||
    inputWitness?.principalId !== evidence.principalId ||
    inputWitness?.toolCallId !== toolCallId ||
    inputWitness?.toolName !== "qq_group_moderation" ||
    inputWitness?.leaseId !== caseRecord.acceptanceLease?.leaseId ||
    inputWitness?.action !== "set_group_ban" ||
    inputWitness?.resourceId !== `group:${fixed.groupId}` ||
    inputWitness?.inputSha256 !== expectedInputDigest.inputSha256 ||
    inputWitness?.inputBytes !== expectedInputDigest.inputBytes ||
    precondition?.runId !== evidence.runId ||
    precondition?.conversationId !== evidence.conversationId ||
    precondition?.principalId !== evidence.principalId ||
    precondition?.resourceId !== `group:${fixed.groupId}` ||
    precondition?.leaseId !== caseRecord.acceptanceLease?.leaseId ||
    precondition?.phase !== stage ||
    precondition?.expectedMuteUntil !== expectedMuteUntil
  )
    invalid("MODERATION_PRECONDITION_WITNESS");
  if (caseRecord.acceptanceLease?.toolsSha256 !== expectedToolsSha256)
    invalid("MODERATION_LEASE_TRACE");
  for (const event of sessions) {
    const lease = event.data?.acceptanceLease;
    if (
      event.principalId !== evidence.principalId ||
      event.data?.runId !== evidence.runId ||
      event.data?.principalId !== evidence.principalId ||
      lease?.leaseId !== caseRecord.acceptanceLease?.leaseId ||
      lease?.marker !== caseRecord.token ||
      lease?.toolsSha256 !== expectedToolsSha256 ||
      !Array.isArray(lease.narrowedTools) ||
      !isDeepStrictEqual(lease.narrowedTools, ["qq_group_moderation"]) ||
      !isDeepStrictEqual(event.data?.authorizedTools, ["qq_group_moderation"])
    )
      invalid("MODERATION_LEASE_TRACE");
  }
  const moderationRows = evidence.decisions.filter((row) => row.action === "group:moderate");
  if (moderationRows.length < 1 || moderationRows.some((row) => row.decision !== "ALLOW"))
    invalid("MODERATION_AUTHORIZATION");
  const rows = evidence.authorizationRows;
  const decisionIds = moderationRows.map((row) => row.id).sort();
  const rowIds = rows.map((row) => row.id).sort();
  if (
    rows.length !== moderationRows.length ||
    !isDeepStrictEqual(rowIds, decisionIds) ||
    rows.some(
      (row) =>
        row.principal_id !== evidence.principalId ||
        row.resource_id !== `group:${fixed.groupId}` ||
        row.action !== "group:moderate" ||
        row.scope_key !== evidence.scopeKey ||
        row.decision !== "ALLOW" ||
        row.delivery_source !== null ||
        row.grant_id !== evidence.policyState.grantId ||
        !row.grant_id ||
        !row.grant_effective,
    )
  )
    invalid("MODERATION_AUTHORIZATION");
  return {
    status: "MODERATION_TRACE_VERIFIED",
    stage,
    toolCallId,
    callCount: calls.length,
    resultCount: results.length,
    authorizationCount: rows.length,
    manifestSha256: expectedToolsSha256,
  };
}

export async function verifyModerationStepEvidence({
  caseRecord,
  fixed,
  config,
  clients,
  expectedRuntime,
  policyState,
}) {
  const stage = caseRecord?.moderationStage;
  if (!["mute", "unmute"].includes(stage)) invalid();
  const expectedMuteUntil = caseRecord.moderationExpectedMuteUntil;
  const startedAt = Date.parse(caseRecord.startedAt);
  if (
    !Number.isSafeInteger(expectedMuteUntil) ||
    expectedMuteUntil < 0 ||
    !Number.isFinite(startedAt) ||
    (stage === "mute" && expectedMuteUntil > startedAt / 1000) ||
    (stage === "unmute" && expectedMuteUntil <= startedAt / 1000)
  )
    invalid("MODERATION_PRECONDITION_BINDING");
  const stageFixed = { ...fixed, expectedMuteUntil };
  const spec = moderationStep(stage, stageFixed);
  const expectedPrompt = `GLASSBOX_ACCEPTANCE_V1 ${caseRecord.token}\n${spec.prompt.replaceAll("{{nonce}}", caseRecord.token)}`;
  const expectedTools = JSON.parse(
    JSON.stringify(spec.leaseTools).replaceAll("{{nonce}}", caseRecord.token),
  );
  if (
    caseRecord.id !== spec.id ||
    caseRecord.moderation !== true ||
    caseRecord.route !== "private" ||
    caseRecord.moderationTarget !== fixed.target ||
    caseRecord.moderationGroupId !== fixed.groupId ||
    caseRecord.prompt !== expectedPrompt ||
    !/^[a-f0-9]{32}$/u.test(caseRecord.token ?? "") ||
    !caseRecord.acceptanceLease ||
    caseRecord.acceptanceLease.toolsSha256 !== toolManifestDigest(expectedTools) ||
    caseRecord.leaseRevoked !== true ||
    caseRecord.status !== "PASS" ||
    caseRecord.code !== "REAL_REPLY_RECEIVED"
  )
    invalid("MODERATION_CASE_BINDING");
  const authorizationEvidence = await verifyModerationAuthorizationEvidence({
    caseRecord,
    config,
    clients,
    fixed,
  });
  const after = runtimeSnapshot(config.runtime);
  if (!isDeepStrictEqual(after, expectedRuntime)) invalid("RUNTIME_CHANGED");
  const db = new DatabaseSync(join(after.dataDirectory, "glassbox.db"), {
    readOnly: true,
    timeout: 5000,
  });
  try {
    const evidence = caseEvidence(db, caseRecord, config);
    await verifyCaseLeaseCleanupEvidence(db, after.dataDirectory, caseRecord, evidence);
    const authorizationRows = db
      .prepare(
        "SELECT d.id,d.principal_id,d.resource_id,d.action,d.scope_key,d.decision,d.grant_id,d.delivery_source,d.created_at,g.effect AS grant_effect,g.created_at AS grant_created_at,g.revoked_at AS grant_revoked_at FROM authorization_decisions_all d LEFT JOIN grants g ON g.id=d.grant_id WHERE d.run_id=? AND d.action='group:moderate' ORDER BY d.created_at,d.id",
      )
      .all(evidence.runId)
      .map((row) => ({
        ...row,
        grant_effective:
          row.grant_effect === "allow" &&
          typeof row.grant_created_at === "string" &&
          Date.parse(row.grant_created_at) <= Date.parse(row.created_at) &&
          (row.grant_revoked_at === null ||
            Date.parse(row.grant_revoked_at) > Date.parse(row.created_at)),
      }));
    const trace = readTraceEvents(after.checkout, after.dataDirectory, evidence.runId, undefined, [
      "native_mute_state_precondition_verified",
      "qq_tool_execution_input_verified",
    ]);
    const traceEntries = trace.events ?? [];
    const events = traceEntries.map((row) => row.event);
    const runContext = db
      .prepare("SELECT conversation_id FROM runs WHERE id=?")
      .get(evidence.runId);
    if (typeof runContext?.conversation_id !== "string" || !runContext.conversation_id)
      invalid("MODERATION_PRECONDITION_WITNESS");
    verifyTraceEvidence(
      events,
      caseRecord,
      config,
      evidence.delivery,
      evidence.authorizationProjectionReceipts,
      evidence.runId,
      evidence.principalId,
    );
    verifyLeaseTraceEvidence(events, caseRecord, evidence.runId);
    const messageBinding = await verifyMessageBindings(
      caseRecord,
      config,
      clients,
      evidence.delivery,
    );
    const traceProof = verifyModerationTraceRun(
      events,
      caseRecord,
      stageFixed,
      {
        ...evidence,
        authorizationRows,
        conversationId: runContext.conversation_id,
        scopeKey: JSON.stringify([
          config.runtime.connectionId,
          config.bot.qq,
          "private",
          config.driver.qq,
          config.driver.qq,
          config.runtime.threadId ?? null,
        ]),
        policyState,
      },
      stage,
      traceEntries,
    );
    const currentPolicy = readModerationPolicyState(config);
    if (
      currentPolicy.moderationEnabled !== true ||
      currentPolicy.principalId !== evidence.principalId ||
      currentPolicy.grantId !== policyState.grantId ||
      currentPolicy.policyVersion !== policyState.policyVersion
    )
      invalid("MODERATION_POLICY_CHANGED");
    const currentRuntime = runtimeSnapshot(config.runtime);
    if (!isDeepStrictEqual(currentRuntime, expectedRuntime)) invalid("RUNTIME_CHANGED");
    return {
      runId: evidence.runId,
      principalId: evidence.principalId,
      messageBinding,
      traceProof,
      policyProof: {
        status: "MODERATION_POLICY_ENABLED",
        policyVersion: policyState.policyVersion,
        grantId: policyState.grantId,
      },
      authorizationProof: {
        status: "GROUP_MODERATE_ALLOWED",
        decisionCount: authorizationRows.length,
        grantId: policyState.grantId,
        ...authorizationEvidence?.authorizationProof,
      },
      ...(authorizationEvidence?.roleProof ? { roleProof: authorizationEvidence.roleProof } : {}),
      leaseProof: {
        status: "LEASE_REVOKED",
        leaseId: caseRecord.acceptanceLease.leaseId,
      },
    };
  } finally {
    db.close();
  }
}

export async function verifyModerationProductEvidence({
  cases,
  config,
  clients,
  expectedRuntime,
  policyState,
} = {}) {
  if (
    !Array.isArray(cases) ||
    cases.length !== 2 ||
    !isDeepStrictEqual(
      cases.map((row) => row.moderationStage),
      ["mute", "unmute"],
    )
  )
    invalid();
  const fixed = {
    groupId: "1126022432",
    target: config.moderation.target,
    durationSeconds: config.moderation.durationSeconds,
  };
  const proofs = [];
  for (const caseRecord of cases)
    proofs.push(
      await verifyModerationStepEvidence({
        caseRecord,
        fixed,
        config,
        clients,
        expectedRuntime,
        policyState,
      }),
    );
  if (new Set(proofs.map((proof) => proof.runId)).size !== 2) invalid("MODERATION_RUN_REUSE");
  return {
    status: "PASS",
    familyId: MODERATION_FAMILY_ID,
    runtime: expectedRuntime,
    cases: proofs,
    cleanupVerified: true,
    actualQqDeliveryVerified: true,
  };
}
