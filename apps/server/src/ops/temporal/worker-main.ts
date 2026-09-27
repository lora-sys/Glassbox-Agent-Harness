import { join } from "node:path";
import { openDomainStore } from "../../application/domain-store.js";
import { getGlassboxDataDir } from "../../platform/paths.js";
import { createAdvanceLongWorkActivity } from "./activity.js";
import { startLongWorkWorker } from "./worker.js";

async function main(): Promise<void> {
  const address = process.env.GLASSBOX_TEMPORAL_ADDRESS;
  if (!address) throw new Error("GLASSBOX_TEMPORAL_ADDRESS is required");
  const store = await openDomainStore({
    databasePath: join(getGlassboxDataDir(), "glassbox.db"),
  });
  try {
    const worker = await startLongWorkWorker({
      address,
      namespace: process.env.GLASSBOX_TEMPORAL_NAMESPACE ?? "default",
      advanceLongWork: createAdvanceLongWorkActivity(store),
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
    await store.close();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
