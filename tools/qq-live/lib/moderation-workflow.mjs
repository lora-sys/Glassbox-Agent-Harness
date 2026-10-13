import { isDeepStrictEqual } from "node:util";
import { digest, fail, safeError, sleep, toolManifestDigest, validateModeration } from "./core.mjs";
import { moderationStep } from "./moderation-scenario.mjs";
import { verifyModerationPolicyUnchanged } from "./moderation-state.mjs";
import { replyCase } from "./runner.mjs";

function invalid(code, message = "禁言流程未完成独立核验。") {
  fail(code, message, "INCONCLUSIVE");
}

async function member(client, groupId, userId, requireMuteState = false) {
  const row = await client.call("get_group_member_info", {
    group_id: groupId,
    user_id: userId,
    no_cache: true,
  });
  if (
    String(row?.group_id) !== groupId ||
    String(row?.user_id) !== userId ||
    !["member", "admin", "owner"].includes(row?.role)
  )
    invalid("MODERATION_ROLE_EVIDENCE");
  const shutUpUntil = row.shut_up_timestamp;
  if (requireMuteState && (!Number.isSafeInteger(shutUpUntil) || shutUpUntil < 0))
    invalid("MUTE_STATE_UNSUPPORTED", "OneBot 没有返回可核验的秒级禁言状态。");
  return { role: row.role, shutUpUntil };
}

function noticeFor(c, operatorId, groupId, targetId, subtype, after) {
  return c.notices.findLast(
    (event) =>
      event.operatorId === operatorId &&
      event.groupId === groupId &&
      event.userId === targetId &&
      event.subtype === subtype &&
      event.receivedMs >= after &&
      Number.isSafeInteger(event.serverTime) &&
      event.serverTime >= Math.floor(after / 1000),
  );
}

async function observeState(config, clients, c, stage, timeoutMs, signal) {
  const until = Date.now() + Math.min(timeoutMs, 45_000);
  const fixed = validateModeration(config, Date.now(), {
    allowOwnerRequest: true,
  });
  while (Date.now() < until) {
    if (signal?.aborted) invalid("CANCELLED");
    const currentAuthorization = validateModeration(config, Date.now(), {
      allowOwnerRequest: true,
    });
    if (!isDeepStrictEqual(currentAuthorization, fixed))
      invalid("MODERATION_AUTHORIZATION_CHANGED");
    const needsOwnerRole = fixed.authorizationBasis === "group-owner-request";
    const [target, targetFromBot, bot, owner] = await Promise.all([
      member(clients.driver, fixed.groupId, fixed.target, true),
      member(clients.bot, fixed.groupId, fixed.target, true),
      member(clients.bot, fixed.groupId, config.bot.qq),
      needsOwnerRole
        ? member(clients.bot, fixed.groupId, config.driver.qq)
        : Promise.resolve(undefined),
    ]);
    if (
      (needsOwnerRole && owner?.role !== "owner") ||
      !["admin", "owner"].includes(bot.role) ||
      target.role !== "member" ||
      targetFromBot.role !== "member" ||
      targetFromBot.shutUpUntil !== target.shutUpUntil
    )
      invalid("MODERATION_ROLE_CHANGED", "群主、Bot 或目标成员角色在操作期间发生变化。");
    const notice =
      stage === "mute"
        ? noticeFor(c, config.bot.qq, fixed.groupId, fixed.target, "ban", c.muteSentAt)
        : noticeFor(c, config.bot.qq, fixed.groupId, fixed.target, "lift_ban", c.liftSentAt);
    const expectedUntil =
      stage === "mute" ? notice && notice.serverTime + fixed.durationSeconds : 0;
    const stateMatches =
      stage === "mute"
        ? target.shutUpUntil > Date.now() / 1000 &&
          Number.isFinite(expectedUntil) &&
          Math.abs(target.shutUpUntil - expectedUntil) <= 10 &&
          Math.abs(notice.duration - fixed.durationSeconds) <= 1
        : !!notice && notice.duration === 0 && target.shutUpUntil <= Date.now() / 1000;
    if (notice && stateMatches) return { notice, target, bot, owner };
    await sleep(750);
  }
  invalid(
    stage === "mute" ? "MUTE_EFFECT_UNCONFIRMED" : "LIFT_EFFECT_UNCONFIRMED",
    "没有同时核实 Bot 操作通知与目标当前禁言状态。",
  );
}

export async function readModerationFinalState(config, clients) {
  const fixed = validateModeration(config, Date.now(), {
    allowOwnerRequest: true,
  });
  const needsOwnerRole = fixed.authorizationBasis === "group-owner-request";
  const [bot, target, targetFromBot, owner] = await Promise.all([
    member(clients.bot, fixed.groupId, config.bot.qq),
    member(clients.driver, fixed.groupId, fixed.target, true),
    member(clients.bot, fixed.groupId, fixed.target, true),
    needsOwnerRole
      ? member(clients.bot, fixed.groupId, config.driver.qq)
      : Promise.resolve(undefined),
  ]);
  if (
    (needsOwnerRole && owner?.role !== "owner") ||
    !["admin", "owner"].includes(bot.role) ||
    target.role !== "member" ||
    targetFromBot.role !== "member" ||
    target.shutUpUntil !== targetFromBot.shutUpUntil ||
    target.shutUpUntil > Date.now() / 1000
  )
    invalid(
      "MODERATION_FINAL_STATE",
      "发起群主角色、Bot 管理角色或目标解禁状态未通过最终双账号复核。",
    );
  return {
    status: "MODERATION_FINAL_STATE_VERIFIED",
    ...(owner ? { ownerRole: owner.role } : {}),
    botRole: bot.role,
    targetRole: target.role,
    targetShutUpUntil: target.shutUpUntil,
  };
}

/**
 * Execute one exact Owner-private mute and one exact Owner-private unmute.
 * Every message gets its own lease and durable stage receipts. Uncertain state never retries.
 */
export async function runModerationWorkflow({
  config,
  clients,
  recorder,
  acceptance,
  checkpoint,
  readPolicyState,
  verifyStep,
  readRuntime,
  expectedRuntime,
  signal,
  send = replyCase,
} = {}) {
  let durable = false;
  const steps = [];
  let baseline;
  let runtime;
  let currentStage = "mute";
  let currentCase;
  let muteVerified = false;
  let observedMuteUntil = null;
  try {
    const fixed = validateModeration(config, Date.now(), {
      allowOwnerRequest: true,
    });
    if (
      fixed.group !== "B" ||
      fixed.groupId !== "1126022432" ||
      !clients?.driver ||
      !clients?.bot ||
      !recorder ||
      !acceptance ||
      typeof checkpoint !== "function" ||
      typeof readPolicyState !== "function" ||
      typeof verifyStep !== "function" ||
      typeof readRuntime !== "function"
    )
      invalid("MODERATION_CONTEXT");
    runtime = await readRuntime();
    if (!isDeepStrictEqual(runtime, expectedRuntime)) invalid("MODERATION_RUNTIME");
    baseline = await readPolicyState();
    if (baseline?.moderationEnabled !== true || !baseline.grantId)
      invalid("MODERATION_AUTHORITY", "群 B 的 group.moderate 策略或 Owner 授权未开启。");
    const assertStable = async (expectedMuteUntil) => {
      if (signal?.aborted) invalid("CANCELLED");
      if (!isDeepStrictEqual(await readRuntime(), runtime)) invalid("MODERATION_RUNTIME_CHANGED");
      const currentAuthorization = validateModeration(config, Date.now(), {
        allowOwnerRequest: true,
      });
      if (!isDeepStrictEqual(currentAuthorization, fixed))
        invalid("MODERATION_AUTHORIZATION_CHANGED");
      verifyModerationPolicyUnchanged(baseline, await readPolicyState());
      const needsOwnerRole = fixed.authorizationBasis === "group-owner-request";
      const [bot, target, targetFromBot, owner] = await Promise.all([
        member(clients.bot, fixed.groupId, config.bot.qq),
        member(clients.driver, fixed.groupId, fixed.target, true),
        member(clients.bot, fixed.groupId, fixed.target, true),
        needsOwnerRole
          ? member(clients.bot, fixed.groupId, config.driver.qq)
          : Promise.resolve(undefined),
      ]);
      if (
        (needsOwnerRole && owner?.role !== "owner") ||
        !["admin", "owner"].includes(bot.role) ||
        target.role !== "member" ||
        targetFromBot.role !== "member" ||
        targetFromBot.shutUpUntil !== target.shutUpUntil
      )
        invalid(
          "MODERATION_ROLE",
          "发起群主必须保持群主角色，Bot 必须是管理员或群主，目标必须是普通成员。",
        );
      if (expectedMuteUntil !== undefined && target.shutUpUntil !== expectedMuteUntil)
        invalid("MODERATION_TARGET_STATE_CHANGED", "目标禁言期限已变化，停止后续修改。");
      if (
        (currentStage === "mute" && target.shutUpUntil > Date.now() / 1000) ||
        (currentStage === "unmute" &&
          (!muteVerified ||
            !Number.isSafeInteger(observedMuteUntil) ||
            observedMuteUntil <= Date.now() / 1000 ||
            target.shutUpUntil !== observedMuteUntil))
      )
        invalid("MODERATION_TARGET_STATE_CHANGED", "目标禁言状态已变化，停止后续修改。");
      return {
        ...(owner ? { ownerRole: owner.role } : {}),
        botRole: bot.role,
        targetRole: target.role,
        targetShutUpUntil: target.shutUpUntil,
      };
    };
    const initialRoles = await assertStable();
    if (initialRoles.targetShutUpUntil > Date.now() / 1000)
      invalid("TARGET_ALREADY_MUTED", "目标原本已被禁言，测试不会覆盖已有状态。");

    for (currentStage of ["mute", "unmute"]) {
      const before = await assertStable(currentStage === "unmute" ? observedMuteUntil : undefined);
      if (
        (currentStage === "mute" && before.targetShutUpUntil > Date.now() / 1000) ||
        (currentStage === "unmute" && !muteVerified)
      )
        invalid("MODERATION_STAGE_STATE");
      const expectedMuteUntil = before.targetShutUpUntil;
      const stageFixed = { ...fixed, expectedMuteUntil };
      const spec = moderationStep(currentStage, stageFixed);
      await checkpoint({
        stage: currentStage,
        phase: "intent",
        steps,
        baseline,
        runtime,
        mutationPrecondition: spec.leaseTools[0].operations[0].nativeMuteState,
      });
      durable = true;
      let hookPhase = "initial";
      const hooks = {
        beforeRegister: async (c) => {
          if (hookPhase !== "initial") invalid("MODERATION_HOOK_ORDER");
          currentCase = c;
          c.moderation = true;
          c.moderationObservationActive = true;
          c.moderationStage = currentStage;
          c.moderationTarget = fixed.target;
          c.moderationGroupId = fixed.groupId;
          c.moderationExpectedMuteUntil = expectedMuteUntil;
          if (fixed.authorizationBasis === "group-owner-request") {
            c.moderationAuthorizationBasis = fixed.authorizationBasis;
            c.moderationOwnerAuthorization = {
              ownerId: config.driver.qq,
              confirmed: fixed.ownerAuthorizationConfirmed,
              authorizedAt: fixed.ownerAuthorizationAt,
              validUntil: fixed.ownerAuthorizationUntil,
            };
          }
          c[currentStage === "mute" ? "muteSentAt" : "liftSentAt"] = Date.now();
          await assertStable(expectedMuteUntil);
          await checkpoint({
            stage: currentStage,
            phase: "lease_intent",
            steps,
            baseline,
            runtime,
            prepared: {
              caseId: c.id,
              marker: c.token,
              promptSha256: digest(c.prompt),
              expectedMuteUntil,
            },
          });
          hookPhase = "registered_intent";
          return true;
        },
        beforeSend: async (c, lease) => {
          if (hookPhase !== "registered_intent" || c !== currentCase)
            invalid("MODERATION_HOOK_ORDER");
          const expectedToolsSha256 = toolManifestDigest(
            JSON.parse(JSON.stringify(spec.leaseTools).replaceAll("{{nonce}}", c.token)),
          );
          if (lease?.toolsSha256 !== expectedToolsSha256)
            invalid(
              "MODERATION_LEASE_MANIFEST",
              "服务器没有保留本轮禁言状态前置条件，消息未发送。",
            );
          await assertStable(expectedMuteUntil);
          await checkpoint({
            stage: currentStage,
            phase: "prepared",
            steps,
            baseline,
            runtime,
            prepared: {
              caseId: c.id,
              marker: c.token,
              promptSha256: digest(c.prompt),
              leaseId: lease.leaseId,
              toolsSha256: lease.toolsSha256,
              expiresAt: lease.expiresAt,
              expectedMuteUntil,
            },
          });
          await assertStable(expectedMuteUntil);
          hookPhase = "prepared";
          return true;
        },
        afterSend: async (c) => {
          if (hookPhase !== "prepared" || c !== currentCase) invalid("MODERATION_HOOK_ORDER");
          await checkpoint({
            stage: currentStage,
            phase: "sent",
            steps,
            baseline,
            runtime,
            sent: {
              caseId: c.id,
              marker: c.token,
              driverMessageId: c.sentMessageId,
            },
          });
          hookPhase = "sent";
          return true;
        },
      };
      const resultCase = await send(config, clients, recorder, spec, signal, {
        ...acceptance,
        ...hooks,
      });
      currentCase = resultCase;
      if (
        resultCase?.moderationStage !== currentStage ||
        resultCase.status !== "PASS" ||
        resultCase.code !== "REAL_REPLY_RECEIVED" ||
        resultCase.leaseRevoked !== true ||
        resultCase.cleanup?.required === true
      )
        invalid("MODERATION_RUN_UNVERIFIED", "本阶段 Run 未通过回复与许可撤销核验。");
      const productProof = await verifyStep({
        stage: currentStage,
        caseRecord: resultCase,
        fixed,
        runtime,
        policyState: baseline,
      });
      const observed = await observeState(
        config,
        clients,
        resultCase,
        currentStage,
        config.timeoutMs,
        signal,
      );
      resultCase.moderationObservationActive = false;
      if (currentStage === "mute") {
        muteVerified = true;
        observedMuteUntil = observed.target.shutUpUntil;
      }
      const proof = {
        stage: currentStage,
        runId: productProof.runId,
        status: "MODERATION_STEP_VERIFIED",
        principalId: productProof.principalId,
        policyProof: productProof.policyProof,
        authorizationProof: productProof.authorizationProof,
        traceProof: productProof.traceProof,
        leaseProof: productProof.leaseProof,
        messageBinding: productProof.messageBinding,
        roleProof: {
          ...(productProof.roleProof ? { independent: productProof.roleProof } : {}),
          ...(observed.owner ? { ownerRole: observed.owner.role } : {}),
          botRole: observed.bot.role,
          targetRole: observed.target.role,
        },
        mutationPrecondition: {
          kind: "qq-member-mute-state",
          phase: currentStage,
          expectedMuteUntil,
        },
        notice: {
          subtype: observed.notice.subtype,
          operatorId: observed.notice.operatorId,
          serverTime: observed.notice.serverTime,
          duration: observed.notice.duration,
        },
        targetShutUpUntil: observed.target.shutUpUntil,
        actualQqDeliveryVerified: true,
        cleanupVerified: true,
      };
      await checkpoint({
        stage: currentStage,
        phase: "observed",
        steps: [...steps, { stage: currentStage, proof }],
        baseline,
        runtime,
      });
      steps.push({ stage: currentStage, proof });
    }
    const finalPolicy = verifyModerationPolicyUnchanged(baseline, await readPolicyState());
    const finalRoles = await readModerationFinalState(config, clients);
    if (!isDeepStrictEqual(await readRuntime(), runtime)) invalid("MODERATION_RUNTIME_CHANGED");
    return {
      status: "MODERATION_WORKFLOW_VERIFIED",
      familyId: "qq-group-moderation-exact-b",
      policyState: baseline,
      steps,
      finalProof: {
        status: "MODERATION_FINAL_STATE_VERIFIED",
        policy: finalPolicy,
        roles: finalRoles,
      },
      requiresReconciliation: false,
      cleanupVerified: true,
      actualQqDeliveryVerified: true,
    };
  } catch (error) {
    if (currentCase) currentCase.moderationObservationActive = false;
    const safe = safeError(error);
    if (currentCase?.cleanup) {
      currentCase.cleanup.required = true;
      currentCase.cleanup.restored = false;
      currentCase.cleanup.pendingActionUnknown = true;
    }
    return {
      status: "INCONCLUSIVE",
      familyId: "qq-group-moderation-exact-b",
      stage: currentStage,
      steps,
      requiresReconciliation: durable,
      cleanupVerified: false,
      actualQqDeliveryVerified: false,
      error: { code: safe.code, message: safe.message },
    };
  }
}
