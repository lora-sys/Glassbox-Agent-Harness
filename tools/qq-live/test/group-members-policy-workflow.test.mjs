import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { toolManifestDigest } from "../lib/core.mjs";
import {
  captureGroupMembersPolicyState,
  verifyGroupMembersPolicyTransition,
} from "../lib/group-members-policy-state.mjs";
import { runGroupMembersPolicyWorkflow } from "../lib/group-members-policy-workflow.mjs";

const config = {
  bot: { qq: "10001" },
  driver: { qq: "20002" },
  groups: [
    { alias: "A", id: "30003" },
    { alias: "B", id: "40004" },
  ],
  runtime: { connectionId: "members-workflow", threadId: null },
};
const scope = JSON.stringify(["members-workflow", "10001", "private", "20002", "20002", null]);
const policy = { categories: { "group.members": true }, memorySources: { history: true } };
function fixture(t) {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  db.exec(
    "CREATE TABLE principals(id TEXT,kind TEXT); CREATE TABLE channel_identities(identity_key TEXT,principal_id TEXT); CREATE TABLE resources(id TEXT); CREATE TABLE grants(id TEXT,principal_id TEXT,resource_id TEXT,action TEXT,scope_key TEXT,effect TEXT,revoked_at TEXT,created_at TEXT); CREATE TABLE group_capability_policies(connection_id TEXT,group_id TEXT,policy_json TEXT,version INTEGER,updated_by_principal_id TEXT,updated_at TEXT);",
  );
  db.prepare("INSERT INTO principals VALUES ('owner','owner')").run();
  db.prepare("INSERT INTO channel_identities VALUES (?, 'owner')").run(
    JSON.stringify(["members-workflow", "10001", "20002"]),
  );
  for (const resource of ["owner-control", "group:30003", "group:40004"]) {
    db.prepare("INSERT INTO resources VALUES (?)").run(resource);
    db.prepare(
      "INSERT INTO grants VALUES (?,?,?,'group:manage',?,'allow',NULL,'2026-10-07T00:00:01.000Z')",
    ).run(`manage-${resource}`, "owner", resource, scope);
  }
  for (const id of ["30003", "40004"])
    db.prepare("INSERT INTO group_capability_policies VALUES (?,?,?,?,?,?)").run(
      "members-workflow",
      id,
      JSON.stringify(policy),
      1,
      "owner",
      "2026-10-07T00:00:01.000Z",
    );
  db.prepare(
    "INSERT INTO grants VALUES ('members-B','owner','group:40004','group:members:read',?,'allow',NULL,'2026-10-07T00:00:01.000Z')",
  ).run(scope);
  return db;
}
function mutate(db, enabled, version) {
  const next = structuredClone(policy);
  next.categories["group.members"] = enabled;
  db.prepare(
    "UPDATE group_capability_policies SET policy_json=?,version=?,updated_at=? WHERE group_id='40004'",
  ).run(JSON.stringify(next), version, `2026-10-07T00:00:0${version}.000Z`);
  if (!enabled)
    db.prepare(
      "UPDATE grants SET revoked_at='2026-10-07T00:00:02.000Z' WHERE id='members-B'",
    ).run();
  else
    db.prepare(
      "INSERT INTO grants VALUES ('members-B-restored','owner','group:40004','group:members:read',?,'allow',NULL,'2026-10-07T00:00:03.000Z')",
    ).run(scope);
}
function transportCase(spec) {
  const char = spec.id.endsWith("disable") ? "1" : spec.id.endsWith("restore") ? "3" : "2";
  const token = (char === "1" ? "a" : char === "2" ? "b" : "c").repeat(32),
    leaseId = `${char.repeat(8)}-${char.repeat(4)}-4${char.repeat(3)}-8${char.repeat(3)}-${char.repeat(12)}`;
  const startedAt = new Date().toISOString();
  const prompt = `GLASSBOX_ACCEPTANCE_V1 ${token}\n${spec.prompt.replaceAll("{{nonce}}", token).trim()}`;
  const c = {
    id: spec.id,
    token,
    route: "private",
    prompt,
    expected: spec.expectContains.map((x) => x.replaceAll("{{nonce}}", token)),
    startedAt,
    featureAssertions:
      spec.featureAssertions === undefined
        ? undefined
        : JSON.parse(JSON.stringify(spec.featureAssertions).replaceAll("{{nonce}}", token)),
    leasedToolNames: spec.leaseTools.map((x) => x.name),
    acceptanceLease: {
      leaseId,
      expiresAt: Date.now() + 60000,
      toolsSha256: toolManifestDigest(
        JSON.parse(JSON.stringify(spec.leaseTools).replaceAll("{{nonce}}", token)),
      ),
    },
    sendAttempted: true,
    inputObserved: true,
    leaseRegistrationAttempted: true,
    leaseRevoked: true,
    status: "PASS",
    code: "REAL_REPLY_RECEIVED",
    sentMessageId: "555",
    replies: [{ route: "private", matches: true, messageId: "556" }],
    anomalies: [],
  };
  return c;
}
test("three-stage workflow restores B and reports boundary verification without claiming positive feature acceptance", async (t) => {
  const db = fixture(t),
    checkpoints = [];
  const runtime = {
    checkout: "/checkout",
    dataDirectory: "/data",
    commit: "a".repeat(40),
    pid: 123,
    connectionId: "members-workflow",
  };
  let baselineState;
  const capture = (options) => {
    const state = captureGroupMembersPolicyState(db, config, options);
    baselineState ??= state;
    return state;
  };
  let run = 0;
  const result = await runGroupMembersPolicyWorkflow({
    groupId: "40004",
    captureState: capture,
    readRuntime: async () => runtime,
    checkpoint: async (row) => {
      checkpoints.push(row);
      return true;
    },
    executeStep: async (stage, spec, hooks) => {
      const c = transportCase(spec);
      await hooks.beforeRegister(c);
      await hooks.beforeSend(c, c.acceptanceLease);
      await hooks.afterSend(c);
      if (stage === "disable") mutate(db, false, 2);
      if (stage === "restore") mutate(db, true, 3);
      const after = captureGroupMembersPolicyState(db, config, {
        originalMemberGrantId: "members-B",
      });
      const before = baselineState;
      const stateProof =
        stage === "members-check"
          ? verifyGroupMembersPolicyTransition(before, after, "disable")
          : verifyGroupMembersPolicyTransition(before, after, stage);
      const proof = {
        stage,
        runId: `run-${++run}`,
        policyVersion: after.B.version,
        toolCallId: stage === "members-check" ? null : "tool-call",
        toolOutputSha256: stage === "members-check" ? null : "b".repeat(64),
        status:
          stage === "members-check"
            ? "GROUP_MEMBERS_POLICY_REQUIRED_EVIDENCE_MISSING"
            : "GROUP_MEMBERS_POLICY_RUN_VERIFIED",
        actualQqDeliveryVerified: true,
        cleanupVerified: true,
        stateProof,
      };
      c.leaseRevoked = true;
      return { transportCase: c, proof };
    },
    verifyStep: async ({ result: stepResult }) => stepResult.proof,
  });
  assert.equal(result.status, "GROUP_MEMBERS_POLICY_BOUNDARY_VERIFIED");
  assert.equal(result.requiresReconciliation, false);
  assert.equal(result.cleanupVerified, true);
  assert.equal(result.steps.length, 3);
  assert.deepEqual(
    result.steps.map((step) => step.stage),
    ["disable", "members-check", "restore"],
  );
  assert.equal(result.steps[1].proof.status, "GROUP_MEMBERS_POLICY_REQUIRED_EVIDENCE_MISSING");
  assert.equal(result.finalProof.originalPolicyRestored, true);
  assert.equal(checkpoints.at(-1).phase, "restored");
});
test("uncertain or stale disabled state stops before the membership check", async (t) => {
  const db = fixture(t);
  let sends = 0;
  const runtime = {
    checkout: "/checkout",
    dataDirectory: "/data",
    commit: "a".repeat(40),
    pid: 123,
    connectionId: "members-workflow",
  };
  const result = await runGroupMembersPolicyWorkflow({
    groupId: "40004",
    captureState: (options) => captureGroupMembersPolicyState(db, config, options),
    readRuntime: async () => runtime,
    checkpoint: async () => true,
    executeStep: async () => {
      sends++;
      return {};
    },
    verifyStep: async () => {
      throw new Error("not reached");
    },
  });
  assert.equal(result.status, "INCONCLUSIVE");
  assert.equal(sends, 1);
  assert.equal(result.stage, "disable");
});
