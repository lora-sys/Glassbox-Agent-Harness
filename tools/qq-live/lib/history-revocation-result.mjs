import { fail } from "./core.mjs";
import { verifyHistoryInputEvidence } from "./history-input-evidence.mjs";
import { captureGroupPolicyState, verifyGroupPolicyTransition } from "./group-policy-state.mjs";

const GROUP = /^[1-9]\d{0,15}$/u;
const NONCE = /^[a-f0-9]{32}$/u;
const RUN_ID = /^[A-Za-z0-9_-]{1,128}$/u;
const HASH = /^[a-f0-9]{64}$/u;
const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const exact = (value, keys) =>
  record(value) &&
  Object.keys(value)
    .sort((a, b) => a.localeCompare(b))
    .join(",") === [...keys].sort((a, b) => a.localeCompare(b)).join(",");
const single = (value, item) => Array.isArray(value) && value.length === 1 && value[0] === item;
const empty = (value) => Array.isArray(value) && value.length === 0;

function invalid() {
  fail(
    "HISTORY_REVOCATION_RESULT",
    "禁用群历史后的 Owner 私聊检索证据缺失、不一致或包含泄露字段。",
    "INCONCLUSIVE",
  );
}
function canonicalTime(value) {
  if (typeof value !== "string") return NaN;
  const stamp = Date.parse(value);
  return Number.isFinite(stamp) && new Date(stamp).toISOString() === value ? stamp : NaN;
}
function validateAssertion(assertion) {
  if (
    !exact(assertion, ["kind", "groupId", "query"]) ||
    assertion.kind !== "history_revocation_result" ||
    !GROUP.test(assertion.groupId ?? "") ||
    !NONCE.test(assertion.query ?? "")
  )
    invalid();
}
function eventIdentity(event, runId, principalId, toolCallId) {
  return (
    event.runId === runId &&
    event.principalId === principalId &&
    event.toolCallId === toolCallId &&
    event.data.runId === runId &&
    event.data.principalId === principalId &&
    event.data.toolCallId === toolCallId
  );
}
function outerToolEvent(event) {
  return exact(event, [
    "type",
    "sessionId",
    "timestamp",
    "runId",
    "principalId",
    "toolCallId",
    "data",
  ]);
}
function validateRunScope(db, runId, state) {
  const rows = db
    .prepare(
      "SELECT r.principal_id,r.conversation_id,r.scope_json,r.status,p.kind FROM runs r JOIN principals p ON p.id=r.principal_id WHERE r.id=?",
    )
    .all(runId);
  if (
    rows.length !== 1 ||
    rows[0].kind !== "owner" ||
    rows[0].principal_id !== state.principalId ||
    rows[0].status !== "succeeded" ||
    typeof rows[0].conversation_id !== "string" ||
    rows[0].conversation_id.length === 0
  )
    invalid();
  let scope;
  let tuple;
  try {
    scope = JSON.parse(rows[0].scope_json);
    tuple = JSON.parse(state.scopeKey);
  } catch {
    invalid();
  }
  if (
    !Array.isArray(tuple) ||
    tuple.length !== 6 ||
    tuple[2] !== "private" ||
    tuple[3] !== tuple[4] ||
    !record(scope) ||
    scope.connectionId !== tuple[0] ||
    scope.botId !== tuple[1] ||
    scope.chatType !== "private" ||
    scope.chatId !== tuple[3] ||
    scope.senderId !== tuple[4] ||
    (scope.threadId ?? null) !== tuple[5] ||
    JSON.stringify([
      scope.connectionId,
      scope.botId,
      scope.chatType,
      scope.chatId,
      scope.senderId,
      scope.threadId ?? null,
    ]) !== state.scopeKey
  )
    invalid();
  const decisions = db
    .prepare(
      "SELECT principal_id,resource_id,action,scope_key,decision,run_id FROM authorization_decisions_all WHERE run_id=? AND resource_id='owner-history' AND action='history:search'",
    )
    .all(runId);
  if (
    decisions.length !== 1 ||
    decisions[0].principal_id !== state.principalId ||
    decisions[0].resource_id !== "owner-history" ||
    decisions[0].action !== "history:search" ||
    decisions[0].scope_key !== state.scopeKey ||
    decisions[0].decision !== "ALLOW" ||
    decisions[0].run_id !== runId
  )
    invalid();
  return rows[0];
}

/**
 * Proves one Owner-private Run searched no sources after Group B history was disabled.
 * It does not prove that prior Conversation context contained no Group B content.
 */
export function observeHistoryRevocationResult(
  assertion,
  { db, config, before, disabled, events, runId } = {},
) {
  try {
    validateAssertion(assertion);
    if (
      !db ||
      !config ||
      !RUN_ID.test(runId ?? "") ||
      !Array.isArray(events) ||
      !before ||
      !disabled ||
      assertion.groupId !== config.groups?.find((group) => group?.alias === "B")?.id ||
      assertion.groupId !== before.B?.groupId ||
      assertion.groupId !== disabled.B?.groupId
    )
      invalid();

    const actualQuery = `gbxhistory1-${assertion.query}`;
    const transition = verifyGroupPolicyTransition(before, disabled, "disable");
    const current = captureGroupPolicyState(db, config, {
      originalHistoryGrantId: before.B.historyGrants?.[0]?.id,
    });
    verifyGroupPolicyTransition(before, current, "disable");
    if (
      transition.status !== "STATE_TRANSITION_VERIFIED" ||
      disabled.B.policy.categories["group.history"] !== false ||
      disabled.B.policy.memorySources.history !== false ||
      disabled.B.historyGrants.length !== 0
    )
      invalid();

    const run = validateRunScope(db, runId, before);
    const histories = events.filter(
      (event) => event?.runId === runId && event.type === "history_retrieval",
    );
    const calls = events.filter((event) => event?.runId === runId && event.type === "tool_call");
    const results = events.filter(
      (event) => event?.runId === runId && event.type === "tool_result",
    );
    if (histories.length !== 1 || calls.length !== 1 || results.length !== 1) invalid();

    const history = histories[0];
    const call = calls[0];
    const result = results[0];
    const callIndex = events.indexOf(call);
    const historyIndex = events.indexOf(history);
    const resultIndex = events.indexOf(result);
    const coverage = history.coverage;
    const output = history.toolOutput;
    const principalId = before.principalId;
    const toolCallId = call.toolCallId;
    const observedAt = canonicalTime(coverage?.observedAt);
    const callAt = canonicalTime(call.timestamp);
    const resultAt = canonicalTime(result.timestamp);
    if (
      !outerToolEvent(call) ||
      !outerToolEvent(result) ||
      !exact(call.data, [
        "runId",
        "principalId",
        "toolCallId",
        "name",
        "inputSha256",
        "inputBytes",
      ]) ||
      !exact(result.data, [
        "runId",
        "principalId",
        "toolCallId",
        "name",
        "isError",
        "outputBytes",
        "outputSha256",
      ]) ||
      !eventIdentity(call, runId, principalId, toolCallId) ||
      !eventIdentity(result, runId, principalId, toolCallId) ||
      typeof toolCallId !== "string" ||
      toolCallId.length === 0 ||
      call.data.name !== "owner_history_search" ||
      result.data.name !== "owner_history_search" ||
      result.data.isError !== false ||
      call.sessionId !== result.sessionId ||
      callIndex >= historyIndex ||
      historyIndex >= resultIndex ||
      !exact(history, [
        "type",
        "runId",
        "principalId",
        "conversationId",
        "query",
        "groups",
        "resources",
        "sourceKind",
        "retrievalMode",
        "resultStatus",
        "toolOutput",
        "considered",
        "truncated",
        "coverage",
        "items",
      ]) ||
      history.type !== "history_retrieval" ||
      history.runId !== runId ||
      history.principalId !== principalId ||
      history.conversationId !== run.conversation_id ||
      history.query !== actualQuery ||
      history.sourceKind !== "channel_message" ||
      history.retrievalMode !== "lexical" ||
      !exact(coverage, [
        "requestedLimit",
        "returned",
        "considered",
        "truncated",
        "truncationReasons",
        "perSourceCap",
        "exactTerms",
        "droppedByExactTerm",
        "coverage",
        "groupsSearched",
        "sourceLimits",
        "sourceCoverage",
        "observedAt",
      ]) ||
      !Number.isSafeInteger(coverage.groupsSearched) ||
      !Number.isSafeInteger(coverage.requestedLimit) ||
      !Number.isSafeInteger(coverage.returned) ||
      !Number.isSafeInteger(coverage.considered) ||
      !Number.isSafeInteger(coverage.droppedByExactTerm) ||
      !Number.isFinite(observedAt) ||
      !Number.isFinite(callAt) ||
      !Number.isFinite(resultAt) ||
      callAt > observedAt ||
      observedAt > resultAt ||
      Object.hasOwn(history, "timestamp") ||
      !output ||
      !exact(output, ["bytes", "sha256"]) ||
      !HASH.test(output.sha256 ?? "") ||
      !Number.isSafeInteger(output.bytes) ||
      output.bytes < 1 ||
      output.bytes > 1024 * 1024 ||
      result.data.outputBytes !== output.bytes ||
      result.data.outputSha256 !== output.sha256
    )
      invalid();

    try {
      verifyHistoryInputEvidence(call, {
        query: actualQuery,
        groupIds: [assertion.groupId],
        limit: 1,
      });
    } catch {
      invalid();
    }

    const expectedResult =
      empty(history.groups) &&
      empty(history.resources) &&
      empty(history.items) &&
      history.resultStatus === "no_matches_in_searched_window" &&
      coverage.coverage === "unknown" &&
      coverage.groupsSearched === 0 &&
      coverage.requestedLimit === 1 &&
      coverage.returned === 0 &&
      coverage.considered === 0 &&
      coverage.droppedByExactTerm === 0 &&
      coverage.perSourceCap === null &&
      coverage.truncated === false &&
      empty(coverage.truncationReasons) &&
      empty(coverage.sourceCoverage) &&
      empty(coverage.sourceLimits) &&
      single(coverage.exactTerms, actualQuery) &&
      history.considered === 0 &&
      history.truncated === false;
    if (!expectedResult)
      return {
        kind: "history_revocation_result",
        status: "FAIL",
        absenceVerified: false,
        actualQqDeliveryVerified: false,
      };

    return {
      kind: "history_revocation_result",
      status: "PASS",
      requestedGroupExcluded: true,
      sourcesSearched: 0,
      coverage: "unknown",
      resultWindow: "no_sources_searched",
      resultStatus: history.resultStatus,
      toolOutputVerified: true,
      sourceEvidenceVerified: true,
      absenceVerified: false,
      actualQqDeliveryVerified: false,
    };
  } catch {
    invalid();
  }
}
