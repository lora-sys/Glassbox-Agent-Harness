import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { resolve, join } from "node:path";
import { fail, digest } from "./core.mjs";
import { boundMessage, compareSameMessage } from "./message-binding.mjs";
import { observeFeature, validateFeatureAssertions } from "./feature-observer.mjs";

export function runtimeSnapshot(runtime, capture = execFileSync) {
  return serviceSnapshot(runtime, capture, true);
}

/** Read-only recovery inspection may run while QQ awaits login; sends still use runtimeSnapshot. */
export function runtimeInspectionSnapshot(runtime, capture = execFileSync) {
  return serviceSnapshot(runtime, capture, false);
}

function serviceSnapshot(runtime, capture, requireOnebot) {
  if (
    !runtime ||
    !/^[a-f0-9]{40}$/.test(runtime.expectedCommit ?? "") ||
    !runtime.checkout ||
    !runtime.dataDirectory ||
    !validIdentifier(runtime.connectionId) ||
    (runtime.threadId !== undefined &&
      runtime.threadId !== null &&
      !validIdentifier(runtime.threadId))
  )
    fail("RUNTIME_CONFIG", "需要配置运行 checkout、数据目录、提交和 connectionId；threadId 可选。");
  const checkout = resolve(runtime.checkout);
  const dataDirectory = resolve(runtime.dataDirectory);
  const git = (args) =>
    capture("git", args, {
      cwd: checkout,
      encoding: "utf8",
      timeout: 10000,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  const commit = git(["rev-parse", "HEAD"]);
  if (commit !== runtime.expectedCommit || git(["status", "--porcelain"]))
    fail("RUNTIME_VERSION", "待测 checkout 必须干净，且 HEAD 必须等于指定提交。");
  const status = JSON.parse(
    capture(
      process.execPath,
      ["--import", "tsx", join(checkout, "scripts/agent-service.mts"), "status"],
      {
        cwd: checkout,
        encoding: "utf8",
        timeout: 30000,
        maxBuffer: 1024 * 1024,
        env: { ...process.env, GLASSBOX_DATA_DIR: dataDirectory },
        stdio: ["ignore", "pipe", "pipe"],
      },
    ),
  );
  const candidates = status.processes?.filter((p) => p.name === "glassbox") ?? [];
  if (candidates.length !== 1) fail("RUNTIME_MULTIPLE", "服务记录必须只有一个 Glassbox 进程。");
  const processInfo = candidates[0];
  if (
    resolve(status.dataDirectory ?? "") !== dataDirectory ||
    !processInfo?.running ||
    processInfo.status !== "running" ||
    !Number.isSafeInteger(processInfo.pid) ||
    resolve(processInfo.checkout ?? "") !== checkout ||
    !status.glassboxReady ||
    (requireOnebot && !status.onebotReady)
  )
    fail("RUNTIME_UNVERIFIED", "服务管理器未确认待测进程、数据目录或 OneBot 就绪。");
  if (processInfo.launchCommit !== commit || processInfo.launchClean !== true)
    fail("RUNTIME_LAUNCH_VERSION", "进程启动时未记录本次干净提交。请通过服务管理器重启待测版本。");
  return {
    checkout,
    dataDirectory,
    commit,
    pid: processInfo.pid,
    connectionId: runtime.connectionId,
    threadId: runtime.threadId ?? null,
  };
}

function validIdentifier(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 512 &&
    !Array.from(value).some((character) => character.charCodeAt(0) < 32)
  );
}

function expectedScope(c, config) {
  const runtime = config.runtime;
  if (
    !runtime ||
    !validIdentifier(runtime.connectionId) ||
    (runtime.threadId !== undefined &&
      runtime.threadId !== null &&
      !validIdentifier(runtime.threadId))
  )
    fail("RUNTIME_CONFIG", "产品证据需要有效的 connectionId 和 threadId。");
  return {
    connectionId: runtime.connectionId,
    botId: config.bot.qq,
    chatType: c.route === "private" ? "private" : "group",
    chatId: c.route === "private" ? config.driver.qq : c.route,
    senderId: config.driver.qq,
    threadId: runtime.threadId ?? null,
  };
}

function scopeKey(scope) {
  return JSON.stringify([
    scope.connectionId,
    scope.botId,
    scope.chatType,
    scope.chatId,
    scope.senderId,
    scope.threadId,
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

export function caseEvidence(db, c, config) {
  const binding = c.inputBinding;
  if (
    !binding ||
    !validIdentifier(binding.botMessageId) ||
    !validIdentifier(binding.driverMessageId) ||
    String(binding.driverMessageId) !== String(c.sentMessageId) ||
    typeof binding.realSequence !== "string" ||
    !/^\d{1,30}$/.test(binding.realSequence) ||
    !Number.isSafeInteger(binding.time) ||
    !/^[a-f0-9]{64}$/.test(binding.textSha256 ?? "")
  )
    fail("INPUT_BINDING", "没有完整的跨账号输入消息绑定。", "INCONCLUSIVE");
  const scope = expectedScope(c, config);
  const expectedScopeKey = scopeKey(scope);
  const candidates = db
    .prepare(
      "SELECT r.id, r.status, r.scope_json, r.created_at FROM runs r JOIN messages m ON m.id=r.message_id WHERE m.external_id=? AND m.scope_key=?",
    )
    .all(binding.botMessageId, expectedScopeKey);
  const matches = candidates.filter((r) => {
    const s = JSON.parse(r.scope_json);
    return scopeMatches(s, scope) && Date.parse(r.created_at) >= Date.parse(c.startedAt) - 2000;
  });
  if (matches.length !== 1 || matches[0].status !== "succeeded")
    fail("RUN_EVIDENCE", "没有唯一且成功的对应 Run。", "INCONCLUSIVE");
  const run = matches[0];
  const decisions = db
    .prepare("SELECT id, action, decision FROM authorization_decisions_all WHERE run_id=?")
    .all(run.id);
  if (
    !decisions.some((d) => d.decision === "ALLOW") ||
    decisions.some((d) => d.decision !== "ALLOW")
  )
    fail("AUTHORIZATION_EVIDENCE", "对应 Run 的授权证据不满足收发验收。", "INCONCLUSIVE");
  const deliveries = db
    .prepare("SELECT id, status, external_id, destination_scope_key FROM deliveries WHERE run_id=?")
    .all(run.id);
  const scopedDeliveries = deliveries.filter(
    (d) => d.status === "sent" && d.destination_scope_key === expectedScopeKey,
  );
  if (scopedDeliveries.length !== 1)
    fail("DELIVERY_EVIDENCE", "接收账号消息未关联到对应 Run 的成功投递。", "INCONCLUSIVE");
  return {
    caseId: c.id,
    runId: run.id,
    runCreatedAt: run.created_at,
    scope,
    decisions,
    deliveries,
    delivery: scopedDeliveries[0],
  };
}

export function verifyTraceEvidence(events, c, config, delivery) {
  const scope = expectedScope(c, config);
  if (
    !events.some(
      (e) =>
        e.type === "message_received" &&
        String(e.externalId) === c.inputBinding?.botMessageId &&
        scopeMatches(e, scope),
    ) ||
    !events.some(
      (e) =>
        e.type === "delivery_changed" &&
        e.deliveryId === delivery.id &&
        e.status === "sent" &&
        String(e.externalId) === String(delivery.external_id),
    )
  )
    fail("TRACE_EVIDENCE", "对应 Raw Trace 缺少匹配 scope 的入站或成功投递证据。", "INCONCLUSIVE");
}

export function verifyLeaseTraceEvidence(events, c, runId) {
  if (!c.featureAssertions) return;
  const sessions = events.filter((e) => e.runId === runId && e.type === "session_start");
  if (
    !/^[a-f0-9]{32}$/.test(c.token ?? "") ||
    !c.acceptanceLease?.leaseId ||
    !/^[a-f0-9]{64}$/.test(c.acceptanceLease.toolsSha256 ?? "") ||
    !Array.isArray(c.leasedToolNames) ||
    !c.leasedToolNames.length ||
    !sessions.length ||
    sessions.some((e) => {
      const lease = e.data?.acceptanceLease;
      return (
        lease?.leaseId !== c.acceptanceLease.leaseId ||
        lease.toolsSha256 !== c.acceptanceLease.toolsSha256 ||
        lease.marker !== c.token ||
        !Array.isArray(lease.narrowedTools) ||
        JSON.stringify(lease.narrowedTools) !== JSON.stringify(e.data?.authorizedTools) ||
        lease.narrowedTools.some((name) => !c.leasedToolNames.includes(name))
      );
    }) ||
    events.some(
      (e) =>
        e.runId === runId &&
        ["tool_call", "tool_result"].includes(e.type) &&
        !c.leasedToolNames.includes(e.data?.name),
    )
  )
    fail("FEATURE_LEASE_TRACE", "功能 Run 缺少对应许可和工具范围的原始证据。", "INCONCLUSIVE");
}

function sameMessageBinding(binding, evidence) {
  if (
    String(binding.realSequence) !== String(evidence.realSequence) ||
    binding.time !== evidence.time ||
    binding.textSha256 !== evidence.textSha256
  )
    fail("MESSAGE_BINDING_MISMATCH", "QQ 两端的消息证据与本轮观察不一致。", "INCONCLUSIVE");
}

export async function verifyMessageBindings(c, config, clients, delivery) {
  const binding = c.inputBinding;
  if (typeof c.prompt !== "string" || binding?.textSha256 !== digest(c.prompt))
    fail("MESSAGE_BINDING", "本轮输入消息与审批执行消息不一致。", "INCONCLUSIVE");
  const reply = c.replies.filter((r) => r.matches && r.route === c.route);
  if (reply.length !== 1 || !validIdentifier(delivery.external_id))
    fail("MESSAGE_BINDING", "没有唯一的本轮输入和投递消息。", "INCONCLUSIVE");
  const messageType = c.route === "private" ? "private" : "group";
  const groupId = messageType === "group" ? c.route : undefined;
  for (const [client, messageId] of [
    [clients.bot, binding.botMessageId],
    [clients.driver, binding.driverMessageId],
    [clients.bot, String(delivery.external_id)],
    [clients.driver, reply[0].messageId],
  ])
    client.allowMessageRead(messageId);

  const inputBot = await boundMessage(clients.bot, binding.botMessageId, {
    selfId: config.bot.qq,
    senderId: config.driver.qq,
    messageType,
    groupId,
    textSha256: binding.textSha256,
    afterTime: c.startedAt,
  });
  const inputDriver = await boundMessage(clients.driver, binding.driverMessageId, {
    selfId: config.driver.qq,
    senderId: config.driver.qq,
    messageType,
    groupId,
    textSha256: binding.textSha256,
    afterTime: c.startedAt,
  });
  const inputMatch = compareSameMessage(inputBot, inputDriver);
  sameMessageBinding(binding, inputMatch);

  const expected = {
    messageType,
    groupId,
    contains: c.expected,
    textSha256: reply[0].textSha256,
    afterTime: c.startedAt,
  };
  const replyBot = await boundMessage(clients.bot, String(delivery.external_id), {
    ...expected,
    selfId: config.bot.qq,
    senderId: config.bot.qq,
  });
  const replyDriver = await boundMessage(clients.driver, reply[0].messageId, {
    ...expected,
    selfId: config.driver.qq,
    senderId: config.bot.qq,
  });
  const finalReplies = c.replies.filter((r) => r.matches && r.route === c.route);
  if (
    finalReplies.length !== 1 ||
    finalReplies[0].messageId !== reply[0].messageId ||
    finalReplies[0].textSha256 !== reply[0].textSha256
  )
    fail("OBSERVATION_CHANGED", "产品证据查询期间收到新的匹配回复。", "INCONCLUSIVE");
  const replyMatch = compareSameMessage(replyBot, replyDriver);
  return { input: inputMatch, reply: replyMatch };
}

export function readTraceEvents(
  checkout,
  dataDirectory,
  runId,
  capture = execFileSync,
  featureTypes = [],
) {
  if (featureTypes.length)
    validateFeatureAssertions(
      featureTypes.map((type) => ({ kind: "trace", type, where: { name: "fixture" }, count: 1 })),
    );
  return JSON.parse(
    capture(
      process.execPath,
      [
        join(checkout, ".agents/skills/glassbox-ops/scripts/gbxtrace.mjs"),
        "events",
        runId,
        "--type",
        "message_received",
        "--type",
        "delivery_changed",
        "--type",
        "session_start",
        "--type",
        "tool_call",
        "--type",
        "tool_result",
        ...[...new Set(featureTypes)].flatMap((type) => ["--type", type]),
        "--json",
        "--data-dir",
        join(dataDirectory, "runs"),
      ],
      {
        encoding: "utf8",
        timeout: 10000,
        maxBuffer: 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
      },
    ),
  );
}

export async function verifyProductEvidence(report, config, clients) {
  const after = runtimeSnapshot(config.runtime);
  const before = report.runtime;
  if (!before || JSON.stringify(before) !== JSON.stringify(after))
    fail("RUNTIME_CHANGED", "测试期间服务进程或代码版本发生变化。", "INCONCLUSIVE");
  if (report.status !== "PASS" || report.mode !== "run" || report.cases.some((c) => c.moderation))
    fail("ACCEPTANCE_SCOPE", "产品证据验收仅支持通过的固定收发用例。");
  const db = new DatabaseSync(join(after.dataDirectory, "glassbox.db"), {
    readOnly: true,
  });
  try {
    const cases = [];
    for (const c of report.cases) {
      const evidence = caseEvidence(db, c, config);
      const messageBinding = await verifyMessageBindings(c, config, clients, evidence.delivery);
      const featureTypes =
        c.featureAssertions?.filter((a) => a.kind === "trace").map((a) => a.type) ?? [];
      if (c.featureAssertions?.some((a) => ["history_coverage", "history_result"].includes(a.kind)))
        featureTypes.push("history_retrieval");
      const trace = readTraceEvents(
        after.checkout,
        after.dataDirectory,
        evidence.runId,
        execFileSync,
        featureTypes,
      );
      const events = trace.events?.map((row) => row.event) ?? [];
      verifyTraceEvidence(events, c, config, evidence.delivery);
      verifyLeaseTraceEvidence(events, c, evidence.runId);
      const feature = c.featureAssertions
        ? observeFeature(c.featureAssertions, { db, events, runId: evidence.runId })
        : undefined;
      await verifyGroupMemberCountEvidence(c, feature, config, clients, events, evidence.runId);
      cases.push({
        ...evidence,
        messageBinding,
        traceVerified: true,
        ...(feature ? { feature } : {}),
      });
    }
    const finalRuntime = runtimeSnapshot(config.runtime);
    if (JSON.stringify(after) !== JSON.stringify(finalRuntime))
      fail("RUNTIME_CHANGED", "测试期间服务进程或代码版本发生变化。", "INCONCLUSIVE");
    return { status: "PASS", runtime: after, cases };
  } finally {
    db.close();
  }
}

export async function verifyGroupMemberCountEvidence(
  c,
  feature,
  config,
  clients,
  events = [],
  runId,
) {
  const assertions =
    c.featureAssertions?.filter(
      (assertion) =>
        assertion.kind === "aggregate_projection" && assertion.tool === "qq_group_members",
    ) ?? [];
  const hasMemberToolActivity = events.some(
    (event) =>
      event.runId === runId &&
      ["tool_call", "tool_result"].includes(event.type) &&
      event.data?.name === "qq_group_members",
  );
  if (!hasMemberToolActivity && assertions.length === 0) return;
  if (assertions.length !== 1 || assertions[0].count !== 1)
    fail(
      "MEMBER_COUNT_ASSERTION_MISSING",
      "成员工具 Trace 缺少固定的聚合数量断言。",
      "INCONCLUSIVE",
    );
  if (c.route !== "private" || config.groups?.filter((group) => group.alias === "A").length !== 1)
    fail("MEMBER_COUNT_SCOPE", "成员数量验证不在固定私聊和测试群范围内。", "INCONCLUSIVE");
  const memberCalls = events.filter(
    (event) =>
      event.runId === runId &&
      event.type === "tool_call" &&
      event.data?.name === "qq_group_members",
  );
  const memberResults = events.filter(
    (event) =>
      event.runId === runId &&
      event.type === "tool_result" &&
      event.data?.name === "qq_group_members",
  );
  if (memberCalls.length !== 1 || memberResults.length !== 1)
    fail("MEMBER_COUNT_TRACE", "成员数量工具缺少唯一的同 Run 调用和结果。", "INCONCLUSIVE");
  const [call] = memberCalls;
  const [result] = memberResults;
  const input = call.data?.input;
  const groupId = config.groups.find((group) => group.alias === "A").id;
  if (
    !call.toolCallId ||
    call.toolCallId !== result.toolCallId ||
    call.data.toolCallId !== call.toolCallId ||
    result.data.toolCallId !== result.toolCallId ||
    result.data.isError !== false ||
    !input ||
    Array.isArray(input) ||
    typeof input !== "object" ||
    Object.keys(input).some((key) => !["groupId", "operation", "params"].includes(key)) ||
    input.groupId !== groupId ||
    input.operation !== "get_group_member_list" ||
    (input.params !== undefined &&
      (!input.params ||
        Array.isArray(input.params) ||
        typeof input.params !== "object" ||
        Object.keys(input.params).length !== 0))
  )
    fail("MEMBER_COUNT_TRACE", "成员数量工具调用未绑定到群 A 名单读取。", "INCONCLUSIVE");
  const observations =
    feature?.observations?.filter(
      (observation) =>
        observation.kind === "aggregate_projection" && observation.tool === "qq_group_members",
    ) ?? [];
  if (
    observations.length !== 1 ||
    !Number.isSafeInteger(observations[0].memberCount) ||
    observations[0].memberCount < 0
  )
    fail("MEMBER_COUNT_EVIDENCE", "Trace 未提供唯一的成员数量观察。", "INCONCLUSIVE");
  if (typeof clients.bot?.readGroupMemberCount !== "function")
    fail("MEMBER_COUNT_UNAVAILABLE", "无法独立确认固定测试群成员数量。", "INCONCLUSIVE");
  let currentCount;
  try {
    currentCount = await clients.bot.readGroupMemberCount();
  } catch {
    fail("MEMBER_COUNT_UNAVAILABLE", "无法独立确认固定测试群成员数量。", "INCONCLUSIVE");
  }
  if (!Number.isSafeInteger(currentCount) || currentCount < 0)
    fail("MEMBER_COUNT_INVALID", "固定测试群成员数量响应无效。", "INCONCLUSIVE");
  if (currentCount !== observations[0].memberCount)
    fail("MEMBER_COUNT_CHANGED", "Trace 成员数量与独立读取结果不同。", "INCONCLUSIVE");
}
