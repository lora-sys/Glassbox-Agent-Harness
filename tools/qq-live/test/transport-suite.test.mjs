import test from "node:test";
import assert from "node:assert/strict";
import {
  TRANSPORT_SUITE_FAMILY_ID,
  transportSmokeSpecs,
  transportSuiteDefinition,
  transportSuiteHash,
  validateTransportCase,
} from "../lib/transport-suite.mjs";
import { baseConfig } from "./fixture.mjs";

test("fixed transport suite binds private and both groups to the configured identities", () => {
  const config = baseConfig();
  const definition = transportSuiteDefinition(config);
  assert.equal(definition.familyId, TRANSPORT_SUITE_FAMILY_ID);
  assert.deepEqual(definition.identities, {
    driverId: "10001",
    botId: "10002",
    groupA: "20001",
    groupB: "20002",
  });
  assert.deepEqual(
    definition.cases.map(({ id, chat, transportOnly, leaseTools }) => ({
      id,
      chat,
      transportOnly,
      leaseTools,
    })),
    [
      { id: "transport-private", chat: "private", transportOnly: true, leaseTools: [] },
      { id: "transport-group-A", chat: "A", transportOnly: true, leaseTools: [] },
      { id: "transport-group-B", chat: "B", transportOnly: true, leaseTools: [] },
    ],
  );
  assert.ok(definition.cases.every((spec) => spec.expectContains.join() === "{{nonce}}"));
  assert.ok(definition.cases.every((spec) => spec.prompt === definition.cases[0].prompt));
  assert.equal(transportSuiteHash(config), transportSuiteHash(config));
  for (const changed of [
    { ...config, driver: { ...config.driver, qq: "10009" } },
    { ...config, bot: { ...config.bot, qq: "10009" } },
    { ...config, groups: [{ ...config.groups[0], id: "20009" }, config.groups[1]] },
    { ...config, groups: [config.groups[0], { ...config.groups[1], id: "20009" }] },
  ])
    assert.notEqual(transportSuiteHash(config), transportSuiteHash(changed));
});

test("transport case validation rejects altered routes, assertions, and nonempty tools", () => {
  const config = baseConfig();
  const [spec] = transportSmokeSpecs(config);
  assert.equal(validateTransportCase(spec, config).id, spec.id);
  for (const mutate of [
    (candidate) => (candidate.chat = "B"),
    (candidate) => (candidate.prompt = "custom {{nonce}}"),
    (candidate) => (candidate.expectContains = ["anything"]),
    (candidate) => (candidate.leaseTools = [{ name: "dangerous" }]),
    (candidate) => (candidate.featureAssertions = []),
    (candidate) => (candidate.extra = true),
  ]) {
    const altered = structuredClone(spec);
    mutate(altered);
    assert.throws(() => validateTransportCase(altered, config), { code: "TRANSPORT_SUITE_CASE" });
  }
});

test("transport suite refuses missing, duplicate, or identical A and B groups", () => {
  const config = baseConfig();
  assert.throws(() => transportSuiteDefinition({ ...config, groups: [config.groups[0]] }), {
    code: "TRANSPORT_SUITE_CONFIG",
  });
  assert.throws(
    () =>
      transportSuiteDefinition({
        ...config,
        groups: [config.groups[0], { ...config.groups[1], id: config.groups[0].id }],
      }),
    { code: "TRANSPORT_SUITE_CONFIG" },
  );
});
