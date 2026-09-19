// Domain contracts for Personal Agent Foundation (Plan 03)

export type PrincipalKind = "owner" | "visitor" | "agent" | "system";

export interface Principal {
  id: string;
  kind: PrincipalKind;
  createdAt: string;
}

export type ChannelType = "qq" | "workbench" | "test" | "cli";

export interface ActionLocation {
  channel: ChannelType;
  connectionId: string;
  botId: string;
  chatType: "private" | "group";
  chatId: string;
  senderId: string;
  threadId?: string;
  scopeKey: string;
}

export type AudienceKind = "private" | "group" | "internal";

export interface Audience {
  kind: AudienceKind;
  destinationScopeKey: string;
  allowedPrincipals: readonly string[];
}

export type ResourceVisibility = "public" | "private";

export type DecisionValue = "ALLOW" | "DENY" | "REQUIRES_APPROVAL";

export type DecisionReason =
  | "identity_unbound"
  | "identity_mismatch"
  | "resource_missing"
  | "private_group_context"
  | "no_grant"
  | "explicit_grant"
  | "approval_required"
  | "approval_invalid"
  | "approved"
  | "scope_mismatch"
  | "audience_mismatch"
  | "policy_deny";

export interface AuthorizationDecision {
  id: string;
  decision: DecisionValue;
  reason: DecisionReason;
  grantId?: string | null;
  approvalId?: string | null;
}

export interface AuthorizationRequest {
  principalId: string;
  resourceId: string;
  action: string;
  location: ActionLocation;
  audience?: Audience;
  approvalId?: string;
  conversationId?: string;
  runId?: string;
  taskId?: string;
}

export type ConversationScopeType = "direct" | "group";

export interface ConversationScope {
  channel: ChannelType;
  scopeType: ConversationScopeType;
  scopeKey: string;
  chatId: string;
  connectionId: string;
}

export interface Conversation {
  id: string;
  agentId: string;
  principalId: string;
  scope: ConversationScope;
  resourceId: string;
  createdAt: string;
}

export type RunStatus =
  | "queued"
  | "running"
  | "cancelling"
  | "cancelled"
  | "succeeded"
  | "failed"
  | "interrupted"
  | "unknown";

export interface AgentRun {
  id: string;
  conversationId: string;
  messageId: string;
  principalId: string;
  executionRef: string;
  status: RunStatus;
  resultText?: string | null;
  createdAt: string;
  updatedAt: string;
}

export type TaskStatus =
  | "NEW"
  | "QUEUED"
  | "ASSIGNED"
  | "RUNNING"
  | "WAITING_INPUT"
  | "REVIEW"
  | "ACCEPTED"
  | "DONE"
  | "FAILED"
  | "CANCELED";

export type TaskPriority = "low" | "normal" | "high" | "urgent";

export interface AgentTask {
  id: string;
  title: string;
  description?: string;
  status: TaskStatus;
  priority: TaskPriority;
  creatorPrincipalId: string;
  conversationId?: string;
  runId?: string;
  activeAttemptId?: string | null;
  acceptanceCriteria?: readonly string[];
  createdAt: string;
  updatedAt: string;
}

export type AttemptStatus =
  | "pending"
  | "running"
  | "waiting_input"
  | "review"
  | "succeeded"
  | "failed"
  | "canceled";

export interface TaskAttempt {
  id: string;
  taskId: string;
  attemptNumber: number;
  status: AttemptStatus;
  reworkReason?: string;
  startedAt: string;
  completedAt?: string | null;
  resultSummary?: string;
}

export type HerdrAgentLifecycleState =
  | "starting"
  | "working"
  | "blocked"
  | "idle"
  | "done"
  | "unknown";

export interface WorkerBinding {
  id: string;
  taskAttemptId: string;
  herdrSession: string;
  workspaceId: string;
  paneId: string;
  tabId?: string;
  worktreePath?: string;
  branch?: string;
  agentName?: string;
  agentKind: string;
  lastObservedAgentState: HerdrAgentLifecycleState;
  updatedAt: string;
}

export type AttentionKind =
  | "unanswered_message"
  | "worker_blocked"
  | "approval_required"
  | "task_review"
  | "task_failed"
  | "delivery_failed"
  | "ops_connection_problem";

export interface AttentionItem {
  id: string;
  kind: AttentionKind;
  summary: string;
  principalId?: string;
  conversationId?: string;
  taskId?: string;
  taskAttemptId?: string;
  createdAt: string;
  resolvedAt?: string | null;
}

export interface AgentOpsSnapshot {
  attention: {
    total: number;
    unansweredMessages: number;
    approvals: number;
    blockedWorkers: number;
    awaitingReview: number;
    failures: number;
  };
  tasks: {
    open: number;
    queued: number;
    running: number;
    waiting: number;
    review: number;
    doneToday: number;
  };
  workers: {
    total: number;
    working: number;
    blocked: number;
    idle: number;
    done: number;
    unknown: number;
  };
}
