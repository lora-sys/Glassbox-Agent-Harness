export interface LongWorkWorkflowInput {
  taskId: string;
  policyRevision: number;
}

export interface ContinuationWorkflowInput {
  scheduleId: string;
}

/** The Activity reads and advances Glassbox state, then tells Temporal when to wake again. */
export type LongWorkAdvanceResult =
  | { kind: "complete" }
  | { kind: "continue" }
  | { kind: "wait"; wakeAt?: string };

export type AdvanceLongWorkActivity = (
  input: LongWorkWorkflowInput,
) => Promise<LongWorkAdvanceResult>;

/** The schedule and occurrence remain Glassbox records. Temporal only wakes this ID. */
export type AdvanceContinuationActivity = (
  input: ContinuationWorkflowInput,
) => Promise<LongWorkAdvanceResult>;

export const LONG_WORK_WAKE_SIGNAL = "longWorkWake";
export const LONG_WORK_WORKFLOW_TYPE = "longWorkWorkflow";
export const CONTINUATION_WORKFLOW_TYPE = "continuationWorkflow";
export const LONG_WORK_TASK_QUEUE = "glassbox-long-work";
export const LONG_WORK_CONTINUE_AFTER_ITERATIONS = 100;

export function longWorkWorkflowId(taskId: string): string {
  return `glassbox-long-work:${taskId}`;
}

export function continuationWorkflowId(scheduleId: string): string {
  return `glassbox-continuation:${scheduleId}`;
}
