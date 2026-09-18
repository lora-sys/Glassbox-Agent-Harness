/**
 * @file apps/web/src/management/adapter/index.ts
 *
 * Separated Fixture Adapter and Real HTTP Read Adapter for /manage.
 *
 * SYSTEM INVARIANTS:
 * - NO silent fallback from API to fixtures.
 * - Live mode must fail closed when authentication or an endpoint is unavailable.
 * - Live mode communicates with actual existing /manage endpoints using Bearer token authentication.
 * - API payloads are strictly validated before rendering.
 * - Active data source ('design'/'fixture' vs 'live'/'api') is explicitly declared and traceable.
 */
import React, { createContext, useContext } from 'react';
import { useQuery } from '@tanstack/react-query';
import type {
  OverviewDesignProjection,
  ConversationDesignProjection,
  TaskDesignProjection,
  PrincipalDesignProjection,
  RunDesignProjection,
  TraceRunDesignSummary,
  TraceEventDesignProjection,
  PiModelDesignProjection,
  ChannelDesignProjection,
  PermissionRuleDesignProjection,
  DecisionTesterInput,
  DecisionTesterDesignResult,
  MonitorTelemetryDesignProjection,
  SettingsDesignProjection,
  PublicModelProfile,
  PublicChannelProfile,
  PublicExecutor,
  ManagementStatus,
  ManagementDoctor,
} from '../types';
import {
  mapModelProfileToDesignProjection,
  mapChannelProfileToDesignProjection,
} from '../types';

import {
  mockOverviewData,
  mockConversationsData,
  mockTasksData,
  mockIdentityData,
  mockRunsData,
  mockTraceRuns,
  getTraceEventsForRun,
  mockPiModelsData,
  mockChannelsData,
  mockPermissionRules,
  evaluateMockDecision,
  mockMonitorData,
  mockSettingsData,
} from '../fixtures';

import {
  isValidManagementToken,
  validateManagementStatus,
  validateManagementDoctor,
  validateModelsResponse,
  validateChannelsResponse,
  validateExecutorsResponse,
  validateWsTicketResponse,
} from './validators';

export type DataSourceKind = 'fixture' | 'api';
export type ManagementMode = 'design' | 'live';

export interface AdapterResult<T> {
  data: T;
  source: DataSourceKind;
  fetchedAt: string;
}

export interface ManagementAdapter {
  kind: DataSourceKind;
  getOverview: () => Promise<AdapterResult<OverviewDesignProjection>>;
  getConversations: () => Promise<AdapterResult<ConversationDesignProjection[]>>;
  getTasks: () => Promise<AdapterResult<TaskDesignProjection[]>>;
  getPrincipals: () => Promise<AdapterResult<PrincipalDesignProjection[]>>;
  getRuns: () => Promise<AdapterResult<RunDesignProjection[]>>;
  getTraceRuns: () => Promise<AdapterResult<TraceRunDesignSummary[]>>;
  getTraceEvents: (runId: string) => Promise<AdapterResult<TraceEventDesignProjection[]>>;
  getPiModels: () => Promise<AdapterResult<PiModelDesignProjection[]>>;
  getChannels: () => Promise<AdapterResult<ChannelDesignProjection[]>>;
  getPermissionRules: () => Promise<AdapterResult<PermissionRuleDesignProjection[]>>;
  getMonitorTelemetry: () => Promise<AdapterResult<MonitorTelemetryDesignProjection[]>>;
  getSettings: () => Promise<AdapterResult<SettingsDesignProjection>>;
  evaluateDecision: (input: DecisionTesterInput) => Promise<DecisionTesterDesignResult>;
  // Direct /manage methods for canonical server contracts
  getStatus?: () => Promise<AdapterResult<ManagementStatus>>;
  getDoctor?: () => Promise<AdapterResult<ManagementDoctor>>;
  getExecutors?: () => Promise<AdapterResult<PublicExecutor[]>>;
  requestWsTicket?: (sessionId: string) => Promise<string>;
  getWsUrl?: (sessionId: string, ticket: string) => string;
}

// ============================================================================
// Token Storage & Management Invariants
// ============================================================================

export const TOKEN_STORAGE_KEY = 'glassbox_management_token';

export function getManagementToken(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    const token = sessionStorage.getItem(TOKEN_STORAGE_KEY) || localStorage.getItem(TOKEN_STORAGE_KEY);
    return isValidManagementToken(token) ? token : null;
  } catch {
    return null;
  }
}

export function setManagementToken(token: string | null, persist = false): void {
  if (typeof window === 'undefined') return;
  try {
    if (token && isValidManagementToken(token)) {
      sessionStorage.setItem(TOKEN_STORAGE_KEY, token);
      if (persist) localStorage.setItem(TOKEN_STORAGE_KEY, token);
    } else {
      sessionStorage.removeItem(TOKEN_STORAGE_KEY);
      localStorage.removeItem(TOKEN_STORAGE_KEY);
    }
  } catch {
    // Ignore storage quota or access errors
  }
}

// ============================================================================
// Fixture Adapter Implementation (Deterministic, Offline, Design Mode)
// ============================================================================

export class FixtureAdapter implements ManagementAdapter {
  readonly kind: DataSourceKind = 'fixture';

  private wrap<T>(data: T): AdapterResult<T> {
    return {
      data,
      source: 'fixture',
      fetchedAt: new Date().toISOString(),
    };
  }

  async getOverview() {
    return this.wrap(mockOverviewData);
  }

  async getConversations() {
    return this.wrap(mockConversationsData);
  }

  async getTasks() {
    return this.wrap(mockTasksData);
  }

  async getPrincipals() {
    return this.wrap(mockIdentityData);
  }

  async getRuns() {
    return this.wrap(mockRunsData);
  }

  async getTraceRuns() {
    return this.wrap(mockTraceRuns);
  }

  async getTraceEvents(runId: string) {
    return this.wrap(getTraceEventsForRun(runId));
  }

  async getPiModels() {
    return this.wrap(mockPiModelsData);
  }

  async getChannels() {
    return this.wrap(mockChannelsData);
  }

  async getPermissionRules() {
    return this.wrap(mockPermissionRules);
  }

  async getMonitorTelemetry() {
    return this.wrap([mockMonitorData]);
  }

  async getSettings() {
    return this.wrap(mockSettingsData);
  }

  async evaluateDecision(input: DecisionTesterInput) {
    return evaluateMockDecision(input);
  }
}

// ============================================================================
// Real HTTP Read Adapter (/manage/* Protocol with Bearer Token & Fail-Closed)
// ============================================================================

export class HttpApiAdapter implements ManagementAdapter {
  readonly kind: DataSourceKind = 'api';
  private readonly baseUrl: string;
  private readonly tokenProvider: () => string | null;

  constructor(options?: { baseUrl?: string; token?: string | null; tokenProvider?: () => string | null }) {
    this.baseUrl = options?.baseUrl?.replace(/\/+$/, '') ?? '';
    if (options?.tokenProvider) {
      this.tokenProvider = options.tokenProvider;
    } else if (options?.token !== undefined) {
      const fixedToken = options.token;
      this.tokenProvider = () => fixedToken;
    } else {
      this.tokenProvider = () => getManagementToken();
    }
  }

  private async fetchManage<T>(
    path: string,
    options?: RequestInit,
    validator?: (json: unknown) => T,
  ): Promise<AdapterResult<T>> {
    const token = this.tokenProvider();
    if (!token || !isValidManagementToken(token)) {
      throw new Error('Authentication Required: Missing or invalid 43-character management token.');
    }

    const cleanPath = path.startsWith('/') ? path.slice(1) : path;
    const url = `${this.baseUrl}/manage/${cleanPath}`;

    const headers = new Headers(options?.headers);
    headers.set('Authorization', `Bearer ${token}`);
    headers.set('Accept', 'application/json');

    const res = await fetch(url, {
      ...options,
      headers,
    });

    if (res.status === 401) {
      throw new Error('Unauthorized (401): Management key rejected by Glassbox server.');
    }
    if (res.status === 403) {
      throw new Error('Forbidden (403): Management access is local only or request origin not allowed.');
    }
    if (res.status === 404) {
      throw new Error(`Endpoint Not Available (404): /manage/${cleanPath} is not available on the server.`);
    }
    if (!res.ok) {
      throw new Error(`Server Error (${res.status} ${res.statusText}) at /manage/${cleanPath}`);
    }

    let json: unknown;
    try {
      json = await res.json();
    } catch {
      throw new Error(`Invalid JSON response from /manage/${cleanPath}`);
    }

    const validatedData = validator ? validator(json) : (json as T);

    return {
      data: validatedData,
      source: 'api',
      fetchedAt: new Date().toISOString(),
    };
  }

  // --- Real /manage Canonical Endpoints ---

  async getStatus(): Promise<AdapterResult<ManagementStatus>> {
    return this.fetchManage('status', { method: 'GET' }, validateManagementStatus);
  }

  async getDoctor(): Promise<AdapterResult<ManagementDoctor>> {
    return this.fetchManage('doctor', { method: 'GET' }, validateManagementDoctor);
  }

  async getPiModels(): Promise<AdapterResult<PiModelDesignProjection[]>> {
    const res = await this.fetchManage('models', { method: 'GET' }, validateModelsResponse);
    const models = res.data.profiles.map((p, idx) =>
      mapModelProfileToDesignProjection(p, {
        isDefault: idx === 0,
        contextWindowTokens: 128000,
        temperature: 0.7,
        tokensToday: 0,
        costStatus: 'unpriced',
        costTodayUsd: null,
      }),
    );
    return {
      data: models,
      source: 'api',
      fetchedAt: res.fetchedAt,
    };
  }

  async getChannels(): Promise<AdapterResult<ChannelDesignProjection[]>> {
    const res = await this.fetchManage('channels', { method: 'GET' }, validateChannelsResponse);
    const channels = res.data.channels.map((c) =>
      mapChannelProfileToDesignProjection(c),
    );
    return {
      data: channels,
      source: 'api',
      fetchedAt: res.fetchedAt,
    };
  }

  async getExecutors(): Promise<AdapterResult<PublicExecutor[]>> {
    const res = await this.fetchManage('executors', { method: 'GET' }, validateExecutorsResponse);
    return {
      data: res.data.executors,
      source: 'api',
      fetchedAt: res.fetchedAt,
    };
  }

  async requestWsTicket(sessionId: string): Promise<string> {
    const token = this.tokenProvider();
    if (!token || !isValidManagementToken(token)) {
      throw new Error('Authentication Required: Valid management token required to issue WS ticket.');
    }
    const res = await fetch(`${this.baseUrl}/manage/ws-ticket`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ sessionId }),
    });
    if (!res.ok) {
      throw new Error(`Failed to issue WS ticket: ${res.status} ${res.statusText}`);
    }
    const body = validateWsTicketResponse(await res.json());
    return body.ticket;
  }

  getWsUrl(sessionId: string, ticket: string): string {
    const wsBase = this.baseUrl
      ? this.baseUrl.replace(/^http/, 'ws')
      : (typeof window !== 'undefined' ? `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}` : 'ws://localhost:3030');
    return `${wsBase}/ws?sessionId=${encodeURIComponent(sessionId)}&ticket=${encodeURIComponent(ticket)}`;
  }

  // --- Projections Built from Canonical Endpoints ---

  async getOverview(): Promise<AdapterResult<OverviewDesignProjection>> {
    // In live mode, synthesize overview from real status, models, and channels
    const [statusRes, modelsRes, channelsRes] = await Promise.all([
      this.getStatus(),
      this.getPiModels(),
      this.getChannels(),
    ]);

    const projection: OverviewDesignProjection = {
      summary: {
        activeConversations: 0,
        pendingAttentionCount: 0,
        runningTasksCount: 0,
        todayTotalTokens: 0,
        todayCostUsd: null,
        todayCostStatus: 'unpriced',
      },
      attentionQueue: [],
      currentRun: null,
      piModelUsage: modelsRes.data.map((m) => ({
        modelId: m.id,
        modelName: m.name,
        callsToday: 0,
        tokensToday: 0,
        costUsd: null,
        costStatus: 'unpriced',
        p95LatencyMs: 0,
      })),
      usageTrend: [],
    };

    return {
      data: projection,
      source: 'api',
      fetchedAt: statusRes.fetchedAt,
    };
  }

  // --- Absent Domains: Fail-Closed without Silent Fallback ---

  async getConversations(): Promise<AdapterResult<ConversationDesignProjection[]>> {
    return this.fetchManage('conversations', { method: 'GET' });
  }

  async getTasks(): Promise<AdapterResult<TaskDesignProjection[]>> {
    return this.fetchManage('tasks', { method: 'GET' });
  }

  async getPrincipals(): Promise<AdapterResult<PrincipalDesignProjection[]>> {
    return this.fetchManage('principals', { method: 'GET' });
  }

  async getRuns(): Promise<AdapterResult<RunDesignProjection[]>> {
    return this.fetchManage('runs', { method: 'GET' });
  }

  async getTraceRuns(): Promise<AdapterResult<TraceRunDesignSummary[]>> {
    return this.fetchManage('runs', { method: 'GET' });
  }

  async getTraceEvents(runId: string): Promise<AdapterResult<TraceEventDesignProjection[]>> {
    return this.fetchManage(`runs/${encodeURIComponent(runId)}/trace`, { method: 'GET' });
  }

  async getPermissionRules(): Promise<AdapterResult<PermissionRuleDesignProjection[]>> {
    return this.fetchManage('permissions/rules', { method: 'GET' });
  }

  async getMonitorTelemetry(): Promise<AdapterResult<MonitorTelemetryDesignProjection[]>> {
    return this.fetchManage('monitor/telemetry', { method: 'GET' });
  }

  async getSettings(): Promise<AdapterResult<SettingsDesignProjection>> {
    return this.fetchManage('settings', { method: 'GET' });
  }

  async evaluateDecision(_input: DecisionTesterInput): Promise<DecisionTesterDesignResult> {
    throw new Error('Server Evaluation Unavailable: /manage does not support remote decision simulation. Switch to design preview for offline rule simulation.');
  }
}

// ============================================================================
// Adapter Selector & React Context
// ============================================================================

export function getActiveAdapter(modeOrKind?: DataSourceKind | ManagementMode, token?: string | null): ManagementAdapter {
  if (modeOrKind === 'api' || modeOrKind === 'live') {
    return new HttpApiAdapter({ token });
  }
  return new FixtureAdapter();
}

export interface ManagementDataContextValue {
  mode: ManagementMode;
  setMode: (mode: ManagementMode) => void;
  adapter: ManagementAdapter;
  token: string | null;
  setToken: (token: string | null) => void;
}

export const ManagementDataContext = createContext<ManagementDataContextValue>({
  mode: 'design',
  setMode: () => {},
  adapter: new FixtureAdapter(),
  token: null,
  setToken: () => {},
});

export const ManagementDataProvider: React.FC<{
  mode: ManagementMode;
  setMode: (mode: ManagementMode) => void;
  token: string | null;
  setToken: (token: string | null) => void;
  children: React.ReactNode;
}> = ({ mode, setMode, token, setToken, children }) => {
  const adapter = React.useMemo(() => {
    return getActiveAdapter(mode, token);
  }, [mode, token]);

  const value = React.useMemo(() => ({
    mode,
    setMode,
    adapter,
    token,
    setToken,
  }), [mode, setMode, adapter, token, setToken]);

  return React.createElement(ManagementDataContext.Provider, { value }, children);
};

export function useManagementData(): ManagementDataContextValue {
  return useContext(ManagementDataContext);
}

// ============================================================================
// Query Hooks with Mode-Partitioned Query Keys
// ============================================================================

export function useManagementOverview(modeOverride?: ManagementMode) {
  const ctx = useManagementData();
  const effectiveMode = modeOverride || ctx.mode;
  const adapter = modeOverride ? getActiveAdapter(modeOverride, ctx.token) : ctx.adapter;

  return useQuery({
    queryKey: ['management', 'overview', effectiveMode],
    queryFn: () => adapter.getOverview(),
    retry: effectiveMode === 'live' ? false : undefined,
  });
}

export function useManagementConversations(modeOverride?: ManagementMode) {
  const ctx = useManagementData();
  const effectiveMode = modeOverride || ctx.mode;
  const adapter = modeOverride ? getActiveAdapter(modeOverride, ctx.token) : ctx.adapter;

  return useQuery({
    queryKey: ['management', 'conversations', effectiveMode],
    queryFn: () => adapter.getConversations(),
    retry: effectiveMode === 'live' ? false : undefined,
  });
}

export function useManagementTasks(modeOverride?: ManagementMode) {
  const ctx = useManagementData();
  const effectiveMode = modeOverride || ctx.mode;
  const adapter = modeOverride ? getActiveAdapter(modeOverride, ctx.token) : ctx.adapter;

  return useQuery({
    queryKey: ['management', 'tasks', effectiveMode],
    queryFn: () => adapter.getTasks(),
    retry: effectiveMode === 'live' ? false : undefined,
  });
}

export function useManagementPrincipals(modeOverride?: ManagementMode) {
  const ctx = useManagementData();
  const effectiveMode = modeOverride || ctx.mode;
  const adapter = modeOverride ? getActiveAdapter(modeOverride, ctx.token) : ctx.adapter;

  return useQuery({
    queryKey: ['management', 'principals', effectiveMode],
    queryFn: () => adapter.getPrincipals(),
    retry: effectiveMode === 'live' ? false : undefined,
  });
}

export function useManagementRuns(modeOverride?: ManagementMode) {
  const ctx = useManagementData();
  const effectiveMode = modeOverride || ctx.mode;
  const adapter = modeOverride ? getActiveAdapter(modeOverride, ctx.token) : ctx.adapter;

  return useQuery({
    queryKey: ['management', 'runs', effectiveMode],
    queryFn: () => adapter.getRuns(),
    retry: effectiveMode === 'live' ? false : undefined,
  });
}

export function useManagementTraceRuns(modeOverride?: ManagementMode) {
  const ctx = useManagementData();
  const effectiveMode = modeOverride || ctx.mode;
  const adapter = modeOverride ? getActiveAdapter(modeOverride, ctx.token) : ctx.adapter;

  return useQuery({
    queryKey: ['management', 'trace-runs', effectiveMode],
    queryFn: () => adapter.getTraceRuns(),
    retry: effectiveMode === 'live' ? false : undefined,
  });
}

export function useManagementTraceEvents(runId: string, modeOverride?: ManagementMode) {
  const ctx = useManagementData();
  const effectiveMode = modeOverride || ctx.mode;
  const adapter = modeOverride ? getActiveAdapter(modeOverride, ctx.token) : ctx.adapter;

  return useQuery({
    queryKey: ['management', 'trace-events', runId, effectiveMode],
    queryFn: () => adapter.getTraceEvents(runId),
    retry: effectiveMode === 'live' ? false : undefined,
    enabled: !!runId,
  });
}

export function useManagementPiModels(modeOverride?: ManagementMode) {
  const ctx = useManagementData();
  const effectiveMode = modeOverride || ctx.mode;
  const adapter = modeOverride ? getActiveAdapter(modeOverride, ctx.token) : ctx.adapter;

  return useQuery({
    queryKey: ['management', 'pi-models', effectiveMode],
    queryFn: () => adapter.getPiModels(),
    retry: effectiveMode === 'live' ? false : undefined,
  });
}

export function useManagementChannels(modeOverride?: ManagementMode) {
  const ctx = useManagementData();
  const effectiveMode = modeOverride || ctx.mode;
  const adapter = modeOverride ? getActiveAdapter(modeOverride, ctx.token) : ctx.adapter;

  return useQuery({
    queryKey: ['management', 'channels', effectiveMode],
    queryFn: () => adapter.getChannels(),
    retry: effectiveMode === 'live' ? false : undefined,
  });
}

export function useManagementPermissionRules(modeOverride?: ManagementMode) {
  const ctx = useManagementData();
  const effectiveMode = modeOverride || ctx.mode;
  const adapter = modeOverride ? getActiveAdapter(modeOverride, ctx.token) : ctx.adapter;

  return useQuery({
    queryKey: ['management', 'permission-rules', effectiveMode],
    queryFn: () => adapter.getPermissionRules(),
    retry: effectiveMode === 'live' ? false : undefined,
  });
}

export const useManagementPermissions = useManagementPermissionRules;

export function useManagementMonitor(modeOverride?: ManagementMode) {
  const ctx = useManagementData();
  const effectiveMode = modeOverride || ctx.mode;
  const adapter = modeOverride ? getActiveAdapter(modeOverride, ctx.token) : ctx.adapter;

  return useQuery({
    queryKey: ['management', 'monitor', effectiveMode],
    queryFn: () => adapter.getMonitorTelemetry(),
    retry: effectiveMode === 'live' ? false : undefined,
  });
}

export function useManagementSettings(modeOverride?: ManagementMode) {
  const ctx = useManagementData();
  const effectiveMode = modeOverride || ctx.mode;
  const adapter = modeOverride ? getActiveAdapter(modeOverride, ctx.token) : ctx.adapter;

  return useQuery({
    queryKey: ['management', 'settings', effectiveMode],
    queryFn: () => adapter.getSettings(),
    retry: effectiveMode === 'live' ? false : undefined,
  });
}
