import assert from "node:assert/strict";
import test from "node:test";
import {
  GROUP_MEMBERS_POLICY_FAMILY_ID,
  groupMembersPolicyPlan,
  groupMembersPolicyStep,
} from "../lib/group-members-policy-scenario.mjs";

test("fixed family disables only Group B group.members, checks an Owner-private refusal, then restores", () => {
  assert.equal(GROUP_MEMBERS_POLICY_FAMILY_ID, "qq-group-members-policy-isolation");
  assert.deepEqual(
    groupMembersPolicyPlan("40004").stages.map((row) => row.stage),
    ["disable", "members-check", "restore"],
  );
  const check = groupMembersPolicyStep("members-check", "40004");
  assert.equal(check.chat, "private");
  assert.deepEqual(check.leaseTools, [
    {
      name: "qq_group_members",
      operations: [
        {
          action: "group:members:read",
          resourceId: "group:40004",
          inputConstraint: { groupId: "40004", operation: "get_group_member_list" },
        },
      ],
    },
  ]);
  assert.equal(check.requiredEvidenceFailure.failureCode, "required_evidence_missing");
  assert.match(check.prompt, /40004/u);
  assert.match(check.expectContains[0], /未能从 QQ 获取/u);
  for (const stage of ["disable", "restore"]) {
    const step = groupMembersPolicyStep(stage, "40004");
    const operation = step.leaseTools[0].operations[0];
    assert.equal(operation.action, "group:manage");
    assert.deepEqual(operation.inputConstraint, {
      action: "set_capability",
      groupId: "40004",
      category: "group.members",
      enabled: stage === "restore",
    });
  }
  assert.match(groupMembersPolicyPlan("40004").coverage, /Owner-private/u);
  assert.match(groupMembersPolicyPlan("40004").coverage, /does not test visitor denial/u);
});
test("scenario rejects malformed group IDs and unknown stages", () => {
  for (const groupId of [undefined, "", "0", "040004", "40004;50005", "1".repeat(17)])
    assert.throws(() => groupMembersPolicyPlan(groupId), /群成员权限/u);
  assert.throws(() => groupMembersPolicyStep("read", "40004"), /群成员权限/u);
});
