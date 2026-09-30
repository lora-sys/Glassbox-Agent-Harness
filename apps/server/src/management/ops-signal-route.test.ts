import { mkdtemp, rm } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import type { TaskStep } from "@glassbox/contracts";
import { afterEach, expect, it } from "vite-plus/test";
import { ModelProfileStore } from "../config/model-profiles.js";
import { agentResourceId } from "../conversation/store.js";
import { FakeHerdrBridge } from "../ops/fake-herdr-bridge.js";
import { ManagementApplication } from "./application.js";

const directories: string[] = [];
const applications: ManagementApplication[] = [];
const now = "2026-09-27T00:00:00.000Z";
const system = { kind: "system", reason: "route signal test" } as const;
const limits = {
  maxSteps: 8,
  maxDependenciesPerStep: 4,
  maxFanOut: 4,
  maxReadySteps: 4,
  maxParallelSteps: 2,
};

afterEach(async () => {
  for (const app of applications.splice(0)) await app.close();
  for (const directory of directories.splice(0)) {
    const target = resolve(directory);
    if (
      dirname(target) !== resolve(tmpdir()) ||
      !basename(target).startsWith("glassbox-ops-signal-route-")
    )
      throw new Error("Invalid disposable Ops signal path");
    await rm(target, { recursive: true, force: true }).catch((error: NodeJS.ErrnoException) => {
      if (process.platform !== "win32" || error.code !== "EBUSY") throw error;
    });
  }
});

function jsonRequest(url: string, body: unknown): IncomingMessage {
  const stream = Readable.from([Buffer.from(JSON.stringify(body))]) as Readable & IncomingMessage;
  Object.assign(stream, {
    method: "POST",
    url,
    headers: { "content-type": "application/json" },
  });
  return stream;
}

it("authorizes Task signals through ManagementApplication and requires approval authority", async () => {
  const dataDirectory = await mkdtemp(join(tmpdir(), "glassbox-ops-signal-route-"));
  directories.push(dataDirectory);
  const models = await ModelProfileStore.open(dataDirectory);
  const app = await ManagementApplication.open({
    dataDirectory,
    databasePath: ":memory:",
    kitPath: new URL("../runtime/pi/fixtures/lora-pi-kit", import.meta.url).pathname,
    models,
    ops: {
      bridge: new FakeHerdrBridge("signal-session"),
      workerTarget: { workspaceId: "signal-workspace", agentKind: "test" },
    },
  });
  applications.push(app);
  const runtimePort = (
    app as unknown as {
      longWorkRuntimePort: { wake(taskId: string): Promise<void> };
    }
  ).longWorkRuntimePort;
  runtimePort.wake = async () => undefined;

  const ownerScope = {
    connectionId: "signal-channel",
    botId: "signal-bot",
    chatType: "private" as const,
    chatId: "owner",
    senderId: "owner",
  };
  await app.store.identities.bindOwner("owner", ownerScope);
  const ownerRunGrant = await app.store.authorization.grant({
    principalId: "owner",
    resourceId: agentResourceId("personal"),
    action: "run:create",
    scope: ownerScope,
    effect: "allow",
  });
  await app.store.authorization.grant({
    principalId: "owner",
    resourceId: agentResourceId("personal"),
    action: "conversation:read",
    scope: ownerScope,
    effect: "allow",
  });
  const ownerAccepted = await app.store.conversations.acceptIncoming({
    agentId: "personal",
    scope: ownerScope,
    messageId: "signal-owner-message",
    text: "Task signal fixture",
    executionRef: "signal-test",
  });

  const visitorScope = { ...ownerScope, chatId: "visitor", senderId: "visitor" };
  await app.store.identities.createPrincipal("visitor", "visitor");
  await app.store.identities.bindPrincipal("visitor", visitorScope);
  await app.store.authorization.grant({
    principalId: "visitor",
    resourceId: agentResourceId("personal"),
    action: "run:create",
    scope: visitorScope,
    effect: "allow",
  });
  await app.store.authorization.grant({
    principalId: "visitor",
    resourceId: agentResourceId("personal"),
    action: "conversation:read",
    scope: visitorScope,
    effect: "allow",
  });
  const visitorAccepted = await app.store.conversations.acceptIncoming({
    agentId: "personal",
    scope: visitorScope,
    messageId: "signal-visitor-message",
    text: "Visitor signal fixture",
    executionRef: "signal-test",
  });

  async function waitingTask(kind: "signal_wait" | "approval_wait", name: string) {
    const task = await app.store.tasks.createTask({
      title: `${name} Task`,
      creatorPrincipalId: "owner",
      runId: ownerAccepted.run.id,
      conversationId: ownerAccepted.conversation.id,
      authorizationScope: ownerScope,
    });
    const step: TaskStep = {
      id: `${name}-step`,
      taskId: task.id,
      kind,
      title: name,
      status: "pending",
      dependencyIds: [],
      dependencyPolicy: { failed: "block", cancelled: "cancel", skipped: "skip" },
      maxAttempts: 1,
      waitPolicy: {
        version: 1,
        kind: kind === "signal_wait" ? "signal" : "approval",
        signalKey: name,
        overdue: "stale",
      },
      requiredCapabilities: [],
      delegatedPermissionSet: [],
      version: 1,
      createdAt: now,
      updatedAt: now,
    };
    await app.store.longWork.createGraph(task.id, [step], step.id, limits, system);
    await app.store.longWork.transitionStep({
      taskId: task.id,
      stepId: step.id,
      expectedVersion: 1,
      from: "pending",
      to: "ready",
      origin: system,
    });
    await app.store.longWork.transitionStep({
      taskId: task.id,
      stepId: step.id,
      expectedVersion: 2,
      from: "ready",
      to: "running",
      origin: system,
    });
    await app.store.longWork.createWait({
      id: `${name}-wait`,
      taskId: task.id,
      stepId: step.id,
      expectedStepVersion: 3,
      policy: {
        version: 1,
        kind: kind === "signal_wait" ? "signal" : "approval",
        signalKey: name,
        overdue: "stale",
      },
      origin: system,
    });
    return { task, step };
  }

  const signal = await waitingTask("signal_wait", "continue");
  const signalGrant = await app.store.authorization.grant({
    principalId: "owner",
    resourceId: `task-${signal.task.id}`,
    action: "task:signal",
    scope: ownerScope,
    effect: "allow",
  });
  const signalBody = {
    runId: ownerAccepted.run.id,
    stepId: signal.step.id,
    targetStepVersion: 4,
    type: "continue",
    idempotencyKey: "continue-owner-1",
  };
  await expect(
    app.route(jsonRequest(`/manage/ops/tasks/${signal.task.id}/signal`, signalBody)),
  ).resolves.toMatchObject({ status: 200, body: { signal: { disposition: "applied" } } });
  await expect(
    app.route(
      jsonRequest(`/manage/ops/tasks/${signal.task.id}/signal`, {
        ...signalBody,
        runId: visitorAccepted.run.id,
        idempotencyKey: "continue-visitor-1",
      }),
    ),
  ).rejects.toThrow();
  await app.store.authorization.revoke(signalGrant);
  await expect(
    app.route(
      jsonRequest(`/manage/ops/tasks/${signal.task.id}/signal`, {
        ...signalBody,
        idempotencyKey: "continue-owner-revoked-1",
      }),
    ),
  ).rejects.toThrow();

  const approval = await waitingTask("approval_wait", "confirm");
  await app.store.authorization.grant({
    principalId: "owner",
    resourceId: `task-${approval.task.id}`,
    action: "task:signal",
    scope: ownerScope,
    effect: "allow",
  });
  const approvalBody = {
    runId: ownerAccepted.run.id,
    stepId: approval.step.id,
    targetStepVersion: 4,
    type: "confirm",
    idempotencyKey: "confirm-owner-1",
    approval: true,
  };
  await expect(
    app.route(jsonRequest(`/manage/ops/tasks/${approval.task.id}/signal`, approvalBody)),
  ).rejects.toThrow();
  await app.store.authorization.grant({
    principalId: "owner",
    resourceId: `task-${approval.task.id}`,
    action: "task:approve",
    scope: ownerScope,
    effect: "allow",
  });
  await expect(
    app.route(
      jsonRequest(`/manage/ops/tasks/${approval.task.id}/signal`, {
        ...approvalBody,
        idempotencyKey: "confirm-owner-approved-1",
      }),
    ),
  ).resolves.toMatchObject({ status: 200, body: { signal: { disposition: "applied" } } });
  await app.store.authorization.revoke(ownerRunGrant);
});
