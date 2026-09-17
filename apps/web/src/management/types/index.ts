/**
 * @file apps/web/src/management/types/index.ts
 *
 * Explicit domain types and UI projections for the Glassbox Web Management UI.
 *
 * MAPPING GAP & CONTRACT GOVERNANCE:
 * - In accordance with repository rules, UI projections reference canonical concepts
 *   from @glassbox/contracts (Conversation, Run, Task, TaskAttempt, WorkerBinding,
 *   Authorization, Trace, PI, Channel, Herdr).
 * - Where backend contracts do not yet expose live operations/reconciler endpoints,
 *   we define explicitly named `*Projection` contracts here.
 * - These projections document the expected schema shape for future backend endpoints
 *   without defining competing domain contracts in the database or server runtime.
 */

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

export interface AttentionItemProjection {
  id: string;
  type: AttentionItemType;
  title: string;
  description: string;
  severity: 'info' | 'warn' | 'bad';
  targetSection: 'ops' | 'permissions' | 'monitor' | 'conversations';
  targetId?: string;
  createdAt: string;
}

// ============================================================================
// 3. UI Projections for the 11 Management Pages
// ============================================================================

/** 1. Overview Page Data */
export interface OverviewProjection {
  summary: {
    activeConversations: number;
    pendingAttentionCount: number;
    runningTasksCount: number;
    todayTotalTokens: number;
    todayCostUsd: number | null;
    todayCostStatus: CostStatus;
  };
  attentionQueue: AttentionItemProjection[];
  currentRun: RunProjection | null;
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

/** 2. Conversations Page Data */
export interface ConversationProjection {
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

/** 3. Ops (Task Collaboration) Page Data */
export interface WorkerBindingProjection {
  herdrSession: string;
  workspaceName: string;
  paneName: string;
  workerType: string;
  branch: string;
  lastObservedAt: string;
}

export interface TaskAttemptProjection {
  attemptNo: number;
  status: 'RUNNING' | 'COMPLETED' | 'FAILED' | 'REWORKED';
  runId: string;
  workerBinding: WorkerBindingProjection;
  testResults: {
    passed: number;
    total: number;
  };
  artifactUri?: string;
  durationMs: number;
  settledAt?: string;
}

export interface TaskProjection {
  id: string;
  title: string;
  state: TaskState;
  priority: 'low' | 'normal' | 'high' | 'critical';
  creatorPrincipal: string;
  conversationId: string;
  currentAttemptNo: number;
  attempts: TaskAttemptProjection[];
  herdrState: HerdrWorkerState;
  herdrObservationMeta: string;
  requiresReview: boolean;
  attentionReason?: string;
  createdAt: string;
  updatedAt: string;
}

/** 4. Identity & Access Page Data */
export interface ChannelIdentityMapping {
  channel: string;
  channelIdentity: string;
  identity?: string;
  boundAt: string;
  isVerified: boolean;
}

export interface PrincipalProjection {
  id: string;
  userDisplayName: string;
  role: 'owner' | 'visitor' | 'worker' | 'system';
  isVerified: boolean;
  channelIdentities: ChannelIdentityMapping[];
  activeGrants: string[];
  delegationLimit: string;
  lastActiveAt: string;
  notes: string;
}

/** 5. Runs Page Data */
export interface ArtifactProjection {
  name: string;
  uri: string;
  type: string;
  sizeBytes: number;
}

export interface RunProjection {
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
  artifacts: ArtifactProjection[];
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

/** 6. Trace Page Data */
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

export interface TraceAuthorizationDetail {
  decision: AuthorizationDecision;
  principal: string;
  resource: string;
  action: string;
  reason: string;
  location: string;
}

export interface TraceEventProjection {
  id: string;
  runId: string;
  sequence: number;
  timestamp: string;
  type: TraceEventType;
  summary: string;
  durationMs?: number;
  authorization?: TraceAuthorizationDetail;
  payload: Record<string, unknown>;
  rawTraceExcerpt?: string;
}

export interface TraceRunSummary {
  runId: string;
  conversationId: string;
  model: string;
  eventCount: number;
  status: 'completed' | 'running' | 'failed' | 'canceled';
  durationMs: number;
  timestamp: string;
}

/** 7. PI Engine Page Data */
export interface PiModelProjection {
  id: string;
  name: string;
  provider: string;
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

/** 8. Channels & Integrations Page Data */
export interface ChannelProjection {
  id: string;
  name: string;
  type: 'onebot' | 'web' | 'email' | 'api';
  status: 'connected' | 'reconnecting' | 'disconnected' | 'error';
  targetAgent: string;
  ingressPolicy: string;
  deliveryPolicy: string;
  totalEventsProcessed: number;
  blockedDeliveriesCount: number;
  lastEventAt: string;
  recentAuditLogs: Array<{
    id: string;
    direction: 'ingress' | 'delivery';
    identity: string;
    action: string;
    decision: AuthorizationDecision;
    timestamp: string;
  }>;
}

/** 9. Permissions & Gates Page Data */
export interface PermissionRuleProjection {
  id: string;
  principalPattern: string;
  resourcePattern: string;
  action: string;
  decision: AuthorizationDecision;
  isHardGate: boolean;
  explanation: string;
}

export interface DecisionTesterInput {
  principal: string;
  resource: string;
  action: string;
  channel: string;
  location: string;
}

export interface DecisionTesterResult {
  decision: AuthorizationDecision;
  matchedRuleId?: string;
  provenance: string;
  isSimulationOnly: true;
}

/** 10. Monitor Page Data */
export interface MonitorTelemetryProjection {
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

/** 11. Settings Page Data */
export interface SettingsProjection {
  retentionDays: number;
  unknownPricingDisplay: 'show_unknown' | 'hide_cost';
  defaultChannelPolicy: 'owner_only' | 'strict_allowlist';
  autoReviewOnWorkerDone: boolean;
  colorBlindMode: boolean;
  enableTraceKeyboardShortcuts: boolean;
  isLocalDraftDirty: boolean;
}
