import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { groupMembersPolicyStep } from "../lib/group-members-policy-scenario.mjs";
import { captureGroupMembersPolicyState } from "../lib/group-members-policy-state.mjs";
import {
  observeGroupMembersPolicyRun,
  verifyGroupMembersPolicyLeaseTrace,
} from "../lib/group-members-policy-run-evidence.mjs";

const config = {
  bot: { qq: "10001" },
  driver: { qq: "20002" },
  groups: [
    { alias: "A", id: "30003" },
    { alias: "B", id: "40004" },
  ],
  runtime: { connectionId: "members-run-fixture", threadId: null },
};
const scope = JSON.stringify(["members-run-fixture", "10001", "private", "20002", "20002", null]);
const principal = "owner-fixture",
  runId = "members-run";
const t0 = "2026-10-07T00:00:01.000Z";
function fixture(t) {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  db.exec(
    "CREATE TABLE principals(id TEXT PRIMARY KEY,kind TEXT); CREATE TABLE channel_identities(identity_key TEXT,principal_id TEXT); CREATE TABLE resources(id TEXT PRIMARY KEY); CREATE TABLE grants(id TEXT PRIMARY KEY,principal_id TEXT,resource_id TEXT,action TEXT,scope_key TEXT,effect TEXT,revoked_at TEXT,created_at TEXT); CREATE TABLE group_capability_policies(connection_id TEXT,group_id TEXT,policy_json TEXT,version INTEGER,updated_by_principal_id TEXT,updated_at TEXT); CREATE TABLE runs(id TEXT PRIMARY KEY,principal_id TEXT,conversation_id TEXT,scope_json TEXT,status TEXT,failure_code TEXT,result_text TEXT,created_at TEXT,updated_at TEXT); CREATE TABLE authorization_decisions(id TEXT PRIMARY KEY,principal_id TEXT,resource_id TEXT,action TEXT,scope_key TEXT,decision TEXT,run_id TEXT,delivery_source TEXT); CREATE TABLE authorization_decisions_archive(id TEXT PRIMARY KEY,principal_id TEXT,resource_id TEXT,action TEXT,scope_key TEXT,decision TEXT,run_id TEXT,delivery_source TEXT); CREATE VIEW authorization_decisions_all AS SELECT * FROM authorization_decisions UNION ALL SELECT * FROM authorization_decisions_archive;",
  );
  db.prepare("INSERT INTO principals VALUES (?, 'owner')").run(principal);
  db.prepare("INSERT INTO channel_identities VALUES (?,?)").run(
    JSON.stringify(["members-run-fixture", "10001", "20002"]),
    principal,
  );
  for (const resource of ["owner-control", "group:30003", "group:40004"]) {
    db.prepare("INSERT INTO resources VALUES (?)").run(resource);
    db.prepare("INSERT INTO grants VALUES (?,?,?,'group:manage',?,'allow',NULL,?)").run(
      `manage-${resource}`,
      principal,
      resource,
      scope,
      t0,
    );
  }
  const policy = {
    categories: { "group.members": true, "group.history": true },
    memorySources: { history: true },
    webCapabilities: {},
  };
  for (const id of ["30003", "40004"])
    db.prepare("INSERT INTO group_capability_policies VALUES (?,?,?,?,?,?)").run(
      config.runtime.connectionId,
      id,
      JSON.stringify(policy),
      1,
      principal,
      t0,
    );
  db.prepare(
    "INSERT INTO grants VALUES ('members-B',?,?, 'group:members:read',?,'allow',NULL,?)",
  ).run(principal, "group:40004", scope, t0);
  return db;
}
function disable(db) {
  const policy = {
    categories: { "group.members": false, "group.history": true },
    memorySources: { history: true },
    webCapabilities: {},
  };
  db.prepare(
    "UPDATE group_capability_policies SET policy_json=?,version=2,updated_at='2026-10-07T00:00:02.000Z' WHERE group_id='40004'",
  ).run(JSON.stringify(policy));
  db.prepare("UPDATE grants SET revoked_at='2026-10-07T00:00:02.000Z' WHERE id='members-B'").run();
}
function insertRun(
  db,
  status,
  failureCode = null,
  resultText = null,
  createdAt = "2026-10-07T00:00:03.000Z",
) {
  db.prepare("INSERT INTO runs VALUES (?,?,?,?,?,?,?,?,?)").run(
    runId,
    principal,
    "conversation-1",
    JSON.stringify({
      connectionId: config.runtime.connectionId,
      botId: "10001",
      chatType: "private",
      chatId: "20002",
      senderId: "20002",
      threadId: null,
    }),
    status,
    failureCode,
    resultText,
    createdAt,
    "2026-10-07T00:00:04.000Z",
  );
}
function checkEvents() {
  return [
    {
      runId,
      principalId: principal,
      conversationId: "conversation-1",
      type: "tool_evidence",
      phase: "required",
      required: [
        {
          domain: "group_members",
          tool: "qq_group_members",
          input: { operation: "get_group_member_list" },
        },
      ],
    },
    {
      runId,
      principalId: principal,
      conversationId: "conversation-1",
      type: "tool_evidence",
      phase: "resolved",
      resolutions: [{ domain: "group_members", tool: "qq_group_members", outcome: "not_called" }],
    },
  ];
}
function mutationFixture(t, stage) {
  const db = fixture(t),
    before = captureGroupMembersPolicyState(db, config);
  disable(db);
  const initialId = before.B.memberGrants[0].id;
  let after;
  if (stage === "restore") {
    db.prepare(
      "UPDATE group_capability_policies SET policy_json=?,version=3,updated_at='2026-10-07T00:00:03.000Z' WHERE group_id='40004'",
    ).run(
      JSON.stringify({
        categories: { "group.members": true, "group.history": true },
        memorySources: { history: true },
        webCapabilities: {},
      }),
    );
    db.prepare(
      "INSERT INTO grants VALUES ('members-B-restored',?,?, 'group:members:read',?,'allow',NULL,'2026-10-07T00:00:03.000Z')",
    ).run(principal, "group:40004", scope);
  }
  after = captureGroupMembersPolicyState(db, config, { originalMemberGrantId: initialId });
  insertRun(db, "succeeded", null, null, "2026-10-07T00:00:01.000Z");
  db.prepare("INSERT INTO authorization_decisions VALUES ('allow-1',?,?,?,?,?,?,NULL)").run(
    principal,
    "owner-control",
    "group:manage",
    scope,
    "ALLOW",
    runId,
  );
  const enabled = stage === "restore";
  const expectedInput = groupMembersPolicyStep(stage, "40004").leaseTools[0].operations[0]
    .inputConstraint;
  const output = JSON.stringify({
    groupId: "40004",
    category: "group.members",
    enabled,
    version: after.B.version,
  });
  const head = JSON.stringify({ content: [{ type: "text", text: output }], details: {} });
  const sha = createHash("sha256").update(head).digest("hex");
  const events = [
    {
      runId,
      timestamp: "2026-10-07T00:00:03.100Z",
      principalId: principal,
      type: "tool_call",
      toolCallId: "call-1",
      data: {
        name: "owner_group_admin",
        runId,
        principalId: principal,
        toolCallId: "call-1",
        input: expectedInput,
      },
    },
    {
      runId,
      type: "group_capability_changed",
      connectionId: config.runtime.connectionId,
      groupId: "40004",
      category: "group.members",
      enabled,
      policyVersion: after.B.version,
      principalId: principal,
    },
    {
      runId,
      timestamp: "2026-10-07T00:00:03.500Z",
      principalId: principal,
      type: "tool_result",
      toolCallId: "call-1",
      data: {
        name: "owner_group_admin",
        runId,
        principalId: principal,
        toolCallId: "call-1",
        isError: false,
        outputTruncated: false,
        outputBytes: Buffer.byteLength(head),
        outputHead: head,
        outputSha256: sha,
      },
    },
  ];
  return { db, before, after, events, stage, initialId };
}

test("verifies the exact Group B group.members mutation and restore", (t) => {
  for (const stage of ["disable", "restore"]) {
    const f = mutationFixture(t, stage);
    const proof = observeGroupMembersPolicyRun({
      db: f.db,
      events: f.events,
      runId,
      before: f.before,
      after: f.after,
      stage,
    });
    assert.equal(proof.status, "GROUP_MEMBERS_POLICY_RUN_VERIFIED");
    assert.equal(proof.stateProof.groupAUnchanged, true);
    assert.equal(proof.toolCallId, "call-1");
  }
});

test("verifies only the failed missing-evidence result with no QQ member Tool calls", (t) => {
  const db = fixture(t),
    before = captureGroupMembersPolicyState(db, config);
  disable(db);
  const disabled = captureGroupMembersPolicyState(db, config, {
    originalMemberGrantId: before.B.memberGrants[0].id,
  });
  insertRun(db, "failed", "required_evidence_missing", "未能从 QQ 获取该信息，因此无法确认。");
  const proof = observeGroupMembersPolicyRun({
    db,
    events: checkEvents(),
    runId,
    before,
    disabled,
    after: disabled,
    stage: "members-check",
  });
  assert.equal(proof.status, "GROUP_MEMBERS_POLICY_REQUIRED_EVIDENCE_MISSING");
  assert.equal(proof.toolCallId, null);
  assert.equal(proof.actualQqDeliveryVerified, false);
});

test("rejects successful, differently failed, evidence-free, or executed member lookup Runs", (t) => {
  for (const [status, code, text, events] of [
    ["succeeded", null, "群里有 42 位成员。", checkEvents()],
    ["failed", "executor_crashed", "未能从 QQ 获取该信息，因此无法确认。", checkEvents()],
    [
      "failed",
      "required_evidence_missing",
      "未能从 QQ 获取该信息，因此无法确认。",
      checkEvents().slice(0, 1),
    ],
    [
      "failed",
      "required_evidence_missing",
      "未能从 QQ 获取该信息，因此无法确认。",
      [
        ...checkEvents(),
        {
          runId,
          type: "tool_call",
          principalId: principal,
          toolCallId: "leak",
          data: { name: "qq_group_members" },
        },
      ],
    ],
  ]) {
    const db = fixture(t),
      before = captureGroupMembersPolicyState(db, config);
    disable(db);
    const disabled = captureGroupMembersPolicyState(db, config, {
      originalMemberGrantId: before.B.memberGrants[0].id,
    });
    insertRun(db, status, code, text);
    assert.throws(
      () =>
        observeGroupMembersPolicyRun({
          db,
          events,
          runId,
          before,
          disabled,
          after: disabled,
          stage: "members-check",
        }),
      (error) => error.code === "GROUP_MEMBERS_POLICY_RUN_EVIDENCE",
    );
  }
});

test("membership-check Trace binds the fixed manifest to the acceptance lease", () => {
  const caseRecord = {
    id: "group-members-policy-check",
    token: "a".repeat(32),
    acceptanceLease: {
      leaseId: "12345678-1234-4234-8234-123456789abc",
      toolsSha256: "b".repeat(64),
    },
  };
  const event = {
    runId,
    type: "session_start",
    data: {
      acceptanceLease: {
        leaseId: caseRecord.acceptanceLease.leaseId,
        marker: caseRecord.token,
        narrowedTools: ["qq_group_members"],
        toolsSha256: caseRecord.acceptanceLease.toolsSha256,
      },
      authorizedTools: ["qq_group_members"],
    },
  };
  assert.equal(verifyGroupMembersPolicyLeaseTrace([event], caseRecord, runId), true);
  for (const events of [
    [],
    [{ ...event, runId: "another-run" }],
    [
      {
        ...event,
        data: {
          ...event.data,
          acceptanceLease: {
            ...event.data.acceptanceLease,
            leaseId: "another-lease",
          },
        },
      },
    ],
    [
      {
        ...event,
        data: {
          ...event.data,
          authorizedTools: ["owner_group_admin"],
        },
      },
    ],
  ])
    assert.throws(() => verifyGroupMembersPolicyLeaseTrace(events, caseRecord, runId), {
      code: "GROUP_MEMBERS_POLICY_RUN_EVIDENCE",
    });
});
