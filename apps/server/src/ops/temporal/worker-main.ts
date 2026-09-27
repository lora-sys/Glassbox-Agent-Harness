import { join } from "node:path";
import { openDomainStore } from "../../application/domain-store.js";
import { loadAgentOperations } from "../../config/agent-operations.js";
import { getGlassboxDataDir } from "../../platform/paths.js";
import { WorkspaceRegistry } from "../../workspace/registry.js";
import { WorkspaceWriteOccupancy } from "../../workspace/write-occupancy.js";
import { AuthorizedOpsService } from "../service.js";
import { createAdvanceLongWorkActivity } from "./activity.js";
import { connectLongWorkWorkflowClient } from "./client.js";
import { HerdrWorkerRuntime } from "./herdr-worker-runtime.js";
import { startLongWorkWorker } from "./worker.js";

async function main(): Promise<void> {
  const address = process.env.GLASSBOX_TEMPORAL_ADDRESS;
  if (!address) throw new Error("GLASSBOX_TEMPORAL_ADDRESS is required");
  const dataDirectory = getGlassboxDataDir();
  const databasePath = join(dataDirectory, "glassbox.db");
  const store = await openDomainStore({ databasePath });
  let wakeClient: Awaited<ReturnType<typeof connectLongWorkWorkflowClient>> | undefined;
  try {
    const operations = await loadAgentOperations(dataDirectory, databasePath);
    const workers =
      operations?.workerPolicy && operations.workerTarget.agentKind === "pi"
        ? new HerdrWorkerRuntime(
            store,
            new AuthorizedOpsService(store, operations.bridge, operations.workerPolicy, undefined, {
              registry: await WorkspaceRegistry.open({ dataRoot: dataDirectory }),
              writes: new WorkspaceWriteOccupancy(dataDirectory, "participant"),
            }),
            operations.bridge,
            operations.workerTarget,
          )
        : undefined;
    const connectedWakeClient = await connectLongWorkWorkflowClient({
      address,
      namespace: process.env.GLASSBOX_TEMPORAL_NAMESPACE ?? "default",
    });
    wakeClient = connectedWakeClient;
    const worker = await startLongWorkWorker({
      address,
      namespace: process.env.GLASSBOX_TEMPORAL_NAMESPACE ?? "default",
      advanceLongWork: createAdvanceLongWorkActivity(store, workers, (taskId) =>
        connectedWakeClient.workflows.wake(taskId),
      ),
    });
    let shutdown: Promise<void> | undefined;
    const stop = () => {
      shutdown ??= worker.shutdown();
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    try {
      await worker.run;
    } finally {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      await (shutdown ?? worker.shutdown());
    }
  } finally {
    await wakeClient?.close();
    await store.close();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
