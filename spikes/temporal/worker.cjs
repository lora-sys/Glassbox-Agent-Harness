const { NativeConnection, Worker } = require("@temporalio/worker");
const { activityInfo } = require("@temporalio/activity");

async function main() {
  const connection = await NativeConnection.connect({
    address: process.env.TEMPORAL_ADDRESS || "localhost:7233",
  });
  const worker = await Worker.create({
    connection,
    namespace: "default",
    taskQueue: "glassbox-p6-spike",
    workflowsPath: require.resolve("./workflows.cjs"),
    activities: {
      async flakyActivity(taskId) {
        const attempt = activityInfo().attempt;
        console.log(JSON.stringify({ event: "activity", taskId, attempt }));
        if (attempt === 1) throw new Error("intentional first attempt failure");
        return { taskId, attempt };
      },
    },
  });
  console.log("worker ready");
  await worker.run();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
