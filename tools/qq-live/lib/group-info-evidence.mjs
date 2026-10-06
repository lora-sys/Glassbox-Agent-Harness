import { digest, fail, id } from "./core.mjs";

const MESSAGE = "群信息 Trace 与独立读取证据不一致。";
const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const groupIdPattern = /^(?:[1-9]\d{4,15}|\{\{group:A\}\})$/u;
const numericGroupIdPattern = /^[1-9]\d{4,15}$/u;

function invalid(code = "GROUP_INFO_EVIDENCE", status = "INCONCLUSIVE") {
  fail(code, MESSAGE, status);
}

export function validateGroupInfoAssertion(assertion) {
  if (
    !isRecord(assertion) ||
    Object.keys(assertion).sort().join(",") !== "count,groupId,kind,tool" ||
    assertion.kind !== "group_info" ||
    assertion.tool !== "qq_groups" ||
    assertion.count !== 1 ||
    typeof assertion.groupId !== "string" ||
    !groupIdPattern.test(assertion.groupId)
  )
    invalid("GROUP_INFO_ASSERTION", "BLOCKED");
  return assertion;
}

function validProviderGroupId(value) {
  const normalized = id(value);
  if (normalized && numericGroupIdPattern.test(normalized)) return normalized;
  return "";
}

/** Return only the stable, non-content projection used by both evidence sources. */
export function projectGroupInfo(result, expectedGroupId) {
  if (
    !isRecord(result) ||
    typeof expectedGroupId !== "string" ||
    !numericGroupIdPattern.test(expectedGroupId)
  )
    invalid();
  const groupId = validProviderGroupId(result.group_id);
  const name = result.group_name;
  const memberCount = result.member_count;
  const maxMemberCount = result.max_member_count;
  if (
    groupId !== expectedGroupId ||
    typeof name !== "string" ||
    name.trim().length === 0 ||
    Buffer.byteLength(name, "utf8") > 512 ||
    !Number.isSafeInteger(memberCount) ||
    memberCount < 0 ||
    !Number.isSafeInteger(maxMemberCount) ||
    maxMemberCount < 0 ||
    memberCount > maxMemberCount
  )
    invalid();
  return {
    groupId,
    groupNameSha256: digest(Buffer.from(name, "utf8")),
    memberCount,
    maxMemberCount,
  };
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

function groupInfoEvents(events, runId) {
  if (!Array.isArray(events) || typeof runId !== "string" || !runId) invalid();
  const calls = events.filter(
    (event) =>
      event?.runId === runId &&
      event.type === "tool_call" &&
      (event.data?.name === "qq_groups" || event.name === "qq_groups"),
  );
  const results = events.filter(
    (event) =>
      event?.runId === runId &&
      event.type === "tool_result" &&
      (event.data?.name === "qq_groups" || event.name === "qq_groups"),
  );
  const infoCalls = calls.filter((event) => event.data?.input?.operation === "get_group_info");
  if (infoCalls.length !== 1 || calls.length !== 1 || results.length !== 1) invalid();
  const [call] = infoCalls;
  const [result] = results;
  if (
    events.indexOf(call) >= events.indexOf(result) ||
    typeof call.toolCallId !== "string" ||
    !call.toolCallId ||
    call.data?.toolCallId !== call.toolCallId ||
    result.toolCallId !== call.toolCallId ||
    result.data?.toolCallId !== call.toolCallId ||
    result.data?.isError !== false
  )
    invalid();
  return { call, result };
}

export function observeGroupInfoResult(assertion, { events, runId }) {
  validateGroupInfoAssertion(assertion);
  const { call, result } = groupInfoEvents(events, runId);
  const input = call.data.input;
  const expectedGroupId = assertion.groupId;
  if (
    !isRecord(input) ||
    Object.keys(input).some((key) => !["groupId", "operation", "params"].includes(key)) ||
    input.groupId !== expectedGroupId ||
    input.operation !== "get_group_info" ||
    (input.params !== undefined &&
      (!isRecord(input.params) || Object.keys(input.params).length !== 0))
  )
    invalid();

  const data = result.data;
  const head = data.outputHead;
  const outputBytes = Buffer.byteLength(typeof head === "string" ? head : "", "utf8");
  if (
    typeof head !== "string" ||
    !Number.isSafeInteger(data.outputBytes) ||
    typeof data.outputSha256 !== "string" ||
    !/^[0-9a-f]{64}$/u.test(data.outputSha256) ||
    !isRecord(data.groupInfo) ||
    Object.keys(data.groupInfo).sort().join(",") !==
      "groupId,groupNameSha256,maxMemberCount,memberCount,schemaVersion" ||
    data.groupInfo.schemaVersion !== 1
  )
    invalid();

  const safe = validateTraceGroupInfo(data.groupInfo, expectedGroupId);
  if (data.outputTruncated === false) {
    if (
      outputBytes > 512 ||
      data.outputBytes !== outputBytes ||
      digest(Buffer.from(head, "utf8")) !== data.outputSha256
    )
      invalid();
    const projection = parseCanonicalJson(head);
    if (
      !isRecord(projection) ||
      Object.keys(projection).sort().join(",") !== "content,details" ||
      !Array.isArray(projection.content) ||
      projection.content.length !== 1 ||
      !isRecord(projection.content[0]) ||
      Object.keys(projection.content[0]).sort().join(",") !== "text,type" ||
      projection.content[0].type !== "text" ||
      typeof projection.content[0].text !== "string" ||
      !isRecord(projection.details) ||
      projection.content[0].text !== JSON.stringify(projection.details) ||
      canonical(projectGroupInfo(projection.details, expectedGroupId)) !== canonical(safe)
    )
      invalid();
  } else if (data.outputTruncated === true) {
    if (data.outputBytes <= 512 || outputBytes < 512 || outputBytes > 514) invalid();
  } else invalid();
  return { kind: "group_info", tool: "qq_groups", ...safe };
}

function expectedAssertion(groupId) {
  return { kind: "group_info", tool: "qq_groups", groupId, count: 1 };
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (isRecord(value))
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

export async function verifyGroupInfoEvidence(
  c,
  feature,
  config,
  clients,
  events,
  runId,
  actualReplyWitness,
) {
  if (!Array.isArray(events) || typeof runId !== "string" || !runId) invalid();
  const infoCalls = events.filter(
    (event) =>
      event?.runId === runId &&
      event.type === "tool_call" &&
      event.data?.name === "qq_groups" &&
      event.data?.input?.operation === "get_group_info",
  );
  const assertionRequested =
    c?.featureAssertions?.some((assertion) => assertion?.kind === "group_info") === true ||
    feature?.observations?.some((observation) => observation?.kind === "group_info") === true;
  if (infoCalls.length === 0 && !assertionRequested) return undefined;
  const { call } = groupInfoEvents(events, runId);
  const groups = config?.groups?.filter((group) => group.alias === "A") ?? [];
  const groupId = groups.length === 1 ? groups[0].id : "";
  if (
    !/^[1-9]\d{4,15}$/u.test(groupId) ||
    c?.route !== "private" ||
    !Array.isArray(c?.featureAssertions) ||
    c.featureAssertions.length !== 2 ||
    !Array.isArray(feature?.observations) ||
    feature.observations.length !== 2
  )
    invalid("GROUP_INFO_SCOPE", "INCONCLUSIVE");

  const rawAssertion = expectedAssertion("{{group:A}}");
  const resolvedAssertion = expectedAssertion(groupId);
  const groupInfoAssertions = c.featureAssertions.filter(
    (assertion) => assertion?.kind === "group_info",
  );
  const traceAssertions = c.featureAssertions.filter((assertion) => assertion?.kind === "trace");
  const expectedTraceAssertion = {
    kind: "trace",
    type: "tool_result",
    where: { name: "qq_groups", isError: false },
    count: 1,
  };
  if (
    groupInfoAssertions.length !== 1 ||
    traceAssertions.length !== 1 ||
    ![canonical(rawAssertion), canonical(resolvedAssertion)].includes(
      canonical(groupInfoAssertions[0]),
    ) ||
    canonical(traceAssertions[0]) !== canonical(expectedTraceAssertion)
  )
    invalid("GROUP_INFO_SCOPE", "INCONCLUSIVE");
  validateGroupInfoAssertion(resolvedAssertion);

  const input = call.data.input;
  if (
    !isRecord(input) ||
    Object.keys(input).some((key) => !["groupId", "operation", "params"].includes(key)) ||
    input.groupId !== groupId ||
    input.operation !== "get_group_info" ||
    (input.params !== undefined &&
      (!isRecord(input.params) || Object.keys(input.params).length !== 0))
  )
    invalid("GROUP_INFO_SCOPE", "INCONCLUSIVE");

  const observed = observeGroupInfoResult(resolvedAssertion, { events, runId });
  const groupInfoObservations = feature.observations.filter(
    (observation) => observation?.kind === "group_info",
  );
  const traceObservations = feature.observations.filter(
    (observation) => observation?.kind === "trace",
  );
  if (
    c.featureAssertions.length !== 2 ||
    groupInfoAssertions.length !== 1 ||
    traceAssertions.length !== 1 ||
    canonical(traceAssertions[0]) !== canonical(expectedTraceAssertion) ||
    feature.observations.length !== 2 ||
    groupInfoObservations.length !== 1 ||
    traceObservations.length !== 1 ||
    canonical(traceObservations[0]) !== canonical({ kind: "trace", type: "tool_result", count: 1 })
  )
    invalid("GROUP_INFO_SCOPE", "INCONCLUSIVE");
  if (canonical(groupInfoObservations[0]) !== canonical(observed))
    invalid("GROUP_INFO_OBSERVATION", "INCONCLUSIVE");
  if (
    !isRecord(actualReplyWitness) ||
    Object.keys(actualReplyWitness).sort().join(",") !== "maxMemberCount,memberCount" ||
    actualReplyWitness.memberCount !== observed.memberCount ||
    actualReplyWitness.maxMemberCount !== observed.maxMemberCount
  )
    invalid("GROUP_INFO_REPLY", "INCONCLUSIVE");
  if (typeof clients?.bot?.readGroupInfo !== "function")
    invalid("GROUP_INFO_UNAVAILABLE", "INCONCLUSIVE");

  let independentResult;
  try {
    independentResult = await clients.bot.readGroupInfo();
  } catch {
    invalid("GROUP_INFO_UNAVAILABLE", "INCONCLUSIVE");
  }
  let independent;
  try {
    independent = validateSafeGroupInfo(independentResult, groupId);
  } catch {
    invalid("GROUP_INFO_MISMATCH", "INCONCLUSIVE");
  }
  if (canonical(independent) !== canonical(observedSafe(observed)))
    invalid("GROUP_INFO_MISMATCH", "INCONCLUSIVE");
  return { status: "PASS", groupId, groupNameSha256: observed.groupNameSha256 };
}

function validateSafeGroupInfo(value, expectedGroupId) {
  if (
    !isRecord(value) ||
    Object.keys(value).sort().join(",") !== "groupId,groupNameSha256,maxMemberCount,memberCount" ||
    value.groupId !== expectedGroupId ||
    !/^[0-9a-f]{64}$/u.test(value.groupNameSha256 ?? "") ||
    !Number.isSafeInteger(value.memberCount) ||
    value.memberCount < 0 ||
    !Number.isSafeInteger(value.maxMemberCount) ||
    value.maxMemberCount < 0 ||
    value.memberCount > value.maxMemberCount
  )
    invalid("GROUP_INFO_UNAVAILABLE", "INCONCLUSIVE");
  return {
    groupId: value.groupId,
    groupNameSha256: value.groupNameSha256,
    memberCount: value.memberCount,
    maxMemberCount: value.maxMemberCount,
  };
}

function validateTraceGroupInfo(value, expectedGroupId) {
  if (
    !isRecord(value) ||
    Object.keys(value).sort().join(",") !==
      "groupId,groupNameSha256,maxMemberCount,memberCount,schemaVersion" ||
    value.schemaVersion !== 1
  )
    invalid();
  return validateSafeGroupInfo(
    {
      groupId: value.groupId,
      groupNameSha256: value.groupNameSha256,
      memberCount: value.memberCount,
      maxMemberCount: value.maxMemberCount,
    },
    expectedGroupId,
  );
}

function observedSafe(observed) {
  const { groupId, groupNameSha256, memberCount, maxMemberCount } = observed;
  return { groupId, groupNameSha256, memberCount, maxMemberCount };
}
