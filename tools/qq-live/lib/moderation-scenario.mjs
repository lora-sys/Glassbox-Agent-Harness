import { digest, fail, validateModeration } from "./core.mjs";

export const MODERATION_FAMILY_ID = "qq-group-moderation-exact-b";
export const MODERATION_GROUP_B_ID = "1126022432";
const ID = /^[1-9]\d{4,15}$/u;
const STAGES = ["mute", "unmute"];

function invalid() {
  fail("MODERATION_SCENARIO", "固定禁言流程配置无效或缺少有效授权依据。", "BLOCKED");
}

function resolveAuthorization(config, now = Date.now()) {
  try {
    const validated = validateModeration(config, now, {
      allowOwnerRequest: true,
    });
    const groups = config?.groups;
    const B = Array.isArray(groups) ? groups.filter((group) => group?.alias === "B") : [];
    if (
      B.length !== 1 ||
      B[0]?.id !== MODERATION_GROUP_B_ID ||
      validated.emergencyCleanupViaDriver === true
    )
      invalid();
    const authorization =
      validated.authorizationBasis === "group-owner-request"
        ? {
            authorizationBasis: validated.authorizationBasis,
            ownerAuthorizationConfirmed: validated.ownerAuthorizationConfirmed,
            ownerAuthorizationAt: validated.ownerAuthorizationAt,
            ownerAuthorizationUntil: validated.ownerAuthorizationUntil,
            ownerId: config.driver.qq,
          }
        : {
            authorizationBasis: "member-consent",
            consentConfirmedAt: validated.consentConfirmedAt,
            consentUntil: validated.consentUntil,
          };
    return {
      groupId: validated.groupId,
      target: validated.target,
      durationSeconds: validated.durationSeconds,
      ...authorization,
    };
  } catch {
    invalid();
  }
}

export function moderationStep(stage, fixed) {
  if (
    !STAGES.includes(stage) ||
    !fixed ||
    !ID.test(fixed.groupId ?? "") ||
    !ID.test(fixed.target ?? "")
  )
    invalid();
  const mute = stage === "mute";
  const duration = mute ? fixed.durationSeconds : 0;
  const expectedMuteUntil = fixed.expectedMuteUntil;
  if (
    !Number.isSafeInteger(expectedMuteUntil) ||
    expectedMuteUntil < 0 ||
    (mute && expectedMuteUntil > Date.now() / 1000) ||
    (!mute && (expectedMuteUntil <= 0 || expectedMuteUntil <= Date.now() / 1000)) ||
    (mute && (!Number.isSafeInteger(duration) || duration < 30 || duration > 60))
  )
    invalid();
  return {
    id: `moderation-${stage}`,
    chat: "private",
    prompt: mute
      ? `请在群 ${fixed.groupId} 将 QQ ${fixed.target} 禁言 ${duration} 秒。执行后回复本轮编号 {{nonce}}。`
      : `请在群 ${fixed.groupId} 解除 QQ ${fixed.target} 的禁言。执行后回复本轮编号 {{nonce}}。`,
    expectContains: ["{{nonce}}"],
    sideEffect: "acceptance_fixture",
    leaseTools: [
      {
        name: "qq_group_moderation",
        operations: [
          {
            action: "group:moderate",
            resourceId: `group:${fixed.groupId}`,
            nativeMuteState: {
              kind: "qq-member-mute-state",
              phase: stage,
              expectedMuteUntil,
            },
            inputConstraint: {
              groupId: fixed.groupId,
              operation: "set_group_ban",
              params: { user_id: Number(fixed.target), duration },
            },
          },
        ],
      },
    ],
    featureAssertions: [
      {
        kind: "trace",
        type: "tool_result",
        where: { name: "qq_group_moderation", isError: false },
        count: 1,
      },
    ],
    moderationStage: stage,
    target: fixed.target,
    groupId: fixed.groupId,
    durationSeconds: duration,
  };
}

export function moderationPlan(config, now = Date.now()) {
  const fixed = resolveAuthorization(config, now);
  if (
    !config.runtime ||
    typeof config.runtime.checkout !== "string" ||
    !config.runtime.checkout ||
    typeof config.runtime.dataDirectory !== "string" ||
    !config.runtime.dataDirectory ||
    !/^[a-f0-9]{40}$/u.test(config.runtime.expectedCommit ?? "") ||
    typeof config.runtime.connectionId !== "string" ||
    !config.runtime.connectionId
  )
    fail("MODERATION_RUNTIME", "禁言计划必须绑定完整 Runtime 身份。", "BLOCKED");
  const plan = {
    familyId: MODERATION_FAMILY_ID,
    workflow: "owner-private-exact-mute-unmute",
    groupId: fixed.groupId,
    actors: {
      ownerId: config.driver.qq,
      botId: config.bot.qq,
      principalKind: "owner",
    },
    runtime: {
      checkout: config.runtime?.checkout,
      dataDirectory: config.runtime?.dataDirectory,
      expectedCommit: config.runtime?.expectedCommit,
      expectedSourceTreeSha256: config.runtime?.expectedSourceTreeSha256 ?? null,
      connectionId: config.runtime?.connectionId,
      threadId: config.runtime?.threadId ?? null,
    },
    groups: {
      A: config.groups.find((group) => group.alias === "A")?.id ?? null,
      B: fixed.groupId,
    },
    targetSha256: digest(fixed.target),
    durationSeconds: fixed.durationSeconds,
    authorizationBasis: fixed.authorizationBasis,
    ...(fixed.authorizationBasis === "group-owner-request"
      ? {
          ownerAuthorization: {
            ownerId: fixed.ownerId,
            confirmed: fixed.ownerAuthorizationConfirmed,
            authorizedAt: fixed.ownerAuthorizationAt,
            validUntil: fixed.ownerAuthorizationUntil,
          },
        }
      : {
          consentConfirmedAt: fixed.consentConfirmedAt,
          consentUntil: fixed.consentUntil,
        }),
    stages: STAGES.map((stage) => {
      const durationSeconds = stage === "mute" ? fixed.durationSeconds : 0;
      return {
        stage,
        chat: "private",
        action: "group:moderate",
        resourceId: `group:${fixed.groupId}`,
        inputConstraint: {
          groupId: fixed.groupId,
          operation: "set_group_ban",
          params: { user_id: Number(fixed.target), duration: durationSeconds },
        },
        nativeMuteState: {
          kind: "qq-member-mute-state",
          phase: stage,
          expectedMuteUntil:
            "captured from a fresh member read immediately before lease registration",
        },
      };
    }),
    prerequisites: [
      fixed.authorizationBasis === "group-owner-request"
        ? "The Owner request is current and covers both Runs; it does not assert target consent."
        : "Fresh target consent is limited to the exact target and remains valid through both Runs.",
      ...(fixed.authorizationBasis === "group-owner-request"
        ? [
            "The configured Owner is independently observed as the native group owner before each stage.",
          ]
        : []),
      "The Bot is independently observed as a group administrator or owner.",
      "The target is independently observed as an unmuted ordinary member.",
      "The service must enforce the previously observed mute-state precondition immediately before every mutation.",
      "Each mutation has a distinct exact server lease and Run; the lease is revoked before advancing.",
      "Both mutations require an independent state and Bot-notice match.",
    ],
    recovery:
      "Unknown mutation outcome or unverified restoration retains STOP and the pending checkpoint. No retry or direct cleanup mutation is automatic.",
    executionStatus:
      "Run requires a pinned Runtime source tree and a server-enforced mute-state precondition before each provider mutation.",
    coverage:
      "This fixed flow verifies only the exact B-group target and two requested mutations. It does not establish general moderation behavior.",
  };
  return { plan, fixed, suiteSha256: digest(JSON.stringify(plan)) };
}

export function resolveModerationCli({ command, caseId, config, approvedSuite } = {}) {
  if (!["plan", "run"].includes(command) || caseId !== MODERATION_FAMILY_ID) invalid();
  const resolved = moderationPlan(config);
  if (command === "plan") return { mode: "plan", familyId: MODERATION_FAMILY_ID, ...resolved };
  if (!config?.runtime) fail("MODERATION_RUNTIME", "禁言实机验收需要核对固定 Runtime。", "BLOCKED");
  if (!/^[a-f0-9]{64}$/u.test(config.runtime.expectedSourceTreeSha256 ?? ""))
    fail(
      "MODERATION_RUNTIME_SOURCE_REQUIRED",
      "禁言执行需要固定 Runtime 源代码树 SHA256。",
      "BLOCKED",
    );
  if (!Number.isSafeInteger(config.maxMessages) || config.maxMessages < 2)
    fail("MESSAGE_BUDGET", "禁言和恢复需要两条消息预算。", "BLOCKED");
  if (approvedSuite !== resolved.suiteSha256)
    fail("SUITE_APPROVAL", "请先审阅固定禁言计划并提供计划 SHA256。", "BLOCKED");
  return {
    mode: "run",
    familyId: MODERATION_FAMILY_ID,
    groupId: resolved.fixed.groupId,
    target: resolved.fixed.target,
    plan: resolved.plan,
    suiteSha256: resolved.suiteSha256,
  };
}
