#!/usr/bin/env node
import { readFile, writeFile, mkdir, open, rm } from "node:fs/promises";
import { appendFileSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { validateConfig, fail, safeError, sleep, digest, exitCode } from "./lib/core.mjs";
import { OneBot } from "./lib/onebot.mjs";
import { Recorder, doctor, smokeSpecs, validateSpecs, replyCase } from "./lib/runner.mjs";
import { moderationCase } from "./lib/moderation.mjs";
import {
  runtimeSnapshot,
  readTraceEvents,
  verifyProductEvidence,
  verifyFailedCaseCleanup,
  verifyKnownTasteFeatureFailureCleanup,
} from "./lib/product-evidence.mjs";
import { runReadCaseSequence, productCleanupStopRequired } from "./lib/read-case-sequence.mjs";
import { acceptanceManagement } from "./lib/management-client.mjs";
import { runMemoryRecoveryCli } from "./lib/memory-recovery-cli.mjs";
import {
  resolveFeatureSuite,
  memoryFamilyPlan,
  historyFamilyPlan,
  historyIsolationFamilyPlan,
} from "./lib/feature-suite.mjs";
import { MEMORY_FAMILY_ID, memoryWorkflow } from "./lib/memory-workflow.mjs";
import { TASTE_FAMILY_ID, tasteFamilyPlan } from "./lib/taste-scenario.mjs";
import {
  finalizeTasteFamilyAcceptance,
  tasteFixtureCheckpointRemovable,
} from "./lib/taste-report-finalization.mjs";
import {
  TRANSPORT_SUITE_FAMILY_ID,
  transportSmokeSpecs,
  transportSuiteDefinition,
  transportSuiteHash,
  validateTransportCase,
} from "./lib/transport-suite.mjs";

const root = dirname(fileURLToPath(import.meta.url));
const help = `QQ 实机测试器 0.1.0

node cli.mjs init
node cli.mjs doctor
node cli.mjs arm --minutes 30
node cli.mjs plan --case transport-smoke
node cli.mjs run --live --approve-suite <SHA256>
node cli.mjs plan --case memory-lifecycle
node cli.mjs run --live --case memory-lifecycle --approve-suite <SHA256>
node cli.mjs plan --case taste-lifecycle
node cli.mjs run --live --case taste-lifecycle --approve-suite <SHA256>
node cli.mjs plan --scenarios examples/feature-baseline.example.json
node cli.mjs run --live --case history-group-seed-private-recall --scenarios examples/feature-baseline.example.json --approve-suite <SHA256>
node cli.mjs reconcile-memory
node cli.mjs reconcile-memory --live --approve-suite <SHA256>
node cli.mjs reconcile-taste
node cli.mjs reconcile-taste --live --approve-suite <SHA256>
node cli.mjs plan --scenarios examples/scenarios.example.json
node cli.mjs coverage
node cli.mjs record-agent-review --pr <URL>
node cli.mjs record-agent-review --pr <URL> --artifact <review-json> --expected-review-binding <SHA256>
node cli.mjs delivery-check --pr <URL> --scenarios <file> --reports <manifest> --approve-suite <SHA256>
node cli.mjs deliver --live --pr <URL> --scenarios <file> --reports <manifest> --approve-suite <SHA256>
node cli.mjs postmerge-check --pr <URL> --scenarios <file> --reports <manifest> --approve-suite <SHA256>
node cli.mjs record-lesson --input <lesson-json> --config <local-config>
node cli.mjs report

通用选项 --config <文件> --out <报告目录>
run 默认测试私聊和已配置的群。moderation 需要独立配置和成员同意。
schemaVersion=1 的自然语言 scenarios 仅支持 plan。
schemaVersion=2 的结构化读取用例需要服务端逐消息许可、运行版本和工具证据。
schemaVersion=4 增加固定群 A 种子与 Owner 私聊回查流程。
schemaVersion=5 增加群 B 种子与仅查询群 A 的私聊隔离流程。
 schemaVersion=6 增加固定 Taste 生命周期流程。
memory-lifecycle 是固定的项目范围反馈、提升、过期流程，需要单独启用并保留审计记录。
taste-lifecycle 是固定的项目范围正向反馈、提升、负向反馈和退役流程。中断时需恢复或清理固定测试资源。
退出码 0=通过，1=验收失败，2=环境或配置阻塞，3=无法确认。
停止文件为报告目录下 STOP。Ctrl+C 也会停止，并尝试已授权的清理。
`;
function args(argv) {
  const command = argv.shift() ?? "help",
    o = {};
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === "--live") {
      o.live = true;
      continue;
    }
    if (
      ![
        "--config",
        "--out",
        "--case",
        "--minutes",
        "--scenarios",
        "--approve-suite",
        "--catalog",
        "--pr",
        "--reports",
        "--input",
        "--artifact",
        "--expected-review-binding",
      ].includes(k) ||
      !argv[i + 1] ||
      argv[i + 1].startsWith("--")
    )
      fail("ARGUMENT", "参数无效，运行 node cli.mjs help 查看帮助。");
    if (command === "record-agent-review" && Object.hasOwn(o, k.slice(2)))
      fail("ARGUMENT", "审查登记参数不能重复。");
    o[k.slice(2)] = argv[++i];
  }
  if (
    ![
      "help",
      "init",
      "doctor",
      "arm",
      "run",
      "plan",
      "report",
      "coverage",
      "reconcile-memory",
      "reconcile-taste",
      "delivery-check",
      "deliver",
      "postmerge-check",
      "record-lesson",
      "record-agent-review",
    ].includes(command)
  )
    fail("COMMAND", "未知命令。");
  if (
    command !== "record-agent-review" &&
    (Object.hasOwn(o, "artifact") || Object.hasOwn(o, "expected-review-binding"))
  )
    fail("ARGUMENT", "审查文件和绑定哈希仅用于审查登记。");
  if (
    command === "record-agent-review" &&
    (!o.pr ||
      Object.keys(o).some(
        (key) => !["config", "out", "pr", "artifact", "expected-review-binding"].includes(key),
      ))
  )
    fail("ARGUMENT", "审查登记需要 --pr，只接受配置、审查文件和绑定哈希选项。");
  return { command, o };
}
async function jsonFile(path) {
  let text;
  try {
    text = await readFile(path, "utf8");
  } catch {
    fail("CONFIG_READ", "文件读取失败，请检查路径或先运行 init。");
  }
  if (text.length > 100000) fail("FILE_LIMIT", "配置或用例文件超过大小上限。");
  try {
    return { raw: JSON.parse(text), text };
  } catch {
    fail("CONFIG_JSON", "文件不是有效 JSON。");
  }
}
function workspace() {
  try {
    const git = (a) =>
      execFileSync("git", a, {
        cwd: process.cwd(),
        encoding: "utf8",
        timeout: 5000,
        maxBuffer: 1024 * 1024,
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    const diff = git(["diff", "HEAD", "--no-ext-diff", "--no-textconv"]);
    return {
      commit: git(["rev-parse", "HEAD"]),
      dirty: git(["status", "--porcelain"]).length > 0,
      trackedDiffSha256: digest(diff),
      runtimeProcessVerified: false,
      note: "仅记录调用命令所在工作区，不证明已运行服务使用该版本。未跟踪文件不在 diff 摘要中。",
    };
  } catch {
    return { runtimeProcessVerified: false, note: "未取得 Git 工作区版本，也未验证运行服务版本。" };
  }
}
async function writeJson(path, value) {
  await writeFile(path, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
}
async function syncDirectory(path) {
  const directory = await open(path, "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}
function memoryPlan() {
  return memoryFamilyPlan();
}
async function main() {
  const { command, o } = args(process.argv.slice(2));
  if (command === "help") {
    console.log(help);
    return;
  }
  if (command === "coverage") {
    const { checkRepositoryFeatureCoverage } = await import("./feature-catalog.mjs");
    const catalog = o.catalog ? (await jsonFile(resolve(o.catalog))).raw : undefined;
    let executableSuiteCases = [];
    let suiteConfig;
    if (o.scenarios) {
      const suite = (await jsonFile(resolve(o.scenarios))).raw;
      const config = validateConfig(
        (await jsonFile(resolve(o.config ?? join(root, "qq-live.local.json")))).raw,
      );
      resolveFeatureSuite(suite, config);
      executableSuiteCases = suite.cases;
      suiteConfig = config;
    }
    const result = await checkRepositoryFeatureCoverage({
      catalog,
      executableSuiteCases,
      suiteConfig,
    });
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.status === "PASS" ? 0 : 2;
    return;
  }
  const configPath = resolve(o.config ?? join(root, "qq-live.local.json"));
  if (command === "record-lesson") {
    if (!o.input || Object.keys(o).some((key) => !["input", "config"].includes(key)))
      fail("ARGUMENT", "经验登记只接受 --input 和既有 --config，不接受发送或合并选项。");
    const { runLessonCli } =
      await import("../../.agents/skills/qq-live-testing/scripts/record-lesson.mjs");
    return runLessonCli(["--input", resolve(o.input), "--config", configPath]);
  }
  const out = resolve(o.out ?? join(root, "artifacts"));
  if (command === "init") {
    const template = await readFile(join(root, "examples/config.example.json"), "utf8");
    await mkdir(dirname(configPath), { recursive: true, mode: 0o700 });
    try {
      await writeFile(configPath, template, { flag: "wx", mode: 0o600 });
    } catch {
      fail("CONFIG_EXISTS", "没有覆盖已有配置。请编辑配置文件或使用 --config 指定新路径。");
    }
    console.log(`已创建 ${configPath}\n填写账号、群号和两个本地 Token 环境变量。默认不发送消息。`);
    return;
  }
  if (command === "report") {
    const { raw } = await jsonFile(join(out, "latest.json"));
    console.log(JSON.stringify(raw, null, 2));
    return;
  }
  const { raw } = await jsonFile(configPath);
  const config = validateConfig(raw, {
    live:
      command === "run" ||
      (["reconcile-memory", "reconcile-taste"].includes(command) && o.live === true),
  });
  if (command === "record-agent-review") {
    const { recordAgentReviewCli } = await import("./lib/delivery-cli.mjs");
    const result = await recordAgentReviewCli(
      config,
      {
        pr: o.pr,
        ...(o.artifact !== undefined ? { artifact: o.artifact } : {}),
        ...(o["expected-review-binding"] !== undefined
          ? { expectedReviewBindingSha256: o["expected-review-binding"] }
          : {}),
      },
      out,
    );
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (command === "reconcile-memory") return runMemoryRecoveryCli(config, o, out);
  if (command === "reconcile-taste") {
    const { runTasteRecoveryCli } = await import("./lib/taste-recovery-cli.mjs");
    return runTasteRecoveryCli(config, o, out);
  }
  if (["delivery-check", "deliver", "postmerge-check"].includes(command)) {
    if (command === "deliver" && !o.live) fail("LIVE_REQUIRED", "执行合并需要显式 --live。");
    const { runDeliveryCli } = await import("./lib/delivery-cli.mjs");
    return runDeliveryCli(
      config,
      {
        ...o,
        executeMerge: command === "deliver" && o.live === true,
        postMerge: command === "postmerge-check",
      },
      out,
    );
  }
  if (command === "run" && o.case === "moderation")
    fail(
      "MODERATION_LEASE_UNSUPPORTED",
      "实机禁言流程尚无精确范围的服务端许可，已在建立连接和发送之前阻止。",
    );
  if (command === "run" && o.live !== true)
    fail("LIVE_REQUIRED", "真正发消息必须显式传入 --live。");
  if (command === "arm") {
    if (
      config.safety?.acceptanceServiceConfirmed !== true ||
      config.safety?.soleConsumerConfirmed !== true
    )
      fail(
        "ACCEPTANCE_SERVICE_REQUIRED",
        "请先确认指定的真实验收服务及唯一消息处理实例，再在配置中设置两个确认字段。",
      );
    const minutes = Number(o.minutes ?? "30");
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 120)
      fail("ARM_MINUTES", "授权窗口只能为 1 至 120 分钟。");
    raw.safety.armedUntil = new Date(Date.now() + minutes * 60000).toISOString();
    await writeJson(configPath, raw);
    console.log(`测试授权有效至 ${raw.safety.armedUntil}。本命令不发送消息。`);
    return;
  }
  const transportOnlySuite =
    !o.scenarios &&
    !["memory-lifecycle", "taste-lifecycle", "moderation"].includes(o.case) &&
    (command === "run" || command === "plan");
  let specs = transportOnlySuite ? transportSmokeSpecs(config) : smokeSpecs(config),
    suiteHash = transportOnlySuite ? transportSuiteHash(config) : null,
    featureSuite = false;
  let memoryLifecycle = o.case === "memory-lifecycle";
  let tasteLifecycle = o.case === "taste-lifecycle";
  let memoryFamilyCase = null;
  let tasteFamilyCase = null;
  let historyFamilyCase = null;
  let plannedSuiteCases = null;
  if (transportOnlySuite) {
    if (
      o.case &&
      o.case !== "transport-smoke" &&
      !["private", "group-A", "group-B"].includes(o.case)
    )
      fail("CASE_NOT_FOUND", "没有匹配的固定传输用例。");
    if (o.case && o.case !== "transport-smoke")
      fail("TRANSPORT_SUITE_FIXED", "默认传输检查必须整轮运行 private、group A 和 group B。");
    if (command === "plan") {
      const definition = transportSuiteDefinition(config);
      console.log(
        JSON.stringify(
          {
            suiteSha256: suiteHash,
            transportOnly: true,
            familyId: TRANSPORT_SUITE_FAMILY_ID,
            identities: definition.identities,
            cases: definition.cases,
            note: "固定零工具传输检查。即使通过，也不计入功能覆盖或完整 QQ 交付验收。",
          },
          null,
          2,
        ),
      );
      return;
    }
    specs.forEach((spec) => validateTransportCase(spec, config));
    if (!config.runtime)
      fail("TRANSPORT_RUNTIME_REQUIRED", "固定传输 suite 需要核验真实验收服务版本。");
    if (o["approve-suite"] !== suiteHash)
      fail("SUITE_APPROVAL", "先运行 plan 审阅固定传输套件，再提供其身份绑定 SHA256。");
    const neededMessages = specs.length;
    if (config.maxMessages < neededMessages)
      fail("MESSAGE_BUDGET", `固定传输 suite 需要 ${neededMessages} 条消息预算。`);
  }
  if (memoryLifecycle) {
    if (o.scenarios) fail("ARGUMENT", "固定记忆流程不能与 scenarios 混用。");
    const plan = memoryPlan();
    suiteHash = digest(JSON.stringify(plan));
    featureSuite = true;
    if (command === "plan") {
      console.log(JSON.stringify({ suiteSha256: suiteHash, ...plan }, null, 2));
      return;
    }
    if (command !== "run") fail("ARGUMENT", "记忆流程只支持 plan 和 run。");
    if (!config.runtime) fail("FEATURE_RUNTIME_REQUIRED", "记忆流程必须核对真实验收服务版本。");
    if (
      config.memoryFixtures?.enabled !== true ||
      config.memoryFixtures?.retainAuditConfirmed !== true
    )
      fail("MEMORY_FIXTURE_DISABLED", "请在配置中明确启用 memoryFixtures 并确认保留测试审计。");
    if (o["approve-suite"] !== suiteHash)
      fail("SUITE_APPROVAL", "请先审阅固定记忆流程并提供 plan 输出的 SHA256。");
    if (config.maxMessages < 3) fail("MESSAGE_BUDGET", "固定记忆流程需要三条消息的预算。");
    specs = [];
  }
  if (tasteLifecycle) {
    if (!tasteFamilyCase && o.scenarios)
      fail("ARGUMENT", "独立固定偏好流程不能与 scenarios 混用。");
    const plan = tasteFamilyPlan();
    if (!tasteFamilyCase) suiteHash = digest(JSON.stringify(plan));
    featureSuite = true;
    if (command === "plan") {
      console.log(JSON.stringify({ suiteSha256: suiteHash, ...plan }, null, 2));
      return;
    }
    if (command !== "run") fail("ARGUMENT", "偏好流程只支持 plan 和 run。");
    if (!config.runtime) fail("FEATURE_RUNTIME_REQUIRED", "偏好流程必须核对真实验收服务版本。");
    if (
      config.memoryFixtures?.enabled !== true ||
      config.memoryFixtures?.retainAuditConfirmed !== true
    )
      fail("MEMORY_FIXTURE_DISABLED", "请在配置中启用固定偏好测试并确认保留审计。");
    if (o["approve-suite"] !== suiteHash)
      fail("SUITE_APPROVAL", "请先审阅固定偏好流程并提供 plan 输出的 SHA256。");
    if (config.maxMessages < 4) fail("MESSAGE_BUDGET", "固定偏好流程需要四条消息的预算。");
    specs = [];
  }
  if (o.scenarios) {
    const suite = await jsonFile(resolve(o.scenarios));
    featureSuite = [2, 3, 4, 5, 6].includes(suite.raw?.schemaVersion);
    if (command === "run" && !featureSuite)
      fail(
        "CUSTOM_LIVE_UNSUPPORTED",
        "自定义自然语言尚未有可验证的能力限制，仅支持 plan 审阅。实机运行使用固定用例。",
      );
    if (featureSuite) {
      const resolved = resolveFeatureSuite(suite.raw, config);
      plannedSuiteCases = resolved.cases;
      specs = resolved.readCases;
      if (resolved.historyFamilies.length && command === "run") {
        if (!o.case) fail("CASE_FAMILY_REQUIRED", "含历史流程的套件须逐个选择用例运行。");
        historyFamilyCase = resolved.historyFamilies.find((c) => c.id === o.case) ?? null;
        if (historyFamilyCase) specs = [];
      }
      if (resolved.memoryFamilies.length && command === "run") {
        if (!o.case)
          fail("CASE_FAMILY_REQUIRED", "含记忆流程的套件须逐个选择用例运行并保留各自报告。");
        memoryFamilyCase = resolved.memoryFamilies.find((c) => c.id === o.case) ?? null;
        if (memoryFamilyCase) {
          memoryLifecycle = true;
          specs = [];
        }
      }
      if (resolved.tasteFamilies.length && command === "run") {
        if (!o.case)
          fail("CASE_FAMILY_REQUIRED", "含偏好流程的套件须逐个选择用例运行并保留各自报告。");
        tasteFamilyCase = resolved.tasteFamilies.find((c) => c.id === o.case) ?? null;
        if (tasteFamilyCase) {
          tasteLifecycle = true;
          if (
            config.memoryFixtures?.enabled !== true ||
            config.memoryFixtures?.retainAuditConfirmed !== true
          )
            fail("MEMORY_FIXTURE_DISABLED", "请明确启用固定偏好测试并确认保留审计。");
          if (config.maxMessages < 4) fail("MESSAGE_BUDGET", "固定偏好流程需要四条消息的预算。");
          specs = [];
        }
      }
    } else specs = validateSpecs(suite.raw, config);
    if (command === "run" && featureSuite && !config.runtime)
      fail("FEATURE_RUNTIME_REQUIRED", "功能用例必须配置并核对真实验收服务版本。");
    suiteHash = digest(suite.text);
    if (command === "run" && o["approve-suite"] !== suiteHash)
      fail(
        "SUITE_APPROVAL",
        "先运行 plan 审阅消息，再把输出 SHA256 传入 --approve-suite。文件修改后需要重新审阅。",
      );
    if (command === "run" && historyFamilyCase && config.maxMessages < 2)
      fail("MESSAGE_BUDGET", "固定历史流程需要两条消息预算。");
    if (command === "run" && memoryFamilyCase) {
      if (
        config.memoryFixtures?.enabled !== true ||
        config.memoryFixtures?.retainAuditConfirmed !== true
      )
        fail("MEMORY_FIXTURE_DISABLED", "请明确启用固定记忆测试并确认保留审计。");
      const requiredMessages = memoryWorkflow(memoryFamilyCase.id).stages.length;
      if (config.maxMessages < requiredMessages)
        fail("MESSAGE_BUDGET", `固定记忆流程需要 ${requiredMessages} 条消息的预算。`);
    }
  }
  if (command === "plan") {
    if (!o.scenarios) fail("SCENARIOS_REQUIRED", "plan 需要 --scenarios。");
    console.log(
      JSON.stringify(
        {
          suiteSha256: suiteHash,
          cases: plannedSuiteCases ?? specs,
          ...(plannedSuiteCases?.some((c) => c.kind === "history-seed")
            ? { historyPlan: historyFamilyPlan(config) }
            : {}),
          ...(plannedSuiteCases?.some((c) => c.kind === "history-isolation")
            ? { historyIsolationPlan: historyIsolationFamilyPlan(config) }
            : {}),
          ...(() => {
            const families = plannedSuiteCases?.filter((c) => c.kind === "memory-lifecycle") ?? [];
            if (families.length === 1) return { memoryPlan: memoryFamilyPlan(families[0].id) };
            if (families.length > 1)
              return {
                memoryPlans: families.map((c) => ({ caseId: c.id, plan: memoryFamilyPlan(c.id) })),
              };
            return {};
          })(),
          ...(plannedSuiteCases?.some((c) => c.kind === "taste-lifecycle")
            ? { tastePlan: tasteFamilyPlan() }
            : {}),
          note: "这是待发送的消息，不是执行结果。sideEffect 声明不能代替代码授权检查。",
        },
        null,
        2,
      ),
    );
    return;
  }
  if (
    o.case &&
    !transportOnlySuite &&
    o.case !== "moderation" &&
    !memoryLifecycle &&
    !tasteLifecycle &&
    !historyFamilyCase
  ) {
    specs = specs.filter((s) => s.id === o.case);
    if (!specs.length) fail("CASE_NOT_FOUND", "没有匹配的用例，未执行任何测试。");
  }
  if (command === "run" && o.live !== true)
    fail("LIVE_REQUIRED", "真正发消息必须显式传入 --live。");
  if (command === "run" && o.case === "moderation" && o.scenarios)
    fail("ARGUMENT", "moderation 不与自定义用例文件混用。");
  await mkdir(out, { recursive: true, mode: 0o700 });
  // A lock tied to the driver identity prevents overlapping runs across worktrees.
  const { homedir } = await import("node:os");
  const lockRoot = join(homedir(), ".glassbox-qq-live-locks");
  await mkdir(lockRoot, { recursive: true, mode: 0o700 });
  const lockPath = join(
    lockRoot,
    createHash("sha256").update(config.driver.qq).digest("hex").slice(0, 24) + ".lock",
  );
  const pendingFixturePath = lockPath.replace(/\.lock$/, ".memory-pending.json");
  const pendingTasteFixturePath = lockPath.replace(/\.lock$/, ".taste-pending.json");
  let lock;
  try {
    lock = await open(lockPath, "wx", 0o600);
    await lock.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
  } catch {
    fail("RUN_LOCKED", "该发起账号已有测试锁。先确认旧测试已停止及副作用已清理，不自动删除旧锁。");
  }
  const runId =
    new Date().toISOString().replaceAll(":", "-") + "_" + digest(String(Math.random())).slice(0, 8);
  const runDir = join(out, runId);
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  const clients = { driver: new OneBot(config, "driver"), bot: new OneBot(config, "bot") };
  const secrets = [clients.driver.token, clients.bot.token];
  const recorder = new Recorder(config, secrets);
  const report = {
    schemaVersion: 1,
    toolVersion: "0.1.0",
    runId,
    mode: command,
    startedAt: new Date().toISOString(),
    productAcceptance: {
      status: "BLOCKED",
      ...(transportOnlySuite ? { acceptanceKind: "TRANSPORT_ONLY" } : {}),
      code:
        command === "doctor"
          ? "DOCTOR_ONLY"
          : config.runtime
            ? "NOT_CHECKED"
            : "RUNTIME_NOT_CONFIGURED",
    },
    status: "BLOCKED",
    suiteSha256: suiteHash,
    workspace: workspace(),
    cases: recorder.cases,
    ...(transportOnlySuite ? { transportOnly: true } : {}),
    ...(memoryFamilyCase ? { memoryFamily: { caseId: memoryFamilyCase.id } } : {}),
    ...(tasteLifecycle ? { tasteFamily: { familyId: TASTE_FAMILY_ID } } : {}),
    ...(historyFamilyCase ? { historyFamily: { caseId: historyFamilyCase.id } } : {}),
    limitations: [
      "没有验证 QQ 客户端 UI。",
      "工作区版本不等于已运行服务版本。",
      "自定义回复断言不证明权限、配置或其他副作用。",
    ],
    privacy: "仅保留本轮可关联消息和目标通知；报告仍含测试账号信息，请勿公开上传。",
  };
  let timer;
  let acceptance;
  let pendingFixtureCreated = false;
  let pendingTasteFixtureCreated = false;
  const observers = [];
  try {
    await mkdir(runDir, { mode: 0o700 });
    await writeJson(join(runDir, "attempt.json"), {
      runId,
      mode: command,
      startedAt: report.startedAt,
      status: "STARTED",
    });
    recorder.onEvent = (e) =>
      appendFileSync(join(runDir, "events.jsonl"), JSON.stringify(e) + "\n", { mode: 0o600 });
    const { existsSync } = await import("node:fs");
    if (existsSync(join(out, "STOP"))) fail("STOP_FILE", "存在 STOP 文件，本轮不会发送消息。");
    if (command === "run" && existsSync(pendingFixturePath))
      fail(
        "MEMORY_RECONCILIATION_REQUIRED",
        "该发起账号有未核实的记忆测试资源。先核实原始报告和清理证据，禁止续发。",
      );
    if (command === "run" && existsSync(pendingTasteFixturePath))
      fail(
        "TASTE_RECONCILIATION_REQUIRED",
        "该发起账号有未核实的偏好测试资源。先核实原始报告和清理证据，禁止续发。",
      );
    if (command === "run" && config.runtime) report.runtime = runtimeSnapshot(config.runtime);
    if (command === "run" && (featureSuite || transportOnlySuite))
      acceptance = await acceptanceManagement(config.runtime);
    timer = setInterval(() => {
      if (existsSync(join(out, "STOP"))) controller.abort();
    }, 250);
    await clients.driver.connect();
    await clients.bot.connect();
    observers.push(clients.driver.subscribe((e) => recorder.ingest("driver", e)));
    observers.push(clients.bot.subscribe((e) => recorder.ingest("bot", e)));
    report.environment = await doctor(config, clients);
    if (command === "doctor") {
      report.status = "PASS";
      report.note = "只完成账号、在线状态和群成员检查，没有执行实机收发验收。";
    } else if (o.case === "moderation") {
      await moderationCase(config, clients, recorder, controller.signal);
      report.status = recorder.finalize();
    } else if (historyFamilyCase) {
      const isolation = historyFamilyCase.kind === "history-isolation";
      const runWorkflow = isolation
        ? (await import("./lib/history-isolation-workflow.mjs")).runHistoryIsolationWorkflow
        : (await import("./lib/history-seed-workflow.mjs")).runHistorySeedWorkflow;
      const checkpoint = async (row) =>
        appendFileSync(join(runDir, "history-fixture.jsonl"), JSON.stringify(row) + "\n", {
          mode: 0o600,
        });
      acceptance.beforeRegister = async (c) =>
        checkpoint({
          phase: "lease_intent",
          caseId: c.id,
          marker: c.token,
          textSha256: digest(c.prompt),
        });
      acceptance.beforeSend = async (c, lease) =>
        checkpoint({
          phase: "send_intent",
          caseId: c.id,
          marker: c.token,
          leaseId: lease.leaseId,
          toolsSha256: lease.toolsSha256,
          textSha256: digest(c.prompt),
        });
      acceptance.afterSend = async (c) =>
        checkpoint({ phase: "sent", caseId: c.id, driverMessageId: c.sentMessageId });
      const historyWorkflow = await runWorkflow({
        config,
        signal: controller.signal,
        checkpoint,
        executeStep: async (stage, spec) => {
          if (stage !== "seed") await sleep(config.minGapMs);
          const transportCase = await replyCase(
            config,
            clients,
            recorder,
            spec,
            controller.signal,
            acceptance,
          );
          if (transportCase.status !== "PASS") return { transportCase };
          const productAcceptance = await verifyProductEvidence(
            { mode: "run", status: "PASS", runtime: report.runtime, cases: [transportCase] },
            config,
            clients,
          );
          if (productAcceptance?.cases?.length !== 1)
            fail("TASTE_STEP_EVIDENCE", "偏好步骤缺少唯一产品 Run 证据。", "INCONCLUSIVE");
          transportCase.runId = productAcceptance.cases[0].runId;
          return { transportCase, productAcceptance };
        },
      });
      if (isolation) report.historyIsolationWorkflow = historyWorkflow;
      else report.historySeedWorkflow = historyWorkflow;
      report.status = historyWorkflow.status;
      report.plannedCaseCount = 2;
      report.executedCaseCount = recorder.cases.length;
    } else if (memoryLifecycle) {
      const memoryContract = memoryWorkflow(memoryFamilyCase?.id ?? MEMORY_FAMILY_ID);
      const { runMemoryLifecycle } = await import("./lib/memory-lifecycle.mjs");
      const { discoverFeedbackCandidate, discoverPromotedMemory, verifyMemoryCleanup } =
        await import("./lib/memory-fixture.mjs");
      const { DatabaseSync } = await import("node:sqlite");
      const { writeMemoryCheckpoint } = await import("./lib/memory-checkpoint.mjs");
      const { captureMemoryProcess } = await import("./lib/memory-process.mjs");
      const memoryOrigin = {
        ...(memoryContract.checkpointVersion === 3 ? { familyId: memoryContract.id } : {}),
        runtime: report.runtime,
        process: await captureMemoryProcess(),
        scope: {
          connectionId: config.runtime.connectionId,
          botId: config.bot.qq,
          chatType: "private",
          chatId: config.driver.qq,
          senderId: config.driver.qq,
          threadId: config.runtime.threadId ?? null,
        },
        driverSha256: digest(config.driver.qq),
        suiteSha256: report.suiteSha256,
        startedAt: report.startedAt,
      };
      let memoryCheckpointState;
      let memoryCheckpointSequence = 0;
      let memoryCheckpointSha256 = null;
      const checkpointMemory = async (state) => {
        const row = {
          schemaVersion: memoryContract.checkpointVersion,
          origin: memoryOrigin,
          sequence: memoryCheckpointSequence + 1,
          previousSha256: memoryCheckpointSha256,
          ...state,
          at: new Date().toISOString(),
          runId,
          reportDirectory: runDir,
        };
        row.checkpointSha256 = digest(JSON.stringify(row));
        await writeMemoryCheckpoint({
          pendingPath: pendingFixturePath,
          journalPath: join(runDir, "memory-fixture.jsonl"),
          row,
          first: !pendingFixtureCreated,
        });
        pendingFixtureCreated = true;
        memoryCheckpointSequence = row.sequence;
        memoryCheckpointSha256 = row.checkpointSha256;
        memoryCheckpointState = state;
      };
      acceptance.beforeRegister = async (c) => {
        if (!memoryCheckpointState)
          fail("CHECKPOINT_UNCONFIRMED", "记忆流程没有注册前的状态记录。");
        await checkpointMemory({
          ...memoryCheckpointState,
          phase: "lease_intent",
          preparedCase: {
            caseId: c.id,
            marker: c.token,
            textSha256: digest(c.prompt),
            startedAt: c.startedAt,
            route: c.route,
          },
        });
      };
      acceptance.beforeSend = async (c, lease) => {
        if (!memoryCheckpointState)
          fail("CHECKPOINT_UNCONFIRMED", "记忆流程没有发送前的状态记录。");
        await checkpointMemory({
          ...memoryCheckpointState,
          phase: "prepared",
          preparedCase: {
            caseId: c.id,
            marker: c.token,
            textSha256: digest(c.prompt),
            startedAt: c.startedAt,
            route: c.route,
            leaseId: lease.leaseId,
            expiresAt: lease.expiresAt,
            toolsSha256: lease.toolsSha256,
          },
        });
      };
      acceptance.afterSend = async (c) => {
        await checkpointMemory({
          ...memoryCheckpointState,
          phase: "sent",
          sentCase: { caseId: c.id, driverMessageId: c.sentMessageId, startedAt: c.startedAt },
        });
      };
      report.memoryLifecycle = await runMemoryLifecycle({
        familyId: memoryContract.id,
        fixtureNonce: randomUUID().replaceAll("-", ""),
        signal: controller.signal,
        checkpoint: checkpointMemory,
        executeStep: async (stage, spec) => {
          if (stage !== "feedback") await sleep(config.minGapMs);
          const transportCase = await replyCase(
            config,
            clients,
            recorder,
            spec,
            controller.signal,
            acceptance,
          );
          if (transportCase.status !== "PASS") return { transportCase };
          const productAcceptance = await verifyProductEvidence(
            { mode: "run", status: "PASS", runtime: report.runtime, cases: [transportCase] },
            config,
            clients,
          );
          return { transportCase, productAcceptance };
        },
        observeStep: async (stage, handles) => {
          const db = new DatabaseSync(join(config.runtime.dataDirectory, "glassbox.db"), {
            readOnly: true,
          });
          try {
            const actor = db
              .prepare(
                "SELECT r.principal_id, p.kind FROM runs r JOIN principals p ON p.id=r.principal_id WHERE r.id=?",
              )
              .get(handles.stepRunId);
            if (
              !actor ||
              actor.kind !== "owner" ||
              (handles.principalId && actor.principal_id !== handles.principalId)
            )
              fail(
                "MEMORY_FIXTURE_OWNER",
                "本轮记忆测试 Run 的 Owner 身份不一致。",
                "INCONCLUSIVE",
              );
            const input = {
              runId: handles.stepRunId,
              principalId: actor.principal_id,
              projectId: handles.projectId,
            };
            const observed =
              stage === "feedback"
                ? discoverFeedbackCandidate(db, input)
                : stage === "promote"
                  ? discoverPromotedMemory(db, {
                      ...input,
                      candidateId: handles.candidateId,
                      creationRunId: handles.creationRunId,
                    })
                  : verifyMemoryCleanup(db, {
                      ...input,
                      candidateId: handles.candidateId,
                      memoryId: handles.memoryId,
                      creationRunId: handles.creationRunId,
                      cleanupRunId: handles.stepRunId,
                    });
            return { ...observed, principalKind: actor.kind, stepRunId: handles.stepRunId };
          } finally {
            db.close();
          }
        },
      });
      report.status = report.memoryLifecycle.status;
      report.plannedCaseCount = memoryContract.stages.length;
      report.executedCaseCount = recorder.cases.length;
    } else if (tasteLifecycle) {
      const { runTasteLifecycle } = await import("./lib/taste-lifecycle.mjs");
      const { verifyTasteKnownReplyFailure } = await import("./lib/taste-known-failure.mjs");
      const { observeTasteFixture } = await import("./lib/taste-fixture.mjs");
      const { writeTasteCheckpoint } = await import("./lib/taste-checkpoint.mjs");
      const { captureMemoryProcess } = await import("./lib/memory-process.mjs");
      const { DatabaseSync } = await import("node:sqlite");
      const tasteOrigin = {
        familyId: TASTE_FAMILY_ID,
        runtime: report.runtime,
        process: await captureMemoryProcess(),
        scope: {
          connectionId: config.runtime.connectionId,
          botId: config.bot.qq,
          chatType: "private",
          chatId: config.driver.qq,
          senderId: config.driver.qq,
          threadId: config.runtime.threadId ?? null,
        },
        driverSha256: digest(config.driver.qq),
        suiteSha256: report.suiteSha256,
        startedAt: report.startedAt,
      };
      let tasteCheckpointState;
      let tasteCheckpointSequence = 0;
      let tasteCheckpointSha256 = null;
      const checkpointTaste = async (state) => {
        const row = {
          schemaVersion: 1,
          familyId: TASTE_FAMILY_ID,
          origin: tasteOrigin,
          sequence: tasteCheckpointSequence + 1,
          previousSha256: tasteCheckpointSha256,
          ...state,
          at: new Date().toISOString(),
          runId,
          reportDirectory: runDir,
        };
        row.checkpointSha256 = digest(JSON.stringify(row));
        await writeTasteCheckpoint({
          pendingPath: pendingTasteFixturePath,
          journalPath: join(runDir, "taste-fixture.jsonl"),
          row,
          first: !pendingTasteFixtureCreated,
        });
        pendingTasteFixtureCreated = true;
        tasteCheckpointSequence = row.sequence;
        tasteCheckpointSha256 = row.checkpointSha256;
        tasteCheckpointState = state;
        return { confirmed: true };
      };
      acceptance.beforeRegister = async (c) => {
        if (!tasteCheckpointState)
          fail("TASTE_CHECKPOINT_UNCONFIRMED", "偏好流程没有注册前的状态记录。", "INCONCLUSIVE");
        await checkpointTaste({
          ...tasteCheckpointState,
          phase: "lease_intent",
          preparedCase: {
            caseId: c.id,
            marker: c.token,
            textSha256: digest(c.prompt),
            route: c.route,
          },
        });
      };
      acceptance.beforeSend = async (c, lease) => {
        if (!tasteCheckpointState)
          fail("TASTE_CHECKPOINT_UNCONFIRMED", "偏好流程没有发送前的状态记录。", "INCONCLUSIVE");
        await checkpointTaste({
          ...tasteCheckpointState,
          phase: "prepared",
          preparedCase: {
            caseId: c.id,
            marker: c.token,
            textSha256: digest(c.prompt),
            route: c.route,
            leaseId: lease.leaseId,
            expiresAt: lease.expiresAt,
            toolsSha256: lease.toolsSha256,
          },
        });
      };
      acceptance.afterSend = async (c) =>
        checkpointTaste({
          ...tasteCheckpointState,
          phase: "sent",
          sentCase: { caseId: c.id, driverMessageId: c.sentMessageId },
        });
      report.tasteLifecycle = await runTasteLifecycle({
        fixtureNonce: randomUUID().replaceAll("-", ""),
        signal: controller.signal,
        checkpoint: checkpointTaste,
        readRuntime: async () => runtimeSnapshot(config.runtime),
        confirmKnownFailure: async (stage, spec, testCase, failureCode, handles) => {
          if (failureCode === "REPLY_ASSERTION_FAILED")
            return verifyTasteKnownReplyFailure(testCase, {
              stage,
              handles,
              runtime: report.runtime,
              config,
              verifyCleanup: verifyFailedCaseCleanup,
              clients,
              readRuntime: () => runtimeSnapshot(config.runtime),
              readTrace: (runId) =>
                readTraceEvents(
                  report.runtime.checkout,
                  report.runtime.dataDirectory,
                  runId,
                  execFileSync,
                  ["tool_result"],
                ),
            });
          return verifyKnownTasteFeatureFailureCleanup(
            testCase,
            failureCode,
            config,
            clients,
            report.runtime,
            handles,
            stage,
          );
        },
        executeStep: async (stage, spec) => {
          if (stage !== "feedback") await sleep(config.minGapMs);
          const transportCase = await replyCase(
            config,
            clients,
            recorder,
            spec,
            controller.signal,
            acceptance,
          );
          if (transportCase.status !== "PASS") return { transportCase };
          const productAcceptance = await verifyProductEvidence(
            { mode: "run", status: "PASS", runtime: report.runtime, cases: [transportCase] },
            config,
            clients,
          );
          return { transportCase, productAcceptance };
        },
        observeStep: async (stage, handles) => {
          const db = new DatabaseSync(join(config.runtime.dataDirectory, "glassbox.db"), {
            readOnly: true,
          });
          try {
            const actor = db
              .prepare(
                "SELECT r.principal_id, p.kind FROM runs r JOIN principals p ON p.id=r.principal_id WHERE r.id=?",
              )
              .get(handles.stepRunId);
            if (
              !actor ||
              actor.kind !== "owner" ||
              (handles.principalId && actor.principal_id !== handles.principalId)
            )
              fail("TASTE_FIXTURE_OWNER", "本轮偏好测试 Run 的 Owner 身份不一致。", "INCONCLUSIVE");
            return observeTasteFixture(db, {
              ...handles,
              stage,
              fixtureNonce: handles.fixtureNonce,
              principalId: actor.principal_id,
            });
          } finally {
            db.close();
          }
        },
      });
      report.plannedCaseCount = 4;
      report.executedCaseCount = recorder.cases.length;
      if (
        report.tasteLifecycle.status === "FAIL" &&
        report.tasteLifecycle.cleanupConfirmed === true
      ) {
        report.status = "FAIL";
        report.productAcceptance = {
          status: "FAIL",
          code: report.tasteLifecycle.knownFailure.failureCode,
          acceptanceKind: "TASTE_LIFECYCLE",
          cleanupRequired: true,
          cleanupVerified: true,
          cases: [],
        };
      }
      if (report.tasteLifecycle.status === "PASS") {
        const { verifyTasteFamilyReport } = await import("./lib/taste-family-evidence.mjs");
        report.tasteFamilyAcceptance = await finalizeTasteFamilyAcceptance(report, (candidate) =>
          verifyTasteFamilyReport(candidate, {
            config,
            verifyProduct: (input) => verifyProductEvidence(input, config, clients),
            readRuntime: () => runtimeSnapshot(config.runtime),
            readFixture: (input) => {
              const db = new DatabaseSync(join(config.runtime.dataDirectory, "glassbox.db"), {
                readOnly: true,
              });
              try {
                return observeTasteFixture(db, input);
              } finally {
                db.close();
              }
            },
          }),
        );
      }
    } else {
      if (specs.length > config.maxMessages) fail("MESSAGE_BUDGET", "用例数超过本轮消息预算。");
      const sequence = await runReadCaseSequence({
        specs,
        executeCase: async (spec) => {
          if (controller.signal.aborted) fail("CANCELLED", "测试已停止。");
          const testCase = await replyCase(
            config,
            clients,
            recorder,
            spec,
            controller.signal,
            acceptance,
          );
          console.log(`${testCase.status} ${testCase.id} ${testCase.code}`);
          return testCase;
        },
        verifyProductCase:
          command === "run" && config.runtime
            ? (testCase) =>
                transportOnlySuite
                  ? import("./lib/product-evidence.mjs").then(
                      ({ verifyTransportOnlyCaseEvidence }) =>
                        verifyTransportOnlyCaseEvidence(
                          testCase,
                          config,
                          clients,
                          report.runtime,
                        ).then((evidence) => ({
                          status: evidence.status,
                          runtime: evidence.runtime,
                          cases: [evidence],
                        })),
                    )
                  : verifyProductEvidence(
                      { mode: "run", status: "PASS", runtime: report.runtime, cases: [testCase] },
                      config,
                      clients,
                    )
            : undefined,
        verifyCleanupOnlyCase:
          command === "run" && config.runtime
            ? (testCase) =>
                verifyFailedCaseCleanup(
                  { mode: "run", status: "FAIL", runtime: report.runtime, cases: [testCase] },
                  config,
                )
            : undefined,
        delay: () => sleep(config.minGapMs),
        serializeError: (error) => ({
          ...safeError(error),
          ...(typeof error?.cleanupVerified === "boolean"
            ? { cleanupVerified: error.cleanupVerified }
            : {}),
        }),
      });
      report.status = sequence.terminalStatus ?? recorder.finalize();
      if (command === "run" && config.runtime) {
        report.productAcceptance = sequence.productAcceptance;
      }
      if (sequence.cleanupStopRequired) report.cleanupStopRequired = true;
      report.plannedCaseCount = specs.length;
      report.executedCaseCount = recorder.cases.length;
      if (recorder.cases.length !== specs.length && report.status === "PASS")
        report.status = "INCONCLUSIVE";
    }
    if (command === "run" && config.runtime && report.status === "PASS" && transportOnlySuite) {
      try {
        const { verifyTransportOnlyEvidence } = await import("./lib/product-evidence.mjs");
        const verified = await verifyTransportOnlyEvidence(
          { ...report, mode: "run", status: "PASS", transportOnly: true },
          config,
          clients,
          report.runtime,
        );
        report.transportStatus = "PASS";
        report.productAcceptance = {
          ...verified,
          status: "TRANSPORT_ONLY",
          acceptanceKind: "TRANSPORT_ONLY",
          suiteSha256: report.suiteSha256,
        };
      } catch (error) {
        const safe = safeError(error);
        report.productAcceptance = {
          ...safe,
          acceptanceKind: "TRANSPORT_ONLY",
          cleanupVerified: error?.cleanupVerified === true,
          cleanupRequired: true,
          cases: report.productAcceptance?.cases ?? [],
        };
        if (report.productAcceptance.cleanupVerified !== true) report.cleanupStopRequired = true;
        if (report.status === "PASS") report.status = report.productAcceptance.status;
      }
    } else if (command === "run" && config.runtime && report.status === "PASS") {
      try {
        report.productAcceptance = await verifyProductEvidence(report, config, clients);
      } catch (error) {
        const safe = safeError(error);
        const cleanupRequired = report.cases.some(
          (testCase) =>
            testCase.transportOnly === true || Array.isArray(testCase.featureAssertions),
        );
        report.productAcceptance = {
          ...safe,
          ...(typeof error?.cleanupVerified === "boolean"
            ? { cleanupVerified: error.cleanupVerified }
            : cleanupRequired
              ? { cleanupVerified: false }
              : {}),
          ...(cleanupRequired ? { cleanupRequired: true } : {}),
          cases: report.productAcceptance?.cases ?? [],
        };
        if (report.status === "PASS") report.status = report.productAcceptance.status;
      }
    }
    if (command === "run" && !config.runtime && report.status === "PASS") {
      report.transportStatus = "PASS";
      report.status = "INCONCLUSIVE";
      report.note = "QQ 收发观察通过，但未配置运行版本与产品证据验证。不能用于合并。";
    }
    if (historyFamilyCase && report.status === "PASS") {
      const verifyHistory =
        historyFamilyCase.kind === "history-isolation"
          ? (await import("./lib/history-isolation-family-evidence.mjs"))
              .verifyHistoryIsolationFamilyReport
          : (await import("./lib/history-family-evidence.mjs")).verifyHistoryFamilyReport;
      report.historyFamilyAcceptance = await verifyHistory(report, {
        config,
        verifyProduct: (input) => verifyProductEvidence(input, config, clients),
      });
    }
    if (memoryFamilyCase && report.status === "PASS") {
      const { verifyMemoryFamilyReport } = await import("./lib/memory-family-evidence.mjs");
      const { verifyMemoryCleanup } = await import("./lib/memory-fixture.mjs");
      const { DatabaseSync } = await import("node:sqlite");
      report.memoryFamilyAcceptance = await verifyMemoryFamilyReport(report, {
        verifyProduct: (input) => verifyProductEvidence(input, config, clients),
        readCleanup: (handles) => {
          const db = new DatabaseSync(join(config.runtime.dataDirectory, "glassbox.db"), {
            readOnly: true,
          });
          try {
            const actor = db
              .prepare("SELECT kind FROM principals WHERE id=?")
              .get(handles.principalId);
            const cleanup = verifyMemoryCleanup(db, handles);
            return { ...cleanup, principalKind: actor?.kind };
          } finally {
            db.close();
          }
        },
      });
    }
  } catch (error) {
    report.error = safeError(error);
    report.status = report.error.status;
  } finally {
    clearInterval(timer);
    for (const unsubscribe of observers) unsubscribe();
    clients.driver.close();
    clients.bot.close();
    if (command === "run" && recorder.cases.length > 0) {
      const finalStatus = recorder.finalize();
      if (report.status === "PASS") report.status = finalStatus;
      if (
        ["PASS", "TRANSPORT_ONLY"].includes(report.productAcceptance.status) &&
        finalStatus !== "PASS"
      ) {
        report.productAcceptance = {
          ...report.productAcceptance,
          status: finalStatus,
          code: "OBSERVATION_CHANGED",
        };
        if (report.transportOnly) report.transportStatus = finalStatus;
      }
    }
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    report.finishedAt = new Date().toISOString();
    report.reportDirectory = runDir;
    try {
      const tasteKnownFailureCleanupConfirmed =
        report.tasteLifecycle?.status === "FAIL" &&
        report.tasteLifecycle?.cleanupConfirmed === true &&
        report.tasteLifecycle?.knownFailure?.terminalProof?.cleanupVerified === true;
      if (
        report.error?.code === "LEASE_CLEANUP_EVIDENCE" ||
        report.cleanupStopRequired === true ||
        productCleanupStopRequired(report.productAcceptance) ||
        report.cases.some(
          (c) =>
            (c.cleanup?.required && !c.cleanup.restored) ||
            (c.sendAttempted && c.status === "INCONCLUSIVE"),
        ) ||
        (pendingFixtureCreated &&
          (report.memoryLifecycle?.requiresReconciliation !== false ||
            report.status !== "PASS" ||
            report.productAcceptance.status !== "PASS")) ||
        (pendingTasteFixtureCreated &&
          !tasteKnownFailureCleanupConfirmed &&
          (report.tasteLifecycle?.requiresReconciliation !== false ||
            report.status !== "PASS" ||
            report.productAcceptance.status !== "PASS"))
      ) {
        await writeFile(
          join(out, "STOP"),
          "CLEANUP_UNCONFIRMED\n请先检查 Bot 的延迟任务、目标状态和本轮报告，再人工删除此文件。\n",
          { mode: 0o600 },
        );
        report.safetyStopCreated = true;
      }
      await mkdir(runDir, { recursive: true, mode: 0o700 });
      await writeJson(join(runDir, "report.json"), report);
      const lines = [
        `# QQ 测试报告`,
        "",
        `结果 ${report.status}`,
        `运行 ${runId}`,
        "",
        ...report.cases.map((c) => `${c.status} ${c.id} ${c.code}\n\n${c.detail}\n`),
      ];
      if (report.error) lines.push(report.error.message);
      lines.push(
        "",
        report.productAcceptance.acceptanceKind === "TRANSPORT_ONLY"
          ? "传输核验通过，但不计入功能覆盖或交付验收。"
          : report.productAcceptance.status === "PASS"
            ? `产品证据通过。运行提交 ${report.productAcceptance.runtime.commit}，进程 ${report.productAcceptance.runtime.pid}。`
            : "产品证据没有通过，不能用于合并。请检查 report.json 中的 productAcceptance。",
      );
      await writeFile(join(runDir, "summary.md"), lines.join("\n") + "\n", { mode: 0o600 });
      await writeJson(join(out, "latest.json"), {
        status: report.status,
        mode: command,
        runId,
        reportDirectory: runDir,
        productAcceptance: report.productAcceptance,
        ...(report.transportOnly
          ? { transportOnly: true, transportStatus: report.transportStatus }
          : {}),
        cases: report.cases.map((c) => ({
          id: c.id,
          status: c.status,
          code: c.code,
          detail: c.detail,
        })),
        error: report.error,
      });
      if (
        pendingFixtureCreated &&
        report.status === "PASS" &&
        report.productAcceptance.status === "PASS" &&
        report.memoryLifecycle?.requiresReconciliation === false &&
        report.memoryLifecycle?.status === "PASS"
      ) {
        await rm(pendingFixturePath);
        await syncDirectory(lockRoot);
      }
      if (pendingTasteFixtureCreated && tasteFixtureCheckpointRemovable(report)) {
        await rm(pendingTasteFixturePath);
        await syncDirectory(lockRoot);
      }
    } finally {
      await lock.close();
      await rm(lockPath, { force: true });
    }
  }
  console.log(`${report.status} 报告位于 ${runDir}`);
  process.exitCode = exitCode(report.status);
}
main().catch((error) => {
  console.error(JSON.stringify(safeError(error)));
  process.exitCode = exitCode(safeError(error).status);
});
