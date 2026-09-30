import { afterEach, expect, it, vi } from "vite-plus/test";
import type { TaskStep } from "@glassbox/contracts";
import { openDomainStore, type CallerContext, type DomainStore } from "../persistence/index.js";
import { conversationScopeKey, scopeKey } from "../identity/scope.js";

const scope = {
  connectionId: "test",
  botId: "bot",
  chatType: "private" as const,
  chatId: "owner",
  senderId: "owner",
};
const caller: CallerContext = { principalId: "owner", scope };
const system = { kind: "system", reason: "worker tool test" } as const;
const limits = {
  maxSteps: 8,
  maxDependenciesPerStep: 4,
  maxFanOut: 4,
  maxReadySteps: 4,
  maxParallelSteps: 2,
};
const stores: DomainStore[] = [];

function step(taskId: string, id: string, kind: TaskStep["kind"]): TaskStep {
  const now = new Date().toISOString();
  return {
    id,
    taskId,
    kind,
    title: id,
    status: "pending",
    dependencyIds: [],
    dependencyPolicy: { failed: "block", cancelled: "cancel", skipped: "skip" },
    maxAttempts: 1,
    requiredCapabilities: [],
    delegatedPermissionSet: [],
    version: 1,
    createdAt: now,
    updatedAt: now,
  };
}

async function fixture(options: { child?: boolean; originRun?: boolean } = {}) {
  const store = await openDomainStore({ databasePath: ":memory:" });
  stores.push(store);
  await store.identities.bindOwner(caller.principalId, scope);
  await store.authorization.registerResource({
    id: "worker-files",
    kind: "worker-files",
    visibility: "public",
  });
  await store.authorization.registerResource({
    id: "workspace:workspace-1",
    kind: "workspace",
    visibility: "public",
  });
  await store.authorization.grant({
    principalId: caller.principalId,
    resourceId: "worker-files",
    action: "worker:file:read",
    scope,
    effect: "allow",
  });

  if (options.originRun) {
    await store.db.transaction(async (tx) => {
      await tx.execute({
        sql: "INSERT OR IGNORE INTO agents(id,created_at) VALUES ('personal',?)",
        args: [new Date().toISOString()],
      });
      await tx.execute({
        sql: "INSERT INTO resources(id,kind,visibility,owner_id) VALUES ('conversation:origin','conversation','private','owner')",
      });
      await tx.execute({
        sql: "INSERT INTO conversations(id,agent_id,principal_id,scope_key,scope_json,resource_id,created_at) VALUES ('origin-conversation','personal','owner',? ,?,'conversation:origin',?)",
        args: [conversationScopeKey(scope), JSON.stringify(scope), new Date().toISOString()],
      });
      await tx.execute({
        sql: "INSERT INTO messages(id,conversation_id,scope_key,external_id,text,created_at) VALUES ('origin-message','origin-conversation',?,'origin-external','',?)",
        args: [scopeKey(scope), new Date().toISOString()],
      });
      await tx.execute({
        sql: "INSERT INTO runs(id,conversation_id,message_id,principal_id,scope_json,execution_ref,status,source,created_at,updated_at) VALUES ('origin-run','origin-conversation','origin-message','owner',?,'pi:test','succeeded','external',?,?)",
        args: [JSON.stringify(scope), new Date().toISOString(), new Date().toISOString()],
      });
    });
  }
  await store.authorization.grant({
    principalId: caller.principalId,
    resourceId: "workspace:workspace-1",
    action: "workspace:read",
    scope,
    effect: "allow",
  });

  let parentId: string | undefined;
  if (options.child) {
    const parent = await store.tasks.createTask({
      id: "parent-task",
      title: "Parent",
      creatorPrincipalId: caller.principalId,
      authorizationScope: scope,
    });
    parentId = parent.id;
    await store.longWork.createGraph(
      parent.id,
      [step(parent.id, "child-step", "child_task")],
      "child-step",
      limits,
      system,
    );
    await store.db.transaction((tx) =>
      tx
        .execute({
          sql: "UPDATE task_steps SET status = 'running' WHERE id = 'child-step'",
        })
        .then(() => undefined),
    );
  }

  const task = await store.tasks.createTask({
    id: options.child ? "child-task" : "durable-task",
    title: "Durable Worker",
    creatorPrincipalId: caller.principalId,
    authorizationScope: scope,
    ...(options.originRun ? { conversationId: "origin-conversation", runId: "origin-run" } : {}),
  });
  const continueGrant = await store.authorization.grant({
    principalId: caller.principalId,
    resourceId: `task-${task.id}`,
    action: "task:continue",
    scope,
    effect: "allow",
  });
  const continueDecisionId = "continue-decision";
  await store.db.transaction((tx) =>
    tx
      .execute({
        sql: `INSERT INTO authorization_decisions(
              id,principal_id,resource_id,action,scope_key,decision,reason,grant_id,created_at
            ) VALUES (?,?,?,'task:continue',?,'ALLOW','test',?,?)`,
        args: [
          continueDecisionId,
          caller.principalId,
          `task-${task.id}`,
          scopeKey(scope),
          continueGrant,
          new Date().toISOString(),
        ],
      })
      .then(() => undefined),
  );
  if (options.child) {
    await store.db.transaction((tx) =>
      tx
        .execute({
          sql: `INSERT INTO task_child_links(
                child_task_id,parent_task_id,parent_step_id,delegated_permissions_json,
                acceptance_criteria_json,cancel_policy,failure_policy,created_at
              ) VALUES (?,?,?,?,'[]','cancel_child','block_parent',?)`,
          args: [
            task.id,
            parentId!,
            "child-step",
            JSON.stringify([{ resourceId: "worker-files", action: "worker:file:read" }]),
            new Date().toISOString(),
          ],
        })
        .then(() => undefined),
    );
  }
  const stepId = options.child ? "child-worker-step" : "worker-step";
  const workerStep = {
    ...step(task.id, stepId, "herdr_worker"),
    delegatedPermissionSet: [
      { resourceId: "worker-files", action: "worker:file:read" },
      { resourceId: "workspace:workspace-1", action: "workspace:read" },
    ],
  };
  await store.longWork.createGraph(task.id, [workerStep], stepId, limits, system);
  await store.longWork.transitionStep({
    taskId: task.id,
    stepId,
    expectedVersion: 1,
    from: "pending",
    to: "ready",
    origin: system,
  });
  await store.longWork.claimReadyStep({
    taskId: task.id,
    stepId,
    expectedStepVersion: 2,
    attemptId: "worker-attempt",
    leaseId: "worker-lease",
    ownerInstanceId: "executor",
    leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    origin: {
      kind: "decision",
      decisionId: continueDecisionId,
      actorPrincipalId: caller.principalId,
    },
  });
  const binding = await store.tasks.bindWorker({
    taskAttemptId: "worker-attempt",
    herdrSession: "session",
    workspaceId: "workspace-1",
    paneId: "pane",
    agentKind: "codex",
  });
  await store.longWork.attachClaimedWorkerBinding({
    taskId: task.id,
    stepId,
    attemptId: "worker-attempt",
    leaseId: "worker-lease",
    workerBindingId: binding.id,
    ownerInstanceId: "executor",
    expectedStepVersion: 3,
    expectedLeaseVersion: 1,
    origin: system,
  });
  await store.db.transaction((tx) =>
    tx
      .execute({
        sql: "UPDATE tasks SET status = 'RUNNING' WHERE id = ?",
        args: [task.id],
      })
      .then(() => undefined),
  );
  return { store, task };
}

afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
});

function execute(store: DomainStore, taskId: string, operation: () => Promise<string>) {
  return store.tasks.executeWorkerTool(
    {
      caller,
      taskId,
      attemptId: "worker-attempt",
      resourceId: "worker-files",
      action: "worker:file:read",
      allowedActions: ["worker:file:read"],
      callId: "call-1",
      productWorkspaceId: "workspace-1",
    },
    operation,
  );
}

it("allows a durable Worker Tool while its running Step, Attempt, lease, and binding are live", async () => {
  const { store, task } = await fixture();
  const operation = vi.fn(async () => "result");

  await expect(execute(store, task.id, operation)).resolves.toBe("result");
  expect(operation).toHaveBeenCalledOnce();
});

it("preserves the external origin Run while checking durable Worker Task delegation", async () => {
  const { store, task } = await fixture({ originRun: true });
  const operation = vi.fn(async () => "result");

  await expect(execute(store, task.id, operation)).resolves.toBe("result");
  expect(operation).toHaveBeenCalledOnce();
  const decisions = await store.db.transaction((tx) =>
    tx.execute({
      sql: "SELECT run_id,decision FROM authorization_decisions WHERE run_id = 'origin-run' AND resource_id = 'worker-files' ORDER BY created_at DESC LIMIT 1",
    }),
  );
  expect(decisions.rows[0]).toMatchObject({ run_id: "origin-run", decision: "ALLOW" });
});

it("rejects durable Worker Tools after the active Step lease expires", async () => {
  const { store, task } = await fixture();
  await store.db.transaction((tx) =>
    tx
      .execute({
        sql: "UPDATE task_step_leases SET expires_at = ? WHERE id = 'worker-lease'",
        args: [new Date(Date.now() - 1_000).toISOString()],
      })
      .then(() => undefined),
  );
  const operation = vi.fn(async () => "result");

  await expect(execute(store, task.id, operation)).rejects.toThrow("worker_tool_denied_or_failed");
  expect(operation).not.toHaveBeenCalled();
});

it("rejects durable Worker Tools after Task cancellation is requested", async () => {
  const { store, task } = await fixture();
  await store.db.transaction((tx) =>
    tx
      .execute({
        sql: "UPDATE tasks SET cancellation_state = 'requested' WHERE id = ?",
        args: [task.id],
      })
      .then(() => undefined),
  );
  const operation = vi.fn(async () => "result");

  await expect(execute(store, task.id, operation)).rejects.toThrow("worker_tool_denied_or_failed");
  expect(operation).not.toHaveBeenCalled();
});

it("rejects a Worker Tool absent from the claimed Step permission set", async () => {
  const { store, task } = await fixture();
  await store.db.transaction((tx) =>
    tx
      .execute({
        sql: "UPDATE task_steps SET delegated_permissions_json = '[]' WHERE id = 'worker-step'",
      })
      .then(() => undefined),
  );
  const operation = vi.fn(async () => "result");

  await expect(execute(store, task.id, operation)).rejects.toThrow("worker_tool_denied_or_failed");
  expect(operation).not.toHaveBeenCalled();
});

it("rechecks current grants before a durable Worker Tool runs", async () => {
  const { store, task } = await fixture();
  const grants = await store.db.transaction((tx) =>
    tx.execute({
      sql: "SELECT id FROM grants WHERE resource_id = 'worker-files' AND action = 'worker:file:read'",
    }),
  );
  const grantId = grants.rows[0]?.id;
  if (typeof grantId !== "string") throw new Error("Missing file grant");
  await store.authorization.revoke(grantId);
  const operation = vi.fn(async () => "result");

  await expect(execute(store, task.id, operation)).rejects.toThrow("Access denied");
  expect(operation).not.toHaveBeenCalled();
});

it("applies child Task delegated permissions to workspace authorization", async () => {
  const { store, task } = await fixture({ child: true });
  const operation = vi.fn(async () => "result");

  await expect(execute(store, task.id, operation)).rejects.toThrow("Access denied");
  expect(operation).not.toHaveBeenCalled();
});
