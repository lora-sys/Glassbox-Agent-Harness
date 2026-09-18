/**
 * @file apps/web/src/management/types/index.ts
 *
 * Explicit domain types and UI projections for the Glassbox Web Management UI.
 *
 * CONTRACT GOVERNANCE & MAPPING GAP AUDIT:
 * - We import and re-export canonical contracts from @glassbox/contracts where they exist:
 *   - Management: PublicModelProfile, ModelProtocol, ManagementStatus, ManagementDoctor, ManagementFailure
 *   - Channels: PublicChannelProfile, ChannelConnectionState, ChannelSafeError, ChannelSaveInput
 *   - Executors: PublicExecutor, ClaudeExecutorSettings
 *   - Evals: RunEvalView, RunEvalAssessment, RunEvalScore, RunEvalCheck, EvalVerdict, RunEvalPage
 *
 * - Where backend contracts do not yet expose public management endpoints,
 *   we define explicitly named `*DesignProjection` types here.
 * - These projections document the expected schema shape for future backend endpoints
 *   without creating competing Run, Task, Conversation, Authorization, Trace, PI,
 *   Channel, or Herdr domain contracts in the database or server runtime.
 */

import type {
  ModelProtocol,
  PublicModelProfile,
  ManagementFailure,
  ManagementStatus,
  ManagementDoctor,
  ChannelConnectionState,
  ChannelSafeError,
  ChannelSaveInput,
  PublicChannelProfile,
  ClaudeExecutorSettings,
  PublicExecutor,
  RunEvalView,
  RunEvalAssessment,
  RunEvalScore,
  RunEvalCheck,
  EvalVerdict,
  RunEvalPage,
} from '@glassbox/contracts';

export {
  MODEL_PROTOCOLS,
  CHANNEL_SAFE_ERRORS,
  RUN_INTEGRITY_SUITE,
} from '@glassbox/contracts';

export type {
  ModelProtocol,
  PublicModelProfile,
  ManagementFailure,
  ManagementStatus,
  ManagementDoctor,
  ChannelConnectionState,
  ChannelSafeError,
  ChannelSaveInput,
  PublicChannelProfile,
  ClaudeExecutorSettings,
  PublicExecutor,
  RunEvalView,
  RunEvalAssessment,
  RunEvalScore,
  RunEvalCheck,
  EvalVerdict,
  RunEvalPage,
};

// ============================================================================
// 1. Mandatory Data Honesty Vocabulary
// ============================================================================

/**
 * Standard implementation truth vocabulary required by DESIGN.md & DESIGN_EVAL.md.
 * Replaces ambiguous labels like 'fixture', 'experimental', or 'planned'.
 */
export type CapabilityState =
  | '已实现'   // Current repository capability exists and works
  | 'P3 目标'  // Required by active P3 plan, not yet implemented in production
  | '设计数据' // Prototype fixture / illustrative data
  | '后续'     // Roadmap capability outside active scope
  | '未知'     // Meaningful field, unavailable value
  | '—';       // Field not applicable

export type CostStatus =
  | 'priced'   // Real USD pricing available
  | 'unpriced' // Pricing model not configured; must display '成本不可用'
  | 'unknown'; // Pricing unknown; must NOT display $0.00

// ============================================================================
// 2. Core Authority & Execution Invariants
// ============================================================================

export type AuthorizationDecision = 'ALLOW' | 'DENY' | 'REQUIRES_APPROVAL';

/**
 * Durable Glassbox Task state (owned by Glassbox product control plane).
 */
export type TaskState =
  | 'NEW'
  | 'QUEUED'
  | 'ASSIGNED'
  | 'RUNNING'
  | 'WAITING_INPUT'
  | 'REVIEW'
  | 'DONE'
  | 'FAILED'
  | 'CANCELED';

/**
 * Observed live Herdr worker lifecycle facts (external execution facts).
 * CRITICAL RULE: Herdr worker 'done' ≠ Glassbox Task 'DONE'.
 */
export type HerdrWorkerState =
  | 'working'
  | 'blocked'
  | 'done'
  | 'idle'
  | 'unknown'
  | 'stale'
  | 'disappeared';

export type AttentionItemType = 'task_review' | 'worker_blocked' | 'requires_approval' | 'system_alert';

export interface AttentionItemDesignProjection {
  id: string;
  type: AttentionItemType;
  title: string;
  description: string;
  severity: 'info' | 'warn' | 'bad';
  targetSection: 'ops' | 'permissions' | 'monitor' | 'conversations';
  targetId?: string;
  createdAt: string;
}
export type AttentionItemProjection = AttentionItemDesignProjection;

// ============================================================================
// 3. UI Design Projections for the 11 Management Pages
// ============================================================================

/** 1. Overview Page Data Projection (Aggregated KPI Rollup) */
export interface OverviewDesignProjection {
  summary: {
    activeConversations: number;
    pendingAttentionCount: number;
    runningTasksCount: number;
    todayTotalTokens: number;
    todayCostUsd: number | null;
    todayCostStatus: CostStatus;
  };
  attentionQueue: AttentionItemDesignProjection[];
  currentRun: RunDesignProjection | null;
  piModelUsage: Array<{
    modelId: string;
    modelName: string;
    callsToday: number;
    tokensToday: number;
    costUsd: number | null;
    costStatus: CostStatus;
    p95LatencyMs: number;
  }>;
  usageTrend: Array<{
    timestamp: string;
    label: string;
    tokens: number;
    runs: number;
  }>;
}
export type OverviewProjection = OverviewDesignProjection;

/** 2. Conversations Page Data Projection */
export interface ConversationDesignProjection {
  id: string;
  title: string;
  principalId: string;
  channel: string;
  channelIdentity: string;
  scope: 'private' | 'group';
  visibility: 'private' | 'shared';
  piSessionId: string;
  runsCount: number;
  tasksCount: number;
  totalTokens: number;
  costUsd: number | null;
  costStatus: CostStatus;
  lastActivityAt: string;
  sanitizedSnippet: string;
  recentMessages: Array<{
    id: string;
    sender: string;
    role: 'user' | 'assistant' | 'system';
    text: string;
    timestamp: string;
  }>;
}
export type ConversationProjection = ConversationDesignProjection;

/** 3. Ops (Task Collaboration) Page Data Projections */
export interface WorkerBindingDesignProjection {
  herdrSession: string;
  workspaceName: string;
  paneName: string;
  workerType: string;
  branch: string;
  lastObservedAt: string;
}
export type WorkerBindingProjection = WorkerBindingDesignProjection;

export interface TaskAttemptDesignProjection {
  attemptNo: number;
  status: 'RUNNING' | 'COMPLETED' | 'FAILED' | 'REWORKED';
  runId: string;
  workerBinding?: WorkerBindingDesignProjection;
  testResults: {
    passed: number;
    total: number;
  };
  artifactUri?: string;
  durationMs: number;
  settledAt?: string;
}
export type TaskAttemptProjection = TaskAttemptDesignProjection;

export interface TaskDesignProjection {
  id: string;
  title: string;
  state: TaskState;
  priority: 'low' | 'normal' | 'high' | 'critical';
  creatorPrincipal: string;
  conversationId: string;
  currentAttemptNo: number;
  attempts: TaskAttemptDesignProjection[];
  herdrState: HerdrWorkerState;
  herdrObservationMeta: string;
  requiresReview: boolean;
  attentionReason?: string;
  createdAt: string;
  updatedAt: string;
}
export type TaskProjection = TaskDesignProjection;

/** 4. Identity & Access Page Data Projections */
export interface ChannelIdentityDesignProjection {
  channel: string;
  channelIdentity: string;
  identity?: string;
  boundAt: string;
  isVerified: boolean;
}
export type ChannelIdentityMapping = ChannelIdentityDesignProjection;

export interface PrincipalDesignProjection {
  id: string;
  userDisplayName: string;
  role: 'owner' | 'visitor' | 'worker' | 'system';
  isVerified: boolean;
  channelIdentities: ChannelIdentityDesignProjection[];
  activeGrants: string[];
  delegationLimit: string;
  lastActiveAt: string;
  notes: string;
}
export type PrincipalProjection = PrincipalDesignProjection;

/** 5. Runs Page Data Projections */
export interface ArtifactDesignProjection {
  name: string;
  uri: string;
  type: string;
  sizeBytes: number;
}
export type ArtifactProjection = ArtifactDesignProjection;

export interface RunDesignProjection {
  id: string;
  conversationId: string;
  principalId: string;
  status: 'completed' | 'running' | 'failed' | 'canceled';
  modelId: string;
  durationMs: number;
  taskAttemptId?: string;
  toolsExecutedCount: number;
  testsPassed?: number;
  testsTotal?: number;
  artifacts: ArtifactDesignProjection[];
  tokens: {
    prompt: number;
    completion: number;
    total: number;
  };
  costUsd: number | null;
  costStatus: CostStatus;
  startedAt: string;
  completedAt?: string;
  traceId: string;
  summary: string;
}
export type RunProjection = RunDesignProjection;

/** 6. Trace Page Data Projections */
export type TraceEventType =
  | 'user'
  | 'authorization'
  | 'system'
  | 'context'
  | 'memory'
  | 'skill'
  | 'thinking'
  | 'tool'
  | 'file'
  | 'test'
  | 'ops'
  | 'delivery'
  | 'assistant'
  | 'error';

export interface TraceAuthorizationDesignProjection {
  decision: AuthorizationDecision;
  principal: string;
  resource: string;
  action: string;
  reason: string;
  location: string;
}
export type TraceAuthorizationDetail = TraceAuthorizationDesignProjection;

export interface TraceEventDesignProjection {
  id: string;
  runId: string;
  sequence: number;
  timestamp: string;
  type: TraceEventType;
  summary: string;
  durationMs?: number;
  authorization?: TraceAuthorizationDesignProjection;
  payload: Record<string, unknown>;
  rawTraceExcerpt?: string;
}
export type TraceEventProjection = TraceEventDesignProjection;

export interface TraceRunDesignSummary {
  runId: string;
  conversationId: string;
  model: string;
  eventCount: number;
  status: 'completed' | 'running' | 'failed' | 'canceled';
  durationMs: number;
  timestamp: string;
}
export type TraceRunSummary = TraceRunDesignSummary;

/** 7. PI Engine Page Data Projection (extends PublicModelProfile with UI metrics) */
export interface PiModelDesignProjection {
  id: string;
  name: string;
  provider: string;
  protocol?: ModelProtocol;
  baseUrl?: string;
  model?: string;
  credentialConfigured?: boolean;
  isDefault: boolean;
  contextWindowTokens: number;
  temperature: number;
  capabilityState: CapabilityState;
  tokensToday: number;
  costTodayUsd: number | null;
  costStatus: CostStatus;
  lastError?: string;
  activeSessionsCount: number;
}
export type PiModelProjection = PiModelDesignProjection;

/** Canonical mapping from PublicModelProfile to PiModelDesignProjection */
export function mapModelProfileToDesignProjection(
  profile: PublicModelProfile,
  overrides?: Partial<PiModelDesignProjection>,
): PiModelDesignProjection {
  return {
    id: profile.id,
    name: profile.label,
    provider: profile.protocol,
    protocol: profile.protocol,
    baseUrl: profile.baseUrl,
    model: profile.model,
    credentialConfigured: profile.credentialConfigured,
    isDefault: overrides?.isDefault ?? false,
    contextWindowTokens: overrides?.contextWindowTokens ?? 128000,
    temperature: overrides?.temperature ?? 0.7,
    capabilityState: profile.credentialConfigured ? '已实现' : 'P3 目标',
    tokensToday: overrides?.tokensToday ?? 0,
    costTodayUsd: overrides?.costTodayUsd ?? null,
    costStatus: overrides?.costStatus ?? 'unpriced',
    activeSessionsCount: overrides?.activeSessionsCount ?? 0,
    ...overrides,
  };
}

/** 8. Channels & Integrations Page Data Projection (maps to PublicChannelProfile) */
export interface ChannelDesignProjection {
  id: string;
  name: string;
  type: 'onebot' | 'web' | 'email' | 'api';
  status: 'connected' | 'reconnecting' | 'disconnected' | 'error';
  connectionState?: ChannelConnectionState;
  targetAgent: string;
  ingressPolicy: string;
  deliveryPolicy: string;
  totalEventsProcessed: number;
  blockedDeliveriesCount: number;
  lastEventAt: string;
  autoConnect?: boolean;
  tokenConfigured?: boolean;
  recentAuditLogs: Array<{
    id: string;
    direction: 'ingress' | 'delivery';
    identity: string;
    action: string;
    decision: AuthorizationDecision;
    timestamp: string;
  }>;
}
export type ChannelProjection = ChannelDesignProjection;

/** Canonical mapping from PublicChannelProfile to ChannelDesignProjection */
export function mapChannelProfileToDesignProjection(
  profile: PublicChannelProfile,
  overrides?: Partial<ChannelDesignProjection>,
): ChannelDesignProjection {
  const statusMap: Record<ChannelConnectionState, ChannelDesignProjection['status']> = {
    connected: 'connected',
    connecting: 'reconnecting',
    disconnected: 'disconnected',
    error: 'error',
  };

  return {
    id: profile.id,
    name: profile.label,
    type: profile.kind === 'qq-onebot' ? 'onebot' : 'api',
    status: statusMap[profile.connectionState] || 'disconnected',
    connectionState: profile.connectionState,
    autoConnect: profile.autoConnect,
    tokenConfigured: profile.tokenConfigured,
    targetAgent: overrides?.targetAgent ?? 'Glassbox Personal Agent (Main)',
    ingressPolicy: overrides?.ingressPolicy ?? 'Strict Group Allowlist + Owner Direct',
    deliveryPolicy: overrides?.deliveryPolicy ?? 'Private Canary Screening + Delivery Gate',
    totalEventsProcessed: overrides?.totalEventsProcessed ?? 0,
    blockedDeliveriesCount: overrides?.blockedDeliveriesCount ?? 0,
    lastEventAt: overrides?.lastEventAt ?? '—',
    recentAuditLogs: overrides?.recentAuditLogs ?? [],
    ...overrides,
  };
}

/** 9. Permissions & Gates Page Data Projections */
export interface PermissionRuleDesignProjection {
  id: string;
  principalPattern: string;
  resourcePattern: string;
  action: string;
  decision: AuthorizationDecision;
  isHardGate: boolean;
  explanation: string;
}
export type PermissionRuleProjection = PermissionRuleDesignProjection;

export interface DecisionTesterInput {
  principal: string;
  resource: string;
  action: string;
  channel: string;
  location: string;
}

export interface DecisionTesterDesignResult {
  decision: AuthorizationDecision;
  matchedRuleId?: string;
  provenance: string;
  isSimulationOnly: true;
}
export type DecisionTesterResult = DecisionTesterDesignResult;

/** 10. Monitor Page Data Projection */
export interface MonitorTelemetryDesignProjection {
  systemHealth: 'healthy' | 'degraded' | 'critical';
  piEngine: {
    status: 'healthy' | 'slow' | 'down';
    p95LatencyMs: number;
    activeSessions: number;
  };
  herdrBridge: {
    status: 'connected' | 'disconnected' | 'stale';
    activeWorkspaces: number;
    activePanes: number;
    lastHeartbeat: string;
  };
  persistence: {
    tursoStatus: 'healthy' | 'unreachable';
    r2Status: 'healthy' | 'unreachable';
  };
  webSocketConnected: boolean;
  alerts: Array<{
    id: string;
    severity: 'warn' | 'bad';
    message: string;
    timestamp: string;
  }>;
  latencyTrend: Array<{
    timestamp: string;
    p50: number;
    p95: number;
  }>;
}
export type MonitorTelemetryProjection = MonitorTelemetryDesignProjection;

/** 11. Settings Page Data Projection */
export interface SettingsDesignProjection {
  retentionDays: number;
  unknownPricingDisplay: 'show_unknown' | 'hide_cost';
  defaultChannelPolicy: 'owner_only' | 'strict_allowlist';
  autoReviewOnWorkerDone: boolean;
  colorBlindMode: boolean;
  enableTraceKeyboardShortcuts: boolean;
  isLocalDraftDirty: boolean;
}
export type SettingsProjection = SettingsDesignProjection;
