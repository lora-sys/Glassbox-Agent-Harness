import { fail } from "./core.mjs";

export const GROUP_POLICY_FAMILY_ID = "qq-group-policy-isolation";
const GROUP_ID = /^[1-9]\d{0,15}$/u;

/** Fixed natural Owner requests. The restore request contains no disabling verbs. */
export function groupPolicyStep(stage, groupId) {
  if (!GROUP_ID.test(groupId ?? "") || !["disable", "history-check", "restore"].includes(stage))
    fail("GROUP_POLICY_SCENARIO", "群策略测试需要固定步骤和测试群号。");
  if (stage === "history-check") {
    return {
      id: "group-policy-history-check",
      chat: "private",
      prompt: `请在群 ${groupId} 的历史检索授权已关闭时，使用 Owner 私聊检索本轮编号 {{nonce}}，只报告本次检索结果，不查询其他群。请在回复中包含本轮测试编号 {{nonce}}。`,
      expectContains: ["{{nonce}}"],
      sideEffect: "none",
      leaseTools: [
        {
          name: "owner_history_search",
          operations: [
            {
              action: "history:search",
              resourceId: "owner-history",
              inputConstraint: {
                query: "gbxhistory1-{{nonce}}",
                groupIds: [groupId],
                limit: 1,
              },
            },
          ],
        },
      ],
      featureAssertions: [
        {
          kind: "trace",
          type: "tool_result",
          where: { name: "owner_history_search", isError: false },
          count: 1,
        },
      ],
      historyRevocationResult: {
        kind: "history_revocation_result",
        groupId,
        query: "{{nonce}}",
      },
    };
  }
  const enabled = stage === "restore";
  return {
    id: `group-policy-${stage}`,
    chat: "private",
    prompt: `${enabled ? "请恢复启用" : "请暂时关闭"}群 ${groupId} 的历史检索。只修改这个群的历史设置。请在回复中包含本轮测试编号 {{nonce}}。`,
    expectContains: ["{{nonce}}"],
    sideEffect: "acceptance_fixture",
    leaseTools: [
      {
        name: "owner_group_admin",
        operations: [
          {
            action: "group:manage",
            resourceId: "owner-control",
            inputConstraint: { action: "set_history", groupId, enabled },
          },
        ],
      },
    ],
    featureAssertions: [
      {
        kind: "trace",
        type: "tool_result",
        where: { name: "owner_group_admin", isError: false },
        count: 1,
      },
    ],
  };
}

/** Display only. No lease, QQ message, policy mutation or recovery is executed. */
export function groupPolicyPlan(groupId) {
  return {
    familyId: GROUP_POLICY_FAMILY_ID,
    workflow: "owner-private-history-disable-check-restore",
    groupId,
    stages: ["disable", "history-check", "restore"].map((stage) => ({
      stage,
      spec: groupPolicyStep(stage, groupId),
    })),
    prerequisites: [
      "Both groups and Owner management authority are independently captured.",
      "B history is enabled with exactly one restorable Owner-private allow grant.",
      "The history-check uses a fresh 32-hex nonce, the fixed query prefix, Group B only, and limit 1.",
      "Durable account guard and mutation checkpoint precede every send.",
    ],
    recovery:
      "Stop on uncertain delivery or state drift. Independently verify the disabled state before any explicit restore request.",
    coverage:
      "The history check runs only after verified disable and before restore. Zero-source coverage is unknown and does not prove absence from earlier Conversation context. State-transition verification alone does not establish real QQ delivery or complete group policy coverage.",
  };
}
