#!/usr/bin/env node
// gbxtrace.mjs — Glassbox run / raw-trace 调试 CLI（零依赖，Node >= 24）
//
// 存在的原因：排查 Glassbox 问题时，每次临时写脚本解析 ~/.glassbox/runs/<runId>/trace.jsonl
// 既慢又不一致。这个 CLI 把"起环境、找 run、看 trace、溯源"固定成确定性命令。
//
// 只读：本 CLI 只读取 trace 文件，不写任何数据。Raw Trace 是不可变证据，永远不要改写它。
// 数据目录解析顺序与服务启动器一致：--data-dir > GLASSBOX_DATA_DIR > ~/.glassbox/runs > <repo>/.glassbox/runs

import { promises as fs } from "node:fs";
import { createConnection } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_PORT = 3030;

// ---------------------------------------------------------------- 数据目录解析

function repoRootFromHere() {
  // <repo>/.agents/skills/glassbox-ops/scripts/gbxtrace.mjs -> 上溯 5 层
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../..");
}

async function resolveRunsDir(flagValue) {
  const candidates = [];
  if (flagValue) candidates.push(path.resolve(flagValue));
  if (process.env.GLASSBOX_DATA_DIR) candidates.push(path.resolve(process.env.GLASSBOX_DATA_DIR));
  candidates.push(path.join(os.homedir(), ".glassbox", "runs"));
  candidates.push(path.join(repoRootFromHere(), ".glassbox", "runs"));
  for (const dir of candidates) {
    try {
      const stat = await fs.stat(dir);
      if (stat.isDirectory()) return { dir, source: candidates.indexOf(dir) };
    } catch {
      // 尝试下一个候选
    }
  }
  return { dir: candidates[0], source: -1 };
}

// ---------------------------------------------------------------- trace 读取

/** 读取一个 run 的 trace.jsonl。容错：坏行记入 malformed，不中断；校验 seq 连续性。 */
async function readTrace(runDir) {
  const file = path.join(runDir, "trace.jsonl");
  let content;
  try {
    content = await fs.readFile(file, "utf8");
  } catch {
    return { entries: [], malformed: 0, seqGaps: [], exists: false };
  }
  const entries = [];
  let malformed = 0;
  const seqGaps = [];
  let expectedSeq = 1;
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      malformed += 1;
      continue;
    }
    if (parsed && typeof parsed === "object" && parsed.event) {
      if (typeof parsed.seq === "number" && parsed.seq !== expectedSeq) {
        seqGaps.push({ expected: expectedSeq, got: parsed.seq });
      }
      if (typeof parsed.seq === "number") expectedSeq = parsed.seq + 1;
      entries.push(parsed);
    } else {
      malformed += 1;
    }
  }
  return { entries, malformed, seqGaps, exists: true };
}

/** 列出 runs 目录，按修改时间倒序。 */
async function listRuns(runsDir) {
  let names;
  try {
    names = await fs.readdir(runsDir);
  } catch {
    return [];
  }
  const runs = [];
  for (const name of names) {
    const dir = path.join(runsDir, name);
    try {
      const stat = await fs.stat(dir);
      if (!stat.isDirectory()) continue;
      runs.push({ runId: name, dir, mtimeMs: stat.mtimeMs });
    } catch {
      // 跳过不可读目录
    }
  }
  runs.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return runs;
}

/** 从 trace 提取 run 概要：状态、起止时间、事件数、会话与主体。 */
function summarizeRun(trace) {
  const entries = trace.entries;
  const finished = entries.find((e) => e.event.type === "run_finished");
  const started = entries.find((e) => e.event.type === "run_started");
  const first = entries[0];
  const session = entries.find((e) => e.event.type === "session_start");
  const last = entries[entries.length - 1];
  const startTs = first?.ts ? Date.parse(first.ts) : NaN;
  const endTs = finished?.ts ? Date.parse(finished.ts) : last?.ts ? Date.parse(last.ts) : NaN;
  return {
    status: finished?.event?.status ?? (entries.length === 0 ? "empty" : "unfinished"),
    startedAt: first?.ts ?? null,
    durationMs:
      Number.isFinite(startTs) && Number.isFinite(endTs) ? Math.max(0, endTs - startTs) : null,
    events: entries.length,
    conversationId: finished?.event?.conversationId ?? started?.event?.conversationId ?? null,
    principalId: session?.event?.principalId ?? null,
    sessionId: session?.event?.sessionId ?? null,
    outputWithheld: finished?.event?.outputWithheld ?? null,
  };
}

// ---------------------------------------------------------------- 输出辅助

const C = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
};
const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code, text) => (useColor ? `${code}${text}${C.reset}` : text);

function short(id, head = 8) {
  return typeof id === "string" && id.length > head ? id.slice(0, head) : String(id ?? "-");
}

function fmtTime(ts) {
  if (!ts) return "-";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return String(ts);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function fmtDuration(ms) {
  if (ms == null) return "-";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s`;
}

function fmtEventTime(ts) {
  if (!ts) return "--:--:--.---";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return String(ts);
  const pad = (n, w = 2) => String(n).padStart(w, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

function fmtAgo(ts) {
  if (!ts) return "-";
  const diff = Date.now() - Date.parse(ts);
  if (!Number.isFinite(diff)) return "-";
  if (diff < 0) return "future";
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function compact(value, limit = 200) {
  let text;
  try {
    text = typeof value === "string" ? value : JSON.stringify(value);
  } catch {
    text = String(value);
  }
  text = text ?? "";
  return text.length > limit ? `${text.slice(0, limit)}…[+${text.length - limit}]` : text;
}

function statusColor(status) {
  if (status === "succeeded") return paint(C.green, status);
  if (status === "failed") return paint(C.red, status);
  return paint(C.yellow, status);
}

/** 单事件的单行摘要。trace 事件的字段分两派：顶层字段与 data 字段，两边都看。 */
function eventSummary(entry) {
  const ev = entry.event ?? {};
  const data = ev.data ?? {};
  const pick = (...keys) => {
    for (const k of keys) {
      if (ev[k] !== undefined) return ev[k];
      if (data[k] !== undefined) return data[k];
    }
    return undefined;
  };
  const str = (v) => (typeof v === "string" ? v : v === undefined ? undefined : JSON.stringify(v));
  const usage = pick("usage");
  switch (ev.type) {
    case "run_queued":
    case "run_started":
      return `conv=${short(ev.conversationId ?? data.conversationId)}`;
    case "run_finished":
      return `status=${ev.status} outputWithheld=${ev.outputWithheld ?? data.outputWithheld ?? "-"}`;
    case "session_start": {
      const runtime = pick("runtime") ?? {};
      const skills = Array.isArray(runtime.enabledSkills) ? runtime.enabledSkills.length : 0;
      return `session=${short(ev.sessionId)} principal=${ev.principalId ?? data.principalId ?? "-"} profile=${runtime.profileName ?? "-"} pi=${runtime.piVersion ?? "-"} skills=${skills}`;
    }
    case "session_end":
      return `session=${short(ev.sessionId)}`;
    case "turn_start":
      return `session=${short(ev.sessionId)}`;
    case "turn_end": {
      const provider = str(pick("provider"));
      const model = str(pick("model"));
      const toolResults = pick("toolResultCount");
      const u = usage && typeof usage === "object" ? usage : {};
      const parts = [];
      if (provider || model) parts.push(`${provider ?? "-"}/${model ?? "-"}`);
      if (u.inputTokens !== undefined)
        parts.push(
          `in=${u.inputTokens} out=${u.outputTokens ?? "?"} total=${u.totalTokens ?? "?"}`,
        );
      if (toolResults !== undefined) parts.push(`toolResults=${toolResults}`);
      return parts.join(" ") || `session=${short(ev.sessionId)}`;
    }
    case "message_chunk": {
      const text = str(pick("text", "delta")) ?? "";
      return text ? `text(${text.length}) ${compact(text, 120)}` : "chunk";
    }
    case "tool_call": {
      const name = str(pick("name", "toolName")) ?? "?";
      const input = pick("input", "arguments", "args");
      return input !== undefined
        ? `${name} input=${compact(input, 160)}`
        : `${name} (call=${short(ev.toolCallId ?? data.toolCallId, 14)})`;
    }
    case "tool_result": {
      const name = str(pick("name", "toolName")) ?? "?";
      const isError = pick("isError");
      const failureCode = str(pick("failureCode"));
      const output = pick("output", "result", "content");
      if (isError) return paint(C.red, `ERROR ${name} failureCode=${failureCode ?? "-"}`);
      return output !== undefined ? `${name} output=${compact(output, 160)}` : `${name} (ok)`;
    }
    case "tool_evidence":
      return `phase=${pick("phase") ?? "-"} ${compact(pick("required", "resolutions") ?? {}, 140)}`;
    case "routing_decision": {
      const exec = str(pick("executionRef")) ?? "-";
      const reason = str(pick("reason"));
      const risk = str(pick("taskRisk"));
      const tokens = pick("demand")?.estimatedMaterialTokens;
      return `exec=${exec} reason=${reason ?? "-"} risk=${risk ?? "-"} demandTokens=${tokens ?? "-"} fallback=${pick("usedFallback") ?? "-"} policy=${str(pick("policyVersion")) ?? "-"}`;
    }
    case "routing_eval_evidence":
      return `decision=${str(pick("decisionExecutionRef")) ?? "-"} actual=${str(pick("actualExecutionRef")) ?? "-"} model=${str(pick("actualModel")) ?? "-"} fallbackSelected=${pick("fallbackSelected") ?? "-"} capabilityFloor=${pick("capabilityFloor") ?? "-"}`;
    case "runtime_health_observation": {
      const state = String(pick("state") ?? "-");
      const colored =
        state === "unavailable"
          ? paint(C.red, state)
          : state === "healthy"
            ? paint(C.green, state)
            : state;
      return `exec=${str(pick("executionRef")) ?? "-"} state=${colored} latency=${pick("latencyMs") ?? "-"}ms reason=${str(pick("reasonCode")) ?? "-"}`;
    }
    case "runtime_usage": {
      const u = (usage && typeof usage === "object" ? usage : {}) ?? {};
      const v = (k) => (u[k] && typeof u[k] === "object" ? u[k].value : u[k]);
      return `in=${v("inputTokens") ?? "?"} out=${v("outputTokens") ?? "?"} cacheRead=${v("cacheReadTokens") ?? "?"} total=${v("totalTokens") ?? "?"}`;
    }
    case "context_budget":
      return `demand=${pick("demandTokens") ?? "-"} projected=${pick("projectedTokens") ?? "-"} window=${pick("contextWindowTokens") ?? "-"} included=${pick("includedExchangeCount") ?? "-"} omitted=${pick("omittedExchangeCount") ?? "-"} policy=${str(pick("policyVersion")) ?? "-"}`;
    case "learning_context":
      return `scope=${str(pick("scopeType")) ?? "-"} status=${str(pick("status")) ?? "-"} memoryIds=${(pick("memoryIds") ?? []).length}`;
    case "history_retrieval": {
      const coverage = pick("coverage") ?? {};
      return `mode=${str(pick("retrievalMode")) ?? "-"} considered=${pick("considered") ?? "-"} returned=${coverage.returned ?? "-"} coverage=${coverage.coverage ?? "-"} truncated=${pick("truncated") ?? false} groups=${(pick("groups") ?? []).join(",") || "-"}`;
    }
    case "delivery_changed":
      return `delivery=${short(ev.deliveryId ?? data.deliveryId)} status=${ev.status ?? data.status ?? "-"}`;
    case "delivery_blocked":
      return paint(
        C.yellow,
        `reasons=${JSON.stringify(pick("reasons") ?? [])} bytes=${pick("candidateBytes") ?? "-"} sha=${short(ev.candidateSha256 ?? data.candidateSha256, 12)}`,
      );
    case "delivery_denied":
      return paint(
        C.red,
        `decision=${str(pick("decision")) ?? "-"} reason=${str(pick("reason")) ?? "-"} audience=${str(pick("audience")) ?? "-"}`,
      );
    case "native_group_role_observed":
      return `group=${short(pick("groupId"), 10)} sender=${short(pick("senderId"), 10)} role=${str(pick("observedRole")) ?? "-"} source=${str(pick("roleSource")) ?? "-"}`;
    case "native_group_role_verification":
      return `group=${short(pick("groupId"), 10)} verified=${str(pick("verifiedRole")) ?? "-"} status=${str(pick("status")) ?? "-"}`;
    case "media_generation_completed":
      return `provider=${str(pick("provider")) ?? "-"} mediaType=${str(pick("mediaType")) ?? "-"} assets=${(pick("assetIds") ?? []).length}`;
    case "learning_candidate_created":
      return compact(pick("candidate") ?? data, 140);
    default: {
      const rest = { ...ev };
      delete rest.type;
      delete rest.runId;
      delete rest.conversationId;
      delete rest.sessionId;
      delete rest.timestamp;
      delete rest.ts;
      delete rest.seq;
      delete rest.provenance;
      return compact(rest, 180);
    }
  }
}

function eventMarker(entry) {
  const ev = entry.event ?? {};
  const data = ev.data ?? {};
  if (ev.type === "run_finished" && ev.status !== "succeeded") return paint(C.red, "✗");
  if (ev.type === "delivery_blocked" || ev.type === "delivery_denied") return paint(C.yellow, "!");
  if (ev.type === "tool_result" && (ev.isError ?? data.isError)) return paint(C.red, "✗");
  if (ev.type === "runtime_health_observation" && ev.state === "unavailable")
    return paint(C.red, "✗");
  return " ";
}

function printEvent(entry, { full = false } = {}) {
  const ev = entry.event ?? {};
  const marker = eventMarker(entry);
  const time = fmtEventTime(entry.ts);
  if (full) {
    console.log(
      `${marker} ${paint(C.dim, String(entry.seq).padStart(4))} ${paint(C.dim, time)} ${paint(C.bold, ev.type ?? "?")}`,
    );
    console.log(`     ${JSON.stringify(ev)}`);
  } else {
    console.log(
      `${marker} ${paint(C.dim, String(entry.seq).padStart(4))} ${paint(C.dim, time)} ${paint(C.bold, (ev.type ?? "?").padEnd(28).slice(0, 28))} ${eventSummary(entry)}`,
    );
  }
}

// ---------------------------------------------------------------- 参数解析

function parseFlags(argv) {
  const flags = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--json") flags.json = true;
    else if (arg === "--full") flags.full = true;
    else if (arg === "--watch") flags.watch = true;
    else if (
      arg === "--limit" ||
      arg === "--last" ||
      arg === "--type" ||
      arg === "--status" ||
      arg === "--data-dir" ||
      arg === "--pattern"
    ) {
      const key = arg.slice(2);
      const value = argv[i + 1];
      if (value === undefined) exitWithError(`${arg} 需要一个值`);
      i += 1;
      if (key === "type") (flags.types ??= []).push(value);
      else flags[key] = value;
    } else if (arg.startsWith("--")) {
      exitWithError(`未知选项 ${arg}`);
    } else {
      flags._.push(arg);
    }
  }
  return flags;
}

function exitWithError(message) {
  console.error(paint(C.red, `错误: ${message}`));
  process.exit(2);
}

function num(value, fallback) {
  const n = Number.parseInt(value ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// ---------------------------------------------------------------- 命令实现

async function cmdEnv(runsDir) {
  let runCount = 0;
  let totalBytes = 0;
  let newest = null;
  try {
    const runs = await listRuns(runsDir);
    runCount = runs.length;
    newest = runs[0] ?? null;
    for (const run of runs.slice(0, 200)) {
      try {
        totalBytes += (await fs.stat(path.join(run.dir, "trace.jsonl"))).size;
      } catch {
        // 无 trace 文件的 run 不计体积
      }
    }
  } catch {
    // 目录不可读
  }
  const dataDir = path.dirname(runsDir);
  const tokenPath = path.join(dataDir, "management-token");
  let tokenPresent = false;
  try {
    tokenPresent = (await fs.stat(tokenPath)).isFile();
  } catch {
    // 没有 token 文件
  }
  const port = await resolveServicePort(dataDir);
  const portReachable = await checkPort(port);
  const info = {
    runsDir,
    runCount,
    newestRun: newest?.runId ?? null,
    newestRunAt: newest ? new Date(newest.mtimeMs).toISOString() : null,
    traceBytesSampled: totalBytes,
    managementTokenFile: tokenPresent,
    servicePort: port,
    serviceReachable: portReachable,
    node: process.version,
    platform: process.platform,
  };
  if (flagsGlobal.json) {
    console.log(JSON.stringify(info, null, 2));
    return;
  }
  console.log(paint(C.bold, "Glassbox 调试环境"));
  console.log(`  数据目录(runs):   ${runsDir}`);
  console.log(`  本地 run 数量:    ${runCount}`);
  console.log(
    `  最新 run:         ${newest ? `${short(newest.runId)} (${fmtAgo(new Date(newest.mtimeMs).toISOString())})` : "-"}`,
  );
  console.log(`  trace 体积(采样200个run): ${(totalBytes / 1024).toFixed(0)} KiB`);
  console.log(`  管理 token 文件:  ${tokenPresent ? "存在" : "缺失（glassbox CLI 需要它）"}`);
  console.log(
    `  服务端口 :${port}  ${portReachable ? paint(C.green, "可达") : paint(C.dim, "不可达（服务未启动？用 npm run agent:up）")}`,
  );
  console.log(`  Node:             ${process.version}`);
}

/**
 * 服务端口解析顺序与服务端一致：PORT 环境变量 → service-launch.json 的
 * glassbox.env.PORT（服务启动器注入的真实端口）→ 默认 3030。
 */
async function resolveServicePort(dataDir) {
  if (process.env.PORT && /^\d{1,5}$/u.test(process.env.PORT)) return Number(process.env.PORT);
  try {
    const launch = JSON.parse(await fs.readFile(path.join(dataDir, "service-launch.json"), "utf8"));
    const port = launch?.glassbox?.env?.PORT;
    if (port && /^\d{1,5}$/u.test(String(port))) return Number(port);
  } catch {
    // 没有或读不到 launch 配置，走默认
  }
  return DEFAULT_PORT;
}

function checkPort(port) {
  return new Promise((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    const done = (result) => {
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(1000);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

async function cmdRuns(runsDir) {
  const limit = num(flagsGlobal.limit, 20);
  // 带 --status 过滤时扫更大的池子，否则"最近的 20 个"可能全是 succeeded，失败的被挡在池外
  const pool = flagsGlobal.status ? 200 : limit;
  const runs = (await listRuns(runsDir)).slice(0, Math.max(pool, limit));
  const rows = [];
  for (const run of runs) {
    const trace = await readTrace(run.dir);
    const summary = summarizeRun(trace);
    if (flagsGlobal.status && summary.status !== flagsGlobal.status) continue;
    rows.push({ runId: run.runId, mtimeMs: run.mtimeMs, ...summary });
    if (rows.length >= limit) break;
  }
  if (flagsGlobal.json) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }
  if (rows.length === 0) {
    console.log(
      paint(C.dim, `没有匹配的 run（status=${flagsGlobal.status ?? "any"}，目录: ${runsDir}）`),
    );
    return;
  }
  console.log(paint(C.bold, `${rows.length} 个 run（按最近活动排序）`));
  console.log(
    paint(
      C.dim,
      "RUN ID    STARTED              STATUS      DURATION  EVENTS  CONVERSATION  PRINCIPAL",
    ),
  );
  for (const row of rows) {
    console.log(
      `${short(row.runId)}  ${fmtTime(row.startedAt).padEnd(19)}  ${statusColor(row.status).padEnd(10 + colorPad(row.status))}  ${fmtDuration(row.durationMs).padStart(8)}  ${String(row.events).padStart(6)}  ${short(row.conversationId).padEnd(12)}  ${row.principalId ?? "-"}`,
    );
  }
  console.log(paint(C.dim, "用 gbxtrace show <runId> 查看完整时间线。"));
}

// statusColor 在无 TTY 时不加 ANSI 码，padEnd 按原长度即可；有 TTY 时颜色码不计入显示宽度。
function colorPad(text) {
  return useColor ? 0 : 0;
}

async function resolveRunArg(runsDir, runIdArg) {
  if (runIdArg) {
    const dir = path.join(runsDir, runIdArg);
    try {
      if ((await fs.stat(dir)).isDirectory()) return { runId: runIdArg, dir };
    } catch {
      // 走前缀匹配
    }
    const runs = await listRuns(runsDir);
    const matches = runs.filter((r) => r.runId.startsWith(runIdArg));
    if (matches.length === 1) return matches[0];
    if (matches.length > 1)
      exitWithError(`runId 前缀 "${runIdArg}" 匹配到 ${matches.length} 个 run，请给更长的前缀`);
    exitWithError(`找不到 run: ${runIdArg}（数据目录 ${runsDir}）`);
  }
  const runs = await listRuns(runsDir);
  if (runs.length === 0) exitWithError(`数据目录没有 run: ${runsDir}`);
  return runs[0];
}

async function cmdShow(runsDir) {
  const run = await resolveRunArg(runsDir, flagsGlobal._[0]);
  const trace = await readTrace(run.dir);
  const summary = summarizeRun(trace);
  if (trace.entries.length === 0) {
    console.log(
      paint(
        C.yellow,
        `run ${run.runId} 没有可读的 trace 事件（${path.join(run.dir, "trace.jsonl")}）`,
      ),
    );
    return;
  }
  if (flagsGlobal.json) {
    console.log(
      JSON.stringify(
        {
          runId: run.runId,
          summary,
          integrity: { malformed: trace.malformed, seqGaps: trace.seqGaps },
          events: trace.entries,
        },
        null,
        2,
      ),
    );
    return;
  }
  console.log(paint(C.bold, `RUN ${run.runId}`));
  console.log(`  状态:        ${statusColor(summary.status)}`);
  console.log(`  开始:        ${fmtTime(summary.startedAt)} (${fmtAgo(summary.startedAt)})`);
  console.log(`  时长:        ${fmtDuration(summary.durationMs)}`);
  console.log(`  事件数:      ${summary.events}`);
  console.log(`  conversation:${summary.conversationId ?? "-"}`);
  console.log(`  session:     ${summary.sessionId ?? "-"}`);
  console.log(`  principal:   ${summary.principalId ?? "-"}`);
  console.log("");
  // 折叠连续的 message_chunk，除非 --full
  let collapsed = 0;
  let collapsedChars = 0;
  for (const entry of trace.entries) {
    const type = entry.event?.type;
    if (!flagsGlobal.full && type === "message_chunk") {
      collapsed += 1;
      collapsedChars += String(entry.event?.data?.text ?? entry.event?.text ?? "").length;
      continue;
    }
    if (collapsed > 0) {
      console.log(
        paint(
          C.dim,
          `  … ${collapsed} 个 message_chunk（助手文本共 ${collapsedChars} 字符，--full 展开）`,
        ),
      );
      collapsed = 0;
      collapsedChars = 0;
    }
    printEvent(entry);
  }
  if (collapsed > 0) {
    console.log(
      paint(
        C.dim,
        `  … ${collapsed} 个 message_chunk（助手文本共 ${collapsedChars} 字符，--full 展开）`,
      ),
    );
  }
  if (trace.malformed > 0 || trace.seqGaps.length > 0) {
    console.log("");
    console.log(
      paint(
        C.yellow,
        `完整性警告: ${trace.malformed} 行无法解析, seq 断点 ${trace.seqGaps.length} 处`,
      ),
    );
    console.log(
      paint(
        C.dim,
        "  Raw Trace 是只读证据；如需继续写入，先停止服务再排查，不要手工修补 trace 文件。",
      ),
    );
  }
}

async function cmdEvents(runsDir) {
  const run = await resolveRunArg(runsDir, flagsGlobal._[0]);
  const types = flagsGlobal.types ?? [];
  const trace = await readTrace(run.dir);
  const entries =
    types.length > 0 ? trace.entries.filter((e) => types.includes(e.event?.type)) : trace.entries;
  if (flagsGlobal.json) {
    console.log(
      JSON.stringify({ runId: run.runId, matched: entries.length, events: entries }, null, 2),
    );
    return;
  }
  if (entries.length === 0) {
    console.log(
      paint(
        C.dim,
        `run ${run.runId} 没有 ${types.length ? `类型为 ${types.join(", ")} 的` : ""}事件`,
      ),
    );
    return;
  }
  console.log(
    paint(
      C.bold,
      `run ${short(run.runId)}: ${entries.length} 个事件${types.length ? `（类型 ${types.join(", ")}）` : ""}`,
    ),
  );
  for (const entry of entries) printEvent(entry, { full: flagsGlobal.full });
}

async function cmdGrep(runsDir) {
  const pattern = flagsGlobal._[0];
  if (!pattern) exitWithError("用法: gbxtrace grep <模式> [--last N] [--type T]");
  const last = num(flagsGlobal.last, 50);
  const runs = (await listRuns(runsDir)).slice(0, last);
  const needle = pattern.toLowerCase();
  const hits = [];
  for (const run of runs) {
    let content;
    try {
      content = await fs.readFile(path.join(run.dir, "trace.jsonl"), "utf8");
    } catch {
      continue;
    }
    for (const line of content.split("\n")) {
      if (!line.trim()) continue;
      const lower = line.toLowerCase();
      if (!lower.includes(needle)) continue;
      let parsed = null;
      try {
        parsed = JSON.parse(line);
      } catch {
        // 坏行也允许命中，按原文展示
      }
      const type = parsed?.event?.type ?? "?";
      if (flagsGlobal.types?.length && !flagsGlobal.types.includes(type)) continue;
      const idx = lower.indexOf(needle);
      const from = Math.max(0, idx - 60);
      const to = Math.min(line.length, idx + pattern.length + 120);
      hits.push({
        runId: run.runId,
        seq: parsed?.seq ?? "?",
        type,
        ts: parsed?.ts ?? null,
        snippet: (from > 0 ? "…" : "") + line.slice(from, to) + (to < line.length ? "…" : ""),
      });
    }
  }
  if (flagsGlobal.json) {
    console.log(JSON.stringify({ pattern, scannedRuns: runs.length, hits }, null, 2));
    return;
  }
  if (hits.length === 0) {
    console.log(paint(C.dim, `在最近 ${runs.length} 个 run 中没有找到 "${pattern}"`));
    return;
  }
  console.log(
    paint(C.bold, `"${pattern}" 命中 ${hits.length} 处（扫描最近 ${runs.length} 个 run）`),
  );
  for (const hit of hits) {
    console.log(
      `${paint(C.cyan, short(hit.runId))} ${paint(C.dim, `#${String(hit.seq).padStart(4)}`)} ${paint(C.bold, hit.type)}`,
    );
    console.log(`     ${hit.snippet}`);
  }
}

const FAILURE_STATUSES = new Set(["failed", "interrupted", "unknown"]);

async function cmdFailures(runsDir) {
  const limit = num(flagsGlobal.limit, 10);
  const runs = (await listRuns(runsDir)).slice(0, 200);
  const failures = [];
  for (const run of runs) {
    const trace = await readTrace(run.dir);
    const summary = summarizeRun(trace);
    if (!FAILURE_STATUSES.has(summary.status)) continue;
    const evidence = trace.entries.filter((e) =>
      [
        "delivery_blocked",
        "delivery_denied",
        "runtime_health_observation",
        "tool_result",
        "routing_eval_evidence",
      ].includes(e.event?.type),
    );
    failures.push({ run, summary, trace, evidence });
    if (failures.length >= limit) break;
  }
  if (flagsGlobal.json) {
    console.log(
      JSON.stringify(
        failures.map((f) => ({
          runId: f.run.runId,
          status: f.summary.status,
          startedAt: f.summary.startedAt,
          durationMs: f.summary.durationMs,
          conversationId: f.summary.conversationId,
          integrity: { malformed: f.trace.malformed, seqGaps: f.trace.seqGaps.length },
          evidence: f.evidence,
        })),
        null,
        2,
      ),
    );
    return;
  }
  if (failures.length === 0) {
    console.log(
      paint(C.green, `最近 ${runs.length} 个 run 中没有 failed/interrupted/unknown 终态`),
    );
    return;
  }
  console.log(paint(C.bold, `${failures.length} 个非成功 run（扫描最近 ${runs.length} 个）`));
  for (const f of failures) {
    console.log("");
    console.log(
      `${paint(C.red, f.summary.status.toUpperCase())}  ${short(f.run.runId)}  ${fmtTime(f.summary.startedAt)}  时长 ${fmtDuration(f.summary.durationMs)}  conv=${short(f.summary.conversationId)}`,
    );
    for (const entry of f.evidence) printEvent(entry);
    if (f.trace.malformed > 0 || f.trace.seqGaps.length > 0) {
      console.log(
        paint(
          C.yellow,
          `  完整性警告: malformed=${f.trace.malformed} seqGaps=${f.trace.seqGaps.length}`,
        ),
      );
    }
  }
  console.log("");
  console.log(
    paint(
      C.dim,
      "用 gbxtrace show <runId> 看完整时间线，gbxtrace events <runId> --type <事件类型> 下钻。",
    ),
  );
}

async function cmdDelivery(runsDir) {
  const limit = num(flagsGlobal.limit, 20);
  const runs = (await listRuns(runsDir)).slice(0, limit);
  const deliveryTypes = ["delivery_changed", "delivery_blocked", "delivery_denied"];
  const rows = [];
  for (const run of runs) {
    const trace = await readTrace(run.dir);
    const events = trace.entries.filter((e) => deliveryTypes.includes(e.event?.type));
    if (events.length === 0) continue;
    rows.push({ runId: run.runId, summary: summarizeRun(trace), events });
  }
  if (flagsGlobal.json) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }
  if (rows.length === 0) {
    console.log(paint(C.dim, `最近 ${runs.length} 个 run 没有投递事件`));
    return;
  }
  console.log(paint(C.bold, `最近 ${runs.length} 个 run 的投递事件`));
  for (const row of rows) {
    console.log("");
    console.log(
      `${short(row.runId)}  run=${statusColor(row.summary.status)}  ${fmtTime(row.summary.startedAt)}`,
    );
    for (const entry of row.events) printEvent(entry);
  }
}

async function cmdTypes(runsDir) {
  const runs = await listRuns(runsDir);
  const counts = {};
  const statusCounts = {};
  for (const run of runs) {
    const trace = await readTrace(run.dir);
    for (const entry of trace.entries) {
      const type = entry.event?.type ?? "?";
      counts[type] = (counts[type] ?? 0) + 1;
    }
    const status = summarizeRun(trace).status;
    statusCounts[status] = (statusCounts[status] ?? 0) + 1;
  }
  const rows = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  if (flagsGlobal.json) {
    console.log(
      JSON.stringify(
        { runCount: runs.length, eventTypes: counts, runStatuses: statusCounts },
        null,
        2,
      ),
    );
    return;
  }
  console.log(paint(C.bold, `本地 ${runs.length} 个 run 的事件类型分布`));
  for (const [type, count] of rows) {
    console.log(`  ${type.padEnd(34)} ${count}`);
  }
  console.log(paint(C.bold, "run 终态分布"));
  for (const [status, count] of Object.entries(statusCounts)) {
    console.log(`  ${status.padEnd(34)} ${count}`);
  }
}

/**
 * 文档漂移检测：本地 trace 出现的事件类型 vs references/trace-events.md 记录的类型。
 * 这是 skill 自我迭代的机械信号——新事件出现时这里会报出来，逼着补文档而不是绕过。
 */
async function cmdDrift(runsDir) {
  const referencePath = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../references/trace-events.md",
  );
  let reference = "";
  try {
    reference = await fs.readFile(referencePath, "utf8");
  } catch {
    exitWithError(`读不到事件字典: ${referencePath}（skill 文件不完整？）`);
  }
  const runs = await listRuns(runsDir);
  const counts = {};
  const samples = {};
  for (const run of runs) {
    const trace = await readTrace(run.dir);
    for (const entry of trace.entries) {
      const type = entry.event?.type;
      if (typeof type !== "string") continue;
      counts[type] = (counts[type] ?? 0) + 1;
      if (!samples[type]) samples[type] = { runId: run.runId, seq: entry.seq, event: entry.event };
    }
  }
  const localTypes = new Set(Object.keys(counts));
  const documented = new Set(
    [...reference.matchAll(/`([a-z][a-z0-9_]*)`/gu)]
      .map((m) => m[1])
      .filter((t) => localTypes.has(t)),
  );
  const undocumented = [...localTypes].filter((t) => !documented.has(t)).sort();
  const documentedButAbsent = [...documented].filter((t) => !counts[t]).sort();
  if (flagsGlobal.json) {
    console.log(
      JSON.stringify(
        {
          referencePath,
          localTypeCount: localTypes.size,
          undocumentedTypes: undocumented,
          documentedButAbsent,
          counts,
        },
        null,
        2,
      ),
    );
    return;
  }
  console.log(paint(C.bold, `trace 文档漂移检测（对照 ${referencePath}）`));
  console.log(`  本地事件类型: ${localTypes.size} 种，字典已记录: ${documented.size} 种`);
  if (undocumented.length === 0) {
    console.log(paint(C.green, "  没有未记录的事件类型，字典与本地数据一致。"));
  } else {
    console.log(
      paint(
        C.yellow,
        `  ${undocumented.length} 种事件类型未记录在字典里（按 SKILL.md「维护这个 skill」补齐）：`,
      ),
    );
    for (const type of undocumented) {
      const sample = samples[type];
      console.log(`\n  ${paint(C.bold, type)}  x${counts[type]}`);
      console.log(`    样本: run=${short(sample.runId)} seq=${sample.seq}`);
      console.log(`    ${JSON.stringify(sample.event).slice(0, 400)}`);
    }
  }
  if (documentedButAbsent.length > 0) {
    console.log(
      paint(
        C.dim,
        `\n  字典记录了但本地未出现（可能是历史类型或别处环境才有）: ${documentedButAbsent.join(", ")}`,
      ),
    );
  }
}

// ---------------------------------------------------------------- 入口

let flagsGlobal = { _: [] };

const USAGE = `gbxtrace — Glassbox run / raw-trace 调试 CLI（只读）

用法: node <skill>/scripts/gbxtrace.mjs <命令> [参数] [选项]

命令:
  env                                  环境检查：数据目录、run 数、服务端口、token
  runs [--limit N] [--status S]        列出最近 run（succeeded/failed/interrupted/unknown）
  show [runId] [--full]                时间线视图，缺省为最新 run；--full 展开 message_chunk
  events <runId> [--type T ...]        按事件类型过滤原始事件（--type 可重复）
  grep <模式> [--last N] [--type T]    跨最近 N 个 run 搜索 trace 原文
  failures [--limit N]                 非成功 run 及其错误证据
  delivery [--limit N]                 投递事件（changed/blocked/denied）
  types                                本地 run 的事件类型与终态分布
  drift                                文档漂移检测：本地有但 references/trace-events.md 没记录的事件类型

通用选项:
  --json                              输出 JSON（供后续处理）
  --data-dir <path>                    覆盖 runs 目录（默认 GLASSBOX_DATA_DIR → ~/.glassbox/runs）

示例:
  gbxtrace runs --status failed --limit 5
  gbxtrace show                      # 最新 run 出了什么问题
  gbxtrace events <runId> --type tool_result --type delivery_blocked
  gbxtrace grep "empty-rendered-output" --last 100
`;

async function main() {
  const argv = process.argv.slice(2);
  const command = argv[0];
  if (!command || command === "help" || command === "--help" || command === "-h") {
    console.log(USAGE);
    return;
  }
  const flags = parseFlags(argv.slice(1));
  flagsGlobal = flags;
  const { dir: runsDir } = await resolveRunsDir(flags["data-dir"]);
  switch (command) {
    case "env":
      await cmdEnv(runsDir);
      break;
    case "runs":
      await cmdRuns(runsDir);
      break;
    case "show":
      await cmdShow(runsDir);
      break;
    case "events":
      await cmdEvents(runsDir);
      break;
    case "grep":
      await cmdGrep(runsDir);
      break;
    case "failures":
      await cmdFailures(runsDir);
      break;
    case "delivery":
      await cmdDelivery(runsDir);
      break;
    case "types":
      await cmdTypes(runsDir);
      break;
    case "drift":
      await cmdDrift(runsDir);
      break;
    default:
      exitWithError(`未知命令: ${command}\n\n${USAGE}`);
  }
}

main().catch((error) => {
  console.error(paint(C.red, `gbxtrace 失败: ${error?.message ?? error}`));
  process.exit(1);
});
