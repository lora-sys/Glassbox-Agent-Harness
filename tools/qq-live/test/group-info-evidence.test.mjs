import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  observeGroupInfoResult,
  projectGroupInfo,
  verifyGroupInfoEvidence,
} from "../lib/group-info-evidence.mjs";
import { observeFeature } from "../lib/feature-observer.mjs";

const runId = "run-group-info-1";
const groupId = "20001";
const groupName = "验收群 A";
const hash = (value) => createHash("sha256").update(value, "utf8").digest("hex");
const providerResult = () => ({
  group_id: Number(groupId),
  group_name: groupName,
  member_count: 8,
  max_member_count: 500,
  provider_extension: "ignored safely",
});

function fixture({ result = providerResult(), params, inputGroupId = groupId } = {}) {
  const input = { groupId: inputGroupId, operation: "get_group_info" };
  if (params !== undefined) input.params = params;
  const wrapped = { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
  const outputHead = JSON.stringify(wrapped);
  const callId = "call-group-info-1";
  const events = [
    {
      type: "tool_call",
      runId,
      toolCallId: callId,
      data: { toolCallId: callId, name: "qq_groups", input },
    },
    {
      type: "tool_result",
      runId,
      toolCallId: callId,
      data: {
        toolCallId: callId,
        name: "qq_groups",
        isError: false,
        groupInfo: {
          schemaVersion: 1,
          ...projectGroupInfo(result, groupId),
        },
        outputHead,
        outputTruncated: false,
        outputBytes: Buffer.byteLength(outputHead, "utf8"),
        outputSha256: hash(outputHead),
      },
    },
  ];
  const groupAssertion = { kind: "group_info", tool: "qq_groups", groupId, count: 1 };
  const traceAssertion = {
    kind: "trace",
    type: "tool_result",
    where: { name: "qq_groups", isError: false },
    count: 1,
  };
  const assertions = [traceAssertion, groupAssertion];
  const feature = observeFeature(assertions, { events, runId });
  const observation = feature.observations.find((item) => item.kind === "group_info");
  const c = { route: "private", featureAssertions: assertions };
  const config = { groups: [{ alias: "A", id: groupId }] };
  const clients = {
    bot: { readGroupInfo: async () => projectGroupInfo(providerResult(), groupId) },
  };
  const witness = { memberCount: 8, maxMemberCount: 500 };
  return {
    events,
    assertion: groupAssertion,
    observation,
    feature,
    c,
    config,
    clients,
    witness,
  };
}

const verify = (f, overrides = {}) =>
  verifyGroupInfoEvidence(
    overrides.c ?? f.c,
    overrides.feature ?? f.feature,
    overrides.config ?? f.config,
    overrides.clients ?? f.clients,
    overrides.events ?? f.events,
    runId,
    Object.hasOwn(overrides, "witness") ? overrides.witness : f.witness,
  );

function replaceOutput(events, head, overrides = {}) {
  const changed = structuredClone(events);
  Object.assign(changed[1].data, {
    outputHead: head,
    outputBytes: Buffer.byteLength(head, "utf8"),
    outputSha256: hash(head),
    ...overrides,
  });
  return changed;
}

function expectInconclusive(operation, code = "GROUP_INFO_EVIDENCE") {
  assert.throws(operation, (error) => {
    if (code !== null) assert.equal(error.code, code);
    assert.equal(error.status, "INCONCLUSIVE");
    assert.equal(error.message.includes(groupName), false);
    assert.equal(error.message.includes("provider_extension"), false);
    return true;
  });
}

test("group info observer retains only the safe projection and ignores extra provider fields", () => {
  const f = fixture();
  assert.deepEqual(f.observation, {
    kind: "group_info",
    tool: "qq_groups",
    groupId,
    groupNameSha256: hash(groupName),
    memberCount: 8,
    maxMemberCount: 500,
  });
  assert.equal(JSON.stringify(f.observation).includes(groupName), false);
  assert.deepEqual(projectGroupInfo(providerResult(), groupId), {
    groupId,
    groupNameSha256: hash(groupName),
    memberCount: 8,
    maxMemberCount: 500,
  });
});

test("group info verifier binds private A call, fixed observation and independent provider read", async () => {
  const f = fixture({ params: {} });
  assert.deepEqual(await verify(f), { status: "PASS", groupId, groupNameSha256: hash(groupName) });
});

test("group info observer rejects bad output hashes, truncation and repeated JSON keys", () => {
  const f = fixture();
  expectInconclusive(() =>
    observeGroupInfoResult(f.assertion, {
      events: replaceOutput(f.events, f.events[1].data.outputHead, {
        outputSha256: "0".repeat(64),
      }),
      runId,
    }),
  );
  expectInconclusive(() =>
    observeGroupInfoResult(f.assertion, {
      events: replaceOutput(f.events, f.events[1].data.outputHead, { outputTruncated: true }),
      runId,
    }),
  );

  const duplicateDetails = `{"group_id":20001,"group_name":"${groupName}","member_count":8,"max_member_count":500,"provider_extension":"a","provider_extension":"b"}`;
  const repeatedHead = `{"content":[{"type":"text","text":${JSON.stringify(duplicateDetails)}}],"details":{"group_id":20001,"group_name":"${groupName}","member_count":8,"max_member_count":500,"provider_extension":"a","provider_extension":"b"}}`;
  expectInconclusive(() =>
    observeGroupInfoResult(f.assertion, { events: replaceOutput(f.events, repeatedHead), runId }),
  );
});

test("group info observer accepts trusted evidence for a UTF-8 truncated protected result", () => {
  const f = fixture();
  let result;
  let full;
  let head;
  for (let size = 300; size < 500; size += 1) {
    result = { ...providerResult(), provider_extension: `${"a".repeat(size)}中tail` };
    full = JSON.stringify({
      content: [{ type: "text", text: JSON.stringify(result) }],
      details: result,
    });
    head = Buffer.from(full, "utf8").subarray(0, 512).toString("utf8");
    if (Buffer.byteLength(head, "utf8") > 512) break;
  }
  assert.ok(Buffer.byteLength(full, "utf8") > 512);
  assert.ok(Buffer.byteLength(head, "utf8") > 512);
  assert.ok(Buffer.byteLength(head, "utf8") <= 514);
  const changed = structuredClone(f.events);
  Object.assign(changed[1].data, {
    outputHead: head,
    outputTruncated: true,
    outputBytes: Buffer.byteLength(full, "utf8"),
    outputSha256: hash(full),
  });
  assert.deepEqual(observeGroupInfoResult(f.assertion, { events: changed, runId }), f.observation);

  const baseEvidence = changed[1].data.groupInfo;
  for (const groupInfo of [
    undefined,
    { ...baseEvidence, groupId: "20002" },
    { ...baseEvidence, groupNameSha256: "not-a-hash" },
    { ...baseEvidence, memberCount: 501 },
    { ...baseEvidence, extra: "not allowed" },
  ]) {
    const invalidEvents = structuredClone(changed);
    if (groupInfo === undefined) delete invalidEvents[1].data.groupInfo;
    else invalidEvents[1].data.groupInfo = groupInfo;
    expectInconclusive(
      () => observeGroupInfoResult(f.assertion, { events: invalidEvents, runId }),
      null,
    );
  }
  for (const shortHead of ["", "short"]) {
    const invalidEvents = structuredClone(changed);
    invalidEvents[1].data.outputHead = shortHead;
    expectInconclusive(() => observeGroupInfoResult(f.assertion, { events: invalidEvents, runId }));
  }
});

test("group info observer rejects bad group, invalid name and unsafe count values", () => {
  const f = fixture();
  for (const result of [
    { ...providerResult(), group_id: 20002 },
    { ...providerResult(), group_name: "  " },
    { ...providerResult(), group_name: "x".repeat(513) },
    { ...providerResult(), member_count: -1 },
    { ...providerResult(), member_count: 501 },
    { ...providerResult(), max_member_count: Number.MAX_SAFE_INTEGER + 1 },
  ]) {
    const head = JSON.stringify({
      content: [{ type: "text", text: JSON.stringify(result) }],
      details: result,
    });
    expectInconclusive(() =>
      observeGroupInfoResult(f.assertion, { events: replaceOutput(f.events, head), runId }),
    );
  }
  assert.throws(() =>
    projectGroupInfo({ groupId, name: groupName, memberCount: 8, maxMemberCount: 500 }, groupId),
  );
  assert.throws(() =>
    projectGroupInfo(
      {
        groupId,
        groupNameSha256: hash(groupName),
        memberCount: 8,
        maxMemberCount: 500,
      },
      groupId,
    ),
  );
});

test("group info observer rejects duplicate activity, mismatched call ids and unsupported params", () => {
  const f = fixture();
  const duplicated = [...structuredClone(f.events), structuredClone(f.events[0])];
  expectInconclusive(() => observeGroupInfoResult(f.assertion, { events: duplicated, runId }));

  const wrongId = structuredClone(f.events);
  wrongId[1].toolCallId = "different-call";
  expectInconclusive(() => observeGroupInfoResult(f.assertion, { events: wrongId, runId }));

  const reversed = structuredClone(f.events).reverse();
  expectInconclusive(() => observeGroupInfoResult(f.assertion, { events: reversed, runId }));

  for (const params of [{ no_cache: true }, { cache: false }]) {
    const changed = fixture();
    changed.events[0].data.input.params = params;
    expectInconclusive(() =>
      observeGroupInfoResult(changed.assertion, { events: changed.events, runId }),
    );
  }
});

test("group info verifier rejects removed assertions, cross-group calls and provider mismatch or failure", async () => {
  const f = fixture();
  await assert.rejects(
    verify(f, { c: { ...f.c, featureAssertions: [f.c.featureAssertions[0]] } }),
    (error) => error.code === "GROUP_INFO_SCOPE" && error.status === "INCONCLUSIVE",
  );

  await assert.rejects(
    verify(f, { c: { ...f.c, featureAssertions: [f.c.featureAssertions[1]] } }),
    (error) => error.code === "GROUP_INFO_SCOPE" && error.status === "INCONCLUSIVE",
  );

  const otherGroup = fixture();
  otherGroup.events[0].data.input.groupId = "20002";
  await assert.rejects(
    verify(otherGroup),
    (error) => error.code === "GROUP_INFO_SCOPE" && error.status === "INCONCLUSIVE",
  );

  await assert.rejects(
    verify(f, {
      clients: {
        bot: {
          readGroupInfo: async () => ({
            ...projectGroupInfo(providerResult(), groupId),
            groupId: "20002",
          }),
        },
      },
    }),
    (error) => error.code === "GROUP_INFO_MISMATCH" && error.status === "INCONCLUSIVE",
  );
  await assert.rejects(
    verify(f, {
      clients: {
        bot: {
          readGroupInfo: async () => {
            throw new Error(groupName);
          },
        },
      },
    }),
    (error) =>
      error.code === "GROUP_INFO_UNAVAILABLE" &&
      error.status === "INCONCLUSIVE" &&
      !error.message.includes(groupName),
  );
});

test("group info verifier rejects changed safe projection", async () => {
  const f = fixture();
  await assert.rejects(
    verify(f, {
      feature: {
        observations: f.feature.observations.map((item) =>
          item.kind === "group_info" ? { ...item, memberCount: 9 } : item,
        ),
      },
    }),
    (error) => error.code === "GROUP_INFO_OBSERVATION" && error.status === "INCONCLUSIVE",
  );

  await assert.rejects(
    verify(f, {
      clients: {
        bot: {
          readGroupInfo: async () =>
            projectGroupInfo({ ...providerResult(), member_count: 9 }, groupId),
        },
      },
    }),
    (error) => error.code === "GROUP_INFO_MISMATCH" && error.status === "INCONCLUSIVE",
  );

  await assert.rejects(
    verify(f, { witness: undefined }),
    (error) => error.code === "GROUP_INFO_REPLY" && error.status === "INCONCLUSIVE",
  );
  await assert.rejects(
    verify(f, { witness: { memberCount: 9, maxMemberCount: 500 } }),
    (error) => error.code === "GROUP_INFO_REPLY" && error.status === "INCONCLUSIVE",
  );
});
