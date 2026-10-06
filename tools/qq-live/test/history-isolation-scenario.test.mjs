import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  historyExclusionSpec,
  historyIsolationScenarioSteps,
  historyIsolationSeedSpec,
} from "../lib/history-isolation-scenario.mjs";

const seedMarker = "a".repeat(32);
const sentinel = `qq-isolation-secret-${"b".repeat(32)}`;
const config = {
  groups: [
    { alias: "A", id: "20001" },
    { alias: "B", id: "20002" },
  ],
};
const input = () => ({
  config,
  sourceGroupId: "20002",
  seedMarker,
  sentinel,
  sourceRunId: "run-seed-b",
  seedInputTime: Math.floor(Date.now() / 1000),
});
const sha256 = (value) => createHash("sha256").update(value, "utf8").digest("hex");

test("builds B seed with a query nonce and independent sentinel content", () => {
  const seed = historyIsolationSeedSpec({ config, sentinel });
  assert.equal(seed.id, "history-cross-group-seed");
  assert.equal(seed.chat, "B");
  assert.match(seed.prompt, /\{\{nonce\}\}/);
  assert.ok(seed.prompt.includes(sentinel));
  assert.deepEqual(seed.expectContains, ["{{nonce}}"]);
  assert.deepEqual(seed.leaseTools[0].operations[0], {
    action: "history:read",
    resourceId: "group:20002",
    inputConstraint: { query: "{{nonce}}", limit: 1 },
  });
  assert.deepEqual(seed.featureAssertions[3], {
    kind: "history_result",
    tool: "group_history_search",
    query: "{{nonce}}",
    groupId: "20002",
    result: "hit",
    count: 1,
  });
});

test("builds Owner-private exclusion restricted to A and binds B evidence by summary", () => {
  const evidence = input();
  const until = new Date(evidence.seedInputTime * 1000).toISOString();
  const exclusion = historyExclusionSpec(evidence);
  const composed = historyIsolationScenarioSteps(evidence);
  assert.equal(exclusion.chat, "private");
  assert.match(exclusion.prompt, new RegExp(`query=${seedMarker}`));
  assert.ok(exclusion.prompt.includes(`until=${until}`));
  assert.deepEqual(exclusion.leaseTools[0].operations[0], {
    action: "history:search",
    resourceId: "owner-history",
    inputConstraint: {
      query: seedMarker,
      groupIds: ["20001"],
      limit: 1,
      until,
    },
  });
  assert.deepEqual(exclusion.featureAssertions[3], {
    kind: "history_exclusion_result",
    tool: "owner_history_search",
    result: "no_match",
    count: 1,
    query: seedMarker,
    groupId: "20001",
    sourceGroupId: "20002",
    sourceRunId: "run-seed-b",
    until,
    sentinelSha256: sha256(sentinel),
  });
  assert.equal(JSON.stringify(exclusion).includes(sentinel), false);
  assert.deepEqual(composed.seed, historyIsolationSeedSpec({ config, sentinel }));
  assert.deepEqual(composed.exclusion, exclusion);
  assert.deepEqual(composed.expectedForbiddenContains, [sentinel]);
});

test("rejects ambiguous scopes, marker reuse, invalid evidence, and extra inputs", () => {
  const invalidInputs = [
    { sourceGroupId: "20001" },
    { seedMarker: "A".repeat(32) },
    { seedMarker: "a".repeat(31) },
    { seedMarker: [seedMarker] },
    { sentinel: seedMarker },
    { sentinel: `qq-isolation-secret-${"b".repeat(31)}` },
    { sentinel: [sentinel] },
    { seedMarker: "b".repeat(32), sentinel: `qq-isolation-secret-${"b".repeat(32)}` },
    { sourceRunId: "bad/run/id" },
    { sourceRunId: "" },
    { sourceRunId: ["run-seed-b"] },
    { sourceGroupId: ["20002"] },
    { seedInputTime: Number.MAX_SAFE_INTEGER },
    { seedInputTime: Math.floor(Date.now() / 1000) + 60 },
    { seedInputTime: 1.5 },
    { extra: true },
  ];
  for (const change of invalidInputs)
    assert.throws(() => historyIsolationScenarioSteps({ ...input(), ...change }), {
      code: "HISTORY_ISOLATION_SCENARIO_INPUT",
    });

  const invalidConfigs = [
    { groups: "not-groups" },
    { groups: [...config.groups, { alias: "A", id: "20003" }] },
    { groups: [...config.groups, { alias: "B", id: "20003" }] },
    {
      groups: [
        { alias: "A", id: "20001" },
        { alias: "B", id: "20001" },
      ],
    },
    {
      groups: [
        { alias: "A", id: "bad" },
        { alias: "B", id: "20002" },
      ],
    },
  ];
  for (const invalidConfig of invalidConfigs)
    assert.throws(() => historyIsolationScenarioSteps({ ...input(), config: invalidConfig }), {
      code: "HISTORY_ISOLATION_SCENARIO_INPUT",
    });
  assert.throws(() => historyIsolationSeedSpec({ config, sentinel, extra: true }), {
    code: "HISTORY_ISOLATION_SCENARIO_INPUT",
  });
  assert.throws(() => historyIsolationSeedSpec({ config, sentinel: [sentinel] }), {
    code: "HISTORY_ISOLATION_SCENARIO_INPUT",
  });
});
