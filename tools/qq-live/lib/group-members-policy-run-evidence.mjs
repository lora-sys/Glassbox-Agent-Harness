import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { fail } from "./core.mjs";
import { groupMembersPolicyStep } from "./group-members-policy-scenario.mjs";
import { verifyGroupMembersPolicyTransition } from "./group-members-policy-state.mjs";

const HASH = /^[a-f0-9]{64}$/u;
const ID = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,255}$/u;
const REFUSAL = "未能从 QQ 获取该信息，因此无法确认。";
const record = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
function invalid() {
  fail(
    "GROUP_MEMBERS_POLICY_RUN_EVIDENCE",
    "群成员权限 Run、Trace 或结果证据缺失或不一致。",
    "INCONCLUSIVE",
  );
}
function exact(v, keys) {
  return (
    record(v) &&
    isDeepStrictEqual(
      Object.keys(v).sort((a, b) => a.localeCompare(b)),
      [...keys].sort((a, b) => a.localeCompare(b)),
    )
  );
}
function time(v) {
  const n = typeof v === "string" ? Date.parse(v) : NaN;
  return Number.isFinite(n) && new Date(n).toISOString() === v ? n : NaN;
}
function scopeKey(scope) {
  if (!record(scope)) invalid();
  const allowed = ["connectionId", "botId", "chatType", "chatId", "senderId", "threadId"];
  if (Object.keys(scope).some((key) => !allowed.includes(key))) invalid();
  for (const key of ["connectionId", "botId", "chatType", "chatId", "senderId"])
    if (typeof scope[key] !== "string" || !scope[key]) invalid();
  if (scope.threadId !== undefined && scope.threadId !== null && typeof scope.threadId !== "string")
    invalid();
  return JSON.stringify([
    scope.connectionId,
    scope.botId,
    scope.chatType,
    scope.chatId,
    scope.senderId,
    scope.threadId ?? null,
  ]);
}
function validateRun(db, runId, before, stage, after) {
  const rows = db
    .prepare(
      "SELECT r.id,r.principal_id,r.conversation_id,r.scope_json,r.status,r.failure_code,r.result_text,r.created_at,r.updated_at,p.kind AS principal_kind FROM runs r JOIN principals p ON p.id=r.principal_id WHERE r.id=?",
    )
    .all(runId);
  if (rows.length !== 1) invalid();
  const run = rows[0];
  let scope;
  try {
    scope = JSON.parse(run.scope_json);
  } catch {
    invalid();
  }
  const created = time(run.created_at),
    updated = time(run.updated_at);
  if (
    run.id !== runId ||
    run.principal_kind !== "owner" ||
    run.principal_id !== before.principalId ||
    scopeKey(scope) !== before.scopeKey ||
    !Number.isFinite(created) ||
    !Number.isFinite(updated) ||
    updated < created
  )
    invalid();
  if (stage === "members-check") {
    if (
      run.status !== "failed" ||
      run.failure_code !== "required_evidence_missing" ||
      run.result_text !== REFUSAL ||
      created < time(after.B.updatedAt) ||
      updated < created
    )
      invalid();
  } else {
    const mutationAt = time(after.B.updatedAt);
    if (
      run.status !== "succeeded" ||
      run.failure_code !== null ||
      created < time(before.B.updatedAt) ||
      !Number.isFinite(mutationAt) ||
      mutationAt < created ||
      mutationAt > updated
    )
      invalid();
  }
  return { created, updated, conversationId: rows[0].conversation_id };
}
function decisionProof(db, runId, before) {
  const decisions = db
    .prepare(
      "SELECT principal_id,resource_id,action,scope_key,decision,run_id,delivery_source FROM authorization_decisions_all WHERE run_id=? AND resource_id='owner-control' AND action='group:manage'",
    )
    .all(runId);
  if (
    decisions.length < 1 ||
    decisions.some(
      (d) =>
        d.principal_id !== before.principalId ||
        d.resource_id !== "owner-control" ||
        d.action !== "group:manage" ||
        d.scope_key !== before.scopeKey ||
        d.decision !== "ALLOW" ||
        d.run_id !== runId ||
        d.delivery_source !== null,
    )
  )
    invalid();
}
function verifyMutation({ events, runId, before, after, stage, interval }) {
  const tool = "owner_group_admin";
  const expected = groupMembersPolicyStep(stage, before.B.groupId).leaseTools[0].operations[0]
    .inputConstraint;
  const calls = events.filter((e) => e?.runId === runId && e.type === "tool_call");
  const results = events.filter((e) => e?.runId === runId && e.type === "tool_result");
  if (calls.length !== 1 || results.length !== 1) invalid();
  const [call] = calls,
    [result] = results;
  const cid = call.toolCallId,
    at = time(call.timestamp),
    resultAt = time(result.timestamp);
  if (
    !ID.test(cid ?? "") ||
    call.principalId !== before.principalId ||
    !record(call.data) ||
    call.data.name !== tool ||
    call.data.runId !== runId ||
    call.data.principalId !== before.principalId ||
    call.data.toolCallId !== cid ||
    !isDeepStrictEqual(call.data.input, expected) ||
    result.principalId !== before.principalId ||
    !record(result.data) ||
    result.data.name !== tool ||
    result.data.runId !== runId ||
    result.data.principalId !== before.principalId ||
    result.data.toolCallId !== cid ||
    result.toolCallId !== cid ||
    result.data.isError !== false ||
    !Number.isFinite(at) ||
    !Number.isFinite(resultAt) ||
    at < interval.created ||
    resultAt > interval.updated ||
    resultAt < at ||
    events.indexOf(result) <= events.indexOf(call)
  )
    invalid();
  const mutations = events.filter(
    (e) => e?.runId === runId && e.type === "group_capability_changed",
  );
  const expectedEvent = {
    type: "group_capability_changed",
    connectionId: before.connectionId,
    groupId: before.B.groupId,
    category: "group.members",
    enabled: stage === "restore",
    policyVersion: after.B.version,
    runId,
    principalId: before.principalId,
  };
  if (
    mutations.length !== 1 ||
    !isDeepStrictEqual(mutations[0], expectedEvent) ||
    events.indexOf(mutations[0]) <= events.indexOf(call) ||
    events.indexOf(mutations[0]) >= events.indexOf(result)
  )
    invalid();
  const wrapperText = result.data.outputHead;
  if (
    typeof wrapperText !== "string" ||
    result.data.outputTruncated !== false ||
    !Number.isSafeInteger(result.data.outputBytes) ||
    result.data.outputBytes !== Buffer.byteLength(wrapperText) ||
    !HASH.test(result.data.outputSha256 ?? "") ||
    createHash("sha256").update(wrapperText).digest("hex") !== result.data.outputSha256
  )
    invalid();
  let wrapper, output;
  try {
    wrapper = JSON.parse(wrapperText);
    if (
      !exact(wrapper, ["content", "details"]) ||
      wrapper.content.length !== 1 ||
      !exact(wrapper.content[0], ["type", "text"]) ||
      wrapper.content[0].type !== "text" ||
      !exact(wrapper.details, [])
    )
      invalid();
    output = JSON.parse(wrapper.content[0].text);
  } catch {
    invalid();
  }
  if (
    JSON.stringify(wrapper) !== wrapperText ||
    !exact(output, ["groupId", "category", "enabled", "version"]) ||
    output.groupId !== before.B.groupId ||
    output.category !== "group.members" ||
    output.enabled !== (stage === "restore") ||
    output.version !== after.B.version
  )
    invalid();
  return { toolCallId: cid, toolOutputSha256: result.data.outputSha256 };
}
function verifyMembersCheck({ events, runId, before, disabled, after, interval }) {
  if (
    !disabled ||
    !isDeepStrictEqual(disabled, after) ||
    verifyGroupMembersPolicyTransition(before, disabled, "disable").status !==
      "STATE_TRANSITION_VERIFIED" ||
    disabled.B.policy.categories["group.members"] !== false ||
    disabled.B.memberGrants.length !== 0 ||
    events.some(
      (event) => event?.runId === runId && ["tool_call", "tool_result"].includes(event.type),
    )
  )
    invalid();
  const evidence = events.filter(
    (event) => event?.runId === runId && event.type === "tool_evidence",
  );
  const required = evidence.filter((event) => event.phase === "required");
  const resolved = evidence.filter((event) => event.phase === "resolved");
  const expectedRequired = [
    {
      domain: "group_members",
      tool: "qq_group_members",
      input: { operation: "get_group_member_list" },
    },
  ];
  const expectedResolved = [
    { domain: "group_members", tool: "qq_group_members", outcome: "not_called" },
  ];
  if (
    evidence.length !== 2 ||
    required.length !== 1 ||
    resolved.length !== 1 ||
    !exact(required[0], ["type", "runId", "principalId", "conversationId", "phase", "required"]) ||
    !exact(resolved[0], [
      "type",
      "runId",
      "principalId",
      "conversationId",
      "phase",
      "resolutions",
    ]) ||
    required[0].runId !== runId ||
    required[0].principalId !== before.principalId ||
    required[0].conversationId !== interval.conversationId ||
    !isDeepStrictEqual(required[0].required, expectedRequired) ||
    resolved[0].runId !== runId ||
    resolved[0].principalId !== before.principalId ||
    resolved[0].conversationId !== interval.conversationId ||
    !isDeepStrictEqual(resolved[0].resolutions, expectedResolved)
  )
    invalid();
  return { toolCallId: null, toolOutputSha256: null };
}

/** Verify the exact category mutation or the expected fail-closed missing-evidence Run. */
export function observeGroupMembersPolicyRun({
  db,
  events,
  runId,
  before,
  disabled,
  after,
  stage,
} = {}) {
  try {
    if (
      !["disable", "members-check", "restore"].includes(stage) ||
      !db ||
      !ID.test(runId ?? "") ||
      !Array.isArray(events)
    )
      invalid();
    if (stage === "members-check") {
      if (
        verifyGroupMembersPolicyTransition(before, disabled, "disable").status !==
          "STATE_TRANSITION_VERIFIED" ||
        !isDeepStrictEqual(disabled, after)
      )
        invalid();
    } else verifyGroupMembersPolicyTransition(before, after, stage);
    const interval = validateRun(
      db,
      runId,
      before,
      stage,
      stage === "members-check" ? disabled : after,
    );
    if (stage === "members-check") {
      verifyMembersCheck({ events, runId, before, disabled, after, interval });
      return {
        status: "GROUP_MEMBERS_POLICY_REQUIRED_EVIDENCE_MISSING",
        runId,
        stage,
        policyVersion: after.B.version,
        toolCallId: null,
        toolOutputSha256: null,
        stateProof: verifyGroupMembersPolicyTransition(before, after, "disable"),
        actualQqDeliveryVerified: false,
      };
    }
    decisionProof(db, runId, before);
    const toolProof = verifyMutation({ events, runId, before, after, stage, interval });
    return {
      status: "GROUP_MEMBERS_POLICY_RUN_VERIFIED",
      runId,
      stage,
      policyVersion: after.B.version,
      ...toolProof,
      stateProof: verifyGroupMembersPolicyTransition(before, after, stage),
      actualQqDeliveryVerified: false,
    };
  } catch (error) {
    if (error?.code === "GROUP_MEMBERS_POLICY_RUN_EVIDENCE") throw error;
    invalid();
  }
}

export function verifyGroupMembersPolicyLeaseTrace(events, caseRecord, runId) {
  try {
    const expectedTools = ["qq_group_members"];
    const sessions = events.filter(
      (event) => event?.runId === runId && event.type === "session_start",
    );
    if (
      !Array.isArray(events) ||
      !ID.test(runId ?? "") ||
      caseRecord?.id !== "group-members-policy-check" ||
      !caseRecord.acceptanceLease ||
      sessions.length < 1 ||
      sessions.some((event) => {
        const lease = event.data?.acceptanceLease;
        return (
          !exact(lease, ["leaseId", "marker", "narrowedTools", "toolsSha256"]) ||
          lease.leaseId !== caseRecord.acceptanceLease.leaseId ||
          lease.marker !== caseRecord.token ||
          lease.toolsSha256 !== caseRecord.acceptanceLease.toolsSha256 ||
          !isDeepStrictEqual(lease.narrowedTools, expectedTools) ||
          !isDeepStrictEqual(event.data?.authorizedTools, expectedTools)
        );
      })
    )
      invalid();
    return true;
  } catch (error) {
    if (error?.code === "GROUP_MEMBERS_POLICY_RUN_EVIDENCE") throw error;
    invalid();
  }
}
