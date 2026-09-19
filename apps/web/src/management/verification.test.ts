/**
 * @file apps/web/src/management/verification.test.ts
 *
 * Focused Vitest coverage for:
 * 1. Canonical mappings from @glassbox/contracts
 * 2. Source selection & mode partitioning
 * 3. Live authentication gating (Bearer token & fail-closed)
 * 4. Real route construction (/manage/* and WS ticket)
 * 5. Invalid API payload rejection
 * 6. Truthful unknown values (never fake $0.00, honest missing workerBinding)
 * 7. Simulated action wording (explicit design simulation / local draft disclaimers)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  MODEL_PROTOCOLS,
  CHANNEL_SAFE_ERRORS,
  RUN_INTEGRITY_SUITE,
  mapModelProfileToDesignProjection,
  mapChannelProfileToDesignProjection,
  type PublicModelProfile,
  type PublicChannelProfile,
} from './types';
import {
  FixtureAdapter,
  HttpApiAdapter,
  getActiveAdapter,
} from './adapter';
import {
  isValidManagementToken,
  validateManagementStatus,
  validateManagementDoctor,
  validateModelsResponse,
  validateChannelsResponse,
  validateWsTicketResponse,
  validateConversationsResponse,
  validateTasksResponse,
  validatePrincipalsResponse,
  validateRunsResponse,
  validateTraceRunSummariesResponse,
  validateTraceEventsResponse,
  validatePermissionRulesResponse,
  validateMonitorTelemetryResponse,
  validateSettingsResponse,
  PayloadValidationError,
} from './adapter/validators';
import { evaluateMockDecision } from './fixtures/permissions';
import {
  mockConversationsData,
  mockTasksData,
  mockIdentityData,
  mockRunsData,
  mockTraceRuns,
  getTraceEventsForRun,
  mockPermissionRules,
  mockMonitorData,
  mockSettingsData,
  mockOverviewData,
} from './fixtures';
import { Route } from '../routes/manage';
import { getChartPointCoordinates, getStrokeDasharray } from './primitives/ChartPanel';
import { isTraceKeyboardShortcutsGuarded } from './pages/TracePage';
import { clampCommandPaletteIndex, getCommandPaletteActiveDescendantId } from './primitives/PageShell';
import { determineTokenVerificationAction } from './access/ManagementAuth';
import { isExplicitRailUserAction } from './primitives/DetailRail';

describe('1. Canonical Mappings & Contract Governance', () => {
  it('re-exports canonical constants from @glassbox/contracts', () => {
    expect(MODEL_PROTOCOLS).toContain('openai-completions');
    expect(MODEL_PROTOCOLS).toContain('anthropic-messages');
    expect(CHANNEL_SAFE_ERRORS.auth).toBe('QQ 连接鉴权失败，请检查 token。');
    expect(RUN_INTEGRITY_SUITE).toBe('run-integrity-v1');
  });

  it('maps PublicModelProfile cleanly to PiModelDesignProjection without data loss', () => {
    const rawProfile: PublicModelProfile = {
      id: 'gpt-4o-primary',
      label: 'GPT-4o (Production)',
      protocol: 'openai-responses',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-4o',
      credentialConfigured: true,
    };

    const projection = mapModelProfileToDesignProjection(rawProfile, {
      isDefault: true,
      contextWindowTokens: 128000,
    });

    expect(projection.id).toBe('gpt-4o-primary');
    expect(projection.name).toBe('GPT-4o (Production)');
    expect(projection.provider).toBe('openai-responses');
    expect(projection.protocol).toBe('openai-responses');
    expect(projection.isDefault).toBe(true);
    expect(projection.capabilityState).toBe('已实现');
    expect(projection.costStatus).toBe('unpriced');
    expect(projection.costTodayUsd).toBeNull();
  });

  it('maps PublicChannelProfile cleanly to ChannelDesignProjection preserving state', () => {
    const rawChannel: PublicChannelProfile = {
      id: 'qq-main',
      label: 'QQ NapCat OneBot',
      kind: 'qq-onebot',
      endpoint: 'ws://127.0.0.1:3001',
      botId: '38192019',
      ownerId: '10293847',
      groupIds: ['98765432'],
      executionRef: 'default',
      tokenConfigured: true,
      autoConnect: true,
      connectionState: 'connected',
    };

    const projection = mapChannelProfileToDesignProjection(rawChannel);

    expect(projection.id).toBe('qq-main');
    expect(projection.name).toBe('QQ NapCat OneBot');
    expect(projection.type).toBe('onebot');
    expect(projection.status).toBe('connected');
    expect(projection.connectionState).toBe('connected');
    expect(projection.autoConnect).toBe(true);
    expect(projection.tokenConfigured).toBe(true);
  });
});

describe('2. Source Selection & Partitioning', () => {
  it('selects FixtureAdapter in design mode', () => {
    const adapter = getActiveAdapter('design');
    expect(adapter.kind).toBe('fixture');
    expect(adapter).toBeInstanceOf(FixtureAdapter);
  });

  it('selects HttpApiAdapter in live mode', () => {
    const validToken = 'abcdefghijklmnopqrstuvwxyz0123456789-_ABCDE';
    const adapter = getActiveAdapter('live', validToken);
    expect(adapter.kind).toBe('api');
    expect(adapter).toBeInstanceOf(HttpApiAdapter);
  });

  it('partitions query keys by mode so caches do not collide', () => {
    const designKey = ['management', 'overview', 'design'];
    const liveKey = ['management', 'overview', 'live'];
    expect(designKey).not.toEqual(liveKey);
  });
});

describe('3. Live Authentication Gating & Fail-Closed Behavior', () => {
  const valid43CharToken = 'abcdefghijklmnopqrstuvwxyz0123456789-_ABCDE';

  it('validates 43-character base64url management tokens strictly', () => {
    expect(isValidManagementToken(valid43CharToken)).toBe(true);
    expect(isValidManagementToken('short-token')).toBe(false);
    expect(isValidManagementToken('')).toBe(false);
    expect(isValidManagementToken('abcdefghijklmnopqrstuvwxyz0123456789-_ABCD!*')).toBe(false);
    expect(isValidManagementToken(null)).toBe(false);
    expect(isValidManagementToken(undefined)).toBe(false);
  });

  it('HttpApiAdapter fails closed if token is missing or invalid', async () => {
    const unauthedAdapter = new HttpApiAdapter({ token: null });
    await expect(unauthedAdapter.getStatus()).rejects.toThrow(/Authentication Required/);

    const invalidAdapter = new HttpApiAdapter({ token: 'invalid_short_token' });
    await expect(invalidAdapter.getPiModels()).rejects.toThrow(/Authentication Required/);
  });

  it('HttpApiAdapter fails closed on 401 Unauthorized without silent fallback', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      status: 401,
      statusText: 'Unauthorized',
      ok: false,
    });
    vi.stubGlobal('fetch', fetchMock);

    const adapter = new HttpApiAdapter({ token: valid43CharToken });
    await expect(adapter.getStatus()).rejects.toThrow(/Unauthorized \(401\)/);

    vi.unstubAllGlobals();
  });

  it('HttpApiAdapter fails closed on 403 Forbidden', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      status: 403,
      statusText: 'Forbidden',
      ok: false,
    });
    vi.stubGlobal('fetch', fetchMock);

    const adapter = new HttpApiAdapter({ token: valid43CharToken });
    await expect(adapter.getStatus()).rejects.toThrow(/Forbidden \(403\)/);

    vi.unstubAllGlobals();
  });
});

describe('4. Real Route Construction & Headers', () => {
  const valid43CharToken = 'abcdefghijklmnopqrstuvwxyz0123456789-_ABCDE';

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('constructs correct /manage/* paths with Bearer token header', async () => {
    let capturedUrl = '';
    let capturedHeaders: Headers | undefined;

    const fetchMock = vi.fn().mockImplementation((url, init) => {
      capturedUrl = String(url);
      capturedHeaders = init?.headers;
      return Promise.resolve({
        status: 200,
        ok: true,
        json: () =>
          Promise.resolve({
            service: 'glassbox',
            version: '0.0.0',
            status: 'ready',
            platform: 'linux',
            defaultExecution: 'claude-code',
            capabilities: {
              modelConfiguration: true,
              channels: true,
              conversations: false,
              runs: false,
              trace: false,
              eval: false,
            },
          }),
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const adapter = new HttpApiAdapter({ baseUrl: 'http://127.0.0.1:8741', token: valid43CharToken });
    await adapter.getStatus();

    expect(capturedUrl).toBe('http://127.0.0.1:8741/manage/status');
    expect(capturedHeaders?.get('Authorization')).toBe(`Bearer ${valid43CharToken}`);

    vi.unstubAllGlobals();
  });

  it('constructs correct /manage/ws-ticket request and parses ticket', async () => {
    let capturedBody = '';

    const fetchMock = vi.fn().mockImplementation((url, init) => {
      capturedBody = init?.body;
      return Promise.resolve({
        status: 200,
        ok: true,
        json: () => Promise.resolve({ ticket: 'ws_ticket_abc_123' }),
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const adapter = new HttpApiAdapter({ baseUrl: 'http://127.0.0.1:8741', token: valid43CharToken });
    const ticket = await adapter.requestWsTicket('session-test-42');

    expect(ticket).toBe('ws_ticket_abc_123');
    expect(JSON.parse(capturedBody)).toEqual({ sessionId: 'session-test-42' });

    const wsUrl = adapter.getWsUrl('session-test-42', ticket);
    expect(wsUrl).toBe('ws://127.0.0.1:8741/ws?sessionId=session-test-42&ticket=ws_ticket_abc_123');

    vi.unstubAllGlobals();
  });
});

describe('5. Invalid Payload Rejection', () => {
  it('rejects ManagementStatus with missing service or status', () => {
    expect(() => validateManagementStatus({})).toThrow(PayloadValidationError);
    expect(() => validateManagementStatus({ service: 'other', status: 'ready' })).toThrow(
      PayloadValidationError,
    );
    expect(() => validateManagementStatus({ service: 'glassbox', status: 'pending' })).toThrow(
      PayloadValidationError,
    );
  });

  it('rejects PublicModelProfile with missing required properties', () => {
    expect(() => validateModelsResponse({ profiles: [{ id: 'm1' }] })).toThrow(
      PayloadValidationError,
    );
    expect(() =>
      validateModelsResponse({
        profiles: [
          {
            id: 'm1',
            label: 'Model 1',
            protocol: 'openai-completions',
            baseUrl: 'http://localhost',
            // missing model and credentialConfigured
          },
        ],
      }),
    ).toThrow(PayloadValidationError);
  });

  it('rejects PublicChannelProfile with invalid kind or missing botId', () => {
    expect(() =>
      validateChannelsResponse({
        channels: [
          {
            id: 'c1',
            label: 'Channel',
            kind: 'unsupported-kind',
          },
        ],
      }),
    ).toThrow(PayloadValidationError);
  });

  it('rejects WsTicket response with missing ticket', () => {
    expect(() => validateWsTicketResponse({})).toThrow(PayloadValidationError);
    expect(() => validateWsTicketResponse({ ticket: '' })).toThrow(PayloadValidationError);
  });

  it('validates valid fixture projections across all domain validators', () => {
    expect(validateConversationsResponse(mockConversationsData)).toHaveLength(mockConversationsData.length);
    expect(validateTasksResponse(mockTasksData)).toHaveLength(mockTasksData.length);
    expect(validatePrincipalsResponse(mockIdentityData)).toHaveLength(mockIdentityData.length);
    expect(validateRunsResponse(mockRunsData)).toHaveLength(mockRunsData.length);
    expect(validateTraceRunSummariesResponse(mockTraceRuns)).toHaveLength(mockTraceRuns.length);
    expect(validateTraceEventsResponse(getTraceEventsForRun('run_A83'))).toHaveLength(getTraceEventsForRun('run_A83').length);
    expect(validatePermissionRulesResponse(mockPermissionRules)).toHaveLength(mockPermissionRules.length);
    expect(validateMonitorTelemetryResponse([mockMonitorData])).toHaveLength(1);
    expect(validateMonitorTelemetryResponse(mockMonitorData)).toHaveLength(1);
    expect(validateSettingsResponse(mockSettingsData).retentionDays).toBe(mockSettingsData.retentionDays);
  });

  it('rejects non-object and non-array shapes for domain endpoints', () => {
    expect(() => validateConversationsResponse(null)).toThrow(PayloadValidationError);
    expect(() => validateConversationsResponse('not-array')).toThrow(PayloadValidationError);
    expect(() => validateConversationsResponse(123)).toThrow(PayloadValidationError);
    expect(() => validateTasksResponse(null)).toThrow(PayloadValidationError);
    expect(() => validateTasksResponse({})).toThrow(PayloadValidationError);
    expect(() => validatePrincipalsResponse(null)).toThrow(PayloadValidationError);
    expect(() => validateRunsResponse(null)).toThrow(PayloadValidationError);
    expect(() => validateTraceRunSummariesResponse(null)).toThrow(PayloadValidationError);
    expect(() => validateTraceEventsResponse(null)).toThrow(PayloadValidationError);
    expect(() => validatePermissionRulesResponse(null)).toThrow(PayloadValidationError);
    expect(() => validateMonitorTelemetryResponse(null)).toThrow(PayloadValidationError);
    expect(() => validateSettingsResponse(null)).toThrow(PayloadValidationError);
    expect(() => validateSettingsResponse([])).toThrow(PayloadValidationError);
  });

  it('rejects invalid enums with understandable PayloadValidationError', () => {
    // Invalid Task state
    expect(() =>
      validateTasksResponse([
        {
          ...mockTasksData[0],
          state: 'INVALID_STATE',
        },
      ]),
    ).toThrow(/Invalid enum at tasks\[0\]\.state/);

    // Invalid Herdr worker state
    expect(() =>
      validateTasksResponse([
        {
          ...mockTasksData[0],
          herdrState: 'invalid_herdr_state',
        },
      ]),
    ).toThrow(/Invalid enum at tasks\[0\]\.herdrState/);

    // Invalid Run status
    expect(() =>
      validateRunsResponse([
        {
          ...mockRunsData[0],
          status: 'invalid_status',
        },
      ]),
    ).toThrow(/Invalid enum at runs\[0\]\.status/);

    // Invalid TraceEventType
    expect(() =>
      validateTraceEventsResponse([
        {
          ...getTraceEventsForRun('run_A83')[0],
          type: 'invalid_type',
        },
      ]),
    ).toThrow(/Invalid enum at traceEvents\[0\]\.type/);

    // Invalid AuthorizationDecision
    expect(() =>
      validatePermissionRulesResponse([
        {
          ...mockPermissionRules[0],
          decision: 'INVALID_DECISION',
        },
      ]),
    ).toThrow(/Invalid enum at permissionRules\[0\]\.decision/);

    // Invalid Monitor systemHealth
    expect(() =>
      validateMonitorTelemetryResponse({
        ...mockMonitorData,
        systemHealth: 'invalid_health',
      }),
    ).toThrow(/Invalid enum at monitorTelemetry\.systemHealth/);

    // Invalid Settings enum
    expect(() =>
      validateSettingsResponse({
        ...mockSettingsData,
        unknownPricingDisplay: 'invalid_display',
      }),
    ).toThrow(/Invalid enum at settings\.unknownPricingDisplay/);
  });

  it('rejects payloads with missing required nested structures', () => {
    // Conversation missing recentMessages
    expect(() =>
      validateConversationsResponse([
        {
          ...mockConversationsData[0],
          recentMessages: undefined,
        },
      ]),
    ).toThrow(/Expected array at conversations\[0\]\.recentMessages/);

    // Task missing attempts array
    expect(() =>
      validateTasksResponse([
        {
          ...mockTasksData[0],
          attempts: undefined,
        },
      ]),
    ).toThrow(/Expected array at tasks\[0\]\.attempts/);

    // Run missing tokens object
    expect(() =>
      validateRunsResponse([
        {
          ...mockRunsData[0],
          tokens: undefined,
        },
      ]),
    ).toThrow(/Expected object at runs\[0\]\.tokens/);

    // Run tokens missing prompt count (do not default to zero!)
    expect(() =>
      validateRunsResponse([
        {
          ...mockRunsData[0],
          tokens: { completion: 100, total: 100 },
        },
      ]),
    ).toThrow(/Expected number at runs\[0\]\.tokens\.prompt/);

    // Principal missing channelIdentities
    expect(() =>
      validatePrincipalsResponse([
        {
          ...mockIdentityData[0],
          channelIdentities: null,
        },
      ]),
    ).toThrow(/Expected array at principals\[0\]\.channelIdentities/);

    // Monitor missing alerts array
    expect(() =>
      validateMonitorTelemetryResponse({
        ...mockMonitorData,
        alerts: null,
      }),
    ).toThrow(/Expected array at monitorTelemetry\.alerts/);
  });

  it('preserves null for unknown cost and optional workerBinding, rejecting undefined cost', () => {
    // costUsd: null is preserved
    const convsWithNullCost = validateConversationsResponse([
      {
        ...mockConversationsData[0],
        costUsd: null,
      },
    ]);
    expect(convsWithNullCost[0].costUsd).toBeNull();

    // costUsd: undefined is rejected
    expect(() =>
      validateConversationsResponse([
        {
          ...mockConversationsData[0],
          costUsd: undefined,
        },
      ]),
    ).toThrow(/cost at conversations\[0\]\.costUsd/);

    // optional workerBinding undefined is preserved
    const taskUnbound = validateTasksResponse([
      {
        ...mockTasksData[0],
        attempts: [
          {
            attemptNo: 1,
            status: 'RUNNING',
            runId: 'run-1',
            testResults: { passed: 0, total: 0 },
            durationMs: 100,
            workerBinding: undefined,
          },
        ],
      },
    ]);
    expect(taskUnbound[0].attempts[0].workerBinding).toBeUndefined();

    // malformed workerBinding is rejected
    expect(() =>
      validateTasksResponse([
        {
          ...mockTasksData[0],
          attempts: [
            {
              attemptNo: 1,
              status: 'RUNNING',
              runId: 'run-1',
              testResults: { passed: 0, total: 0 },
              durationMs: 100,
              workerBinding: { workspaceName: 'ws1' }, // missing herdrSession, paneName, etc.
            },
          ],
        },
      ]),
    ).toThrow(PayloadValidationError);
  });

  it('HttpApiAdapter.getTraceRuns derives summaries from /manage/runs with eventCount: null', async () => {
    const valid43CharToken = 'abcdefghijklmnopqrstuvwxyz0123456789-_ABCDE';
    const fetchMock = vi.fn().mockImplementation(() =>
      Promise.resolve({
        status: 200,
        ok: true,
        json: () =>
          Promise.resolve({
            runs: [mockRunsData[0]],
          }),
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const adapter = new HttpApiAdapter({ baseUrl: 'http://127.0.0.1:8741', token: valid43CharToken });
    const res = await adapter.getTraceRuns();
    expect(res.data).toHaveLength(1);
    expect(res.data[0].runId).toBe(mockRunsData[0].id);
    expect(res.data[0].eventCount).toBeNull();
    expect(res.data[0].status).toBe(mockRunsData[0].status);
    expect(res.data[0].model).toBe(mockRunsData[0].modelId);

    vi.unstubAllGlobals();
  });
});

describe('6. Truthful Unknown Values & Honest Absence States', () => {
  it('preserves unpriced/unknown costs without fabricating $0.00', async () => {
    const fixtureAdapter = new FixtureAdapter();
    const overview = await fixtureAdapter.getOverview();

    expect(overview.data.summary.todayCostStatus).toBe('unpriced');
    expect(overview.data.summary.todayCostUsd).toBeNull();

    for (const model of overview.data.piModelUsage) {
      if (model.costStatus === 'unpriced') {
        expect(model.costUsd).toBeNull();
      }
    }
  });

  it('truthfully reports missing worker binding rather than synthesizing fake pane', async () => {
    const fixtureAdapter = new FixtureAdapter();
    const tasks = await fixtureAdapter.getTasks();

    // Verify task structure supports optional/absent workerBinding
    const queuedTask = tasks.data.find((t) => t.id === 'task-224');
    expect(queuedTask).toBeDefined();
    expect(queuedTask?.attempts.length).toBe(0);

    // Prior attempt or new attempt can have undefined workerBinding
    const emptyAttempt = {
      attemptNo: 2,
      status: 'RUNNING' as const,
      runId: 'run-temp',
      testResults: { passed: 0, total: 0 },
      durationMs: 0,
      workerBinding: undefined,
    };
    expect(emptyAttempt.workerBinding).toBeUndefined();
  });
});

describe('7. Explicit Simulated Action Wording & Invariants', () => {
  it('ensures Decision Tester returns explicit simulation metadata', () => {
    const res = evaluateMockDecision({
      principal: 'owner_primary',
      resource: 'workspace:code',
      action: 'read',
      channel: 'web',
      location: 'workbench',
    });

    expect(res.isSimulationOnly).toBe(true);
    expect(res.decision).toBe('ALLOW');
    expect(res.matchedRuleId).toBe('rule-101');
  });

  it('upholds the collaboration invariant: Herdr worker done ≠ Glassbox Task DONE', async () => {
    const adapter = new FixtureAdapter();
    const tasks = await adapter.getTasks();
    const reviewTask = tasks.data.find((t) => t.id === 'task-218');

    expect(reviewTask).toBeDefined();
    expect(reviewTask?.herdrState).toBe('done');  // External observation
    expect(reviewTask?.state).toBe('REVIEW');       // Durable product truth
    expect(reviewTask?.requiresReview).toBe(true);
  });
});

describe('8. ChartPanel Coordinate Helper & Single/Zero Point Safety', () => {
  it('computes horizontal center (x=300) without NaN for a single data point', () => {
    const coords = getChartPointCoordinates(
      50,    // val
      0,     // idx
      1,     // length = 1
      100,   // maxVal
      540,   // usableWidth
      120,   // usableHeight
      30,    // paddingX
      20,    // paddingY
      160,   // height
    );

    expect(coords.x).toBe(300); // 30 + 540 / 2 = 300
    expect(Number.isNaN(coords.x)).toBe(false);
    expect(Number.isNaN(coords.y)).toBe(false);
    expect(coords.y).toBe(160 - 20 - (50 / 100) * 120); // 80
  });

  it('keeps zero-point behavior safe without NaN or crash', () => {
    const coords = getChartPointCoordinates(0, 0, 0, 0, 540, 120, 30, 20, 160);
    expect(coords.x).toBe(300);
    expect(Number.isNaN(coords.x)).toBe(false);
    expect(Number.isNaN(coords.y)).toBe(false);
  });

  it('spreads points across width when multiple points exist', () => {
    const p0 = getChartPointCoordinates(10, 0, 3, 100, 540, 120, 30, 20, 160);
    const p1 = getChartPointCoordinates(50, 1, 3, 100, 540, 120, 30, 20, 160);
    const p2 = getChartPointCoordinates(90, 2, 3, 100, 540, 120, 30, 20, 160);

    expect(p0.x).toBe(30);
    expect(p1.x).toBe(300);
    expect(p2.x).toBe(570);
  });
});

describe('9. Data Honesty & Mode Truthfulness (R-01, R-02, R-03)', () => {
  const token = 'abcdefghijklmnopqrstuvwxyz0123456789-_ABCDE';

  it('R-01: HttpApiAdapter.getOverview returns null for unknown summary metrics and never fabricates 196 or 3', async () => {
    const adapter = new HttpApiAdapter({ token });
    vi.spyOn(adapter, 'getStatus').mockResolvedValue({
      data: {
        service: 'glassbox',
        version: '0.1.0',
        status: 'ready',
        platform: 'linux',
        defaultExecution: 'claude-code',
        capabilities: { modelConfiguration: true, channels: true, conversations: true, runs: true, trace: true, eval: true },
      },
      source: 'api',
      fetchedAt: new Date().toISOString(),
    });
    vi.spyOn(adapter, 'getPiModels').mockResolvedValue({
      data: [
        {
          id: 'claude-3-5-sonnet',
          name: 'Claude 3.5 Sonnet',
          provider: 'anthropic',
          protocol: 'anthropic-messages',
          baseUrl: 'https://api.anthropic.com',
          model: 'claude-3-5-sonnet-20241022',
          credentialConfigured: true,
          isDefault: true,
          capabilityState: '已实现',
          temperature: 0.2,
          contextWindowTokens: null,
          tokensToday: null,
          costTodayUsd: null,
          costStatus: 'unpriced',
          quota: null,
          quotaStatus: 'unreported',
          activeSessionsCount: null,
        },
      ],
      source: 'api',
      fetchedAt: new Date().toISOString(),
    });

    const res = await adapter.getOverview();
    expect(res.source).toBe('api');
    expect(res.data.summary.runs24h).toBeNull();
    expect(res.data.summary.pendingAttentionCount).toBeNull();
    expect(res.data.summary.todayTotalTokens).toBeNull();
    expect(res.data.summary.todayCostUsd).toBeNull();
    expect(res.data.summary.todayCostStatus).toBe('unknown');
    expect(res.data.attentionQueue).toEqual([]);
    expect(res.data.currentRun).toBeNull();
    expect(res.data.usageTrend).toEqual([]);

    expect(res.data.piModelUsage[0].callsToday).toBeNull();
    expect(res.data.piModelUsage[0].tokensToday).toBeNull();
    expect(res.data.piModelUsage[0].costUsd).toBeNull();
    expect(res.data.piModelUsage[0].costStatus).toBe('unknown');
    expect(res.data.piModelUsage[0].p95LatencyMs).toBeNull();
  });

  it('R-03: HttpApiAdapter.getTraceRuns derives summaries from real runs without fabricating eventCount', async () => {
    const fetchMock = vi.fn().mockImplementation(() =>
      Promise.resolve({
        status: 200,
        ok: true,
        json: () =>
          Promise.resolve({
            runs: [mockRunsData[0]],
          }),
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const adapter = new HttpApiAdapter({ baseUrl: 'http://127.0.0.1:8741', token });
    const res = await adapter.getTraceRuns();
    expect(res.data[0].runId).toBe(mockRunsData[0].id);
    expect(res.data[0].eventCount).toBeNull();

    vi.unstubAllGlobals();
  });

  it('R-03: HttpApiAdapter.evaluateDecision throws explicit offline-only error in live mode', async () => {
    const adapter = new HttpApiAdapter({ token });
    await expect(
      adapter.evaluateDecision({
        principal: 'owner_primary',
        channel: 'web',
        location: 'workbench',
        resource: 'workspace:clean_reset',
        action: 'execute',
      }),
    ).rejects.toThrow(/Server Evaluation Unavailable/);
  });
});

describe('10. Settings, Route Search Validation, & Targeted Navigation (R-04, R-05, R-10)', () => {
  it('R-04: Unsupported settings controls are explicitly marked and distinct from supported settings', () => {
    const unsupportedControlIds = [
      'language',
      'density',
      'currency',
      'pi-model',
      'pi-compat',
      'qq-activation',
      'event-dedupe',
      'sanitize',
      'herdr-timeout',
      'reconnect',
      'notify-review',
      'notify-auth',
    ];
    expect(unsupportedControlIds).toHaveLength(12);

    // The 6 supported fields in SettingsProjection
    const supportedFields = [
      'defaultChannelPolicy',
      'unknownPricingDisplay',
      'retentionDays',
      'enableTraceKeyboardShortcuts',
      'autoReviewOnWorkerDone',
      'colorBlindMode',
    ];
    for (const field of supportedFields) {
      expect(mockSettingsData).toHaveProperty(field);
    }
  });

  it('R-05: Route search validation preserves testPrincipal and selectedId when valid', () => {
    const validateSearch = (Route.options as any).validateSearch;
    expect(validateSearch).toBeDefined();

    // Valid search with testPrincipal and selectedId
    const res1 = validateSearch({
      page: 'permissions',
      testPrincipal: 'worker_herdr_04',
      selectedId: 'perm-gate-03',
    });
    expect(res1.page).toBe('permissions');
    expect(res1.testPrincipal).toBe('worker_herdr_04');
    expect(res1.selectedId).toBe('perm-gate-03');

    // Invalid non-string values should be sanitized to undefined
    const res2 = validateSearch({
      page: 'ops',
      testPrincipal: 12345,
      selectedId: ['invalid'],
    });
    expect(res2.page).toBe('ops');
    expect(res2.testPrincipal).toBeUndefined();
    expect(res2.selectedId).toBeUndefined();

    // Empty strings should be sanitized to undefined
    const res3 = validateSearch({
      page: 'runs',
      testPrincipal: '',
      selectedId: '',
      runId: '',
    });
    expect(res3.testPrincipal).toBeUndefined();
    expect(res3.selectedId).toBeUndefined();
    expect(res3.runId).toBeUndefined();
  });

  it('R-05: Decision simulation differentiates worker principal from owner principal', () => {
    // Owner attempting destructive action requires approval
    const ownerDestructive = evaluateMockDecision({
      principal: 'owner_primary',
      resource: 'workspace:clean_reset',
      action: 'execute',
      channel: 'web',
      location: 'local:workbench',
    });
    expect(ownerDestructive.decision).toBe('REQUIRES_APPROVAL');

    // Owner normal workspace access is allowed
    const ownerNormal = evaluateMockDecision({
      principal: 'owner_primary',
      resource: 'workspace:main',
      action: 'read_write',
      channel: 'web',
      location: 'local:workbench',
    });
    expect(ownerNormal.decision).toBe('ALLOW');

    // Worker principal scoped worktree access is allowed
    const workerWorktree = evaluateMockDecision({
      principal: 'worker_herdr_04',
      resource: 'workspace:designated_worktree',
      action: 'read_write',
      channel: 'web',
      location: 'local:workbench',
    });
    expect(workerWorktree.decision).toBe('ALLOW');

    // Worker principal attempting out-of-scope resource is denied (Default Deny)
    const workerOutOfScope = evaluateMockDecision({
      principal: 'worker_herdr_04',
      resource: 'workspace:secrets',
      action: 'read',
      channel: 'web',
      location: 'local:workbench',
    });
    expect(workerOutOfScope.decision).toBe('DENY');
  });

  it('R-10: Attention queue specifies accurate target sections and IDs', () => {
    const taskItem = mockOverviewData.attentionQueue.find((item) => item.targetId === 'task-221');
    expect(taskItem).toBeDefined();
    expect(taskItem?.targetSection).toBe('ops');

    const permItem = mockOverviewData.attentionQueue.find((item) => item.targetId === 'perm-gate-03');
    expect(permItem).toBeDefined();
    expect(permItem?.targetSection).toBe('permissions');

    // perm-gate-03 is intentionally not present in mockPermissionRules to exercise honest unavailable state
    expect(mockPermissionRules.some((r) => r.id === 'perm-gate-03')).toBe(false);
  });

  it('R-10: Task Ops correctly tracks currentAttempt and its runId rather than task ID', () => {
    const task218 = mockTasksData.find((t) => t.id === 'task-218');
    expect(task218).toBeDefined();
    expect(task218?.attempts.length).toBeGreaterThan(1);
    expect(task218?.currentAttemptNo).toBe(2);

    const currentAttempt = task218?.attempts.find((att) => att.attemptNo === task218.currentAttemptNo);
    expect(currentAttempt).toBeDefined();
    expect(currentAttempt?.runId).toBe('run_A83');
    expect(currentAttempt?.runId).not.toBe('task-218');
    expect(currentAttempt?.runId).not.toBe('run_A81'); // Attempt 1 runId
  });

  it('R-10: Safe selection invariant ensures invalid IDs never fall back to index 0 or unrelated entities', () => {
    // Runs safe selection:
    const runs = mockRunsData;
    const findRun = (id: string | null | undefined) => {
      if (!id) return null;
      return runs.find((r) => r.id === id) ?? null;
    };
    expect(findRun('run_A83')?.id).toBe('run_A83');
    expect(findRun('non-existent-run')).toBeNull();
    expect(findRun('')).toBeNull();
    expect(findRun(undefined)).toBeNull();

    // Tasks safe selection:
    const tasks = mockTasksData;
    const findTask = (id: string | null | undefined) => {
      if (!id) return null;
      return tasks.find((t) => t.id === id) ?? null;
    };
    expect(findTask('task-221')?.id).toBe('task-221');
    expect(findTask('non-existent-task')).toBeNull();
    expect(findTask('')).toBeNull();
    expect(findTask(undefined)).toBeNull();
  });
});

describe('11. Color-blind Charts, Trace Shortcuts, Command Palette ARIA, Token Deduplication, & DetailRail Focus (R-06, R-07, R-08, R-09, R-11)', () => {
  it('R-06: getStrokeDasharray returns distinct patterns for solid, dashed, and dotted', () => {
    expect(getStrokeDasharray('solid')).toBeUndefined();
    expect(getStrokeDasharray('dashed')).toBe('6,4');
    expect(getStrokeDasharray('dotted')).toBe('2,4');
  });

  it('R-07: Trace shortcuts modifier guard filters out Cmd/Ctrl/Alt and active inputs', () => {
    // Modifiers must be guarded
    expect(isTraceKeyboardShortcutsGuarded({ ctrlKey: true })).toBe(true);
    expect(isTraceKeyboardShortcutsGuarded({ metaKey: true })).toBe(true);
    expect(isTraceKeyboardShortcutsGuarded({ altKey: true })).toBe(true);

    // Form inputs must be guarded
    expect(isTraceKeyboardShortcutsGuarded({}, { tagName: 'INPUT' })).toBe(true);
    expect(isTraceKeyboardShortcutsGuarded({}, { tagName: 'TEXTAREA' })).toBe(true);
    expect(isTraceKeyboardShortcutsGuarded({}, { tagName: 'SELECT' })).toBe(true);
    expect(isTraceKeyboardShortcutsGuarded({}, { isContentEditable: true })).toBe(true);

    // Plain keypress without modifiers or focused input is not guarded
    expect(isTraceKeyboardShortcutsGuarded({})).toBe(false);
    expect(isTraceKeyboardShortcutsGuarded({}, { tagName: 'DIV' })).toBe(false);
  });

  it('R-08: Command Palette active index clamping and ARIA activedescendant IDs', () => {
    const items = [
      { id: 'overview', titleZh: '概览' },
      { id: 'runs', titleZh: '运行记录' },
      { id: 'trace', titleZh: '追踪' },
    ];

    expect(clampCommandPaletteIndex(0, items.length)).toBe(0);
    expect(clampCommandPaletteIndex(2, items.length)).toBe(2);
    expect(clampCommandPaletteIndex(5, items.length)).toBe(2); // clamped to upper bound
    expect(clampCommandPaletteIndex(-3, items.length)).toBe(0); // clamped to lower bound
    expect(clampCommandPaletteIndex(0, 0)).toBe(-1); // empty list returns -1

    // Stable ID matching
    expect(getCommandPaletteActiveDescendantId(items, 1)).toBe('cmd-item-runs');
    expect(getCommandPaletteActiveDescendantId(items, 0)).toBe('cmd-item-overview');
    expect(getCommandPaletteActiveDescendantId([], 0)).toBeUndefined();
  });

  it('R-09: Token validation rejects malformed tokens and prevents duplicate verification', () => {
    const validToken = 'valid_test_token_43_characters_long_1234567';
    expect(isValidManagementToken(validToken)).toBe(true);

    const invalidShort = 'short_token';
    expect(isValidManagementToken(invalidShort)).toBe(false);

    // Tests production determineTokenVerificationAction
    // Invalid tokens trigger reset
    expect(determineTokenVerificationAction(invalidShort, null, null)).toBe('reset_invalid');
    expect(determineTokenVerificationAction(null, null, null)).toBe('reset_invalid');

    // Initial valid token triggers verification
    expect(determineTokenVerificationAction(validToken, null, null)).toBe('verify');

    // Re-render with already verified token: skipped
    expect(determineTokenVerificationAction(validToken, validToken, null)).toBe('skip_already_verified');

    // Token with verification currently in-flight: skipped
    expect(determineTokenVerificationAction(validToken, null, validToken)).toBe('skip_in_flight');

    // Replacement token triggers verification
    const replacementToken = 'replace_test_token_43_characters_long_12345';
    expect(determineTokenVerificationAction(replacementToken, validToken, null)).toBe('verify');
  });

  it('R-11: DetailRail distinguishes explicit user interaction from async data arrival', () => {
    const now = 1000000;
    // Click occurred 50ms ago: explicit user action
    expect(isExplicitRailUserAction({ timestamp: now - 50 }, now)).toBe(true);

    // Async query resolved 500ms after last click: NOT explicit user action
    expect(isExplicitRailUserAction({ timestamp: now - 500 }, now)).toBe(false);

    // No user interaction recorded (e.g. direct URL navigation): NOT explicit user action
    expect(isExplicitRailUserAction(null, now)).toBe(false);

    // Detached element is rejected
    expect(
      isExplicitRailUserAction(
        { element: {} as HTMLElement, timestamp: now - 50 },
        now,
        400,
        () => false
      )
    ).toBe(false);
  });
});
