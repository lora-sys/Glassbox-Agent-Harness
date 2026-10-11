import assert from "node:assert/strict";
import test from "node:test";
import { digest, toolManifestDigest } from "../lib/core.mjs";
import { runTaskWorkerFamily } from "../lib/task-worker-family.mjs";
import { taskWorkerFixtureStep, TASK_WORKER_FAMILY_ID } from "../lib/task-worker-scenario.mjs";

const fixtureNonce = "a".repeat(32);
const taskId = "12345678-1234-4234-9234-123456789abc";
const attemptId = "22345678-1234-4234-9234-123456789abc";
const bindingId = "32345678-1234-4234-9234-123456789abc";
const markerSha256 = "4".repeat(64);
const runtime = {
  checkout: "/fixture/checkout",
  dataDirectory: "/fixture/data",
  commit: "5".repeat(40),
  pid: 3210,
  connectionId: "qq-test-connection",
};
const target = {
  workspaceId: "workspace-fixture-1",
  herdrSession: "herdr-session-fixture-1",
  agentKind: "pi",
  markerSha256,
};
const scope = {
  connectionId: runtime.connectionId,
  botId: "10001",
  chatType: "private",
  chatId: "10002",
  senderId: "10002",
  threadId: null,
};

function uuid(index) {
  return `${String(index).padStart(8, "0")}-1234-4234-9234-123456789abc`;
}

function transport(stage, index) {
  const spec = taskWorkerFixtureStep(stage, { fixtureNonce, taskId });
  const token = String(index).padStart(32, "0");
  const runId = uuid(index + 100);
  const leaseId = uuid(index + 200);
  const expectedPrompt = `GLASSBOX_ACCEPTANCE_V1 ${token}\n${spec.prompt.replaceAll("{{nonce}}", token).trim()}`;
  const now = Date.now();
  const messageTime = Math.floor(now / 1000);
  const sentMessageId = String(10000 + index * 2);
  const botMessageId = String(10001 + index * 2);
  const replyMessageId = String(20000 + index);
  const replyTextSha256 = "6".repeat(64);
  const item = {
    id: spec.id,
    status: "PASS",
    route: "private",
    token,
    prompt: expectedPrompt,
    expected: [token],
    featureAssertions: spec.featureAssertions,
    leasedToolNames: spec.leaseTools.map(({ name }) => name),
    inputObserved: true,
    sendAttempted: true,
    leaseRegistrationAttempted: true,
    leaseRevoked: true,
    acceptanceLease: {
      leaseId,
      expiresAt: now + 60000,
      toolsSha256: toolManifestDigest(spec.leaseTools),
    },
    startedAt: new Date(now).toISOString(),
    sentMessageId,
    inputBinding: {
      botMessageId,
      driverMessageId: sentMessageId,
      realSequence: String(30000 + index),
      time: messageTime,
      driverTime: messageTime,
      textSha256: digest(expectedPrompt),
    },
    botInputMessageId: botMessageId,
    replies: [
      { route: "private", matches: true, messageId: replyMessageId, textSha256: replyTextSha256 },
    ],
    anomalies: [],
  };
  const feature = { status: "PASS", runId };
  return {
    runId,
    transportCase: item,
    productAcceptance: {
      status: "PASS",
      runtime,
      cases: [
        {
          caseId: spec.id,
          runId,
          traceVerified: true,
          cleanupVerified: true,
          feature,
          scope,
          delivery: { status: "sent", external_id: String(40000 + index) },
          messageBinding: {
            input: {
              realSequence: item.inputBinding.realSequence,
              time: messageTime,
              driverTime: messageTime,
              textSha256: item.inputBinding.textSha256,
            },
            reply: {
              botMessageId: String(40000 + index),
              driverMessageId: replyMessageId,
              realSequence: String(50000 + index),
              time: messageTime + 1,
              driverTime: messageTime + 1,
              textSha256: replyTextSha256,
            },
          },
        },
      ],
    },
  };
}

function receipt(stage, ctx) {
  const base = {
    stage,
    runId: ctx.runId,
    taskId,
    principalId: "principal-owner-1",
    principalKind: "owner",
    scope,
    cleanupVerified: true,
    creationRunId: ctx.creationRunId,
  };
  if (stage === "create")
    return {
      ...base,
      creationRunId: ctx.runId,
      taskStatus: "NEW",
      attemptId: null,
      bindingId: null,
    };
  if (stage === "delegate")
    return {
      ...base,
      attemptId,
      bindingId,
      workspaceId: target.workspaceId,
      herdrSession: target.herdrSession,
      agentKind: target.agentKind,
      dispatchVerified: true,
      taskStatus: "REVIEW",
      attemptStatus: "review",
    };
  if (stage === "inspect")
    return {
      ...base,
      attemptId,
      bindingId,
      taskStatus: "REVIEW",
      attemptStatus: "review",
      workerTerminalVerified: true,
      artifact: {
        filename: `qq-live-worker-${fixtureNonce}.txt`,
        sizeBytes: Buffer.byteLength(`${fixtureNonce}\n`),
        sha256: digest(Buffer.from(`${fixtureNonce}\n`)),
        fullContentVerified: true,
        markerSha256,
      },
    };
  return {
    ...base,
    attemptId,
    bindingId,
    acceptedRunId: ctx.runId,
    taskStatus: "DONE",
    attemptStatus: "succeeded",
    workerLeaseReleased: true,
    terminalVerified: true,
    pendingAttentionCount: 0,
  };
}

async function run(overrides = {}) {
  const sends = [];
  const checkpoints = [];
  let index = 0;
  const result = await runTaskWorkerFamily({
    fixtureNonce,
    expectedWorkerTarget: target,
    executeStep: async (stage) => {
      sends.push(stage);
      return transport(stage, ++index);
    },
    verifyStep: async (stage, context) => receipt(stage, context),
    checkpoint: async (item) => {
      checkpoints.push(item);
      return true;
    },
    readRuntime: async () => runtime,
    ...overrides,
  });
  return { result, sends, checkpoints };
}

test("Task Worker family runs four distinct verified private Runs and retains the artifact", async () => {
  const { result, sends, checkpoints } = await run();
  assert.equal(result.status, "PASS");
  assert.equal(result.familyId, TASK_WORKER_FAMILY_ID);
  assert.equal(result.taskId, taskId);
  assert.deepEqual(sends, ["create", "delegate", "inspect", "accept"]);
  assert.equal(new Set(result.stageRunIds).size, 4);
  assert.equal(result.terminalStatus, "DONE");
  assert.equal(result.artifact.fullContentVerified, true);
  assert.equal(result.cleanup.workerLeaseReleased, true);
  assert.equal(result.cleanup.pendingAttentionCount, 0);
  assert.equal(checkpoints.filter((item) => item.phase === "intent").length, 4);
  assert.equal(checkpoints.filter((item) => item.phase === "verified").length, 4);
});

test("Task Worker family stops before sending when intent checkpoint is not durable", async () => {
  let sends = 0;
  await assert.rejects(() =>
    runTaskWorkerFamily({
      fixtureNonce,
      expectedWorkerTarget: target,
      executeStep: async () => {
        sends += 1;
        return {};
      },
      verifyStep: async () => ({}),
      checkpoint: async () => false,
      readRuntime: async () => runtime,
    }),
  );
  assert.equal(sends, 0);
});

test("Task Worker family does not retry after a sent-stage checkpoint failure", async () => {
  let sends = 0;
  await assert.rejects(() =>
    runTaskWorkerFamily({
      fixtureNonce,
      expectedWorkerTarget: target,
      executeStep: async (stage) => {
        sends += 1;
        return transport(stage, sends);
      },
      verifyStep: async (stage, ctx) => receipt(stage, ctx),
      checkpoint: async ({ phase }) => phase !== "sent_unverified",
      readRuntime: async () => runtime,
    }),
  );
  assert.equal(sends, 1);
});

test("Task Worker family blocks acceptance if independent artifact proof is wrong", async () => {
  const sends = [];
  await assert.rejects(() =>
    runTaskWorkerFamily({
      fixtureNonce,
      expectedWorkerTarget: target,
      executeStep: async (stage) => {
        sends.push(stage);
        return transport(stage, sends.length);
      },
      verifyStep: async (stage, ctx) => {
        const value = receipt(stage, ctx);
        if (stage === "inspect") value.artifact.sha256 = "f".repeat(64);
        return value;
      },
      checkpoint: async () => true,
      readRuntime: async () => runtime,
    }),
  );
  assert.deepEqual(sends, ["create", "delegate", "inspect"]);
});

test("Task Worker family does not delegate unless creation proves an unstarted Task", async () => {
  const sends = [];
  await assert.rejects(() =>
    runTaskWorkerFamily({
      fixtureNonce,
      expectedWorkerTarget: target,
      executeStep: async (stage) => {
        sends.push(stage);
        return transport(stage, sends.length);
      },
      verifyStep: async (stage, ctx) => {
        const value = receipt(stage, ctx);
        if (stage === "create") value.taskStatus = "RUNNING";
        return value;
      },
      checkpoint: async () => true,
      readRuntime: async () => runtime,
    }),
  );
  assert.deepEqual(sends, ["create"]);
});

test("Task Worker family stops on runtime drift and never advances to the next send", async () => {
  const sends = [];
  let reads = 0;
  await assert.rejects(() =>
    runTaskWorkerFamily({
      fixtureNonce,
      expectedWorkerTarget: target,
      executeStep: async (stage) => {
        sends.push(stage);
        return transport(stage, sends.length);
      },
      verifyStep: async (stage, ctx) => receipt(stage, ctx),
      checkpoint: async () => true,
      readRuntime: async () => (++reads > 4 ? { ...runtime, pid: runtime.pid + 1 } : runtime),
    }),
  );
  assert.ok(sends.length <= 1);
});

test("Task Worker family rejects reused Run and lease identities before the next stage", async () => {
  for (const duplicate of ["run", "lease"]) {
    const sends = [];
    let first;
    await assert.rejects(() =>
      runTaskWorkerFamily({
        fixtureNonce,
        expectedWorkerTarget: target,
        executeStep: async (stage) => {
          sends.push(stage);
          const result = transport(stage, sends.length);
          if (sends.length === 1) first = result;
          else if (duplicate === "run") result.runId = first.runId;
          else
            result.transportCase.acceptanceLease.leaseId =
              first.transportCase.acceptanceLease.leaseId;
          return result;
        },
        verifyStep: async (stage, ctx) => receipt(stage, ctx),
        checkpoint: async () => true,
        readRuntime: async () => runtime,
      }),
    );
    assert.deepEqual(sends, ["create", "delegate"]);
  }
});

test("Task Worker family honors abort after a verified stage without resending it", async () => {
  const sends = [];
  const signal = { aborted: false };
  await assert.rejects(() =>
    runTaskWorkerFamily({
      fixtureNonce,
      expectedWorkerTarget: target,
      executeStep: async (stage) => {
        sends.push(stage);
        signal.aborted = true;
        return transport(stage, sends.length);
      },
      verifyStep: async (stage, ctx) => receipt(stage, ctx),
      checkpoint: async () => true,
      readRuntime: async () => runtime,
      signal,
    }),
  );
  assert.deepEqual(sends, ["create"]);
});
