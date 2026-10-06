import test from "node:test";
import assert from "node:assert/strict";
import { observeFeature, validateFeatureAssertions } from "../lib/feature-observer.mjs";

const nonce = "a".repeat(32);
const assertion = { kind: "history_coverage", query: nonce, groupId: "123", count: 1 };
function evidence(returned = 0) {
  return {
    type: "history_retrieval",
    runId: "run-1",
    query: nonce,
    groups: ["123"],
    resources: ["group:123"],
    sourceKind: "channel_message",
    retrievalMode: "lexical",
    considered: returned,
    truncated: false,
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
      observedAt: "2026-10-06T00:00:00.000Z",
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
          },
        ]
      : [],
  };
}
test("complete history source and window return only sanitized counts", () => {
  for (const returned of [0, 1]) {
    const result = observeFeature([assertion], { events: [evidence(returned)], runId: "run-1" });
    assert.deepEqual(result.observations, [
      { kind: "history_coverage", coverage: "complete", returned, sourceComplete: true },
    ]);
    assert.ok(!JSON.stringify(result).includes("123"));
  }
});
test("history completeness accepts considered exact-term rejects without calling them truncation", () => {
  const event = evidence();
  event.considered = 2;
  event.coverage.considered = 2;
  event.coverage.droppedByExactTerm = 2;
  event.coverage.sourceCoverage[0].considered = 0;
  assert.equal(observeFeature([assertion], { events: [event], runId: "run-1" }).status, "PASS");
});
test("history completeness accepts archive candidates excluded by other retrieval filters", () => {
  for (const returned of [0, 1]) {
    const event = evidence(returned);
    event.considered = 2;
    event.coverage.considered = 2;
    assert.equal(observeFeature([assertion], { events: [event], runId: "run-1" }).status, "PASS");
  }
});
test("history completeness fails closed on incomplete, conflicting or foreign evidence", () => {
  const mutations = [
    (e) => (e.coverage.coverage = "partial"),
    (e) => (e.coverage.sourceLimits = ["page_bound_reached"]),
    (e) => (e.coverage.sourceCoverage[0].sync.stop = "provider_failed"),
    (e) => (e.coverage.sourceCoverage[0].sync = "unreported"),
    (e) => (e.coverage.truncated = true),
    (e) => (e.coverage.truncationReasons = ["limit"]),
    (e) => (e.coverage.continuation = {}),
    (e) => (e.coverage.returned = 2),
    (e) => (e.coverage.considered = -1),
    (e) => (e.coverage.sourceCoverage[0].capped = true),
    (e) => e.coverage.sourceCoverage.push({ ...e.coverage.sourceCoverage[0], groupId: "456" }),
    (e) => (e.groups = ["123", "456"]),
    (e) => (e.resources = ["group:456"]),
    (e) => (e.query = "b".repeat(32)),
    (e) => (e.coverage.exactTerms = []),
    (e) => (e.coverage.observedAt = "yesterday"),
    (e) => (e.runId = "other-run"),
    (e) => (e.coverage.requestedLimit = 10),
    (e) => (e.coverage.perSourceCap = 1),
    (e) => (e.coverage.sourceCoverage[0].returned = 1),
    (e) => (e.truncated = true),
    (e) => (e.coverage.sourceCoverage = [null]),
  ];
  for (const mutate of mutations) {
    const event = evidence();
    mutate(event);
    assert.throws(() => observeFeature([assertion], { events: [event], runId: "run-1" }), /完整性/);
  }
  assert.throws(
    () => observeFeature([assertion], { events: [evidence(), evidence()], runId: "run-1" }),
    /完整性/,
  );
  for (const change of [
    { sourceId: "456" },
    { resourceId: "group:456" },
    { rank: 0 },
    { returnMode: "excerpt" },
    { matchedTerms: [] },
  ]) {
    const event = evidence(1);
    Object.assign(event.items[0], change);
    assert.throws(() => observeFeature([assertion], { events: [event], runId: "run-1" }), /完整性/);
  }
  const nullItem = evidence(1);
  nullItem.items = [null];
  assert.throws(
    () => observeFeature([assertion], { events: [nullItem], runId: "run-1" }),
    /完整性/,
  );
});
test("history completeness validates closed assertion fields", () => {
  for (const change of [
    { count: 0 },
    { groupId: "{{group:B}}" },
    { query: "arbitrary" },
    { coverage: "complete" },
  ])
    assert.throws(() => validateFeatureAssertions([{ ...assertion, ...change }]), /完整性/);
});
