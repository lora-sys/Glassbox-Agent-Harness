import {
  condition,
  continueAsNew,
  defineSignal,
  proxyActivities,
  setHandler,
} from "@temporalio/workflow";
import type {
  AdvanceContinuationActivity,
  AdvanceLongWorkActivity,
  ContinuationWorkflowInput,
  LongWorkWorkflowInput,
} from "./contracts.js";
import { LONG_WORK_CONTINUE_AFTER_ITERATIONS, LONG_WORK_WAKE_SIGNAL } from "./contracts.js";

const wake = defineSignal(LONG_WORK_WAKE_SIGNAL);
const { advanceLongWork } = proxyActivities<{
  advanceLongWork: AdvanceLongWorkActivity;
}>({
  startToCloseTimeout: "1 minute",
  retry: { maximumAttempts: 5 },
});
const { advanceContinuation } = proxyActivities<{
  advanceContinuation: AdvanceContinuationActivity;
}>({
  startToCloseTimeout: "1 minute",
  retry: { maximumAttempts: 5 },
});

/** Temporal coordinates wakeups and retries. Glassbox remains the Task state authority. */
export async function longWorkWorkflow(input: LongWorkWorkflowInput): Promise<void> {
  let wakeRequested = false;
  let iterations = 0;
  setHandler(wake, () => {
    wakeRequested = true;
  });

  while (true) {
    const result = await advanceLongWork(input);
    iterations += 1;
    if (result.kind === "complete") return;

    if (iterations >= LONG_WORK_CONTINUE_AFTER_ITERATIONS) {
      return continueAsNew<typeof longWorkWorkflow>(input);
    }

    if (result.kind === "wait") {
      if (result.wakeAt !== undefined) {
        const dueAt = Date.parse(result.wakeAt);
        if (!Number.isFinite(dueAt)) throw new Error("Activity returned invalid wakeAt");
        await condition(() => wakeRequested, Math.max(0, dueAt - Date.now()));
      } else {
        await condition(() => wakeRequested);
      }
      wakeRequested = false;
    }
  }
}

/** A domain-neutral timer. The Activity reloads the current generation on every wake. */
export async function continuationWorkflow(input: ContinuationWorkflowInput): Promise<void> {
  let wakeRequested = false;
  let iterations = 0;
  setHandler(wake, () => {
    wakeRequested = true;
  });
  while (true) {
    const result = await advanceContinuation(input);
    iterations += 1;
    if (result.kind === "complete") return;
    if (iterations >= LONG_WORK_CONTINUE_AFTER_ITERATIONS) {
      return continueAsNew<typeof continuationWorkflow>(input);
    }
    if (result.kind === "wait") {
      if (result.wakeAt !== undefined) {
        const dueAt = Date.parse(result.wakeAt);
        if (!Number.isFinite(dueAt)) throw new Error("Activity returned invalid wakeAt");
        await condition(() => wakeRequested, Math.max(0, dueAt - Date.now()));
      } else {
        await condition(() => wakeRequested);
      }
      wakeRequested = false;
    }
  }
}
