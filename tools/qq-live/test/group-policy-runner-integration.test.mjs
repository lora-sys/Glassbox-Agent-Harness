import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { OneBot } from "../lib/onebot.mjs";
import { Recorder, replyCase } from "../lib/runner.mjs";
import {
  captureGroupPolicyState,
  verifyGroupPolicyTransition,
} from "../lib/group-policy-state.mjs";
import { runGroupPolicyWorkflow } from "../lib/group-policy-workflow.mjs";
import { toolManifestDigest } from "../lib/core.mjs";
import { world } from "./fixture.mjs";

const env = {
  DRIVER_TOKEN: "fixture-token-only",
  BOT_TOKEN: "fixture-token-only",
};
const runtime = {
  checkout: "/tmp/disposable-qq-live",
  dataDirectory: "/tmp/disposable-qq-live-data",
  commit: "a".repeat(40),
  pid: 123,
  connectionId: "fixture",
  threadId: null,
};
const initialPolicy = {
  categories: { "group.history": true, "group.read": true },
  memorySources: { history: true },
  webCapabilities: {},
};
const scopeKey = JSON.stringify(["fixture", "10002", "private", "10001", "10001", null]);

function policyDatabase(t, config) {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  db.exec(
    "CREATE TABLE principals(id TEXT,kind TEXT);CREATE TABLE channel_identities(identity_key TEXT,principal_id TEXT);CREATE TABLE resources(id TEXT);CREATE TABLE grants(id TEXT,principal_id TEXT,resource_id TEXT,action TEXT,scope_key TEXT,effect TEXT,revoked_at TEXT,created_at TEXT);CREATE TABLE group_capability_policies(connection_id TEXT,group_id TEXT,policy_json TEXT,version INTEGER,updated_by_principal_id TEXT,updated_at TEXT);",
  );
  db.prepare("INSERT INTO principals VALUES (?,?)").run("owner", "owner");
  db.prepare("INSERT INTO channel_identities VALUES (?,?)").run(
    JSON.stringify(["fixture", config.bot.qq, config.driver.qq]),
    "owner",
  );
  const grant = (id, resource, action, createdAt = "2026-10-07T00:00:00.000Z") =>
    db
      .prepare("INSERT INTO grants VALUES (?,?,?,?,?,?,NULL,?)")
      .run(id, "owner", resource, action, scopeKey, "allow", createdAt);
  for (const resourceId of ["owner-control", "group:20001", "group:20002"]) {
    db.prepare("INSERT INTO resources VALUES (?)").run(resourceId);
    grant("manage-" + resourceId, resourceId, "group:manage");
  }
  for (const groupId of ["20001", "20002"])
    db.prepare("INSERT INTO group_capability_policies VALUES (?,?,?,?,?,?)").run(
      "fixture",
      groupId,
      JSON.stringify(initialPolicy),
      1,
      "owner",
      "2026-10-07T00:00:00.000Z",
    );
  grant("history-B", "group:20002", "history:read");
  return { db, grant };
}
async function setup(t) {
  const fixture = await world();
  const clients = {
    driver: new OneBot(fixture.config, "driver", { env }),
    bot: new OneBot(fixture.config, "bot", { env }),
  };
  t.after(async () => {
    clients.driver.close();
    clients.bot.close();
    await fixture.close();
  });
  await clients.driver.connect();
  await clients.bot.connect();
  const recorder = new Recorder(fixture.config, Object.values(env));
  for (const role of ["driver", "bot"])
    clients[role].subscribe((event) => recorder.ingest(role, event));
  const config = {
    ...fixture.config,
    groups: [
      { alias: "A", id: "20001" },
      { alias: "B", id: "20002" },
    ],
    runtime,
  };
  return {
    ...fixture,
    clients,
    recorder,
    config,
    ...policyDatabase(t, config),
  };
}
function workflowOptions(h, { blockBeforeRegister = false } = {}) {
  const checkpoints = [];
  const sendsAtHooks = [];
  return {
    checkpoints,
    sendsAtHooks,
    options: {
      groupId: "20002",
      captureState: (options) => captureGroupPolicyState(h.db, h.config, options),
      readRuntime: async () => structuredClone(runtime),
      checkpoint: async (row) => {
        checkpoints.push(structuredClone(row));
        return true;
      },
      executeStep: async (stage, spec, hooks) => {
        const expectedPriorSends = { disable: 0, "history-check": 1, restore: 2 }[stage];
        const leaseId = {
          disable: "11111111-1111-4111-8111-111111111111",
          "history-check": "33333333-3333-4333-8333-333333333333",
          restore: "22222222-2222-4222-8222-222222222222",
        }[stage];
        const sendCount = () =>
          h.actions.filter((action) => action.action === "send_private_msg").length;
        const acceptance = {
          beforeRegister: async (caseRecord) => {
            sendsAtHooks.push([stage, "beforeRegister", sendCount()]);
            assert.equal(sendCount(), expectedPriorSends);
            if (blockBeforeRegister && stage === "disable") return false;
            return hooks.beforeRegister(caseRecord);
          },
          register: async (_config, caseRecord, tools) => {
            sendsAtHooks.push([stage, "register", sendCount()]);
            assert.equal(caseRecord.id, spec.id);
            assert.equal(sendCount(), expectedPriorSends);
            const leasedTools = JSON.parse(
              JSON.stringify(spec.leaseTools).replaceAll("{{nonce}}", caseRecord.token),
            );
            assert.deepEqual(tools, leasedTools);
            return {
              leaseId,
              expiresAt: Date.now() + 60_000,
              toolsSha256: toolManifestDigest(leasedTools),
            };
          },
          beforeSend: async (caseRecord, lease) => {
            sendsAtHooks.push([stage, "beforeSend", sendCount()]);
            assert.equal(sendCount(), expectedPriorSends);
            return hooks.beforeSend(caseRecord, lease);
          },
          afterSend: async (caseRecord) => {
            sendsAtHooks.push([stage, "afterSend", sendCount()]);
            assert.equal(sendCount(), expectedPriorSends + 1);
            return hooks.afterSend(caseRecord);
          },
          revoke: async (revokedLeaseId) => assert.equal(revokedLeaseId, leaseId),
        };
        const transportCase = await replyCase(
          h.config,
          h.clients,
          h.recorder,
          spec,
          undefined,
          acceptance,
        );
        if (transportCase.status === "PASS" && stage !== "history-check") {
          const enabled = stage === "restore";
          const policy = {
            categories: {
              ...initialPolicy.categories,
              "group.history": enabled,
            },
            memorySources: { ...initialPolicy.memorySources, history: enabled },
            webCapabilities: {},
          };
          h.db
            .prepare(
              "UPDATE group_capability_policies SET policy_json=?,version=?,updated_at=? WHERE group_id='20002'",
            )
            .run(
              JSON.stringify(policy),
              stage === "disable" ? 2 : 3,
              stage === "disable" ? "2026-10-07T00:00:02.000Z" : "2026-10-07T00:00:03.000Z",
            );
          if (stage === "disable")
            h.db
              .prepare("UPDATE grants SET revoked_at=? WHERE id='history-B'")
              .run("2026-10-07T00:00:02.000Z");
          else
            h.grant("history-restored", "group:20002", "history:read", "2026-10-07T00:00:03.000Z");
        }
        return { transportCase };
      },
      verifyStep: async ({ stage, before, after, result }) => ({
        status:
          stage === "history-check"
            ? "HISTORY_REVOCATION_RESULT_VERIFIED"
            : "GROUP_POLICY_RUN_VERIFIED",
        stage,
        runId: "fixture-run-" + stage,
        policyVersion: after.B.version,
        toolCallId: "fixture-call-" + stage,
        toolOutputSha256: "a".repeat(64),
        stateProof: verifyGroupPolicyTransition(
          before,
          after,
          stage === "history-check" ? "disable" : stage,
        ),
        actualQqDeliveryVerified: result.transportCase.status === "PASS",
        cleanupVerified: result.transportCase.leaseRevoked === true,
      }),
    },
  };
}
test("fixed workflow uses real replyCase lease hooks and local OneBot transport in order", async (t) => {
  const h = await setup(t);
  const { options, checkpoints, sendsAtHooks } = workflowOptions(h);
  const result = await runGroupPolicyWorkflow(options);
  assert.equal(result.status, "GROUP_POLICY_WORKFLOW_VERIFIED");
  assert.equal(result.actualQqDeliveryVerified, true);
  assert.deepEqual(sendsAtHooks, [
    ["disable", "beforeRegister", 0],
    ["disable", "register", 0],
    ["disable", "beforeSend", 0],
    ["disable", "afterSend", 1],
    ["history-check", "beforeRegister", 1],
    ["history-check", "register", 1],
    ["history-check", "beforeSend", 1],
    ["history-check", "afterSend", 2],
    ["restore", "beforeRegister", 2],
    ["restore", "register", 2],
    ["restore", "beforeSend", 2],
    ["restore", "afterSend", 3],
  ]);
  assert.equal(h.actions.filter((action) => action.action === "send_private_msg").length, 3);
  assert.deepEqual(
    h.recorder.cases.map((row) => row.status),
    ["PASS", "PASS", "PASS"],
  );
  assert.equal(
    h.recorder.cases.every((row) => row.leaseRevoked),
    true,
  );
  assert.deepEqual(
    checkpoints.map((row) => row.phase),
    [
      ...["disable", "history-check", "restore"].flatMap(() => [
        "intent",
        "lease_intent",
        "prepared",
        "sent",
        "verified",
      ]),
      "restored",
    ],
  );
});
test("failed registration checkpoint blocks the case before local transport sends", async (t) => {
  const h = await setup(t);
  const { options, checkpoints } = workflowOptions(h, {
    blockBeforeRegister: true,
  });
  const result = await runGroupPolicyWorkflow(options);
  assert.equal(result.status, "INCONCLUSIVE");
  assert.equal(result.requiresReconciliation, true);
  assert.equal(h.actions.filter((action) => action.action === "send_private_msg").length, 0);
  assert.equal(h.recorder.cases.length, 1);
  assert.equal(h.recorder.cases[0].status, "BLOCKED");
  assert.equal(
    checkpoints.some((row) => row.phase === "prepared"),
    false,
  );
});
