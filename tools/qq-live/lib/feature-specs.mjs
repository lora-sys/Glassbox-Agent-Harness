import { fail } from "./core.mjs";
import { validateFeatureAssertions } from "./feature-observer.mjs";

const READ_ACTIONS = {
  ops_status: "ops:status",
  task_list: "task:list",
  task_get: "task:read",
  task_events: "task:read",
  task_steps: "task:read",
  worker_status: "worker:status",
  qq_account_status: "account:status:read",
  qq_groups: "group:read",
  qq_group_members: "group:members:read",
  qq_capability_search: "qq:capability:read",
};

/** Only implemented read cases are admitted here. Mutations need independent cleanup support. */
export function validateReadFeatureSpecs(raw, config) {
  if (
    raw?.schemaVersion !== 2 ||
    !Array.isArray(raw.cases) ||
    !raw.cases.length ||
    raw.cases.length > 10
  )
    fail("FEATURE_SUITE", "功能套件需要 schemaVersion=2 和 1 至 10 个用例。");
  const ids = new Set();
  for (const c of raw.cases) {
    if (
      !c ||
      Object.keys(c).some(
        (k) =>
          ![
            "id",
            "chat",
            "prompt",
            "expectContains",
            "leaseTools",
            "featureAssertions",
            "sideEffect",
          ].includes(k),
      ) ||
      !/^[a-zA-Z0-9_-]{1,50}$/.test(c.id ?? "") ||
      ids.has(c.id)
    )
      fail("FEATURE_CASE", "功能用例字段或 ID 无效。");
    ids.add(c.id);
    if (c.chat !== "private" && !config.groups.some((g) => g.alias === c.chat))
      fail("FEATURE_ROUTE", "功能用例指定了未配置会话。");
    if (
      typeof c.prompt !== "string" ||
      c.prompt.length > 4000 ||
      !c.prompt.includes("{{nonce}}") ||
      c.prompt.includes("GLASSBOX_ACCEPTANCE_V1") ||
      !Array.isArray(c.expectContains) ||
      !c.expectContains.length ||
      c.expectContains.length > 8 ||
      c.expectContains.some((v) => typeof v !== "string" || !v || v.length > 1000) ||
      !c.expectContains.some((v) => v.includes("{{nonce}}"))
    )
      fail("FEATURE_PROMPT", "功能用例需要有界消息和包含测试编号的回复断言。");
    if (
      c.sideEffect !== "none" ||
      !Array.isArray(c.leaseTools) ||
      !c.leaseTools.length ||
      c.leaseTools.length > 8
    )
      fail(
        "FEATURE_CLEANUP_UNSUPPORTED",
        "当前功能执行器只支持已接入的读取工具。修改操作须先实现独立清理。",
      );
    for (const tool of c.leaseTools) {
      if (
        !tool ||
        !Object.hasOwn(READ_ACTIONS, tool.name) ||
        !Array.isArray(tool.operations) ||
        !tool.operations.length ||
        tool.operations.length > 8 ||
        tool.operations.some(
          (op) =>
            !op ||
            op.action !== READ_ACTIONS[tool.name] ||
            typeof op.resourceId !== "string" ||
            !op.resourceId ||
            !op.inputConstraint ||
            typeof op.inputConstraint !== "object" ||
            Array.isArray(op.inputConstraint),
        )
      )
        fail("FEATURE_CAPABILITY", "功能用例含未接入的读取工具或操作。");
    }
    validateFeatureAssertions(c.featureAssertions);
    if (
      !c.featureAssertions.some(
        (a) =>
          a.kind === "trace" &&
          a.type === "tool_result" &&
          a.where.isError === false &&
          c.leaseTools.some((t) => t.name === a.where.name),
      )
    )
      fail("FEATURE_EXECUTION_ASSERTION", "功能用例必须证明指定工具实际执行成功。");
  }
  return raw.cases;
}
