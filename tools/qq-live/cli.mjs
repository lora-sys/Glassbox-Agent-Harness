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
import { runtimeSnapshot, verifyProductEvidence } from "./lib/product-evidence.mjs";
import { acceptanceManagement } from "./lib/management-client.mjs";
import { resolveReadFeatureSpecs } from "./lib/feature-specs.mjs";
import { memoryFixtureStep } from "./lib/memory-scenario.mjs";
import { runMemoryRecoveryCli } from "./lib/memory-recovery-cli.mjs";

const root = dirname(fileURLToPath(import.meta.url));
const help = `QQ 实机测试器 0.1.0

node cli.mjs init
node cli.mjs doctor
node cli.mjs arm --minutes 30
node cli.mjs run --live
node cli.mjs run --live --case group-A
node cli.mjs run --live --case moderation
node cli.mjs plan --case memory-lifecycle
node cli.mjs run --live --case memory-lifecycle --approve-suite <SHA256>
node cli.mjs reconcile-memory
node cli.mjs reconcile-memory --live --approve-suite <SHA256>
node cli.mjs plan --scenarios examples/scenarios.example.json
node cli.mjs coverage
node cli.mjs report

通用选项 --config <文件> --out <报告目录>
run 默认测试私聊和已配置的群。moderation 需要独立配置和成员同意。
schemaVersion=1 的自然语言 scenarios 仅支持 plan。
schemaVersion=2 的结构化读取用例需要服务端逐消息许可、运行版本和工具证据。
memory-lifecycle 是固定的项目范围反馈、提升、过期流程，需要单独启用并保留审计记录。
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
      ].includes(k) ||
      !argv[i + 1] ||
      argv[i + 1].startsWith("--")
    )
      fail("ARGUMENT", "参数无效，运行 node cli.mjs help 查看帮助。");
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
    ].includes(command)
  )
    fail("COMMAND", "未知命令。");
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
  const placeholder = "0".repeat(32);
  return {
    schemaVersion: 3,
    scenario: "memory-lifecycle",
    stages: ["feedback", "promote", "expire"].map((stage) => ({
      stage,
      spec: JSON.parse(
        JSON.stringify(
          memoryFixtureStep(stage, {
            nonce: placeholder,
            candidateId: `candidate_${placeholder}`,
            memoryId: `memory_${placeholder}`,
          }),
        )
          .replaceAll(`candidate_${placeholder}`, "{{candidate_id}}")
          .replaceAll(`memory_${placeholder}`, "{{memory_id}}")
          .replaceAll(`qqtest-${placeholder}`, "qqtest-{{fixture_nonce}}"),
      ),
    })),
    cleanup:
      "expire the exact promoted fixture; retain feedback, candidate, Memory and audit history",
  };
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
      resolveReadFeatureSpecs(suite, config);
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
    live: command === "run" || (command === "reconcile-memory" && o.live === true),
  });
  if (command === "reconcile-memory") return runMemoryRecoveryCli(config, o, out);
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
  let specs = smokeSpecs(config),
    suiteHash = null,
    featureSuite = false;
  const memoryLifecycle = o.case === "memory-lifecycle";
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
  if (o.scenarios) {
    const suite = await jsonFile(resolve(o.scenarios));
    featureSuite = suite.raw?.schemaVersion === 2;
    if (command === "run" && !featureSuite)
      fail(
        "CUSTOM_LIVE_UNSUPPORTED",
        "自定义自然语言尚未有可验证的能力限制，仅支持 plan 审阅。实机运行使用固定用例。",
      );
    specs = featureSuite
      ? resolveReadFeatureSpecs(suite.raw, config)
      : validateSpecs(suite.raw, config);
    if (command === "run" && featureSuite && !config.runtime)
      fail("FEATURE_RUNTIME_REQUIRED", "功能用例必须配置并核对真实验收服务版本。");
    suiteHash = digest(suite.text);
    if (command === "run" && o["approve-suite"] !== suiteHash)
      fail(
        "SUITE_APPROVAL",
        "先运行 plan 审阅消息，再把输出 SHA256 传入 --approve-suite。文件修改后需要重新审阅。",
      );
  }
  if (command === "plan") {
    if (!o.scenarios) fail("SCENARIOS_REQUIRED", "plan 需要 --scenarios。");
    console.log(
      JSON.stringify(
        {
          suiteSha256: suiteHash,
          cases: specs,
          note: "这是待发送的消息，不是执行结果。sideEffect 声明不能代替代码授权检查。",
        },
        null,
        2,
      ),
    );
    return;
  }
  if (o.case && o.case !== "moderation" && !memoryLifecycle) {
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
    if (command === "run" && config.runtime) report.runtime = runtimeSnapshot(config.runtime);
    if (command === "run" && featureSuite) acceptance = await acceptanceManagement(config.runtime);
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
    } else if (memoryLifecycle) {
      const { runMemoryLifecycle } = await import("./lib/memory-lifecycle.mjs");
      const { discoverFeedbackCandidate, discoverPromotedMemory, verifyMemoryCleanup } =
        await import("./lib/memory-fixture.mjs");
      const { DatabaseSync } = await import("node:sqlite");
      const { writeMemoryCheckpoint } = await import("./lib/memory-checkpoint.mjs");
      const { captureMemoryProcess } = await import("./lib/memory-process.mjs");
      const memoryOrigin = {
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
          schemaVersion: 2,
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
      report.plannedCaseCount = 3;
      report.executedCaseCount = recorder.cases.length;
    } else {
      if (specs.length > config.maxMessages) fail("MESSAGE_BUDGET", "用例数超过本轮消息预算。");
      for (const spec of specs) {
        if (controller.signal.aborted) fail("CANCELLED", "测试已停止。");
        const c = await replyCase(config, clients, recorder, spec, controller.signal, acceptance);
        console.log(`${c.status} ${c.id} ${c.code}`);
        // Fail fast: do not let an unresolved request overlap a later case.
        if (c.status !== "PASS") break;
        await sleep(config.minGapMs);
      }
      report.status = recorder.finalize();
      report.plannedCaseCount = specs.length;
      report.executedCaseCount = recorder.cases.length;
      if (recorder.cases.length !== specs.length && report.status === "PASS")
        report.status = "INCONCLUSIVE";
    }
    if (command === "run" && config.runtime) {
      try {
        report.productAcceptance = await verifyProductEvidence(report, config, clients);
      } catch (error) {
        report.productAcceptance = safeError(error);
        if (report.status === "PASS") report.status = report.productAcceptance.status;
      }
    }
    if (command === "run" && !config.runtime && report.status === "PASS") {
      report.transportStatus = "PASS";
      report.status = "INCONCLUSIVE";
      report.note = "QQ 收发观察通过，但未配置运行版本与产品证据验证。不能用于合并。";
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
      if (finalStatus === "FAIL" || report.status === "PASS") report.status = finalStatus;
      if (report.productAcceptance.status === "PASS" && finalStatus !== "PASS")
        report.productAcceptance = {
          ...report.productAcceptance,
          status: finalStatus,
          code: "OBSERVATION_CHANGED",
        };
    }
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    report.finishedAt = new Date().toISOString();
    report.reportDirectory = runDir;
    try {
      if (
        report.cases.some(
          (c) =>
            (c.cleanup?.required && !c.cleanup.restored) ||
            (c.sendAttempted && c.status === "INCONCLUSIVE"),
        ) ||
        (pendingFixtureCreated &&
          (report.memoryLifecycle?.requiresReconciliation !== false ||
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
        report.productAcceptance.status === "PASS"
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
