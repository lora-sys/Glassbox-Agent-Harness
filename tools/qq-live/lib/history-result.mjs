import { createHash } from "node:crypto";
import { fail } from "./core.mjs";
import { observeHistoryCoverage, validateHistoryCoverageAssertion } from "./history-coverage.mjs";

const hash = (text) => createHash("sha256").update(text, "utf8").digest("hex");
const canonical = (value) => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  return JSON.stringify(value);
};
function invalid() {
  fail("FEATURE_HISTORY_RESULT", "本轮历史结果或独立来源证据未被证明。", "INCONCLUSIVE");
}

export function validateHistoryResultAssertion(assertion) {
  if (
    !assertion ||
    typeof assertion !== "object" ||
    Array.isArray(assertion) ||
    Object.keys(assertion).sort().join(",") !== "count,groupId,kind,query,result,tool" ||
    assertion.kind !== "history_result" ||
    !(
      (assertion.result === "hit" && assertion.tool === "group_history_search") ||
      (assertion.result === "no_match" && assertion.tool === "owner_history_search")
    )
  )
    fail("FEATURE_HISTORY_RESULT", "历史结果断言只能选择固定群内命中或 Owner 私聊无命中。");
  validateHistoryCoverageAssertion({
    kind: "history_coverage",
    query: assertion.query,
    groupId: assertion.groupId,
    count: assertion.count,
  });
}

/** Result hashes correlate protected Tool output without opening its payload. */
export function historyResultTrace(assertion, events, runId) {
  validateHistoryResultAssertion(assertion);
  const input =
    assertion.tool === "group_history_search"
      ? { query: assertion.query, limit: 1 }
      : { query: assertion.query, groupIds: [assertion.groupId], limit: 1 };
  return protectedHistoryResultTrace(assertion, events, runId, input);
}

function protectedHistoryResultTrace(assertion, events, runId, input) {
  const coverage = observeHistoryCoverage(
    { kind: "history_coverage", query: assertion.query, groupId: assertion.groupId, count: 1 },
    events,
    runId,
  );
  const history = events.find(
    (event) => event?.runId === runId && event.type === "history_retrieval",
  );
  const calls = events.filter((event) => event?.runId === runId && event.type === "tool_call");
  const results = events.filter((event) => event?.runId === runId && event.type === "tool_result");
  const output = history.toolOutput;
  const expectedCount = assertion.result === "hit" ? 1 : 0;
  if (
    coverage.returned !== expectedCount ||
    history.resultStatus !== (expectedCount ? "matches_found" : "no_matches_in_searched_window") ||
    calls.length !== 1 ||
    results.length !== 1 ||
    calls[0].data?.name !== assertion.tool ||
    results[0].data?.name !== assertion.tool ||
    !calls[0].toolCallId ||
    calls[0].toolCallId !== results[0].toolCallId ||
    results[0].data?.isError !== false ||
    canonical(calls[0].data?.input) !== canonical(input) ||
    !output ||
    Object.keys(output).sort().join(",") !== "bytes,sha256" ||
    !/^[a-f0-9]{64}$/.test(output.sha256 ?? "") ||
    !Number.isSafeInteger(output.bytes) ||
    output.bytes < 1 ||
    output.bytes > 1024 * 1024 ||
    results[0].data?.outputBytes !== output.bytes ||
    results[0].data?.outputSha256 !== output.sha256
  )
    invalid();
  return { history, item: history.items[0] };
}

export function matchesHistoryText(item, text) {
  return (
    typeof text === "string" &&
    item?.textSha256 === hash(text) &&
    item?.textBytes === Buffer.byteLength(text, "utf8")
  );
}

/** Mirrors the current 240-character history projection, preserving the exact nonce. */
export function historySnippet(text, nonce) {
  const limit = 240;
  if (text.length <= limit) return text;
  const index = text.toLocaleLowerCase().indexOf(nonce.toLocaleLowerCase());
  if (index < 0) invalid();
  const before = Math.min(index, Math.floor((limit - nonce.length) / 2));
  const start = Math.max(0, Math.min(index - before, text.length - limit));
  return `${start > 0 ? "…" : ""}${text.slice(start, start + limit)}${start + limit < text.length ? "…" : ""}`;
}

export function observeHistoryResult(assertion, { db, events, runId }) {
  const { history, item } = historyResultTrace(assertion, events, runId);
  if (!db) invalid();
  const rows = db
    .prepare(
      "SELECT r.principal_id, r.conversation_id, r.scope_json, r.status, m.external_id, m.scope_key, p.kind FROM runs r JOIN messages m ON m.id=r.message_id JOIN principals p ON p.id=r.principal_id WHERE r.id=?",
    )
    .all(runId);
  if (rows.length !== 1 || rows[0].kind !== "owner" || rows[0].status !== "succeeded") invalid();
  const row = rows[0];
  let scope;
  try {
    scope = JSON.parse(row.scope_json);
  } catch {
    invalid();
  }
  const numericId = (value) => typeof value === "string" && /^[1-9]\d{0,15}$/.test(value);
  const key = JSON.stringify([
    scope?.connectionId,
    scope?.botId,
    scope?.chatType,
    scope?.chatId,
    scope?.senderId,
    scope?.threadId ?? null,
  ]);
  if (
    !scope ||
    typeof scope.connectionId !== "string" ||
    !scope.connectionId ||
    !numericId(scope.botId) ||
    !numericId(scope.senderId) ||
    row.scope_key !== key ||
    history.principalId !== row.principal_id ||
    history.conversationId !== row.conversation_id ||
    (assertion.result === "hit"
      ? scope.chatType !== "group" || scope.chatId !== assertion.groupId
      : scope.chatType !== "private" || scope.chatId !== scope.senderId)
  )
    invalid();
  if (assertion.result === "no_match") {
    const count = db
      .prepare(
        "SELECT COUNT(*) AS count FROM channel_messages WHERE channel='qq-onebot' AND connection_id=? AND group_id=? AND resource_id=? AND source_class='history' AND instr(lower(normalized_text),?)>0",
      )
      .get(scope.connectionId, assertion.groupId, `group:${assertion.groupId}`, assertion.query);
    if (count?.count !== 0) invalid();
  } else {
    if (
      typeof item?.recordId !== "string" ||
      !/^[a-f0-9-]{36}$/i.test(item.recordId) ||
      item.senderId !== scope.senderId ||
      typeof item.occurredAt !== "string" ||
      !Number.isFinite(Date.parse(item.occurredAt))
    )
      invalid();
    const candidates = db
      .prepare(
        "SELECT id, external_message_id, sender_id, occurred_at, occurred_at_ms, normalized_text FROM channel_messages WHERE id=? AND channel='qq-onebot' AND connection_id=? AND group_id=? AND resource_id=? AND source_class='history' AND external_message_id=? AND sender_id=? AND instr(lower(normalized_text),?)>0",
      )
      .all(
        item.recordId,
        scope.connectionId,
        assertion.groupId,
        `group:${assertion.groupId}`,
        row.external_id,
        scope.senderId,
        assertion.query,
      );
    if (candidates.length !== 1) invalid();
    const source = candidates[0];
    if (
      source.occurred_at !== item.occurredAt ||
      source.occurred_at_ms !== Date.parse(item.occurredAt) ||
      typeof source.normalized_text !== "string" ||
      source.normalized_text.length > 4096 ||
      !matchesHistoryText(item, historySnippet(source.normalized_text, assertion.query))
    )
      invalid();
  }
  return {
    kind: "history_result",
    result: assertion.result,
    returned: assertion.result === "hit" ? 1 : 0,
    sourceVerified: true,
    toolOutputVerified: true,
  };
}

export function validateHistorySeedAssertion(assertion) {
  if (
    !assertion ||
    Array.isArray(assertion) ||
    Object.keys(assertion).sort().join(",") !==
      "count,groupId,kind,query,result,sourceRunId,tool,until" ||
    assertion.kind !== "history_seed_result" ||
    assertion.tool !== "owner_history_search" ||
    assertion.result !== "hit" ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(assertion.sourceRunId ?? "") ||
    typeof assertion.until !== "string" ||
    !Number.isFinite(Date.parse(assertion.until)) ||
    new Date(assertion.until).toISOString() !== assertion.until ||
    Date.parse(assertion.until) <= 0 ||
    Date.parse(assertion.until) % 1000 !== 0
  )
    invalid();
  validateHistoryCoverageAssertion({
    kind: "history_coverage",
    query: assertion.query,
    groupId: assertion.groupId,
    count: assertion.count,
  });
}

/** Verify a distinct earlier group input through a later Owner-private Run. */
export function observeHistorySeedResult(assertion, { db, events, runId, inputBinding }) {
  validateHistorySeedAssertion(assertion);
  const untilMs = Date.parse(assertion.until);
  if (
    !db ||
    runId === assertion.sourceRunId ||
    !Number.isSafeInteger(inputBinding?.time) ||
    inputBinding.time * 1000 <= untilMs
  )
    invalid();
  const { history, item } = protectedHistoryResultTrace(assertion, events, runId, {
    query: assertion.query,
    groupIds: [assertion.groupId],
    limit: 1,
    until: assertion.until,
  });
  const load = (id) =>
    db
      .prepare(
        "SELECT r.principal_id,r.conversation_id,r.scope_json,r.status,m.external_id,m.scope_key,p.kind FROM runs r JOIN messages m ON m.id=r.message_id JOIN principals p ON p.id=r.principal_id WHERE r.id=?",
      )
      .all(id);
  const seeds = load(assertion.sourceRunId),
    recalls = load(runId);
  if (seeds.length !== 1 || recalls.length !== 1) invalid();
  const seed = seeds[0],
    recall = recalls[0];
  let a, b;
  try {
    a = JSON.parse(seed.scope_json);
    b = JSON.parse(recall.scope_json);
  } catch {
    invalid();
  }
  const scopeKey = (scope) =>
    JSON.stringify([
      scope.connectionId,
      scope.botId,
      scope.chatType,
      scope.chatId,
      scope.senderId,
      scope.threadId ?? null,
    ]);
  const numeric = (value) => typeof value === "string" && /^[1-9]\d{0,15}$/.test(value);
  if (
    seed.kind !== "owner" ||
    recall.kind !== "owner" ||
    seed.status !== "succeeded" ||
    recall.status !== "succeeded" ||
    seed.principal_id !== recall.principal_id ||
    history.principalId !== recall.principal_id ||
    history.conversationId !== recall.conversation_id ||
    !a ||
    !b ||
    a.chatType !== "group" ||
    a.chatId !== assertion.groupId ||
    b.chatType !== "private" ||
    b.chatId !== b.senderId ||
    typeof a.connectionId !== "string" ||
    !a.connectionId ||
    a.connectionId !== b.connectionId ||
    a.botId !== b.botId ||
    a.senderId !== b.senderId ||
    !numeric(a.botId) ||
    !numeric(a.senderId) ||
    scopeKey(a) !== seed.scope_key ||
    scopeKey(b) !== recall.scope_key ||
    item?.senderId !== a.senderId ||
    item?.occurredAt !== assertion.until ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(item?.recordId ?? "")
  )
    invalid();
  const rows = db
    .prepare(
      "SELECT normalized_text,occurred_at,occurred_at_ms FROM channel_messages WHERE id=? AND channel='qq-onebot' AND connection_id=? AND group_id=? AND resource_id=? AND source_class='history' AND external_message_id=? AND sender_id=? AND instr(lower(normalized_text),?)>0",
    )
    .all(
      item.recordId,
      a.connectionId,
      assertion.groupId,
      `group:${assertion.groupId}`,
      seed.external_id,
      a.senderId,
      assertion.query,
    );
  if (
    rows.length !== 1 ||
    rows[0].occurred_at !== assertion.until ||
    rows[0].occurred_at_ms !== untilMs ||
    typeof rows[0].normalized_text !== "string" ||
    rows[0].normalized_text.length > 4096 ||
    !matchesHistoryText(item, historySnippet(rows[0].normalized_text, assertion.query))
  )
    invalid();
  return {
    kind: "history_seed_result",
    result: "hit",
    returned: 1,
    sourceVerified: true,
    toolOutputVerified: true,
    distinctEarlierInput: true,
  };
}
