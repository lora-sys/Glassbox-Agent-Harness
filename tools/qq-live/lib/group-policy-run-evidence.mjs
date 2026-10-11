import { createHash } from "node:crypto";
import { fail } from "./core.mjs";
import { groupPolicyStep } from "./group-policy-scenario.mjs";
import { verifyGroupPolicyTransition } from "./group-policy-state.mjs";

const TOOL = "owner_group_admin";
const RESOURCE = "owner-control";
const ACTION = "group:manage";
const HASH = /^[a-f0-9]{64}$/u;
const ID = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,255}$/u;
const MESSAGE = "群策略 Run 的授权、Trace 与独立状态证据缺失或不一致。";
const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (isRecord(value))
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

function inconclusive() {
  fail("GROUP_POLICY_RUN_EVIDENCE", MESSAGE, "INCONCLUSIVE");
}

function timestamp(value) {
  if (typeof value !== "string") return NaN;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value ? parsed : NaN;
}

function scopeKey(scope) {
  if (!isRecord(scope)) inconclusive();
  const allowed = ["connectionId", "botId", "chatType", "chatId", "senderId", "threadId"];
  if (Object.keys(scope).some((key) => !allowed.includes(key))) inconclusive();
  for (const key of ["connectionId", "botId", "chatType", "chatId", "senderId"])
    if (typeof scope[key] !== "string" || !scope[key]) inconclusive();
  if (scope.threadId !== undefined && scope.threadId !== null && typeof scope.threadId !== "string")
    inconclusive();
  return JSON.stringify([
    scope.connectionId,
    scope.botId,
    scope.chatType,
    scope.chatId,
    scope.senderId,
    scope.threadId ?? null,
  ]);
}

function runEvidence(db, runId, before, after, stage) {
  if (!db || typeof db.prepare !== "function" || !ID.test(runId ?? "")) inconclusive();
  if (typeof before?.scopeKey !== "string" || typeof before?.principalId !== "string")
    inconclusive();
  let expectedScope;
  try {
    expectedScope = JSON.parse(before.scopeKey);
  } catch {
    inconclusive();
  }
  if (
    !Array.isArray(expectedScope) ||
    expectedScope.length !== 6 ||
    expectedScope[2] !== "private" ||
    typeof expectedScope[3] !== "string" ||
    expectedScope[3] !== expectedScope[4] ||
    (expectedScope[5] !== null && typeof expectedScope[5] !== "string")
  )
    inconclusive();

  const runs = db
    .prepare(
      "SELECT r.id,r.principal_id,r.scope_json,r.status,r.created_at,r.updated_at,p.kind AS principal_kind FROM runs r JOIN principals p ON p.id=r.principal_id WHERE r.id=?",
    )
    .all(runId);
  if (runs.length !== 1) inconclusive();
  const run = runs[0];
  let actualScope;
  try {
    actualScope = JSON.parse(run.scope_json);
  } catch {
    inconclusive();
  }
  const created = timestamp(run.created_at);
  const updated = timestamp(run.updated_at);
  const baseline = timestamp(before.B?.updatedAt);
  const transitionAt = timestamp(after?.B?.updatedAt);
  const grantChangedAt =
    stage === "disable"
      ? timestamp(after?.B?.originalHistoryGrant?.revokedAt)
      : timestamp(after?.B?.historyGrants?.[0]?.createdAt);
  if (
    run.id !== runId ||
    run.principal_kind !== "owner" ||
    run.principal_id !== before.principalId ||
    scopeKey(actualScope) !== before.scopeKey ||
    run.status !== "succeeded" ||
    !Number.isFinite(created) ||
    !Number.isFinite(updated) ||
    !Number.isFinite(baseline) ||
    created > updated ||
    created < baseline ||
    !Number.isFinite(transitionAt) ||
    transitionAt < created ||
    transitionAt > updated ||
    !Number.isFinite(grantChangedAt) ||
    grantChangedAt < created ||
    grantChangedAt > updated
  )
    inconclusive();

  const decisions = db
    .prepare(
      "SELECT principal_id,resource_id,action,scope_key,decision,run_id,delivery_source FROM authorization_decisions_all WHERE run_id=? AND resource_id=? AND action=?",
    )
    .all(runId, RESOURCE, ACTION);
  if (
    decisions.length < 1 ||
    decisions.some(
      (decision) =>
        decision.principal_id !== before.principalId ||
        decision.resource_id !== RESOURCE ||
        decision.action !== ACTION ||
        decision.scope_key !== before.scopeKey ||
        decision.decision !== "ALLOW" ||
        decision.run_id !== runId ||
        decision.delivery_source !== null,
    )
  )
    inconclusive();
  return { created, updated };
}

function readToolEvents(events, runId, before, stage, runInterval) {
  if (!Array.isArray(events) || !["disable", "restore"].includes(stage)) inconclusive();
  const calls = events.filter((event) => event?.runId === runId && event.type === "tool_call");
  const results = events.filter((event) => event?.runId === runId && event.type === "tool_result");
  if (calls.length !== 1 || results.length !== 1) inconclusive();
  const [call] = calls;
  const [result] = results;
  const callData = call.data;
  const resultData = result.data;
  const groupId = before.B?.groupId;
  const expectedInput = groupPolicyStep(stage, groupId).leaseTools[0].operations[0].inputConstraint;
  if (
    !isRecord(callData) ||
    (call.name !== undefined && call.name !== TOOL) ||
    call.principalId !== before.principalId ||
    callData.name !== TOOL ||
    callData.runId !== runId ||
    callData.principalId !== before.principalId ||
    canonical(callData.input) !== canonical(expectedInput) ||
    typeof call.toolCallId !== "string" ||
    !call.toolCallId ||
    callData.toolCallId !== call.toolCallId ||
    !isRecord(resultData) ||
    (result.name !== undefined && result.name !== TOOL) ||
    result.principalId !== before.principalId ||
    resultData.name !== TOOL ||
    resultData.runId !== runId ||
    resultData.principalId !== before.principalId ||
    result.toolCallId !== call.toolCallId ||
    resultData.toolCallId !== call.toolCallId ||
    resultData.isError !== false ||
    events.indexOf(call) < 0 ||
    events.indexOf(result) <= events.indexOf(call) ||
    !Number.isFinite(timestamp(call.timestamp)) ||
    !Number.isFinite(timestamp(result.timestamp)) ||
    timestamp(call.timestamp) < runInterval.created ||
    timestamp(result.timestamp) > runInterval.updated ||
    timestamp(result.timestamp) < timestamp(call.timestamp)
  )
    inconclusive();
  return {
    call,
    result,
    callIndex: events.indexOf(call),
    resultIndex: events.indexOf(result),
  };
}

function verifyMutationEvent(events, runId, before, after, stage, callIndex, resultIndex) {
  const mutationEvents = events.filter(
    (event) => event?.runId === runId && event.type === "group_history_changed",
  );
  if (mutationEvents.length !== 1) inconclusive();
  const event = mutationEvents[0];
  const expected = {
    connectionId: before.connectionId,
    groupId: before.B?.groupId,
    enabled: stage === "restore",
    policyVersion: after.B?.version,
    runId,
    principalId: before.principalId,
  };
  if (
    !isRecord(event) ||
    event.data !== undefined ||
    Object.keys(event).sort().join(",") !==
      "connectionId,enabled,groupId,policyVersion,principalId,runId,type" ||
    Object.keys(expected).some((key) => event[key] !== expected[key]) ||
    event.type !== "group_history_changed" ||
    events.indexOf(event) <= callIndex ||
    events.indexOf(event) >= resultIndex
  )
    inconclusive();
}

function verifyCompleteResult(result, stage, groupId, version) {
  const data = result.data;
  const head = data.outputHead;
  if (
    data.outputTruncated !== false ||
    typeof head !== "string" ||
    !Number.isSafeInteger(data.outputBytes) ||
    data.outputBytes !== Buffer.byteLength(head, "utf8") ||
    typeof data.outputSha256 !== "string" ||
    !HASH.test(data.outputSha256) ||
    createHash("sha256").update(head, "utf8").digest("hex") !== data.outputSha256
  )
    inconclusive();
  let wrapper;
  let output;
  try {
    wrapper = JSON.parse(head);
    if (
      !isRecord(wrapper) ||
      Object.keys(wrapper).sort().join(",") !== "content,details" ||
      !Array.isArray(wrapper.content) ||
      wrapper.content.length !== 1 ||
      !isRecord(wrapper.content[0]) ||
      Object.keys(wrapper.content[0]).sort().join(",") !== "text,type" ||
      wrapper.content[0].type !== "text" ||
      !isRecord(wrapper.details) ||
      Object.keys(wrapper.details).length !== 0
    )
      inconclusive();
    output = JSON.parse(wrapper.content[0].text);
  } catch {
    inconclusive();
  }
  if (
    JSON.stringify(wrapper) !== head ||
    !isRecord(output) ||
    Object.keys(output).sort().join(",") !== "enabled,groupId,version" ||
    output.groupId !== groupId ||
    output.enabled !== (stage === "restore") ||
    output.version !== version
  )
    inconclusive();
  return data.outputSha256;
}

/** Verify one Owner-private group-history policy mutation against independent DB and gbxtrace reads. */
export function observeGroupPolicyRun({ db, events, runId, before, after, stage } = {}) {
  try {
    if (!["disable", "restore"].includes(stage)) inconclusive();
    const stateProof = verifyGroupPolicyTransition(before, after, stage);
    const runInterval = runEvidence(db, runId, before, after, stage);
    const { call, result, callIndex, resultIndex } = readToolEvents(
      events,
      runId,
      before,
      stage,
      runInterval,
    );
    verifyMutationEvent(events, runId, before, after, stage, callIndex, resultIndex);
    const toolOutputSha256 = verifyCompleteResult(result, stage, before.B.groupId, after.B.version);
    return {
      status: "GROUP_POLICY_RUN_VERIFIED",
      runId,
      stage,
      policyVersion: after.B.version,
      toolCallId: call.toolCallId,
      toolOutputSha256,
      stateProof,
      actualQqDeliveryVerified: false,
    };
  } catch (error) {
    if (error?.code === "GROUP_POLICY_TRANSITION") inconclusive();
    if (error?.code === "GROUP_POLICY_RUN_EVIDENCE") throw error;
    inconclusive();
  }
}
