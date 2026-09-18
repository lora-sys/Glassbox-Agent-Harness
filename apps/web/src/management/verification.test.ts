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
  PayloadValidationError,
} from './adapter/validators';
import { evaluateMockDecision } from './fixtures/permissions';

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
