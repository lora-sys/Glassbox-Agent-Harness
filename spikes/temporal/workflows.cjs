const {
  defineSignal,
  setHandler,
  condition,
  sleep,
  proxyActivities,
  executeChild,
  continueAsNew,
} = require("@temporalio/workflow");

const resume = defineSignal("resume");
const { flakyActivity } = proxyActivities({
  startToCloseTimeout: "10s",
  retry: {
    maximumAttempts: 3,
    initialInterval: "1s",
    backoffCoefficient: 1,
  },
});

async function childWork(taskId) {
  return `child:${taskId}`;
}

async function longWork(taskId, generation = 0, prior = null) {
  if (generation === 1) return { taskId, generation, prior };

  let received = false;
  setHandler(resume, () => {
    received = true;
  });
  await sleep("8s");
  await condition(() => received);
  const activity = await flakyActivity(taskId);
  const child = await executeChild(childWork, { args: [taskId], workflowId: `${taskId}-child` });
  return continueAsNew(taskId, 1, { activity, child });
}

async function cancelWait() {
  await sleep("1h");
  return "unexpected completion";
}

module.exports = { longWork, childWork, cancelWait };
