import test from "node:test";
import assert from "node:assert/strict";
import { waitForTaskWorkerCompletion } from "../lib/task-worker-completion.mjs";
const taskId = "11111111-1111-4111-8111-111111111111",
  attemptId = "22222222-2222-4222-8222-222222222222",
  bindingId = "33333333-3333-4333-8333-333333333333";
const runtime = { pid: 1 };
const input = {
  config: { taskWorkerFixtures: { timeoutMs: 1000 } },
  taskId,
  attemptId,
  bindingId,
  expectedRuntime: runtime,
};
const row = {
  taskId,
  attemptId,
  bindingId,
  taskStatus: "RUNNING",
  attemptStatus: "running",
  workerState: "working",
};
test("completion waits for the exact existing binding state without starting a Worker", async () => {
  let reads = 0,
    clock = 0;
  const result = await waitForTaskWorkerCompletion(input, {
    readRuntime: () => runtime,
    readState: () => [
      ++reads === 1
        ? row
        : { ...row, taskStatus: "REVIEW", attemptStatus: "review", workerState: "done" },
    ],
    now: () => clock,
    pause: async (ms) => {
      clock += ms;
    },
  });
  assert.equal(result.terminalObserved, true);
  assert.equal(reads, 2);
});
test("completion stops on binding drift, terminal failure, abort, or timeout", async () => {
  for (const changed of [
    { ...row, bindingId: "other" },
    { ...row, taskStatus: "FAILED" },
  ])
    await assert.rejects(
      waitForTaskWorkerCompletion(input, {
        readRuntime: () => runtime,
        readState: () => [changed],
      }),
    );
  let clock = 0;
  await assert.rejects(
    waitForTaskWorkerCompletion(input, {
      readRuntime: () => runtime,
      readState: () => [row],
      now: () => clock,
      pause: async (ms) => {
        clock += ms;
      },
    }),
    { code: "TASK_WORKER_COMPLETION_TIMEOUT" },
  );
  await assert.rejects(
    waitForTaskWorkerCompletion(
      { ...input, signal: AbortSignal.abort() },
      { readRuntime: () => runtime, readState: () => [row] },
    ),
    { code: "TASK_WORKER_ABORTED" },
  );
});
