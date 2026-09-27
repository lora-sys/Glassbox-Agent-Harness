import { NativeConnection, Worker } from "@temporalio/worker";
import { fileURLToPath } from "node:url";
import type { AdvanceContinuationActivity, AdvanceLongWorkActivity } from "./contracts.js";
import { LONG_WORK_TASK_QUEUE } from "./contracts.js";

export interface LongWorkWorkerOptions {
  address: string;
  namespace?: string;
  taskQueue?: string;
  advanceLongWork: AdvanceLongWorkActivity;
  advanceContinuation: AdvanceContinuationActivity;
}

/** Starts a worker for the durable coordinator. Activities must be idempotent. */
export async function startLongWorkWorker(options: LongWorkWorkerOptions) {
  const connection = await NativeConnection.connect({ address: options.address });
  const worker = await Worker.create({
    connection,
    namespace: options.namespace,
    taskQueue: options.taskQueue ?? LONG_WORK_TASK_QUEUE,
    workflowsPath: fileURLToPath(new URL("./workflow.ts", import.meta.url)),
    activities: {
      advanceLongWork: options.advanceLongWork,
      advanceContinuation: options.advanceContinuation,
    },
  });

  const run = worker.run();
  return {
    worker,
    run,
    shutdown: async () => {
      worker.shutdown();
      await run;
      await connection.close();
    },
  };
}
