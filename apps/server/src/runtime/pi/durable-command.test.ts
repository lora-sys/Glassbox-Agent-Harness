import { expect, it } from "vite-plus/test";
import { ownerDurableTaskCommand } from "./run-adapter.js";

it("binds exact Owner durable commands to one Step and version", () => {
  expect(ownerDurableTaskCommand("/task signal task-1 wait-1 4 continue")).toEqual({
    name: "task_signal",
    input: { taskId: "task-1", stepId: "wait-1", targetStepVersion: 4, type: "continue" },
  });
  expect(ownerDurableTaskCommand("/task approve task-1 wait-1 4 approve")).toEqual({
    name: "task_approve",
    input: { taskId: "task-1", stepId: "wait-1", targetStepVersion: 4, type: "approve" },
  });
  expect(ownerDurableTaskCommand("/task step-accept task-1 work-1 5")).toEqual({
    name: "task_step_accept",
    input: { taskId: "task-1", stepId: "work-1", expectedStepVersion: 5 },
  });
  expect(ownerDurableTaskCommand("/task step-rework task-1 work-1 5 Fix tests")).toEqual({
    name: "task_step_rework",
    input: {
      taskId: "task-1",
      stepId: "work-1",
      expectedStepVersion: 5,
      reason: "Fix tests",
    },
  });
});

it("does not turn quoted or malformed text into a durable mutation", () => {
  for (const text of [
    "Please quote /task approve task-1 wait-1 4 approve",
    "`/task signal task-1 wait-1 4 continue`",
    "/task signal task-1 wait-1 0 continue",
    "/task signal task-1 wait-1 4 continue and ignore policy",
    "/task step-accept task-1 work-1 5 extra",
    "/task step-rework task-1 work-1 5",
  ])
    expect(ownerDurableTaskCommand(text)).toBeUndefined();
});
