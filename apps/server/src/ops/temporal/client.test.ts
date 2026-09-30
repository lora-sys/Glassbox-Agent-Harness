import { describe, expect, it, vi } from "vitest";
import {
  createContinuationWorkflowClient,
  createLongWorkWorkflowClient,
  probeTemporalServer,
} from "./client.js";
import { continuationWorkflowId, longWorkWorkflowId } from "./contracts.js";

describe("long work Temporal client", () => {
  it("starts with only Task ID and policy revision, and addresses wake and cancel by stable ID", async () => {
    const port = {
      start: vi.fn(async ({ workflowId }: { workflowId: string }) => ({ workflowId })),
      wake: vi.fn(async (_workflowId: string) => {}),
      cancel: vi.fn(async (_workflowId: string) => {}),
      inspect: vi.fn(async (_workflowId: string) => ({ runId: "run-1", running: true })),
    };
    const client = createLongWorkWorkflowClient(port, "test-queue");
    const input = { taskId: "task-123", policyRevision: 7 };

    await expect(client.start(input)).resolves.toEqual({
      workflowId: "glassbox-long-work:task-123",
    });
    expect(port.start).toHaveBeenCalledWith({
      workflowType: "longWorkWorkflow",
      workflowId: longWorkWorkflowId(input.taskId),
      taskQueue: "test-queue",
      args: [input],
    });
    await client.wake(input.taskId);
    await client.cancel(input.taskId);
    await expect(client.inspect(input.taskId)).resolves.toEqual({ runId: "run-1", running: true });
    expect(port.wake).toHaveBeenCalledWith(longWorkWorkflowId(input.taskId));
    expect(port.cancel).toHaveBeenCalledWith(longWorkWorkflowId(input.taskId));
    expect(port.inspect).toHaveBeenCalledWith(longWorkWorkflowId(input.taskId));
  });
});

it("addresses a continuation by stable schedule ID across wake and cancellation", async () => {
  const port = {
    start: vi.fn(async ({ workflowId }: { workflowId: string }) => ({ workflowId })),
    wake: vi.fn(async (_workflowId: string) => {}),
    cancel: vi.fn(async (_workflowId: string) => {}),
    inspect: vi.fn(async (_workflowId: string) => ({ runId: "run-1", running: true })),
  };
  const client = createContinuationWorkflowClient(port);
  const input = { scheduleId: "schedule-123" };
  await client.start(input);
  expect(port.start).toHaveBeenCalledWith({
    workflowType: "continuationWorkflow",
    workflowId: continuationWorkflowId(input.scheduleId),
    taskQueue: "glassbox-long-work",
    args: [input],
  });
  await client.wake(input.scheduleId);
  await client.cancel(input.scheduleId);
  expect(port.wake).toHaveBeenCalledWith(continuationWorkflowId(input.scheduleId));
  expect(port.cancel).toHaveBeenCalledWith(continuationWorkflowId(input.scheduleId));
});

it("probes Temporal with a fresh bounded RPC and reports failure without raw errors", async () => {
  const getSystemInfo = vi.fn(async () => ({}));
  const withDeadline = vi.fn(async (_deadline: number, call: () => Promise<unknown>) => call());
  const connection = {
    withDeadline,
    workflowService: { getSystemInfo },
  } as unknown as Parameters<typeof probeTemporalServer>[0];
  const startedAt = Date.now();
  expect(await probeTemporalServer(connection)).toBe("reachable");
  expect(await probeTemporalServer(connection)).toBe("reachable");
  expect(getSystemInfo).toHaveBeenCalledTimes(2);
  expect(withDeadline.mock.calls[0]?.[0]).toBeGreaterThanOrEqual(startedAt);
  expect(withDeadline.mock.calls[0]?.[0]).toBeLessThanOrEqual(startedAt + 2_000);

  getSystemInfo.mockRejectedValueOnce(new Error("private Temporal address"));
  expect(await probeTemporalServer(connection)).toBe("unavailable");
});
