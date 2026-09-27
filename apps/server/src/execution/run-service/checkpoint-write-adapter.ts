import type { DomainStore } from "../../application/domain-store.js";
import { parseCheckpointWriteSpec } from "../../ops/tool-step-spec.js";
import type { RunExecutionAdapter } from "./types.js";

/** A closed mutation whose receipt is verified from durable state after uncertain delivery. */
export function createCheckpointWriteAdapter(store: DomainStore): RunExecutionAdapter {
  return {
    supportsGroup: true,
    supportsTaskStepTool: true,
    async execute(input) {
      if (
        input.executionMode !== "task_step_tool" ||
        !input.taskStepBinding ||
        !parseCheckpointWriteSpec(input.run.executionRef)
      )
        return { status: "failed" };
      if (input.signal.aborted) return { status: "cancelled" };
      const receipt = await store.longWork.writeClaimedCheckpoint({
        caller: input.caller,
        runId: input.run.id,
        taskId: input.taskStepBinding.taskId,
        stepId: input.taskStepBinding.stepId,
        attemptId: input.taskStepBinding.attemptId,
      });
      return { status: "succeeded", text: `checkpoint:${receipt.checkpointId}` };
    },
  };
}
