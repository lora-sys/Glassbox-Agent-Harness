import { describe, expect, it, vi } from "vitest";
import { createLongWorkWorkflowClient } from "./client.js";
import { longWorkWorkflowId } from "./contracts.js";

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
