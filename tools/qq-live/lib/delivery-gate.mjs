import { fail, digest, toolManifestDigest } from "./core.mjs";
import { validateFeatureAssertions } from "./feature-observer.mjs";
import { resolveReadFeatureCase } from "./feature-specs.mjs";
import { validateMemoryFamily, validateHistoryFamily } from "./feature-suite.mjs";
import { memoryWorkflow } from "./memory-workflow.mjs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
const runFile = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));

/** Gate judgments never execute a merge. Remote checks and evidence are read again by trusted callers. */
async function verifyRepositoryCoverage({ commit, suite, suiteConfig }) {
  const git = async (args) => (await runFile("git", args, { cwd: repositoryRoot })).stdout.trim();
  if ((await git(["rev-parse", "HEAD"])) !== commit || (await git(["status", "--porcelain"])))
    fail("COVERAGE_VERSION", "功能目录必须来自待交付提交的干净工作区。");
  const { FEATURE_CATALOG, checkRepositoryFeatureCoverage } =
    await import("../feature-catalog.mjs");
  const coverage = await checkRepositoryFeatureCoverage({
    executableSuiteCases: suite.cases,
    suiteConfig,
  });
  if ((await git(["rev-parse", "HEAD"])) !== commit || (await git(["status", "--porcelain"])))
    fail("COVERAGE_VERSION", "检查功能目录期间工作区版本发生变化。");
  return {
    ...coverage,
    requiredCaseIds: FEATURE_CATALOG.cases.map((c) => c.suiteCaseId ?? c.id),
  };
}

export async function evaluateDeliveryGate(
  input,
  {
    verifyReport,
    verifyMemoryReport,
    verifyHistoryReport,
    readRemote,
    resolveRoute,
    verifyCoverage = verifyRepositoryCoverage,
  },
) {
  if (
    typeof verifyReport !== "function" ||
    typeof readRemote !== "function" ||
    typeof resolveRoute !== "function"
  )
    fail("GATE_VERIFIER", "交付检查必须重新验证产品证据和远端状态。");
  const { commit, suiteSha256, requiredCaseIds, reports, requiredCheckNames } = input;
  const postMerge = input.postMerge === true;
  if (
    postMerge &&
    (input.checkOnly !== true || !/^[a-f0-9]{40}$/.test(input.candidateCommit ?? ""))
  )
    fail("POST_MERGE_BINDING", "合并后检查必须绑定原候选提交，且不能授权再次合并。");
  let suite;
  try {
    if (
      typeof input.suiteText !== "string" ||
      input.suiteText.length > 100000 ||
      digest(input.suiteText) !== suiteSha256
    )
      fail("SUITE_BINDING", "交付检查必须读取与审批哈希匹配的原始套件。");
    suite = JSON.parse(input.suiteText);
  } catch {
    fail("SUITE_BINDING", "交付检查必须读取与审批哈希匹配的原始套件。");
  }
  if (
    !Array.isArray(suite.cases) ||
    !suite.cases.length ||
    new Set(suite.cases.map((c) => c.id)).size !== suite.cases.length
  )
    fail("SUITE_BINDING", "审批套件的用例清单无效。");
  const approvedCases = new Map(suite.cases.map((c) => [c.id, c]));
  const suiteConfig = {
    groups: ["A", "B"].flatMap((alias) => {
      const id = resolveRoute(alias);
      return typeof id === "string" && /^[1-9][0-9]{4,19}$/.test(id) ? [{ alias, id }] : [];
    }),
  };
  const coverage = await verifyCoverage({ commit, suite, suiteSha256, suiteConfig });
  if (
    coverage?.status !== "PASS" ||
    !Array.isArray(coverage.requiredCaseIds) ||
    !coverage.requiredCaseIds.length ||
    coverage.requiredCaseIds.some((id) => typeof id !== "string" || !approvedCases.has(id))
  )
    fail("COVERAGE_GATE", "完整既有功能目录未绑定到已批准的可执行用例。");
  if (
    !/^[a-f0-9]{40}$/.test(commit ?? "") ||
    !/^[a-f0-9]{64}$/.test(suiteSha256 ?? "") ||
    !Array.isArray(requiredCaseIds) ||
    !requiredCaseIds.length ||
    new Set(requiredCaseIds).size !== requiredCaseIds.length ||
    !Array.isArray(requiredCheckNames) ||
    !requiredCheckNames.length ||
    new Set(requiredCheckNames).size !== requiredCheckNames.length ||
    !Array.isArray(reports) ||
    !reports.length
  )
    fail("GATE_INPUT", "交付检查需要完整提交、套件哈希、必测用例和必需 CI。");
  if (input.checkOnly !== true && input.userAuthorizedMerge !== true)
    fail("MERGE_AUTHORIZATION", "本次交付没有用户合并授权。");
  if (
    input.deterministic?.commit !== commit ||
    input.deterministic?.full !== "PASS" ||
    input.deterministic?.commitGate !== "PASS"
  )
    fail("DETERMINISTIC_GATE", "当前提交未通过完整验证和提交门禁。");
  if (
    input.review?.commit !== (postMerge ? input.candidateCommit : commit) ||
    input.review?.status !== "PASS" ||
    !input.review?.evidenceId
  )
    fail("REVIEW_GATE", "当前提交缺少通过的独立审查证据。");
  const observed = new Set();
  const freshRunTimes = [];
  const freshInputTimes = [];
  for (const report of reports) {
    if (
      report.status !== "PASS" ||
      report.mode !== "run" ||
      report.suiteSha256 !== suiteSha256 ||
      report.productAcceptance?.status !== "PASS" ||
      report.productAcceptance.runtime?.commit !== commit ||
      !Array.isArray(report.cases) ||
      !report.cases.length ||
      report.cases.some(
        (c) =>
          c.status !== "PASS" ||
          (c.cleanup?.required && !c.cleanup.restored) ||
          (c.acceptanceLease && c.leaseRevoked !== true),
      )
    )
      fail("LIVE_GATE", "真实验收、清理或版本证据未通过。");
    const fresh = await verifyReport(report);
    if (fresh?.status !== "PASS" || fresh.runtime?.commit !== commit || !Array.isArray(fresh.cases))
      fail("LIVE_REVERIFICATION", "重新查询的产品证据未通过。");
    if (postMerge) {
      for (const evidence of fresh.cases) {
        const created = Date.parse(evidence.runCreatedAt);
        if (!Number.isFinite(created)) fail("POST_MERGE_RUN", "合并后验收缺少独立 Run 创建时间。");
        freshRunTimes.push(created);
        const inputTime = evidence.messageBinding?.input?.time;
        if (
          !Number.isSafeInteger(inputTime) ||
          !Number.isSafeInteger(inputTime * 1000) ||
          inputTime <= 0
        )
          fail("POST_MERGE_INPUT", "合并后验收缺少真实 QQ 入站消息时间。");
        freshInputTimes.push(inputTime * 1000);
      }
    }
    if (report.historyFamily !== undefined || report.historySeedWorkflow !== undefined) {
      const familyId = report.historyFamily?.caseId,
        original = approvedCases.get(familyId);
      if (suite.schemaVersion !== 4 || !original || typeof verifyHistoryReport !== "function")
        fail("HISTORY_FAMILY_GATE", "历史流程须绑定已批准的固定用例并重新核对两轮来源。");
      validateHistoryFamily(original);
      if (observed.has(familyId)) fail("CASE_DUPLICATE", "交付报告重复声明历史用例。");
      const history = await verifyHistoryReport(report, { approvedFamily: original });
      if (
        history?.status !== "PASS" ||
        history.caseId !== familyId ||
        history.runtime?.commit !== commit ||
        JSON.stringify(history.runtime) !== JSON.stringify(fresh.runtime) ||
        !Array.isArray(history.stageRunIds) ||
        history.stageRunIds.length !== 2 ||
        new Set(history.stageRunIds).size !== 2 ||
        JSON.stringify(history.stageRunIds) !==
          JSON.stringify(report.historySeedWorkflow?.stageRunIds) ||
        report.cases.length !== 2 ||
        fresh.cases.length !== 2 ||
        fresh.cases.some(
          (e, i) =>
            e.runId !== history.stageRunIds[i] ||
            e.caseId !== report.cases[i].id ||
            e.feature?.status !== "PASS" ||
            e.traceVerified !== true,
        ) ||
        history.cleanup?.required !== false ||
        history.cleanup.leaseRevoked !== true
      )
        fail("HISTORY_FAMILY_GATE", "历史流程来源或独立 Run 证据不完整。");
      observed.add(familyId);
      continue;
    }
    if (report.memoryFamily !== undefined || report.memoryLifecycle !== undefined) {
      const familyId = report.memoryFamily?.caseId;
      const original = approvedCases.get(familyId);
      if (
        ![3, 4].includes(suite.schemaVersion) ||
        !original ||
        typeof verifyMemoryReport !== "function"
      )
        fail("MEMORY_FAMILY_GATE", "记忆流程必须绑定已批准的固定用例并重新核对资源清理。");
      let workflow;
      try {
        workflow = memoryWorkflow(familyId);
      } catch {
        fail("MEMORY_FAMILY_GATE", "记忆流程未绑定受支持的固定工作流。");
      }
      validateMemoryFamily(original);
      if (original.id !== workflow.id)
        fail("MEMORY_FAMILY_GATE", "报告 Memory 家族与审批套件不一致。");
      if (observed.has(familyId)) fail("CASE_DUPLICATE", "交付报告重复声明记忆用例。");
      const memory = await verifyMemoryReport(report, { approvedFamily: original });
      const expectedRuns = report.memoryLifecycle?.steps?.map((s) => s.runId);
      if (
        memory?.status !== "PASS" ||
        memory.caseId !== familyId ||
        memory.runtime?.commit !== commit ||
        JSON.stringify(memory.runtime) !== JSON.stringify(fresh.runtime) ||
        !Array.isArray(memory.stageRunIds) ||
        memory.stageRunIds.length !== workflow.stages.length ||
        new Set(memory.stageRunIds).size !== workflow.stages.length ||
        JSON.stringify(memory.stageRunIds) !== JSON.stringify(expectedRuns) ||
        memory.cleanup?.status !== workflow.cleanupStatus ||
        memory.handles?.cleanupRunId !== memory.stageRunIds.at(-1) ||
        (!workflow.stages.includes("promote") &&
          (Object.hasOwn(memory.handles ?? {}, "memoryId") ||
            Object.hasOwn(memory.handles ?? {}, "promoteRunId"))) ||
        report.cases.length !== workflow.stages.length ||
        fresh.cases.length !== workflow.stages.length ||
        fresh.cases.some(
          (e, index) =>
            e.runId !== memory.stageRunIds[index] ||
            e.caseId !== report.cases[index].id ||
            e.feature?.status !== "PASS" ||
            e.traceVerified !== true,
        )
      )
        fail("MEMORY_FAMILY_GATE", "记忆流程的独立 Run 或清理证据不完整。");
      observed.add(familyId);
      continue;
    }
    for (const c of report.cases) {
      const original = approvedCases.get(c.id);
      if (!original) fail("SUITE_CASE_BINDING", "报告声明了审批套件以外的用例。");
      const approved = resolveReadFeatureCase(original, resolveRoute);
      const featureCase = Array.isArray(approved.leaseTools);
      if (approved.featureAssertions !== undefined && !featureCase)
        fail("SUITE_CASE_BINDING", "审批套件的功能断言缺少测试许可范围。");
      if (
        typeof c.token !== "string" ||
        !c.token ||
        (featureCase && !/^[a-f0-9]{32}$/.test(c.token)) ||
        typeof approved.prompt !== "string" ||
        !Array.isArray(approved.expectContains) ||
        !approved.expectContains.length ||
        approved.expectContains.some((v) => typeof v !== "string" || !v) ||
        typeof approved.chat !== "string" ||
        !resolveRoute(approved.chat) ||
        c.route !== resolveRoute(approved.chat) ||
        c.prompt !==
          (featureCase
            ? `GLASSBOX_ACCEPTANCE_V1 ${c.token}\n${approved.prompt.trim()}`
            : approved.prompt
          ).replaceAll("{{nonce}}", c.token) ||
        JSON.stringify(c.expected) !==
          JSON.stringify(approved.expectContains.map((v) => v.replaceAll("{{nonce}}", c.token)))
      )
        fail("SUITE_CASE_BINDING", "测试消息或回复断言与审批套件不一致。");
      if (featureCase) validateFeatureAssertions(approved.featureAssertions);
      if (
        featureCase &&
        (!c.acceptanceLease ||
          c.leaseRevoked !== true ||
          c.acceptanceLease.toolsSha256 !==
            toolManifestDigest(
              JSON.parse(JSON.stringify(approved.leaseTools).replaceAll("{{nonce}}", c.token)),
            ) ||
          !Array.isArray(c.featureAssertions) ||
          !c.featureAssertions.length ||
          JSON.stringify(c.leasedToolNames) !==
            JSON.stringify(approved.leaseTools.map((t) => t.name)) ||
          JSON.stringify(c.featureAssertions) !==
            JSON.stringify(
              JSON.parse(
                JSON.stringify(approved.featureAssertions).replaceAll("{{nonce}}", c.token),
              ),
            ))
      )
        fail("SUITE_CASE_BINDING", "功能断言或许可与审批套件不一致。");
      if (!featureCase && (c.featureAssertions || c.acceptanceLease))
        fail("SUITE_CASE_BINDING", "报告擅自改变了用例执行类型。");
      if (observed.has(c.id)) fail("CASE_DUPLICATE", "交付报告重复声明同一个用例。");
      const evidence = fresh.cases.find((e) => e.caseId === c.id);
      if (
        !evidence?.runId ||
        evidence.traceVerified !== true ||
        (featureCase && evidence.feature?.status !== "PASS")
      )
        fail("CASE_EVIDENCE", "用例缺少重新核对的 Run 和 Trace 证据。");
      observed.add(c.id);
    }
  }
  if (
    [...requiredCaseIds, ...coverage.requiredCaseIds, ...approvedCases.keys()].some(
      (id) => !observed.has(id),
    )
  )
    fail("COVERAGE_GATE", "新增功能或现有功能回归有未完成用例。");
  const remote = await readRemote();
  const remoteMatches = postMerge
    ? remote?.headCommit === input.candidateCommit &&
      remote.state === "MERGED" &&
      remote.mergeCommit === commit &&
      Number.isFinite(Date.parse(remote.mergedAt)) &&
      freshRunTimes.length > 0 &&
      freshRunTimes.every((created) => created >= Date.parse(remote.mergedAt))
    : remote?.headCommit === commit &&
      remote.state === "OPEN" &&
      remote.draft === false &&
      remote.mergeable === true;
  if (!remoteMatches) fail("REMOTE_HEAD_GATE", "远端 PR 版本或合并状态不满足交付条件。");
  if (postMerge && freshInputTimes.some((time) => time <= Date.parse(remote.mergedAt)))
    fail("POST_MERGE_INPUT", "验收消息必须在合并后新发，不能使用合并前排队的消息。");
  if (
    requiredCheckNames.some(
      (name) =>
        !remote.checks?.some(
          (c) => c.name === name && c.commit === commit && c.status === "SUCCESS",
        ),
    )
  )
    fail("CI_GATE", "当前远端提交存在缺失或未通过的必需 CI。");
  return {
    status: "PASS",
    commit,
    suiteSha256,
    caseIds: [...observed],
    remoteHead: remote.headCommit,
    ...(postMerge
      ? {
          candidateCommit: input.candidateCommit,
          mergeCommit: remote.mergeCommit,
          mergedAt: remote.mergedAt,
        }
      : {}),
    mergeAuthorized: input.checkOnly !== true && input.userAuthorizedMerge === true,
  };
}
