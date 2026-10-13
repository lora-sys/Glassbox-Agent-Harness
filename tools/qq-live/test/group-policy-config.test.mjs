import assert from "node:assert/strict";
import test from "node:test";
import { groupPolicyFixtureConfig } from "../lib/group-policy-config.mjs";

const config = {
  groups: [
    { alias: "A", id: "30003" },
    { alias: "B", id: "40004" },
  ],
  runtime: {
    checkout: "/fixture/checkout",
    dataDirectory: "/fixture/data",
    expectedCommit: "a".repeat(40),
    connectionId: "fixture-connection",
  },
  groupPolicyFixtures: {
    enabled: true,
    retainAuditConfirmed: true,
    groupId: "40004",
  },
};

test("accepts an explicit fixture bound to the unique configured group B", () => {
  const fixture = groupPolicyFixtureConfig(config);
  assert.deepEqual(fixture, config.groupPolicyFixtures);
  assert.notEqual(fixture, config.groupPolicyFixtures);
});

test("requires explicit enablement and audit retention", () => {
  for (const groupPolicyFixtures of [
    undefined,
    { ...config.groupPolicyFixtures, enabled: false },
    { ...config.groupPolicyFixtures, retainAuditConfirmed: false },
  ]) {
    assert.throws(() => groupPolicyFixtureConfig({ ...config, groupPolicyFixtures }), {
      code: "GROUP_POLICY_FIXTURE_DISABLED",
    });
  }
});

test("requires exact fixture fields and boolean confirmations", () => {
  for (const groupPolicyFixtures of [
    { ...config.groupPolicyFixtures, extra: true },
    { enabled: true, retainAuditConfirmed: true },
    { ...config.groupPolicyFixtures, enabled: "true" },
    { ...config.groupPolicyFixtures, retainAuditConfirmed: 1 },
  ]) {
    assert.throws(() => groupPolicyFixtureConfig({ ...config, groupPolicyFixtures }), {
      code: "GROUP_POLICY_CONFIG",
    });
  }
});

test("rejects group A, unknown groups, malformed and duplicate configured groups", () => {
  const invalidCases = [
    ["group A target", { ...config.groupPolicyFixtures, groupId: "30003" }, config.groups],
    ["unknown target", { ...config.groupPolicyFixtures, groupId: "50005" }, config.groups],
    ["malformed target", { ...config.groupPolicyFixtures, groupId: "0" }, config.groups],
    [
      "duplicate B alias",
      config.groupPolicyFixtures,
      [...config.groups, { alias: "B", id: "50005" }],
    ],
    [
      "duplicate A alias",
      config.groupPolicyFixtures,
      [{ alias: "A", id: "30003" }, ...config.groups],
    ],
    ["duplicate IDs", config.groupPolicyFixtures, [{ alias: "A", id: "40004" }, config.groups[1]]],
    [
      "unknown configured group",
      config.groupPolicyFixtures,
      [{ alias: "A", id: "30003" }, config.groups[1], { alias: "C", id: "50005" }],
    ],
  ];
  for (const [name, groupPolicyFixtures, groups] of invalidCases) {
    assert.throws(
      () => groupPolicyFixtureConfig({ ...config, groupPolicyFixtures, groups }),
      { code: "GROUP_POLICY_CONFIG" },
      name,
    );
  }
});

test("requires the Runtime identity and data locations for execution", () => {
  for (const runtime of [
    undefined,
    { ...config.runtime, checkout: "" },
    { ...config.runtime, dataDirectory: "" },
    { ...config.runtime, expectedCommit: "bad" },
    { ...config.runtime, connectionId: "" },
  ]) {
    assert.throws(() => groupPolicyFixtureConfig({ ...config, runtime }), {
      code: "GROUP_POLICY_CONFIG",
    });
  }
});
