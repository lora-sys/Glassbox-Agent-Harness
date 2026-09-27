import type { DeliveryRecord } from "../../conversation/lifecycle.js";
import type { ConversationRecord, RunRecord, RunStatus } from "../../conversation/store.js";
import type { CallerContext, TrustedChannelScope } from "../../identity/scope.js";
import type { DomainStore } from "../../persistence/index.js";

export type AcceptedIncoming = Awaited<ReturnType<DomainStore["conversations"]["acceptIncoming"]>>;

export interface ExecutionInput {
  /** Set only by the server from a persisted internal Run source. */
  executionMode?: "task_step_model" | "task_step_tool";
  caller: CallerContext;
  conversation: ConversationRecord;
  run: RunRecord;
  taskStepBinding?: { taskId: string; stepId: string; attemptId: string };
  stepResults?: Array<{ stepId: string; runId: string; text: string; truncated: boolean }>;
  text: string;
  history: Array<{ role: "user" | "assistant"; text: string }>;
  historyRunIds?: string[];
  historyScanTruncated?: boolean;
  historyOmittedRunIds?: string[];
  /** Only present when saved for this exact execution configuration and Conversation. */
  providerSessionId: string | null;
  signal: AbortSignal;
}

export interface ExecutionResult {
  /** A terminal adapter result is evidence; receiving an abort signal alone is not. */
  status: "succeeded" | "failed" | "cancelled" | "interrupted" | "unknown";
  text?: string;
  providerSessionId?: string;
  /** The selected model was rejected before any provider request or Tool call. */
  failureCode?: "pre_provider_context_overflow" | "model_capacity_unknown";
}

export interface RunExecutionAdapter {
  /** True only for adapters with enforced isolation of files, tools and host configuration. */
  supportsGroup: boolean;
  /** True only when task_step_model executes without any mutating or ambient Tool surface. */
  supportsTaskStepModel?: boolean;
  /** A closed server Tool executor with no model, ambient Tool registry, or external ingress. */
  supportsTaskStepTool?: boolean;
  execute(input: ExecutionInput): Promise<ExecutionResult>;
}

export type SendOutcome =
  | { status: "sent"; externalId?: string }
  | { status: "failed" | "unknown" };
export interface RunTransport {
  send(input: {
    destination: TrustedChannelScope;
    delivery: DeliveryRecord;
    signal: AbortSignal;
  }): Promise<SendOutcome>;
}

export type RunServiceEvent =
  | { type: "run_queued" | "run_started" | "run_cancelling"; runId: string; conversationId: string }
  | {
      type: "run_finished";
      runId: string;
      conversationId: string;
      status: RunStatus;
      outputWithheld: boolean;
    }
  | {
      type: "delivery_changed";
      runId: string;
      deliveryId: string;
      status: DeliveryRecord["status"];
    }
  | {
      type: "task_notification_changed";
      runId: string;
      taskId: string;
      notificationId: string;
      status: "sending" | "sent" | "failed" | "unknown";
    }
  | {
      type: "delivery_blocked";
      runId: string;
      conversationId: string;
      reasons: string[];
      candidateSha256: string;
      candidateBytes: number;
    }
  /**
   * A delivery authorization refused the Run's answer.
   *
   * Distinct from `delivery_blocked`, which is the content policy refusing a candidate that
   * authorization had already permitted. This carries the decision and its reason and nothing
   * else: no payload, no snippet, no protected text. The exact Resource and Action the decision
   * was made on stay in the authorization ledger, joined to this Run.
   */
  | {
      type: "delivery_denied";
      runId: string;
      conversationId: string;
      /** The authorization decision value, e.g. `DENY`. */
      decision: string;
      /** The decision reason, e.g. `no_grant`. */
      reason: string;
    }
  | {
      type: "recovered";
      interruptedRunIds: string[];
      unknownRunIds: string[];
      unknownDeliveryIds: string[];
    };

export interface RunServiceOptions {
  store: DomainStore;
  resolveExecution(executionRef: string): RunExecutionAdapter | undefined;
  transport: RunTransport;
  concurrency?: number;
  /** Polls the shared durable queue when an external coordinator inserts internal Runs. */
  queuedPollMs?: number;
  deliveryTimeoutMs?: number;
  onEvent?: (event: RunServiceEvent) => void | Promise<void>;
  prepareDelivery?: (
    candidate: string,
    context: { caller: CallerContext; run: RunRecord },
  ) => Promise<{
    allowed: boolean;
    text?: string;
    reasons: string[];
    candidateSha256: string;
    artifactIds?: readonly string[];
    mediaAssetIds?: readonly string[];
  }>;
  /** Fixed diagnostic codes only; provider errors and protected payloads are excluded. */
  onError?: (error: {
    code: "dispatch_failed" | "delivery_failed" | "evidence_failed";
    runId?: string;
  }) => void;
}
