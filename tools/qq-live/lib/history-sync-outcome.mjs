import { fail } from "./core.mjs";
import { verifyHistoryInputEvidence } from "./history-input-evidence.mjs";

const GROUP_ID = /^[1-9]\d{0,15}$/u;
const NONCE = /^[a-f0-9]{32}$/u;
const RUN_ID = /^[A-Za-z0-9_-]{1,128}$/u;
const HASH = /^[a-f0-9]{64}$/u;
const STOPS = new Set([
  "page_bound_reached",
  "cursor_stuck",
  "provider_unavailable",
  "provider_failed",
  "provider_unknown",
]);
const integer = (value) => Number.isSafeInteger(value) && value >= 0;
const single = (value, expected) =>
  Array.isArray(value) && value.length === 1 && value[0] === expected;
const exactKeys = (value, keys) =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).sort().join(",") ===
    [...keys].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).join(",");

function invalid() {
  fail("HISTORY_SYNC_OUTCOME", "本轮群历史同步范围或结果 Trace 不完整。", "INCONCLUSIVE");
}

function validateAssertion(assertion) {
  if (
    !assertion ||
    typeof assertion !== "object" ||
    Array.isArray(assertion) ||
    Object.keys(assertion).sort().join(",") !== "groupId,kind,query,stop" ||
    assertion.kind !== "history_sync_outcome" ||
    !GROUP_ID.test(assertion.groupId ?? "") ||
    !NONCE.test(assertion.query ?? "") ||
    !STOPS.has(assertion.stop)
  )
    invalid();
}

function requireEventIdentity(event, runId, principalId, toolCallId) {
  return (
    event?.runId === runId &&
    event?.principalId === principalId &&
    event?.toolCallId === toolCallId &&
    event?.data?.runId === runId &&
    event?.data?.principalId === principalId &&
    event?.data?.toolCallId === toolCallId
  );
}

/**
 * Bind one protected group-history Tool result to its safe retrieval evidence.
 * This proves only the bounded window and its sync stop, never that a message was absent.
 */
export function observeHistorySyncOutcome(assertion, { events, runId } = {}) {
  validateAssertion(assertion);
  if (!RUN_ID.test(runId ?? "") || !Array.isArray(events)) invalid();

  const historyRows = events
    .map((event, index) => ({ event, index }))
    .filter(({ event }) => event?.runId === runId && event.type === "history_retrieval");
  const calls = events
    .map((event, index) => ({ event, index }))
    .filter(({ event }) => event?.runId === runId && event.type === "tool_call");
  const results = events
    .map((event, index) => ({ event, index }))
    .filter(({ event }) => event?.runId === runId && event.type === "tool_result");
  if (historyRows.length !== 1 || calls.length !== 1 || results.length !== 1) invalid();

  const historyRow = historyRows[0];
  const callRow = calls[0];
  const resultRow = results[0];
  const history = historyRow.event;
  const call = callRow.event;
  const result = resultRow.event;
  const coverage = history.coverage;
  const source = coverage?.sourceCoverage?.[0];
  const principalId = history.principalId;
  const toolCallId = call.toolCallId;
  const output = history.toolOutput;
  const stop = source?.sync?.stop;

  if (
    typeof principalId !== "string" ||
    principalId.length === 0 ||
    typeof toolCallId !== "string" ||
    toolCallId.length === 0 ||
    !requireEventIdentity(call, runId, principalId, toolCallId) ||
    !requireEventIdentity(result, runId, principalId, toolCallId) ||
    call.data?.name !== "group_history_search" ||
    result.data?.name !== "group_history_search" ||
    !exactKeys(result.data, [
      "runId",
      "principalId",
      "toolCallId",
      "name",
      "isError",
      "outputBytes",
      "outputSha256",
    ]) ||
    result.data?.isError !== false ||
    call.data?.input !== undefined ||
    callRow.index >= historyRow.index ||
    historyRow.index >= resultRow.index
  )
    invalid();
  try {
    verifyHistoryInputEvidence(call, { query: assertion.query, limit: 1 });
  } catch {
    invalid();
  }

  // The protected Tool omits its model-visible query from tool_call Trace. The result event
  // carries only a complete digest and byte count; retrieval evidence supplies the bounded,
  // safe fields needed to bind this fixed query to one group and its source-walk result.
  const callTimestamp = Date.parse(call.timestamp ?? "");
  const observedAt = coverage?.observedAt;
  const observedAtMs = Date.parse(observedAt ?? "");
  const resultTimestamp = Date.parse(result.timestamp ?? "");
  if (
    !Number.isFinite(callTimestamp) ||
    typeof observedAt !== "string" ||
    !Number.isFinite(observedAtMs) ||
    new Date(observedAtMs).toISOString() !== observedAt ||
    !Number.isFinite(resultTimestamp) ||
    Object.hasOwn(history, "timestamp") ||
    callTimestamp > observedAtMs ||
    observedAtMs > resultTimestamp
  )
    invalid();

  if (
    history.query !== assertion.query ||
    typeof history.conversationId !== "string" ||
    history.conversationId.length === 0 ||
    !single(history.groups, assertion.groupId) ||
    !single(history.resources, `group:${assertion.groupId}`) ||
    history.sourceKind !== "channel_message" ||
    history.retrievalMode !== "lexical" ||
    !coverage ||
    coverage.requestedLimit !== 1 ||
    coverage.coverage !== "partial" ||
    coverage.groupsSearched !== 1 ||
    coverage.perSourceCap !== null ||
    !single(coverage.exactTerms, assertion.query) ||
    !single(coverage.sourceLimits, assertion.stop) ||
    stop !== assertion.stop ||
    !STOPS.has(stop) ||
    !Array.isArray(coverage.sourceCoverage) ||
    coverage.sourceCoverage.length !== 1 ||
    !source ||
    !exactKeys(source, ["groupId", "returned", "considered", "capped", "sync"]) ||
    source.groupId !== assertion.groupId ||
    source.capped !== false ||
    !integer(source.returned) ||
    source.returned > 1 ||
    !integer(source.considered) ||
    source.considered < source.returned ||
    !integer(source.sync?.pagesWalked) ||
    (["page_bound_reached", "cursor_stuck"].includes(stop) && source.sync.pagesWalked < 1) ||
    !exactKeys(
      source.sync,
      source.sync?.skippedOwnMessages === undefined
        ? ["pagesWalked", "stop"]
        : ["pagesWalked", "skippedOwnMessages", "stop"],
    ) ||
    (source.sync.skippedOwnMessages !== undefined && !integer(source.sync.skippedOwnMessages)) ||
    !integer(coverage.returned) ||
    coverage.returned > 1 ||
    source.returned !== coverage.returned ||
    !integer(coverage.considered) ||
    history.considered !== coverage.considered ||
    coverage.considered < source.considered ||
    !integer(coverage.droppedByExactTerm) ||
    coverage.considered < coverage.returned + coverage.droppedByExactTerm ||
    typeof coverage.truncated !== "boolean" ||
    history.truncated !== coverage.truncated ||
    !Array.isArray(coverage.truncationReasons) ||
    (coverage.truncated && coverage.truncationReasons.length === 0) ||
    (!coverage.truncated && coverage.truncationReasons.length !== 0) ||
    !Array.isArray(history.items) ||
    history.items.length !== coverage.returned ||
    history.items.some(
      (item, index) =>
        !item ||
        typeof item !== "object" ||
        Array.isArray(item) ||
        item.resourceId !== `group:${assertion.groupId}` ||
        item.sourceId !== assertion.groupId ||
        item.rank !== index + 1 ||
        !HASH.test(item.textSha256 ?? "") ||
        !integer(item.textBytes) ||
        !Number.isFinite(item.score) ||
        !single(item.matchedTerms, assertion.query),
    ) ||
    history.resultStatus !==
      (coverage.returned > 0 ? "matches_found" : "no_matches_in_searched_window")
  )
    invalid();

  if (
    !output ||
    Object.keys(output).sort().join(",") !== "bytes,sha256" ||
    !HASH.test(output.sha256 ?? "") ||
    !Number.isSafeInteger(output.bytes) ||
    output.bytes < 1 ||
    output.bytes > 1024 * 1024 ||
    result.data?.outputBytes !== output.bytes ||
    result.data?.outputSha256 !== output.sha256 ||
    "outputHead" in result.data ||
    "outputTruncated" in result.data
  )
    invalid();

  return {
    kind: "history_sync_outcome",
    coverage: "partial",
    stop,
    pagesWalked: source.sync.pagesWalked,
    returned: coverage.returned,
    resultStatus: history.resultStatus,
    resultWindow: "searched_window_only",
    absenceVerified: false,
    toolOutputVerified: true,
    sourceEvidenceVerified: true,
    actualQqDeliveryVerified: false,
  };
}
