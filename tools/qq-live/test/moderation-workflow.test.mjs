import test from "node:test";
import assert from "node:assert/strict";
import { Recorder } from "../lib/runner.mjs";
import { baseConfig } from "./fixture.mjs";
import { runModerationWorkflow } from "../lib/moderation-workflow.mjs";
import { MODERATION_GROUP_B_ID } from "../lib/moderation-scenario.mjs";
import { digest, toolManifestDigest } from "../lib/core.mjs";

function harness({
  botRole = "admin",
  failUnmute = false,
  policyDrift = false,
  driftBeforeUnmute = false,
  omitMuteStatePrecondition = false,
  ownerRequest = false,
  ownerRole = "owner",
  delayUnmuteNoticeMs = 0,
  omitUnmuteNotice = false,
} = {}) {
  const config = baseConfig();
  config.groups[1].id = MODERATION_GROUP_B_ID;
  config.moderation.group = "B";
  config.moderation.consentConfirmedAt = new Date().toISOString();
  config.moderation.consentUntil = new Date(Date.now() + 60 * 60_000).toISOString();
  if (ownerRequest) {
    config.driver.qq = "3526039967";
    Object.assign(config.moderation, {
      authorizationBasis: "group-owner-request",
      ownerAuthorizationConfirmed: true,
      ownerAuthorizationAt: new Date().toISOString(),
      ownerAuthorizationUntil: new Date(Date.now() + 60 * 60_000).toISOString(),
      consentConfirmed: false,
      consentConfirmedAt: "",
      consentUntil: "",
      durationSeconds: 30,
    });
  }
  let currentOwnerRole = ownerRole;
  let ownerRoleReads = 0;
  const runtime = {
    checkout: "/fixture",
    dataDirectory: "/fixture-data",
    commit: "a".repeat(40),
    pid: 77,
    connectionId: "qq-main",
  };
  let mutedUntil = 0;
  let policyReads = 0;
  const clients = {
    driver: {
      async call(action, args) {
        assert.equal(action, "get_group_member_info");
        assert.equal(String(args.group_id), MODERATION_GROUP_B_ID);
        return {
          group_id: MODERATION_GROUP_B_ID,
          user_id: config.moderation.target,
          role: "member",
          shut_up_timestamp: mutedUntil,
        };
      },
    },
    bot: {
      async call(action, args) {
        assert.equal(action, "get_group_member_info");
        assert.equal(String(args.group_id), MODERATION_GROUP_B_ID);
        const userId = String(args.user_id);
        if (userId === config.driver.qq) ownerRoleReads++;
        return {
          group_id: MODERATION_GROUP_B_ID,
          user_id: userId,
          role:
            userId === config.bot.qq
              ? botRole
              : userId === config.driver.qq
                ? currentOwnerRole
                : "member",
          ...(userId === config.moderation.target ? { shut_up_timestamp: mutedUntil } : {}),
        };
      },
    },
  };
  const recorder = new Recorder(config);
  const leases = [];
  const checkpoints = [];
  let sendAttempts = 0;
  const acceptance = {
    async register(_config, c, tools) {
      const registeredTools = structuredClone(tools);
      if (omitMuteStatePrecondition) delete registeredTools[0].operations[0].nativeMuteState;
      const lease = {
        leaseId: `${String(leases.length + 1).padStart(8, "0")}-0000-4000-8000-000000000000`,
        expiresAt: Date.now() + 60_000,
        toolsSha256: toolManifestDigest(registeredTools),
      };
      leases.push({ c, tools: registeredTools, lease });
      return lease;
    },
    async revoke(id) {
      assert.equal(id, leases.at(-1).lease.leaseId);
      return { active: false, revoked: true };
    },
  };
  const readPolicyState = async () => {
    policyReads++;
    return {
      connectionId: runtime.connectionId,
      groupId: MODERATION_GROUP_B_ID,
      principalId: "owner-principal",
      scopeKey: "scope",
      policyVersion: policyDrift && policyReads > 6 ? 2 : 1,
      policyUpdatedAt: "2026-10-08T00:00:00.000Z",
      moderationEnabled: true,
      grantId: "group-moderate-grant",
      grantCreatedAt: "2026-10-07T00:00:00.000Z",
    };
  };
  const send = async (_config, _clients, record, spec, _signal, hooks) => {
    if (driftBeforeUnmute && spec.moderationStage === "unmute") mutedUntil += 1;
    const token = String(record.cases.length + 1).padStart(32, "0");
    const c = record.begin(
      spec.id,
      "private",
      `GLASSBOX_ACCEPTANCE_V1 ${token}\n${spec.prompt}`,
      [],
      token,
    );
    c.featureAssertions = [];
    await hooks.beforeRegister(c);
    c.leaseRegistrationAttempted = true;
    const lease = await acceptance.register(config, c, spec.leaseTools);
    c.acceptanceLease = lease;
    await hooks.beforeSend(c, lease);
    sendAttempts += 1;
    c.sentMessageId = `${record.cases.length + 101}`;
    await hooks.afterSend(c);
    const now = Math.floor(Date.now() / 1000);
    const isMute = spec.moderationStage === "mute";
    const notice = {
      groupId: MODERATION_GROUP_B_ID,
      userId: config.moderation.target,
      operatorId: config.bot.qq,
      subtype: isMute ? "ban" : "lift_ban",
      receivedMs: Date.now(),
      serverTime: now,
      duration: isMute ? config.moderation.durationSeconds : 0,
    };
    const ingestNotice = () =>
      record.ingest("driver", {
        self_id: config.driver.qq,
        post_type: "notice",
        notice_type: "group_ban",
        group_id: notice.groupId,
        user_id: notice.userId,
        operator_id: notice.operatorId,
        sub_type: notice.subtype,
        time: notice.serverTime,
        duration: notice.duration,
      });
    if (isMute || !omitUnmuteNotice) {
      if (!isMute && delayUnmuteNoticeMs > 0) setTimeout(ingestNotice, delayUnmuteNoticeMs);
      else ingestNotice();
    }
    mutedUntil = isMute && !failUnmute ? now + config.moderation.durationSeconds : 0;
    if (isMute) mutedUntil = now + config.moderation.durationSeconds;
    if (!isMute && failUnmute) mutedUntil = now + config.moderation.durationSeconds;
    c.status = "PASS";
    c.code = "REAL_REPLY_RECEIVED";
    c.leaseRevoked = true;
    c.finishedAt = new Date().toISOString();
    return c;
  };
  return {
    config,
    clients,
    recorder,
    acceptance,
    runtime,
    leases,
    get sendAttempts() {
      return sendAttempts;
    },
    checkpoints,
    readPolicyState,
    setOwnerRole(role) {
      currentOwnerRole = role;
    },
    get ownerRoleReads() {
      return ownerRoleReads;
    },
    send,
    checkpoint: async (row) => {
      checkpoints.push(structuredClone(row));
      return true;
    },
  };
}

test("moderation executes two ordered messages with separate exact leases and revocation", async () => {
  const h = harness({ ownerRole: "admin" });
  const result = await runModerationWorkflow({
    config: h.config,
    clients: h.clients,
    recorder: h.recorder,
    acceptance: h.acceptance,
    checkpoint: h.checkpoint,
    readPolicyState: h.readPolicyState,
    verifyStep: async ({ stage }) => ({
      runId: `run-${stage}`,
      principalId: "owner-principal",
      policyProof: { status: "MODERATION_POLICY_ENABLED" },
      authorizationProof: { status: "GROUP_MODERATE_ALLOWED" },
      traceProof: { status: "MODERATION_TRACE_VERIFIED" },
      leaseProof: { status: "LEASE_REVOKED" },
      messageBinding: { status: "MESSAGE_BOUND" },
    }),
    readRuntime: async () => h.runtime,
    expectedRuntime: h.runtime,
    send: h.send,
  });
  assert.equal(result.status, "MODERATION_WORKFLOW_VERIFIED");
  assert.deepEqual(
    result.steps.map((step) => step.stage),
    ["mute", "unmute"],
  );
  assert.deepEqual(
    h.leases.map((row) => row.tools[0].operations[0].inputConstraint.params),
    [
      { user_id: 10003, duration: 60 },
      { user_id: 10003, duration: 0 },
    ],
  );
  assert.deepEqual(
    h.leases.map((row) => row.tools[0].operations[0].nativeMuteState),
    [
      { kind: "qq-member-mute-state", phase: "mute", expectedMuteUntil: 0 },
      {
        kind: "qq-member-mute-state",
        phase: "unmute",
        expectedMuteUntil: result.steps[0].proof.targetShutUpUntil,
      },
    ],
  );
  assert.equal(
    result.steps[1].proof.mutationPrecondition.expectedMuteUntil,
    result.steps[0].proof.targetShutUpUntil,
  );
  assert.equal(h.checkpoints.length, 10);
  assert.deepEqual(
    h.checkpoints.filter((row) => row.phase === "intent").map((row) => row.mutationPrecondition),
    h.leases.map((row) => row.tools[0].operations[0].nativeMuteState),
  );
  const prepared = h.checkpoints.filter((row) => row.phase === "prepared");
  assert.equal(prepared.length, 2);
  assert.deepEqual(
    prepared.map((row) => row.prepared.promptSha256),
    h.recorder.cases.map((row) => digest(row.prompt)),
  );
  assert.ok(prepared.every((row) => !Object.hasOwn(row.prepared, "prompt")));
  assert.equal(result.cleanupVerified, true);
  assert.equal(result.actualQqDeliveryVerified, true);
});

test("an older server lease hash without the mute-state guard blocks before the message send", async () => {
  const h = harness({ omitMuteStatePrecondition: true });
  const result = await runModerationWorkflow({
    config: h.config,
    clients: h.clients,
    recorder: h.recorder,
    acceptance: h.acceptance,
    checkpoint: h.checkpoint,
    readPolicyState: h.readPolicyState,
    verifyStep: async () => assert.fail("must not verify a Run"),
    readRuntime: async () => h.runtime,
    expectedRuntime: h.runtime,
    send: h.send,
  });
  assert.equal(result.status, "INCONCLUSIVE");
  assert.equal(result.error.code, "MODERATION_LEASE_MANIFEST");
  assert.equal(result.requiresReconciliation, true);
  assert.equal(h.leases.length, 1);
  assert.equal(h.sendAttempts, 0);
  assert.equal(h.recorder.cases.length, 1);
  assert.equal(h.recorder.cases[0].sentMessageId, undefined);
});

test("missing Bot administrator role stops before lease or message", async () => {
  const h = harness({ botRole: "member" });
  const result = await runModerationWorkflow({
    config: h.config,
    clients: h.clients,
    recorder: h.recorder,
    acceptance: h.acceptance,
    checkpoint: h.checkpoint,
    readPolicyState: h.readPolicyState,
    verifyStep: async () => assert.fail("must not verify a Run"),
    readRuntime: async () => h.runtime,
    expectedRuntime: h.runtime,
    send: h.send,
  });
  assert.equal(result.status, "INCONCLUSIVE");
  assert.equal(result.error.code, "MODERATION_ROLE");
  assert.equal(result.requiresReconciliation, false);
  assert.equal(h.leases.length, 0);
  assert.equal(h.recorder.cases.length, 0);
});

test("policy drift before unmute leaves a pending state and does not retry", async () => {
  const h = harness({ policyDrift: true });
  const result = await runModerationWorkflow({
    config: h.config,
    clients: h.clients,
    recorder: h.recorder,
    acceptance: h.acceptance,
    checkpoint: h.checkpoint,
    readPolicyState: h.readPolicyState,
    verifyStep: async ({ stage }) => ({
      runId: `run-${stage}`,
      principalId: "owner-principal",
      policyProof: {},
      authorizationProof: {},
      traceProof: {},
      leaseProof: {},
      messageBinding: {},
    }),
    readRuntime: async () => h.runtime,
    expectedRuntime: h.runtime,
    send: h.send,
  });
  assert.equal(result.status, "INCONCLUSIVE");
  assert.equal(result.requiresReconciliation, true);
  assert.equal(h.recorder.cases.length, 1);
  assert.equal(h.sendAttempts, 1);
  assert.equal(h.leases.length, 1);
});

test("changed mute state before unmute stops before creating the second lease", async () => {
  const h = harness({ driftBeforeUnmute: true });
  const result = await runModerationWorkflow({
    config: h.config,
    clients: h.clients,
    recorder: h.recorder,
    acceptance: h.acceptance,
    checkpoint: h.checkpoint,
    readPolicyState: h.readPolicyState,
    verifyStep: async ({ stage }) => ({
      runId: `run-${stage}`,
      principalId: "owner-principal",
      policyProof: {},
      authorizationProof: {},
      traceProof: {},
      leaseProof: {},
      messageBinding: {},
    }),
    readRuntime: async () => h.runtime,
    expectedRuntime: h.runtime,
    send: h.send,
  });
  assert.equal(result.status, "INCONCLUSIVE");
  assert.equal(result.error.code, "MODERATION_TARGET_STATE_CHANGED");
  assert.equal(result.requiresReconciliation, true);
  assert.equal(h.recorder.cases.length, 2);
  assert.equal(h.recorder.cases[1].sentMessageId, undefined);
  assert.equal(h.sendAttempts, 1);
  assert.equal(h.leases.length, 1);
});

test("group-owner authorization runs two exact 30 second stages with owner role independently read", async () => {
  const h = harness({ ownerRequest: true });
  const result = await runModerationWorkflow({
    config: h.config,
    clients: h.clients,
    recorder: h.recorder,
    acceptance: h.acceptance,
    checkpoint: h.checkpoint,
    readPolicyState: h.readPolicyState,
    verifyStep: async ({ stage }) => ({
      runId: `run-${stage}`,
      principalId: "owner-principal",
      policyProof: {},
      authorizationProof: {},
      traceProof: {},
      leaseProof: {},
      messageBinding: {},
    }),
    readRuntime: async () => h.runtime,
    expectedRuntime: h.runtime,
    send: h.send,
  });
  assert.equal(result.status, "MODERATION_WORKFLOW_VERIFIED");
  assert.equal(h.sendAttempts, 2);
  assert.ok(h.ownerRoleReads >= 2);
  assert.ok(result.steps.every((step) => step.proof.roleProof.ownerRole === "owner"));
  assert.deepEqual(
    h.leases.map((row) => row.tools[0].operations[0].inputConstraint.params.duration),
    [30, 0],
  );
});

test("group-owner request blocks before lease when native driver role is not owner", async () => {
  const h = harness({ ownerRequest: true, ownerRole: "admin" });
  const result = await runModerationWorkflow({
    config: h.config,
    clients: h.clients,
    recorder: h.recorder,
    acceptance: h.acceptance,
    checkpoint: h.checkpoint,
    readPolicyState: h.readPolicyState,
    verifyStep: async () => assert.fail("must not verify a Run"),
    readRuntime: async () => h.runtime,
    expectedRuntime: h.runtime,
    send: h.send,
  });
  assert.equal(result.status, "INCONCLUSIVE");
  assert.equal(result.error.code, "MODERATION_ROLE");
  assert.equal(h.leases.length, 0);
  assert.equal(h.sendAttempts, 0);
});

test("group-owner role is rechecked before unmute and a changed role stops without a second send", async () => {
  const h = harness({ ownerRequest: true });
  const send = async (...args) => {
    if (args[3]?.moderationStage === "unmute") h.setOwnerRole("admin");
    return h.send(...args);
  };
  const result = await runModerationWorkflow({
    config: h.config,
    clients: h.clients,
    recorder: h.recorder,
    acceptance: h.acceptance,
    checkpoint: h.checkpoint,
    readPolicyState: h.readPolicyState,
    verifyStep: async ({ stage }) => ({
      runId: `run-${stage}`,
      principalId: "owner-principal",
      policyProof: {},
      authorizationProof: {},
      traceProof: {},
      leaseProof: {},
      messageBinding: {},
    }),
    readRuntime: async () => h.runtime,
    expectedRuntime: h.runtime,
    send,
  });
  assert.equal(result.status, "INCONCLUSIVE");
  assert.equal(result.error.code, "MODERATION_ROLE");
  assert.equal(h.sendAttempts, 1);
  assert.equal(h.leases.length, 1);
});

test("group-owner authorization expiry during mute stops before the unmute Run", async () => {
  const h = harness({ ownerRequest: true });
  const result = await runModerationWorkflow({
    config: h.config,
    clients: h.clients,
    recorder: h.recorder,
    acceptance: h.acceptance,
    checkpoint: h.checkpoint,
    readPolicyState: h.readPolicyState,
    verifyStep: async ({ stage }) => {
      if (stage === "mute")
        h.config.moderation.ownerAuthorizationUntil = new Date(Date.now() + 1000).toISOString();
      return {
        runId: `run-${stage}`,
        principalId: "owner-principal",
        policyProof: {},
        authorizationProof: {},
        traceProof: {},
        leaseProof: {},
        messageBinding: {},
      };
    },
    readRuntime: async () => h.runtime,
    expectedRuntime: h.runtime,
    send: h.send,
  });
  assert.equal(result.status, "INCONCLUSIVE");
  assert.equal(result.error.code, "OWNER_AUTHORIZATION_REQUIRED");
  assert.equal(h.sendAttempts, 1);
  assert.equal(h.leases.length, 1);
});

test("unmute waits for a delayed Bot lift notice while both account reads show unmuted", async () => {
  const h = harness({ delayUnmuteNoticeMs: 100 });
  const result = await runModerationWorkflow({
    config: h.config,
    clients: h.clients,
    recorder: h.recorder,
    acceptance: h.acceptance,
    checkpoint: h.checkpoint,
    readPolicyState: h.readPolicyState,
    verifyStep: async ({ stage }) => ({
      runId: `run-${stage}`,
      principalId: "owner-principal",
      policyProof: {},
      authorizationProof: {},
      traceProof: {},
      leaseProof: {},
      messageBinding: {},
    }),
    readRuntime: async () => h.runtime,
    expectedRuntime: h.runtime,
    send: h.send,
  });
  assert.equal(result.status, "MODERATION_WORKFLOW_VERIFIED");
  assert.equal(result.steps[1].proof.notice.subtype, "lift_ban");
});

test("unmute without a Bot lift notice stays inconclusive instead of throwing", async () => {
  const h = harness({ omitUnmuteNotice: true });
  const result = await runModerationWorkflow({
    config: h.config,
    clients: h.clients,
    recorder: h.recorder,
    acceptance: h.acceptance,
    checkpoint: h.checkpoint,
    readPolicyState: h.readPolicyState,
    verifyStep: async ({ stage }) => ({
      runId: `run-${stage}`,
      principalId: "owner-principal",
      policyProof: {},
      authorizationProof: {},
      traceProof: {},
      leaseProof: {},
      messageBinding: {},
    }),
    readRuntime: async () => h.runtime,
    expectedRuntime: h.runtime,
    send: h.send,
  });
  assert.equal(result.status, "INCONCLUSIVE");
  assert.equal(result.error.code, "LIFT_EFFECT_UNCONFIRMED");
  assert.equal(result.requiresReconciliation, true);
  assert.equal(h.sendAttempts, 2);
});

test("private moderation observes only the configured group and target until native observation closes", () => {
  const config = baseConfig();
  const recorder = new Recorder(config);
  const c = recorder.begin("moderation-mute", "private", "mute request", []);
  Object.assign(c, {
    moderation: true,
    moderationGroupId: MODERATION_GROUP_B_ID,
    moderationTarget: config.moderation.target,
    moderationObservationActive: true,
    finishedAt: new Date().toISOString(),
  });
  const event = {
    self_id: config.driver.qq,
    post_type: "notice",
    notice_type: "group_ban",
    group_id: MODERATION_GROUP_B_ID,
    user_id: config.moderation.target,
    operator_id: config.bot.qq,
    sub_type: "ban",
    time: Math.floor(Date.now() / 1000),
    duration: 30,
  };
  recorder.ingest("driver", { ...event, group_id: "99999" });
  recorder.ingest("driver", { ...event, user_id: "99999" });
  recorder.ingest("driver", { ...event, self_id: "99999" });
  recorder.ingest("driver", { ...event, time: Math.floor(c.startedMs / 1000) - 2 });
  assert.equal(c.notices.length, 0);
  recorder.ingest("driver", event);
  assert.equal(c.notices.length, 1);
  c.moderationObservationActive = false;
  recorder.ingest("driver", { ...event, sub_type: "lift_ban", duration: 0 });
  assert.equal(c.notices.length, 1);
});
