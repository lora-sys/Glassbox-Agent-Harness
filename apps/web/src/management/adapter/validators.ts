/**
 * @file apps/web/src/management/adapter/validators.ts
 *
 * Runtime validation for untrusted API responses from /manage endpoints.
 * Ensures malformed, corrupted, or injected payloads are rejected before rendering.
 */
import type {
  ManagementStatus,
  ManagementDoctor,
  PublicModelProfile,
  PublicChannelProfile,
  PublicExecutor,
} from '@glassbox/contracts';
import type {
  ConversationDesignProjection,
  TaskDesignProjection,
  WorkerBindingDesignProjection,
  TaskAttemptDesignProjection,
  PrincipalDesignProjection,
  ChannelIdentityDesignProjection,
  RunDesignProjection,
  ArtifactDesignProjection,
  TraceRunDesignSummary,
  TraceEventDesignProjection,
  TraceAuthorizationDesignProjection,
  PermissionRuleDesignProjection,
  MonitorTelemetryDesignProjection,
  SettingsDesignProjection,
} from '../types';

export class PayloadValidationError extends Error {
  constructor(message: string) {
    super(`PayloadValidationError: ${message}`);
    this.name = 'PayloadValidationError';
  }
}

export const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;

export function isValidManagementToken(token: unknown): token is string {
  return typeof token === 'string' && TOKEN_PATTERN.test(token.trim());
}

export function validateManagementStatus(val: unknown): ManagementStatus {
  if (!val || typeof val !== 'object') {
    throw new PayloadValidationError('Expected object for ManagementStatus');
  }
  const obj = val as Record<string, unknown>;
  if (obj.service !== 'glassbox') {
    throw new PayloadValidationError(`Invalid service in status: ${String(obj.service)}`);
  }
  if (obj.status !== 'ready') {
    throw new PayloadValidationError(`Invalid status: ${String(obj.status)}`);
  }
  if (typeof obj.version !== 'string') {
    throw new PayloadValidationError('Missing version in ManagementStatus');
  }
  if (!obj.capabilities || typeof obj.capabilities !== 'object') {
    throw new PayloadValidationError('Missing capabilities in ManagementStatus');
  }
  return val as ManagementStatus;
}

export function validateManagementDoctor(val: unknown): ManagementDoctor {
  if (!val || typeof val !== 'object') {
    throw new PayloadValidationError('Expected object for ManagementDoctor');
  }
  const obj = val as Record<string, unknown>;
  if (!Array.isArray(obj.checks)) {
    throw new PayloadValidationError('Missing checks array in ManagementDoctor');
  }
  for (const check of obj.checks) {
    if (!check || typeof check !== 'object') {
      throw new PayloadValidationError('Invalid check item in ManagementDoctor');
    }
    const c = check as Record<string, unknown>;
    if (typeof c.id !== 'string' || typeof c.label !== 'string' || typeof c.status !== 'string') {
      throw new PayloadValidationError('Malformed check item in ManagementDoctor');
    }
  }
  return val as ManagementDoctor;
}

export function validatePublicModelProfile(val: unknown): PublicModelProfile {
  if (!val || typeof val !== 'object') {
    throw new PayloadValidationError('Expected object for PublicModelProfile');
  }
  const obj = val as Record<string, unknown>;
  if (typeof obj.id !== 'string' || !obj.id) {
    throw new PayloadValidationError('Missing model profile id');
  }
  if (typeof obj.label !== 'string') {
    throw new PayloadValidationError('Missing model profile label');
  }
  if (typeof obj.protocol !== 'string') {
    throw new PayloadValidationError('Missing model profile protocol');
  }
  if (typeof obj.baseUrl !== 'string') {
    throw new PayloadValidationError('Missing model profile baseUrl');
  }
  if (typeof obj.model !== 'string') {
    throw new PayloadValidationError('Missing model profile model name');
  }
  if (typeof obj.credentialConfigured !== 'boolean') {
    throw new PayloadValidationError('Missing credentialConfigured boolean');
  }
  return val as PublicModelProfile;
}

export function validateModelsResponse(val: unknown): { profiles: PublicModelProfile[] } {
  if (!val || typeof val !== 'object') {
    throw new PayloadValidationError('Expected object for /manage/models response');
  }
  const obj = val as Record<string, unknown>;
  if (!Array.isArray(obj.profiles)) {
    throw new PayloadValidationError('Expected profiles array in /manage/models response');
  }
  return {
    profiles: obj.profiles.map(validatePublicModelProfile),
  };
}

export function validatePublicChannelProfile(val: unknown): PublicChannelProfile {
  if (!val || typeof val !== 'object') {
    throw new PayloadValidationError('Expected object for PublicChannelProfile');
  }
  const obj = val as Record<string, unknown>;
  if (typeof obj.id !== 'string' || !obj.id) {
    throw new PayloadValidationError('Missing channel id');
  }
  if (typeof obj.label !== 'string') {
    throw new PayloadValidationError('Missing channel label');
  }
  if (obj.kind !== 'qq-onebot') {
    throw new PayloadValidationError(`Unsupported channel kind: ${String(obj.kind)}`);
  }
  if (typeof obj.endpoint !== 'string') {
    throw new PayloadValidationError('Missing channel endpoint');
  }
  if (typeof obj.botId !== 'string') {
    throw new PayloadValidationError('Missing channel botId');
  }
  if (typeof obj.ownerId !== 'string') {
    throw new PayloadValidationError('Missing channel ownerId');
  }
  if (!Array.isArray(obj.groupIds)) {
    throw new PayloadValidationError('Missing channel groupIds');
  }
  if (typeof obj.tokenConfigured !== 'boolean') {
    throw new PayloadValidationError('Missing tokenConfigured');
  }
  if (typeof obj.autoConnect !== 'boolean') {
    throw new PayloadValidationError('Missing autoConnect');
  }
  const validStates = ['disconnected', 'connecting', 'connected', 'error'];
  if (typeof obj.connectionState !== 'string' || !validStates.includes(obj.connectionState)) {
    throw new PayloadValidationError(`Invalid connectionState: ${String(obj.connectionState)}`);
  }
  return val as PublicChannelProfile;
}

export function validateChannelsResponse(val: unknown): { channels: PublicChannelProfile[] } {
  if (!val || typeof val !== 'object') {
    throw new PayloadValidationError('Expected object for /manage/channels response');
  }
  const obj = val as Record<string, unknown>;
  if (!Array.isArray(obj.channels)) {
    throw new PayloadValidationError('Expected channels array in /manage/channels response');
  }
  return {
    channels: obj.channels.map(validatePublicChannelProfile),
  };
}

export function validateExecutorsResponse(val: unknown): { executors: PublicExecutor[] } {
  if (!val || typeof val !== 'object') {
    throw new PayloadValidationError('Expected object for /manage/executors response');
  }
  const obj = val as Record<string, unknown>;
  if (!Array.isArray(obj.executors)) {
    throw new PayloadValidationError('Expected executors array in /manage/executors response');
  }
  return val as { executors: PublicExecutor[] };
}

export function validateWsTicketResponse(val: unknown): { ticket: string } {
  if (!val || typeof val !== 'object') {
    throw new PayloadValidationError('Expected object for /manage/ws-ticket response');
  }
  const obj = val as Record<string, unknown>;
  if (typeof obj.ticket !== 'string' || obj.ticket.length === 0) {
    throw new PayloadValidationError('Missing or empty ticket in ws-ticket response');
  }
  return { ticket: obj.ticket };
}

// ============================================================================
// Internal Validation Assertion Helpers
// ============================================================================

function assertObject(val: unknown, path: string): Record<string, unknown> {
  if (!val || typeof val !== 'object' || Array.isArray(val)) {
    throw new PayloadValidationError(`Expected object at ${path}`);
  }
  return val as Record<string, unknown>;
}

function assertArray(val: unknown, path: string): unknown[] {
  if (!Array.isArray(val)) {
    throw new PayloadValidationError(`Expected array at ${path}`);
  }
  return val;
}

function assertString(val: unknown, path: string): string {
  if (typeof val !== 'string') {
    throw new PayloadValidationError(`Expected string at ${path}`);
  }
  return val;
}

function assertNumber(val: unknown, path: string): number {
  if (typeof val !== 'number' || Number.isNaN(val)) {
    throw new PayloadValidationError(`Expected number at ${path}`);
  }
  return val;
}

function assertBoolean(val: unknown, path: string): boolean {
  if (typeof val !== 'boolean') {
    throw new PayloadValidationError(`Expected boolean at ${path}`);
  }
  return val;
}

function assertEnum<T extends string>(val: unknown, allowed: readonly T[], path: string): T {
  if (typeof val !== 'string' || !allowed.includes(val as T)) {
    throw new PayloadValidationError(`Invalid enum at ${path}: expected one of [${allowed.join(', ')}], got ${JSON.stringify(val)}`);
  }
  return val as T;
}

function assertCostUsd(val: unknown, path: string): number | null {
  if (val === null) return null;
  if (typeof val === 'number' && !Number.isNaN(val)) return val;
  throw new PayloadValidationError(`Expected number or null for cost at ${path}, got ${val === undefined ? 'undefined' : JSON.stringify(val)}`);
}

// ============================================================================
// 1. Conversations Runtime Validation
// ============================================================================

export function validateConversation(val: unknown, path = 'conversation'): ConversationDesignProjection {
  const obj = assertObject(val, path);
  const id = assertString(obj.id, `${path}.id`);
  const title = assertString(obj.title, `${path}.title`);
  const principalId = assertString(obj.principalId, `${path}.principalId`);
  const channel = assertString(obj.channel, `${path}.channel`);
  const channelIdentity = assertString(obj.channelIdentity, `${path}.channelIdentity`);
  const scope = assertEnum(obj.scope, ['private', 'group'] as const, `${path}.scope`);
  const visibility = assertEnum(obj.visibility, ['private', 'shared'] as const, `${path}.visibility`);
  const piSessionId = assertString(obj.piSessionId, `${path}.piSessionId`);
  const runsCount = assertNumber(obj.runsCount, `${path}.runsCount`);
  const tasksCount = assertNumber(obj.tasksCount, `${path}.tasksCount`);
  const totalTokens = assertNumber(obj.totalTokens, `${path}.totalTokens`);
  const costUsd = assertCostUsd(obj.costUsd, `${path}.costUsd`);
  const costStatus = assertEnum(obj.costStatus, ['priced', 'unpriced', 'unknown'] as const, `${path}.costStatus`);
  const lastActivityAt = assertString(obj.lastActivityAt, `${path}.lastActivityAt`);
  const sanitizedSnippet = assertString(obj.sanitizedSnippet, `${path}.sanitizedSnippet`);
  const rawMessages = assertArray(obj.recentMessages, `${path}.recentMessages`);
  const recentMessages = rawMessages.map((m, idx) => {
    const mObj = assertObject(m, `${path}.recentMessages[${idx}]`);
    return {
      id: assertString(mObj.id, `${path}.recentMessages[${idx}].id`),
      sender: assertString(mObj.sender, `${path}.recentMessages[${idx}].sender`),
      role: assertEnum(mObj.role, ['user', 'assistant', 'system'] as const, `${path}.recentMessages[${idx}].role`),
      text: assertString(mObj.text, `${path}.recentMessages[${idx}].text`),
      timestamp: assertString(mObj.timestamp, `${path}.recentMessages[${idx}].timestamp`),
    };
  });

  return {
    id,
    title,
    principalId,
    channel,
    channelIdentity,
    scope,
    visibility,
    piSessionId,
    runsCount,
    tasksCount,
    totalTokens,
    costUsd,
    costStatus,
    lastActivityAt,
    sanitizedSnippet,
    recentMessages,
  };
}

export function validateConversationsResponse(val: unknown): ConversationDesignProjection[] {
  if (Array.isArray(val)) {
    return val.map((item, idx) => validateConversation(item, `conversations[${idx}]`));
  }
  if (val && typeof val === 'object' && Array.isArray((val as Record<string, unknown>).conversations)) {
    return ((val as Record<string, unknown>).conversations as unknown[]).map((item, idx) =>
      validateConversation(item, `conversations[${idx}]`),
    );
  }
  throw new PayloadValidationError('Expected array or object with conversations array for /manage/conversations');
}

// ============================================================================
// 2. Tasks Runtime Validation
// ============================================================================

export function validateWorkerBinding(val: unknown, path = 'workerBinding'): WorkerBindingDesignProjection {
  const obj = assertObject(val, path);
  return {
    herdrSession: assertString(obj.herdrSession, `${path}.herdrSession`),
    workspaceName: assertString(obj.workspaceName, `${path}.workspaceName`),
    paneName: assertString(obj.paneName, `${path}.paneName`),
    workerType: assertString(obj.workerType, `${path}.workerType`),
    branch: assertString(obj.branch, `${path}.branch`),
    lastObservedAt: assertString(obj.lastObservedAt, `${path}.lastObservedAt`),
  };
}

export function validateTaskAttempt(val: unknown, path = 'attempt'): TaskAttemptDesignProjection {
  const obj = assertObject(val, path);
  const testResultsObj = assertObject(obj.testResults, `${path}.testResults`);
  return {
    attemptNo: assertNumber(obj.attemptNo, `${path}.attemptNo`),
    status: assertEnum(obj.status, ['RUNNING', 'COMPLETED', 'FAILED', 'REWORKED'] as const, `${path}.status`),
    runId: assertString(obj.runId, `${path}.runId`),
    workerBinding:
      obj.workerBinding !== undefined && obj.workerBinding !== null
        ? validateWorkerBinding(obj.workerBinding, `${path}.workerBinding`)
        : undefined,
    testResults: {
      passed: assertNumber(testResultsObj.passed, `${path}.testResults.passed`),
      total: assertNumber(testResultsObj.total, `${path}.testResults.total`),
    },
    artifactUri: typeof obj.artifactUri === 'string' ? obj.artifactUri : undefined,
    durationMs: assertNumber(obj.durationMs, `${path}.durationMs`),
    settledAt: typeof obj.settledAt === 'string' ? obj.settledAt : undefined,
  };
}

export function validateTask(val: unknown, path = 'task'): TaskDesignProjection {
  const obj = assertObject(val, path);
  const rawAttempts = assertArray(obj.attempts, `${path}.attempts`);
  return {
    id: assertString(obj.id, `${path}.id`),
    title: assertString(obj.title, `${path}.title`),
    state: assertEnum(
      obj.state,
      ['NEW', 'QUEUED', 'ASSIGNED', 'RUNNING', 'WAITING_INPUT', 'REVIEW', 'DONE', 'FAILED', 'CANCELED'] as const,
      `${path}.state`,
    ),
    priority: assertEnum(obj.priority, ['low', 'normal', 'high', 'critical'] as const, `${path}.priority`),
    creatorPrincipal: assertString(obj.creatorPrincipal, `${path}.creatorPrincipal`),
    conversationId: assertString(obj.conversationId, `${path}.conversationId`),
    currentAttemptNo: assertNumber(obj.currentAttemptNo, `${path}.currentAttemptNo`),
    attempts: rawAttempts.map((a, idx) => validateTaskAttempt(a, `${path}.attempts[${idx}]`)),
    herdrState: assertEnum(
      obj.herdrState,
      ['working', 'blocked', 'done', 'idle', 'unknown', 'stale', 'disappeared'] as const,
      `${path}.herdrState`,
    ),
    herdrObservationMeta: assertString(obj.herdrObservationMeta, `${path}.herdrObservationMeta`),
    requiresReview: assertBoolean(obj.requiresReview, `${path}.requiresReview`),
    attentionReason: typeof obj.attentionReason === 'string' ? obj.attentionReason : undefined,
    createdAt: assertString(obj.createdAt, `${path}.createdAt`),
    updatedAt: assertString(obj.updatedAt, `${path}.updatedAt`),
  };
}

export function validateTasksResponse(val: unknown): TaskDesignProjection[] {
  if (Array.isArray(val)) {
    return val.map((item, idx) => validateTask(item, `tasks[${idx}]`));
  }
  if (val && typeof val === 'object' && Array.isArray((val as Record<string, unknown>).tasks)) {
    return ((val as Record<string, unknown>).tasks as unknown[]).map((item, idx) =>
      validateTask(item, `tasks[${idx}]`),
    );
  }
  throw new PayloadValidationError('Expected array or object with tasks array for /manage/tasks');
}

// ============================================================================
// 3. Principals Runtime Validation
// ============================================================================

export function validateChannelIdentity(val: unknown, path = 'channelIdentity'): ChannelIdentityDesignProjection {
  const obj = assertObject(val, path);
  return {
    channel: assertString(obj.channel, `${path}.channel`),
    channelIdentity: assertString(obj.channelIdentity, `${path}.channelIdentity`),
    identity: typeof obj.identity === 'string' ? obj.identity : undefined,
    boundAt: assertString(obj.boundAt, `${path}.boundAt`),
    isVerified: assertBoolean(obj.isVerified, `${path}.isVerified`),
  };
}

export function validatePrincipal(val: unknown, path = 'principal'): PrincipalDesignProjection {
  const obj = assertObject(val, path);
  const rawChans = assertArray(obj.channelIdentities, `${path}.channelIdentities`);
  const rawGrants = assertArray(obj.activeGrants, `${path}.activeGrants`);
  return {
    id: assertString(obj.id, `${path}.id`),
    userDisplayName: assertString(obj.userDisplayName, `${path}.userDisplayName`),
    role: assertEnum(obj.role, ['owner', 'visitor', 'worker', 'system'] as const, `${path}.role`),
    isVerified: assertBoolean(obj.isVerified, `${path}.isVerified`),
    channelIdentities: rawChans.map((c, idx) => validateChannelIdentity(c, `${path}.channelIdentities[${idx}]`)),
    activeGrants: rawGrants.map((g, idx) => assertString(g, `${path}.activeGrants[${idx}]`)),
    delegationLimit: assertString(obj.delegationLimit, `${path}.delegationLimit`),
    lastActiveAt: assertString(obj.lastActiveAt, `${path}.lastActiveAt`),
    notes: assertString(obj.notes, `${path}.notes`),
  };
}

export function validatePrincipalsResponse(val: unknown): PrincipalDesignProjection[] {
  if (Array.isArray(val)) {
    return val.map((item, idx) => validatePrincipal(item, `principals[${idx}]`));
  }
  if (val && typeof val === 'object' && Array.isArray((val as Record<string, unknown>).principals)) {
    return ((val as Record<string, unknown>).principals as unknown[]).map((item, idx) =>
      validatePrincipal(item, `principals[${idx}]`),
    );
  }
  throw new PayloadValidationError('Expected array or object with principals array for /manage/principals');
}

// ============================================================================
// 4. Runs Runtime Validation
// ============================================================================

export function validateArtifact(val: unknown, path = 'artifact'): ArtifactDesignProjection {
  const obj = assertObject(val, path);
  return {
    name: assertString(obj.name, `${path}.name`),
    uri: assertString(obj.uri, `${path}.uri`),
    type: assertString(obj.type, `${path}.type`),
    sizeBytes: assertNumber(obj.sizeBytes, `${path}.sizeBytes`),
  };
}

export function validateRun(val: unknown, path = 'run'): RunDesignProjection {
  const obj = assertObject(val, path);
  const tokensObj = assertObject(obj.tokens, `${path}.tokens`);
  const rawArtifacts = assertArray(obj.artifacts, `${path}.artifacts`);
  return {
    id: assertString(obj.id, `${path}.id`),
    conversationId: assertString(obj.conversationId, `${path}.conversationId`),
    principalId: assertString(obj.principalId, `${path}.principalId`),
    status: assertEnum(obj.status, ['completed', 'running', 'failed', 'canceled'] as const, `${path}.status`),
    modelId: assertString(obj.modelId, `${path}.modelId`),
    durationMs: assertNumber(obj.durationMs, `${path}.durationMs`),
    taskAttemptId: typeof obj.taskAttemptId === 'string' ? obj.taskAttemptId : undefined,
    toolsExecutedCount: assertNumber(obj.toolsExecutedCount, `${path}.toolsExecutedCount`),
    testsPassed: typeof obj.testsPassed === 'number' ? assertNumber(obj.testsPassed, `${path}.testsPassed`) : undefined,
    testsTotal: typeof obj.testsTotal === 'number' ? assertNumber(obj.testsTotal, `${path}.testsTotal`) : undefined,
    artifacts: rawArtifacts.map((a, idx) => validateArtifact(a, `${path}.artifacts[${idx}]`)),
    tokens: {
      prompt: assertNumber(tokensObj.prompt, `${path}.tokens.prompt`),
      completion: assertNumber(tokensObj.completion, `${path}.tokens.completion`),
      total: assertNumber(tokensObj.total, `${path}.tokens.total`),
    },
    costUsd: assertCostUsd(obj.costUsd, `${path}.costUsd`),
    costStatus: assertEnum(obj.costStatus, ['priced', 'unpriced', 'unknown'] as const, `${path}.costStatus`),
    startedAt: assertString(obj.startedAt, `${path}.startedAt`),
    completedAt: typeof obj.completedAt === 'string' ? obj.completedAt : undefined,
    traceId: assertString(obj.traceId, `${path}.traceId`),
    summary: assertString(obj.summary, `${path}.summary`),
  };
}

export function validateRunsResponse(val: unknown): RunDesignProjection[] {
  if (Array.isArray(val)) {
    return val.map((item, idx) => validateRun(item, `runs[${idx}]`));
  }
  if (val && typeof val === 'object' && Array.isArray((val as Record<string, unknown>).runs)) {
    return ((val as Record<string, unknown>).runs as unknown[]).map((item, idx) =>
      validateRun(item, `runs[${idx}]`),
    );
  }
  throw new PayloadValidationError('Expected array or object with runs array for /manage/runs');
}

// ============================================================================
// 5. Trace Run Summaries Runtime Validation
// ============================================================================

export function validateTraceRunSummary(val: unknown, path = 'traceRunSummary'): TraceRunDesignSummary {
  const obj = assertObject(val, path);
  return {
    runId: assertString(obj.runId, `${path}.runId`),
    conversationId: assertString(obj.conversationId, `${path}.conversationId`),
    model: assertString(obj.model, `${path}.model`),
    eventCount: typeof obj.eventCount === 'number' && Number.isFinite(obj.eventCount) ? obj.eventCount : null,
    status: assertEnum(obj.status, ['completed', 'running', 'failed', 'canceled'] as const, `${path}.status`),
    durationMs: assertNumber(obj.durationMs, `${path}.durationMs`),
    timestamp: assertString(obj.timestamp, `${path}.timestamp`),
  };
}

export function validateTraceRunSummariesResponse(val: unknown): TraceRunDesignSummary[] {
  if (Array.isArray(val)) {
    return val.map((item, idx) => validateTraceRunSummary(item, `traceRunSummaries[${idx}]`));
  }
  if (val && typeof val === 'object') {
    const record = val as Record<string, unknown>;
    if (Array.isArray(record.summaries)) {
      return (record.summaries as unknown[]).map((item, idx) =>
        validateTraceRunSummary(item, `traceRunSummaries[${idx}]`),
      );
    }
    if (Array.isArray(record.runs)) {
      return (record.runs as unknown[]).map((item, idx) =>
        validateTraceRunSummary(item, `traceRunSummaries[${idx}]`),
      );
    }
  }
  throw new PayloadValidationError('Expected array or object with summaries array for trace runs');
}

// ============================================================================
// 6. Trace Events Runtime Validation
// ============================================================================

export function validateTraceAuthorization(val: unknown, path = 'authorization'): TraceAuthorizationDesignProjection {
  const obj = assertObject(val, path);
  return {
    decision: assertEnum(obj.decision, ['ALLOW', 'DENY', 'REQUIRES_APPROVAL'] as const, `${path}.decision`),
    principal: assertString(obj.principal, `${path}.principal`),
    resource: assertString(obj.resource, `${path}.resource`),
    action: assertString(obj.action, `${path}.action`),
    reason: assertString(obj.reason, `${path}.reason`),
    location: assertString(obj.location, `${path}.location`),
  };
}

export function validateTraceEvent(val: unknown, path = 'traceEvent'): TraceEventDesignProjection {
  const obj = assertObject(val, path);
  return {
    id: assertString(obj.id, `${path}.id`),
    runId: assertString(obj.runId, `${path}.runId`),
    sequence: assertNumber(obj.sequence, `${path}.sequence`),
    timestamp: assertString(obj.timestamp, `${path}.timestamp`),
    type: assertEnum(
      obj.type,
      [
        'user',
        'authorization',
        'system',
        'context',
        'memory',
        'skill',
        'thinking',
        'tool',
        'file',
        'test',
        'ops',
        'delivery',
        'assistant',
        'error',
      ] as const,
      `${path}.type`,
    ),
    summary: assertString(obj.summary, `${path}.summary`),
    durationMs: typeof obj.durationMs === 'number' ? assertNumber(obj.durationMs, `${path}.durationMs`) : undefined,
    authorization:
      obj.authorization !== undefined && obj.authorization !== null
        ? validateTraceAuthorization(obj.authorization, `${path}.authorization`)
        : undefined,
    payload: assertObject(obj.payload, `${path}.payload`),
    rawTraceExcerpt: typeof obj.rawTraceExcerpt === 'string' ? obj.rawTraceExcerpt : undefined,
  };
}

export function validateTraceEventsResponse(val: unknown): TraceEventDesignProjection[] {
  if (Array.isArray(val)) {
    return val.map((item, idx) => validateTraceEvent(item, `traceEvents[${idx}]`));
  }
  if (val && typeof val === 'object' && Array.isArray((val as Record<string, unknown>).events)) {
    return ((val as Record<string, unknown>).events as unknown[]).map((item, idx) =>
      validateTraceEvent(item, `traceEvents[${idx}]`),
    );
  }
  throw new PayloadValidationError('Expected array or object with events array for trace events');
}

// ============================================================================
// 7. Permission Rules Runtime Validation
// ============================================================================

export function validatePermissionRule(val: unknown, path = 'permissionRule'): PermissionRuleDesignProjection {
  const obj = assertObject(val, path);
  return {
    id: assertString(obj.id, `${path}.id`),
    principalPattern: assertString(obj.principalPattern, `${path}.principalPattern`),
    resourcePattern: assertString(obj.resourcePattern, `${path}.resourcePattern`),
    action: assertString(obj.action, `${path}.action`),
    decision: assertEnum(obj.decision, ['ALLOW', 'DENY', 'REQUIRES_APPROVAL'] as const, `${path}.decision`),
    isHardGate: assertBoolean(obj.isHardGate, `${path}.isHardGate`),
    explanation: assertString(obj.explanation, `${path}.explanation`),
  };
}

export function validatePermissionRulesResponse(val: unknown): PermissionRuleDesignProjection[] {
  if (Array.isArray(val)) {
    return val.map((item, idx) => validatePermissionRule(item, `permissionRules[${idx}]`));
  }
  if (val && typeof val === 'object' && Array.isArray((val as Record<string, unknown>).rules)) {
    return ((val as Record<string, unknown>).rules as unknown[]).map((item, idx) =>
      validatePermissionRule(item, `permissionRules[${idx}]`),
    );
  }
  throw new PayloadValidationError('Expected array or object with rules array for /manage/permissions/rules');
}

// ============================================================================
// 8. Monitor Telemetry Runtime Validation
// ============================================================================

export function validateMonitorTelemetry(val: unknown, path = 'monitorTelemetry'): MonitorTelemetryDesignProjection {
  const obj = assertObject(val, path);
  const piEngineObj = assertObject(obj.piEngine, `${path}.piEngine`);
  const herdrBridgeObj = assertObject(obj.herdrBridge, `${path}.herdrBridge`);
  const persistenceObj = assertObject(obj.persistence, `${path}.persistence`);
  const rawAlerts = assertArray(obj.alerts, `${path}.alerts`);
  const rawLatencyTrend = assertArray(obj.latencyTrend, `${path}.latencyTrend`);

  return {
    systemHealth: assertEnum(obj.systemHealth, ['healthy', 'degraded', 'critical'] as const, `${path}.systemHealth`),
    piEngine: {
      status: assertEnum(piEngineObj.status, ['healthy', 'slow', 'down'] as const, `${path}.piEngine.status`),
      p95LatencyMs: assertNumber(piEngineObj.p95LatencyMs, `${path}.piEngine.p95LatencyMs`),
      activeSessions: assertNumber(piEngineObj.activeSessions, `${path}.piEngine.activeSessions`),
    },
    herdrBridge: {
      status: assertEnum(herdrBridgeObj.status, ['connected', 'disconnected', 'stale'] as const, `${path}.herdrBridge.status`),
      activeWorkspaces: assertNumber(herdrBridgeObj.activeWorkspaces, `${path}.herdrBridge.activeWorkspaces`),
      activePanes: assertNumber(herdrBridgeObj.activePanes, `${path}.herdrBridge.activePanes`),
      lastHeartbeat: assertString(herdrBridgeObj.lastHeartbeat, `${path}.herdrBridge.lastHeartbeat`),
    },
    persistence: {
      tursoStatus: assertEnum(persistenceObj.tursoStatus, ['healthy', 'unreachable'] as const, `${path}.persistence.tursoStatus`),
      r2Status: assertEnum(persistenceObj.r2Status, ['healthy', 'unreachable'] as const, `${path}.persistence.r2Status`),
    },
    webSocketConnected: assertBoolean(obj.webSocketConnected, `${path}.webSocketConnected`),
    alerts: rawAlerts.map((a, idx) => {
      const aObj = assertObject(a, `${path}.alerts[${idx}]`);
      return {
        id: assertString(aObj.id, `${path}.alerts[${idx}].id`),
        severity: assertEnum(aObj.severity, ['warn', 'bad'] as const, `${path}.alerts[${idx}].severity`),
        message: assertString(aObj.message, `${path}.alerts[${idx}].message`),
        timestamp: assertString(aObj.timestamp, `${path}.alerts[${idx}].timestamp`),
      };
    }),
    latencyTrend: rawLatencyTrend.map((t, idx) => {
      const tObj = assertObject(t, `${path}.latencyTrend[${idx}]`);
      return {
        timestamp: assertString(tObj.timestamp, `${path}.latencyTrend[${idx}].timestamp`),
        p50: assertNumber(tObj.p50, `${path}.latencyTrend[${idx}].p50`),
        p95: assertNumber(tObj.p95, `${path}.latencyTrend[${idx}].p95`),
      };
    }),
  };
}

export function validateMonitorTelemetryResponse(val: unknown): MonitorTelemetryDesignProjection[] {
  if (Array.isArray(val)) {
    return val.map((item, idx) => validateMonitorTelemetry(item, `monitorTelemetry[${idx}]`));
  }
  if (val && typeof val === 'object') {
    const record = val as Record<string, unknown>;
    if (Array.isArray(record.telemetry)) {
      return (record.telemetry as unknown[]).map((item, idx) =>
        validateMonitorTelemetry(item, `monitorTelemetry[${idx}]`),
      );
    }
    return [validateMonitorTelemetry(val, 'monitorTelemetry')];
  }
  throw new PayloadValidationError('Expected array or object for /manage/monitor/telemetry');
}

// ============================================================================
// 9. Settings Runtime Validation
// ============================================================================

export function validateSettings(val: unknown, path = 'settings'): SettingsDesignProjection {
  const obj = assertObject(val, path);
  return {
    retentionDays: assertNumber(obj.retentionDays, `${path}.retentionDays`),
    unknownPricingDisplay: assertEnum(
      obj.unknownPricingDisplay,
      ['show_unknown', 'hide_cost'] as const,
      `${path}.unknownPricingDisplay`,
    ),
    defaultChannelPolicy: assertEnum(
      obj.defaultChannelPolicy,
      ['owner_only', 'strict_allowlist'] as const,
      `${path}.defaultChannelPolicy`,
    ),
    autoReviewOnWorkerDone: assertBoolean(obj.autoReviewOnWorkerDone, `${path}.autoReviewOnWorkerDone`),
    colorBlindMode: assertBoolean(obj.colorBlindMode, `${path}.colorBlindMode`),
    enableTraceKeyboardShortcuts: assertBoolean(obj.enableTraceKeyboardShortcuts, `${path}.enableTraceKeyboardShortcuts`),
    isLocalDraftDirty: assertBoolean(obj.isLocalDraftDirty, `${path}.isLocalDraftDirty`),
  };
}

export function validateSettingsResponse(val: unknown): SettingsDesignProjection {
  return validateSettings(val, 'settings');
}

// Convenience Aliases
export const validateConversations = validateConversationsResponse;
export const validateTasks = validateTasksResponse;
export const validatePrincipals = validatePrincipalsResponse;
export const validateRuns = validateRunsResponse;
export const validateTraceRunSummaries = validateTraceRunSummariesResponse;
export const validateTraceEvents = validateTraceEventsResponse;
export const validatePermissionRules = validatePermissionRulesResponse;
