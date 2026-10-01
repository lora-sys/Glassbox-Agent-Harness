import type { DeliveryRecord } from "../../conversation/lifecycle.js";
import type {
  ConversationRecord,
  HistoryActor,
  IncomingImageFailure,
  IncomingImageMimeType,
  RunRecord,
  RunStatus,
  StepResultRecord,
} from "../../conversation/store.js";
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
  stepResults?: StepResultRecord[];
  text: string;
  images?: readonly { mimeType: IncomingImageMimeType; data: string }[];
  imageFailureCode?: IncomingImageFailure;
  history: Array<{ role: "user" | "assistant"; text: string }>;
  /** One entry per history turn, in the same order, naming who wrote it. */
  historyActors?: readonly HistoryActor[];
  historyRunIds?: string[];
  historyScanTruncated?: boolean;
  historyOmittedRunIds?: string[];
  /** Bounded, active, authorized learning records selected for this exact Run scope. */
  learningContext?: readonly { memoryId: string; type: string; statement: string }[];
  /** Only present when saved for this exact execution configuration and Conversation. */
  providerSessionId: string | null;
  signal: AbortSignal;
}

/**
 * Why a Run produced no answer of its own.
 *
 * This is a closed union on purpose. Every layer that reads it — the fallback line a reader
 * receives, the health observation routing acts on, the Trace — decides what to do from the
 * cause alone, so a cause that means "the runtime was down" and one that means "Glassbox
 * refused this itself" must never collapse into the same value. `status: "failed"` used to be
 * allowed to name no cause at all, which put every refusal in the same bucket as a provider
 * outage; that is what let a single gate decision pull a working profile out of routing.
 */
export type ExecutionFailureCode =
  /** The selected model was rejected before any provider request or Tool call. */
  | "pre_provider_context_overflow"
  /** The model's context capacity could not be established, so nothing was sent. */
  | "model_capacity_unknown"
  /** Loaded input requires a capability the selected model does not support. */
  | "model_capability_missing"
  /** The selected execution path cannot resolve a currently configured credential. */
  | "model_credential_missing"
  /** A gate of Glassbox's own refused the request, so the request was never put to the runtime. */
  | "gate_refused"
  /** The configured execution reference has no executor able to take this Run. */
  | "execution_unavailable"
  /** The action the message pinned down never executed, so the answer cannot stand. */
  | "required_action_not_completed"
  /** The Run asserted a durable change no Tool performed, so the answer cannot stand. */
  | "claimed_change_not_performed"
  /** The facts the message was about were never observed, so the answer cannot stand. */
  | "required_evidence_missing"
  /** The runtime was engaged and the run it was given ended in an error rather than an answer. */
  | "runtime_run_errored"
  /** The executor threw before producing a classified result of its own. */
  | "execution_threw";

/** What every terminal adapter result carries. */
interface ExecutionResultShape {
  /** False is explicit evidence that no provider Run was attempted, even for local replies. */
  runtimeAttempted?: boolean;
  text?: string;
  providerSessionId?: string;
}

export interface ExecutionResultSucceeded extends ExecutionResultShape {
  /** A terminal adapter result is evidence; receiving an abort signal alone is not. */
  status: "succeeded";
  /** A Run that answered names no reason for not answering. */
  failureCode?: never;
}

export interface ExecutionResultFailed extends ExecutionResultShape {
  status: "failed";
  /**
   * Required. A failure that names no cause forces every later layer to guess at one, and the
   * guess that used to be made — treat an unnamed failure as the runtime being down — is how
   * a refusal by Glassbox's own gates removed a working profile from routing for a minute.
   *
   * Provider error text never enters this union: these are Glassbox's own classifications.
   */
  failureCode: ExecutionFailureCode;
}

export interface ExecutionResultUnfinished extends ExecutionResultShape {
  /**
   * A Run that was stopped, interrupted, or that the adapter could not classify. These name
   * no cause, because none of them is a failure to produce an answer of the Run's own.
   */
  status: "cancelled" | "interrupted" | "unknown";
  failureCode?: ExecutionFailureCode;
}

/**
 * The single terminal outcome type an adapter returns.
 *
 * The union is what keeps a refusal honest: a `failed` result cannot be written without naming
 * which of the causes in `ExecutionFailureCode` it was, so a new gate added later has to say
 * whether it refused the request itself or found the runtime unable to answer.
 */
export type ExecutionResult =
  | ExecutionResultSucceeded
  | ExecutionResultFailed
  | ExecutionResultUnfinished;

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
  /**
   * The first event of a Run's trace: the channel message that produced it.
   *
   * Carries the channel-native and storage identifiers so a Run joins back to the message
   * that caused it, plus a digest and byte count instead of the body. The body stays in
   * `messages.text`; copying it here would fail the trace-leak gate (AGENTS.md: the Trace
   * must explain the decision without leaking protected payloads).
   */
  | {
      type: "message_received";
      runId: string;
      conversationId: string;
      /** Channel-native message id (`IncomingMessage.messageId`); joins to `channel_messages`. */
      externalId: string;
      /** Storage message id; joins to `messages.id`. */
      messageId: string;
      connectionId: string;
      botId: string;
      chatType: "private" | "group";
      chatId: string;
      senderId: string;
      threadId?: string;
      /** UTF-8 byte length of the accepted message text. */
      textBytes: number;
      /** Digest of the accepted message text, for equality checks without the body. */
      textSha256: string;
    }
  | { type: "run_queued" | "run_started" | "run_cancelling"; runId: string; conversationId: string }
  | {
      type: "run_finished";
      runId: string;
      conversationId: string;
      status: RunStatus;
      outputWithheld: boolean;
      /**
       * Why an unsuccessful Run stopped, when the executor could name the cause. Fixed
       * diagnostic codes only; provider errors and protected payloads are excluded, so a
       * missing code means the executor did not have a cause to report rather than zero risk.
       */
      failureCode?: ExecutionResult["failureCode"];
    }
  | {
      type: "delivery_changed";
      runId: string;
      deliveryId: string;
      status: DeliveryRecord["status"];
      /** Channel-native id of the sent message, when the transport confirmed one. */
      externalId?: string;
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
      type: "learning_candidate_created";
      runId: string;
      conversationId: string;
      candidateId: string;
      scopeType: "global" | "group";
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
  /**
   * How long after a Run finishes a restart may still publish it. Defaults to two hours; a Run
   * holding a delivery that never reached a final state is restored regardless of age.
   */
  restoreWindowMs?: number;
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
  /** Creates pending learning evidence after current Run authorization and before inference. */
  captureLearning?: (input: ExecutionInput) => Promise<string | undefined>;
  /** Fixed diagnostic codes only; provider errors and protected payloads are excluded. */
  onError?: (error: {
    code: "dispatch_failed" | "delivery_failed" | "evidence_failed";
    runId?: string;
  }) => void;
}
