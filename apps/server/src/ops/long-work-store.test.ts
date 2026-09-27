import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vite-plus/test";
import type { TaskStep } from "@glassbox/contracts";
import { DomainDatabase } from "../persistence/database.js";
import {
  LongWorkStore,
  MAX_CHILD_TASK_ANCESTOR_DEPTH,
  MAX_CHILD_TASKS_PER_PARENT,
} from "./long-work-store.js";
import { TaskStore } from "./task-store.js";
import { parseTaskGetSpec } from "./tool-step-spec.js";

const now = "2026-09-27T00:00:00.000Z";
const system = { kind: "system", reason: "test scheduler" } as const;
const claimOrigin = {
  kind: "decision",
  decisionId: "continue-decision",
  actorPrincipalId: "owner",
} as const;
const limits = {
  maxSteps: 8,
  maxDependenciesPerStep: 4,
  maxFanOut: 4,
  maxReadySteps: 4,
  maxParallelSteps: 2,
};

function step(id: string, dependencyIds: string[] = [], kind: TaskStep["kind"] = "join"): TaskStep {
  return {
    id,
    taskId: "task-1",
    kind,
    title: id,
    status: "pending",
    dependencyIds,
    dependencyPolicy: { failed: "block", cancelled: "cancel", skipped: "skip" },
    maxAttempts: 1,
    requiredCapabilities: [],
    delegatedPermissionSet: [],
    ...(kind === "timer_wait"
      ? {
          waitPolicy: {
            version: 1,
            kind: "duration" as const,
            durationMs: 1_000,
            overdue: "resume" as const,
          },
        }
      : kind === "signal_wait"
        ? {
            waitPolicy: {
              version: 1,
              kind: "signal" as const,
              signalKey: "continue",
              overdue: "resume" as const,
            },
          }
        : kind === "approval_wait"
          ? {
              waitPolicy: {
                version: 1,
                kind: "approval" as const,
                signalKey: "approve",
                overdue: "stale" as const,
              },
            }
          : {}),
    version: 1,
    createdAt: now,
    updatedAt: now,
  };
}

async function succeedStep(store: LongWorkStore, stepId: string, version = 1): Promise<void> {
  await store.transitionStep({
    taskId: "task-1",
    stepId,
    expectedVersion: version,
    from: "pending",
    to: "ready",
    origin: system,
  });
  await store.transitionStep({
    taskId: "task-1",
    stepId,
    expectedVersion: version + 1,
    from: "ready",
    to: "running",
    origin: system,
  });
  await store.transitionStep({
    taskId: "task-1",
    stepId,
    expectedVersion: version + 2,
    from: "running",
    to: "succeeded",
    origin: system,
  });
}

async function settleWorkerStep(
  store: LongWorkStore,
  outcome: "review" | "unknown" = "review",
  maxAttempts = 3,
): Promise<TaskStep> {
  await store.createGraph(
    "task-1",
    [{ ...step("worker", [], "herdr_worker"), maxAttempts }],
    "worker",
    limits,
    system,
  );
  await store.transitionStep({
    taskId: "task-1",
    stepId: "worker",
    expectedVersion: 1,
    from: "pending",
    to: "ready",
    origin: system,
  });
  await store.claimReadyStep({
    taskId: "task-1",
    stepId: "worker",
    expectedStepVersion: 2,
    attemptId: "worker-attempt",
    leaseId: "worker-lease",
    ownerInstanceId: "executor-1",
    leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    origin: claimOrigin,
  });
  return store.settleClaimedStep({
    taskId: "task-1",
    stepId: "worker",
    attemptId: "worker-attempt",
    leaseId: "worker-lease",
    ownerInstanceId: "executor-1",
    expectedStepVersion: 3,
    expectedLeaseVersion: 1,
    outcome,
    evidenceRef: outcome === "unknown" ? "trace:worker-lost" : "trace:worker-result",
    outputRef: outcome === "review" ? "artifact:worker-result" : undefined,
    origin: system,
  });
}

async function addAcceptDecision(
  db: DomainDatabase,
  overrides: { id?: string; principal?: string; action?: string; scope?: string } = {},
): Promise<string> {
  const id = overrides.id ?? "accept-decision";
  await db.transaction(async (tx) => {
    await tx.execute({
      sql: "INSERT INTO authorization_decisions(id,principal_id,resource_id,action,scope_key,decision,reason,created_at) VALUES (?,?,?,?,?,'ALLOW','test',?)",
      args: [
        id,
        overrides.principal ?? "owner",
        "task-task-1",
        overrides.action ?? "task:accept",
        overrides.scope ?? "test",
        now,
      ],
    });
  });
  return id;
}

async function addStepDecision(
  db: DomainDatabase,
  action: "task:accept" | "task:rework",
  id: string,
  overrides: { principal?: string; resource?: string; scope?: string; revoked?: boolean } = {},
): Promise<void> {
  const grantId = `${id}-grant`;
  await db.transaction(async (tx) => {
    await tx.execute({
      sql: "INSERT OR IGNORE INTO principals(id,kind,created_at) VALUES (?,'owner',?)",
      args: [overrides.principal ?? "owner", now],
    });
    await tx.execute({
      sql: "INSERT OR IGNORE INTO resources(id,kind,visibility,owner_id) VALUES (?,'task','private','owner')",
      args: [overrides.resource ?? "task-task-1"],
    });
    await tx.execute({
      sql: "INSERT INTO grants(id,principal_id,resource_id,action,scope_key,effect,created_at,revoked_at) VALUES (?,?,?,?,?,'allow',?,?)",
      args: [
        grantId,
        overrides.principal ?? "owner",
        overrides.resource ?? "task-task-1",
        action,
        overrides.scope ?? "test",
        now,
        overrides.revoked ? now : null,
      ],
    });
    await tx.execute({
      sql: "INSERT INTO authorization_decisions(id,principal_id,resource_id,action,scope_key,decision,reason,grant_id,created_at) VALUES (?,?,?,?,?,'ALLOW','test',?,?)",
      args: [
        id,
        overrides.principal ?? "owner",
        overrides.resource ?? "task-task-1",
        action,
        overrides.scope ?? "test",
        grantId,
        now,
      ],
    });
  });
}

async function addCancelDecision(
  db: DomainDatabase,
  overrides: {
    id?: string;
    principal?: string;
    resource?: string;
    action?: string;
    scope?: string;
    grantId?: string;
  } = {},
): Promise<string> {
  const id = overrides.id ?? "cancel-decision";
  await db.transaction(async (tx) => {
    if (overrides.grantId) {
      await tx.execute({
        sql: "INSERT OR IGNORE INTO resources(id,kind,visibility,owner_id) VALUES (?,'task','private','owner')",
        args: [overrides.resource ?? "task-task-1"],
      });
      await tx.execute({
        sql: "INSERT INTO grants(id,principal_id,resource_id,action,scope_key,effect,created_at) VALUES (?,?,?,?,?,'allow',?)",
        args: [
          overrides.grantId,
          overrides.principal ?? "owner",
          overrides.resource ?? "task-task-1",
          overrides.action ?? "task:cancel",
          overrides.scope ?? "test",
          now,
        ],
      });
    }
    await tx.execute({
      sql: "INSERT INTO authorization_decisions(id,principal_id,resource_id,action,scope_key,decision,reason,grant_id,created_at) VALUES (?,?,?,?,?,'ALLOW','test',?,?)",
      args: [
        id,
        overrides.principal ?? "owner",
        overrides.resource ?? "task-task-1",
        overrides.action ?? "task:cancel",
        overrides.scope ?? "test",
        overrides.grantId ?? null,
        now,
      ],
    });
  });
  return id;
}

async function fixture(db: DomainDatabase): Promise<LongWorkStore> {
  await db.transaction(async (tx) => {
    await tx.execute({
      sql: "INSERT INTO principals(id,kind,created_at) VALUES (?,?,?)",
      args: ["owner", "owner", now],
    });
    await tx.execute({
      sql: "INSERT INTO tasks(id,title,status,priority,creator_principal_id,origin_scope_key,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)",
      args: ["task-1", "Old P3 task", "NEW", "normal", "owner", "test", now, now],
    });
    await tx.execute({
      sql: "INSERT INTO task_attempts(id,task_id,attempt_number,status,started_at) VALUES (?,?,?,?,?)",
      args: ["attempt-1", "task-1", 1, "running", now],
    });
    await tx.execute({
      sql: "INSERT INTO authorization_decisions(id,principal_id,resource_id,action,scope_key,decision,reason,created_at) VALUES (?,?,?,?,?,?,?,?)",
      args: ["decision-1", "owner", "task-task-1", "task:signal", "test", "ALLOW", "test", now],
    });
    await tx.execute({
      sql: "INSERT INTO resources(id,kind,visibility,owner_id) VALUES (?,'task','private','owner')",
      args: ["task-task-1"],
    });
    await tx.execute({
      sql: "INSERT INTO grants(id,principal_id,resource_id,action,scope_key,effect,created_at) VALUES (?,?,?,?,?,'allow',?)",
      args: ["continue-grant", "owner", "task-task-1", "task:continue", "test", now],
    });
    await tx.execute({
      sql: "INSERT INTO authorization_decisions(id,principal_id,resource_id,action,scope_key,decision,reason,grant_id,created_at) VALUES (?,?,?,?,?,'ALLOW','test',?,?)",
      args: [
        "continue-decision",
        "owner",
        "task-task-1",
        "task:continue",
        "test",
        "continue-grant",
        now,
      ],
    });
  });
  return new LongWorkStore(db);
}

async function insertLegacyTask(db: DomainDatabase, id: string): Promise<void> {
  await db.transaction((tx) =>
    tx.execute({
      sql: "INSERT INTO tasks(id,title,status,priority,creator_principal_id,origin_scope_key,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)",
      args: [id, id, "NEW", "normal", "owner", "test", now, now],
    }),
  );
}

async function addTaskContinueDecision(db: DomainDatabase, taskId: string): Promise<string> {
  const decisionId = `continue-decision-${taskId}`;
  const grantId = `continue-grant-${taskId}`;
  await db.transaction(async (tx) => {
    await tx.execute({
      sql: "INSERT INTO resources(id,kind,visibility,owner_id) VALUES (?, 'task','private','owner')",
      args: [`task-${taskId}`],
    });
    await tx.execute({
      sql: "INSERT INTO grants(id,principal_id,resource_id,action,scope_key,effect,created_at) VALUES (?,?,?,?,?,'allow',?)",
      args: [grantId, "owner", `task-${taskId}`, "task:continue", "test", now],
    });
    await tx.execute({
      sql: "INSERT INTO authorization_decisions(id,principal_id,resource_id,action,scope_key,decision,reason,grant_id,created_at) VALUES (?,?,?,?,?,'ALLOW','test',?,?)",
      args: [decisionId, "owner", `task-${taskId}`, "task:continue", "test", grantId, now],
    });
  });
  return decisionId;
}

const retryPolicy = {
  version: 1,
  maxAttempts: 2,
  initialDelayMs: 0,
  backoffMultiplier: 2,
  maxDelayMs: 10_000,
  retryableErrorClasses: ["transient"],
  nonRetryableErrorClasses: ["permanent"],
  timeoutOutcome: "retryable" as const,
};

async function claimRetryStep(
  store: LongWorkStore,
  db: DomainDatabase,
  options: { seedPriorReworkCycle?: boolean } = {},
) {
  await store.createGraph(
    "task-1",
    [{ ...step("retry"), maxAttempts: retryPolicy.maxAttempts, retryPolicy }],
    "retry",
    limits,
    system,
  );
  if (options.seedPriorReworkCycle) {
    await db.transaction(async (tx) => {
      for (const [number, id] of ["old-attempt-1", "old-attempt-2"].entries()) {
        await tx.execute({
          sql: "INSERT INTO task_attempts(id,task_id,step_id,attempt_number,status,started_at,completed_at) VALUES (?,?,?,?,'failed',?,?)",
          args: [id, "task-1", "retry", number + 2, now, now],
        });
      }
      await tx.execute({
        sql: "INSERT INTO task_events(id,task_id,step_id,attempt_id,type,metadata_json,created_at) VALUES (?,?,?,?,?,?,?)",
        args: ["rework-event", "task-1", "retry", "old-attempt-2", "TASK_REWORK", "{}", now],
      });
    });
  }
  await store.transitionStep({
    taskId: "task-1",
    stepId: "retry",
    expectedVersion: 1,
    from: "pending",
    to: "ready",
    origin: system,
  });
  return store.claimReadyStep({
    taskId: "task-1",
    stepId: "retry",
    expectedStepVersion: 2,
    attemptId: "retry-attempt",
    leaseId: "retry-lease",
    ownerInstanceId: "executor-1",
    leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    origin: claimOrigin,
  });
}

it("bounds active durable Tasks per Principal when adopting a graph", async () => {
  const db = await DomainDatabase.open(":memory:");
  try {
    const store = await fixture(db);
    await db.transaction((tx) =>
      tx.execute({
        sql: "INSERT INTO tasks(id,title,status,priority,creator_principal_id,origin_scope_key,created_at,updated_at) VALUES ('task-2','Second Task','NEW','normal','owner','test',?,?)",
        args: [now, now],
      }),
    );
    const constrained = { ...limits, maxActiveTasksPerPrincipal: 1 };
    await store.createGraph("task-1", [step("a")], "a", constrained, system);
    const second = { ...step("b"), taskId: "task-2" };
    await expect(
      store.createGraph("task-2", [second], "b", constrained, system),
    ).rejects.toMatchObject({ code: "ACTIVE_TASK_LIMIT" });
    expect(await store.listSteps("task-2")).toEqual([]);
    await db.transaction((tx) =>
      tx.execute("UPDATE tasks SET status = 'DONE' WHERE id = 'task-1'"),
    );
    await store.createGraph("task-2", [second], "b", constrained, system);
    expect(await store.listSteps("task-2")).toHaveLength(1);
  } finally {
    await db.close();
  }
});

it("does not let legacy whole-Task operations bypass a durable graph", async () => {
  const db = await DomainDatabase.open(":memory:");
  try {
    const longWork = await fixture(db);
    await longWork.createGraph("task-1", [step("a")], "a", limits, system);
    const legacy = new TaskStore(db);
    await expect(legacy.createAttempt({ taskId: "task-1" })).rejects.toThrow();
    await expect(legacy.updateTaskStatus("task-1", "DONE")).rejects.toThrow(
      "step-aware status transitions",
    );
    await expect(legacy.cancelTask("task-1")).rejects.toThrow("step-aware cancellation");
    await db.transaction(async (tx) => {
      await tx.execute("UPDATE tasks SET status = 'REVIEW' WHERE id = 'task-1'");
    });
    await expect(legacy.acceptTask("task-1", "owner")).rejects.toThrow("step-aware acceptance");
    await expect(legacy.reworkTask("task-1", "retry", "owner")).rejects.toThrow(
      "step-aware rework",
    );
    expect((await legacy.getTask("task-1"))?.status).toBe("REVIEW");
    expect((await longWork.listSteps("task-1"))[0]?.status).toBe("pending");
    await db.transaction(async (tx) => {
      await tx.execute(
        "UPDATE tasks SET status = 'RUNNING', active_attempt_id = 'attempt-1' WHERE id = 'task-1'",
      );
    });
    await legacy.bindWorker({
      taskAttemptId: "attempt-1",
      herdrSession: "session-1",
      workspaceId: "workspace-1",
      paneId: "pane-1",
      agentName: "worker-1",
      agentKind: "pi",
    });
    await legacy.observeWorker(
      { herdrSession: "session-1", workspaceId: "workspace-1", paneId: "pane-1" },
      "done",
    );
    expect((await legacy.getTask("task-1"))?.status).toBe("RUNNING");
  } finally {
    await db.close();
  }
});

it("does not adopt a graph with a decision for a different Task action", async () => {
  const db = await DomainDatabase.open(":memory:");
  try {
    const store = await fixture(db);
    await expect(
      store.createGraph("task-1", [step("a")], "a", limits, claimOrigin),
    ).rejects.toThrow("Current Task planning grant is required");
    expect((await new TaskStore(db).getTask("task-1"))?.orchestrationMode).toBeUndefined();
  } finally {
    await db.close();
  }
});

it("rejects a wait beyond the configured one-year horizon", async () => {
  const db = await DomainDatabase.open(":memory:");
  try {
    const store = await fixture(db);
    await expect(
      store.createGraph(
        "task-1",
        [
          {
            ...step("too-long", [], "timer_wait"),
            waitPolicy: {
              version: 1,
              kind: "duration",
              durationMs: 366 * 24 * 60 * 60 * 1_000,
              overdue: "resume",
            },
          },
        ],
        "too-long",
        limits,
        system,
      ),
    ).rejects.toThrow("Invalid wait policy");
  } finally {
    await db.close();
  }
});

it("requires wait policies to match wait Step kinds", async () => {
  const db = await DomainDatabase.open(":memory:");
  try {
    const store = await fixture(db);
    for (const waitStep of [
      { ...step("timer-without-policy", [], "timer_wait"), waitPolicy: undefined },
      {
        ...step("signal-with-timer-policy", [], "signal_wait"),
        waitPolicy: {
          version: 1,
          kind: "duration" as const,
          durationMs: 1_000,
          overdue: "resume" as const,
        },
      },
      {
        ...step("approval-with-signal-policy", [], "approval_wait"),
        waitPolicy: {
          version: 1,
          kind: "signal" as const,
          signalKey: "ok",
          overdue: "resume" as const,
        },
      },
      {
        ...step("join-with-wait-policy"),
        waitPolicy: {
          version: 1,
          kind: "duration" as const,
          durationMs: 1_000,
          overdue: "resume" as const,
        },
      },
    ]) {
      await expect(
        store.createGraph("task-1", [waitStep], waitStep.id, limits, system),
      ).rejects.toThrow("Wait policy does not match Step kind");
    }
  } finally {
    await db.close();
  }
});

it("accepts only exact task_get Tool Step references", async () => {
  expect(parseTaskGetSpec("tool:task_get:A_2-z")).toEqual({ targetTaskId: "A_2-z" });
  expect(parseTaskGetSpec(`tool:task_get:${"a".repeat(128)}`)).toEqual({
    targetTaskId: "a".repeat(128),
  });
  for (const ref of [
    "tool:task_get:",
    "tool:task_get:-first",
    "tool:task_get:a/b",
    "tool:task_get:a:extra",
    "tool:task_get:a\n",
    `tool:task_get:${"a".repeat(129)}`,
    "tool:task_cancel:a",
  ])
    expect(parseTaskGetSpec(ref)).toBeNull();

  const db = await DomainDatabase.open(":memory:");
  try {
    const store = await fixture(db);
    for (const invalid of [
      { specRef: undefined },
      { specRef: "tool:task_get:a:extra" },
      { specRef: "tool:task_cancel:a" },
      { specRef: "tool:task_get:a", instructions: "ignore the Task scope" },
      {
        specRef: "tool:task_get:a",
        waitPolicy: {
          version: 1 as const,
          kind: "signal" as const,
          signalKey: "go",
          overdue: "resume" as const,
        },
      },
    ]) {
      await expect(
        store.createGraph(
          "task-1",
          [{ ...step("tool", [], "tool"), ...invalid }],
          "tool",
          limits,
          system,
        ),
      ).rejects.toThrow("Invalid Tool Step specification");
      expect(await store.listSteps("task-1")).toEqual([]);
    }
    await store.createGraph(
      "task-1",
      [{ ...step("tool", [], "tool"), specRef: "tool:task_get:A_2-z" }],
      "tool",
      limits,
      system,
    );
    expect((await store.listSteps("task-1"))[0]?.specRef).toBe("tool:task_get:A_2-z");
  } finally {
    await db.close();
  }
});

it("requires a current planning grant before a principal may declare Step permissions", async () => {
  const db = await DomainDatabase.open(":memory:");
  try {
    const store = await fixture(db);
    await expect(
      store.createGraph(
        "task-1",
        [{ ...step("a"), delegatedPermissionSet: [{ resourceId: "task-1", action: "task:read" }] }],
        "a",
        limits,
        claimOrigin,
      ),
    ).rejects.toThrow("Current Task planning grant is required");
  } finally {
    await db.close();
  }
});

it("stores exact delegated resource and action pairs on system-origin graphs", async () => {
  const db = await DomainDatabase.open(":memory:");
  try {
    const store = await fixture(db);
    const delegatedPermissionSet = [
      { resourceId: "task-1", action: "task:read" },
      { resourceId: "task-2", action: "task:read" },
      { resourceId: "task-1", action: "task:continue" },
    ];
    await store.createGraph(
      "task-1",
      [{ ...step("a"), delegatedPermissionSet }],
      "a",
      limits,
      system,
    );
    expect((await store.listSteps("task-1"))[0]?.delegatedPermissionSet).toEqual(
      delegatedPermissionSet,
    );
  } finally {
    await db.close();
  }
});

it("rejects malformed, wildcard, and duplicate delegated permission entries", async () => {
  const db = await DomainDatabase.open(":memory:");
  try {
    const store = await fixture(db);
    const invalidSets = [
      ["task:read"],
      [{ resourceId: "task-1" }],
      [{ resourceId: "task-1", action: "task:read", scope: "all" }],
      [{ resourceId: "", action: "task:read" }],
      [{ resourceId: "task-1", action: "" }],
      [{ resourceId: "*", action: "task:read" }],
      [{ resourceId: "task-1", action: "*" }],
      [{ resourceId: "task-1", action: "task:\nread" }],
      [
        { resourceId: "task-1", action: "task:read" },
        { resourceId: "task-1", action: "task:read" },
      ],
    ];
    for (const delegatedPermissionSet of invalidSets) {
      await expect(
        store.createGraph(
          "task-1",
          [{ ...step("a"), delegatedPermissionSet } as TaskStep],
          "a",
          limits,
          system,
        ),
      ).rejects.toThrow("Invalid delegated permissions");
    }
  } finally {
    await db.close();
  }
});

it("links a pristine same-scope child Task with no delegated permissions", async () => {
  const db = await DomainDatabase.open(":memory:");
  try {
    const store = await fixture(db);
    const parentStep = {
      ...step("child-step", [], "child_task"),
      delegatedPermissionSet: [],
    };
    await store.createGraph("task-1", [parentStep], "child-step", limits, system);
    await store.transitionStep({
      taskId: "task-1",
      stepId: "child-step",
      expectedVersion: 1,
      from: "pending",
      to: "ready",
      origin: system,
    });
    await db.transaction(async (tx) => {
      await tx.execute({
        sql: "INSERT INTO tasks(id,title,status,priority,creator_principal_id,origin_scope_key,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)",
        args: ["child-1", "Child work", "NEW", "normal", "owner", "test", now, now],
      });
    });

    const link = await store.createChildTaskLink({
      parentTaskId: "task-1",
      parentStepId: "child-step",
      expectedStepVersion: 2,
      childTaskId: "child-1",
      delegatedPermissionSet: [],
      acceptanceCriteria: ["Return a verified result"],
      cancellationPolicy: "cancel_child",
      failurePolicy: "review_parent",
      origin: claimOrigin,
    });
    expect(link).toMatchObject({
      parentTaskId: "task-1",
      parentStepId: "child-step",
      childTaskId: "child-1",
      delegatedPermissionSet: [],
      acceptanceCriteria: ["Return a verified result"],
      cancellationPolicy: "cancel_child",
      failurePolicy: "review_parent",
    });
    expect((await store.listSteps("task-1"))[0]).toMatchObject({ status: "running", version: 3 });
    const childCriteria = await db.transaction((tx) =>
      tx.execute("SELECT acceptance_criteria_json FROM tasks WHERE id = 'child-1'"),
    );
    expect(childCriteria.rows[0]?.acceptance_criteria_json).toBe(
      JSON.stringify(["Return a verified result"]),
    );
    expect(await store.getChildTaskLink("child-1")).toEqual(link);
    expect(await store.listChildTaskLinks("task-1", "child-step")).toEqual([link]);
    expect((await store.listEvents("task-1")).at(-1)).toMatchObject({
      type: "CHILD_TASK_CREATED",
      stepId: "child-step",
      metadata: { childTaskId: "child-1" },
    });
    await store.transitionStep({
      taskId: "task-1",
      stepId: "child-step",
      expectedVersion: 3,
      from: "running",
      to: "blocked",
      origin: system,
    });
    await addStepDecision(db, "task:rework", "child-active-rework");
    await expect(
      store.reworkDurableStep({
        taskId: "task-1",
        stepId: "child-step",
        expectedStepVersion: 4,
        reason: "Replace the child",
        origin: {
          kind: "decision",
          decisionId: "child-active-rework",
          actorPrincipalId: "owner",
        },
      }),
    ).rejects.toThrow("Linked child must stop before blocked Step rework");
  } finally {
    await db.close();
  }
});

it("rejects child Task links with stale Step state, delegated permissions, or mismatched scope", async () => {
  const db = await DomainDatabase.open(":memory:");
  try {
    const store = await fixture(db);
    const parentStep = {
      ...step("child-step", [], "child_task"),
      delegatedPermissionSet: [],
    };
    await store.createGraph("task-1", [parentStep], "child-step", limits, system);
    await store.transitionStep({
      taskId: "task-1",
      stepId: "child-step",
      expectedVersion: 1,
      from: "pending",
      to: "ready",
      origin: system,
    });
    await db.transaction(async (tx) => {
      for (const [id, owner, scope] of [
        ["child-excess", "owner", "test"],
        ["child-scope", "owner", "other"],
        ["child-mismatch", "owner", "test"],
      ]) {
        await tx.execute({
          sql: "INSERT INTO tasks(id,title,status,priority,creator_principal_id,origin_scope_key,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)",
          args: [id, id, "NEW", "normal", owner, scope, now, now],
        });
      }
      await tx.execute(
        "UPDATE tasks SET acceptance_criteria_json = '[\"Different criterion\"]' WHERE id = 'child-mismatch'",
      );
    });
    const common = {
      parentTaskId: "task-1",
      parentStepId: "child-step",
      childTaskId: "child-excess",
      delegatedPermissionSet: [],
      acceptanceCriteria: ["Return a verified result"],
      cancellationPolicy: "cancel_child" as const,
      failurePolicy: "review_parent" as const,
      origin: claimOrigin,
    };
    await expect(store.createChildTaskLink({ ...common, expectedStepVersion: 1 })).rejects.toThrow(
      "Child Task Step version or state conflict",
    );
    await expect(
      store.createChildTaskLink({
        ...common,
        expectedStepVersion: 2,
        delegatedPermissionSet: [{ resourceId: "task-1", action: "task:read" }],
      }),
    ).rejects.toThrow("Child permissions exceed the parent Step delegation");
    await expect(
      store.createChildTaskLink({
        ...common,
        childTaskId: "child-scope",
        expectedStepVersion: 2,
      }),
    ).rejects.toThrow("Child Task must be a new Task in the same principal and scope");
    await expect(
      store.createChildTaskLink({
        ...common,
        childTaskId: "child-mismatch",
        expectedStepVersion: 2,
      }),
    ).rejects.toThrow("Child Task acceptance criteria differ from the link");
    expect((await store.listSteps("task-1"))[0]).toMatchObject({ status: "ready", version: 2 });
  } finally {
    await db.close();
  }
});

it("rejects duplicate child links and bounds child acceptance criteria", async () => {
  const db = await DomainDatabase.open(":memory:");
  try {
    const store = await fixture(db);
    const parentStep = {
      ...step("child-step", [], "child_task"),
      delegatedPermissionSet: [],
    };
    await store.createGraph("task-1", [parentStep], "child-step", limits, system);
    await store.transitionStep({
      taskId: "task-1",
      stepId: "child-step",
      expectedVersion: 1,
      from: "pending",
      to: "ready",
      origin: system,
    });
    await db.transaction(async (tx) => {
      await tx.execute({
        sql: "INSERT INTO tasks(id,title,status,priority,creator_principal_id,origin_scope_key,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)",
        args: ["child-1", "Child work", "NEW", "normal", "owner", "test", now, now],
      });
    });
    const request = {
      parentTaskId: "task-1",
      parentStepId: "child-step",
      expectedStepVersion: 2,
      childTaskId: "child-1",
      delegatedPermissionSet: [],
      acceptanceCriteria: ["Return a verified result"],
      cancellationPolicy: "cancel_child" as const,
      failurePolicy: "review_parent" as const,
      origin: claimOrigin,
    };
    await store.createChildTaskLink(request);
    await expect(store.createChildTaskLink(request)).rejects.toThrow();
    await expect(
      store.createChildTaskLink({
        ...request,
        expectedStepVersion: 3,
        acceptanceCriteria: Array.from({ length: 21 }, (_, index) => `criterion ${index}`),
      }),
    ).rejects.toThrow("Invalid child Task acceptance criteria");
  } finally {
    await db.close();
  }
});

it("enforces the per-parent child Task limit without partially linking the next child", async () => {
  const db = await DomainDatabase.open(":memory:");
  try {
    const store = await fixture(db);
    const childSteps = Array.from({ length: MAX_CHILD_TASKS_PER_PARENT + 1 }, (_, index) => ({
      ...step(`child-step-${index + 1}`, [], "child_task"),
      delegatedPermissionSet: [],
    }));
    await store.createGraph(
      "task-1",
      childSteps,
      childSteps[0]!.id,
      {
        ...limits,
        maxSteps: childSteps.length,
        maxReadySteps: childSteps.length,
        maxParallelSteps: childSteps.length,
      },
      system,
    );
    for (const childStep of childSteps)
      await store.transitionStep({
        taskId: "task-1",
        stepId: childStep.id,
        expectedVersion: 1,
        from: "pending",
        to: "ready",
        origin: system,
      });
    for (let index = 1; index <= childSteps.length; index++)
      await insertLegacyTask(db, `count-child-${index}`);

    const linkInput = (index: number) => ({
      parentTaskId: "task-1",
      parentStepId: `child-step-${index}`,
      expectedStepVersion: 2,
      childTaskId: `count-child-${index}`,
      delegatedPermissionSet: [],
      acceptanceCriteria: ["Return a result"],
      cancellationPolicy: "cancel_child" as const,
      failurePolicy: "review_parent" as const,
      origin: claimOrigin,
    });
    for (let index = 1; index <= MAX_CHILD_TASKS_PER_PARENT; index++)
      await store.createChildTaskLink(linkInput(index));

    await expect(
      store.createChildTaskLink(linkInput(MAX_CHILD_TASKS_PER_PARENT + 1)),
    ).rejects.toMatchObject({
      name: "ChildTaskLinkError",
      code: "CHILD_COUNT_LIMIT",
      limit: MAX_CHILD_TASKS_PER_PARENT,
      attempted: MAX_CHILD_TASKS_PER_PARENT + 1,
    });
    expect(await store.listChildTaskLinks("task-1")).toHaveLength(MAX_CHILD_TASKS_PER_PARENT);
    expect(
      await store.getChildTaskLink(`count-child-${MAX_CHILD_TASKS_PER_PARENT + 1}`),
    ).toBeNull();
    expect(await store.listSteps("task-1")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: `child-step-${MAX_CHILD_TASKS_PER_PARENT + 1}`,
          status: "ready",
          version: 2,
        }),
      ]),
    );
    expect(
      (await store.listEvents("task-1")).filter((event) => event.type === "CHILD_TASK_CREATED"),
    ).toHaveLength(MAX_CHILD_TASKS_PER_PARENT);
  } finally {
    await db.close();
  }
});

it("allows the maximum child ancestor depth and rejects the next level atomically", async () => {
  const db = await DomainDatabase.open(":memory:");
  try {
    const store = await fixture(db);
    let parentTaskId = "task-1";
    let parentDecisionId = "continue-decision";

    for (let depth = 1; depth <= MAX_CHILD_TASK_ANCESTOR_DEPTH; depth++) {
      if (parentTaskId !== "task-1") {
        const parentStep = {
          ...step(`depth-step-${depth}`, [], "child_task"),
          taskId: parentTaskId,
        };
        await store.createGraph(parentTaskId, [parentStep], parentStep.id, limits, system);
        await store.transitionStep({
          taskId: parentTaskId,
          stepId: parentStep.id,
          expectedVersion: 1,
          from: "pending",
          to: "ready",
          origin: system,
        });
        parentDecisionId = await addTaskContinueDecision(db, parentTaskId);
      } else {
        const parentStep = {
          ...step(`depth-step-${depth}`, [], "child_task"),
          taskId: parentTaskId,
        };
        await store.createGraph(parentTaskId, [parentStep], parentStep.id, limits, system);
        await store.transitionStep({
          taskId: parentTaskId,
          stepId: parentStep.id,
          expectedVersion: 1,
          from: "pending",
          to: "ready",
          origin: system,
        });
      }
      const childTaskId = `depth-child-${depth}`;
      await insertLegacyTask(db, childTaskId);
      await store.createChildTaskLink({
        parentTaskId,
        parentStepId: `depth-step-${depth}`,
        expectedStepVersion: 2,
        childTaskId,
        delegatedPermissionSet: [],
        acceptanceCriteria: ["Return a result"],
        cancellationPolicy: "cancel_child",
        failurePolicy: "review_parent",
        origin: {
          kind: "decision",
          decisionId: parentDecisionId,
          actorPrincipalId: "owner",
        },
      });
      parentTaskId = childTaskId;
    }

    const parentStep = {
      ...step("depth-step-over-limit", [], "child_task"),
      taskId: parentTaskId,
    };
    await store.createGraph(parentTaskId, [parentStep], parentStep.id, limits, system);
    await store.transitionStep({
      taskId: parentTaskId,
      stepId: parentStep.id,
      expectedVersion: 1,
      from: "pending",
      to: "ready",
      origin: system,
    });
    const parentDecision = await addTaskContinueDecision(db, parentTaskId);
    await insertLegacyTask(db, "depth-child-over-limit");

    await expect(
      store.createChildTaskLink({
        parentTaskId,
        parentStepId: parentStep.id,
        expectedStepVersion: 2,
        childTaskId: "depth-child-over-limit",
        delegatedPermissionSet: [],
        acceptanceCriteria: ["Return a result"],
        cancellationPolicy: "cancel_child",
        failurePolicy: "review_parent",
        origin: { kind: "decision", decisionId: parentDecision, actorPrincipalId: "owner" },
      }),
    ).rejects.toMatchObject({
      name: "ChildTaskLinkError",
      code: "CHILD_DEPTH_LIMIT",
      limit: MAX_CHILD_TASK_ANCESTOR_DEPTH,
      attempted: MAX_CHILD_TASK_ANCESTOR_DEPTH + 1,
    });
    expect(await store.getChildTaskLink("depth-child-over-limit")).toBeNull();
    expect(await store.listSteps(parentTaskId)).toMatchObject([
      expect.objectContaining({ id: parentStep.id, status: "ready", version: 2 }),
    ]);
    expect(
      (await store.listEvents(parentTaskId)).some(
        (event) =>
          event.type === "CHILD_TASK_CREATED" &&
          event.metadata?.childTaskId === "depth-child-over-limit",
      ),
    ).toBe(false);
  } finally {
    await db.close();
  }
});

it("preserves an old Task, atomically creates a DAG, and reopens its events and dependencies", async () => {
  const directory = await mkdtemp(join(tmpdir(), "glassbox-long-work-store-"));
  const path = join(directory, "data.db");
  try {
    const db = await DomainDatabase.open(path);
    const store = await fixture(db);
    try {
      expect(await store.listSteps("task-1")).toEqual([]);
      await expect(
        store.createGraph("task-1", [step("a", ["missing"])], "a", limits, system),
      ).rejects.toThrow();
      await store.createGraph("task-1", [step("a"), step("b", ["a"])], "a", limits, system);
      await expect(store.createGraph("task-1", [step("c")], "c", limits, system)).rejects.toThrow();
      await store.transitionStep({
        taskId: "task-1",
        stepId: "a",
        expectedVersion: 1,
        from: "pending",
        to: "ready",
        origin: system,
      });
      await store.createWait({
        id: "timer-1",
        taskId: "task-1",
        stepId: "a",
        expectedStepVersion: 2,
        policy: { version: 1, kind: "duration", durationMs: 60_000, overdue: "resume" },
        origin: system,
      });
    } finally {
      await db.close();
    }
    const reopened = await DomainDatabase.open(path);
    try {
      const read = new LongWorkStore(reopened);
      expect((await read.listSteps("task-1")).map((item) => [item.id, item.dependencyIds])).toEqual(
        [
          ["a", []],
          ["b", ["a"]],
        ],
      );
      expect((await read.listEvents("task-1")).map((item) => item.type)).toEqual([
        "STEP_ADDED",
        "STEP_ADDED",
        "STEP_READY",
        "STEP_WAITING",
      ]);
      const timer = (await read.listWaiting("task-1"))[0];
      expect(timer?.policy.dueAt).toBeDefined();
      expect(Date.parse(timer!.policy.dueAt!)).toBeGreaterThan(Date.parse(timer!.startedAt));
      await reopened.transaction(async (tx) => {
        const task = (
          await tx.execute(
            "SELECT status,orchestration_mode,root_step_id FROM tasks WHERE id = 'task-1'",
          )
        ).rows[0];
        expect(task).toMatchObject({
          status: "NEW",
          orchestration_mode: "durable",
          root_step_id: "a",
        });
        expect(
          (await tx.execute("SELECT id,step_id FROM task_attempts WHERE id = 'attempt-1'")).rows[0],
        ).toMatchObject({ id: "attempt-1", step_id: null });
        expect(
          (await tx.execute("SELECT due_at FROM task_waits WHERE id = 'timer-1'")).rows[0]?.due_at,
        ).toBe(timer?.policy.dueAt);
      });
    } finally {
      await reopened.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }).catch(
      (error: NodeJS.ErrnoException) => {
        if (process.platform !== "win32" || error.code !== "EBUSY") throw error;
      },
    );
  }
});

it("checks Step versions and records every state transition in append-only history", async () => {
  const db = await DomainDatabase.open(":memory:");
  try {
    const store = await fixture(db);
    await store.createGraph("task-1", [step("a")], "a", limits, system);
    const ready = await store.transitionStep({
      taskId: "task-1",
      stepId: "a",
      expectedVersion: 1,
      from: "pending",
      to: "ready",
      origin: system,
    });
    expect(ready.version).toBe(2);
    await expect(
      store.transitionStep({
        taskId: "task-1",
        stepId: "a",
        expectedVersion: 1,
        from: "pending",
        to: "ready",
        origin: system,
      }),
    ).rejects.toThrow("version conflict");
    await expect(
      store.transitionStep({
        taskId: "task-1",
        stepId: "a",
        expectedVersion: 2,
        from: "ready",
        to: "succeeded",
        origin: system,
      }),
    ).rejects.toThrow("Invalid step transition");
    await store.transitionStep({
      taskId: "task-1",
      stepId: "a",
      expectedVersion: 2,
      from: "ready",
      to: "running",
      origin: system,
    });
    await store.transitionStep({
      taskId: "task-1",
      stepId: "a",
      expectedVersion: 3,
      from: "running",
      to: "review",
      origin: system,
    });
    expect((await store.listEvents("task-1")).map((event) => event.type)).toEqual([
      "STEP_ADDED",
      "STEP_READY",
      "STEP_STARTED",
      "STEP_REVIEW",
    ]);
    await db.transaction(async (tx) => {
      await expect(tx.execute("UPDATE task_events SET type = 'STEP_FAILED'")).rejects.toThrow();
      await expect(tx.execute("DELETE FROM task_events")).rejects.toThrow();
    });
  } finally {
    await db.close();
  }
});

it("claims a ready Step with its running attempt and initial lease in one transaction", async () => {
  const db = await DomainDatabase.open(":memory:");
  try {
    const store = await fixture(db);
    await store.createGraph("task-1", [step("claim")], "claim", limits, system);
    await store.transitionStep({
      taskId: "task-1",
      stepId: "claim",
      expectedVersion: 1,
      from: "pending",
      to: "ready",
      origin: system,
    });

    const claimed = await store.claimReadyStep({
      taskId: "task-1",
      stepId: "claim",
      expectedStepVersion: 2,
      attemptId: "claim-attempt",
      leaseId: "claim-lease",
      ownerInstanceId: "scheduler-1",
      leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      origin: claimOrigin,
    });

    expect(claimed.step).toMatchObject({ id: "claim", status: "running", version: 3 });
    expect(claimed.attempt).toMatchObject({
      id: "claim-attempt",
      taskId: "task-1",
      stepId: "claim",
      attemptNumber: 2,
      status: "running",
    });
    expect(claimed.lease).toMatchObject({
      id: "claim-lease",
      attemptId: "claim-attempt",
      state: "active",
      version: 1,
    });
    expect((await store.listEvents("task-1")).at(-1)).toMatchObject({
      type: "STEP_STARTED",
      stepId: "claim",
      attemptId: "claim-attempt",
    });
  } finally {
    await db.close();
  }
});

it("allows only one concurrent claim and rolls back losing claim records", async () => {
  const db = await DomainDatabase.open(":memory:");
  try {
    const store = await fixture(db);
    await store.createGraph("task-1", [step("claim")], "claim", limits, system);
    await store.transitionStep({
      taskId: "task-1",
      stepId: "claim",
      expectedVersion: 1,
      from: "pending",
      to: "ready",
      origin: system,
    });
    const claim = (attemptId: string, leaseId: string) =>
      store.claimReadyStep({
        taskId: "task-1",
        stepId: "claim",
        expectedStepVersion: 2,
        attemptId,
        leaseId,
        ownerInstanceId: "scheduler-1",
        leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
        origin: claimOrigin,
      });

    const results = await Promise.allSettled([
      claim("claim-attempt-a", "claim-lease-a"),
      claim("claim-attempt-b", "claim-lease-b"),
    ]);
    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(results.filter(({ status }) => status === "rejected")).toHaveLength(1);
    await db.transaction(async (tx) => {
      expect(
        (await tx.execute("SELECT id,step_id FROM task_attempts WHERE step_id = 'claim'")).rows,
      ).toHaveLength(1);
      expect(
        (
          await tx.execute(
            "SELECT id FROM task_step_leases WHERE step_id = 'claim' AND state = 'active'",
          )
        ).rows,
      ).toHaveLength(1);
    });
  } finally {
    await db.close();
  }
});

it("bounds unresolved Herdr Worker attempts before creating another lease", async () => {
  const db = await DomainDatabase.open(":memory:");
  try {
    const store = await fixture(db);
    await store.createGraph(
      "task-1",
      [
        step("worker-a", [], "herdr_worker"),
        step("worker-b", [], "herdr_worker"),
        step("join", ["worker-a", "worker-b"]),
      ],
      "join",
      limits,
      system,
    );
    for (const stepId of ["worker-a", "worker-b"])
      await store.transitionStep({
        taskId: "task-1",
        stepId,
        expectedVersion: 1,
        from: "pending",
        to: "ready",
        origin: system,
      });
    const claim = (stepId: string) =>
      store.claimReadyStep({
        taskId: "task-1",
        stepId,
        expectedStepVersion: 2,
        attemptId: `${stepId}-attempt`,
        leaseId: `${stepId}-lease`,
        ownerInstanceId: "scheduler-1",
        leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
        maxActiveWorkerAttemptsPerPrincipal: 1,
        origin: claimOrigin,
      });
    await claim("worker-a");
    await expect(claim("worker-b")).rejects.toMatchObject({
      code: "ACTIVE_WORKER_LIMIT",
    });
    expect((await store.listSteps("task-1")).find((item) => item.id === "worker-b")).toMatchObject({
      status: "ready",
      version: 2,
    });
    await db.transaction(async (tx) => {
      expect(
        (await tx.execute("SELECT id FROM task_attempts WHERE step_id = 'worker-b'")).rows,
      ).toHaveLength(0);
      expect(
        (await tx.execute("SELECT id FROM task_step_leases WHERE step_id = 'worker-b'")).rows,
      ).toHaveLength(0);
    });
  } finally {
    await db.close();
  }
});

it("attaches a same-Attempt WorkerBinding to the exact active lease once", async () => {
  const db = await DomainDatabase.open(":memory:");
  try {
    const store = await fixture(db);
    await store.createGraph(
      "task-1",
      [step("worker-binding", [], "herdr_worker")],
      "worker-binding",
      limits,
      system,
    );
    await store.transitionStep({
      taskId: "task-1",
      stepId: "worker-binding",
      expectedVersion: 1,
      from: "pending",
      to: "ready",
      origin: system,
    });
    await store.claimReadyStep({
      taskId: "task-1",
      stepId: "worker-binding",
      expectedStepVersion: 2,
      attemptId: "worker-binding-attempt",
      leaseId: "worker-binding-lease",
      ownerInstanceId: "executor-1",
      leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      origin: claimOrigin,
    });
    await db.transaction((tx) =>
      tx.execute({
        sql: "INSERT INTO worker_bindings(id,task_attempt_id,herdr_session,workspace_id,pane_id,agent_kind,last_observed_agent_state,updated_at) VALUES (?,?,?,?,?,?,'starting',?)",
        args: [
          "worker-binding-id",
          "worker-binding-attempt",
          "herdr-session",
          "workspace-1",
          "pane-1",
          "pi",
          now,
        ],
      }),
    );

    const attached = await store.attachClaimedWorkerBinding({
      taskId: "task-1",
      stepId: "worker-binding",
      attemptId: "worker-binding-attempt",
      leaseId: "worker-binding-lease",
      workerBindingId: "worker-binding-id",
      ownerInstanceId: "executor-1",
      expectedStepVersion: 3,
      expectedLeaseVersion: 1,
      origin: claimOrigin,
    });
    expect(attached).toMatchObject({
      id: "worker-binding-lease",
      taskId: "task-1",
      stepId: "worker-binding",
      attemptId: "worker-binding-attempt",
      workerBindingId: "worker-binding-id",
      ownerInstanceId: "executor-1",
      state: "active",
      version: 2,
    });
    expect(
      (await store.listEvents("task-1")).filter((event) => event.type === "WORKER_BOUND"),
    ).toEqual([
      expect.objectContaining({
        stepId: "worker-binding",
        attemptId: "worker-binding-attempt",
        metadata: { workerBindingId: "worker-binding-id" },
      }),
    ]);
    await expect(
      store.attachClaimedWorkerBinding({
        taskId: "task-1",
        stepId: "worker-binding",
        attemptId: "worker-binding-attempt",
        leaseId: "worker-binding-lease",
        workerBindingId: "worker-binding-id",
        ownerInstanceId: "executor-1",
        expectedStepVersion: 3,
        expectedLeaseVersion: 1,
        origin: claimOrigin,
      }),
    ).rejects.toThrow("Step lease ownership conflict");
  } finally {
    await db.close();
  }
});

it("rejects binding an unrelated Attempt or a non-Worker Step", async () => {
  const db = await DomainDatabase.open(":memory:");
  try {
    const store = await fixture(db);
    await store.createGraph(
      "task-1",
      [step("worker-binding", [], "herdr_worker"), step("join-binding")],
      "worker-binding",
      limits,
      system,
    );
    await store.transitionStep({
      taskId: "task-1",
      stepId: "worker-binding",
      expectedVersion: 1,
      from: "pending",
      to: "ready",
      origin: system,
    });
    await store.claimReadyStep({
      taskId: "task-1",
      stepId: "worker-binding",
      expectedStepVersion: 2,
      attemptId: "worker-binding-attempt",
      leaseId: "worker-binding-lease",
      ownerInstanceId: "executor-1",
      leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      origin: claimOrigin,
    });
    await db.transaction(async (tx) => {
      await tx.execute({
        sql: "INSERT INTO worker_bindings(id,task_attempt_id,herdr_session,workspace_id,pane_id,agent_kind,last_observed_agent_state,updated_at) VALUES (?,?,?,?,?,?,'starting',?)",
        args: ["foreign-binding", "attempt-1", "session", "workspace", "pane", "pi", now],
      });
      await tx.execute({
        sql: "INSERT INTO task_attempts(id,task_id,step_id,attempt_number,status,started_at) VALUES (?,?,?,?,'running',?)",
        args: ["other-attempt", "task-1", "worker-binding", 99, now],
      });
    });

    await expect(
      store.attachClaimedWorkerBinding({
        taskId: "task-1",
        stepId: "worker-binding",
        attemptId: "worker-binding-attempt",
        leaseId: "worker-binding-lease",
        workerBindingId: "foreign-binding",
        ownerInstanceId: "executor-1",
        expectedStepVersion: 3,
        expectedLeaseVersion: 1,
        origin: claimOrigin,
      }),
    ).rejects.toThrow("WorkerBinding does not belong to the claimed Attempt");
    await expect(
      store.attachClaimedWorkerBinding({
        taskId: "task-1",
        stepId: "worker-binding",
        attemptId: "other-attempt",
        leaseId: "worker-binding-lease",
        workerBindingId: "foreign-binding",
        ownerInstanceId: "executor-1",
        expectedStepVersion: 3,
        expectedLeaseVersion: 1,
        origin: claimOrigin,
      }),
    ).rejects.toThrow("Step lease ownership conflict");

    await store.transitionStep({
      taskId: "task-1",
      stepId: "join-binding",
      expectedVersion: 1,
      from: "pending",
      to: "ready",
      origin: system,
    });
    await store.claimReadyStep({
      taskId: "task-1",
      stepId: "join-binding",
      expectedStepVersion: 2,
      attemptId: "join-binding-attempt",
      leaseId: "join-binding-lease",
      ownerInstanceId: "executor-1",
      leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      origin: claimOrigin,
    });
    await db.transaction((tx) =>
      tx.execute({
        sql: "INSERT INTO worker_bindings(id,task_attempt_id,herdr_session,workspace_id,pane_id,agent_kind,last_observed_agent_state,updated_at) VALUES (?,?,?,?,?,?,'starting',?)",
        args: [
          "join-binding-id",
          "join-binding-attempt",
          "session",
          "workspace",
          "pane",
          "pi",
          now,
        ],
      }),
    );
    await expect(
      store.attachClaimedWorkerBinding({
        taskId: "task-1",
        stepId: "join-binding",
        attemptId: "join-binding-attempt",
        leaseId: "join-binding-lease",
        workerBindingId: "join-binding-id",
        ownerInstanceId: "executor-1",
        expectedStepVersion: 3,
        expectedLeaseVersion: 1,
        origin: claimOrigin,
      }),
    ).rejects.toThrow("Worker binding Step conflict");
  } finally {
    await db.close();
  }
});

it("rejects a Step claim after its continuation grant is revoked", async () => {
  const db = await DomainDatabase.open(":memory:");
  try {
    const store = await fixture(db);
    await store.createGraph("task-1", [step("claim")], "claim", limits, system);
    await store.transitionStep({
      taskId: "task-1",
      stepId: "claim",
      expectedVersion: 1,
      from: "pending",
      to: "ready",
      origin: system,
    });
    await db.transaction(async (tx) => {
      await tx.execute({
        sql: "UPDATE grants SET revoked_at = ? WHERE id = ?",
        args: [new Date().toISOString(), "continue-grant"],
      });
    });
    await expect(
      store.claimReadyStep({
        taskId: "task-1",
        stepId: "claim",
        expectedStepVersion: 2,
        attemptId: "revoked-attempt",
        leaseId: "revoked-lease",
        ownerInstanceId: "scheduler-1",
        leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
        origin: claimOrigin,
      }),
    ).rejects.toThrow("Current Task continuation grant is required");
    expect((await store.listSteps("task-1"))[0]?.status).toBe("ready");
  } finally {
    await db.close();
  }
});

it("does not claim a Step after durable cancellation is requested", async () => {
  const db = await DomainDatabase.open(":memory:");
  try {
    const store = await fixture(db);
    await store.createGraph("task-1", [step("claim")], "claim", limits, system);
    await store.transitionStep({
      taskId: "task-1",
      stepId: "claim",
      expectedVersion: 1,
      from: "pending",
      to: "ready",
      origin: system,
    });
    const decisionId = await addCancelDecision(db);
    await store.requestDurableCancellation("task-1", {
      kind: "decision",
      decisionId,
      actorPrincipalId: "owner",
    });

    await expect(
      store.claimReadyStep({
        taskId: "task-1",
        stepId: "claim",
        expectedStepVersion: 2,
        attemptId: "cancelled-attempt",
        leaseId: "cancelled-lease",
        ownerInstanceId: "scheduler-1",
        leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
        origin: claimOrigin,
      }),
    ).rejects.toThrow("not active durable work");
    await db.transaction(async (tx) => {
      expect(
        (await tx.execute("SELECT id FROM task_attempts WHERE id = 'cancelled-attempt'")).rows,
      ).toHaveLength(0);
      expect(
        (await tx.execute("SELECT id FROM task_step_leases WHERE id = 'cancelled-lease'")).rows,
      ).toHaveLength(0);
      expect(
        (await tx.execute("SELECT status FROM task_steps WHERE id = 'claim'")).rows[0]?.status,
      ).toBe("cancelled");
    });
  } finally {
    await db.close();
  }
});

it("applies a signal once to its wait generation and does not wake a later wait", async () => {
  const db = await DomainDatabase.open(":memory:");
  try {
    const store = await fixture(db);
    await store.createGraph("task-1", [step("a", [])], "a", limits, system);
    await store.transitionStep({
      taskId: "task-1",
      stepId: "a",
      expectedVersion: 1,
      from: "pending",
      to: "ready",
      origin: system,
    });
    const wait1 = await store.createWait({
      id: "wait-1",
      taskId: "task-1",
      stepId: "a",
      expectedStepVersion: 2,
      attemptId: "attempt-1",
      policy: { version: 1, kind: "signal", signalKey: "continue", overdue: "stale" },
      origin: system,
    });
    expect(wait1.generation).toBe(1);
    const signal = {
      id: "signal-1",
      taskId: "task-1",
      stepId: "a",
      targetStepVersion: 3,
      targetAttemptId: "attempt-1",
      type: "continue",
      source: "principal" as const,
      actorPrincipalId: "owner",
      authorizationDecisionId: "decision-1",
      idempotencyKey: "key-1",
      receivedAt: new Date().toISOString(),
    };
    expect((await store.recordSignal(signal)).disposition).toBe("applied");
    expect((await store.recordSignal({ ...signal, id: "signal-duplicate" })).id).toBe("signal-1");
    const wait2 = await store.createWait({
      id: "wait-2",
      taskId: "task-1",
      stepId: "a",
      expectedStepVersion: 4,
      attemptId: "attempt-1",
      policy: { version: 1, kind: "signal", signalKey: "continue", overdue: "stale" },
      origin: system,
    });
    expect(wait2.generation).toBe(2);
    expect(
      (await store.recordSignal({ ...signal, id: "signal-stale", idempotencyKey: "key-2" }))
        .disposition,
    ).toBe("stale");
    expect((await store.listWaiting("task-1")).map((wait) => wait.id)).toEqual(["wait-2"]);
    expect(
      (await store.listEvents("task-1")).filter((event) => event.type === "SIGNAL_RECEIVED"),
    ).toHaveLength(2);
  } finally {
    await db.close();
  }
});

it("rejects a signal when its recorded grant was revoked before application", async () => {
  const db = await DomainDatabase.open(":memory:");
  try {
    const store = await fixture(db);
    await store.createGraph("task-1", [step("a", [], "signal_wait")], "a", limits, system);
    await store.transitionStep({
      taskId: "task-1",
      stepId: "a",
      expectedVersion: 1,
      from: "pending",
      to: "ready",
      origin: system,
    });
    await store.createWait({
      id: "wait-revoked",
      taskId: "task-1",
      stepId: "a",
      expectedStepVersion: 2,
      policy: { version: 1, kind: "signal", signalKey: "continue", overdue: "stale" },
      origin: system,
    });
    await db.transaction(async (tx) => {
      await tx.execute({
        sql: "INSERT INTO grants(id,principal_id,resource_id,action,scope_key,effect,created_at,revoked_at) VALUES (?,?,?,?,?,'allow',?,?)",
        args: ["revoked-grant", "owner", "task-task-1", "task:signal", "test", now, now],
      });
      await tx.execute({
        sql: "UPDATE authorization_decisions SET grant_id = ? WHERE id = ?",
        args: ["revoked-grant", "decision-1"],
      });
    });
    await expect(
      store.recordSignal({
        id: "revoked-signal",
        taskId: "task-1",
        stepId: "a",
        targetStepVersion: 3,
        type: "continue",
        source: "principal",
        actorPrincipalId: "owner",
        authorizationDecisionId: "decision-1",
        idempotencyKey: "revoked-key",
        receivedAt: new Date().toISOString(),
      }),
    ).rejects.toThrow("Matching ALLOW decision");
    expect((await store.listSteps("task-1"))[0]?.status).toBe("waiting");
  } finally {
    await db.close();
  }
});

it("requires a matching Task action, Resource, scope, and principal for signal authorization", async () => {
  const db = await DomainDatabase.open(":memory:");
  try {
    const store = await fixture(db);
    await db.transaction(async (tx) => {
      await tx.execute({
        sql: "INSERT INTO principals(id,kind,created_at) VALUES (?,?,?)",
        args: ["other", "owner", now],
      });
      for (const [id, principal, resource, action, scope] of [
        ["wrong-action", "owner", "task-task-1", "task:approve", "test"],
        ["wrong-resource", "owner", "task-other", "task:signal", "test"],
        ["wrong-scope", "owner", "task-task-1", "task:signal", "other-scope"],
        ["wrong-principal", "other", "task-task-1", "task:signal", "test"],
      ]) {
        await tx.execute({
          sql: "INSERT INTO authorization_decisions(id,principal_id,resource_id,action,scope_key,decision,reason,created_at) VALUES (?,?,?,?,?,'ALLOW','test',?)",
          args: [id, principal, resource, action, scope, now],
        });
      }
    });
    await store.createGraph("task-1", [step("a")], "a", limits, system);
    await store.transitionStep({
      taskId: "task-1",
      stepId: "a",
      expectedVersion: 1,
      from: "pending",
      to: "ready",
      origin: system,
    });
    await store.createWait({
      id: "wait-1",
      taskId: "task-1",
      stepId: "a",
      expectedStepVersion: 2,
      policy: { version: 1, kind: "signal", signalKey: "continue", overdue: "stale" },
      origin: system,
    });
    for (const [index, authorizationDecisionId] of [
      "wrong-action",
      "wrong-resource",
      "wrong-scope",
      "wrong-principal",
    ].entries()) {
      await expect(
        store.recordSignal({
          id: `signal-${index}`,
          taskId: "task-1",
          stepId: "a",
          targetStepVersion: 3,
          type: "continue",
          source: "principal",
          actorPrincipalId: "owner",
          authorizationDecisionId,
          idempotencyKey: `key-${index}`,
          receivedAt: now,
        }),
      ).rejects.toThrow("Matching ALLOW decision is required");
    }
  } finally {
    await db.close();
  }
});

it("requires an explicit approval signal key and rejects unrelated signal types", async () => {
  const db = await DomainDatabase.open(":memory:");
  try {
    const store = await fixture(db);
    await db.transaction(async (tx) => {
      await tx.execute({
        sql: "INSERT INTO authorization_decisions(id,principal_id,resource_id,action,scope_key,decision,reason,created_at) VALUES (?,?,?,?,?,?,?,?)",
        args: [
          "approval-decision",
          "owner",
          "task-task-1",
          "task:approve",
          "test",
          "ALLOW",
          "test",
          now,
        ],
      });
    });
    await store.createGraph("task-1", [step("a")], "a", limits, system);
    await store.transitionStep({
      taskId: "task-1",
      stepId: "a",
      expectedVersion: 1,
      from: "pending",
      to: "ready",
      origin: system,
    });
    await expect(
      store.createWait({
        id: "invalid-approval-wait",
        taskId: "task-1",
        stepId: "a",
        expectedStepVersion: 2,
        policy: { version: 1, kind: "approval", overdue: "stale" },
        origin: system,
      }),
    ).rejects.toThrow("Signal and approval waits need signalKey");
    await store.createWait({
      id: "approval-wait",
      taskId: "task-1",
      stepId: "a",
      expectedStepVersion: 2,
      policy: { version: 1, kind: "approval", signalKey: "approve", overdue: "stale" },
      origin: system,
    });
    const result = await store.recordSignal({
      id: "unrelated-approval-signal",
      taskId: "task-1",
      stepId: "a",
      targetStepVersion: 3,
      type: "anything-else",
      source: "principal",
      actorPrincipalId: "owner",
      authorizationDecisionId: "approval-decision",
      idempotencyKey: "unrelated-approval-key",
      receivedAt: now,
    });
    expect(result.disposition).toBe("stale");
    expect((await store.listSteps("task-1"))[0]?.status).toBe("waiting");
  } finally {
    await db.close();
  }
});

it("settles the active wait whenever a Step leaves waiting", async () => {
  const db = await DomainDatabase.open(":memory:");
  try {
    const store = await fixture(db);
    await store.createGraph("task-1", [step("a")], "a", limits, system);
    await store.transitionStep({
      taskId: "task-1",
      stepId: "a",
      expectedVersion: 1,
      from: "pending",
      to: "ready",
      origin: system,
    });
    await store.createWait({
      id: "wait-1",
      taskId: "task-1",
      stepId: "a",
      expectedStepVersion: 2,
      attemptId: "attempt-1",
      policy: { version: 1, kind: "signal", signalKey: "continue", overdue: "stale" },
      origin: system,
    });
    await store.transitionStep({
      taskId: "task-1",
      stepId: "a",
      expectedVersion: 3,
      from: "waiting",
      to: "ready",
      attemptId: "attempt-1",
      origin: system,
    });
    expect(await store.listWaiting("task-1")).toEqual([]);
    await store.createWait({
      id: "wait-2",
      taskId: "task-1",
      stepId: "a",
      expectedStepVersion: 4,
      attemptId: "attempt-1",
      policy: { version: 1, kind: "signal", signalKey: "continue", overdue: "stale" },
      origin: system,
    });
    await store.transitionStep({
      taskId: "task-1",
      stepId: "a",
      expectedVersion: 5,
      from: "waiting",
      to: "cancelled",
      attemptId: "attempt-1",
      origin: system,
    });
    expect(await store.listWaiting("task-1")).toEqual([]);
    await db.transaction(async (tx) => {
      expect(
        (await tx.execute("SELECT id,status FROM task_waits ORDER BY generation")).rows,
      ).toMatchObject([
        { id: "wait-1", status: "resumed" },
        { id: "wait-2", status: "cancelled" },
      ]);
    });
  } finally {
    await db.close();
  }
});

it("records a late signal as stale and blocks its timed-out Step using server time", async () => {
  const db = await DomainDatabase.open(":memory:");
  try {
    const store = await fixture(db);
    await store.createGraph("task-1", [step("a")], "a", limits, system);
    await store.transitionStep({
      taskId: "task-1",
      stepId: "a",
      expectedVersion: 1,
      from: "pending",
      to: "ready",
      origin: system,
    });
    await store.createWait({
      id: "wait-1",
      taskId: "task-1",
      stepId: "a",
      expectedStepVersion: 2,
      policy: {
        version: 1,
        kind: "signal",
        signalKey: "continue",
        timeoutAt: new Date(Date.now() - 1000).toISOString(),
        overdue: "stale",
      },
      origin: system,
    });
    const result = await store.recordSignal({
      id: "late-signal",
      taskId: "task-1",
      stepId: "a",
      targetStepVersion: 3,
      type: "continue",
      source: "principal",
      actorPrincipalId: "owner",
      authorizationDecisionId: "decision-1",
      idempotencyKey: "late-key",
      receivedAt: now,
    });
    expect(result.disposition).toBe("stale");
    expect((await store.listSteps("task-1"))[0]?.status).toBe("blocked");
    expect(await store.listWaiting("task-1")).toEqual([]);
    expect((await store.listEvents("task-1")).map((event) => event.type)).toContain("STEP_BLOCKED");
    await db.transaction(async (tx) => {
      expect(
        (await tx.execute("SELECT status FROM task_waits WHERE id = 'wait-1'")).rows[0]?.status,
      ).toBe("stale");
    });
  } finally {
    await db.close();
  }
});

it("keeps a quarantined lease occupied until explicit outcome reconciliation", async () => {
  const db = await DomainDatabase.open(":memory:");
  try {
    const store = await fixture(db);
    await store.createGraph("task-1", [step("a")], "a", limits, system);
    await store.transitionStep({
      taskId: "task-1",
      stepId: "a",
      expectedVersion: 1,
      from: "pending",
      to: "ready",
      origin: system,
    });
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    const first = await store.acquireLease({
      id: "lease-1",
      taskId: "task-1",
      stepId: "a",
      ownerInstanceId: "one",
      expiresAt,
      origin: system,
    });
    expect(first?.version).toBe(1);
    expect(
      await store.acquireLease({
        id: "lease-2",
        taskId: "task-1",
        stepId: "a",
        ownerInstanceId: "two",
        expiresAt,
        origin: system,
      }),
    ).toBeNull();
    await expect(
      store.updateLease({
        taskId: "task-1",
        leaseId: "lease-1",
        ownerInstanceId: "two",
        expectedVersion: 1,
        action: "release",
        origin: system,
      }),
    ).rejects.toThrow("version conflict");
    await store.updateLease({
      taskId: "task-1",
      leaseId: "lease-1",
      ownerInstanceId: "one",
      expectedVersion: 1,
      action: "quarantine",
      origin: system,
    });
    expect(
      await store.acquireLease({
        id: "lease-2",
        taskId: "task-1",
        stepId: "a",
        ownerInstanceId: "two",
        expiresAt,
        origin: system,
      }),
    ).toBeNull();
    await expect(
      store.updateLease({
        taskId: "task-1",
        leaseId: "lease-1",
        ownerInstanceId: "one",
        expectedVersion: 2,
        action: "release",
        origin: system,
      }),
    ).rejects.toThrow("Lease version conflict");
    expect(
      await store.acquireLease({
        id: "lease-2",
        taskId: "task-1",
        stepId: "a",
        ownerInstanceId: "two",
        expiresAt,
        origin: system,
      }),
    ).toBeNull();
  } finally {
    await db.close();
  }
});

it("stores checkpoint references without rewriting an earlier checkpoint", async () => {
  const db = await DomainDatabase.open(":memory:");
  try {
    const store = await fixture(db);
    await store.createGraph("task-1", [step("a")], "a", limits, system);
    const checkpoint = {
      id: "checkpoint-1",
      taskId: "task-1",
      stepId: "a",
      type: "step_state",
      stateRef: "asset:state-1",
      sourceEvidenceRef: "trace:1",
      policyVersion: 1,
      createdAt: now,
    };
    await store.writeCheckpoint(checkpoint, system, 1);
    expect(await store.latestCheckpoint("task-1", "a")).toMatchObject(checkpoint);
    const laterWrite = {
      ...checkpoint,
      id: "checkpoint-2",
      stateRef: "asset:state-2",
      createdAt: "2020-01-01T00:00:00.000Z",
    };
    await store.writeCheckpoint(laterWrite, system, 2);
    expect(await store.latestCheckpoint("task-1", "a")).toMatchObject(laterWrite);
    expect(await store.latestCheckpoint("task-1")).toMatchObject(laterWrite);
    await db.transaction(async (tx) => {
      expect(
        (await tx.execute("SELECT checkpoint_ref FROM tasks WHERE id = 'task-1'")).rows[0]
          ?.checkpoint_ref,
      ).toBe("asset:state-2");
    });
    await db.transaction(async (tx) => {
      await expect(
        tx.execute("UPDATE task_checkpoints SET state_ref = 'replacement'"),
      ).rejects.toThrow();
    });
  } finally {
    await db.close();
  }
});

it("does not advance a waiting Step or acquire a lease after Task cancellation", async () => {
  const db = await DomainDatabase.open(":memory:");
  try {
    const store = await fixture(db);
    await store.createGraph("task-1", [step("a")], "a", limits, system);
    await store.transitionStep({
      taskId: "task-1",
      stepId: "a",
      expectedVersion: 1,
      from: "pending",
      to: "ready",
      origin: system,
    });
    await store.createWait({
      id: "wait-1",
      taskId: "task-1",
      stepId: "a",
      expectedStepVersion: 2,
      policy: { version: 1, kind: "signal", signalKey: "continue", overdue: "stale" },
      origin: system,
    });
    await db.transaction(async (tx) => {
      await tx.execute(
        "UPDATE tasks SET status = 'CANCELED', cancellation_state = 'requested' WHERE id = 'task-1'",
      );
    });
    await expect(
      store.recordSignal({
        id: "signal-1",
        taskId: "task-1",
        stepId: "a",
        targetStepVersion: 3,
        type: "continue",
        source: "principal",
        actorPrincipalId: "owner",
        authorizationDecisionId: "decision-1",
        idempotencyKey: "cancelled-key",
        receivedAt: new Date().toISOString(),
      }),
    ).rejects.toThrow("not active durable work");
    await expect(
      store.acquireLease({
        id: "lease-1",
        taskId: "task-1",
        stepId: "a",
        ownerInstanceId: "one",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        origin: system,
      }),
    ).rejects.toThrow("not active durable work");
    expect((await store.listSteps("task-1"))[0]?.status).toBe("waiting");
  } finally {
    await db.close();
  }
});

it("records cancellation before stopping and cancels current waits and future Steps", async () => {
  const db = await DomainDatabase.open(":memory:");
  try {
    const store = await fixture(db);
    await store.createGraph(
      "task-1",
      [step("waiting", [], "signal_wait"), step("future")],
      "waiting",
      limits,
      system,
    );
    await store.transitionStep({
      taskId: "task-1",
      stepId: "waiting",
      expectedVersion: 1,
      from: "pending",
      to: "ready",
      origin: system,
    });
    await store.createWait({
      id: "cancel-wait",
      taskId: "task-1",
      stepId: "waiting",
      expectedStepVersion: 2,
      policy: { version: 1, kind: "signal", signalKey: "continue", overdue: "stale" },
      origin: system,
    });
    const decisionId = await addCancelDecision(db);
    const origin = { kind: "decision", decisionId, actorPrincipalId: "owner" } as const;

    await expect(store.requestDurableCancellation("task-1", origin)).resolves.toMatchObject({
      status: "NEW",
      cancellationState: "requested",
    });
    await store.requestDurableCancellation("task-1", origin);

    expect((await store.listSteps("task-1")).map(({ id, status }) => [id, status])).toEqual([
      ["future", "cancelled"],
      ["waiting", "cancelled"],
    ]);
    expect(await store.listWaiting("task-1")).toEqual([]);
    await db.transaction(async (tx) => {
      expect(
        (await tx.execute("SELECT status FROM task_waits WHERE id = 'cancel-wait'")).rows[0]
          ?.status,
      ).toBe("cancelled");
      expect(
        (await tx.execute("SELECT status,cancellation_state FROM tasks WHERE id = 'task-1'"))
          .rows[0],
      ).toMatchObject({ status: "NEW", cancellation_state: "requested" });
    });
    await expect(
      store.recordSignal({
        id: "signal-after-cancel",
        taskId: "task-1",
        stepId: "waiting",
        targetStepVersion: 3,
        type: "continue",
        source: "principal",
        actorPrincipalId: "owner",
        authorizationDecisionId: "decision-1",
        idempotencyKey: "signal-after-cancel",
        receivedAt: now,
      }),
    ).rejects.toThrow("not active durable work");
    const events = await store.listEvents("task-1");
    expect(events.filter(({ type }) => type === "TASK_CANCELLED")).toHaveLength(1);
    expect(events.filter(({ type }) => type === "STEP_CANCELLED")).toHaveLength(2);
    expect(events.find(({ type }) => type === "TASK_CANCELLED")?.metadata).toMatchObject({
      phase: "requested",
      rollbackPerformed: false,
    });
  } finally {
    await db.close();
  }
});

it("keeps cancellation unresolved until running Steps and worker leases settle", async () => {
  const db = await DomainDatabase.open(":memory:");
  try {
    const store = await fixture(db);
    await store.createGraph(
      "task-1",
      [step("worker", [], "herdr_worker")],
      "worker",
      limits,
      system,
    );
    await store.transitionStep({
      taskId: "task-1",
      stepId: "worker",
      expectedVersion: 1,
      from: "pending",
      to: "ready",
      origin: system,
    });
    await store.transitionStep({
      taskId: "task-1",
      stepId: "worker",
      expectedVersion: 2,
      from: "ready",
      to: "running",
      origin: system,
    });
    const lease = await store.acquireLease({
      id: "cancel-lease",
      taskId: "task-1",
      stepId: "worker",
      ownerInstanceId: "worker-1",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      origin: system,
    });
    expect(lease?.state).toBe("active");
    const decisionId = await addCancelDecision(db);
    const owner = { kind: "decision", decisionId, actorPrincipalId: "owner" } as const;
    await store.requestDurableCancellation("task-1", owner);

    await expect(store.settleDurableCancellation("task-1", system)).rejects.toThrow(
      "running Steps or active leases",
    );
    expect((await store.listSteps("task-1"))[0]?.status).toBe("running");
    await store.updateLease({
      taskId: "task-1",
      leaseId: "cancel-lease",
      ownerInstanceId: "worker-1",
      expectedVersion: 1,
      action: "release",
      origin: system,
    });
    await store.transitionStep({
      taskId: "task-1",
      stepId: "worker",
      expectedVersion: 3,
      from: "running",
      to: "cancelled",
      origin: system,
      metadata: { reason: "worker_stop_confirmed" },
    });
    await db.transaction(async (tx) => {
      await tx.execute({
        sql: "INSERT INTO attention_items(id,kind,summary,principal_id,task_id,created_at) VALUES ('cancel-attention','task_review','Review task','owner','task-1',?)",
        args: [now],
      });
    });
    await expect(store.settleDurableCancellation("task-1", system)).resolves.toMatchObject({
      status: "CANCELED",
      cancellationState: "settled",
    });
    await store.settleDurableCancellation("task-1", system);
    await db.transaction(async (tx) => {
      expect(
        (
          await tx.execute(
            "SELECT status,cancellation_state,completed_at FROM tasks WHERE id = 'task-1'",
          )
        ).rows[0],
      ).toMatchObject({ status: "CANCELED", cancellation_state: "settled" });
      expect(
        (await tx.execute("SELECT resolved_at FROM attention_items WHERE id = 'cancel-attention'"))
          .rows[0]?.resolved_at,
      ).toBeTruthy();
    });
    expect(
      (await store.listEvents("task-1")).filter(({ type }) => type === "TASK_CANCELLED"),
    ).toHaveLength(2);
  } finally {
    await db.close();
  }
});

it("requires an exact, current task cancellation ALLOW decision", async () => {
  const db = await DomainDatabase.open(":memory:");
  try {
    const store = await fixture(db);
    await store.createGraph("task-1", [step("a")], "a", limits, system);
    const mismatches = [
      { id: "cancel-action", action: "task:signal" },
      { id: "cancel-principal", principal: "other" },
      { id: "cancel-resource", resource: "task-other" },
      { id: "cancel-scope", scope: "other" },
    ];
    for (const mismatch of mismatches) {
      const decisionId = await addCancelDecision(db, mismatch);
      await expect(
        store.requestDurableCancellation("task-1", {
          kind: "decision",
          decisionId,
          actorPrincipalId: "owner",
        }),
      ).rejects.toThrow("Matching Task cancellation ALLOW decision is required");
    }

    const revokedDecisionId = await addCancelDecision(db, {
      id: "cancel-revoked",
      grantId: "cancel-grant",
    });
    await db.transaction(async (tx) => {
      await tx.execute({
        sql: "UPDATE grants SET revoked_at = ? WHERE id = 'cancel-grant'",
        args: [now],
      });
    });
    await expect(
      store.requestDurableCancellation("task-1", {
        kind: "decision",
        decisionId: revokedDecisionId,
        actorPrincipalId: "owner",
      }),
    ).rejects.toThrow("Matching Task cancellation ALLOW decision is required");
    expect((await store.listSteps("task-1"))[0]?.status).toBe("pending");
  } finally {
    await db.close();
  }
});

it("moves a completed durable graph to review and accepts it with matching authorization", async () => {
  const db = await DomainDatabase.open(":memory:");
  try {
    const store = await fixture(db);
    await store.createGraph(
      "task-1",
      [step("root"), step("optional", ["root"])],
      "root",
      limits,
      system,
    );
    await succeedStep(store, "root");
    await store.transitionStep({
      taskId: "task-1",
      stepId: "optional",
      expectedVersion: 1,
      from: "pending",
      to: "skipped",
      origin: system,
    });

    await store.markTaskReview("task-1", system);
    await store.markTaskReview("task-1", system);
    await db.transaction(async (tx) => {
      expect(
        (await tx.execute("SELECT status FROM tasks WHERE id = 'task-1'")).rows[0]?.status,
      ).toBe("REVIEW");
      expect(
        (
          await tx.execute(
            "SELECT id,kind,task_id,resolved_at FROM attention_items WHERE task_id = 'task-1'",
          )
        ).rows,
      ).toHaveLength(1);
      expect(
        (await tx.execute("SELECT type FROM task_events WHERE task_id = 'task-1'")).rows.map(
          (row) => row.type,
        ),
      ).toContain("TASK_REVIEW");
    });

    const actionMismatch = await addAcceptDecision(db, {
      id: "accept-wrong-action",
      action: "task:signal",
    });
    const scopeMismatch = await addAcceptDecision(db, { id: "accept-wrong-scope", scope: "other" });
    const principalMismatch = await addAcceptDecision(db, {
      id: "accept-wrong-principal",
      principal: "other",
    });
    for (const decisionId of [actionMismatch, scopeMismatch, principalMismatch]) {
      await expect(
        store.acceptDurableTask("task-1", {
          kind: "decision",
          decisionId,
          actorPrincipalId: "owner",
        }),
      ).rejects.toThrow("Matching Task acceptance ALLOW decision is required");
    }

    await db.transaction(async (tx) => {
      await tx.execute({
        sql: "INSERT INTO grants(id,principal_id,resource_id,action,scope_key,effect,created_at,revoked_at) VALUES (?,?,?,?,?,'allow',?,?)",
        args: ["revoked-accept-grant", "owner", "task-task-1", "task:accept", "test", now, now],
      });
      await tx.execute({
        sql: "INSERT INTO authorization_decisions(id,principal_id,resource_id,action,scope_key,decision,reason,grant_id,created_at) VALUES (?,?,?,?,?,'ALLOW','test',?,?)",
        args: [
          "revoked-accept-decision",
          "owner",
          "task-task-1",
          "task:accept",
          "test",
          "revoked-accept-grant",
          now,
        ],
      });
    });
    await expect(
      store.acceptDurableTask("task-1", {
        kind: "decision",
        decisionId: "revoked-accept-decision",
        actorPrincipalId: "owner",
      }),
    ).rejects.toThrow("Matching Task acceptance ALLOW decision is required");

    const decisionId = await addAcceptDecision(db);
    await store.acceptDurableTask("task-1", {
      kind: "decision",
      decisionId,
      actorPrincipalId: "owner",
    });
    await db.transaction(async (tx) => {
      const task = (await tx.execute("SELECT status,completed_at FROM tasks WHERE id = 'task-1'"))
        .rows[0];
      expect(task?.status).toBe("DONE");
      expect(task?.completed_at).toBeTruthy();
      expect(
        (await tx.execute("SELECT resolved_at FROM attention_items WHERE task_id = 'task-1'"))
          .rows[0]?.resolved_at,
      ).toBeTruthy();
      expect(
        (
          await tx.execute(
            "SELECT type,principal_id FROM ops_trace_events WHERE task_id = 'task-1'",
          )
        ).rows,
      ).toMatchObject([{ type: "task.accepted", principal_id: "owner" }]);
      expect(
        (await tx.execute("SELECT type FROM task_events WHERE task_id = 'task-1'")).rows.map(
          (row) => row.type,
        ),
      ).toContain("TASK_ACCEPTED");
    });
  } finally {
    await db.close();
  }
});

it("rejects Task review until the root succeeds and every Step is terminal", async () => {
  const db = await DomainDatabase.open(":memory:");
  try {
    const store = await fixture(db);
    await store.createGraph(
      "task-1",
      [step("root"), step("child", ["root"])],
      "root",
      limits,
      system,
    );
    await expect(store.markTaskReview("task-1", system)).rejects.toThrow("Root Step must succeed");
    await succeedStep(store, "root");
    await store.transitionStep({
      taskId: "task-1",
      stepId: "child",
      expectedVersion: 1,
      from: "pending",
      to: "ready",
      origin: system,
    });
    await expect(store.markTaskReview("task-1", system)).rejects.toThrow(
      "All Task Steps must be terminal",
    );
    await store.transitionStep({
      taskId: "task-1",
      stepId: "child",
      expectedVersion: 2,
      from: "ready",
      to: "running",
      origin: system,
    });
    await store.transitionStep({
      taskId: "task-1",
      stepId: "child",
      expectedVersion: 3,
      from: "running",
      to: "failed",
      origin: system,
    });
    await store.markTaskReview("task-1", system);
  } finally {
    await db.close();
  }
});

it("allows a cancelled non-root Step after the root succeeds", async () => {
  const db = await DomainDatabase.open(":memory:");
  try {
    const store = await fixture(db);
    await store.createGraph(
      "task-1",
      [step("root"), step("optional", ["root"])],
      "root",
      limits,
      system,
    );
    await succeedStep(store, "root");
    await db.transaction(async (tx) => {
      await tx.execute("UPDATE task_steps SET status = 'cancelled' WHERE id = 'optional'");
    });
    await store.markTaskReview("task-1", system);
    expect((await new TaskStore(db).getTask("task-1"))?.status).toBe("REVIEW");
  } finally {
    await db.close();
  }
});

it("creates attention for a blocked non-root Step once", async () => {
  const db = await DomainDatabase.open(":memory:");
  try {
    const store = await fixture(db);
    await store.createGraph(
      "task-1",
      [step("root"), step("branch", ["root"])],
      "root",
      limits,
      system,
    );
    await db.transaction(async (tx) => {
      await tx.execute("UPDATE task_steps SET status = 'blocked' WHERE id = 'branch'");
    });
    await store.markTaskNeedsAttention("task-1", system, "branch");
    await store.markTaskNeedsAttention("task-1", system, "branch");
    await db.transaction(async (tx) => {
      expect(
        (await tx.execute("SELECT status FROM tasks WHERE id = 'task-1'")).rows[0]?.status,
      ).toBe("WAITING_INPUT");
      expect(
        (
          await tx.execute(
            "SELECT summary FROM attention_items WHERE task_id = 'task-1' AND resolved_at IS NULL",
          )
        ).rows,
      ).toHaveLength(1);
      expect(
        (
          await tx.execute(
            "SELECT step_id FROM task_events WHERE task_id = 'task-1' AND type = 'TASK_BLOCKED'",
          )
        ).rows,
      ).toMatchObject([{ step_id: "branch" }]);
    });
    await expect(store.markTaskNeedsAttention("task-1", system, "root")).rejects.toThrow(
      "Task Step does not need failure attention",
    );
  } finally {
    await db.close();
  }
});

it("requires no unresolved waits or leases before Task review", async () => {
  const db = await DomainDatabase.open(":memory:");
  try {
    const store = await fixture(db);
    await store.createGraph("task-1", [step("root")], "root", limits, system);
    await succeedStep(store, "root");
    const future = new Date(Date.now() + 60_000).toISOString();
    await db.transaction(async (tx) => {
      await tx.execute({
        sql: "INSERT INTO task_waits(id,task_id,step_id,generation,kind,status,started_at,due_at,policy_json,updated_at) VALUES ('dangling-wait','task-1','root',1,'duration','waiting',?,?,?,?)",
        args: [
          now,
          future,
          JSON.stringify({
            version: 1,
            kind: "duration",
            durationMs: 1,
            overdue: "resume",
            dueAt: future,
          }),
          now,
        ],
      });
    });
    await expect(store.markTaskReview("task-1", system)).rejects.toThrow("active waits or leases");
    await db.transaction(async (tx) => {
      await tx.execute("UPDATE task_waits SET status = 'resumed' WHERE id = 'dangling-wait'");
      await tx.execute({
        sql: "INSERT INTO task_step_leases(id,task_id,step_id,owner_instance_id,state,version,acquired_at,heartbeat_at,expires_at) VALUES ('dangling-lease','task-1','root','worker','active',1,?,?,?)",
        args: [now, now, future],
      });
    });
    await expect(store.markTaskReview("task-1", system)).rejects.toThrow("active waits or leases");
  } finally {
    await db.close();
  }
});

it("fires due timer and timeout waits once and completes dedicated wait Steps", async () => {
  const db = await DomainDatabase.open(":memory:");
  try {
    const store = await fixture(db);
    await store.createGraph(
      "task-1",
      [
        step("timer", [], "timer_wait"),
        step("signal", [], "signal_wait"),
        step("approval", [], "approval_wait"),
        step("timer-timeout", [], "timer_wait"),
      ],
      "timer",
      limits,
      system,
    );
    await store.transitionStep({
      taskId: "task-1",
      stepId: "timer",
      expectedVersion: 1,
      from: "pending",
      to: "ready",
      origin: system,
    });
    await store.createWait({
      id: "timer-wait",
      taskId: "task-1",
      stepId: "timer",
      expectedStepVersion: 2,
      policy: {
        version: 1,
        kind: "until",
        dueAt: new Date(Date.now() + 60_000).toISOString(),
        overdue: "resume",
      },
      origin: system,
    });
    await db.transaction(async (tx) => {
      await tx.execute({
        sql: "UPDATE task_waits SET due_at = ? WHERE id = 'timer-wait'",
        args: [now],
      });
    });
    expect((await store.fireDueWait("task-1", "timer", 3, system)).status).toBe("succeeded");
    await expect(store.fireDueWait("task-1", "timer", 4, system)).rejects.toThrow(
      "Step version conflict",
    );

    await store.transitionStep({
      taskId: "task-1",
      stepId: "signal",
      expectedVersion: 1,
      from: "pending",
      to: "ready",
      origin: system,
    });
    await store.createWait({
      id: "signal-timeout",
      taskId: "task-1",
      stepId: "signal",
      expectedStepVersion: 2,
      policy: {
        version: 1,
        kind: "signal",
        signalKey: "continue",
        timeoutAt: new Date(Date.now() - 1000).toISOString(),
        overdue: "stale",
      },
      origin: system,
    });
    expect((await store.fireDueWait("task-1", "signal", 3, system)).status).toBe("blocked");
    expect((await store.listEvents("task-1")).map((event) => event.type)).toContain("STEP_BLOCKED");
    await db.transaction(async (tx) => {
      expect(
        (await tx.execute("SELECT status FROM task_waits WHERE id = 'signal-timeout'")).rows[0]
          ?.status,
      ).toBe("stale");
    });

    await store.transitionStep({
      taskId: "task-1",
      stepId: "approval",
      expectedVersion: 1,
      from: "pending",
      to: "ready",
      origin: system,
    });
    await store.createWait({
      id: "approval-timeout",
      taskId: "task-1",
      stepId: "approval",
      expectedStepVersion: 2,
      policy: {
        version: 1,
        kind: "approval",
        signalKey: "approved",
        timeoutAt: new Date(Date.now() - 1000).toISOString(),
        overdue: "resume",
      },
      origin: system,
    });
    expect((await store.fireDueWait("task-1", "approval", 3, system)).status).toBe("blocked");

    await store.transitionStep({
      taskId: "task-1",
      stepId: "timer-timeout",
      expectedVersion: 1,
      from: "pending",
      to: "ready",
      origin: system,
    });
    await store.createWait({
      id: "timer-early-timeout",
      taskId: "task-1",
      stepId: "timer-timeout",
      expectedStepVersion: 2,
      policy: {
        version: 1,
        kind: "until",
        dueAt: new Date(Date.now() + 60_000).toISOString(),
        timeoutAt: new Date(Date.now() - 1000).toISOString(),
        overdue: "resume",
      },
      origin: system,
    });
    expect((await store.fireDueWait("task-1", "timer-timeout", 3, system)).status).toBe("blocked");
  } finally {
    await db.close();
  }
});

it("completes a signal-only Step after an authorized matching signal", async () => {
  const db = await DomainDatabase.open(":memory:");
  try {
    const store = await fixture(db);
    await store.createGraph(
      "task-1",
      [step("signal", [], "signal_wait")],
      "signal",
      limits,
      system,
    );
    await store.transitionStep({
      taskId: "task-1",
      stepId: "signal",
      expectedVersion: 1,
      from: "pending",
      to: "ready",
      origin: system,
    });
    await store.createWait({
      id: "signal-wait",
      taskId: "task-1",
      stepId: "signal",
      expectedStepVersion: 2,
      policy: { version: 1, kind: "signal", signalKey: "continue", overdue: "resume" },
      origin: system,
    });
    const result = await store.recordSignal({
      id: "signal-only",
      taskId: "task-1",
      stepId: "signal",
      targetStepVersion: 3,
      type: "continue",
      source: "principal",
      actorPrincipalId: "owner",
      authorizationDecisionId: "decision-1",
      idempotencyKey: "signal-only-key",
      receivedAt: now,
    });
    expect(result.disposition).toBe("applied");
    expect((await store.listSteps("task-1"))[0]?.status).toBe("succeeded");
    expect((await store.listEvents("task-1")).map((event) => event.type)).toContain(
      "STEP_SUCCEEDED",
    );
  } finally {
    await db.close();
  }
});

it("rejects signal and approval waits after timeout even when overdue policy resumes", async () => {
  const db = await DomainDatabase.open(":memory:");
  try {
    const store = await fixture(db);
    await store.createGraph(
      "task-1",
      [step("signal", [], "signal_wait")],
      "signal",
      limits,
      system,
    );
    await store.transitionStep({
      taskId: "task-1",
      stepId: "signal",
      expectedVersion: 1,
      from: "pending",
      to: "ready",
      origin: system,
    });
    await store.createWait({
      id: "signal-timeout",
      taskId: "task-1",
      stepId: "signal",
      expectedStepVersion: 2,
      policy: {
        version: 1,
        kind: "signal",
        signalKey: "continue",
        timeoutAt: new Date(Date.now() - 1_000).toISOString(),
        overdue: "resume",
      },
      origin: system,
    });
    const result = await store.recordSignal({
      id: "signal-after-timeout",
      taskId: "task-1",
      stepId: "signal",
      targetStepVersion: 3,
      type: "continue",
      source: "principal",
      actorPrincipalId: "owner",
      authorizationDecisionId: "decision-1",
      idempotencyKey: "late-signal",
      receivedAt: new Date().toISOString(),
    });
    expect(result.disposition).toBe("stale");
    expect((await store.listSteps("task-1"))[0]?.status).toBe("blocked");
    expect(await store.listWaiting("task-1")).toEqual([]);
  } finally {
    await db.close();
  }
});

it("settles a claimed worker Step into review without accepting the Task", async () => {
  const db = await DomainDatabase.open(":memory:");
  try {
    const store = await fixture(db);
    await store.createGraph(
      "task-1",
      [step("worker", [], "herdr_worker")],
      "worker",
      limits,
      system,
    );
    await store.transitionStep({
      taskId: "task-1",
      stepId: "worker",
      expectedVersion: 1,
      from: "pending",
      to: "ready",
      origin: system,
    });
    await store.claimReadyStep({
      taskId: "task-1",
      stepId: "worker",
      expectedStepVersion: 2,
      attemptId: "worker-attempt",
      leaseId: "worker-lease",
      ownerInstanceId: "executor-1",
      leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      origin: claimOrigin,
    });
    await expect(
      store.transitionStep({
        taskId: "task-1",
        stepId: "worker",
        expectedVersion: 3,
        from: "running",
        to: "succeeded",
        origin: system,
      }),
    ).rejects.toThrow("lease settlement");
    await expect(
      store.settleClaimedStep({
        taskId: "task-1",
        stepId: "worker",
        attemptId: "worker-attempt",
        leaseId: "worker-lease",
        ownerInstanceId: "stale-executor",
        expectedStepVersion: 3,
        expectedLeaseVersion: 1,
        outcome: "review",
        evidenceRef: "trace:worker-done",
        origin: system,
      }),
    ).rejects.toThrow("ownership conflict");
    const reviewed = await store.settleClaimedStep({
      taskId: "task-1",
      stepId: "worker",
      attemptId: "worker-attempt",
      leaseId: "worker-lease",
      ownerInstanceId: "executor-1",
      expectedStepVersion: 3,
      expectedLeaseVersion: 1,
      outcome: "review",
      evidenceRef: "trace:worker-done",
      outputRef: "artifact:worker-result",
      origin: system,
    });
    expect(reviewed).toMatchObject({ status: "review", outputRef: "artifact:worker-result" });
    await db.transaction(async (tx) => {
      expect(
        (await tx.execute("SELECT status FROM tasks WHERE id = 'task-1'")).rows[0]?.status,
      ).not.toBe("DONE");
      expect(
        (await tx.execute("SELECT status FROM task_attempts WHERE id = 'worker-attempt'")).rows[0]
          ?.status,
      ).toBe("review");
      expect(
        (await tx.execute("SELECT state FROM task_step_leases WHERE id = 'worker-lease'")).rows[0]
          ?.state,
      ).toBe("released");
    });
    expect((await store.listEvents("task-1")).slice(-2).map((event) => event.type)).toEqual([
      "ATTEMPT_FINISHED",
      "STEP_REVIEW",
    ]);
    await expect(
      store.settleClaimedStep({
        taskId: "task-1",
        stepId: "worker",
        attemptId: "worker-attempt",
        leaseId: "worker-lease",
        ownerInstanceId: "executor-1",
        expectedStepVersion: 3,
        expectedLeaseVersion: 1,
        outcome: "review",
        evidenceRef: "trace:worker-done",
        origin: system,
      }),
    ).rejects.toThrow("Step settlement conflict");
  } finally {
    await db.close();
  }
});

it("atomically schedules a retry with the exact claimed lease and fires it after database reopen", async () => {
  const directory = await mkdtemp(join(tmpdir(), "glassbox-long-work-retry-"));
  const path = join(directory, "data.db");
  try {
    const db = await DomainDatabase.open(path);
    const store = await fixture(db);
    try {
      await claimRetryStep(store, db, { seedPriorReworkCycle: true });
      expect((await new TaskStore(db).getTask("task-1"))?.status).toBe("RUNNING");
      const scheduled = await store.scheduleClaimedStepRetry({
        taskId: "task-1",
        stepId: "retry",
        attemptId: "retry-attempt",
        leaseId: "retry-lease",
        ownerInstanceId: "executor-1",
        expectedStepVersion: 3,
        expectedLeaseVersion: 1,
        proof: {
          ref: "evidence:retry-proof",
          sideEffectOutcome: "not_applied",
          errorClass: "transient",
        },
        origin: system,
      });
      expect(scheduled).toMatchObject({ status: "waiting", version: 4 });
      expect(scheduled.waitPolicy).toMatchObject({ kind: "retry", overdue: "resume" });
      await db.transaction(async (tx) => {
        expect(
          (await tx.execute("SELECT status FROM task_attempts WHERE id = 'retry-attempt'")).rows[0]
            ?.status,
        ).toBe("failed");
        expect(
          (await tx.execute("SELECT state FROM task_step_leases WHERE id = 'retry-lease'")).rows[0]
            ?.state,
        ).toBe("released");
        expect(
          (await tx.execute("SELECT kind,status,due_at FROM task_waits WHERE step_id = 'retry'"))
            .rows[0],
        ).toMatchObject({ kind: "retry", status: "waiting" });
      });
      expect((await store.listEvents("task-1")).slice(-3).map((event) => event.type)).toEqual([
        "ATTEMPT_FINISHED",
        "RETRY_SCHEDULED",
        "STEP_WAITING",
      ]);
      await expect(
        store.scheduleClaimedStepRetry({
          taskId: "task-1",
          stepId: "retry",
          attemptId: "retry-attempt",
          leaseId: "retry-lease",
          ownerInstanceId: "executor-1",
          expectedStepVersion: 3,
          expectedLeaseVersion: 1,
          proof: {
            ref: "evidence:duplicate",
            sideEffectOutcome: "not_started",
            errorClass: "transient",
          },
          origin: system,
        }),
      ).rejects.toThrow("conflict");
    } finally {
      await db.close();
    }

    const reopened = await DomainDatabase.open(path);
    try {
      const read = new LongWorkStore(reopened);
      const waiting = (await read.listWaiting("task-1"))[0];
      expect(waiting).toMatchObject({
        stepId: "retry",
        attemptId: "retry-attempt",
        policy: { kind: "retry" },
      });
      expect(Date.parse(waiting!.policy.dueAt!)).toBeLessThanOrEqual(Date.now());
      expect(await read.fireDueWait("task-1", "retry", 4, system)).toMatchObject({
        status: "ready",
        version: 5,
      });
      expect((await read.listEvents("task-1")).at(-1)?.metadata).toMatchObject({
        reason: "retry_due",
      });
      await expect(read.fireDueWait("task-1", "retry", 4, system)).rejects.toThrow(
        "version conflict",
      );
    } finally {
      await reopened.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }).catch(
      (error: NodeJS.ErrnoException) => {
        if (process.platform !== "win32" || error.code !== "EBUSY") throw error;
      },
    );
  }
});

it("refuses retry without matching policy evidence or the exact active lease version", async () => {
  const db = await DomainDatabase.open(":memory:");
  try {
    const store = await fixture(db);
    await claimRetryStep(store, db);
    const retry = (overrides: Record<string, unknown> = {}) =>
      store.scheduleClaimedStepRetry({
        taskId: "task-1",
        stepId: "retry",
        attemptId: "retry-attempt",
        leaseId: "retry-lease",
        ownerInstanceId: "executor-1",
        expectedStepVersion: 3,
        expectedLeaseVersion: 1,
        proof: {
          ref: "evidence:retry-proof",
          sideEffectOutcome: "not_started",
          errorClass: "transient",
        },
        origin: system,
        ...overrides,
      } as Parameters<typeof store.scheduleClaimedStepRetry>[0]);
    await expect(retry({ expectedLeaseVersion: 2 })).rejects.toThrow("ownership conflict");
    await expect(
      retry({
        proof: { ref: "evidence:unknown", sideEffectOutcome: "unknown", errorClass: "transient" },
      }),
    ).rejects.toThrow("Invalid retry proof");
    await expect(
      retry({
        proof: {
          ref: "evidence:permanent",
          sideEffectOutcome: "not_started",
          errorClass: "permanent",
        },
      }),
    ).rejects.toThrow("Retry was not authorized");
    await expect(
      retry({
        proof: {
          ref: "evidence:unclassified",
          sideEffectOutcome: "not_started",
          errorClass: "other",
        },
      }),
    ).rejects.toThrow("Retry was not authorized");
    await expect(
      retry({
        proof: { ref: "evidence:applied", sideEffectOutcome: "not_applied", timedOut: true },
      }),
    ).resolves.toMatchObject({ status: "waiting" });
  } finally {
    await db.close();
  }
});

it("accepts a reviewed durable Step with a current matching grant and keeps Task acceptance separate", async () => {
  const db = await DomainDatabase.open(":memory:");
  try {
    const store = await fixture(db);
    await settleWorkerStep(store);
    for (const [action, id, overrides] of [
      ["task:rework", "accept-wrong-action", {}],
      ["task:accept", "accept-wrong-scope", { scope: "other" }],
      ["task:accept", "accept-wrong-principal", { principal: "other" }],
      ["task:accept", "accept-revoked", { revoked: true }],
    ] as const) {
      await addStepDecision(db, action, id, overrides);
      await expect(
        store.acceptDurableStep({
          taskId: "task-1",
          stepId: "worker",
          expectedStepVersion: 4,
          origin: { kind: "decision", decisionId: id, actorPrincipalId: "owner" },
        }),
      ).rejects.toThrow("Matching Step acceptance ALLOW decision is required");
    }

    await addStepDecision(db, "task:accept", "accept-step");
    const step = await store.acceptDurableStep({
      taskId: "task-1",
      stepId: "worker",
      expectedStepVersion: 4,
      origin: {
        kind: "decision",
        decisionId: "accept-step",
        actorPrincipalId: "owner",
      },
    });
    expect(step).toMatchObject({
      status: "succeeded",
      version: 5,
      outputRef: "artifact:worker-result",
    });
    expect((await store.listEvents("task-1")).map((event) => event.evidenceRef)).toContain(
      "trace:worker-result",
    );
    await db.transaction(async (tx) => {
      expect(
        (await tx.execute("SELECT status FROM task_attempts WHERE id = 'worker-attempt'")).rows[0]
          ?.status,
      ).toBe("succeeded");
      expect(
        (await tx.execute("SELECT status FROM tasks WHERE id = 'task-1'")).rows[0]?.status,
      ).toBe("RUNNING");
    });
    await expect(
      store.acceptDurableStep({
        taskId: "task-1",
        stepId: "worker",
        expectedStepVersion: 4,
        origin: { kind: "decision", decisionId: "accept-step", actorPrincipalId: "owner" },
      }),
    ).rejects.toThrow("Step acceptance conflict");
  } finally {
    await db.close();
  }
});

it("reworks a reviewed durable Step without replacing attempt or evidence and rejects unknown outcomes", async () => {
  const db = await DomainDatabase.open(":memory:");
  try {
    const store = await fixture(db);
    await settleWorkerStep(store, "review", 1);
    await addStepDecision(db, "task:rework", "rework-wrong-scope", { scope: "other" });
    await expect(
      store.reworkDurableStep({
        taskId: "task-1",
        stepId: "worker",
        expectedStepVersion: 4,
        reason: "Add the missing validation",
        origin: {
          kind: "decision",
          decisionId: "rework-wrong-scope",
          actorPrincipalId: "owner",
        },
      }),
    ).rejects.toThrow("Matching Step rework ALLOW decision is required");

    await addStepDecision(db, "task:rework", "rework-step");
    const ready = await store.reworkDurableStep({
      taskId: "task-1",
      stepId: "worker",
      expectedStepVersion: 4,
      reason: "Add the missing validation",
      origin: {
        kind: "decision",
        decisionId: "rework-step",
        actorPrincipalId: "owner",
      },
    });
    expect(ready).toMatchObject({ status: "ready", version: 5, outputRef: undefined });
    expect((await store.listEvents("task-1")).map((event) => event.evidenceRef)).toContain(
      "trace:worker-result",
    );
    expect((await store.listEvents("task-1")).at(-1)).toMatchObject({
      type: "TASK_REWORK",
      attemptId: "worker-attempt",
      metadata: { priorAttemptPreserved: true, status: "ready" },
    });
    expect(JSON.stringify((await store.listEvents("task-1")).at(-1)?.metadata)).not.toContain(
      "Add the missing validation",
    );
    await db.transaction(async (tx) => {
      expect(
        (
          await tx.execute(
            "SELECT id,status,rework_reason FROM task_attempts WHERE step_id = 'worker'",
          )
        ).rows,
      ).toEqual([
        expect.objectContaining({
          id: "worker-attempt",
          status: "review",
          rework_reason: "Add the missing validation",
        }),
      ]);
    });
    const nextClaim = await store.claimReadyStep({
      taskId: "task-1",
      stepId: "worker",
      expectedStepVersion: ready.version,
      attemptId: "worker-attempt-2",
      leaseId: "worker-lease-2",
      ownerInstanceId: "executor-1",
      leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      origin: claimOrigin,
    });
    expect(nextClaim).toMatchObject({
      step: { status: "running", version: 6 },
      attempt: { id: "worker-attempt-2", attemptNumber: 3, status: "running" },
      lease: { id: "worker-lease-2", state: "active" },
    });
    await db.transaction(async (tx) => {
      expect(
        (await tx.execute("SELECT rework_reason FROM task_attempts WHERE id = 'worker-attempt-2'"))
          .rows[0]?.rework_reason,
      ).toBe("Add the missing validation");
      await tx.execute(
        "UPDATE task_step_leases SET state = 'released' WHERE id = 'worker-lease-2'",
      );
      await tx.execute("UPDATE task_steps SET status = 'ready', version = 7 WHERE id = 'worker'");
    });
    await expect(
      store.claimReadyStep({
        taskId: "task-1",
        stepId: "worker",
        expectedStepVersion: 7,
        attemptId: "worker-attempt-3",
        leaseId: "worker-lease-3",
        ownerInstanceId: "executor-1",
        leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
        origin: claimOrigin,
      }),
    ).rejects.toThrow("Step attempt limit reached");
  } finally {
    await db.close();
  }
});

it("does not rework an unknown Step outcome while its lease is quarantined", async () => {
  const db = await DomainDatabase.open(":memory:");
  try {
    const store = await fixture(db);
    await settleWorkerStep(store, "unknown", 3);
    await addStepDecision(db, "task:rework", "rework-unknown");
    await expect(
      store.reworkDurableStep({
        taskId: "task-1",
        stepId: "worker",
        expectedStepVersion: 4,
        reason: "Retry it",
        origin: {
          kind: "decision",
          decisionId: "rework-unknown",
          actorPrincipalId: "owner",
        },
      }),
    ).rejects.toThrow("Step rework conflict");
    expect((await store.listSteps("task-1"))[0]).toMatchObject({ status: "blocked", version: 4 });
    expect(await store.getActiveLease("task-1", "worker")).toBeNull();
    await db.transaction(async (tx) => {
      expect(
        (await tx.execute("SELECT state FROM task_step_leases WHERE id = 'worker-lease'")).rows[0],
      ).toMatchObject({ state: "quarantined" });
      expect(
        (await tx.execute("SELECT status FROM task_attempts WHERE id = 'worker-attempt'")).rows[0],
      ).toMatchObject({ status: "waiting_input" });
    });
  } finally {
    await db.close();
  }
});

it("resets the full Step retry budget after rework even when the prior cycle used every attempt", async () => {
  const db = await DomainDatabase.open(":memory:");
  try {
    const store = await fixture(db);
    await store.createGraph(
      "task-1",
      [{ ...step("worker", [], "herdr_worker"), maxAttempts: 3 }],
      "worker",
      limits,
      system,
    );
    await db.transaction(async (tx) => {
      await tx.execute({
        sql: "UPDATE task_steps SET status = 'review', version = 4 WHERE id = 'worker'",
      });
      for (const [id, number, status] of [
        ["prior-attempt-1", 2, "failed"],
        ["prior-attempt-2", 3, "failed"],
        ["prior-attempt-3", 4, "review"],
      ] as const) {
        await tx.execute({
          sql: "INSERT INTO task_attempts(id,task_id,step_id,attempt_number,status,started_at,completed_at) VALUES (?,'task-1','worker',?,?,?,?)",
          args: [id, number, status, now, now],
        });
      }
    });
    await addStepDecision(db, "task:rework", "rework-full-budget");
    const ready = await store.reworkDurableStep({
      taskId: "task-1",
      stepId: "worker",
      expectedStepVersion: 4,
      reason: "Start a new reviewed cycle",
      origin: {
        kind: "decision",
        decisionId: "rework-full-budget",
        actorPrincipalId: "owner",
      },
    });
    const claim = await store.claimReadyStep({
      taskId: "task-1",
      stepId: "worker",
      expectedStepVersion: ready.version,
      attemptId: "new-cycle-attempt",
      leaseId: "new-cycle-lease",
      ownerInstanceId: "executor-1",
      leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      origin: claimOrigin,
    });
    expect(claim.attempt).toMatchObject({
      id: "new-cycle-attempt",
      attemptNumber: 5,
      status: "running",
    });
    expect((await store.listEvents("task-1")).at(-1)).toMatchObject({
      type: "STEP_STARTED",
      attemptId: "new-cycle-attempt",
    });
  } finally {
    await db.close();
  }
});

it("quarantines a lost worker lease and preserves unknown outcome", async () => {
  const db = await DomainDatabase.open(":memory:");
  try {
    const store = await fixture(db);
    await store.createGraph(
      "task-1",
      [step("worker", [], "herdr_worker")],
      "worker",
      limits,
      system,
    );
    await store.transitionStep({
      taskId: "task-1",
      stepId: "worker",
      expectedVersion: 1,
      from: "pending",
      to: "ready",
      origin: system,
    });
    await store.claimReadyStep({
      taskId: "task-1",
      stepId: "worker",
      expectedStepVersion: 2,
      attemptId: "lost-attempt",
      leaseId: "lost-lease",
      ownerInstanceId: "executor-1",
      leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      origin: claimOrigin,
    });
    const blocked = await store.settleClaimedStep({
      taskId: "task-1",
      stepId: "worker",
      attemptId: "lost-attempt",
      leaseId: "lost-lease",
      ownerInstanceId: "executor-1",
      expectedStepVersion: 3,
      expectedLeaseVersion: 1,
      outcome: "unknown",
      evidenceRef: "trace:worker-lost",
      origin: system,
    });
    expect(blocked.status).toBe("blocked");
    await db.transaction(async (tx) => {
      expect(
        (
          await tx.execute(
            "SELECT status,completed_at FROM task_attempts WHERE id = 'lost-attempt'",
          )
        ).rows[0],
      ).toMatchObject({ status: "waiting_input", completed_at: null });
      expect(
        (await tx.execute("SELECT state FROM task_step_leases WHERE id = 'lost-lease'")).rows[0]
          ?.state,
      ).toBe("quarantined");
    });
    expect((await store.listEvents("task-1")).slice(-2).map((event) => event.type)).toEqual([
      "WORKER_LOST",
      "STEP_BLOCKED",
    ]);
    await expect(
      store.updateLease({
        taskId: "task-1",
        leaseId: "lost-lease",
        ownerInstanceId: "executor-1",
        expectedVersion: 2,
        action: "release",
        origin: system,
      }),
    ).rejects.toThrow("Lease version conflict");
    await expect(
      store.transitionStep({
        taskId: "task-1",
        stepId: "worker",
        expectedVersion: 4,
        from: "blocked",
        to: "ready",
        origin: system,
      }),
    ).rejects.toThrow("requires reconciliation");
    expect((await store.listSteps("task-1"))[0]?.status).toBe("blocked");
  } finally {
    await db.close();
  }
});
