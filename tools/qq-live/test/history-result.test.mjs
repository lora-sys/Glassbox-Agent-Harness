import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { observeFeature, validateFeatureAssertions } from "../lib/feature-observer.mjs";
import {
  historySnippet,
  observeHistorySeedResult,
  validateHistorySeedAssertion,
} from "../lib/history-result.mjs";

const nonce = "a".repeat(32),
  recordId = "11111111-1111-4111-8111-111111111111";
const digest = (value) => createHash("sha256").update(value).digest("hex");
function fixture(t, result = "hit") {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  db.exec(
    "CREATE TABLE principals(id TEXT,kind TEXT); CREATE TABLE messages(id TEXT,external_id TEXT,scope_key TEXT); CREATE TABLE runs(id TEXT,principal_id TEXT,conversation_id TEXT,scope_json TEXT,status TEXT,message_id TEXT); CREATE TABLE channel_messages(id TEXT,channel TEXT,connection_id TEXT,group_id TEXT,resource_id TEXT,source_class TEXT,external_message_id TEXT,sender_id TEXT,occurred_at TEXT,occurred_at_ms INTEGER,normalized_text TEXT)",
  );
  const scope = {
    connectionId: "p3-qq",
    botId: "10003",
    chatType: result === "hit" ? "group" : "private",
    chatId: result === "hit" ? "123" : "10002",
    senderId: "10002",
    threadId: null,
  };
  const key = JSON.stringify([
    scope.connectionId,
    scope.botId,
    scope.chatType,
    scope.chatId,
    scope.senderId,
    null,
  ]);
  db.prepare("INSERT INTO principals VALUES (?,?)").run("owner", "owner");
  db.prepare("INSERT INTO messages VALUES (?,?,?)").run("message", "-22", key);
  db.prepare("INSERT INTO runs VALUES (?,?,?,?,?,?)").run(
    "run-1",
    "owner",
    "conv-1",
    JSON.stringify(scope),
    "succeeded",
    "message",
  );
  const text = `test ${nonce} ${"x".repeat(300)}`,
    occurredAt = "2026-10-06T00:00:00.000Z";
  const seed = () =>
    db
      .prepare("INSERT INTO channel_messages VALUES (?,?,?,?,?,?,?,?,?,?,?)")
      .run(
        recordId,
        "qq-onebot",
        "p3-qq",
        "123",
        "group:123",
        "history",
        "-22",
        "10002",
        occurredAt,
        Date.parse(occurredAt),
        text,
      );
  if (result === "hit") seed();
  const returned = result === "hit" ? 1 : 0;
  const tool = result === "hit" ? "group_history_search" : "owner_history_search";
  const snippet = historySnippet(text, nonce),
    output = "protected result";
  const event = {
    type: "history_retrieval",
    runId: "run-1",
    principalId: "owner",
    conversationId: "conv-1",
    query: nonce,
    groups: ["123"],
    resources: ["group:123"],
    sourceKind: "channel_message",
    retrievalMode: "lexical",
    considered: returned,
    truncated: false,
    resultStatus: returned ? "matches_found" : "no_matches_in_searched_window",
    toolOutput: { sha256: digest(output), bytes: Buffer.byteLength(output) },
    coverage: {
      requestedLimit: 1,
      returned,
      considered: returned,
      truncated: false,
      truncationReasons: [],
      perSourceCap: null,
      exactTerms: [nonce],
      droppedByExactTerm: 0,
      coverage: "complete",
      groupsSearched: 1,
      sourceLimits: [],
      sourceCoverage: [
        {
          groupId: "123",
          returned,
          considered: returned,
          capped: false,
          sync: { pagesWalked: 1, stop: "end_of_source" },
        },
      ],
      observedAt: occurredAt,
    },
    items: returned
      ? [
          {
            resourceId: "group:123",
            sourceId: "123",
            rank: 1,
            score: 1,
            matchedTerms: [nonce],
            returnMode: "raw",
            recordId,
            textSha256: digest(snippet),
            textBytes: Buffer.byteLength(snippet),
            occurredAt,
            senderId: "10002",
          },
        ]
      : [],
  };
  const input = returned
    ? { query: nonce, limit: 1 }
    : { query: nonce, groupIds: ["123"], limit: 1 };
  const events = [
    event,
    { type: "tool_call", runId: "run-1", toolCallId: "call-1", data: { name: tool, input } },
    {
      type: "tool_result",
      runId: "run-1",
      toolCallId: "call-1",
      data: {
        name: tool,
        isError: false,
        outputSha256: digest(output),
        outputBytes: Buffer.byteLength(output),
      },
    },
  ];
  const assertion = {
    kind: "history_result",
    tool,
    query: nonce,
    groupId: "123",
    result,
    count: 1,
  };
  return { db, events, event, assertion, seed, text, scope };
}
test("history result proves the current input source and protected output without returning payload", (t) => {
  const f = fixture(t);
  const result = observeFeature([f.assertion], { db: f.db, events: f.events, runId: "run-1" });
  assert.deepEqual(result.observations, [
    {
      kind: "history_result",
      result: "hit",
      returned: 1,
      sourceVerified: true,
      toolOutputVerified: true,
    },
  ]);
  assert.ok(!JSON.stringify(result).includes(nonce));
  assert.ok(!JSON.stringify(result).includes(recordId));
});
test("private history no-match requires complete source and independently empty scoped archive", (t) => {
  const f = fixture(t, "no_match");
  assert.equal(
    observeFeature([f.assertion], { db: f.db, events: f.events, runId: "run-1" }).status,
    "PASS",
  );
  f.seed();
  assert.throws(
    () => observeFeature([f.assertion], { db: f.db, events: f.events, runId: "run-1" }),
    /独立来源/,
  );
});
test("history result rejects changed output hashes, source records and identity", (t) => {
  const f = fixture(t);
  for (const mutate of [
    (e) => (e[0].toolOutput.sha256 = "b".repeat(64)),
    (e) => (e[0].resultStatus = "no_matches_in_searched_window"),
    (e) => (e[0].principalId = "visitor"),
    (e) => (e[0].conversationId = "other"),
    (e) => (e[0].items[0].recordId = "22222222-2222-4222-8222-222222222222"),
    (e) => (e[0].items[0].senderId = "10004"),
    (e) => (e[0].items[0].textSha256 = "c".repeat(64)),
    (e) => (e[0].items[0].textBytes = 0),
    (e) => (e[0].items[0].occurredAt = "2026-10-05T00:00:00.000Z"),
    (e) => (e[2].toolCallId = "other"),
    (e) => (e[1].data.input.limit = 2),
    (e) => (e[2].data.isError = true),
  ]) {
    const events = structuredClone(f.events);
    mutate(events);
    assert.throws(
      () => observeFeature([f.assertion], { db: f.db, events, runId: "run-1" }),
      /独立来源/,
    );
  }
  f.db.exec("UPDATE principals SET kind='visitor'");
  assert.throws(
    () => observeFeature([f.assertion], { db: f.db, events: f.events, runId: "run-1" }),
    /独立来源/,
  );
});
test("history result rejects current-source metadata and archive-scope mismatches", (t) => {
  const f = fixture(t);
  for (const [column, value] of [
    ["external_message_id", "-23"],
    ["sender_id", "10004"],
    ["group_id", "456"],
    ["resource_id", "group:456"],
    ["connection_id", "other"],
    ["source_class", "notice"],
    ["occurred_at_ms", 0],
    ["normalized_text", "missing nonce"],
  ]) {
    const previous = f.db.prepare(`SELECT ${column} AS value FROM channel_messages`).get().value;
    f.db.prepare(`UPDATE channel_messages SET ${column}=?`).run(value);
    assert.throws(
      () => observeFeature([f.assertion], { db: f.db, events: f.events, runId: "run-1" }),
      /独立来源/,
    );
    f.db.prepare(`UPDATE channel_messages SET ${column}=?`).run(previous);
  }
});
test("history result assertions reject custom recipes and missing database evidence", (t) => {
  const f = fixture(t);
  for (const change of [
    { tool: "owner_history_search" },
    { result: "anything" },
    { query: "free text" },
    { count: 2 },
    { sql: "SELECT 1" },
  ])
    assert.throws(() => validateFeatureAssertions([{ ...f.assertion, ...change }]));
  assert.throws(
    () => observeFeature([f.assertion], { events: f.events, runId: "run-1" }),
    /独立来源/,
  );
});

function seedFixture(t) {
  const f = fixture(t);
  const scope = { ...f.scope, chatType: "private", chatId: f.scope.senderId };
  const key = JSON.stringify([
    scope.connectionId,
    scope.botId,
    scope.chatType,
    scope.chatId,
    scope.senderId,
    null,
  ]);
  f.db.prepare("INSERT INTO messages VALUES (?,?,?)").run("recall-message", "-23", key);
  f.db
    .prepare("INSERT INTO runs VALUES (?,?,?,?,?,?)")
    .run(
      "recall-run",
      "owner",
      "private-conversation",
      JSON.stringify(scope),
      "succeeded",
      "recall-message",
    );
  const until = f.event.items[0].occurredAt;
  const assertion = {
    kind: "history_seed_result",
    tool: "owner_history_search",
    query: nonce,
    groupId: "123",
    result: "hit",
    count: 1,
    sourceRunId: "run-1",
    until,
  };
  for (const event of f.events) {
    event.runId = "recall-run";
    if (event.data?.name) event.data.name = "owner_history_search";
  }
  f.event.conversationId = "private-conversation";
  f.events.find((e) => e.type === "tool_call").data.input = {
    query: nonce,
    groupIds: ["123"],
    limit: 1,
    until,
  };
  return {
    ...f,
    assertion,
    runId: "recall-run",
    inputBinding: { time: Date.parse(until) / 1000 + 1 },
  };
}
test("history seed proves a distinct earlier group input from a later private Run", (t) => {
  const f = seedFixture(t);
  assert.deepEqual(observeHistorySeedResult(f.assertion, f), {
    kind: "history_seed_result",
    result: "hit",
    returned: 1,
    sourceVerified: true,
    toolOutputVerified: true,
    distinctEarlierInput: true,
  });
  for (const change of [
    (a) => (a.sourceRunId = "recall-run"),
    (a) => (a.until = "2026-10-06T00:00:00.001Z"),
    (a) => (a.until = "2026-10-06T00:00:01.000Z"),
    (a) => (a.tool = "group_history_search"),
    (a) => (a.sql = "arbitrary"),
  ]) {
    const a = structuredClone(f.assertion);
    change(a);
    assert.throws(() => observeHistorySeedResult(a, f));
  }
  assert.throws(() =>
    observeHistorySeedResult(f.assertion, {
      ...f,
      inputBinding: { time: Date.parse(f.assertion.until) / 1000 },
    }),
  );
  assert.throws(() => observeHistorySeedResult(f.assertion, { ...f, inputBinding: undefined }));
});
test("history seed rejects another source, actor, scope and a missing time constraint", (t) => {
  const f = seedFixture(t);
  const call = f.events.find((e) => e.type === "tool_call");
  delete call.data.input.until;
  assert.throws(() => observeHistorySeedResult(f.assertion, f));
  call.data.input.until = f.assertion.until;
  for (const sql of [
    "UPDATE channel_messages SET external_message_id='-23'",
    "UPDATE runs SET principal_id='foreign' WHERE id='run-1'",
    "UPDATE messages SET scope_key='foreign' WHERE id='message'",
    "UPDATE channel_messages SET occurred_at_ms=0",
    "UPDATE channel_messages SET normalized_text='unrelated'",
  ]) {
    f.db.exec("SAVEPOINT invalid_source");
    f.db.exec(sql);
    assert.throws(() => observeHistorySeedResult(f.assertion, f));
    f.db.exec("ROLLBACK TO invalid_source; RELEASE invalid_source");
  }
  const bad = { ...f.assertion, count: 2 };
  assert.throws(() => validateHistorySeedAssertion(bad));
});
