import test from "node:test";
import assert from "node:assert/strict";
import { baseConfig } from "./fixture.mjs";
import { validateModeration } from "../lib/core.mjs";
import {
  MODERATION_FAMILY_ID,
  MODERATION_GROUP_B_ID,
  moderationPlan,
  moderationStep,
  resolveModerationCli,
} from "../lib/moderation-scenario.mjs";

function config() {
  const value = baseConfig();
  value.groups[1].id = MODERATION_GROUP_B_ID;
  value.runtime = {
    checkout: "/tmp/glassbox-moderation-fixture",
    dataDirectory: "/tmp/glassbox-moderation-fixture-data",
    expectedCommit: "a".repeat(40),
    connectionId: "qq-main",
  };
  value.moderation.group = "B";
  value.moderation.target = "1126000001";
  value.moderation.consentConfirmedAt = new Date().toISOString();
  value.moderation.consentUntil = new Date(Date.now() + 60 * 60_000).toISOString();
  return value;
}

test("moderation plan pins exactly B, target, duration and two one-operation leases", () => {
  const value = config();
  const { plan, fixed, suiteSha256 } = moderationPlan(value);
  assert.equal(plan.familyId, MODERATION_FAMILY_ID);
  assert.equal(plan.groupId, MODERATION_GROUP_B_ID);
  assert.equal(plan.targetSha256.length, 64);
  assert.equal(plan.stages.length, 2);
  assert.deepEqual(
    plan.stages.map((row) => row.stage),
    ["mute", "unmute"],
  );
  const [mute, unmute] = plan.stages;
  assert.deepEqual(mute, {
    stage: "mute",
    chat: "private",
    action: "group:moderate",
    resourceId: `group:${MODERATION_GROUP_B_ID}`,
    inputConstraint: {
      groupId: MODERATION_GROUP_B_ID,
      operation: "set_group_ban",
      params: { user_id: Number(fixed.target), duration: 60 },
    },
    nativeMuteState: {
      kind: "qq-member-mute-state",
      phase: "mute",
      expectedMuteUntil: "captured from a fresh member read immediately before lease registration",
    },
  });
  assert.deepEqual(unmute.inputConstraint.params, {
    user_id: Number(fixed.target),
    duration: 0,
  });
  assert.equal(unmute.nativeMuteState.phase, "unmute");
  assert.equal(
    plan.prerequisites.some((item) => item.includes("native group owner")),
    false,
  );
  assert.match(suiteSha256, /^[a-f0-9]{64}$/u);
});

test("stage input cannot widen target, group or duration", () => {
  const fixed = {
    groupId: MODERATION_GROUP_B_ID,
    target: "1126000001",
    durationSeconds: 45,
    expectedMuteUntil: 0,
  };
  assert.equal(
    moderationStep("mute", fixed).leaseTools[0].operations[0].inputConstraint.params.duration,
    45,
  );
  assert.equal(
    moderationStep("unmute", {
      ...fixed,
      expectedMuteUntil: Math.ceil(Date.now() / 1000) + 60,
    }).leaseTools[0].operations[0].inputConstraint.params.duration,
    0,
  );
  assert.equal(
    moderationStep("mute", fixed).leaseTools[0].operations[0].nativeMuteState.expectedMuteUntil,
    0,
  );
  assert.throws(() => moderationStep("kick", fixed), {
    code: "MODERATION_SCENARIO",
  });
  assert.throws(() => moderationStep("unmute", { ...fixed, expectedMuteUntil: 0 }), {
    code: "MODERATION_SCENARIO",
  });
});

test("planning fails closed without a fresh ordinary target consent", () => {
  for (const mutate of [
    (value) => (value.moderation.target = ""),
    (value) => (value.moderation.consentConfirmed = false),
    (value) =>
      (value.moderation.consentConfirmedAt = new Date(Date.now() - 16 * 60_000).toISOString()),
    (value) => (value.moderation.consentUntil = new Date(Date.now() + 30_000).toISOString()),
    (value) => (value.moderation.emergencyCleanupViaDriver = true),
    (value) => (value.groups[1].id = "1126022433"),
    (value) => (value.moderation.group = "A"),
  ]) {
    const value = config();
    mutate(value);
    assert.throws(() => moderationPlan(value), { code: "MODERATION_SCENARIO" });
  }
});

function ownerRequestConfig() {
  const value = config();
  value.driver.qq = "3526039967";
  Object.assign(value.moderation, {
    authorizationBasis: "group-owner-request",
    ownerAuthorizationConfirmed: true,
    ownerAuthorizationAt: new Date().toISOString(),
    ownerAuthorizationUntil: new Date(Date.now() + 60 * 60_000).toISOString(),
    consentConfirmed: false,
    consentConfirmedAt: "",
    consentUntil: "",
    durationSeconds: 30,
  });
  return value;
}

test("group-owner request plan records its basis and never claims target consent", () => {
  const value = ownerRequestConfig();
  const { plan, fixed } = moderationPlan(value);
  assert.equal(fixed.authorizationBasis, "group-owner-request");
  assert.equal(plan.authorizationBasis, "group-owner-request");
  assert.deepEqual(plan.ownerAuthorization, {
    ownerId: "3526039967",
    confirmed: true,
    authorizedAt: value.moderation.ownerAuthorizationAt,
    validUntil: value.moderation.ownerAuthorizationUntil,
  });
  assert.equal(plan.durationSeconds, 30);
  assert.equal(
    plan.prerequisites.some((item) => item.includes("native group owner")),
    true,
  );
  assert.equal(plan.stages[0].inputConstraint.params.duration, 30);
  assert.equal(plan.stages[1].inputConstraint.params.duration, 0);
  assert.equal(Object.hasOwn(plan, "consentConfirmedAt"), false);
  assert.equal(Object.hasOwn(plan, "consentUntil"), false);
  assert.equal(Object.hasOwn(fixed, "consentConfirmedAt"), false);
  assert.throws(() => validateModeration(value), { code: "CONSENT_REQUIRED" });
  const changedOwnerTime = ownerRequestConfig();
  changedOwnerTime.moderation.ownerAuthorizationAt = new Date(Date.now() - 1000).toISOString();
  assert.notEqual(moderationPlan(changedOwnerTime).suiteSha256, moderationPlan(value).suiteSha256);
  const changedTarget = ownerRequestConfig();
  changedTarget.moderation.target = "1126000002";
  assert.notEqual(moderationPlan(changedTarget).suiteSha256, moderationPlan(value).suiteSha256);
});

test("group-owner request rejects unconfirmed, stale, expired, widened, or target-consent configurations", () => {
  const invalidChanges = [
    (value) => (value.driver.qq = "3526039968"),
    (value) => (value.moderation.ownerAuthorizationConfirmed = false),
    (value) =>
      (value.moderation.ownerAuthorizationAt = new Date(Date.now() - 16 * 60_000).toISOString()),
    (value) =>
      (value.moderation.ownerAuthorizationAt = new Date(Date.now() + 60_000).toISOString()),
    (value) =>
      (value.moderation.ownerAuthorizationUntil = new Date(Date.now() + 30_000).toISOString()),
    (value) =>
      (value.moderation.ownerAuthorizationUntil = new Date(Date.now() + 20_000).toISOString()),
    (value) => (value.moderation.durationSeconds = 31),
    (value) => (value.groups[1].id = "1126022433"),
    (value) => (value.moderation.target = value.driver.qq),
    (value) => (value.moderation.target = value.bot.qq),
    (value) => (value.moderation.consentConfirmed = true),
    (value) => (value.moderation.consentConfirmedAt = new Date().toISOString()),
  ];
  for (const mutate of invalidChanges) {
    const value = ownerRequestConfig();
    mutate(value);
    assert.throws(() => moderationPlan(value), { code: "MODERATION_SCENARIO" });
  }
});

test("fixed run requires approval of the current plan hash", () => {
  const value = config();
  value.runtime.expectedSourceTreeSha256 = "c".repeat(64);
  const resolved = resolveModerationCli({
    command: "plan",
    caseId: MODERATION_FAMILY_ID,
    config: value,
  });
  value.runtime = { ...value.runtime, expectedCommit: "b".repeat(40) };
  assert.throws(
    () =>
      resolveModerationCli({
        command: "run",
        caseId: MODERATION_FAMILY_ID,
        config: value,
        approvedSuite: resolved.suiteSha256,
      }),
    { code: "SUITE_APPROVAL" },
  );
});

test("fixed run requires an explicit source-tree pin and current plan approval", () => {
  const value = config();
  const resolved = moderationPlan(value);
  assert.equal(
    resolved.plan.executionStatus,
    "Run requires a pinned Runtime source tree and a server-enforced mute-state precondition before each provider mutation.",
  );
  assert.throws(
    () =>
      resolveModerationCli({
        command: "run",
        caseId: MODERATION_FAMILY_ID,
        config: value,
        approvedSuite: resolved.suiteSha256,
      }),
    { code: "MODERATION_RUNTIME_SOURCE_REQUIRED" },
  );
  value.runtime.expectedSourceTreeSha256 = "c".repeat(64);
  const pinnedPlan = moderationPlan(value);
  const selection = resolveModerationCli({
    command: "run",
    caseId: MODERATION_FAMILY_ID,
    config: value,
    approvedSuite: pinnedPlan.suiteSha256,
  });
  assert.equal(selection.mode, "run");
  assert.deepEqual(Object.keys(selection).sort(), [
    "familyId",
    "groupId",
    "mode",
    "plan",
    "suiteSha256",
    "target",
  ]);
  assert.equal(selection.suiteSha256, pinnedPlan.suiteSha256);
  assert.equal(selection.groupId, MODERATION_GROUP_B_ID);
  assert.equal(selection.target, "1126000001");
});
