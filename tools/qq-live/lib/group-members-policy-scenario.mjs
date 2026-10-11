import { fail } from "./core.mjs";
export const GROUP_MEMBERS_POLICY_FAMILY_ID = "qq-group-members-policy-isolation";
const GROUP_ID = /^[1-9]\d{0,15}$/u;
const REFUSAL = "未能从 QQ 获取该信息，因此无法确认。";
export function groupMembersPolicyStep(stage, groupId) {
  if (!GROUP_ID.test(groupId ?? "") || !["disable", "members-check", "restore"].includes(stage))
    fail("GROUP_MEMBERS_POLICY_SCENARIO", "群成员权限测试需要固定步骤和测试群号。");
  const enabled = stage === "restore";
  if (stage === "members-check")
    return {
      id: "group-members-policy-check",
      chat: "private",
      prompt: `请告诉我群 ${groupId} 的成员人数，只报告人数，不提供成员名单。本轮测试编号 {{nonce}}。`,
      expectContains: [REFUSAL],
      sideEffect: "none",
      leaseTools: [
        {
          name: "qq_group_members",
          operations: [
            {
              action: "group:members:read",
              resourceId: `group:${groupId}`,
              inputConstraint: { groupId, operation: "get_group_member_list" },
            },
          ],
        },
      ],
      requiredEvidenceFailure: {
        kind: "group_members_policy_result",
        groupId,
        failureCode: "required_evidence_missing",
        reply: REFUSAL,
      },
    };
  return {
    id: `group-members-policy-${stage}`,
    chat: "private",
    prompt: `${enabled ? "请恢复启用" : "请暂时关闭"}群 ${groupId} 的群成员读取权限，只修改这个群的 group.members 设置。请回复本轮测试编号 {{nonce}}。`,
    expectContains: ["{{nonce}}"],
    sideEffect: "acceptance_fixture",
    leaseTools: [
      {
        name: "owner_group_admin",
        operations: [
          {
            action: "group:manage",
            resourceId: "owner-control",
            inputConstraint: {
              action: "set_capability",
              groupId,
              category: "group.members",
              enabled,
            },
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
export function groupMembersPolicyPlan(groupId) {
  return {
    familyId: GROUP_MEMBERS_POLICY_FAMILY_ID,
    workflow: "owner-private-group-members-disable-check-restore",
    groupId,
    stages: ["disable", "members-check", "restore"].map((stage) => ({
      stage,
      spec: groupMembersPolicyStep(stage, groupId),
    })),
    prerequisites: [
      "Groups A and B and Owner management authority are independently captured.",
      "Group B group.members is enabled with exactly one restorable Owner-private read grant.",
      "The membership check runs only after verified disable and uses the fixed group.members read manifest.",
      "A durable account guard and mutation checkpoint precede each send.",
    ],
    recovery:
      "Stop on uncertain delivery or state drift. Restore only after independently confirming the exact disabled state.",
    coverage:
      "The check covers Owner-private exclusion for Group B. It does not test visitor denial or disclose a member list. A fail-closed response does not establish any broader privacy claim.",
  };
}
