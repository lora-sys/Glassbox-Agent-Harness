import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { afterEach, expect, it } from "vite-plus/test";
import { ModelProfileStore } from "../config/model-profiles.js";
import { AccessDeniedError } from "../auth/service.js";
import { agentResourceId } from "../conversation/store.js";
import { FakeHerdrBridge } from "../ops/fake-herdr-bridge.js";
import { ManagementApplication } from "./application.js";

const directories: string[] = [];
const applications: ManagementApplication[] = [];

afterEach(async () => {
  for (const app of applications.splice(0)) await app.close();
  for (const directory of directories.splice(0)) {
    const target = resolve(directory);
    if (
      dirname(target) !== resolve(tmpdir()) ||
      !basename(target).startsWith("glassbox-ops-health-route-")
    )
      throw new Error("Invalid disposable Ops health path");
    await rm(target, { recursive: true, force: true }).catch((error: NodeJS.ErrnoException) => {
      if (process.platform !== "win32" || error.code !== "EBUSY") throw error;
    });
  }
});

it("serves authorized Owner health and rejects out-of-scope or revoked Ops status access", async () => {
  const dataDirectory = await mkdtemp(join(tmpdir(), "glassbox-ops-health-route-"));
  directories.push(dataDirectory);
  const bridge = new FakeHerdrBridge("health-session");
  const models = await ModelProfileStore.open(dataDirectory);
  const app = await ManagementApplication.open({
    dataDirectory,
    databasePath: ":memory:",
    kitPath: new URL("../runtime/pi/fixtures/lora-pi-kit", import.meta.url).pathname,
    models,
    ops: { bridge, workerTarget: { workspaceId: "health-workspace", agentKind: "test" } },
  });
  applications.push(app);

  const ownerScope = {
    connectionId: "health-channel",
    botId: "health-bot",
    chatType: "private" as const,
    chatId: "owner",
    senderId: "owner",
  };
  await app.store.identities.bindOwner("owner", ownerScope);
  const agentResource = agentResourceId("personal");
  const ownerRunGrant = await app.store.authorization.grant({
    principalId: "owner",
    resourceId: agentResource,
    action: "run:create",
    scope: ownerScope,
    effect: "allow",
  });
  await app.store.authorization.grant({
    principalId: "owner",
    resourceId: agentResource,
    action: "conversation:read",
    scope: ownerScope,
    effect: "allow",
  });
  const ownerRun = await app.store.conversations.acceptIncoming({
    agentId: "personal",
    scope: ownerScope,
    messageId: "health-owner-run",
    text: "fixture",
    executionRef: "health-fixture",
  });

  await app.store.authorization.registerResource({
    id: "agent-operations",
    kind: "ops",
    visibility: "public",
  });
  const opsGrant = await app.store.authorization.grant({
    principalId: "owner",
    resourceId: "agent-operations",
    action: "ops:status",
    scope: ownerScope,
    effect: "allow",
  });

  const task = await app.store.tasks.createTask({
    title: "Worker health fixture",
    creatorPrincipalId: "owner",
    authorizationScope: ownerScope,
  });
  const attempt = await app.store.tasks.createAttempt({ taskId: task.id });
  await app.store.tasks.bindWorker({
    taskAttemptId: attempt.id,
    herdrSession: "health-session",
    workspaceId: "health-workspace",
    paneId: "missing-live-pane",
    agentKind: "test",
    lastObservedAgentState: "unknown",
  });
  await app.store.authorization.grant({
    principalId: "owner",
    resourceId: `task-${task.id}`,
    action: "task:read",
    scope: ownerScope,
    effect: "allow",
  });

  const ownerResponse = await app.route({
    method: "GET",
    url: `/manage/ops/health?runId=${ownerRun.run.id}`,
    headers: {},
  } as never);
  expect(ownerResponse).toMatchObject({
    status: 200,
    body: {
      health: {
        durable: { activeTasks: 1 },
        workers: { total: 1, unknown: 1 },
        herdr: { state: "healthy", stale: false },
      },
    },
  });

  await app.store.identities.createPrincipal("visitor", "visitor");
  const visitorScope = { ...ownerScope, chatId: "visitor", senderId: "visitor" };
  await app.store.identities.bindPrincipal("visitor", visitorScope);
  await app.store.authorization.grant({
    principalId: "visitor",
    resourceId: agentResource,
    action: "run:create",
    scope: visitorScope,
    effect: "allow",
  });
  const visitorRun = await app.store.conversations.acceptIncoming({
    agentId: "personal",
    scope: visitorScope,
    messageId: "health-visitor-run",
    text: "fixture",
    executionRef: "health-fixture",
  });
  await expect(
    app.route({
      method: "GET",
      url: `/manage/ops/health?runId=${visitorRun.run.id}`,
      headers: {},
    } as never),
  ).rejects.toMatchObject({ status: 404 });

  await app.store.authorization.revoke(opsGrant);
  await expect(
    app.route({
      method: "GET",
      url: `/manage/ops/health?runId=${ownerRun.run.id}`,
      headers: {},
    } as never),
  ).rejects.toBeInstanceOf(AccessDeniedError);
  await app.store.authorization.revoke(ownerRunGrant);
});
