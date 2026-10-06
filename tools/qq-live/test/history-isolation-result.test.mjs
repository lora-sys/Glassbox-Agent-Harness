import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  observeHistoryExclusionResult,
  validateHistoryExclusionAssertion,
} from "../lib/history-result.mjs";

const query = "a".repeat(32);
const sentinel = `qq-isolation-secret-${"b".repeat(32)}`;
const until = "2026-10-06T00:00:00.000Z";
const digest = (value) => createHash("sha256").update(value, "utf8").digest("hex");

function fixture(t) {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  db.exec(
    "CREATE TABLE principals(id TEXT,kind TEXT); CREATE TABLE messages(id TEXT,external_id TEXT,scope_key TEXT); CREATE TABLE runs(id TEXT,principal_id TEXT,conversation_id TEXT,scope_json TEXT,status TEXT,message_id TEXT); CREATE TABLE channel_messages(id TEXT,channel TEXT,connection_id TEXT,group_id TEXT,resource_id TEXT,source_class TEXT,external_message_id TEXT,sender_id TEXT,occurred_at TEXT,occurred_at_ms INTEGER,normalized_text TEXT)",
  );
  const groupScope = {
    connectionId: "p3-qq",
    botId: "10003",
    chatType: "group",
    chatId: "456",
    senderId: "10002",
    threadId: null,
  };
  const privateScope = { ...groupScope, chatType: "private", chatId: "10002" };
  const scopeKey = (scope) =>
    JSON.stringify([
      scope.connectionId,
      scope.botId,
      scope.chatType,
      scope.chatId,
      scope.senderId,
      null,
    ]);
  db.prepare("INSERT INTO principals VALUES (?,?)").run("owner", "owner");
  db.prepare("INSERT INTO messages VALUES (?,?,?)").run(
    "seed-message",
    "-41",
    scopeKey(groupScope),
  );
  db.prepare("INSERT INTO messages VALUES (?,?,?)").run(
    "recall-message",
    "-42",
    scopeKey(privateScope),
  );
  db.prepare("INSERT INTO runs VALUES (?,?,?,?,?,?)").run(
    "seed-run",
    "owner",
    "group-conversation",
    JSON.stringify(groupScope),
    "succeeded",
    "seed-message",
  );
  db.prepare("INSERT INTO runs VALUES (?,?,?,?,?,?)").run(
    "recall-run",
    "owner",
    "private-conversation",
    JSON.stringify(privateScope),
    "succeeded",
    "recall-message",
  );
  db.prepare("INSERT INTO channel_messages VALUES (?,?,?,?,?,?,?,?,?,?,?)").run(
    "11111111-1111-4111-8111-111111111111",
    "qq-onebot",
    "p3-qq",
    "456",
    "group:456",
    "history",
    "-41",
    "10002",
    until,
    Date.parse(until),
    `Seed text ${query} contains ${sentinel}`,
  );

  const toolOutput = "protected history result";
  const history = {
    type: "history_retrieval",
    runId: "recall-run",
    principalId: "owner",
    conversationId: "private-conversation",
    query,
    groups: ["123"],
    resources: ["group:123"],
    sourceKind: "channel_message",
    retrievalMode: "lexical",
    considered: 0,
    truncated: false,
    resultStatus: "no_matches_in_searched_window",
    toolOutput: { sha256: digest(toolOutput), bytes: Buffer.byteLength(toolOutput) },
    coverage: {
      requestedLimit: 1,
      returned: 0,
      considered: 0,
      truncated: false,
      truncationReasons: [],
      perSourceCap: null,
      exactTerms: [query],
      droppedByExactTerm: 0,
      coverage: "complete",
      groupsSearched: 1,
      sourceLimits: [],
      sourceCoverage: [
        {
          groupId: "123",
          returned: 0,
          considered: 0,
          capped: false,
          sync: { pagesWalked: 1, stop: "end_of_source" },
        },
      ],
      observedAt: "2026-10-06T00:01:00.000Z",
    },
    items: [],
  };
  const events = [
    history,
    {
      type: "tool_call",
      runId: "recall-run",
      toolCallId: "call-1",
      data: {
        name: "owner_history_search",
        input: { query, groupIds: ["123"], limit: 1, until },
      },
    },
    {
      type: "tool_result",
      runId: "recall-run",
      toolCallId: "call-1",
      data: {
        name: "owner_history_search",
        isError: false,
        outputSha256: digest(toolOutput),
        outputBytes: Buffer.byteLength(toolOutput),
      },
    },
  ];
  return {
    db,
    events,
    runId: "recall-run",
    inputBinding: { time: Date.parse(until) / 1000 + 60 },
    assertion: {
      kind: "history_exclusion_result",
      tool: "owner_history_search",
      query,
      groupId: "123",
      sourceGroupId: "456",
      sourceRunId: "seed-run",
      until,
      sentinelSha256: digest(sentinel),
      result: "no_match",
      count: 1,
    },
  };
}

test("cross-group history exclusion proves a B source and a complete A no-match", (t) => {
  const f = fixture(t);
  assert.deepEqual(observeHistoryExclusionResult(f.assertion, f), {
    kind: "history_exclusion_result",
    result: "no_match",
    returned: 0,
    sourceVerified: true,
    exclusionVerified: true,
    toolOutputVerified: true,
  });
  const serialized = JSON.stringify(observeHistoryExclusionResult(f.assertion, f));
  assert.ok(!serialized.includes(query));
  assert.ok(!serialized.includes(sentinel));
  assert.ok(!serialized.includes("11111111-1111-4111-8111-111111111111"));
});

test("cross-group exclusion assertion has a fixed contract", (t) => {
  const assertion = fixture(t).assertion;
  validateHistoryExclusionAssertion(assertion);
  for (const patch of [
    (a) => (a.extra = true),
    (a) => (a.groupId = "0"),
    (a) => (a.sourceGroupId = a.groupId),
    (a) => (a.query = "bad"),
    (a) => (a.count = 0),
    (a) => (a.until = "2026-10-06T00:00:00.001Z"),
    (a) => (a.sentinelSha256 = "z".repeat(64)),
  ]) {
    const bad = structuredClone(assertion);
    patch(bad);
    assert.throws(() => validateHistoryExclusionAssertion(bad));
  }
});

test("cross-group exclusion rejects missing source and mismatched source time", (t) => {
  const missing = fixture(t);
  missing.db.prepare("DELETE FROM channel_messages").run();
  assert.throws(() => observeHistoryExclusionResult(missing.assertion, missing));

  const wrongTime = fixture(t);
  wrongTime.db.prepare("UPDATE channel_messages SET occurred_at_ms=occurred_at_ms+1000").run();
  assert.throws(() => observeHistoryExclusionResult(wrongTime.assertion, wrongTime));
});

test("cross-group exclusion requires the same succeeded Owner and a later private input", (t) => {
  const wrongOwner = fixture(t);
  wrongOwner.db.prepare("INSERT INTO principals VALUES (?,?)").run("other", "owner");
  wrongOwner.db.prepare("UPDATE runs SET principal_id='other' WHERE id='seed-run'").run();
  assert.throws(() => observeHistoryExclusionResult(wrongOwner.assertion, wrongOwner));

  const sameGroup = fixture(t);
  sameGroup.assertion.sourceGroupId = sameGroup.assertion.groupId;
  assert.throws(() => observeHistoryExclusionResult(sameGroup.assertion, sameGroup));

  const earlyRecall = fixture(t);
  earlyRecall.inputBinding.time = Date.parse(until) / 1000;
  assert.throws(() => observeHistoryExclusionResult(earlyRecall.assertion, earlyRecall));
});

test("cross-group exclusion rejects forged Tool evidence and a real A match", (t) => {
  const forged = fixture(t);
  forged.events[0].resultStatus = "matches_found";
  assert.throws(() => observeHistoryExclusionResult(forged.assertion, forged));

  const targetMatch = fixture(t);
  targetMatch.db
    .prepare("INSERT INTO channel_messages VALUES (?,?,?,?,?,?,?,?,?,?,?)")
    .run(
      "22222222-2222-4222-8222-222222222222",
      "qq-onebot",
      "p3-qq",
      "123",
      "group:123",
      "history",
      "-50",
      "10004",
      "2026-10-05T23:59:59.000Z",
      Date.parse("2026-10-05T23:59:59.000Z"),
      `Different source contains ${query}`,
    );
  assert.throws(() => observeHistoryExclusionResult(targetMatch.assertion, targetMatch));
});

test("cross-group exclusion rejects a source whose sentinel does not match the assertion", (t) => {
  const f = fixture(t);
  f.assertion.sentinelSha256 = digest("qq-isolation-secret-" + "c".repeat(32));
  assert.throws(() => observeHistoryExclusionResult(f.assertion, f));
});
