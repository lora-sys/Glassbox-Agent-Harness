import { beforeEach, expect, it, vi } from "vite-plus/test";
import { LONG_WORK_CONTINUE_AFTER_ITERATIONS } from "./contracts.js";

const temporal = vi.hoisted(() => ({
  advance: vi.fn(),
  continueAsNew: vi.fn(),
  condition: vi.fn(),
  setHandler: vi.fn(),
}));

vi.mock("@temporalio/workflow", () => ({
  defineSignal: (name: string) => name,
  proxyActivities: () => ({ advanceLongWork: temporal.advance }),
  continueAsNew: temporal.continueAsNew,
  condition: temporal.condition,
  setHandler: temporal.setHandler,
}));

import { longWorkWorkflow } from "./workflow.js";

beforeEach(() => {
  vi.clearAllMocks();
});

it("passes the same Task identity and policy revision through bounded rollover", async () => {
  const input = { taskId: "durable-task", policyRevision: 3 };
  let advances = 0;
  temporal.advance.mockImplementation(async () => {
    advances += 1;
    if (advances < LONG_WORK_CONTINUE_AFTER_ITERATIONS) return { kind: "continue" };
    if (advances === LONG_WORK_CONTINUE_AFTER_ITERATIONS)
      return { kind: "wait", wakeAt: "2030-01-01T00:00:00.000Z" };
    return { kind: "complete" };
  });
  temporal.continueAsNew.mockImplementation((continuedInput: typeof input) =>
    longWorkWorkflow(continuedInput),
  );

  await longWorkWorkflow(input);

  expect(temporal.continueAsNew).toHaveBeenCalledExactlyOnceWith(input);
  expect(temporal.advance).toHaveBeenCalledTimes(LONG_WORK_CONTINUE_AFTER_ITERATIONS + 1);
  expect(temporal.advance.mock.calls.every(([activityInput]) => activityInput === input)).toBe(
    true,
  );
  // The next Workflow invocation calls the Activity before scheduling a wait.
  // The Activity loads current wait state from Glassbox persistence.
  expect(temporal.condition).not.toHaveBeenCalled();
});
