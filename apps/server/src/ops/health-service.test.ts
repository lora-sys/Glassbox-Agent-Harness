import { expect, it } from "vite-plus/test";
import { AccessDeniedError, openDomainStore, type CallerContext } from "../persistence/index.js";
import { FakeHerdrBridge } from "./fake-herdr-bridge.js";
import { AuthorizedOpsService } from "./service.js";

const caller: CallerContext = {
  principalId: "health-owner",
  scope: {
    connectionId: "health-test",
    botId: "health-bot",
    chatType: "private",
    chatId: "health-owner",
    senderId: "health-owner",
  },
};

async function grant(
  store: Awaited<ReturnType<typeof openDomainStore>>,
  resourceId: string,
  action: string,
) {
  await store.authorization.grant({
    principalId: caller.principalId,
    resourceId,
    action,
    scope: caller.scope,
    effect: "allow",
  });
}

it("returns caller-visible Ops health using durable acceptance and explicit Herdr state", async () => {
  const store = await openDomainStore({ databasePath: ":memory:" });
  try {
    await store.identities.bindOwner(caller.principalId, caller.scope);
    await store.authorization.registerResource({
      id: "agent-operations",
      kind: "ops",
      visibility: "public",
    });
    await grant(store, "agent-operations", "ops:status");

    const acceptedTask = await store.tasks.createTask({
      title: "Accepted task",
      creatorPrincipalId: caller.principalId,
      authorizationScope: caller.scope,
    });
    const acceptedAttempt = await store.tasks.createAttempt({ taskId: acceptedTask.id });
    await store.tasks.updateAttemptStatus(acceptedAttempt.id, "review");
    await store.tasks.updateTaskStatus(acceptedTask.id, "REVIEW");
    await store.tasks.acceptTask(acceptedTask.id, caller.principalId);
    await grant(store, `task-${acceptedTask.id}`, "task:read");

    const reviewTask = await store.tasks.createTask({
      title: "Waiting review",
      creatorPrincipalId: caller.principalId,
      authorizationScope: caller.scope,
    });
    const reviewAttempt = await store.tasks.createAttempt({ taskId: reviewTask.id });
    await store.tasks.bindWorker({
      taskAttemptId: reviewAttempt.id,
      herdrSession: "health-session",
      workspaceId: "health-workspace",
      paneId: "health-pane",
      agentName: "test-worker",
      agentKind: "test",
    });
    await store.tasks.updateAttemptStatus(reviewAttempt.id, "review");
    await store.tasks.updateTaskStatus(reviewTask.id, "REVIEW");
    await grant(store, `task-${reviewTask.id}`, "task:read");

    const hiddenTask = await store.tasks.createTask({
      title: "Hidden task",
      creatorPrincipalId: caller.principalId,
      authorizationScope: caller.scope,
    });
    const hiddenAttempt = await store.tasks.createAttempt({ taskId: hiddenTask.id });
    await store.tasks.bindWorker({
      taskAttemptId: hiddenAttempt.id,
      herdrSession: "health-session",
      workspaceId: "health-workspace",
      paneId: "hidden-pane",
      agentName: "hidden-worker",
      agentKind: "test",
    });

    const service = new AuthorizedOpsService(store, new FakeHerdrBridge());
    const now = new Date(Date.now() + 5_000).toISOString();
    const result = await service.health(caller, {
      now,
      windowStart: "2000-01-01T00:00:00.000Z",
      herdr: {
        bridgeState: "connected",
        eventsLost: false,
        lastSuccessfulReconciliationAt: now,
        observations: [{ taskAttemptId: reviewAttempt.id, state: "done", observedAt: now }],
      },
    });

    expect(result.durable).toMatchObject({
      activeTasks: 0,
      waitingReviewTasks: 1,
      acceptedTasksInWindow: 1,
      attemptsInWindow: 2,
      reworkAttempts: 0,
    });
    expect(result.durable.meanReviewLatencyMs).not.toBeNull();
    expect(result.workers).toMatchObject({ total: 1, done: 1, unknown: 0 });
  } finally {
    await store.close();
  }
});

it("requires Ops status authorization before loading health records", async () => {
  const store = await openDomainStore({ databasePath: ":memory:" });
  try {
    await store.identities.bindOwner(caller.principalId, caller.scope);
    await store.authorization.registerResource({
      id: "agent-operations",
      kind: "ops",
      visibility: "public",
    });
    const service = new AuthorizedOpsService(store, new FakeHerdrBridge());

    await expect(
      service.health(caller, {
        now: new Date().toISOString(),
        windowStart: "2000-01-01T00:00:00.000Z",
        herdr: {
          bridgeState: "unknown",
          eventsLost: false,
          lastSuccessfulReconciliationAt: null,
          observations: [],
        },
      }),
    ).rejects.toBeInstanceOf(AccessDeniedError);
  } finally {
    await store.close();
  }
});
