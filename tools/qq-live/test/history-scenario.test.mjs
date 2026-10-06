import test from "node:test";
import assert from "node:assert/strict";
import {
  historyRecallSpec,
  historyScenarioSteps,
  historySeedSpec,
} from "../lib/history-scenario.mjs";

const marker = "a".repeat(32);
const config = {
  groups: [
    { alias: "A", id: "20001" },
    { alias: "B", id: "20002" },
  ],
};
const input = () => ({
  config,
  groupId: "20001",
  seedMarker: marker,
  seedRunId: "run-seed-1",
  seedInputTime: Math.floor(Date.now() / 1000),
});

test("builds a fixed seed without fabricated Run or time evidence", () => {
  const seed = historySeedSpec(config);
  assert.equal(seed.id, "history-current-group-hit");
  assert.equal(seed.chat, "A");
  assert.deepEqual(seed.leaseTools[0].operations[0], {
    action: "history:read",
    resourceId: "group:20001",
    inputConstraint: { query: "{{nonce}}", limit: 1 },
  });
  assert.deepEqual(seed.featureAssertions[3], {
    kind: "history_result",
    tool: "group_history_search",
    query: "{{nonce}}",
    groupId: "20001",
    result: "hit",
    count: 1,
  });
});

test("builds Owner-private recall from independent seed Run and Unix-second evidence", () => {
  const seedEvidence = input();
  const until = new Date(seedEvidence.seedInputTime * 1000).toISOString();
  const recall = historyRecallSpec(seedEvidence);
  const composed = historyScenarioSteps(seedEvidence);
  assert.equal(recall.chat, "private");
  assert.match(recall.prompt, new RegExp(`query=${marker}`));
  assert.match(recall.prompt, new RegExp(`until=${until.replaceAll(".", "\\.")}`));
  assert.match(recall.prompt, /\{\{nonce\}\}/);
  assert.deepEqual(recall.expectContains, ["{{nonce}}"]);
  assert.deepEqual(recall.leaseTools[0].operations[0], {
    action: "history:search",
    resourceId: "owner-history",
    inputConstraint: {
      query: marker,
      groupIds: ["20001"],
      limit: 1,
      until,
    },
  });
  assert.deepEqual(recall.featureAssertions[3], {
    kind: "history_seed_result",
    tool: "owner_history_search",
    query: marker,
    groupId: "20001",
    result: "hit",
    count: 1,
    sourceRunId: "run-seed-1",
    until,
  });
  assert.deepEqual(composed.seed, historySeedSpec(config));
  assert.deepEqual(composed.recall, recall);
  assert.ok(recall.prompt.includes(historySeedSpec(config).expectContains[0]));
});

test("rejects wrong group, malformed seed identity, out-of-range time, and extra inputs", () => {
  const invalidInputs = [
    { groupId: "20002" },
    { seedMarker: "A".repeat(32) },
    { seedMarker: "a".repeat(31) },
    { seedRunId: "bad/run/id" },
    { seedRunId: "" },
    { seedInputTime: Number.MAX_SAFE_INTEGER },
    { seedInputTime: Math.floor(Date.now() / 1000) + 60 },
    { seedInputTime: 1.5 },
    { extra: true },
  ];
  for (const change of invalidInputs)
    assert.throws(() => historyScenarioSteps({ ...input(), ...change }), {
      code: "HISTORY_SCENARIO_INPUT",
    });
  assert.throws(
    () =>
      historyScenarioSteps({
        ...input(),
        config: { groups: [...config.groups, config.groups[0]] },
      }),
    { code: "HISTORY_SCENARIO_INPUT" },
  );
  assert.throws(
    () => historyScenarioSteps({ ...input(), config: { groups: [{ alias: "A", id: "invalid" }] } }),
    { code: "HISTORY_SCENARIO_INPUT" },
  );
});
