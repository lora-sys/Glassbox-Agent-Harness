import { digest, fail, id, toolManifestDigest } from "./core.mjs";

const ROLE_CODES = new Set(["qq_group_owner", "qq_group_admin", "qq_group_member"]);
const GROUP_ID = /^(?:[1-9]\d{4,15}|\{\{group:B\}\})$/u;
const SUBJECT_ID = /^(?:[1-9]\d{0,15}|\{\{bot\}\})$/u;
const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

function invalid(code = "GROUP_MEMBER_ROLE_EVIDENCE", status = "INCONCLUSIVE") {
  fail(code, "Bot 群角色 Trace 与独立读取证据不一致。", status);
}

export function validateGroupMemberRoleAssertion(assertion) {
  if (
    !isRecord(assertion) ||
    Object.keys(assertion).sort().join(",") !== "count,groupId,kind,tool,userId" ||
    assertion.kind !== "group_member_role" ||
    assertion.tool !== "qq_group_members" ||
    assertion.count !== 1 ||
    typeof assertion.groupId !== "string" ||
    !GROUP_ID.test(assertion.groupId) ||
    typeof assertion.userId !== "string" ||
    !SUBJECT_ID.test(assertion.userId)
  )
    invalid("GROUP_MEMBER_ROLE_ASSERTION", "BLOCKED");
  return assertion;
}

function validId(value) {
  const normalized = id(value);
  return normalized && /^[1-9]\d{0,15}$/u.test(normalized) ? normalized : "";
}

export function projectGroupMemberRole(result, expectedGroupId, expectedUserId) {
  const groupId = isRecord(result) ? validId(result.group_id) : "";
  const userId = isRecord(result) ? validId(result.user_id) : "";
  const roles = {
    owner: "qq_group_owner",
    admin: "qq_group_admin",
    member: "qq_group_member",
  };
  const normalizedRole = roles[result.role];
  if (
    !groupId ||
    groupId !== expectedGroupId ||
    !userId ||
    userId !== expectedUserId ||
    !ROLE_CODES.has(normalizedRole)
  )
    invalid("GROUP_MEMBER_ROLE_PROVIDER", "INCONCLUSIVE");
  return { groupId, userId, role: normalizedRole };
}

function parseCanonicalJson(value) {
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    invalid();
  }
  if (JSON.stringify(parsed) !== value) invalid();
  return parsed;
}

function roleFromOutput(result) {
  const data = result.data;
  const head = data.outputHead;
  if (
    typeof head !== "string" ||
    data.outputTruncated !== false ||
    !Number.isSafeInteger(data.outputBytes) ||
    data.outputBytes !== Buffer.byteLength(head, "utf8") ||
    data.outputBytes > 512 ||
    typeof data.outputSha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(data.outputSha256) ||
    digest(Buffer.from(head, "utf8")) !== data.outputSha256
  )
    invalid();
  const wrapped = parseCanonicalJson(head);
  if (
    !isRecord(wrapped) ||
    Object.keys(wrapped).sort().join(",") !== "content,details" ||
    !Array.isArray(wrapped.content) ||
    wrapped.content.length !== 1 ||
    !isRecord(wrapped.content[0]) ||
    Object.keys(wrapped.content[0]).sort().join(",") !== "text,type" ||
    wrapped.content[0].type !== "text" ||
    !isRecord(wrapped.details) ||
    Object.keys(wrapped.details).join(",") !== "role" ||
    wrapped.content[0].text !== JSON.stringify(wrapped.details) ||
    !ROLE_CODES.has(wrapped.details.role)
  )
    invalid();
  return wrapped.details.role;
}

function expectedInputWitness(groupId, userId) {
  const providerInput = { group_id: Number(groupId), user_id: Number(userId) };
  const canonical = JSON.stringify(providerInput);
  return {
    inputSha256: digest(Buffer.from(canonical, "utf8")),
    inputBytes: Buffer.byteLength(canonical, "utf8"),
  };
}

export function observeGroupMemberRole(assertion, { events, runId }) {
  validateGroupMemberRoleAssertion(assertion);
  if (!Array.isArray(events) || typeof runId !== "string" || !runId) invalid();
  const calls = events.filter(
    (event) =>
      event?.runId === runId &&
      event.type === "tool_call" &&
      event.data?.name === "qq_group_members",
  );
  const results = events.filter(
    (event) =>
      event?.runId === runId &&
      event.type === "tool_result" &&
      event.data?.name === "qq_group_members",
  );
  if (calls.length !== 1 || results.length !== 1) invalid();
  const [call] = calls;
  const [result] = results;
  const callId = call.toolCallId;
  const input = call.data?.input;
  const sessions = events.filter(
    (event) => event?.runId === runId && event.type === "session_start",
  );
  const witnesses = events.filter(
    (event) => event?.runId === runId && event.type === "qq_tool_execution_input_verified",
  );
  const session = sessions.length === 1 ? sessions[0] : null;
  const witness = witnesses.length === 1 ? witnesses[0] : null;
  const expectedWitness = expectedInputWitness(assertion.groupId, assertion.userId);
  if (
    sessions.length !== 1 ||
    witnesses.length !== 1 ||
    typeof callId !== "string" ||
    !callId ||
    call.data?.toolCallId !== callId ||
    result.toolCallId !== callId ||
    result.data?.toolCallId !== callId ||
    call.data?.name !== "qq_group_members" ||
    result.data?.name !== "qq_group_members" ||
    result.data?.isError !== false ||
    events.indexOf(call) < 0 ||
    events.indexOf(call) >= events.indexOf(result) ||
    !isRecord(input) ||
    Object.keys(input).sort().join(",") !== "groupId,operation" ||
    input.groupId !== assertion.groupId ||
    input.operation !== "get_group_member_info" ||
    !isRecord(session?.data) ||
    typeof session.data.conversationId !== "string" ||
    !session.data.conversationId ||
    session.principalId !== witness?.principalId ||
    witness?.conversationId !== session.data.conversationId ||
    typeof session.data.acceptanceLease?.leaseId !== "string" ||
    !session.data.acceptanceLease.leaseId ||
    witness?.leaseId !== session.data.acceptanceLease.leaseId ||
    witness?.principalId !== call.principalId ||
    witness?.principalId !== result.principalId ||
    witness?.toolCallId !== callId ||
    witness?.toolName !== "qq_group_members" ||
    witness?.action !== "get_group_member_info" ||
    witness?.resourceId !== `group:${assertion.groupId}` ||
    Object.keys(witness ?? {})
      .sort()
      .join(",") !==
      "action,conversationId,inputBytes,inputSha256,leaseId,principalId,resourceId,runId,toolCallId,toolName,type" ||
    witness?.type !== "qq_tool_execution_input_verified" ||
    witness?.runId !== runId ||
    witness?.inputSha256 !== expectedWitness.inputSha256 ||
    witness?.inputBytes !== expectedWitness.inputBytes ||
    events.indexOf(call) >= events.indexOf(witness) ||
    events.indexOf(witness) >= events.indexOf(result)
  )
    invalid();
  const role = roleFromOutput(result);
  return {
    kind: "group_member_role",
    tool: "qq_group_members",
    toolCallId: callId,
    groupId: assertion.groupId,
    userId: assertion.userId,
    role,
    inputSha256: witness.inputSha256,
    inputBytes: witness.inputBytes,
  };
}

export async function verifyGroupMemberRoleEvidence(c, feature, config, clients, events, runId) {
  const assertions =
    c?.featureAssertions?.filter((assertion) => assertion?.kind === "group_member_role") ?? [];
  const hasRoleCall =
    Array.isArray(events) &&
    events.some(
      (event) =>
        event?.runId === runId &&
        event.type === "tool_call" &&
        event.data?.name === "qq_group_members" &&
        event.data?.input?.operation === "get_group_member_info",
    );
  const fixedCase = c?.id === "qq-bot-group-role-read";
  if (!fixedCase && !assertions.length && !hasRoleCall) return undefined;

  const groups = config?.groups?.filter((group) => group.alias === "B") ?? [];
  const botId = validId(config?.bot?.qq);
  if (
    !fixedCase ||
    assertions.length !== 1 ||
    c?.route !== "private" ||
    groups.length !== 1 ||
    !validId(groups[0].id) ||
    !botId ||
    typeof c.token !== "string" ||
    !/^[a-f0-9]{32}$/u.test(c.token)
  )
    invalid("GROUP_MEMBER_ROLE_SCOPE", "INCONCLUSIVE");

  const groupId = groups[0].id;
  const expectedPrompt = `GLASSBOX_ACCEPTANCE_V1 ${c.token}\n你现在在测试群 ${groupId} 里是管理员吗？请实际查一下。请按一行回复 QQBOTGROUPROLE ${c.token} role=角色，方便我核对。`;
  const expectedLeaseTools = [
    {
      name: "qq_group_members",
      operations: [
        {
          action: "group:members:read",
          resourceId: `group:${groupId}`,
          inputConstraint: {
            groupId,
            operation: "get_group_member_info",
            params: { user_id: botId },
          },
        },
      ],
    },
  ];
  const expectedAssertions = [
    {
      kind: "trace",
      type: "tool_result",
      where: { name: "qq_group_members", isError: false },
      count: 1,
    },
    {
      kind: "group_member_role",
      tool: "qq_group_members",
      groupId,
      userId: botId,
      count: 1,
    },
  ];
  const expectedAssertion = expectedAssertions[1];
  if (
    c.prompt !== expectedPrompt ||
    JSON.stringify(c.expected) !== JSON.stringify([`QQBOTGROUPROLE ${c.token}`]) ||
    JSON.stringify(c.leasedToolNames) !== JSON.stringify(["qq_group_members"]) ||
    c.acceptanceLease?.toolsSha256 !== toolManifestDigest(expectedLeaseTools) ||
    JSON.stringify(c.featureAssertions) !== JSON.stringify(expectedAssertions)
  )
    invalid("GROUP_MEMBER_ROLE_SCOPE", "INCONCLUSIVE");

  const observed = observeGroupMemberRole(expectedAssertion, { events, runId });
  const roleWitness = events.find(
    (event) =>
      event?.runId === runId &&
      event.type === "qq_tool_execution_input_verified" &&
      event.toolCallId === observed.toolCallId,
  );
  if (
    typeof c.acceptanceLease?.leaseId !== "string" ||
    roleWitness?.leaseId !== c.acceptanceLease.leaseId
  )
    invalid("GROUP_MEMBER_ROLE_LEASE", "INCONCLUSIVE");
  const observations = feature?.observations ?? [];
  if (
    observations.length !== 2 ||
    JSON.stringify(observations[0]) !==
      JSON.stringify({ kind: "trace", type: "tool_result", count: 1 }) ||
    JSON.stringify(observations[1]) !== JSON.stringify(observed)
  )
    invalid("GROUP_MEMBER_ROLE_OBSERVATION", "INCONCLUSIVE");
  if (typeof clients?.bot?.readBotGroupMemberRole !== "function")
    invalid("GROUP_MEMBER_ROLE_UNAVAILABLE", "INCONCLUSIVE");
  let independent;
  try {
    independent = await clients.bot.readBotGroupMemberRole();
  } catch {
    invalid("GROUP_MEMBER_ROLE_UNAVAILABLE", "INCONCLUSIVE");
  }
  if (
    !isRecord(independent) ||
    Object.keys(independent).sort().join(",") !== "groupId,role,userId" ||
    independent.groupId !== groupId ||
    independent.userId !== botId ||
    independent.role !== observed.role
  )
    invalid("GROUP_MEMBER_ROLE_MISMATCH", "INCONCLUSIVE");
  return {
    status: "PASS",
    groupAlias: "B",
    role: observed.role,
    toolCallId: events.find(
      (event) =>
        event?.runId === runId &&
        event.type === "tool_call" &&
        event.data?.name === "qq_group_members",
    )?.toolCallId,
    inputWitness: {
      status: "QQ_TOOL_INPUT_VERIFIED",
      inputSha256: observed.inputSha256,
      inputBytes: observed.inputBytes,
    },
    independentSource: "bot_get_group_member_info",
  };
}
