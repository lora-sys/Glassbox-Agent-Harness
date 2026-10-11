import test from "node:test";
import assert from "node:assert/strict";
import { historyInputDigest } from "../lib/history-input-evidence.mjs";
import { observeHistorySyncOutcome } from "../lib/history-sync-outcome.mjs";

const runId = "history_sync_run_01";
const principalId = "principal_owner";
const toolCallId = "tool-call-history-1";
const query = "a1b2c3d4e5f60718293a4b5c6d7e8f90";
const groupId = "123456789";
const outputSha256 = "a".repeat(64);
const at = (seconds) => new Date(seconds * 1000).toISOString();

function fixture({ returned = 0, stop = "page_bound_reached" } = {}) {
  const item = {
    recordId: "0d9da1ae-efed-4cc7-b521-488bb46480e5",
    textSha256: "b".repeat(64),
    textBytes: 39,
    occurredAt: at(1_800_000_000),
    senderId: "987654321",
    resourceId: `group:${groupId}`,
    sourceId: groupId,
    rank: 1,
    score: 0.75,
    matchedTerms: [query],
    returnMode: "raw",
  };
  const coverage = {
    requestedLimit: 1,
    returned,
    considered: returned,
    truncated: false,
    truncationReasons: [],
    perSourceCap: null,
    exactTerms: [query],
    droppedByExactTerm: 0,
    coverage: "partial",
    groupsSearched: 1,
    sourceLimits: [stop],
    sourceCoverage: [
      {
        groupId,
        returned,
        considered: returned,
        capped: false,
        sync: { pagesWalked: 1, stop },
      },
    ],
    observedAt: at(1_800_000_002),
  };
  const digestAndSize = { sha256: outputSha256, bytes: 432 };
  const call = {
    type: "tool_call",
    timestamp: at(1_800_000_001),
    runId,
    principalId,
    toolCallId,
    data: {
      runId,
      principalId,
      toolCallId,
      name: "group_history_search",
      ...historyInputDigest({ query, limit: 1 }),
    },
  };
  const history = {
    type: "history_retrieval",
    runId,
    principalId,
    conversationId: "conversation-1",
    query,
    groups: [groupId],
    resources: [`group:${groupId}`],
    sourceKind: "channel_message",
    retrievalMode: "lexical",
    resultStatus: returned ? "matches_found" : "no_matches_in_searched_window",
    toolOutput: digestAndSize,
    considered: coverage.considered,
    truncated: coverage.truncated,
    coverage,
    items: returned ? [item] : [],
  };
  const result = {
    type: "tool_result",
    timestamp: at(1_800_000_003),
    runId,
    principalId,
    toolCallId,
    data: {
      runId,
      principalId,
      toolCallId,
      name: "group_history_search",
      isError: false,
      outputBytes: digestAndSize.bytes,
      outputSha256: digestAndSize.sha256,
    },
  };
  return { events: [call, history, result], call, history, result };
}

const assertion = (stop = "page_bound_reached") => ({
  kind: "history_sync_outcome",
  query,
  groupId,
  stop,
});

function rejects(events, expected = assertion()) {
  assert.throws(
    () => observeHistorySyncOutcome(expected, { events, runId }),
    (error) => error.code === "HISTORY_SYNC_OUTCOME" && error.status === "INCONCLUSIVE",
  );
}

test("accepts an actual producer-shaped partial empty window without claiming absence", () => {
  const { events } = fixture();
  const evidence = observeHistorySyncOutcome(assertion(), { events, runId });
  assert.deepEqual(evidence, {
    kind: "history_sync_outcome",
    coverage: "partial",
    stop: "page_bound_reached",
    pagesWalked: 1,
    returned: 0,
    resultStatus: "no_matches_in_searched_window",
    resultWindow: "searched_window_only",
    absenceVerified: false,
    toolOutputVerified: true,
    sourceEvidenceVerified: true,
    actualQqDeliveryVerified: false,
  });
  assert.equal(Object.hasOwn(evidence, "text"), false);
});

test("accepts a match inside a partial source window and reports only safe metadata", () => {
  const { events } = fixture({ returned: 1, stop: "cursor_stuck" });
  const evidence = observeHistorySyncOutcome(assertion("cursor_stuck"), { events, runId });
  assert.equal(evidence.returned, 1);
  assert.equal(evidence.resultStatus, "matches_found");
  assert.equal(evidence.absenceVerified, false);
  assert.equal(evidence.stop, "cursor_stuck");
});

test("accepts the producer's other bounded non-complete stop enums", () => {
  for (const stop of ["provider_unavailable", "provider_failed", "provider_unknown"]) {
    const { events } = fixture({ stop });
    assert.equal(observeHistorySyncOutcome(assertion(stop), { events, runId }).stop, stop);
  }
});

test("rejects complete, unreported, unsupported, or unexpected stop claims", () => {
  for (const stop of ["end_of_source", "since_bound_reached", "unreported", "made_up"]) {
    const { events } = fixture({ stop });
    rejects(events, assertion(stop));
  }
  const { events } = fixture();
  rejects(events, assertion("provider_failed"));
});

test("rejects false no-match claims and malformed source-window coverage", () => {
  const cases = [
    (history) => (history.resultStatus = "no_matches"),
    (history) => (history.resultStatus = "matches_found"),
    (history) => (history.coverage.coverage = "complete"),
    (history) => (history.coverage.sourceLimits = []),
    (history) => (history.coverage.groupsSearched = 0),
    (history) => (history.coverage.exactTerms = []),
    (history) => (history.coverage.requestedLimit = 2),
    (history) => (history.groups = [groupId, "987654321"]),
    (history) => (history.resources = []),
  ];
  for (const mutate of cases) {
    const { events, history } = fixture();
    mutate(history);
    rejects(events);
  }
});

test("rejects Run, principal, group, tool, input, and call identity mismatches", () => {
  const mutations = [
    (f) => (f.history.runId = "other-run"),
    (f) => (f.call.data.runId = "other-run"),
    (f) => (f.result.data.principalId = "other-principal"),
    (f) => (f.history.groups = ["987654321"]),
    (f) => (f.call.data.name = "owner_history_search"),
    (f) => (f.call.data.inputSha256 = "c".repeat(64)),
    (f) => (f.call.data.inputBytes += 1),
    (f) => (f.call.data.input = { query, limit: 1 }),
    (f) => (f.call.toolCallId = "other-call"),
  ];
  for (const mutate of mutations) {
    const f = fixture();
    mutate(f);
    rejects(f.events);
  }
});

test("rejects mismatched output digest, byte count, or leaked truncated output projection", () => {
  const mutations = [
    (f) => (f.result.data.outputSha256 = "c".repeat(64)),
    (f) => (f.result.data.outputBytes += 1),
    (f) => (f.result.data.outputHead = "partial protected output"),
    (f) => (f.result.data.outputTruncated = false),
    (f) => (f.result.data.details = { query }),
    (f) => (f.history.toolOutput.sha256 = "d".repeat(64)),
    (f) => (f.history.toolOutput.bytes = 0),
  ];
  for (const mutate of mutations) {
    const f = fixture();
    mutate(f);
    rejects(f.events);
  }
});

test("rejects duplicate events, invalid order, and invalid observedAt chronology", () => {
  const duplicate = fixture();
  rejects([...duplicate.events, structuredClone(duplicate.history)]);

  const reversed = fixture();
  reversed.events.reverse();
  rejects(reversed.events);

  const timestamp = fixture();
  timestamp.history.coverage.observedAt = at(1_800_000_000);
  rejects(timestamp.events);

  const invented = fixture();
  invented.history.timestamp = at(1_800_000_002);
  rejects(invented.events);
});

test("rejects inconsistent item coverage and truncation indicators", () => {
  const { events, history } = fixture({ returned: 1 });
  history.items[0].matchedTerms = [];
  rejects(events);

  const truncated = fixture();
  truncated.history.truncated = true;
  rejects(truncated.events);
});
