#!/usr/bin/env node
import { readFile, writeFile, mkdir, open, rm, lstat } from "node:fs/promises";
import { appendFileSync } from "node:fs";
import { dirname, resolve, join, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { validateConfig, fail, safeError, sleep, digest, exitCode } from "./lib/core.mjs";
import { OneBot } from "./lib/onebot.mjs";
import { writeDurableReport } from "./lib/durable-report.mjs";
import {
  Recorder,
  doctor,
  smokeSpecs,
  validateSpecs,
  replyCase,
  privateAccountPreflightOnly,
} from "./lib/runner.mjs";
import { moderationCase } from "./lib/moderation.mjs";
import { runModerationCli, resolveModerationSelection } from "./lib/moderation-cli.mjs";
import { MODERATION_FAMILY_ID } from "./lib/moderation-scenario.mjs";
import { readModerationPolicyState } from "./lib/moderation-state.mjs";
import { isFixedPreRunReadCase } from "./lib/pre-run-cleanup-cases.mjs";
import {
  runtimeSnapshot,
  readTraceEvents,
  verifyProductEvidence,
  verifyFailedCaseCleanup,
  verifyKnownTasteFeatureFailureCleanup,
} from "./lib/product-evidence.mjs";
import {
  runReadCaseSequence,
  productCleanupStopRequired,
  fixedReadTimeoutCleanupConfirmed,
  fixedPreRunCleanupConfirmed,
} from "./lib/read-case-sequence.mjs";
import { acceptanceManagement } from "./lib/management-client.mjs";
import { runMemoryRecoveryCli } from "./lib/memory-recovery-cli.mjs";
import {
  runAcceptanceMemoryReconciliationCli,
  hasUnresolvedAcceptanceMemoryReconciliation,
} from "./lib/acceptance-memory-reconciliation.mjs";
import { hasUnresolvedPreRunStopReconciliation } from "./lib/pre-run-stop-reconciliation.mjs";
import {
  resolveFeatureSuite,
  memoryFamilyPlan,
  historyFamilyPlan,
  historyIsolationFamilyPlan,
} from "./lib/feature-suite.mjs";
import { MEMORY_FAMILY_ID, memoryWorkflow } from "./lib/memory-workflow.mjs";
import { TASTE_FAMILY_ID, tasteFamilyPlan } from "./lib/taste-scenario.mjs";
import { mediaFamilyPlan } from "./lib/media-scenario.mjs";
import { TASK_WORKER_FAMILY_ID, taskWorkerFamilyPlan } from "./lib/task-worker-scenario.mjs";
import { taskWorkerFixtureConfig } from "./lib/task-worker-config.mjs";
import { verifyTaskWorkerPreflight } from "./lib/task-worker-preflight.mjs";
import { resolveGroupPolicyCli, runGroupPolicyCli } from "./lib/group-policy-cli.mjs";
import { GROUP_POLICY_FAMILY_ID } from "./lib/group-policy-scenario.mjs";
import {
  resolveGroupMembersPolicyCli,
  runGroupMembersPolicyCli,
} from "./lib/group-members-policy-cli.mjs";
import { GROUP_MEMBERS_POLICY_FAMILY_ID } from "./lib/group-members-policy-scenario.mjs";
import {
  verifyGroupMembersPolicyTransition,
  readGroupMembersPolicyState,
} from "./lib/group-members-policy-state.mjs";
import { verifyGroupPolicyTransition, readGroupPolicyState } from "./lib/group-policy-state.mjs";
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

export function shouldWriteLatest(command, report, mediaRecoveryFinalProof) {
  return (
    command !== "resume-media" || (report?.status === "PASS" && Boolean(mediaRecoveryFinalProof))
  );
}

export async function runModerationNoEffectRecoveryCli(
  config,
  { reportPath, live = false, approvedPlanSha256, locksDirectory } = {},
  dependencies = {},
) {
  if (
    typeof reportPath !== "string" ||
    !isAbsolute(reportPath) ||
    resolve(reportPath) !== reportPath
  )
    fail("ARGUMENT", "禁言恢复需要规范的绝对报告路径。");
  if (
    (live !== true && approvedPlanSha256 !== undefined) ||
    (live === true && !/^[a-f0-9]{64}$/u.test(approvedPlanSha256 ?? ""))
  )
    fail("MODERATION_RECOVERY_APPROVAL", "归档必须显式 --live 并提供计划 SHA256。");

  const recovery =
    dependencies.recovery ?? (await import("./lib/moderation-no-effect-recovery.mjs"));
  const clients = dependencies.clients ?? {
    driver: new OneBot(config, "driver"),
    bot: new OneBot(config, "bot"),
  };
  try {
    await clients.driver.connect();
    await clients.bot.connect();
    const planInput = {
      reportPath,
      config,
      clients,
      ...(locksDirectory ? { locksDirectory } : {}),
    };
    const planned = await recovery.planModerationKnownNoEffectRecovery(planInput);
    if (live !== true) return planned;
    if (planned.planSha256 !== approvedPlanSha256)
      fail(
        "MODERATION_RECOVERY_APPROVAL",
        "禁言恢复计划已变化。请重新查看只读计划，再用当前 SHA256 批准归档。",
        "INCONCLUSIVE",
      );
    return await recovery.archiveModerationKnownNoEffectRecovery(
      { plan: planned.plan, planSha256: planned.planSha256 },
      {
        config,
        clients,
        approvedPlanSha256,
        ...(locksDirectory ? { locksDirectory } : {}),
      },
    );
  } finally {
    clients.driver.close();
    clients.bot.close();
  }
}

export function shouldCreateSafetyStop(
  report,
  {
    pendingFixtureCreated = false,
    pendingTasteFixtureCreated = false,
    pendingTaskWorkerFixtureCreated = false,
    pendingGroupPolicyFixtureCreated = false,
    pendingGroupMembersPolicyFixtureCreated = false,
    pendingModerationFixtureCreated = false,
    tasteKnownFailureCleanupConfirmed = false,
  } = {},
) {
  return (
    report.error?.code === "LEASE_CLEANUP_EVIDENCE" ||
    report.cleanupStopRequired === true ||
    productCleanupStopRequired(report.productAcceptance) ||
    report.cases.some(
      (c) =>
        (c.cleanup?.required && !c.cleanup.restored) ||
        (c.sendAttempted &&
          c.code === "API_REJECTED" &&
          isFixedPreRunReadCase(c.id) &&
          !fixedPreRunCleanupConfirmed(report.productAcceptance, c)) ||
        (c.sendAttempted &&
          c.status === "INCONCLUSIVE" &&
          !fixedReadTimeoutCleanupConfirmed(report.productAcceptance, c)),
    ) ||
    (pendingFixtureCreated &&
      (report.memoryLifecycle?.requiresReconciliation !== false ||
        report.status !== "PASS" ||
        report.productAcceptance.status !== "PASS")) ||
    (pendingTasteFixtureCreated &&
      !tasteKnownFailureCleanupConfirmed &&
      (report.tasteLifecycle?.requiresReconciliation !== false ||
        report.status !== "PASS" ||
        report.productAcceptance.status !== "PASS")) ||
    (pendingTaskWorkerFixtureCreated &&
      (report.status !== "PASS" ||
        report.taskWorkerAcceptance?.status !== "PASS" ||
        report.productAcceptance?.status !== "PASS" ||
        report.productAcceptance?.cleanupVerified !== true)) ||
    (pendingGroupPolicyFixtureCreated && !groupPolicyCompletionSafe(report)) ||
    (pendingGroupMembersPolicyFixtureCreated && !groupMembersPolicyCompletionSafe(report)) ||
    (pendingModerationFixtureCreated && !moderationCompletionSafe(report))
  );
}

function moderationCompletionSafe(report) {
  const result = report.moderationAcceptance;
  return (
    report.status === "PASS" &&
    result?.status === "MODERATION_WORKFLOW_VERIFIED" &&
    result.familyId === MODERATION_FAMILY_ID &&
    result.requiresReconciliation === false &&
    result.cleanupVerified === true &&
    result.actualQqDeliveryVerified === true &&
    report.productAcceptance?.status === "PASS" &&
    report.productAcceptance?.cleanupVerified === true &&
    report.moderationFinalStateProof?.status === "MODERATION_FINAL_STATE_VERIFIED"
  );
}

function groupPolicyCompletionSafe(report) {
  const finalStateVerified =
    report.groupPolicyFinalStateProof?.status === "GROUP_POLICY_FINAL_STATE_VERIFIED";
  const acceptance = report.groupPolicyAcceptance;
  const product = report.productAcceptance;
  const common =
    acceptance?.requiresReconciliation === false &&
    acceptance?.cleanupVerified === true &&
    acceptance?.actualQqDeliveryVerified === true &&
    product?.cleanupVerified === true &&
    finalStateVerified;
  return (
    common &&
    ((report.status === "PASS" &&
      acceptance.status === "GROUP_POLICY_WORKFLOW_VERIFIED" &&
      product.status === "PASS") ||
      (report.status === "FAIL" &&
        acceptance.status === "GROUP_POLICY_RESTORED_FEATURE_FAILED" &&
        product.status === "FAIL"))
  );
}

async function assertNoGroupMembersPolicyPending(config) {
  const { homedir } = await import("node:os");
  const account = createHash("sha256").update(config.driver.qq).digest("hex").slice(0, 24);
  const guard = join(
    homedir(),
    ".glassbox-qq-live-locks",
    account + ".group-members-policy-pending.json",
  );
  try {
    await lstat(guard);
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  fail(
    "GROUP_MEMBERS_POLICY_RECONCILIATION_REQUIRED",
    "该账号有未确认的群成员权限测试。先核实原始报告和检查点，禁止发送、清理或交付。",
    "INCONCLUSIVE",
  );
}
function groupMembersPolicyCompletionSafe(report) {
  const acceptance = report.groupMembersPolicyAcceptance;
  return (
    report.status === "PASS" &&
    acceptance?.status === "GROUP_MEMBERS_POLICY_BOUNDARY_VERIFIED" &&
    acceptance.requiresReconciliation === false &&
    acceptance.cleanupVerified === true &&
    acceptance.actualQqDeliveryVerified === true &&
    report.groupMembersPolicyFinalStateProof?.status ===
      "GROUP_MEMBERS_POLICY_FINAL_STATE_VERIFIED" &&
    report.productAcceptance?.status === "PASS" &&
    report.productAcceptance?.acceptanceKind === "GROUP_MEMBERS_POLICY_BOUNDARY" &&
    report.productAcceptance?.cleanupVerified === true
  );
}
function groupPolicyRestoredFeatureFailure(report) {
  const acceptance = report.groupPolicyAcceptance;
  return (
    acceptance?.status === "GROUP_POLICY_RESTORED_FEATURE_FAILED" &&
    acceptance.requiresReconciliation === false &&
    acceptance.cleanupVerified === true &&
    acceptance.actualQqDeliveryVerified === true
  );
}
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
node cli.mjs plan --case qq-group-policy-isolation
node cli.mjs run --live --case qq-group-policy-isolation --approve-suite <SHA256>
node cli.mjs plan --case qq-group-members-policy-isolation
node cli.mjs run --live --case qq-group-members-policy-isolation --approve-suite <SHA256>
node cli.mjs plan --case qq-group-moderation-exact-b
node cli.mjs run --live --case qq-group-moderation-exact-b --approve-suite <SHA256>
node cli.mjs plan --scenarios examples/feature-baseline.example.json
node cli.mjs plan --scenarios examples/media-private.example.json
node cli.mjs run --live --case media-private-delivery --scenarios examples/media-private.example.json --approve-suite <SHA256>
node cli.mjs plan-media-recovery --report <blocked-media-report.json>
node cli.mjs plan-media-delivery-gap-cleanup --report <blocked-media-report.json>
node cli.mjs reconcile-media-delivery-gap-cleanup --report <blocked-media-report.json> --live --approve-plan <SHA256>
node cli.mjs resume-media --live --report <blocked-media-report.json> --case media-private-delivery --scenarios examples/media-private.example.json --approve-suite <SHA256> --approve-recovery <SHA256>
node cli.mjs run --live --case history-group-seed-private-recall --scenarios examples/feature-baseline.example.json --approve-suite <SHA256>
node cli.mjs reconcile-memory
node cli.mjs reconcile-memory --live --approve-suite <SHA256>
node cli.mjs cleanup-acceptance-memory --input <manifest-json>
node cli.mjs cleanup-acceptance-memory --input <manifest-json> --live --approve-suite <SHA256>
node cli.mjs reconcile-acceptance-memory --input <manifest-json> --cleanup-report <report-json>
node cli.mjs reconcile-acceptance-memory --input <manifest-json> --cleanup-report <report-json> --live --approve-suite <SHA256>
node cli.mjs reconcile-completed-cleanup --input <manifest-json> --cleanup-failure <failed-report-json>
node cli.mjs reconcile-moderation --report <blocked-moderation-report.json>
node cli.mjs reconcile-moderation --report <blocked-moderation-report.json> --live --approve-suite <SHA256>
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
run 默认测试私聊和已配置的群。moderation 需要独立配置，并使用目标明确同意或严格的群主请求依据。群主请求仅适用于固定群 B，需每步重新确认发起者为群主，禁言时长固定为 30 秒。
schemaVersion=1 的自然语言 scenarios 仅支持 plan。
schemaVersion=2 的结构化读取用例需要服务端逐消息许可、运行版本和工具证据。
schemaVersion=4 增加固定群 A 种子与 Owner 私聊回查流程。
schemaVersion=5 增加群 B 种子与仅查询群 A 的私聊隔离流程。
 schemaVersion=6 增加固定 Taste 生命周期流程。
schemaVersion=7 提供固定 Owner 私聊图片和视频流程，需要启用并保留测试文件。
memory-lifecycle 是固定的项目范围反馈、提升、过期流程，需要单独启用并保留审计记录。
taste-lifecycle 是固定的项目范围正向反馈、提升、负向反馈和退役流程。中断时需恢复或清理固定测试资源。
qq-group-policy-isolation 是固定的 Owner 私聊群 B 历史检索关闭、核查与恢复流程，需要明确启用并保留审计记录。
qq-group-members-policy-isolation 是固定的 Owner 私聊群 B 成员读取关闭、拒绝核查与恢复流程。它验证权限边界，不证明已授权成员人数读取功能。
qq-group-moderation-exact-b 是固定的 Owner 私聊群 B 单一目标禁言与明确解禁流程，需要本轮目标同意、独立角色/策略检查和两次独立服务端许可。
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
        "--cleanup-report",
        "--cleanup-failure",
        "--report",
        "--approve-recovery",
        "--approve-plan",
        "--artifact",
        "--expected-review-binding",
      ].includes(k) ||
      !argv[i + 1] ||
      argv[i + 1].startsWith("--")
    )
      fail("ARGUMENT", "参数无效，运行 node cli.mjs help 查看帮助。");
    if (
      [
        "record-agent-review",
        "cleanup-acceptance-memory",
        "reconcile-acceptance-memory",
        "reconcile-completed-cleanup",
        "reconcile-moderation",
        "plan-media-recovery",
        "plan-media-delivery-gap-cleanup",
        "reconcile-media-delivery-gap-cleanup",
        "resume-media",
      ].includes(command) &&
      Object.hasOwn(o, k.slice(2))
    )
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
      "cleanup-acceptance-memory",
      "reconcile-acceptance-memory",
      "reconcile-completed-cleanup",
      "reconcile-moderation",
      "plan-media-recovery",
      "plan-media-delivery-gap-cleanup",
      "reconcile-media-delivery-gap-cleanup",
      "resume-media",
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
  if (command !== "reconcile-acceptance-memory" && Object.hasOwn(o, "cleanup-report"))
    fail("ARGUMENT", "--cleanup-report 仅用于固定记忆清理归档。");
  if (command !== "reconcile-completed-cleanup" && Object.hasOwn(o, "cleanup-failure"))
    fail("ARGUMENT", "--cleanup-failure 仅用于固定完成清理核验。");
  if (
    !["plan-media-recovery", "resume-media"].includes(command) &&
    Object.hasOwn(o, "approve-recovery")
  )
    fail("ARGUMENT", "--approve-recovery 仅用于固定媒体恢复。");
  if (
    !["plan-media-delivery-gap-cleanup", "reconcile-media-delivery-gap-cleanup"].includes(
      command,
    ) &&
    Object.hasOwn(o, "approve-plan")
  )
    fail("ARGUMENT", "--approve-plan 仅用于固定媒体缺失证据清理归档。");
  if (
    command === "record-agent-review" &&
    (!o.pr ||
      Object.keys(o).some(
        (key) => !["config", "out", "pr", "artifact", "expected-review-binding"].includes(key),
      ))
  )
    fail("ARGUMENT", "审查登记需要 --pr，只接受配置、审查文件和绑定哈希选项。");
  if (
    command === "cleanup-acceptance-memory" &&
    (!o.input ||
      Object.keys(o).some(
        (key) => !["input", "config", "out", "live", "approve-suite"].includes(key),
      ))
  )
    fail("ARGUMENT", "固定清理需要 --input，只接受配置、报告目录和当前计划审批选项。");
  if (
    command === "reconcile-acceptance-memory" &&
    (!o.input ||
      !o["cleanup-report"] ||
      Object.keys(o).some(
        (key) =>
          !["input", "cleanup-report", "config", "out", "live", "approve-suite"].includes(key),
      ))
  )
    fail("ARGUMENT", "固定清理归档需要 --input 和 --cleanup-report，只接受当前计划审批选项。");
  if (
    command === "reconcile-completed-cleanup" &&
    (!o.input ||
      !o["cleanup-failure"] ||
      Object.keys(o).some((key) => !["input", "cleanup-failure", "config", "out"].includes(key)))
  )
    fail("ARGUMENT", "完成清理核验需要 --input 和 --cleanup-failure，只接受配置和报告目录选项。");
  if (
    command === "reconcile-moderation" &&
    (!o.report ||
      !isAbsolute(o.report) ||
      Object.keys(o).some((key) => !["report", "config", "live", "approve-suite"].includes(key)) ||
      (o.live === true && !/^[a-f0-9]{64}$/u.test(o["approve-suite"] ?? "")) ||
      (o.live !== true && o["approve-suite"] !== undefined))
  )
    fail("ARGUMENT", "禁言恢复需要绝对报告路径；归档还需要显式 --live 和当前计划 SHA256。");
  if (
    command === "plan-media-recovery" &&
    (!o.report || Object.keys(o).some((key) => !["report", "config", "out"].includes(key)))
  )
    fail("ARGUMENT", "媒体恢复计划需要 --report，只接受配置和报告目录选项。");
  if (
    command === "plan-media-delivery-gap-cleanup" &&
    (!o.report || Object.keys(o).some((key) => !["report", "config", "out"].includes(key)))
  )
    fail("ARGUMENT", "固定媒体清理计划需要 --report，只接受配置和报告目录选项。");
  if (
    command === "reconcile-media-delivery-gap-cleanup" &&
    (!o.report ||
      o.live !== true ||
      !/^[a-f0-9]{64}$/u.test(o["approve-plan"] ?? "") ||
      Object.keys(o).some(
        (key) => !["report", "config", "out", "live", "approve-plan"].includes(key),
      ))
  )
    fail("ARGUMENT", "固定媒体清理归档需要精确报告、当前计划 SHA256 和显式 --live。");
  if (
    command === "resume-media" &&
    (!o.report ||
      !o["approve-recovery"] ||
      o.live !== true ||
      !["media-private-delivery"].includes(o.case) ||
      !o.scenarios ||
      !o["approve-suite"] ||
      Object.keys(o).some(
        (key) =>
          ![
            "report",
            "approve-recovery",
            "live",
            "case",
            "scenarios",
            "approve-suite",
            "config",
            "out",
          ].includes(key),
      ))
  )
    fail("ARGUMENT", "媒体恢复需要精确报告、固定媒体套件、计划哈希和显式 --live。");
  if (
    ["plan-media-recovery", "resume-media"].includes(command) &&
    Object.hasOwn(o, "approve-recovery") &&
    !/^[a-f0-9]{64}$/u.test(o["approve-recovery"])
  )
    fail("ARGUMENT", "--approve-recovery 必须是 64 位小写 SHA256。");
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
    return {
      runtimeProcessVerified: false,
      note: "未取得 Git 工作区版本，也未验证运行服务版本。",
    };
  }
}
async function writeJson(path, value) {
  await writeDurableReport(path, value);
}
async function syncDirectory(path) {
  const directory = await open(path, "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}
export async function acquireRunLock({
  lockPath,
  startedAt = new Date().toISOString(),
  identityRequired = false,
  platform = process.platform,
  pid = process.pid,
  captureProcess = async () => {
    const { captureMemoryProcess } = await import("./lib/memory-process.mjs");
    return captureMemoryProcess();
  },
  openFile = open,
  syncDirectoryFn = syncDirectory,
} = {}) {
  const processIdentity = identityRequired && platform === "linux" ? await captureProcess() : null;
  let lock;
  let created = false;
  let lockStat;
  try {
    lock = await openFile(lockPath, "wx", 0o600);
    created = true;
    lockStat = await lock.stat();
    await lock.writeFile(
      JSON.stringify({
        pid: processIdentity?.pid ?? pid,
        startedAt,
        ...(processIdentity ? { process: processIdentity } : {}),
      }),
    );
    await lock.sync();
    if (identityRequired && platform === "linux") await syncDirectoryFn(dirname(lockPath));
    return { lock, lockStat, processIdentity, startedAt };
  } catch (error) {
    if (lock) {
      try {
        await lock.close();
      } catch {
        // Keep the failure closed; the lock path is removed only if it is ours.
      }
    }
    if (created && lockStat) {
      try {
        const current = await lstat(lockPath);
        if (current.dev === lockStat.dev && current.ino === lockStat.ino) {
          await rm(lockPath);
          await syncDirectoryFn(dirname(lockPath));
        }
      } catch {
        // A cleanup failure leaves the account locked rather than permitting overlap.
      }
    }
    if (error?.code === "EEXIST")
      fail(
        "RUN_LOCKED",
        "该发起账号已有测试锁。先确认旧测试已停止及副作用已清理，不自动删除旧锁。",
      );
    fail(
      "RUN_LOCK_WRITE",
      "无法持久化测试账号锁，本轮未执行外部操作。请检查锁目录后再运行。",
      "INCONCLUSIVE",
    );
  }
}
function memoryPlan() {
  return memoryFamilyPlan();
}

export function applyCloseDrainFailure(report, error) {
  report.connectionClose = safeError(error);
  if (report.cases.some((testCase) => testCase.sendAttempted === true))
    report.cleanupStopRequired = true;
  if (["PASS", "TRANSPORT_ONLY"].includes(report.status)) report.status = "INCONCLUSIVE";
  if (report.transportOnly) report.transportStatus = "INCONCLUSIVE";
  if (["PASS", "TRANSPORT_ONLY"].includes(report.productAcceptance.status)) {
    report.productAcceptance = {
      ...report.productAcceptance,
      status: "INCONCLUSIVE",
      code: report.connectionClose.code,
    };
  }
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
      command === "resume-media" ||
      (command === "reconcile-media-delivery-gap-cleanup" && o.live === true) ||
      (command === "reconcile-moderation" && o.live === true) ||
      ([
        "reconcile-memory",
        "reconcile-taste",
        "cleanup-acceptance-memory",
        "reconcile-acceptance-memory",
      ].includes(command) &&
        o.live === true),
  });
  if (command === "plan-media-recovery") {
    if (
      !config.runtime ||
      config.mediaFixtures?.enabled !== true ||
      config.mediaFixtures?.retainAssetsConfirmed !== true
    )
      fail(
        "MEDIA_FIXTURE_DISABLED",
        "媒体恢复计划需要真实运行版本及已确认保留的固定媒体测试文件。",
      );
    const { planMediaImageRecovery } = await import("./lib/media-recovery.mjs");
    const plan = await planMediaImageRecovery({
      reportPath: resolve(o.report),
      config,
      expectedRuntime: runtimeSnapshot(config.runtime),
    });
    console.log(JSON.stringify(plan, null, 2));
    return plan;
  }
  if (
    ["plan-media-delivery-gap-cleanup", "reconcile-media-delivery-gap-cleanup"].includes(command)
  ) {
    if (
      !config.runtime ||
      config.mediaFixtures?.enabled !== true ||
      config.mediaFixtures?.retainAssetsConfirmed !== true
    )
      fail(
        "MEDIA_FIXTURE_DISABLED",
        "固定媒体清理核验需要已配置运行版本和已确认保留的媒体测试文件。",
      );
    const { applyMediaDeliveryGapCleanup, planMediaDeliveryGapCleanup } =
      await import("./lib/media-delivery-gap-cleanup.mjs");
    const clients = {
      driver: new OneBot(config, "driver"),
      bot: new OneBot(config, "bot"),
    };
    try {
      await clients.driver.connect();
      await clients.bot.connect();
      const input = {
        reportPath: resolve(o.report),
        config,
        expectedRuntime: runtimeSnapshot(config.runtime),
        clients,
      };
      const planned = await planMediaDeliveryGapCleanup(input);
      if (command === "plan-media-delivery-gap-cleanup") {
        console.log(JSON.stringify(planned, null, 2));
        return planned;
      }
      if (planned.plan.planSha256 !== o["approve-plan"])
        fail(
          "MEDIA_CLEANUP_APPROVAL",
          "媒体清理归档计划已变化，请先重新查看只读计划。",
          "INCONCLUSIVE",
        );
      const receipt = await applyMediaDeliveryGapCleanup(planned.plan, input, o["approve-plan"]);
      console.log(JSON.stringify(receipt, null, 2));
      return receipt;
    } finally {
      clients.driver.close();
      clients.bot.close();
    }
  }
  if (
    o.live === true &&
    [
      "run",
      "resume-media",
      "reconcile-memory",
      "reconcile-taste",
      "cleanup-acceptance-memory",
      "reconcile-acceptance-memory",
      "deliver",
    ].includes(command)
  ) {
    const { homedir } = await import("node:os");
    const { hasUnresolvedMediaDeliveryGapCleanup } =
      await import("./lib/media-delivery-gap-cleanup.mjs");
    if (
      await hasUnresolvedMediaDeliveryGapCleanup({
        config,
        locksDirectory: join(homedir(), ".glassbox-qq-live-locks"),
      })
    )
      fail(
        "MEDIA_DELIVERY_GAP_CLEANUP_REQUIRED",
        "该账号存在未完成的固定媒体清理归档。先核验原报告、检查点和归档收据，不得开始其他发送或交付。",
        "INCONCLUSIVE",
      );
  }
  if (
    o.live === true &&
    [
      "run",
      "resume-media",
      "reconcile-memory",
      "reconcile-taste",
      "cleanup-acceptance-memory",
      "reconcile-acceptance-memory",
      "deliver",
    ].includes(command)
  ) {
    const { homedir } = await import("node:os");
    const { existsSync } = await import("node:fs");
    const account = createHash("sha256").update(config.driver.qq).digest("hex").slice(0, 24);
    const guard = join(homedir(), ".glassbox-qq-live-locks", `${account}.moderation-pending.json`);
    if (existsSync(guard))
      fail(
        "MODERATION_RECONCILIATION_REQUIRED",
        "该账号有未确认的禁言或恢复操作。先独立核对目标状态和检查点，禁止继续发送或交付。",
        "INCONCLUSIVE",
      );
  }
  if (
    o.live === true &&
    [
      "run",
      "resume-media",
      "reconcile-memory",
      "reconcile-taste",
      "cleanup-acceptance-memory",
      "reconcile-acceptance-memory",
      "deliver",
    ].includes(command) &&
    (await hasUnresolvedPreRunStopReconciliation(out))
  )
    fail(
      "PRE_RUN_STOP_RECONCILIATION_REQUIRED",
      "存在未完成的预运行停止归档。先核实归档意图和停止文件，不得继续发送。",
    );
  if (
    [
      "run",
      "reconcile-memory",
      "reconcile-taste",
      "cleanup-acceptance-memory",
      "reconcile-acceptance-memory",
      "reconcile-completed-cleanup",
      "resume-media",
      "delivery-check",
      "deliver",
      "postmerge-check",
    ].includes(command)
  )
    await assertNoGroupMembersPolicyPending(config);
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
  if (command === "reconcile-moderation") {
    const result = await runModerationNoEffectRecoveryCli(config, {
      reportPath: o.report,
      live: o.live === true,
      ...(o["approve-suite"] !== undefined ? { approvedPlanSha256: o["approve-suite"] } : {}),
    });
    console.log(JSON.stringify(result, null, 2));
    return result;
  }
  if (command === "reconcile-memory") return runMemoryRecoveryCli(config, o, out);
  if (command === "cleanup-acceptance-memory") {
    const { runAcceptanceMemoryCleanupCli } =
      await import("./lib/acceptance-memory-cleanup-cli.mjs");
    const result = await runAcceptanceMemoryCleanupCli(config, o, out);
    console.log(JSON.stringify(result, null, 2));
    return result;
  }
  if (command === "reconcile-acceptance-memory") {
    const result = await runAcceptanceMemoryReconciliationCli(
      config,
      {
        input: o.input,
        cleanupReport: o["cleanup-report"],
        ...(o.live === true ? { live: true } : {}),
        ...(o["approve-suite"] !== undefined ? { "approve-suite": o["approve-suite"] } : {}),
      },
      out,
    );
    console.log(JSON.stringify(result, null, 2));
    return result;
  }
  if (command === "reconcile-completed-cleanup") {
    const { verifyAcceptanceMemoryCompletedCleanup } =
      await import("./lib/acceptance-memory-completed-cleanup.mjs");
    const reportPath = resolve(o["cleanup-failure"]);
    const result = await verifyAcceptanceMemoryCompletedCleanup({
      reportPath,
      reportDirectory: dirname(reportPath),
      manifestPath: resolve(o.input),
      config,
      out,
      expectedRuntime: runtimeSnapshot(config.runtime),
    });
    console.log(JSON.stringify(result, null, 2));
    return result;
  }
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
  if (["run", "resume-media"].includes(command) && o.live !== true)
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
  let groupPolicySelection = null;
  let groupMembersPolicySelection = null;
  let moderationSelection = null;
  if (o.case === GROUP_POLICY_FAMILY_ID) {
    if (!["plan", "run"].includes(command) || o.scenarios)
      fail("ARGUMENT", "群策略流程只支持固定用例的 plan 和 run，不接受 scenarios。");
    groupPolicySelection = resolveGroupPolicyCli({
      command,
      caseId: o.case,
      config,
      approvedSuite: o["approve-suite"],
    });
    if (command === "run" && config.maxMessages < groupPolicySelection.plan.stages.length)
      fail(
        "MESSAGE_BUDGET",
        `群策略流程需要 ${groupPolicySelection.plan.stages.length} 条消息预算。`,
      );
    if (command === "plan") {
      console.log(JSON.stringify(groupPolicySelection, null, 2));
      return;
    }
  }
  if (o.case === GROUP_MEMBERS_POLICY_FAMILY_ID) {
    if (!["plan", "run"].includes(command) || o.scenarios)
      fail("ARGUMENT", "群成员权限流程只支持固定用例的 plan 和 run，不接受 scenarios。");
    groupMembersPolicySelection = resolveGroupMembersPolicyCli({
      command,
      caseId: o.case,
      config,
      approvedSuite: o["approve-suite"],
    });
    if (command === "run" && config.maxMessages < groupMembersPolicySelection.plan.stages.length)
      fail("MESSAGE_BUDGET", "群成员权限流程需要三条消息预算。");
    if (command === "plan") {
      console.log(JSON.stringify(groupMembersPolicySelection, null, 2));
      return;
    }
  }
  if (o.case === MODERATION_FAMILY_ID) {
    if (!["plan", "run"].includes(command) || o.scenarios)
      fail("ARGUMENT", "固定禁言流程只支持 plan 和 run，不接受 scenarios。");
    moderationSelection = resolveModerationSelection({
      command,
      caseId: o.case,
      config,
      approvedSuite: o["approve-suite"],
    });
    if (command === "run" && config.maxMessages < 2)
      fail("MESSAGE_BUDGET", "禁言和恢复流程需要两条消息预算。");
    if (command === "plan") {
      console.log(JSON.stringify(moderationSelection, null, 2));
      return;
    }
  }
  const transportOnlySuite =
    !o.scenarios &&
    ![
      "memory-lifecycle",
      "taste-lifecycle",
      "moderation",
      GROUP_POLICY_FAMILY_ID,
      GROUP_MEMBERS_POLICY_FAMILY_ID,
      MODERATION_FAMILY_ID,
    ].includes(o.case) &&
    ["run", "resume-media", "plan"].includes(command);
  let specs = transportOnlySuite ? transportSmokeSpecs(config) : smokeSpecs(config),
    suiteHash = transportOnlySuite ? transportSuiteHash(config) : null,
    featureSuite = Boolean(
      groupPolicySelection || groupMembersPolicySelection || moderationSelection,
    );
  if (groupPolicySelection || groupMembersPolicySelection || moderationSelection) {
    suiteHash = (groupPolicySelection || groupMembersPolicySelection || moderationSelection)
      .suiteSha256;
    specs = [];
  }
  let memoryLifecycle = o.case === "memory-lifecycle";
  let tasteLifecycle = o.case === "taste-lifecycle";
  let memoryFamilyCase = null;
  let tasteFamilyCase = null;
  let historyFamilyCase = null;
  let mediaFamilyCase = null;
  let taskWorkerFamilyCase = null;
  let taskWorkerFixture = null;
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
    featureSuite = [2, 3, 4, 5, 6, 7, 8].includes(suite.raw?.schemaVersion);
    if (command === "run" && !featureSuite)
      fail(
        "CUSTOM_LIVE_UNSUPPORTED",
        "自定义自然语言尚未有可验证的能力限制，仅支持 plan 审阅。实机运行使用固定用例。",
      );
    if (featureSuite) {
      const resolved = resolveFeatureSuite(suite.raw, config);
      plannedSuiteCases = resolved.cases;
      specs = resolved.readCases;
      if (resolved.mediaFamilies?.length && ["run", "resume-media"].includes(command)) {
        if (o.case !== "media-private-delivery")
          fail("CASE_FAMILY_REQUIRED", "媒体流程需要选择固定用例。");
        mediaFamilyCase = resolved.mediaFamilies[0];
        if (
          config.mediaFixtures?.enabled !== true ||
          config.mediaFixtures?.retainAssetsConfirmed !== true
        )
          fail("MEDIA_FIXTURE_DISABLED", "请启用固定媒体测试并确认保留测试文件。");
        const remainingMessages = command === "resume-media" ? 1 : 2;
        if (config.maxMessages < remainingMessages)
          fail("MESSAGE_BUDGET", `固定媒体流程需要 ${remainingMessages} 条消息预算。`);
      }
      if (resolved.taskWorkerFamilies?.length && command === "run") {
        if (o.case !== TASK_WORKER_FAMILY_ID)
          fail("CASE_FAMILY_REQUIRED", "Worker 流程需要选择固定用例。");
        taskWorkerFamilyCase = resolved.taskWorkerFamilies[0];
        taskWorkerFixture = taskWorkerFixtureConfig(config);
        if (config.maxMessages < 4) fail("MESSAGE_BUDGET", "Worker 流程需要四条消息预算。");
        specs = [];
      }
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
    if (["run", "resume-media"].includes(command) && featureSuite && !config.runtime)
      fail("FEATURE_RUNTIME_REQUIRED", "功能用例必须配置并核对真实验收服务版本。");
    suiteHash = digest(suite.text);
    if (["run", "resume-media"].includes(command) && o["approve-suite"] !== suiteHash)
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
  if (command === "resume-media" && !mediaFamilyCase)
    fail("CASE_FAMILY_REQUIRED", "媒体恢复必须解析为固定媒体流程。");
  let mediaRecoveryPlan = null;
  if (command === "resume-media") {
    if (
      !config.runtime ||
      config.mediaFixtures?.enabled !== true ||
      config.mediaFixtures?.retainAssetsConfirmed !== true
    )
      fail("MEDIA_FIXTURE_DISABLED", "媒体恢复需要真实运行版本及保留测试文件的确认。");
    const { planMediaImageRecovery } = await import("./lib/media-recovery.mjs");
    const planned = await planMediaImageRecovery({
      reportPath: resolve(o.report),
      config,
      expectedRuntime: runtimeSnapshot(config.runtime),
    });
    if (planned.planSha256 !== o["approve-recovery"])
      fail("MEDIA_RECOVERY_APPROVAL", "媒体恢复计划已变化，请重新审阅并提供新的计划 SHA256。");
    mediaRecoveryPlan = planned.plan;
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
                memoryPlans: families.map((c) => ({
                  caseId: c.id,
                  plan: memoryFamilyPlan(c.id),
                })),
              };
            return {};
          })(),
          ...(plannedSuiteCases?.some((c) => c.kind === "taste-lifecycle")
            ? { tastePlan: tasteFamilyPlan() }
            : {}),
          ...(plannedSuiteCases?.some((c) => c.kind === "media-private-delivery")
            ? { mediaPlan: mediaFamilyPlan() }
            : {}),
          ...(plannedSuiteCases?.some((c) => c.kind === "task-worker-artifact-lifecycle")
            ? { taskWorkerPlan: taskWorkerFamilyPlan() }
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
    !groupPolicySelection &&
    !groupMembersPolicySelection &&
    !moderationSelection &&
    !memoryLifecycle &&
    !tasteLifecycle &&
    !historyFamilyCase &&
    !mediaFamilyCase &&
    !taskWorkerFamilyCase
  ) {
    specs = specs.filter((s) => s.id === o.case);
    if (!specs.length) fail("CASE_NOT_FOUND", "没有匹配的用例，未执行任何测试。");
  }
  if (["run", "resume-media"].includes(command) && o.live !== true)
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
  const pendingMediaFixturePath = lockPath.replace(/\.lock$/, ".media-pending.json");
  const pendingTaskWorkerFixturePath = lockPath.replace(/\.lock$/, ".task-worker-pending.json");
  const pendingGroupPolicyFixturePath = lockPath.replace(/\.lock$/, ".group-policy-pending.json");
  const pendingGroupMembersPolicyFixturePath = lockPath.replace(
    /\.lock$/,
    ".group-members-policy-pending.json",
  );
  const pendingModerationFixturePath = lockPath.replace(/\.lock$/, ".moderation-pending.json");
  const runStartedAt = new Date().toISOString();
  const { lock, processIdentity: runProcessIdentity } = await acquireRunLock({
    lockPath,
    startedAt: runStartedAt,
    identityRequired: ["run", "resume-media"].includes(command) && o.live === true,
  });
  const runId =
    new Date().toISOString().replaceAll(":", "-") + "_" + digest(String(Math.random())).slice(0, 8);
  const runDir = join(out, runId);
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  const clients = {
    driver: new OneBot(config, "driver"),
    bot: new OneBot(config, "bot"),
  };
  const secrets = [clients.driver.token, clients.bot.token];
  const recorder = new Recorder(config, secrets);
  const report = {
    schemaVersion: 1,
    toolVersion: "0.1.0",
    runId,
    mode: command,
    startedAt: runStartedAt,
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
  let mediaRecoveryEvidence = null;
  let mediaRecoveryFinalProof = null;
  let mediaRecoveryVideoCase = null;
  let mediaRecoveryVideoAcceptance = null;
  let pendingFixtureCreated = false;
  let pendingTasteFixtureCreated = false;
  let pendingMediaFixtureCreated = false;
  let pendingTaskWorkerFixtureCreated = false;
  let pendingGroupPolicyFixtureCreated = false;
  let pendingGroupMembersPolicyFixtureCreated = false;
  let pendingModerationFixtureCreated = false;
  let groupPolicyExecution;
  let groupMembersPolicyExecution;
  let moderationExecution;
  let recheckGroupMembersPolicyFinalState;
  let recheckGroupPolicyFinalState;
  let recheckModerationFinalState;
  let taskFixtureNonce;
  let taskExpectedTarget;
  let taskTrustedFixture;
  let taskDatabase;
  let taskVerifier;
  let taskCheckpointIdentity;
  let recheckTaskTerminal;
  const taskReceipts = [];
  const verifiedMediaSnapshots = new Map();
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
      appendFileSync(join(runDir, "events.jsonl"), JSON.stringify(e) + "\n", {
        mode: 0o600,
      });
    const { existsSync } = await import("node:fs");
    if (existsSync(join(out, "STOP")) && command !== "resume-media")
      fail("STOP_FILE", "存在 STOP 文件，本轮不会发送消息。");
    if (o.live === true && ["run", "resume-media", "deliver"].includes(command)) {
      const { hasUnresolvedMediaRecoveryRelease } = await import("./lib/media-recovery.mjs");
      if (await hasUnresolvedMediaRecoveryRelease(config, lockRoot))
        fail(
          "MEDIA_RECOVERY_RELEASE_REQUIRED",
          "媒体恢复的停止记录归档未完成。先核对恢复报告和发布意图，禁止继续发送。",
        );
    }
    let memoryReconciliationOptions = {
      stopPath: join(out, "STOP"),
      guardPath: pendingFixturePath,
    };
    if (command === "resume-media" && mediaRecoveryPlan) {
      const { mediaRecoveryPlanBinding } = await import("./lib/media-recovery.mjs");
      memoryReconciliationOptions = {
        ...memoryReconciliationOptions,
        replacementStop: mediaRecoveryPlanBinding(mediaRecoveryPlan),
        mediaRecoveryContext: {
          config,
          expectedRuntime: runtimeSnapshot(config.runtime),
          locksDirectory: lockRoot,
        },
      };
    }
    if (
      ["run", "resume-media"].includes(command) &&
      (await hasUnresolvedAcceptanceMemoryReconciliation(out, memoryReconciliationOptions))
    )
      fail(
        "MEMORY_RECONCILIATION_REQUIRED",
        "该发起账号有未核实的记忆清理归档。先核实原始报告和归档收据，禁止续发。",
      );
    if (["run", "resume-media"].includes(command) && existsSync(pendingFixturePath))
      fail(
        "MEMORY_RECONCILIATION_REQUIRED",
        "该发起账号有未核实的记忆测试资源。先核实原始报告和清理证据，禁止续发。",
      );
    if (["run", "resume-media"].includes(command) && existsSync(pendingTasteFixturePath))
      fail(
        "TASTE_RECONCILIATION_REQUIRED",
        "该发起账号有未核实的偏好测试资源。先核实原始报告和清理证据，禁止续发。",
      );
    if (command === "run" && existsSync(pendingMediaFixturePath))
      fail(
        "MEDIA_RECONCILIATION_REQUIRED",
        "该账号有未确认的媒体测试。请核实原始报告、发送状态和临时许可，禁止重复生成。",
      );
    if (["run", "resume-media"].includes(command) && existsSync(pendingTaskWorkerFixturePath))
      fail(
        "TASK_WORKER_RECONCILIATION_REQUIRED",
        "该账号有未确认的 Worker 测试。请核实原始报告和检查点，禁止重发。",
      );
    if (["run", "resume-media"].includes(command) && existsSync(pendingGroupPolicyFixturePath))
      fail(
        "GROUP_POLICY_RECONCILIATION_REQUIRED",
        "该账号有未确认的群策略测试。先核实原始报告和检查点，禁止重发。",
      );
    if (
      ["run", "resume-media"].includes(command) &&
      existsSync(pendingGroupMembersPolicyFixturePath)
    )
      fail(
        "GROUP_MEMBERS_POLICY_RECONCILIATION_REQUIRED",
        "该账号有未确认的群成员权限测试。先核实原始报告和检查点，禁止重发。",
      );
    if (["run", "resume-media"].includes(command) && existsSync(pendingModerationFixturePath))
      fail(
        "MODERATION_RECONCILIATION_REQUIRED",
        "该账号有未确认的禁言或恢复操作。先独立核对目标状态和检查点，禁止重试。",
        "INCONCLUSIVE",
      );
    if (["run", "resume-media"].includes(command) && config.runtime)
      report.runtime = runtimeSnapshot(config.runtime);
    if (["run", "resume-media"].includes(command) && (featureSuite || transportOnlySuite))
      acceptance = await acceptanceManagement(config.runtime);
    timer = setInterval(() => {
      if (command !== "resume-media" && existsSync(join(out, "STOP"))) controller.abort();
    }, 250);
    await clients.driver.connect();
    await clients.bot.connect();
    observers.push(clients.driver.subscribe((e) => recorder.ingest("driver", e)));
    observers.push(clients.bot.subscribe((e) => recorder.ingest("bot", e)));
    if (command === "resume-media") {
      const { verifyMediaImageRecoveryPlan } = await import("./lib/media-recovery.mjs");
      mediaRecoveryEvidence = await verifyMediaImageRecoveryPlan(mediaRecoveryPlan, {
        reportPath: resolve(o.report),
        config,
        expectedRuntime: report.runtime,
        clients,
      });
      const recoveredImageCase = {
        ...mediaRecoveryEvidence.transportCase,
        runId: mediaRecoveryEvidence.productRunId,
        mediaObservationExpectedType: "image",
        mediaObservationExpectedCaptionSha256: digest("图片已生成"),
        mediaObservations: mediaRecoveryEvidence.mediaObservations.candidates,
        mediaObservationOverflow: false,
        mediaObservationClosed: true,
      };
      recorder.cases.push(recoveredImageCase);
      report.mediaRecoveryPrefix = {
        status: mediaRecoveryEvidence.status,
        planSha256: mediaRecoveryEvidence.planSha256,
        proofSha256: mediaRecoveryEvidence.proofSha256,
        runId: mediaRecoveryEvidence.productRunId,
        mediaMessageBinding: mediaRecoveryEvidence.mediaMessageBinding,
      };
    }
    // These fixed families have exclusively Owner-private stages and no group targets.
    // Keep comprehensive group checks for standalone doctor, history and other cases.
    const privateFixtureOnly =
      ["run", "resume-media"].includes(command) &&
      Boolean(
        taskWorkerFamilyCase ||
        groupMembersPolicySelection ||
        mediaFamilyCase ||
        memoryLifecycle ||
        tasteLifecycle ||
        privateAccountPreflightOnly(specs),
      );
    report.environment = await doctor(
      config,
      clients,
      privateFixtureOnly ? { groupAliases: [] } : {},
    );
    if (command === "doctor") {
      report.status = "PASS";
      report.note = "只完成账号、在线状态和群成员检查，没有执行实机收发验收。";
    } else if (o.case === "moderation") {
      await moderationCase(config, clients, recorder, controller.signal);
      report.status = recorder.finalize();
    } else if (moderationSelection) {
      pendingModerationFixtureCreated = true;
      moderationExecution = await runModerationCli({
        selection: moderationSelection,
        config,
        clients,
        recorder,
        acceptance,
        signal: controller.signal,
        pendingPath: pendingModerationFixturePath,
        reportDirectory: runDir,
        reportRuntime: report.runtime,
        driverSha256: digest(config.driver.qq),
        processIdentity: runProcessIdentity,
      });
      report.moderationAcceptance = moderationExecution.result;
      report.moderationFinalStateProof = moderationExecution.result.finalProof;
      report.productAcceptance = {
        ...moderationExecution.productAcceptance,
        cleanupRequired: true,
        cleanupVerified: moderationExecution.result.cleanupVerified === true,
      };
      report.status =
        moderationExecution.result.status === "MODERATION_WORKFLOW_VERIFIED" &&
        report.productAcceptance.status === "PASS"
          ? "PASS"
          : "INCONCLUSIVE";
      report.plannedCaseCount = 2;
      report.executedCaseCount = recorder.cases.length;
      recheckModerationFinalState = () => {
        if (!isDeepStrictEqual(runtimeSnapshot(config.runtime), report.runtime))
          fail("MODERATION_RUNTIME_CHANGED", "禁言验收服务发生变化。", "INCONCLUSIVE");
        const currentPolicy = readModerationPolicyState(config);
        if (!isDeepStrictEqual(currentPolicy, moderationExecution.result.policyState))
          fail(
            "MODERATION_POLICY_CHANGED",
            "群 B 的禁言策略或授权在验收后发生变化。",
            "INCONCLUSIVE",
          );
        if (
          moderationExecution.result.finalProof?.status !== "MODERATION_FINAL_STATE_VERIFIED" ||
          moderationExecution.result.finalProof.roles?.status !==
            "MODERATION_FINAL_STATE_VERIFIED" ||
          moderationExecution.result.finalProof.roles.targetShutUpUntil > Date.now() / 1000
        )
          fail("MODERATION_FINAL_STATE", "禁言恢复后的双账号成员状态未通过复核。", "INCONCLUSIVE");
        return moderationExecution.result.finalProof;
      };
    } else if (groupPolicySelection) {
      pendingGroupPolicyFixtureCreated = true;
      groupPolicyExecution = await runGroupPolicyCli({
        selection: groupPolicySelection,
        config,
        clients,
        recorder,
        acceptance,
        signal: controller.signal,
        pendingPath: pendingGroupPolicyFixturePath,
        reportDirectory: runDir,
        reportRuntime: report.runtime,
        driverSha256: digest(config.driver.qq),
        processIdentity: runProcessIdentity,
      });
      report.groupPolicyAcceptance = groupPolicyExecution.result;
      recheckGroupPolicyFinalState = () => {
        const runtimeBefore = runtimeSnapshot(config.runtime);
        if (!isDeepStrictEqual(runtimeBefore, report.runtime))
          fail("GROUP_POLICY_RUNTIME_CHANGED", "群策略验收服务发生变化。", "INCONCLUSIVE");
        const originalHistoryGrantId = groupPolicyExecution.baseline?.B?.historyGrants?.[0]?.id;
        if (typeof originalHistoryGrantId !== "string" || !originalHistoryGrantId)
          fail("GROUP_POLICY_STATE_RECHECK", "群策略原始授权基线缺失。", "INCONCLUSIVE");
        const current = readGroupPolicyState(config, {
          originalHistoryGrantId,
        });
        const stateProof = verifyGroupPolicyTransition(
          groupPolicyExecution.baseline,
          current,
          "restore",
        );
        if (!isDeepStrictEqual(stateProof, groupPolicyExecution.result.finalProof))
          fail(
            "GROUP_POLICY_STATE_RECHECK",
            "群策略恢复后的独立状态与报告不一致。",
            "INCONCLUSIVE",
          );
        if (!isDeepStrictEqual(runtimeSnapshot(config.runtime), report.runtime))
          fail("GROUP_POLICY_RUNTIME_CHANGED", "群策略验收服务发生变化。", "INCONCLUSIVE");
        return {
          status: "GROUP_POLICY_FINAL_STATE_VERIFIED",
          policyVersion: current.B.version,
          stateProof,
          actualQqDeliveryVerified: false,
        };
      };
      const verified =
        report.groupPolicyAcceptance.status === "GROUP_POLICY_WORKFLOW_VERIFIED" &&
        report.groupPolicyAcceptance.requiresReconciliation === false &&
        report.groupPolicyAcceptance.cleanupVerified === true &&
        report.groupPolicyAcceptance.actualQqDeliveryVerified === true;
      const restoredFeatureFailure = groupPolicyRestoredFeatureFailure(report);
      report.status = verified ? "PASS" : restoredFeatureFailure ? "FAIL" : "INCONCLUSIVE";
      report.productAcceptance = {
        status: verified ? "PASS" : restoredFeatureFailure ? "FAIL" : "INCONCLUSIVE",
        runtime: report.runtime,
        cleanupRequired: true,
        cleanupVerified: verified || restoredFeatureFailure,
        cases: report.groupPolicyAcceptance.steps.map((step) => step.proof),
      };
      report.plannedCaseCount = 2;
      report.executedCaseCount = recorder.cases.length;
    } else if (groupMembersPolicySelection) {
      pendingGroupMembersPolicyFixtureCreated = true;
      groupMembersPolicyExecution = await runGroupMembersPolicyCli({
        selection: groupMembersPolicySelection,
        config,
        clients,
        recorder,
        acceptance,
        signal: controller.signal,
        pendingPath: pendingGroupMembersPolicyFixturePath,
        reportDirectory: runDir,
        reportRuntime: report.runtime,
        driverSha256: digest(config.driver.qq),
        processIdentity: runProcessIdentity,
      });
      report.groupMembersPolicyAcceptance = groupMembersPolicyExecution.result;
      recheckGroupMembersPolicyFinalState = () => {
        if (!isDeepStrictEqual(runtimeSnapshot(config.runtime), report.runtime))
          fail(
            "GROUP_MEMBERS_POLICY_RUNTIME_CHANGED",
            "群成员权限验收服务发生变化。",
            "INCONCLUSIVE",
          );
        const originalId = groupMembersPolicyExecution.baseline?.B?.memberGrants?.[0]?.id;
        if (typeof originalId !== "string" || !originalId)
          fail("GROUP_MEMBERS_POLICY_STATE_RECHECK", "缺少原始群成员授权记录。", "INCONCLUSIVE");
        const current = readGroupMembersPolicyState(config, {
          originalMemberGrantId: originalId,
        });
        const stateProof = verifyGroupMembersPolicyTransition(
          groupMembersPolicyExecution.baseline,
          current,
          "restore",
        );
        if (!isDeepStrictEqual(stateProof, groupMembersPolicyExecution.result.finalProof))
          fail(
            "GROUP_MEMBERS_POLICY_STATE_RECHECK",
            "群成员权限恢复后的独立状态与报告不一致。",
            "INCONCLUSIVE",
          );
        if (!isDeepStrictEqual(runtimeSnapshot(config.runtime), report.runtime))
          fail(
            "GROUP_MEMBERS_POLICY_RUNTIME_CHANGED",
            "群成员权限验收服务发生变化。",
            "INCONCLUSIVE",
          );
        return {
          status: "GROUP_MEMBERS_POLICY_FINAL_STATE_VERIFIED",
          policyVersion: current.B.version,
          stateProof,
          actualQqDeliveryVerified: false,
        };
      };
      const accepted =
        report.groupMembersPolicyAcceptance.status === "GROUP_MEMBERS_POLICY_BOUNDARY_VERIFIED" &&
        report.groupMembersPolicyAcceptance.requiresReconciliation === false &&
        report.groupMembersPolicyAcceptance.cleanupVerified === true &&
        report.groupMembersPolicyAcceptance.actualQqDeliveryVerified === true;
      report.status = accepted ? "PASS" : "INCONCLUSIVE";
      report.productAcceptance = {
        status: accepted ? "PASS" : "INCONCLUSIVE",
        acceptanceKind: "GROUP_MEMBERS_POLICY_BOUNDARY",
        runtime: report.runtime,
        cleanupRequired: true,
        cleanupVerified: accepted,
        cases: report.groupMembersPolicyAcceptance.steps.map((step) => step.proof),
      };
      report.plannedCaseCount = 3;
      report.executedCaseCount = recorder.cases.length;
    } else if (taskWorkerFamilyCase) {
      const { runTaskWorkerFamily } = await import("./lib/task-worker-family.mjs");
      const { createTaskWorkerStepVerifier } = await import("./lib/task-worker-evidence.mjs");
      const { openReadOnlyDatabase } = await import("./lib/read-only-database.mjs");
      const { createTaskWorkerCheckpoint, advanceTaskWorkerCheckpoint } =
        await import("./lib/task-worker-checkpoint.mjs");
      const { waitForTaskWorkerCompletion } = await import("./lib/task-worker-completion.mjs");
      await verifyTaskWorkerPreflight({
        dataDirectory: report.runtime.dataDirectory,
        fixture: taskWorkerFixture,
        runtime: report.runtime,
      });
      taskFixtureNonce = randomUUID().replaceAll("-", "");
      taskExpectedTarget = {
        workspaceId: taskWorkerFixture.workspaceId,
        herdrSession: taskWorkerFixture.herdrSession,
        agentKind: taskWorkerFixture.agentKind,
        markerSha256: taskWorkerFixture.markerSha256,
      };
      taskTrustedFixture = {
        canonicalRoot: taskWorkerFixture.canonicalRoot,
        productWorkspaceId: taskWorkerFixture.productWorkspaceId,
        markerSha256: taskWorkerFixture.markerSha256,
      };
      taskDatabase = openReadOnlyDatabase(join(report.runtime.dataDirectory, "glassbox.db"));
      taskVerifier = createTaskWorkerStepVerifier({
        db: taskDatabase,
        dataDirectory: report.runtime.dataDirectory,
        config,
        clients,
        trustedFixture: taskTrustedFixture,
      });
      recheckTaskTerminal = async () => {
        if (JSON.stringify(runtimeSnapshot(config.runtime)) !== JSON.stringify(report.runtime))
          fail("RUNTIME_CHANGED", "Worker 验收服务发生变化。", "INCONCLUSIVE");
        const { verifyTaskWorkerTerminalState } = await import("./lib/task-worker-evidence.mjs");
        const createdReceipt = taskReceipts[0];
        const acceptedReceipt = taskReceipts.at(-1);
        return verifyTaskWorkerTerminalState({
          db: taskDatabase,
          taskId: acceptedReceipt.taskId,
          attemptId: acceptedReceipt.attemptId,
          bindingId: acceptedReceipt.bindingId,
          creationRunId: createdReceipt.runId,
          acceptedRunId: acceptedReceipt.acceptedRunId,
          fixtureNonce: taskFixtureNonce,
          expectedWorkerTarget: taskExpectedTarget,
          trustedFixture: taskTrustedFixture,
          scope: acceptedReceipt.scope,
          principalId: acceptedReceipt.principalId,
        });
      };
      pendingTaskWorkerFixtureCreated = true;
      const created = await createTaskWorkerCheckpoint({
        pendingPath: pendingTaskWorkerFixturePath,
        reportDirectory: runDir,
        identity: {
          runtime: report.runtime,
          suiteSha256: suiteHash,
          fixtureNonce: taskFixtureNonce,
          workerTarget: taskExpectedTarget,
          startedAt: report.startedAt,
        },
      });
      taskCheckpointIdentity = created.identity;
      const taskConfig = { ...config, timeoutMs: taskWorkerFixture.timeoutMs };
      const productCases = [];
      report.productAcceptance = {
        status: "INCONCLUSIVE",
        runtime: report.runtime,
        cleanupRequired: true,
        cleanupVerified: false,
        cases: productCases,
      };
      report.taskWorkerAcceptance = await runTaskWorkerFamily({
        fixtureNonce: taskFixtureNonce,
        expectedWorkerTarget: taskExpectedTarget,
        signal: controller.signal,
        readRuntime: () => runtimeSnapshot(config.runtime),
        checkpoint: async (row) => {
          await advanceTaskWorkerCheckpoint({
            pendingPath: pendingTaskWorkerFixturePath,
            reportDirectory: runDir,
            identity: taskCheckpointIdentity,
            stage: row.stage,
            phase: row.phase,
            ...(row.phase === "verified" ? { proof: taskReceipts.at(-1) } : {}),
          });
          return true;
        },
        executeStep: async (stage, spec) => {
          if (stage === "delegate")
            await verifyTaskWorkerPreflight({
              dataDirectory: report.runtime.dataDirectory,
              fixture: taskWorkerFixture,
              runtime: report.runtime,
            });
          if (stage === "inspect") {
            const prior = taskReceipts.at(-1);
            await waitForTaskWorkerCompletion({
              config,
              taskId: prior.taskId,
              attemptId: prior.attemptId,
              bindingId: prior.bindingId,
              expectedRuntime: report.runtime,
              signal: controller.signal,
            });
          }
          const transportCase = await replyCase(
            taskConfig,
            clients,
            recorder,
            spec,
            controller.signal,
            acceptance,
          );
          if (transportCase.status !== "PASS")
            fail(
              "TASK_WORKER_TRANSPORT_UNCONFIRMED",
              "Worker 请求的真实回复未确认，本轮不会重发。",
              "INCONCLUSIVE",
            );
          const productAcceptance = await verifyProductEvidence(
            {
              mode: "run",
              status: "PASS",
              runtime: report.runtime,
              cases: [transportCase],
            },
            config,
            clients,
          );
          transportCase.runId = productAcceptance.cases[0]?.runId;
          productCases.push(productAcceptance.cases[0]);
          return { transportCase, productAcceptance };
        },
        verifyStep: async (stage, ctx) => {
          const receipt = await taskVerifier(stage, ctx);
          taskReceipts.push(receipt);
          return receipt;
        },
      });
      report.taskWorkerReceipts = taskReceipts;
      report.productAcceptance = {
        status: "PASS",
        runtime: report.runtime,
        cleanupRequired: true,
        cleanupVerified: true,
        cases: productCases,
      };
      report.status = "PASS";
      report.plannedCaseCount = 4;
      report.executedCaseCount = recorder.cases.length;
    } else if (mediaFamilyCase) {
      const { runMediaWorkflow } = await import("./lib/media-workflow.mjs");
      const { mediaObservationFor } = await import("./lib/media-scenario.mjs");
      const { verifyMediaCase } = await import("./lib/media-product-evidence.mjs");
      const { waitForMediaCompletion } = await import("./lib/media-completion.mjs");
      const { writeMemoryCheckpoint } = await import("./lib/memory-checkpoint.mjs");
      const mediaConfig = {
        ...config,
        timeoutMs: config.mediaFixtures.timeoutMs,
      };
      let sequence = mediaRecoveryEvidence ? 4 : 0,
        currentStage;
      const checkpoint = async (row) => {
        const first = sequence === 0;
        pendingMediaFixtureCreated = true;
        await writeMemoryCheckpoint({
          pendingPath: pendingMediaFixturePath,
          journalPath: mediaRecoveryPlan?.checkpointPath ?? join(runDir, "media-fixture.jsonl"),
          first,
          row: {
            schemaVersion: 1,
            familyId: mediaFamilyCase.id,
            sequence: ++sequence,
            driverSha256: digest(config.driver.qq),
            suiteSha256: suiteHash,
            runtime: report.runtime,
            process: runProcessIdentity,
            reportDirectory: runDir,
            recordedAt: new Date().toISOString(),
            ...row,
          },
        });
        return true;
      };
      acceptance.beforeRegister = (c) =>
        checkpoint({
          stage: currentStage,
          phase: "lease_intent",
          caseId: c.id,
          marker: c.token,
          textSha256: digest(c.prompt),
        });
      acceptance.beforeSend = (c, lease) =>
        checkpoint({
          stage: currentStage,
          phase: "send_intent",
          caseId: c.id,
          marker: c.token,
          leaseId: lease.leaseId,
          toolsSha256: lease.toolsSha256,
          textSha256: digest(c.prompt),
        });
      acceptance.afterSend = (c) =>
        checkpoint({
          stage: currentStage,
          phase: "sent",
          caseId: c.id,
          driverMessageId: c.sentMessageId,
        });
      const receipts = mediaRecoveryEvidence
        ? [
            {
              caseId: "media-image-1k",
              ...mediaRecoveryEvidence.mediaAcceptance,
            },
          ]
        : [];
      report.mediaFamilyAcceptance = await runMediaWorkflow({
        signal: controller.signal,
        checkpoint,
        ...(mediaRecoveryEvidence
          ? {
              verifiedPrefix: mediaRecoveryEvidence.prefix,
              revalidatePrefix: async (prefix) => {
                if (!isDeepStrictEqual(prefix, mediaRecoveryEvidence.prefix))
                  fail("MEDIA_RECOVERY_PREFIX_CHANGED", "图片前缀证据已变化。", "INCONCLUSIVE");
                const { revalidateMediaImagePrefix } = await import("./lib/media-recovery.mjs");
                return revalidateMediaImagePrefix(mediaRecoveryPlan, mediaRecoveryEvidence, {
                  reportPath: resolve(o.report),
                  config,
                  expectedRuntime: report.runtime,
                  clients,
                });
              },
            }
          : {}),
        executeStep: async (stage, spec) => {
          currentStage = stage;
          const transportCase = await replyCase(
            mediaConfig,
            clients,
            recorder,
            spec,
            controller.signal,
            acceptance,
            mediaObservationFor(stage),
          );
          if (transportCase.status !== "PASS")
            fail("MEDIA_TRANSPORT_UNCONFIRMED", "媒体请求的真实回复未确认。", "INCONCLUSIVE");
          const stageController = new AbortController();
          const stageSignal = AbortSignal.any([
            controller.signal,
            stageController.signal,
            AbortSignal.timeout(config.mediaFixtures.timeoutMs),
          ]);
          try {
            await Promise.all([
              recorder.waitForMediaObservation(transportCase.id, stageSignal),
              waitForMediaCompletion({
                config,
                caseRecord: transportCase,
                signal: stageSignal,
              }),
            ]);
          } finally {
            stageController.abort();
          }
          const observations = recorder.mediaObservationSnapshot(transportCase.id);
          const receipt = await verifyMediaCase({
            stage,
            caseRecord: transportCase,
            config,
            clients,
            expectedRuntime: report.runtime,
            mediaObservations: observations,
          });
          transportCase.runId = receipt.runId;
          receipts.push({ caseId: transportCase.id, ...receipt });
          if (mediaRecoveryEvidence && stage === "video-4s") {
            mediaRecoveryVideoCase = transportCase;
            mediaRecoveryVideoAcceptance = receipt;
          }
          verifiedMediaSnapshots.set(transportCase.id, observations);
          recorder.closeMediaObservation(transportCase.id);
          return { transportCase, mediaAcceptance: receipt };
        },
      });
      report.status = report.mediaFamilyAcceptance.status;
      report.productAcceptance = {
        status: report.status,
        runtime: report.runtime,
        cleanupRequired: true,
        cleanupVerified: true,
        cases: receipts,
      };
      report.plannedCaseCount = 2;
      report.executedCaseCount = recorder.cases.length;
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
        checkpoint({
          phase: "sent",
          caseId: c.id,
          driverMessageId: c.sentMessageId,
        });
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
            {
              mode: "run",
              status: "PASS",
              runtime: report.runtime,
              cases: [transportCase],
            },
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
        process: runProcessIdentity ?? (await captureMemoryProcess()),
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
          sentCase: {
            caseId: c.id,
            driverMessageId: c.sentMessageId,
            startedAt: c.startedAt,
          },
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
            {
              mode: "run",
              status: "PASS",
              runtime: report.runtime,
              cases: [transportCase],
            },
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
            return {
              ...observed,
              principalKind: actor.kind,
              stepRunId: handles.stepRunId,
            };
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
        process: runProcessIdentity ?? (await captureMemoryProcess()),
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
            {
              mode: "run",
              status: "PASS",
              runtime: report.runtime,
              cases: [transportCase],
            },
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
                      {
                        mode: "run",
                        status: "PASS",
                        runtime: report.runtime,
                        cases: [testCase],
                      },
                      config,
                      clients,
                    )
            : undefined,
        verifyCleanupOnlyCase:
          command === "run" && config.runtime
            ? (testCase) =>
                verifyFailedCaseCleanup(
                  {
                    mode: "run",
                    status: "FAIL",
                    runtime: report.runtime,
                    cases: [testCase],
                  },
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
    } else if (
      command === "run" &&
      config.runtime &&
      report.status === "PASS" &&
      !mediaFamilyCase
    ) {
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
    const closeResults = await Promise.allSettled([
      clients.driver.closeAndDrain(),
      clients.bot.closeAndDrain(),
    ]);
    const closeFailure = closeResults.find((result) => result.status === "rejected");
    if (closeFailure) applyCloseDrainFailure(report, closeFailure.reason);
    for (const unsubscribe of observers) unsubscribe();
    if (mediaFamilyCase) {
      for (const [caseId, verified] of verifiedMediaSnapshots) {
        if (
          JSON.stringify(recorder.mediaObservationSnapshot(caseId)) !== JSON.stringify(verified)
        ) {
          report.status = "INCONCLUSIVE";
          report.productAcceptance = {
            ...report.productAcceptance,
            status: "INCONCLUSIVE",
            code: "MEDIA_OBSERVATION_CHANGED",
          };
        }
      }
      if (pendingMediaFixtureCreated && report.status !== "PASS") report.cleanupStopRequired = true;
    }
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
    if (
      pendingGroupPolicyFixtureCreated &&
      ((report.status === "PASS" &&
        report.groupPolicyAcceptance?.status === "GROUP_POLICY_WORKFLOW_VERIFIED") ||
        (report.status === "FAIL" && groupPolicyRestoredFeatureFailure(report)))
    ) {
      try {
        if (
          closeResults.some((result) => result.status !== "fulfilled") ||
          clients.driver.closed !== true ||
          clients.bot.closed !== true ||
          clients.driver.pending.size !== 0 ||
          clients.bot.pending.size !== 0
        )
          fail("GROUP_POLICY_DRAIN_UNCONFIRMED", "群策略观察连接没有完成排空。", "INCONCLUSIVE");
        report.groupPolicyFinalStateProof = recheckGroupPolicyFinalState();
      } catch (error) {
        report.status = "INCONCLUSIVE";
        report.error = safeError(error);
        report.groupPolicyAcceptance = {
          ...report.groupPolicyAcceptance,
          status: "INCONCLUSIVE",
          requiresReconciliation: true,
          actualQqDeliveryVerified: false,
        };
        report.productAcceptance = {
          ...report.productAcceptance,
          status: "INCONCLUSIVE",
          cleanupVerified: false,
          code: report.error.code,
        };
        report.cleanupStopRequired = true;
      }
    }
    if (
      pendingGroupMembersPolicyFixtureCreated &&
      report.status === "PASS" &&
      report.groupMembersPolicyAcceptance?.status === "GROUP_MEMBERS_POLICY_BOUNDARY_VERIFIED"
    ) {
      try {
        if (
          closeResults.some((result) => result.status !== "fulfilled") ||
          clients.driver.closed !== true ||
          clients.bot.closed !== true ||
          clients.driver.pending.size !== 0 ||
          clients.bot.pending.size !== 0
        )
          fail(
            "GROUP_MEMBERS_POLICY_DRAIN_UNCONFIRMED",
            "群成员权限观察连接没有完成排空。",
            "INCONCLUSIVE",
          );
        report.groupMembersPolicyFinalStateProof = recheckGroupMembersPolicyFinalState();
      } catch (error) {
        report.status = "INCONCLUSIVE";
        report.error = safeError(error);
        report.groupMembersPolicyAcceptance = {
          ...report.groupMembersPolicyAcceptance,
          status: "INCONCLUSIVE",
          requiresReconciliation: true,
          actualQqDeliveryVerified: false,
        };
        report.productAcceptance = {
          ...report.productAcceptance,
          status: "INCONCLUSIVE",
          cleanupVerified: false,
          code: report.error.code,
        };
        report.cleanupStopRequired = true;
      }
    }
    if (command === "resume-media" && report.status === "PASS") {
      try {
        if (
          closeResults.some((result) => result.status !== "fulfilled") ||
          clients.driver.closed !== true ||
          clients.bot.closed !== true ||
          clients.driver.pending.size !== 0 ||
          clients.bot.pending.size !== 0 ||
          !mediaRecoveryEvidence ||
          !mediaRecoveryVideoCase ||
          !mediaRecoveryVideoAcceptance
        )
          fail(
            "MEDIA_RECOVERY_DRAIN_UNCONFIRMED",
            "媒体恢复观察连接没有完成排空。",
            "INCONCLUSIVE",
          );
        const { verifyMediaRecoveryAppendOnly } = await import("./lib/media-recovery.mjs");
        mediaRecoveryFinalProof = await verifyMediaRecoveryAppendOnly(mediaRecoveryPlan, {
          config,
          expectedRuntime: report.runtime,
          reportDirectory: runDir,
          processIdentity: runProcessIdentity,
          imagePrefixProofSha256: mediaRecoveryEvidence.proofSha256,
          imagePrefixProductRunId: mediaRecoveryEvidence.productRunId,
          imagePrefixAssetId: mediaRecoveryEvidence.mediaAcceptance.asset.assetId,
          videoCase: mediaRecoveryVideoCase,
          videoAcceptance: mediaRecoveryVideoAcceptance,
        });
        report.mediaRecoveryFinalProof = mediaRecoveryFinalProof;
      } catch (error) {
        report.status = "INCONCLUSIVE";
        report.error = safeError(error);
        report.productAcceptance = {
          ...report.productAcceptance,
          status: "INCONCLUSIVE",
          cleanupVerified: false,
          code: report.error.code,
        };
        report.cleanupStopRequired = true;
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
        shouldCreateSafetyStop(report, {
          pendingFixtureCreated,
          pendingTasteFixtureCreated,
          pendingTaskWorkerFixtureCreated,
          pendingGroupPolicyFixtureCreated,
          pendingGroupMembersPolicyFixtureCreated,
          pendingModerationFixtureCreated,
          tasteKnownFailureCleanupConfirmed,
        }) &&
        !(
          command === "resume-media" &&
          (await lstat(join(out, "STOP")).then(
            () => true,
            () => false,
          ))
        )
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
        report.productAcceptance.acceptanceKind === "GROUP_MEMBERS_POLICY_BOUNDARY"
          ? "群成员权限边界核验通过。结果只证明关闭后的拒绝和策略恢复，不证明允许读取成员人数。"
          : report.productAcceptance.acceptanceKind === "TRANSPORT_ONLY"
            ? "传输核验通过，但不计入功能覆盖或交付验收。"
            : report.productAcceptance.status === "PASS"
              ? `产品证据通过。运行提交 ${report.productAcceptance.runtime.commit}，进程 ${report.productAcceptance.runtime.pid}。`
              : "产品证据没有通过，不能用于合并。请检查 report.json 中的 productAcceptance。",
      );
      await writeFile(join(runDir, "summary.md"), lines.join("\n") + "\n", {
        mode: 0o600,
      });
      if (shouldWriteLatest(command, report, mediaRecoveryFinalProof))
        await writeJson(join(out, "latest.json"), {
          status: report.status,
          mode: command,
          runId,
          reportDirectory: runDir,
          productAcceptance: report.productAcceptance,
          ...(report.mediaRecoveryFinalProof
            ? { mediaRecoveryFinalProof: report.mediaRecoveryFinalProof }
            : {}),
          ...(report.mediaFamilyAcceptance
            ? { mediaFamilyAcceptance: report.mediaFamilyAcceptance }
            : {}),
          ...(report.groupMembersPolicyAcceptance
            ? {
                groupMembersPolicyAcceptance: report.groupMembersPolicyAcceptance,
              }
            : {}),
          ...(report.groupMembersPolicyFinalStateProof
            ? {
                groupMembersPolicyFinalStateProof: report.groupMembersPolicyFinalStateProof,
              }
            : {}),
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
        pendingGroupPolicyFixtureCreated &&
        groupPolicyCompletionSafe(report) &&
        groupPolicyExecution
      ) {
        try {
          for (const path of [join(runDir, "report.json"), join(out, "latest.json")]) {
            const file = await open(path, "r");
            try {
              await file.sync();
            } finally {
              await file.close();
            }
          }
          await syncDirectory(runDir);
          await syncDirectory(out);
          const guard = await groupPolicyExecution.complete({
            reportPath: join(runDir, "report.json"),
            connectionsDrained: true,
            recheck: recheckGroupPolicyFinalState,
          });
          pendingGroupPolicyFixtureCreated = false;
          await writeJson(join(out, "latest.json"), {
            status: report.status,
            mode: command,
            runId,
            reportDirectory: runDir,
            productAcceptance: report.productAcceptance,
            groupPolicyAcceptance: report.groupPolicyAcceptance,
            groupPolicyGuardLifecycle: guard,
            groupPolicyFinalStateProof: report.groupPolicyFinalStateProof,
            cases: report.cases.map((c) => ({
              id: c.id,
              status: c.status,
              code: c.code,
              detail: c.detail,
            })),
            error: report.error,
          });
        } catch (error) {
          report.status = "INCONCLUSIVE";
          report.error = safeError(error);
          report.groupPolicyAcceptance = {
            ...report.groupPolicyAcceptance,
            status: "INCONCLUSIVE",
            requiresReconciliation: true,
            actualQqDeliveryVerified: false,
          };
          report.productAcceptance = {
            ...report.productAcceptance,
            status: "INCONCLUSIVE",
            cleanupVerified: false,
            code: report.error.code,
          };
          report.cleanupStopRequired = true;
          report.safetyStopCreated = true;
          await writeFile(
            join(out, "STOP"),
            "GROUP_POLICY_COMPLETION_UNCONFIRMED\n请核对群策略检查点与报告后再恢复测试。\n",
            { mode: 0o600 },
          );
          await writeJson(join(runDir, "report.json"), report);
          lines[2] = `结果 ${report.status}`;
          lines.push(report.error.message);
          await writeFile(join(runDir, "summary.md"), lines.join("\n") + "\n", {
            mode: 0o600,
          });
          await writeJson(join(out, "latest.json"), {
            status: report.status,
            mode: command,
            runId,
            reportDirectory: runDir,
            productAcceptance: report.productAcceptance,
            groupPolicyAcceptance: report.groupPolicyAcceptance,
            groupPolicyFinalStateProof: report.groupPolicyFinalStateProof,
            error: report.error,
          });
        }
      }
      if (
        pendingGroupMembersPolicyFixtureCreated &&
        groupMembersPolicyCompletionSafe(report) &&
        groupMembersPolicyExecution
      ) {
        try {
          for (const path of [join(runDir, "report.json"), join(out, "latest.json")]) {
            const file = await open(path, "r");
            try {
              await file.sync();
            } finally {
              await file.close();
            }
          }
          await syncDirectory(runDir);
          await syncDirectory(out);
          const guard = await groupMembersPolicyExecution.complete({
            reportPath: join(runDir, "report.json"),
            connectionsDrained: true,
            recheck: recheckGroupMembersPolicyFinalState,
          });
          pendingGroupMembersPolicyFixtureCreated = false;
          await writeJson(join(out, "latest.json"), {
            status: report.status,
            mode: command,
            runId,
            reportDirectory: runDir,
            productAcceptance: report.productAcceptance,
            groupMembersPolicyAcceptance: report.groupMembersPolicyAcceptance,
            groupMembersPolicyGuardLifecycle: guard,
            groupMembersPolicyFinalStateProof: report.groupMembersPolicyFinalStateProof,
            cases: report.cases.map((c) => ({
              id: c.id,
              status: c.status,
              code: c.code,
              detail: c.detail,
            })),
            error: report.error,
          });
        } catch (error) {
          report.status = "INCONCLUSIVE";
          report.error = safeError(error);
          report.groupMembersPolicyAcceptance = {
            ...report.groupMembersPolicyAcceptance,
            status: "INCONCLUSIVE",
            requiresReconciliation: true,
            actualQqDeliveryVerified: false,
          };
          report.productAcceptance = {
            ...report.productAcceptance,
            status: "INCONCLUSIVE",
            cleanupVerified: false,
            code: report.error.code,
          };
          report.cleanupStopRequired = true;
          report.safetyStopCreated = true;
          await writeFile(
            join(out, "STOP"),
            "GROUP_MEMBERS_POLICY_COMPLETION_UNCONFIRMED\n请核对群成员权限检查点与报告后再恢复测试。\n",
            { mode: 0o600 },
          );
          await writeJson(join(runDir, "report.json"), report);
          lines[2] = "结果 " + report.status;
          lines.push(report.error.message);
          await writeFile(join(runDir, "summary.md"), lines.join("\n") + "\n", {
            mode: 0o600,
          });
          await writeJson(join(out, "latest.json"), {
            status: report.status,
            mode: command,
            runId,
            reportDirectory: runDir,
            productAcceptance: report.productAcceptance,
            groupMembersPolicyAcceptance: report.groupMembersPolicyAcceptance,
            groupMembersPolicyFinalStateProof: report.groupMembersPolicyFinalStateProof,
            error: report.error,
          });
        }
      }
      if (
        pendingModerationFixtureCreated &&
        moderationCompletionSafe(report) &&
        moderationExecution
      ) {
        try {
          for (const path of [join(runDir, "report.json"), join(out, "latest.json")]) {
            const file = await open(path, "r");
            try {
              await file.sync();
            } finally {
              await file.close();
            }
          }
          await syncDirectory(runDir);
          await syncDirectory(out);
          const guard = await moderationExecution.complete({
            reportPath: join(runDir, "report.json"),
            connectionsDrained:
              closeResults.every((result) => result.status === "fulfilled") &&
              clients.driver.closed === true &&
              clients.bot.closed === true &&
              clients.driver.pending.size === 0 &&
              clients.bot.pending.size === 0,
            recheck: recheckModerationFinalState,
          });
          report.moderationGuardLifecycle = guard;
          await writeJson(join(out, "latest.json"), {
            status: report.status,
            mode: command,
            runId,
            reportDirectory: runDir,
            productAcceptance: report.productAcceptance,
            moderationAcceptance: report.moderationAcceptance,
            moderationFinalStateProof: report.moderationFinalStateProof,
            moderationGuardLifecycle: guard,
            cases: report.cases.map((c) => ({
              id: c.id,
              status: c.status,
              code: c.code,
              detail: c.detail,
            })),
            error: report.error,
          });
          await syncDirectory(out);
          await rm(pendingModerationFixturePath);
          await syncDirectory(lockRoot);
          pendingModerationFixtureCreated = false;
        } catch (error) {
          report.status = "INCONCLUSIVE";
          report.error = safeError(error);
          report.moderationAcceptance = {
            ...report.moderationAcceptance,
            status: "INCONCLUSIVE",
            requiresReconciliation: true,
            cleanupVerified: false,
            actualQqDeliveryVerified: false,
          };
          report.productAcceptance = {
            ...report.productAcceptance,
            status: "INCONCLUSIVE",
            cleanupVerified: false,
            code: report.error.code,
          };
          report.cleanupStopRequired = true;
          report.safetyStopCreated = true;
          await writeFile(
            join(out, "STOP"),
            "MODERATION_COMPLETION_UNCONFIRMED\n请核对禁言和解禁检查点后再恢复。\n",
            { mode: 0o600 },
          );
          await writeJson(join(runDir, "report.json"), report);
          lines[2] = `结果 ${report.status}`;
          lines.push(report.error.message);
          await writeFile(join(runDir, "summary.md"), lines.join("\n") + "\n", { mode: 0o600 });
          await writeJson(join(out, "latest.json"), {
            status: report.status,
            mode: command,
            runId,
            reportDirectory: runDir,
            productAcceptance: report.productAcceptance,
            moderationAcceptance: report.moderationAcceptance,
            error: report.error,
          });
        }
      }
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
      if (pendingTaskWorkerFixtureCreated && report.status === "PASS") {
        try {
          report.taskWorkerFinalState = await recheckTaskTerminal();
          if (closeResults.some((result) => result.status !== "fulfilled"))
            fail("TASK_WORKER_DRAIN", "Worker 测试观察连接没有完成关闭。", "INCONCLUSIVE");
          const { completeTaskWorkerCheckpoint } = await import("./lib/task-worker-checkpoint.mjs");
          for (const path of [join(runDir, "report.json"), join(out, "latest.json")]) {
            const file = await open(path, "r");
            try {
              await file.sync();
            } finally {
              await file.close();
            }
          }
          await syncDirectory(runDir);
          await syncDirectory(out);
          report.taskWorkerGuardLifecycle = await completeTaskWorkerCheckpoint({
            pendingPath: pendingTaskWorkerFixturePath,
            reportDirectory: runDir,
            identity: taskCheckpointIdentity,
            receipts: taskReceipts,
            drainReceipt: Object.fromEntries(
              ["driver", "bot"].map((role) => [
                role,
                {
                  closed: clients[role].closed,
                  pendingCount: clients[role].pending.size,
                },
              ]),
            ),
          });
          await writeJson(join(runDir, "report.json"), report);
        } catch (error) {
          report.status = "INCONCLUSIVE";
          report.error = safeError(error);
          report.cleanupStopRequired = true;
          report.safetyStopCreated = true;
          await writeFile(
            join(out, "STOP"),
            "TASK_WORKER_COMPLETION_UNCONFIRMED\n请核对 Worker 检查点与报告后再恢复测试。\n",
            { mode: 0o600 },
          );
          await writeJson(join(runDir, "report.json"), report);
        }
        await writeJson(join(out, "latest.json"), {
          status: report.status,
          mode: command,
          runId,
          reportDirectory: runDir,
          taskWorkerGuardLifecycle: report.taskWorkerGuardLifecycle,
          productAcceptance: report.productAcceptance,
          error: report.error,
        });
      }
      if (
        pendingMediaFixtureCreated &&
        command === "run" &&
        report.status === "PASS" &&
        report.productAcceptance.status === "PASS" &&
        report.mediaFamilyAcceptance?.status === "PASS" &&
        report.productAcceptance.cleanupVerified === true
      ) {
        for (const path of [join(runDir, "report.json"), join(out, "latest.json")]) {
          const file = await open(path, "r");
          try {
            await file.sync();
          } finally {
            await file.close();
          }
        }
        await syncDirectory(runDir);
        await syncDirectory(out);
        await rm(pendingMediaFixturePath);
        await syncDirectory(lockRoot);
      }
      if (
        command === "resume-media" &&
        mediaRecoveryFinalProof &&
        report.status === "PASS" &&
        report.productAcceptance.status === "PASS"
      ) {
        for (const path of [join(runDir, "report.json"), join(out, "latest.json")]) {
          const file = await open(path, "r");
          try {
            await file.sync();
          } finally {
            await file.close();
          }
        }
        await syncDirectory(runDir);
        await syncDirectory(out);
        const { releaseMediaRecoveryGuards } = await import("./lib/media-recovery.mjs");
        try {
          await releaseMediaRecoveryGuards(mediaRecoveryPlan, mediaRecoveryFinalProof, {
            finalReportPath: join(runDir, "report.json"),
            finalLatestPath: join(out, "latest.json"),
            reportRunId: runId,
          });
        } catch (error) {
          report.status = "INCONCLUSIVE";
          report.error = safeError(error);
          report.cleanupStopRequired = true;
          report.productAcceptance = {
            ...report.productAcceptance,
            status: "INCONCLUSIVE",
            cleanupVerified: false,
            code: report.error.code,
          };
          if (
            !(await lstat(join(out, "STOP")).then(
              () => true,
              () => false,
            ))
          )
            await writeFile(
              join(out, "STOP"),
              "MEDIA_RECOVERY_RELEASE_UNCONFIRMED\n请核对媒体恢复发布意图和报告后再恢复测试。\n",
              { mode: 0o600 },
            );
          report.safetyStopCreated = true;
          await writeJson(join(runDir, "report.json"), report);
          await writeJson(join(out, "latest.json"), {
            status: report.status,
            mode: command,
            runId,
            reportDirectory: runDir,
            productAcceptance: report.productAcceptance,
            mediaFamilyAcceptance: report.mediaFamilyAcceptance,
            mediaRecoveryFinalProof: report.mediaRecoveryFinalProof,
            error: report.error,
          });
        }
      }
    } finally {
      taskDatabase?.close();
      await lock.close();
      await rm(lockPath, { force: true });
    }
  }
  console.log(`${report.status} 报告位于 ${runDir}`);
  process.exitCode = exitCode(report.status);
}
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]))
  main().catch((error) => {
    console.error(JSON.stringify(safeError(error)));
    process.exitCode = exitCode(safeError(error).status);
  });
