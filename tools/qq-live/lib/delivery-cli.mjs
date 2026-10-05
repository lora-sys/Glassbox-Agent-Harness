import { readFile, open, mkdir, lstat, rm, realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { digest, fail, safeError } from "./core.mjs";
import { resolveFeatureSuite } from "./feature-suite.mjs";
import { evaluateDeliveryGate } from "./delivery-gate.mjs";
import { verifyProductEvidence } from "./product-evidence.mjs";
import { verifyMemoryFamilyReport } from "./memory-family-evidence.mjs";
import { verifyMemoryCleanup } from "./memory-fixture.mjs";
import { OneBot } from "./onebot.mjs";
import { doctor } from "./runner.mjs";
import { FEATURE_CATALOG, checkRepositoryFeatureCoverage } from "../feature-catalog.mjs";

const runFile = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));

export async function readDeliveryJson(path, maximum = 1024 * 1024) {
  const info = await lstat(path);
  if (!info.isFile() || info.size > maximum)
    fail("DELIVERY_FILE", "交付证据必须是大小受限的普通文件。");
  try {
    const text = await readFile(path, "utf8");
    if (Buffer.byteLength(text) > maximum) fail("DELIVERY_FILE", "交付证据超过大小限制。");
    return JSON.parse(text);
  } catch {
    fail("DELIVERY_FILE", "交付证据文件无法读取。");
  }
}

export function validateReportManifest(value) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(",") !== "reports,schemaVersion" ||
    value.schemaVersion !== 1 ||
    !Array.isArray(value.reports) ||
    !value.reports.length ||
    value.reports.length > 100 ||
    value.reports.some((path) => typeof path !== "string" || !path || path.length > 4096) ||
    new Set(value.reports).size !== value.reports.length
  )
    fail("DELIVERY_MANIFEST", "报告清单必须列出不同的本地报告文件。");
  return value.reports;
}

export function verifyPostMergeAttempt(
  attempt,
  { prUrl, candidateCommit, suiteSha256, acceptanceIdentitySha256 },
) {
  if (
    !/^[a-f0-9]{40}$/.test(candidateCommit ?? "") ||
    !/^[a-f0-9]{64}$/.test(suiteSha256 ?? "") ||
    !/^[a-f0-9]{64}$/.test(acceptanceIdentitySha256 ?? "") ||
    !attempt ||
    attempt.status !== "ATTEMPTING" ||
    attempt.prUrl !== prUrl ||
    attempt.commit !== candidateCommit ||
    attempt.remoteHead !== candidateCommit ||
    attempt.suiteSha256 !== suiteSha256 ||
    attempt.acceptanceIdentitySha256 !== acceptanceIdentitySha256 ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(
      attempt.attemptId ?? "",
    ) ||
    !Number.isFinite(Date.parse(attempt.startedAt))
  )
    fail("POST_MERGE_ATTEMPT", "合并后验收必须关联原来的持久合并记录。");
  return attempt.attemptId;
}

export async function readDeliveryRemoteEvidence(github, commit, postMerge = false) {
  const current = await github.readRemote();
  if (!postMerge) return current;
  const merged = await github.readMergedChecks(commit);
  if (
    merged.commit !== commit ||
    !Array.isArray(merged.requiredCheckNames) ||
    !merged.requiredCheckNames.length
  )
    fail("POST_MERGE_CI", "合并后 CI 不属于待验收提交，或缺少固定检查清单。");
  return {
    ...current,
    checks: merged.checks,
    requiredCheckNames: merged.requiredCheckNames,
    checksCommit: merged.commit,
  };
}

async function durableCreate(path, value) {
  const file = await open(path, "wx", 0o600);
  try {
    await file.writeFile(JSON.stringify(value, null, 2) + "\n");
    await file.sync();
  } finally {
    await file.close();
  }
  const directory = await open(dirname(path), "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

async function absent(path, code) {
  try {
    await lstat(path);
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  fail(code, "存在停止或未完成记录，交付不能继续。");
}

async function releaseOwnedLock(lock, lockPath) {
  const owned = await lock.stat();
  await lock.close();
  try {
    const current = await lstat(lockPath);
    if (current.dev === owned.dev && current.ino === owned.ino) await rm(lockPath);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

/** Production entry point. All judgments are rebuilt from repository, product and GitHub state. */
export async function runDeliveryCli(config, options, out) {
  if (options.postMerge === true && options.executeMerge === true)
    fail("POST_MERGE_BINDING", "合并后检查不能再次执行合并。");
  if (!config.runtime || !options.pr || !options.scenarios || !options.reports)
    fail("DELIVERY_ARGUMENT", "交付需要运行配置、PR、原始套件和报告清单。");
  const suitePath = resolve(options.scenarios);
  const suiteText = await readFile(suitePath, "utf8");
  if (suiteText.length > 100000 || digest(suiteText) !== options["approve-suite"])
    fail("SUITE_APPROVAL", "交付必须使用已审阅套件的原始文件哈希。");
  let suite;
  try {
    suite = JSON.parse(suiteText);
  } catch {
    fail("SUITE_BINDING", "套件文件无效。");
  }
  resolveFeatureSuite(suite, config);
  const coverage = await checkRepositoryFeatureCoverage({
    executableSuiteCases: suite.cases,
    suiteConfig: config,
  });
  if (coverage.status !== "PASS")
    fail("COVERAGE_GATE", "完整既有功能目录仍有未实现或未绑定的实机用例。");
  const manifestPath = resolve(options.reports);
  const paths = validateReportManifest(await readDeliveryJson(manifestPath, 65536)).map((path) =>
    resolve(dirname(manifestPath), path),
  );
  if (new Set(paths).size !== paths.length) fail("DELIVERY_MANIFEST", "报告清单引用了重复文件。");
  const reports = [];
  for (const path of paths) {
    await absent(join(dirname(path), "STOP"), "SAFETY_STOP");
    await absent(join(dirname(dirname(path)), "STOP"), "SAFETY_STOP");
    reports.push(await readDeliveryJson(path));
  }
  const git = async (args) => (await runFile("git", args, { cwd: repositoryRoot })).stdout.trim();
  const readLocalHead = async () => ({
    commit: await git(["rev-parse", "HEAD"]),
    clean: !(await git(["status", "--porcelain"])),
  });
  const local = await readLocalHead();
  if (!local.clean || local.commit !== config.runtime.expectedCommit)
    fail("DELIVERY_VERSION", "交付必须运行在与验收服务相同的干净提交。");
  const acceptanceIdentitySha256 = digest(
    JSON.stringify({
      checkout: await realpath(config.runtime.checkout),
      dataDirectory: await realpath(config.runtime.dataDirectory),
      connectionId: config.runtime.connectionId,
      threadId: config.runtime.threadId ?? null,
      driver: config.driver.qq,
      bot: config.bot.qq,
      groups: config.groups
        .map(({ alias, id }) => ({ alias, id }))
        .sort((a, b) => a.alias.localeCompare(b.alias)),
    }),
  );
  const lockRoot = join(homedir(), ".glassbox-qq-live-locks");
  await mkdir(lockRoot, { recursive: true, mode: 0o700 });
  const account = digest(config.driver.qq).slice(0, 24);
  const lockPath = join(lockRoot, `${account}.lock`);
  await absent(join(lockRoot, `${account}.memory-pending.json`), "MEMORY_FIXTURE_PENDING");
  await absent(join(out, "STOP"), "SAFETY_STOP");
  let lock;
  try {
    lock = await open(lockPath, "wx", 0o600);
  } catch {
    fail("RUN_LOCKED", "该发起账号已有测试或交付锁。");
  }
  const clients = { driver: new OneBot(config, "driver"), bot: new OneBot(config, "bot") };
  try {
    await lock.writeFile(
      JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), action: "delivery" }),
    );
    await lock.sync();
    const { createGitHubDelivery } = await import("./github-delivery.mjs");
    const { executeDelivery } = await import("./delivery-executor.mjs");
    const github = createGitHubDelivery({ pullRequestUrl: options.pr, cwd: repositoryRoot });
    const remote = await github.readRemote();
    const postMerge = options.postMerge === true;
    if (
      postMerge
        ? remote.state !== "MERGED" || remote.mergeCommit !== local.commit
        : remote.headCommit !== local.commit
    )
      fail("REMOTE_HEAD_GATE", "远端提交与本地验收提交不同。");
    await mkdir(out, { recursive: true, mode: 0o700 });
    const logDirectory = join(out, `delivery_${randomUUID()}`);
    await mkdir(logDirectory, { mode: 0o700 });
    const validation = {};
    for (const [key, command] of [
      ["full", "verify:full"],
      ["commitGate", "verify:commit"],
    ]) {
      let result;
      try {
        result = await runFile("vp", ["run", command], {
          cwd: repositoryRoot,
          timeout: 45 * 60000,
          maxBuffer: 64 * 1024 * 1024,
        });
      } catch {
        fail("DETERMINISTIC_GATE", "交付时执行的仓库验证失败。");
      }
      await durableCreate(join(logDirectory, `${key}.json`), {
        commit: local.commit,
        command,
        status: "PASS",
        stdout: result.stdout,
      });
      const current = await readLocalHead();
      if (!current.clean || current.commit !== local.commit)
        fail("DELIVERY_VERSION", "验证期间提交或工作区发生变化。");
      validation[key] = "PASS";
    }
    await clients.driver.connect();
    await clients.bot.connect();
    await doctor(config, clients);
    const verifyReport = (report) => verifyProductEvidence(report, config, clients);
    const verifyMemoryReport = (report) =>
      verifyMemoryFamilyReport(report, {
        verifyProduct: verifyReport,
        readCleanup: (handles) => {
          const db = new DatabaseSync(join(config.runtime.dataDirectory, "glassbox.db"), {
            readOnly: true,
          });
          try {
            const actor = db
              .prepare("SELECT kind FROM principals WHERE id=?")
              .get(handles.principalId);
            return { ...verifyMemoryCleanup(db, handles), principalKind: actor?.kind };
          } finally {
            db.close();
          }
        },
      });
    const suiteSha256 = digest(suiteText);
    const binding = {
      commit: local.commit,
      prUrl: github.pullRequestUrl,
      suiteSha256,
      acceptanceIdentitySha256,
    };
    const attemptPath = join(lockRoot, `merge-${digest(github.pullRequestUrl)}.json`);
    const readRemoteEvidence = () => readDeliveryRemoteEvidence(github, local.commit, postMerge);
    const evaluateGate = async () => {
      await absent(join(out, "STOP"), "SAFETY_STOP");
      await absent(join(lockRoot, `${account}.memory-pending.json`), "MEMORY_FIXTURE_PENDING");
      for (const path of paths) {
        await absent(join(dirname(path), "STOP"), "SAFETY_STOP");
        await absent(join(dirname(dirname(path)), "STOP"), "SAFETY_STOP");
      }
      const currentRemote = await readRemoteEvidence();
      return evaluateDeliveryGate(
        {
          commit: local.commit,
          suiteText,
          suiteSha256,
          requiredCaseIds: FEATURE_CATALOG.cases.map((c) => c.suiteCaseId ?? c.id),
          reports,
          requiredCheckNames: currentRemote.requiredCheckNames,
          deterministic: { commit: local.commit, ...validation },
          review: currentRemote.review,
          checkOnly: options.executeMerge !== true,
          userAuthorizedMerge: options.live === true,
          ...(postMerge ? { postMerge: true, candidateCommit: remote.headCommit } : {}),
        },
        {
          verifyReport,
          verifyMemoryReport,
          readRemote: readRemoteEvidence,
          resolveRoute: (alias) =>
            alias === "private" ? "private" : config.groups.find((g) => g.alias === alias)?.id,
        },
      );
    };
    if (postMerge) {
      const attemptId = verifyPostMergeAttempt(await readDeliveryJson(attemptPath, 65536), {
        prUrl: github.pullRequestUrl,
        candidateCommit: remote.headCommit,
        suiteSha256,
        acceptanceIdentitySha256,
      });
      const gate = await evaluateGate();
      const current = await readLocalHead();
      if (!current.clean || current.commit !== local.commit)
        fail("DELIVERY_VERSION", "合并后验收期间工作区发生变化。");
      const outcome = {
        status: "DELIVERED",
        ...binding,
        candidateCommit: remote.headCommit,
        mergeCommit: local.commit,
        attemptId,
        gate,
        confirmedAt: new Date().toISOString(),
      };
      await durableCreate(join(logDirectory, "postmerge.json"), outcome);
      console.log(JSON.stringify({ ...outcome, reportDirectory: logDirectory }, null, 2));
      process.exitCode = 0;
      return outcome;
    }
    const result = await executeDelivery(
      { ...binding, live: options.executeMerge === true },
      {
        evaluateGate,
        readLocalHead,
        readRemote: () => github.readRemote(),
        mergeExactHead: (commit) => github.mergeExactHead(commit),
        readAttempt: async () => {
          try {
            return await readDeliveryJson(attemptPath, 65536);
          } catch (error) {
            if (error.code === "ENOENT") return null;
            throw error;
          }
        },
        writeAttempt: (attempt) => durableCreate(attemptPath, attempt),
        writeOutcome: (outcome) =>
          durableCreate(join(logDirectory, `outcome_${randomUUID()}.json`), outcome),
        postMergeAccept: async () => ({
          status: "PENDING",
          reason: "MERGED_COMMIT_LIVE_ACCEPTANCE_REQUIRED",
        }),
      },
    );
    console.log(JSON.stringify({ ...result, reportDirectory: logDirectory }, null, 2));
    process.exitCode =
      result.status === "READY" || result.status === "DELIVERED"
        ? 0
        : result.status === "BLOCKED"
          ? 2
          : 3;
    return result;
  } catch (error) {
    throw error.code ? error : Object.assign(new Error("交付检查无法确认。"), safeError(error));
  } finally {
    clients.driver.close();
    clients.bot.close();
    await releaseOwnedLock(lock, lockPath);
  }
}
