/**
 * @file apps/web/src/management/adapter/index.ts
 *
 * Clearly separated Fixture Adapter and Real HTTP Read Adapter.
 * Invariant: NO silent fallback from API to fixtures. The active data source
 * is explicitly declared and traceable.
 */
import { useQuery } from '@tanstack/react-query';
import type {
  OverviewProjection,
  ConversationProjection,
  TaskProjection,
  PrincipalProjection,
  RunProjection,
  TraceRunSummary,
  TraceEventProjection,
  PiModelProjection,
  ChannelProjection,
  PermissionRuleProjection,
  DecisionTesterInput,
  DecisionTesterResult,
  MonitorTelemetryProjection,
  SettingsProjection,
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

export type DataSourceKind = 'fixture' | 'api';

export interface AdapterResult<T> {
  data: T;
  source: DataSourceKind;
  fetchedAt: string;
}

export interface ManagementAdapter {
  kind: DataSourceKind;
  getOverview: () => Promise<AdapterResult<OverviewProjection>>;
  getConversations: () => Promise<AdapterResult<ConversationProjection[]>>;
  getTasks: () => Promise<AdapterResult<TaskProjection[]>>;
  getPrincipals: () => Promise<AdapterResult<PrincipalProjection[]>>;
  getRuns: () => Promise<AdapterResult<RunProjection[]>>;
  getTraceRuns: () => Promise<AdapterResult<TraceRunSummary[]>>;
  getTraceEvents: (runId: string) => Promise<AdapterResult<TraceEventProjection[]>>;
  getPiModels: () => Promise<AdapterResult<PiModelProjection[]>>;
  getChannels: () => Promise<AdapterResult<ChannelProjection[]>>;
  getPermissionRules: () => Promise<AdapterResult<PermissionRuleProjection[]>>;
  getMonitorTelemetry: () => Promise<AdapterResult<MonitorTelemetryProjection[]>>;
  getSettings: () => Promise<AdapterResult<SettingsProjection>>;
  evaluateDecision: (input: DecisionTesterInput) => Promise<DecisionTesterResult>;
}

// ============================================================================
// Fixture Adapter Implementation (Deterministic, Offline, Zero Backend Writes)
// ============================================================================

export class FixtureAdapter implements ManagementAdapter {
  kind: DataSourceKind = 'fixture';

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
// Real HTTP Read Adapter (Strict API Read-Only; Fails with Real Error if Unreachable)
// ============================================================================

export class HttpApiAdapter implements ManagementAdapter {
  kind: DataSourceKind = 'api';

  private async fetchApi<T>(endpoint: string): Promise<AdapterResult<T>> {
    const res = await fetch(`/api/management/${endpoint}`);
    if (!res.ok) {
      throw new Error(`API Read Error: ${res.status} ${res.statusText} at ${endpoint}`);
    }
    const json = await res.json();
    return {
      data: json,
      source: 'api',
      fetchedAt: new Date().toISOString(),
    };
  }

  async getOverview() {
    return this.fetchApi<OverviewProjection>('overview');
  }

  async getConversations() {
    return this.fetchApi<ConversationProjection[]>('conversations');
  }

  async getTasks() {
    return this.fetchApi<TaskProjection[]>('tasks');
  }

  async getPrincipals() {
    return this.fetchApi<PrincipalProjection[]>('principals');
  }

  async getRuns() {
    return this.fetchApi<RunProjection[]>('runs');
  }

  async getTraceRuns() {
    return this.fetchApi<TraceRunSummary[]>('trace/runs');
  }

  async getTraceEvents(runId: string) {
    return this.fetchApi<TraceEventProjection[]>(`trace/runs/${runId}/events`);
  }

  async getPiModels() {
    return this.fetchApi<PiModelProjection[]>('pi/models');
  }

  async getChannels() {
    return this.fetchApi<ChannelProjection[]>('channels');
  }

  async getPermissionRules() {
    return this.fetchApi<PermissionRuleProjection[]>('permissions/rules');
  }

  async getMonitorTelemetry() {
    return this.fetchApi<MonitorTelemetryProjection[]>('monitor/telemetry');
  }

  async getSettings() {
    return this.fetchApi<SettingsProjection>('settings');
  }

  async evaluateDecision(input: DecisionTesterInput) {
    const res = await fetch('/api/management/permissions/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    if (!res.ok) {
      throw new Error(`Permission Tester API Error: ${res.status}`);
    }
    return res.json();
  }
}

// ============================================================================
// Adapter Selector & Hooks
// ============================================================================

export function getActiveAdapter(): ManagementAdapter {
  // Check if mock mode is forced via URL search param or env
  if (typeof window !== 'undefined') {
    const urlParams = new URLSearchParams(window.location.search);
    if (urlParams.get('mock') === 'false') {
      return new HttpApiAdapter();
    }
  }
  // Default to deterministic FixtureAdapter for isolated testing & standalone UI delivery
  return new FixtureAdapter();
}

export function useManagementOverview() {
  const adapter = getActiveAdapter();
  return useQuery({
    queryKey: ['management', 'overview', adapter.kind],
    queryFn: () => adapter.getOverview(),
  });
}

export function useManagementConversations() {
  const adapter = getActiveAdapter();
  return useQuery({
    queryKey: ['management', 'conversations', adapter.kind],
    queryFn: () => adapter.getConversations(),
  });
}

export function useManagementTasks() {
  const adapter = getActiveAdapter();
  return useQuery({
    queryKey: ['management', 'tasks', adapter.kind],
    queryFn: () => adapter.getTasks(),
  });
}

export function useManagementPrincipals() {
  const adapter = getActiveAdapter();
  return useQuery({
    queryKey: ['management', 'principals', adapter.kind],
    queryFn: () => adapter.getPrincipals(),
  });
}

export function useManagementRuns() {
  const adapter = getActiveAdapter();
  return useQuery({
    queryKey: ['management', 'runs', adapter.kind],
    queryFn: () => adapter.getRuns(),
  });
}

export function useManagementTraceRuns() {
  const adapter = getActiveAdapter();
  return useQuery({
    queryKey: ['management', 'trace', 'runs', adapter.kind],
    queryFn: () => adapter.getTraceRuns(),
  });
}

export function useManagementTraceEvents(runId: string) {
  const adapter = getActiveAdapter();
  return useQuery({
    queryKey: ['management', 'trace', 'events', runId, adapter.kind],
    queryFn: () => adapter.getTraceEvents(runId),
    enabled: !!runId,
  });
}

export function useManagementPiModels() {
  const adapter = getActiveAdapter();
  return useQuery({
    queryKey: ['management', 'pi', 'models', adapter.kind],
    queryFn: () => adapter.getPiModels(),
  });
}

export function useManagementChannels() {
  const adapter = getActiveAdapter();
  return useQuery({
    queryKey: ['management', 'channels', adapter.kind],
    queryFn: () => adapter.getChannels(),
  });
}

export function useManagementPermissions() {
  const adapter = getActiveAdapter();
  return useQuery({
    queryKey: ['management', 'permissions', adapter.kind],
    queryFn: () => adapter.getPermissionRules(),
  });
}

export function useManagementMonitor() {
  const adapter = getActiveAdapter();
  return useQuery({
    queryKey: ['management', 'monitor', adapter.kind],
    queryFn: () => adapter.getMonitorTelemetry(),
  });
}

export function useManagementSettings() {
  const adapter = getActiveAdapter();
  return useQuery({
    queryKey: ['management', 'settings', adapter.kind],
    queryFn: () => adapter.getSettings(),
  });
}
