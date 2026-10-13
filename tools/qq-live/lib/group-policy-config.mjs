import { fail } from "./core.mjs";

const GROUP_ID = /^[1-9]\d{4,15}$/u;
const FIXTURE_KEYS = ["enabled", "groupId", "retainAuditConfirmed"];

/** Return the explicitly approved fixed group B target for live group-policy runs. */
export function groupPolicyFixtureConfig(config) {
  const fixture = config?.groupPolicyFixtures;
  if (fixture === undefined || fixture === null)
    fail("GROUP_POLICY_FIXTURE_DISABLED", "请明确启用群策略测试并确认保留审计记录。");

  if (
    typeof fixture !== "object" ||
    Array.isArray(fixture) ||
    Object.keys(fixture).sort().join(",") !== FIXTURE_KEYS.join(",") ||
    typeof fixture.enabled !== "boolean" ||
    typeof fixture.retainAuditConfirmed !== "boolean" ||
    typeof fixture.groupId !== "string"
  )
    fail("GROUP_POLICY_CONFIG", "群策略测试必须指定有效且固定的群 B 目标。");

  if (fixture.enabled !== true || fixture.retainAuditConfirmed !== true)
    fail("GROUP_POLICY_FIXTURE_DISABLED", "请明确启用群策略测试并确认保留审计记录。");

  if (!GROUP_ID.test(fixture.groupId))
    fail("GROUP_POLICY_CONFIG", "群策略测试必须指定有效且固定的群 B 目标。");

  const groups = config.groups;
  const groupA = Array.isArray(groups) ? groups.filter((group) => group?.alias === "A") : [];
  const groupB = Array.isArray(groups) ? groups.filter((group) => group?.alias === "B") : [];
  if (
    !Array.isArray(groups) ||
    groups.length !== 2 ||
    groupA.length !== 1 ||
    groupB.length !== 1 ||
    !GROUP_ID.test(groupA[0]?.id ?? "") ||
    !GROUP_ID.test(groupB[0]?.id ?? "") ||
    groupA[0].id === groupB[0].id ||
    groups.some((group) => !group || !GROUP_ID.test(group.id ?? "")) ||
    new Set(groups.map((group) => group.id)).size !== groups.length ||
    fixture.groupId !== groupB[0].id
  )
    fail("GROUP_POLICY_CONFIG", "群策略测试只能使用配置中唯一且不同于群 A 的群 B。");

  const runtime = config.runtime;
  if (
    !runtime ||
    typeof runtime !== "object" ||
    typeof runtime.checkout !== "string" ||
    !runtime.checkout ||
    typeof runtime.dataDirectory !== "string" ||
    !runtime.dataDirectory ||
    typeof runtime.expectedCommit !== "string" ||
    !/^[a-f0-9]{40}$/u.test(runtime.expectedCommit) ||
    typeof runtime.connectionId !== "string" ||
    !runtime.connectionId
  )
    fail("GROUP_POLICY_CONFIG", "群策略实机执行需要配置完整的待测 Runtime。");

  return structuredClone(fixture);
}
