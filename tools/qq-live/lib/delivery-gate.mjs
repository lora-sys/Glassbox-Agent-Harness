import { fail, digest, toolManifestDigest } from "./core.mjs";
import { validateFeatureAssertions } from "./feature-observer.mjs";

/** Gate judgments never execute a merge. Remote checks and evidence are read again by trusted callers. */
export async function evaluateDeliveryGate(input, { verifyReport, readRemote, resolveRoute }) {
  if (
    typeof verifyReport !== "function" ||
    typeof readRemote !== "function" ||
    typeof resolveRoute !== "function"
  )
    fail("GATE_VERIFIER", "交付检查必须重新验证产品证据和远端状态。");
  const { commit, suiteSha256, requiredCaseIds, reports, requiredCheckNames } = input;
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
  if (input.userAuthorizedMerge !== true) fail("MERGE_AUTHORIZATION", "本次交付没有用户合并授权。");
  if (
    input.deterministic?.commit !== commit ||
    input.deterministic?.full !== "PASS" ||
    input.deterministic?.commitGate !== "PASS"
  )
    fail("DETERMINISTIC_GATE", "当前提交未通过完整验证和提交门禁。");
  if (
    input.review?.commit !== commit ||
    input.review?.status !== "PASS" ||
    !input.review?.evidenceId
  )
    fail("REVIEW_GATE", "当前提交缺少通过的独立审查证据。");
  const observed = new Set();
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
    for (const c of report.cases) {
      const approved = approvedCases.get(c.id);
      if (!approved) fail("SUITE_CASE_BINDING", "报告声明了审批套件以外的用例。");
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
          JSON.stringify(c.featureAssertions) !== JSON.stringify(approved.featureAssertions))
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
  if ([...requiredCaseIds, ...approvedCases.keys()].some((id) => !observed.has(id)))
    fail("COVERAGE_GATE", "新增功能或现有功能回归有未完成用例。");
  const remote = await readRemote();
  if (
    remote?.headCommit !== commit ||
    remote.state !== "OPEN" ||
    remote.draft !== false ||
    remote.mergeable !== true
  )
    fail("REMOTE_HEAD_GATE", "远端 PR 版本或合并状态不满足交付条件。");
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
  };
}
