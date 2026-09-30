import type { TaskStep } from "@glassbox/contracts";
import { describe, expect, it } from "vitest";
import {
  computeTaskGraphProgress,
  TaskGraphError,
  validateTaskGraph,
  type TaskGraphLimits,
} from "./task-graph.js";

const limits: TaskGraphLimits = {
  maxSteps: 12,
  maxDependenciesPerStep: 4,
  maxFanOut: 3,
  maxReadySteps: 4,
  maxParallelSteps: 2,
};

function step(id: string, dependencyIds: string[] = [], changes: Partial<TaskStep> = {}): TaskStep {
  return {
    id,
    taskId: "task-1",
    kind: "model",
    title: id,
    status: "pending",
    dependencyIds,
    dependencyPolicy: { failed: "block", cancelled: "cancel", skipped: "skip" },
    maxAttempts: 1,
    requiredCapabilities: [],
    delegatedPermissionSet: [],
    createdAt: "2026-09-27T00:00:00Z",
    updatedAt: "2026-09-27T00:00:00Z",
    version: 1,
    ...changes,
  };
}

function expectGraphError(action: () => unknown, code: TaskGraphError["code"]): void {
  try {
    action();
    throw new Error("Expected TaskGraphError");
  } catch (error) {
    expect(error).toBeInstanceOf(TaskGraphError);
    expect((error as TaskGraphError).code).toBe(code);
  }
}

describe("task dependency graph", () => {
  it("makes a linear successor ready only after its predecessor succeeds", () => {
    const graph = [step("c", ["b"]), step("a", [], { status: "succeeded" }), step("b", ["a"])];
    expect(validateTaskGraph(graph, limits).topologicalStepIds).toEqual(["a", "b", "c"]);
    expect(computeTaskGraphProgress(graph, limits).readyStepIds).toEqual(["b"]);
    expect(computeTaskGraphProgress(graph, limits).transitions).toEqual([
      { stepId: "b", status: "ready", reason: "dependencies_satisfied" },
    ]);
    expect(
      computeTaskGraphProgress(
        [graph[0]!, graph[1]!, step("b", ["a"], { status: "succeeded" })],
        limits,
      ).readyStepIds,
    ).toEqual(["c"]);
  });

  it("keeps a join behind both branches and orders ready branches deterministically", () => {
    const graph = [
      step("d", ["c", "b"]),
      step("c", ["a"]),
      step("b", ["a"]),
      step("a", [], { status: "succeeded" }),
    ];
    const result = computeTaskGraphProgress(graph, limits);
    expect(result.topologicalStepIds).toEqual(["a", "b", "c", "d"]);
    expect(result.readyStepIds).toEqual(["b", "c"]);
    expect(result.runnableStepIds).toEqual(["b", "c"]);
    expect(computeTaskGraphProgress([...graph].reverse(), limits)).toEqual(result);
    expect(
      computeTaskGraphProgress(
        [
          step("d", ["b", "c"]),
          step("b", ["a"], { status: "succeeded" }),
          step("c", ["a"], { status: "running" }),
          graph[3]!,
        ],
        limits,
      ).readyStepIds,
    ).toEqual([]);
  });

  it("rejects cycles, missing nodes, duplicate edges, cross-task nodes and arbitrary kinds", () => {
    expectGraphError(
      () => validateTaskGraph([step("a", ["b"]), step("b", ["a"])], limits),
      "CYCLE",
    );
    expectGraphError(
      () => validateTaskGraph([step("a", ["missing"])], limits),
      "MISSING_DEPENDENCY",
    );
    expectGraphError(
      () => validateTaskGraph([step("a"), step("b", ["a", "a"])], limits),
      "DUPLICATE_DEPENDENCY",
    );
    expectGraphError(
      () => validateTaskGraph([step("a"), step("b", [], { taskId: "task-2" })], limits),
      "INVALID_STEP",
    );
    expectGraphError(
      () =>
        validateTaskGraph([step("a", [], { kind: "arbitrary_shell" as TaskStep["kind"] })], limits),
      "INVALID_STEP",
    );
  });

  it("enforces graph size, fan-out and dependency bounds", () => {
    expectGraphError(
      () => validateTaskGraph([step("a"), step("b")], { ...limits, maxSteps: 1 }),
      "STEP_LIMIT",
    );
    expectGraphError(
      () =>
        validateTaskGraph([step("a"), step("b", ["a"]), step("c", ["a"])], {
          ...limits,
          maxFanOut: 1,
        }),
      "FAN_OUT_LIMIT",
    );
    expectGraphError(
      () =>
        validateTaskGraph([step("a"), step("b"), step("c", ["a", "b"])], {
          ...limits,
          maxDependenciesPerStep: 1,
        }),
      "DEPENDENCY_LIMIT",
    );
  });

  it("applies explicit failure, cancellation and skip policies through descendants", () => {
    const result = computeTaskGraphProgress(
      [
        step("a", [], { status: "failed" }),
        step("b", ["a"], {
          dependencyPolicy: { failed: "skip", cancelled: "cancel", skipped: "skip" },
        }),
        step("c", ["b"]),
      ],
      limits,
    );
    expect(result.transitions).toEqual([
      { stepId: "b", status: "skipped", reason: "dependency_failed" },
      { stepId: "c", status: "skipped", reason: "dependency_skipped" },
    ]);
    const cancelled = computeTaskGraphProgress(
      [step("a", [], { status: "cancelled" }), step("b", ["a"])],
      limits,
    );
    expect(cancelled.transitions).toEqual([
      { stepId: "b", status: "cancelled", reason: "dependency_cancelled" },
    ]);
    const blocked = computeTaskGraphProgress(
      [step("a", [], { status: "failed" }), step("b", ["a"])],
      limits,
    );
    expect(blocked.transitions).toEqual([
      { stepId: "b", status: "blocked", reason: "dependency_failed" },
    ]);
  });

  it("allows an explicit continue policy only after every join dependency settles", () => {
    const join = step("join", ["a", "b"], {
      kind: "join",
      dependencyPolicy: { failed: "continue", cancelled: "block", skipped: "block" },
    });
    expect(
      computeTaskGraphProgress(
        [step("a", [], { status: "failed" }), step("b", [], { status: "running" }), join],
        limits,
      ).readyStepIds,
    ).toEqual([]);
    expect(
      computeTaskGraphProgress(
        [step("a", [], { status: "failed" }), step("b", [], { status: "succeeded" }), join],
        limits,
      ).readyStepIds,
    ).toEqual(["join"]);
  });

  it("does not dispatch a stale ready step after dependency cancellation or rework", () => {
    const cancelled = computeTaskGraphProgress(
      [step("a", [], { status: "cancelled" }), step("b", ["a"], { status: "ready" })],
      limits,
    );
    expect(cancelled.runnableStepIds).toEqual([]);
    expect(cancelled.transitions).toEqual([
      { stepId: "b", status: "cancelled", reason: "dependency_cancelled" },
    ]);
    const reworked = computeTaskGraphProgress(
      [step("a", [], { status: "running" }), step("b", ["a"], { status: "ready" })],
      limits,
    );
    expect(reworked.runnableStepIds).toEqual([]);
  });

  it("caps ready queue and running slots without dropping eligible work", () => {
    const graph = [step("a"), step("b"), step("c"), step("d", [], { status: "running" })];
    const result = computeTaskGraphProgress(graph, {
      ...limits,
      maxReadySteps: 2,
      maxParallelSteps: 2,
    });
    expect(result.readyStepIds).toEqual(["a", "b"]);
    expect(result.runnableStepIds).toEqual(["a"]);
    expect(result.deferredReadyStepIds).toEqual(["c"]);
    expectGraphError(
      () =>
        computeTaskGraphProgress(
          [step("a", [], { status: "ready" }), step("b", [], { status: "ready" })],
          { ...limits, maxReadySteps: 1 },
        ),
      "READY_LIMIT",
    );
  });
});
