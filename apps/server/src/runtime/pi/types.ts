import type { Conversation, AgentRun } from "@glassbox/contracts";
import type { ModelCapacity as EfficiencyModelCapacity } from "../../efficiency/index.js";

export type PiRuntimeProfileName =
  | "main-agent"
  | "local-coding"
  | "owner-direct"
  | "qq-group"
  | "herdr-worker"
  | "test";

export interface PiRuntimeConfig {
  profileName: PiRuntimeProfileName;
  kitPath?: string;
  kitRepo: string;
  kitCommit: string;
  agentDir: string;
  allowedTools: string[];
  timeoutMs?: number;
}

export interface PiSessionBinding {
  conversationId: string;
  runtimeSessionId: string;
  profileName: PiRuntimeProfileName;
  agentDir: string;
  createdAt: string;
  lastActiveAt: string;
}

export type PiNormalizedEventType =
  | "session_start"
  | "turn_start"
  | "turn_end"
  | "tool_call"
  | "tool_result"
  | "message_chunk"
  | "session_end";

export interface PiNormalizedEvent {
  type: PiNormalizedEventType;
  sessionId: string;
  timestamp: string;
  runId?: string;
  principalId?: string;
  toolCallId?: string;
  data: Record<string, unknown>;
}

export interface PiRunResult {
  status: "completed" | "aborted" | "error";
  text: string;
  toolCalls: Array<{
    name: string;
    input: Record<string, unknown>;
    result?: unknown;
    failed?: boolean;
    blocked?: boolean;
    reason?: string;
    /**
     * The runtime's identifier for this call, when the runtime supplied one.
     *
     * A required-evidence check and the Trace both need to name the *call* rather than the
     * Tool: one Run may call the same Tool twice, and only one of those calls answered the
     * question. Without the id the evidence cannot be pointed back at the exact call.
     */
    toolCallId?: string;
    /**
     * What actually happened, in the shared Tool-plane vocabulary.
     *
     * `failed` alone is not enough to decide whether a call answered anything: a refusal, a
     * malformed call and an unavailable provider are all failures, and only one of them is a
     * fact about the world that a Run may report.
     */
    outcome?: ToolExecutionOutcome;
  }>;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  };
  error?: string;
  /** Safe diagnostic assigned by the adapter; raw error text cannot select its origin. */
  failure?: import("./failure-diagnostics.js").PiFailureDiagnostic;
}

import type { CallerContext } from "../../identity/scope.js";
import type { ToolExecutionOutcome } from "./tool-plane.js";
import type { RequiredEvidence } from "./required-evidence.js";

export interface PiRunContext {
  /** Server-owned, message-bound restriction. It is never serialized into model context. */
  acceptanceLease?: {
    leaseId: string;
    marker: string;
    toolsSha256: string;
    assertActive(): boolean;
    filterToolNames(names: readonly string[]): string[];
    checkToolCall(input: {
      toolName: string;
      action: string;
      resourceId: string;
      toolInput: Readonly<Record<string, unknown>>;
    }): boolean;
  };
  /** Server-owned authorization callback; never populated from model or Tool input. */
  authorizeProviderContext?: () => Promise<void>;
  /** Rechecks mutable server-owned policy for Skill metadata already in the prompt. */
  authorizeSkillContext?: () => Promise<void>;
  /** Trusted server execution mode, not inferred from prompt text. */
  executionMode?: "task_step_model";
  caller?: CallerContext;
  /**
   * Who is speaking right now, resolved from the Channel binding rather than from the message.
   *
   * A group Conversation is shared, so the principal frozen on it belongs to whoever spoke first.
   * This carries the current sender instead, which is the only thing that can answer "who am I
   * talking to" — and the prompt's identity rules are written against it.
   */
  callerIdentity?: {
    senderId: string;
    isOwner: boolean;
    /** True when this Conversation's location is shared by several senders. */
    sharedConversation: boolean;
    /**
     * What this channel's configuration calls the bot.
     *
     * Resolved from the connection, never from message text or a provider response, so it is
     * the one name source the prompt can state as fact. Absent means the channel configured
     * no name.
     */
    botDisplayName?: string;
  };
  conversationId?: string;
  runId?: string;
  /** Current user attachments, carried to Pi as ImageContent without changing their order. */
  images?: readonly {
    mimeType: "image/png" | "image/jpeg" | "image/webp";
    data: string;
  }[];
  /** Server-resolved workspace for the current Owner Run, never a model-supplied host path. */
  workspaceId?: string;
  requiredToolName?: string;
  requiredToolInput?: Record<string, unknown>;
  authorizedSkillNames?: readonly string[];
  modelVisibleSkillNames?: readonly string[];
  skillPolicy?: Record<string, unknown>;
  /**
   * The Tool names this Run actually discovered, as the runtime resolved them.
   *
   * Written by the runtime once per session and used to build the model-visible Tool set. It
   * is not an input to any requirement: what a message requires is read from the message, and
   * the surface decides only whether the Run can satisfy it.
   */
  authorizedToolNames?: readonly string[];
  /**
   * The factual domains the current user message requires evidence from.
   *
   * Resolved once per Run from the message, then carried on the context so the completion
   * check and the Tool plane read the same list. An empty array means the message requires no
   * evidence; `undefined` means no policy was resolved at all, which the completion check
   * treats as nothing required rather than as a blanket requirement.
   */
  requiredEvidence?: readonly RequiredEvidence[];
}

export interface PiRuntimeAdapter {
  initialize(): Promise<void>;
  createOrRestoreSession(
    conversation: Conversation,
    profile: PiRuntimeProfileName,
    context?: PiRunContext,
  ): Promise<PiSessionBinding>;
  run(
    binding: PiSessionBinding,
    run: AgentRun,
    prompt: string,
    context?: PiRunContext,
  ): Promise<PiRunResult>;
  abort(runtimeSessionId: string): Promise<void>;
  disposeSession?(runtimeSessionId: string): Promise<void>;
  disposeWorkspaceSessions?(principalId: string, workspaceId: string): Promise<void>;
  getRunContext?(runtimeSessionId: string): PiRunContext | undefined;
  getModelSupportsImages?(runtimeSessionId: string): boolean;
  getModelCapacity?(runtimeSessionId: string): EfficiencyModelCapacity | undefined;
  getThinkingLevel?(runtimeSessionId: string): string | null | undefined;
  getStaticContextEstimate?(runtimeSessionId: string):
    | {
        systemTokens: number;
        toolSchemaTokens: number;
      }
    | undefined;
  cleanup(): Promise<void>;
}
