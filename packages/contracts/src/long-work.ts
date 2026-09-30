// P6 product records. Runtime history and Herdr state are not Task truth.
export const TASK_STEP_KINDS = [
  "model",
  "tool",
  "herdr_worker",
  "timer_wait",
  "signal_wait",
  "approval_wait",
  "child_task",
  "join",
] as const;
export type TaskStepKind = (typeof TASK_STEP_KINDS)[number];

export const TASK_STEP_STATUSES = [
  "pending",
  "ready",
  "running",
  "waiting",
  "blocked",
  "review",
  "succeeded",
  "failed",
  "cancelled",
  "skipped",
] as const;
export type TaskStepStatus = (typeof TASK_STEP_STATUSES)[number];

export type DependencyOutcome = "continue" | "block" | "skip" | "cancel";
export interface TaskStepDependencyPolicy {
  failed: DependencyOutcome;
  cancelled: DependencyOutcome;
  skipped: DependencyOutcome;
}

export interface TaskRetryPolicy {
  version: number;
  maxAttempts: number;
  initialDelayMs: number;
  backoffMultiplier: number;
  maxDelayMs: number;
  retryableErrorClasses: readonly string[];
  nonRetryableErrorClasses: readonly string[];
  timeoutOutcome: "retryable" | "failed" | "unknown";
}

export type TaskWaitKind = "duration" | "until" | "deadline" | "signal" | "approval" | "retry";
export interface TaskWaitPolicy {
  version: number;
  kind: TaskWaitKind;
  durationMs?: number;
  dueAt?: string;
  signalKey?: string;
  timeoutAt?: string;
  overdue: "resume" | "stale";
}

/** One exact protected resource and action. A declaration is not an authorization grant. */
export interface DelegatedPermission {
  resourceId: string;
  action: string;
}

export interface TaskStep {
  id: string;
  taskId: string;
  kind: TaskStepKind;
  title: string;
  instructions?: string;
  specRef?: string;
  status: TaskStepStatus;
  dependencyIds: readonly string[];
  dependencyPolicy: TaskStepDependencyPolicy;
  maxAttempts: number;
  timeoutMs?: number;
  retryPolicy?: TaskRetryPolicy;
  waitPolicy?: TaskWaitPolicy;
  requiredCapabilities: readonly string[];
  delegatedPermissionSet: readonly DelegatedPermission[];
  checkpointRef?: string;
  outputRef?: string;
  createdAt: string;
  updatedAt: string;
  version: number;
}

export const TASK_EVENT_TYPES = [
  "TASK_CREATED",
  "STEP_ADDED",
  "STEP_READY",
  "STEP_STARTED",
  "STEP_WAITING",
  "STEP_BLOCKED",
  "SIGNAL_RECEIVED",
  "RETRY_SCHEDULED",
  "CHECKPOINT_WRITTEN",
  "WORKER_BOUND",
  "WORKER_RECOVERED",
  "WORKER_LOST",
  "ATTEMPT_FINISHED",
  "STEP_REVIEW",
  "STEP_SUCCEEDED",
  "STEP_FAILED",
  "STEP_CANCELLED",
  "STEP_SKIPPED",
  "CHILD_TASK_CREATED",
  "TASK_REVIEW",
  "TASK_BLOCKED",
  "TASK_REWORK",
  "TASK_ACCEPTED",
  "TASK_CANCELLED",
  "TASK_CONTINUED",
] as const;
export type TaskEventType = (typeof TASK_EVENT_TYPES)[number];

export interface TaskEvent {
  id: string;
  taskId: string;
  sequence: number;
  type: TaskEventType;
  stepId?: string;
  attemptId?: string;
  actorPrincipalId?: string;
  authorizationDecisionId?: string;
  evidenceRef?: string;
  metadata?: Readonly<Record<string, string | number | boolean | null>>;
  createdAt: string;
}

export interface TaskWait {
  id: string;
  taskId: string;
  stepId: string;
  attemptId?: string;
  policy: TaskWaitPolicy;
  startedAt: string;
  dueAt?: string;
  status: "waiting" | "resumed" | "stale" | "cancelled";
  version: number;
}

export interface TaskSignal {
  id: string;
  taskId: string;
  stepId: string;
  targetStepVersion: number;
  targetAttemptId?: string;
  type: string;
  source: "principal" | "trusted_system";
  actorPrincipalId?: string;
  authorizationDecisionId: string;
  payloadRef?: string;
  metadata?: Readonly<Record<string, string | number | boolean | null>>;
  idempotencyKey: string;
  receivedAt: string;
  disposition: "applied" | "duplicate" | "stale" | "denied";
}

export interface TaskCheckpoint {
  id: string;
  taskId: string;
  stepId?: string;
  attemptId?: string;
  type: string;
  stateRef: string;
  artifactRef?: string;
  sourceEvidenceRef: string;
  policyVersion: number;
  createdAt: string;
}

export interface ChildTaskLink {
  parentTaskId: string;
  parentStepId: string;
  childTaskId: string;
  delegatedPermissionSet: readonly DelegatedPermission[];
  acceptanceCriteria: readonly string[];
  cancellationPolicy: "cancel_child" | "keep_child";
  failurePolicy: "block_parent" | "fail_parent" | "review_parent";
  parentNotificationPolicy: "suppress" | "notify_parent";
  resultRef?: string;
  createdAt: string;
}

export interface TaskStepLease {
  id: string;
  taskId: string;
  stepId: string;
  attemptId: string;
  workerBindingId: string;
  ownerInstanceId: string;
  acquiredAt: string;
  heartbeatAt: string;
  expiresAt: string;
  status: "active" | "expired" | "released" | "quarantined";
  version: number;
}

export interface TaskWorkflowBinding {
  taskId: string;
  workflowId: string;
  runId?: string;
  backend: "temporal";
  policyRevision: number;
  continuation: number;
  status: "starting" | "running" | "unavailable" | "closed";
  updatedAt: string;
}

/** Domain-neutral pointer for a durable continuation. It never carries instructions. */
export interface DurableContinuationTarget {
  kind: "task" | "activity";
  targetId: string;
}

export type DurableContinuationCadence =
  | { kind: "once" }
  | { kind: "interval"; intervalMs: number; maxOccurrences: number; endAt?: string };

export type DurableContinuationStatus = "active" | "completed" | "cancelled";

export interface DurableContinuationSchedule {
  id: string;
  target: DurableContinuationTarget;
  cadence: DurableContinuationCadence;
  createdAt: string;
  nextDueAt: string | null;
  occurrenceCount: number;
  generation: number;
  version: number;
  status: DurableContinuationStatus;
  updatedAt: string;
}

/** A fired timer is immutable evidence, even if its schedule is later rescheduled. */
export interface DurableContinuationOccurrence {
  id: string;
  scheduleId: string;
  target: DurableContinuationTarget;
  generation: number;
  ordinal: number;
  dueAt: string;
  createdAt: string;
}

export interface PendingContinuationDelivery {
  occurrence: DurableContinuationOccurrence;
  version: number;
}

export type DurableContinuationOrigin =
  | { kind: "decision"; decisionId: string; actorPrincipalId: string }
  | { kind: "system"; reason: string };

export interface DurableContinuationEvent {
  id: string;
  sequence: number;
  scheduleId: string;
  type: "created" | "rescheduled" | "cancelled" | "fired";
  target: DurableContinuationTarget;
  generation: number;
  version: number;
  dueAt: string | null;
  occurrenceId?: string;
  origin: DurableContinuationOrigin;
  createdAt: string;
}
