import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { observeFeature } from "../lib/feature-observer.mjs";
import { toolManifestDigest } from "../lib/core.mjs";
import {
  observeGroupMemberRole,
  verifyGroupMemberRoleEvidence,
} from "../lib/group-member-role-evidence.mjs";

const runId = "run-fixed-role-1";
const groupId = "20002";
const userId = "10001";
const role = "qq_group_admin";
const hash = (text) => createHash("sha256").update(text, "utf8").digest("hex");
const traceAssertion = {
  kind: "trace",
  type: "tool_result",
  where: { name: "qq_group_members", isError: false },
  count: 1,
};
const roleAssertion = {
  kind: "group_member_role",
  tool: "qq_group_members",
  groupId,
  userId,
  count: 1,
};

function fixture() {
  const callId = "tool-call-fixed-role";
  const input = {
    groupId,
    operation: "get_group_member_info",
  };
  const details = { role };
  const outputHead = JSON.stringify({
    content: [{ type: "text", text: JSON.stringify(details) }],
    details,
  });
  const providerInput = { group_id: Number(groupId), user_id: Number(userId) };
  const canonicalInput = JSON.stringify(providerInput);
  const events = [
    {
      type: "session_start",
      runId,
      principalId: "owner-principal",
      data: {
        conversationId: "conversation-fixed-role",
        acceptanceLease: { leaseId: "lease-fixed-role" },
      },
    },
    {
      type: "tool_call",
      runId,
      principalId: "owner-principal",
      toolCallId: callId,
      data: { toolCallId: callId, name: "qq_group_members", input },
    },
    {
      type: "qq_tool_execution_input_verified",
      runId,
      conversationId: "conversation-fixed-role",
      principalId: "owner-principal",
      toolCallId: callId,
      toolName: "qq_group_members",
      leaseId: "lease-fixed-role",
      action: "get_group_member_info",
      resourceId: `group:${groupId}`,
      inputSha256: hash(canonicalInput),
      inputBytes: Buffer.byteLength(canonicalInput, "utf8"),
    },
    {
      type: "tool_result",
      runId,
      principalId: "owner-principal",
      toolCallId: callId,
      data: {
        toolCallId: callId,
        name: "qq_group_members",
        isError: false,
        outputHead,
        outputTruncated: false,
        outputBytes: Buffer.byteLength(outputHead, "utf8"),
        outputSha256: hash(outputHead),
      },
    },
  ];
  const assertions = [traceAssertion, roleAssertion];
  const feature = observeFeature(assertions, { db: {}, events, runId });
  const token = "a".repeat(32);
  const c = {
    id: "qq-bot-group-role-read",
    token,
    route: "private",
    prompt: `GLASSBOX_ACCEPTANCE_V1 ${token}\n你现在在测试群 ${groupId} 里是管理员吗？请实际查一下。请按一行回复 QQBOTGROUPROLE ${token} role=角色，方便我核对。`,
    expected: [`QQBOTGROUPROLE ${token}`],
    leasedToolNames: ["qq_group_members"],
    acceptanceLease: {
      leaseId: "lease-fixed-role",
      toolsSha256: toolManifestDigest([
        {
          name: "qq_group_members",
          operations: [
            {
              action: "group:members:read",
              resourceId: `group:${groupId}`,
              inputConstraint: {
                groupId,
                operation: "get_group_member_info",
                params: { user_id: userId },
              },
            },
          ],
        },
      ]),
    },
    featureAssertions: assertions,
  };
  const config = {
    bot: { qq: userId },
    groups: [
      { alias: "A", id: "20001" },
      { alias: "B", id: groupId },
    ],
  };
  const clients = {
    bot: { readBotGroupMemberRole: async () => ({ groupId, userId, role }) },
  };
  return { c, config, clients, events, feature, assertions };
}
const verify = (f, overrides = {}) =>
  verifyGroupMemberRoleEvidence(
    overrides.c ?? f.c,
    overrides.feature ?? f.feature,
    overrides.config ?? f.config,
    overrides.clients ?? f.clients,
    overrides.events ?? f.events,
    runId,
  );

test("role observer binds one same-Run Bot-subject call to a safe normalized result", () => {
  const f = fixture();
  assert.deepEqual(observeGroupMemberRole(roleAssertion, { events: f.events, runId }), {
    kind: "group_member_role",
    tool: "qq_group_members",
    toolCallId: "tool-call-fixed-role",
    groupId,
    userId,
    role,
    inputSha256: hash('{"group_id":20002,"user_id":10001}'),
    inputBytes: Buffer.byteLength('{"group_id":20002,"user_id":10001}', "utf8"),
  });
});

test("role verifier compares Trace with independent Bot-side read and returns only normalized role", async () => {
  const f = fixture();
  assert.deepEqual(await verify(f), {
    status: "PASS",
    groupAlias: "B",
    role,
    toolCallId: "tool-call-fixed-role",
    inputWitness: {
      status: "QQ_TOOL_INPUT_VERIFIED",
      inputSha256: hash('{"group_id":20002,"user_id":10001}'),
      inputBytes: Buffer.byteLength('{"group_id":20002,"user_id":10001}', "utf8"),
    },
    independentSource: "bot_get_group_member_info",
  });
});

test("role evidence rejects another subject, group, malformed output, duplicates, order and cross-Run events", async () => {
  const mutations = [
    (events) => {
      events[1].data.input.groupId = "20001";
    },
    (events) => {
      events[2].inputSha256 = "0".repeat(64);
    },
    (events) => {
      events[2].leaseId = "other-lease";
    },
    (events) => {
      events[3].data.outputHead = events[3].data.outputHead.replace(role, "qq_group_owner");
    },
    (events) => {
      events.reverse();
    },
    (events) => {
      events[1].runId = "other-run";
    },
    (events) => {
      events.push(structuredClone(events[2]));
    },
    (events) => {
      events.splice(2, 1);
    },
  ];
  for (const mutate of mutations) {
    const f = fixture();
    mutate(f.events);
    await assert.rejects(verify(f), (error) =>
      ["GROUP_MEMBER_ROLE_EVIDENCE", "GROUP_MEMBER_ROLE_MISMATCH"].includes(error.code),
    );
  }
  const f = fixture();
  f.clients.bot.readBotGroupMemberRole = async () => ({
    groupId,
    userId: "10002",
    role,
  });
  await assert.rejects(verify(f), { code: "GROUP_MEMBER_ROLE_MISMATCH" });
});

test("role verifier requires the fixed assertion and keeps other member reads separate", async () => {
  const f = fixture();
  const noRoleAssertion = structuredClone(f.c);
  noRoleAssertion.featureAssertions = [traceAssertion];
  await assert.rejects(
    verifyGroupMemberRoleEvidence(noRoleAssertion, f.feature, f.config, f.clients, f.events, runId),
    { code: "GROUP_MEMBER_ROLE_SCOPE" },
  );
  const duplicate = structuredClone(f.c);
  duplicate.featureAssertions.push(structuredClone(roleAssertion));
  await assert.rejects(
    verifyGroupMemberRoleEvidence(duplicate, f.feature, f.config, f.clients, f.events, runId),
    { code: "GROUP_MEMBER_ROLE_SCOPE" },
  );
  const wrong = structuredClone(f.c);
  wrong.featureAssertions[1].userId = "10002";
  await assert.rejects(
    verifyGroupMemberRoleEvidence(wrong, f.feature, f.config, f.clients, f.events, runId),
    { code: "GROUP_MEMBER_ROLE_SCOPE" },
  );
  const replacedId = structuredClone(f.c);
  replacedId.id = "different-case-id";
  replacedId.featureAssertions = [traceAssertion];
  await assert.rejects(
    verifyGroupMemberRoleEvidence(replacedId, f.feature, f.config, f.clients, f.events, runId),
    { code: "GROUP_MEMBER_ROLE_SCOPE" },
  );

  const countEvents = structuredClone(f.events);
  countEvents[1].data.input.operation = "get_group_member_list";
  const countCase = {
    id: "qq-group-member-count-read",
    route: "private",
    featureAssertions: [traceAssertion],
  };
  assert.equal(
    await verifyGroupMemberRoleEvidence(
      countCase,
      f.feature,
      f.config,
      f.clients,
      countEvents,
      runId,
    ),
    undefined,
  );
});
