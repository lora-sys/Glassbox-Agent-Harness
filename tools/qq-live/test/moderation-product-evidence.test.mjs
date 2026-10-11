import test from "node:test";
import assert from "node:assert/strict";
import { digest, toolManifestDigest } from "../lib/core.mjs";
import { moderationStep, MODERATION_GROUP_B_ID } from "../lib/moderation-scenario.mjs";
import {
  verifyModerationAuthorizationEvidence,
  verifyModerationTraceRun,
} from "../lib/moderation-product-evidence.mjs";

const principalId = "owner-principal";
const runId = "run-mute-1";
const caseRecord = {
  token: "1234567890abcdef1234567890abcdef",
  startedAt: new Date(Date.now() - 5_000).toISOString(),
  moderationExpectedMuteUntil: 0,
  acceptanceLease: {
    leaseId: "12345678-1234-4123-8123-123456789012",
    toolsSha256: "a".repeat(64),
  },
};
const fixed = {
  groupId: MODERATION_GROUP_B_ID,
  target: "1126000001",
  durationSeconds: 45,
  expectedMuteUntil: 0,
};

function eventSet({ stage = "mute", expectedMuteUntil = 0 } = {}) {
  const stageFixed = { ...fixed, expectedMuteUntil };
  const expectedToolsSha256 = toolManifestDigest(moderationStep(stage, stageFixed).leaseTools);
  caseRecord.startedAt = new Date(Date.now() - 5_000).toISOString();
  caseRecord.moderationExpectedMuteUntil = expectedMuteUntil;
  const input = {
    groupId: fixed.groupId,
    operation: "set_group_ban",
    params: {
      user_id: Number(fixed.target),
      duration: stage === "mute" ? fixed.durationSeconds : 0,
    },
  };
  const lease = {
    leaseId: caseRecord.acceptanceLease.leaseId,
    marker: caseRecord.token,
    toolsSha256: expectedToolsSha256,
    narrowedTools: ["qq_group_moderation"],
  };
  const decision = (id) => ({
    id,
    action: "group:moderate",
    decision: "ALLOW",
  });
  const row = (id) => ({
    id,
    principal_id: principalId,
    resource_id: `group:${fixed.groupId}`,
    action: "group:moderate",
    scope_key: "fixed-owner-private-scope",
    decision: "ALLOW",
    delivery_source: null,
    grant_id: "grant-moderate-b",
    grant_effective: true,
  });
  const evidence = {
    runId,
    principalId,
    conversationId: "owner-private-conversation",
    scopeKey: "fixed-owner-private-scope",
    policyState: { grantId: "grant-moderate-b", policyVersion: 7 },
    config: {},
    decisions: [decision("decision-select"), decision("decision-execute")],
    authorizationRows: [row("decision-select"), row("decision-execute")],
  };
  const events = [
    {
      runId,
      principalId,
      type: "session_start",
      data: {
        runId,
        principalId,
        acceptanceLease: lease,
        authorizedTools: ["qq_group_moderation"],
      },
    },
    {
      runId,
      principalId,
      toolCallId: "tool-call-1",
      type: "tool_call",
      data: {
        runId,
        principalId,
        toolCallId: "tool-call-1",
        name: "qq_group_moderation",
        // The production Trace bounds the visible call input and omits nested params.
        input: { groupId: fixed.groupId, operation: input.operation },
      },
    },
    {
      runId,
      principalId,
      toolCallId: "tool-call-1",
      type: "tool_result",
      data: {
        runId,
        principalId,
        toolCallId: "tool-call-1",
        name: "qq_group_moderation",
        isError: false,
      },
    },
  ];
  events.splice(2, 0, {
    type: "native_mute_state_precondition_verified",
    runId,
    conversationId: evidence.conversationId,
    principalId,
    resourceId: `group:${fixed.groupId}`,
    leaseId: caseRecord.acceptanceLease.leaseId,
    phase: stage,
    expectedMuteUntil,
  });
  const providerInput = {
    group_id: Number(fixed.groupId),
    user_id: Number(fixed.target),
    duration: stage === "mute" ? fixed.durationSeconds : 0,
  };
  const canonicalInput = JSON.stringify(
    Object.fromEntries(Object.entries(providerInput).sort(([a], [b]) => a.localeCompare(b))),
  );
  events.splice(3, 0, {
    type: "qq_tool_execution_input_verified",
    runId,
    conversationId: evidence.conversationId,
    principalId,
    toolCallId: "tool-call-1",
    toolName: "qq_group_moderation",
    leaseId: caseRecord.acceptanceLease.leaseId,
    action: "set_group_ban",
    resourceId: `group:${fixed.groupId}`,
    inputSha256: digest(Buffer.from(canonicalInput, "utf8")),
    inputBytes: Buffer.byteLength(canonicalInput, "utf8"),
  });
  caseRecord.acceptanceLease.toolsSha256 = expectedToolsSha256;
  return { events, evidence, decision, row, stage };
}

function verify(events, evidence, stage = "mute") {
  const base = Date.now();
  const traceEntries = events.map((event, index) => ({
    event,
    ts: new Date(base + index * 1_000).toISOString(),
  }));
  return verifyModerationTraceRun(events, caseRecord, fixed, evidence, stage, traceEntries);
}

function ownerAuthorizationFixture() {
  const startedAt = new Date(Date.now() - 5_000).toISOString();
  const config = {
    timeoutMs: 5_000,
    bot: { qq: "3394947361" },
    driver: { qq: "3526039967" },
    groups: [{ alias: "B", id: MODERATION_GROUP_B_ID }],
    moderation: {
      enabled: true,
      group: "B",
      target: fixed.target,
      durationSeconds: 30,
      authorizationBasis: "group-owner-request",
      ownerAuthorizationConfirmed: true,
      ownerAuthorizationAt: new Date(Date.parse(startedAt) - 1_000).toISOString(),
      ownerAuthorizationUntil: new Date(Date.parse(startedAt) + 60 * 60_000).toISOString(),
    },
  };
  return {
    config,
    fixed: { ...fixed, durationSeconds: 30 },
    caseRecord: {
      startedAt,
      moderationTarget: fixed.target,
      moderationGroupId: MODERATION_GROUP_B_ID,
      moderationAuthorizationBasis: "group-owner-request",
      moderationOwnerAuthorization: {
        ownerId: config.driver.qq,
        confirmed: true,
        authorizedAt: config.moderation.ownerAuthorizationAt,
        validUntil: config.moderation.ownerAuthorizationUntil,
      },
    },
  };
}

test("owner-request product proof revalidates the bound authorization and native owner role", async () => {
  const { config, fixed: ownerFixed, caseRecord } = ownerAuthorizationFixture();
  let calls = 0;
  const proof = await verifyModerationAuthorizationEvidence({
    caseRecord,
    config,
    fixed: ownerFixed,
    clients: {
      bot: {
        async call(method, input) {
          calls += 1;
          assert.equal(method, "get_group_member_info");
          assert.deepEqual(input, {
            group_id: MODERATION_GROUP_B_ID,
            user_id: Number(config.driver.qq),
            no_cache: true,
          });
          return {
            group_id: MODERATION_GROUP_B_ID,
            user_id: config.driver.qq,
            role: "owner",
          };
        },
      },
    },
  });
  assert.equal(calls, 1);
  assert.deepEqual(proof, {
    authorizationProof: {
      basis: "group-owner-request",
      ownerId: config.driver.qq,
      authorizedAt: config.moderation.ownerAuthorizationAt,
      validUntil: config.moderation.ownerAuthorizationUntil,
      targetSha256: digest(ownerFixed.target),
    },
    roleProof: { status: "NATIVE_GROUP_OWNER_VERIFIED", role: "owner" },
  });
});

test("owner-request product proof rejects missing or mismatched case binding and non-owner role", async () => {
  const { config, fixed: ownerFixed, caseRecord } = ownerAuthorizationFixture();
  for (const mutate of [
    (record) => delete record.moderationAuthorizationBasis,
    (record) => (record.moderationOwnerAuthorization.ownerId = "3394947361"),
    (record) => (record.moderationTarget = "1126000002"),
  ]) {
    const malformed = structuredClone(caseRecord);
    mutate(malformed);
    await assert.rejects(
      verifyModerationAuthorizationEvidence({
        caseRecord: malformed,
        config,
        fixed: ownerFixed,
        clients: { bot: { call: async () => ({ role: "owner" }) } },
      }),
      { code: "MODERATION_AUTHORIZATION_BINDING" },
    );
  }
  await assert.rejects(
    verifyModerationAuthorizationEvidence({
      caseRecord,
      config,
      fixed: ownerFixed,
      clients: {
        bot: {
          call: async () => ({
            group_id: MODERATION_GROUP_B_ID,
            user_id: config.driver.qq,
            role: "admin",
          }),
        },
      },
    }),
    { code: "MODERATION_OWNER_ROLE_EVIDENCE" },
  );
});

test("member-consent product proof keeps its old case shape and does not require owner role", async () => {
  const startedAt = new Date(Date.now() - 5_000).toISOString();
  const config = {
    timeoutMs: 5_000,
    bot: { qq: "3394947361" },
    driver: { qq: "3526039967" },
    groups: [{ alias: "B", id: MODERATION_GROUP_B_ID }],
    moderation: {
      enabled: true,
      group: "B",
      target: fixed.target,
      durationSeconds: 45,
      consentConfirmed: true,
      consentConfirmedAt: new Date(Date.parse(startedAt) - 1_000).toISOString(),
      consentUntil: new Date(Date.parse(startedAt) + 60 * 60_000).toISOString(),
    },
  };
  const caseRecord = {
    startedAt,
    moderationTarget: fixed.target,
    moderationGroupId: MODERATION_GROUP_B_ID,
  };
  let called = false;
  const result = await verifyModerationAuthorizationEvidence({
    caseRecord,
    config,
    fixed,
    clients: {
      bot: {
        call: async () => {
          called = true;
        },
      },
    },
  });
  assert.equal(result, undefined);
  assert.equal(called, false);
});

test("moderation trace proof accepts the bounded call input and witness-bound provider input", () => {
  const { events, evidence } = eventSet();
  assert.deepEqual(events[1].data.input, {
    groupId: fixed.groupId,
    operation: "set_group_ban",
  });
  const result = verify(events, evidence);
  assert.equal(result.status, "MODERATION_TRACE_VERIFIED");
  assert.equal(result.authorizationCount, 2);
});

test("moderation trace proof rejects altered inputs, duplicate calls and mismatched actor bindings", () => {
  for (const [mutate, code] of [
    [
      (events) => {
        events[1].data.input.unexpected = true;
      },
      "MODERATION_TOOL_TRACE",
    ],
    [
      (events) => {
        events.push(structuredClone(events[1]));
      },
      "MODERATION_TOOL_TRACE",
    ],
    [
      (events) => {
        events[3].toolCallId = "other-call";
      },
      "MODERATION_PRECONDITION_WITNESS",
    ],
    [
      (events) => {
        events[1].data.principalId = "other-principal";
      },
      "MODERATION_TOOL_TRACE",
    ],
    [
      (events) => {
        events[0].data.acceptanceLease.marker = "other-marker";
      },
      "MODERATION_LEASE_TRACE",
    ],
    [
      (events) => {
        events[0].data.authorizedTools = ["qq_group_members"];
      },
      "MODERATION_LEASE_TRACE",
    ],
  ]) {
    const { events, evidence } = eventSet();
    mutate(events);
    assert.throws(() => verify(events, evidence), {
      code,
    });
  }
});

test("moderation input witness is exact, bound to the native check, and ordered before the result", () => {
  for (const mutate of [
    (events) => events.splice(3, 1),
    (events) => events.splice(4, 0, structuredClone(events[3])),
    (events) => (events[3].inputSha256 = "0".repeat(64)),
    (events) => (events[3].leaseId = "another-lease"),
    (events) => (events[3].toolCallId = "another-call"),
    (events) => (events[3].resourceId = "group:another"),
    (events) => events.push(events.splice(3, 1)[0]),
  ]) {
    const { events, evidence } = eventSet();
    mutate(events);
    assert.throws(() => verify(events, evidence), {
      code: "MODERATION_PRECONDITION_WITNESS",
    });
  }
});

test("strict lease proof rejects a manifest missing the native mute-state precondition", () => {
  const { events, evidence } = eventSet();
  const withoutPrecondition = structuredClone(moderationStep("mute", fixed).leaseTools);
  delete withoutPrecondition[0].operations[0].nativeMuteState;
  const weakenedSha256 = toolManifestDigest(withoutPrecondition);
  caseRecord.acceptanceLease.toolsSha256 = weakenedSha256;
  events[0].data.acceptanceLease.toolsSha256 = weakenedSha256;
  assert.throws(() => verify(events, evidence), {
    code: "MODERATION_LEASE_TRACE",
  });
});

test("precondition witness is unique, exact, and between the fixed call and result", () => {
  const mutations = [
    (events) => events.splice(2, 1),
    (events) => events.splice(3, 0, structuredClone(events[2])),
    (events) => (events[2].leaseId = "another-lease"),
    (events) => (events[2].phase = "unmute"),
    (events) => (events[2].conversationId = "another-conversation"),
    (events) => events.splice(1, 0, events.splice(2, 1)[0]),
    (events) => events.push(events.splice(2, 1)[0]),
  ];
  for (const mutate of mutations) {
    const { events, evidence } = eventSet();
    mutate(events);
    assert.throws(() => verify(events, evidence), {
      code: "MODERATION_PRECONDITION_WITNESS",
    });
  }
});

test("expired unmute precondition is rejected at the witness Trace time", () => {
  const expectedMuteUntil = Math.floor(Date.now() / 1000) + 1;
  const { events, evidence } = eventSet({ stage: "unmute", expectedMuteUntil });
  assert.throws(() => verify(events, evidence, "unmute"), {
    code: "MODERATION_PRECONDITION_WITNESS",
  });
});

test("moderation trace proof rejects denied, wrong-scope and detached authorization rows", () => {
  for (const mutate of [
    (evidence) => {
      evidence.decisions[0].decision = "DENY";
    },
    (evidence) => {
      evidence.authorizationRows[0].scope_key = "another-scope";
    },
    (evidence) => {
      evidence.authorizationRows[0].id = "detached-decision";
    },
    (evidence) => {
      evidence.authorizationRows[0].grant_effective = false;
    },
  ]) {
    const { events, evidence } = eventSet();
    mutate(evidence);
    assert.throws(() => verify(events, evidence), {
      code: "MODERATION_AUTHORIZATION",
    });
  }
});

test("moderation trace proof requires result after the same exact call", () => {
  const { events, evidence } = eventSet();
  [events[1], events[4]] = [events[4], events[1]];
  assert.throws(() => verify(events, evidence), {
    code: "MODERATION_TOOL_TRACE",
  });
});
