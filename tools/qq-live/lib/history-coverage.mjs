import { fail } from "./core.mjs";

const integer = (value) => Number.isSafeInteger(value) && value >= 0;
const empty = (value) => Array.isArray(value) && value.length === 0;
const single = (value, expected) =>
  Array.isArray(value) && value.length === 1 && value[0] === expected;

export function validateHistoryCoverageAssertion(assertion) {
  if (
    !assertion ||
    typeof assertion !== "object" ||
    Array.isArray(assertion) ||
    Object.keys(assertion).sort().join(",") !== "count,groupId,kind,query" ||
    assertion.kind !== "history_coverage" ||
    assertion.count !== 1 ||
    typeof assertion.query !== "string" ||
    !/^(?:[a-f0-9]{32}|\{\{nonce\}\})$/u.test(assertion.query) ||
    typeof assertion.groupId !== "string" ||
    !/^(?:[1-9]\d{0,15}|\{\{group:A\}\})$/u.test(assertion.groupId)
  )
    fail("FEATURE_HISTORY_COVERAGE", "历史完整性断言必须限定当前测试编号和群 A。");
}

/** Verify source and result-window completeness without copying history payloads. */
export function observeHistoryCoverage(assertion, events, runId) {
  validateHistoryCoverageAssertion(assertion);
  const matches = events.filter(
    (event) => event?.runId === runId && event.type === "history_retrieval",
  );
  if (matches.length !== 1)
    fail("FEATURE_HISTORY_COVERAGE", "本轮必须只有一条历史检索完整性证据。", "INCONCLUSIVE");
  const event = matches[0];
  const coverage = event.coverage;
  const source = coverage?.sourceCoverage?.[0];
  if (
    event.query !== assertion.query ||
    !single(event.groups, assertion.groupId) ||
    !single(event.resources, `group:${assertion.groupId}`) ||
    event.sourceKind !== "channel_message" ||
    event.retrievalMode !== "lexical" ||
    !coverage ||
    coverage.coverage !== "complete" ||
    coverage.requestedLimit !== 1 ||
    coverage.groupsSearched !== 1 ||
    coverage.perSourceCap !== null ||
    coverage.truncated !== false ||
    event.truncated !== false ||
    !empty(coverage.truncationReasons) ||
    !empty(coverage.sourceLimits) ||
    !integer(coverage.returned) ||
    coverage.returned > 1 ||
    !integer(coverage.considered) ||
    event.considered !== coverage.considered ||
    !integer(coverage.droppedByExactTerm) ||
    coverage.considered < coverage.returned + coverage.droppedByExactTerm ||
    !single(coverage.exactTerms, assertion.query) ||
    !Array.isArray(coverage.sourceCoverage) ||
    coverage.sourceCoverage.length !== 1 ||
    !source ||
    typeof source !== "object" ||
    Array.isArray(source) ||
    source.groupId !== assertion.groupId ||
    source.capped !== false ||
    source.returned !== coverage.returned ||
    source.considered !== coverage.returned ||
    source.sync?.stop !== "end_of_source" ||
    !integer(source.sync.pagesWalked) ||
    (source.sync.skippedOwnMessages !== undefined && !integer(source.sync.skippedOwnMessages)) ||
    typeof coverage.observedAt !== "string" ||
    !Number.isFinite(Date.parse(coverage.observedAt)) ||
    new Date(coverage.observedAt).toISOString() !== coverage.observedAt ||
    coverage.continuation !== undefined ||
    !Array.isArray(event.items) ||
    event.items.length !== coverage.returned ||
    event.items.some(
      (item, index) =>
        !item ||
        typeof item !== "object" ||
        Array.isArray(item) ||
        item.resourceId !== `group:${assertion.groupId}` ||
        item.sourceId !== assertion.groupId ||
        item.rank !== index + 1 ||
        !Number.isFinite(item.score) ||
        !single(item.matchedTerms, assertion.query) ||
        item.returnMode !== "raw",
    )
  )
    fail("FEATURE_HISTORY_COVERAGE", "历史来源或结果窗口的完整性未被证明。", "INCONCLUSIVE");
  return {
    kind: "history_coverage",
    coverage: "complete",
    returned: coverage.returned,
    sourceComplete: true,
  };
}
