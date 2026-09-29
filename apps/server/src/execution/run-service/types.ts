import type { DeliveryRecord } from "../../conversation/lifecycle.js";
import type {
  ConversationRecord,
  HistoryActor,
  IncomingImageFailure,
  IncomingImageMimeType,
  RunRecord,
  RunStatus,
} from "../../conversation/store.js";
import type { CallerContext, TrustedChannelScope } from "../../identity/scope.js";
import type { DomainStore } from "../../persistence/index.js";

export type AcceptedIncoming = Awaited<ReturnType<DomainStore["conversations"]["acceptIncoming"]>>;

export interface ExecutionInput {
  caller: CallerContext;
  conversation: ConversationRecord;
  run: RunRecord;
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

export interface ExecutionResult {
  /** A terminal adapter result is evidence; receiving an abort signal alone is not. */
  status: "succeeded" | "failed" | "cancelled" | "interrupted" | "unknown";
  text?: string;
  providerSessionId?: string;
  /**
   * A fixed diagnostic code naming why this Run produced no answer of its own. It is persisted so
   * the fallback line a reader receives states the cause rather than the terminal status, and so a
   * Run recovered at startup still delivers the same line. Provider error text never enters this
   * union: these are Glassbox's own classifications.
   */
  failureCode?:
    /** The selected model was rejected before any provider request or Tool call. */
    | "pre_provider_context_overflow"
    /** The model's context capacity could not be established, so nothing was sent. */
    | "model_capacity_unknown"
    /** The action the message pinned down never executed, so the answer cannot stand. */
    | "required_action_not_completed"
    /** The facts the message was about were never observed, so the answer cannot stand. */
    | "required_evidence_missing"
    /** The executor threw before producing a classified result of its own. */
    | "execution_threw";
}

export interface RunExecutionAdapter {
  /** True only for adapters with enforced isolation of files, tools and host configuration. */
  supportsGroup: boolean;
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
