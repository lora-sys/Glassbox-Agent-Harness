import type { Conversation, AgentRun } from "@glassbox/contracts";

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
}

import type { CallerContext } from "../../identity/scope.js";
import type { ToolExecutionOutcome } from "./tool-plane.js";
import type { RequiredEvidence } from "./required-evidence.js";

export interface PiRunContext {
  caller?: CallerContext;
  conversationId?: string;
  runId?: string;
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
  cleanup(): Promise<void>;
}
