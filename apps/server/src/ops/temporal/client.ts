import { Client, Connection, WorkflowNotFoundError } from "@temporalio/client";
import {
  LONG_WORK_TASK_QUEUE,
  LONG_WORK_WAKE_SIGNAL,
  LONG_WORK_WORKFLOW_TYPE,
  longWorkWorkflowId,
  type LongWorkWorkflowInput,
} from "./contracts.js";

export interface LongWorkWorkflowClientPort {
  start(input: {
    workflowType: string;
    workflowId: string;
    taskQueue: string;
    args: [LongWorkWorkflowInput];
  }): Promise<{ workflowId: string; runId?: string }>;
  wake(workflowId: string): Promise<void>;
  cancel(workflowId: string): Promise<void>;
  inspect(workflowId: string): Promise<{ runId: string; running: boolean } | null>;
}

/** Fresh bounded RPC, distinct from Connection.ensureConnected's memoized startup check. */
export async function probeTemporalServer(
  connection: Pick<Connection, "withDeadline" | "workflowService">,
): Promise<"reachable" | "unavailable"> {
  try {
    await connection.withDeadline(Date.now() + 2_000, () =>
      connection.workflowService.getSystemInfo({}),
    );
    return "reachable";
  } catch {
    return "unavailable";
  }
}

export function createLongWorkWorkflowClient(
  port: LongWorkWorkflowClientPort,
  taskQueue = LONG_WORK_TASK_QUEUE,
) {
  return {
    start(input: LongWorkWorkflowInput) {
      return port.start({
        workflowType: LONG_WORK_WORKFLOW_TYPE,
        workflowId: longWorkWorkflowId(input.taskId),
        taskQueue,
        args: [input],
      });
    },
    wake(taskId: string) {
      return port.wake(longWorkWorkflowId(taskId));
    },
    cancel(taskId: string) {
      return port.cancel(longWorkWorkflowId(taskId));
    },
    inspect(taskId: string) {
      return port.inspect(longWorkWorkflowId(taskId));
    },
  };
}

export async function connectLongWorkWorkflowClient(options: {
  address: string;
  namespace?: string;
  taskQueue?: string;
}) {
  const connection = await Connection.connect({ address: options.address });
  const client = new Client({ connection, namespace: options.namespace });
  const workflows = createLongWorkWorkflowClient(
    {
      async start(input) {
        const handle = await client.workflow.start(input.workflowType, {
          workflowId: input.workflowId,
          taskQueue: input.taskQueue,
          args: input.args,
        });
        return {
          workflowId: handle.workflowId,
          runId: handle.firstExecutionRunId,
        };
      },
      async wake(workflowId) {
        await client.workflow.getHandle(workflowId).signal(LONG_WORK_WAKE_SIGNAL);
      },
      async cancel(workflowId) {
        await client.workflow.getHandle(workflowId).cancel();
      },
      async inspect(workflowId) {
        try {
          const observed = await client.workflow.getHandle(workflowId).describe();
          return { runId: observed.runId, running: observed.status.name === "RUNNING" };
        } catch (error) {
          if (error instanceof WorkflowNotFoundError) return null;
          throw error;
        }
      },
    },
    options.taskQueue,
  );
  return {
    workflows,
    probe: () => probeTemporalServer(connection),
    close: () => connection.close(),
  };
}
