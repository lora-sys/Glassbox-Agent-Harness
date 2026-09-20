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
  }>;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  };
  error?: string;
}

import type { CallerContext } from "../../identity/scope.js";

export interface PiRunContext {
  caller?: CallerContext;
  conversationId?: string;
  runId?: string;
  requiredToolName?: string;
  requiredToolInput?: Record<string, unknown>;
  authorizedSkillNames?: readonly string[];
  modelVisibleSkillNames?: readonly string[];
  skillPolicy?: Record<string, unknown>;
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
  getRunContext?(runtimeSessionId: string): PiRunContext | undefined;
  cleanup(): Promise<void>;
}
