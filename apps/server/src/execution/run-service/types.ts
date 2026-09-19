import type { DeliveryRecord } from "../../conversation/lifecycle.js";
import type { ConversationRecord, RunRecord, RunStatus } from "../../conversation/store.js";
import type { CallerContext, TrustedChannelScope } from "../../identity/scope.js";
import type { DomainStore } from "../../persistence/index.js";

export type AcceptedIncoming = Awaited<ReturnType<DomainStore["conversations"]["acceptIncoming"]>>;

export interface ExecutionInput {
  caller: CallerContext;
  conversation: ConversationRecord;
  run: RunRecord;
  text: string;
  history: Array<{ role: "user" | "assistant"; text: string }>;
  /** Only present when saved for this exact execution configuration and Conversation. */
  providerSessionId: string | null;
  signal: AbortSignal;
}

export interface ExecutionResult {
  /** A terminal adapter result is evidence; receiving an abort signal alone is not. */
  status: "succeeded" | "failed" | "cancelled" | "interrupted" | "unknown";
  text?: string;
  providerSessionId?: string;
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
  onEvent?: (event: RunServiceEvent) => void | Promise<void>;
  /** Fixed diagnostic codes only; provider errors and protected payloads are excluded. */
  onError?: (error: {
    code: "dispatch_failed" | "delivery_failed" | "evidence_failed";
    runId?: string;
  }) => void;
}
