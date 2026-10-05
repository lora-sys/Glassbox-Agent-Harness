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
  group_history_search: "history:read",
  owner_history_search: "history:search",
};

const HISTORY_TOOLS = new Set(["group_history_search", "owner_history_search"]);
const TEST_GROUP_ALIASES = new Set(["A", "B"]);

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

function validGroupId(value) {
  return typeof value === "string" && /^[1-9]\d{0,15}$/u.test(value);
}

function configGroup(config, alias) {
  const matches = config?.groups?.filter((group) => group.alias === alias) ?? [];
  if (!TEST_GROUP_ALIASES.has(alias) || matches.length !== 1 || !validGroupId(matches[0].id))
    fail("FEATURE_GROUP_BINDING", "测试群别名必须是唯一配置的 A 或 B，并映射到数字群号。");
  return matches[0];
}

function expectedHistoryAssertions(toolName, groupId) {
  return [
    {
      kind: "trace",
      type: "tool_result",
      where: { name: toolName, isError: false },
      count: 1,
    },
    {
      kind: "trace",
      type: "history_retrieval",
      where: {
        query: "{{nonce}}",
        groups: [groupId],
        resources: [`group:${groupId}`],
        sourceKind: "channel_message",
        retrievalMode: "lexical",
      },
      count: 1,
    },
  ];
}

function validateGroupMembersCase(c, config) {
  const group = configGroup(config, "A");
  const tool = c.leaseTools[0];
  const operation = tool?.operations?.[0];
  const expectedOperation = {
    action: "group:members:read",
    resourceId: `group:${group.id}`,
    inputConstraint: { groupId: group.id, operation: "get_group_member_list" },
  };
  const templateOperation = {
    action: "group:members:read",
    resourceId: "group:{{group:A}}",
    inputConstraint: {
      groupId: "{{group:A}}",
      operation: "get_group_member_list",
    },
  };
  const expectedAssertions = [
    {
      kind: "trace",
      type: "tool_result",
      where: { name: "qq_group_members", isError: false },
      count: 1,
    },
    { kind: "aggregate_projection", tool: "qq_group_members", count: 1 },
  ];
  if (
    c.chat !== "private" ||
    c.leaseTools.length !== 1 ||
    tool?.name !== "qq_group_members" ||
    tool.operations.length !== 1 ||
    (canonical(operation) !== canonical(expectedOperation) &&
      canonical(operation) !== canonical(templateOperation)) ||
    canonical(c.featureAssertions) !== canonical(expectedAssertions)
  )
    fail(
      "FEATURE_GROUP_MEMBERS_SCOPE",
      "群成员数量用例必须在 Owner 私聊中限定到群 A 的名单读取及完整聚合 Trace。",
    );
}

function validateHistoryCase(c, tool, config) {
  if (c.leaseTools.length !== 1 || tool.operations.length !== 1)
    fail("FEATURE_HISTORY_SCOPE", "历史用例只能租用一个历史工具和一个精确读取操作。");
  const group = configGroup(config, "A");
  const templateGroupId = "{{group:A}}";
  const groupId = group.id;
  const allowedGroupIds = new Set([templateGroupId, groupId]);
  let expectedOperation;

  if (tool.name === "group_history_search") {
    if (c.chat !== "A") fail("FEATURE_HISTORY_SCOPE", "当前群历史测试必须路由到专用测试群 A。");
    if (!["group:{{group:A}}", `group:${groupId}`].includes(tool.operations[0].resourceId))
      fail("FEATURE_HISTORY_SCOPE", "当前群历史租约必须绑定聊天别名 A 的群 Resource。");
    expectedOperation = {
      action: "history:read",
      resourceId: tool.operations[0].resourceId,
      inputConstraint: { query: "{{nonce}}", limit: 1 },
    };
  } else {
    if (c.chat !== "private")
      fail("FEATURE_HISTORY_SCOPE", "跨群历史测试必须在 Owner 私聊中执行。");
    if (tool.operations[0].resourceId !== "owner-history")
      fail("FEATURE_HISTORY_SCOPE", "Owner 历史租约必须绑定 owner-history Resource。");
    const actualGroupIds = tool.operations[0].inputConstraint?.groupIds;
    if (
      !Array.isArray(actualGroupIds) ||
      actualGroupIds.length !== 1 ||
      !allowedGroupIds.has(actualGroupIds[0])
    )
      fail("FEATURE_HISTORY_SCOPE", "Owner 历史测试只能搜索测试群 A。");
    expectedOperation = {
      action: "history:search",
      resourceId: "owner-history",
      inputConstraint: { query: "{{nonce}}", limit: 1, groupIds: actualGroupIds },
    };
  }
  if (canonical(tool.operations[0]) !== canonical(expectedOperation))
    fail("FEATURE_HISTORY_SCOPE", "历史租约必须把查询限制为当前 nonce、limit 1 和指定测试群。");

  const rawAssertions = expectedHistoryAssertions(tool.name, templateGroupId);
  const resolvedAssertions = expectedHistoryAssertions(tool.name, groupId);
  const withCoverage = (assertions, id) => [
    ...assertions,
    { kind: "history_coverage", query: "{{nonce}}", groupId: id, count: 1 },
  ];
  const withResult = (assertions, id) => [
    ...withCoverage(assertions, id),
    {
      kind: "history_result",
      tool: tool.name,
      query: "{{nonce}}",
      groupId: id,
      result: tool.name === "group_history_search" ? "hit" : "no_match",
      count: 1,
    },
  ];
  if (
    canonical(c.featureAssertions) !== canonical(rawAssertions) &&
    canonical(c.featureAssertions) !== canonical(resolvedAssertions) &&
    canonical(c.featureAssertions) !== canonical(withCoverage(rawAssertions, templateGroupId)) &&
    canonical(c.featureAssertions) !== canonical(withCoverage(resolvedAssertions, groupId)) &&
    canonical(c.featureAssertions) !== canonical(withResult(rawAssertions, templateGroupId)) &&
    canonical(c.featureAssertions) !== canonical(withResult(resolvedAssertions, groupId))
  )
    fail(
      "FEATURE_HISTORY_TRACE",
      "历史用例必须核对 nonce 查询、数据源类型、检索方式及唯一测试群的 retrieval Trace。",
    );
}

/** Resolve only the explicit group placeholders used by approved history suite templates. */
export function resolveReadFeatureCase(testCase, resolveGroup) {
  if (typeof resolveGroup !== "function")
    fail("FEATURE_GROUP_BINDING", "历史用例需要受信任的群别名解析器。");
  const resolveValue = (value) => {
    if (typeof value === "string") {
      const result = value.replace(/\{\{([^{}]+)\}\}/gu, (placeholder, name) => {
        if (name === "nonce") return placeholder;
        const match = /^group:([A-Z])$/u.exec(name);
        if (!match || !TEST_GROUP_ALIASES.has(match[1]))
          fail(
            "FEATURE_TEMPLATE",
            "功能用例只支持 {{nonce}} 和预先指定的 {{group:A}} / {{group:B}} 模板。",
          );
        const groupId = resolveGroup(match[1]);
        if (!validGroupId(groupId))
          fail("FEATURE_GROUP_BINDING", "测试群别名必须解析为有效数字群号。");
        return groupId;
      });
      const unresolved = result.replaceAll("{{nonce}}", "");
      if (unresolved.includes("{{") || unresolved.includes("}}"))
        fail("FEATURE_TEMPLATE", "功能用例包含未支持的模板占位符。");
      return result;
    }
    if (Array.isArray(value)) return value.map(resolveValue);
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value).map(([key, child]) => [key, resolveValue(child)]),
      );
    return value;
  };
  return resolveValue(testCase);
}

/** Only implemented read cases are admitted here. Mutations need independent cleanup support. */
export function validateReadFeatureSpecs(raw, config) {
  if (
    raw?.schemaVersion !== 2 ||
    !Array.isArray(raw.cases) ||
    !raw.cases.length ||
    raw.cases.length > 16
  )
    fail("FEATURE_SUITE", "功能套件需要 schemaVersion=2 和 1 至 16 个用例。");
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
      if (HISTORY_TOOLS.has(tool.name)) validateHistoryCase(c, tool, config);
    }
    validateFeatureAssertions(c.featureAssertions);
    if (c.leaseTools.some((tool) => tool.name === "qq_group_members"))
      validateGroupMembersCase(c, config);
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

/** Validate a raw schema-2 suite and resolve its approved A/B test-group aliases. */
export function resolveReadFeatureSpecs(raw, config) {
  const cases = validateReadFeatureSpecs(raw, config);
  return cases.map((testCase) =>
    resolveReadFeatureCase(testCase, (alias) => configGroup(config, alias).id),
  );
}
