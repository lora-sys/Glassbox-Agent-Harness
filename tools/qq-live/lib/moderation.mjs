import { fail, id, sleep, safeError, validateModeration } from "./core.mjs";
import { sendCase } from "./runner.mjs";

async function member(client, group, user) {
  const m = await client.call("get_group_member_info", {
    group_id: group,
    user_id: user,
    no_cache: true,
  });
  if (
    id(m?.user_id) !== user ||
    id(m?.group_id) !== group ||
    !["member", "admin", "owner"].includes(m?.role)
  )
    fail("MEMBER_SHAPE", "群成员查询未通过身份与结构校验。");
  return m;
}
export function muteUntil(m, now = Date.now()) {
  const until = m?.shut_up_timestamp;
  // NapCat extension. Unsupported adapters must fail before any mutation.
  if (!Number.isSafeInteger(until) || until < 0 || until > now / 1000 + 366 * 86400)
    fail(
      "MUTE_STATE_UNSUPPORTED",
      "当前 OneBot 未返回有效的秒级 shut_up_timestamp。禁言测试不能验证状态，已停止。",
    );
  return until;
}
function ownNotice(c, bot, subtype, since) {
  // Notice timestamps have one-second precision. A notice in the same second
  // as the request cannot prove whether the action happened before or after it.
  const earliestServerTime = Math.ceil(since / 1000);
  return c.notices.findLast(
    (n) =>
      n.operatorId === bot &&
      n.subtype === subtype &&
      n.receivedMs >= since &&
      Number.isSafeInteger(n.serverTime) &&
      n.serverTime >= earliestServerTime,
  );
}
function sameBan(c, bot, until, seconds) {
  const n = ownNotice(c, bot, "ban", c.muteSentAt);
  const latest = c.notices.at(-1);
  return (
    !!n &&
    latest === n &&
    Math.abs(n.duration - seconds) <= 1 &&
    Math.abs(until - (n.serverTime + seconds)) <= 10 &&
    until > Date.now() / 1000
  );
}
async function observe(config, clients, c, predicate, timeout, signal) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (signal?.aborted) fail("CANCELLED", "测试已停止。");
    for (const client of Object.values(clients)) if (client.problem) throw client.problem;
    const until = muteUntil(await member(clients.driver, c.route, c.target));
    c.lastObservedMuteUntil = until;
    if (predicate(until)) return true;
    await sleep(750);
  }
  return false;
}
export async function moderationCase(config, clients, recorder, signal) {
  const m = validateModeration(config);
  const c = recorder.begin(
    "moderation",
    m.groupId,
    `请将 QQ ${m.target} 禁言 ${m.durationSeconds} 秒。执行完成后回复测试编号 {{nonce}}。`,
    [],
  );
  Object.assign(c, {
    moderation: true,
    target: m.target,
    effectVerified: false,
    cleanup: { required: false, normalChatVerified: false, emergencyUsed: false, restored: false },
  });
  let outcome = {
    status: "INCONCLUSIVE",
    code: "MODERATION_NOT_COMPLETED",
    message: "禁言测试未完成。",
  };
  try {
    if (signal?.aborted) fail("CANCELLED", "测试已停止。");
    if (Date.parse(config.safety.armedUntil) <= Date.now()) fail("NOT_ARMED", "授权窗口已过期。");
    const bot = await member(clients.bot, c.route, config.bot.qq);
    const target = await member(clients.driver, c.route, c.target);
    const driver = await member(clients.driver, c.route, config.driver.qq);
    if (!["admin", "owner"].includes(bot.role) || target.role !== "member")
      fail("MODERATION_ROLE", "Bot 必须有群管理角色，目标必须为普通成员。");
    if (m.emergencyCleanupViaDriver && !["admin", "owner"].includes(driver.role))
      fail("CLEANUP_ROLE", "启用主号紧急解禁时，主号也必须有群管理角色。");
    c.beforeMuteUntil = muteUntil(target);
    if (c.beforeMuteUntil > Date.now() / 1000)
      fail("TARGET_ALREADY_MUTED", "目标原本已被禁言，测试不会覆盖已有状态。");
    if (Date.parse(m.consentUntil) < Date.now() + 2 * config.timeoutMs + m.durationSeconds * 1000)
      fail("CONSENT_WINDOW_SHORT", "成员同意时段不足以覆盖测试和清理，请重新约定测试时段。");
    c.muteSentAt = Date.now();
    c.cleanup.required = true;
    await sendCase(config, clients, c);
    const observed = await observe(
      config,
      clients,
      c,
      (until) => sameBan(c, config.bot.qq, until, m.durationSeconds),
      Math.min(config.timeoutMs, 45000),
      signal,
    );
    if (!observed)
      fail(
        "MUTE_EFFECT_UNCONFIRMED",
        "未同时取得 Bot 操作的禁言通知与相符的禁言状态。回复成功不算通过。",
        "INCONCLUSIVE",
      );
    c.effectVerified = true;
    const lift = {
      route: c.route,
      prompt: `请解除 QQ ${m.target} 的禁言。执行完成后回复测试编号 ${c.token}_LIFT。`,
    };
    c.liftSentAt = Date.now();
    await sendCase(config, clients, lift);
    c.liftMessageId = lift.sentMessageId;
    const restored = await observe(
      config,
      clients,
      c,
      (until) =>
        until <= Date.now() / 1000 && !!ownNotice(c, config.bot.qq, "lift_ban", c.liftSentAt),
      Math.min(config.timeoutMs, 45000),
      signal,
    );
    if (!restored)
      fail(
        "LIFT_EFFECT_UNCONFIRMED",
        "未确认 Glassbox 通过聊天执行了解禁。自动到期不算解禁功能通过。",
        "INCONCLUSIVE",
      );
    c.cleanup.normalChatVerified = true;
    c.cleanup.restored = true;
    outcome = {
      status: "PASS",
      code: "MODERATION_EFFECT_VERIFIED",
      message: "发起账号收到 Bot 的禁言及解禁通知，且状态查询相符。没有直接调用 Bot 禁言接口。",
    };
  } catch (error) {
    outcome = safeError(error);
  } finally {
    if (c.cleanup.required && !c.cleanup.restored) {
      try {
        const until = muteUntil(await member(clients.driver, c.route, c.target));
        if (until <= Date.now() / 1000) {
          c.cleanup.restored = true;
          c.cleanup.method = "already_unmuted_or_expired";
          // An in-flight request may still execute. Do not declare cleanup complete.
          if (!c.effectVerified) {
            c.cleanup.restored = false;
            c.cleanup.pendingActionUnknown = true;
          }
        } else if (
          m.emergencyCleanupViaDriver &&
          sameBan(c, config.bot.qq, until, m.durationSeconds)
        ) {
          c.cleanup.emergencyUsed = true;
          await clients.driver.call(
            "set_group_ban",
            { group_id: c.route, user_id: c.target, duration: 0 },
            { cleanup: true },
          );
          const end = Date.now() + Math.min(config.apiTimeoutMs, 5000);
          while (Date.now() < end) {
            if (muteUntil(await member(clients.driver, c.route, c.target)) <= Date.now() / 1000) {
              c.cleanup.restored = true;
              break;
            }
            await sleep(500);
          }
          c.cleanup.method = "driver_emergency_cleanup";
        } else {
          c.cleanup.method = "manual_check_required";
          c.cleanup.note = "未取得可归因证据或未授权紧急解禁，不覆盖可能由他人设置的禁言。";
        }
      } catch {
        c.cleanup.method = "cleanup_query_failed";
      }
      if (!c.cleanup.restored) {
        outcome = {
          status: "BLOCKED",
          code: "CLEANUP_UNCONFIRMED",
          message: "清理结果或延迟操作无法确认。已停止，检查 Bot 待执行任务与目标状态后才能重跑。",
        };
      }
    }
  }
  return recorder.finish(c, outcome.status, outcome.code, outcome.message);
}
