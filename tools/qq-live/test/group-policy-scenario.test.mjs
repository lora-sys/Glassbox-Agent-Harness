import assert from "node:assert/strict";
import test from "node:test";
import { groupPolicyPlan, groupPolicyStep } from "../lib/group-policy-scenario.mjs";

test("fixed natural requests bind only B history, with a read-only disabled-state check", () => {
  const check = groupPolicyStep("history-check", "40004");
  assert.equal(check.chat, "private");
  assert.equal(check.sideEffect, "none");
  assert.deepEqual(check.leaseTools, [
    {
      name: "owner_history_search",
      operations: [
        {
          action: "history:search",
          resourceId: "owner-history",
          inputConstraint: {
            query: "gbxhistory1-{{nonce}}",
            groupIds: ["40004"],
            limit: 1,
          },
        },
      ],
    },
  ]);
  assert.deepEqual(check.historyRevocationResult, {
    kind: "history_revocation_result",
    groupId: "40004",
    query: "{{nonce}}",
  });
  assert.deepEqual(check.featureAssertions, [
    {
      kind: "trace",
      type: "tool_result",
      where: { name: "owner_history_search", isError: false },
      count: 1,
    },
  ]);
  for (const stage of ["disable", "restore"]) {
    const spec = groupPolicyStep(stage, "40004");
    assert.equal(spec.chat, "private");
    assert.deepEqual(spec.leaseTools, [
      {
        name: "owner_group_admin",
        operations: [
          {
            action: "group:manage",
            resourceId: "owner-control",
            inputConstraint: {
              action: "set_history",
              groupId: "40004",
              enabled: stage === "restore",
            },
          },
        ],
      },
    ]);
    assert.deepEqual(spec.prompt.match(/\d+/gu), ["40004"]);
    assert.match(spec.prompt, /历史/u);
    assert.equal(/关闭|停用|禁用|取消|移除/u.test(spec.prompt), stage === "disable");
    if (stage === "restore") assert.match(spec.prompt, /启用|开启|打开|允许|恢复|加入/u);
    assert.equal(spec.sideEffect, "acceptance_fixture");
  }
});

test("plan preserves stages and exposes recovery prerequisites without claiming acceptance", () => {
  const plan = groupPolicyPlan("40004");
  assert.deepEqual(
    plan.stages.map((row) => row.stage),
    ["disable", "history-check", "restore"],
  );
  assert.ok(plan.prerequisites.some((row) => row.includes("Durable account guard")));
  assert.equal(Object.hasOwn(plan, "status"), false);
  for (const group of [undefined, "", "0", "0123", "123;456", "1".repeat(17)])
    assert.throws(() => groupPolicyPlan(group), /群策略测试/u);
  assert.throws(() => groupPolicyStep("get", "40004"), /群策略测试/u);
});
