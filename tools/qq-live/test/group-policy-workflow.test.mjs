import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import {
  captureGroupPolicyState,
  verifyGroupPolicyTransition,
} from "../lib/group-policy-state.mjs";
import { runGroupPolicyWorkflow } from "../lib/group-policy-workflow.mjs";
import { toolManifestDigest } from "../lib/core.mjs";

const config = {
  bot: { qq: "10001" },
  driver: { qq: "20002" },
  runtime: { connectionId: "fixture" },
  groups: [
    { alias: "A", id: "30003" },
    { alias: "B", id: "40004" },
  ],
};
const scope = JSON.stringify(["fixture", "10001", "private", "20002", "20002", null]);
const policy = {
  categories: { "group.history": true, "group.read": true },
  memorySources: { history: true },
  webCapabilities: {},
};
const runtime = {
  checkout: "/tmp/disposable",
  dataDirectory: "/tmp/disposable-data",
  commit: "a".repeat(40),
  pid: 123,
  connectionId: "fixture",
  threadId: null,
};

function setup(t) {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  db.exec(
    "CREATE TABLE principals(id TEXT,kind TEXT);CREATE TABLE channel_identities(identity_key TEXT,principal_id TEXT);CREATE TABLE resources(id TEXT);CREATE TABLE grants(id TEXT,principal_id TEXT,resource_id TEXT,action TEXT,scope_key TEXT,effect TEXT,revoked_at TEXT,created_at TEXT);CREATE TABLE group_capability_policies(connection_id TEXT,group_id TEXT,policy_json TEXT,version INTEGER,updated_by_principal_id TEXT,updated_at TEXT);",
  );
  db.prepare("INSERT INTO principals VALUES (?,?)").run("owner", "owner");
  db.prepare("INSERT INTO channel_identities VALUES (?,?)").run(
    JSON.stringify(["fixture", "10001", "20002"]),
    "owner",
  );
  const grant = (id, resource, action, time = "2026-10-07T00:00:00.000Z") =>
    db
      .prepare("INSERT INTO grants VALUES (?,?,?,?,?,?,NULL,?)")
      .run(id, "owner", resource, action, scope, "allow", time);
  for (const r of ["owner-control", "group:30003", "group:40004"]) {
    db.prepare("INSERT INTO resources VALUES (?)").run(r);
    grant(`manage-${r}`, r, "group:manage");
  }
  for (const g of config.groups) {
    db.prepare("INSERT INTO group_capability_policies VALUES (?,?,?,?,?,?)").run(
      "fixture",
      g.id,
      JSON.stringify(policy),
      1,
      "owner",
      "2026-10-07T00:00:00.000Z",
    );
    grant(`history-${g.alias}`, `group:${g.id}`, "history:read");
  }
  const rows = [];
  const sends = [];
  const options = {
    groupId: "40004",
    captureState: (o) => captureGroupPolicyState(db, config, o),
    readRuntime: async () => structuredClone(runtime),
    checkpoint: async (row) => {
      rows.push(row);
      return true;
    },
    executeStep: async (stage, spec, hooks) => {
      const token = { disable: "1", "history-check": "3", restore: "2" }[stage].repeat(32);
      const c = {
        id: spec.id,
        route: "private",
        token,
        startedAt: "2026-10-07T00:00:01.000Z",
        prompt: `GLASSBOX_ACCEPTANCE_V1 ${token}\n${spec.prompt.replaceAll("{{nonce}}", token)}`,
        expected: spec.expectContains.map((s) => s.replaceAll("{{nonce}}", token)),
        featureAssertions: spec.featureAssertions,
        leasedToolNames: spec.leaseTools.map((tool) => tool.name),
      };
      await hooks.beforeRegister(c);
      c.leaseRegistrationAttempted = true;
      c.acceptanceLease = {
        leaseId: {
          disable: "11111111-1111-4111-8111-111111111111",
          "history-check": "33333333-3333-4333-8333-333333333333",
          restore: "22222222-2222-4222-8222-222222222222",
        }[stage],
        expiresAt: Date.parse("2026-10-07T00:01:00.000Z"),
        toolsSha256: toolManifestDigest(
          JSON.parse(JSON.stringify(spec.leaseTools).replaceAll("{{nonce}}", token)),
        ),
      };
      await hooks.beforeSend(c, c.acceptanceLease);
      sends.push(stage);
      c.sendAttempted = true;
      c.sentMessageId = { disable: "101", "history-check": "103", restore: "102" }[stage];
      await hooks.afterSend(c);
      if (stage !== "history-check") {
        const next = structuredClone(policy);
        next.categories["group.history"] = stage === "restore";
        next.memorySources.history = stage === "restore";
        db.prepare(
          "UPDATE group_capability_policies SET policy_json=?,version=?,updated_at=? WHERE group_id='40004'",
        ).run(
          JSON.stringify(next),
          stage === "disable" ? 2 : 3,
          stage === "disable" ? "2026-10-07T00:00:02.000Z" : "2026-10-07T00:00:03.000Z",
        );
        if (stage === "disable")
          db.prepare("UPDATE grants SET revoked_at=? WHERE id='history-B'").run(
            "2026-10-07T00:00:02.000Z",
          );
        else grant("history-restored", "group:40004", "history:read", "2026-10-07T00:00:03.000Z");
      }
      c.status = "PASS";
      c.leaseRevoked = true;
      c.inputObserved = true;
      return { transportCase: c };
    },
    verifyStep: async ({ stage, before, after }) => ({
      status: "GROUP_POLICY_RUN_VERIFIED",
      stage,
      runId: `run-${stage}`,
      policyVersion: after.B.version,
      toolCallId: `call-${stage}`,
      toolOutputSha256: "a".repeat(64),
      stateProof: verifyGroupPolicyTransition(
        before,
        after,
        stage === "history-check" ? "disable" : stage,
      ),
      actualQqDeliveryVerified: true,
      cleanupVerified: true,
      ...(stage === "history-check"
        ? {
            requestedGroupExcluded: true,
            sourcesSearched: 0,
            coverage: "unknown",
            resultWindow: "no_sources_searched",
            absenceVerified: false,
            status: "HISTORY_REVOCATION_RESULT_VERIFIED",
          }
        : {}),
    }),
  };
  return { db, rows, sends, options };
}

test("fixed workflow checkpoints each real send hook and verifies restoration before completion", async (t) => {
  const { rows, sends, options } = setup(t);
  const result = await runGroupPolicyWorkflow(options);
  assert.equal(result.status, "GROUP_POLICY_WORKFLOW_VERIFIED", JSON.stringify(result));
  assert.deepEqual(sends, ["disable", "history-check", "restore"]);
  assert.deepEqual(
    rows.map((r) => [r.stage, r.phase]),
    [
      ...["disable", "history-check", "restore"].flatMap((stage) =>
        ["intent", "lease_intent", "prepared", "sent", "verified"].map((phase) => [stage, phase]),
      ),
      ["restore", "restored"],
    ],
  );
  assert.equal(result.requiresReconciliation, false);
  assert.equal(result.cleanupVerified, true);
  assert.equal(result.finalProof.originalPolicyRestored, true);
  assert.equal(result.finalProof.actualQqDeliveryVerified, false);
});

test("uncertain checkpoint persistence or unknown send retains reconciliation without a replay", async (t) => {
  for (const mode of ["checkpoint-false", "checkpoint-throw", "unknown-send"]) {
    const { sends, options } = setup(t);
    if (mode === "checkpoint-false") options.checkpoint = async () => false;
    else if (mode === "checkpoint-throw")
      options.checkpoint = async () => {
        throw new Error("private-provider-secret");
      };
    else
      options.executeStep = async () => {
        sends.push("unknown");
        throw new Error("private-provider-secret");
      };
    const result = await runGroupPolicyWorkflow(options);
    assert.equal(result.status, "INCONCLUSIVE", mode);
    assert.equal(result.requiresReconciliation, true, mode);
    assert.ok(sends.length <= 1);
    assert.equal(JSON.stringify(result).includes("private-provider-secret"), false);
  }
});

test("prepared checkpoint drift is caught before sending", async (t) => {
  const { db, sends, options } = setup(t);
  const original = options.checkpoint;
  options.checkpoint = async (row) => {
    await original(row);
    if (row.phase === "prepared")
      db.prepare(
        "UPDATE group_capability_policies SET version=version+1 WHERE group_id='30003'",
      ).run();
    return true;
  };
  const result = await runGroupPolicyWorkflow(options);
  assert.equal(result.status, "INCONCLUSIVE");
  assert.deepEqual(sends, []);
  assert.equal(result.requiresReconciliation, true);
});

test("a lease mismatch is rejected before the send hook returns", async (t) => {
  const { rows, sends, options } = setup(t);
  const original = options.executeStep;
  options.executeStep = (stage, spec, hooks) =>
    original(stage, spec, {
      ...hooks,
      beforeSend: (c, lease) =>
        hooks.beforeSend(c, {
          ...lease,
          leaseId: "33333333-3333-4333-8333-333333333333",
        }),
    });
  const result = await runGroupPolicyWorkflow(options);
  assert.equal(result.status, "INCONCLUSIVE");
  assert.deepEqual(sends, []);
  assert.equal(
    rows.some((row) => row.phase === "prepared"),
    false,
  );
  assert.equal(result.requiresReconciliation, true);
});

test("drift after intent stops before permission registration and cancellation stops before send", async (t) => {
  for (const mode of ["drift", "abort"]) {
    const { db, sends, options } = setup(t);
    const controller = new AbortController();
    options.signal = controller.signal;
    const original = options.checkpoint;
    options.checkpoint = async (row) => {
      await original(row);
      if (row.phase === "intent") {
        if (mode === "drift")
          db.prepare(
            "UPDATE group_capability_policies SET version=version+1 WHERE group_id='30003'",
          ).run();
        else controller.abort();
      }
      return true;
    };
    const result = await runGroupPolicyWorkflow(options);
    assert.equal(result.status, "INCONCLUSIVE");
    assert.deepEqual(sends, []);
    assert.equal(result.requiresReconciliation, true);
  }
});

test("absent hooks, stale captures, changed runtime and unverified delivery cannot complete", async (t) => {
  for (const mode of ["hooks", "capture", "runtime", "delivery"]) {
    const { sends, options } = setup(t);
    if (mode === "hooks") options.executeStep = async () => ({ transportCase: { status: "PASS" } });
    if (mode === "capture") {
      const baseline = options.captureState();
      options.captureState = () => baseline;
    }
    if (mode === "runtime") {
      let reads = 0;
      options.readRuntime = async () => ({
        ...runtime,
        pid: ++reads === 1 ? 123 : 124,
      });
    }
    if (mode === "delivery") {
      const original = options.verifyStep;
      options.verifyStep = async (args) => ({
        ...(await original(args)),
        actualQqDeliveryVerified: false,
      });
    }
    const result = await runGroupPolicyWorkflow(options);
    assert.equal(result.status, "INCONCLUSIVE", mode);
    assert.ok(sends.length <= 1, mode);
  }
});

test("collateral state change after a verified disable prevents restore", async (t) => {
  const { db, sends, options } = setup(t);
  const original = options.checkpoint;
  options.checkpoint = async (row) => {
    await original(row);
    if (row.phase === "verified" && row.stage === "disable")
      db.prepare(
        "UPDATE group_capability_policies SET version=version+1 WHERE group_id='30003'",
      ).run();
    return true;
  };
  const result = await runGroupPolicyWorkflow(options);
  assert.equal(result.status, "INCONCLUSIVE");
  assert.deepEqual(sends, ["disable"]);
  assert.equal(result.requiresReconciliation, true);
  assert.equal(result.actualQqDeliveryVerified, false);
});

test("final checkpoint drift cannot return a verified workflow", async (t) => {
  const { db, sends, options } = setup(t);
  const original = options.checkpoint;
  options.checkpoint = async (row) => {
    await original(row);
    if (row.phase === "restored")
      db.prepare(
        "UPDATE group_capability_policies SET version=version+1 WHERE group_id='30003'",
      ).run();
    return true;
  };
  const result = await runGroupPolicyWorkflow(options);
  assert.equal(result.status, "INCONCLUSIVE");
  assert.deepEqual(sends, ["disable", "history-check", "restore"]);
  assert.equal(result.requiresReconciliation, true);
  assert.equal(result.actualQqDeliveryVerified, false);
});

test("a bound history feature failure restores policy and completes only as FAIL-ready cleanup", async (t) => {
  const { sends, options } = setup(t);
  const verify = options.verifyStep;
  options.verifyStep = async (input) => {
    const proof = await verify(input);
    if (input.stage === "history-check")
      return { ...proof, status: "HISTORY_REVOCATION_RESULT_FAILED" };
    return proof;
  };
  const result = await runGroupPolicyWorkflow(options);
  assert.equal(result.status, "GROUP_POLICY_RESTORED_FEATURE_FAILED");
  assert.equal(result.requiresReconciliation, false);
  assert.equal(result.cleanupVerified, true);
  assert.deepEqual(sends, ["disable", "history-check", "restore"]);
  assert.equal(result.finalProof.originalPolicyRestored, true);
  assert.equal(
    result.steps.find((step) => step.stage === "history-check").proof.cleanupVerified,
    true,
  );
});

test("history check exception or policy drift retains the guard without restoring", async (t) => {
  for (const mode of ["query-unknown", "drift"]) {
    const { db, sends, options } = setup(t);
    if (mode === "query-unknown") {
      const execute = options.executeStep;
      options.executeStep = async (...args) => {
        if (args[0] === "history-check") throw new Error("private output");
        return execute(...args);
      };
    } else {
      const checkpoint = options.checkpoint;
      options.checkpoint = async (row) => {
        await checkpoint(row);
        if (row.stage === "history-check" && row.phase === "intent")
          db.prepare(
            "UPDATE group_capability_policies SET version=version+1 WHERE group_id='40004'",
          ).run();
        return true;
      };
    }
    const result = await runGroupPolicyWorkflow(options);
    assert.equal(result.status, "INCONCLUSIVE");
    assert.equal(result.requiresReconciliation, true);
    assert.notEqual(sends.includes("restore"), true);
  }
});
