import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { resolve, join } from "node:path";
import { fail } from "./core.mjs";

export function runtimeSnapshot(runtime, capture = execFileSync) {
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
    !status.onebotReady
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
  const scope = expectedScope(c, config);
  const expectedScopeKey = scopeKey(scope);
  const candidates = db
    .prepare(
      "SELECT r.id, r.status, r.scope_json, r.created_at FROM runs r JOIN messages m ON m.id=r.message_id WHERE m.external_id=? AND m.scope_key=?",
    )
    .all(c.sentMessageId, expectedScopeKey);
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
  const replies = c.replies.filter((r) => r.matches && r.route === c.route);
  const matchingDeliveries = deliveries.filter(
    (d) =>
      d.status === "sent" &&
      String(d.external_id) === replies[0]?.messageId &&
      d.destination_scope_key === expectedScopeKey,
  );
  if (replies.length !== 1 || matchingDeliveries.length !== 1)
    fail("DELIVERY_EVIDENCE", "接收账号消息未关联到对应 Run 的成功投递。", "INCONCLUSIVE");
  return { caseId: c.id, runId: run.id, decisions, deliveries, delivery: matchingDeliveries[0] };
}

export function verifyTraceEvidence(events, c, config, delivery) {
  const scope = expectedScope(c, config);
  if (
    !events.some(
      (e) =>
        e.type === "message_received" &&
        String(e.externalId) === c.sentMessageId &&
        scopeMatches(e, scope),
    ) ||
    !events.some(
      (e) =>
        e.type === "delivery_changed" &&
        e.deliveryId === delivery.id &&
        e.status === "sent" &&
        c.replies.some(
          (r) => r.matches && r.route === c.route && r.messageId === String(e.externalId),
        ),
    )
  )
    fail("TRACE_EVIDENCE", "对应 Raw Trace 缺少匹配 scope 的入站或成功投递证据。", "INCONCLUSIVE");
}

export function verifyProductEvidence(report, config) {
  const after = runtimeSnapshot(config.runtime);
  const before = report.runtime;
  if (!before || JSON.stringify(before) !== JSON.stringify(after))
    fail("RUNTIME_CHANGED", "测试期间服务进程或代码版本发生变化。", "INCONCLUSIVE");
  if (report.status !== "PASS" || report.mode !== "run" || report.cases.some((c) => c.moderation))
    fail("ACCEPTANCE_SCOPE", "产品证据验收仅支持通过的固定收发用例。");
  const db = new DatabaseSync(join(after.dataDirectory, "glassbox.db"), { readOnly: true });
  try {
    const cases = report.cases.map((c) => {
      const evidence = caseEvidence(db, c, config);
      const trace = JSON.parse(
        execFileSync(
          process.execPath,
          [
            join(after.checkout, ".agents/skills/glassbox-ops/scripts/gbxtrace.mjs"),
            "events",
            evidence.runId,
            "--type",
            "message_received",
            "--type",
            "delivery_changed",
            "--json",
            "--data-dir",
            after.dataDirectory,
          ],
          {
            encoding: "utf8",
            timeout: 10000,
            maxBuffer: 1024 * 1024,
            stdio: ["ignore", "pipe", "pipe"],
          },
        ),
      );
      const events = trace.events?.map((row) => row.event) ?? [];
      verifyTraceEvidence(events, c, config, evidence.delivery);
      return { ...evidence, traceVerified: true };
    });
    return { status: "PASS", runtime: after, cases };
  } finally {
    db.close();
  }
}
