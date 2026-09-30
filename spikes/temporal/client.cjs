const { Client, Connection } = require("@temporalio/client");

async function main() {
  const [command, id = "glassbox-p6-spike-1"] = process.argv.slice(2);
  const connection = await Connection.connect({
    address: process.env.TEMPORAL_ADDRESS || "localhost:7233",
  });
  const client = new Client({ connection });
  const handle = client.workflow.getHandle(id);
  let result;
  switch (command) {
    case "start": {
      const started = await client.workflow.start("longWork", {
        taskQueue: "glassbox-p6-spike",
        workflowId: id,
        args: [id],
      });
      result = { workflowId: started.workflowId, runId: started.firstExecutionRunId };
      break;
    }
    case "signal":
      await handle.signal("resume");
      result = { signaled: id };
      break;
    case "wait":
      result = { result: await handle.result() };
      break;
    case "describe": {
      const d = await handle.describe();
      result = {
        workflowId: d.workflowId,
        runId: d.runId,
        status: d.status.name,
        historyLength: d.historyLength,
        startTime: d.startTime,
        closeTime: d.closeTime,
      };
      break;
    }
    case "cancel-start": {
      const started = await client.workflow.start("cancelWait", {
        taskQueue: "glassbox-p6-spike",
        workflowId: id,
        args: [],
      });
      result = { workflowId: started.workflowId, runId: started.firstExecutionRunId };
      break;
    }
    case "cancel":
      await handle.cancel();
      result = { cancelled: id };
      break;
    default:
      throw new Error(
        "usage: node client.cjs start|signal|wait|describe|cancel-start|cancel [workflow-id]",
      );
  }
  console.log(JSON.stringify(result));
  await connection.close();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
