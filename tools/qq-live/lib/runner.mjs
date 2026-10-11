import {
  fail,
  LiveError,
  id,
  messageId,
  textOf,
  routeOf,
  nonce,
  sleep,
  safeError,
  safeText,
  digest,
  statusOf,
} from "./core.mjs";
import { boundMessage, compareSameMessage } from "./message-binding.mjs";
import { randomUUID } from "node:crypto";
import { validateFeatureAssertions } from "./feature-observer.mjs";

export class Recorder {
  constructor(config, secrets = []) {
    this.config = config;
    this.secrets = secrets;
    this.cases = [];
    this.events = [];
    this.sequence = 0;
    this.mediaObservationWaiters = new Map();
    this.mediaObservationExpectations = new Map();
  }
  begin(name, route, prompt, expected, token = nonce()) {
    const c = {
      id: name,
      token,
      route,
      prompt: prompt.replaceAll("{{nonce}}", token),
      expected: expected.map((t) => t.replaceAll("{{nonce}}", token)),
      startedAt: new Date().toISOString(),
      startedMs: Date.now(),
      inputObserved: false,
      botInputMessageIds: [],
      botInputCandidates: [],
      replies: [],
      notices: [],
      anomalies: [],
      status: "INCONCLUSIVE",
    };
    this.cases.push(c);
    return c;
  }
  ingest(role, event) {
    const cfg = this.config;
    if (id(event.self_id) !== cfg[role].qq) return;
    if (event.post_type === "message") {
      const incoming = role === "bot" && id(event.user_id) === cfg.driver.qq;
      const reply = role === "driver" && id(event.user_id) === cfg.bot.qq;
      if (!incoming && !reply) return;
      const text = textOf(event.message);
      const route = routeOf(event, cfg.bot.qq, cfg.driver.qq);
      for (const c of this.cases) {
        const replyRef =
          Array.isArray(event.message) &&
          event.message.some(
            (s) =>
              s?.type === "reply" &&
              messageId(s.data?.id) &&
              messageId(s.data.id) === c.sentMessageId,
          );
        const eventTimeMs = Number.isFinite(event.time) ? event.time * 1000 : NaN;
        const startedMs = c.startedMs ?? Date.parse(c.startedAt);
        // Media delivery can arrive after the text reply completed. Its observer has its own
        // close boundary; finishing the text transport must not discard the later media event.
        const mediaObservationOpen = c.mediaObservationExpectedType && !c.mediaObservationClosed;
        const freshUnmarkedReply =
          reply &&
          route === c.route &&
          (!c.finishedAt || mediaObservationOpen) &&
          Number.isFinite(eventTimeMs) &&
          eventTimeMs >= startedMs - 2000 &&
          eventTimeMs <= Date.now() + 5000;
        if (
          !text.includes(c.token) &&
          !(reply && route === c.route && replyRef) &&
          !freshUnmarkedReply
        )
          continue;
        if (Number.isFinite(eventTimeMs) && eventTimeMs < startedMs - 2000) continue;
        const mid = messageId(event.message_id);
        if (!mid) {
          c.anomalies.push("MISSING_MESSAGE_ID");
          continue;
        }
        if (c.mediaObservationExpectedType && freshUnmarkedReply)
          this.observeMediaMessage(c, event);
        if (incoming && route === c.route && text === c.prompt) {
          if (!c.botInputMessageIds.includes(mid)) c.botInputMessageIds.push(mid);
          if (!c.botInputCandidates.some((candidate) => candidate.messageId === mid)) {
            c.botInputCandidates.push({
              messageId: mid,
              textSha256: digest(text),
            });
          }
        }
        if (reply) {
          if (c.replies.some((r) => r.route === route && r.messageId === mid)) continue;
          c.replies.push({
            route,
            messageId: mid,
            textSha256: digest(text),
            textBytes: Buffer.byteLength(text),
            matches: c.expected.every((s) => text.includes(s)),
            receivedAt: new Date().toISOString(),
          });
          if (route !== c.route) c.anomalies.push("WRONG_DESTINATION");
        }
        this.add({
          caseId: c.id,
          role,
          kind: incoming ? "input_observed" : "reply_observed",
          route,
          messageId: mid,
          textSha256: digest(text),
          textBytes: Buffer.byteLength(text),
          at: new Date().toISOString(),
        });
      }
    }
    if (role === "driver" && event.post_type === "notice" && event.notice_type === "group_ban") {
      for (const c of this.cases.filter(
        (x) => x.moderation && (x.moderationObservationActive === true || !x.finishedAt),
      )) {
        if (
          id(event.group_id) !== (c.moderationGroupId ?? c.route) ||
          id(event.user_id) !== (c.moderationTarget ?? c.target)
        )
          continue;
        if (!Number.isFinite(event.time) || event.time < Math.floor(c.startedMs / 1000) - 1)
          continue;
        const n = {
          groupId: id(event.group_id),
          userId: id(event.user_id),
          operatorId: id(event.operator_id),
          subtype: event.sub_type,
          duration: event.duration,
          serverTime: event.time,
          receivedMs: Date.now(),
        };
        if (
          !c.notices.some(
            (x) =>
              JSON.stringify(x, ["operatorId", "subtype", "duration", "serverTime"]) ===
              JSON.stringify(n, ["operatorId", "subtype", "duration", "serverTime"]),
          )
        ) {
          c.notices.push(n);
          this.add({ caseId: c.id, role, kind: "group_ban_notice", ...n });
        }
      }
    }
  }
  add(event) {
    if (this.events.length >= 500) fail("EVENT_BUDGET", "相关事件超过 500 条，停止测试。");
    const row = { seq: ++this.sequence, ...event };
    this.events.push(row);
    this.onEvent?.(row);
  }
  finish(c, status, code, detail) {
    c.status = status;
    c.code = code;
    c.detail = detail;
    c.finishedAt = new Date().toISOString();
    delete c.startedMs;
    return c;
  }
  finalize() {
    for (const c of this.cases) {
      if (c.anomalies.includes("WRONG_DESTINATION")) {
        c.status = "FAIL";
        c.code = "WRONG_DESTINATION";
        c.detail = "带本轮标记的回复出现在错误会话。";
      }
      if (!c.moderation && c.replies.filter((r) => r.route === c.route && r.matches).length > 1) {
        c.status = "FAIL";
        c.code = "DUPLICATE_REPLY";
        c.detail = "同一测试请求收到多个不同消息 ID 的合格回复。";
      }
    }
    return statusOf(this.cases);
  }
  expectMediaObservation(c, expected) {
    if (
      !this.cases.includes(c) ||
      !expected ||
      typeof expected !== "object" ||
      Array.isArray(expected) ||
      JSON.stringify(Object.keys(expected).sort()) !==
        JSON.stringify(["expectedCaption", "expectedType"]) ||
      !["image", "video"].includes(expected.expectedType) ||
      typeof expected.expectedCaption !== "string" ||
      !expected.expectedCaption ||
      expected.expectedCaption.length > 100 ||
      c.mediaObservationExpectedType
    )
      fail("MEDIA_OBSERVATION_CONFIG", "媒体观察配置无效。", "BLOCKED");
    c.mediaObservationExpectedType = expected.expectedType;
    c.mediaObservationExpectedCaptionSha256 = digest(expected.expectedCaption);
    c.mediaObservations = [];
    c.mediaObservationOverflow = false;
    c.mediaObservationClosed = false;
    this.mediaObservationWaiters.set(c.id, new Set());
    this.mediaObservationExpectations.set(c.id, {
      expectedType: expected.expectedType,
      expectedCaption: expected.expectedCaption,
    });
  }
  observeMediaMessage(c, event) {
    if (c.mediaObservationClosed || !Array.isArray(event.message)) return;
    const textSegments = event.message.filter((segment) => segment?.type === "text");
    if (
      textSegments.length !== 1 ||
      textSegments[0]?.data?.text !== this.mediaObservationExpectations.get(c.id)?.expectedCaption
    )
      return;
    const mediaSegments = event.message.filter((segment) =>
      ["image", "video"].includes(segment?.type),
    );
    const hasPayload = (segment) =>
      segment?.data &&
      typeof segment.data === "object" &&
      !Array.isArray(segment.data) &&
      ["file", "url", "file_id"].some(
        (key) =>
          typeof segment.data[key] === "string" &&
          segment.data[key].length > 0 &&
          segment.data[key].length <= 4096,
      );
    if (!mediaSegments.length || !mediaSegments.some(hasPayload)) return;
    const observedMessageId = messageId(event.message_id);
    if (!observedMessageId) return;
    if (c.mediaObservations.some((candidate) => candidate.messageId === observedMessageId)) return;
    if (c.mediaObservations.length >= 2) {
      c.mediaObservationOverflow = true;
      this.notifyMediaObservation(c.id);
      return;
    }
    c.mediaObservations.push({
      messageId: observedMessageId,
      mediaType: mediaSegments.length === 1 ? mediaSegments[0].type : null,
      captionSha256: digest(textSegments[0].data.text),
      segmentCount: event.message.length,
      receivedAt: new Date().toISOString(),
    });
    this.notifyMediaObservation(c.id);
  }
  notifyMediaObservation(caseId, error) {
    const waiters = this.mediaObservationWaiters.get(caseId);
    if (!waiters) return;
    for (const finish of [...waiters]) finish(error);
  }
  waitForMediaObservation(caseId, signal) {
    const c = this.cases.find((candidate) => candidate.id === caseId);
    if (!c?.mediaObservationExpectedType)
      fail("MEDIA_OBSERVATION_UNAVAILABLE", "本轮没有媒体观察器。", "INCONCLUSIVE");
    if (c.mediaObservations.length || c.mediaObservationOverflow) return Promise.resolve();
    if (c.mediaObservationClosed)
      fail("MEDIA_OBSERVATION_CLOSED", "媒体观察已关闭。", "INCONCLUSIVE");
    if (signal?.aborted)
      return Promise.reject(new LiveError("CANCELLED", "媒体观察已停止。", "INCONCLUSIVE"));
    return new Promise((resolve, reject) => {
      let settled = false;
      const waiters = this.mediaObservationWaiters.get(caseId);
      const onAbort = () => finish(new LiveError("CANCELLED", "媒体观察已停止。", "INCONCLUSIVE"));
      const finish = (error) => {
        if (settled) return;
        settled = true;
        waiters?.delete(finish);
        signal?.removeEventListener?.("abort", onAbort);
        if (error) reject(error);
        else resolve();
      };
      waiters?.add(finish);
      signal?.addEventListener?.("abort", onAbort, { once: true });
      if (signal?.aborted) onAbort();
    });
  }
  mediaObservationSnapshot(caseId) {
    const c = this.cases.find((candidate) => candidate.id === caseId);
    if (!c?.mediaObservationExpectedType)
      fail("MEDIA_OBSERVATION_UNAVAILABLE", "本轮没有媒体观察器。", "INCONCLUSIVE");
    return {
      candidates: c.mediaObservations.map((candidate) => ({ ...candidate })),
      overflow: c.mediaObservationOverflow,
    };
  }
  closeMediaObservation(caseId) {
    const c = this.cases.find((candidate) => candidate.id === caseId);
    if (!c?.mediaObservationExpectedType)
      fail("MEDIA_OBSERVATION_UNAVAILABLE", "本轮没有媒体观察器。", "INCONCLUSIVE");
    if (c.mediaObservationClosed) return;
    c.mediaObservationClosed = true;
    this.mediaObservationExpectations.delete(caseId);
    this.notifyMediaObservation(
      caseId,
      c.mediaObservations.length || c.mediaObservationOverflow
        ? undefined
        : new LiveError("MEDIA_OBSERVATION_CLOSED", "媒体观察在收到结果前已关闭。", "INCONCLUSIVE"),
    );
  }
}

/** These exact private read capabilities never target a QQ group. Unknown surfaces stay broad. */
export function privateAccountPreflightOnly(specs) {
  return (
    Array.isArray(specs) &&
    specs.length > 0 &&
    specs.every((spec) => {
      if (
        spec?.chat !== "private" ||
        spec.sideEffect !== "none" ||
        !Array.isArray(spec.leaseTools) ||
        spec.leaseTools.length !== 1
      )
        return false;
      const tool = spec.leaseTools[0];
      if (!Array.isArray(tool?.operations) || tool.operations.length !== 1) return false;
      const operation = tool.operations[0];
      const constraint = operation?.inputConstraint;
      if (!constraint || typeof constraint !== "object" || Array.isArray(constraint)) return false;
      return (
        (tool.name === "qq_account_status" &&
          operation.action === "account:status:read" &&
          operation.resourceId === "agent:personal" &&
          Object.keys(constraint).length === 1 &&
          constraint.operation === "get_status") ||
        (tool.name === "ops_status" &&
          operation.action === "ops:status" &&
          operation.resourceId === "agent-operations" &&
          Object.keys(constraint).length === 0)
      );
    })
  );
}

export async function doctor(config, clients, options = {}) {
  if (
    !options ||
    typeof options !== "object" ||
    Array.isArray(options) ||
    Object.keys(options).some((key) => key !== "groupAliases")
  )
    fail("PREFLIGHT_SCOPE", "实机前置检查范围无效。");
  const aliases = options.groupAliases ?? config.groups.map((group) => group.alias);
  if (
    !Array.isArray(aliases) ||
    new Set(aliases).size !== aliases.length ||
    aliases.some(
      (alias) => typeof alias !== "string" || !config.groups.some((group) => group.alias === alias),
    )
  )
    fail("PREFLIGHT_SCOPE", "实机前置检查范围无效。");
  const requiredGroups = config.groups.filter((group) => aliases.includes(group.alias));
  const result = {};
  for (const role of ["driver", "bot"]) {
    const login = await clients[role].call("get_login_info");
    if (id(login?.user_id) !== config[role].qq)
      fail("LOGIN_IDENTITY", `${role} 当前登录的 QQ 号与配置不符。`);
    const status = await clients[role].call("get_status");
    if (status?.online !== true || status?.good === false)
      fail("ACCOUNT_OFFLINE", `${role} 未确认在线。`);
    let version = null;
    try {
      const v = await clients[role].call("get_version_info");
      version = {
        appName: safeText(v?.app_name),
        appVersion: safeText(v?.app_version),
        protocolVersion: safeText(v?.protocol_version),
      };
    } catch {
      /* Version query is informational. Identity and online checks are mandatory. */
    }
    const groups = [];
    for (const g of requiredGroups) {
      // Verify both identities from the Bot's group membership view. A newly logged-in
      // NapCat driver can have an empty member cache even when it belongs to the group.
      const member = await clients.bot.call("get_group_member_info", {
        group_id: g.id,
        user_id: config[role].qq,
        no_cache: true,
      });
      if (
        id(member?.user_id) !== config[role].qq ||
        id(member?.group_id) !== g.id ||
        !["member", "admin", "owner"].includes(member?.role)
      )
        fail("GROUP_MEMBERSHIP", `${role} 在群 ${g.alias} 的成员信息未通过验证。`);
      groups.push({ alias: g.alias, role: member.role });
    }
    result[role] = {
      identityVerified: true,
      online: true,
      version,
      groups,
      groupMembershipRequired: requiredGroups.length > 0,
    };
  }
  return result;
}
function check(clients, signal, config) {
  if (signal?.aborted) fail("CANCELLED", "测试已停止。");
  for (const client of Object.values(clients)) if (client.problem) throw client.problem;
  if (Date.parse(config.safety?.armedUntil) <= Date.now())
    fail("LEASE_EXPIRED", "测试授权窗口已过期。");
}
export async function sendCase(config, clients, c) {
  const message = [];
  if (c.route !== "private") message.push({ type: "at", data: { qq: config.bot.qq } });
  message.push({ type: "text", data: { text: c.prompt } });
  c.sendAttempted = true;
  const data = await clients.driver.call(
    c.route === "private" ? "send_private_msg" : "send_group_msg",
    c.route === "private" ? { user_id: config.bot.qq, message } : { group_id: c.route, message },
  );
  c.sentMessageId = messageId(data?.message_id);
  if (!c.sentMessageId)
    fail("SEND_RECEIPT", "发送接口没有返回有效 message_id，结果未知，不会重发。", "INCONCLUSIVE");
}

async function bindInput(config, clients, c) {
  const candidates = c.botInputCandidates ?? [];
  if (candidates.length !== 1)
    fail(
      candidates.length ? "MESSAGE_BINDING_MISMATCH" : "INPUT_OBSERVER_MISSING",
      candidates.length
        ? "Bot 端观察到多个本轮输入候选，无法唯一绑定。"
        : "Bot 端未观察到本轮原始输入。",
      "INCONCLUSIVE",
    );
  const candidate = candidates[0];
  clients.bot.allowMessageRead(candidate.messageId);
  const messageType = c.route === "private" ? "private" : "group";
  const shared = {
    senderId: config.driver.qq,
    messageType,
    ...(messageType === "group" ? { groupId: c.route } : {}),
    text: c.prompt,
    afterTime: c.startedAt,
  };
  const [driverMessage, botMessage] = await Promise.all([
    boundMessage(clients.driver, c.sentMessageId, {
      ...shared,
      selfId: config.driver.qq,
    }),
    boundMessage(clients.bot, candidate.messageId, {
      ...shared,
      selfId: config.bot.qq,
      textSha256: candidate.textSha256,
    }),
  ]);
  const same = compareSameMessage(botMessage, driverMessage);
  c.inputBinding = {
    driverMessageId: driverMessage.messageId,
    botMessageId: botMessage.messageId,
    ...same,
  };
  c.inputObserved = true;
  c.botInputMessageId = botMessage.messageId;
}
export async function replyCase(
  config,
  clients,
  recorder,
  spec,
  signal,
  acceptance,
  mediaObservation,
) {
  const route =
    spec.chat === "private" ? "private" : config.groups.find((g) => g.alias === spec.chat)?.id;
  if (!route) fail("CASE_ROUTE", "测试会话没有配置。");
  const leaseCase = Array.isArray(spec.leaseTools);
  const transportOnly = spec.transportOnly === true;
  if (spec.featureAssertions !== undefined && !leaseCase)
    fail("FEATURE_CAPABILITY", "功能断言缺少服务端测试许可范围。");
  if (
    transportOnly &&
    (!leaseCase || spec.featureAssertions !== undefined || spec.leaseTools.length !== 0)
  )
    fail("TRANSPORT_ONLY_SPEC", "传输用例只能绑定空工具许可，不能包含功能断言。");
  const marker = leaseCase ? randomUUID().replaceAll("-", "") : undefined;
  const prompt = leaseCase
    ? `GLASSBOX_ACCEPTANCE_V1 {{nonce}}\n${spec.prompt.trim()}`
    : spec.prompt;
  const c = recorder.begin(spec.id, route, prompt, spec.expectContains, marker);
  if (mediaObservation !== undefined) recorder.expectMediaObservation(c, mediaObservation);
  if (transportOnly) c.transportOnly = true;
  let lease;
  let registrationAttempted = false;
  try {
    check(clients, signal, config);
    if (leaseCase) {
      if (!acceptance) fail("ACCEPTANCE_MANAGEMENT", "受限用例缺少服务端测试许可接口。");
      if (spec.featureAssertions !== undefined)
        c.featureAssertions = validateFeatureAssertions(
          JSON.parse(JSON.stringify(spec.featureAssertions).replaceAll("{{nonce}}", marker)),
        );
      const tools = JSON.parse(JSON.stringify(spec.leaseTools).replaceAll("{{nonce}}", marker));
      c.leasedToolNames = tools.map((tool) => tool.name);
      if (acceptance.beforeRegister) {
        let confirmed;
        let failed = false;
        try {
          confirmed = await acceptance.beforeRegister(c);
        } catch {
          failed = true;
        }
        check(clients, signal, config);
        if (failed || confirmed === false)
          fail("CHECKPOINT_UNCONFIRMED", "注册前的测试进度记录未确认。");
      }
      registrationAttempted = true;
      c.leaseRegistrationAttempted = true;
      lease = await acceptance.register(config, c, tools);
      c.acceptanceLease = lease;
      check(clients, signal, config);
      if (acceptance.beforeSend) {
        let confirmed;
        let failed = false;
        try {
          confirmed = await acceptance.beforeSend(c, lease);
        } catch {
          failed = true;
        }
        check(clients, signal, config);
        if (failed || confirmed === false)
          fail("CHECKPOINT_UNCONFIRMED", "发送前的测试进度记录未确认。");
      }
    }
    await sendCase(config, clients, c);
    if (leaseCase && acceptance?.afterSend) {
      let confirmed;
      let failed = false;
      try {
        confirmed = await acceptance.afterSend(c);
      } catch {
        failed = true;
      }
      check(clients, signal, config);
      if (failed || confirmed === false)
        fail(
          "SEND_CHECKPOINT_UNCONFIRMED",
          "消息已发送，但发送回执未能持久化确认，不会重发。",
          "INCONCLUSIVE",
        );
    }
    const end = Date.now() + config.timeoutMs;
    let matchedAt = 0;
    while (Date.now() < end) {
      check(clients, signal, config);
      if (c.replies.some((r) => r.route !== c.route))
        return recorder.finish(c, "FAIL", "WRONG_DESTINATION", "回复发往错误会话。");
      if (c.replies.some((r) => r.route === c.route && r.matches)) matchedAt ||= Date.now();
      if (matchedAt && Date.now() - matchedAt >= config.settleMs) {
        if (!c.inputObserved) {
          try {
            await bindInput(config, clients, c);
          } catch (error) {
            const e = safeError(error);
            return recorder.finish(c, "INCONCLUSIVE", e.code, e.message);
          }
        }
        return recorder.finish(
          c,
          "PASS",
          "REAL_REPLY_RECEIVED",
          "Bot 端观察到真实输入，发起账号收到符合断言的回复。",
        );
      }
      await sleep(50);
    }
    if (c.replies.length) {
      if (!c.inputObserved) {
        try {
          await bindInput(config, clients, c);
        } catch (error) {
          const e = safeError(error);
          return recorder.finish(c, "INCONCLUSIVE", e.code, e.message);
        }
      }
      return recorder.finish(
        c,
        "FAIL",
        "REPLY_ASSERTION_FAILED",
        "收到本轮相关回复，但内容未满足断言。",
      );
    }
    if (!c.inputObserved && c.botInputCandidates.length) {
      try {
        await bindInput(config, clients, c);
      } catch (error) {
        const e = safeError(error);
        return recorder.finish(c, "INCONCLUSIVE", e.code, e.message);
      }
    }
    return recorder.finish(
      c,
      "INCONCLUSIVE",
      c.inputObserved ? "REPLY_TIMEOUT" : "INPUT_NOT_OBSERVED",
      c.inputObserved
        ? "QQ 已送达 Bot 端，但期限内未收到可关联回复。请检查对应执行证据，不要猜测故障位置。"
        : "发送回执存在，但 Bot 端没有观察到输入。先排查 QQ 传输和事件上报。",
    );
  } catch (error) {
    const e = safeError(error);
    if (e.transportFailure) c.transportFailure = e.transportFailure;
    if (e.transportDiagnostic) c.transportDiagnostic = e.transportDiagnostic;
    return recorder.finish(c, e.status, e.code, e.message);
  } finally {
    if (registrationAttempted) {
      try {
        if (lease) await acceptance.revoke(lease.leaseId);
        else await acceptance.revokeMarker(marker);
        c.leaseRevoked = true;
      } catch {
        c.cleanup = { required: true, restored: false };
        recorder.finish(
          c,
          "INCONCLUSIVE",
          "LEASE_REVOKE_UNCONFIRMED",
          "未确认服务已撤销测试许可，必须先核实对应 Run 与许可状态。",
        );
      }
    }
  }
}
export function smokeSpecs(config) {
  return [
    { id: "private", chat: "private" },
    ...config.groups.map((g) => ({ id: `group-${g.alias}`, chat: g.alias })),
  ].map((s) => ({
    ...s,
    prompt: "这是一次 QQ 收发测试。请只回复以下测试编号，不调用工具：{{nonce}}",
    expectContains: ["{{nonce}}"],
  }));
}
export function validateSpecs(raw, config) {
  if (
    raw?.schemaVersion !== 1 ||
    !Array.isArray(raw.cases) ||
    !raw.cases.length ||
    raw.cases.length > 10
  )
    fail("SUITE_CONFIG", "自定义用例文件需要 schemaVersion=1 和 1 至 10 个 cases。");
  const names = new Set();
  for (const s of raw.cases) {
    if (!/^[a-zA-Z0-9_-]{1,50}$/.test(s.id ?? "") || names.has(s.id))
      fail("SUITE_ID", "用例 ID 无效或重复。");
    names.add(s.id);
    if (s.chat !== "private" && !config.groups.some((g) => g.alias === s.chat))
      fail("SUITE_ROUTE", "用例指定了未授权会话。");
    if (typeof s.prompt !== "string" || s.prompt.length > 4000 || !s.prompt.includes("{{nonce}}"))
      fail("SUITE_PROMPT", "每条用例必须在 prompt 中保留 {{nonce}}。");
    if (
      s.assertion !== "reply" ||
      !Array.isArray(s.expectContains) ||
      !s.expectContains.length ||
      s.expectContains.length > 8 ||
      s.expectContains.some((x) => typeof x !== "string" || !x || x.length > 1000) ||
      !s.expectContains.some((x) => x.includes("{{nonce}}"))
    )
      fail(
        "SUITE_ASSERTION",
        "自定义用例仅支持 assertion=reply，且 expectContains 必须包含 {{nonce}}。不能用文字回复证明副作用。",
      );
    if (s.sideEffect !== "none")
      fail(
        "SUITE_SIDE_EFFECT",
        "首版自定义用例只接受声明为无副作用的请求。副作用测试使用独立的固定用例。",
      );
  }
  return raw.cases;
}
