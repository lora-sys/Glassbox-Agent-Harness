import { digest, fail } from "./core.mjs";

export const TRANSPORT_SUITE_FAMILY_ID = "qq-transport-smoke";

const CASES = [
  { id: "transport-private", chat: "private" },
  { id: "transport-group-A", chat: "A" },
  { id: "transport-group-B", chat: "B" },
];

const PROMPT = "QQ transport-only check. Reply with this marker only. Do not use tools: {{nonce}}";

function groupsByAlias(config) {
  if (!Array.isArray(config?.groups)) fail("TRANSPORT_SUITE_CONFIG", "需要配置测试群 A 和 B。");
  const a = config.groups.filter((group) => group?.alias === "A");
  const b = config.groups.filter((group) => group?.alias === "B");
  if (
    a.length !== 1 ||
    b.length !== 1 ||
    typeof a[0]?.id !== "string" ||
    typeof b[0]?.id !== "string" ||
    !/^[1-9]\d{4,15}$/.test(a[0].id) ||
    !/^[1-9]\d{4,15}$/.test(b[0].id) ||
    a[0].id === b[0].id
  )
    fail("TRANSPORT_SUITE_CONFIG", "固定传输套件需要唯一且不同的群 A、群 B。");
  return { A: a[0].id, B: b[0].id };
}

export function transportSmokeSpecs(config) {
  groupsByAlias(config);
  return CASES.map((testCase) => ({
    ...testCase,
    prompt: PROMPT,
    expectContains: ["{{nonce}}"],
    transportOnly: true,
    leaseTools: [],
  }));
}

export function transportSuiteDefinition(config) {
  const groups = groupsByAlias(config);
  if (
    typeof config?.driver?.qq !== "string" ||
    !/^[1-9]\d{4,15}$/.test(config.driver.qq) ||
    typeof config?.bot?.qq !== "string" ||
    !/^[1-9]\d{4,15}$/.test(config.bot.qq)
  )
    fail("TRANSPORT_SUITE_CONFIG", "固定传输套件需要有效的发起账号和 Bot 身份。");
  return {
    schemaVersion: 1,
    familyId: TRANSPORT_SUITE_FAMILY_ID,
    identities: {
      driverId: config.driver.qq,
      botId: config.bot.qq,
      groupA: groups.A,
      groupB: groups.B,
    },
    cases: transportSmokeSpecs(config),
  };
}

export function transportSuiteHash(config) {
  return digest(JSON.stringify(transportSuiteDefinition(config)));
}

export function validateTransportCase(spec, config) {
  if (!spec || typeof spec !== "object" || Array.isArray(spec))
    fail("TRANSPORT_SUITE_CASE", "传输用例必须匹配固定的零工具套件定义。");
  const expected = transportSmokeSpecs(config).find((candidate) => candidate.id === spec?.id);
  if (
    !expected ||
    spec.chat !== expected.chat ||
    spec.prompt !== expected.prompt ||
    spec.transportOnly !== true ||
    !Array.isArray(spec.leaseTools) ||
    spec.leaseTools.length !== 0 ||
    JSON.stringify(spec.expectContains) !== JSON.stringify(expected.expectContains) ||
    Object.keys(spec).sort().join(",") !== Object.keys(expected).sort().join(",")
  )
    fail("TRANSPORT_SUITE_CASE", "传输用例必须匹配固定的零工具套件定义。");
  return expected;
}
