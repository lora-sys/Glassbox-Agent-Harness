import { expect, it } from "vite-plus/test";
import type { CallerContext, TrustedChannelScope } from "../identity/scope.js";
import { AccessDeniedError, AuthorizationService } from "../auth/service.js";
import { IdentityService } from "../identity/service.js";
import { DomainDatabase } from "../persistence/database.js";
import type { TaskStep } from "@glassbox/contracts";
import { LongWorkStore } from "./long-work-store.js";
import { DEFAULT_TASK_GRAPH_LIMITS } from "./task-graph.js";
import { authorizeLongWorkAction } from "./long-work-authority.js";
import { TaskStore } from "./task-store.js";

const scope: TrustedChannelScope = {
  connectionId: "connection-1",
  botId: "bot-1",
  chatType: "private",
  chatId: "chat-1",
  senderId: "sender-1",
};
const caller: CallerContext = { principalId: "owner-1", scope };
const system = { kind: "system", reason: "authority test" } as const;

const waitingStep: TaskStep = {
  id: "step-1",
  taskId: "task-1",
  kind: "signal_wait",
  title: "Wait for signal",
  status: "pending",
  dependencyIds: [],
  dependencyPolicy: { failed: "block", cancelled: "cancel", skipped: "skip" },
  maxAttempts: 1,
  waitPolicy: { version: 1, kind: "signal", signalKey: "resume", overdue: "stale" },
  requiredCapabilities: [],
  delegatedPermissionSet: [],
  version: 1,
  createdAt: "2026-09-27T00:00:00.000Z",
  updatedAt: "2026-09-27T00:00:00.000Z",
};

async function fixture() {
  const db = await DomainDatabase.open(":memory:");
  return {
    store: {
      db,
      authorization: new AuthorizationService(db),
      identities: new IdentityService(db),
      tasks: new TaskStore(db),
      longWork: new LongWorkStore(db),
    },
    cleanup: () => db.close(),
  };
}

async function setup(store: Awaited<ReturnType<typeof fixture>>["store"]) {
  await store.identities.bindOwner(caller.principalId, scope);
  await store.tasks.createTask({
    id: "task-1",
    title: "Durable Task",
    creatorPrincipalId: caller.principalId,
    authorizationScope: scope,
  });
  await store.authorization.grant({
    principalId: caller.principalId,
    resourceId: "task-task-1",
    action: "task:continue",
    scope,
    effect: "allow",
  });
}

it("rechecks the current grant after a durable wait", async () => {
  const { store, cleanup } = await fixture();
  try {
    await setup(store);
    await store.longWork.createGraph(
      "task-1",
      [waitingStep],
      "step-1",
      DEFAULT_TASK_GRAPH_LIMITS,
      system,
    );
    await store.longWork.transitionStep({
      taskId: "task-1",
      stepId: "step-1",
      expectedVersion: 1,
      from: "pending",
      to: "ready",
      origin: system,
    });
    await store.longWork.createWait({
      id: "wait-1",
      taskId: "task-1",
      stepId: "step-1",
      expectedStepVersion: 2,
      policy: waitingStep.waitPolicy!,
      origin: system,
    });
    await authorizeLongWorkAction(store, {
      taskId: "task-1",
      caller,
      resourceId: "task-task-1",
      action: "task:continue",
    });
    await store.authorization.revokeScopeAction({
      principalId: caller.principalId,
      resourceId: "task-task-1",
      action: "task:continue",
      scope,
    });
    await expect(
      authorizeLongWorkAction(store, {
        taskId: "task-1",
        resourceId: "task-task-1",
        action: "task:continue",
      }),
    ).rejects.toBeInstanceOf(AccessDeniedError);
  } finally {
    await cleanup();
  }
});

it("reconstructs a migrated Task scope from its canonical scope key", async () => {
  const { store, cleanup } = await fixture();
  try {
    await setup(store);
    await store.db.transaction(async (tx) => {
      await tx.execute("UPDATE tasks SET origin_scope_json = NULL WHERE id = 'task-1'");
    });
    const decisionId = await authorizeLongWorkAction(store, {
      taskId: "task-1",
      caller,
      resourceId: "task-task-1",
      action: "task:continue",
    });
    expect(decisionId).toBeTruthy();
  } finally {
    await cleanup();
  }
});

it("rejects a caller whose principal or exact scope differs from the Task origin", async () => {
  const { store, cleanup } = await fixture();
  try {
    await setup(store);
    await expect(
      authorizeLongWorkAction(store, {
        taskId: "task-1",
        caller: { ...caller, principalId: "other-principal" },
        resourceId: "task-task-1",
        action: "task:continue",
      }),
    ).rejects.toThrow("does not match Task creator");
    await expect(
      authorizeLongWorkAction(store, {
        taskId: "task-1",
        caller: {
          ...caller,
          scope: { ...scope, chatId: "different-chat" },
        },
        resourceId: "task-task-1",
        action: "task:continue",
      }),
    ).rejects.toThrow("does not match Task origin");
  } finally {
    await cleanup();
  }
});

it("denies continuation when the current identity binding changed", async () => {
  const { store, cleanup } = await fixture();
  try {
    await setup(store);
    await store.identities.createPrincipal("other-principal", "visitor");
    await store.identities.bindPrincipal("other-principal", scope);
    await expect(
      authorizeLongWorkAction(store, {
        taskId: "task-1",
        resourceId: "task-task-1",
        action: "task:continue",
      }),
    ).rejects.toBeInstanceOf(AccessDeniedError);
  } finally {
    await cleanup();
  }
});
