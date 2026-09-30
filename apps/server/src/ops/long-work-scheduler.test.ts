import { expect, it } from "vite-plus/test";
import type { TaskStep } from "@glassbox/contracts";
import { DomainDatabase } from "../persistence/database.js";
import { LongWorkScheduler } from "./long-work-scheduler.js";
import { LongWorkStore } from "./long-work-store.js";

const now = "2026-09-27T00:00:00.000Z";
const origin = { kind: "system", reason: "deterministic scheduler" } as const;
const limits = {
  maxSteps: 8,
  maxDependenciesPerStep: 4,
  maxFanOut: 4,
  maxReadySteps: 4,
  maxParallelSteps: 2,
};

function step(
  id: string,
  dependencyIds: string[] = [],
  policy: TaskStep["dependencyPolicy"] = { failed: "block", cancelled: "cancel", skipped: "skip" },
  kind: TaskStep["kind"] = "tool",
): TaskStep {
  return {
    id,
    taskId: "task-1",
    kind,
    ...(kind === "tool" ? { specRef: "tool:task_get:task-1" } : {}),
    title: id,
    status: "pending",
    dependencyIds,
    dependencyPolicy: policy,
    maxAttempts: 1,
    requiredCapabilities: [],
    delegatedPermissionSet: [],
    version: 1,
    createdAt: now,
    updatedAt: now,
  };
}

async function fixture(steps: TaskStep[]) {
  const db = await DomainDatabase.open(":memory:");
  await db.transaction(async (tx) => {
    await tx.execute({
      sql: "INSERT INTO principals(id,kind,created_at) VALUES (?,?,?)",
      args: ["owner", "owner", now],
    });
    await tx.execute({
      sql: "INSERT INTO tasks(id,title,status,priority,creator_principal_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?)",
      args: ["task-1", "Scheduler test", "NEW", "normal", "owner", now, now],
    });
  });
  const store = new LongWorkStore(db);
  await store.createGraph("task-1", steps, steps[0]!.id, limits, origin);
  return { db, store, scheduler: new LongWorkScheduler(store, limits) };
}

it("promotes ready Steps in graph order and bounds runnable parallel work", async () => {
  const { db, store, scheduler } = await fixture([step("a"), step("b"), step("c")]);
  try {
    const result = await scheduler.advance("task-1", origin);
    expect(result.readyStepIds).toEqual(["a", "b", "c"]);
    expect(result.runnableStepIds).toEqual(["a", "b"]);
    expect(result.deferredReadyStepIds).toEqual([]);
    expect((await store.listSteps("task-1")).map(({ id, status }) => [id, status])).toEqual([
      ["a", "ready"],
      ["b", "ready"],
      ["c", "ready"],
    ]);
    expect((await store.listEvents("task-1")).map((event) => event.type)).toEqual([
      "STEP_ADDED",
      "STEP_ADDED",
      "STEP_ADDED",
      "STEP_READY",
      "STEP_READY",
      "STEP_READY",
    ]);
  } finally {
    await db.close();
  }
});

it("propagates block policy through dependent Steps and barriers", async () => {
  const graph = [
    step("a"),
    step("blocked", ["a"]),
    step("also-blocked", ["blocked"]),
    step("join", ["also-blocked"], undefined, "join"),
    step("after-join", ["join"]),
  ];
  const { db, store, scheduler } = await fixture(graph);
  try {
    await scheduler.advance("task-1", origin);
    await store.transitionStep({
      taskId: "task-1",
      stepId: "a",
      expectedVersion: 2,
      from: "ready",
      to: "running",
      origin,
    });
    await store.transitionStep({
      taskId: "task-1",
      stepId: "a",
      expectedVersion: 3,
      from: "running",
      to: "failed",
      origin,
    });

    const result = await scheduler.advance("task-1", origin);
    expect(
      Object.fromEntries((await store.listSteps("task-1")).map(({ id, status }) => [id, status])),
    ).toEqual({
      a: "failed",
      blocked: "blocked",
      "also-blocked": "blocked",
      join: "blocked",
      "after-join": "blocked",
    });
    expect(result.readyStepIds).toEqual([]);
    expect(result.runnableStepIds).toEqual([]);
    expect((await store.listEvents("task-1")).map((event) => event.type)).toContain("STEP_BLOCKED");
  } finally {
    await db.close();
  }
});

it("propagates skip and cancel dependency policies", async () => {
  const graph = [
    step("root"),
    step("skip-child", ["root"], { failed: "skip", cancelled: "continue", skipped: "continue" }),
    step("cancel-child", ["root"], {
      failed: "cancel",
      cancelled: "continue",
      skipped: "continue",
    }),
    step("skip-descendant", ["cancel-child"], {
      failed: "continue",
      cancelled: "skip",
      skipped: "continue",
    }),
  ];
  const { db, store, scheduler } = await fixture(graph);
  try {
    await scheduler.advance("task-1", origin);
    await store.transitionStep({
      taskId: "task-1",
      stepId: "root",
      expectedVersion: 2,
      from: "ready",
      to: "running",
      origin,
    });
    await store.transitionStep({
      taskId: "task-1",
      stepId: "root",
      expectedVersion: 3,
      from: "running",
      to: "failed",
      origin,
    });

    await scheduler.advance("task-1", origin);
    expect(
      Object.fromEntries((await store.listSteps("task-1")).map(({ id, status }) => [id, status])),
    ).toMatchObject({
      root: "failed",
      "skip-child": "skipped",
      "cancel-child": "cancelled",
      "skip-descendant": "skipped",
    });
  } finally {
    await db.close();
  }
});

it("auto-completes a successful barrier without marking the Task complete", async () => {
  const graph = [step("a"), step("join", ["a"], undefined, "join"), step("next", ["join"])];
  const { db, store, scheduler } = await fixture(graph);
  try {
    await scheduler.advance("task-1", origin);
    await store.transitionStep({
      taskId: "task-1",
      stepId: "a",
      expectedVersion: 2,
      from: "ready",
      to: "running",
      origin,
    });
    await store.transitionStep({
      taskId: "task-1",
      stepId: "a",
      expectedVersion: 3,
      from: "running",
      to: "succeeded",
      origin,
    });

    const result = await scheduler.advance("task-1", origin);
    expect((await store.listSteps("task-1")).map(({ id, status }) => [id, status])).toEqual([
      ["a", "succeeded"],
      ["join", "succeeded"],
      ["next", "ready"],
    ]);
    expect(result.runnableStepIds).toEqual(["next"]);
    await db.transaction(async (tx) => {
      expect(
        (await tx.execute("SELECT status FROM tasks WHERE id = 'task-1'")).rows[0]?.status,
      ).toBe("NEW");
    });
    const events = await store.listEvents("task-1");
    expect(events.filter((event) => event.stepId === "join").map((event) => event.type)).toEqual([
      "STEP_ADDED",
      "STEP_READY",
      "STEP_STARTED",
      "STEP_SUCCEEDED",
    ]);
  } finally {
    await db.close();
  }
});
